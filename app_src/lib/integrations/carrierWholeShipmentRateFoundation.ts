import { createHash } from 'node:crypto'

/**
 * Pure, read-only foundation for a whole-shipment carrier rate request.
 *
 * This module deliberately has no HTTP client, credential acquisition, or
 * shipment mutation surface. A future executor must supply authorization and
 * perform the network call, then pass the recorded response back to the pure
 * parser below. Keeping that boundary explicit prevents a rate-only adapter
 * from acquiring shipping, cancellation, or other provider-write behavior.
 */

export type CarrierWholeShipmentRateProvider = 'ups_rest' | 'fedex_rest'
export type CarrierWholeShipmentRateEnvironment = 'sandbox' | 'production'
export type CarrierWholeShipmentRateBillingRelationship =
  | 'sender'
  | 'recipient'
  | 'third_party'
export type CarrierWholeShipmentFedexPickupType =
  | 'DROPOFF_AT_FEDEX_LOCATION'
  | 'CONTACT_FEDEX_TO_SCHEDULE'
  | 'USE_SCHEDULED_PICKUP'

export const UPS_WHOLE_SHIPMENT_PACKAGING_TYPES = Object.freeze({
  '01': 'Letter',
  '02': 'Customer supplied package',
  '03': 'Tube',
  '04': 'PAK',
  '21': 'Express box',
  '24': '25KG box',
  '25': '10KG box',
  '2a': 'Small express box',
  '2b': 'Medium express box',
  '2c': 'Large express box',
} as const)
export const FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES = Object.freeze({
  YOUR_PACKAGING: 'Your packaging',
  FEDEX_ENVELOPE: 'Envelope',
  FEDEX_BOX: 'Box',
  FEDEX_EXTRA_SMALL_BOX: 'Extra small box',
  FEDEX_SMALL_BOX: 'Small box',
  FEDEX_MEDIUM_BOX: 'Medium box',
  FEDEX_LARGE_BOX: 'Large box',
  FEDEX_EXTRA_LARGE_BOX: 'Extra large box',
  FEDEX_10KG_BOX: '10KG box',
  FEDEX_25KG_BOX: '25KG box',
  FEDEX_PAK: 'PAK',
  FEDEX_TUBE: 'Tube',
} as const)

export type CarrierWholeShipmentRateParty = {
  name: string
  phone: string | null
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: 'US'
  residential: boolean | null
}

export type CarrierWholeShipmentRateDestination = {
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  region: string | null
  postalCode: string
  countryCode: 'US'
  residential: boolean | null
}

export type CarrierWholeShipmentRateParcel = {
  description: string
  packageCode?: string
  length: number
  width: number
  height: number
  dimensionUnit: 'IN'
  weight: number
  weightUnit: 'LB'
}
type NormalizedCarrierWholeShipmentRateParcel = Omit<
  CarrierWholeShipmentRateParcel,
  'packageCode'
> & { packageCode: string }

export type CarrierWholeShipmentRateBindingInput = {
  organizationId: string
  carrierAccountId: string
  integrationAccountId: string
  credentialRevision: number
  credentialFingerprint: string
  accountNumber: string
  accountNumberFingerprint: string
  provider: CarrierWholeShipmentRateProvider
  environment: CarrierWholeShipmentRateEnvironment
}

export type CarrierWholeShipmentRateBillingInput = {
  relationship: CarrierWholeShipmentRateBillingRelationship
  payerAccountNumber: string
  payerAccountNumberFingerprint: string
  payerPostalCode: string
  payerCountryCode: 'US'
}

export type CarrierWholeShipmentRateRequestInput = {
  binding: CarrierWholeShipmentRateBindingInput
  origin: CarrierWholeShipmentRateParty
  destination: CarrierWholeShipmentRateDestination
  parcels: CarrierWholeShipmentRateParcel[]
  billing: CarrierWholeShipmentRateBillingInput
  expectedCurrency: 'USD'
  fedexPickupType: CarrierWholeShipmentFedexPickupType | null
}

export type CarrierWholeShipmentRate = {
  serviceCode: string
  serviceName: string
  amount: string
  currency: string
  rateType: string | null
  transitDays: number | null
  deliveryDate: string | null
}

export type CarrierWholeShipmentRateSafeBinding = {
  organizationId: string
  carrierAccountId: string
  integrationAccountId: string
  credentialRevision: number
  credentialFingerprint: string
  accountNumberFingerprint: string
}

export type CarrierWholeShipmentRateSafeBilling = {
  relationship: CarrierWholeShipmentRateBillingRelationship
  providerMapping: 'ups_payment_details' | 'fedex_rate_account_number'
  payerAccountNumberFingerprint: string
  payerPostalCode: string
  payerCountryCode: 'US'
}

export type CarrierWholeShipmentRateRequestEvidence = {
  adapterVersion: 'carrier-whole-shipment-rate-v1'
  accessMode: 'rate_read_only'
  providerMutationCount: 0
  provider: CarrierWholeShipmentRateProvider
  environment: CarrierWholeShipmentRateEnvironment
  endpoint: string
  endpointVersion: string
  purpose: 'fulfillment_execution'
  rateScope: 'multi_package_shipment'
  expectedCurrency: 'USD'
  packageCount: number
  binding: CarrierWholeShipmentRateSafeBinding
  billing: CarrierWholeShipmentRateSafeBilling
  shipment: {
    originFingerprint: string
    destinationFingerprint: string
    origin: {
      region: string
      countryCode: 'US'
      residential: boolean | null
    }
    destination: {
      region: string | null
      countryCode: 'US'
      residential: boolean | null
    }
    fedexPickupType: CarrierWholeShipmentFedexPickupType | null
    parcels: NormalizedCarrierWholeShipmentRateParcel[]
  }
}

export type PreparedCarrierWholeShipmentRateRequest = {
  adapterVersion: 'carrier-whole-shipment-rate-v1'
  accessMode: 'rate_read_only'
  providerMutationCount: 0
  provider: CarrierWholeShipmentRateProvider
  environment: CarrierWholeShipmentRateEnvironment
  endpoint: string
  endpointVersion: string
  method: 'POST'
  headers: Record<string, string>
  body: Record<string, unknown>
  requestHash: string
  redactedRequest: CarrierWholeShipmentRateRequestEvidence
}

/**
 * Persistence-safe proof that a prepared request passed the foundation's
 * complete, auth-free request-integrity check. The provider body can contain
 * account numbers, so callers must persist this seal rather than the prepared
 * request itself.
 */
export type SealedCarrierWholeShipmentRateRequest = {
  adapterVersion: 'carrier-whole-shipment-rate-v1'
  accessMode: 'rate_read_only'
  providerMutationCount: 0
  provider: CarrierWholeShipmentRateProvider
  environment: CarrierWholeShipmentRateEnvironment
  endpoint: string
  endpointVersion: string
  requestHash: string
  redactedRequest: CarrierWholeShipmentRateRequestEvidence
}

export type CarrierWholeShipmentRateAddressFingerprints = {
  originFingerprint: string
  destinationFingerprint: string
}

export type CarrierWholeShipmentRateExpectedRequestBinding = {
  origin: CarrierWholeShipmentRateParty
  destination: CarrierWholeShipmentRateDestination
  matchesAccountNumber: (accountNumber: string) => boolean
}

export type CarrierWholeShipmentRateResponseInput = {
  payload: unknown
  requestedAt: string
  completedAt: string
  providerReference?: string | null
}

export type CarrierWholeShipmentRateResponseEvidence = {
  requestHash: string
  providerPayloadHash: string
  redactedRequest: CarrierWholeShipmentRateRequestEvidence
  redactedResponse: {
    adapterVersion: 'carrier-whole-shipment-rate-v1'
    accessMode: 'rate_read_only'
    providerMutationCount: 0
    provider: CarrierWholeShipmentRateProvider
    environment: CarrierWholeShipmentRateEnvironment
    endpoint: string
    endpointVersion: string
    purpose: 'fulfillment_execution'
    rateScope: 'multi_package_shipment'
    expectedCurrency: 'USD'
    packageCount: number
    rateCount: number
    rates: CarrierWholeShipmentRate[]
  }
  providerReference: string | null
  requestedAt: string
  completedAt: string
}

