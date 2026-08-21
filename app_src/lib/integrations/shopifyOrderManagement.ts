import { createHash } from 'node:crypto'
import {
  SHOPIFY_ADMIN_API_VERSION,
  hasEffectiveShopifyScope,
  type ShopifyAccessScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  type ShopifyClientCredentials,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
  type ShopifyConnectionProbe,
} from '@/lib/integrations/shopifyCommerceClient'

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const LINE_ITEM_GID_PATTERN = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const CALCULATED_ORDER_GID_PATTERN =
  /^gid:\/\/shopify\/CalculatedOrder\/[A-Za-z0-9][A-Za-z0-9-]*$/
const ORDER_EDIT_SESSION_GID_PATTERN =
  /^gid:\/\/shopify\/OrderEditSession\/[A-Za-z0-9][A-Za-z0-9-]*$/
const CALCULATED_LINE_ITEM_GID_PATTERN =
  /^gid:\/\/shopify\/CalculatedLineItem\/[A-Za-z0-9][A-Za-z0-9-]*$/
const JOB_GID_PATTERN = /^gid:\/\/shopify\/Job\/[A-Za-z0-9][A-Za-z0-9-]*$/
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const CURRENCY_CODE_PATTERN = /^(?:[A-Z]{3}|USDC)$/
const DECIMAL_AMOUNT_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const MAX_ORDER_LINES = 250
const MAX_GID_LENGTH = 255
const MAX_TAGS = 250
const MAX_TAG_LENGTH = 255
const MAX_NOTE_LENGTH = 5_000
const MAX_EMAIL_LENGTH = 254
const MAX_PHONE_LENGTH = 64
const MAX_PO_NUMBER_LENGTH = 255
const MAX_STAFF_NOTE_LENGTH = 255
const MAX_USER_ERRORS = 50

export const SHOPIFY_ORDER_MANAGEMENT_API_VERSION = SHOPIFY_ADMIN_API_VERSION
export const SHOPIFY_ORDER_MANAGEMENT_ADAPTER_VERSION =
  'shopify-graphql-2026-07-order-management-v1'

if (SHOPIFY_ORDER_MANAGEMENT_API_VERSION !== '2026-07') {
  throw new Error('Shopify order management requires Admin API 2026-07')
}

export type ShopifyOrderManagementAction =
  | {
      type: 'add_tag'
      tag: string
    }
  | {
      type: 'cancel'
      reason?: 'OTHER' | 'STAFF'
      staffNote?: string | null
    }
  | {
      type: 'set_line_quantity'
      lineItemGid: string
      quantity: number
      staffNote?: string | null
    }
  | {
      type: 'save_order'
      email: string | null
      phone: string | null
      poNumber: string | null
      note: string | null
      tagAdds: string[]
      tagRemoves: string[]
      lineQuantities: Array<{
        lineItemGid: string
        quantity: number
      }>
    }

export type ShopifyOrderManagementExpectedIdentity = {
  shopId: string
  shopDomain: string
  orderGid: string
  orderName: string
  updatedAt: string
}

export type ShopifyOrderManagementLine = {
  id: string
  name: string
  sku: string | null
  currentQuantity: number
  unfulfilledQuantity: number
  nonFulfillableQuantity: number
  merchantEditable: boolean
}

export type ShopifyOrderManagementPreview = {
  id: string
  legacyResourceId: string
  name: string
  test: boolean
  createdAt: string
  updatedAt: string
  cancelledAt: string | null
  closed: boolean
  unpaid: boolean
  capturable: boolean
  displayFinancialStatus: string | null
  displayFulfillmentStatus: string
  merchantEditable: boolean
  merchantEditableErrors: string[]
  returnStatus: string
  shopCurrencyCode: string
  orderCurrencyCode: string
  currentTotalPrice: ShopifyOrderManagementMoney
  totalOutstanding: ShopifyOrderManagementMoney
  email: string | null
  phone: string | null
  poNumber: string | null
  note: string | null
  tags: string[]
  lines: ShopifyOrderManagementLine[]
}

export type ShopifyOrderTagMutationResult = {
  orderGid: string
  orderName: string
  updatedAt: string
  tags: string[]
}

export type ShopifyOrderMetadataMutationResult =
  ShopifyOrderTagMutationResult & {
    email: string | null
    phone: string | null
    poNumber: string | null
    note: string | null
  }

export type ShopifyOrderSaveResult = {
  orderGid: string
  orderName: string
  updatedAt: string
  metadataChanged: boolean
  changedLineCount: number
}

export type ShopifyOrderCancelMutationResult = {
  jobGid: string
  done: boolean
}

export type ShopifyOrderManagementJobRead = {
  jobGid: string
  done: boolean
}

export type ShopifyOrderEditBeginResult = {
  calculatedOrderGid: string
  orderEditSessionGid: string
}

export type ShopifyOrderEditQuantityResult = {
  calculatedOrderGid: string
  calculatedLineItemGid: string
  quantity: number
  totalPrice: ShopifyOrderManagementMoney
  totalOutstanding: ShopifyOrderManagementMoney
}

export type ShopifyOrderManagementMoney = {
  amount: string
  currencyCode: string
}

export type ShopifyOrderEditCommitResult = {
  orderGid: string
  orderName: string
  updatedAt: string
  successMessages: string[]
}

export type ShopifyOrderManagementDependencies = {
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  graphql: typeof shopifyAdminGraphql
}

const DEFAULT_DEPENDENCIES: ShopifyOrderManagementDependencies = {
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  graphql: shopifyAdminGraphql,
}

export class ShopifyOrderManagementError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable = false
  readonly providerRejected: boolean
  readonly stage: string

  constructor(input: {
    code: string
    message: string
    status?: number
    providerRejected?: boolean
    stage?: string
  }) {
    super(input.message)
    this.name = 'ShopifyOrderManagementError'
    this.code = input.code
    this.status = input.status || 409
    this.providerRejected = Boolean(input.providerRejected)
    this.stage = input.stage || 'validation'
  }
}

export type ShopifyOrderManagementExecutionResult = {
  action: ShopifyOrderManagementAction['type']
  outcome: 'outcomeUnknown' | 'rejected' | 'succeeded'
  providerReads: 2 | 3
  providerMutationAttempted: boolean
  providerWritesKnown: boolean
  providerWrites: number | null
  retryable: false
  probe: ShopifyConnectionProbe
  before: ShopifyOrderManagementPreview
  after: ShopifyOrderManagementPreview | null
  result:
    | ShopifyOrderCancelMutationResult
    | ShopifyOrderEditCommitResult
    | ShopifyOrderTagMutationResult
    | ShopifyOrderSaveResult
    | null
  providerReference: string | null
  errorCode: string | null
  safeMessage: string | null
}

export type ExecuteShopifyOrderManagementInput = {
  credential: ShopifyClientCredentials
  expected: ShopifyOrderManagementExpectedIdentity
  action: ShopifyOrderManagementAction
  clientOptions?: ShopifyCommerceClientOptions
}

export type InspectShopifyOrderManagementTargetInput = {
  credential: ShopifyClientCredentials
  expected: {
    shopId: string
    shopDomain: string
    orderGid: string
    orderName?: string
  }
  requiredActions?: readonly ShopifyOrderManagementAction['type'][]
  jobGid?: string
  clientOptions?: ShopifyCommerceClientOptions
}

export type InspectShopifyOrderManagementTargetResult = {
  probe: ShopifyConnectionProbe
  preview: ShopifyOrderManagementPreview
  job: ShopifyOrderManagementJobRead | null
  grantedScopes: string[]
  providerReads: 2 | 3
}

type SafeUserError = {
  field: string[]
  message: string
  code: string | null
}

