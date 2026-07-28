import { createHash, randomUUID } from 'node:crypto'
import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'

export type CarrierSandboxParty = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: 'US'
}

export type CarrierSandboxParcel = {
  description: string
  length: number
  width: number
  height: number
  dimensionUnit: 'IN'
  weight: number
  weightUnit: 'LB'
}

export type CarrierSandboxParcelRequest = {
  description: string
  exteriorInches: {
    length: number
    width: number
    height: number
  }
  grossPounds: number
}

export type CarrierSandboxRatePurpose =
  | 'sandbox_rate_test'
  | 'cartonization_package_rate'

export type CarrierSandboxRateFixture = {
  origin: CarrierSandboxParty
  destination: CarrierSandboxParty
  parcel: CarrierSandboxParcel
}

type LegacyCarrierSandboxRateFixture = {
  origin: {
    name: string
    street: string
    city: string
    state: string
    postalCode: string
    countryCode: string
  }
  destination: {
    name: string
    street: string
    city: string
    state: string
    postalCode: string
    countryCode: string
  }
  parcel: CarrierSandboxParcel
}

// The fixed legacy fixture remains the separate bounded sandbox-label fixture.
// Sandbox rating converts it to the canonical party shape before use.
export const CARRIER_SANDBOX_RATE_FIXTURE: LegacyCarrierSandboxRateFixture = {
  origin: {
    name: 'John Doe',
    street: '101 Jegs Place',
    city: 'Delaware',
    state: 'OH',
    postalCode: '43015',
    countryCode: 'US',
  },
  destination: {
    name: 'John Doe',
    street: '101 Academy Drive',
    city: 'Buzzards Bay',
    state: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
  parcel: {
    description: 'Test Product',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  },
}

export type CarrierSandboxRate = {
  serviceCode: string
  serviceName: string
  amount: string
  currency: string
  rateType: string | null
  transitDays: number | null
  deliveryDate: string | null
}

export type CarrierSandboxRateResult = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  purpose: CarrierSandboxRatePurpose
  fixture: CarrierSandboxRateFixture
  destinationFingerprint: string
  rates: CarrierSandboxRate[]
  testedAt: string
  evidenceGlobalId?: string
}

export type CarrierSandboxRateEvidence = {
  requestHash: string
  redactedRequest: Record<string, unknown>
  redactedResponse: Record<string, unknown>
  providerReference: string | null
  requestedAt: string
  completedAt: string
}

const RATE_ENDPOINTS = {
  ups_rest: 'https://wwwcie.ups.com/api/rating/v2409/Shop',
  fedex_rest: 'https://apis-sandbox.fedex.com/rate/v1/rates/quotes',
} as const

const UPS_SERVICE_NAMES: Record<string, string> = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '59': 'UPS 2nd Day Air A.M.',
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
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

function normalizeDate(value: unknown) {
  const raw = text(value)
  if (!raw) return null
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown) {
  return createHash('sha256').update(stable(value)).digest('hex')
}

const PARTY_FIELDS = new Set([
  'name',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'countryCode',
])

const PARCEL_FIELDS = new Set([
  'description',
  'exteriorInches',
  'grossPounds',
])

const EXTERIOR_INCH_FIELDS = new Set([
  'length',
  'width',
  'height',
])

function partyText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Carrier sandbox ${label} must be plain text`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximum) {
    throw new Error(`Carrier sandbox ${label} must be 1-${maximum} characters`)
  }
  return normalized
}

function exactObject(
  value: unknown,
  expected: ReadonlySet<string>,
  label: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Carrier sandbox ${label} must be an object`)
  }
  const input = value as Record<string, unknown>
  const unsupported = Object.keys(input).find((field) => !expected.has(field))
  if (unsupported) {
    throw new Error(`Carrier sandbox ${label} field is not supported: ${unsupported}`)
  }
  const missing = [...expected].find((field) => !(field in input))
  if (missing) {
    throw new Error(`Carrier sandbox ${label} field is required: ${missing}`)
  }
  return input
}