export type ParsedCarrierWholeShipmentRateResponse = {
  provider: CarrierWholeShipmentRateProvider
  environment: CarrierWholeShipmentRateEnvironment
  purpose: 'fulfillment_execution'
  rateScope: 'multi_package_shipment'
  expectedCurrency: 'USD'
  packageCount: number
  rates: CarrierWholeShipmentRate[]
  evidence: CarrierWholeShipmentRateResponseEvidence
}

export const MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES = 50

export const CARRIER_WHOLE_SHIPMENT_RATE_ENDPOINTS = {
  ups_rest: {
    sandbox: 'https://wwwcie.ups.com/api/rating/v2409/Shop',
    production: 'https://onlinetools.ups.com/api/rating/v2409/Shop',
  },
  fedex_rest: {
    sandbox: 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes',
    production: 'https://apis.fedex.com/rate/v1/rates/quotes',
  },
} as const

const ENDPOINT_VERSIONS: Record<CarrierWholeShipmentRateProvider, string> = {
  ups_rest: 'ups-rating-v2409',
  fedex_rest: 'fedex-rate-v1',
}

const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '59': 'UPS 2nd Day Air A.M.',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const EXACT_RATE_AMOUNT = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const FEDEX_PICKUP_TYPES = new Set<CarrierWholeShipmentFedexPickupType>([
  'DROPOFF_AT_FEDEX_LOCATION',
  'CONTACT_FEDEX_TO_SCHEDULE',
  'USE_SCHEDULED_PICKUP',
])

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value]
}

function text(value: unknown) {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : ''
}

function plainText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be plain text`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters`)
  }
  return normalized
}

function optionalPlainText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be plain text`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  if (normalized.length > maximum) {
    throw new Error(`${label} must be ${maximum} characters or fewer`)
  }
  return normalized
}

function canonicalUuid(value: unknown, label: string) {
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw new Error(`${label} must be a canonical UUID`)
  }
  return value.trim().toLowerCase()
}

function canonicalFingerprint(value: unknown, label: string) {
  if (typeof value !== 'string' || !SHA256.test(value.trim())) {
    throw new Error(`${label} must be a SHA-256 fingerprint`)
  }
  return value.trim().toLowerCase()
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function nullableBooleanValue(value: unknown, label: string) {
  return value === null ? null : booleanValue(value, label)
}

function usPhone(value: unknown, label: string) {
  const phone = plainText(value, label, 24)
  if (!/^\+?[0-9() .-]+$/.test(phone)) {
    throw new Error(`${label} must contain only phone-number characters`)
  }
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (!/^\d{10}$/.test(digits)) {
    throw new Error(`${label} must be a ten-digit US phone number`)
  }
  return digits
}

function nullableUsPhone(value: unknown, label: string) {
  return value === null ? null : usPhone(value, label)
}

function expectedCurrency(value: unknown): 'USD' {
  if (value !== 'USD') {
    throw new Error('Whole-shipment carrier rating currently requires USD currency')
  }
  return 'USD'
}

function fedexPickupType(
  provider: CarrierWholeShipmentRateProvider,
  value: unknown,
): CarrierWholeShipmentFedexPickupType | null {
  if (provider === 'ups_rest') {
    if (value !== null) {
      throw new Error('FedEx pickup type must be null for UPS rating')
    }
    return null
  }
  if (!FEDEX_PICKUP_TYPES.has(value as CarrierWholeShipmentFedexPickupType)) {
    throw new Error('FedEx pickup type must be explicitly configured')
  }
  return value as CarrierWholeShipmentFedexPickupType
}

function positiveDecimal(value: unknown, label: string, maximum: number) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || value > maximum
  ) {
    throw new Error(`${label} must be a positive number no greater than ${maximum}`)
  }
  const canonical = Math.round(value * 1_000) / 1_000
  if (Math.abs(value - canonical) > Number.EPSILON * Math.max(1, value) * 8) {
    throw new Error(`${label} supports at most three decimal places`)
  }
  return canonical
}

function usPostalCode(value: unknown, label: string) {
  const postalCode = plainText(value, label, 10)
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new Error(`${label} must be a five or nine digit US ZIP code`)
  }
  return postalCode
}

function usCountry(value: unknown, label: string): 'US' {
  const countryCode = plainText(value, label, 2).toUpperCase()
  if (countryCode !== 'US') {
    throw new Error('Whole-shipment carrier rating currently supports US addresses only')
  }
  return 'US'
}

function usRegion(value: unknown, label: string) {
  const region = plainText(value, label, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(region)) {
    throw new Error(`${label} must be a two-letter US region code`)
  }
  return region
}

function normalizeParty(value: unknown): CarrierWholeShipmentRateParty {
  const input = record(value)
  return {
    name: plainText(input.name, 'Origin name', 120),
    phone: nullableUsPhone(input.phone, 'Origin phone'),
    line1: plainText(input.line1, 'Origin address line 1', 160),
    line2: optionalPlainText(input.line2, 'Origin address line 2', 120),
    city: plainText(input.city, 'Origin city', 100),
    region: usRegion(input.region, 'Origin region'),
    postalCode: usPostalCode(input.postalCode, 'Origin postal code'),
    countryCode: usCountry(input.countryCode, 'Origin country code'),
    residential: nullableBooleanValue(
      input.residential,
      'Origin residential classification',
    ),
  }
}

function normalizeDestination(
  value: unknown,
): CarrierWholeShipmentRateDestination {
  const input = record(value)
  const line1 = optionalPlainText(
    input.line1,
    'Destination address line 1',
    160,
  )
  const line2 = optionalPlainText(
    input.line2,
    'Destination address line 2',
    120,
  )
  if (line2 && !line1) {
    throw new Error('Destination address line 2 requires address line 1')
  }
  const regionValue = optionalPlainText(input.region, 'Destination region', 2)
  return {
    name: optionalPlainText(input.name, 'Destination name', 120),
    line1,
    line2,
    city: optionalPlainText(input.city, 'Destination city', 100),
    region: regionValue ? usRegion(regionValue, 'Destination region') : null,
    postalCode: usPostalCode(input.postalCode, 'Destination postal code'),
    countryCode: usCountry(input.countryCode, 'Destination country code'),
    residential: nullableBooleanValue(
      input.residential,
      'Destination residential classification',
    ),
  }
}

export function carrierWholeShipmentRateAddressFingerprints(input: {
  origin: CarrierWholeShipmentRateParty
  destination: CarrierWholeShipmentRateDestination
}): CarrierWholeShipmentRateAddressFingerprints {
  const origin = normalizeParty(input.origin)
  return deepFreeze({
    originFingerprint: hash({ version: 'carrier-rate-origin-v1', origin }),
    destinationFingerprint: carrierWholeShipmentRateDestinationFingerprint(
      input.destination,
    ),
  })
}

/**
 * Canonical destination identity used by production whole-shipment evidence.
 * Callers that prepare durable authority before the provider read must use
 * this helper instead of reproducing the fingerprint algorithm.
 */
export function carrierWholeShipmentRateDestinationFingerprint(
  value: CarrierWholeShipmentRateDestination,
) {
  const destination = normalizeDestination(value)
  return hash({
    version: 'carrier-rate-destination-v1',
    destination,
  })
}

function packageName(
  provider: CarrierWholeShipmentRateProvider,
  value: unknown,
) {
  const code = value === undefined || value === null
    ? provider === 'ups_rest' ? '02' : 'YOUR_PACKAGING'
    : plainText(value, 'Carrier package code', 32)
  const name = provider === 'ups_rest'
    ? (UPS_WHOLE_SHIPMENT_PACKAGING_TYPES as Record<string, string>)[code]
    : (FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES as Record<string, string>)[code]
  if (!name) throw new Error('Carrier package type is not supported')
  return { code, name }
}

function normalizeParcel(
  value: unknown,
  provider: CarrierWholeShipmentRateProvider,
): NormalizedCarrierWholeShipmentRateParcel {
  const input = record(value)
  if (input.dimensionUnit !== 'IN' || input.weightUnit !== 'LB') {
    throw new Error('Whole-shipment carrier rating requires IN and LB canonical units')
  }
  const packaging = packageName(provider, input.packageCode)
  return {
    description: plainText(input.description, 'Parcel description', 120),
    packageCode: packaging.code,
    length: positiveDecimal(input.length, 'Parcel length', 108),
    width: positiveDecimal(input.width, 'Parcel width', 108),
    height: positiveDecimal(input.height, 'Parcel height', 108),
    dimensionUnit: 'IN',
    weight: positiveDecimal(input.weight, 'Parcel weight', 150),
    weightUnit: 'LB',
  }
}

function normalizeBinding(
  value: CarrierWholeShipmentRateBindingInput,
): CarrierWholeShipmentRateBindingInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Carrier rate binding is required')
  }
  if (value.provider !== 'ups_rest' && value.provider !== 'fedex_rest') {
    throw new Error('Carrier rate provider is not supported')
  }
  if (value.environment !== 'sandbox' && value.environment !== 'production') {
    throw new Error('Carrier rate environment is not supported')
  }
  if (!Number.isInteger(value.credentialRevision) || value.credentialRevision < 1) {
    throw new Error('Credential revision must be a positive integer')
  }
  const accountNumber = plainText(value.accountNumber, 'Carrier account number', 64)
  return {
    organizationId: canonicalUuid(value.organizationId, 'Organization ID'),
    carrierAccountId: canonicalUuid(value.carrierAccountId, 'Carrier account ID'),
    integrationAccountId: canonicalUuid(
      value.integrationAccountId,
      'Integration account ID',
    ),
    credentialRevision: value.credentialRevision,
    credentialFingerprint: canonicalFingerprint(
      value.credentialFingerprint,
      'Credential fingerprint',
    ),
    accountNumber,
    accountNumberFingerprint: canonicalFingerprint(
      value.accountNumberFingerprint,
      'Carrier account-number fingerprint',
    ),
    provider: value.provider,
    environment: value.environment,
  }
}

function normalizeBilling(value: CarrierWholeShipmentRateBillingInput) {
  if (!value || typeof value !== 'object') {
    throw new Error('Carrier rate billing selection is required')
  }
  if (
    value.relationship !== 'sender'
    && value.relationship !== 'recipient'
    && value.relationship !== 'third_party'
  ) {
    throw new Error('Carrier rate billing relationship is not supported')
  }
  return {
    relationship: value.relationship,
    payerAccountNumber: plainText(
      value.payerAccountNumber,
      'Carrier rate payer account number',
      64,
    ),
    payerAccountNumberFingerprint: canonicalFingerprint(
      value.payerAccountNumberFingerprint,
      'Carrier rate payer account-number fingerprint',
    ),
    payerPostalCode: usPostalCode(
      value.payerPostalCode,
      'Carrier rate payer postal code',
    ),
    payerCountryCode: usCountry(
      value.payerCountryCode,
      'Carrier rate payer country code',
    ),
  }
}

function assertBillingContext(
  binding: CarrierWholeShipmentRateBindingInput,
  billing: ReturnType<typeof normalizeBilling>,
  origin: CarrierWholeShipmentRateParty,
  destination: CarrierWholeShipmentRateDestination,
) {
  if (billing.relationship === 'sender') {
    if (
      billing.payerAccountNumber !== binding.accountNumber
      || billing.payerAccountNumberFingerprint !== binding.accountNumberFingerprint
    ) {
      throw new Error('Sender billing must use the bound carrier account')
    }
    if (
      billing.payerPostalCode !== origin.postalCode
      || billing.payerCountryCode !== origin.countryCode
    ) {
      throw new Error('Sender billing address must match the bound origin')
    }
  }
  if (
    billing.relationship === 'recipient'
    && (
      billing.payerPostalCode !== destination.postalCode
      || billing.payerCountryCode !== destination.countryCode
    )
  ) {
    throw new Error('Recipient billing address must match the bound destination')
  }
}

function normalizeInstant(value: unknown, label: string) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must be an ISO-8601 instant`)
  }
  const match = ISO_INSTANT.exec(value)
  if (!match) {
    throw new Error(`${label} must be an ISO-8601 instant`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const calendarDate = new Date(Date.UTC(year, month - 1, day))
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be an ISO-8601 instant`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO-8601 instant`)
  }
  return new Date(parsed).toISOString()
}

