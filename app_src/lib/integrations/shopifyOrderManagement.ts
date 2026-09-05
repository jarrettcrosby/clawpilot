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
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'

const ORDER_GID_PATTERN = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const ORDER_TRANSACTION_GID_PATTERN =
  /^gid:\/\/shopify\/OrderTransaction\/[A-Za-z0-9][A-Za-z0-9-]*$/
const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const LINE_ITEM_GID_PATTERN = /^gid:\/\/shopify\/LineItem\/[1-9][0-9]*$/
const FULFILLMENT_GID_PATTERN =
  /^gid:\/\/shopify\/Fulfillment\/[1-9][0-9]*$/
const FULFILLMENT_ORDER_GID_PATTERN =
  /^gid:\/\/shopify\/FulfillmentOrder\/[1-9][0-9]*$/
const LOCATION_GID_PATTERN = /^gid:\/\/shopify\/Location\/[1-9][0-9]*$/
const AUTHORIZATION_GLOBAL_ID_PATTERN = /^gsom(?:[0-9]{7}|[0-9a-v]{12})$/
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
const MAX_ORDER_FULFILLMENTS = 10
const MAX_ORDER_TRANSACTIONS = 25
const MAX_FULFILLMENT_ORDERS = 10
const MAX_FULFILLMENT_TRACKING_ENTRIES = 10
const MAX_GID_LENGTH = 255
const MAX_TAGS = 250
const MAX_TAG_LENGTH = 255
const MAX_NOTE_LENGTH = 5_000
const MAX_EMAIL_LENGTH = 254
const MAX_PHONE_LENGTH = 64
const MAX_PO_NUMBER_LENGTH = 255
const MAX_STAFF_NOTE_LENGTH = 255
const MAX_ADDRESS_NAME_LENGTH = 255
const MAX_ADDRESS_COMPANY_LENGTH = 255
const MAX_ADDRESS_LINE_LENGTH = 255
const MAX_ADDRESS_CITY_LENGTH = 255
const MAX_ADDRESS_PROVINCE_CODE_LENGTH = 64
const MAX_ADDRESS_POSTAL_CODE_LENGTH = 64
const MAX_USER_ERRORS = 50
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/
const ORDER_TRANSACTION_KINDS = new Set([
  'AUTHORIZATION',
  'CAPTURE',
  'CHANGE',
  'EMV_AUTHORIZATION',
  'REFUND',
  'SALE',
  'SUGGESTED_REFUND',
  'VOID',
])
const ORDER_TRANSACTION_STATUSES = new Set([
  'AWAITING_RESPONSE',
  'ERROR',
  'FAILURE',
  'PENDING',
  'SUCCESS',
  'UNKNOWN',
])

