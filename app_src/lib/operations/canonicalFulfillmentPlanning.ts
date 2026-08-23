// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentionally used for Node tests.
import { isIso4217CurrencyCode } from '../currency.ts'

export const CANONICAL_FULFILLMENT_RATE_POLICY_VERSION =
  'canonical-fulfillment-whole-shipment-rate-v3' as const

export const CANONICAL_FULFILLMENT_RATE_OBJECTIVE_SEQUENCE = [
  'whole_shipment_delivery_feasible',
  'lowest_carrier_cost_minor',
  'fewest_transit_days',
  'stable_provider_id',
  'stable_carrier_account_id',
  'stable_service_id',
] as const

export const CANONICAL_CUSTOMER_PAID_VARIANCE_FORMULA =
  'actual_checkout_shipping_charge_minor_minus_selected_carrier_cost_minor' as const

const MAX_MINOR = 1_000_000_000_000
const MAX_PACKAGES = 50
const MAX_OFFERS = 100
const HASH = /^[a-f0-9]{64}$/
const PACKAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,127}$/
const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:#-]{0,127}$/
const RATE_EVIDENCE_GLOBAL_ID = /^grq(?:[0-9]{7}|[0-9a-v]{12})$/
const CARRIER_ACCOUNT_GLOBAL_ID = /^gac(?:[0-9]{7}|[0-9a-v]{12})$/
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

export type CanonicalFulfillmentCarrierProvider =
  | 'ups_rest'
  | 'fedex_rest'

export type CanonicalWholeShipmentRateOffer = Readonly<{
  evidenceState: 'sealed'
  rateScope: 'multi_package_shipment'
  rateEvidenceGlobalId: string
  packagePlanHash: string
  packageCount: number
  packageKeys: readonly string[]
  carrierAccountGlobalId: string
  provider: CanonicalFulfillmentCarrierProvider
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  currency: string
  transitDays: number | null
  estimatedDeliveryAt: string | null
}>

export type CanonicalFulfillmentPlanningInput = Readonly<{
  packagePlanHash: string
  packageCount: number
  packageKeys: readonly string[]
  expectedCurrency: string
  requestedDeliveryAt: string | null
  actualCheckoutShippingChargeMinor: number | null
  offers: readonly CanonicalWholeShipmentRateOffer[]
}>

export type CanonicalFulfillmentRatePolicyMetadata = Readonly<{
  version: typeof CANONICAL_FULFILLMENT_RATE_POLICY_VERSION
  selectionUnit: 'whole_shipment'
  packageServiceSplitAllowed: false
  objectiveSequence:
    typeof CANONICAL_FULFILLMENT_RATE_OBJECTIVE_SEQUENCE
  customerPaidVarianceFormula:
    typeof CANONICAL_CUSTOMER_PAID_VARIANCE_FORMULA
  expectedCurrency: string
  packagePlanHash: string
  packageCount: number
  requestedDeliveryAt: string | null
  evaluatedOfferCount: number
  feasibleOfferCount: number
  rejectedForPromiseCount: number
}>

export type CanonicalFulfillmentRateSelection = Readonly<{
  rateScope: 'multi_package_shipment'
  packagePlanHash: string
  packageCount: number
  packageKeys: readonly string[]
  rateEvidenceGlobalId: string
  carrierAccountGlobalId: string
  carrierProvider: CanonicalFulfillmentCarrierProvider
  carrierName: 'UPS' | 'FedEx'
  serviceCode: string
  serviceName: string
  carrierCostMinor: number
  currency: string
  transitDays: number | null
  estimatedDeliveryAt: string | null
  requestedDeliveryAt: string | null
  meetsRequestedDelivery: true
  actualCheckoutShippingChargeMinor: number | null
  customerPaidVarianceMinor: number | null
  policy: CanonicalFulfillmentRatePolicyMetadata
}>

export class CanonicalFulfillmentPlanningError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CanonicalFulfillmentPlanningError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new CanonicalFulfillmentPlanningError(code, message)
}

function exactNonnegativeMinor(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 0
    || Number(value) > MAX_MINOR
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_MONEY_INVALID',
      `${label} must use exact nonnegative minor units`,
    )
  }
  return Number(value)
}

function record(value: unknown): Record<string, unknown> {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : {}
}

/**
 * Reads the checkout shipping charge only when commerce intake explicitly
 * authorized that header-money field for customer-charge use. An absent,
 * blocked, or malformed value remains unknown; it must never be converted to
 * a real zero-dollar charge.
 */
export function authorizedCheckoutShippingChargeMinor(
  sourcePayload: unknown,
): number | null {
  const payload = record(sourcePayload)
  const headerMoney = record(payload.headerMoney)
  if (headerMoney.customerChargeUse !== 'eligible') return null

  const amounts = record(payload.amountsMinor)
  if (
    amounts.shipping === null
    || amounts.shipping === undefined
    || amounts.shipping === ''
  ) return null
  const amount = Number(amounts.shipping)
  return (
    Number.isSafeInteger(amount)
    && amount >= 0
    && amount <= MAX_MINOR
  )
    ? amount
    : null
}