export function carrierWholeShipmentRateEndpoint(
  provider: CarrierWholeShipmentRateProvider,
  environment: CarrierWholeShipmentRateEnvironment,
) {
  if (provider !== 'ups_rest' && provider !== 'fedex_rest') {
    throw new Error('Carrier rate provider is not supported')
  }
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error('Carrier rate environment is not supported')
  }
  return CARRIER_WHOLE_SHIPMENT_RATE_ENDPOINTS[provider][environment]
}

function fedexRequest(
  payerAccountNumber: string,
  origin: CarrierWholeShipmentRateParty,
  destination: CarrierWholeShipmentRateDestination,
  parcels: NormalizedCarrierWholeShipmentRateParcel[],
  pickupType: CarrierWholeShipmentFedexPickupType,
) {
  const packagingType = parcels[0]?.packageCode
  if (!packagingType || parcels.some((parcel) => parcel.packageCode !== packagingType)) {
    throw new Error('FedEx whole-shipment rating requires one package type for every parcel')
  }
  return {
    // The FedEx Rate API expresses the account whose rates are requested only
    // through this top-level accountNumber. It has no shipping-payment mutation
    // container; the relationship is therefore bound in redacted evidence.
    accountNumber: { value: payerAccountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: {
        contact: {
          personName: origin.name,
          companyName: origin.name,
          ...(origin.phone ? { phoneNumber: origin.phone } : {}),
        },
        address: {
          streetLines: [origin.line1, ...(origin.line2 ? [origin.line2] : [])],
          city: origin.city,
          stateOrProvinceCode: origin.region,
          postalCode: origin.postalCode,
          countryCode: origin.countryCode,
          ...(origin.residential === null
            ? {}
            : { residential: origin.residential }),
        },
      },
      recipient: {
        address: {
          ...(destination.line1
            ? {
                streetLines: [
                  destination.line1,
                  ...(destination.line2 ? [destination.line2] : []),
                ],
              }
            : {}),
          ...(destination.city ? { city: destination.city } : {}),
          ...(destination.region
            ? { stateOrProvinceCode: destination.region }
            : {}),
          postalCode: destination.postalCode,
          countryCode: destination.countryCode,
          ...(destination.residential === null
            ? {}
            : { residential: destination.residential }),
        },
      },
      pickupType,
      rateRequestType: ['ACCOUNT', 'LIST'],
      packagingType,
      totalPackageCount: parcels.length,
      requestedPackageLineItems: parcels.map((parcel, index) => ({
        sequenceNumber: index + 1,
        groupPackageCount: 1,
        itemDescription: parcel.description,
        weight: { units: parcel.weightUnit, value: parcel.weight },
        dimensions: {
          length: parcel.length,
          width: parcel.width,
          height: parcel.height,
          units: parcel.dimensionUnit,
        },
      })),
    },
  }
}

function upsParty(address: CarrierWholeShipmentRateParty) {
  return {
    Name: address.name,
    Address: {
      AddressLine: [address.line1, ...(address.line2 ? [address.line2] : [])],
      City: address.city,
      StateProvinceCode: address.region,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
      ...(address.residential === true
        ? { ResidentialAddressIndicator: '' }
        : {}),
    },
  }
}

