import { createHash, randomUUID } from 'node:crypto'
import {
  CarrierCredentialClientError,
  requestCarrierAccessToken,
  type CarrierRuntimeCredential,
} from '@/lib/integrations/carrierCredentialClient'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES,
  UPS_WHOLE_SHIPMENT_PACKAGING_TYPES,
} from '@/lib/integrations/carrierWholeShipmentRateFoundation'

export type CarrierSandboxParty = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: 'US'
}

/**
 * Carrier rate requests may be submitted before Shopify releases a complete
 * delivery address. This shape is intentionally limited to quote-only paths;
 * shipping and label creation continue to require CarrierSandboxParty.
 */
export type CarrierSandboxRateDestination = {
  name: string | null
  line1: string | null
  line2: string | null
  city: string | null
  region: string | null
  postalCode: string
  countryCode: 'US'
}

export type CarrierSandboxParcel = {
  description: string
  /** Exact selected package code when the caller has carrier/package
   * authority. Legacy provider-neutral callers may omit it and the request
   * builder applies the carrier's customer-supplied default. */
  packageCode?: string | null
  length: number
  width: number
  height: number
  dimensionUnit: 'IN'
  weight: number
  weightUnit: 'LB'
}

export type CarrierSandboxParcelRequest = {
  description: string
  packageCode?: string | null
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
  | 'cartonization_shipment_rate'

export type CarrierSandboxRateFixture = {
  origin: CarrierSandboxParty
  destination: CarrierSandboxParty
  parcel: CarrierSandboxParcel
}

export const MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES = 50

export type CarrierSandboxShipmentRateFixture = {
  origin: CarrierSandboxParty
  destination: CarrierSandboxRateDestination
  parcels: CarrierSandboxParcel[]
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

const EXACT_RATE_AMOUNT = /^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/

function exactRateAmountMinor(value: string) {
  if (!EXACT_RATE_AMOUNT.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`)
}

function compareDuplicateServiceRates(
  left: CarrierSandboxRate,
  right: CarrierSandboxRate,
) {
  const leftMinor = exactRateAmountMinor(left.amount)
  const rightMinor = exactRateAmountMinor(right.amount)
  if (leftMinor === null && rightMinor !== null) return 1
  if (leftMinor !== null && rightMinor === null) return -1
  if (leftMinor !== null && rightMinor !== null && leftMinor !== rightMinor) {
    return leftMinor < rightMinor ? -1 : 1
  }
  return (
    (left.deliveryDate || '9999-12-31')
      .localeCompare(right.deliveryDate || '9999-12-31')
    || (left.transitDays ?? 366) - (right.transitDays ?? 366)
    || left.serviceName.localeCompare(right.serviceName)
    || (left.rateType || '').localeCompare(right.rateType || '')
  )
}

/**
 * FedEx can return more than one rateReplyDetails row for the same service
 * code. Shopify requires a unique service code, so collapse exact-currency
 * duplicates to the lowest usable account rate before the strict checkout
 * response boundary. A cross-currency duplicate remains visible and will fail
 * closed in the checkout normalizer.
 */
function collapseFedexDuplicateServices(
  rates: CarrierSandboxRate[],
) {
  const selected = new Map<string, CarrierSandboxRate>()
  const passthrough: CarrierSandboxRate[] = []
  for (const rate of rates) {
    const current = selected.get(rate.serviceCode)
    if (!current) {
      selected.set(rate.serviceCode, rate)
      continue
    }
    if (current.currency !== rate.currency) {
      passthrough.push(rate)
      continue
    }
    if (compareDuplicateServiceRates(rate, current) < 0) {
      selected.set(rate.serviceCode, rate)
    }
  }
  return [...selected.values(), ...passthrough]
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

export type CarrierSandboxShipmentRateResult = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  purpose: 'cartonization_shipment_rate'
  rateScope: 'multi_package_shipment'
  fixture: CarrierSandboxShipmentRateFixture
  packageCount: number
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
const PARCEL_WITH_CODE_FIELDS = new Set([...PARCEL_FIELDS, 'packageCode'])

const EXTERIOR_INCH_FIELDS = new Set([
  'length',
  'width',
  'height',
])

const US_REGION_CODES = new Map<string, string>([
  ['alabama', 'AL'],
  ['alaska', 'AK'],
  ['american samoa', 'AS'],
  ['arizona', 'AZ'],
  ['arkansas', 'AR'],
  ['armed forces americas', 'AA'],
  ['armed forces europe', 'AE'],
  ['armed forces pacific', 'AP'],
  ['california', 'CA'],
  ['colorado', 'CO'],
  ['connecticut', 'CT'],
  ['delaware', 'DE'],
  ['district of columbia', 'DC'],
  ['florida', 'FL'],
  ['georgia', 'GA'],
  ['guam', 'GU'],
  ['hawaii', 'HI'],
  ['idaho', 'ID'],
  ['illinois', 'IL'],
  ['indiana', 'IN'],
  ['iowa', 'IA'],
  ['kansas', 'KS'],
  ['kentucky', 'KY'],
  ['louisiana', 'LA'],
  ['maine', 'ME'],
  ['maryland', 'MD'],
  ['massachusetts', 'MA'],
  ['michigan', 'MI'],
  ['minnesota', 'MN'],
  ['mississippi', 'MS'],
  ['missouri', 'MO'],
  ['montana', 'MT'],
  ['nebraska', 'NE'],
  ['nevada', 'NV'],
  ['new hampshire', 'NH'],
  ['new jersey', 'NJ'],
  ['new mexico', 'NM'],
  ['new york', 'NY'],
  ['north carolina', 'NC'],
  ['north dakota', 'ND'],
  ['northern mariana islands', 'MP'],
  ['ohio', 'OH'],
  ['oklahoma', 'OK'],
  ['oregon', 'OR'],
  ['pennsylvania', 'PA'],
  ['puerto rico', 'PR'],
  ['rhode island', 'RI'],
  ['south carolina', 'SC'],
  ['south dakota', 'SD'],
  ['tennessee', 'TN'],
  ['texas', 'TX'],
  ['united states virgin islands', 'VI'],
  ['utah', 'UT'],
  ['vermont', 'VT'],
  ['virgin islands', 'VI'],
  ['virginia', 'VA'],
  ['washington', 'WA'],
  ['washington dc', 'DC'],
  ['west virginia', 'WV'],
  ['wisconsin', 'WI'],
  ['wyoming', 'WY'],
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

function optionalPartyText(
  value: unknown,
  label: string,
  maximum: number,
) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Carrier sandbox ${label} must be plain text`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  if (normalized.length > maximum) {
    throw new Error(
      `Carrier sandbox ${label} must be ${maximum} characters or fewer`,
    )
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

function normalizeUsRegion(value: unknown) {
  const region = partyText(value, 'destination region', 64)
  if (/^[a-z]{2}$/i.test(region)) return region.toUpperCase()
  const normalizedName = region
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
  const code = US_REGION_CODES.get(normalizedName)
  if (!code) {
    throw new Error(
      'Carrier sandbox destination region must use a recognized US state '
      + 'or territory name or its two-letter code',
    )
  }
  return code
}

export function normalizeCarrierSandboxParcel(
  value: unknown,
): CarrierSandboxParcel {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const input = exactObject(
    value,
    Object.hasOwn(source, 'packageCode') ? PARCEL_WITH_CODE_FIELDS : PARCEL_FIELDS,
    'parcel',
  )
  const exterior = exactObject(
    input.exteriorInches,
    EXTERIOR_INCH_FIELDS,
    'parcel exterior inches',
  )
  const packageCode = input.packageCode === undefined
    || input.packageCode === null
    ? null
    : partyText(input.packageCode, 'parcel package code', 32)
  return {
    description: partyText(input.description, 'parcel description', 120),
    ...(packageCode === null ? {} : { packageCode }),
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
  const postalCode = partyText(input.postalCode, 'destination postal code', 10)
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new Error('Carrier sandbox destination postal code must be a five or nine digit US ZIP code')
  }
  const countryCode = partyText(input.countryCode, 'destination country code', 2).toUpperCase()
  if (countryCode !== 'US') {
    throw new Error('Carrier sandbox rating currently supports US addresses only')
  }
  const region = normalizeUsRegion(input.region)
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

export function normalizeCarrierSandboxRateDestination(
  value: unknown,
): CarrierSandboxRateDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Carrier sandbox rate destination must be an object')
  }
  const input = value as Record<string, unknown>
  const unsupported = Object.keys(input).find(
    (field) => !PARTY_FIELDS.has(field),
  )
  if (unsupported) {
    throw new Error(
      `Carrier sandbox rate destination field is not supported: ${unsupported}`,
    )
  }
  const postalCode = partyText(
    input.postalCode,
    'rate destination postal code',
    10,
  )
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new Error(
      'Carrier sandbox rate destination postal code must be a five or '
      + 'nine digit US ZIP code',
    )
  }
  const countryCode = partyText(
    input.countryCode,
    'rate destination country code',
    2,
  ).toUpperCase()
  if (countryCode !== 'US') {
    throw new Error('Carrier sandbox rating currently supports US addresses only')
  }
  const name = optionalPartyText(input.name, 'rate destination name', 120)
  const line1 = optionalPartyText(
    input.line1,
    'rate destination address line 1',
    160,
  )
  const line2 = optionalPartyText(
    input.line2,
    'rate destination address line 2',
    120,
  )
  if (line2 && !line1) {
    throw new Error(
      'Carrier sandbox rate destination line 2 requires address line 1',
    )
  }
  const region = optionalPartyText(
    input.region,
    'rate destination region',
    64,
  )
  return {
    name,
    line1,
    line2,
    city: optionalPartyText(input.city, 'rate destination city', 100),
    region: region ? normalizeUsRegion(region) : null,
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

export function carrierSandboxRateDestinationFingerprint(
  normalizedDestination: CarrierSandboxRateDestination,
) {
  const destination = normalizeCarrierSandboxRateDestination(
    normalizedDestination,
  )
  if (
    destination.name
    && destination.line1
    && destination.city
    && destination.region
  ) {
    return carrierSandboxPartyFingerprint({
      ...destination,
      name: destination.name,
      line1: destination.line1,
      city: destination.city,
      region: destination.region,
    })
  }
  return hash({
    version: 'carrier-sandbox-rate-destination-v1',
    destination,
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

export function buildCarrierSandboxShipmentRateFixture(input: {
  senderName: string
  registeredAddress: {
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    countryCode: string
  }
  destination: unknown
  parcels: unknown
}): CarrierSandboxShipmentRateFixture {
  if (
    !Array.isArray(input.parcels)
    || input.parcels.length < 1
    || input.parcels.length > MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
  ) {
    throw new Error(
      `Carrier sandbox shipment rating requires 1-${
        MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
      } ordered packages`,
    )
  }
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
    destination: normalizeCarrierSandboxRateDestination(input.destination),
    parcels: input.parcels.map(normalizeCarrierSandboxParcel),
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

function carrierPackageCode(
  provider: 'ups_rest' | 'fedex_rest',
  value: string | null | undefined,
) {
  const code = value || (provider === 'ups_rest' ? '02' : 'YOUR_PACKAGING')
  const name = provider === 'ups_rest'
    ? (UPS_WHOLE_SHIPMENT_PACKAGING_TYPES as Record<string, string>)[code]
    : (FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES as Record<string, string>)[code]
  if (!name) throw new Error('Carrier package type is not supported')
  return { code, name }
}

function fedexRequest(
  accountNumber: string,
  fixture: CarrierSandboxShipmentRateFixture,
) {
  const packageCodes = fixture.parcels.map((parcel) => (
    carrierPackageCode('fedex_rest', parcel.packageCode).code
  ))
  if (new Set(packageCodes).size !== 1) {
    throw new Error('FedEx whole-shipment rating requires one package type for every parcel')
  }
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
        ...(fixture.destination.line1
          ? {
              streetLines: [
                fixture.destination.line1,
                ...(fixture.destination.line2
                  ? [fixture.destination.line2]
                  : []),
              ],
            }
          : {}),
        ...(fixture.destination.city
          ? { city: fixture.destination.city }
          : {}),
        ...(fixture.destination.region
          ? { stateOrProvinceCode: fixture.destination.region }
          : {}),
        postalCode: fixture.destination.postalCode,
        countryCode: fixture.destination.countryCode,
      } },
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['ACCOUNT', 'LIST'],
      packagingType: packageCodes[0],
      totalPackageCount: fixture.parcels.length,
      requestedPackageLineItems: fixture.parcels.map((parcel, index) => ({
        sequenceNumber: index + 1,
        groupPackageCount: 1,
        itemDescription: parcel.description,
        weight: { units: parcel.weightUnit, value: parcel.weight },
        dimensions: {
          length: parcel.length, width: parcel.width, height: parcel.height,
          units: parcel.dimensionUnit,
        },
      })),
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

function upsRateDestination(address: CarrierSandboxRateDestination) {
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
    },
  }
}

function upsRequest(
  accountNumber: string,
  fixture: CarrierSandboxShipmentRateFixture,
) {
  return {
    RateRequest: {
      Request: {
        RequestOption: 'Shop',
        TransactionReference: { CustomerContext: 'ClawPilot sandbox rating' },
      },
      Shipment: {
        Shipper: { ...upsParty(fixture.origin), ShipperNumber: accountNumber },
        ShipFrom: upsParty(fixture.origin),
        ShipTo: upsRateDestination(fixture.destination),
        PaymentDetails: {
          ShipmentCharge: [{ Type: '01', BillShipper: { AccountNumber: accountNumber } }],
        },
        NumOfPieces: String(fixture.parcels.length),
        Package: fixture.parcels.map((parcel) => {
          const packaging = carrierPackageCode('ups_rest', parcel.packageCode)
          return ({
          PackagingType: { Code: packaging.code, Description: packaging.name },
          Description: parcel.description,
          Dimensions: {
            UnitOfMeasurement: { Code: parcel.dimensionUnit },
            Length: String(parcel.length), Width: String(parcel.width), Height: String(parcel.height),
          },
          PackageWeight: {
            UnitOfMeasurement: { Code: 'LBS' },
            Weight: String(parcel.weight),
          },
        })}),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: '' },
      },
    },
  }
}

function parseFedex(payload: Record<string, unknown>): CarrierSandboxRate[] {
  const output = record(payload.output)
  const rates = list(output.rateReplyDetails).flatMap((rawDetail) => {
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
  return collapseFedexDuplicateServices(rates)
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

export function carrierSandboxShipmentRateRequestEvidence(
  provider: 'ups_rest' | 'fedex_rest',
  fixture: CarrierSandboxShipmentRateFixture,
) {
  const purpose = 'cartonization_shipment_rate' as const
  const request = {
    provider,
    environment: 'sandbox',
    purpose,
    origin: fixture.origin,
    destination: fixture.destination,
    parcels: fixture.parcels,
  }
  return {
    requestHash: hash(request),
    redactedRequest: {
      provider,
      environment: 'sandbox',
      purpose,
      shipment: {
        rateScope: 'multi_package_shipment',
        packageCount: fixture.parcels.length,
        originFingerprint: carrierSandboxPartyFingerprint(fixture.origin),
        destinationFingerprint:
          carrierSandboxRateDestinationFingerprint(fixture.destination),
        origin: {
          region: fixture.origin.region,
          countryCode: fixture.origin.countryCode,
        },
        destination: {
          region: fixture.destination.region,
          countryCode: fixture.destination.countryCode,
        },
        parcels: fixture.parcels,
      },
    },
  }
}

const SINGLE_PARCEL_RATE_RESPONSE_LIMIT_BYTES = 128 * 1024
const MULTI_PACKAGE_RATE_RESPONSE_BYTES_PER_ADDITIONAL_PACKAGE = 32 * 1024
const MULTI_PACKAGE_RATE_RESPONSE_HARD_LIMIT_BYTES = 2 * 1024 * 1024

type SandboxRateRuntimeCredential = CarrierRuntimeCredential & {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
}

export function carrierSandboxShipmentResponseLimitBytes(
  packageCount: number,
) {
  if (
    !Number.isInteger(packageCount)
    || packageCount < 1
    || packageCount > MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
  ) {
    throw new Error(
      `Carrier sandbox shipment response sizing requires 1-${
        MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
      } packages`,
    )
  }
  return Math.min(
    MULTI_PACKAGE_RATE_RESPONSE_HARD_LIMIT_BYTES,
    SINGLE_PARCEL_RATE_RESPONSE_LIMIT_BYTES
      + (
        packageCount - 1
      ) * MULTI_PACKAGE_RATE_RESPONSE_BYTES_PER_ADDITIONAL_PACKAGE,
  )
}

function assertCarrierSandboxRateCredential(
  input: CarrierRuntimeCredential,
): asserts input is SandboxRateRuntimeCredential {
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
}

async function executeCarrierSandboxRateRequest(
  input: SandboxRateRuntimeCredential,
  options: {
    fetchImpl: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
    fixture: CarrierSandboxShipmentRateFixture
    purpose: CarrierSandboxRatePurpose
    responseLimitBytes: number
    safeRequest: {
      requestHash: string
      redactedRequest: Record<string, unknown>
    }
    safeResponseContext?: Record<string, unknown>
  },
): Promise<{
  rates: CarrierSandboxRate[]
  testedAt: string
  evidence: CarrierSandboxRateEvidence
}> {
  const requestedAt = new Date().toISOString()
  const token = await requestCarrierAccessToken(input, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  const body = input.provider === 'fedex_rest'
    ? fedexRequest(input.credential.accountNumber!, options.fixture)
    : upsRequest(input.credential.accountNumber!, options.fixture)
  const transactionId = randomUUID()
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 12_000, 15_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    assertIntegrationCredentialProviderIoReady()
    const response = await options.fetchImpl(RATE_ENDPOINTS[input.provider], {
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
    if (
      Number.isFinite(contentLength)
      && contentLength > options.responseLimitBytes
    ) {
      throw new CarrierCredentialClientError('The carrier returned an invalid rate response', 502, 'CARRIER_PROVIDER_RESPONSE_INVALID')
    }
    const raw = await response.text()
    if (Buffer.byteLength(raw, 'utf8') > options.responseLimitBytes) {
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
    const safeResponse = {
      ...(options.safeResponseContext || {}),
      rateCount: rates.length,
      rates,
    }
    return {
      rates,
      testedAt: completedAt,
      evidence: {
        requestHash: options.safeRequest.requestHash,
        redactedRequest: options.safeRequest.redactedRequest,
        redactedResponse: safeResponse,
        providerReference: response.headers.get('transaction-id') || response.headers.get('x-customer-transaction-id'),
        requestedAt,
        completedAt,
      },
    }
  } catch (error) {
    if (isIntegrationCredentialRuntimeGateError(error)) throw error
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
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

export async function requestCarrierSandboxRates(
  input: CarrierRuntimeCredential,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
    fixture?: CarrierSandboxRateFixture
    purpose?: CarrierSandboxRatePurpose
  } = {},
): Promise<{
  result: CarrierSandboxRateResult
  evidence: CarrierSandboxRateEvidence
}> {
  assertCarrierSandboxRateCredential(input)
  const fixture = options.fixture || defaultCarrierSandboxRateFixture()
  const purpose = options.purpose || 'sandbox_rate_test'
  if (purpose === 'cartonization_shipment_rate') {
    throw new CarrierCredentialClientError(
      'Whole-shipment rating requires the multi-package request path',
      409,
      'CARRIER_SHIPMENT_RATE_PATH_REQUIRED',
    )
  }
  const shipmentFixture: CarrierSandboxShipmentRateFixture = {
    origin: fixture.origin,
    destination: fixture.destination,
    parcels: [fixture.parcel],
  }
  const request = carrierSandboxRateRequestEvidence(
    input.provider as 'ups_rest' | 'fedex_rest',
    fixture,
    purpose,
  )
  const response = await executeCarrierSandboxRateRequest(input, {
    fetchImpl: options.fetchImpl || fetch,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fixture: shipmentFixture,
    purpose,
    responseLimitBytes: SINGLE_PARCEL_RATE_RESPONSE_LIMIT_BYTES,
    safeRequest: request,
  })
  return {
    result: {
      provider: input.provider as 'ups_rest' | 'fedex_rest',
      environment: 'sandbox',
      purpose,
      fixture,
      destinationFingerprint:
        carrierSandboxPartyFingerprint(fixture.destination),
      rates: response.rates,
      testedAt: response.testedAt,
    },
    evidence: response.evidence,
  }
}

export async function requestCarrierSandboxShipmentRates(
  input: CarrierRuntimeCredential,
  options: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
    fixture: CarrierSandboxShipmentRateFixture
  },
): Promise<{
  result: CarrierSandboxShipmentRateResult
  evidence: CarrierSandboxRateEvidence
}> {
  assertCarrierSandboxRateCredential(input)
  if (
    !Array.isArray(options.fixture.parcels)
    || options.fixture.parcels.length < 1
    || options.fixture.parcels.length
      > MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
  ) {
    throw new CarrierCredentialClientError(
      `A shipment rate request supports 1-${
        MAX_CARRIER_SANDBOX_SHIPMENT_PACKAGES
      } packages`,
      409,
      'CARRIER_SHIPMENT_PACKAGE_COUNT_INVALID',
    )
  }
  const fixture: CarrierSandboxShipmentRateFixture = {
    origin: normalizeCarrierSandboxParty(options.fixture.origin),
    destination: normalizeCarrierSandboxRateDestination(
      options.fixture.destination,
    ),
    parcels: options.fixture.parcels.map((parcel) => ({
      ...parcel,
    })),
  }
  const safeRequest = carrierSandboxShipmentRateRequestEvidence(
    input.provider as 'ups_rest' | 'fedex_rest',
    fixture,
  )
  const response = await executeCarrierSandboxRateRequest(input, {
    fetchImpl: options.fetchImpl || fetch,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fixture,
    purpose: 'cartonization_shipment_rate',
    responseLimitBytes: carrierSandboxShipmentResponseLimitBytes(
      fixture.parcels.length,
    ),
    safeRequest,
    safeResponseContext: {
      rateScope: 'multi_package_shipment',
      packageCount: fixture.parcels.length,
    },
  })
  return {
    result: {
      provider: input.provider as 'ups_rest' | 'fedex_rest',
      environment: 'sandbox',
      purpose: 'cartonization_shipment_rate',
      rateScope: 'multi_package_shipment',
      fixture,
      packageCount: fixture.parcels.length,
      destinationFingerprint:
        carrierSandboxRateDestinationFingerprint(fixture.destination),
      rates: response.rates,
      testedAt: response.testedAt,
    },
    evidence: response.evidence,
  }
}