function fail(
  code: string,
  message: string,
  status = 400,
  input: { providerRejected?: boolean; stage?: string } = {},
): never {
  throw new ShopifyOrderManagementError({
    code,
    message,
    status,
    ...input,
  })
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function strictText(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || (!options.allowEmpty && value.length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return value
}

function inputText(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > maximum
    || (!options.allowEmpty && value.length === 0)
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return value
}

function strictGid(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (
    typeof value !== 'string'
    || value.length > MAX_GID_LENGTH
    || !pattern.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return value
}

function inputGid(value: unknown, label: string, pattern: RegExp): string {
  if (
    typeof value !== 'string'
    || value.length > MAX_GID_LENGTH
    || !pattern.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return value
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return value
}

function strictNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return Number(value)
}

function strictCurrencyCode(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !CURRENCY_CODE_PATTERN.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return value
}

function inputCurrencyCode(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !CURRENCY_CODE_PATTERN.test(value)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return value
}

function strictMoney(
  value: unknown,
  label: string,
  expectedCurrencyCode: string,
  options: { allowNegative?: boolean } = {},
): ShopifyOrderManagementMoney {
  const bag = safeRecord(value)
  const money = safeRecord(bag?.shopMoney)
  if (!bag || !money) {
    fail(
      'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
      `Shopify did not return staged ${label}`,
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  const amount = money.amount
  if (
    typeof amount !== 'string'
    || amount.length < 1
    || amount.length > 128
    || !DECIMAL_AMOUNT_PATTERN.test(amount)
    || (!options.allowNegative && amount.startsWith('-'))
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
      `Shopify returned invalid staged ${label}`,
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  const currencyCode = money.currencyCode
  if (
    typeof currencyCode !== 'string'
    || !CURRENCY_CODE_PATTERN.test(currencyCode)
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_FINANCIAL_RESPONSE_INVALID',
      `Shopify returned invalid staged ${label} currency`,
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  if (currencyCode !== expectedCurrencyCode) {
    fail(
      'SHOPIFY_ORDER_EDIT_FINANCIAL_CURRENCY_MISMATCH',
      `Shopify staged ${label} in a different currency`,
      409,
      { stage: 'order_edit_set_quantity' },
    )
  }
  return { amount, currencyCode }
}

function strictPreviewMoney(
  value: unknown,
  label: string,
  expectedCurrencyCode: string,
  options: { allowNegative?: boolean } = {},
): ShopifyOrderManagementMoney {
  const bag = safeRecord(value)
  const money = safeRecord(bag?.shopMoney)
  const amount = money?.amount
  if (
    !bag
    || !money
    || typeof amount !== 'string'
    || amount.length < 1
    || amount.length > 128
    || !DECIMAL_AMOUNT_PATTERN.test(amount)
    || (!options.allowNegative && amount.startsWith('-'))
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_preview' },
    )
  }
  const currencyCode = strictCurrencyCode(
    money.currencyCode,
    `${label} currency`,
  )
  if (currencyCode !== expectedCurrencyCode) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_CURRENCY_MISMATCH',
      `Shopify returned ${label} in a different shop currency`,
      409,
      { stage: 'provider_preview' },
    )
  }
  return { amount, currencyCode }
}

function compareDecimalAmounts(left: string, right: string): -1 | 0 | 1 {
  const parts = (amount: string) => {
    const negative = amount.startsWith('-')
    const unsigned = negative ? amount.slice(1) : amount
    const [wholeInput, fractionInput = ''] = unsigned.split('.')
    const whole = wholeInput.replace(/^0+/, '') || '0'
    const fraction = fractionInput.replace(/0+$/, '')
    const zero = whole === '0' && fraction.length === 0
    return { fraction, negative: negative && !zero, whole }
  }
  const leftParts = parts(left)
  const rightParts = parts(right)
  if (leftParts.negative !== rightParts.negative) {
    return leftParts.negative ? -1 : 1
  }
  const magnitude = (() => {
    if (leftParts.whole.length !== rightParts.whole.length) {
      return leftParts.whole.length < rightParts.whole.length ? -1 : 1
    }
    if (leftParts.whole !== rightParts.whole) {
      return leftParts.whole < rightParts.whole ? -1 : 1
    }
    const scale = Math.max(
      leftParts.fraction.length,
      rightParts.fraction.length,
    )
    const leftFraction = leftParts.fraction.padEnd(scale, '0')
    const rightFraction = rightParts.fraction.padEnd(scale, '0')
    return leftFraction < rightFraction
      ? -1
      : leftFraction > rightFraction
        ? 1
        : 0
  })()
  return leftParts.negative ? (magnitude * -1) as -1 | 0 | 1 : magnitude
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 64) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return parsed.toISOString()
}

function expectedIsoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 64) {
    fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', `${label} is invalid`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', `${label} is invalid`)
  }
  return parsed.toISOString()
}

function optionalIsoDate(value: unknown, label: string): string | null {
  return value === null ? null : isoDate(value, label)
}

function strictTags(value: unknown, label = 'order tags'): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  const tags = value.map((tag) => strictText(
    tag,
    label,
    MAX_TAG_LENGTH,
  ))
  if (new Set(tags).size !== tags.length) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      `Shopify returned duplicate ${label}`,
      502,
      { stage: 'provider_response' },
    )
  }
  return tags
}

function normalizeOneTag(value: unknown): string {
  const tag = inputText(value, 'Shopify order tag', MAX_TAG_LENGTH)
  if (tag.includes(',')) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify order tag must be one exact tag without commas',
    )
  }
  return tag
}

function nullableInputText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null) return null
  return inputText(value, label, maximum, { allowEmpty: false })
}

function nullableResponseText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null) return null
  return strictText(value, label, maximum, { allowEmpty: false })
}

function normalizedTags(value: readonly string[]) {
  return [...value].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function normalizeStaffNote(value: unknown, required: boolean): string | null {
  if ((value === undefined || value === null) && !required) return null
  return inputText(value, 'Shopify staff note', MAX_STAFF_NOTE_LENGTH)
}

function safeUserErrors(
  value: unknown,
  options: { allowCode?: boolean } = {},
): SafeUserError[] {
  if (!Array.isArray(value) || value.length > MAX_USER_ERRORS) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid mutation errors',
      502,
      { stage: 'provider_response' },
    )
  }
  return value.map((candidate) => {
    const entry = safeRecord(candidate)
    if (!entry) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
        'Shopify returned invalid mutation errors',
        502,
        { stage: 'provider_response' },
      )
    }
    const field = entry.field === null
      ? []
      : entry.field
    if (
      !Array.isArray(field)
      || field.length > 20
      || !field.every((part) => (
        typeof part === 'string'
        && part.length <= 128
        && /^[A-Za-z0-9_.-]+$/.test(part)
      ))
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
        'Shopify returned invalid mutation errors',
        502,
        { stage: 'provider_response' },
      )
    }
    const code = entry.code === undefined || entry.code === null
      ? null
      : entry.code
    if (
      (!options.allowCode && code !== null)
      || (code !== null && (
        typeof code !== 'string'
        || !SAFE_CODE_PATTERN.test(code)
      ))
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
        'Shopify returned invalid mutation errors',
        502,
        { stage: 'provider_response' },
      )
    }
    return {
      field: field as string[],
      message: strictText(entry.message, 'mutation error message', 4_096),
      code: code as string | null,
    }
  })
}

function providerRejected(code: string, message: string, stage: string): never {
  fail(code, message, 409, { providerRejected: true, stage })
}

function parseLine(value: unknown): ShopifyOrderManagementLine {
  const line = safeRecord(value)
  if (!line) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned an invalid order line',
      502,
      { stage: 'provider_preview' },
    )
  }
  const sku = line.sku === null
    ? null
    : strictText(line.sku, 'order line SKU', 255, { allowEmpty: true })
  return {
    id: strictGid(line.id, 'order line identity', LINE_ITEM_GID_PATTERN),
    name: strictText(line.name, 'order line name', 512),
    sku,
    currentQuantity: strictNonnegativeInteger(
      line.currentQuantity,
      'order line current quantity',
    ),
    unfulfilledQuantity: strictNonnegativeInteger(
      line.unfulfilledQuantity,
      'order line unfulfilled quantity',
    ),
    nonFulfillableQuantity: strictNonnegativeInteger(
      line.nonFulfillableQuantity,
      'order line non-fulfillable quantity',
    ),
    merchantEditable: strictBoolean(
      line.merchantEditable,
      'order line merchant-editable state',
    ),
  }
}

