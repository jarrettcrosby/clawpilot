import { createHash } from 'node:crypto'

export const COMMERCE_NORMALIZATION_ENVELOPE_VERSION =
  'commerce-normalization-envelope-v1' as const
export const COMMERCE_NORMALIZED_PRODUCT_VERSION =
  'commerce-normalized-product-v1' as const
export const COMMERCE_NORMALIZED_VARIANT_VERSION =
  'commerce-normalized-variant-v1' as const
export const COMMERCE_NORMALIZED_ORDER_VERSION =
  'commerce-normalized-order-v1' as const
export const COMMERCE_NORMALIZED_ORDER_LINE_VERSION =
  'commerce-normalized-order-line-v1' as const

export type CommerceNormalizationProvider = 'shopify' | 'faire'
export type CommerceExternalResourceType =
  | 'brand'
  | 'customer'
  | 'inventory_item'
  | 'order'
  | 'order_line'
  | 'product'
  | 'retailer'
  | 'variant'

export type CommerceExternalIdentity = Readonly<{
  provider: CommerceNormalizationProvider
  resourceType: CommerceExternalResourceType
  value: string
}>

export type CommerceUnavailableReason =
  | 'access_denied'
  | 'not_provided'
  | 'not_requested'
  | 'not_supported'
  | 'provider_redacted'
  | 'untracked'

export type CommerceDataField<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{
      state: 'unavailable' | 'redacted'
      value: null
      reason: CommerceUnavailableReason
    }>

export type CommerceMoney = Readonly<{
  amountMinor: bigint
  currency: string
}>

/**
 * `primary` is the amount used by the provider as the operational order
 * amount. Shopify also exposes the exact shop and presentment bags. Other
 * providers leave those provider-specific bags unavailable.
 */
export type CommerceMoneySet = Readonly<{
  primary: CommerceMoney
  shop: CommerceDataField<CommerceMoney>
  presentment: CommerceDataField<CommerceMoney>
}>

export type CommerceLifecycleState =
  | 'cancelled'
  | 'closed'
  | 'open'
  | 'unknown'
export type CommercePaymentState =
  | 'authorized'
  | 'paid'
  | 'partially_paid'
  | 'partially_refunded'
  | 'pending'
  | 'refunded'
  | 'unknown'
  | 'voided'
export type CommerceFulfillmentState =
  | 'fulfilled'
  | 'on_hold'
  | 'partial'
  | 'scheduled'
  | 'unfulfilled'
  | 'unknown'
export type CommerceReturnState =
  | 'in_progress'
  | 'none'
  | 'requested'
  | 'returned'
  | 'unknown'

export type CommerceProviderStates = Readonly<{
  lifecycle: string | null
  payment: string | null
  fulfillment: string | null
  returns: string | null
}>

export type CommerceCanonicalStates = Readonly<{
  lifecycle: CommerceLifecycleState
  payment: CommercePaymentState
  fulfillment: CommerceFulfillmentState
  returns: CommerceReturnState
}>

export type CommerceAddressSnapshot = Readonly<{
  name: CommerceDataField<string>
  organizationName: CommerceDataField<string>
  line1: CommerceDataField<string>
  line2: CommerceDataField<string>
  city: CommerceDataField<string>
  region: CommerceDataField<string>
  regionCode: CommerceDataField<string>
  postalCode: CommerceDataField<string>
  country: CommerceDataField<string>
  countryCode: CommerceDataField<string>
  phone: CommerceDataField<string>
}>

export type CommercePartySnapshot = Readonly<{
  role: 'brand' | 'customer' | 'retailer'
  partyType: 'organization' | 'person' | 'unknown'
  externalIdentity: CommerceDataField<CommerceExternalIdentity>
  organizationName: CommerceDataField<string>
  contactName: CommerceDataField<string>
  email: CommerceDataField<string>
  phone: CommerceDataField<string>
}>

export type CommercePackagingSnapshot = Readonly<{
  weightGrams: number
  lengthMillimeters: number
  widthMillimeters: number
  heightMillimeters: number
  source: 'order_line' | 'product_variant'
}>

export type CommerceInventoryQuantity = CommerceDataField<
  Readonly<{
    quantity: number
    name: string
  }>
>

export type CommerceNormalizedOption = Readonly<{
  name: string
  value: string
}>

