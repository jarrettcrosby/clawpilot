import { createHash } from 'node:crypto'

/**
 * Pure R+L Carriers freight request/response foundation.
 *
 * Contract source: the public RLC.API Swagger v1 document exposed at
 * https://api.rlc.com/swagger/docs/v1, reviewed 2026-08-11, plus the supplied
 * R+L Postman examples. This module prepares deterministic request bodies and
 * parses recorded responses. It performs no transport or account access.
 */

export const RL_CARRIERS_FREIGHT_PROVIDER = 'rl_carriers' as const

export const RL_CARRIERS_EXECUTING_CARRIER = Object.freeze({
  code: 'RL_CARRIERS',
  name: 'R+L Carriers',
})

export const RL_CARRIERS_FREIGHT_ENDPOINTS = Object.freeze({
  servicePoint: 'https://api.rlc.com/ServicePoint',
  rateQuote: 'https://api.rlc.com/RateQuote',
  billOfLading: 'https://api.rlc.com/BillOfLading',
  pickupRequest: 'https://api.rlc.com/PickupRequest',
})

export type RlCarriersFreightProvider = typeof RL_CARRIERS_FREIGHT_PROVIDER
export type RlCarriersExecutingCarrier =
  typeof RL_CARRIERS_EXECUTING_CARRIER
export type RlCarriersFreightOperation =
  | 'rate_quote'
  | 'bill_of_lading'
  | 'pickup_request'

export type RlCarriersServicePointInput = {
  city: string
  stateOrProvince: string
  zipOrPostalCode: string
  countryCode: string
}

export type RlCarriersPartyInput = RlCarriersServicePointInput & {
  companyName: string
  addressLine1: string
  addressLine2?: string | null
  phoneNumber: string
  emailAddress?: string | null
}

export type RlCarriersRateQuoteAccessorial =
  | 'InsideDelivery'
  | 'LimitedAccessPickup'
  | 'LimitedAccessDelivery'
  | 'OriginLiftgate'
  | 'DestinationLiftgate'
  | 'DeliveryAppointment'
  | 'InsidePickup'
  | 'Freezable'
  | 'SortAndSegregate'
  | 'OverDimension'
  | 'ResidentialDelivery'
  | 'ResidentialPickup'

export type RlCarriersBillOfLadingAccessorial =
  | 'InsideDelivery'
  | 'LimitedAccessPickup'
  | 'LimitedAccessDelivery'
  | 'OriginLiftgate'
  | 'DestinationLiftgate'
  | 'DeliveryAppointment'
  | 'InsidePickup'
  | 'Freezable'
  | 'ResidentialDelivery'
  | 'ResidentialPickup'

export type RlCarriersPickupRequestAccessorial =
  | 'LimitedAccessPickup'
  | 'InsidePickup'
  | 'Liftgate'

export type RlCarriersRateItemInput = {
  freightClass: string | number
  weightLb: number
  lengthIn: number
  widthIn: number
  heightIn: number
}

export type RlCarriersPalletTariffInput = {
  code: string
  weightLb: number
  quantity: number
}

export type RlCarriersRateQuoteInput = {
  credentialVersion: number
  credentialFingerprint: string
  pickupDate: string
  origin: RlCarriersServicePointInput
  destination: RlCarriersServicePointInput
  items: RlCarriersRateItemInput[]
  pallets?: RlCarriersPalletTariffInput[]
  accessorials?: RlCarriersRateQuoteAccessorial[]
  declaredValueUsd?: string | number | null
}

export type RlCarriersHandlingUnitItemInput = {
  pieces: number
  packageType: string
  description: string
  freightClass: string | number
  weightLb: number
  nmfcItemNumber?: string | null
  nmfcSubNumber?: string | null
}

export type RlCarriersHandlingUnitInput = {
  unitType: 'PLT'
  quantity: 1
  lengthIn: number
  widthIn: number
  heightIn: number
  items: [RlCarriersHandlingUnitItemInput]
}

export type RlCarriersBillOfLadingInput = {
  bolDate: string
  rateSelection: RlCarriersRateSelectionInput
  shipper: RlCarriersPartyInput
  consignee: RlCarriersPartyInput & { attention?: string | null }
  handlingUnits: RlCarriersHandlingUnitInput[]
  specialInstructions?: string | null
  declaredValue?: {
    amountUsd: string | number
    per: string
  } | null
  referenceNumbers?: {
    shipperNumber?: string | null
    purchaseOrderNumber?: string | null
  }
  freightChargePaymentMethod: 'Prepaid' | 'Collect'
  pickupRequest?: RlCarriersEmbeddedPickupRequestInput | null
}

export type RlCarriersPickupHandlingUnitInput = {
  quantity: 1
  freightClass: string | number
  weightLb: number
  lengthIn: number
  widthIn: number
  heightIn: number
}

export type RlCarriersEmbeddedPickupRequestInput = {
  pickupDate: string
  readyTime: string
  closeTime: string
  additionalInstructions?: string | null
  loadAttributes?: string[]
  contact?: {
    name: string
    companyName?: string | null
    phoneNumber: string
    emailAddress?: string | null
  } | null
  sendEmailConfirmation?: boolean
  shipperReferenceNumber?: string | null
}

export type RlCarriersQuotedPickupRequestInput = {
  rateSelection: RlCarriersRateSelectionInput
  shipper: RlCarriersPartyInput & {
    contactName?: string | null
    shipperReferenceNumber?: string | null
  }
  contact?: {
    name: string
    companyName?: string | null
    phoneNumber: string
    emailAddress?: string | null
  } | null
  destination: RlCarriersServicePointInput
  handlingUnits: RlCarriersPickupHandlingUnitInput[]
  pickupDate: string
  readyTime: string
  closeTime: string
  additionalInstructions?: string | null
  loadAttributes?: string[]
  sendEmailConfirmation?: boolean
}

type RlCarriersSafeFreightSummary = {
  handlingUnitCount: number
  totalWeightLb: number
}

export type RlCarriersRateSelectionEvidence = {
  rateRequestHash: string
  rateResponseIntegrityHash: string
  selectedRateFingerprint: string
  tariffBasis: RlCarriersTariffBasis
  accessorials: string[]
  ratedPlan: RlCarriersRatedPlanEvidence
}

export type RlCarriersRatedPlanEvidence = {
  planHash: string
  originFingerprint: string
  destinationFingerprint: string
  itemCount: number
  totalWeightLb: number
  pallets: RlCarriersRatedPalletTariffEvidence[]
  palletCount: number
  palletWeightLb: number
}

export type RlCarriersRatedPalletTariffEvidence = {
  code: string
  weightLb: number
  quantity: number
}

export type RlCarriersRedactedRequestEvidence = {
  adapterVersion: 'rl-carriers-freight-v1'
  sourceContract: 'rlc-public-swagger-v1-2026-08-11'
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  operation: RlCarriersFreightOperation
  providerMutationCount: 0
  credentialVersion: number
  credentialFingerprint: string
  providerWriteIntent:
    | null
    | 'bill_of_lading.create'
    | 'bill_of_lading_with_pickup.create'
    | 'pickup_request.create'
  pickupBinding: 'none' | 'bill_of_lading_embedded' | 'direct_quote'
  rateSelection: RlCarriersRateSelectionEvidence | null
  ratedPlan: RlCarriersRatedPlanEvidence
  accessorials: string[]
  quoteNumberFingerprint: string | null
  route: {
    originFingerprint: string
    destinationFingerprint: string
  }
  freight: RlCarriersSafeFreightSummary & {
    commodityCount: number
    palletTariffRequested: boolean
  }
}

type RlCarriersPreparedRequestBase<
  Operation extends RlCarriersFreightOperation,
> = {
  adapterVersion: 'rl-carriers-freight-v1'
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  operation: Operation
  providerMutationCount: 0
  method: 'POST'
  endpoint: string
  body: Record<string, unknown>
  requestHash: string
  redactedRequest: RlCarriersRedactedRequestEvidence & {
    operation: Operation
  }
}

export type PreparedRlCarriersRateQuoteRequest =
  RlCarriersPreparedRequestBase<'rate_quote'>
export type PreparedRlCarriersBillOfLadingRequest =
  RlCarriersPreparedRequestBase<'bill_of_lading'>
export type PreparedRlCarriersQuotedPickupRequest =
  RlCarriersPreparedRequestBase<'pickup_request'>
export type PreparedRlCarriersFreightRequest =
  | PreparedRlCarriersRateQuoteRequest
  | PreparedRlCarriersBillOfLadingRequest
  | PreparedRlCarriersQuotedPickupRequest

export type SealedRlCarriersFreightRequest = {
  adapterVersion: 'rl-carriers-freight-v1'
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  operation: RlCarriersFreightOperation
  providerMutationCount: 0
  method: 'POST'
  endpoint: string
  requestHash: string
  redactedRequest: RlCarriersRedactedRequestEvidence
}

export type RlCarriersNormalizedCharge = {
  type: string | null
  title: string | null
  weight: string | null
  rate: string | null
  amount: string | null
}

export type RlCarriersTariffBasis = 'class_ltl' | 'pallet_tariff'
export type RlCarriersTenderServiceLevel =
  | 'Standard'
  | 'Guaranteed'
  | 'GuaranteedByNoon'
  | 'GuaranteedHourlyWindow'
  | 'Expedited'

export type RlCarriersNormalizedRate = {
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  mode: 'ltl'
  tariffBasis: RlCarriersTariffBasis
  quoteNumber: string
  serviceCode: string
  serviceName: string
  netCharge: string
  grossCharge: string | null
  currency: 'USD'
  serviceDays: number | null
  hourlyWindow: { start: string; end: string } | null
  accessorials: string[]
  carrierChargeTypes: string[]
  isDirect: boolean | null
}

export type RlCarriersResponseEvidence = {
  requestHash: string
  providerPayloadHash: string
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  operation: RlCarriersFreightOperation
  redactedResponse: {
    successCode: 0 | 200
    messageCount: number
    resultCount: number
    tariffBasis: RlCarriersTariffBasis | null
    quoteNumberFingerprints: string[]
    proNumberFingerprint: string | null
    pickupRequestIdFingerprint: string | null
  }
}

