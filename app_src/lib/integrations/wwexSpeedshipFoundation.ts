import { createHash } from 'node:crypto'

/**
 * Pure request/response contracts for the WWEX SpeedShip v1.9b flows.
 *
 * This module performs no network or token work. Prepared bodies contain the
 * operational shipment data required by SpeedShip and are therefore ephemeral;
 * callers should persist only the redacted evidence and hashes returned here.
 * Cancellation is intentionally absent because the supplied v1.9b collection
 * has duplicate keys and does not unambiguously identify the pickup identifier.
 */

export const WWEX_SPEEDSHIP_ADAPTER_VERSION = 'wwex-speedship-v1' as const
export const WWEX_SPEEDSHIP_PROVIDER = 'wwex_speedship' as const
export const WWEX_SPEEDSHIP_FLOW_PATHS = {
  shopFlow: '/svc/shopFlow',
  schedulePickupFlow: '/svc/schedulePickupFlow',
  integratedOrderFlow: '/svc/integratedOrderFlow',
  quoteOrderFlow: '/svc/quoteOrderFlow',
} as const

export type WwexSpeedshipTransportMode = 'small_parcel' | 'ltl'
export type WwexSpeedshipContact = {
  firstName?: string | null
  lastName: string
  phone: string
  email?: string | null
}

export type WwexSpeedshipAddress = {
  line1: string
  line2?: string | null
  locality: string
  region: string
  postalCode: string
  countryCode: string
  companyName: string
  phone: string
  contact: WwexSpeedshipContact
  residential: boolean
  locationType?: string | null
}

export type WwexSpeedshipReference = {
  type: string
  value: string
  isPrintAsBarCode: boolean
}

export type WwexSmallpackPackage = {
  packageKey: string
  packagingType: string
  length: number
  width: number
  height: number
  weight: number
  references?: WwexSpeedshipReference[]
  insuredValueUsd?: string | number | null
  codAmountUsd?: string | number | null
}

export type WwexSmallpackShopInput = {
  credentialVersion: number
  credentialFingerprint: string
  planId: string
  correlationId: string
  shipmentDate: string
  shipmentDescription?: string | null
  origin: WwexSpeedshipAddress
  destination: WwexSpeedshipAddress
  packages: WwexSmallpackPackage[]
  codPaymentMethods?: Array<
    'CASHIERS_CHECK' | 'PERSONAL_CHECKS' | 'CHECKS_MONEY_ORDERS'
  >
  deliveryConfirmation?: boolean
  carbonNeutral?: boolean
  adultSignatureRequired?: boolean
  signatureRequired?: boolean
  shipperRelease?: boolean
  selfScheduled?: boolean
  returnLabel?: boolean
  returnServiceType?:
    | '1DM'
    | '1DA'
    | '1DP'
    | '2DM'
    | '2DA'
    | '3DS'
    | 'GND'
    | null
}

export type WwexLtlCommodity = {
  commodityKey: string
  commodityClass: string
  description: string
  packagingType: string
  quantity: number
  weight: number
  nmfcNumber?: string | null
  nmfcDescription?: string | null
}

export type WwexLtlPallet = {
  palletKey: string
  length: number
  width: number
  height: number
  weight: number
  isStackable: boolean
  isMixedClass: boolean
  marksAndNumbers?: string | null
  commodities: WwexLtlCommodity[]
}

export type WwexLtlAccessorials = {
  appointmentDelivery?: boolean
  deliveryConfirmation?: boolean
  directDeliveryOnly?: boolean
  holdAtTerminal?: boolean
  insideDelivery?: boolean
  insidePickup?: boolean
  carrierTerminalPickup?: boolean
  liftgateDelivery?: boolean
  liftgatePickup?: boolean
  notifyBeforeDelivery?: boolean
  protectionFromCold?: boolean
  protectionFromHeat?: boolean
  signatureRequired?: boolean
  sortAndSegregate?: boolean
  tradeshowDelivery?: boolean
  tradeshowDeliveryName?: string | null
  tradeshowPickup?: boolean
  tradeshowPickupName?: string | null
}

export type WwexLtlShopInput = {
  credentialVersion: number
  credentialFingerprint: string
  planId: string
  correlationId: string
  shipmentDate: string
  origin: WwexSpeedshipAddress
  destination: WwexSpeedshipAddress
  pallets: WwexLtlPallet[]
  shipmentReferences?: WwexSpeedshipReference[]
  accessorials?: WwexLtlAccessorials
  pickupSpecialInstructions?: string | null
  deliverySpecialInstructions?: string | null
}

type WwexSafeAddress = {
  addressFingerprint: string
  locationFingerprint: string
  region: string
  countryCode: string
  residential: boolean
}

export type WwexSpeedshipShopRequestEvidence = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'prepare_only'
  providerMutationCount: 0
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  flow: 'shopFlow'
  credentialVersion: number
  credentialFingerprint: string
  planId: string
  planHash: string
  correlationId: string
  isInternational: boolean
  shipmentDate: string
  origin: WwexSafeAddress
  destination: WwexSafeAddress
  handlingUnitCount: number
  totalWeight: number
  handlingUnits: Array<Record<string, unknown>>
  accessorials: Record<string, boolean | string | null>
  expectedExecutingCarrier: {
    vendorId: 'UPS'
    name: 'UPS'
  } | null
}

export type PreparedWwexSpeedshipShopRequest = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'prepare_only'
  providerMutationCount: 0
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  flow: 'shopFlow'
  path: typeof WWEX_SPEEDSHIP_FLOW_PATHS.shopFlow
  method: 'POST'
  planId: string
  planHash: string
  requestHash: string
  body: Record<string, unknown>
  evidence: WwexSpeedshipShopRequestEvidence
}

export type SealedWwexSpeedshipShopRequest = Omit<
  PreparedWwexSpeedshipShopRequest,
  'body'
>

export type WwexSpeedshipExecutingCarrier = {
  vendorId: string
  name: string
  scac: string
}

export type WwexSpeedshipCharge = {
  code: string | null
  category: string | null
  description: string | null
  amount: string
  currency: 'USD'
}

export type WwexSpeedshipOffer = {
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  planId: string
  planHash: string
  productTransactionId: string
  offerId: string
  offeredProductId: string
  executingCarrier: WwexSpeedshipExecutingCarrier
  serviceCode: string
  serviceName: string
  amount: string
  currency: 'USD'
  transitDays: number | null
  estimatedDeliveryDate: string | null
  expiresAt: string
  eligible: boolean
  ineligibleReason: string | null
  charges: WwexSpeedshipCharge[]
}

export type ParsedWwexSpeedshipShopResponse = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  planId: string
  planHash: string
  productTransactionId: string
  offers: WwexSpeedshipOffer[]
  resultHash: string
  evidence: {
    requestHash: string
    providerPayloadHash: string
    correlationId: string | null
    apiVersion: string | null
    offerCount: number
    shopRequest: WwexSpeedshipShopRequestEvidence
  }
}

export type WwexSmallpackSchedulePickupInput = {
  pickupPlanId: string
  shop: ParsedWwexSpeedshipShopResponse
  pickupDate: string
  pickupAddress: WwexSpeedshipAddress
  timeZone: string
  readyTime: string
  closeTime: string
  alternateAddress: boolean
  saturdayAvailable: boolean
  selfScheduled: boolean
  correlationId: string
}

export type WwexSmallpackSchedulePickupEvidence = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'prepare_only'
  providerMutationCount: 0
  providerOperationIsMutation: true
  providerIdempotencySupported: false
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: 'small_parcel'
  flow: 'schedulePickupFlow'
  credentialVersion: number
  credentialFingerprint: string
  pickupPlanId: string
  pickupPlanHash: string
  correlationId: string
  shipmentPlanIds: string[]
  shipmentPlanHashes: string[]
  shipmentProductTransactionIds: string[]
  pickupDate: string
  readyTime: string
  closeTime: string
  pickupAddress: WwexSafeAddress
  timeZone: string
  alternateAddress: boolean
  residential: boolean
  saturdayAvailable: boolean
  selfScheduled: boolean
  executingCarrier: { vendorId: 'UPS'; name: 'UPS' }
}

export type PreparedWwexSmallpackSchedulePickupRequest = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'prepare_only'
  providerMutationCount: 0
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: 'small_parcel'
  flow: 'schedulePickupFlow'
  path: typeof WWEX_SPEEDSHIP_FLOW_PATHS.schedulePickupFlow
  method: 'POST'
  pickupPlanId: string
  pickupPlanHash: string
  requestHash: string
  body: Record<string, unknown>
  evidence: WwexSmallpackSchedulePickupEvidence
}

export type SealedWwexSmallpackSchedulePickupRequest = Omit<
  PreparedWwexSmallpackSchedulePickupRequest,
  'body'
>

export type WwexSmallpackPickupOffer = {
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: 'small_parcel'
  pickupPlanId: string
  pickupPlanHash: string
  shipmentProductTransactionIds: string[]
  pickupProductTransactionId: string
  pickupOfferId: string
  pickupOfferedProductId: string
  executingCarrier: WwexSpeedshipExecutingCarrier
  amount: string
  currency: 'USD'
  expiresAt: string
  matchedRequestedPickupTime: boolean | null
}

export type ParsedWwexSmallpackSchedulePickupResponse = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: 'small_parcel'
  pickupPlanId: string
  pickupPlanHash: string
  offers: WwexSmallpackPickupOffer[]
  resultHash: string
  evidence: {
    requestHash: string
    providerPayloadHash: string
    correlationId: string | null
    apiVersion: string | null
    offerCount: number
    pickupRequest: WwexSmallpackSchedulePickupEvidence
  }
}

export type WwexSmallpackTenderInput = {
  tenderPlanId: string
  shop: ParsedWwexSpeedshipShopResponse
  selectedOfferId: string
  selectedOfferedProductId: string
  pickup: ParsedWwexSmallpackSchedulePickupResponse
  selectedPickupOfferId: string
  selectedPickupOfferedProductId: string
  billToType: 'SENDER' | 'RECEIVER' | 'THIRD_PARTY' | 'CONSIGNEE'
  billToAccountNumber: string
  billToAccountFingerprint: string
  billToPostalCode: string
  billToCountryCode: string
  sendersReceipt: boolean
  internationalFormsPrepared: boolean
  tenderedAtLocal: string
  correlationId: string
}

export type WwexLtlTenderInput = {
  tenderPlanId: string
  shop: ParsedWwexSpeedshipShopResponse
  selectedOfferId: string
  selectedOfferedProductId: string
  origin: WwexSpeedshipAddress
  destination: WwexSpeedshipAddress
  shipmentReferences?: WwexSpeedshipReference[]
  pickupDate: string
  readyTime: string
  closeTime: string
  selfScheduled: boolean
  internationalFormsPrepared: boolean
  tenderedAtLocal: string
  pickupSpecialInstructions?: string | null
  deliverySpecialInstructions?: string | null
  specialInstructions?: string | null
}

export type WwexSpeedshipTenderEvidence = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'tender_prepare_only'
  providerMutationCount: 0
  providerOperationIsMutation: true
  providerIdempotencySupported: false
  retryDisposition: 'outcome_unknown_requires_reconciliation'
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  flow: 'integratedOrderFlow' | 'quoteOrderFlow'
  tenderPlanId: string
  tenderPlanHash: string
  shopPlanId: string
  shopPlanHash: string
  shipmentProductTransactionId: string
  shipmentOfferId: string
  offeredProductId: string
  pickupPlanId: string | null
  pickupPlanHash: string | null
  pickupOfferId: string | null
  pickupOfferedProductId: string | null
  pickupProductTransactionId: string | null
  executingCarrier: WwexSpeedshipExecutingCarrier
  isInternational: boolean
  internationalFormsPrepared: boolean
  tenderedAtLocal: string
  originLocationFingerprint: string
  destinationLocationFingerprint: string
  credentialVersion: number
  credentialFingerprint: string
  billToAccountBinding: string | null
}