export type CommerceNormalizedVariant = Readonly<{
  schemaVersion: typeof COMMERCE_NORMALIZED_VARIANT_VERSION
  identity: CommerceExternalIdentity
  productIdentity: CommerceExternalIdentity
  inventoryItemIdentity: CommerceDataField<CommerceExternalIdentity>
  sku: string | null
  barcode: string | null
  title: string | null
  selectedOptions: readonly CommerceNormalizedOption[]
  unitMultiplier: number | null
  wholesalePrice: CommerceDataField<CommerceMoneySet>
  retailPrice: CommerceDataField<CommerceMoneySet>
  taxable: boolean | null
  requiresShipping: boolean | null
  inventory: CommerceInventoryQuantity
  packaging: CommerceDataField<CommercePackagingSnapshot>
  weightGrams: number | null
  providerCreatedAt: string | null
  providerUpdatedAt: string | null
  sourceHash: string
}>

export type CommerceNormalizedProduct = Readonly<{
  schemaVersion: typeof COMMERCE_NORMALIZED_PRODUCT_VERSION
  identity: CommerceExternalIdentity
  brandIdentity: CommerceDataField<CommerceExternalIdentity>
  title: string
  description: string | null
  vendor: string | null
  productType: string | null
  lifecycleState: string | null
  active: boolean | null
  providerCreatedAt: string | null
  providerUpdatedAt: string | null
  variants: readonly CommerceNormalizedVariant[]
  sourceHash: string
}>

export type ShopifyNormalizedOrderFacts = Readonly<{
  provider: 'shopify'
  shopDomain: string | null
  sourceName: string | null
  testOrder: boolean
  shippingService: Readonly<{
    code: string | null
    title: string | null
    deliveryCategory: string | null
  }> | null
}>

export type FaireNormalizedOrderFacts = Readonly<{
  provider: 'faire'
  brandIdentity: CommerceDataField<CommerceExternalIdentity>
  retailerIdentity: CommerceDataField<CommerceExternalIdentity>
  brandDiscount: CommerceDataField<CommerceMoneySet>
  lineDiscountTotal: CommerceDataField<CommerceMoneySet>
  payoutState: string | null
  payoutAmount: CommerceDataField<CommerceMoneySet>
}>

export type CommerceNormalizedOrderFacts =
  | ShopifyNormalizedOrderFacts
  | FaireNormalizedOrderFacts

export type CommerceOrderHeaderMoneyField =
  | 'subtotal'
  | 'discount'
  | 'shipping'
  | 'tax'
  | 'total'

/**
 * Provider-neutral safety boundary for order header money.
 *
 * `operational_incomplete` is intentionally narrow: exact merchandise,
 * discount, and tax evidence exists, but a provider did not return exact
 * shipping and/or header total. Those orders may stage exact fulfillment
 * demand from confirmed line quantities and prices, but cannot be used for
 * accounting or customer charges.
 */
export type CommerceOrderHeaderMoneyState = Readonly<{
  state: 'complete' | 'operational_incomplete'
  unavailableFields: readonly CommerceOrderHeaderMoneyField[]
  fulfillmentDemandEligible: boolean
  accountingEligible: boolean
  customerChargeEligible: boolean
}>

export type CommerceNormalizedOrderLine = Readonly<{
  schemaVersion: typeof COMMERCE_NORMALIZED_ORDER_LINE_VERSION
  identity: CommerceExternalIdentity
  productIdentity: CommerceDataField<CommerceExternalIdentity>
  variantIdentity: CommerceDataField<CommerceExternalIdentity>
  /**
   * SKU is matching evidence only. It is preserved exactly, including case,
   * and never substitutes for an exact account-scoped provider identity.
   */
  sku: string | null
  titleSnapshot: string
  variantTitleSnapshot: string | null
  vendorSnapshot: string | null
  orderedQuantity: number
  /**
   * Provider-observed line lifecycle quantities. Shopify supplies these
   * directly enough to calculate the exact remaining fulfillment workload.
   * Providers that do not expose line-level lifecycle quantities leave them
   * null so persistence can fail closed on partial fulfillment.
   *
   * Shopify's `quantity - currentQuantity` delta combines units removed by an
   * edit with refunded units. It is retained in `cancelledQuantity` only as
   * the existing ClawPilot candidate-schema disposition bucket; the exact
   * provider meaning is preserved by `removedOrRefundedQuantity`.
   */
  currentQuantity: number | null
  cancelledQuantity: number | null
  fulfilledQuantity: number | null
  unfulfilledQuantity: number | null
  returnedQuantity: number | null
  removedOrRefundedQuantity: number | null
  unitMultiplier: number | null
  physicalUnitQuantity: number
  unitPrice: CommerceDataField<CommerceMoneySet>
  lineSubtotal: CommerceDataField<CommerceMoneySet>
  lineDiscount: CommerceDataField<CommerceMoneySet>
  lineTax: CommerceDataField<CommerceMoneySet>
  requiresShipping: boolean
  packaging: CommerceDataField<CommercePackagingSnapshot>
  sourceHash: string
}>