function boundedParcelDecimal(
  value: unknown,
  label: string,
  maximum: number,
) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || value > maximum
  ) {
    throw new Error(
      `Carrier sandbox ${label} must be a positive number no greater than ${maximum}`,
    )
  }
  const canonical = Math.round(value * 1_000) / 1_000
  if (Math.abs(value - canonical) > Number.EPSILON * Math.max(1, value) * 8) {
    throw new Error(`Carrier sandbox ${label} supports at most three decimal places`)
  }
  return canonical
}

export function normalizeCarrierSandboxParcel(
  value: unknown,
): CarrierSandboxParcel {
  const input = exactObject(value, PARCEL_FIELDS, 'parcel')
  const exterior = exactObject(
    input.exteriorInches,
    EXTERIOR_INCH_FIELDS,
    'parcel exterior inches',
  )
  return {
    description: partyText(input.description, 'parcel description', 120),
    length: boundedParcelDecimal(
      exterior.length,
      'parcel exterior length in inches',
      108,
    ),
    width: boundedParcelDecimal(
      exterior.width,
      'parcel exterior width in inches',
      108,
    ),
    height: boundedParcelDecimal(
      exterior.height,
      'parcel exterior height in inches',
      108,
    ),
    dimensionUnit: 'IN',
    weight: boundedParcelDecimal(
      input.grossPounds,
      'parcel gross weight in pounds',
      150,
    ),
    weightUnit: 'LB',
  }
}

export function normalizeCarrierSandboxParty(value: unknown): CarrierSandboxParty {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Carrier sandbox destination must be an object')
  }
  const input = value as Record<string, unknown>
  const unsupported = Object.keys(input).find((field) => !PARTY_FIELDS.has(field))
  if (unsupported) {
    throw new Error(`Carrier sandbox destination field is not supported: ${unsupported}`)
  }
  const line2Value = input.line2
  if (
    line2Value !== undefined
    && line2Value !== null
    && (typeof line2Value !== 'string' || /[\u0000-\u001f\u007f]/.test(line2Value))
  ) {
    throw new Error('Carrier sandbox destination line 2 must be plain text')
  }
  const line2 = typeof line2Value === 'string'
    ? line2Value.trim().replace(/\s+/g, ' ')
    : ''
  if (line2.length > 120) {
    throw new Error('Carrier sandbox destination line 2 must be 120 characters or fewer')
  }
  const region = partyText(input.region, 'destination region', 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(region)) {
    throw new Error('Carrier sandbox destination region must use a two-letter US state code')
  }
  const postalCode = partyText(input.postalCode, 'destination postal code', 10)
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new Error('Carrier sandbox destination postal code must be a five or nine digit US ZIP code')
  }
  const countryCode = partyText(input.countryCode, 'destination country code', 2).toUpperCase()
  if (countryCode !== 'US') {
    throw new Error('Carrier sandbox rating currently supports US addresses only')
  }
  return {
    name: partyText(input.name, 'destination name', 120),
    line1: partyText(input.line1, 'destination address line 1', 160),
    line2: line2 || null,
    city: partyText(input.city, 'destination city', 100),
    region,
    postalCode,
    countryCode,
  }
}

export function carrierSandboxPartyFingerprint(normalizedParty: CarrierSandboxParty) {
  const party = normalizeCarrierSandboxParty(normalizedParty)
  return hash({
    version: 'carrier-sandbox-party-v1',
    party,
  })
}

function legacyParty(
  party: LegacyCarrierSandboxRateFixture['origin'],
): CarrierSandboxParty {
  return normalizeCarrierSandboxParty({
    name: party.name,
    line1: party.street,
    line2: null,
    city: party.city,
    region: party.state,
    postalCode: party.postalCode,
    countryCode: party.countryCode,
  })
}