export type ParsedRlCarriersRateQuoteResponse = {
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  mode: 'ltl'
  tariffBasis: RlCarriersTariffBasis
  requestedPalletTariff: boolean
  accessorials: string[]
  customerDiscount: string | null
  charges: RlCarriersNormalizedCharge[]
  rates: RlCarriersNormalizedRate[]
  messages: string[]
  evidence: RlCarriersResponseEvidence & { operation: 'rate_quote' }
  credentialVersion: number
  credentialFingerprint: string
  ratedPlan: RlCarriersRatedPlanEvidence
  integrityHash: string
}

export type RlCarriersRateSelectionInput = {
  parsedRateQuote: ParsedRlCarriersRateQuoteResponse
  selectedQuoteNumber: string
}

export type ParsedRlCarriersBillOfLadingResponse = {
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  quoteNumber: string
  proNumber: string
  pickupRequestId: string | null
  messages: string[]
  evidence: RlCarriersResponseEvidence & { operation: 'bill_of_lading' }
}

export type ParsedRlCarriersQuotedPickupResponse = {
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  quoteNumber: string
  pickupRequestId: string
  messages: string[]
  evidence: RlCarriersResponseEvidence & { operation: 'pickup_request' }
}

export type RlCarriersPartialMutationReconciliation = Readonly<{
  adapterVersion: 'rl-carriers-freight-v1'
  provider: RlCarriersFreightProvider
  executingCarrier: RlCarriersExecutingCarrier
  operation: 'bill_of_lading' | 'pickup_request'
  requestHash: string
  providerPayloadHash: string
  providerIds: Readonly<{
    proNumber: string | null
    pickupRequestId: string | null
  }>
  fingerprints: Readonly<{
    quoteNumber: string
    proNumber: string | null
    pickupRequestId: string | null
  }>
  successCode: 0 | 200
  messageCount: number
  missingRequiredIdentifiers: readonly (
    | 'pro_number'
    | 'pickup_request_id'
  )[]
}>

export class RlCarriersPartialMutationOutcomeError extends Error {
  readonly code = 'RL_CARRIERS_PARTIAL_MUTATION_OUTCOME' as const
  readonly reconciliation: RlCarriersPartialMutationReconciliation

  constructor(reconciliation: RlCarriersPartialMutationReconciliation) {
    super(
      `R+L ${reconciliation.operation} response omitted required provider identifier(s): ${reconciliation.missingRequiredIdentifiers.join(', ')}`,
    )
    this.name = 'RlCarriersPartialMutationOutcomeError'
    this.reconciliation = deepFreeze(reconciliation)
  }
}

const FREIGHT_CLASSES = new Set([
  '50',
  '55',
  '60',
  '65',
  '70',
  '77.5',
  '85',
  '92.5',
  '100',
  '110',
  '125',
  '150',
  '175',
  '200',
  '250',
  '300',
  '400',
  '500',
])
const RATE_QUOTE_ACCESSORIALS = new Set<string>([
  'InsideDelivery',
  'LimitedAccessPickup',
  'LimitedAccessDelivery',
  'OriginLiftgate',
  'DestinationLiftgate',
  'DeliveryAppointment',
  'InsidePickup',
  'Freezable',
  'SortAndSegregate',
  'OverDimension',
  'ResidentialDelivery',
  'ResidentialPickup',
])
const BILL_OF_LADING_ACCESSORIALS = new Set<string>([
  'InsideDelivery',
  'LimitedAccessPickup',
  'LimitedAccessDelivery',
  'OriginLiftgate',
  'DestinationLiftgate',
  'DeliveryAppointment',
  'InsidePickup',
  'Freezable',
  'ResidentialDelivery',
  'ResidentialPickup',
])
const PICKUP_REQUEST_ACCESSORIALS = new Set<string>([
  'LimitedAccessPickup',
  'InsidePickup',
  'Liftgate',
])
const SHA256 = /^[0-9a-f]{64}$/
const DIGITS = /^[0-9]+$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TWENTY_FOUR_HOUR_TIME = /^(\d{2}):(\d{2})$/
const MONEY = /^\$?((?:0|[1-9][0-9]{0,12})|(?:[1-9][0-9]{0,2}(?:,[0-9]{3})+))(?:\.([0-9]{1,2}))?$/

function codePointCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function fingerprint(kind: string, value: unknown) {
  return hash({ adapterVersion: 'rl-carriers-freight-v1', kind, value })
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

function object(
  value: unknown,
  label: string,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const result = value as Record<string, unknown>
  if (allowedKeys) {
    const allowed = new Set(allowedKeys)
    const unexpected = Object.keys(result).filter((key) => !allowed.has(key))
    if (unexpected.length > 0) {
      throw new Error(`${label} contains unsupported field ${unexpected.sort(codePointCompare)[0]}`)
    }
  }
  return result
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
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

function optionalPlainText(
  value: unknown,
  label: string,
  maximum: number,
) {
  if (value === undefined || value === null || value === '') return null
  return plainText(value, label, maximum)
}

function positiveInteger(value: unknown, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`)
  }
  return Number(value)
}

function credentialFingerprint(value: unknown, label: string) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint`)
  }
  return value
}

function measure(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be greater than 0 and no more than ${maximum}`)
  }
  const normalized = Number(value.toFixed(3))
  if (Math.abs(normalized - value) > 1e-9) {
    throw new Error(`${label} must use no more than three decimal places`)
  }
  return normalized
}

function canonicalMeasure(value: number) {
  return Number.isInteger(value) ? String(value) : String(value)
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}

function optionalBoolean(value: unknown, label: string, fallback: boolean) {
  if (value === undefined) return fallback
  return booleanValue(value, label)
}

function freightClass(value: unknown, label: string) {
  const normalized = typeof value === 'number'
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : ''
  if (!FREIGHT_CLASSES.has(normalized)) {
    throw new Error(`${label} must be a recognized LTL freight class`)
  }
  return normalized
}

function carrierIdentifier(value: unknown, label: string, maximum = 32) {
  const normalized = plainText(value, label, maximum)
  if (!DIGITS.test(normalized)) throw new Error(`${label} must contain only digits`)
  return normalized
}

function optionalCarrierIdentifier(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') {
    return carrierIdentifier(String(positiveInteger(value, label, 2_147_483_647)), label)
  }
  return carrierIdentifier(value, label)
}

function servicePoint(
  value: unknown,
  label: string,
): RlCarriersServicePointInput {
  const input = object(value, label, [
    'city',
    'stateOrProvince',
    'zipOrPostalCode',
    'countryCode',
  ])
  const city = plainText(input.city, `${label}.city`, 60)
  if (!/^[A-Za-z0-9 .'-]+$/.test(city)) {
    throw new Error(`${label}.city contains unsupported characters`)
  }
  const stateOrProvince = plainText(
    input.stateOrProvince,
    `${label}.stateOrProvince`,
    3,
  ).toUpperCase()
  if (!/^[A-Z]{2,3}$/.test(stateOrProvince)) {
    throw new Error(`${label}.stateOrProvince must be a 2-3 letter code`)
  }
  const zipOrPostalCode = plainText(
    input.zipOrPostalCode,
    `${label}.zipOrPostalCode`,
    10,
  ).toUpperCase()
  if (!/^[A-Z0-9 -]{3,10}$/.test(zipOrPostalCode)) {
    throw new Error(`${label}.zipOrPostalCode is invalid`)
  }
  const countryCode = plainText(
    input.countryCode,
    `${label}.countryCode`,
    3,
  ).toUpperCase()
  if (!/^[A-Z]{3}$/.test(countryCode)) {
    throw new Error(`${label}.countryCode must be an ISO3 country code`)
  }
  return { city, stateOrProvince, zipOrPostalCode, countryCode }
}

function phoneNumber(value: unknown, label: string) {
  const raw = plainText(value, label, 30)
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 10) throw new Error(`${label} must contain ten digits`)
  return digits
}

function emailAddress(value: unknown, label: string) {
  const normalized = optionalPlainText(value, label, 254)
  if (normalized === null) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${label} must be an email address`)
  }
  return normalized
}

function party(
  value: unknown,
  label: string,
  extraAllowedKeys: readonly string[] = [],
) {
  const input = object(value, label, [
    'companyName',
    'addressLine1',
    'addressLine2',
    'phoneNumber',
    'emailAddress',
    'city',
    'stateOrProvince',
    'zipOrPostalCode',
    'countryCode',
    ...extraAllowedKeys,
  ])
  const point = servicePoint({
    city: input.city,
    stateOrProvince: input.stateOrProvince,
    zipOrPostalCode: input.zipOrPostalCode,
    countryCode: input.countryCode,
  }, `${label}.servicePoint`)
  const normalized = {
    CompanyName: plainText(input.companyName, `${label}.companyName`, 80),
    AddressLine1: plainText(input.addressLine1, `${label}.addressLine1`, 100),
    AddressLine2: optionalPlainText(input.addressLine2, `${label}.addressLine2`, 100),
    PhoneNumber: phoneNumber(input.phoneNumber, `${label}.phoneNumber`),
    EmailAddress: emailAddress(input.emailAddress, `${label}.emailAddress`),
    City: point.city,
    StateOrProvince: point.stateOrProvince,
    ZipOrPostalCode: point.zipOrPostalCode,
    CountryCode: point.countryCode,
  }
  return Object.fromEntries(
    Object.entries(normalized).filter(([, item]) => item !== null),
  )
}

function carrierServicePoint(value: RlCarriersServicePointInput) {
  return {
    City: value.city,
    StateOrProvince: value.stateOrProvince,
    ZipOrPostalCode: value.zipOrPostalCode,
    CountryCode: value.countryCode,
  }
}