export const SHOPIFY_ORDER_MANAGEMENT_API_VERSION = SHOPIFY_ADMIN_API_VERSION
export const SHOPIFY_ORDER_MANAGEMENT_ADAPTER_VERSION =
  'shopify-graphql-2026-07-order-management-v4'

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
      reason?: ShopifyOrderCancellationReason
      staffNote?: string | null
      refundMethod?: ShopifyOrderCancellationRefundMethod
      restock?: boolean
      notifyCustomer?: boolean
    }
  | {
      type: 'cancel_fulfillment'
      fulfillmentGid: string
      expectedFulfillmentUpdatedAt: string
    }
  | {
      type: 'cancel_order_after_fulfillment_reversal'
      predecessorAuthorizationGlobalId: string
      reversedFulfillmentGid?: string
      reason?: ShopifyOrderCancellationReason
      staffNote?: string | null
      refundMethod?: ShopifyOrderCancellationRefundMethod
      restock?: boolean
      notifyCustomer?: boolean
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
      shippingAddress: ShopifyOrderShippingAddress | null
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

export type ShopifyOrderShippingAddress = {
  firstName: string | null
  lastName: string | null
  company: string | null
  address1: string | null
  address2: string | null
  city: string | null
  provinceCode: string | null
  countryCode: string | null
  zip: string | null
  phone: string | null
}

export type ShopifyOrderManagementFulfillmentTracking = {
  company: string | null
  number: string | null
  url: string | null
}

export type ShopifyOrderManagementFulfillmentOrder = {
  id: string
  assignedLocation: {
    location: {
      id: string
      name: string
    } | null
  }
}

export type ShopifyOrderManagementFulfillment = {
  id: string
  name: string
  status: string
  displayStatus: string | null
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
  totalQuantity: number
  tracking: ShopifyOrderManagementFulfillmentTracking[]
  fulfillmentOrders: ShopifyOrderManagementFulfillmentOrder[]
}

export type ShopifyOrderManagementTransaction = {
  id: string
  kind: string
  status: string
  test: boolean
  manuallyCapturable: boolean
  amount: ShopifyOrderManagementMoney
  totalUnsettled: ShopifyOrderManagementMoney | null
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
  totalReceived: ShopifyOrderManagementMoney
  totalRefunded: ShopifyOrderManagementMoney
  totalCapturable: ShopifyOrderManagementMoney
  transactionsCount: number | null
  paymentEvidenceComplete: boolean
  transactions: ShopifyOrderManagementTransaction[]
  email: string | null
  phone: string | null
  poNumber: string | null
  note: string | null
  shippingAddress: ShopifyOrderShippingAddress | null
  tags: string[]
  lines: ShopifyOrderManagementLine[]
  fulfillments: ShopifyOrderManagementFulfillment[]
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
    shippingAddress: ShopifyOrderShippingAddress | null
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

export type ShopifyFulfillmentCancelMutationResult = {
  fulfillmentGid: string
  status: string
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

export type ShopifyOrderCancellationPaymentEligibility = Readonly<{
  allowed: boolean
  reason: string | null
  releasesAuthorization: boolean
}>

export type ShopifyOrderCancellationReason =
  | 'CUSTOMER'
  | 'DECLINED'
  | 'FRAUD'
  | 'INVENTORY'
  | 'OTHER'
  | 'STAFF'

export type ShopifyOrderCancellationRefundMethod =
  | 'none'
  | 'original_payment_methods'

export type ShopifyOrderCancellationPaymentEvidenceV1 = Readonly<{
  schema: 'shopify-order-cancel-payment-evidence-v1'
  transactionsCount: number
  authorizationTransactionId: string | null
  authorizationAmount: Readonly<ShopifyOrderManagementMoney> | null
}>

export type ShopifyOrderCancellationPaymentEvidenceV2 = Readonly<{
  schema: 'shopify-order-cancel-payment-evidence-v2'
  transactionsCount: number
  transactionsHash: string
  totalReceived: Readonly<ShopifyOrderManagementMoney>
  totalRefunded: Readonly<ShopifyOrderManagementMoney>
  totalCapturable: Readonly<ShopifyOrderManagementMoney>
  refundMethod: ShopifyOrderCancellationRefundMethod
}>

export type ShopifyOrderCancellationPaymentEvidence =
  | ShopifyOrderCancellationPaymentEvidenceV1
  | ShopifyOrderCancellationPaymentEvidenceV2

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
    | ShopifyFulfillmentCancelMutationResult
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
  cancellationPaymentEvidenceMatches?: (
    evidence: ShopifyOrderCancellationPaymentEvidence,
  ) => boolean
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
  fulfillmentGid?: string
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

function zeroMoney(value: ShopifyOrderManagementMoney): boolean {
  return compareDecimalAmounts(value.amount, '0') === 0
}

function positiveMoney(value: ShopifyOrderManagementMoney | null): boolean {
  return value !== null && compareDecimalAmounts(value.amount, '0') > 0
}

const UNRESOLVED_TRANSACTION_STATUSES = new Set([
  'AWAITING_RESPONSE',
  'PENDING',
  'UNKNOWN',
])

/**
 * Payment eligibility is shared by the public command state and the provider
 * execution assertion. Shopify's order-level displayFinancialStatus is never
 * used here: a PENDING order display status is distinct from a PENDING payment
 * transaction. The bounded, exhaustive transaction projection is authoritative.
 */
export function shopifyOrderCancellationPaymentEligibility(
  preview: ShopifyOrderManagementPreview,
  refundMethod: ShopifyOrderCancellationRefundMethod = 'none',
): ShopifyOrderCancellationPaymentEligibility {
  if (
    !preview.paymentEvidenceComplete
    || preview.transactionsCount === null
  ) {
    return Object.freeze({
      allowed: false,
      reason: 'Shopify payment transaction evidence is not bounded and exhaustive',
      releasesAuthorization: false,
    })
  }
  if (preview.transactions.some((transaction) => (
    UNRESOLVED_TRANSACTION_STATUSES.has(transaction.status)
  ))) {
    return Object.freeze({
      allowed: false,
      reason: 'A Shopify payment transaction is still pending or unresolved',
      releasesAuthorization: false,
    })
  }
  if (
    preview.totalRefunded.currencyCode !== preview.totalReceived.currencyCode
    || preview.totalCapturable.currencyCode !== preview.totalReceived.currencyCode
    || compareDecimalAmounts(
      preview.totalRefunded.amount,
      preview.totalReceived.amount,
    ) > 0
  ) {
    return Object.freeze({
      allowed: false,
      reason: 'Shopify returned inconsistent received, refunded, or capturable totals',
      releasesAuthorization: false,
    })
  }
  const successfulAuthorizations = preview.transactions.filter(
    (transaction) => (
      transaction.kind === 'AUTHORIZATION'
      && transaction.status === 'SUCCESS'
    ),
  )
  const liveTransactions = preview.transactions.filter((transaction) => (
    transaction.manuallyCapturable
    || positiveMoney(transaction.totalUnsettled)
  ))
  const capturableAmountPositive = positiveMoney(preview.totalCapturable)
  if (preview.capturable !== capturableAmountPositive) {
    return Object.freeze({
      allowed: false,
      reason: 'Shopify returned inconsistent capturable payment evidence',
      releasesAuthorization: false,
    })
  }

  if (preview.capturable) {
    const authorization = successfulAuthorizations.length === 1
      ? successfulAuthorizations[0]
      : null
    if (
      !authorization
      || liveTransactions.length !== 1
      || liveTransactions[0].id !== authorization.id
      || !positiveMoney(authorization.amount)
      || !positiveMoney(authorization.totalUnsettled)
      || authorization.amount.currencyCode
        !== preview.totalCapturable.currencyCode
      || authorization.totalUnsettled!.currencyCode
        !== preview.totalCapturable.currencyCode
      || compareDecimalAmounts(
        authorization.amount.amount,
        preview.totalCapturable.amount,
      ) !== 0
      || compareDecimalAmounts(
        authorization.totalUnsettled!.amount,
        preview.totalCapturable.amount,
      ) !== 0
    ) {
      return Object.freeze({
        allowed: false,
        reason: 'The capturable balance is not one bounded successful authorization',
        releasesAuthorization: false,
      })
    }
  } else if (liveTransactions.length > 0) {
    return Object.freeze({
      allowed: false,
      reason: 'Shopify returned a live payment authorization without a capturable balance',
      releasesAuthorization: false,
    })
  }
  const capturedPayments = preview.transactions.filter((transaction) => (
    transaction.status === 'SUCCESS'
    && ['CAPTURE', 'SALE'].includes(transaction.kind)
    && positiveMoney(transaction.amount)
  ))
  const unrefundedReceived = compareDecimalAmounts(
    preview.totalReceived.amount,
    preview.totalRefunded.amount,
  ) > 0
  if (refundMethod === 'original_payment_methods' && !unrefundedReceived) {
    return Object.freeze({
      allowed: false,
      reason: 'No captured Shopify payment remains to refund',
      releasesAuthorization: false,
    })
  }
  const expectedAdditionalTransactions = liveTransactions.length
    + (refundMethod === 'original_payment_methods' && unrefundedReceived
      ? Math.max(1, capturedPayments.length)
      : 0)
  if (
    preview.transactionsCount === null
    || preview.transactionsCount + expectedAdditionalTransactions
      > MAX_ORDER_TRANSACTIONS
  ) {
    return Object.freeze({
      allowed: false,
      reason: 'Shopify payment history has no bounded room to verify cancellation',
      releasesAuthorization: false,
    })
  }
  return Object.freeze({
    allowed: true,
    reason: null,
    releasesAuthorization: liveTransactions.length > 0,
  })
}

function cancellationTransactionsHash(
  transactions: readonly ShopifyOrderManagementTransaction[],
) {
  return createHash('sha256').update(JSON.stringify(
    [...transactions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((transaction) => ({
        id: transaction.id,
        kind: transaction.kind,
        status: transaction.status,
        test: transaction.test,
        manuallyCapturable: transaction.manuallyCapturable,
        amount: transaction.amount,
        totalUnsettled: transaction.totalUnsettled,
      })),
  )).digest('hex')
}

export function shopifyOrderCancellationPaymentEvidence(
  preview: ShopifyOrderManagementPreview,
  refundMethod: ShopifyOrderCancellationRefundMethod = 'none',
): ShopifyOrderCancellationPaymentEvidence | null {
  const eligibility = shopifyOrderCancellationPaymentEligibility(
    preview,
    refundMethod,
  )
  if (!eligibility.allowed || preview.transactionsCount === null) return null
  return Object.freeze({
    schema: 'shopify-order-cancel-payment-evidence-v2' as const,
    transactionsCount: preview.transactionsCount,
    transactionsHash: cancellationTransactionsHash(preview.transactions),
    totalReceived: Object.freeze({ ...preview.totalReceived }),
    totalRefunded: Object.freeze({ ...preview.totalRefunded }),
    totalCapturable: Object.freeze({ ...preview.totalCapturable }),
    refundMethod,
  })
}

export function shopifyOrderCancellationPaymentReleased(
  preview: ShopifyOrderManagementPreview,
  expected: ShopifyOrderCancellationPaymentEvidence,
) {
  if (expected.schema === 'shopify-order-cancel-payment-evidence-v2') {
    const sameCurrency = [
      preview.totalReceived,
      preview.totalRefunded,
      preview.totalCapturable,
    ].every((money) => money.currencyCode === expected.totalReceived.currencyCode)
      && expected.totalRefunded.currencyCode === expected.totalReceived.currencyCode
      && expected.totalCapturable.currencyCode === expected.totalReceived.currencyCode
    const refundProven = expected.refundMethod === 'none'
      ? compareDecimalAmounts(
          preview.totalRefunded.amount,
          expected.totalRefunded.amount,
        ) === 0
      : compareDecimalAmounts(
          preview.totalRefunded.amount,
          expected.totalReceived.amount,
        ) >= 0
    const unexpectedCapturedPayment = zeroMoney(expected.totalReceived)
      && preview.transactions.some((transaction) => (
        transaction.status === 'SUCCESS'
        && ['CAPTURE', 'SALE'].includes(transaction.kind)
        && positiveMoney(transaction.amount)
      ))
    return sameCurrency
      && preview.paymentEvidenceComplete
      && preview.transactionsCount !== null
      && preview.transactionsCount >= expected.transactionsCount
      && compareDecimalAmounts(
        preview.totalReceived.amount,
        expected.totalReceived.amount,
      ) === 0
      && !preview.capturable
      && zeroMoney(preview.totalCapturable)
      && refundProven
      && !unexpectedCapturedPayment
      && !preview.transactions.some((transaction) => (
        UNRESOLVED_TRANSACTION_STATUSES.has(transaction.status)
        || transaction.manuallyCapturable
        || positiveMoney(transaction.totalUnsettled)
      ))
  }
  const expectedAuthorization = expected.authorizationTransactionId
    ? preview.transactions.find((transaction) => (
        transaction.id === expected.authorizationTransactionId
      )) || null
    : null
  const authorizationReleased = expected.authorizationTransactionId === null
    ? expected.authorizationAmount === null
    : expected.authorizationAmount !== null
      && expectedAuthorization !== null
      && expectedAuthorization.kind === 'AUTHORIZATION'
      && expectedAuthorization.status === 'SUCCESS'
      && expectedAuthorization.test
      && expectedAuthorization.amount.currencyCode
        === expected.authorizationAmount.currencyCode
      && compareDecimalAmounts(
        expectedAuthorization.amount.amount,
        expected.authorizationAmount.amount,
      ) === 0
      && !expectedAuthorization.manuallyCapturable
      && (
        expectedAuthorization.totalUnsettled === null
        || (
          expectedAuthorization.totalUnsettled.currencyCode
            === expected.authorizationAmount.currencyCode
          && zeroMoney(expectedAuthorization.totalUnsettled)
        )
      )
  return preview.paymentEvidenceComplete
    && preview.transactionsCount !== null
    && preview.transactionsCount >= expected.transactionsCount
    && preview.unpaid
    && zeroMoney(preview.totalReceived)
    && !preview.capturable
    && zeroMoney(preview.totalCapturable)
    && authorizationReleased
    && !preview.transactions.some((transaction) => (
      UNRESOLVED_TRANSACTION_STATUSES.has(transaction.status)
      || transaction.manuallyCapturable
      || positiveMoney(transaction.totalUnsettled)
      || (
        transaction.status === 'SUCCESS'
        && ['CAPTURE', 'SALE'].includes(transaction.kind)
      )
    ))
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

function nullableAddressInputText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null) return null
  return inputText(value, label, maximum, { allowEmpty: false })
}

function nullableAddressResponseText(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === '') return null
  return strictText(value, label, maximum, { allowEmpty: false })
}

function countryCodeInput(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !COUNTRY_CODE_PATTERN.test(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify shipping-address country code is invalid',
    )
  }
  return value
}

function countryCodeResponse(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !COUNTRY_CODE_PATTERN.test(value)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned an invalid shipping-address country code',
      502,
      { stage: 'provider_response' },
    )
  }
  return value
}