export type PreparedWwexSpeedshipTenderRequest = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  accessMode: 'tender_prepare_only'
  providerMutationCount: 0
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  flow: 'integratedOrderFlow' | 'quoteOrderFlow'
  path:
    | typeof WWEX_SPEEDSHIP_FLOW_PATHS.integratedOrderFlow
    | typeof WWEX_SPEEDSHIP_FLOW_PATHS.quoteOrderFlow
  method: 'POST'
  tenderPlanId: string
  tenderPlanHash: string
  requestHash: string
  body: Record<string, unknown>
  evidence: WwexSpeedshipTenderEvidence
}

export type SealedWwexSpeedshipTenderRequest = Omit<
  PreparedWwexSpeedshipTenderRequest,
  'body'
>

export type WwexSpeedshipTenderDocument = {
  s3FileName: string
  docType: string
  docFormat: string
  name: string
}

export type ParsedWwexSpeedshipTenderResponse = {
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  tenderPlanId: string
  tenderPlanHash: string
  executingCarrier: WwexSpeedshipExecutingCarrier
  pickupOrderId: string
  pickupTransactionId: string
  shipmentOrderId: string
  quoteNumber: string | null
  secondaryTransactionIds: Array<{ type: string; value: string }>
  documents: WwexSpeedshipTenderDocument[]
  resultHash: string
  evidence: {
    requestHash: string
    providerPayloadHash: string
    correlationId: string | null
    apiVersion: string | null
    tender: WwexSpeedshipTenderEvidence
  }
}

export type WwexSpeedshipPartialTenderReconciliation = Readonly<{
  adapterVersion: typeof WWEX_SPEEDSHIP_ADAPTER_VERSION
  provider: typeof WWEX_SPEEDSHIP_PROVIDER
  transportMode: WwexSpeedshipTransportMode
  flow: 'integratedOrderFlow' | 'quoteOrderFlow'
  requestHash: string
  providerPayloadHash: string
  providerIds: Readonly<{
    pickupOrderId: string | null
    pickupTransactionId: string | null
    shipmentOrderId: string | null
    quoteNumber: string | null
  }>
  missingRequiredEvidence: readonly (
    | 'pickup_order_id'
    | 'pickup_transaction_id'
    | 'shipment_order_id'
    | 'quote_number'
    | 'shipment_documents'
  )[]
}>

export class WwexSpeedshipPartialTenderOutcomeError extends Error {
  readonly code = 'WWEX_SPEEDSHIP_PARTIAL_TENDER_OUTCOME' as const
  readonly reconciliation: WwexSpeedshipPartialTenderReconciliation

  constructor(reconciliation: WwexSpeedshipPartialTenderReconciliation) {
    super(
      `Worldwide Express ${reconciliation.flow} response omitted required tender evidence: ${reconciliation.missingRequiredEvidence.join(', ')}`,
    )
    this.name = 'WwexSpeedshipPartialTenderOutcomeError'
    this.reconciliation = deepFreeze(reconciliation)
  }
}

export const WWEX_SMALLPACK_PACKAGING_TYPES = Object.freeze({
  '01': 'UPS Express Envelope',
  '02': 'Custom',
  '03': 'UPS Express Tube',
  '04': 'UPS Express Pak',
  '21': 'UPS Express Box',
  '24': 'UPS 25KG Box',
  '25': 'UPS 10KG Box',
  '2a': 'UPS Express Box Small',
  '2b': 'UPS Express Box Medium',
  '2c': 'UPS Express Box Large',
} as const)

export const WWEX_LTL_PACKAGING_TYPES = Object.freeze([
  'BAG', 'BALE', 'BOX', 'BUNDLE', 'CARTON', 'CASE', 'CRATE', 'DRUM',
  'PAIL', 'PLT', 'PIECES', 'REEL', 'ROLL', 'SKID', 'TANK', 'TRAILER',
] as const)
const SMALLPACK_PACKAGING: Readonly<Record<string, string>> =
  WWEX_SMALLPACK_PACKAGING_TYPES
const LTL_PACKAGING = new Set<string>(WWEX_LTL_PACKAGING_TYPES)
const SMALLPACK_LOCATION_TYPES = new Set([
  'AIRPORT', 'CARRIER_TERMINAL', 'CEMETERY', 'CHURCH',
  'CONTAINER_FREIGHT_STATION', 'CONSTRUCTION', 'COUNTRY_OR_GOLF_CLUB',
  'DISTRIBUTION_CENTER', 'FARM', 'GOVERNMENT_FACILITY', 'HOTEL_OR_MOTEL',
  'HOSPITAL', 'LIMITED_ACCESS', 'MALL_OR_SHOPPING_CENTER', 'MILITARY',
  'MINE', 'MINI_STORAGE_FACILITY', 'NURSING_HOME', 'PARK',
  'PIER_PORT_WARF', 'PRISON', 'RESIDENTIAL', 'SECURED_LOCATION', 'SCHOOL',
  'TERMINAL', 'UTILITY_SITE', 'OTHER',
])
const LTL_LOCATION_TYPES = new Set([
  'AIRPORT', 'CARRIER_TERMINAL', 'COMMERCIAL', 'CONSTRUCTION',
  'CONTAINER_FREIGHT_STATION', 'DISTRIBUTION_CENTER', 'PIER_PORT_WARF',
  'GOVERNMENT_FACILITY', 'LIMITED_ACCESS', 'RESIDENTIAL',
  'SECURED_ACCESS', 'TRADE_SHOW',
])
const COD_METHODS = new Set([
  'CASHIERS_CHECK', 'PERSONAL_CHECKS', 'CHECKS_MONEY_ORDERS',
])
const RETURN_SERVICES = new Set([
  '1DM', '1DA', '1DP', '2DM', '2DA', '3DS', 'GND',
])
const SHA256 = /^[a-f0-9]{64}$/i
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
// Keep provider parsing aligned with the canonical transport and persistence
// boundary: a SCAC is two to four uppercase letters.
const SCAC = /^[A-Z]{2,4}$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{2}):(\d{2}):(\d{2})$/
const MONEY = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/

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

function record(value: unknown, label = 'Value'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function providerList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported fields`)
  }
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

function optionalText(value: unknown, label: string, maximum: number) {
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

function identifier(value: unknown, label: string) {
  const normalized = plainText(value, label, 200)
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`)
  return normalized
}

function fingerprint(value: unknown, label: string) {
  if (typeof value !== 'string' || !SHA256.test(value.trim())) {
    throw new Error(`${label} must be a SHA-256 fingerprint`)
  }
  return value.trim().toLowerCase()
}

function credentialBinding(
  versionValue: unknown,
  fingerprintValue: unknown,
  label: string,
) {
  return {
    credentialVersion: positiveInteger(
      versionValue,
      `${label} version`,
      2_147_483_647,
    ),
    credentialFingerprint: fingerprint(
      fingerprintValue,
      `${label} fingerprint`,
    ),
  }
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`)
  return value
}

function optionalBoolean(value: unknown, label: string, fallback = false) {
  return value === undefined ? fallback : booleanValue(value, label)
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`)
  }
  return Number(value)
}

function normalizeMoney(value: unknown, label: string, allowZero = false) {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (!MONEY.test(candidate)) throw new Error(`${label} must be a USD amount`)
  const amount = Number(candidate)
  if (!Number.isSafeInteger(Math.round(amount * 100)) || (!allowZero && amount <= 0)) {
    throw new Error(`${label} must be a valid USD amount`)
  }
  return amount.toFixed(2)
}

function validCalendarDate(year: number, month: number, day: number) {
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function dateTime(value: unknown, label: string) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use YYYY-MM-DD HH:MM:SS`)
  }
  const match = DATE_TIME.exec(value)
  if (!match) throw new Error(`${label} must use YYYY-MM-DD HH:MM:SS`)
  const [, year, month, day, hour, minute, second] = match.map(Number)
  if (
    !validCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
  ) throw new Error(`${label} is not a valid local date and time`)
  return value
}

function calendarDate(value: unknown, label: string) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use YYYY-MM-DD`)
  }
  const match = DATE.exec(value)
  if (!match || !validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    throw new Error(`${label} must use a valid YYYY-MM-DD date`)
  }
  return value
}

function optionalCalendarDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  return calendarDate(value, label)
}

function clockTime(value: unknown, label: string) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error(`${label} must use HH:MM:SS`)
  }
  const match = TIME.exec(value)
  if (
    !match
    || Number(match[1]) > 23
    || Number(match[2]) > 59
    || Number(match[3]) > 59
  ) throw new Error(`${label} must use a valid HH:MM:SS time`)
  return value
}

function countryCode(value: unknown, label: string) {
  const normalized = plainText(value, label, 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(`${label} must be a two-letter country code`)
  }
  return normalized
}

function phone(value: unknown, label: string) {
  const normalized = plainText(value, label, 24)
  if (!/^\+?[0-9() .-]+$/.test(normalized)) {
    throw new Error(`${label} contains unsupported phone characters`)
  }
  const digits = normalized.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) {
    throw new Error(`${label} must contain 7-15 digits`)
  }
  return normalized
}

