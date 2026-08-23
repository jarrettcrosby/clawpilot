const SHOPIFY_CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const SHOPIFY_CUSTOMER_GID_PATTERN =
  /^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,19}$/
const SHOPIFY_SERVICE_CODE_PATTERN =
  /^clawpilot:[a-z0-9](?:[a-z0-9_-]{0,31}):[a-z0-9](?:[a-z0-9_-]{0,31})$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const MAX_SERVICE_CODES = 50
const MAX_SEARCH_LENGTH = 200
const MAX_CURSOR_LENGTH = 2_048
const MAX_CUSTOMER_LABEL_LENGTH = 255
const MAX_CUSTOMER_EMAIL_LENGTH = 320
export const SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MIN_LENGTH = 3
export const SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MAX_LENGTH = 160
const EMAIL_IN_TEXT_PATTERN =
  /([^\s@:<>()\[\]{}"',;]+)@([^\s@<>()\[\]{}"',;]+)/gu

export const SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES = 15
export const SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES = 60
export const SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES = 240
export const SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE = 'timed' as const
export const SHOPIFY_SHADOW_POLICY_LIFETIME_MODES = [
  'timed',
  'until_turned_off',
] as const

export type ShopifyShadowPolicyLifetimeMode =
  typeof SHOPIFY_SHADOW_POLICY_LIFETIME_MODES[number]

export type NormalizedShopifyShadowPolicyLifetime = {
  shadowLifetimeMode: ShopifyShadowPolicyLifetimeMode
  shadowDurationMinutes: number | null
}

export type ShopifyCustomerRatePolicyMode =
  | 'show_all'
  | 'hide_all'
  | 'include_only'
  | 'exclude'

export const SHOPIFY_SHADOW_TEST_CHARGE_MODES = [
  'carrier_rate',
  'zero_single_service',
] as const

export type ShopifyShadowTestChargeMode =
  typeof SHOPIFY_SHADOW_TEST_CHARGE_MODES[number]

export type NormalizedShopifyCustomerRatePolicy = {
  version: 2
  mode: ShopifyCustomerRatePolicyMode
  serviceCodes: string[]
  shadowTestChargeMode: ShopifyShadowTestChargeMode
  shadowTestServiceCode: string | null
  shadowTestSubsidyReason: string | null
}

export function shopifyCustomerRatePolicyAllowsService(
  policy: Pick<NormalizedShopifyCustomerRatePolicy, 'mode' | 'serviceCodes'>,
  stableServiceCode: string,
): boolean {
  if (policy.mode === 'show_all') return true
  if (policy.mode === 'hide_all') return false
  const selected = policy.serviceCodes.includes(stableServiceCode)
  return policy.mode === 'include_only' ? selected : !selected
}

export type ShopifyCustomerSearchResult = {
  customers: Array<{
    customerGid: string
    displayName: string
    maskedEmail: string | null
    state: string
  }>
  query: string
  nextCursor: string | null
  hasNextPage: boolean
}

type ShopifyCustomerGraphql = <T>(
  credential: {
    shopDomain: string
    accessToken: string
  },
  request: {
    query: string
    variables: Record<string, unknown>
    operationName: string
  },
  options?: { timeoutMs?: number },
) => Promise<T>

export class ShopifyCustomerRatePolicyError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ShopifyCustomerRatePolicyError'
    this.code = code
    this.status = status
  }
}