function upsDestination(address: CarrierWholeShipmentRateDestination) {
  return {
    ...(address.name ? { Name: address.name } : {}),
    Address: {
      ...(address.line1
        ? {
            AddressLine: [
              address.line1,
              ...(address.line2 ? [address.line2] : []),
            ],
          }
        : {}),
      ...(address.city ? { City: address.city } : {}),
      ...(address.region ? { StateProvinceCode: address.region } : {}),
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
      ...(address.residential === true
        ? { ResidentialAddressIndicator: '' }
        : {}),
    },
  }
}

function upsPaymentDetails(
  billing: ReturnType<typeof normalizeBilling>,
) {
  if (billing.relationship === 'sender') {
    return {
      ShipmentCharge: [{
        Type: '01',
        BillShipper: { AccountNumber: billing.payerAccountNumber },
      }],
    }
  }
  const payer = {
    AccountNumber: billing.payerAccountNumber,
    Address: {
      PostalCode: billing.payerPostalCode,
      CountryCode: billing.payerCountryCode,
    },
  }
  return {
    ShipmentCharge: [{
      Type: '01',
      ...(billing.relationship === 'recipient'
        ? { BillReceiver: payer }
        : { BillThirdParty: payer }),
    }],
  }
}

function upsRequest(
  accountNumber: string,
  origin: CarrierWholeShipmentRateParty,
  destination: CarrierWholeShipmentRateDestination,
  parcels: NormalizedCarrierWholeShipmentRateParcel[],
  billing: ReturnType<typeof normalizeBilling>,
) {
  return {
    RateRequest: {
      Request: {
        RequestOption: 'Shop',
        TransactionReference: {
          CustomerContext: 'ClawPilot whole-shipment rate',
        },
      },
      Shipment: {
        Shipper: { ...upsParty(origin), ShipperNumber: accountNumber },
        ShipFrom: upsParty(origin),
        ShipTo: upsDestination(destination),
        PaymentDetails: upsPaymentDetails(billing),
        NumOfPieces: String(parcels.length),
        Package: parcels.map((parcel) => ({
          PackagingType: {
            Code: parcel.packageCode,
            Description: packageName('ups_rest', parcel.packageCode).name,
          },
          Description: parcel.description,
          Dimensions: {
            UnitOfMeasurement: { Code: parcel.dimensionUnit },
            Length: String(parcel.length),
            Width: String(parcel.width),
            Height: String(parcel.height),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(parcel.weight),
          },
        })),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: '' },
      },
    },
  }
}

function carrierRateHeaders(
  provider: CarrierWholeShipmentRateProvider,
  requestHash: string,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (provider === 'ups_rest') {
    headers.transId = [
      requestHash.slice(0, 8),
      requestHash.slice(8, 12),
      requestHash.slice(12, 16),
      requestHash.slice(16, 20),
      requestHash.slice(20, 32),
    ].join('-')
    headers.transactionSrc = 'clawpilot'
  } else {
    headers['x-locale'] = 'en_US'
  }
  return headers
}

export function prepareCarrierWholeShipmentRateRequest(
  input: CarrierWholeShipmentRateRequestInput,
): PreparedCarrierWholeShipmentRateRequest {
  const binding = normalizeBinding(input.binding)
  const origin = normalizeParty(input.origin)
  const destination = normalizeDestination(input.destination)
  const billing = normalizeBilling(input.billing)
  assertBillingContext(binding, billing, origin, destination)
  const currency = expectedCurrency(input.expectedCurrency)
  const pickupType = fedexPickupType(binding.provider, input.fedexPickupType)
  if (
    !Array.isArray(input.parcels)
    || input.parcels.length < 1
    || input.parcels.length > MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES
  ) {
    throw new Error(
      `Whole-shipment carrier rating requires 1-${
        MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES
      } ordered packages`,
    )
  }
  const parcels = input.parcels.map((parcel) => normalizeParcel(
    parcel,
    binding.provider,
  ))
  const endpoint = carrierWholeShipmentRateEndpoint(
    binding.provider,
    binding.environment,
  )
  const endpointVersion = ENDPOINT_VERSIONS[binding.provider]
  const safeBinding: CarrierWholeShipmentRateSafeBinding = {
    organizationId: binding.organizationId,
    carrierAccountId: binding.carrierAccountId,
    integrationAccountId: binding.integrationAccountId,
    credentialRevision: binding.credentialRevision,
    credentialFingerprint: binding.credentialFingerprint,
    accountNumberFingerprint: binding.accountNumberFingerprint,
  }
  const safeBilling: CarrierWholeShipmentRateSafeBilling = {
    relationship: billing.relationship,
    providerMapping: binding.provider === 'ups_rest'
      ? 'ups_payment_details'
      : 'fedex_rate_account_number',
    payerAccountNumberFingerprint: billing.payerAccountNumberFingerprint,
    payerPostalCode: billing.payerPostalCode,
    payerCountryCode: billing.payerCountryCode,
  }
  const body = binding.provider === 'ups_rest'
    ? upsRequest(binding.accountNumber, origin, destination, parcels, billing)
    : fedexRequest(
      billing.payerAccountNumber,
      origin,
      destination,
      parcels,
      pickupType!,
    )
  const addressFingerprints = carrierWholeShipmentRateAddressFingerprints({
    origin,
    destination,
  })
  const redactedRequest: CarrierWholeShipmentRateRequestEvidence = {
    adapterVersion: 'carrier-whole-shipment-rate-v1',
    accessMode: 'rate_read_only',
    providerMutationCount: 0,
    provider: binding.provider,
    environment: binding.environment,
    endpoint,
    endpointVersion,
    purpose: 'fulfillment_execution',
    rateScope: 'multi_package_shipment',
    expectedCurrency: currency,
    packageCount: parcels.length,
    binding: safeBinding,
    billing: safeBilling,
    shipment: {
      originFingerprint: addressFingerprints.originFingerprint,
      destinationFingerprint: addressFingerprints.destinationFingerprint,
      origin: {
        region: origin.region,
        countryCode: origin.countryCode,
        residential: origin.residential,
      },
      destination: {
        region: destination.region,
        countryCode: destination.countryCode,
        residential: destination.residential,
      },
      fedexPickupType: pickupType,
      parcels,
    },
  }
  const requestHash = hash({
    ...redactedRequest,
    providerRequestBodyHash: hash(body),
  })
  const headers = carrierRateHeaders(binding.provider, requestHash)
  return deepFreeze({
    adapterVersion: 'carrier-whole-shipment-rate-v1',
    accessMode: 'rate_read_only',
    providerMutationCount: 0,
    provider: binding.provider,
    environment: binding.environment,
    endpoint,
    endpointVersion,
    method: 'POST',
    headers,
    body,
    requestHash,
    redactedRequest,
  })
}

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function transitDays(value: unknown) {
  const numeric = positiveInteger(value)
  if (numeric !== null) return numeric
  const normalized = text(value).toUpperCase()
  const names: Record<string, number> = {
    ONE_DAY: 1,
    TWO_DAYS: 2,
    THREE_DAYS: 3,
    FOUR_DAYS: 4,
    FIVE_DAYS: 5,
    SIX_DAYS: 6,
    SEVEN_DAYS: 7,
    EIGHT_DAYS: 8,
    NINE_DAYS: 9,
    TEN_DAYS: 10,
  }
  return names[normalized] ?? null
}

function normalizeDate(value: unknown, label: string) {
  const raw = text(value)
  if (!raw) return null
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized)
  if (!match) throw new Error(`${label} must be a calendar-valid YYYY-MM-DD date`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a calendar-valid YYYY-MM-DD date`)
  }
  return normalized
}

function responseServiceCode(value: unknown, provider: string) {
  const code = text(value)
  if (!code || code.length > 80 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error(`${provider} rate response is missing a usable service code`)
  }
  return code
}

function responseServiceName(
  value: unknown,
  fallback: string,
  provider: string,
) {
  const name = text(value) || fallback
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`${provider} rate response contains an invalid service name`)
  }
  return name
}

function responseCurrency(
  value: unknown,
  expected: 'USD',
  provider: string,
) {
  const currency = text(value)
  if (!/^[A-Z]{3}$/.test(currency) || currency !== expected) {
    throw new Error(
      `${provider} rate response currency must match expected ${expected}`,
    )
  }
  return currency
}

function responseAmount(value: unknown, provider: string) {
  const amount = text(value)
  if (!EXACT_RATE_AMOUNT.test(amount)) {
    throw new Error(`${provider} rate response contains an invalid amount`)
  }
  return amount
}

function exactRateAmountMinor(value: string) {
  if (!EXACT_RATE_AMOUNT.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`)
}

function codePointCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareRates(
  left: CarrierWholeShipmentRate,
  right: CarrierWholeShipmentRate,
) {
  const leftMinor = exactRateAmountMinor(left.amount)
  const rightMinor = exactRateAmountMinor(right.amount)
  if (leftMinor === null && rightMinor !== null) return 1
  if (leftMinor !== null && rightMinor === null) return -1
  if (leftMinor !== null && rightMinor !== null && leftMinor !== rightMinor) {
    return leftMinor < rightMinor ? -1 : 1
  }
  return (
    codePointCompare(
      left.deliveryDate || '9999-12-31',
      right.deliveryDate || '9999-12-31',
    )
  ) || (
    (left.transitDays ?? 366) - (right.transitDays ?? 366)
    || codePointCompare(left.serviceName, right.serviceName)
    || codePointCompare(left.rateType || '', right.rateType || '')
  )
}

function collapseFedexDuplicates(rates: CarrierWholeShipmentRate[]) {
  const selected = new Map<string, CarrierWholeShipmentRate>()
  for (const rate of rates) {
    const current = selected.get(rate.serviceCode)
    if (!current) {
      selected.set(rate.serviceCode, rate)
      continue
    }
    if (compareRates(rate, current) < 0) selected.set(rate.serviceCode, rate)
  }
  return [...selected.values()]
}

function parseFedex(
  payload: unknown,
  expected: 'USD',
): CarrierWholeShipmentRate[] {
  const output = record(record(payload).output)
  const rates = list(output.rateReplyDetails).map((rawDetail) => {
    const detail = record(rawDetail)
    const rated = list(detail.ratedShipmentDetails).map(record)
    const preferred = rated.find((item) => text(item.rateType) === 'ACCOUNT')
    if (!preferred) {
      throw new Error(
        'FedEx rate response did not contain the requested ACCOUNT rate type',
      )
    }
    const totalNetCharge = record(preferred.totalNetCharge)
    const amount = responseAmount(
      text(totalNetCharge.amount)
        || preferred.totalNetCharge
        || preferred.totalNetFedExCharge,
      'FedEx',
    )
    const currency = responseCurrency(
      preferred.currency || totalNetCharge.currency,
      expected,
      'FedEx',
    )
    const operational = record(detail.operationalDetail)
    const commit = record(detail.commit)
    const dateDetail = record(commit.dateDetail)
    const serviceCode = responseServiceCode(detail.serviceType, 'FedEx')
    return {
      serviceCode,
      serviceName: responseServiceName(
        detail.serviceName,
        serviceCode,
        'FedEx',
      ),
      amount,
      currency,
      rateType: 'ACCOUNT',
      transitDays: transitDays(operational.transitTime || commit.transitDays),
      deliveryDate: normalizeDate(
        dateDetail.dayFormat || operational.deliveryDate,
        'FedEx delivery date',
      ),
    }
  })
  return collapseFedexDuplicates(rates)
}

function parseUps(
  payload: unknown,
  expected: 'USD',
): CarrierWholeShipmentRate[] {
  const response = record(record(payload).RateResponse)
  return list(response.RatedShipment).map((rawShipment) => {
    const shipment = record(rawShipment)
    const service = record(shipment.Service)
    const negotiated = record(
      record(shipment.NegotiatedRateCharges).TotalCharge,
    )
    const charges = text(negotiated.MonetaryValue)
      ? negotiated
      : record(shipment.TotalCharges)
    const serviceCode = responseServiceCode(service.Code, 'UPS')
    const amount = responseAmount(charges.MonetaryValue, 'UPS')
    const currency = responseCurrency(
      charges.CurrencyCode,
      expected,
      'UPS',
    )
    const time = record(shipment.TimeInTransit)
    const summary = record(time.ServiceSummary)
    const estimatedArrival = record(summary.EstimatedArrival)
    const arrival = record(estimatedArrival.Arrival)
    return {
      serviceCode,
      serviceName: responseServiceName(
        service.Description,
        UPS_SERVICE_NAMES[serviceCode] || `UPS service ${serviceCode}`,
        'UPS',
      ),
      amount,
      currency,
      rateType: charges === negotiated ? 'NEGOTIATED' : 'PUBLISHED',
      transitDays: transitDays(
        estimatedArrival.BusinessDaysInTransit
        || summary.BusinessDaysInTransit,
      ),
      deliveryDate: normalizeDate(
        arrival.Date || estimatedArrival.Date,
        'UPS delivery date',
      ),
    }
  })
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const candidate = value as Record<string, unknown>
  const actualKeys = Object.keys(candidate).sort()
  const canonicalKeys = [...expectedKeys].sort()
  if (stable(actualKeys) !== stable(canonicalKeys)) {
    throw new Error(`${label} contains an unexpected field`)
  }
  return candidate
}

function exactList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function upsAddress(
  value: unknown,
  label: string,
  options: {
    destination: boolean
    residential: boolean | null
  },
) {
  const source = record(value)
  const expectedKeys = [
    ...(!options.destination || source.AddressLine !== undefined
      ? ['AddressLine']
      : []),
    ...(!options.destination || source.City !== undefined ? ['City'] : []),
    ...(!options.destination || source.StateProvinceCode !== undefined
      ? ['StateProvinceCode']
      : []),
    'PostalCode',
    'CountryCode',
    ...(source.ResidentialAddressIndicator !== undefined
      ? ['ResidentialAddressIndicator']
      : []),
  ]
  const address = exactObject(value, expectedKeys, label)
  if (
    address.ResidentialAddressIndicator !== undefined
    && address.ResidentialAddressIndicator !== ''
  ) {
    throw new Error(`${label} residential indicator is invalid`)
  }
  if (
    (address.ResidentialAddressIndicator === '')
      !== (options.residential === true)
  ) {
    throw new Error(`${label} residential indicator does not match evidence`)
  }
  const lines = address.AddressLine === undefined
    ? []
    : exactList(address.AddressLine, `${label} lines`)
  if (lines.length > 2) throw new Error(`${label} has too many address lines`)
  return {
    line1: lines[0] ?? null,
    line2: lines[1] ?? null,
    city: address.City ?? null,
    region: address.StateProvinceCode ?? null,
    postalCode: address.PostalCode,
    countryCode: address.CountryCode,
    residential: options.residential,
  }
}

function parcelsFromUpsBody(value: unknown): NormalizedCarrierWholeShipmentRateParcel[] {
  return exactList(value, 'UPS packages').map((candidate, index) => {
    const item = exactObject(
      candidate,
      ['PackagingType', 'Description', 'Dimensions', 'PackageWeight'],
      `UPS package ${index + 1}`,
    )
    const packaging = exactObject(
      item.PackagingType,
      ['Code', 'Description'],
      `UPS package ${index + 1} packaging`,
    )
    const dimensions = exactObject(
      item.Dimensions,
      ['UnitOfMeasurement', 'Length', 'Width', 'Height'],
      `UPS package ${index + 1} dimensions`,
    )
    const dimensionUnit = exactObject(
      dimensions.UnitOfMeasurement,
      ['Code'],
      `UPS package ${index + 1} dimension unit`,
    )
    const weight = exactObject(
      item.PackageWeight,
      ['UnitOfMeasurement', 'Weight'],
      `UPS package ${index + 1} weight`,
    )
    const weightUnit = exactObject(
      weight.UnitOfMeasurement,
      ['Code'],
      `UPS package ${index + 1} weight unit`,
    )
    const carrierPackaging = packageName('ups_rest', packaging.Code)
    if (
      packaging.Description !== carrierPackaging.name
      || dimensionUnit.Code !== 'IN'
      || weightUnit.Code !== 'LBS'
    ) {
      throw new Error(`UPS package ${index + 1} contains invalid literals`)
    }
    return normalizeParcel({
      description: item.Description,
      packageCode: carrierPackaging.code,
      length: Number(dimensions.Length),
      width: Number(dimensions.Width),
      height: Number(dimensions.Height),
      dimensionUnit: 'IN',
      weight: Number(weight.Weight),
      weightUnit: 'LB',
    }, 'ups_rest')
  })
}