function exactPackageCount(value: unknown): number {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < 1
    || Number(value) > MAX_PACKAGES
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PACKAGE_COUNT_INVALID',
      `Canonical fulfillment requires between 1 and ${MAX_PACKAGES} packages`,
    )
  }
  return Number(value)
}

function currency(value: unknown, label: string): string {
  const normalized = String(value ?? '').trim().toUpperCase()
  if (!isIso4217CurrencyCode(normalized)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_CURRENCY_INVALID',
      `${label} requires an ISO 4217 currency`,
    )
  }
  return normalized
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_TIMESTAMP_INVALID',
      `${label} must be an ISO 8601 timestamp with an explicit timezone`,
    )
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_TIMESTAMP_INVALID',
      `${label} is not a real timestamp`,
    )
  }
  return parsed.toISOString()
}

function packageKeys(
  value: unknown,
  expectedCount: number,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
      `${label} must cover the complete canonical package array`,
    )
  }
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (
      typeof candidate !== 'string'
      || !PACKAGE_KEY.test(candidate)
      || seen.has(candidate)
    ) {
      fail(
        'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
        `${label} contains an invalid or duplicate package key`,
      )
    }
    seen.add(candidate)
    return candidate
  })
}

function sameOrderedPackages(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length
    && left.every((packageKey, index) => packageKey === right[index])
  )
}

type NormalizedWholeShipmentRateOffer =
  Omit<CanonicalWholeShipmentRateOffer, 'packageKeys'> & {
    packageKeys: string[]
  }

function normalizeOffer(
  offer: CanonicalWholeShipmentRateOffer,
  expected: {
    packagePlanHash: string
    packageCount: number
    packageKeys: readonly string[]
    currency: string
  },
): NormalizedWholeShipmentRateOffer {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_OFFER_INVALID',
      'Every canonical carrier offer must be an object',
    )
  }
  if (
    offer.evidenceState !== 'sealed'
    || offer.rateScope !== 'multi_package_shipment'
    || !RATE_EVIDENCE_GLOBAL_ID.test(offer.rateEvidenceGlobalId)
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_EVIDENCE_INVALID',
      'Canonical selection requires sealed whole-shipment rate evidence',
    )
  }
  if (
    offer.provider !== 'ups_rest'
    && offer.provider !== 'fedex_rest'
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PROVIDER_INVALID',
      'Canonical selection supports configured UPS and FedEx offers',
    )
  }
  if (!CARRIER_ACCOUNT_GLOBAL_ID.test(offer.carrierAccountGlobalId)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_ACCOUNT_INVALID',
      'Canonical selection requires an exact configured carrier account',
    )
  }
  if (
    typeof offer.serviceCode !== 'string'
    || !SERVICE_CODE.test(offer.serviceCode)
    || typeof offer.serviceName !== 'string'
    || !offer.serviceName.trim()
    || offer.serviceName.trim().length > 255
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_SERVICE_INVALID',
      'Carrier offers require stable service codes and names',
    )
  }
  if (
    typeof offer.packagePlanHash !== 'string'
    || offer.packagePlanHash !== expected.packagePlanHash
    || offer.packageCount !== expected.packageCount
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
      'Carrier offer does not match the sealed canonical package plan',
    )
  }
  const offerPackageKeys = packageKeys(
    offer.packageKeys,
    expected.packageCount,
    'Carrier offer',
  )
  if (!sameOrderedPackages(offerPackageKeys, expected.packageKeys)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
      'Carrier offer does not cover the exact ordered package array',
    )
  }
  const offerCurrency = currency(offer.currency, 'Carrier offer')
  if (offerCurrency !== expected.currency) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_CURRENCY_MISMATCH',
      'Carrier offer currency does not match the canonical order currency',
    )
  }
  const transitUnknown = offer.transitDays === null
  const deliveryUnknown = offer.estimatedDeliveryAt === null
  if (transitUnknown !== deliveryUnknown) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_TRANSIT_INVALID',
      'Carrier transit days and estimated delivery must both be known or both be unavailable',
    )
  }
  if (
    !transitUnknown
    && (
      !Number.isSafeInteger(offer.transitDays)
      || Number(offer.transitDays) < 0
      || Number(offer.transitDays) > 365
    )
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_TRANSIT_INVALID',
      'Carrier transit days must be an exact value from 0 through 365',
    )
  }
  return {
    ...offer,
    serviceCode: offer.serviceCode.toLowerCase(),
    serviceName: offer.serviceName.trim(),
    carrierCostMinor: exactNonnegativeMinor(
      offer.carrierCostMinor,
      'Carrier cost',
    ),
    currency: offerCurrency,
    packageKeys: offerPackageKeys,
    transitDays: transitUnknown ? null : Number(offer.transitDays),
    estimatedDeliveryAt: deliveryUnknown
      ? null
      : timestamp(offer.estimatedDeliveryAt, 'Estimated delivery'),
  }
}

/**
 * Selects one promise-feasible carrier service for every package in the
 * sealed canonical cartonization plan. It never combines package-level
 * services. Positive customer-paid variance means checkout shipping revenue
 * exceeds the selected pre-label carrier estimate; it is not carrier-billed
 * actual cost or a markup directive.
 */