export type CommerceReadinessDimension =
  | 'cancelled'
  | 'customer'
  | 'delivery'
  | 'fulfilled'
  | 'packaging'
  | 'product'
  | 'ship_to'
  | 'stale'
  | 'truncated'

export type CommerceReadinessCode =
  | 'customer_redacted'
  | 'customer_resolution_required'
  | 'customer_unavailable'
  | 'delivery_available'
  | 'delivery_decision_required'
  | 'order_already_fulfilled'
  | 'order_cancellation_state_unknown'
  | 'order_cancelled'
  | 'order_fulfillment_state_unknown'
  | 'order_not_cancelled'
  | 'order_not_fulfilled'
  | 'packaging_available'
  | 'packaging_required'
  | 'product_identity_missing'
  | 'product_mapping_required'
  | 'product_sku_ambiguous'
  | 'product_sku_missing'
  | 'ship_to_available'
  | 'ship_to_incomplete'
  | 'ship_to_redacted'
  | 'ship_to_unavailable'
  | 'source_complete'
  | 'source_current'
  | 'source_stale'
  | 'source_truncated'

export type CommerceReadinessFact = Readonly<{
  dimension: CommerceReadinessDimension
  code: CommerceReadinessCode
  blocking: boolean
  subjectExternalId: string | null
}>

export type CommerceNormalizedOrder = Readonly<{
  schemaVersion: typeof COMMERCE_NORMALIZED_ORDER_VERSION
  identity: CommerceExternalIdentity
  orderNumber: string
  providerCreatedAt: string | null
  providerProcessedAt: string | null
  providerUpdatedAt: string | null
  providerCancelledAt: string | null
  providerClosedAt: string | null
  rawStates: CommerceProviderStates
  canonicalStates: CommerceCanonicalStates
  currency: string
  subtotal: CommerceDataField<CommerceMoneySet>
  shipping: CommerceDataField<CommerceMoneySet>
  tax: CommerceDataField<CommerceMoneySet>
  discount: CommerceDataField<CommerceMoneySet>
  total: CommerceDataField<CommerceMoneySet>
  headerMoney: CommerceOrderHeaderMoneyState
  party: CommerceDataField<CommercePartySnapshot>
  shipTo: CommerceDataField<CommerceAddressSnapshot>
  requestedDeliveryAt: CommerceDataField<string>
  lines: readonly CommerceNormalizedOrderLine[]
  lineItemsTruncated: boolean
  sourceStale: boolean
  readinessFacts: readonly CommerceReadinessFact[]
  providerFacts: CommerceNormalizedOrderFacts
  sourceHash: string
}>

export type CommerceNormalizationContext = Readonly<{
  organizationId: string
  integrationAccountId: string
  externalAccountId: string
  apiVersion: string
  observedAt: string
  credentialGeneration: number
  retentionExpiresAt: string
  sourceState?: 'current' | 'stale'
}>

export type CommerceNormalizationRejectedResourceType = 'order' | 'product'

export type CommerceNormalizationRejectionCode =
  | 'COMMERCE_ORDER_LINE_PAGINATION_LIMIT'
  | 'COMMERCE_ORDER_MONEY_INCOMPLETE'
  | 'COMMERCE_ORDER_RECORD_INVALID'
  | 'COMMERCE_PRODUCT_VARIANT_PAGINATION_LIMIT'
  | 'COMMERCE_PRODUCT_RECORD_INVALID'

/**
 * Durable-safe evidence that a single provider record was excluded.
 *
 * Rejections intentionally contain no provider payload, exception text, party
 * data, address data, or other free-form provider values. `externalId` is
 * either a validated provider resource identifier supplied by the adapter or
 * a stable hash token when the record has no usable identifier.
 */
export type CommerceNormalizationRejection = Readonly<{
  resourceType: CommerceNormalizationRejectedResourceType
  externalId: string
  sourceHash: string
  errorCode: CommerceNormalizationRejectionCode
  safeMessage: string
}>

