import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

export const FAIRE_API_BASE_URL = 'https://www.faire.com/external-api/v2' as const
export const FAIRE_OAUTH_AUTHORIZE_URL =
  'https://faire.com/oauth2/authorize' as const
export const FAIRE_OAUTH_TOKEN_URL =
  'https://www.faire.com/api/external-api-oauth2/token' as const

const FAIRE_API_ORIGIN = 'https://www.faire.com'
const FAIRE_API_PATH_PREFIX = '/external-api/v2/'
const DEFAULT_TIMEOUT_MS = 15_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_BYTES = 64 * 1024
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 50
const MAX_INVENTORY_SELECTORS = 50
const MAX_AVAILABILITY_ITEMS = 250
const MAX_SHIPMENTS = 100
const MAX_PRODUCT_VARIANTS = 250
const MAX_PRODUCT_IMAGES = 20
const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_REQUEST_BYTES = 7 * 1024 * 1024

/**
 * Faire's documented OAuth scope vocabulary.
 */
export const FAIRE_API_SCOPES = Object.freeze([
  'READ_PRODUCTS',
  'WRITE_PRODUCTS',
  'READ_ORDERS',
  'WRITE_ORDERS',
  'READ_BRAND',
  'READ_RETAILER',
  'READ_INVENTORIES',
  'WRITE_INVENTORIES',
  'READ_SHIPMENTS',
  'READ_REVIEWS',
] as const)

/**
 * This adapter is a B2B wholesale marketplace sales-channel client, not a POS
 * or shopping-cart client. Faire does not document webhook registration, a
 * public sandbox, or return-write endpoints, so those capabilities stay false.
 */
export const FAIRE_COMMERCE_CAPABILITIES = Object.freeze({
  provider: 'faire',
  classification: 'b2b_wholesale_marketplace_sales_channel',
  environment: 'production',
  authentication: 'direct_token_or_oauth',
  inventoryReadMode: 'selector_only',
  webhooks: false,
  sandbox: false,
  returnWrites: false,
  orderWrites: Object.freeze([
    'processing',
    'cancel',
    'availability',
    'shipment',
  ] as const),
})

export type FaireJsonObject = Record<string, unknown>
export type FaireBrandProfile = FaireJsonObject
export type FaireProduct = FaireJsonObject
export type FaireOrder = FaireJsonObject

export type FaireCursorPage = {
  page?: number
  limit?: number
  cursor?: string | null
}

export type FaireProductsPage = FaireJsonObject & FaireCursorPage & {
  products: FaireProduct[]
}

export type FaireOrdersPage = FaireJsonObject & FaireCursorPage & {
  orders: FaireOrder[]
}

export type FaireInventoryQuantity = FaireJsonObject & {
  type: 'QUANTITY' | 'UNTRACKED'
  quantity?: number
}

export type FaireInventoryLevel = FaireJsonObject & {
  on_hand_quantity?: FaireInventoryQuantity
  committed_quantity?: FaireInventoryQuantity
  available_quantity?: FaireInventoryQuantity
}

export type FaireInventoryResponse = FaireJsonObject & {
  inventories: Record<string, FaireInventoryLevel>
}

export type FaireListOptions = {
  cursor?: string | null
  updatedAtMin?: string | null
  limit?: number | null
}

export type FaireProductListOptions = FaireListOptions & {
  includeDeleted?: boolean
}

export type FaireInventoryQuery =
  | {
      productVariantIds: readonly string[]
      skus?: never
    }
  | {
      productVariantIds?: never
      skus: readonly string[]
    }

export type FaireProviderWriteScope =
  | 'WRITE_PRODUCTS'
  | 'WRITE_INVENTORIES'
  | 'WRITE_ORDERS'

export type FaireProviderWriteCapability =
  | 'product_draft_create'
  | 'product_draft_update'
  | 'product_image_upload'
  | 'inventory_update'
  | 'order_processing'
  | 'order_cancel'
  | 'order_availability'
  | 'fulfillment_export'
  | 'tracking_export'

export type FaireVerifiedCredentialBinding = {
  provider: 'faire'
  environment: 'production'
  accountGlobalId: string
  externalAccountId: string
  credentialVersion: number
  connectionStatus: 'active'
  verificationStatus: 'verified'
}

/**
 * A provider write must be backed by explicit, current evidence. The provider's
 * advertised scope vocabulary is deliberately not an accepted evidence source.
 */
export type FaireProviderWriteAuthorization = {
  provider: 'faire'
  environment: 'production'
  accountGlobalId: string
  externalAccountId: string
  credentialVersion: number
  authorizationRevision: number
  capabilities: readonly FaireProviderWriteCapability[]
  verifiedWriteScopes: readonly FaireProviderWriteScope[]
  scopeVerificationSource: 'oauth_grant'
}

export type FaireProductImageInput = {
  url: string
  sequence?: number
}

export type FaireProductVariantOptionInput = {
  name: string
  value: string
}

export type FaireProductVariantPriceInput = {
  geoConstraint?: {
    country?: string
    countryGroup?: string
  }
  wholesalePrice: FaireMoneyInput
  retailPrice: FaireMoneyInput
}

export type FaireProductVariantDraftInput = {
  idempotenceToken: string
  name: string
  sku: string
  prices: readonly FaireProductVariantPriceInput[]
  images?: readonly FaireProductImageInput[]
  options?: readonly FaireProductVariantOptionInput[]
  tariffCode?: string
  orderabilityType?: 'IMMEDIATE'
}

export type FaireProductDraftCreateInput = {
  idempotenceToken: string
  name: string
  description?: string
  shortDescription?: string
  variants: readonly FaireProductVariantDraftInput[]
  unitMultiplier: number
  minimumOrderQuantity: number
  allowSalesWhenOutOfStock?: boolean
  images?: readonly FaireProductImageInput[]
  variantOptionSets?: readonly {
    name: string
    values: readonly string[]
  }[]
  madeInCountry?: string
}

export type FaireProductDraftPatchInput = {
  name?: string
  description?: string
  shortDescription?: string
  images?: readonly FaireProductImageInput[]
  allowSalesWhenOutOfStock?: boolean
  madeInCountry?: string
}

export type FaireProductImagePatchInput = {
  expectedCurrentImages: readonly FaireProductImageInput[]
  images: readonly FaireProductImageInput[]
}

export type FaireImageUploadInput = {
  attachmentBase64: string
}

export type FaireImageUploadResponse = FaireJsonObject & {
  url: string
}

export type FaireInventoryUpdateInput =
  | {
      by: 'skus'
      inventories: readonly {
        sku: string
        productVariantId?: string
        onHandQuantity: number
      }[]
    }
  | {
      by: 'product_variant_ids'
      inventories: readonly {
        productVariantId: string
        sku?: string
        onHandQuantity: number
      }[]
    }

export type FaireMoveOrderToProcessingInput = {
  expectedShipDate?: string | null
}

export const FAIRE_ORDER_CANCELLATION_REASONS = Object.freeze([
  'REQUESTED_BY_RETAILER',
  'RETAILER_NOT_GOOD_FIT',
  'CHANGE_REPLACE_ORDER',
  'ITEM_OUT_OF_STOCK',
  'INCORRECT_PRICING',
  'ORDER_TOO_SMALL',
  'REJECT_INTERNATIONAL_ORDER',
  'OTHER',
] as const)

export type FaireOrderCancellationReason =
  typeof FAIRE_ORDER_CANCELLATION_REASONS[number]

export type FaireCancelOrderInput = {
  reason: FaireOrderCancellationReason
  note?: string | null
}

export type FaireOrderItemAvailabilityInput = {
  availableQuantity?: number
  discontinued?: boolean
  backorderedUntil?: string
}

export type FaireOrderItemAvailabilities =
  Readonly<Record<string, FaireOrderItemAvailabilityInput>>

export type FaireMoneyInput = {
  amountMinor: number
  currency: string
}

export type FaireShippingType = 'SHIP_ON_YOUR_OWN' | 'SHIP_WITH_FAIRE'

export type FaireShipmentInput = {
  carrier: string
  trackingCode: string
  makerCost?: FaireMoneyInput | null
  shippingType: FaireShippingType
}

export type FaireCommerceClientOptions = {
  accessToken: unknown
  applicationId?: unknown
  applicationSecret?: unknown
  credentialBinding?: FaireVerifiedCredentialBinding
  writeAuthorization?: FaireProviderWriteAuthorization
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type FaireOAuthAuthorizationInput = {
  applicationId: unknown
  redirectUrl: unknown
  scopes: unknown
  state: unknown
}

export type FaireOAuthTokenExchangeInput = FaireOAuthAuthorizationInput & {
  applicationSecret: unknown
  authorizationCode: unknown
}

export type FaireOAuthTokenGrant = {
  accessToken: string
  tokenType: 'BEARER'
}

export type FaireCommerceClient = {
  probeBrandProfile: () => Promise<FaireBrandProfile>
  listProducts: (options?: FaireProductListOptions) => Promise<FaireProductsPage>
  getProduct: (productId: string) => Promise<FaireProduct>
  createDraftProduct: (
    input: FaireProductDraftCreateInput,
  ) => Promise<FaireProduct>
  updateDraftProduct: (
    productId: string,
    input: FaireProductDraftPatchInput,
  ) => Promise<FaireProduct>
  updateProductImages: (
    productId: string,
    input: FaireProductImagePatchInput,
  ) => Promise<FaireProduct>
  uploadProductImage: (
    input: FaireImageUploadInput,
  ) => Promise<FaireImageUploadResponse>
  listOrders: (options?: FaireListOptions) => Promise<FaireOrdersPage>
  getOrder: (orderId: string) => Promise<FaireOrder>
  listInventory: (query: FaireInventoryQuery) => Promise<FaireInventoryResponse>
  updateInventory: (
    input: FaireInventoryUpdateInput,
  ) => Promise<FaireInventoryResponse>
  moveOrderToProcessing: (
    orderId: string,
    input?: FaireMoveOrderToProcessingInput,
  ) => Promise<FaireJsonObject>
  cancelOrder: (
    orderId: string,
    input: FaireCancelOrderInput,
  ) => Promise<FaireJsonObject>
  setOrderItemsAvailability: (
    orderId: string,
    availabilities: FaireOrderItemAvailabilities,
  ) => Promise<FaireJsonObject>
  setOrderItemAvailability: (
    orderId: string,
    availabilities: FaireOrderItemAvailabilities,
  ) => Promise<FaireJsonObject>
  addOrderShipments: (
    orderId: string,
    shipments: readonly FaireShipmentInput[],
  ) => Promise<FaireJsonObject>
  addOrderShipment: (
    orderId: string,
    shipment: FaireShipmentInput,
  ) => Promise<FaireJsonObject>
}

type FaireRequestInput = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: URLSearchParams
  body?: unknown
  maxRequestBytes?: number
}