const SHIPPING_ADDRESS_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'address1',
  'address2',
  'city',
  'provinceCode',
  'countryCode',
  'zip',
  'phone',
] as const

function normalizeShippingAddressInput(
  value: unknown,
): ShopifyOrderShippingAddress | null {
  if (value === null) return null
  const address = safeRecord(value)
  if (
    !address
    || Object.keys(address).some((key) => (
      !(SHIPPING_ADDRESS_FIELDS as readonly string[]).includes(key)
    ))
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify shipping address is invalid',
    )
  }
  return {
    firstName: nullableAddressInputText(
      address.firstName,
      'Shopify shipping-address first name',
      MAX_ADDRESS_NAME_LENGTH,
    ),
    lastName: nullableAddressInputText(
      address.lastName,
      'Shopify shipping-address last name',
      MAX_ADDRESS_NAME_LENGTH,
    ),
    company: nullableAddressInputText(
      address.company,
      'Shopify shipping-address company',
      MAX_ADDRESS_COMPANY_LENGTH,
    ),
    address1: nullableAddressInputText(
      address.address1,
      'Shopify shipping-address line 1',
      MAX_ADDRESS_LINE_LENGTH,
    ),
    address2: nullableAddressInputText(
      address.address2,
      'Shopify shipping-address line 2',
      MAX_ADDRESS_LINE_LENGTH,
    ),
    city: nullableAddressInputText(
      address.city,
      'Shopify shipping-address city',
      MAX_ADDRESS_CITY_LENGTH,
    ),
    provinceCode: nullableAddressInputText(
      address.provinceCode,
      'Shopify shipping-address province or state code',
      MAX_ADDRESS_PROVINCE_CODE_LENGTH,
    ),
    countryCode: countryCodeInput(address.countryCode),
    zip: nullableAddressInputText(
      address.zip,
      'Shopify shipping-address postal code',
      MAX_ADDRESS_POSTAL_CODE_LENGTH,
    ),
    phone: nullableAddressInputText(
      address.phone,
      'Shopify shipping-address phone',
      MAX_PHONE_LENGTH,
    ),
  }
}