export type CommerceNormalizationEnvelope = Readonly<{
  schemaVersion: typeof COMMERCE_NORMALIZATION_ENVELOPE_VERSION
  normalizerVersion: string
  provider: CommerceNormalizationProvider
  organizationId: string
  integrationAccountId: string
  externalAccountId: string
  apiVersion: string
  observedAt: string
  credentialGeneration: number
  retentionExpiresAt: string
  sourceHash: string
  products: readonly CommerceNormalizedProduct[]
  orders: readonly CommerceNormalizedOrder[]
  rejections: readonly CommerceNormalizationRejection[]
}>

/**
 * Deliberately contains transformation only. Provider reads live outside this
 * boundary and write, mutation, webhook-registration, fulfillment-export, and
 * cursor-advancement methods cannot be attached through this interface.
 */
export interface ReadOnlyCommerceNormalizationAdapter<Source = unknown> {
  readonly provider: CommerceNormalizationProvider
  readonly normalizerVersion: string
  readonly normalize: (
    source: Readonly<Source>,
    context: CommerceNormalizationContext,
  ) => CommerceNormalizationEnvelope
}

export class CommerceNormalizationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message)
    this.name = 'CommerceNormalizationError'
  }
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])
const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
])
const FOUR_DECIMAL_CURRENCIES = new Set(['CLF', 'UYW'])
const PLAIN_DECIMAL = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/
const ISO_CURRENCY = /^[A-Z]{3}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MAX_MINOR_UNITS = BigInt('9223372036854775807')
const COMMERCE_NORMALIZATION_REJECTION_MESSAGES = Object.freeze({
  COMMERCE_ORDER_LINE_PAGINATION_LIMIT:
    'Provider order exceeds the bounded line-item intake limit.',
  COMMERCE_ORDER_MONEY_INCOMPLETE:
    'Provider order is missing required exact monetary totals.',
  COMMERCE_ORDER_RECORD_INVALID:
    'Provider order record could not be normalized.',
  COMMERCE_PRODUCT_VARIANT_PAGINATION_LIMIT:
    'Provider product exceeds the bounded variant intake limit.',
  COMMERCE_PRODUCT_RECORD_INVALID:
    'Provider product record could not be normalized.',
} satisfies Record<CommerceNormalizationRejectionCode, string>)

export function normalizeCommerceCurrency(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CommerceNormalizationError(
      'COMMERCE_CURRENCY_INVALID',
      'Commerce money requires an ISO 4217 currency code',
    )
  }
  const currency = value.trim().toUpperCase()
  if (!ISO_CURRENCY.test(currency)) {
    throw new CommerceNormalizationError(
      'COMMERCE_CURRENCY_INVALID',
      'Commerce money requires an ISO 4217 currency code',
    )
  }
  return currency
}

export function commerceCurrencyMinorUnit(value: unknown): number {
  const currency = normalizeCommerceCurrency(value)
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3
  if (FOUR_DECIMAL_CURRENCIES.has(currency)) return 4
  return 2
}

/**
 * Converts a provider decimal string without ever routing the amount through a
 * JavaScript floating-point value.
 */
export function decimalToCommerceMinorUnits(
  value: unknown,
  currencyValue: unknown,
): bigint {
  if (typeof value !== 'string') {
    throw new CommerceNormalizationError(
      'COMMERCE_MONEY_INVALID',
      'Commerce money must be supplied as a plain decimal string',
    )
  }
  const match = PLAIN_DECIMAL.exec(value.trim())
  if (!match) {
    throw new CommerceNormalizationError(
      'COMMERCE_MONEY_INVALID',
      'Commerce money must be supplied as a plain decimal string',
    )
  }
  const exponent = commerceCurrencyMinorUnit(currencyValue)
  const fraction = match[3] || ''
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) {
    throw new CommerceNormalizationError(
      'COMMERCE_MONEY_PRECISION_INVALID',
      'Commerce money has more precision than its currency supports',
    )
  }
  const padded = fraction.slice(0, exponent).padEnd(exponent, '0')
  const magnitude = BigInt(`${match[2]}${padded}`)
  const amount = match[1] === '-' ? -magnitude : magnitude
  if (amount > MAX_MINOR_UNITS || amount < -MAX_MINOR_UNITS) {
    throw new CommerceNormalizationError(
      'COMMERCE_MONEY_RANGE_INVALID',
      'Commerce money exceeds the supported minor-unit range',
    )
  }
  return amount
}