const SHOPIFY_CUSTOMERS_QUERY = `query ClawPilotCustomerRatePolicySearch(
  $first: Int!
  $after: String
  $query: String
) {
  customers(first: $first, after: $after, query: $query) {
    nodes {
      id
      displayName
      defaultEmailAddress {
        emailAddress
      }
      state
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
) {
  const candidate = value ?? fallback
  if (
    !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new ShopifyCustomerRatePolicyError(
      code,
      'Shopify customer search bounds were invalid',
    )
  }
  return candidate
}

function boundedText(
  value: unknown,
  maximumLength: number,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  return (
    normalized.length >= 1
    && normalized.length <= maximumLength
    && !CONTROL_CHARACTER_PATTERN.test(normalized)
  )
    ? normalized
    : null
}

function maskedEmailParts(localPart: string, domain: string) {
  return `${localPart.slice(0, 1).toLowerCase() || '*'}***@${
    domain.toLowerCase()
  }`
}

export function maskShopifyCustomerEmail(value: string): string {
  const match = /^([^\s@]+)@([^\s@]+)$/u.exec(value.trim())
  return match ? maskedEmailParts(match[1], match[2]) : '***'
}

export function maskShopifyCustomerEmailsInText(value: string): string {
  return value.replace(
    EMAIL_IN_TEXT_PATTERN,
    (_email, localPart: string, domain: string) => (
      maskedEmailParts(localPart, domain)
    ),
  )
}

export function normalizeShopifyCustomerGid(value: unknown): string {
  const normalized = String(value || '').trim()
  if (SHOPIFY_CUSTOMER_GID_PATTERN.test(normalized)) return normalized
  if (SHOPIFY_CUSTOMER_ID_PATTERN.test(normalized)) {
    return `gid://shopify/Customer/${normalized}`
  }
  throw new ShopifyCustomerRatePolicyError(
    'SHOPIFY_CUSTOMER_GID_INVALID',
    'A valid Shopify Customer GID is required',
  )
}

export function normalizeShopifyShadowPolicyDurationMinutes(
  value: unknown,
): number {
  const candidate = value === null || value === undefined || value === ''
    ? SHOPIFY_SHADOW_POLICY_DEFAULT_DURATION_MINUTES
    : Number(value)
  if (
    !Number.isSafeInteger(candidate)
    || candidate < SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES
    || candidate > SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_POLICY_DURATION_INVALID',
      `Shadow proof duration must be a whole number from ${
        SHOPIFY_SHADOW_POLICY_MIN_DURATION_MINUTES
      } to ${SHOPIFY_SHADOW_POLICY_MAX_DURATION_MINUTES} minutes`,
    )
  }
  return candidate
}

export function normalizeShopifyShadowPolicyLifetime(input: {
  shadowLifetimeMode?: unknown
  shadowDurationMinutes?: unknown
}): NormalizedShopifyShadowPolicyLifetime {
  const shadowLifetimeMode = input.shadowLifetimeMode === undefined
    || input.shadowLifetimeMode === null
    || input.shadowLifetimeMode === ''
    ? SHOPIFY_SHADOW_POLICY_DEFAULT_LIFETIME_MODE
    : String(input.shadowLifetimeMode).trim()
  if (
    shadowLifetimeMode !== 'timed'
    && shadowLifetimeMode !== 'until_turned_off'
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_POLICY_LIFETIME_INVALID',
      'Shadow lifetime must be timed or until turned off',
    )
  }
  if (shadowLifetimeMode === 'until_turned_off') {
    if (
      input.shadowDurationMinutes !== undefined
      && input.shadowDurationMinutes !== null
      && input.shadowDurationMinutes !== ''
    ) {
      throw new ShopifyCustomerRatePolicyError(
        'SHOPIFY_SHADOW_POLICY_LIFETIME_INVALID',
        'Until-turned-off Shadow policies cannot include a duration',
      )
    }
    return {
      shadowLifetimeMode,
      shadowDurationMinutes: null,
    }
  }
  return {
    shadowLifetimeMode,
    shadowDurationMinutes: normalizeShopifyShadowPolicyDurationMinutes(
      input.shadowDurationMinutes,
    ),
  }
}