function isoDate(value: unknown, label: string) {
  const normalized = plainText(value, label, 10)
  const match = ISO_DATE.exec(normalized)
  if (!match) throw new Error(`${label} must use YYYY-MM-DD`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a real calendar date`)
  }
  return {
    iso: normalized,
    carrier: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
  }
}

function carrierTime(value: unknown, label: string) {
  const normalized = plainText(value, label, 5)
  const match = TWENTY_FOUR_HOUR_TIME.exec(normalized)
  if (!match) throw new Error(`${label} must use HH:MM`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error(`${label} is invalid`)
  const suffix = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 || 12
  return {
    minutes: hour * 60 + minute,
    carrier: `${String(displayHour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${suffix}`,
  }
}

function normalizeMoney(value: unknown, label: string) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${label} must be USD money`)
  }
  const raw = String(value).trim()
  const match = MONEY.exec(raw)
  if (!match) throw new Error(`${label} must be non-negative USD money`)
  const major = match[1].replace(/,/g, '')
  const minor = (match[2] || '').padEnd(2, '0')
  return `${BigInt(major)}.${minor}`
}

function optionalResponseMoney(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${label} must be USD money text`)
  return normalizeMoney(value, label)
}

function responseMoney(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be USD money text`)
  return normalizeMoney(value, label)
}

function moneyNumber(value: unknown, label: string, allowZero: boolean) {
  const normalized = normalizeMoney(value, label)
  if (!allowZero && normalized === '0.00') {
    throw new Error(`${label} must be greater than zero`)
  }
  const numeric = Number(normalized)
  if (!Number.isSafeInteger(Math.round(numeric * 100))) {
    throw new Error(`${label} is too large`)
  }
  return numeric
}

function accessorials(
  value: unknown,
  label: string,
  operation: RlCarriersFreightOperation,
) {
  if (value === undefined) return []
  const input = array(value, label)
  if (input.length > 32) throw new Error(`${label} supports at most 32 values`)
  const allowed = operation === 'rate_quote'
    ? RATE_QUOTE_ACCESSORIALS
    : operation === 'bill_of_lading'
      ? BILL_OF_LADING_ACCESSORIALS
      : PICKUP_REQUEST_ACCESSORIALS
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of input.entries()) {
    const normalized = plainText(item, `${label}[${index}]`, 80)
    if (item !== normalized || !allowed.has(normalized)) {
      throw new Error(`${label}[${index}] is not supported for ${operation}`)
    }
    if (seen.has(normalized)) {
      throw new Error(`${label} cannot repeat ${normalized}`)
    }
    seen.add(normalized)
    result.push(normalized)
  }
  if (seen.has('ResidentialPickup') && seen.has('LimitedAccessPickup')) {
    throw new Error(`${label} cannot combine ResidentialPickup and LimitedAccessPickup`)
  }
  if (seen.has('ResidentialDelivery') && seen.has('LimitedAccessDelivery')) {
    throw new Error(`${label} cannot combine ResidentialDelivery and LimitedAccessDelivery`)
  }
  return result.sort(codePointCompare)
}

function pickupAccessorialsFromRate(rateAccessorials: string[]) {
  const projected: RlCarriersPickupRequestAccessorial[] = []
  if (rateAccessorials.includes('InsidePickup')) projected.push('InsidePickup')
  if (rateAccessorials.includes('LimitedAccessPickup')) {
    projected.push('LimitedAccessPickup')
  }
  if (rateAccessorials.includes('OriginLiftgate')) projected.push('Liftgate')
  return projected.sort(codePointCompare)
}

function stringSet(value: unknown, label: string, maximumItems = 32) {
  if (value === undefined) return []
  const input = array(value, label)
  if (input.length > maximumItems) {
    throw new Error(`${label} supports at most ${maximumItems} values`)
  }
  return [...new Set(input.map((item, index) => plainText(
    item,
    `${label}[${index}]`,
    80,
  )))].sort(codePointCompare)
}

function rateSelection(value: unknown, label: string) {
  const input = object(value, label, [
    'parsedRateQuote',
    'selectedQuoteNumber',
  ])
  const parsed = assertParsedRateQuoteIntegrity(
    input.parsedRateQuote,
    `${label}.parsedRateQuote`,
  )
  const quoteNumber = carrierIdentifier(
    input.selectedQuoteNumber,
    `${label}.selectedQuoteNumber`,
  )
  const matches = parsed.rates.filter((rate) => rate.quoteNumber === quoteNumber)
  if (matches.length !== 1) {
    throw new Error(`${label}.selectedQuoteNumber is not an offered quote`)
  }
  const rate = matches[0]
  const tenderService = tenderServiceLevel(
    rate,
    `${label}.parsedRateQuote selected rate`,
  )
  if (tenderService.serviceLevel === 'Expedited') {
    throw new Error(
      `${label} cannot tender Expedited without a distinct expedited quote binding`,
    )
  }
  const selectedRateFingerprint = fingerprint('selected_rate', {
    rateRequestHash: parsed.evidence.requestHash,
    rateResponseIntegrityHash: parsed.integrityHash,
    credentialVersion: parsed.credentialVersion,
    credentialFingerprint: parsed.credentialFingerprint,
    tariffBasis: parsed.tariffBasis,
    accessorials: parsed.accessorials,
    rate,
  })
  return {
    quoteNumber,
    serviceLevel: tenderService.serviceLevel,
    hourlyWindow: tenderService.hourlyWindow,
    rate,
    credentialVersion: parsed.credentialVersion,
    credentialFingerprint: parsed.credentialFingerprint,
    evidence: {
      rateRequestHash: parsed.evidence.requestHash,
      rateResponseIntegrityHash: parsed.integrityHash,
      selectedRateFingerprint,
      tariffBasis: parsed.tariffBasis,
      accessorials: parsed.accessorials,
      ratedPlan: parsed.ratedPlan,
    } satisfies RlCarriersRateSelectionEvidence,
  }
}

function rateItem(value: unknown, label: string) {
  const input = object(value, label, [
    'freightClass',
    'weightLb',
    'lengthIn',
    'widthIn',
    'heightIn',
  ])
  return {
    Width: measure(input.widthIn, `${label}.widthIn`, 96),
    Height: measure(input.heightIn, `${label}.heightIn`, 96),
    Length: measure(input.lengthIn, `${label}.lengthIn`, 480),
    Class: freightClass(input.freightClass, `${label}.freightClass`),
    Weight: positiveInteger(input.weightLb, `${label}.weightLb`, 19_999),
  }
}

function palletTariff(value: unknown, label: string) {
  const input = object(value, label, ['code', 'weightLb', 'quantity'])
  const code = plainText(input.code, `${label}.code`, 4)
  if (!/^[0-9]{4}$/.test(code)) {
    throw new Error(`${label}.code must be exactly four digits`)
  }
  return {
    Code: code,
    Weight: positiveInteger(input.weightLb, `${label}.weightLb`, 2_147_483_647),
    Quantity: positiveInteger(input.quantity, `${label}.quantity`, 999),
  }
}

function total(values: number[], label: string, maximum = 2_147_483_647) {
  const result = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isSafeInteger(result) || result > maximum) {
    throw new Error(`${label} exceeds the supported total`)
  }
  return result
}

type RlCarriersCanonicalRatedItem = {
  freightClass: string
  weightLb: number
  lengthIn: number
  widthIn: number
  heightIn: number
}

type RlCarriersCanonicalRatedPallet = {
  code: string
  weightLb: number
  quantity: number
}

function canonicalRatedItems(items: RlCarriersCanonicalRatedItem[]) {
  return items
    .map((item) => ({
      freightClass: freightClass(item.freightClass, 'rated item freightClass'),
      weightLb: positiveInteger(item.weightLb, 'rated item weightLb', 19_999),
      lengthIn: measure(item.lengthIn, 'rated item lengthIn', 480),
      widthIn: measure(item.widthIn, 'rated item widthIn', 96),
      heightIn: measure(item.heightIn, 'rated item heightIn', 96),
    }))
    .sort((left, right) => codePointCompare(stable(left), stable(right)))
}

function canonicalRatedPallets(
  pallets: RlCarriersCanonicalRatedPallet[],
) {
  const normalized = pallets
    .map((pallet, index) => {
      const code = plainText(pallet.code, `rated pallet[${index}].code`, 4)
      if (!/^[0-9]{4}$/.test(code)) {
        throw new Error(`rated pallet[${index}].code must be exactly four digits`)
      }
      return {
        code,
        weightLb: positiveInteger(
          pallet.weightLb,
          `rated pallet[${index}].weightLb`,
          2_147_483_647,
        ),
        quantity: positiveInteger(
          pallet.quantity,
          `rated pallet[${index}].quantity`,
          999,
        ),
      }
    })
    .sort((left, right) => codePointCompare(stable(left), stable(right)))
  if (new Set(normalized.map((pallet) => pallet.code)).size !== normalized.length) {
    throw new Error('rated pallets must combine weight and quantity by pallet code')
  }
  return normalized
}

function ratedPlanEvidence(input: {
  origin: RlCarriersServicePointInput
  destination: RlCarriersServicePointInput
  items: RlCarriersCanonicalRatedItem[]
  pallets: RlCarriersCanonicalRatedPallet[]
}, label: string): RlCarriersRatedPlanEvidence {
  const items = canonicalRatedItems(input.items)
  const pallets = canonicalRatedPallets(input.pallets)
  const originFingerprint = fingerprint('origin', input.origin)
  const destinationFingerprint = fingerprint('destination', input.destination)
  const itemCount = items.length
  const totalWeightLb = total(items.map((item) => item.weightLb), `${label} weight`)
  const palletCount = total(
    pallets.map((pallet) => pallet.quantity),
    `${label} pallet count`,
  )
  const palletWeightLb = total(
    pallets.map((pallet) => pallet.weightLb),
    `${label} pallet weight`,
  )
  if (
    pallets.length > 0
    && (palletCount !== itemCount || palletWeightLb !== totalWeightLb)
  ) {
    throw new Error(
      `${label} pallet tariff count and combined weight must match its handling units`,
    )
  }
  return {
    planHash: fingerprint('rated_plan', {
      origin: input.origin,
      destination: input.destination,
      items,
      pallets,
    }),
    originFingerprint,
    destinationFingerprint,
    itemCount,
    totalWeightLb,
    pallets,
    palletCount,
    palletWeightLb,
  }
}