export class FaireCommerceClientError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'FAIRE_REQUEST_FAILED',
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'FaireCommerceClientError'
  }
}

export function sanitizeFaireCommerceError(error: unknown) {
  if (error instanceof FaireCommerceClientError) return error
  return new FaireCommerceClientError(
    'The Faire integration request failed',
    500,
    'FAIRE_INTERNAL_ERROR',
  )
}

function invalidInput(message: string, code: string): never {
  throw new FaireCommerceClientError(message, 400, code)
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeAccessToken(value: unknown) {
  const accessToken = typeof value === 'string' ? value.trim() : ''
  if (
    accessToken.length < 8
    || accessToken.length > 4096
    || !/^[\x21-\x7e]+$/.test(accessToken)
  ) {
    invalidInput('A valid Faire access token is required', 'FAIRE_ACCESS_TOKEN_INVALID')
  }
  return accessToken
}

function normalizeApplicationId(value: unknown) {
  const applicationId = typeof value === 'string' ? value.trim() : ''
  if (
    applicationId.length < 1
    || applicationId.length > 255
    || !/^[\x20-\x7e]+$/.test(applicationId)
  ) {
    invalidInput(
      'A valid Faire application ID is required',
      'FAIRE_APPLICATION_ID_INVALID',
    )
  }
  return applicationId
}

function normalizeApplicationSecret(value: unknown) {
  const applicationSecret = typeof value === 'string' ? value.trim() : ''
  if (
    applicationSecret.length < 16
    || applicationSecret.length > 4096
    || !/^[\x21-\x7e]+$/.test(applicationSecret)
  ) {
    invalidInput(
      'A valid Faire Secret ID is required',
      'FAIRE_APPLICATION_SECRET_INVALID',
    )
  }
  return applicationSecret
}

function normalizeOAuthScopes(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    invalidInput(
      'Faire OAuth requires 1-10 permissions',
      'FAIRE_OAUTH_SCOPES_INVALID',
    )
  }
  const known = new Set<string>(FAIRE_API_SCOPES)
  const scopes = value.map((scope) => String(scope || '').trim())
  if (
    scopes.some((scope) => !known.has(scope))
    || new Set(scopes).size !== scopes.length
  ) {
    invalidInput(
      'Faire OAuth permissions are invalid',
      'FAIRE_OAUTH_SCOPES_INVALID',
    )
  }
  return scopes
}

function normalizeOAuthState(value: unknown) {
  const state = typeof value === 'string' ? value.trim() : ''
  if (
    state.length < 32
    || state.length > 256
    || !/^[A-Za-z0-9_-]+$/.test(state)
  ) {
    invalidInput('Faire OAuth state is invalid', 'FAIRE_OAUTH_STATE_INVALID')
  }
  return state
}

function normalizeOAuthRedirectUrl(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    invalidInput(
      'Faire OAuth callback URL is invalid',
      'FAIRE_OAUTH_REDIRECT_INVALID',
    )
  }
  if (
    url.username
    || url.password
    || url.hash
    || (
      url.protocol !== 'https:'
      && url.hostname !== 'localhost'
      && url.hostname !== '127.0.0.1'
    )
  ) {
    invalidInput(
      'Faire OAuth callback URL is invalid',
      'FAIRE_OAUTH_REDIRECT_INVALID',
    )
  }
  return url.toString()
}

function normalizeAuthorizationCode(value: unknown) {
  const code = typeof value === 'string' ? value.trim() : ''
  if (
    code.length < 8
    || code.length > 4096
    || !/^[\x21-\x7e]+$/.test(code)
  ) {
    invalidInput(
      'Faire OAuth authorization code is invalid',
      'FAIRE_OAUTH_CODE_INVALID',
    )
  }
  return code
}

function normalizeTimeout(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)))
}

function normalizeCursor(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  const cursor = typeof value === 'string' ? value.trim() : ''
  if (
    !cursor
    || cursor.length > 4096
    || /[\u0000-\u001f\u007f]/.test(cursor)
  ) {
    invalidInput('Faire cursor is invalid', 'FAIRE_CURSOR_INVALID')
  }
  return cursor
}

function normalizeTimestamp(value: unknown, label: string, code: string) {
  const timestamp = typeof value === 'string' ? value.trim() : ''
  const parsed = timestamp && timestamp.length <= 80
    ? new Date(timestamp)
    : new Date(Number.NaN)
  if (!Number.isFinite(parsed.getTime())) {
    invalidInput(`${label} must be a valid ISO timestamp`, code)
  }
  return parsed.toISOString()
}

function normalizeOptionalTimestamp(
  value: unknown,
  label: string,
  code: string,
) {
  if (value === undefined || value === null || value === '') return null
  return normalizeTimestamp(value, label, code)
}

function normalizeListLimit(value: unknown) {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_LIST_LIMIT
  ) {
    invalidInput(
      `Faire list limit must be between 1 and ${MAX_LIST_LIMIT}`,
      'FAIRE_LIST_LIMIT_INVALID',
    )
  }
  return value
}

function listQuery(options: FaireListOptions = {}) {
  const query = new URLSearchParams()
  query.set('limit', String(normalizeListLimit(options?.limit)))
  const cursor = normalizeCursor(options?.cursor)
  if (cursor) query.set('cursor', cursor)
  const updatedAtMin = normalizeOptionalTimestamp(
    options?.updatedAtMin,
    'Faire updated-at minimum',
    'FAIRE_UPDATED_AT_MIN_INVALID',
  )
  if (updatedAtMin) query.set('updated_at_min', updatedAtMin)
  return query
}

function productListQuery(options: FaireProductListOptions = {}) {
  const query = listQuery(options)
  if (
    options.includeDeleted !== undefined
    && typeof options.includeDeleted !== 'boolean'
  ) {
    invalidInput(
      'Faire include-deleted selection must be true or false',
      'FAIRE_INCLUDE_DELETED_INVALID',
    )
  }
  if (options.includeDeleted !== undefined) {
    query.set('include_deleted', String(options.includeDeleted))
  }
  return query
}

function normalizeResourceId(value: unknown, label: string, code: string) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    invalidInput(`${label} is invalid`, code)
  }
  return id
}

const FAIRE_PROVIDER_WRITE_SCOPES = new Set<FaireProviderWriteScope>([
  'WRITE_PRODUCTS',
  'WRITE_INVENTORIES',
  'WRITE_ORDERS',
])

const FAIRE_PROVIDER_WRITE_CAPABILITIES =
  new Set<FaireProviderWriteCapability>([
    'product_draft_create',
    'product_draft_update',
    'product_image_upload',
    'inventory_update',
    'order_processing',
    'order_cancel',
    'order_availability',
    'fulfillment_export',
    'tracking_export',
  ])

function normalizePositiveRevision(value: unknown, label: string, code: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    invalidInput(`${label} is invalid`, code)
  }
  return Number(value)
}

function normalizeCredentialBinding(value: unknown) {
  const binding = safeRecord(value)
  if (
    !binding
    || binding.provider !== 'faire'
    || binding.environment !== 'production'
    || binding.connectionStatus !== 'active'
    || binding.verificationStatus !== 'verified'
  ) {
    invalidInput(
      'A verified active Faire credential binding is required',
      'FAIRE_CREDENTIAL_BINDING_INVALID',
    )
  }
  return Object.freeze({
    provider: 'faire' as const,
    environment: 'production' as const,
    accountGlobalId: normalizeResourceId(
      binding.accountGlobalId,
      'Faire account global ID',
      'FAIRE_ACCOUNT_GLOBAL_ID_INVALID',
    ),
    externalAccountId: normalizeResourceId(
      binding.externalAccountId,
      'Faire external account ID',
      'FAIRE_EXTERNAL_ACCOUNT_ID_INVALID',
    ),
    credentialVersion: normalizePositiveRevision(
      binding.credentialVersion,
      'Faire credential version',
      'FAIRE_CREDENTIAL_VERSION_INVALID',
    ),
  })
}