export function normalizeShopifyCustomerRatePolicy(input: {
  mode: unknown
  serviceCodes: unknown
  shadowTestChargeMode?: unknown
  shadowTestServiceCode?: unknown
  shadowTestSubsidyReason?: unknown
}): NormalizedShopifyCustomerRatePolicy {
  const mode = String(input.mode || '').trim()
  if (![
    'show_all',
    'hide_all',
    'include_only',
    'exclude',
  ].includes(mode)) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_RATE_POLICY_MODE_INVALID',
      'Shopify customer rate policy mode is invalid',
    )
  }
  if (!Array.isArray(input.serviceCodes)) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_INVALID',
      'Shopify customer rate policy service codes must be an array',
    )
  }
  if (input.serviceCodes.length > MAX_SERVICE_CODES) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_LIMIT_EXCEEDED',
      'Shopify customer rate policy supports at most 50 service codes',
    )
  }
  const serviceCodes = input.serviceCodes.map((value) => (
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  ))
  if (
    serviceCodes.some(
      (serviceCode) => !SHOPIFY_SERVICE_CODE_PATTERN.test(serviceCode),
    )
    || new Set(serviceCodes).size !== serviceCodes.length
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_INVALID',
      'Shopify customer rate policy service codes are invalid or duplicated',
    )
  }
  if (
    (['show_all', 'hide_all'].includes(mode) && serviceCodes.length !== 0)
    || (
      ['include_only', 'exclude'].includes(mode)
      && serviceCodes.length < 1
    )
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_RATE_POLICY_SERVICE_CODES_INVALID',
      'Shopify customer rate policy service codes do not match its mode',
    )
  }
  const normalizedMode = mode as ShopifyCustomerRatePolicyMode
  const normalizedServiceCodes = [...serviceCodes].sort()
  const shadowTestChargeMode = input.shadowTestChargeMode === undefined
    || input.shadowTestChargeMode === null
    || input.shadowTestChargeMode === ''
    ? 'carrier_rate'
    : String(input.shadowTestChargeMode).trim()
  if (!SHOPIFY_SHADOW_TEST_CHARGE_MODES.includes(
    shadowTestChargeMode as ShopifyShadowTestChargeMode,
  )) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_TEST_CHARGE_MODE_INVALID',
      'Shadow test charge mode is invalid',
    )
  }
  const normalizedShadowTestChargeMode =
    shadowTestChargeMode as ShopifyShadowTestChargeMode
  const shadowTestServiceCode = typeof input.shadowTestServiceCode === 'string'
    ? input.shadowTestServiceCode.trim().toLowerCase() || null
    : input.shadowTestServiceCode === undefined
      || input.shadowTestServiceCode === null
      ? null
      : ''
  const shadowTestSubsidyReason = boundedText(
    input.shadowTestSubsidyReason,
    SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MAX_LENGTH,
  )
  const shadowTestSubsidyReasonProvided =
    input.shadowTestSubsidyReason !== undefined
    && input.shadowTestSubsidyReason !== null
    && (
      typeof input.shadowTestSubsidyReason !== 'string'
      || input.shadowTestSubsidyReason.trim() !== ''
    )
  if (normalizedShadowTestChargeMode === 'carrier_rate') {
    if (
      shadowTestServiceCode !== null
      || shadowTestSubsidyReasonProvided
    ) {
      throw new ShopifyCustomerRatePolicyError(
        'SHOPIFY_SHADOW_TEST_CHARGE_FIELDS_INVALID',
        'Normal carrier charge mode cannot include a test service or subsidy reason',
      )
    }
    return {
      version: 2,
      mode: normalizedMode,
      serviceCodes: normalizedServiceCodes,
      shadowTestChargeMode: normalizedShadowTestChargeMode,
      shadowTestServiceCode: null,
      shadowTestSubsidyReason: null,
    }
  }
  if (
    !shadowTestServiceCode
    || !SHOPIFY_SERVICE_CODE_PATTERN.test(shadowTestServiceCode)
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_TEST_SERVICE_CODE_INVALID',
      'A valid exact Shopify service code is required for a zero test charge',
    )
  }
  if (
    !shadowTestSubsidyReason
    || shadowTestSubsidyReason.length
      < SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MIN_LENGTH
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_INVALID',
      'A specific subsidy reason is required for a zero test charge',
    )
  }
  const serviceVisible = normalizedMode === 'show_all'
    || (
      normalizedMode === 'include_only'
      && normalizedServiceCodes.includes(shadowTestServiceCode)
    )
    || (
      normalizedMode === 'exclude'
      && !normalizedServiceCodes.includes(shadowTestServiceCode)
    )
  if (!serviceVisible) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_SHADOW_TEST_SERVICE_NOT_VISIBLE',
      'The zero-charge test service must be visible under the customer policy',
    )
  }
  return {
    version: 2,
    mode: normalizedMode,
    serviceCodes: normalizedServiceCodes,
    shadowTestChargeMode: normalizedShadowTestChargeMode,
    shadowTestServiceCode,
    shadowTestSubsidyReason,
  }
}