function parsePreview(
  value: unknown,
  shopCurrencyInput: unknown,
): ShopifyOrderManagementPreview {
  const order = safeRecord(value)
  const lineItems = safeRecord(order?.lineItems)
  const pageInfo = safeRecord(lineItems?.pageInfo)
  if (
    !order
    || !lineItems
    || !pageInfo
    || !Array.isArray(lineItems.nodes)
    || lineItems.nodes.length > MAX_ORDER_LINES
    || typeof pageInfo.hasNextPage !== 'boolean'
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned an invalid order-management preview',
      502,
      { stage: 'provider_preview' },
    )
  }
  if (pageInfo.hasNextPage) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_TOO_LARGE',
      'The order has more lines than the bounded editor can verify',
      409,
      { stage: 'provider_preview' },
    )
  }
  const lines = lineItems.nodes.map(parseLine)
  if (!lines.length || new Set(lines.map((line) => line.id)).size !== lines.length) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid or duplicate order lines',
      502,
      { stage: 'provider_preview' },
    )
  }
  const merchantEditableErrors = order.merchantEditableErrors
  if (
    !Array.isArray(merchantEditableErrors)
    || merchantEditableErrors.length > 50
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid editability evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  const displayFinancialStatus = order.displayFinancialStatus === null
    ? null
    : strictText(order.displayFinancialStatus, 'financial status', 64)
  const note = order.note === null
    ? null
    : strictText(order.note, 'order note', MAX_NOTE_LENGTH, { allowEmpty: true })
  const shopCurrencyCode = strictCurrencyCode(
    shopCurrencyInput,
    'shop currency',
  )
  const orderCurrencyCode = strictCurrencyCode(
    order.currencyCode,
    'order currency',
  )
  return {
    id: strictGid(order.id, 'order identity', ORDER_GID_PATTERN),
    legacyResourceId: strictText(
      order.legacyResourceId,
      'legacy order identity',
      32,
    ),
    name: strictText(order.name, 'order name', 255),
    test: strictBoolean(order.test, 'test-order state'),
    createdAt: isoDate(order.createdAt, 'order creation timestamp'),
    updatedAt: isoDate(order.updatedAt, 'order update timestamp'),
    cancelledAt: optionalIsoDate(order.cancelledAt, 'order cancellation timestamp'),
    closed: strictBoolean(order.closed, 'closed state'),
    unpaid: strictBoolean(order.unpaid, 'unpaid state'),
    capturable: strictBoolean(order.capturable, 'capturable state'),
    displayFinancialStatus,
    displayFulfillmentStatus: strictText(
      order.displayFulfillmentStatus,
      'fulfillment status',
      64,
    ),
    merchantEditable: strictBoolean(
      order.merchantEditable,
      'merchant-editable state',
    ),
    merchantEditableErrors: merchantEditableErrors.map((entry) =>
      strictText(entry, 'merchant-editable error', 1_024)),
    returnStatus: strictText(order.returnStatus, 'return status', 64),
    shopCurrencyCode,
    orderCurrencyCode,
    currentTotalPrice: strictPreviewMoney(
      order.currentTotalPriceSet,
      'current order total price',
      shopCurrencyCode,
    ),
    totalOutstanding: strictPreviewMoney(
      order.totalOutstandingSet,
      'order total outstanding',
      shopCurrencyCode,
      { allowNegative: true },
    ),
    email: nullableResponseText(
      order.email,
      'order email',
      MAX_EMAIL_LENGTH,
    ),
    phone: nullableResponseText(
      order.phone,
      'order phone',
      MAX_PHONE_LENGTH,
    ),
    poNumber: nullableResponseText(
      order.poNumber,
      'order PO number',
      MAX_PO_NUMBER_LENGTH,
    ),
    note,
    tags: strictTags(order.tags),
    lines,
  }
}

const SHOPIFY_ORDER_MANAGEMENT_PREVIEW_QUERY =
  `query ClawPilotShopifyOrderManagementPreview($id: ID!) {
    shop { currencyCode }
    order(id: $id) {
      id
      legacyResourceId
      name
      test
      createdAt
      updatedAt
      cancelledAt
      closed
      unpaid
      capturable
      displayFinancialStatus
      displayFulfillmentStatus
      merchantEditable
      merchantEditableErrors
      returnStatus
      currencyCode
      currentTotalPriceSet {
        shopMoney { amount currencyCode }
      }
      totalOutstandingSet {
        shopMoney { amount currencyCode }
      }
      email
      phone
      poNumber
      note
      tags
      lineItems(first: 250) {
        nodes {
          id
          name
          sku
          currentQuantity
          unfulfilledQuantity
          nonFulfillableQuantity
          merchantEditable
        }
        pageInfo { hasNextPage }
      }
    }
  }`

export async function readShopifyOrderManagementPreview(
  credential: ShopifyCommerceRuntimeCredential,
  orderGid: unknown,
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderManagementPreview> {
  const id = inputGid(orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{
    order?: unknown
    shop?: unknown
  }>(
    credential,
    {
      query: SHOPIFY_ORDER_MANAGEMENT_PREVIEW_QUERY,
      operationName: 'ClawPilotShopifyOrderManagementPreview',
      variables: { id },
    },
    options,
  )
  const root = safeRecord(data)
  const shop = safeRecord(root?.shop)
  if (!root) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned an invalid order-management response',
      502,
      { stage: 'provider_preview' },
    )
  }
  if (root.order === null || root.order === undefined) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_NOT_FOUND',
      'Shopify did not return the requested order',
      404,
      { stage: 'provider_preview' },
    )
  }
  if (!shop) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify did not return the Shopify shop currency',
      502,
      { stage: 'provider_preview' },
    )
  }
  const preview = parsePreview(root.order, shop.currencyCode)
  if (preview.id !== id) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_IDENTITY_MISMATCH',
      'Shopify returned a different order identity',
      409,
      { stage: 'provider_preview' },
    )
  }
  return preview
}

const SHOPIFY_ORDER_MANAGEMENT_JOB_QUERY =
  `query ClawPilotShopifyOrderManagementJob($id: ID!) {
    job(id: $id) { id done }
  }`

/** One exact read of Shopify's asynchronous Job. This function never polls. */
export async function readShopifyOrderManagementJob(
  credential: ShopifyCommerceRuntimeCredential,
  jobGidInput: unknown,
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderManagementJobRead> {
  const jobGid = inputGid(
    jobGidInput,
    'Shopify job ID',
    JOB_GID_PATTERN,
  )
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ job?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_MANAGEMENT_JOB_QUERY,
      operationName: 'ClawPilotShopifyOrderManagementJob',
      variables: { id: jobGid },
    },
    options,
  )
  const root = safeRecord(data)
  const job = safeRecord(root?.job)
  if (!job) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_JOB_NOT_FOUND',
      'Shopify did not return the requested cancellation job',
      404,
      { stage: 'job_read' },
    )
  }
  const result = {
    jobGid: strictGid(job.id, 'job identity', JOB_GID_PATTERN),
    done: strictBoolean(job.done, 'job state'),
  }
  if (result.jobGid !== jobGid) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_JOB_MISMATCH',
      'Shopify returned a different cancellation job identity',
      409,
      { stage: 'job_read' },
    )
  }
  return result
}

const SHOPIFY_ORDER_TAG_ADD_MUTATION =
  `mutation ClawPilotShopifyOrderTagAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
        ... on Order {
          name
          updatedAt
          tags
        }
      }
      userErrors { field message }
    }
  }`

export async function addShopifyOrderTag(
  credential: ShopifyCommerceRuntimeCredential,
  input: { orderGid: unknown; tag: unknown },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderTagMutationResult> {
  const orderGid = inputGid(input.orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const tag = normalizeOneTag(input.tag)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ tagsAdd?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_TAG_ADD_MUTATION,
      operationName: 'ClawPilotShopifyOrderTagAdd',
      variables: { id: orderGid, tags: [tag] },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.tagsAdd)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_TAG_RESPONSE_INVALID',
      'Shopify returned an invalid tag-add response',
      502,
      { stage: 'tag_add' },
    )
  }
  const errors = safeUserErrors(payload.userErrors)
  if (errors.length) {
    providerRejected(
      'SHOPIFY_ORDER_TAG_REJECTED',
      'Shopify rejected the exact order tag',
      'tag_add',
    )
  }
  const node = safeRecord(payload.node)
  if (!node) {
    fail(
      'SHOPIFY_ORDER_TAG_RESPONSE_INVALID',
      'Shopify did not return the tagged order',
      502,
      { stage: 'tag_add' },
    )
  }
  const result = {
    orderGid: strictGid(node.id, 'tagged order identity', ORDER_GID_PATTERN),
    orderName: strictText(node.name, 'tagged order name', 255),
    updatedAt: isoDate(node.updatedAt, 'tagged order timestamp'),
    tags: strictTags(node.tags, 'tagged order tags'),
  }
  if (result.orderGid !== orderGid || !result.tags.includes(tag)) {
    fail(
      'SHOPIFY_ORDER_TAG_RESPONSE_MISMATCH',
      'Shopify returned a different tagged order projection',
      502,
      { stage: 'tag_add' },
    )
  }
  return result
}

const SHOPIFY_ORDER_METADATA_UPDATE_MUTATION =
  `mutation ClawPilotShopifyOrderMetadataUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id name updatedAt email phone poNumber note tags }
      userErrors { field message }
    }
  }`

/**
 * Exact full-replacement metadata primitive. The order-management dispatcher
 * intentionally does not expose this operation; its initial tag action uses
 * additive tagsAdd so existing Shopify tags cannot be lost.
 */