export function integerCommerceMinorUnits(
  value: unknown,
  currencyValue: unknown,
): CommerceMoney {
  let amountMinor: bigint
  if (typeof value === 'bigint') {
    amountMinor = value
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    amountMinor = BigInt(value)
  } else if (typeof value === 'string' && /^[+-]?[0-9]+$/.test(value.trim())) {
    amountMinor = BigInt(value.trim())
  } else {
    throw new CommerceNormalizationError(
      'COMMERCE_MINOR_MONEY_INVALID',
      'Minor-unit money must be an integer',
    )
  }
  if (amountMinor > MAX_MINOR_UNITS || amountMinor < -MAX_MINOR_UNITS) {
    throw new CommerceNormalizationError(
      'COMMERCE_MONEY_RANGE_INVALID',
      'Commerce money exceeds the supported minor-unit range',
    )
  }
  return Object.freeze({
    amountMinor,
    currency: normalizeCommerceCurrency(currencyValue),
  })
}

export function commerceMoneyFromDecimal(
  value: unknown,
  currency: unknown,
): CommerceMoney {
  const normalizedCurrency = normalizeCommerceCurrency(currency)
  return Object.freeze({
    amountMinor: decimalToCommerceMinorUnits(value, normalizedCurrency),
    currency: normalizedCurrency,
  })
}

export function availableCommerceField<T>(value: T): CommerceDataField<T> {
  return Object.freeze({ state: 'available', value })
}

export function unavailableCommerceField<T = never>(
  reason: Exclude<CommerceUnavailableReason, 'provider_redacted'> = 'not_provided',
): CommerceDataField<T> {
  return Object.freeze({ state: 'unavailable', value: null, reason })
}

export function redactedCommerceField<T = never>(
  reason: 'access_denied' | 'provider_redacted' = 'provider_redacted',
): CommerceDataField<T> {
  return Object.freeze({ state: 'redacted', value: null, reason })
}

export function asCommerceRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function commerceConnectionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asCommerceRecord(value)
  if (!record) return []
  if (Array.isArray(record.nodes)) return record.nodes
  if (Array.isArray(record.edges)) {
    return record.edges
      .map((edge) => asCommerceRecord(edge)?.node)
      .filter((node) => node !== null && node !== undefined)
  }
  return []
}

export function requiredCommerceText(
  value: unknown,
  label: string,
  maximum = 512,
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || value !== value.trim()
    || CONTROL_CHARACTER.test(value)
  ) {
    throw new CommerceNormalizationError(
      'COMMERCE_TEXT_INVALID',
      `Provider returned invalid ${label}`,
      label,
    )
  }
  return value
}

export function optionalCommerceText(
  value: unknown,
  maximum = 4_096,
): string | null {
  if (value === undefined || value === null || value === '') return null
  if (
    typeof value !== 'string'
    || value.length > maximum
    || CONTROL_CHARACTER.test(value)
  ) {
    return null
  }
  return value
}

export function optionalCommerceTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 64) return null
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString()
}

export function requiredCommerceTimestamp(
  value: unknown,
  label: string,
): string {
  const timestamp = optionalCommerceTimestamp(value)
  if (!timestamp) {
    throw new CommerceNormalizationError(
      'COMMERCE_TIMESTAMP_INVALID',
      `Provider returned invalid ${label}`,
      label,
    )
  }
  return timestamp
}

export function nonnegativeCommerceInteger(
  value: unknown,
  fallback: number | null = null,
): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback
}

export function positiveCommerceInteger(
  value: unknown,
  fallback: number | null = null,
): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback
}

function stableJson(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CommerceNormalizationError(
        'COMMERCE_SOURCE_INVALID',
        'Provider source contains a non-finite number',
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`)
  if (typeof value === 'undefined') return 'null'
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new CommerceNormalizationError(
        'COMMERCE_SOURCE_INVALID',
        'Provider source contains a cycle',
      )
    }
    seen.add(value)
    const result = `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    seen.delete(value)
    return result
  }
  const record = asCommerceRecord(value)
  if (!record) {
    throw new CommerceNormalizationError(
      'COMMERCE_SOURCE_INVALID',
      'Provider source contains an unsupported value',
    )
  }
  if (seen.has(record)) {
    throw new CommerceNormalizationError(
      'COMMERCE_SOURCE_INVALID',
      'Provider source contains a cycle',
    )
  }
  seen.add(record)
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
  seen.delete(record)
  return `{${entries.join(',')}}`
}