export function normalizeShopifyCustomerSearchQuery(
  value: unknown,
): string {
  if (value === null || value === undefined || value === '') return ''
  const normalized = String(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
  if (
    normalized.length > MAX_SEARCH_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_QUERY_INVALID',
      'Shopify customer search query is invalid',
    )
  }
  return normalized
}

export function normalizeShopifyCustomerSearchCursor(
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null
  const cursor = String(value)
  if (
    cursor.length > MAX_CURSOR_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(cursor)
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_CURSOR_INVALID',
      'Shopify customer search cursor is invalid',
    )
  }
  return cursor
}

function customerNode(value: unknown) {
  const node = record(value)
  const displayName = boundedText(
    node?.displayName,
    MAX_CUSTOMER_LABEL_LENGTH,
  )
  const defaultEmailAddress = record(node?.defaultEmailAddress)
  const emailValue = defaultEmailAddress?.emailAddress
  const email = emailValue === null || emailValue === undefined
    ? null
    : boundedText(emailValue, MAX_CUSTOMER_EMAIL_LENGTH)
  const state = boundedText(node?.state, 64)
  if (
    !node
    || typeof node.id !== 'string'
    || !SHOPIFY_CUSTOMER_GID_PATTERN.test(node.id)
    || !displayName
    || (emailValue !== null && emailValue !== undefined && !email)
    || !state
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_RESPONSE_INVALID',
      'Shopify returned invalid customer search data',
      502,
    )
  }
  return {
    customerGid: node.id,
    displayName: maskShopifyCustomerEmailsInText(displayName),
    maskedEmail: email ? maskShopifyCustomerEmail(email) : null,
    state,
  }
}

function hasCustomerReadScope(scopes: readonly string[]) {
  return scopes.includes('read_customers') || scopes.includes('write_customers')
}

export async function searchShopifyCustomers(input: {
  credential: {
    shopDomain: string
    accessToken: string
  }
  grantedScopes: readonly string[]
  graphql: ShopifyCustomerGraphql
  search?: unknown
  cursor?: unknown
  pageSize?: number
  timeoutMs?: number
}): Promise<ShopifyCustomerSearchResult> {
  if (!hasCustomerReadScope(input.grantedScopes)) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_READ_CUSTOMERS_SCOPE_REQUIRED',
      'Shopify read_customers scope is required to search customers',
      409,
    )
  }
  const query = normalizeShopifyCustomerSearchQuery(input.search)
  const cursor = normalizeShopifyCustomerSearchCursor(input.cursor)
  const pageSize = boundedInteger(
    input.pageSize,
    25,
    1,
    100,
    'SHOPIFY_CUSTOMER_SEARCH_BOUNDS_INVALID',
  )
  const data = await input.graphql<{ customers?: unknown }>(
    input.credential,
    {
      query: SHOPIFY_CUSTOMERS_QUERY,
      variables: {
        first: pageSize,
        after: cursor,
        query: query || null,
      },
      operationName: 'ClawPilotCustomerRatePolicySearch',
    },
    { timeoutMs: input.timeoutMs ?? 10_000 },
  )
  const connection = record(data.customers)
  const nodes = connection?.nodes
  const pageInfo = record(connection?.pageInfo)
  if (
    !connection
    || !Array.isArray(nodes)
    || nodes.length > pageSize
    || !pageInfo
    || typeof pageInfo.hasNextPage !== 'boolean'
  ) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_RESPONSE_INVALID',
      'Shopify returned invalid customer search data',
      502,
    )
  }
  const nextCursor = pageInfo.hasNextPage
    ? normalizeShopifyCustomerSearchCursor(pageInfo.endCursor)
    : null
  if (pageInfo.hasNextPage && !nextCursor) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_CURSOR_INVALID',
      'Shopify returned invalid customer search pagination',
      502,
    )
  }
  if (nextCursor && nextCursor === cursor) {
    throw new ShopifyCustomerRatePolicyError(
      'SHOPIFY_CUSTOMER_SEARCH_CURSOR_INVALID',
      'Shopify repeated the current customer search cursor',
      502,
    )
  }
  return {
    customers: nodes.map(customerNode),
    query: maskShopifyCustomerEmailsInText(query),
    nextCursor,
    hasNextPage: pageInfo.hasNextPage,
  }
}