export async function updateShopifyOrderMetadata(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    orderGid: unknown
    email?: unknown
    phone?: unknown
    poNumber?: unknown
    note?: unknown
    tags?: unknown
  },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderMetadataMutationResult> {
  const orderGid = inputGid(input.orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  if (
    input.email === undefined
    && input.phone === undefined
    && input.poNumber === undefined
    && input.note === undefined
    && input.tags === undefined
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'At least one exact order field replacement is required',
    )
  }
  const email = input.email === undefined
    ? undefined
    : nullableInputText(input.email, 'Shopify order email', MAX_EMAIL_LENGTH)
  const phone = input.phone === undefined
    ? undefined
    : nullableInputText(input.phone, 'Shopify order phone', MAX_PHONE_LENGTH)
  const poNumber = input.poNumber === undefined
    ? undefined
    : nullableInputText(
        input.poNumber,
        'Shopify order PO number',
        MAX_PO_NUMBER_LENGTH,
      )
  const note = input.note === undefined
    ? undefined
    : input.note === null
      ? null
      : inputText(input.note, 'Shopify order note', MAX_NOTE_LENGTH, {
          allowEmpty: true,
        })
  let tags: string[] | undefined
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > MAX_TAGS) {
      fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', 'Shopify order tags are invalid')
    }
    tags = input.tags.map(normalizeOneTag)
    if (new Set(tags).size !== tags.length) {
      fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', 'Shopify order tags contain duplicates')
    }
  }
  const providerInput = {
    id: orderGid,
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(poNumber !== undefined ? { poNumber } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(tags !== undefined ? { tags } : {}),
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderUpdate?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_METADATA_UPDATE_MUTATION,
      operationName: 'ClawPilotShopifyOrderMetadataUpdate',
      variables: { input: providerInput },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.orderUpdate)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_METADATA_RESPONSE_INVALID',
      'Shopify returned an invalid order-update response',
      502,
      { stage: 'metadata_update' },
    )
  }
  if (safeUserErrors(payload.userErrors).length) {
    providerRejected(
      'SHOPIFY_ORDER_METADATA_REJECTED',
      'Shopify rejected the exact order metadata update',
      'metadata_update',
    )
  }
  const order = safeRecord(payload.order)
  if (!order) {
    fail(
      'SHOPIFY_ORDER_METADATA_RESPONSE_INVALID',
      'Shopify did not return the updated order',
      502,
      { stage: 'metadata_update' },
    )
  }
  const result: ShopifyOrderMetadataMutationResult = {
    orderGid: strictGid(order.id, 'updated order identity', ORDER_GID_PATTERN),
    orderName: strictText(order.name, 'updated order name', 255),
    updatedAt: isoDate(order.updatedAt, 'updated order timestamp'),
    email: nullableResponseText(
      order.email,
      'updated order email',
      MAX_EMAIL_LENGTH,
    ),
    phone: nullableResponseText(
      order.phone,
      'updated order phone',
      MAX_PHONE_LENGTH,
    ),
    poNumber: nullableResponseText(
      order.poNumber,
      'updated order PO number',
      MAX_PO_NUMBER_LENGTH,
    ),
    note: order.note === null
      ? null
      : strictText(order.note, 'updated order note', MAX_NOTE_LENGTH, {
          allowEmpty: true,
        }),
    tags: strictTags(order.tags, 'updated order tags'),
  }
  if (
    result.orderGid !== orderGid
    || (email !== undefined && result.email !== email)
    || (phone !== undefined && result.phone !== phone)
    || (poNumber !== undefined && result.poNumber !== poNumber)
    || (note !== undefined && result.note !== note)
    || (tags !== undefined && (
      !sameStringList(normalizedTags(result.tags), normalizedTags(tags))
    ))
  ) {
    fail(
      'SHOPIFY_ORDER_METADATA_RESPONSE_MISMATCH',
      'Shopify returned a different order metadata projection',
      502,
      { stage: 'metadata_update' },
    )
  }
  return result
}

const SHOPIFY_ORDER_CANCEL_MUTATION =
  `mutation ClawPilotShopifyTestOrderCancel(
    $orderId: ID!
    $notifyCustomer: Boolean!
    $refundMethod: OrderCancelRefundMethodInput!
    $restock: Boolean!
    $reason: OrderCancelReason!
    $staffNote: String
  ) {
    orderCancel(
      orderId: $orderId
      notifyCustomer: $notifyCustomer
      refundMethod: $refundMethod
      restock: $restock
      reason: $reason
      staffNote: $staffNote
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }`

export async function cancelShopifyTestOrder(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    orderGid: unknown
    reason?: unknown
    staffNote?: unknown
  },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderCancelMutationResult> {
  const orderGid = inputGid(input.orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const reason = input.reason === undefined ? 'STAFF' : input.reason
  if (reason !== 'OTHER' && reason !== 'STAFF') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify cancellation reason must be STAFF or OTHER',
    )
  }
  const staffNote = normalizeStaffNote(input.staffNote, false)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderCancel?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_CANCEL_MUTATION,
      operationName: 'ClawPilotShopifyTestOrderCancel',
      variables: {
        orderId: orderGid,
        notifyCustomer: false,
        refundMethod: { originalPaymentMethodsRefund: false },
        restock: false,
        reason,
        staffNote,
      },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.orderCancel)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_CANCEL_RESPONSE_INVALID',
      'Shopify returned an invalid cancellation response',
      502,
      { stage: 'cancel' },
    )
  }
  if (safeUserErrors(payload.orderCancelUserErrors, { allowCode: true }).length) {
    providerRejected(
      'SHOPIFY_ORDER_CANCEL_REJECTED',
      'Shopify rejected the test-order cancellation',
      'cancel',
    )
  }
  const job = safeRecord(payload.job)
  if (!job) {
    fail(
      'SHOPIFY_ORDER_CANCEL_RESPONSE_INVALID',
      'Shopify did not return a cancellation job',
      502,
      { stage: 'cancel' },
    )
  }
  return {
    jobGid: strictGid(job.id, 'cancellation job identity', JOB_GID_PATTERN),
    done: strictBoolean(job.done, 'cancellation job state'),
  }
}

const SHOPIFY_ORDER_EDIT_BEGIN_MUTATION =
  `mutation ClawPilotShopifyOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id }
      orderEditSession { id }
      userErrors { field message }
    }
  }`

export async function beginShopifyOrderEdit(
  credential: ShopifyCommerceRuntimeCredential,
  orderGidInput: unknown,
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderEditBeginResult> {
  const orderGid = inputGid(orderGidInput, 'Shopify order ID', ORDER_GID_PATTERN)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderEditBegin?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_EDIT_BEGIN_MUTATION,
      operationName: 'ClawPilotShopifyOrderEditBegin',
      variables: { id: orderGid },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.orderEditBegin)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_EDIT_BEGIN_RESPONSE_INVALID',
      'Shopify returned an invalid order-edit response',
      502,
      { stage: 'order_edit_begin' },
    )
  }
  if (safeUserErrors(payload.userErrors).length) {
    providerRejected(
      'SHOPIFY_ORDER_EDIT_BEGIN_REJECTED',
      'Shopify rejected the order-edit session',
      'order_edit_begin',
    )
  }
  const calculatedOrder = safeRecord(payload.calculatedOrder)
  const orderEditSession = safeRecord(payload.orderEditSession)
  if (!calculatedOrder || !orderEditSession) {
    fail(
      'SHOPIFY_ORDER_EDIT_BEGIN_RESPONSE_INVALID',
      'Shopify did not return the order-edit session',
      502,
      { stage: 'order_edit_begin' },
    )
  }
  return {
    calculatedOrderGid: strictGid(
      calculatedOrder.id,
      'calculated order identity',
      CALCULATED_ORDER_GID_PATTERN,
    ),
    orderEditSessionGid: strictGid(
      orderEditSession.id,
      'order-edit session identity',
      ORDER_EDIT_SESSION_GID_PATTERN,
    ),
  }
}

const SHOPIFY_ORDER_EDIT_SET_QUANTITY_MUTATION =
  `mutation ClawPilotShopifyOrderEditSetQuantity(
    $id: ID!
    $lineItemId: ID!
    $quantity: Int!
    $restock: Boolean!
  ) {
    orderEditSetQuantity(
      id: $id
      lineItemId: $lineItemId
      quantity: $quantity
      restock: $restock
    ) {
      calculatedOrder {
        id
        totalPriceSet {
          shopMoney { amount currencyCode }
        }
        totalOutstandingSet {
          shopMoney { amount currencyCode }
        }
      }
      calculatedLineItem { id quantity }
      userErrors { field message }
    }
  }`