export function buildCarrierSandboxRateFixture(input: {
  senderName: string
  registeredAddress: {
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    countryCode: string
  }
  destination?: unknown
  parcel?: unknown
}): CarrierSandboxRateFixture {
  return {
    origin: normalizeCarrierSandboxParty({
      name: input.senderName,
      line1: input.registeredAddress.line1,
      line2: input.registeredAddress.line2,
      city: input.registeredAddress.city,
      region: input.registeredAddress.region,
      postalCode: input.registeredAddress.postalCode,
      countryCode: input.registeredAddress.countryCode,
    }),
    destination: input.destination === undefined
      ? legacyParty(CARRIER_SANDBOX_RATE_FIXTURE.destination)
      : normalizeCarrierSandboxParty(input.destination),
    parcel: input.parcel === undefined
      ? { ...CARRIER_SANDBOX_RATE_FIXTURE.parcel }
      : normalizeCarrierSandboxParcel(input.parcel),
  }
}

function defaultCarrierSandboxRateFixture(): CarrierSandboxRateFixture {
  return {
    origin: legacyParty(CARRIER_SANDBOX_RATE_FIXTURE.origin),
    destination: legacyParty(CARRIER_SANDBOX_RATE_FIXTURE.destination),
    parcel: { ...CARRIER_SANDBOX_RATE_FIXTURE.parcel },
  }
}

function providerError(status: number) {
  if ([400, 401, 403, 404, 422].includes(status)) {
    return new CarrierCredentialClientError(
      'The carrier rejected the sandbox rate request',
      409,
      'CARRIER_SANDBOX_RATE_REJECTED',
    )
  }
  if (status === 429) {
    return new CarrierCredentialClientError(
      'The carrier temporarily rate limited sandbox rating',
      503,
      'CARRIER_PROVIDER_RATE_LIMITED',
    )
  }
  return new CarrierCredentialClientError(
    'The carrier sandbox rating service is temporarily unavailable',
    503,
    'CARRIER_PROVIDER_UNAVAILABLE',
  )
}