function normalizeWriteAuthorization(
  value: unknown,
  binding: ReturnType<typeof normalizeCredentialBinding> | null,
) {
  const authorization = safeRecord(value)
  if (
    !authorization
    || !binding
    || authorization.provider !== 'faire'
    || authorization.environment !== 'production'
    || authorization.scopeVerificationSource !== 'oauth_grant'
  ) {
    invalidInput(
      'Verified Faire provider-write authorization is required',
      'FAIRE_WRITE_AUTHORIZATION_INVALID',
    )
  }
  const accountGlobalId = normalizeResourceId(
    authorization.accountGlobalId,
    'Faire authorization account global ID',
    'FAIRE_WRITE_AUTHORIZATION_INVALID',
  )
  const externalAccountId = normalizeResourceId(
    authorization.externalAccountId,
    'Faire authorization external account ID',
    'FAIRE_WRITE_AUTHORIZATION_INVALID',
  )
  const credentialVersion = normalizePositiveRevision(
    authorization.credentialVersion,
    'Faire authorization credential version',
    'FAIRE_WRITE_AUTHORIZATION_INVALID',
  )
  if (
    accountGlobalId !== binding.accountGlobalId
    || externalAccountId !== binding.externalAccountId
    || credentialVersion !== binding.credentialVersion
  ) {
    invalidInput(
      'Faire provider-write authorization is stale or mismatched',
      'FAIRE_WRITE_AUTHORIZATION_STALE',
    )
  }
  if (!Array.isArray(authorization.capabilities)) {
    invalidInput(
      'Faire provider-write capabilities are invalid',
      'FAIRE_WRITE_AUTHORIZATION_INVALID',
    )
  }
  const capabilities = authorization.capabilities.map((value) => String(value))
  if (
    capabilities.length === 0
    || capabilities.some((value) => (
      !FAIRE_PROVIDER_WRITE_CAPABILITIES.has(
        value as FaireProviderWriteCapability,
      )
    ))
    || new Set(capabilities).size !== capabilities.length
  ) {
    invalidInput(
      'Faire provider-write capabilities are invalid',
      'FAIRE_WRITE_AUTHORIZATION_INVALID',
    )
  }
  if (!Array.isArray(authorization.verifiedWriteScopes)) {
    invalidInput(
      'Verified Faire provider-write scopes are required',
      'FAIRE_WRITE_SCOPE_REQUIRED',
    )
  }
  const verifiedWriteScopes = authorization.verifiedWriteScopes
    .map((value) => String(value))
  if (
    verifiedWriteScopes.length === 0
    || verifiedWriteScopes.some((value) => (
      !FAIRE_PROVIDER_WRITE_SCOPES.has(value as FaireProviderWriteScope)
    ))
    || new Set(verifiedWriteScopes).size !== verifiedWriteScopes.length
  ) {
    invalidInput(
      'Verified Faire provider-write scopes are invalid',
      'FAIRE_WRITE_SCOPE_REQUIRED',
    )
  }
  return Object.freeze({
    authorizationRevision: normalizePositiveRevision(
      authorization.authorizationRevision,
      'Faire authorization revision',
      'FAIRE_WRITE_AUTHORIZATION_INVALID',
    ),
    capabilities: new Set(capabilities),
    verifiedWriteScopes: new Set(verifiedWriteScopes),
  })
}

function normalizeInventorySelectors(
  values: unknown,
  kind: 'product variant ID' | 'SKU',
) {
  if (
    !Array.isArray(values)
    || values.length === 0
    || values.length > MAX_INVENTORY_SELECTORS
  ) {
    invalidInput(
      `Faire inventory requires 1-${MAX_INVENTORY_SELECTORS} ${kind}s`,
      'FAIRE_INVENTORY_SELECTORS_INVALID',
    )
  }

  const normalized = values.map((value) => {
    if (kind === 'product variant ID') {
      return normalizeResourceId(
        value,
        'Faire product variant ID',
        'FAIRE_PRODUCT_VARIANT_ID_INVALID',
      )
    }
    const sku = typeof value === 'string' ? value.trim() : ''
    if (
      !sku
      || sku.length > 128
      || sku.includes(',')
      || /[\u0000-\u001f\u007f]/.test(sku)
    ) {
      invalidInput('Faire SKU is invalid', 'FAIRE_SKU_INVALID')
    }
    return sku
  })
  return [...new Set(normalized)]
}

function inventoryRequest(query: FaireInventoryQuery) {
  const productVariantIds = query?.productVariantIds
  const skus = query?.skus
  const selectorCount = Number(productVariantIds !== undefined)
    + Number(skus !== undefined)
  if (selectorCount !== 1) {
    invalidInput(
      'Faire inventory requires product variant IDs or SKUs, but not both',
      'FAIRE_INVENTORY_SELECTOR_TYPE_INVALID',
    )
  }

  const search = new URLSearchParams()
  if (productVariantIds !== undefined) {
    const values = normalizeInventorySelectors(
      productVariantIds,
      'product variant ID',
    )
    for (const value of values) search.append('ids', value)
    return {
      pathname: '/product-inventory/by-product-variant-ids',
      query: search,
    }
  }

  const values = normalizeInventorySelectors(skus, 'SKU')
  for (const value of values) search.append('skus', value)
  return {
    pathname: '/product-inventory/by-skus',
    query: search,
  }
}

function boundedText(
  value: unknown,
  label: string,
  code: string,
  max: number,
  allowEmpty = false,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    (!allowEmpty && !normalized)
    || normalized.length > max
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    invalidInput(`${label} is invalid`, code)
  }
  return normalized
}

function normalizeIdempotenceToken(value: unknown, label: string) {
  const token = boundedText(
    value,
    label,
    'FAIRE_IDEMPOTENCE_TOKEN_INVALID',
    128,
  )
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(token)) {
    invalidInput(`${label} is invalid`, 'FAIRE_IDEMPOTENCE_TOKEN_INVALID')
  }
  return token
}

function normalizeSku(value: unknown) {
  const sku = boundedText(value, 'Faire SKU', 'FAIRE_SKU_INVALID', 128)
  if (sku.includes(',')) {
    invalidInput('Faire SKU is invalid', 'FAIRE_SKU_INVALID')
  }
  return sku
}

function normalizeHttpsUrl(value: unknown, label: string, code: string) {
  const candidate = boundedText(value, label, code, 2_048)
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    invalidInput(`${label} is invalid`, code)
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
  ) {
    invalidInput(`${label} is invalid`, code)
  }
  return url.toString()
}

function normalizeMoney(input: FaireMoneyInput, label: string) {
  const amountMinor = input?.amountMinor
  const currency = typeof input?.currency === 'string'
    ? input.currency.trim().toUpperCase()
    : ''
  if (
    !Number.isSafeInteger(amountMinor)
    || Number(amountMinor) < 0
    || !/^[A-Z]{3}$/.test(currency)
  ) {
    invalidInput(`${label} is invalid`, 'FAIRE_MONEY_INVALID')
  }
  return { amount_minor: Number(amountMinor), currency }
}

function normalizeProductImages(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_PRODUCT_IMAGES) {
    invalidInput('Faire product images are invalid', 'FAIRE_PRODUCT_IMAGES_INVALID')
  }
  return value.map((candidate, index) => {
    const image = safeRecord(candidate)
    if (!image) {
      invalidInput('Faire product image is invalid', 'FAIRE_PRODUCT_IMAGE_INVALID')
    }
    const sequence = image.sequence === undefined
      ? index
      : image.sequence
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0) {
      invalidInput(
        'Faire product image sequence is invalid',
        'FAIRE_PRODUCT_IMAGE_INVALID',
      )
    }
    return {
      url: normalizeHttpsUrl(
        image.url,
        'Faire product image URL',
        'FAIRE_PRODUCT_IMAGE_INVALID',
      ),
      sequence: Number(sequence),
    }
  })
}

function normalizeVariantPrices(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    invalidInput('Faire variant prices are invalid', 'FAIRE_VARIANT_PRICES_INVALID')
  }
  return value.map((candidate) => {
    const price = safeRecord(candidate)
    if (!price) {
      invalidInput('Faire variant price is invalid', 'FAIRE_VARIANT_PRICE_INVALID')
    }
    const payload: Record<string, unknown> = {
      wholesale_price: normalizeMoney(
        price.wholesalePrice as FaireMoneyInput,
        'Faire wholesale price',
      ),
      retail_price: normalizeMoney(
        price.retailPrice as FaireMoneyInput,
        'Faire retail price',
      ),
    }
    if (price.geoConstraint !== undefined) {
      const constraint = safeRecord(price.geoConstraint)
      if (!constraint) {
        invalidInput(
          'Faire price geographic constraint is invalid',
          'FAIRE_PRICE_GEO_INVALID',
        )
      }
      const country = constraint.country === undefined
        ? null
        : boundedText(
          constraint.country,
          'Faire price country',
          'FAIRE_PRICE_GEO_INVALID',
          64,
        ).toUpperCase()
      const countryGroup = constraint.countryGroup === undefined
        ? null
        : boundedText(
          constraint.countryGroup,
          'Faire price country group',
          'FAIRE_PRICE_GEO_INVALID',
          64,
        ).toUpperCase()
      if (!country && !countryGroup) {
        invalidInput(
          'Faire price geographic constraint is empty',
          'FAIRE_PRICE_GEO_INVALID',
        )
      }
      payload.geo_constraint = {
        ...(country ? { country } : {}),
        ...(countryGroup ? { country_group: countryGroup } : {}),
      }
    }
    return payload
  })
}