export async function setShopifyOrderEditLineQuantity(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    calculatedOrderGid: unknown
    lineItemGid: unknown
    quantity: unknown
    expectedCurrencyCode: unknown
  },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderEditQuantityResult> {
  const calculatedOrderGid = inputGid(
    input.calculatedOrderGid,
    'Shopify calculated order ID',
    CALCULATED_ORDER_GID_PATTERN,
  )
  const lineItemGid = inputGid(
    input.lineItemGid,
    'Shopify order line ID',
    LINE_ITEM_GID_PATTERN,
  )
  if (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify order line quantity is invalid',
    )
  }
  const quantity = Number(input.quantity)
  const expectedCurrencyCode = inputCurrencyCode(
    input.expectedCurrencyCode,
    'Expected Shopify store currency',
  )
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderEditSetQuantity?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_EDIT_SET_QUANTITY_MUTATION,
      operationName: 'ClawPilotShopifyOrderEditSetQuantity',
      variables: {
        id: calculatedOrderGid,
        lineItemId: lineItemGid,
        quantity,
        restock: false,
      },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.orderEditSetQuantity)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_EDIT_QUANTITY_RESPONSE_INVALID',
      'Shopify returned an invalid staged quantity response',
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  if (safeUserErrors(payload.userErrors).length) {
    providerRejected(
      'SHOPIFY_ORDER_EDIT_QUANTITY_REJECTED',
      'Shopify rejected the staged line quantity',
      'order_edit_set_quantity',
    )
  }
  const calculatedOrder = safeRecord(payload.calculatedOrder)
  const calculatedLineItem = safeRecord(payload.calculatedLineItem)
  if (!calculatedOrder || !calculatedLineItem) {
    fail(
      'SHOPIFY_ORDER_EDIT_QUANTITY_RESPONSE_INVALID',
      'Shopify did not return the staged line quantity',
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  const result = {
    calculatedOrderGid: strictGid(
      calculatedOrder.id,
      'calculated order identity',
      CALCULATED_ORDER_GID_PATTERN,
    ),
    calculatedLineItemGid: strictGid(
      calculatedLineItem.id,
      'calculated line identity',
      CALCULATED_LINE_ITEM_GID_PATTERN,
    ),
    quantity: strictNonnegativeInteger(
      calculatedLineItem.quantity,
      'calculated line quantity',
    ),
    totalPrice: strictMoney(
      calculatedOrder.totalPriceSet,
      'order total price',
      expectedCurrencyCode,
    ),
    totalOutstanding: strictMoney(
      calculatedOrder.totalOutstandingSet,
      'order total outstanding',
      expectedCurrencyCode,
      { allowNegative: true },
    ),
  }
  if (
    result.calculatedOrderGid !== calculatedOrderGid
    || result.quantity !== quantity
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_QUANTITY_RESPONSE_MISMATCH',
      'Shopify returned a different staged line quantity',
      502,
      { stage: 'order_edit_set_quantity' },
    )
  }
  return result
}

const SHOPIFY_ORDER_EDIT_COMMIT_MUTATION =
  `mutation ClawPilotShopifyOrderEditCommit(
    $id: ID!
    $notifyCustomer: Boolean!
    $staffNote: String
  ) {
    orderEditCommit(
      id: $id
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      order { id name updatedAt }
      successMessages
      userErrors { field message }
    }
  }`

export async function commitShopifyOrderEdit(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    calculatedOrderGid: unknown
    orderGid: unknown
    staffNote?: unknown
  },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderEditCommitResult> {
  const calculatedOrderGid = inputGid(
    input.calculatedOrderGid,
    'Shopify calculated order ID',
    CALCULATED_ORDER_GID_PATTERN,
  )
  const orderGid = inputGid(input.orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const staffNote = normalizeStaffNote(input.staffNote, false)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderEditCommit?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_EDIT_COMMIT_MUTATION,
      operationName: 'ClawPilotShopifyOrderEditCommit',
      variables: {
        id: calculatedOrderGid,
        notifyCustomer: false,
        staffNote,
      },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.orderEditCommit)
  if (!payload) {
    fail(
      'SHOPIFY_ORDER_EDIT_COMMIT_RESPONSE_INVALID',
      'Shopify returned an invalid order-edit commit response',
      502,
      { stage: 'order_edit_commit' },
    )
  }
  if (safeUserErrors(payload.userErrors).length) {
    providerRejected(
      'SHOPIFY_ORDER_EDIT_COMMIT_REJECTED',
      'Shopify rejected the order-edit commit',
      'order_edit_commit',
    )
  }
  const order = safeRecord(payload.order)
  if (!order || !Array.isArray(payload.successMessages) || payload.successMessages.length > 20) {
    fail(
      'SHOPIFY_ORDER_EDIT_COMMIT_RESPONSE_INVALID',
      'Shopify did not return the committed order',
      502,
      { stage: 'order_edit_commit' },
    )
  }
  const result = {
    orderGid: strictGid(order.id, 'committed order identity', ORDER_GID_PATTERN),
    orderName: strictText(order.name, 'committed order name', 255),
    updatedAt: isoDate(order.updatedAt, 'committed order timestamp'),
    successMessages: payload.successMessages.map((message) =>
      strictText(message, 'order-edit success message', 1_024)),
  }
  if (result.orderGid !== orderGid) {
    fail(
      'SHOPIFY_ORDER_EDIT_COMMIT_RESPONSE_MISMATCH',
      'Shopify returned a different committed order',
      502,
      { stage: 'order_edit_commit' },
    )
  }
  return result
}

function normalizeExpectedIdentity(
  input: ShopifyOrderManagementExpectedIdentity,
): ShopifyOrderManagementExpectedIdentity {
  return {
    shopId: inputGid(input.shopId, 'expected Shopify shop ID', SHOP_GID_PATTERN),
    shopDomain: normalizeShopifyShopDomain(input.shopDomain),
    orderGid: inputGid(input.orderGid, 'expected Shopify order ID', ORDER_GID_PATTERN),
    orderName: inputText(input.orderName, 'expected Shopify order name', 255),
    updatedAt: expectedIsoDate(
      input.updatedAt,
      'expected Shopify order timestamp',
    ),
  }
}

function normalizeAction(action: ShopifyOrderManagementAction): ShopifyOrderManagementAction {
  if (!action || typeof action !== 'object') {
    fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', 'Shopify order action is invalid')
  }
  if (action.type === 'add_tag') {
    return { type: 'add_tag', tag: normalizeOneTag(action.tag) }
  }
  if (action.type === 'cancel') {
    const reason = action.reason === undefined ? 'STAFF' : action.reason
    if (reason !== 'OTHER' && reason !== 'STAFF') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify cancellation reason must be STAFF or OTHER',
      )
    }
    return {
      type: 'cancel',
      reason,
      staffNote: normalizeStaffNote(action.staffNote, false),
    }
  }
  if (action.type === 'set_line_quantity') {
    if (!Number.isSafeInteger(action.quantity) || action.quantity < 0) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify order line quantity is invalid',
      )
    }
    return {
      type: 'set_line_quantity',
      lineItemGid: inputGid(
        action.lineItemGid,
        'Shopify order line ID',
        LINE_ITEM_GID_PATTERN,
      ),
      quantity: action.quantity,
      staffNote: normalizeStaffNote(action.staffNote, false),
    }
  }
  if (action.type === 'save_order') {
    if (
      !Array.isArray(action.tagAdds)
      || !Array.isArray(action.tagRemoves)
      || action.tagAdds.length > MAX_TAGS
      || action.tagRemoves.length > MAX_TAGS
      || !Array.isArray(action.lineQuantities)
      || action.lineQuantities.length > MAX_ORDER_LINES
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify order save changes are invalid',
      )
    }
    const tagAdds = action.tagAdds.map(normalizeOneTag)
    const tagRemoves = action.tagRemoves.map(normalizeOneTag)
    if (
      new Set(tagAdds).size !== tagAdds.length
      || new Set(tagRemoves).size !== tagRemoves.length
      || tagAdds.some((tag) => tagRemoves.includes(tag))
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify tag changes are duplicated or contradictory',
      )
    }
    const lineQuantities = action.lineQuantities.map((line) => {
      if (!line || typeof line !== 'object') {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
          'Shopify order line changes are invalid',
        )
      }
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) {
        fail(
          'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
          'Shopify order line quantity is invalid',
        )
      }
      return {
        lineItemGid: inputGid(
          line.lineItemGid,
          'Shopify order line ID',
          LINE_ITEM_GID_PATTERN,
        ),
        quantity: line.quantity,
      }
    })
    if (new Set(lineQuantities.map((line) => line.lineItemGid)).size
      !== lineQuantities.length) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify order line changes contain duplicates',
      )
    }
    return {
      type: 'save_order',
      email: nullableInputText(
        action.email,
        'Shopify order email',
        MAX_EMAIL_LENGTH,
      ),
      phone: nullableInputText(
        action.phone,
        'Shopify order phone',
        MAX_PHONE_LENGTH,
      ),
      poNumber: nullableInputText(
        action.poNumber,
        'Shopify order PO number',
        MAX_PO_NUMBER_LENGTH,
      ),
      note: action.note === null
        ? null
        : inputText(action.note, 'Shopify order note', MAX_NOTE_LENGTH, {
            allowEmpty: true,
          }),
      tagAdds: normalizedTags(tagAdds),
      tagRemoves: normalizedTags(tagRemoves),
      lineQuantities: [...lineQuantities].sort((left, right) => (
        left.lineItemGid < right.lineItemGid
          ? -1
          : left.lineItemGid > right.lineItemGid ? 1 : 0
      )),
    }
  }
  fail('SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID', 'Shopify order action is invalid')
}

type ShopifyOrderSaveProjection = Readonly<{
  email: string | null
  phone: string | null
  poNumber: string | null
  note: string | null
  tags: readonly string[]
  lineQuantities: readonly Readonly<{
    lineItemGid: string
    quantity: number
  }>[]
}>

function previewProjection(
  preview: ShopifyOrderManagementPreview,
): ShopifyOrderSaveProjection {
  return {
    email: preview.email,
    phone: preview.phone,
    poNumber: preview.poNumber,
    note: preview.note,
    tags: normalizedTags(preview.tags),
    lineQuantities: preview.lines
      .map((line) => ({
        lineItemGid: line.id,
        quantity: line.currentQuantity,
      }))
      .sort((left, right) => (
        left.lineItemGid < right.lineItemGid
          ? -1
          : left.lineItemGid > right.lineItemGid ? 1 : 0
      )),
  }
}