function servicePointFromCarrierParty(
  value: Record<string, unknown>,
  label: string,
) {
  return servicePoint({
    city: value.City,
    stateOrProvince: value.StateOrProvince,
    zipOrPostalCode: value.ZipOrPostalCode,
    countryCode: value.CountryCode,
  }, label)
}

function assertRatedPlanMatch(
  expected: RlCarriersRatedPlanEvidence,
  actual: RlCarriersRatedPlanEvidence,
  label: string,
) {
  if (stable(expected) !== stable(actual)) {
    throw new Error(`${label} has drifted from the selected R+L rate request`)
  }
}

function requestHash(
  operation: RlCarriersFreightOperation,
  endpoint: string,
  body: Record<string, unknown>,
  redactedRequest: RlCarriersRedactedRequestEvidence,
) {
  return hash({
    adapterVersion: 'rl-carriers-freight-v1',
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    operation,
    method: 'POST',
    endpoint,
    body,
    redactedRequest,
  })
}

function prepare<Operation extends RlCarriersFreightOperation>(input: {
  operation: Operation
  endpoint: string
  body: Record<string, unknown>
  redactedRequest: RlCarriersRedactedRequestEvidence & { operation: Operation }
}): RlCarriersPreparedRequestBase<Operation> {
  return deepFreeze({
    adapterVersion: 'rl-carriers-freight-v1' as const,
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    operation: input.operation,
    providerMutationCount: 0 as const,
    method: 'POST' as const,
    endpoint: input.endpoint,
    body: input.body,
    requestHash: requestHash(
      input.operation,
      input.endpoint,
      input.body,
      input.redactedRequest,
    ),
    redactedRequest: input.redactedRequest,
  })
}

function baseEvidence(input: {
  operation: RlCarriersFreightOperation
  providerWriteIntent: RlCarriersRedactedRequestEvidence['providerWriteIntent']
  pickupBinding: RlCarriersRedactedRequestEvidence['pickupBinding']
  credentialVersion: number
  credentialFingerprint: string
  rateSelection: RlCarriersRateSelectionEvidence | null
  ratedPlan: RlCarriersRatedPlanEvidence
  accessorials: string[]
  quoteNumber: string | null
  origin: unknown
  destination: unknown
  handlingUnitCount: number
  totalWeightLb: number
  commodityCount: number
  palletTariffRequested: boolean
}): RlCarriersRedactedRequestEvidence {
  return {
    adapterVersion: 'rl-carriers-freight-v1',
    sourceContract: 'rlc-public-swagger-v1-2026-08-11',
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    operation: input.operation,
    providerMutationCount: 0,
    credentialVersion: input.credentialVersion,
    credentialFingerprint: input.credentialFingerprint,
    providerWriteIntent: input.providerWriteIntent,
    pickupBinding: input.pickupBinding,
    rateSelection: input.rateSelection,
    ratedPlan: input.ratedPlan,
    accessorials: input.accessorials,
    quoteNumberFingerprint: input.quoteNumber === null
      ? null
      : fingerprint('quote_number', input.quoteNumber),
    route: {
      originFingerprint: fingerprint('origin', input.origin),
      destinationFingerprint: fingerprint('destination', input.destination),
    },
    freight: {
      handlingUnitCount: input.handlingUnitCount,
      totalWeightLb: input.totalWeightLb,
      commodityCount: input.commodityCount,
      palletTariffRequested: input.palletTariffRequested,
    },
  }
}

export function prepareRlCarriersRateQuoteRequest(
  value: RlCarriersRateQuoteInput,
): PreparedRlCarriersRateQuoteRequest {
  const input = object(value, 'R+L rate quote input', [
    'credentialVersion',
    'credentialFingerprint',
    'pickupDate',
    'origin',
    'destination',
    'items',
    'pallets',
    'accessorials',
    'declaredValueUsd',
  ])
  const normalizedCredentialVersion = positiveInteger(
    input.credentialVersion,
    'credentialVersion',
    2_147_483_647,
  )
  const normalizedCredentialFingerprint = credentialFingerprint(
    input.credentialFingerprint,
    'credentialFingerprint',
  )
  const pickupDate = isoDate(input.pickupDate, 'pickupDate')
  const origin = servicePoint(input.origin, 'origin')
  const destination = servicePoint(input.destination, 'destination')
  const itemInputs = array(input.items, 'items')
  if (itemInputs.length < 1 || itemInputs.length > 100) {
    throw new Error('items must contain 1-100 palletized freight items')
  }
  const items = itemInputs.map((item, index) => rateItem(item, `items[${index}]`))
  const palletInputs = input.pallets === undefined
    ? []
    : array(input.pallets, 'pallets')
  if (palletInputs.length > 100) throw new Error('pallets supports at most 100 entries')
  const pallets = palletInputs.map((item, index) => palletTariff(item, `pallets[${index}]`))
  const normalizedAccessorials = accessorials(
    input.accessorials,
    'accessorials',
    'rate_quote',
  )
  const rateQuote: Record<string, unknown> = {
    Origin: carrierServicePoint(origin),
    Destination: carrierServicePoint(destination),
    Items: items,
    AdditionalServices: normalizedAccessorials,
    PickupDate: pickupDate.carrier,
  }
  if (pallets.length > 0) rateQuote.Pallets = pallets
  if (input.declaredValueUsd !== undefined && input.declaredValueUsd !== null) {
    rateQuote.DeclaredValue = moneyNumber(
      input.declaredValueUsd,
      'declaredValueUsd',
      true,
    )
  }
  const body = { RateQuote: rateQuote }
  const totalWeightLb = total(items.map((item) => item.Weight), 'item weight')
  const ratedPlan = ratedPlanEvidence({
    origin,
    destination,
    items: items.map((item) => ({
      freightClass: item.Class,
      weightLb: item.Weight,
      lengthIn: item.Length,
      widthIn: item.Width,
      heightIn: item.Height,
    })),
    pallets: pallets.map((pallet) => ({
      code: pallet.Code,
      weightLb: pallet.Weight,
      quantity: pallet.Quantity,
    })),
  }, 'R+L rate request rated plan')
  return prepare({
    operation: 'rate_quote',
    endpoint: RL_CARRIERS_FREIGHT_ENDPOINTS.rateQuote,
    body,
    redactedRequest: baseEvidence({
      operation: 'rate_quote',
      providerWriteIntent: null,
      pickupBinding: 'none',
      credentialVersion: normalizedCredentialVersion,
      credentialFingerprint: normalizedCredentialFingerprint,
      rateSelection: null,
      ratedPlan,
      accessorials: normalizedAccessorials,
      quoteNumber: null,
      origin,
      destination,
      handlingUnitCount: items.length,
      totalWeightLb,
      commodityCount: items.length,
      palletTariffRequested: pallets.length > 0,
    }) as RlCarriersRedactedRequestEvidence & { operation: 'rate_quote' },
  })
}

function handlingUnitItem(value: unknown, label: string) {
  const input = object(value, label, [
    'pieces',
    'packageType',
    'description',
    'freightClass',
    'weightLb',
    'nmfcItemNumber',
    'nmfcSubNumber',
  ])
  const result: Record<string, unknown> = {
    IsHazmat: false,
    Pieces: positiveInteger(input.pieces, `${label}.pieces`, 9999),
    PackageType: plainText(input.packageType, `${label}.packageType`, 20),
    Description: plainText(input.description, `${label}.description`, 200),
    Class: freightClass(input.freightClass, `${label}.freightClass`),
    Weight: positiveInteger(input.weightLb, `${label}.weightLb`, 19_999),
  }
  const nmfcItemNumber = optionalPlainText(
    input.nmfcItemNumber,
    `${label}.nmfcItemNumber`,
    20,
  )
  const nmfcSubNumber = optionalPlainText(
    input.nmfcSubNumber,
    `${label}.nmfcSubNumber`,
    20,
  )
  if (nmfcSubNumber !== null && nmfcItemNumber === null) {
    throw new Error(`${label}.nmfcSubNumber requires nmfcItemNumber`)
  }
  if (nmfcItemNumber !== null) result.NMFCItemNumber = nmfcItemNumber
  if (nmfcSubNumber !== null) result.NMFCSubNumber = nmfcSubNumber
  return result
}

function handlingUnit(value: unknown, label: string) {
  const input = object(value, label, [
    'unitType',
    'quantity',
    'lengthIn',
    'widthIn',
    'heightIn',
    'items',
  ])
  const unitType = plainText(input.unitType, `${label}.unitType`, 3).toUpperCase()
  if (unitType !== 'PLT') throw new Error(`${label}.unitType must be PLT`)
  const quantity = positiveInteger(input.quantity, `${label}.quantity`, 999)
  if (quantity !== 1) {
    throw new Error(`${label}.quantity must be 1 for exact rated-plan binding`)
  }
  const lengthIn = measure(input.lengthIn, `${label}.lengthIn`, 480)
  const widthIn = measure(input.widthIn, `${label}.widthIn`, 96)
  const heightIn = measure(input.heightIn, `${label}.heightIn`, 96)
  const itemInputs = array(input.items, `${label}.items`)
  if (itemInputs.length !== 1) {
    throw new Error(`${label}.items must contain exactly one rated commodity`)
  }
  const items = itemInputs.map((item, index) => handlingUnitItem(
    item,
    `${label}.items[${index}]`,
  ))
  return {
    carrier: {
      UnitType: unitType,
      Dimensions: [{
        Count: quantity,
        Length: canonicalMeasure(lengthIn),
        Width: canonicalMeasure(widthIn),
        Height: canonicalMeasure(heightIn),
      }],
      Items: items,
    },
    quantity,
    totalWeightLb: total(
      items.map((item) => Number(item.Weight)),
      `${label} weight`,
    ),
    commodityCount: items.length,
    ratedItem: {
      freightClass: String(items[0].Class),
      weightLb: Number(items[0].Weight),
      lengthIn,
      widthIn,
      heightIn,
    },
  }
}

function declaredValue(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  const input = object(value, label, ['amountUsd', 'per'])
  return {
    Amount: moneyNumber(input.amountUsd, `${label}.amountUsd`, false),
    Per: plainText(input.per, `${label}.per`, 40),
  }
}