function assertUpsBodyIntegrity(
  bodyValue: unknown,
  redacted: CarrierWholeShipmentRateRequestEvidence,
  expectedBinding?: CarrierWholeShipmentRateExpectedRequestBinding,
) {
  const body = exactObject(bodyValue, ['RateRequest'], 'UPS request body')
  const rateRequest = exactObject(
    body.RateRequest,
    ['Request', 'Shipment'],
    'UPS RateRequest',
  )
  const request = exactObject(
    rateRequest.Request,
    ['RequestOption', 'TransactionReference'],
    'UPS request metadata',
  )
  const transaction = exactObject(
    request.TransactionReference,
    ['CustomerContext'],
    'UPS transaction reference',
  )
  if (
    request.RequestOption !== 'Shop'
    || transaction.CustomerContext !== 'ClawPilot whole-shipment rate'
  ) {
    throw new Error('UPS request metadata is invalid')
  }
  const shipment = exactObject(
    rateRequest.Shipment,
    [
      'Shipper',
      'ShipFrom',
      'ShipTo',
      'PaymentDetails',
      'NumOfPieces',
      'Package',
      'ShipmentRatingOptions',
    ],
    'UPS shipment',
  )
  const shipper = exactObject(
    shipment.Shipper,
    ['Name', 'Address', 'ShipperNumber'],
    'UPS shipper',
  )
  const shipFrom = exactObject(
    shipment.ShipFrom,
    ['Name', 'Address'],
    'UPS ship from',
  )
  const shipToSource = record(shipment.ShipTo)
  const shipTo = exactObject(
    shipment.ShipTo,
    [...(shipToSource.Name === undefined ? [] : ['Name']), 'Address'],
    'UPS ship to',
  )
  const originAddress = upsAddress(
    shipFrom.Address,
    'UPS origin address',
    {
      destination: false,
      residential: redacted.shipment.origin.residential,
    },
  )
  const shipperAddress = upsAddress(
    shipper.Address,
    'UPS shipper address',
    {
      destination: false,
      residential: redacted.shipment.origin.residential,
    },
  )
  const destinationAddress = upsAddress(
    shipTo.Address,
    'UPS destination address',
    {
      destination: true,
      residential: redacted.shipment.destination.residential,
    },
  )
  const origin = normalizeParty({
    name: shipFrom.Name,
    phone: null,
    ...originAddress,
  })
  const destination = normalizeDestination({
    name: shipTo.Name ?? null,
    ...destinationAddress,
  })
  const parcels = parcelsFromUpsBody(shipment.Package)
  const payment = exactObject(
    shipment.PaymentDetails,
    ['ShipmentCharge'],
    'UPS payment details',
  )
  const charges = exactList(payment.ShipmentCharge, 'UPS shipment charges')
  if (charges.length !== 1) throw new Error('UPS requires one shipment charge')
  const relationship = redacted.billing.relationship
  const relationshipKey = relationship === 'sender'
    ? 'BillShipper'
    : relationship === 'recipient'
      ? 'BillReceiver'
      : 'BillThirdParty'
  const charge = exactObject(
    charges[0],
    ['Type', relationshipKey],
    'UPS shipment charge',
  )
  if (charge.Type !== '01') throw new Error('UPS shipment charge type is invalid')
  const payer = exactObject(
    charge[relationshipKey],
    relationship === 'sender' ? ['AccountNumber'] : ['AccountNumber', 'Address'],
    'UPS payer',
  )
  const payerAddress = relationship === 'sender'
    ? { PostalCode: origin.postalCode, CountryCode: origin.countryCode }
    : exactObject(payer.Address, ['PostalCode', 'CountryCode'], 'UPS payer address')
  const billing = normalizeBilling({
    relationship,
    payerAccountNumber: plainText(
      payer.AccountNumber,
      'UPS payer account number',
      64,
    ),
    payerAccountNumberFingerprint: redacted.billing.payerAccountNumberFingerprint,
    payerPostalCode: usPostalCode(
      payerAddress.PostalCode,
      'UPS payer postal code',
    ),
    payerCountryCode: usCountry(
      payerAddress.CountryCode,
      'UPS payer country code',
    ),
  })
  const binding: CarrierWholeShipmentRateBindingInput = {
    ...redacted.binding,
    accountNumber: plainText(
      shipper.ShipperNumber,
      'UPS shipper account number',
      64,
    ),
    provider: 'ups_rest',
    environment: redacted.environment,
  }
  assertBillingContext(binding, billing, origin, destination)
  const ratingOptions = exactObject(
    shipment.ShipmentRatingOptions,
    ['NegotiatedRatesIndicator'],
    'UPS rating options',
  )
  if (ratingOptions.NegotiatedRatesIndicator !== '') {
    throw new Error('UPS negotiated-rate indicator is invalid')
  }
  if (
    stable(shipperAddress) !== stable(originAddress)
    || shipper.Name !== shipFrom.Name
    || shipment.NumOfPieces !== String(parcels.length)
    || stable(parcels) !== stable(redacted.shipment.parcels)
    || stable({
      region: origin.region,
      countryCode: origin.countryCode,
      residential: origin.residential,
    }) !== stable(redacted.shipment.origin)
    || stable({
      region: destination.region,
      countryCode: destination.countryCode,
      residential: destination.residential,
    }) !== stable(redacted.shipment.destination)
    || stable(upsRequest(binding.accountNumber, origin, destination, parcels, billing))
      !== stable(bodyValue)
    || redacted.shipment.destinationFingerprint !== hash({
      version: 'carrier-rate-destination-v1',
      destination,
    })
  ) {
    throw new Error('UPS request body does not match its redacted evidence')
  }
  if (expectedBinding) {
    const expectedOrigin = normalizeParty(expectedBinding.origin)
    const expectedDestination = normalizeDestination(expectedBinding.destination)
    const expectedFingerprints = carrierWholeShipmentRateAddressFingerprints({
      origin: expectedOrigin,
      destination: expectedDestination,
    })
    if (
      !expectedBinding.matchesAccountNumber(binding.accountNumber)
      || !expectedBinding.matchesAccountNumber(billing.payerAccountNumber)
      || stable(upsParty(expectedOrigin)) !== stable(shipFrom)
      || stable(upsDestination(expectedDestination)) !== stable(shipTo)
      || expectedFingerprints.originFingerprint
        !== redacted.shipment.originFingerprint
      || expectedFingerprints.destinationFingerprint
        !== redacted.shipment.destinationFingerprint
    ) {
      throw new Error('UPS request body does not match the expected durable binding')
    }
  }
}

function fedexAddress(value: unknown, label: string, destination: boolean) {
  const source = record(value)
  const expectedKeys = [
    ...(source.streetLines === undefined ? [] : ['streetLines']),
    ...(source.city === undefined ? [] : ['city']),
    ...(source.stateOrProvinceCode === undefined ? [] : ['stateOrProvinceCode']),
    'postalCode',
    'countryCode',
    ...(source.residential === undefined ? [] : ['residential']),
  ]
  const address = exactObject(value, expectedKeys, label)
  const lines = address.streetLines === undefined
    ? []
    : exactList(address.streetLines, `${label} lines`)
  if ((!destination && lines.length < 1) || lines.length > 2) {
    throw new Error(`${label} has an invalid address-line count`)
  }
  return {
    line1: lines[0] ?? null,
    line2: lines[1] ?? null,
    city: address.city ?? null,
    region: address.stateOrProvinceCode ?? null,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    residential: address.residential ?? null,
  }
}