function desiredSaveProjection(
  before: ShopifyOrderManagementPreview,
  action: Extract<ShopifyOrderManagementAction, { type: 'save_order' }>,
): ShopifyOrderSaveProjection {
  const quantities = new Map(
    before.lines.map((line) => [line.id, line.currentQuantity]),
  )
  for (const change of action.lineQuantities) {
    if (!quantities.has(change.lineItemGid)) {
      fail(
        'SHOPIFY_ORDER_EDIT_LINE_NOT_FOUND',
        'A changed Shopify order line was not found',
        404,
        { stage: 'eligibility' },
      )
    }
    quantities.set(change.lineItemGid, change.quantity)
  }
  const tags = new Set(before.tags)
  for (const tag of action.tagRemoves) tags.delete(tag)
  for (const tag of action.tagAdds) tags.add(tag)
  return {
    email: action.email,
    phone: action.phone,
    poNumber: action.poNumber,
    note: action.note,
    tags: normalizedTags([...tags]),
    lineQuantities: [...quantities.entries()]
      .map(([lineItemGid, quantity]) => ({ lineItemGid, quantity }))
      .sort((left, right) => (
        left.lineItemGid < right.lineItemGid
          ? -1
          : left.lineItemGid > right.lineItemGid ? 1 : 0
      )),
  }
}

function projectionHash(projection: ShopifyOrderSaveProjection): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'shopify-order-save-projection-v1',
    ...projection,
  })).digest('hex')
}

export function shopifyOrderManagementProjectionHash(
  preview: ShopifyOrderManagementPreview,
): string {
  return projectionHash(previewProjection(preview))
}

export function requestedShopifyOrderSaveProjectionHash(
  preview: ShopifyOrderManagementPreview,
  actionInput: Extract<ShopifyOrderManagementAction, { type: 'save_order' }>,
): string {
  const action = normalizeAction(actionInput)
  if (action.type !== 'save_order') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify order save changes are invalid',
    )
  }
  return projectionHash(desiredSaveProjection(preview, action))
}

function requiredScopes(action: ShopifyOrderManagementAction): ShopifyAccessScope[] {
  return action.type === 'set_line_quantity'
    ? ['read_orders', 'write_order_edits']
    : action.type === 'save_order' && action.lineQuantities.length > 0
      ? ['read_orders', 'write_orders', 'write_order_edits']
    : ['read_orders', 'write_orders']
}

function assertRequiredScopes(
  required: readonly ShopifyAccessScope[],
  tokenScopes: readonly string[],
  probeScopes: readonly string[],
) {
  for (const scope of required) {
    if (
      !hasEffectiveShopifyScope(tokenScopes, scope)
      || !hasEffectiveShopifyScope(probeScopes, scope)
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_SCOPE_MISSING',
        `The Shopify connection is missing required ${scope} access`,
        409,
        { stage: 'scope_check' },
      )
    }
  }
}

function assertScopes(
  action: ShopifyOrderManagementAction,
  tokenScopes: readonly string[],
  probeScopes: readonly string[],
) {
  assertRequiredScopes(requiredScopes(action), tokenScopes, probeScopes)
}

function assertProbeIdentity(
  probe: ShopifyConnectionProbe,
  expected: Pick<
    ShopifyOrderManagementExpectedIdentity,
    'shopDomain' | 'shopId'
  >,
) {
  if (
    probe.provider !== 'shopify'
    || probe.apiVersion !== SHOPIFY_ORDER_MANAGEMENT_API_VERSION
    || probe.shopId !== expected.shopId
    || probe.shopDomain !== expected.shopDomain
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SHOP_MISMATCH',
      'The live Shopify store identity did not match the authorized target',
      409,
      { stage: 'provider_probe' },
    )
  }
}

function assertOrderIdentity(
  preview: ShopifyOrderManagementPreview,
  expected: ShopifyOrderManagementExpectedIdentity,
) {
  if (
    preview.id !== expected.orderGid
    || preview.name !== expected.orderName
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_MISMATCH',
      'The live Shopify order identity did not match the authorized target',
      409,
      { stage: 'provider_preview' },
    )
  }
  if (preview.updatedAt !== expected.updatedAt) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_STALE',
      'The Shopify order changed after this action was prepared',
      409,
      { stage: 'provider_preview' },
    )
  }
}

function whollyUnfulfilled(preview: ShopifyOrderManagementPreview): boolean {
  return preview.displayFulfillmentStatus === 'UNFULFILLED'
    && preview.lines.every((line) => (
      line.currentQuantity > 0
      && line.unfulfilledQuantity === line.currentQuantity
      && line.nonFulfillableQuantity === 0
    ))
}

function assertTestOrder(preview: ShopifyOrderManagementPreview) {
  if (!preview.test) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_TEST_ORDER_REQUIRED',
      'Active order management is limited to Shopify test orders',
      409,
      { stage: 'eligibility' },
    )
  }
}

function assertCancellationEligible(preview: ShopifyOrderManagementPreview) {
  assertTestOrder(preview)
  if (
    preview.cancelledAt !== null
    || preview.closed
    || !preview.unpaid
    || preview.capturable
    || preview.returnStatus !== 'NO_RETURN'
    || !whollyUnfulfilled(preview)
  ) {
    fail(
      'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
      'The test order is not an unpaid, wholly unfulfilled order without returns or payment authorization',
      409,
      { stage: 'eligibility' },
    )
  }
}

function targetLine(
  preview: ShopifyOrderManagementPreview,
  lineItemGid: string,
): ShopifyOrderManagementLine {
  const line = preview.lines.find((candidate) => candidate.id === lineItemGid)
  if (!line) {
    fail(
      'SHOPIFY_ORDER_EDIT_LINE_NOT_FOUND',
      'The selected Shopify order line was not found',
      404,
      { stage: 'eligibility' },
    )
  }
  return line
}

function assertLineEditEligible(
  preview: ShopifyOrderManagementPreview,
  action: Extract<ShopifyOrderManagementAction, { type: 'set_line_quantity' }>,
) {
  assertTestOrder(preview)
  const line = targetLine(preview, action.lineItemGid)
  if (preview.shopCurrencyCode !== preview.orderCurrencyCode) {
    fail(
      'SHOPIFY_ORDER_EDIT_CURRENCY_MISMATCH',
      'The test order was not placed in the Shopify store currency',
      409,
      { stage: 'eligibility' },
    )
  }
  if (
    preview.cancelledAt !== null
    || preview.closed
    || preview.returnStatus !== 'NO_RETURN'
    || !preview.merchantEditable
    || !line.merchantEditable
    || !whollyUnfulfilled(preview)
    || action.quantity >= line.currentQuantity
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_NOT_ELIGIBLE',
      'The test order is not eligible for a wholly unfulfilled line decrease or removal',
      409,
      { stage: 'eligibility' },
    )
  }
}

function assertSaveOrderEligible(
  preview: ShopifyOrderManagementPreview,
  action: Extract<ShopifyOrderManagementAction, { type: 'save_order' }>,
) {
  if (
    action.tagAdds.some((tag) => preview.tags.includes(tag))
    || action.tagRemoves.some((tag) => !preview.tags.includes(tag))
  ) {
    fail(
      'SHOPIFY_ORDER_TAG_STALE',
      'Shopify tags changed before this order save',
      409,
      { stage: 'eligibility' },
    )
  }
  const finalTagCount = preview.tags.length
    - action.tagRemoves.length
    + action.tagAdds.length
  if (finalTagCount > MAX_TAGS) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify order has too many tags',
      400,
      { stage: 'eligibility' },
    )
  }
  for (const line of action.lineQuantities) {
    assertLineEditEligible(preview, {
      type: 'set_line_quantity',
      lineItemGid: line.lineItemGid,
      quantity: line.quantity,
    })
  }
}

function assertStagedLineEditFinancials(
  before: ShopifyOrderManagementPreview,
  staged: ShopifyOrderEditQuantityResult,
) {
  if (
    staged.totalPrice.currencyCode !== before.shopCurrencyCode
    || staged.totalOutstanding.currencyCode !== before.shopCurrencyCode
    || compareDecimalAmounts(
      staged.totalPrice.amount,
      before.currentTotalPrice.amount,
    ) > 0
    || compareDecimalAmounts(
      staged.totalOutstanding.amount,
      before.totalOutstanding.amount,
    ) > 0
  ) {
    fail(
      'SHOPIFY_ORDER_EDIT_FINANCIAL_INCOHERENT',
      'Shopify staged an incoherent financial result for the line decrease',
      409,
      { stage: 'order_edit_set_quantity' },
    )
  }
}