export function commerceSourceHash(value: unknown): string {
  return createHash('sha256')
    .update(stableJson(value, new Set()))
    .digest('hex')
}

export function createCommerceNormalizationRejection(input: Readonly<{
  resourceType: CommerceNormalizationRejectedResourceType
  source: unknown
  externalId?: unknown
  errorCode: CommerceNormalizationRejectionCode
}>): CommerceNormalizationRejection {
  const sourceHash = commerceSourceHash(input.source)
  const externalId = (
    typeof input.externalId === 'string'
    && input.externalId.length > 0
    && input.externalId.length <= 512
    && input.externalId === input.externalId.trim()
    && !CONTROL_CHARACTER.test(input.externalId)
  )
    ? input.externalId
    : `unidentified:${sourceHash}`
  return Object.freeze({
    resourceType: input.resourceType,
    externalId,
    sourceHash,
    errorCode: input.errorCode,
    safeMessage: COMMERCE_NORMALIZATION_REJECTION_MESSAGES[input.errorCode],
  })
}

export function assertCommerceOrderMoneyComplete(input: Readonly<{
  currency: string
  subtotal: CommerceDataField<CommerceMoneySet>
  shipping: CommerceDataField<CommerceMoneySet>
  tax: CommerceDataField<CommerceMoneySet>
  discount: CommerceDataField<CommerceMoneySet>
  total: CommerceDataField<CommerceMoneySet>
}>): void {
  const state = commerceOrderHeaderMoneyState(input)
  if (state.state !== 'complete') {
    throw new CommerceNormalizationError(
      'COMMERCE_ORDER_MONEY_INCOMPLETE',
      COMMERCE_NORMALIZATION_REJECTION_MESSAGES
        .COMMERCE_ORDER_MONEY_INCOMPLETE,
    )
  }
}

export function commerceOrderHeaderMoneyState(input: Readonly<{
  currency: string
  subtotal: CommerceDataField<CommerceMoneySet>
  shipping: CommerceDataField<CommerceMoneySet>
  tax: CommerceDataField<CommerceMoneySet>
  discount: CommerceDataField<CommerceMoneySet>
  total: CommerceDataField<CommerceMoneySet>
}>): CommerceOrderHeaderMoneyState {
  const currency = normalizeCommerceCurrency(input.currency)
  const requiredFields = [
    input.subtotal,
    input.discount,
    input.tax,
  ]
  if (requiredFields.some((field) => (
    field.state !== 'available'
    || field.value.primary.currency !== currency
  ))) {
    throw new CommerceNormalizationError(
      'COMMERCE_ORDER_MONEY_INCOMPLETE',
      COMMERCE_NORMALIZATION_REJECTION_MESSAGES
        .COMMERCE_ORDER_MONEY_INCOMPLETE,
    )
  }
  const unavailableFields: CommerceOrderHeaderMoneyField[] = []
  for (const [name, field] of [
    ['shipping', input.shipping],
    ['total', input.total],
  ] as const) {
    if (field.state !== 'available') {
      unavailableFields.push(name)
      continue
    }
    if (field.value.primary.currency !== currency) {
      throw new CommerceNormalizationError(
        'COMMERCE_ORDER_MONEY_INCOMPLETE',
        COMMERCE_NORMALIZATION_REJECTION_MESSAGES
          .COMMERCE_ORDER_MONEY_INCOMPLETE,
      )
    }
  }
  const complete = unavailableFields.length === 0
  return Object.freeze({
    state: complete ? 'complete' : 'operational_incomplete',
    unavailableFields: Object.freeze(unavailableFields),
    fulfillmentDemandEligible: true,
    accountingEligible: complete,
    customerChargeEligible: complete,
  })
}

export function createCommerceExternalIdentity(
  provider: CommerceNormalizationProvider,
  resourceType: CommerceExternalResourceType,
  value: string,
): CommerceExternalIdentity {
  return Object.freeze({ provider, resourceType, value })
}

export function commercePrimaryMoneySet(
  money: CommerceMoney,
): CommerceMoneySet {
  return Object.freeze({
    primary: money,
    shop: unavailableCommerceField('not_supported'),
    presentment: unavailableCommerceField('not_supported'),
  })
}