function embeddedPickupRequest(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  const input = object(value, label, [
    'pickupDate',
    'readyTime',
    'closeTime',
    'additionalInstructions',
    'loadAttributes',
    'contact',
    'sendEmailConfirmation',
    'shipperReferenceNumber',
  ])
  const pickupDate = isoDate(input.pickupDate, `${label}.pickupDate`)
  const readyTime = carrierTime(input.readyTime, `${label}.readyTime`)
  const closeTime = carrierTime(input.closeTime, `${label}.closeTime`)
  if (closeTime.minutes <= readyTime.minutes) {
    throw new Error(`${label}.closeTime must be later than ${label}.readyTime`)
  }
  const pickupInformation: Record<string, unknown> = {
    PickupDate: pickupDate.carrier,
    ReadyTime: readyTime.carrier,
    CloseTime: closeTime.carrier,
    LoadAttributes: stringSet(input.loadAttributes, `${label}.loadAttributes`),
  }
  const additionalInstructions = optionalPlainText(
    input.additionalInstructions,
    `${label}.additionalInstructions`,
    500,
  )
  if (additionalInstructions !== null) {
    pickupInformation.AdditionalInstructions = additionalInstructions
  }
  const result: Record<string, unknown> = {
    PickupInformation: pickupInformation,
    SendEmailConfirmation: optionalBoolean(
      input.sendEmailConfirmation,
      `${label}.sendEmailConfirmation`,
      false,
    ),
  }
  const contact = pickupContact(input.contact, `${label}.contact`)
  if (contact !== null) result.Contact = contact
  const shipperReferenceNumber = optionalPlainText(
    input.shipperReferenceNumber,
    `${label}.shipperReferenceNumber`,
    80,
  )
  if (shipperReferenceNumber !== null) {
    result.ShipperReferenceNumber = shipperReferenceNumber
  }
  return result
}

export function prepareRlCarriersBillOfLadingRequest(
  value: RlCarriersBillOfLadingInput,
): PreparedRlCarriersBillOfLadingRequest {
  const input = object(value, 'R+L bill of lading input', [
    'bolDate',
    'rateSelection',
    'shipper',
    'consignee',
    'handlingUnits',
    'specialInstructions',
    'declaredValue',
    'referenceNumbers',
    'freightChargePaymentMethod',
    'pickupRequest',
  ])
  const bolDate = isoDate(input.bolDate, 'bolDate')
  const quote = rateSelection(input.rateSelection, 'rateSelection')
  const shipper = party(input.shipper, 'shipper')
  const consigneeInput = object(input.consignee, 'consignee')
  const consignee = party(consigneeInput, 'consignee', ['attention'])
  const originPoint = servicePointFromCarrierParty(shipper, 'shipper.servicePoint')
  const destinationPoint = servicePointFromCarrierParty(
    consignee,
    'consignee.servicePoint',
  )
  const attention = optionalPlainText(consigneeInput.attention, 'consignee.attention', 80)
  if (attention !== null) consignee.Attention = attention
  const unitInputs = array(input.handlingUnits, 'handlingUnits')
  if (unitInputs.length < 1 || unitInputs.length > 50) {
    throw new Error('handlingUnits must contain 1-50 pallet handling units')
  }
  const units = unitInputs.map((item, index) => handlingUnit(
    item,
    `handlingUnits[${index}]`,
  ))
  const actualRatedPlan = ratedPlanEvidence({
    origin: originPoint,
    destination: destinationPoint,
    items: units.map((unit) => unit.ratedItem),
    pallets: quote.evidence.ratedPlan.pallets,
  }, 'R+L bill of lading rated plan')
  assertRatedPlanMatch(
    quote.evidence.ratedPlan,
    actualRatedPlan,
    'R+L bill of lading shipment plan',
  )
  const normalizedAccessorials = accessorials(
    quote.evidence.accessorials,
    'rateSelection.parsedRateQuote.accessorials',
    'bill_of_lading',
  )
  const paymentMethod = plainText(
    input.freightChargePaymentMethod,
    'freightChargePaymentMethod',
    20,
  )
  if (!['Prepaid', 'Collect'].includes(paymentMethod)) {
    throw new Error('freightChargePaymentMethod is unsupported')
  }
  const referencesInput = input.referenceNumbers === undefined
    ? {}
    : object(input.referenceNumbers, 'referenceNumbers', [
      'shipperNumber',
      'purchaseOrderNumber',
    ])
  const referenceNumbers: Record<string, unknown> = {
    RateQuoteNumber: quote.quoteNumber,
  }
  const shipperNumber = optionalPlainText(
    referencesInput.shipperNumber,
    'referenceNumbers.shipperNumber',
    80,
  )
  const purchaseOrderNumber = optionalPlainText(
    referencesInput.purchaseOrderNumber,
    'referenceNumbers.purchaseOrderNumber',
    80,
  )
  if (shipperNumber !== null) referenceNumbers.ShipperNumber = shipperNumber
  if (purchaseOrderNumber !== null) referenceNumbers.PONumber = purchaseOrderNumber
  const billOfLading: Record<string, unknown> = {
    BOLDate: bolDate.carrier,
    Shipper: shipper,
    Consignee: consignee,
    AdditionalServices: normalizedAccessorials,
    HandlingUnits: units.map((unit) => unit.carrier),
    ReferenceNumbers: referenceNumbers,
    FreightChargePaymentMethod: paymentMethod,
    ServiceLevel: quote.serviceLevel,
  }
  if (quote.hourlyWindow !== null) {
    billOfLading.HourlyWindow = {
      Start: quote.hourlyWindow.start,
      End: quote.hourlyWindow.end,
    }
  }
  const normalizedDeclaredValue = declaredValue(input.declaredValue, 'declaredValue')
  if (normalizedDeclaredValue !== null) {
    billOfLading.DeclaredValue = normalizedDeclaredValue
  }
  const specialInstructions = optionalPlainText(
    input.specialInstructions,
    'specialInstructions',
    500,
  )
  if (specialInstructions !== null) {
    billOfLading.SpecialInstructions = specialInstructions
  }
  const normalizedPickupRequest = embeddedPickupRequest(
    input.pickupRequest,
    'pickupRequest',
  )
  const body: Record<string, unknown> = {
    BillOfLading: billOfLading,
    GenerateUniversalPro: true,
  }
  if (normalizedPickupRequest !== null) {
    body.PickupRequest = normalizedPickupRequest
  }
  return prepare({
    operation: 'bill_of_lading',
    endpoint: RL_CARRIERS_FREIGHT_ENDPOINTS.billOfLading,
    body,
    redactedRequest: baseEvidence({
      operation: 'bill_of_lading',
      providerWriteIntent: normalizedPickupRequest === null
        ? 'bill_of_lading.create'
        : 'bill_of_lading_with_pickup.create',
      pickupBinding: normalizedPickupRequest === null
        ? 'none'
        : 'bill_of_lading_embedded',
      credentialVersion: quote.credentialVersion,
      credentialFingerprint: quote.credentialFingerprint,
      rateSelection: quote.evidence,
      ratedPlan: actualRatedPlan,
      accessorials: normalizedAccessorials,
      quoteNumber: quote.quoteNumber,
      origin: originPoint,
      destination: destinationPoint,
      handlingUnitCount: total(units.map((unit) => unit.quantity), 'handling unit count'),
      totalWeightLb: total(units.map((unit) => unit.totalWeightLb), 'handling unit weight'),
      commodityCount: total(units.map((unit) => unit.commodityCount), 'commodity count'),
      palletTariffRequested: false,
    }) as RlCarriersRedactedRequestEvidence & { operation: 'bill_of_lading' },
  })
}

function pickupHandlingUnit(value: unknown, label: string) {
  const input = object(value, label, [
    'quantity',
    'freightClass',
    'weightLb',
    'lengthIn',
    'widthIn',
    'heightIn',
  ])
  const quantity = positiveInteger(input.quantity, `${label}.quantity`, 999)
  if (quantity !== 1) {
    throw new Error(`${label}.quantity must be 1 for exact rated-plan binding`)
  }
  const normalizedFreightClass = freightClass(
    input.freightClass,
    `${label}.freightClass`,
  )
  const weightLb = positiveInteger(input.weightLb, `${label}.weightLb`, 19_999)
  const lengthIn = measure(input.lengthIn, `${label}.lengthIn`, 480)
  const widthIn = measure(input.widthIn, `${label}.widthIn`, 96)
  const heightIn = measure(input.heightIn, `${label}.heightIn`, 96)
  return {
    quantity,
    totalWeightLb: weightLb * quantity,
    ratedItem: {
      freightClass: normalizedFreightClass,
      weightLb,
      lengthIn,
      widthIn,
      heightIn,
    },
    carrier: {
      Units: quantity,
      Width: widthIn,
      Height: heightIn,
      Length: lengthIn,
    },
  }
}

function pickupContact(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  const input = object(value, label, [
    'name',
    'companyName',
    'phoneNumber',
    'emailAddress',
  ])
  const result: Record<string, unknown> = {
    Name: plainText(input.name, `${label}.name`, 50),
    PhoneNumber: phoneNumber(input.phoneNumber, `${label}.phoneNumber`),
  }
  const companyName = optionalPlainText(input.companyName, `${label}.companyName`, 80)
  const email = emailAddress(input.emailAddress, `${label}.emailAddress`)
  if (companyName !== null) result.CompanyName = companyName
  if (email !== null) result.EmailAddress = email
  return result
}