function parseShippingAddress(value: unknown): ShopifyOrderShippingAddress | null {
  if (value === null) return null
  const address = safeRecord(value)
  if (!address) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned an invalid shipping address',
      502,
      { stage: 'provider_response' },
    )
  }
  return {
    firstName: nullableAddressResponseText(
      address.firstName,
      'shipping-address first name',
      MAX_ADDRESS_NAME_LENGTH,
    ),
    lastName: nullableAddressResponseText(
      address.lastName,
      'shipping-address last name',
      MAX_ADDRESS_NAME_LENGTH,
    ),
    company: nullableAddressResponseText(
      address.company,
      'shipping-address company',
      MAX_ADDRESS_COMPANY_LENGTH,
    ),
    address1: nullableAddressResponseText(
      address.address1,
      'shipping-address line 1',
      MAX_ADDRESS_LINE_LENGTH,
    ),
    address2: nullableAddressResponseText(
      address.address2,
      'shipping-address line 2',
      MAX_ADDRESS_LINE_LENGTH,
    ),
    city: nullableAddressResponseText(
      address.city,
      'shipping-address city',
      MAX_ADDRESS_CITY_LENGTH,
    ),
    provinceCode: nullableAddressResponseText(
      address.provinceCode,
      'shipping-address province or state code',
      MAX_ADDRESS_PROVINCE_CODE_LENGTH,
    ),
    countryCode: countryCodeResponse(address.countryCodeV2),
    zip: nullableAddressResponseText(
      address.zip,
      'shipping-address postal code',
      MAX_ADDRESS_POSTAL_CODE_LENGTH,
    ),
    phone: nullableAddressResponseText(
      address.phone,
      'shipping-address phone',
      MAX_PHONE_LENGTH,
    ),
  }
}