function availableText(value: unknown): CommerceDataField<string> {
  const text = optionalCommerceText(value, 512)
  return text === null
    ? unavailableCommerceField()
    : availableCommerceField(text)
}

export function commerceAddressFromRecord(
  recordValue: unknown,
  options: Readonly<{
    redacted?: boolean
    redactedFields?: ReadonlySet<string>
    aliases?: Partial<Record<
      keyof CommerceAddressSnapshot,
      readonly string[]
    >>
  }> = {},
): CommerceDataField<CommerceAddressSnapshot> {
  if (options.redacted) return redactedCommerceField()
  const record = asCommerceRecord(recordValue)
  if (!record) return unavailableCommerceField()
  const aliases: Record<keyof CommerceAddressSnapshot, readonly string[]> = {
    name: ['name'],
    organizationName: ['company', 'organization_name'],
    line1: ['address1', 'line1'],
    line2: ['address2', 'line2'],
    city: ['city'],
    region: ['province', 'state', 'region'],
    regionCode: ['provinceCode', 'state_code', 'region_code'],
    postalCode: ['zip', 'postal_code', 'postalCode'],
    country: ['country'],
    countryCode: ['countryCodeV2', 'country_code', 'countryCode'],
    phone: ['phone', 'phone_number'],
    ...options.aliases,
  }
  const field = (key: keyof CommerceAddressSnapshot) => {
    const keys = aliases[key]
    if (options.redactedFields?.has(key)) return redactedCommerceField<string>()
    for (const sourceKey of keys) {
      if (Object.prototype.hasOwnProperty.call(record, sourceKey)) {
        return availableText(record[sourceKey])
      }
    }
    return unavailableCommerceField<string>()
  }
  return availableCommerceField(Object.freeze({
    name: field('name'),
    organizationName: field('organizationName'),
    line1: field('line1'),
    line2: field('line2'),
    city: field('city'),
    region: field('region'),
    regionCode: field('regionCode'),
    postalCode: field('postalCode'),
    country: field('country'),
    countryCode: field('countryCode'),
    phone: field('phone'),
  }))
}

export function commerceAddressIsComplete(
  field: CommerceDataField<CommerceAddressSnapshot>,
): boolean {
  if (field.state !== 'available') return false
  const address = field.value
  return (
    address.line1.state === 'available'
    && address.city.state === 'available'
    && address.postalCode.state === 'available'
    && (
      address.countryCode.state === 'available'
      || address.country.state === 'available'
    )
  )
}

export function commercePackagingFromRecord(
  value: unknown,
  source: CommercePackagingSnapshot['source'],
): CommerceDataField<CommercePackagingSnapshot> {
  const record = asCommerceRecord(value)
  if (!record) return unavailableCommerceField()
  const dimensions = asCommerceRecord(record.dimensionsMm)
    || asCommerceRecord(record.dimensions_mm)
    || record
  const weightGrams = positiveCommerceInteger(
    record.weightGrams ?? record.weight_grams,
  )
  const lengthMillimeters = positiveCommerceInteger(
    dimensions.length ?? dimensions.lengthMillimeters
      ?? dimensions.length_millimeters,
  )
  const widthMillimeters = positiveCommerceInteger(
    dimensions.width ?? dimensions.widthMillimeters
      ?? dimensions.width_millimeters,
  )
  const heightMillimeters = positiveCommerceInteger(
    dimensions.height ?? dimensions.heightMillimeters
      ?? dimensions.height_millimeters,
  )
  if (
    weightGrams === null
    || lengthMillimeters === null
    || widthMillimeters === null
    || heightMillimeters === null
  ) {
    return unavailableCommerceField()
  }
  return availableCommerceField(Object.freeze({
    weightGrams,
    lengthMillimeters,
    widthMillimeters,
    heightMillimeters,
    source,
  }))
}

function fact(
  dimension: CommerceReadinessDimension,
  code: CommerceReadinessCode,
  blocking: boolean,
  subjectExternalId: string | null = null,
): CommerceReadinessFact {
  return Object.freeze({
    dimension,
    code,
    blocking,
    subjectExternalId,
  })
}