export function prepareRlCarriersQuotedPickupRequest(
  value: RlCarriersQuotedPickupRequestInput,
): PreparedRlCarriersQuotedPickupRequest {
  const input = object(value, 'R+L pickup request input', [
    'rateSelection',
    'shipper',
    'contact',
    'destination',
    'handlingUnits',
    'pickupDate',
    'readyTime',
    'closeTime',
    'additionalInstructions',
    'loadAttributes',
    'sendEmailConfirmation',
  ])
  const quote = rateSelection(input.rateSelection, 'rateSelection')
  const shipperInput = object(input.shipper, 'shipper')
  const shipper = party(shipperInput, 'shipper', [
    'contactName',
    'shipperReferenceNumber',
  ])
  const contactName = optionalPlainText(
    shipperInput.contactName,
    'shipper.contactName',
    80,
  )
  const shipperReferenceNumber = optionalPlainText(
    shipperInput.shipperReferenceNumber,
    'shipper.shipperReferenceNumber',
    80,
  )
  if (contactName !== null) shipper.ContactName = contactName
  if (shipperReferenceNumber !== null) {
    shipper.ShipperReferenceNumber = shipperReferenceNumber
  }
  const originPoint = servicePointFromCarrierParty(shipper, 'shipper.servicePoint')
  const destination = servicePoint(input.destination, 'destination')
  const unitInputs = array(input.handlingUnits, 'handlingUnits')
  if (unitInputs.length < 1 || unitInputs.length > 50) {
    throw new Error('handlingUnits must contain 1-50 pallet handling units')
  }
  const units = unitInputs.map((item, index) => pickupHandlingUnit(
    item,
    `handlingUnits[${index}]`,
  ))
  const actualRatedPlan = ratedPlanEvidence({
    origin: originPoint,
    destination,
    items: units.map((unit) => unit.ratedItem),
    pallets: quote.evidence.ratedPlan.pallets,
  }, 'R+L quoted pickup rated plan')
  assertRatedPlanMatch(
    quote.evidence.ratedPlan,
    actualRatedPlan,
    'R+L quoted pickup shipment plan',
  )
  const totalPieces = total(units.map((unit) => unit.quantity), 'pickup pieces')
  const totalWeightLb = total(units.map((unit) => unit.totalWeightLb), 'pickup weight')
  const normalizedAccessorials = pickupAccessorialsFromRate(
    quote.evidence.accessorials,
  )
  const loadAttributes = stringSet(input.loadAttributes, 'loadAttributes')
  const pickupDate = isoDate(input.pickupDate, 'pickupDate')
  const readyTime = carrierTime(input.readyTime, 'readyTime')
  const closeTime = carrierTime(input.closeTime, 'closeTime')
  if (closeTime.minutes <= readyTime.minutes) {
    throw new Error('closeTime must be later than readyTime')
  }
  const pickup: Record<string, unknown> = {
    Shipper: shipper,
    Destinations: [{
      Weight: totalWeightLb,
      Pieces: totalPieces,
      PackageType: 'PLT',
      Dimensions: units.map((unit) => unit.carrier),
      ...carrierServicePoint(destination),
    }],
    AdditionalServices: normalizedAccessorials,
    ServiceLevel: quote.serviceLevel,
    QuoteNumber: quote.quoteNumber,
    PickupDate: pickupDate.carrier,
    ReadyTime: readyTime.carrier,
    CloseTime: closeTime.carrier,
    LoadAttributes: loadAttributes,
  }
  if (quote.hourlyWindow !== null) {
    pickup.HourlyWindow = {
      Start: quote.hourlyWindow.start,
      End: quote.hourlyWindow.end,
    }
  }
  const contact = pickupContact(input.contact, 'contact')
  if (contact !== null) pickup.Contact = contact
  const additionalInstructions = optionalPlainText(
    input.additionalInstructions,
    'additionalInstructions',
    500,
  )
  if (additionalInstructions !== null) {
    pickup.AdditionalInstructions = additionalInstructions
  }
  const body = {
    Pickup: pickup,
    SendEmailConfirmation: optionalBoolean(
      input.sendEmailConfirmation,
      'sendEmailConfirmation',
      false,
    ),
  }
  return prepare({
    operation: 'pickup_request',
    endpoint: RL_CARRIERS_FREIGHT_ENDPOINTS.pickupRequest,
    body,
    redactedRequest: baseEvidence({
      operation: 'pickup_request',
      providerWriteIntent: 'pickup_request.create',
      pickupBinding: 'direct_quote',
      credentialVersion: quote.credentialVersion,
      credentialFingerprint: quote.credentialFingerprint,
      rateSelection: quote.evidence,
      ratedPlan: actualRatedPlan,
      accessorials: normalizedAccessorials,
      quoteNumber: quote.quoteNumber,
      origin: originPoint,
      destination,
      handlingUnitCount: totalPieces,
      totalWeightLb,
      commodityCount: 0,
      palletTariffRequested: false,
    }) as RlCarriersRedactedRequestEvidence & { operation: 'pickup_request' },
  })
}

function assertPreparedIntegrity<Operation extends RlCarriersFreightOperation>(
  prepared: RlCarriersPreparedRequestBase<Operation>,
  operation: Operation,
) {
  const ratedPlan = prepared.redactedRequest.ratedPlan
  const selection = prepared.redactedRequest.rateSelection
  if (
    prepared.adapterVersion !== 'rl-carriers-freight-v1'
    || prepared.provider !== RL_CARRIERS_FREIGHT_PROVIDER
    || prepared.executingCarrier.code !== RL_CARRIERS_EXECUTING_CARRIER.code
    || prepared.executingCarrier.name !== RL_CARRIERS_EXECUTING_CARRIER.name
    || prepared.operation !== operation
    || prepared.method !== 'POST'
    || prepared.providerMutationCount !== 0
    || !SHA256.test(prepared.requestHash)
    || !Number.isSafeInteger(prepared.redactedRequest.credentialVersion)
    || prepared.redactedRequest.credentialVersion < 1
    || !SHA256.test(prepared.redactedRequest.credentialFingerprint)
    || !SHA256.test(ratedPlan.planHash)
    || !SHA256.test(ratedPlan.originFingerprint)
    || !SHA256.test(ratedPlan.destinationFingerprint)
    || !Array.isArray(ratedPlan.pallets)
    || ratedPlan.pallets.some((pallet) => (
      !/^[0-9]{4}$/.test(pallet.code)
      || !Number.isSafeInteger(pallet.weightLb)
      || pallet.weightLb < 1
      || !Number.isSafeInteger(pallet.quantity)
      || pallet.quantity < 1
    ))
    || !Number.isSafeInteger(ratedPlan.palletCount)
    || ratedPlan.palletCount < 0
    || !Number.isSafeInteger(ratedPlan.palletWeightLb)
    || ratedPlan.palletWeightLb < 0
    || (operation === 'rate_quote') !== (selection === null)
    || (selection !== null && (
      !SHA256.test(selection.rateRequestHash)
      || !SHA256.test(selection.rateResponseIntegrityHash)
      || !SHA256.test(selection.selectedRateFingerprint)
      || stable(selection.ratedPlan) !== stable(ratedPlan)
    ))
  ) {
    throw new Error(`Prepared R+L ${operation} request is invalid`)
  }
  const expectedEndpoint = operation === 'rate_quote'
    ? RL_CARRIERS_FREIGHT_ENDPOINTS.rateQuote
    : operation === 'bill_of_lading'
      ? RL_CARRIERS_FREIGHT_ENDPOINTS.billOfLading
      : RL_CARRIERS_FREIGHT_ENDPOINTS.pickupRequest
  if (
    prepared.endpoint !== expectedEndpoint
    || requestHash(
      operation,
      expectedEndpoint,
      prepared.body,
      prepared.redactedRequest,
    ) !== prepared.requestHash
  ) {
    throw new Error(`Prepared R+L ${operation} request integrity check failed`)
  }
}

/**
 * Re-validates the endpoint, operation, body, and deterministic request hash.
 * A transport adapter should call this immediately before it adds transport
 * headers. The returned seal deliberately excludes the carrier request body.
 */
export function sealPreparedRlCarriersFreightRequest(
  prepared: PreparedRlCarriersFreightRequest,
): SealedRlCarriersFreightRequest {
  if (prepared.operation === 'rate_quote') {
    assertPreparedIntegrity(prepared, 'rate_quote')
  } else if (prepared.operation === 'bill_of_lading') {
    assertPreparedIntegrity(prepared, 'bill_of_lading')
  } else if (prepared.operation === 'pickup_request') {
    assertPreparedIntegrity(prepared, 'pickup_request')
  } else {
    throw new Error('Prepared R+L freight request operation is invalid')
  }
  return deepFreeze({
    adapterVersion: prepared.adapterVersion,
    provider: prepared.provider,
    executingCarrier: prepared.executingCarrier,
    operation: prepared.operation,
    providerMutationCount: prepared.providerMutationCount,
    method: prepared.method,
    endpoint: prepared.endpoint,
    requestHash: prepared.requestHash,
    redactedRequest: prepared.redactedRequest,
  })
}

function responseText(value: unknown, label: string, maximum = 2000) {
  return plainText(value, label, maximum)
}

function responseMessages(value: unknown, label: string) {
  if (value === undefined || value === null) return []
  return array(value, label).map((item, index) => responseText(
    item,
    `${label}[${index}]`,
  ))
}

function responseEnvelope(payload: unknown, label: string) {
  const response = object(payload, label)
  const errors = response.Errors === undefined || response.Errors === null
    ? []
    : array(response.Errors, `${label}.Errors`)
  for (const [index, item] of errors.entries()) {
    object(item, `${label}.Errors[${index}]`)
  }
  if (errors.length > 0) {
    throw new Error(`${label} failed with ${errors.length} carrier error${errors.length === 1 ? '' : 's'}`)
  }
  if (response.Code !== 0 && response.Code !== 200) {
    throw new Error(`${label}.Code must be a supported success code`)
  }
  return {
    response,
    successCode: response.Code as 0 | 200,
    messages: responseMessages(response.Messages, `${label}.Messages`),
  }
}

function normalizedCharge(value: unknown, label: string): RlCarriersNormalizedCharge {
  const input = object(value, label)
  return {
    type: optionalPlainText(input.Type, `${label}.Type`, 80),
    title: optionalPlainText(input.Title, `${label}.Title`, 200),
    weight: optionalPlainText(input.Weight, `${label}.Weight`, 40),
    rate: optionalPlainText(input.Rate, `${label}.Rate`, 80),
    amount: optionalResponseMoney(input.Amount, `${label}.Amount`),
  }
}