function parcelsFromFedexBody(
  value: unknown,
  packageCode: string,
): NormalizedCarrierWholeShipmentRateParcel[] {
  return exactList(value, 'FedEx package lines').map((candidate, index) => {
    const item = exactObject(
      candidate,
      [
        'sequenceNumber',
        'groupPackageCount',
        'itemDescription',
        'weight',
        'dimensions',
      ],
      `FedEx package ${index + 1}`,
    )
    const weight = exactObject(
      item.weight,
      ['units', 'value'],
      `FedEx package ${index + 1} weight`,
    )
    const dimensions = exactObject(
      item.dimensions,
      ['length', 'width', 'height', 'units'],
      `FedEx package ${index + 1} dimensions`,
    )
    if (
      item.sequenceNumber !== index + 1
      || item.groupPackageCount !== 1
      || weight.units !== 'LB'
      || dimensions.units !== 'IN'
    ) {
      throw new Error(`FedEx package ${index + 1} contains invalid literals`)
    }
    return normalizeParcel({
      description: item.itemDescription,
      packageCode,
      length: dimensions.length,
      width: dimensions.width,
      height: dimensions.height,
      dimensionUnit: dimensions.units,
      weight: weight.value,
      weightUnit: weight.units,
    }, 'fedex_rest')
  })
}

function assertFedexBodyIntegrity(
  bodyValue: unknown,
  redacted: CarrierWholeShipmentRateRequestEvidence,
  expectedBinding?: CarrierWholeShipmentRateExpectedRequestBinding,
) {
  const body = exactObject(
    bodyValue,
    ['accountNumber', 'rateRequestControlParameters', 'requestedShipment'],
    'FedEx request body',
  )
  const account = exactObject(body.accountNumber, ['value'], 'FedEx account')
  const controls = exactObject(
    body.rateRequestControlParameters,
    ['returnTransitTimes'],
    'FedEx rate controls',
  )
  if (controls.returnTransitTimes !== true) {
    throw new Error('FedEx transit-time control is invalid')
  }
  const shipment = exactObject(
    body.requestedShipment,
    [
      'shipper',
      'recipient',
      'pickupType',
      'rateRequestType',
      'packagingType',
      'totalPackageCount',
      'requestedPackageLineItems',
    ],
    'FedEx requested shipment',
  )
  const shipper = exactObject(
    shipment.shipper,
    ['contact', 'address'],
    'FedEx shipper',
  )
  const contactSource = record(shipper.contact)
  const contact = exactObject(
    shipper.contact,
    [
      'personName',
      'companyName',
      ...(contactSource.phoneNumber === undefined ? [] : ['phoneNumber']),
    ],
    'FedEx shipper contact',
  )
  if (contact.personName !== contact.companyName) {
    throw new Error('FedEx shipper contact names must match')
  }
  const origin = normalizeParty({
    name: contact.personName,
    phone: contact.phoneNumber ?? null,
    ...fedexAddress(shipper.address, 'FedEx origin address', false),
  })
  const recipient = exactObject(
    shipment.recipient,
    ['address'],
    'FedEx recipient',
  )
  const destination = normalizeDestination({
    name: null,
    ...fedexAddress(recipient.address, 'FedEx destination address', true),
  })
  const fedexPackaging = packageName('fedex_rest', shipment.packagingType)
  const parcels = parcelsFromFedexBody(
    shipment.requestedPackageLineItems,
    fedexPackaging.code,
  )
  const pickupType = fedexPickupType('fedex_rest', shipment.pickupType)
  const rateTypes = exactList(shipment.rateRequestType, 'FedEx rate request types')
  if (
    stable(rateTypes) !== stable(['ACCOUNT', 'LIST'])
    || shipment.totalPackageCount !== parcels.length
    || stable(parcels) !== stable(redacted.shipment.parcels)
    || stable(fedexRequest(
      plainText(account.value, 'FedEx payer account number', 64),
      origin,
      destination,
      parcels,
      pickupType!,
    )) !== stable(bodyValue)
  ) {
    throw new Error('FedEx request body does not match its redacted evidence')
  }
  const fingerprints = carrierWholeShipmentRateAddressFingerprints({
    origin,
    destination,
  })
  if (
    fingerprints.originFingerprint !== redacted.shipment.originFingerprint
    || stable({
      region: destination.region,
      countryCode: destination.countryCode,
      residential: destination.residential,
    }) !== stable(redacted.shipment.destination)
  ) {
    throw new Error('FedEx address evidence does not match the request body')
  }
  if (expectedBinding) {
    const expectedOrigin = normalizeParty(expectedBinding.origin)
    const expectedDestination = normalizeDestination(expectedBinding.destination)
    const expectedFingerprints = carrierWholeShipmentRateAddressFingerprints({
      origin: expectedOrigin,
      destination: expectedDestination,
    })
    const payerAccountNumber = plainText(
      account.value,
      'FedEx payer account number',
      64,
    )
    if (
      !expectedBinding.matchesAccountNumber(payerAccountNumber)
      || stable(fedexRequest(
        payerAccountNumber,
        expectedOrigin,
        expectedDestination,
        parcels,
        pickupType!,
      )) !== stable(bodyValue)
      || expectedFingerprints.originFingerprint
        !== redacted.shipment.originFingerprint
      || expectedFingerprints.destinationFingerprint
        !== redacted.shipment.destinationFingerprint
    ) {
      throw new Error('FedEx request body does not match the expected durable binding')
    }
  }
}

function normalizeRequestEvidence(
  value: CarrierWholeShipmentRateRequestEvidence,
  prepared: PreparedCarrierWholeShipmentRateRequest,
): CarrierWholeShipmentRateRequestEvidence {
  const bindingSource = exactObject(
    value.binding,
    [
      'organizationId',
      'carrierAccountId',
      'integrationAccountId',
      'credentialRevision',
      'credentialFingerprint',
      'accountNumberFingerprint',
    ],
    'Carrier request binding evidence',
  )
  const billingSource = exactObject(
    value.billing,
    [
      'relationship',
      'providerMapping',
      'payerAccountNumberFingerprint',
      'payerPostalCode',
      'payerCountryCode',
    ],
    'Carrier request billing evidence',
  )
  const shipmentSource = exactObject(
    value.shipment,
    [
      'originFingerprint',
      'destinationFingerprint',
      'origin',
      'destination',
      'fedexPickupType',
      'parcels',
    ],
    'Carrier request shipment evidence',
  )
  const originSource = exactObject(
    shipmentSource.origin,
    ['region', 'countryCode', 'residential'],
    'Carrier request origin evidence',
  )
  const destinationSource = exactObject(
    shipmentSource.destination,
    ['region', 'countryCode', 'residential'],
    'Carrier request destination evidence',
  )
  const relationship = billingSource.relationship
  if (
    relationship !== 'sender'
    && relationship !== 'recipient'
    && relationship !== 'third_party'
  ) {
    throw new Error('Carrier request billing relationship is invalid')
  }
  const pickupType = fedexPickupType(prepared.provider, shipmentSource.fedexPickupType)
  const parcels = exactList(shipmentSource.parcels, 'Carrier request parcels')
    .map((parcel) => normalizeParcel(parcel, prepared.provider))
  const destinationRegion = destinationSource.region === null
    ? null
    : usRegion(destinationSource.region, 'Destination evidence region')
  const normalized: CarrierWholeShipmentRateRequestEvidence = {
    adapterVersion: 'carrier-whole-shipment-rate-v1',
    accessMode: 'rate_read_only',
    providerMutationCount: 0,
    provider: prepared.provider,
    environment: prepared.environment,
    endpoint: carrierWholeShipmentRateEndpoint(
      prepared.provider,
      prepared.environment,
    ),
    endpointVersion: ENDPOINT_VERSIONS[prepared.provider],
    purpose: 'fulfillment_execution',
    rateScope: 'multi_package_shipment',
    expectedCurrency: expectedCurrency(value.expectedCurrency),
    packageCount: parcels.length,
    binding: {
      organizationId: canonicalUuid(bindingSource.organizationId, 'Organization ID'),
      carrierAccountId: canonicalUuid(
        bindingSource.carrierAccountId,
        'Carrier account ID',
      ),
      integrationAccountId: canonicalUuid(
        bindingSource.integrationAccountId,
        'Integration account ID',
      ),
      credentialRevision: Number(bindingSource.credentialRevision),
      credentialFingerprint: canonicalFingerprint(
        bindingSource.credentialFingerprint,
        'Credential fingerprint',
      ),
      accountNumberFingerprint: canonicalFingerprint(
        bindingSource.accountNumberFingerprint,
        'Carrier account-number fingerprint',
      ),
    },
    billing: {
      relationship,
      providerMapping: prepared.provider === 'ups_rest'
        ? 'ups_payment_details'
        : 'fedex_rate_account_number',
      payerAccountNumberFingerprint: canonicalFingerprint(
        billingSource.payerAccountNumberFingerprint,
        'Payer account-number fingerprint',
      ),
      payerPostalCode: usPostalCode(
        billingSource.payerPostalCode,
        'Payer postal code',
      ),
      payerCountryCode: usCountry(
        billingSource.payerCountryCode,
        'Payer country code',
      ),
    },
    shipment: {
      originFingerprint: canonicalFingerprint(
        shipmentSource.originFingerprint,
        'Origin fingerprint',
      ),
      destinationFingerprint: canonicalFingerprint(
        shipmentSource.destinationFingerprint,
        'Destination fingerprint',
      ),
      origin: {
        region: usRegion(originSource.region, 'Origin evidence region'),
        countryCode: usCountry(
          originSource.countryCode,
          'Origin evidence country code',
        ),
        residential: nullableBooleanValue(
          originSource.residential,
          'Origin evidence residential classification',
        ),
      },
      destination: {
        region: destinationRegion,
        countryCode: usCountry(
          destinationSource.countryCode,
          'Destination evidence country code',
        ),
        residential: nullableBooleanValue(
          destinationSource.residential,
          'Destination evidence residential classification',
        ),
      },
      fedexPickupType: pickupType,
      parcels,
    },
  }
  if (
    !Number.isInteger(bindingSource.credentialRevision)
    || Number(bindingSource.credentialRevision) < 1
    || parcels.length < 1
    || parcels.length > MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES
    || value.packageCount !== parcels.length
    || stable(value) !== stable(normalized)
  ) {
    throw new Error('Carrier request redacted evidence is not canonical')
  }
  return normalized
}