function email(value: unknown, label: string) {
  const normalized = optionalText(value, label, 254)
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function normalizeAddress(
  value: unknown,
  label: string,
  mode: WwexSpeedshipTransportMode,
) {
  const input = record(value, label)
  assertOnlyKeys(input, [
    'line1', 'line2', 'locality', 'region', 'postalCode', 'countryCode',
    'companyName', 'phone', 'contact', 'residential', 'locationType',
  ], label)
  const contactInput = record(input.contact, `${label} contact`)
  assertOnlyKeys(
    contactInput,
    ['firstName', 'lastName', 'phone', 'email'],
    `${label} contact`,
  )
  const locationType = optionalText(input.locationType, `${label} location type`, 40)
  const allowedLocationTypes = mode === 'small_parcel'
    ? SMALLPACK_LOCATION_TYPES
    : LTL_LOCATION_TYPES
  if (locationType && !allowedLocationTypes.has(locationType.toUpperCase())) {
    throw new Error(`${label} location type is not supported by SpeedShip v1.9b`)
  }
  const line2 = optionalText(input.line2, `${label} address line 2`, 120)
  const normalized = {
    line1: plainText(input.line1, `${label} address line 1`, 160),
    line2,
    locality: plainText(input.locality, `${label} locality`, 100),
    region: plainText(input.region, `${label} region`, 3).toUpperCase(),
    postalCode: plainText(input.postalCode, `${label} postal code`, 16).toUpperCase(),
    countryCode: countryCode(input.countryCode, `${label} country code`),
    companyName: plainText(input.companyName, `${label} company`, 120),
    phone: phone(input.phone, `${label} phone`),
    contact: {
      firstName: optionalText(contactInput.firstName, `${label} contact first name`, 80),
      lastName: plainText(contactInput.lastName, `${label} contact last name`, 80),
      phone: phone(contactInput.phone, `${label} contact phone`),
      email: email(contactInput.email, `${label} contact email`),
    },
    residential: booleanValue(input.residential, `${label} residential classification`),
    locationType: locationType ? locationType.toUpperCase() : null,
  }
  return normalized
}

function safeAddress(address: ReturnType<typeof normalizeAddress>): WwexSafeAddress {
  const location = {
    locality: address.locality,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  }
  return {
    addressFingerprint: hash({ version: 'wwex-speedship-address-v1', address }),
    locationFingerprint: hash({ version: 'wwex-speedship-location-v1', location }),
    region: address.region,
    countryCode: address.countryCode,
    residential: address.residential,
  }
}

function providerStop(
  address: ReturnType<typeof normalizeAddress>,
  contactType: 'SENDER' | 'RECEIVER',
) {
  return {
    address: {
      addressLineList: [address.line1, ...(address.line2 ? [address.line2] : [])],
      locality: address.locality,
      region: address.region,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      companyName: address.companyName,
      phone: address.phone,
      contactList: [{
        ...(address.contact.firstName ? { firstName: address.contact.firstName } : {}),
        lastName: address.contact.lastName,
        phone: address.contact.phone,
        contactType,
        ...(address.contact.email ? { email: address.contact.email } : {}),
      }],
    },
    ...(address.locationType ? { locationType: address.locationType } : {}),
  }
}

function normalizeReferences(value: unknown, label: string, maximum: number) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain no more than ${maximum} references`)
  }
  return value.map((item, index) => {
    const input = record(item, `${label} ${index + 1}`)
    assertOnlyKeys(input, ['type', 'value', 'isPrintAsBarCode'], `${label} ${index + 1}`)
    const reference = {
      type: plainText(input.type, `${label} ${index + 1} type`, 80),
      value: plainText(input.value, `${label} ${index + 1} value`, 120),
      isPrintAsBarCode: booleanValue(
        input.isPrintAsBarCode,
        `${label} ${index + 1} barcode flag`,
      ),
    }
    if (reference.isPrintAsBarCode && !/^\d+$/.test(reference.value)) {
      throw new Error(`${label} barcode values must contain digits only`)
    }
    return reference
  })
}

function normalizeSmallpackPackage(value: unknown, index: number) {
  const input = record(value, `Small parcel package ${index + 1}`)
  assertOnlyKeys(input, [
    'packageKey', 'packagingType', 'length', 'width', 'height', 'weight',
    'references', 'insuredValueUsd', 'codAmountUsd',
  ], `Small parcel package ${index + 1}`)
  const packagingType = plainText(
    input.packagingType,
    `Small parcel package ${index + 1} packaging type`,
    2,
  )
  const packagingTypeName = SMALLPACK_PACKAGING[packagingType]
  if (!packagingTypeName) {
    throw new Error('Small parcel packaging type is not supported by SpeedShip v1.9b')
  }
  return {
    packageKey: identifier(input.packageKey, `Small parcel package ${index + 1} key`),
    packagingType,
    packagingTypeName,
    length: positiveInteger(input.length, `Small parcel package ${index + 1} length`, 108),
    width: positiveInteger(input.width, `Small parcel package ${index + 1} width`, 108),
    height: positiveInteger(input.height, `Small parcel package ${index + 1} height`, 108),
    weight: positiveInteger(input.weight, `Small parcel package ${index + 1} weight`, 150),
    references: normalizeReferences(
      input.references,
      `Small parcel package ${index + 1} references`,
      2,
    ),
    insuredValueUsd: input.insuredValueUsd === undefined || input.insuredValueUsd === null
      ? null
      : normalizeMoney(input.insuredValueUsd, `Small parcel package ${index + 1} insured value`),
    codAmountUsd: input.codAmountUsd === undefined || input.codAmountUsd === null
      ? null
      : normalizeMoney(input.codAmountUsd, `Small parcel package ${index + 1} COD amount`),
  }
}

function normalizeCodMethods(value: unknown, isCod: boolean) {
  if (value === undefined) {
    if (isCod) throw new Error('COD payment methods are required when COD is requested')
    return []
  }
  if (!Array.isArray(value) || value.some((item) => !COD_METHODS.has(String(item)))) {
    throw new Error('COD payment methods contain an unsupported value')
  }
  const methods = [...new Set(value.map(String))]
  if (isCod && methods.length === 0) throw new Error('At least one COD payment method is required')
  if (!isCod && methods.length > 0) throw new Error('COD payment methods require a COD package amount')
  return methods
}

function preparedShop(
  mode: WwexSpeedshipTransportMode,
  planId: string,
  correlationId: string,
  body: Record<string, unknown>,
  evidenceInput: Omit<
    WwexSpeedshipShopRequestEvidence,
    'adapterVersion' | 'accessMode' | 'providerMutationCount' | 'provider'
    | 'transportMode' | 'flow' | 'planId' | 'planHash' | 'correlationId'
  >,
) {
  const planHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    planId,
    shipment: optionalRecord(optionalRecord(body.request).shipment),
  })
  const evidence: WwexSpeedshipShopRequestEvidence = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'prepare_only',
    providerMutationCount: 0,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    flow: 'shopFlow',
    planId,
    planHash,
    correlationId,
    ...evidenceInput,
  }
  const requestHash = hash({ flow: 'shopFlow', planHash, body, evidence })
  return deepFreeze({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'prepare_only' as const,
    providerMutationCount: 0 as const,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    flow: 'shopFlow' as const,
    path: WWEX_SPEEDSHIP_FLOW_PATHS.shopFlow,
    method: 'POST' as const,
    planId,
    planHash,
    requestHash,
    body,
    evidence,
  })
}

export function prepareWwexSmallpackShopRequest(
  value: WwexSmallpackShopInput,
): PreparedWwexSpeedshipShopRequest {
  const input = record(value, 'Small parcel shop input')
  assertOnlyKeys(input, [
    'credentialVersion', 'credentialFingerprint',
    'planId', 'correlationId', 'shipmentDate', 'shipmentDescription',
    'origin', 'destination', 'packages', 'codPaymentMethods',
    'deliveryConfirmation', 'carbonNeutral', 'adultSignatureRequired',
    'signatureRequired', 'shipperRelease', 'selfScheduled', 'returnLabel',
    'returnServiceType',
  ], 'Small parcel shop input')
  const binding = credentialBinding(
    input.credentialVersion,
    input.credentialFingerprint,
    'Small parcel credential',
  )
  const planId = identifier(input.planId, 'Small parcel plan ID')
  const correlationId = identifier(input.correlationId, 'Small parcel correlation ID')
  const shipmentDate = dateTime(input.shipmentDate, 'Small parcel shipment date')
  const origin = normalizeAddress(input.origin, 'Small parcel origin', 'small_parcel')
  const destination = normalizeAddress(
    input.destination,
    'Small parcel destination',
    'small_parcel',
  )
  if (!Array.isArray(input.packages) || input.packages.length < 1 || input.packages.length > 50) {
    throw new Error('Small parcel plan must contain 1-50 loose packages')
  }
  const packages = input.packages.map(normalizeSmallpackPackage)
  if (new Set(packages.map((item) => item.packageKey)).size !== packages.length) {
    throw new Error('Small parcel package keys must be unique')
  }
  const isInternational = origin.countryCode !== destination.countryCode
  if (isInternational) {
    throw new Error(
      'International SMALLPACK rating requires UPS billing and forms inputs not included in this foundation',
    )
  }
  const isCod = packages.some((item) => item.codAmountUsd !== null)
  const codMethods = normalizeCodMethods(input.codPaymentMethods, isCod)
  const returnLabel = optionalBoolean(input.returnLabel, 'Return label flag')
  const returnServiceType = input.returnServiceType === undefined || input.returnServiceType === null
    ? null
    : plainText(input.returnServiceType, 'Return service type', 3)
  if (returnServiceType && !RETURN_SERVICES.has(returnServiceType)) {
    throw new Error('Return service type is not supported by SpeedShip v1.9b')
  }
  if (returnLabel !== Boolean(returnServiceType)) {
    throw new Error('Return labels require exactly one supported return service type')
  }
  const totalWeight = packages.reduce((sum, item) => sum + item.weight, 0)
  const shipment = {
    shipmentDate,
    originAddress: providerStop(origin, 'SENDER'),
    destinationAddress: providerStop(destination, 'RECEIVER'),
    handlingUnitList: packages.map((item) => ({
      billedDimension: {
        length: { value: item.length, unit: 'IN' },
        width: { value: item.width, unit: 'IN' },
        height: { value: item.height, unit: 'IN' },
      },
      packagingType: item.packagingType,
      packagingTypeName: item.packagingTypeName,
      quantity: 1,
      referenceList: item.references,
      shippedItemList: [{
        ...(item.insuredValueUsd
          ? { insuredValue: { value: item.insuredValueUsd, unit: 'USD' } }
          : {}),
        ...(item.codAmountUsd
          ? { codAmount: { value: item.codAmountUsd, unit: 'USD' } }
          : {}),
        isHazMat: false,
      }],
      weight: { value: item.weight, unit: 'LB' },
    })),
    totalHandlingUnitCount: packages.length,
    totalWeight: { value: totalWeight, unit: 'LB' },
    insuranceRequestFlag: packages.some((item) => item.insuredValueUsd !== null),
    isCOD: isCod,
    allowedCODPaymentMethodsList: codMethods,
    deliveryConfirmationFlag: optionalBoolean(
      input.deliveryConfirmation,
      'Delivery confirmation flag',
    ),
    isCarbonNeutral: optionalBoolean(input.carbonNeutral, 'Carbon neutral flag'),
    adultSignatureRequiredFlag: optionalBoolean(
      input.adultSignatureRequired,
      'Adult signature flag',
    ),
    isSignatureRequired: optionalBoolean(input.signatureRequired, 'Signature flag'),
    isSelfScheduled: optionalBoolean(input.selfScheduled, 'Self-scheduled flag'),
    residentialDeliveryFlag: destination.residential,
    residentialPickupFlag: origin.residential,
    shipperReleaseFlag: optionalBoolean(input.shipperRelease, 'Shipper release flag'),
    returnLabelFlag: returnLabel,
    returnServiceType,
    description: optionalText(input.shipmentDescription, 'Shipment description', 500),
  }
  const body = { request: { productType: 'SMALLPACK', shipment }, correlationId }
  return preparedShop('small_parcel', planId, correlationId, body, {
    ...binding,
    isInternational,
    shipmentDate,
    origin: safeAddress(origin),
    destination: safeAddress(destination),
    handlingUnitCount: packages.length,
    totalWeight,
    handlingUnits: packages.map((item) => ({
      packageKey: item.packageKey,
      packagingType: item.packagingType,
      length: item.length,
      width: item.width,
      height: item.height,
      weight: item.weight,
      referenceCount: item.references.length,
      insured: item.insuredValueUsd !== null,
      cod: item.codAmountUsd !== null,
    })),
    accessorials: {
      deliveryConfirmation: shipment.deliveryConfirmationFlag,
      carbonNeutral: shipment.isCarbonNeutral,
      adultSignatureRequired: shipment.adultSignatureRequiredFlag,
      signatureRequired: shipment.isSignatureRequired,
      shipperRelease: shipment.shipperReleaseFlag,
      selfScheduled: shipment.isSelfScheduled,
      residentialDelivery: destination.residential,
      residentialPickup: origin.residential,
      returnLabel,
      returnServiceType,
      cod: isCod,
      insurance: shipment.insuranceRequestFlag,
    },
    expectedExecutingCarrier: { vendorId: 'UPS', name: 'UPS' },
  })
}

function normalizeLtlCommodity(value: unknown, palletIndex: number, itemIndex: number) {
  const label = `LTL pallet ${palletIndex + 1} commodity ${itemIndex + 1}`
  const input = record(value, label)
  assertOnlyKeys(input, [
    'commodityKey', 'commodityClass', 'description', 'packagingType',
    'quantity', 'weight', 'nmfcNumber', 'nmfcDescription',
  ], label)
  const commodityClass = plainText(input.commodityClass, `${label} class`, 5)
  const classNumber = Number(commodityClass)
  if (!/^\d{2,3}(?:\.5)?$/.test(commodityClass) || classNumber < 50 || classNumber > 500) {
    throw new Error(`${label} class must be a valid 50-500 freight class`)
  }
  const packagingType = plainText(input.packagingType, `${label} packaging type`, 16).toUpperCase()
  if (!LTL_PACKAGING.has(packagingType)) {
    throw new Error(`${label} packaging type is not supported by SpeedShip v1.9b`)
  }
  return {
    commodityKey: identifier(input.commodityKey, `${label} key`),
    commodityClass,
    description: plainText(input.description, `${label} description`, 250),
    packagingType,
    quantity: positiveInteger(input.quantity, `${label} quantity`, 100_000),
    weight: positiveInteger(input.weight, `${label} weight`, 100_000),
    nmfcNumber: optionalText(input.nmfcNumber, `${label} NMFC number`, 30),
    nmfcDescription: optionalText(input.nmfcDescription, `${label} NMFC description`, 250),
  }
}

function normalizeLtlPallet(value: unknown, index: number) {
  const label = `LTL pallet ${index + 1}`
  const input = record(value, label)
  assertOnlyKeys(input, [
    'palletKey', 'length', 'width', 'height', 'weight', 'isStackable',
    'isMixedClass', 'marksAndNumbers', 'commodities',
  ], label)
  if (!Array.isArray(input.commodities) || input.commodities.length < 1 || input.commodities.length > 50) {
    throw new Error(`${label} must contain 1-50 commodities`)
  }
  const commodities = input.commodities.map((item, itemIndex) =>
    normalizeLtlCommodity(item, index, itemIndex))
  if (new Set(commodities.map((item) => item.commodityKey)).size !== commodities.length) {
    throw new Error(`${label} commodity keys must be unique`)
  }
  const weight = positiveInteger(input.weight, `${label} gross weight`, 100_000)
  const commodityWeight = commodities.reduce((sum, item) => sum + item.weight, 0)
  if (commodityWeight > weight) {
    throw new Error(`${label} commodity weight cannot exceed gross pallet weight`)
  }
  const distinctCommodityClasses = new Set(
    commodities.map((item) => item.commodityClass),
  )
  const isMixedClass = distinctCommodityClasses.size > 1
  if (booleanValue(input.isMixedClass, `${label} mixed-class flag`) !== isMixedClass) {
    throw new Error(`${label} mixed-class flag must match its distinct commodity classes`)
  }
  return {
    palletKey: identifier(input.palletKey, `${label} key`),
    length: positiveInteger(input.length, `${label} length`, 636),
    width: positiveInteger(input.width, `${label} width`, 102),
    height: positiveInteger(input.height, `${label} height`, 110),
    weight,
    isStackable: booleanValue(input.isStackable, `${label} stackable flag`),
    isMixedClass,
    marksAndNumbers: optionalText(input.marksAndNumbers, `${label} marks and numbers`, 120),
    commodities,
  }
}

const LTL_ACCESSORIAL_KEYS = [
  'appointmentDelivery', 'deliveryConfirmation', 'directDeliveryOnly',
  'holdAtTerminal', 'insideDelivery', 'insidePickup', 'carrierTerminalPickup',
  'liftgateDelivery', 'liftgatePickup', 'notifyBeforeDelivery',
  'protectionFromCold', 'protectionFromHeat', 'signatureRequired',
  'sortAndSegregate', 'tradeshowDelivery', 'tradeshowDeliveryName',
  'tradeshowPickup', 'tradeshowPickupName',
] as const

function normalizeLtlAccessorials(value: unknown) {
  const input = value === undefined ? {} : record(value, 'LTL accessorials')
  assertOnlyKeys(input, LTL_ACCESSORIAL_KEYS, 'LTL accessorials')
  const tradeshowDelivery = optionalBoolean(
    input.tradeshowDelivery,
    'Trade show delivery flag',
  )
  const tradeshowPickup = optionalBoolean(input.tradeshowPickup, 'Trade show pickup flag')
  const tradeshowDeliveryName = optionalText(
    input.tradeshowDeliveryName,
    'Trade show delivery name',
    120,
  )
  const tradeshowPickupName = optionalText(
    input.tradeshowPickupName,
    'Trade show pickup name',
    120,
  )
  if (tradeshowDelivery !== Boolean(tradeshowDeliveryName)) {
    throw new Error('Trade show delivery requires exactly one trade show name')
  }
  if (tradeshowPickup !== Boolean(tradeshowPickupName)) {
    throw new Error('Trade show pickup requires exactly one trade show name')
  }
  return {
    appointmentDelivery: optionalBoolean(input.appointmentDelivery, 'Appointment delivery flag'),
    deliveryConfirmation: optionalBoolean(input.deliveryConfirmation, 'Delivery confirmation flag'),
    directDeliveryOnly: optionalBoolean(input.directDeliveryOnly, 'Direct delivery flag'),
    holdAtTerminal: optionalBoolean(input.holdAtTerminal, 'Hold at terminal flag'),
    insideDelivery: optionalBoolean(input.insideDelivery, 'Inside delivery flag'),
    insidePickup: optionalBoolean(input.insidePickup, 'Inside pickup flag'),
    carrierTerminalPickup: optionalBoolean(input.carrierTerminalPickup, 'Terminal pickup flag'),
    liftgateDelivery: optionalBoolean(input.liftgateDelivery, 'Liftgate delivery flag'),
    liftgatePickup: optionalBoolean(input.liftgatePickup, 'Liftgate pickup flag'),
    notifyBeforeDelivery: optionalBoolean(input.notifyBeforeDelivery, 'Notify before delivery flag'),
    protectionFromCold: optionalBoolean(input.protectionFromCold, 'Cold protection flag'),
    protectionFromHeat: optionalBoolean(input.protectionFromHeat, 'Heat protection flag'),
    signatureRequired: optionalBoolean(input.signatureRequired, 'Signature flag'),
    sortAndSegregate: optionalBoolean(input.sortAndSegregate, 'Sort and segregate flag'),
    tradeshowDelivery,
    tradeshowDeliveryName,
    tradeshowPickup,
    tradeshowPickupName,
  }
}

// ClawPilot accuracy rule: always rate LTL with full factual street, company,
// phone, and contact data. The provider guide permits temporary validation
// values at shop time; this stricter rule is ours, not a SpeedShip requirement.
export function prepareWwexLtlShopRequest(
  value: WwexLtlShopInput,
): PreparedWwexSpeedshipShopRequest {
  const input = record(value, 'LTL shop input')
  assertOnlyKeys(input, [
    'credentialVersion', 'credentialFingerprint',
    'planId', 'correlationId', 'shipmentDate', 'origin', 'destination',
    'pallets', 'shipmentReferences', 'accessorials',
    'pickupSpecialInstructions', 'deliverySpecialInstructions',
  ], 'LTL shop input')
  const binding = credentialBinding(
    input.credentialVersion,
    input.credentialFingerprint,
    'LTL credential',
  )
  const planId = identifier(input.planId, 'LTL plan ID')
  const correlationId = identifier(input.correlationId, 'LTL correlation ID')
  const shipmentDate = dateTime(input.shipmentDate, 'LTL shipment date')
  const origin = normalizeAddress(input.origin, 'LTL origin', 'ltl')
  const destination = normalizeAddress(input.destination, 'LTL destination', 'ltl')
  if (!Array.isArray(input.pallets) || input.pallets.length < 1 || input.pallets.length > 20) {
    throw new Error('LTL plan must contain 1-20 palletized handling units')
  }
  const pallets = input.pallets.map(normalizeLtlPallet)
  if (new Set(pallets.map((item) => item.palletKey)).size !== pallets.length) {
    throw new Error('LTL pallet keys must be unique')
  }
  const accessorials = normalizeLtlAccessorials(input.accessorials)
  const pickupInstructions = optionalText(
    input.pickupSpecialInstructions,
    'LTL pickup special instructions',
    60,
  )
  const deliveryInstructions = optionalText(
    input.deliverySpecialInstructions,
    'LTL delivery special instructions',
    500,
  )
  const references = normalizeReferences(input.shipmentReferences, 'LTL shipment references', 20)
  const totalWeight = pallets.reduce((sum, item) => sum + item.weight, 0)
  const isInternational = origin.countryCode !== destination.countryCode
  const shipment = {
    shipmentDate,
    ...(isInternational
      ? {
          shipmentForm: {
            allowPaperless: false,
            shipmentFormRequestDetails: [{
              shipmentFormName: 'CI',
              shipmentFormRequestType: 'PRINT_POPULATED',
            }, {
              shipmentFormName: 'CO',
              shipmentFormRequestType: 'PRINT_POPULATED',
            }],
          },
        }
      : {}),
    originAddress: providerStop(origin, 'SENDER'),
    destinationAddress: providerStop(destination, 'RECEIVER'),
    handlingUnitList: pallets.map((pallet) => ({
      billedDimension: {
        length: { value: pallet.length, unit: 'IN' },
        width: { value: pallet.width, unit: 'IN' },
        height: { value: pallet.height, unit: 'IN' },
      },
      isMixedClass: pallet.isMixedClass,
      isStackable: pallet.isStackable,
      marksAndNumbers: pallet.marksAndNumbers,
      packagingType: 'PLT',
      quantity: 1,
      shippedItemList: pallet.commodities.map((commodity) => ({
        commodityClass: commodity.commodityClass,
        commodityDescription: commodity.description,
        isHazMat: false,
        NMFCDescription: commodity.nmfcDescription,
        NMFCNbr: commodity.nmfcNumber,
        packagingType: commodity.packagingType,
        quantity: commodity.quantity,
        weight: { value: commodity.weight, unit: 'LB' },
      })),
      sortAndSegregateFlag: accessorials.sortAndSegregate,
      weight: { value: pallet.weight, unit: 'LB' },
    })),
    totalWeight: { value: totalWeight, unit: 'LB' },
    totalHandlingUnitCount: pallets.length,
    shipmentReferenceList: references,
    insuranceRequestFlag: false,
    isSignatureRequired: accessorials.signatureRequired,
    appointmentDeliveryFlag: accessorials.appointmentDelivery,
    deliveryConfirmationFlag: accessorials.deliveryConfirmation,
    directDeliveryOnlyFlag: accessorials.directDeliveryOnly,
    holdAtTerminalFlag: accessorials.holdAtTerminal,
    insideDeliveryFlag: accessorials.insideDelivery,
    insidePickupFlag: accessorials.insidePickup,
    carrierTerminalPickupFlag: accessorials.carrierTerminalPickup,
    liftgateDeliveryFlag: accessorials.liftgateDelivery,
    liftgatePickupFlag: accessorials.liftgatePickup,
    notifyBeforeDeliveryFlag: accessorials.notifyBeforeDelivery,
    protectionFromColdFlag: accessorials.protectionFromCold,
    protectionFromHeatFlag: accessorials.protectionFromHeat,
    residentialDeliveryFlag: destination.residential,
    residentialPickupFlag: origin.residential,
    sortAndSegregateFlag: accessorials.sortAndSegregate,
    pickupSpecialInstructions: pickupInstructions,
    deliverySpecialInstructions: deliveryInstructions,
    tradeshowDeliveryFlag: accessorials.tradeshowDelivery,
    tradeshowDeliveryName: accessorials.tradeshowDeliveryName,
    tradeshowPickupFlag: accessorials.tradeshowPickup,
    tradeshowPickupName: accessorials.tradeshowPickupName,
  }
  const body = { request: { productType: 'LTL', shipment }, correlationId }
  return preparedShop('ltl', planId, correlationId, body, {
    ...binding,
    isInternational,
    shipmentDate,
    origin: safeAddress(origin),
    destination: safeAddress(destination),
    handlingUnitCount: pallets.length,
    totalWeight,
    handlingUnits: pallets.map((pallet) => ({
      palletKey: pallet.palletKey,
      packagingType: 'PLT',
      length: pallet.length,
      width: pallet.width,
      height: pallet.height,
      weight: pallet.weight,
      isStackable: pallet.isStackable,
      isMixedClass: pallet.isMixedClass,
      commodityCount: pallet.commodities.length,
      commodityClasses: [...new Set(pallet.commodities.map((item) => item.commodityClass))],
    })),
    accessorials: {
      appointmentDelivery: accessorials.appointmentDelivery,
      deliveryConfirmation: accessorials.deliveryConfirmation,
      directDeliveryOnly: accessorials.directDeliveryOnly,
      holdAtTerminal: accessorials.holdAtTerminal,
      insideDelivery: accessorials.insideDelivery,
      insidePickup: accessorials.insidePickup,
      carrierTerminalPickup: accessorials.carrierTerminalPickup,
      liftgateDelivery: accessorials.liftgateDelivery,
      liftgatePickup: accessorials.liftgatePickup,
      notifyBeforeDelivery: accessorials.notifyBeforeDelivery,
      protectionFromCold: accessorials.protectionFromCold,
      protectionFromHeat: accessorials.protectionFromHeat,
      signatureRequired: accessorials.signatureRequired,
      sortAndSegregate: accessorials.sortAndSegregate,
      tradeshowDelivery: accessorials.tradeshowDelivery,
      tradeshowDeliveryNameProvided: Boolean(accessorials.tradeshowDeliveryName),
      tradeshowPickup: accessorials.tradeshowPickup,
      tradeshowPickupNameProvided: Boolean(accessorials.tradeshowPickupName),
      residentialDelivery: destination.residential,
      residentialPickup: origin.residential,
    },
    expectedExecutingCarrier: null,
  })
}

function assertPreparedShop(
  prepared: PreparedWwexSpeedshipShopRequest,
  mode: WwexSpeedshipTransportMode,
) {
  if (mode !== 'small_parcel' && mode !== 'ltl') {
    throw new Error('Prepared SpeedShip shop request has an invalid transport mode')
  }
  const request = optionalRecord(prepared.body.request)
  if (
    prepared.adapterVersion !== WWEX_SPEEDSHIP_ADAPTER_VERSION
    || prepared.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.transportMode !== mode
    || prepared.flow !== 'shopFlow'
    || prepared.path !== WWEX_SPEEDSHIP_FLOW_PATHS.shopFlow
    || prepared.method !== 'POST'
    || prepared.evidence.transportMode !== mode
    || prepared.evidence.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.evidence.planId !== prepared.planId
    || !Number.isSafeInteger(prepared.evidence.credentialVersion)
    || prepared.evidence.credentialVersion < 1
    || !SHA256.test(prepared.evidence.credentialFingerprint)
    || request.productType !== (mode === 'small_parcel' ? 'SMALLPACK' : 'LTL')
  ) throw new Error('Prepared SpeedShip shop request is not compatible with this parser')
  const expectedPlanHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    planId: prepared.planId,
    shipment: optionalRecord(optionalRecord(prepared.body.request).shipment),
  })
  if (
    prepared.planHash !== expectedPlanHash
    || prepared.evidence.planHash !== expectedPlanHash
    || prepared.requestHash !== hash({
      flow: 'shopFlow',
      planHash: expectedPlanHash,
      body: prepared.body,
      evidence: prepared.evidence,
    })
  ) throw new Error('Prepared SpeedShip shop request failed its integrity check')
}

export function sealPreparedWwexSpeedshipShopRequest(
  prepared: PreparedWwexSpeedshipShopRequest,
): SealedWwexSpeedshipShopRequest {
  assertPreparedShop(prepared, prepared.transportMode)
  const seal = { ...prepared } as Partial<PreparedWwexSpeedshipShopRequest>
  delete seal.body
  return deepFreeze(seal as SealedWwexSpeedshipShopRequest)
}

function providerText(value: unknown, label: string, maximum = 200) {
  return plainText(value, label, maximum)
}

function optionalProviderText(value: unknown, label: string, maximum = 200) {
  return optionalText(value, label, maximum)
}

function providerIdentifier(value: unknown, label: string) {
  return identifier(value, label)
}

function usd(value: unknown, label: string): 'USD' {
  if (providerText(value, label, 3).toUpperCase() !== 'USD') {
    throw new Error(`${label} must be USD`)
  }
  return 'USD'
}

function normalizeCharges(value: unknown): WwexSpeedshipCharge[] {
  return providerList(value).map((item, index) => {
    const charge = record(item, `SpeedShip charge ${index + 1}`)
    const price = record(charge.customerPrice, `SpeedShip charge ${index + 1} price`)
    return {
      code: optionalProviderText(
        charge.customerChargeCode ?? charge.itemCode,
        `SpeedShip charge ${index + 1} code`,
        80,
      ),
      category: optionalProviderText(
        charge.chargeCodeCategory ?? charge.chargeCodeCatagory,
        `SpeedShip charge ${index + 1} category`,
        80,
      ),
      description: optionalProviderText(
        charge.customerDescription ?? charge.description,
        `SpeedShip charge ${index + 1} description`,
        200,
      ),
      amount: normalizeMoney(price.value, `SpeedShip charge ${index + 1} amount`, true),
      currency: usd(price.unit, `SpeedShip charge ${index + 1} currency`),
    }
  })
}

function normalizeTransitDays(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  return positiveInteger(
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    'SpeedShip transit days',
    365,
  )
}

function clientSuccess(payload: Record<string, unknown>, flow: string) {
  const status = record(payload.clientStatus, `${flow} client status`)
  if (status.success !== true && status.status !== true) {
    throw new Error(`SpeedShip ${flow} reported failure`)
  }
}

function parseWwexShopResponse(
  prepared: PreparedWwexSpeedshipShopRequest,
  payloadValue: unknown,
  mode: WwexSpeedshipTransportMode,
): ParsedWwexSpeedshipShopResponse {
  assertPreparedShop(prepared, mode)
  const payload = record(payloadValue, 'SpeedShip shop response')
  clientSuccess(payload, 'shopFlow')
  const response = record(payload.response, 'SpeedShip shop response body')
  const productTransactionId = providerIdentifier(
    response.productTransactionId,
    'SpeedShip product transaction ID',
  )
  const offerList = providerList(response.offerList)
  if (offerList.length === 0) throw new Error('SpeedShip shop response did not contain offers')
  const offers: WwexSpeedshipOffer[] = []
  for (const [offerIndex, rawOffer] of offerList.entries()) {
    const offer = record(rawOffer, `SpeedShip offer ${offerIndex + 1}`)
    const vendor = record(offer.primaryVendor, `SpeedShip offer ${offerIndex + 1} vendor`)
    const rawVendorId = providerText(
      vendor.vendorId ?? vendor.vendorID,
      `SpeedShip offer ${offerIndex + 1} vendor ID`,
      80,
    )
    const rawName = providerText(
      vendor.preferredName,
      `SpeedShip offer ${offerIndex + 1} vendor name`,
      120,
    )
    const rawScac = providerText(
      vendor.scac,
      `SpeedShip offer ${offerIndex + 1} SCAC`,
      8,
    ).toUpperCase()
    if (!SCAC.test(rawScac)) throw new Error('SpeedShip offer SCAC is invalid')
    if (mode === 'small_parcel' && rawVendorId.toUpperCase() !== 'UPS') {
      throw new Error('SpeedShip SMALLPACK responses must identify UPS as executing carrier')
    }
    const executingCarrier = mode === 'small_parcel'
      ? { vendorId: 'UPS', name: 'UPS', scac: rawScac }
      : { vendorId: rawVendorId, name: rawName, scac: rawScac }
    const offerId = providerIdentifier(offer.offerId, `SpeedShip offer ${offerIndex + 1} ID`)
    const products = providerList(offer.offeredProductList)
    if (products.length === 0) throw new Error('SpeedShip offer did not contain offered products')
    for (const [productIndex, rawProduct] of products.entries()) {
      const product = record(
        rawProduct,
        `SpeedShip offer ${offerIndex + 1} product ${productIndex + 1}`,
      )
      const offeredProductId = providerIdentifier(
        product.offeredProductId,
        `SpeedShip offer ${offerIndex + 1} offered product ID`,
      )
      const price = record(product.offerPrice, 'SpeedShip offer price')
      const transit = optionalRecord(
        product.timeInTransit
        ?? optionalRecord(product.shopRQShipment).timeInTransit
        ?? offer.timeInTransit,
      )
      const serviceCode = mode === 'small_parcel'
        ? providerText(transit.upsServiceCode, 'UPS service code', 20)
        : providerText(
            transit.serviceLevel ?? optionalRecord(product.serviceDetail).name,
            'LTL service level',
            80,
          )
      const serviceName = mode === 'small_parcel'
        ? providerText(transit.serviceDescription, 'UPS service description', 120)
        : optionalProviderText(
            optionalRecord(product.serviceDetail).name,
            'LTL service name',
            120,
          ) ?? serviceCode
      const ineligible = product.ineligible === true || offer.ineligible === true
      offers.push({
        provider: WWEX_SPEEDSHIP_PROVIDER,
        transportMode: mode,
        planId: prepared.planId,
        planHash: prepared.planHash,
        productTransactionId,
        offerId,
        offeredProductId,
        executingCarrier,
        serviceCode,
        serviceName,
        amount: normalizeMoney(price.value, 'SpeedShip offer amount', true),
        currency: usd(price.unit, 'SpeedShip offer currency'),
        transitDays: normalizeTransitDays(transit.transitDays),
        estimatedDeliveryDate: optionalCalendarDate(
          transit.estimatedDeliveryDate,
          'SpeedShip estimated delivery date',
        ),
        expiresAt: dateTime(offer.expirationDate, 'SpeedShip offer expiration'),
        eligible: !ineligible,
        ineligibleReason: ineligible
          ? optionalProviderText(
              product.ineligibleReason ?? offer.ineligibleReason,
              'SpeedShip ineligible reason',
              250,
            ) ?? 'Provider marked this offer ineligible'
          : null,
        charges: normalizeCharges(product.chargeItemList),
      })
    }
  }
  const offerKeys = offers.map((offer) => `${offer.offerId}\u0000${offer.offeredProductId}`)
  if (new Set(offerKeys).size !== offerKeys.length) {
    throw new Error('SpeedShip shop response contains duplicate offer product IDs')
  }
  const resultHash = hash({
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    planId: prepared.planId,
    planHash: prepared.planHash,
    productTransactionId,
    offers,
    requestHash: prepared.requestHash,
    shopRequest: prepared.evidence,
  })
  return deepFreeze({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    planId: prepared.planId,
    planHash: prepared.planHash,
    productTransactionId,
    offers,
    resultHash,
    evidence: {
      requestHash: prepared.requestHash,
      providerPayloadHash: hash(payload),
      correlationId: optionalProviderText(payload.correlationId, 'SpeedShip correlation ID', 200),
      apiVersion: optionalProviderText(payload.apiVersion, 'SpeedShip API version', 40),
      offerCount: offers.length,
      shopRequest: prepared.evidence,
    },
  })
}

export function parseWwexSmallpackShopResponse(
  prepared: PreparedWwexSpeedshipShopRequest,
  payload: unknown,
) {
  return parseWwexShopResponse(prepared, payload, 'small_parcel')
}

export function parseWwexLtlShopResponse(
  prepared: PreparedWwexSpeedshipShopRequest,
  payload: unknown,
) {
  return parseWwexShopResponse(prepared, payload, 'ltl')
}

function assertParsedShop(
  shop: ParsedWwexSpeedshipShopResponse,
  mode: WwexSpeedshipTransportMode,
) {
  if (!shop || typeof shop !== 'object') {
    throw new Error('Parsed SpeedShip shop result failed its integrity check')
  }
  const evidence = optionalRecord(shop.evidence)
  const shopRequest = optionalRecord(evidence.shopRequest)
  const requestHash = typeof evidence.requestHash === 'string'
    ? evidence.requestHash
    : ''
  if (
    shop.adapterVersion !== WWEX_SPEEDSHIP_ADAPTER_VERSION
    || shop.provider !== WWEX_SPEEDSHIP_PROVIDER
    || shop.transportMode !== mode
    || !SHA256.test(requestHash)
    || shopRequest.provider !== WWEX_SPEEDSHIP_PROVIDER
    || shopRequest.transportMode !== mode
    || shopRequest.planId !== shop.planId
    || shopRequest.planHash !== shop.planHash
    || shop.resultHash !== hash({
      provider: WWEX_SPEEDSHIP_PROVIDER,
      transportMode: mode,
      planId: shop.planId,
      planHash: shop.planHash,
      productTransactionId: shop.productTransactionId,
      offers: shop.offers,
      requestHash,
      shopRequest,
    })
  ) throw new Error('Parsed SpeedShip shop result failed its integrity check')
}

function timeZoneName(value: unknown) {
  const normalized = plainText(value, 'Pickup time zone', 80)
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(normalized)) {
    throw new Error('Pickup time zone must be an IANA time-zone database name')
  }
  return normalized
}

function sameIdentifierSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const expected = [...left].sort()
  const actual = [...right].sort()
  return expected.every((value, index) => value === actual[index])
}

export function prepareWwexSmallpackSchedulePickupRequest(
  value: WwexSmallpackSchedulePickupInput,
): PreparedWwexSmallpackSchedulePickupRequest {
  const input = record(value, 'SMALLPACK schedule pickup input')
  assertOnlyKeys(input, [
    'pickupPlanId', 'shop', 'pickupDate', 'pickupAddress', 'timeZone',
    'readyTime', 'closeTime', 'alternateAddress', 'saturdayAvailable',
    'selfScheduled', 'correlationId',
  ], 'SMALLPACK schedule pickup input')
  const pickupPlanId = identifier(input.pickupPlanId, 'Pickup plan ID')
  const shop = input.shop as ParsedWwexSpeedshipShopResponse
  assertParsedShop(shop, 'small_parcel')
  const credentialVersion = shop.evidence.shopRequest.credentialVersion
  const credentialFingerprint = shop.evidence.shopRequest.credentialFingerprint
  // This adapter tenders one immutable shipment plus its pickup atomically.
  // A multi-shipment pickup needs a separate batch-tender contract.
  const shipmentProductTransactionIds = [shop.productTransactionId]
  const pickupDate = dateTime(input.pickupDate, 'Pickup date')
  const readyTime = clockTime(input.readyTime, 'Pickup ready time')
  const closeTime = clockTime(input.closeTime, 'Pickup close time')
  if (readyTime >= closeTime) throw new Error('Pickup ready time must be before close time')
  const pickupAddress = normalizeAddress(
    input.pickupAddress,
    'SMALLPACK pickup address',
    'small_parcel',
  )
  const safePickupAddress = safeAddress(pickupAddress)
  const alternateAddress = booleanValue(input.alternateAddress, 'Alternate pickup address flag')
  if (
    !alternateAddress
    && shop.evidence.shopRequest.origin.addressFingerprint
      !== safePickupAddress.addressFingerprint
  ) {
    throw new Error('Non-alternate pickup address must match the rated shipment origin')
  }
  const saturdayAvailable = booleanValue(
    input.saturdayAvailable,
    'Saturday pickup availability flag',
  )
  const selfScheduled = booleanValue(input.selfScheduled, 'Self-scheduled pickup flag')
  const timeZone = timeZoneName(input.timeZone)
  const correlationId = identifier(input.correlationId, 'Pickup correlation ID')
  const body = {
    request: {
      productTransactionIdList: shipmentProductTransactionIds,
      pickupDate,
      pickupStop: {
        address: {
          ...optionalRecord(providerStop(pickupAddress, 'SENDER').address),
          timeZone,
        },
        readyTime,
        closeTime,
      },
      productType: 'SMALLPACK',
      isAlternateAddress: alternateAddress,
      isResidential: pickupAddress.residential,
      vendorId: 'UPS',
      isSaturdayAvailable: saturdayAvailable,
      isSelfScheduled: selfScheduled,
    },
    correlationId,
  }
  const pickupPlanHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel',
    flow: 'schedulePickupFlow',
    pickupPlanId,
    credentialVersion,
    credentialFingerprint,
    request: body.request,
  })
  const evidence: WwexSmallpackSchedulePickupEvidence = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'prepare_only',
    providerMutationCount: 0,
    providerOperationIsMutation: true,
    providerIdempotencySupported: false,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel',
    flow: 'schedulePickupFlow',
    credentialVersion,
    credentialFingerprint,
    pickupPlanId,
    pickupPlanHash,
    correlationId,
    shipmentPlanIds: [shop.planId],
    shipmentPlanHashes: [shop.planHash],
    shipmentProductTransactionIds,
    pickupDate,
    readyTime,
    closeTime,
    pickupAddress: safePickupAddress,
    timeZone,
    alternateAddress,
    residential: pickupAddress.residential,
    saturdayAvailable,
    selfScheduled,
    executingCarrier: { vendorId: 'UPS', name: 'UPS' },
  }
  return deepFreeze({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'prepare_only' as const,
    providerMutationCount: 0 as const,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel' as const,
    flow: 'schedulePickupFlow' as const,
    path: WWEX_SPEEDSHIP_FLOW_PATHS.schedulePickupFlow,
    method: 'POST' as const,
    pickupPlanId,
    pickupPlanHash,
    requestHash: hash({
      flow: 'schedulePickupFlow',
      pickupPlanHash,
      body,
      evidence,
    }),
    body,
    evidence,
  })
}

function assertPreparedSchedulePickup(
  prepared: PreparedWwexSmallpackSchedulePickupRequest,
) {
  const request = optionalRecord(prepared.body.request)
  const expectedPlanHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel',
    flow: 'schedulePickupFlow',
    pickupPlanId: prepared.pickupPlanId,
    credentialVersion: prepared.evidence.credentialVersion,
    credentialFingerprint: prepared.evidence.credentialFingerprint,
    request,
  })
  if (
    prepared.adapterVersion !== WWEX_SPEEDSHIP_ADAPTER_VERSION
    || prepared.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.transportMode !== 'small_parcel'
    || prepared.flow !== 'schedulePickupFlow'
    || prepared.path !== WWEX_SPEEDSHIP_FLOW_PATHS.schedulePickupFlow
    || prepared.method !== 'POST'
    || request.productType !== 'SMALLPACK'
    || request.vendorId !== 'UPS'
    || prepared.evidence.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.evidence.flow !== 'schedulePickupFlow'
    || !Number.isSafeInteger(prepared.evidence.credentialVersion)
    || prepared.evidence.credentialVersion < 1
    || !SHA256.test(prepared.evidence.credentialFingerprint)
    || prepared.evidence.pickupPlanId !== prepared.pickupPlanId
    || prepared.pickupPlanHash !== expectedPlanHash
    || prepared.evidence.pickupPlanHash !== expectedPlanHash
    || prepared.requestHash !== hash({
      flow: 'schedulePickupFlow',
      pickupPlanHash: expectedPlanHash,
      body: prepared.body,
      evidence: prepared.evidence,
    })
  ) throw new Error('Prepared SpeedShip schedule pickup request failed its integrity check')
}

export function sealPreparedWwexSmallpackSchedulePickupRequest(
  prepared: PreparedWwexSmallpackSchedulePickupRequest,
): SealedWwexSmallpackSchedulePickupRequest {
  assertPreparedSchedulePickup(prepared)
  const seal = {
    ...prepared,
  } as Partial<PreparedWwexSmallpackSchedulePickupRequest>
  delete seal.body
  return deepFreeze(seal as SealedWwexSmallpackSchedulePickupRequest)
}

export function parseWwexSmallpackSchedulePickupResponse(
  prepared: PreparedWwexSmallpackSchedulePickupRequest,
  payloadValue: unknown,
): ParsedWwexSmallpackSchedulePickupResponse {
  assertPreparedSchedulePickup(prepared)
  const payload = record(payloadValue, 'SpeedShip schedule pickup response')
  clientSuccess(payload, 'schedulePickupFlow')
  const response = record(payload.response, 'SpeedShip schedule pickup response body')
  const rawOffers = providerList(response.pickupOfferList)
  if (rawOffers.length === 0) {
    throw new Error('SpeedShip schedule pickup response did not contain offers')
  }
  const offers: WwexSmallpackPickupOffer[] = []
  for (const [offerIndex, offerValue] of rawOffers.entries()) {
    const offer = record(offerValue, `SpeedShip pickup offer ${offerIndex + 1}`)
    const vendor = record(
      offer.primaryVendor,
      `SpeedShip pickup offer ${offerIndex + 1} vendor`,
    )
    const vendorId = providerText(
      vendor.vendorId ?? vendor.vendorID,
      'SpeedShip pickup vendor ID',
      80,
    ).toUpperCase()
    if (vendorId !== 'UPS') throw new Error('SpeedShip pickup offers must execute through UPS')
    const scac = providerText(vendor.scac, 'SpeedShip pickup SCAC', 8).toUpperCase()
    if (!SCAC.test(scac)) throw new Error('SpeedShip pickup SCAC is invalid')
    const products = providerList(offer.offeredProductList)
    if (products.length === 0) {
      throw new Error('SpeedShip pickup offer did not contain offered products')
    }
    for (const [productIndex, productValue] of products.entries()) {
      const product = record(
        productValue,
        `SpeedShip pickup offer ${offerIndex + 1} product ${productIndex + 1}`,
      )
      const pickup = record(product.pickup, 'SpeedShip pickup offer details')
      const shipmentProductTransactionIds = providerList(
        pickup.shipmentProductTransactionIdList,
      ).map((item, index) => providerIdentifier(
        item,
        `SpeedShip pickup shipment transaction ID ${index + 1}`,
      ))
      if (
        !sameIdentifierSet(
          shipmentProductTransactionIds,
          prepared.evidence.shipmentProductTransactionIds,
        )
      ) throw new Error('SpeedShip pickup offer is not bound to the requested shipments')
      const price = record(
        product.offerPrice ?? offer.totalOfferPrice,
        'SpeedShip pickup offer price',
      )
      offers.push({
        provider: WWEX_SPEEDSHIP_PROVIDER,
        transportMode: 'small_parcel',
        pickupPlanId: prepared.pickupPlanId,
        pickupPlanHash: prepared.pickupPlanHash,
        shipmentProductTransactionIds,
        pickupProductTransactionId: providerIdentifier(
          offer.productTransactionId,
          'SpeedShip pickup product transaction ID',
        ),
        pickupOfferId: providerIdentifier(offer.offerId, 'SpeedShip pickup offer ID'),
        pickupOfferedProductId: providerIdentifier(
          product.offeredProductId,
          'SpeedShip pickup offered product ID',
        ),
        executingCarrier: { vendorId: 'UPS', name: 'UPS', scac },
        amount: normalizeMoney(price.value, 'SpeedShip pickup offer amount', true),
        currency: usd(price.unit, 'SpeedShip pickup offer currency'),
        expiresAt: dateTime(offer.expirationDate, 'SpeedShip pickup offer expiration'),
        matchedRequestedPickupTime: typeof offer.matchedRequestedPickupTime === 'boolean'
          ? offer.matchedRequestedPickupTime
          : null,
      })
    }
  }
  const offerKeys = offers.map((offer) =>
    `${offer.pickupOfferId}\u0000${offer.pickupOfferedProductId}`)
  if (new Set(offerKeys).size !== offerKeys.length) {
    throw new Error('SpeedShip pickup response contains duplicate offer product IDs')
  }
  const result = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel' as const,
    pickupPlanId: prepared.pickupPlanId,
    pickupPlanHash: prepared.pickupPlanHash,
    offers,
  }
  return deepFreeze({
    ...result,
    resultHash: hash(result),
    evidence: {
      requestHash: prepared.requestHash,
      providerPayloadHash: hash(payload),
      correlationId: optionalProviderText(payload.correlationId, 'SpeedShip correlation ID', 200),
      apiVersion: optionalProviderText(payload.apiVersion, 'SpeedShip API version', 40),
      offerCount: offers.length,
      pickupRequest: prepared.evidence,
    },
  })
}

function assertParsedSchedulePickup(
  pickup: ParsedWwexSmallpackSchedulePickupResponse,
) {
  if (
    pickup.adapterVersion !== WWEX_SPEEDSHIP_ADAPTER_VERSION
    || pickup.provider !== WWEX_SPEEDSHIP_PROVIDER
    || pickup.transportMode !== 'small_parcel'
    || pickup.resultHash !== hash({
      adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
      provider: WWEX_SPEEDSHIP_PROVIDER,
      transportMode: 'small_parcel',
      pickupPlanId: pickup.pickupPlanId,
      pickupPlanHash: pickup.pickupPlanHash,
      offers: pickup.offers,
    })
  ) throw new Error('Parsed SpeedShip pickup result failed its integrity check')
}

function selectedPickupOffer(
  pickup: ParsedWwexSmallpackSchedulePickupResponse,
  offerIdValue: unknown,
  offeredProductIdValue: unknown,
) {
  const offerId = providerIdentifier(offerIdValue, 'Selected pickup offer ID')
  const offeredProductId = providerIdentifier(
    offeredProductIdValue,
    'Selected pickup offered product ID',
  )
  const matches = pickup.offers.filter((offer) =>
    offer.pickupOfferId === offerId
    && offer.pickupOfferedProductId === offeredProductId)
  if (matches.length !== 1) {
    throw new Error('Selected pickup offer does not belong to this pickup plan')
  }
  return matches[0]
}

function selectedOffer(
  shop: ParsedWwexSpeedshipShopResponse,
  offerIdValue: unknown,
  offeredProductIdValue: unknown,
) {
  const offerId = providerIdentifier(offerIdValue, 'Selected SpeedShip offer ID')
  const offeredProductId = providerIdentifier(
    offeredProductIdValue,
    'Selected SpeedShip offered product ID',
  )
  const matches = shop.offers.filter((offer) =>
    offer.offerId === offerId && offer.offeredProductId === offeredProductId)
  if (matches.length !== 1) throw new Error('Selected SpeedShip offer does not belong to this shop plan')
  if (!matches[0].eligible) throw new Error('Selected SpeedShip offer is ineligible')
  return matches[0]
}

function tenderTimeBeforeExpiration(
  value: unknown,
  expiresAt: string,
  label: string,
) {
  const tenderedAtLocal = dateTime(value, 'Tender local date and time')
  if (tenderedAtLocal >= expiresAt) {
    throw new Error(`${label} expired before tender preparation`)
  }
  return tenderedAtLocal
}

function preparedTender(
  mode: WwexSpeedshipTransportMode,
  flow: 'integratedOrderFlow' | 'quoteOrderFlow',
  tenderPlanId: string,
  tenderPlanHash: string,
  body: Record<string, unknown>,
  evidence: WwexSpeedshipTenderEvidence,
): PreparedWwexSpeedshipTenderRequest {
  const path = flow === 'integratedOrderFlow'
    ? WWEX_SPEEDSHIP_FLOW_PATHS.integratedOrderFlow
    : WWEX_SPEEDSHIP_FLOW_PATHS.quoteOrderFlow
  return deepFreeze({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'tender_prepare_only' as const,
    providerMutationCount: 0 as const,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    flow,
    path,
    method: 'POST' as const,
    tenderPlanId,
    tenderPlanHash,
    requestHash: hash({ flow, tenderPlanHash, body, evidence }),
    body,
    evidence,
  })
}

export function prepareWwexSmallpackTenderRequest(
  value: WwexSmallpackTenderInput,
): PreparedWwexSpeedshipTenderRequest {
  const input = record(value, 'Small parcel tender input')
  assertOnlyKeys(input, [
    'tenderPlanId', 'shop', 'selectedOfferId', 'selectedOfferedProductId',
    'pickup', 'selectedPickupOfferId', 'selectedPickupOfferedProductId',
    'billToType', 'billToAccountNumber', 'billToAccountFingerprint',
    'billToPostalCode',
    'billToCountryCode', 'sendersReceipt', 'internationalFormsPrepared',
    'tenderedAtLocal', 'correlationId',
  ], 'Small parcel tender input')
  const shop = input.shop as ParsedWwexSpeedshipShopResponse
  assertParsedShop(shop, 'small_parcel')
  const offer = selectedOffer(shop, input.selectedOfferId, input.selectedOfferedProductId)
  const pickup = input.pickup as ParsedWwexSmallpackSchedulePickupResponse
  assertParsedSchedulePickup(pickup)
  const credentialVersion = shop.evidence.shopRequest.credentialVersion
  const secureCredentialFingerprint = shop.evidence.shopRequest.credentialFingerprint
  if (
    pickup.evidence.pickupRequest.credentialVersion !== credentialVersion
    || pickup.evidence.pickupRequest.credentialFingerprint
      !== secureCredentialFingerprint
  ) {
    throw new Error('Pickup and shipment offers must use the same credential revision')
  }
  const pickupOffer = selectedPickupOffer(
    pickup,
    input.selectedPickupOfferId,
    input.selectedPickupOfferedProductId,
  )
  if (!pickupOffer.shipmentProductTransactionIds.includes(shop.productTransactionId)) {
    throw new Error('Selected pickup offer is not bound to the selected shipment plan')
  }
  if (pickupOffer.executingCarrier.scac !== offer.executingCarrier.scac) {
    throw new Error('Pickup and shipment offers must identify the same UPS execution SCAC')
  }
  const tenderPlanId = identifier(input.tenderPlanId, 'Small parcel tender plan ID')
  const tenderedAtLocal = tenderTimeBeforeExpiration(
    input.tenderedAtLocal,
    offer.expiresAt,
    'Selected shipment offer',
  )
  tenderTimeBeforeExpiration(
    tenderedAtLocal,
    pickupOffer.expiresAt,
    'Selected pickup offer',
  )
  const billToType = plainText(input.billToType, 'Bill-to type', 20)
  if (!['SENDER', 'RECEIVER', 'THIRD_PARTY', 'CONSIGNEE'].includes(billToType)) {
    throw new Error('Bill-to type is not supported by SpeedShip v1.9b')
  }
  const billToAccountNumber = plainText(input.billToAccountNumber, 'Bill-to account number', 64)
  // This is a server-keyed HMAC produced outside this pure carrier adapter.
  // An unkeyed hash of a short billing account number is brute-forceable.
  const billToAccountBinding = fingerprint(
    input.billToAccountFingerprint,
    'Bill-to account fingerprint',
  )
  const billToPostalCode = plainText(input.billToPostalCode, 'Bill-to postal code', 16)
  const billToCountryCode = countryCode(input.billToCountryCode, 'Bill-to country code')
  const sendersReceipt = booleanValue(input.sendersReceipt, 'Sender receipt flag')
  const internationalFormsPrepared = booleanValue(
    input.internationalFormsPrepared,
    'International forms prepared flag',
  )
  if (shop.evidence.shopRequest.isInternational && !internationalFormsPrepared) {
    throw new Error('International SpeedShip tender requires prepared shipment forms')
  }
  const correlationId = identifier(input.correlationId, 'Small parcel tender correlation ID')
  const body = {
    request: {
      orderRQList: [{
        billToType,
        billToAccountNbr: billToAccountNumber,
        billToPostalCode,
        billToCountryCode,
        offerId: offer.offerId,
        productTransactionId: shop.productTransactionId,
        sendersReceiptFlag: sendersReceipt,
      }, {
        offerId: pickupOffer.pickupOfferId,
        productTransactionId: pickupOffer.pickupProductTransactionId,
        sendersReceiptFlag: sendersReceipt,
      }],
    },
    correlationId,
  }
  const tenderPlanHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel',
    flow: 'integratedOrderFlow',
    tenderPlanId,
    shopPlanHash: shop.planHash,
    shipmentProductTransactionId: shop.productTransactionId,
    shipmentOfferId: offer.offerId,
    offeredProductId: offer.offeredProductId,
    pickupPlanHash: pickup.pickupPlanHash,
    pickupOfferId: pickupOffer.pickupOfferId,
    pickupOfferedProductId: pickupOffer.pickupOfferedProductId,
    pickupProductTransactionId: pickupOffer.pickupProductTransactionId,
    credentialVersion,
    credentialFingerprint: secureCredentialFingerprint,
    billToType,
    billToAccountBinding,
    billToPostalCode,
    billToCountryCode,
    sendersReceipt,
    internationalFormsPrepared,
    tenderedAtLocal,
  })
  const evidence: WwexSpeedshipTenderEvidence = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'tender_prepare_only',
    providerMutationCount: 0,
    providerOperationIsMutation: true,
    providerIdempotencySupported: false,
    retryDisposition: 'outcome_unknown_requires_reconciliation',
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'small_parcel',
    flow: 'integratedOrderFlow',
    tenderPlanId,
    tenderPlanHash,
    shopPlanId: shop.planId,
    shopPlanHash: shop.planHash,
    shipmentProductTransactionId: shop.productTransactionId,
    shipmentOfferId: offer.offerId,
    offeredProductId: offer.offeredProductId,
    pickupPlanId: pickup.pickupPlanId,
    pickupPlanHash: pickup.pickupPlanHash,
    pickupOfferId: pickupOffer.pickupOfferId,
    pickupOfferedProductId: pickupOffer.pickupOfferedProductId,
    pickupProductTransactionId: pickupOffer.pickupProductTransactionId,
    executingCarrier: offer.executingCarrier,
    isInternational: shop.evidence.shopRequest.isInternational,
    internationalFormsPrepared,
    tenderedAtLocal,
    originLocationFingerprint: shop.evidence.shopRequest.origin.locationFingerprint,
    destinationLocationFingerprint: shop.evidence.shopRequest.destination.locationFingerprint,
    credentialVersion,
    credentialFingerprint: secureCredentialFingerprint,
    billToAccountBinding,
  }
  return preparedTender(
    'small_parcel',
    'integratedOrderFlow',
    tenderPlanId,
    tenderPlanHash,
    body,
    evidence,
  )
}

export function prepareWwexLtlTenderRequest(
  value: WwexLtlTenderInput,
): PreparedWwexSpeedshipTenderRequest {
  const input = record(value, 'LTL tender input')
  assertOnlyKeys(input, [
    'tenderPlanId', 'shop', 'selectedOfferId', 'selectedOfferedProductId',
    'origin', 'destination', 'shipmentReferences', 'pickupDate', 'readyTime',
    'closeTime', 'selfScheduled', 'internationalFormsPrepared', 'tenderedAtLocal',
    'pickupSpecialInstructions', 'deliverySpecialInstructions',
    'specialInstructions',
  ], 'LTL tender input')
  const shop = input.shop as ParsedWwexSpeedshipShopResponse
  assertParsedShop(shop, 'ltl')
  const offer = selectedOffer(shop, input.selectedOfferId, input.selectedOfferedProductId)
  const tenderPlanId = identifier(input.tenderPlanId, 'LTL tender plan ID')
  const credentialVersion = shop.evidence.shopRequest.credentialVersion
  const secureCredentialFingerprint = shop.evidence.shopRequest.credentialFingerprint
  const tenderedAtLocal = tenderTimeBeforeExpiration(
    input.tenderedAtLocal,
    offer.expiresAt,
    'Selected LTL offer',
  )
  const origin = normalizeAddress(input.origin, 'LTL tender origin', 'ltl')
  const destination = normalizeAddress(input.destination, 'LTL tender destination', 'ltl')
  const safeOrigin = safeAddress(origin)
  const safeDestination = safeAddress(destination)
  // ClawPilot accuracy rule: rate and tender use the same full factual LTL
  // addresses. SpeedShip permits temporary rate-time contact data, but this
  // foundation intentionally does not rely on that provider allowance.
  if (
    safeOrigin.addressFingerprint !== shop.evidence.shopRequest.origin.addressFingerprint
    || safeDestination.addressFingerprint !== shop.evidence.shopRequest.destination.addressFingerprint
  ) throw new Error('LTL tender addresses must match the full factual rated addresses')
  const pickupDate = dateTime(input.pickupDate, 'LTL pickup date')
  const readyTime = clockTime(input.readyTime, 'LTL ready time')
  const closeTime = clockTime(input.closeTime, 'LTL close time')
  if (readyTime >= closeTime) throw new Error('LTL ready time must be before close time')
  const selfScheduled = booleanValue(input.selfScheduled, 'LTL self-scheduled flag')
  const internationalFormsPrepared = booleanValue(
    input.internationalFormsPrepared,
    'International forms prepared flag',
  )
  if (shop.evidence.shopRequest.isInternational && !internationalFormsPrepared) {
    throw new Error('International SpeedShip tender requires prepared shipment forms')
  }
  const references = normalizeReferences(input.shipmentReferences, 'LTL tender references', 20)
  const pickupInstructions = optionalText(
    input.pickupSpecialInstructions,
    'LTL tender pickup instructions',
    60,
  )
  const deliveryInstructions = optionalText(
    input.deliverySpecialInstructions,
    'LTL tender delivery instructions',
    500,
  )
  const specialInstructions = optionalText(
    input.specialInstructions,
    'LTL tender special instructions',
    500,
  )
  const body = {
    request: {
      shipmentProductTransactionId: shop.productTransactionId,
      shipmentOfferId: offer.offerId,
      shipment: {
        originAddress: providerStop(origin, 'SENDER'),
        destinationAddress: providerStop(destination, 'RECEIVER'),
        shipmentReferenceList: references,
      },
      isSelfScheduled: selfScheduled,
      pickupDate,
      closeTime,
      readyTime,
      ...(pickupInstructions ? { pickupSpecialInstructions: pickupInstructions } : {}),
      ...(deliveryInstructions ? { deliverySpecialInstructions: deliveryInstructions } : {}),
      ...(specialInstructions ? { specialInstructions } : {}),
    },
  }
  const tenderPlanHash = hash({
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'ltl',
    flow: 'quoteOrderFlow',
    tenderPlanId,
    shopPlanHash: shop.planHash,
    shipmentProductTransactionId: shop.productTransactionId,
    shipmentOfferId: offer.offerId,
    offeredProductId: offer.offeredProductId,
    credentialVersion,
    credentialFingerprint: secureCredentialFingerprint,
    originAddressFingerprint: safeOrigin.addressFingerprint,
    destinationAddressFingerprint: safeDestination.addressFingerprint,
    referencesHash: hash(references),
    pickupDate,
    readyTime,
    closeTime,
    selfScheduled,
    internationalFormsPrepared,
    tenderedAtLocal,
    pickupInstructions,
    deliveryInstructions,
    specialInstructions,
  })
  const evidence: WwexSpeedshipTenderEvidence = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    accessMode: 'tender_prepare_only',
    providerMutationCount: 0,
    providerOperationIsMutation: true,
    providerIdempotencySupported: false,
    retryDisposition: 'outcome_unknown_requires_reconciliation',
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: 'ltl',
    flow: 'quoteOrderFlow',
    tenderPlanId,
    tenderPlanHash,
    shopPlanId: shop.planId,
    shopPlanHash: shop.planHash,
    shipmentProductTransactionId: shop.productTransactionId,
    shipmentOfferId: offer.offerId,
    offeredProductId: offer.offeredProductId,
    pickupPlanId: null,
    pickupPlanHash: null,
    pickupOfferId: null,
    pickupOfferedProductId: null,
    pickupProductTransactionId: null,
    executingCarrier: offer.executingCarrier,
    isInternational: shop.evidence.shopRequest.isInternational,
    internationalFormsPrepared,
    tenderedAtLocal,
    originLocationFingerprint: safeOrigin.locationFingerprint,
    destinationLocationFingerprint: safeDestination.locationFingerprint,
    credentialVersion,
    credentialFingerprint: secureCredentialFingerprint,
    billToAccountBinding: null,
  }
  return preparedTender(
    'ltl',
    'quoteOrderFlow',
    tenderPlanId,
    tenderPlanHash,
    body,
    evidence,
  )
}

function assertPreparedTender(
  prepared: PreparedWwexSpeedshipTenderRequest,
  mode: WwexSpeedshipTransportMode,
) {
  if (mode !== 'small_parcel' && mode !== 'ltl') {
    throw new Error('Prepared SpeedShip tender request has an invalid transport mode')
  }
  const flow = mode === 'small_parcel' ? 'integratedOrderFlow' : 'quoteOrderFlow'
  const path = mode === 'small_parcel'
    ? WWEX_SPEEDSHIP_FLOW_PATHS.integratedOrderFlow
    : WWEX_SPEEDSHIP_FLOW_PATHS.quoteOrderFlow
  if (
    prepared.adapterVersion !== WWEX_SPEEDSHIP_ADAPTER_VERSION
    || prepared.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.transportMode !== mode
    || prepared.flow !== flow
    || prepared.path !== path
    || prepared.method !== 'POST'
    || prepared.evidence.provider !== WWEX_SPEEDSHIP_PROVIDER
    || prepared.evidence.transportMode !== mode
    || prepared.evidence.flow !== flow
    || prepared.evidence.tenderPlanId !== prepared.tenderPlanId
    || prepared.evidence.tenderPlanHash !== prepared.tenderPlanHash
    || prepared.requestHash !== hash({
      flow,
      tenderPlanHash: prepared.tenderPlanHash,
      body: prepared.body,
      evidence: prepared.evidence,
    })
  ) throw new Error('Prepared SpeedShip tender request failed its integrity check')
}

export function sealPreparedWwexSpeedshipTenderRequest(
  prepared: PreparedWwexSpeedshipTenderRequest,
): SealedWwexSpeedshipTenderRequest {
  assertPreparedTender(prepared, prepared.transportMode)
  const seal = { ...prepared } as Partial<PreparedWwexSpeedshipTenderRequest>
  delete seal.body
  return deepFreeze(seal as SealedWwexSpeedshipTenderRequest)
}

function documentsFrom(items: unknown[]): WwexSpeedshipTenderDocument[] {
  const documents: WwexSpeedshipTenderDocument[] = []
  for (const itemValue of items) {
    const item = record(itemValue, 'SpeedShip ordered item')
    for (const [index, documentValue] of providerList(item.documentList).entries()) {
      const document = record(documentValue, `SpeedShip document ${index + 1}`)
      documents.push({
        s3FileName: providerIdentifier(
          document.s3FileName ?? document.s3fileName ?? document.s3filename,
          'Document S3 file name',
        ),
        docType: providerText(document.docType ?? document.doctype, 'Document type', 80),
        docFormat: providerText(document.docFormat, 'Document format', 20),
        name: providerText(document.name, 'Document name', 160),
      })
    }
  }
  const keys = documents.map((document) => document.s3FileName)
  if (new Set(keys).size !== keys.length) throw new Error('SpeedShip tender response contains duplicate documents')
  return documents
}

function secondaryIdsFrom(items: unknown[]) {
  const identifiers: Array<{ type: string; value: string }> = []
  for (const itemValue of items) {
    const item = record(itemValue, 'SpeedShip ordered item')
    for (const [index, idValue] of providerList(item.secondaryTxnIdList).entries()) {
      const id = record(idValue, `SpeedShip secondary transaction ID ${index + 1}`)
      identifiers.push({
        type: providerText(id.type, 'Secondary transaction ID type', 80),
        value: providerIdentifier(id.value, 'Secondary transaction ID value'),
      })
    }
  }
  return identifiers
}

function partialProviderIdentifier(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  try {
    return providerIdentifier(value, label)
  } catch {
    return null
  }
}

function parseTenderResponse(
  prepared: PreparedWwexSpeedshipTenderRequest,
  payloadValue: unknown,
  mode: WwexSpeedshipTransportMode,
): ParsedWwexSpeedshipTenderResponse {
  assertPreparedTender(prepared, mode)
  const payload = record(payloadValue, 'SpeedShip tender response')
  clientSuccess(payload, prepared.flow)
  const response = optionalRecord(payload.response)
  const pickupResponse = optionalRecord(response.pickupOrderResponse)
  const pickupOrder = optionalRecord(pickupResponse.order)
  const pickupItems = providerList(pickupOrder.orderedItemList)
  const pickupItem = optionalRecord(pickupItems[0])
  const shipmentResponse = optionalRecord(response.shipmentOrderResponse)
  const shipmentOrder = optionalRecord(shipmentResponse.order)
  const shipmentItems = providerList(shipmentOrder.orderedItemList)
  let documents: WwexSpeedshipTenderDocument[] = []
  try {
    documents = documentsFrom(shipmentItems)
  } catch {
    documents = []
  }
  let secondaryTransactionIds: Array<{ type: string; value: string }> = []
  try {
    secondaryTransactionIds = secondaryIdsFrom(shipmentItems)
  } catch {
    secondaryTransactionIds = []
  }
  const pickupOrderId = partialProviderIdentifier(
    pickupOrder.orderId ?? pickupResponse.orderId,
    'Pickup order ID',
  )
  const pickupTransactionId = partialProviderIdentifier(
    pickupItem.pickupTxnId,
    'Pickup transaction ID',
  )
  const shipmentOrderId = partialProviderIdentifier(
    shipmentOrder.orderId ?? shipmentResponse.orderId,
    'Shipment order ID',
  )
  const quoteNumber = mode === 'ltl'
    ? partialProviderIdentifier(shipmentOrder.quoteNumber, 'LTL quote number')
    : null
  const missingRequiredEvidence: WwexSpeedshipPartialTenderReconciliation[
    'missingRequiredEvidence'
  ][number][] = []
  if (pickupOrderId === null) missingRequiredEvidence.push('pickup_order_id')
  if (pickupTransactionId === null) {
    missingRequiredEvidence.push('pickup_transaction_id')
  }
  if (shipmentOrderId === null) missingRequiredEvidence.push('shipment_order_id')
  if (mode === 'ltl' && quoteNumber === null) {
    missingRequiredEvidence.push('quote_number')
  }
  if (documents.length < 1) missingRequiredEvidence.push('shipment_documents')
  if (missingRequiredEvidence.length > 0) {
    throw new WwexSpeedshipPartialTenderOutcomeError({
      adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
      provider: WWEX_SPEEDSHIP_PROVIDER,
      transportMode: mode,
      flow: prepared.flow,
      requestHash: prepared.requestHash,
      providerPayloadHash: hash(payload),
      providerIds: {
        pickupOrderId,
        pickupTransactionId,
        shipmentOrderId,
        quoteNumber,
      },
      missingRequiredEvidence,
    })
  }
  const result = {
    adapterVersion: WWEX_SPEEDSHIP_ADAPTER_VERSION,
    provider: WWEX_SPEEDSHIP_PROVIDER,
    transportMode: mode,
    tenderPlanId: prepared.tenderPlanId,
    tenderPlanHash: prepared.tenderPlanHash,
    executingCarrier: prepared.evidence.executingCarrier,
    pickupOrderId: pickupOrderId as string,
    pickupTransactionId: pickupTransactionId as string,
    shipmentOrderId: shipmentOrderId as string,
    quoteNumber,
    secondaryTransactionIds,
    documents,
  }
  return deepFreeze({
    ...result,
    resultHash: hash(result),
    evidence: {
      requestHash: prepared.requestHash,
      providerPayloadHash: hash(payload),
      correlationId: optionalProviderText(payload.correlationId, 'SpeedShip correlation ID', 200),
      apiVersion: optionalProviderText(payload.apiVersion, 'SpeedShip API version', 40),
      tender: prepared.evidence,
    },
  })
}

export function parseWwexSmallpackTenderResponse(
  prepared: PreparedWwexSpeedshipTenderRequest,
  payload: unknown,
) {
  return parseTenderResponse(prepared, payload, 'small_parcel')
}

export function parseWwexLtlTenderResponse(
  prepared: PreparedWwexSpeedshipTenderRequest,
  payload: unknown,
) {
  return parseTenderResponse(prepared, payload, 'ltl')
}