function hourlyWindow(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  const input = object(value, label)
  return {
    start: responseText(input.Start, `${label}.Start`, 40),
    end: responseText(input.End, `${label}.End`, 40),
  }
}

function serviceDays(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 365) {
    throw new Error(`${label} must be an integer from 0 to 365`)
  }
  return Number(value)
}

const TENDER_SERVICE_LEVELS: Record<string, {
  serviceLevel: RlCarriersTenderServiceLevel
  names: readonly string[]
}> = {
  STD: {
    serviceLevel: 'Standard',
    names: ['Standard', 'Standard Service'],
  },
  GSDS: {
    serviceLevel: 'Guaranteed',
    names: ['Guaranteed', 'Guaranteed Service'],
  },
  GSAM: {
    serviceLevel: 'GuaranteedByNoon',
    names: [
      'GuaranteedByNoon',
      'Guaranteed By Noon',
      'Guaranteed By Noon Service',
      'Guaranteed AM Service',
    ],
  },
  GSHW: {
    serviceLevel: 'GuaranteedHourlyWindow',
    names: [
      'GuaranteedHourlyWindow',
      'Guaranteed Hourly Window',
      'Guaranteed Hourly Window Service',
      'Guaranteed HW Service',
    ],
  },
  EXPD: {
    serviceLevel: 'Expedited',
    names: ['Expedited', 'Expedited Service'],
  },
}

function tenderServiceLevel(rate: RlCarriersNormalizedRate, label: string) {
  const mapping = TENDER_SERVICE_LEVELS[rate.serviceCode]
  if (!mapping || !mapping.names.includes(rate.serviceName)) {
    throw new Error(
      `${label} does not map to a supported R+L tender service level`,
    )
  }
  if (mapping.serviceLevel === 'GuaranteedHourlyWindow' && rate.hourlyWindow === null) {
    throw new Error(`${label} requires an hourly window`)
  }
  return {
    serviceLevel: mapping.serviceLevel,
    hourlyWindow: mapping.serviceLevel === 'GuaranteedHourlyWindow'
      ? rate.hourlyWindow
      : null,
  }
}

function moneyMinor(value: string) {
  const [major, minor] = value.split('.')
  return BigInt(major) * BigInt(100) + BigInt(minor)
}

function responseEvidence<Operation extends RlCarriersFreightOperation>(input: {
  prepared: RlCarriersPreparedRequestBase<Operation>
  payload: unknown
  successCode: 0 | 200
  messageCount: number
  resultCount: number
  tariffBasis: RlCarriersTariffBasis | null
  quoteNumbers?: string[]
  proNumber?: string | null
  pickupRequestId?: string | null
}): RlCarriersResponseEvidence & { operation: Operation } {
  return deepFreeze({
    requestHash: input.prepared.requestHash,
    providerPayloadHash: hash(input.payload),
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    operation: input.prepared.operation,
    redactedResponse: {
      successCode: input.successCode,
      messageCount: input.messageCount,
      resultCount: input.resultCount,
      tariffBasis: input.tariffBasis,
      quoteNumberFingerprints: (input.quoteNumbers || [])
        .map((value) => fingerprint('quote_number', value))
        .sort(codePointCompare),
      proNumberFingerprint: input.proNumber
        ? fingerprint('pro_number', input.proNumber)
        : null,
      pickupRequestIdFingerprint: input.pickupRequestId
        ? fingerprint('pickup_request_id', input.pickupRequestId)
        : null,
    },
  })
}

function partialMutationOutcomeError(input: {
  prepared:
    | PreparedRlCarriersBillOfLadingRequest
    | PreparedRlCarriersQuotedPickupRequest
  payload: unknown
  successCode: 0 | 200
  messageCount: number
  quoteNumber: string
  proNumber: string | null
  pickupRequestId: string | null
  missingRequiredIdentifiers: (
    | 'pro_number'
    | 'pickup_request_id'
  )[]
}) {
  return new RlCarriersPartialMutationOutcomeError({
    adapterVersion: 'rl-carriers-freight-v1',
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    operation: input.prepared.operation,
    requestHash: input.prepared.requestHash,
    providerPayloadHash: hash(input.payload),
    providerIds: {
      proNumber: input.proNumber,
      pickupRequestId: input.pickupRequestId,
    },
    fingerprints: {
      quoteNumber: fingerprint('quote_number', input.quoteNumber),
      proNumber: input.proNumber
        ? fingerprint('pro_number', input.proNumber)
        : null,
      pickupRequestId: input.pickupRequestId
        ? fingerprint('pickup_request_id', input.pickupRequestId)
        : null,
    },
    successCode: input.successCode,
    messageCount: input.messageCount,
    missingRequiredIdentifiers: [...input.missingRequiredIdentifiers],
  })
}

type RlCarriersRateQuoteIntegrityPayload = Omit<
  ParsedRlCarriersRateQuoteResponse,
  'integrityHash'
>

function rateQuoteIntegrityHash(input: RlCarriersRateQuoteIntegrityPayload) {
  return hash({
    adapterVersion: 'rl-carriers-freight-v1',
    kind: 'parsed_rate_quote_response',
    response: input,
  })
}

function rateQuoteIntegrityPayload(
  input: Record<string, unknown>,
): RlCarriersRateQuoteIntegrityPayload {
  return {
    provider: input.provider as RlCarriersFreightProvider,
    executingCarrier: input.executingCarrier as RlCarriersExecutingCarrier,
    mode: input.mode as 'ltl',
    tariffBasis: input.tariffBasis as RlCarriersTariffBasis,
    requestedPalletTariff: input.requestedPalletTariff as boolean,
    accessorials: input.accessorials as string[],
    customerDiscount: input.customerDiscount as string | null,
    charges: input.charges as RlCarriersNormalizedCharge[],
    rates: input.rates as RlCarriersNormalizedRate[],
    messages: input.messages as string[],
    evidence: input.evidence as RlCarriersResponseEvidence & {
      operation: 'rate_quote'
    },
    credentialVersion: input.credentialVersion as number,
    credentialFingerprint: input.credentialFingerprint as string,
    ratedPlan: input.ratedPlan as RlCarriersRatedPlanEvidence,
  }
}

function assertParsedRateQuoteIntegrity(
  value: unknown,
  label: string,
): ParsedRlCarriersRateQuoteResponse {
  const input = object(value, label, [
    'provider',
    'executingCarrier',
    'mode',
    'tariffBasis',
    'requestedPalletTariff',
    'accessorials',
    'customerDiscount',
    'charges',
    'rates',
    'messages',
    'evidence',
    'credentialVersion',
    'credentialFingerprint',
    'ratedPlan',
    'integrityHash',
  ])
  const executingCarrier = object(input.executingCarrier, `${label}.executingCarrier`)
  const evidence = object(input.evidence, `${label}.evidence`)
  const redactedResponse = object(
    evidence.redactedResponse,
    `${label}.evidence.redactedResponse`,
  )
  const ratedPlan = object(input.ratedPlan, `${label}.ratedPlan`)
  const normalizedRatedPallets = canonicalRatedPallets(
    array(ratedPlan.pallets, `${label}.ratedPlan.pallets`).map(
      (value, index) => {
        const pallet = object(value, `${label}.ratedPlan.pallets[${index}]`, [
          'code',
          'weightLb',
          'quantity',
        ])
        return {
          code: pallet.code as string,
          weightLb: pallet.weightLb as number,
          quantity: pallet.quantity as number,
        }
      },
    ),
  )
  const ratedPalletCount = total(
    normalizedRatedPallets.map((pallet) => pallet.quantity),
    `${label}.ratedPlan pallet count`,
  )
  const ratedPalletWeight = total(
    normalizedRatedPallets.map((pallet) => pallet.weightLb),
    `${label}.ratedPlan pallet weight`,
  )
  const normalizedAccessorials = accessorials(
    input.accessorials,
    `${label}.accessorials`,
    'rate_quote',
  )
  if (
    input.provider !== RL_CARRIERS_FREIGHT_PROVIDER
    || executingCarrier.code !== RL_CARRIERS_EXECUTING_CARRIER.code
    || executingCarrier.name !== RL_CARRIERS_EXECUTING_CARRIER.name
    || input.mode !== 'ltl'
    || (input.tariffBasis !== 'class_ltl' && input.tariffBasis !== 'pallet_tariff')
    || typeof input.requestedPalletTariff !== 'boolean'
    || stable(input.accessorials) !== stable(normalizedAccessorials)
    || !Number.isSafeInteger(input.credentialVersion)
    || Number(input.credentialVersion) < 1
    || !SHA256.test(String(input.credentialFingerprint))
    || !SHA256.test(String(ratedPlan.planHash))
    || !SHA256.test(String(ratedPlan.originFingerprint))
    || !SHA256.test(String(ratedPlan.destinationFingerprint))
    || !Number.isSafeInteger(ratedPlan.itemCount)
    || Number(ratedPlan.itemCount) < 1
    || !Number.isSafeInteger(ratedPlan.totalWeightLb)
    || Number(ratedPlan.totalWeightLb) < 1
    || stable(ratedPlan.pallets) !== stable(normalizedRatedPallets)
    || ratedPlan.palletCount !== ratedPalletCount
    || ratedPlan.palletWeightLb !== ratedPalletWeight
    || (
      normalizedRatedPallets.length > 0
      && (
        ratedPalletCount !== ratedPlan.itemCount
        || ratedPalletWeight !== ratedPlan.totalWeightLb
      )
    )
    || evidence.provider !== RL_CARRIERS_FREIGHT_PROVIDER
    || evidence.operation !== 'rate_quote'
    || !SHA256.test(String(evidence.requestHash))
    || !SHA256.test(String(evidence.providerPayloadHash))
    || redactedResponse.tariffBasis !== input.tariffBasis
    || !SHA256.test(String(input.integrityHash))
  ) {
    throw new Error(`${label} has invalid R+L rate quote integrity evidence`)
  }
  const rates = array(input.rates, `${label}.rates`)
  if (rates.length < 1 || rates.length > 100) {
    throw new Error(`${label}.rates must contain 1-100 normalized rates`)
  }
  const quoteNumbers = new Set<string>()
  for (const [index, value] of rates.entries()) {
    const rate = object(value, `${label}.rates[${index}]`)
    const rateCarrier = object(
      rate.executingCarrier,
      `${label}.rates[${index}].executingCarrier`,
    )
    const quoteNumber = carrierIdentifier(
      rate.quoteNumber,
      `${label}.rates[${index}].quoteNumber`,
    )
    if (
      rate.provider !== RL_CARRIERS_FREIGHT_PROVIDER
      || rateCarrier.code !== RL_CARRIERS_EXECUTING_CARRIER.code
      || rateCarrier.name !== RL_CARRIERS_EXECUTING_CARRIER.name
      || rate.mode !== 'ltl'
      || rate.tariffBasis !== input.tariffBasis
      || rate.currency !== 'USD'
      || stable(rate.accessorials) !== stable(normalizedAccessorials)
      || quoteNumbers.has(quoteNumber)
    ) {
      throw new Error(`${label}.rates[${index}] has drifted from its rate response`)
    }
    quoteNumbers.add(quoteNumber)
  }
  const payload = rateQuoteIntegrityPayload(input)
  if (rateQuoteIntegrityHash(payload) !== input.integrityHash) {
    throw new Error(`${label} failed its R+L rate quote integrity check`)
  }
  return value as ParsedRlCarriersRateQuoteResponse
}