function sameShippingAddress(
  left: ShopifyOrderShippingAddress | null,
  right: ShopifyOrderShippingAddress | null,
) {
  return JSON.stringify(left) === JSON.stringify(right)
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

function parseFulfillmentTracking(
  value: unknown,
): ShopifyOrderManagementFulfillmentTracking {
  const tracking = safeRecord(value)
  if (!tracking) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid fulfillment tracking evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  return {
    company: nullableResponseText(
      tracking.company,
      'fulfillment tracking company',
      255,
    ),
    number: nullableResponseText(
      tracking.number,
      'fulfillment tracking number',
      255,
    ),
    url: nullableResponseText(
      tracking.url,
      'fulfillment tracking URL',
      2_048,
    ),
  }
}

function parseFulfillmentOrder(
  value: unknown,
): ShopifyOrderManagementFulfillmentOrder {
  const fulfillmentOrder = safeRecord(value)
  const assignedLocation = safeRecord(fulfillmentOrder?.assignedLocation)
  const location = safeRecord(assignedLocation?.location)
  if (
    !fulfillmentOrder
    || !assignedLocation
    || (assignedLocation.location !== null && !location)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid fulfillment ownership evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  return {
    id: strictGid(
      fulfillmentOrder.id,
      'fulfillment order identity',
      FULFILLMENT_ORDER_GID_PATTERN,
    ),
    assignedLocation: {
      location: location
        ? {
            id: strictGid(
              location.id,
              'fulfillment location identity',
              LOCATION_GID_PATTERN,
            ),
            name: strictText(location.name, 'fulfillment location name', 255),
          }
        : null,
    },
  }
}

function parseFulfillment(value: unknown): ShopifyOrderManagementFulfillment {
  const fulfillment = safeRecord(value)
  const fulfillmentOrders = safeRecord(fulfillment?.fulfillmentOrders)
  const pageInfo = safeRecord(fulfillmentOrders?.pageInfo)
  if (
    !fulfillment
    || !Array.isArray(fulfillment.trackingInfo)
    || fulfillment.trackingInfo.length > MAX_FULFILLMENT_TRACKING_ENTRIES
    || (fulfillment?.fulfillmentOrders !== undefined && (
      !fulfillmentOrders
      || !pageInfo
      || !Array.isArray(fulfillmentOrders.nodes)
      || fulfillmentOrders.nodes.length > MAX_FULFILLMENT_ORDERS
      || typeof pageInfo.hasNextPage !== 'boolean'
    ))
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid fulfillment evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  if (pageInfo?.hasNextPage) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_FULFILLMENT_TOO_LARGE',
      'A Shopify fulfillment has more fulfillment orders than the bounded preview can verify',
      409,
      { stage: 'provider_preview' },
    )
  }
  const parsedFulfillmentOrders = fulfillmentOrders
    ? (fulfillmentOrders.nodes as unknown[]).map(parseFulfillmentOrder)
    : []
  if (
    new Set(parsedFulfillmentOrders.map((entry) => entry.id)).size
      !== parsedFulfillmentOrders.length
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned duplicate fulfillment ownership evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  return {
    id: strictGid(
      fulfillment.id,
      'fulfillment identity',
      FULFILLMENT_GID_PATTERN,
    ),
    name: strictText(fulfillment.name, 'fulfillment name', 255),
    status: strictText(fulfillment.status, 'fulfillment status', 64),
    displayStatus: fulfillment.displayStatus === null
      ? null
      : strictText(
          fulfillment.displayStatus,
          'fulfillment display status',
          64,
        ),
    createdAt: isoDate(fulfillment.createdAt, 'fulfillment creation timestamp'),
    updatedAt: isoDate(fulfillment.updatedAt, 'fulfillment update timestamp'),
    deliveredAt: optionalIsoDate(
      fulfillment.deliveredAt,
      'fulfillment delivery timestamp',
    ),
    totalQuantity: strictNonnegativeInteger(
      fulfillment.totalQuantity,
      'fulfillment total quantity',
    ),
    tracking: fulfillment.trackingInfo.map(parseFulfillmentTracking),
    fulfillmentOrders: parsedFulfillmentOrders,
  }
}

function parseOrderTransaction(
  value: unknown,
  shopCurrencyCode: string,
): ShopifyOrderManagementTransaction {
  const transaction = safeRecord(value)
  if (!transaction) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid payment transaction evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  const kind = strictText(transaction.kind, 'payment transaction kind', 64)
  const status = strictText(
    transaction.status,
    'payment transaction status',
    64,
  )
  if (
    !ORDER_TRANSACTION_KINDS.has(kind)
    || !ORDER_TRANSACTION_STATUSES.has(status)
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid payment transaction state',
      502,
      { stage: 'provider_preview' },
    )
  }
  return {
    id: strictGid(
      transaction.id,
      'payment transaction identity',
      ORDER_TRANSACTION_GID_PATTERN,
    ),
    kind,
    status,
    test: strictBoolean(transaction.test, 'payment transaction test state'),
    manuallyCapturable: strictBoolean(
      transaction.manuallyCapturable,
      'payment transaction capturable state',
    ),
    amount: strictPreviewMoney(
      transaction.amountSet,
      'payment transaction amount',
      shopCurrencyCode,
    ),
    totalUnsettled: transaction.totalUnsettledSet === null
      ? null
      : strictPreviewMoney(
          transaction.totalUnsettledSet,
          'payment transaction unsettled amount',
          shopCurrencyCode,
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
    || !Array.isArray(order.fulfillments)
    || order.fulfillments.length > MAX_ORDER_FULFILLMENTS
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
  const fulfillments = order.fulfillments.map(parseFulfillment)
  if (
    new Set(fulfillments.map((fulfillment) => fulfillment.id)).size
      !== fulfillments.length
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned duplicate fulfillments',
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
  if (!Array.isArray(order.transactions)) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid payment transaction evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  const transactionCount = order.transactionsCount === null
    ? null
    : safeRecord(order.transactionsCount)
  if (
    order.transactions.length > MAX_ORDER_TRANSACTIONS
    || (order.transactionsCount !== null && !transactionCount)
    || (
      transactionCount
      && (
        !['AT_LEAST', 'EXACT'].includes(String(transactionCount.precision))
        || !Number.isSafeInteger(transactionCount.count)
        || Number(transactionCount.count) < 0
        || Number(transactionCount.count) > 2_147_483_647
      )
    )
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned invalid payment transaction count evidence',
      502,
      { stage: 'provider_preview' },
    )
  }
  const normalizedTransactionCount = transactionCount
    ? Number(transactionCount.count)
    : null
  const paymentEvidenceComplete = transactionCount?.precision === 'EXACT'
    && normalizedTransactionCount !== null
    && normalizedTransactionCount <= MAX_ORDER_TRANSACTIONS
    && order.transactions.length === normalizedTransactionCount
  const transactions = order.transactions.map((transaction) => (
    parseOrderTransaction(transaction, shopCurrencyCode)
  ))
  if (
    new Set(transactions.map((transaction) => transaction.id)).size
      !== transactions.length
  ) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_RESPONSE_INVALID',
      'Shopify returned duplicate payment transactions',
      502,
      { stage: 'provider_preview' },
    )
  }
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
    totalReceived: strictPreviewMoney(
      order.totalReceivedSet,
      'order total received',
      shopCurrencyCode,
    ),
    totalRefunded: strictPreviewMoney(
      order.totalRefundedSet,
      'order total refunded',
      shopCurrencyCode,
    ),
    totalCapturable: strictPreviewMoney(
      order.totalCapturableSet,
      'order total capturable',
      shopCurrencyCode,
    ),
    transactionsCount: normalizedTransactionCount,
    paymentEvidenceComplete,
    transactions,
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
    shippingAddress: parseShippingAddress(order.shippingAddress),
    tags: strictTags(order.tags),
    lines,
    fulfillments,
  }
}

const SHOPIFY_ORDER_MANAGEMENT_PREVIEW_QUERY =
  `query ClawPilotShopifyOrderManagementPreview(
    $id: ID!
    $fulfillmentId: ID!
    $includeExactFulfillment: Boolean!
    $includeFulfillmentOwnership: Boolean!
  ) {
    shop { currencyCode }
    exactFulfillment: node(id: $fulfillmentId)
      @include(if: $includeExactFulfillment) {
      ... on Fulfillment {
        ...ClawPilotShopifyFulfillmentEvidence
        order { id }
        fulfillmentOrders(first: 10)
          @include(if: $includeFulfillmentOwnership) {
          nodes {
            id
            assignedLocation {
              location { id name }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
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
      totalReceivedSet {
        shopMoney { amount currencyCode }
      }
      totalRefundedSet {
        shopMoney { amount currencyCode }
      }
      totalCapturableSet {
        shopMoney { amount currencyCode }
      }
      transactionsCount { count precision }
      transactions(first: 25) {
        id
        kind
        status
        test
        manuallyCapturable
        amountSet {
          shopMoney { amount currencyCode }
        }
        totalUnsettledSet {
          shopMoney { amount currencyCode }
        }
      }
      email
      phone
      poNumber
      note
      shippingAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        provinceCode
        countryCodeV2
        zip
        phone
      }
      tags
      fulfillments(first: 10) {
        ...ClawPilotShopifyFulfillmentEvidence
      }
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
  }
  fragment ClawPilotShopifyFulfillmentEvidence on Fulfillment {
    id
    name
    status
    displayStatus
    createdAt
    updatedAt
    deliveredAt
    totalQuantity
    trackingInfo(first: 10) {
      company
      number
      url
    }
  }`