export function selectCanonicalFulfillmentRate(
  input: CanonicalFulfillmentPlanningInput,
): CanonicalFulfillmentRateSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_INPUT_INVALID',
      'Canonical fulfillment rate input must be an object',
    )
  }
  if (
    typeof input.packagePlanHash !== 'string'
    || !HASH.test(input.packagePlanHash)
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PACKAGE_PLAN_INVALID',
      'Canonical fulfillment requires a sealed package-plan hash',
    )
  }
  const expectedPackageCount = exactPackageCount(input.packageCount)
  const expectedPackageKeys = packageKeys(
    input.packageKeys,
    expectedPackageCount,
    'Canonical package plan',
  )
  const expectedCurrency = currency(
    input.expectedCurrency,
    'Canonical order',
  )
  const requestedDeliveryAt = input.requestedDeliveryAt === null
    ? null
    : timestamp(input.requestedDeliveryAt, 'Requested delivery')
  const actualCheckoutShippingChargeMinor =
    input.actualCheckoutShippingChargeMinor === null
      ? null
      : exactNonnegativeMinor(
          input.actualCheckoutShippingChargeMinor,
          'Actual checkout shipping charge',
        )
  if (
    !Array.isArray(input.offers)
    || input.offers.length < 1
    || input.offers.length > MAX_OFFERS
  ) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_OFFERS_INVALID',
      `Canonical fulfillment requires between 1 and ${MAX_OFFERS} carrier offers`,
    )
  }

  const services = new Set<string>()
  const normalizedOffers = input.offers.map((offer) => {
    const normalized = normalizeOffer(offer, {
      packagePlanHash: input.packagePlanHash,
      packageCount: expectedPackageCount,
      packageKeys: expectedPackageKeys,
      currency: expectedCurrency,
    })
    const serviceKey = [
      normalized.carrierAccountGlobalId,
      normalized.provider,
      normalized.serviceCode,
    ].join(':')
    if (services.has(serviceKey)) {
      fail(
        'CANONICAL_FULFILLMENT_RATE_SERVICE_DUPLICATE',
        'Canonical carrier offers cannot repeat an account service',
      )
    }
    services.add(serviceKey)
    return normalized
  })

  const requestedDeliveryMs = requestedDeliveryAt === null
    ? null
    : new Date(requestedDeliveryAt).getTime()
  const feasibleOffers = normalizedOffers
    .filter((offer) => (
      requestedDeliveryMs === null
      || (
        offer.estimatedDeliveryAt !== null
        && new Date(offer.estimatedDeliveryAt).getTime()
          <= requestedDeliveryMs
      )
    ))
    .sort((left, right) => (
      left.carrierCostMinor - right.carrierCostMinor
      || (left.transitDays ?? 366) - (right.transitDays ?? 366)
      || left.provider.localeCompare(right.provider)
      || left.carrierAccountGlobalId.localeCompare(
        right.carrierAccountGlobalId,
      )
      || left.serviceCode.localeCompare(right.serviceCode)
    ))
  const selected = feasibleOffers[0]
  if (!selected) {
    fail(
      'CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
      'No whole-shipment UPS or FedEx service meets the requested delivery timestamp',
    )
  }

  return {
    rateScope: 'multi_package_shipment',
    packagePlanHash: input.packagePlanHash,
    packageCount: expectedPackageCount,
    packageKeys: [...expectedPackageKeys],
    rateEvidenceGlobalId: selected.rateEvidenceGlobalId,
    carrierAccountGlobalId: selected.carrierAccountGlobalId,
    carrierProvider: selected.provider,
    carrierName: selected.provider === 'ups_rest' ? 'UPS' : 'FedEx',
    serviceCode: selected.serviceCode,
    serviceName: selected.serviceName,
    carrierCostMinor: selected.carrierCostMinor,
    currency: expectedCurrency,
    transitDays: selected.transitDays,
    estimatedDeliveryAt: selected.estimatedDeliveryAt,
    requestedDeliveryAt,
    meetsRequestedDelivery: true,
    actualCheckoutShippingChargeMinor,
    customerPaidVarianceMinor: actualCheckoutShippingChargeMinor === null
      ? null
      : actualCheckoutShippingChargeMinor - selected.carrierCostMinor,
    policy: {
      version: CANONICAL_FULFILLMENT_RATE_POLICY_VERSION,
      selectionUnit: 'whole_shipment',
      packageServiceSplitAllowed: false,
      objectiveSequence:
        CANONICAL_FULFILLMENT_RATE_OBJECTIVE_SEQUENCE,
      customerPaidVarianceFormula:
        CANONICAL_CUSTOMER_PAID_VARIANCE_FORMULA,
      expectedCurrency,
      packagePlanHash: input.packagePlanHash,
      packageCount: expectedPackageCount,
      requestedDeliveryAt,
      evaluatedOfferCount: normalizedOffers.length,
      feasibleOfferCount: feasibleOffers.length,
      rejectedForPromiseCount:
        normalizedOffers.length - feasibleOffers.length,
    },
  }
}