export function buildCommerceReadinessFacts(input: Readonly<{
  canonicalStates: CommerceCanonicalStates
  lines: readonly CommerceNormalizedOrderLine[]
  party: CommerceDataField<CommercePartySnapshot>
  shipTo: CommerceDataField<CommerceAddressSnapshot>
  requestedDeliveryAt: CommerceDataField<string>
  lineItemsTruncated: boolean
  sourceStale: boolean
  ambiguousSkus: ReadonlySet<string>
}>): readonly CommerceReadinessFact[] {
  const facts: CommerceReadinessFact[] = []
  for (const line of input.lines) {
    const subject = line.identity.value
    if (
      line.productIdentity.state !== 'available'
      || line.variantIdentity.state !== 'available'
    ) {
      facts.push(fact('product', 'product_identity_missing', true, subject))
    } else {
      facts.push(fact('product', 'product_mapping_required', true, subject))
    }
    if (!line.sku) {
      facts.push(fact('product', 'product_sku_missing', false, subject))
    } else if (input.ambiguousSkus.has(line.sku)) {
      facts.push(fact('product', 'product_sku_ambiguous', true, subject))
    }
    facts.push(line.packaging.state === 'available'
      ? fact('packaging', 'packaging_available', false, subject)
      : fact('packaging', 'packaging_required', true, subject))
  }

  const partyContainsRedaction = input.party.state === 'available' && [
    input.party.value.externalIdentity,
    input.party.value.organizationName,
    input.party.value.contactName,
    input.party.value.email,
    input.party.value.phone,
  ].some((field) => field.state === 'redacted')
  if (input.party.state === 'redacted' || partyContainsRedaction) {
    facts.push(fact('customer', 'customer_redacted', true))
  } else if (input.party.state === 'unavailable') {
    facts.push(fact('customer', 'customer_unavailable', true))
  } else {
    facts.push(fact('customer', 'customer_resolution_required', true))
  }

  const shipToContainsRedaction = input.shipTo.state === 'available' && (
    Object.values(input.shipTo.value)
      .some((field) => field.state === 'redacted')
  )
  if (input.shipTo.state === 'redacted' || shipToContainsRedaction) {
    facts.push(fact('ship_to', 'ship_to_redacted', true))
  } else if (input.shipTo.state === 'unavailable') {
    facts.push(fact('ship_to', 'ship_to_unavailable', true))
  } else if (!commerceAddressIsComplete(input.shipTo)) {
    facts.push(fact('ship_to', 'ship_to_incomplete', true))
  } else {
    facts.push(fact('ship_to', 'ship_to_available', false))
  }

  facts.push(input.requestedDeliveryAt.state === 'available'
    ? fact('delivery', 'delivery_available', false)
    : fact('delivery', 'delivery_decision_required', true))
  facts.push(input.canonicalStates.lifecycle === 'cancelled'
    ? fact('cancelled', 'order_cancelled', true)
    : input.canonicalStates.lifecycle === 'unknown'
      ? fact('cancelled', 'order_cancellation_state_unknown', true)
      : fact('cancelled', 'order_not_cancelled', false))
  facts.push(input.canonicalStates.fulfillment === 'fulfilled'
    ? fact('fulfilled', 'order_already_fulfilled', true)
    : input.canonicalStates.fulfillment === 'unknown'
      ? fact('fulfilled', 'order_fulfillment_state_unknown', true)
      : fact('fulfilled', 'order_not_fulfilled', false))
  facts.push(input.lineItemsTruncated
    ? fact('truncated', 'source_truncated', true)
    : fact('truncated', 'source_complete', false))
  facts.push(input.sourceStale
    ? fact('stale', 'source_stale', true)
    : fact('stale', 'source_current', false))
  return Object.freeze(facts)
}

export function validateCommerceNormalizationContext(
  context: CommerceNormalizationContext,
): void {
  requiredCommerceText(context.organizationId, 'organization identity')
  requiredCommerceText(context.integrationAccountId, 'integration account identity')
  requiredCommerceText(context.externalAccountId, 'external account identity')
  requiredCommerceText(context.apiVersion, 'provider API version')
  requiredCommerceTimestamp(context.observedAt, 'observation timestamp')
  requiredCommerceTimestamp(context.retentionExpiresAt, 'retention expiry')
  if (
    !Number.isSafeInteger(context.credentialGeneration)
    || context.credentialGeneration < 1
  ) {
    throw new CommerceNormalizationError(
      'COMMERCE_CREDENTIAL_GENERATION_INVALID',
      'Commerce normalization requires a positive credential generation',
    )
  }
}

export function freezeCommerceEnvelope(
  envelope: CommerceNormalizationEnvelope,
): CommerceNormalizationEnvelope {
  return Object.freeze(envelope)
}