function fedexRequest(accountNumber: string, fixture: CarrierSandboxRateFixture) {
  return {
    accountNumber: { value: accountNumber },
    rateRequestControlParameters: { returnTransitTimes: true },
    requestedShipment: {
      shipper: {
        contact: {
          personName: fixture.origin.name,
          companyName: fixture.origin.name,
          phoneNumber: '7405550100',
        },
        address: {
          streetLines: [fixture.origin.line1, ...(fixture.origin.line2 ? [fixture.origin.line2] : [])],
          city: fixture.origin.city,
          stateOrProvinceCode: fixture.origin.region, postalCode: fixture.origin.postalCode,
          countryCode: fixture.origin.countryCode,
        },
      },
      recipient: { address: {
        streetLines: [
          fixture.destination.line1,
          ...(fixture.destination.line2 ? [fixture.destination.line2] : []),
        ],
        city: fixture.destination.city,
        stateOrProvinceCode: fixture.destination.region, postalCode: fixture.destination.postalCode,
        countryCode: fixture.destination.countryCode,
      } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT', 'LIST'],
      packagingType: 'YOUR_PACKAGING',
      requestedPackageLineItems: [{
        itemDescription: fixture.parcel.description,
        weight: { units: fixture.parcel.weightUnit, value: fixture.parcel.weight },
        dimensions: {
          length: fixture.parcel.length, width: fixture.parcel.width, height: fixture.parcel.height,
          units: fixture.parcel.dimensionUnit,
        },
      }],
    },
  }
}

function upsParty(address: CarrierSandboxParty) {
  return {
    Name: address.name,
    Address: {
      AddressLine: [address.line1, ...(address.line2 ? [address.line2] : [])],
      City: address.city,
      StateProvinceCode: address.region,
      PostalCode: address.postalCode,
      CountryCode: address.countryCode,
    },
  }
}

function upsRequest(accountNumber: string, fixture: CarrierSandboxRateFixture) {
  return {
    RateRequest: {
      Request: {
        RequestOption: 'Shop',
        TransactionReference: { CustomerContext: 'ClawPilot sandbox rating' },
      },
      Shipment: {
        Shipper: { ...upsParty(fixture.origin), ShipperNumber: accountNumber },
        ShipFrom: upsParty(fixture.origin),
        ShipTo: upsParty(fixture.destination),
        PaymentDetails: {
          ShipmentCharge: [{ Type: '01', BillShipper: { AccountNumber: accountNumber } }],
        },
        NumOfPieces: '1',
        Package: [{
          PackagingType: { Code: '02', Description: 'Customer supplied package' },
          Description: fixture.parcel.description,
          Dimensions: {
            UnitOfMeasurement: { Code: fixture.parcel.dimensionUnit },
            Length: String(fixture.parcel.length), Width: String(fixture.parcel.width), Height: String(fixture.parcel.height),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(fixture.parcel.weight),
          },
        }],
        ShipmentRatingOptions: { NegotiatedRatesIndicator: '' },
      },
    },
  }
}

function parseFedex(payload: Record<string, unknown>): CarrierSandboxRate[] {
  const output = record(payload.output)
  return list(output.rateReplyDetails).flatMap((rawDetail) => {
    const detail = record(rawDetail)
    const rated = list(detail.ratedShipmentDetails).map(record)
    const preferred = rated.find((item) => text(item.rateType).includes('ACCOUNT')) || rated[0]
    if (!preferred) return []
    const amount = text(preferred.totalNetCharge || preferred.totalNetFedExCharge)
    const currency = text(preferred.currency || record(preferred.totalNetCharge).currency)
    const amountValue = amount || text(record(preferred.totalNetCharge).amount)
    if (!amountValue || !currency) return []
    const operational = record(detail.operationalDetail)
    const commit = record(detail.commit)
    const dateDetail = record(commit.dateDetail)
    return [{
      serviceCode: text(detail.serviceType) || 'UNKNOWN',
      serviceName: text(detail.serviceName) || text(detail.serviceType) || 'FedEx service',
      amount: amountValue,
      currency,
      rateType: text(preferred.rateType) || null,
      transitDays: transitDays(operational.transitTime || commit.transitDays),
      deliveryDate: normalizeDate(dateDetail.dayFormat || operational.deliveryDate),
    }]
  })
}

function parseUps(payload: Record<string, unknown>): CarrierSandboxRate[] {
  const response = record(payload.RateResponse)
  return list(response.RatedShipment).flatMap((rawShipment) => {
    const shipment = record(rawShipment)
    const service = record(shipment.Service)
    const negotiated = record(record(shipment.NegotiatedRateCharges).TotalCharge)
    const charges = text(negotiated.MonetaryValue) ? negotiated : record(shipment.TotalCharges)
    const serviceCode = text(service.Code) || 'UNKNOWN'
    const amount = text(charges.MonetaryValue)
    const currency = text(charges.CurrencyCode)
    if (!amount || !currency) return []
    const time = record(shipment.TimeInTransit)
    const summary = record(time.ServiceSummary)
    const estimatedArrival = record(summary.EstimatedArrival)
    const arrival = record(estimatedArrival.Arrival)
    return [{
      serviceCode,
      serviceName: text(service.Description) || UPS_SERVICE_NAMES[serviceCode] || `UPS service ${serviceCode}`,
      amount,
      currency,
      rateType: charges === negotiated ? 'NEGOTIATED' : 'PUBLISHED',
      transitDays: transitDays(estimatedArrival.BusinessDaysInTransit || summary.BusinessDaysInTransit),
      deliveryDate: normalizeDate(arrival.Date || estimatedArrival.Date),
    }]
  })
}

export function carrierSandboxRateRequestEvidence(
  provider: 'ups_rest' | 'fedex_rest',
  fixture: CarrierSandboxRateFixture = defaultCarrierSandboxRateFixture(),
  purpose: CarrierSandboxRatePurpose = 'sandbox_rate_test',
) {
  const request = {
    provider,
    environment: 'sandbox',
    purpose,
    origin: fixture.origin,
    destination: fixture.destination,
    parcel: fixture.parcel,
  }
  return {
    requestHash: hash(request),
    redactedRequest: {
      provider,
      environment: 'sandbox',
      purpose,
      shipment: {
        originFingerprint: carrierSandboxPartyFingerprint(fixture.origin),
        destinationFingerprint: carrierSandboxPartyFingerprint(fixture.destination),
        origin: {
          region: fixture.origin.region,
          countryCode: fixture.origin.countryCode,
        },
        destination: {
          region: fixture.destination.region,
          countryCode: fixture.destination.countryCode,
        },
        parcel: fixture.parcel,
      },
    },
  }
}

export async function requestCarrierSandboxRates(
  input: CarrierRuntimeCredential,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    fixture?: CarrierSandboxRateFixture
    purpose?: CarrierSandboxRatePurpose
  } = {},
): Promise<{ result: CarrierSandboxRateResult; evidence: CarrierSandboxRateEvidence }> {
  if (input.environment !== 'sandbox') {
    throw new CarrierCredentialClientError(
      'Rate testing is limited to carrier sandbox accounts',
      409,
      'CARRIER_SANDBOX_REQUIRED',
    )
  }
  if (input.provider !== 'ups_rest' && input.provider !== 'fedex_rest') {
    throw new CarrierCredentialClientError(
      'Sandbox rating is not available for this carrier yet',
      409,
      'CARRIER_SANDBOX_RATE_UNSUPPORTED',
    )
  }
  if (!input.credential.accountNumber) {
    throw new CarrierCredentialClientError(
      'A carrier account number is required for sandbox rating',
      409,
      'CARRIER_ACCOUNT_REQUIRED',
    )
  }

  const fetchImpl = options.fetchImpl || fetch
  const fixture = options.fixture || defaultCarrierSandboxRateFixture()
  const purpose = options.purpose || 'sandbox_rate_test'
  const requestedAt = new Date().toISOString()
  const token = await requestCarrierAccessToken(input, { fetchImpl, timeoutMs: options.timeoutMs })
  const body = input.provider === 'fedex_rest'
    ? fedexRequest(input.credential.accountNumber, fixture)
    : upsRequest(input.credential.accountNumber, fixture)
  const transactionId = randomUUID()
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 12_000, 15_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(RATE_ENDPOINTS[input.provider], {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        ...(input.provider === 'ups_rest'
          ? { transId: transactionId, transactionSrc: 'clawpilot' }
          : { 'X-locale': 'en_US' }),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw providerError(response.status)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(contentLength) && contentLength > 128 * 1024) {
      throw new CarrierCredentialClientError('The carrier returned an invalid rate response', 502, 'CARRIER_PROVIDER_RESPONSE_INVALID')
    }
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) {
      throw new CarrierCredentialClientError('The carrier returned an invalid rate response', 502, 'CARRIER_PROVIDER_RESPONSE_INVALID')
    }
    let payload: Record<string, unknown>
    try {
      payload = record(JSON.parse(raw))
    } catch {
      throw new CarrierCredentialClientError('The carrier returned an invalid rate response', 502, 'CARRIER_PROVIDER_RESPONSE_INVALID')
    }
    const rates = input.provider === 'fedex_rest' ? parseFedex(payload) : parseUps(payload)
    if (!rates.length) {
      throw new CarrierCredentialClientError('The carrier returned no usable sandbox rates', 502, 'CARRIER_SANDBOX_RATE_EMPTY')
    }
    const completedAt = new Date().toISOString()
    const safeRequest = carrierSandboxRateRequestEvidence(
      input.provider,
      fixture,
      purpose,
    )
    const safeResponse = { rateCount: rates.length, rates }
    return {
      result: {
        provider: input.provider,
        environment: 'sandbox',
        purpose,
        fixture,
        destinationFingerprint: carrierSandboxPartyFingerprint(fixture.destination),
        rates,
        testedAt: completedAt,
      },
      evidence: {
        requestHash: safeRequest.requestHash,
        redactedRequest: safeRequest.redactedRequest,
        redactedResponse: safeResponse,
        providerReference: response.headers.get('transaction-id') || response.headers.get('x-customer-transaction-id'),
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    if (error instanceof CarrierCredentialClientError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CarrierCredentialClientError('Carrier sandbox rating timed out', 504, 'CARRIER_PROVIDER_TIMEOUT')
    }
    throw new CarrierCredentialClientError(
      'The carrier sandbox rating service is temporarily unavailable',
      503,
      'CARRIER_PROVIDER_UNAVAILABLE',
    )
  } finally {
    clearTimeout(timeout)
  }
}