function normalizeProductVariants(value: unknown) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_PRODUCT_VARIANTS
  ) {
    invalidInput(
      `Faire draft product requires 1-${MAX_PRODUCT_VARIANTS} variants`,
      'FAIRE_PRODUCT_VARIANTS_INVALID',
    )
  }
  const seenSkus = new Set<string>()
  const seenTokens = new Set<string>()
  return value.map((candidate) => {
    const variant = safeRecord(candidate)
    if (!variant) {
      invalidInput('Faire product variant is invalid', 'FAIRE_PRODUCT_VARIANT_INVALID')
    }
    const sku = normalizeSku(variant.sku)
    const idempotenceToken = normalizeIdempotenceToken(
      variant.idempotenceToken,
      'Faire variant idempotence token',
    )
    if (seenSkus.has(sku) || seenTokens.has(idempotenceToken)) {
      invalidInput(
        'Faire draft product variants must have unique SKUs and tokens',
        'FAIRE_PRODUCT_VARIANT_DUPLICATE',
      )
    }
    seenSkus.add(sku)
    seenTokens.add(idempotenceToken)
    const payload: Record<string, unknown> = {
      idempotence_token: idempotenceToken,
      name: boundedText(
        variant.name,
        'Faire variant name',
        'FAIRE_PRODUCT_VARIANT_INVALID',
        255,
      ),
      sku,
      prices: normalizeVariantPrices(variant.prices),
      orderability_type: 'IMMEDIATE',
    }
    if (variant.orderabilityType !== undefined
        && variant.orderabilityType !== 'IMMEDIATE') {
      invalidInput(
        'Faire draft test variants must be immediately orderable',
        'FAIRE_PRODUCT_VARIANT_INVALID',
      )
    }
    if (variant.images !== undefined) {
      payload.images = normalizeProductImages(variant.images)
    }
    if (variant.options !== undefined) {
      if (!Array.isArray(variant.options) || variant.options.length > 20) {
        invalidInput('Faire variant options are invalid', 'FAIRE_VARIANT_OPTIONS_INVALID')
      }
      payload.options = variant.options.map((candidate) => {
        const option = safeRecord(candidate)
        if (!option) {
          invalidInput('Faire variant option is invalid', 'FAIRE_VARIANT_OPTIONS_INVALID')
        }
        return {
          name: boundedText(
            option.name,
            'Faire variant option name',
            'FAIRE_VARIANT_OPTIONS_INVALID',
            80,
          ),
          value: boundedText(
            option.value,
            'Faire variant option value',
            'FAIRE_VARIANT_OPTIONS_INVALID',
            255,
          ),
        }
      })
    }
    if (variant.tariffCode !== undefined) {
      payload.tariff_code = boundedText(
        variant.tariffCode,
        'Faire tariff code',
        'FAIRE_TARIFF_CODE_INVALID',
        32,
      )
    }
    return payload
  })
}

function normalizeDraftProductCreate(input: FaireProductDraftCreateInput) {
  const unitMultiplier = input?.unitMultiplier
  const minimumOrderQuantity = input?.minimumOrderQuantity
  if (
    !Number.isSafeInteger(unitMultiplier)
    || Number(unitMultiplier) < 1
    || !Number.isSafeInteger(minimumOrderQuantity)
    || Number(minimumOrderQuantity) < Number(unitMultiplier)
    || Number(minimumOrderQuantity) % Number(unitMultiplier) !== 0
  ) {
    invalidInput(
      'Faire product order quantities are invalid',
      'FAIRE_PRODUCT_ORDER_QUANTITY_INVALID',
    )
  }
  const payload: Record<string, unknown> = {
    idempotence_token: normalizeIdempotenceToken(
      input?.idempotenceToken,
      'Faire product idempotence token',
    ),
    name: boundedText(
      input?.name,
      'Faire product name',
      'FAIRE_PRODUCT_NAME_INVALID',
      255,
    ),
    lifecycle_state: 'DRAFT',
    variants: normalizeProductVariants(input?.variants),
    unit_multiplier: Number(unitMultiplier),
    minimum_order_quantity: Number(minimumOrderQuantity),
    allow_sales_when_out_of_stock: input?.allowSalesWhenOutOfStock === true,
  }
  if (input?.description !== undefined) {
    payload.description = boundedText(
      input.description,
      'Faire product description',
      'FAIRE_PRODUCT_DESCRIPTION_INVALID',
      65_535,
      true,
    )
  }
  if (input?.shortDescription !== undefined) {
    payload.short_description = boundedText(
      input.shortDescription,
      'Faire product short description',
      'FAIRE_PRODUCT_DESCRIPTION_INVALID',
      255,
      true,
    )
  }
  if (input?.images !== undefined) {
    payload.images = normalizeProductImages(input.images)
  }
  if (input?.variantOptionSets !== undefined) {
    if (!Array.isArray(input.variantOptionSets) || input.variantOptionSets.length > 20) {
      invalidInput(
        'Faire variant option sets are invalid',
        'FAIRE_VARIANT_OPTION_SETS_INVALID',
      )
    }
    payload.variant_option_sets = input.variantOptionSets.map((candidate) => {
      const optionSet = safeRecord(candidate)
      if (!optionSet || !Array.isArray(optionSet.values)
          || optionSet.values.length < 1 || optionSet.values.length > 100) {
        invalidInput(
          'Faire variant option set is invalid',
          'FAIRE_VARIANT_OPTION_SETS_INVALID',
        )
      }
      return {
        name: boundedText(
          optionSet.name,
          'Faire variant option-set name',
          'FAIRE_VARIANT_OPTION_SETS_INVALID',
          80,
        ),
        values: optionSet.values.map((value) => boundedText(
          value,
          'Faire variant option-set value',
          'FAIRE_VARIANT_OPTION_SETS_INVALID',
          255,
        )),
      }
    })
  }
  if (input?.madeInCountry !== undefined) {
    payload.made_in_country = boundedText(
      input.madeInCountry,
      'Faire country of origin',
      'FAIRE_MADE_IN_COUNTRY_INVALID',
      64,
    ).toUpperCase()
  }
  return payload
}

function normalizeDraftProductPatch(input: FaireProductDraftPatchInput) {
  const candidate = safeRecord(input)
  if (!candidate) {
    invalidInput('Faire product patch is invalid', 'FAIRE_PRODUCT_PATCH_INVALID')
  }
  const payload: Record<string, unknown> = {}
  if (candidate.name !== undefined) {
    payload.name = boundedText(
      candidate.name,
      'Faire product name',
      'FAIRE_PRODUCT_NAME_INVALID',
      255,
    )
  }
  if (candidate.description !== undefined) {
    payload.description = boundedText(
      candidate.description,
      'Faire product description',
      'FAIRE_PRODUCT_DESCRIPTION_INVALID',
      65_535,
      true,
    )
  }
  if (candidate.shortDescription !== undefined) {
    payload.short_description = boundedText(
      candidate.shortDescription,
      'Faire product short description',
      'FAIRE_PRODUCT_DESCRIPTION_INVALID',
      255,
      true,
    )
  }
  if (candidate.images !== undefined) {
    payload.images = normalizeProductImages(candidate.images)
  }
  if (candidate.allowSalesWhenOutOfStock !== undefined) {
    if (typeof candidate.allowSalesWhenOutOfStock !== 'boolean') {
      invalidInput(
        'Faire out-of-stock sale setting is invalid',
        'FAIRE_PRODUCT_PATCH_INVALID',
      )
    }
    payload.allow_sales_when_out_of_stock = candidate.allowSalesWhenOutOfStock
  }
  if (candidate.madeInCountry !== undefined) {
    payload.made_in_country = boundedText(
      candidate.madeInCountry,
      'Faire country of origin',
      'FAIRE_MADE_IN_COUNTRY_INVALID',
      64,
    ).toUpperCase()
  }
  if (Object.keys(payload).length === 0) {
    invalidInput('Faire product patch is empty', 'FAIRE_PRODUCT_PATCH_EMPTY')
  }
  return payload
}

function normalizeImageUpload(input: FaireImageUploadInput) {
  const attachment = typeof input?.attachmentBase64 === 'string'
    ? input.attachmentBase64.trim()
    : ''
  if (
    !attachment
    || attachment.length > MAX_IMAGE_REQUEST_BYTES
    || attachment.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment)
  ) {
    invalidInput('Faire image attachment is invalid', 'FAIRE_IMAGE_ATTACHMENT_INVALID')
  }
  const bytes = Buffer.from(attachment, 'base64')
  if (
    bytes.byteLength < 1
    || bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES
    || bytes.toString('base64') !== attachment
  ) {
    invalidInput('Faire image attachment is invalid', 'FAIRE_IMAGE_ATTACHMENT_INVALID')
  }
  return { attachment }
}

function normalizeInventoryUpdate(input: FaireInventoryUpdateInput) {
  const candidate = safeRecord(input)
  if (
    !candidate
    || !['skus', 'product_variant_ids'].includes(String(candidate.by || ''))
    || !Array.isArray(candidate.inventories)
    || candidate.inventories.length < 1
    || candidate.inventories.length > MAX_INVENTORY_SELECTORS
  ) {
    invalidInput('Faire inventory update is invalid', 'FAIRE_INVENTORY_UPDATE_INVALID')
  }
  const by = candidate.by as FaireInventoryUpdateInput['by']
  const selectors = new Set<string>()
  const inventories = candidate.inventories.map((value) => {
    const inventory = safeRecord(value)
    if (!inventory || !Number.isSafeInteger(inventory.onHandQuantity)) {
      invalidInput('Faire inventory quantity is invalid', 'FAIRE_INVENTORY_QUANTITY_INVALID')
    }
    const sku = inventory.sku === undefined ? null : normalizeSku(inventory.sku)
    const productVariantId = inventory.productVariantId === undefined
      ? null
      : normalizeResourceId(
        inventory.productVariantId,
        'Faire product variant ID',
        'FAIRE_PRODUCT_VARIANT_ID_INVALID',
      )
    const selector = by === 'skus' ? sku : productVariantId
    if (!selector || selectors.has(selector)) {
      invalidInput(
        'Faire inventory update selectors are invalid or duplicated',
        'FAIRE_INVENTORY_UPDATE_INVALID',
      )
    }
    selectors.add(selector)
    return {
      ...(sku ? { sku } : {}),
      ...(productVariantId ? { product_variant_id: productVariantId } : {}),
      on_hand_quantity: Number(inventory.onHandQuantity),
    }
  })
  const query = new URLSearchParams()
  const queryKey = by === 'skus' ? 'skus' : 'ids'
  for (const selector of selectors) query.append(queryKey, selector)
  return {
    pathname: by === 'skus'
      ? '/product-inventory/by-skus'
      : '/product-inventory/by-product-variant-ids',
    query,
    selectors: inventories.map((inventory) => ({
      selector: by === 'skus'
        ? String(inventory.sku)
        : String(inventory.product_variant_id),
      onHandQuantity: inventory.on_hand_quantity,
    })),
    body: { inventories },
  }
}