function sealPreparedCarrierWholeShipmentRateRequestUnchecked(
  prepared: PreparedCarrierWholeShipmentRateRequest,
  expectedBinding?: CarrierWholeShipmentRateExpectedRequestBinding,
): SealedCarrierWholeShipmentRateRequest {
  if (!prepared || typeof prepared !== 'object') {
    throw new Error('Prepared carrier rate request integrity check failed')
  }
  const expectedEndpoint = carrierWholeShipmentRateEndpoint(
    prepared.provider,
    prepared.environment,
  )
  const expectedEndpointVersion = ENDPOINT_VERSIONS[prepared.provider]
  const redacted = normalizeRequestEvidence(prepared.redactedRequest, prepared)
  if (prepared.provider === 'ups_rest') {
    assertUpsBodyIntegrity(prepared.body, redacted, expectedBinding)
  } else {
    assertFedexBodyIntegrity(prepared.body, redacted, expectedBinding)
  }
  const expectedHash = hash({
    ...redacted,
    providerRequestBodyHash: hash(prepared.body),
  })
  const expectedHeaders = carrierRateHeaders(prepared.provider, expectedHash)
  if (
    prepared.adapterVersion !== 'carrier-whole-shipment-rate-v1'
    || prepared.accessMode !== 'rate_read_only'
    || prepared.providerMutationCount !== 0
    || prepared.method !== 'POST'
    || prepared.endpoint !== expectedEndpoint
    || prepared.endpointVersion !== expectedEndpointVersion
    || prepared.requestHash !== expectedHash
    || stable(prepared.headers) !== stable(expectedHeaders)
    || redacted.adapterVersion !== prepared.adapterVersion
    || redacted.accessMode !== prepared.accessMode
    || redacted.providerMutationCount !== prepared.providerMutationCount
    || redacted.provider !== prepared.provider
    || redacted.environment !== prepared.environment
    || redacted.endpoint !== prepared.endpoint
    || redacted.endpointVersion !== prepared.endpointVersion
    || redacted.purpose !== 'fulfillment_execution'
    || redacted.rateScope !== 'multi_package_shipment'
    || redacted.expectedCurrency !== 'USD'
  ) {
    throw new Error('Prepared carrier rate request integrity check failed')
  }
  const safeEvidence = JSON.parse(
    JSON.stringify(redacted),
  ) as CarrierWholeShipmentRateRequestEvidence
  return deepFreeze({
    adapterVersion: prepared.adapterVersion,
    accessMode: prepared.accessMode,
    providerMutationCount: prepared.providerMutationCount,
    provider: prepared.provider,
    environment: prepared.environment,
    endpoint: prepared.endpoint,
    endpointVersion: prepared.endpointVersion,
    requestHash: prepared.requestHash,
    redactedRequest: safeEvidence,
  })
}

export function sealPreparedCarrierWholeShipmentRateRequest(
  prepared: PreparedCarrierWholeShipmentRateRequest,
  expectedBinding?: CarrierWholeShipmentRateExpectedRequestBinding,
): SealedCarrierWholeShipmentRateRequest {
  try {
    return sealPreparedCarrierWholeShipmentRateRequestUnchecked(
      prepared,
      expectedBinding,
    )
  } catch {
    throw new Error('Prepared carrier rate request integrity check failed')
  }
}

export function parseCarrierWholeShipmentRateResponse(
  prepared: PreparedCarrierWholeShipmentRateRequest,
  input: CarrierWholeShipmentRateResponseInput,
): ParsedCarrierWholeShipmentRateResponse {
  sealPreparedCarrierWholeShipmentRateRequest(prepared)
  const requestedAt = normalizeInstant(input.requestedAt, 'Requested at')
  const completedAt = normalizeInstant(input.completedAt, 'Completed at')
  if (Date.parse(completedAt) < Date.parse(requestedAt)) {
    throw new Error('Carrier rate completion cannot precede its request')
  }
  const expected = prepared.redactedRequest.expectedCurrency
  const rates = prepared.provider === 'ups_rest'
    ? parseUps(input.payload, expected)
    : parseFedex(input.payload, expected)
  if (rates.length < 1) {
    throw new Error('Carrier rate response did not contain a usable rate')
  }
  const providerReference = input.providerReference === undefined
    || input.providerReference === null
    ? null
    : plainText(input.providerReference, 'Provider reference', 160)
  const redactedResponse = {
    adapterVersion: 'carrier-whole-shipment-rate-v1' as const,
    accessMode: 'rate_read_only' as const,
    providerMutationCount: 0 as const,
    provider: prepared.provider,
    environment: prepared.environment,
    endpoint: prepared.endpoint,
    endpointVersion: prepared.endpointVersion,
    purpose: 'fulfillment_execution' as const,
    rateScope: 'multi_package_shipment' as const,
    expectedCurrency: expected,
    packageCount: prepared.redactedRequest.packageCount,
    rateCount: rates.length,
    rates,
  }
  return deepFreeze({
    provider: prepared.provider,
    environment: prepared.environment,
    purpose: 'fulfillment_execution',
    rateScope: 'multi_package_shipment',
    expectedCurrency: expected,
    packageCount: prepared.redactedRequest.packageCount,
    rates,
    evidence: {
      requestHash: prepared.requestHash,
      providerPayloadHash: hash({
        version: 'carrier-rate-provider-response-v1',
        provider: prepared.provider,
        environment: prepared.environment,
        payload: input.payload,
      }),
      redactedRequest: prepared.redactedRequest,
      redactedResponse,
      providerReference,
      requestedAt,
      completedAt,
    },
  })
}