function lineEditFinancialReadbackMatches(
  after: ShopifyOrderManagementPreview,
  staged: ShopifyOrderEditQuantityResult,
): boolean {
  return after.shopCurrencyCode === staged.totalPrice.currencyCode
    && after.shopCurrencyCode === staged.totalOutstanding.currencyCode
    && compareDecimalAmounts(
      after.currentTotalPrice.amount,
      staged.totalPrice.amount,
    ) === 0
    && compareDecimalAmounts(
      after.totalOutstanding.amount,
      staged.totalOutstanding.amount,
    ) === 0
}

function resultBase(input: {
  action: ShopifyOrderManagementAction['type']
  probe: ShopifyConnectionProbe
  before: ShopifyOrderManagementPreview
  providerReads?: 2 | 3
}): Pick<
  ShopifyOrderManagementExecutionResult,
  'action' | 'before' | 'probe' | 'providerReads' | 'retryable'
> {
  return {
    action: input.action,
    probe: input.probe,
    before: input.before,
    providerReads: input.providerReads || 2,
    retryable: false,
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : fallback
}

function explicitFirstMutationRejection(error: unknown): boolean {
  return error instanceof ShopifyOrderManagementError
    && error.providerRejected
}

function unknownResult(input: {
  action: ShopifyOrderManagementAction['type']
  probe: ShopifyConnectionProbe
  before: ShopifyOrderManagementPreview
  providerWritesKnown: boolean
  providerWrites: number | null
  providerReads?: 2 | 3
  error: unknown
}): ShopifyOrderManagementExecutionResult {
  return {
    ...resultBase(input),
    outcome: 'outcomeUnknown',
    providerMutationAttempted: true,
    providerWritesKnown: input.providerWritesKnown,
    providerWrites: input.providerWrites,
    after: null,
    result: null,
    providerReference: null,
    errorCode: safeErrorCode(
      input.error,
      'SHOPIFY_ORDER_MANAGEMENT_OUTCOME_UNKNOWN',
    ),
    safeMessage: 'Shopify write outcome requires reconciliation; do not retry this action',
  }
}

function rejectedResult(input: {
  action: ShopifyOrderManagementAction['type']
  probe: ShopifyConnectionProbe
  before: ShopifyOrderManagementPreview
  providerReads?: 2 | 3
  error: unknown
}): ShopifyOrderManagementExecutionResult {
  return {
    ...resultBase(input),
    outcome: 'rejected',
    providerMutationAttempted: true,
    providerWritesKnown: true,
    providerWrites: 0,
    after: null,
    result: null,
    providerReference: null,
    errorCode: safeErrorCode(
      input.error,
      'SHOPIFY_ORDER_MANAGEMENT_REJECTED',
    ),
    safeMessage: 'Shopify rejected the exact order-management action',
  }
}

function inspectionActions(
  value: InspectShopifyOrderManagementTargetInput['requiredActions'],
): ShopifyOrderManagementAction['type'][] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Required Shopify order actions are invalid',
    )
  }
  const actions = [...new Set(value)]
  if (actions.some((action) => ![
    'add_tag',
    'cancel',
    'set_line_quantity',
    'save_order',
  ].includes(action))) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Required Shopify order actions are invalid',
    )
  }
  return actions
}

/**
 * Open one read-only, short-lived Shopify order-management session. The token
 * exchange is followed by one live identity/scope probe and one exact order
 * read. No mutation, polling, or retry occurs.
 */
export async function inspectShopifyOrderManagementTarget(
  input: InspectShopifyOrderManagementTargetInput,
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<InspectShopifyOrderManagementTargetResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const shopId = inputGid(
    input.expected.shopId,
    'expected Shopify shop ID',
    SHOP_GID_PATTERN,
  )
  const shopDomain = normalizeShopifyShopDomain(input.expected.shopDomain)
  const orderGid = inputGid(
    input.expected.orderGid,
    'expected Shopify order ID',
    ORDER_GID_PATTERN,
  )
  const orderName = input.expected.orderName === undefined
    ? null
    : inputText(
        input.expected.orderName,
        'expected Shopify order name',
        255,
      )
  const actions = inspectionActions(input.requiredActions)
  const credential = {
    ...input.credential,
    shopDomain: normalizeShopifyShopDomain(input.credential.shopDomain),
  }
  if (credential.shopDomain !== shopDomain) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SHOP_MISMATCH',
      'The configured Shopify domain did not match the inspection target',
      409,
      { stage: 'credential_check' },
    )
  }
  const options = input.clientOptions || {}
  const token = await dependencies.requestAccessToken(credential, options)
  const runtimeCredential = {
    shopDomain,
    accessToken: token.accessToken,
  }
  const probe = await dependencies.probeConnection(runtimeCredential, options)
  assertProbeIdentity(probe, { shopId, shopDomain })
  const required = new Set<ShopifyAccessScope>(['read_orders'])
  for (const action of actions) {
    required.add(action === 'set_line_quantity'
      ? 'write_order_edits'
      : 'write_orders')
  }
  assertRequiredScopes(
    [...required],
    token.grantedScopes,
    probe.grantedScopes,
  )
  const preview = await readShopifyOrderManagementPreview(
    runtimeCredential,
    orderGid,
    options,
    dependencies,
  )
  if (
    preview.id !== orderGid
    || (orderName !== null && preview.name !== orderName)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_ORDER_MISMATCH',
      'The live Shopify order identity did not match the inspection target',
      409,
      { stage: 'provider_preview' },
    )
  }
  const job = input.jobGid === undefined
    ? null
    : await readShopifyOrderManagementJob(
        runtimeCredential,
        input.jobGid,
        options,
        dependencies,
      )
  return {
    probe,
    preview,
    job,
    grantedScopes: [...probe.grantedScopes],
    providerReads: job ? 3 : 2,
  }
}

/**
 * Execute one bounded Shopify test-order action.
 *
 * This adapter never retries provider requests. Any ambiguous failure after a
 * mutation is dispatched is terminal outcomeUnknown, including a later stage
 * of the three-mutation order-edit workflow.
 */