function normalizeCancellation(input: FaireCancelOrderInput) {
  const reason = input?.reason
  if (
    typeof reason !== 'string'
    || !(FAIRE_ORDER_CANCELLATION_REASONS as readonly string[]).includes(reason)
  ) {
    invalidInput(
      'Faire cancellation reason is invalid',
      'FAIRE_CANCELLATION_REASON_INVALID',
    )
  }

  const payload: { reason: FaireOrderCancellationReason; note?: string } = {
    reason,
  }
  if (input?.note !== undefined && input.note !== null) {
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (note) {
      if (
        note.length < 30
        || note.length > 1000
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)
      ) {
        invalidInput(
          'Faire cancellation note must be 30-1000 readable characters',
          'FAIRE_CANCELLATION_NOTE_INVALID',
        )
      }
      payload.note = note
    }
  }
  return payload
}

function normalizeAvailabilities(
  input: FaireOrderItemAvailabilities,
): Record<string, Record<string, unknown>> {
  const entries = safeRecord(input) ? Object.entries(input) : []
  if (entries.length === 0 || entries.length > MAX_AVAILABILITY_ITEMS) {
    invalidInput(
      `Faire availability requires 1-${MAX_AVAILABILITY_ITEMS} order items`,
      'FAIRE_AVAILABILITY_ITEMS_INVALID',
    )
  }

  return Object.fromEntries(entries.map(([keyValue, value]) => {
    const key = normalizeResourceId(
      keyValue,
      'Faire order-item availability key',
      'FAIRE_ORDER_ITEM_ID_INVALID',
    )
    const item = safeRecord(value)
    if (!item) {
      invalidInput(
        'Faire order-item availability is invalid',
        'FAIRE_AVAILABILITY_INVALID',
      )
    }

    const payload: Record<string, unknown> = {}
    if (item.availableQuantity !== undefined) {
      if (
        typeof item.availableQuantity !== 'number'
        || !Number.isInteger(item.availableQuantity)
        || item.availableQuantity < 0
      ) {
        invalidInput(
          'Faire available quantity must be a non-negative integer',
          'FAIRE_AVAILABLE_QUANTITY_INVALID',
        )
      }
      payload.available_quantity = item.availableQuantity
    }
    if (item.discontinued !== undefined) {
      if (typeof item.discontinued !== 'boolean') {
        invalidInput(
          'Faire discontinued status must be true or false',
          'FAIRE_DISCONTINUED_INVALID',
        )
      }
      payload.discontinued = item.discontinued
    }
    if (item.backorderedUntil !== undefined) {
      payload.backordered_until = normalizeTimestamp(
        item.backorderedUntil,
        'Faire backordered-until value',
        'FAIRE_BACKORDERED_UNTIL_INVALID',
      )
    }
    if (Object.keys(payload).length === 0) {
      invalidInput(
        'Faire order-item availability requires at least one change',
        'FAIRE_AVAILABILITY_EMPTY',
      )
    }
    return [key, payload]
  }))
}

function normalizeShipment(input: FaireShipmentInput, orderId: string) {
  const carrier = typeof input?.carrier === 'string'
    ? input.carrier.trim()
    : ''
  if (
    !carrier
    || carrier.length > 80
    || /[\u0000-\u001f\u007f]/.test(carrier)
  ) {
    invalidInput('Faire shipment carrier is invalid', 'FAIRE_CARRIER_INVALID')
  }

  const trackingCode = typeof input?.trackingCode === 'string'
    ? input.trackingCode.trim()
    : ''
  if (
    !trackingCode
    || trackingCode.length > 255
    || /[\u0000-\u001f\u007f]/.test(trackingCode)
  ) {
    invalidInput(
      'Faire shipment tracking code is invalid',
      'FAIRE_TRACKING_CODE_INVALID',
    )
  }

  if (
    input?.shippingType !== 'SHIP_ON_YOUR_OWN'
    && input?.shippingType !== 'SHIP_WITH_FAIRE'
  ) {
    invalidInput(
      'Faire shipment type is invalid',
      'FAIRE_SHIPPING_TYPE_INVALID',
    )
  }

  const payload: Record<string, unknown> = {
    order_id: orderId,
    carrier,
    tracking_code: trackingCode,
    shipping_type: input.shippingType,
  }
  if (input?.makerCost !== undefined && input.makerCost !== null) {
    const amountMinor = input.makerCost.amountMinor
    const currency = typeof input.makerCost.currency === 'string'
      ? input.makerCost.currency.trim().toUpperCase()
      : ''
    if (
      typeof amountMinor !== 'number'
      || !Number.isInteger(amountMinor)
      || amountMinor < 0
      || !/^[A-Z]{3}$/.test(currency)
    ) {
      invalidInput(
        'Faire shipment maker cost is invalid',
        'FAIRE_MAKER_COST_INVALID',
      )
    }
    payload.maker_cost = {
      amount_minor: amountMinor,
      currency,
    }
  }
  return payload
}

function normalizeShipments(
  input: readonly FaireShipmentInput[],
  orderId: string,
) {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.length > MAX_SHIPMENTS
  ) {
    invalidInput(
      `Faire shipment request requires 1-${MAX_SHIPMENTS} shipments`,
      'FAIRE_SHIPMENTS_INVALID',
    )
  }
  const trackingCodes = new Set<string>()
  return input.map((shipment) => {
    const normalized = normalizeShipment(shipment, orderId)
    const trackingCode = String(normalized.tracking_code)
    if (trackingCodes.has(trackingCode)) {
      invalidInput(
        'Faire shipment tracking codes must be unique',
        'FAIRE_TRACKING_CODE_DUPLICATE',
      )
    }
    trackingCodes.add(trackingCode)
    return normalized
  })
}

function requestUrl(pathname: string, query?: URLSearchParams) {
  if (
    !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
    || pathname.includes('..')
    || pathname.includes('?')
    || pathname.includes('#')
    || /[\u0000-\u001f\u007f]/.test(pathname)
  ) {
    throw new FaireCommerceClientError(
      'Faire request path is invalid',
      500,
      'FAIRE_REQUEST_PATH_INVALID',
    )
  }
  const url = new URL(`${FAIRE_API_BASE_URL}${pathname}`)
  if (
    url.origin !== FAIRE_API_ORIGIN
    || !url.pathname.startsWith(FAIRE_API_PATH_PREFIX)
  ) {
    throw new FaireCommerceClientError(
      'Faire request origin is invalid',
      500,
      'FAIRE_REQUEST_ORIGIN_INVALID',
    )
  }
  if (query) url.search = query.toString()
  return url
}

function serializeRequestBody(value: unknown, maxBytes = MAX_REQUEST_BYTES) {
  let body: string
  try {
    body = JSON.stringify(value)
  } catch {
    throw new FaireCommerceClientError(
      'Faire request body is invalid',
      400,
      'FAIRE_REQUEST_BODY_INVALID',
    )
  }
  if (typeof body !== 'string') {
    throw new FaireCommerceClientError(
      'Faire request body is invalid',
      400,
      'FAIRE_REQUEST_BODY_INVALID',
    )
  }
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new FaireCommerceClientError(
      'Faire request exceeded the safe size limit',
      400,
      'FAIRE_REQUEST_TOO_LARGE',
    )
  }
  return body
}

async function readBoundedResponse(response: Response) {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new FaireCommerceClientError(
      'Faire response exceeded the safe size limit',
      502,
      'FAIRE_RESPONSE_TOO_LARGE',
    )
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // Preserve the bounded-response error if cancellation also fails.
      }
      throw new FaireCommerceClientError(
        'Faire response exceeded the safe size limit',
        502,
        'FAIRE_RESPONSE_TOO_LARGE',
      )
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function upstreamError(status: number) {
  if (status === 400 || status === 422) {
    return new FaireCommerceClientError(
      'Faire rejected the integration request',
      422,
      'FAIRE_REQUEST_REJECTED',
    )
  }
  if (status === 401 || status === 403) {
    return new FaireCommerceClientError(
      'Faire denied access for the configured integration',
      422,
      'FAIRE_ACCESS_DENIED',
    )
  }
  if (status === 404) {
    return new FaireCommerceClientError(
      'The requested Faire resource was not found',
      404,
      'FAIRE_RESOURCE_NOT_FOUND',
    )
  }
  if (status === 409) {
    return new FaireCommerceClientError(
      'The Faire request conflicted with the current resource state',
      409,
      'FAIRE_RESOURCE_CONFLICT',
    )
  }
  if (status === 429) {
    return new FaireCommerceClientError(
      'Faire is temporarily rate limiting integration requests',
      503,
      'FAIRE_RATE_LIMITED',
      true,
    )
  }
  if (status >= 500) {
    return new FaireCommerceClientError(
      'Faire is temporarily unavailable',
      503,
      'FAIRE_UPSTREAM_UNAVAILABLE',
      true,
    )
  }
  return new FaireCommerceClientError(
    'Faire integration request failed',
    502,
    'FAIRE_UPSTREAM_FAILED',
  )
}