export function parseRlCarriersRateQuoteResponse(
  prepared: PreparedRlCarriersRateQuoteRequest,
  payload: unknown,
): ParsedRlCarriersRateQuoteResponse {
  assertPreparedIntegrity(prepared, 'rate_quote')
  const envelope = responseEnvelope(payload, 'R+L rate quote response')
  const rateQuote = object(envelope.response.RateQuote, 'R+L rate quote response.RateQuote')
  const charges = rateQuote.Charges === undefined || rateQuote.Charges === null
    ? []
    : array(rateQuote.Charges, 'R+L rate quote response.RateQuote.Charges')
      .map((item, index) => normalizedCharge(
        item,
        `R+L rate quote response.RateQuote.Charges[${index}]`,
      ))
  const tariffBasis: RlCarriersTariffBasis = charges.some(
    (charge) => charge.type?.trim().toUpperCase() === 'PALLET',
  ) ? 'pallet_tariff' : 'class_ltl'
  const carrierChargeTypes = [...new Set(charges
    .map((charge) => charge.type)
    .filter((value): value is string => value !== null))]
    .sort(codePointCompare)
  const isDirect = rateQuote.IsDirect === undefined || rateQuote.IsDirect === null
    ? null
    : booleanValue(rateQuote.IsDirect, 'R+L rate quote response.RateQuote.IsDirect')
  const serviceLevels = array(
    rateQuote.ServiceLevels,
    'R+L rate quote response.RateQuote.ServiceLevels',
  )
  if (serviceLevels.length < 1 || serviceLevels.length > 100) {
    throw new Error('R+L rate quote response must contain 1-100 service levels')
  }
  const rates = serviceLevels.map((value, index): RlCarriersNormalizedRate => {
    const label = `R+L rate quote response.RateQuote.ServiceLevels[${index}]`
    const input = object(value, label)
    return {
      provider: RL_CARRIERS_FREIGHT_PROVIDER,
      executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
      mode: 'ltl',
      tariffBasis,
      quoteNumber: carrierIdentifier(input.QuoteNumber, `${label}.QuoteNumber`),
      serviceCode: responseText(input.Code, `${label}.Code`, 40),
      serviceName: responseText(input.Name, `${label}.Name`, 120),
      netCharge: responseMoney(input.NetCharge, `${label}.NetCharge`),
      grossCharge: optionalResponseMoney(input.Charge, `${label}.Charge`),
      currency: 'USD',
      serviceDays: serviceDays(input.ServiceDays, `${label}.ServiceDays`),
      hourlyWindow: hourlyWindow(input.HourlyWindow, `${label}.HourlyWindow`),
      accessorials: prepared.redactedRequest.accessorials,
      carrierChargeTypes,
      isDirect,
    }
  })
  const quoteNumbers = rates.map((rate) => rate.quoteNumber)
  if (new Set(quoteNumbers).size !== quoteNumbers.length) {
    throw new Error('R+L rate quote response contains duplicate quote numbers')
  }
  rates.sort((left, right) => {
    const amountOrder = moneyMinor(left.netCharge) - moneyMinor(right.netCharge)
    if (amountOrder !== BigInt(0)) {
      return amountOrder < BigInt(0) ? -1 : 1
    }
    const serviceOrder = codePointCompare(left.serviceCode, right.serviceCode)
    return serviceOrder || codePointCompare(left.quoteNumber, right.quoteNumber)
  })
  const customerDiscount = optionalResponseMoney(
    rateQuote.CustomerDiscounts,
    'R+L rate quote response.RateQuote.CustomerDiscounts',
  )
  const evidence = responseEvidence({
    prepared,
    payload,
    successCode: envelope.successCode,
    messageCount: envelope.messages.length,
    resultCount: rates.length,
    tariffBasis,
    quoteNumbers,
  })
  const normalized: RlCarriersRateQuoteIntegrityPayload = {
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    mode: 'ltl' as const,
    tariffBasis,
    requestedPalletTariff: prepared.redactedRequest.freight.palletTariffRequested,
    accessorials: prepared.redactedRequest.accessorials,
    customerDiscount,
    charges,
    rates,
    messages: envelope.messages,
    evidence,
    credentialVersion: prepared.redactedRequest.credentialVersion,
    credentialFingerprint: prepared.redactedRequest.credentialFingerprint,
    ratedPlan: prepared.redactedRequest.ratedPlan,
  }
  return deepFreeze({
    ...normalized,
    integrityHash: rateQuoteIntegrityHash(normalized),
  })
}

function quoteNumberFromBillOfLading(
  prepared: PreparedRlCarriersBillOfLadingRequest,
) {
  const billOfLading = object(prepared.body.BillOfLading, 'Prepared R+L BillOfLading')
  const references = object(
    billOfLading.ReferenceNumbers,
    'Prepared R+L BillOfLading.ReferenceNumbers',
  )
  return carrierIdentifier(
    references.RateQuoteNumber,
    'Prepared R+L BillOfLading.ReferenceNumbers.RateQuoteNumber',
  )
}

export function parseRlCarriersBillOfLadingResponse(
  prepared: PreparedRlCarriersBillOfLadingRequest,
  payload: unknown,
): ParsedRlCarriersBillOfLadingResponse {
  assertPreparedIntegrity(prepared, 'bill_of_lading')
  const envelope = responseEnvelope(payload, 'R+L bill of lading response')
  const proNumber = optionalCarrierIdentifier(
    envelope.response.ProNumber,
    'R+L bill of lading response.ProNumber',
  )
  const pickupRequestId = optionalCarrierIdentifier(
    envelope.response.PickupRequestNumber,
    'R+L bill of lading response.PickupRequestNumber',
  )
  const quoteNumber = quoteNumberFromBillOfLading(prepared)
  const embeddedPickupRequested = Object.prototype.hasOwnProperty.call(
    prepared.body,
    'PickupRequest',
  )
  if (
    proNumber === null
    || (embeddedPickupRequested && pickupRequestId === null)
  ) {
    const missingRequiredIdentifiers: (
      | 'pro_number'
      | 'pickup_request_id'
    )[] = []
    if (proNumber === null) missingRequiredIdentifiers.push('pro_number')
    if (embeddedPickupRequested && pickupRequestId === null) {
      missingRequiredIdentifiers.push('pickup_request_id')
    }
    throw partialMutationOutcomeError({
      prepared,
      payload,
      successCode: envelope.successCode,
      messageCount: envelope.messages.length,
      quoteNumber,
      proNumber,
      pickupRequestId,
      missingRequiredIdentifiers,
    })
  }
  const evidence = responseEvidence({
    prepared,
    payload,
    successCode: envelope.successCode,
    messageCount: envelope.messages.length,
    resultCount: 1,
    tariffBasis: null,
    quoteNumbers: [quoteNumber],
    proNumber,
    pickupRequestId,
  })
  return deepFreeze({
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    quoteNumber,
    proNumber,
    pickupRequestId,
    messages: envelope.messages,
    evidence,
  })
}

function quoteNumberFromPickup(prepared: PreparedRlCarriersQuotedPickupRequest) {
  const pickup = object(prepared.body.Pickup, 'Prepared R+L Pickup')
  return carrierIdentifier(
    pickup.QuoteNumber,
    'Prepared R+L Pickup.QuoteNumber',
  )
}

export function parseRlCarriersQuotedPickupResponse(
  prepared: PreparedRlCarriersQuotedPickupRequest,
  payload: unknown,
): ParsedRlCarriersQuotedPickupResponse {
  assertPreparedIntegrity(prepared, 'pickup_request')
  const envelope = responseEnvelope(payload, 'R+L pickup response')
  const pickupRequestId = optionalCarrierIdentifier(
    envelope.response.PickupRequestId,
    'R+L pickup response.PickupRequestId',
  )
  const quoteNumber = quoteNumberFromPickup(prepared)
  if (pickupRequestId === null) {
    throw partialMutationOutcomeError({
      prepared,
      payload,
      successCode: envelope.successCode,
      messageCount: envelope.messages.length,
      quoteNumber,
      proNumber: null,
      pickupRequestId,
      missingRequiredIdentifiers: ['pickup_request_id'],
    })
  }
  const evidence = responseEvidence({
    prepared,
    payload,
    successCode: envelope.successCode,
    messageCount: envelope.messages.length,
    resultCount: 1,
    tariffBasis: null,
    quoteNumbers: [quoteNumber],
    pickupRequestId,
  })
  return deepFreeze({
    provider: RL_CARRIERS_FREIGHT_PROVIDER,
    executingCarrier: RL_CARRIERS_EXECUTING_CARRIER,
    quoteNumber,
    pickupRequestId,
    messages: envelope.messages,
    evidence,
  })
}