export async function executeShopifyOrderManagementAction(
  input: ExecuteShopifyOrderManagementInput,
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderManagementExecutionResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const expected = normalizeExpectedIdentity(input.expected)
  const action = normalizeAction(input.action)
  const options = input.clientOptions || {}
  const credential = {
    ...input.credential,
    shopDomain: normalizeShopifyShopDomain(input.credential.shopDomain),
  }
  if (credential.shopDomain !== expected.shopDomain) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_SHOP_MISMATCH',
      'The configured Shopify domain did not match the authorized target',
      409,
      { stage: 'credential_check' },
    )
  }

  const token = await dependencies.requestAccessToken(credential, options)
  const runtimeCredential = {
    shopDomain: credential.shopDomain,
    accessToken: token.accessToken,
  }
  const probe = await dependencies.probeConnection(runtimeCredential, options)
  assertProbeIdentity(probe, expected)
  assertScopes(action, token.grantedScopes, probe.grantedScopes)
  const before = await readShopifyOrderManagementPreview(
    runtimeCredential,
    expected.orderGid,
    options,
    dependencies,
  )
  assertOrderIdentity(before, expected)

  if (action.type === 'add_tag') {
    if (before.tags.includes(action.tag)) {
      return {
        ...resultBase({ action: action.type, probe, before }),
        outcome: 'succeeded',
        providerMutationAttempted: false,
        providerWritesKnown: true,
        providerWrites: 0,
        after: before,
        result: {
          orderGid: before.id,
          orderName: before.name,
          updatedAt: before.updatedAt,
          tags: before.tags,
        },
        providerReference: before.id,
        errorCode: null,
        safeMessage: null,
      }
    }
    let mutation: ShopifyOrderTagMutationResult
    try {
      mutation = await addShopifyOrderTag(
        runtimeCredential,
        { orderGid: before.id, tag: action.tag },
        options,
        dependencies,
      )
    } catch (error) {
      return explicitFirstMutationRejection(error)
        ? rejectedResult({ action: action.type, probe, before, error })
        : unknownResult({
            action: action.type,
            probe,
            before,
            providerWritesKnown: false,
            providerWrites: null,
            error,
          })
    }
    try {
      const after = await readShopifyOrderManagementPreview(
        runtimeCredential,
        before.id,
        options,
        dependencies,
      )
      if (
        after.id !== before.id
        || after.name !== before.name
        || !after.tags.includes(action.tag)
        || mutation.orderGid !== after.id
        || mutation.orderName !== after.name
      ) {
        fail(
          'SHOPIFY_ORDER_TAG_READBACK_MISMATCH',
          'Shopify tag readback did not match the accepted mutation',
          502,
          { stage: 'tag_readback' },
        )
      }
      return {
        ...resultBase({ action: action.type, probe, before, providerReads: 3 }),
        outcome: 'succeeded',
        providerMutationAttempted: true,
        providerWritesKnown: true,
        providerWrites: 1,
        after,
        result: mutation,
        providerReference: mutation.orderGid,
        errorCode: null,
        safeMessage: null,
      }
    } catch (error) {
      return unknownResult({
        action: action.type,
        probe,
        before,
        providerReads: 3,
        providerWritesKnown: true,
        providerWrites: 1,
        error,
      })
    }
  }

  if (action.type === 'save_order') {
    assertSaveOrderEligible(before, action)
    const desired = desiredSaveProjection(before, action)
    const beforeProjection = previewProjection(before)
    const metadataChanged = beforeProjection.email !== desired.email
      || beforeProjection.phone !== desired.phone
      || beforeProjection.poNumber !== desired.poNumber
      || beforeProjection.note !== desired.note
      || !sameStringList(beforeProjection.tags, desired.tags)
    if (!metadataChanged && action.lineQuantities.length === 0) {
      return {
        ...resultBase({ action: action.type, probe, before }),
        outcome: 'succeeded',
        providerMutationAttempted: false,
        providerWritesKnown: true,
        providerWrites: 0,
        after: before,
        result: {
          orderGid: before.id,
          orderName: before.name,
          updatedAt: before.updatedAt,
          metadataChanged: false,
          changedLineCount: 0,
        },
        providerReference: before.id,
        errorCode: null,
        safeMessage: null,
      }
    }

    let acceptedWrites = 0
    let providerReads: 2 | 3 = 2
    const expectedWrites = (metadataChanged ? 1 : 0)
      + (action.lineQuantities.length > 0
        ? action.lineQuantities.length + 2
        : 0)
    try {
      if (metadataChanged) {
        await updateShopifyOrderMetadata(
          runtimeCredential,
          {
            orderGid: before.id,
            email: desired.email,
            phone: desired.phone,
            poNumber: desired.poNumber,
            note: desired.note,
            tags: desired.tags,
          },
          options,
          dependencies,
        )
        acceptedWrites += 1
      }

      if (action.lineQuantities.length > 0) {
        const edit = await beginShopifyOrderEdit(
          runtimeCredential,
          before.id,
          options,
          dependencies,
        )
        acceptedWrites += 1
        let finalStaged: ShopifyOrderEditQuantityResult | null = null
        for (const line of action.lineQuantities) {
          finalStaged = await setShopifyOrderEditLineQuantity(
            runtimeCredential,
            {
              calculatedOrderGid: edit.calculatedOrderGid,
              lineItemGid: line.lineItemGid,
              quantity: line.quantity,
              expectedCurrencyCode: before.shopCurrencyCode,
            },
            options,
            dependencies,
          )
          acceptedWrites += 1
          assertStagedLineEditFinancials(before, finalStaged)
        }
        await commitShopifyOrderEdit(
          runtimeCredential,
          {
            calculatedOrderGid: edit.calculatedOrderGid,
            orderGid: before.id,
            staffNote: 'Saved Shopify order changes in ClawPilot',
          },
          options,
          dependencies,
        )
        acceptedWrites += 1
      }

      providerReads = 3
      const after = await readShopifyOrderManagementPreview(
        runtimeCredential,
        before.id,
        options,
        dependencies,
      )
      if (
        after.id !== before.id
        || after.name !== before.name
        || projectionHash(previewProjection(after)) !== projectionHash(desired)
      ) {
        fail(
          'SHOPIFY_ORDER_SAVE_READBACK_MISMATCH',
          'Shopify order readback did not match the saved fields',
          502,
          { stage: 'order_save_readback' },
        )
      }
      return {
        ...resultBase({ action: action.type, probe, before, providerReads }),
        outcome: 'succeeded',
        providerMutationAttempted: acceptedWrites > 0,
        providerWritesKnown: true,
        providerWrites: acceptedWrites,
        after,
        result: {
          orderGid: after.id,
          orderName: after.name,
          updatedAt: after.updatedAt,
          metadataChanged,
          changedLineCount: action.lineQuantities.length,
        },
        providerReference: after.id,
        errorCode: null,
        safeMessage: null,
      }
    } catch (error) {
      if (acceptedWrites === 0 && explicitFirstMutationRejection(error)) {
        return rejectedResult({ action: action.type, probe, before, error })
      }
      const providerWritesKnown = acceptedWrites === expectedWrites
        || (acceptedWrites > 0 && explicitFirstMutationRejection(error))
      return unknownResult({
        action: action.type,
        probe,
        before,
        providerReads,
        providerWritesKnown,
        providerWrites: providerWritesKnown ? acceptedWrites : null,
        error,
      })
    }
  }

  if (action.type === 'cancel') {
    assertCancellationEligible(before)
    let mutation: ShopifyOrderCancelMutationResult
    try {
      mutation = await cancelShopifyTestOrder(
        runtimeCredential,
        {
          orderGid: before.id,
          reason: action.reason,
          staffNote: action.staffNote,
        },
        options,
        dependencies,
      )
    } catch (error) {
      return explicitFirstMutationRejection(error)
        ? rejectedResult({ action: action.type, probe, before, error })
        : unknownResult({
            action: action.type,
            probe,
            before,
            providerWritesKnown: false,
            providerWrites: null,
            error,
          })
    }
    if (!mutation.done) {
      return {
        ...resultBase({ action: action.type, probe, before }),
        outcome: 'outcomeUnknown',
        providerMutationAttempted: true,
        providerWritesKnown: true,
        providerWrites: 1,
        after: null,
        result: mutation,
        providerReference: mutation.jobGid,
        errorCode: 'SHOPIFY_ORDER_CANCEL_JOB_PENDING',
        safeMessage: 'Shopify accepted the cancellation job; reconcile its result and do not retry',
      }
    }
    try {
      const after = await readShopifyOrderManagementPreview(
        runtimeCredential,
        before.id,
        options,
        dependencies,
      )
      if (after.id !== before.id || after.name !== before.name || !after.cancelledAt) {
        fail(
          'SHOPIFY_ORDER_CANCEL_READBACK_MISMATCH',
          'Shopify cancellation readback did not show a cancelled order',
          502,
          { stage: 'cancel_readback' },
        )
      }
      return {
        ...resultBase({ action: action.type, probe, before, providerReads: 3 }),
        outcome: 'succeeded',
        providerMutationAttempted: true,
        providerWritesKnown: true,
        providerWrites: 1,
        after,
        result: mutation,
        providerReference: mutation.jobGid,
        errorCode: null,
        safeMessage: null,
      }
    } catch (error) {
      return unknownResult({
        action: action.type,
        probe,
        before,
        providerReads: 3,
        providerWritesKnown: true,
        providerWrites: 1,
        error,
      })
    }
  }

  assertLineEditEligible(before, action)
  let acceptedStages = 0
  let providerReads: 2 | 3 = 2
  try {
    const edit = await beginShopifyOrderEdit(
      runtimeCredential,
      before.id,
      options,
      dependencies,
    )
    acceptedStages = 1
    const staged = await setShopifyOrderEditLineQuantity(
      runtimeCredential,
      {
        calculatedOrderGid: edit.calculatedOrderGid,
        lineItemGid: action.lineItemGid,
        quantity: action.quantity,
        expectedCurrencyCode: before.shopCurrencyCode,
      },
      options,
      dependencies,
    )
    assertStagedLineEditFinancials(before, staged)
    acceptedStages = 2
    const mutation = await commitShopifyOrderEdit(
      runtimeCredential,
      {
        calculatedOrderGid: edit.calculatedOrderGid,
        orderGid: before.id,
        staffNote: action.staffNote,
      },
      options,
      dependencies,
    )
    acceptedStages = 3
    providerReads = 3
    const after = await readShopifyOrderManagementPreview(
      runtimeCredential,
      before.id,
      options,
      dependencies,
    )
    const line = targetLine(after, action.lineItemGid)
    if (
      after.id !== before.id
      || after.name !== before.name
      || mutation.orderGid !== after.id
      || mutation.orderName !== after.name
      || line.currentQuantity !== action.quantity
      || !lineEditFinancialReadbackMatches(after, staged)
    ) {
      fail(
        'SHOPIFY_ORDER_EDIT_READBACK_MISMATCH',
        'Shopify order-edit readback did not match the committed quantity and financial totals',
        502,
        { stage: 'order_edit_readback' },
      )
    }
    return {
      ...resultBase({ action: action.type, probe, before, providerReads }),
      outcome: 'succeeded',
      providerMutationAttempted: true,
      providerWritesKnown: true,
      providerWrites: 3,
      after,
      result: mutation,
      providerReference: mutation.orderGid,
      errorCode: null,
      safeMessage: null,
    }
  } catch (error) {
    if (acceptedStages === 0 && explicitFirstMutationRejection(error)) {
      return rejectedResult({ action: action.type, probe, before, error })
    }
    const providerWritesKnown = acceptedStages === 3
      || (acceptedStages > 0 && explicitFirstMutationRejection(error))
    return unknownResult({
      action: action.type,
      probe,
      before,
      providerReads,
      providerWritesKnown,
      providerWrites: providerWritesKnown ? acceptedStages : null,
      error,
    })
  }
}