function isAbortError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && error.name === 'AbortError',
  )
}

function parseJsonResponse(bytes: Uint8Array) {
  if (bytes.byteLength === 0) return {}
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
}

function expectObject(value: unknown) {
  const record = safeRecord(value)
  if (!record) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

function expectProduct(value: unknown, expectedProductId?: string) {
  const response = expectObject(value)
  const product = safeRecord(response.product) || response
  const productId = typeof product.id === 'string' ? product.id.trim() : ''
  if (
    !/^p_[A-Za-z0-9_-]+$/.test(productId)
    || (expectedProductId && productId !== expectedProductId)
  ) {
    throw new FaireCommerceClientError(
      'Faire returned a different or invalid product',
      502,
      'FAIRE_PRODUCT_RESPONSE_INVALID',
    )
  }
  return product as FaireProduct
}

function expectDraftProduct(value: unknown, expectedProductId?: string) {
  const product = expectProduct(value, expectedProductId)
  if (String(product.lifecycle_state || '').trim().toUpperCase() !== 'DRAFT') {
    throw new FaireCommerceClientError(
      'Faire product is not in the DRAFT lifecycle state',
      409,
      'FAIRE_PRODUCT_NOT_DRAFT',
    )
  }
  return product
}

function expectImageWritableProduct(
  value: unknown,
  expectedProductId?: string,
) {
  const product = expectProduct(value, expectedProductId)
  const lifecycleState = String(product.lifecycle_state || '')
    .trim()
    .toUpperCase()
  if (!['DRAFT', 'PUBLISHED', 'ACTIVE'].includes(lifecycleState)) {
    throw new FaireCommerceClientError(
      'Faire product lifecycle does not permit a Product-image update',
      409,
      'FAIRE_PRODUCT_IMAGE_LIFECYCLE_UNSUPPORTED',
    )
  }
  return product
}

function providerBrandIdentifiers(value: Record<string, unknown>) {
  const nestedBrand = safeRecord(value.brand)
  return [
    value.brand_id,
    value.brandId,
    nestedBrand?.id,
  ].filter((candidate) => candidate !== undefined && candidate !== null)
    .map((candidate) => (
      typeof candidate === 'string' ? candidate.trim() : ''
    ))
}

function profileBrandIdentifiers(value: Record<string, unknown>) {
  return [value.brand_id, value.brandId, value.id]
    .filter((candidate) => candidate !== undefined && candidate !== null)
    .map((candidate) => (
      typeof candidate === 'string' ? candidate.trim() : ''
    ))
}

function expectExactBrandIdentity(
  value: Record<string, unknown>,
  expectedBrandId: string,
  code: string,
  profile = false,
) {
  const identifiers = profile
    ? profileBrandIdentifiers(value)
    : providerBrandIdentifiers(value)
  if (
    identifiers.length > 0
    && identifiers.every((identifier) => (
      identifier === expectedBrandId
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identifier)
    ))
  ) {
    return
  }
  throw new FaireCommerceClientError(
    'Faire returned a different or invalid brand identity',
    409,
    code,
  )
}

function exactRequestedValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => (
        exactRequestedValue(actual[index], value)
      ))
  }
  const expectedRecord = safeRecord(expected)
  if (expectedRecord) {
    const actualRecord = safeRecord(actual)
    if (!actualRecord) return false
    return Object.entries(expectedRecord).every(
      ([key, value]) => (
        Object.prototype.hasOwnProperty.call(actualRecord, key)
        && exactRequestedValue(actualRecord[key], value)
      ),
    )
  }
  return Object.is(actual, expected)
}

function expectRequestedProductReadback(
  value: unknown,
  expectedProductId: string,
  expectedBrandId: string,
  requested: Record<string, unknown>,
) {
  const product = expectDraftProduct(value, expectedProductId)
  if (providerBrandIdentifiers(product).length > 0) {
    expectExactBrandIdentity(
      product,
      expectedBrandId,
      'FAIRE_PRODUCT_BRAND_READBACK_MISMATCH',
    )
  }

  for (const [key, expected] of Object.entries(requested)) {
    if (key === 'variants') continue
    const required = key === 'name'
    if (!Object.prototype.hasOwnProperty.call(product, key)) {
      if (required) {
        throw new FaireCommerceClientError(
          'Faire product readback omitted a required requested field',
          502,
          'FAIRE_PRODUCT_READBACK_MISMATCH',
        )
      }
      continue
    }
    if (!exactRequestedValue(product[key], expected)) {
      throw new FaireCommerceClientError(
        'Faire product readback did not match the requested draft fields',
        409,
        'FAIRE_PRODUCT_READBACK_MISMATCH',
      )
    }
  }

  if (requested.variants !== undefined) {
    if (!Array.isArray(requested.variants) || !Array.isArray(product.variants)) {
      throw new FaireCommerceClientError(
        'Faire product readback omitted the requested variants',
        502,
        'FAIRE_PRODUCT_READBACK_MISMATCH',
      )
    }
    const requestedBySku = new Map<string, Record<string, unknown>>()
    for (const value of requested.variants) {
      const variant = safeRecord(value)
      if (!variant || typeof variant.sku !== 'string') {
        throw new FaireCommerceClientError(
          'Faire requested product variants are invalid',
          500,
          'FAIRE_PRODUCT_READBACK_MISMATCH',
        )
      }
      requestedBySku.set(variant.sku, variant)
    }
    const returnedBySku = new Map<string, Record<string, unknown>>()
    for (const value of product.variants) {
      const variant = safeRecord(value)
      const sku = typeof variant?.sku === 'string' ? variant.sku.trim() : ''
      if (!variant || !sku || returnedBySku.has(sku)) {
        throw new FaireCommerceClientError(
          'Faire product readback included invalid or duplicate variant SKUs',
          502,
          'FAIRE_PRODUCT_READBACK_MISMATCH',
        )
      }
      returnedBySku.set(sku, variant)
    }
    if (
      returnedBySku.size !== requestedBySku.size
      || [...requestedBySku.keys()].some((sku) => !returnedBySku.has(sku))
    ) {
      throw new FaireCommerceClientError(
        'Faire product readback did not match the requested variant SKUs',
        409,
        'FAIRE_PRODUCT_READBACK_MISMATCH',
      )
    }
    for (const [sku, expected] of requestedBySku) {
      const actual = returnedBySku.get(sku)!
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (key === 'sku') continue
        const required = key === 'name'
        if (!Object.prototype.hasOwnProperty.call(actual, key)) {
          if (required) {
            throw new FaireCommerceClientError(
              'Faire product readback omitted a required variant field',
              502,
              'FAIRE_PRODUCT_READBACK_MISMATCH',
            )
          }
          continue
        }
        if (!exactRequestedValue(actual[key], expectedValue)) {
          throw new FaireCommerceClientError(
            'Faire product readback did not match the requested variants',
            409,
            'FAIRE_PRODUCT_READBACK_MISMATCH',
          )
        }
      }
    }
  }
  return product
}

function expectOrder(value: unknown, expectedOrderId: string) {
  const response = expectObject(value)
  const order = safeRecord(response.order) || response
  if (String(order.id || '').trim() !== expectedOrderId) {
    throw new FaireCommerceClientError(
      'Faire returned a different or invalid order',
      502,
      'FAIRE_ORDER_RESPONSE_INVALID',
    )
  }
  return order as FaireOrder
}

function expectImageUpload(value: unknown) {
  const response = expectObject(value)
  return {
    ...response,
    url: normalizeHttpsUrl(
      response.url,
      'Faire uploaded image URL',
      'FAIRE_IMAGE_RESPONSE_INVALID',
    ),
  } as FaireImageUploadResponse
}