export async function readShopifyOrderManagementPreview(
  credential: ShopifyCommerceRuntimeCredential,
  orderGid: unknown,
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
  exactFulfillmentGid?: unknown,
  includeFulfillmentOwnership = false,
): Promise<ShopifyOrderManagementPreview> {
  const id = inputGid(orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const includeExactFulfillment = exactFulfillmentGid !== undefined
  const fulfillmentId = includeExactFulfillment
    ? inputGid(
        exactFulfillmentGid,
        'exact Shopify fulfillment ID',
        FULFILLMENT_GID_PATTERN,
      )
    : id
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{
    order?: unknown
    shop?: unknown
    exactFulfillment?: unknown
  }>(
    credential,
    {
      query: SHOPIFY_ORDER_MANAGEMENT_PREVIEW_QUERY,
      operationName: 'ClawPilotShopifyOrderManagementPreview',
      variables: {
        id,
        fulfillmentId,
        includeExactFulfillment,
        includeFulfillmentOwnership:
          includeExactFulfillment && includeFulfillmentOwnership,
      },
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
  if (!includeExactFulfillment) return preview
  const exactFulfillment = safeRecord(root.exactFulfillment)
  const exactOrder = safeRecord(exactFulfillment?.order)
  if (
    !exactFulfillment
    || !exactOrder
    || strictGid(
      exactOrder.id,
      'fulfillment order identity',
      ORDER_GID_PATTERN,
    ) !== preview.id
  ) {
    fail(
      'SHOPIFY_FULFILLMENT_NOT_FOUND',
      'The exact Shopify fulfillment was not found on this order',
      404,
      { stage: 'provider_preview' },
    )
  }
  const parsedFulfillment = parseFulfillment(exactFulfillment)
  const fulfillments = preview.fulfillments.some((entry) => (
    entry.id === parsedFulfillment.id
  ))
    ? preview.fulfillments.map((entry) => (
        entry.id === parsedFulfillment.id ? parsedFulfillment : entry
      ))
    : [...preview.fulfillments, parsedFulfillment]
  return { ...preview, fulfillments }
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
      order {
        id
        name
        updatedAt
        email
        phone
        poNumber
        note
        tags
        shippingAddress {
          firstName
          lastName
          company
          address1
          address2
          city
          provinceCode
          countryCodeV2
          zip
          phone
        }
      }
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
    shippingAddress?: unknown
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
    && input.shippingAddress === undefined
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
  const shippingAddress = input.shippingAddress === undefined
    ? undefined
    : normalizeShippingAddressInput(input.shippingAddress)
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
    ...(shippingAddress !== undefined ? { shippingAddress } : {}),
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
    shippingAddress: parseShippingAddress(order.shippingAddress),
    tags: strictTags(order.tags, 'updated order tags'),
  }
  if (
    result.orderGid !== orderGid
    || (email !== undefined && result.email !== email)
    || (phone !== undefined && result.phone !== phone)
    || (poNumber !== undefined && result.poNumber !== poNumber)
    || (note !== undefined && result.note !== note)
    || (shippingAddress !== undefined && !sameShippingAddress(
      result.shippingAddress,
      shippingAddress,
    ))
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
  `mutation ClawPilotShopifyOrderCancel(
    $orderId: ID!
    $notifyCustomer: Boolean!
    $refundMethod: OrderCancelRefundMethodInput
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

export async function cancelShopifyOrder(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    orderGid: unknown
    reason?: unknown
    staffNote?: unknown
    refundMethod?: unknown
    restock?: unknown
    notifyCustomer?: unknown
  },
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyOrderCancelMutationResult> {
  const orderGid = inputGid(input.orderGid, 'Shopify order ID', ORDER_GID_PATTERN)
  const reason = input.reason === undefined ? 'STAFF' : input.reason
  if (![
    'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF',
  ].includes(String(reason))) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify cancellation reason is invalid',
    )
  }
  const refundMethod = input.refundMethod === undefined
    ? 'none' : input.refundMethod
  if (refundMethod !== 'none' && refundMethod !== 'original_payment_methods') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify cancellation refund choice is invalid',
    )
  }
  const restock = input.restock === undefined ? false : input.restock
  const notifyCustomer = input.notifyCustomer === undefined
    ? false : input.notifyCustomer
  if (typeof restock !== 'boolean' || typeof notifyCustomer !== 'boolean') {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Shopify cancellation options are invalid',
    )
  }
  const staffNote = normalizeStaffNote(input.staffNote, false)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ orderCancel?: unknown }>(
    credential,
    {
      query: SHOPIFY_ORDER_CANCEL_MUTATION,
      operationName: 'ClawPilotShopifyOrderCancel',
      variables: {
        orderId: orderGid,
        notifyCustomer,
        refundMethod: {
          originalPaymentMethodsRefund:
            refundMethod === 'original_payment_methods',
        },
        restock,
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
      'Shopify rejected the order cancellation',
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

/** @deprecated Use cancelShopifyOrder. Retained for adapter compatibility. */
export const cancelShopifyTestOrder = cancelShopifyOrder

const SHOPIFY_FULFILLMENT_CANCEL_MUTATION =
  `mutation ClawPilotShopifyTestFulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }`

export async function cancelShopifyTestFulfillment(
  credential: ShopifyCommerceRuntimeCredential,
  fulfillmentGidInput: unknown,
  options: ShopifyCommerceClientOptions = {},
  overrides: Partial<ShopifyOrderManagementDependencies> = {},
): Promise<ShopifyFulfillmentCancelMutationResult> {
  const fulfillmentGid = inputGid(
    fulfillmentGidInput,
    'Shopify fulfillment ID',
    FULFILLMENT_GID_PATTERN,
  )
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const data = await dependencies.graphql<{ fulfillmentCancel?: unknown }>(
    credential,
    {
      query: SHOPIFY_FULFILLMENT_CANCEL_MUTATION,
      operationName: 'ClawPilotShopifyTestFulfillmentCancel',
      variables: { id: fulfillmentGid },
    },
    options,
  )
  const payload = safeRecord(safeRecord(data)?.fulfillmentCancel)
  if (!payload) {
    fail(
      'SHOPIFY_FULFILLMENT_CANCEL_RESPONSE_INVALID',
      'Shopify returned an invalid fulfillment cancellation response',
      502,
      { stage: 'cancel_fulfillment' },
    )
  }
  if (safeUserErrors(payload.userErrors).length) {
    providerRejected(
      'SHOPIFY_FULFILLMENT_CANCEL_REJECTED',
      'Shopify rejected the test-order fulfillment cancellation',
      'cancel_fulfillment',
    )
  }
  const fulfillment = safeRecord(payload.fulfillment)
  if (!fulfillment) {
    fail(
      'SHOPIFY_FULFILLMENT_CANCEL_RESPONSE_INVALID',
      'Shopify did not return the cancelled fulfillment',
      502,
      { stage: 'cancel_fulfillment' },
    )
  }
  const result = {
    fulfillmentGid: strictGid(
      fulfillment.id,
      'cancelled fulfillment identity',
      FULFILLMENT_GID_PATTERN,
    ),
    status: strictText(
      fulfillment.status,
      'cancelled fulfillment status',
      64,
    ),
  }
  if (result.fulfillmentGid !== fulfillmentGid || result.status !== 'CANCELLED') {
    fail(
      'SHOPIFY_FULFILLMENT_CANCEL_RESPONSE_MISMATCH',
      'Shopify returned a different or non-cancelled fulfillment',
      502,
      { stage: 'cancel_fulfillment' },
    )
  }
  return result
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
    if (![
      'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF',
    ].includes(reason)) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify cancellation reason is invalid',
      )
    }
    const refundMethod = action.refundMethod === undefined
      ? 'none' : action.refundMethod
    if (refundMethod !== 'none' && refundMethod !== 'original_payment_methods') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify cancellation refund choice is invalid',
      )
    }
    const restock = action.restock === undefined ? false : action.restock
    const notifyCustomer = action.notifyCustomer === undefined
      ? false : action.notifyCustomer
    if (typeof restock !== 'boolean' || typeof notifyCustomer !== 'boolean') {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify cancellation options are invalid',
      )
    }
    return {
      type: 'cancel',
      reason,
      staffNote: normalizeStaffNote(action.staffNote, false),
      refundMethod,
      restock,
      notifyCustomer,
    }
  }
  if (action.type === 'cancel_order_after_fulfillment_reversal') {
    const reason = action.reason === undefined ? 'STAFF' : action.reason
    if (![
      'CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF',
    ].includes(reason)) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Shopify cancellation reason is invalid',
      )
    }
    if (
      (action.refundMethod !== undefined && action.refundMethod !== 'none')
      || (action.restock !== undefined && action.restock !== false)
      || (action.notifyCustomer !== undefined
        && action.notifyCustomer !== false)
    ) {
      fail(
        'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
        'Post-reversal cancellation options are fixed',
      )
    }
    return {
      type: 'cancel_order_after_fulfillment_reversal',
      predecessorAuthorizationGlobalId: inputGid(
        action.predecessorAuthorizationGlobalId,
        'fulfillment-reversal authorization ID',
        AUTHORIZATION_GLOBAL_ID_PATTERN,
      ),
      reversedFulfillmentGid: inputGid(
        action.reversedFulfillmentGid,
        'reversed Shopify fulfillment ID',
        FULFILLMENT_GID_PATTERN,
      ),
      reason,
      staffNote: normalizeStaffNote(action.staffNote, false),
      refundMethod: 'none',
      restock: false,
      notifyCustomer: false,
    }
  }
  if (action.type === 'cancel_fulfillment') {
    return {
      type: 'cancel_fulfillment',
      fulfillmentGid: inputGid(
        action.fulfillmentGid,
        'Shopify fulfillment ID',
        FULFILLMENT_GID_PATTERN,
      ),
      expectedFulfillmentUpdatedAt: expectedIsoDate(
        action.expectedFulfillmentUpdatedAt,
        'expected Shopify fulfillment timestamp',
      ),
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
      shippingAddress: normalizeShippingAddressInput(action.shippingAddress),
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
  shippingAddress: ShopifyOrderShippingAddress | null
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
    shippingAddress: preview.shippingAddress,
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
    shippingAddress: action.shippingAddress,
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
    schema: 'shopify-order-save-projection-v2',
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
  return action.type === 'cancel_fulfillment'
    ? [
        'read_orders',
        'write_orders',
        'write_merchant_managed_fulfillment_orders',
      ]
    : action.type === 'set_line_quantity'
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

function assertCancellationEligible(
  preview: ShopifyOrderManagementPreview,
  refundMethod: ShopifyOrderCancellationRefundMethod,
) {
  if (
    preview.cancelledAt !== null
    || preview.closed
    || preview.returnStatus !== 'NO_RETURN'
    || !whollyUnfulfilled(preview)
  ) {
    fail(
      'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
      'The order is not open, wholly unfulfilled, and without returns',
      409,
      { stage: 'eligibility' },
    )
  }
  const payment = shopifyOrderCancellationPaymentEligibility(
    preview,
    refundMethod,
  )
  if (!payment.allowed) {
    fail(
      'SHOPIFY_ORDER_CANCEL_NOT_ELIGIBLE',
      payment.reason || 'The order payment state is not eligible for cancellation',
      409,
      { stage: 'eligibility' },
    )
  }
}

function assertPostReversalCancellationEligible(
  preview: ShopifyOrderManagementPreview,
  action: Extract<
    ShopifyOrderManagementAction,
    { type: 'cancel_order_after_fulfillment_reversal' }
  >,
) {
  assertTestOrder(preview)
  assertCancellationEligible(preview, action.refundMethod || 'none')
  const reversedFulfillment = targetFulfillment(
    preview,
    action.reversedFulfillmentGid!,
  )
  if (reversedFulfillment.status !== 'CANCELLED') {
    fail(
      'SHOPIFY_ORDER_POST_REVERSAL_CANCEL_NOT_ELIGIBLE',
      'The exact predecessor fulfillment is not cancelled in Shopify',
      409,
      { stage: 'eligibility' },
    )
  }
}

function targetFulfillment(
  preview: ShopifyOrderManagementPreview,
  fulfillmentGid: string,
): ShopifyOrderManagementFulfillment {
  const fulfillment = preview.fulfillments.find((candidate) => (
    candidate.id === fulfillmentGid
  ))
  if (!fulfillment) {
    fail(
      'SHOPIFY_FULFILLMENT_NOT_FOUND',
      'The selected Shopify fulfillment was not found on this order',
      404,
      { stage: 'eligibility' },
    )
  }
  return fulfillment
}

function assertFulfillmentCancellationEligible(
  preview: ShopifyOrderManagementPreview,
  action: Extract<
    ShopifyOrderManagementAction,
    { type: 'cancel_fulfillment' }
  >,
): ShopifyOrderManagementFulfillment {
  assertTestOrder(preview)
  const fulfillment = targetFulfillment(preview, action.fulfillmentGid)
  if (fulfillment.updatedAt !== action.expectedFulfillmentUpdatedAt) {
    fail(
      'SHOPIFY_FULFILLMENT_STALE',
      'The Shopify fulfillment changed after this reversal was prepared',
      409,
      { stage: 'eligibility' },
    )
  }
  if (
    fulfillment.status !== 'SUCCESS'
    || fulfillment.displayStatus !== 'FULFILLED'
    || fulfillment.deliveredAt !== null
    || fulfillment.totalQuantity < 1
    || fulfillment.fulfillmentOrders.length < 1
    || fulfillment.fulfillmentOrders.some((fulfillmentOrder) => (
      fulfillmentOrder.assignedLocation.location === null
    ))
  ) {
    fail(
      'SHOPIFY_FULFILLMENT_CANCEL_NOT_ELIGIBLE',
      'Only a successful, undelivered Shopify fulfillment with exact assigned-location evidence can be reversed',
      409,
      { stage: 'eligibility' },
    )
  }
  return fulfillment
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
  if (!Array.isArray(value) || value.length > 6) {
    fail(
      'SHOPIFY_ORDER_MANAGEMENT_INPUT_INVALID',
      'Required Shopify order actions are invalid',
    )
  }
  const actions = [...new Set(value)]
  if (actions.some((action) => ![
    'add_tag',
    'cancel',
    'cancel_order_after_fulfillment_reversal',
    'cancel_fulfillment',
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
  const fulfillmentGid = input.fulfillmentGid === undefined
    ? undefined
    : inputGid(
        input.fulfillmentGid,
        'exact Shopify fulfillment ID',
        FULFILLMENT_GID_PATTERN,
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
    if (action === 'set_line_quantity') {
      required.add('write_order_edits')
      continue
    }
    required.add('write_orders')
    if (action === 'cancel_fulfillment') {
      required.add('write_merchant_managed_fulfillment_orders')
    }
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
    fulfillmentGid,
    actions.includes('cancel_fulfillment'),
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
  const exactFulfillmentGid = action.type === 'cancel_fulfillment'
    ? action.fulfillmentGid
    : action.type === 'cancel_order_after_fulfillment_reversal'
      ? action.reversedFulfillmentGid
      : undefined
  const before = await readShopifyOrderManagementPreview(
    runtimeCredential,
    expected.orderGid,
    options,
    dependencies,
    exactFulfillmentGid,
    action.type === 'cancel_fulfillment',
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
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
    const shippingAddressChanged = !sameShippingAddress(
      beforeProjection.shippingAddress,
      desired.shippingAddress,
    )
    const metadataChanged = beforeProjection.email !== desired.email
      || beforeProjection.phone !== desired.phone
      || beforeProjection.poNumber !== desired.poNumber
      || beforeProjection.note !== desired.note
      || shippingAddressChanged
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
            ...(shippingAddressChanged
              ? { shippingAddress: desired.shippingAddress }
              : {}),
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
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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

  if (action.type === 'cancel_fulfillment') {
    const fulfillment = assertFulfillmentCancellationEligible(before, action)
    let mutation: ShopifyFulfillmentCancelMutationResult
    try {
      mutation = await cancelShopifyTestFulfillment(
        runtimeCredential,
        fulfillment.id,
        options,
        dependencies,
      )
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
        fulfillment.id,
        true,
      )
      const cancelledFulfillment = after.fulfillments.find((candidate) => (
        candidate.id === fulfillment.id
      ))
      if (
        after.id !== before.id
        || after.name !== before.name
        || mutation.fulfillmentGid !== fulfillment.id
        || mutation.status !== 'CANCELLED'
        || !cancelledFulfillment
        || cancelledFulfillment.status !== 'CANCELLED'
      ) {
        fail(
          'SHOPIFY_FULFILLMENT_CANCEL_READBACK_MISMATCH',
          'Shopify fulfillment readback did not show the exact fulfillment as cancelled',
          502,
          { stage: 'cancel_fulfillment_readback' },
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
        providerReference: mutation.fulfillmentGid,
        errorCode: null,
        safeMessage: null,
      }
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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

  if (
    action.type === 'cancel'
    || action.type === 'cancel_order_after_fulfillment_reversal'
  ) {
    if (action.type === 'cancel_order_after_fulfillment_reversal') {
      assertPostReversalCancellationEligible(before, action)
    } else {
      assertCancellationEligible(before, action.refundMethod || 'none')
    }
    const cancellationPaymentEvidence =
      shopifyOrderCancellationPaymentEvidence(
        before,
        action.refundMethod || 'none',
      )
    if (!cancellationPaymentEvidence) {
      fail(
        'SHOPIFY_ORDER_CANCEL_PAYMENT_EVIDENCE_INVALID',
        'Shopify cancellation payment evidence could not be bound before the provider write',
      )
    }
    if (!input.cancellationPaymentEvidenceMatches) {
      fail(
        'SHOPIFY_ORDER_CANCEL_PAYMENT_EVIDENCE_BINDING_REQUIRED',
        'Shopify cancellation requires an exact durable payment-evidence binding',
      )
    }
    if (!input.cancellationPaymentEvidenceMatches(
      cancellationPaymentEvidence,
    )) {
      fail(
        'SHOPIFY_ORDER_CANCEL_PAYMENT_EVIDENCE_CHANGED',
        'Shopify cancellation payment evidence changed after authorization',
      )
    }
    let mutation: ShopifyOrderCancelMutationResult
    try {
      mutation = await cancelShopifyOrder(
        runtimeCredential,
        {
          orderGid: before.id,
          reason: action.reason,
          staffNote: action.staffNote,
          refundMethod: action.refundMethod,
          restock: action.restock,
          notifyCustomer: action.notifyCustomer,
        },
        options,
        dependencies,
      )
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
        action.type === 'cancel_order_after_fulfillment_reversal'
          ? action.reversedFulfillmentGid
          : undefined,
      )
      if (
        after.id !== before.id
        || after.name !== before.name
        || !after.cancelledAt
        || !shopifyOrderCancellationPaymentReleased(
          after,
          cancellationPaymentEvidence,
        )
      ) {
        fail(
          'SHOPIFY_ORDER_CANCEL_READBACK_MISMATCH',
          'Shopify cancellation readback did not prove cancellation and payment-authorization release',
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
      if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