function expectObjectCollection(
  value: unknown,
  key: 'products' | 'orders',
) {
  const record = expectObject(value)
  const collection = record[key]
  if (
    !Array.isArray(collection)
    || collection.some((item) => !safeRecord(item))
  ) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

function expectInventoryResponse(value: unknown) {
  const record = expectObject(value)
  const inventories = safeRecord(record.inventories)
  const validQuantity = (quantity: unknown, signed: boolean) => {
    const candidate = safeRecord(quantity)
    if (!candidate) return false
    if (candidate.type === 'UNTRACKED') {
      return candidate.quantity === undefined
    }
    return (
      candidate.type === 'QUANTITY'
      && Number.isSafeInteger(candidate.quantity)
      && (signed || Number(candidate.quantity) >= 0)
    )
  }
  const validLevel = (value: unknown) => {
    const level = safeRecord(value)
    if (!level) return false
    return (
      (
        level.on_hand_quantity === undefined
        || validQuantity(level.on_hand_quantity, true)
      )
      && (
        level.committed_quantity === undefined
        || validQuantity(level.committed_quantity, false)
      )
      && (
        level.available_quantity === undefined
        || validQuantity(level.available_quantity, true)
      )
    )
  }
  if (
    !inventories
    || Object.values(inventories).some((item) => !validLevel(item))
  ) {
    throw new FaireCommerceClientError(
      'Faire returned an invalid response',
      502,
      'FAIRE_RESPONSE_INVALID',
    )
  }
  return record
}

function expectInventoryWriteReadback(
  value: unknown,
  expected: readonly { selector: string; onHandQuantity: number }[],
) {
  const response = expectInventoryResponse(value)
  const inventories = safeRecord(response.inventories)!
  const returnedSelectors = Object.keys(inventories)
  if (
    returnedSelectors.length !== expected.length
    || expected.some(({ selector }) => (
      !Object.prototype.hasOwnProperty.call(inventories, selector)
    ))
  ) {
    throw new FaireCommerceClientError(
      'Faire inventory readback did not match the requested selectors',
      409,
      'FAIRE_INVENTORY_READBACK_MISMATCH',
    )
  }
  for (const { selector, onHandQuantity } of expected) {
    const level = safeRecord(inventories[selector])
    const quantity = safeRecord(level?.on_hand_quantity)
    if (
      quantity?.type !== 'QUANTITY'
      || quantity.quantity !== onHandQuantity
    ) {
      throw new FaireCommerceClientError(
        'Faire inventory readback did not match the requested quantity',
        409,
        'FAIRE_INVENTORY_READBACK_MISMATCH',
      )
    }
  }
  return response
}

export function buildFaireOAuthAuthorizationUrl(
  input: FaireOAuthAuthorizationInput,
) {
  const applicationId = normalizeApplicationId(input.applicationId)
  const redirectUrl = normalizeOAuthRedirectUrl(input.redirectUrl)
  const scopes = normalizeOAuthScopes(input.scopes)
  const state = normalizeOAuthState(input.state)
  const url = new URL(FAIRE_OAUTH_AUTHORIZE_URL)
  url.searchParams.set('applicationId', applicationId)
  for (const scope of scopes) url.searchParams.append('scope', scope)
  url.searchParams.set('state', state)
  url.searchParams.set('redirectUrl', redirectUrl)
  return url.toString()
}

export async function exchangeFaireOAuthAuthorizationCode(
  input: FaireOAuthTokenExchangeInput,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {},
): Promise<FaireOAuthTokenGrant> {
  const applicationId = normalizeApplicationId(input.applicationId)
  const applicationSecret = normalizeApplicationSecret(
    input.applicationSecret,
  )
  const redirectUrl = normalizeOAuthRedirectUrl(input.redirectUrl)
  const scopes = normalizeOAuthScopes(input.scopes)
  normalizeOAuthState(input.state)
  const authorizationCode = normalizeAuthorizationCode(input.authorizationCode)
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : fetch
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    normalizeTimeout(options.timeoutMs),
  )
  let response: Response
  let bytes: Uint8Array
  try {
    assertIntegrationCredentialProviderIoReady()
    response = await fetchImpl(FAIRE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: serializeRequestBody({
        application_token: applicationId,
        application_secret: applicationSecret,
        redirect_url: redirectUrl,
        scope: scopes,
        grant_type: 'AUTHORIZATION_CODE',
        authorization_code: authorizationCode,
      }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    })
    bytes = await readBoundedResponse(response)
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
    if (error instanceof FaireCommerceClientError) throw error
    if (controller.signal.aborted || isAbortError(error)) {
      throw new FaireCommerceClientError(
        'Faire OAuth token exchange timed out',
        504,
        'FAIRE_OAUTH_EXCHANGE_TIMEOUT',
        true,
      )
    }
    throw new FaireCommerceClientError(
      'Faire OAuth token exchange is temporarily unavailable',
      503,
      'FAIRE_OAUTH_EXCHANGE_UNAVAILABLE',
      true,
    )
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new FaireCommerceClientError(
        'Faire rejected the OAuth authorization exchange',
        422,
        'FAIRE_OAUTH_EXCHANGE_REJECTED',
      )
    }
    throw upstreamError(response.status)
  }
  const payload = expectObject(parseJsonResponse(bytes))
  const accessToken = normalizeAccessToken(payload.access_token)
  const tokenType = String(payload.token_type || '').trim().toUpperCase()
  if (tokenType !== 'BEARER') {
    throw new FaireCommerceClientError(
      'Faire returned an invalid OAuth token response',
      502,
      'FAIRE_OAUTH_RESPONSE_INVALID',
    )
  }
  return { accessToken, tokenType }
}

export function createFaireCommerceClient(
  options: FaireCommerceClientOptions,
): FaireCommerceClient {
  const accessToken = normalizeAccessToken(options?.accessToken)
  const credentialBinding = options?.credentialBinding === undefined
    ? null
    : normalizeCredentialBinding(options.credentialBinding)
  const writeAuthorization = options?.writeAuthorization === undefined
    ? null
    : normalizeWriteAuthorization(options.writeAuthorization, credentialBinding)
  const oauthRequested = options?.applicationId !== undefined
    || options?.applicationSecret !== undefined
  const applicationId = oauthRequested
    ? normalizeApplicationId(options?.applicationId)
    : null
  const applicationSecret = oauthRequested
    ? normalizeApplicationSecret(options?.applicationSecret)
    : null
  const fetchImpl = typeof options?.fetchImpl === 'function'
    ? options.fetchImpl
    : fetch
  const timeoutMs = normalizeTimeout(options?.timeoutMs)

  function requireWriteAuthorization(
    capabilities: readonly FaireProviderWriteCapability[],
    scope: FaireProviderWriteScope,
  ) {
    if (!credentialBinding || !writeAuthorization) {
      invalidInput(
        'Explicit Faire provider-write authorization is required',
        'FAIRE_WRITE_AUTHORIZATION_REQUIRED',
      )
    }
    if (
      !writeAuthorization.verifiedWriteScopes.has(scope)
      || capabilities.some((capability) => (
        !writeAuthorization.capabilities.has(capability)
      ))
    ) {
      invalidInput(
        `Verified Faire ${scope} authorization is required`,
        'FAIRE_WRITE_SCOPE_REQUIRED',
      )
    }
  }

  async function request(
    pathname: string,
    input: FaireRequestInput = {},
  ): Promise<unknown> {
    const url = requestUrl(pathname, input.query)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const headers = new Headers({ Accept: 'application/json' })
    if (applicationId && applicationSecret) {
      headers.set(
        'X-FAIRE-APP-CREDENTIALS',
        Buffer.from(
          `${applicationId}:${applicationSecret}`,
          'utf8',
        ).toString('base64'),
      )
      headers.set('X-FAIRE-OAUTH-ACCESS-TOKEN', accessToken)
    } else {
      headers.set('X-FAIRE-ACCESS-TOKEN', accessToken)
    }
    const body = input.body === undefined
      ? undefined
      : serializeRequestBody(input.body, input.maxRequestBytes)
    if (body !== undefined) headers.set('Content-Type', 'application/json')

    let response: Response
    let bytes: Uint8Array
    try {
      assertIntegrationCredentialProviderIoReady()
      response = await fetchImpl(url, {
        method: input.method || 'GET',
        headers,
        body,
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      })
      bytes = await readBoundedResponse(response)
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
      if (error instanceof FaireCommerceClientError) throw error
      if (controller.signal.aborted || isAbortError(error)) {
        throw new FaireCommerceClientError(
          'Faire integration request timed out',
          504,
          'FAIRE_REQUEST_TIMEOUT',
          true,
        )
      }
      throw new FaireCommerceClientError(
        'Faire is temporarily unavailable',
        503,
        'FAIRE_UPSTREAM_UNAVAILABLE',
        true,
      )
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) throw upstreamError(response.status)
    return parseJsonResponse(bytes)
  }

  async function probeBrandProfile() {
    return expectObject(await request('/brands/profile')) as FaireBrandProfile
  }

  async function verifyWriteBrandIdentity() {
    if (!credentialBinding) {
      invalidInput(
        'A verified Faire credential binding is required',
        'FAIRE_CREDENTIAL_BINDING_INVALID',
      )
    }
    const profile = await probeBrandProfile()
    expectExactBrandIdentity(
      profile,
      credentialBinding.externalAccountId,
      'FAIRE_WRITE_BRAND_MISMATCH',
      true,
    )
  }

  async function listProducts(options: FaireProductListOptions = {}) {
    return expectObjectCollection(
      await request('/products', { query: productListQuery(options) }),
      'products',
    ) as FaireProductsPage
  }

  async function getProduct(productIdValue: string) {
    const productId = normalizeResourceId(
      productIdValue,
      'Faire product ID',
      'FAIRE_PRODUCT_ID_INVALID',
    )
    return expectProduct(
      await request(`/products/${productId}`),
      productId,
    )
  }

  async function createDraftProduct(input: FaireProductDraftCreateInput) {
    requireWriteAuthorization(['product_draft_create'], 'WRITE_PRODUCTS')
    const payload = normalizeDraftProductCreate(input)
    await verifyWriteBrandIdentity()
    const created = expectDraftProduct(await request('/products', {
      method: 'POST',
      body: payload,
    }))
    return expectRequestedProductReadback(
      await request(`/products/${String(created.id)}`),
      String(created.id),
      credentialBinding!.externalAccountId,
      payload,
    )
  }

  async function updateDraftProduct(
    productIdValue: string,
    input: FaireProductDraftPatchInput,
  ) {
    requireWriteAuthorization(['product_draft_update'], 'WRITE_PRODUCTS')
    const productId = normalizeResourceId(
      productIdValue,
      'Faire product ID',
      'FAIRE_PRODUCT_ID_INVALID',
    )
    const payload = normalizeDraftProductPatch(input)
    await verifyWriteBrandIdentity()
    const existing = expectDraftProduct(
      await request(`/products/${productId}`),
      productId,
    )
    if (providerBrandIdentifiers(existing).length > 0) {
      expectExactBrandIdentity(
        existing,
        credentialBinding!.externalAccountId,
        'FAIRE_PRODUCT_BRAND_READBACK_MISMATCH',
      )
    }
    expectDraftProduct(await request(`/products/${productId}`, {
      method: 'PATCH',
      body: payload,
    }), productId)
    return expectRequestedProductReadback(
      await request(`/products/${productId}`),
      productId,
      credentialBinding!.externalAccountId,
      payload,
    )
  }

  async function updateProductImages(
    productIdValue: string,
    input: FaireProductImagePatchInput,
  ) {
    requireWriteAuthorization(['product_draft_update'], 'WRITE_PRODUCTS')
    const productId = normalizeResourceId(
      productIdValue,
      'Faire product ID',
      'FAIRE_PRODUCT_ID_INVALID',
    )
    const expectedCurrentImages = normalizeProductImages(
      input?.expectedCurrentImages,
    )
    const images = normalizeProductImages(input?.images)
    if (images.length < 1) {
      invalidInput(
        'Faire Product-image publication requires at least one image',
        'FAIRE_PRODUCT_IMAGES_INVALID',
      )
    }
    await verifyWriteBrandIdentity()
    const existing = expectImageWritableProduct(
      await request(`/products/${productId}`),
      productId,
    )
    if (providerBrandIdentifiers(existing).length > 0) {
      expectExactBrandIdentity(
        existing,
        credentialBinding!.externalAccountId,
        'FAIRE_PRODUCT_BRAND_READBACK_MISMATCH',
      )
    }
    if (!exactRequestedValue(existing.images, expectedCurrentImages)) {
      throw new FaireCommerceClientError(
        'Faire Product images changed after the authoritative base read',
        409,
        'FAIRE_PRODUCT_IMAGE_BASE_SET_CHANGED',
      )
    }
    expectImageWritableProduct(await request(`/products/${productId}`, {
      method: 'PATCH',
      body: { images },
    }), productId)
    const readback = expectImageWritableProduct(
      await request(`/products/${productId}`),
      productId,
    )
    if (providerBrandIdentifiers(readback).length > 0) {
      expectExactBrandIdentity(
        readback,
        credentialBinding!.externalAccountId,
        'FAIRE_PRODUCT_BRAND_READBACK_MISMATCH',
      )
    }
    if (!exactRequestedValue(readback.images, images)) {
      throw new FaireCommerceClientError(
        'Faire product readback did not match the requested Product images',
        409,
        'FAIRE_PRODUCT_IMAGE_READBACK_MISMATCH',
      )
    }
    return readback
  }

  async function uploadProductImage(input: FaireImageUploadInput) {
    requireWriteAuthorization(['product_image_upload'], 'WRITE_PRODUCTS')
    const payload = normalizeImageUpload(input)
    await verifyWriteBrandIdentity()
    return expectImageUpload(await request('/products/upload-image', {
      method: 'POST',
      body: payload,
      maxRequestBytes: MAX_IMAGE_REQUEST_BYTES,
    }))
  }

  async function listOrders(options: FaireListOptions = {}) {
    return expectObjectCollection(
      await request('/orders', { query: listQuery(options) }),
      'orders',
    ) as FaireOrdersPage
  }

  async function getOrder(orderIdValue: string) {
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectOrder(await request(`/orders/${orderId}`), orderId)
  }

  async function listInventory(query: FaireInventoryQuery) {
    const inventory = inventoryRequest(query)
    return expectInventoryResponse(await request(inventory.pathname, {
      query: inventory.query,
    })) as FaireInventoryResponse
  }

  async function updateInventory(input: FaireInventoryUpdateInput) {
    requireWriteAuthorization(['inventory_update'], 'WRITE_INVENTORIES')
    const update = normalizeInventoryUpdate(input)
    await verifyWriteBrandIdentity()
    expectInventoryWriteReadback(await request(update.pathname, {
      method: 'PATCH',
      body: update.body,
    }), update.selectors)
    return expectInventoryWriteReadback(await request(update.pathname, {
      query: update.query,
    }), update.selectors) as FaireInventoryResponse
  }

  async function moveOrderToProcessing(
    orderIdValue: string,
    input: FaireMoveOrderToProcessingInput = {},
  ) {
    requireWriteAuthorization(['order_processing'], 'WRITE_ORDERS')
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    const expectedShipDate = normalizeOptionalTimestamp(
      input?.expectedShipDate,
      'Faire expected ship date',
      'FAIRE_EXPECTED_SHIP_DATE_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/processing`, {
      method: 'PUT',
      body: expectedShipDate
        ? { expected_ship_date: expectedShipDate }
        : {},
    }))
  }

  async function cancelOrder(
    orderIdValue: string,
    input: FaireCancelOrderInput,
  ) {
    requireWriteAuthorization(['order_cancel'], 'WRITE_ORDERS')
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/cancel`, {
      method: 'PUT',
      body: normalizeCancellation(input),
    }))
  }

  async function setOrderItemsAvailability(
    orderIdValue: string,
    availabilities: FaireOrderItemAvailabilities,
  ) {
    requireWriteAuthorization(['order_availability'], 'WRITE_ORDERS')
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/items/availability`, {
      method: 'POST',
      body: {
        availabilities: normalizeAvailabilities(availabilities),
      },
    }))
  }

  async function addOrderShipments(
    orderIdValue: string,
    shipments: readonly FaireShipmentInput[],
  ) {
    requireWriteAuthorization(
      ['fulfillment_export', 'tracking_export'],
      'WRITE_ORDERS',
    )
    const orderId = normalizeResourceId(
      orderIdValue,
      'Faire order ID',
      'FAIRE_ORDER_ID_INVALID',
    )
    return expectObject(await request(`/orders/${orderId}/shipments`, {
      method: 'POST',
      body: {
        shipments: normalizeShipments(shipments, orderId),
      },
    }))
  }

  async function addOrderShipment(
    orderId: string,
    shipment: FaireShipmentInput,
  ) {
    return addOrderShipments(orderId, [shipment])
  }

  return Object.freeze({
    probeBrandProfile,
    listProducts,
    getProduct,
    createDraftProduct,
    updateDraftProduct,
    updateProductImages,
    uploadProductImage,
    listOrders,
    getOrder,
    listInventory,
    updateInventory,
    moveOrderToProcessing,
    cancelOrder,
    setOrderItemsAvailability,
    setOrderItemAvailability: setOrderItemsAvailability,
    addOrderShipments,
    addOrderShipment,
  })
}

export function probeFaireBrandProfile(options: FaireCommerceClientOptions) {
  return createFaireCommerceClient(options).probeBrandProfile()
}

export function listFaireProducts(
  options: FaireCommerceClientOptions,
  listOptions?: FaireProductListOptions,
) {
  return createFaireCommerceClient(options).listProducts(listOptions)
}

export function getFaireProduct(
  options: FaireCommerceClientOptions,
  productId: string,
) {
  return createFaireCommerceClient(options).getProduct(productId)
}

export function createFaireDraftProduct(
  options: FaireCommerceClientOptions,
  input: FaireProductDraftCreateInput,
) {
  return createFaireCommerceClient(options).createDraftProduct(input)
}

export function updateFaireDraftProduct(
  options: FaireCommerceClientOptions,
  productId: string,
  input: FaireProductDraftPatchInput,
) {
  return createFaireCommerceClient(options).updateDraftProduct(productId, input)
}

export function updateFaireProductImages(
  options: FaireCommerceClientOptions,
  productId: string,
  input: FaireProductImagePatchInput,
) {
  return createFaireCommerceClient(options).updateProductImages(
    productId,
    input,
  )
}

export function uploadFaireProductImage(
  options: FaireCommerceClientOptions,
  input: FaireImageUploadInput,
) {
  return createFaireCommerceClient(options).uploadProductImage(input)
}

export function listFaireOrders(
  options: FaireCommerceClientOptions,
  listOptions?: FaireListOptions,
) {
  return createFaireCommerceClient(options).listOrders(listOptions)
}

export function getFaireOrder(
  options: FaireCommerceClientOptions,
  orderId: string,
) {
  return createFaireCommerceClient(options).getOrder(orderId)
}

export function listFaireInventory(
  options: FaireCommerceClientOptions,
  query: FaireInventoryQuery,
) {
  return createFaireCommerceClient(options).listInventory(query)
}

export function updateFaireInventory(
  options: FaireCommerceClientOptions,
  input: FaireInventoryUpdateInput,
) {
  return createFaireCommerceClient(options).updateInventory(input)
}

export function moveFaireOrderToProcessing(
  options: FaireCommerceClientOptions,
  orderId: string,
  input?: FaireMoveOrderToProcessingInput,
) {
  return createFaireCommerceClient(options).moveOrderToProcessing(orderId, input)
}

export function cancelFaireOrder(
  options: FaireCommerceClientOptions,
  orderId: string,
  input: FaireCancelOrderInput,
) {
  return createFaireCommerceClient(options).cancelOrder(orderId, input)
}

export function setFaireOrderItemAvailability(
  options: FaireCommerceClientOptions,
  orderId: string,
  availabilities: FaireOrderItemAvailabilities,
) {
  return createFaireCommerceClient(options)
    .setOrderItemsAvailability(orderId, availabilities)
}

export function setFaireOrderItemsAvailability(
  options: FaireCommerceClientOptions,
  orderId: string,
  availabilities: FaireOrderItemAvailabilities,
) {
  return setFaireOrderItemAvailability(options, orderId, availabilities)
}

export function addFaireOrderShipment(
  options: FaireCommerceClientOptions,
  orderId: string,
  shipment: FaireShipmentInput,
) {
  return createFaireCommerceClient(options).addOrderShipment(orderId, shipment)
}

export function addFaireOrderShipments(
  options: FaireCommerceClientOptions,
  orderId: string,
  shipments: readonly FaireShipmentInput[],
) {
  return createFaireCommerceClient(options).addOrderShipments(orderId, shipments)
}
