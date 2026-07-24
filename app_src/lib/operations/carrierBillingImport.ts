import { createHash } from 'node:crypto'
import { parse } from 'csv-parse/sync'

export const CARRIER_BILLING_LOGICAL_FIELDS = [
  'accountNumber',
  'externalStatementId',
  'externalChargeId',
  'trackingNumber',
  'providerLabelId',
  'packageReference',
  'serviceCode',
  'chargeCategory',
  'description',
  'amount',
  'currency',
  'shipmentDate',
  'billedAt',
  'statementPeriodStart',
  'statementPeriodEnd',
  'issuedAt',
  'statementTotal',
] as const

export type CarrierBillingLogicalField = typeof CARRIER_BILLING_LOGICAL_FIELDS[number]
export type CarrierBillingEnvironment = 'sandbox' | 'production'
export type CarrierBillingChargeCategory =
  | 'transportation'
  | 'fuel_surcharge'
  | 'residential_surcharge'
  | 'delivery_area_surcharge'
  | 'address_correction'
  | 'dimensional_adjustment'
  | 'weight_adjustment'
  | 'signature'
  | 'saturday'
  | 'declared_value'
  | 'tax'
  | 'duty'
  | 'late_fee'
  | 'refund'
  | 'credit'
  | 'other'

export type CarrierBillingHeaderMapping = Partial<Record<CarrierBillingLogicalField, string>>

export type CarrierBillingAccountFingerprintInput = {
  accountNumber: string
  normalizedAccountNumber: string
  provider: string
  environment: CarrierBillingEnvironment
}

export type CarrierBillingCsvParseOptions = {
  provider: unknown
  environment: unknown
  headerMapping?: CarrierBillingHeaderMapping
  defaultCurrency?: unknown
  maxBytes?: number
  maxRows?: number
  failOnRejectedRows?: boolean
  fingerprintAccountNumber?: (input: Readonly<CarrierBillingAccountFingerprintInput>) => string
}

export type CarrierBillingCsvParseRequest = CarrierBillingCsvParseOptions & {
  csv: string | Buffer | Uint8Array
}

export type CarrierBillingRowIssue = {
  code:
    | 'INVALID_ACCOUNT'
    | 'INVALID_STATEMENT_ID'
    | 'INVALID_CHARGE_ID'
    | 'INVALID_AMOUNT'
    | 'INVALID_CURRENCY'
    | 'INVALID_DATE'
    | 'INVALID_VALUE'
    | 'DUPLICATE_ROW'
    | 'DUPLICATE_CHARGE'
    | 'INCONSISTENT_STATEMENT'
  field: CarrierBillingLogicalField | null
  message: string
}

export type NormalizedCarrierBillingRow = {
  rowNumber: number
  lineNumber: number
  lineSequence: number
  provider: string
  environment: CarrierBillingEnvironment
  externalStatementId: string
  externalChargeId: string
  billedAccountMaskedReference: string
  billedAccountFingerprint: string
  trackingNumber: string | null
  providerLabelId: string | null
  packageReference: string | null
  serviceCode: string | null
  chargeCategory: CarrierBillingChargeCategory
  description: string | null
  amountMinor: bigint
  currency: string
  shipmentDate: string | null
  billedAt: string | null
  statementPeriodStart: string | null
  statementPeriodEnd: string | null
  issuedAt: string | null
  statementTotalMinor: bigint | null
  sourceRowHash: string
  redactedEvidence: Record<string, string>
}

export type RejectedCarrierBillingRow = {
  rowNumber: number
  lineNumber: number
  billedAccountMaskedReference: string | null
  sourceRowHash: string
  issues: CarrierBillingRowIssue[]
  redactedEvidence: Record<string, string>
}

export type NormalizedCarrierBillingStatement = {
  externalStatementId: string
  billedAccountMaskedReference: string
  billedAccountFingerprint: string
  currency: string
  statementPeriodStart: string | null
  statementPeriodEnd: string | null
  issuedAt: string | null
  statementTotalMinor: bigint | null
  chargeCount: number
}

export type NormalizedCarrierBillingAccount = {
  billedAccountMaskedReference: string
  billedAccountFingerprint: string
  statementCount: number
  chargeCount: number
}

export type CarrierBillingCsvParseResult = {
  provider: string
  environment: CarrierBillingEnvironment
  sourceChecksum: string
  sourceByteLength: number
  resolvedHeaders: Partial<Record<CarrierBillingLogicalField, string>>
  rowCount: number
  importedRowCount: number
  rejectedRowCount: number
  accounts: NormalizedCarrierBillingAccount[]
  statements: NormalizedCarrierBillingStatement[]
  rows: NormalizedCarrierBillingRow[]
  rejectedRows: RejectedCarrierBillingRow[]
}

type CarrierBillingImportErrorCode =
  | 'INVALID_INPUT'
  | 'FILE_TOO_LARGE'
  | 'CSV_MALFORMED'
  | 'CSV_EMPTY'
  | 'TOO_MANY_ROWS'
  | 'INVALID_HEADERS'
  | 'MISSING_REQUIRED_HEADER'
  | 'AMBIGUOUS_HEADER'
  | 'INVALID_HEADER_MAPPING'
  | 'INVALID_PROVIDER'
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_ACCOUNT'
  | 'INVALID_STATEMENT_ID'
  | 'INVALID_CHARGE_ID'
  | 'INVALID_AMOUNT'
  | 'INVALID_CURRENCY'
  | 'INVALID_DATE'
  | 'INVALID_VALUE'
  | 'ROWS_REJECTED'

export class CarrierBillingImportError extends Error {
  readonly code: CarrierBillingImportErrorCode
  readonly field: CarrierBillingLogicalField | null

  constructor(
    code: CarrierBillingImportErrorCode,
    message: string,
    field: CarrierBillingLogicalField | null = null,
  ) {
    super(message)
    this.name = 'CarrierBillingImportError'
    this.code = code
    this.field = field
  }
}

export const CARRIER_BILLING_HEADER_ALIASES: Readonly<
  Record<CarrierBillingLogicalField, readonly string[]>
> = {
  accountNumber: [
    'account number',
    'account no',
    'account #',
    'billing account',
    'billing account number',
    'billed account',
    'billed account number',
    'bill to account',
    'bill-to account',
    'carrier account',
    'carrier account number',
    'payer account',
    'payer account number',
    'shipper account',
    'shipper number',
  ],
  externalStatementId: [
    'statement id',
    'statement number',
    'statement no',
    'statement #',
    'invoice id',
    'invoice number',
    'invoice no',
    'invoice #',
    'bill id',
    'bill number',
    'billing document number',
  ],
  externalChargeId: [
    'charge id',
    'charge number',
    'charge line id',
    'line id',
    'line item id',
    'invoice line id',
    'transaction id',
    'detail id',
    'record id',
  ],
  trackingNumber: [
    'tracking number',
    'tracking no',
    'tracking #',
    'tracking id',
    'shipment tracking number',
    'package tracking number',
    'waybill',
    'waybill number',
    'air waybill',
    'airway bill',
    'awb',
    'pro number',
  ],
  providerLabelId: [
    'provider label id',
    'label id',
    'label identifier',
    'label reference',
    'shipment label id',
  ],
  packageReference: [
    'package reference',
    'package id',
    'package number',
    'package no',
    'parcel id',
    'parcel number',
    'package control number',
  ],
  serviceCode: [
    'service code',
    'service level',
    'service type',
    'service',
    'carrier service',
    'product code',
    'mail class',
  ],
  chargeCategory: [
    'charge category',
    'charge type',
    'charge classification',
    'fee category',
    'fee type',
    'adjustment type',
    'surcharge type',
  ],
  description: [
    'description',
    'charge description',
    'charge name',
    'charge detail',
    'fee description',
    'line description',
  ],
  amount: [
    'amount',
    'charge amount',
    'net amount',
    'net charge',
    'billed amount',
    'line amount',
    'line total',
    'extended amount',
    'invoice charge',
  ],
  currency: [
    'currency',
    'currency code',
    'iso currency',
    'billing currency',
    'charge currency',
  ],
  shipmentDate: [
    'shipment date',
    'ship date',
    'pickup date',
    'tender date',
    'mailing date',
  ],
  billedAt: [
    'billed at',
    'billed date',
    'billing date',
    'charge date',
    'transaction date',
  ],
  statementPeriodStart: [
    'statement period start',
    'billing period start',
    'period start',
    'from date',
    'start date',
  ],
  statementPeriodEnd: [
    'statement period end',
    'billing period end',
    'period end',
    'through date',
    'to date',
    'end date',
  ],
  issuedAt: [
    'statement date',
    'statement issued at',
    'invoice date',
    'invoice issued at',
    'issue date',
  ],
  statementTotal: [
    'statement total',
    'invoice total',
    'invoice total amount',
    'statement amount',
    'bill total',
    'billing document total',
  ],
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_ROWS = 100_000
const MAX_COLUMNS = 200
const MAX_BIGINT = BigInt('9223372036854775807')
const MIN_BIGINT = BigInt('-9223372036854775808')
const REQUIRED_HEADERS: readonly CarrierBillingLogicalField[] = [
  'accountNumber',
  'externalStatementId',
  'amount',
]
const LOGICAL_FIELD_SET = new Set<string>(CARRIER_BILLING_LOGICAL_FIELDS)

const ZERO_MINOR_UNIT_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
  'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
])
const THREE_MINOR_UNIT_CURRENCIES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
])
const FOUR_MINOR_UNIT_CURRENCIES = new Set(['CLF', 'UYW'])
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  '$': 'USD',
  'US$': 'USD',
  'USDOLLAR': 'USD',
  'USDOLLARS': 'USD',
  'U.S.DOLLAR': 'USD',
  'U.S.DOLLARS': 'USD',
  'CA$': 'CAD',
  'C$': 'CAD',
  'CANADIANDOLLAR': 'CAD',
  'CANADIANDOLLARS': 'CAD',
  '€': 'EUR',
  'EURO': 'EUR',
  'EUROS': 'EUR',
  '£': 'GBP',
  'POUNDSTERLING': 'GBP',
  'STERLING': 'GBP',
  '¥': 'JPY',
  'YEN': 'JPY',
  '₹': 'INR',
  'RUPEE': 'INR',
  'RUPEES': 'INR',
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  ups: 'ups_rest',
  upsrest: 'ups_rest',
  unitedparcelservice: 'ups_rest',
  fedex: 'fedex_rest',
  fedexrest: 'fedex_rest',
  federalexpress: 'fedex_rest',
  usps: 'usps_rest',
  uspsrest: 'usps_rest',
  unitedstatespostalservice: 'usps_rest',
  postalservice: 'usps_rest',
  rocketshipit: 'rocketshipit',
  rsi: 'rocketshipit',
  mock: 'mock',
  mockcarrier: 'mock',
}

const ENVIRONMENT_ALIASES: Readonly<Record<string, CarrierBillingEnvironment>> = {
  sandbox: 'sandbox',
  sand: 'sandbox',
  test: 'sandbox',
  testing: 'sandbox',
  qa: 'sandbox',
  staging: 'sandbox',
  stage: 'sandbox',
  development: 'sandbox',
  dev: 'sandbox',
  cie: 'sandbox',
  tem: 'sandbox',
  production: 'production',
  prod: 'production',
  live: 'production',
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

type CsvRecordWithInfo = {
  record: string[]
  info: {
    lines: number
  }
}

type AccountSecret = {
  raw: string
  normalized: string
  masked: string
}

type StatementAccumulator = NormalizedCarrierBillingStatement & {
  sourceRowHashes: Set<string>
  externalChargeIds: Set<string>
}

function normalizedHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

const NORMALIZED_HEADER_ALIASES = Object.fromEntries(
  CARRIER_BILLING_LOGICAL_FIELDS.map((field) => [
    field,
    new Set([
      normalizedHeader(field),
      ...CARRIER_BILLING_HEADER_ALIASES[field].map(normalizedHeader),
    ]),
  ]),
) as Record<CarrierBillingLogicalField, Set<string>>

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeCarrierBillingProvider(value: unknown): string {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw || raw.length > 100 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new CarrierBillingImportError(
      'INVALID_PROVIDER',
      'Carrier billing provider is required and must be printable',
    )
  }
  const aliasKey = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (PROVIDER_ALIASES[aliasKey]) return PROVIDER_ALIASES[aliasKey]
  const provider = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!provider || provider.length > 64) {
    throw new CarrierBillingImportError(
      'INVALID_PROVIDER',
      'Carrier billing provider could not be normalized',
    )
  }
  return provider
}

export function normalizeCarrierBillingEnvironment(value: unknown): CarrierBillingEnvironment {
  const key = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const environment = ENVIRONMENT_ALIASES[key]
  if (!environment) {
    throw new CarrierBillingImportError(
      'INVALID_ENVIRONMENT',
      'Carrier billing environment must identify sandbox or production',
    )
  }
  return environment
}

export function normalizeCarrierBillingCurrency(
  value: unknown,
  fallback: unknown = 'USD',
): string {
  const raw = String(value ?? '').normalize('NFKC').trim()
    || String(fallback ?? '').normalize('NFKC').trim()
  const compact = raw.toUpperCase().replace(/\s+/g, '')
  const currency = CURRENCY_ALIASES[compact]
    || CURRENCY_ALIASES[raw.toUpperCase()]
    || compact
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CarrierBillingImportError(
      'INVALID_CURRENCY',
      'Carrier billing currency must use a three-letter code',
      'currency',
    )
  }
  return currency
}

export function carrierBillingCurrencyMinorDigits(currencyValue: unknown): number {
  const currency = normalizeCarrierBillingCurrency(currencyValue)
  if (ZERO_MINOR_UNIT_CURRENCIES.has(currency)) return 0
  if (THREE_MINOR_UNIT_CURRENCIES.has(currency)) return 3
  if (FOUR_MINOR_UNIT_CURRENCIES.has(currency)) return 4
  return 2
}

function validGroupedInteger(value: string, separator: string): boolean {
  const parts = value.split(separator)
  return parts.length > 1
    && /^\d{1,3}$/.test(parts[0])
    && parts.slice(1).every((part) => /^\d{3}$/.test(part))
}

function decimalParts(value: string, minorDigits: number): { whole: string; fraction: string } {
  const dotCount = (value.match(/\./g) || []).length
  const commaCount = (value.match(/,/g) || []).length
  let decimalSeparator: '.' | ',' | null = null
  let groupingSeparator: '.' | ',' | null = null

  if (dotCount > 0 && commaCount > 0) {
    decimalSeparator = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ','
    groupingSeparator = decimalSeparator === '.' ? ',' : '.'
    if ((value.match(new RegExp(`\\${decimalSeparator}`, 'g')) || []).length !== 1) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has ambiguous decimal separators',
        'amount',
      )
    }
  } else if (dotCount === 1) {
    decimalSeparator = '.'
  } else if (dotCount > 1) {
    if (!validGroupedInteger(value, '.')) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has invalid grouping',
        'amount',
      )
    }
    groupingSeparator = '.'
  } else if (commaCount === 1) {
    const digitsAfterComma = value.length - value.lastIndexOf(',') - 1
    if (minorDigits > 0 && digitsAfterComma <= minorDigits) {
      decimalSeparator = ','
    } else if (validGroupedInteger(value, ',')) {
      groupingSeparator = ','
    } else {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has invalid precision or grouping',
        'amount',
      )
    }
  } else if (commaCount > 1) {
    if (!validGroupedInteger(value, ',')) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has invalid grouping',
        'amount',
      )
    }
    groupingSeparator = ','
  }

  const decimalIndex = decimalSeparator ? value.lastIndexOf(decimalSeparator) : -1
  const integerPart = decimalIndex >= 0 ? value.slice(0, decimalIndex) : value
  const fraction = decimalIndex >= 0 ? value.slice(decimalIndex + 1) : ''
  if (!fraction.match(/^\d*$/)) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing amount has an invalid decimal fraction',
      'amount',
    )
  }
  if (groupingSeparator) {
    if (!validGroupedInteger(integerPart, groupingSeparator)) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has invalid grouping',
        'amount',
      )
    }
  } else if (!/^\d+$/.test(integerPart)) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing amount must be a decimal value',
      'amount',
    )
  }
  const whole = groupingSeparator
    ? integerPart.split(groupingSeparator).join('')
    : integerPart
  return { whole, fraction }
}

export function decimalToMinorUnits(
  value: unknown,
  currencyOrMinorDigits: unknown = 'USD',
): bigint {
  const minorDigits = typeof currencyOrMinorDigits === 'number'
    ? currencyOrMinorDigits
    : carrierBillingCurrencyMinorDigits(currencyOrMinorDigits)
  if (!Number.isInteger(minorDigits) || minorDigits < 0 || minorDigits > 6) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing minor-unit precision must be an integer from 0 to 6',
      'amount',
    )
  }

  let raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing amount is required',
      'amount',
    )
  }

  let negative = false
  let signSeen = false
  if (raw.startsWith('(') || raw.endsWith(')')) {
    if (!(raw.startsWith('(') && raw.endsWith(')'))) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has unmatched parentheses',
        'amount',
      )
    }
    negative = true
    signSeen = true
    raw = raw.slice(1, -1).trim()
  }

  const direction = raw.match(/\s+(CR|DR)$/i)
  if (direction) {
    if (signSeen) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount contains multiple sign indicators',
        'amount',
      )
    }
    negative = direction[1].toUpperCase() === 'CR'
    signSeen = true
    raw = raw.slice(0, direction.index).trim()
  }
  if (raw.endsWith('-')) {
    if (signSeen) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount contains multiple sign indicators',
        'amount',
      )
    }
    negative = true
    signSeen = true
    raw = raw.slice(0, -1).trim()
  }
  if (/^[+-]/.test(raw)) {
    if (signSeen) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount contains multiple sign indicators',
        'amount',
      )
    }
    negative = raw[0] === '-'
    signSeen = true
    raw = raw.slice(1).trim()
  }

  const currency = typeof currencyOrMinorDigits === 'number'
    ? null
    : normalizeCarrierBillingCurrency(currencyOrMinorDigits)
  if (currency) {
    const codePattern = new RegExp(`\\b${currency}\\b`, 'ig')
    raw = raw.replace(codePattern, '')
  }
  raw = raw
    .replace(/(?:US\$|CA\$|C\$|A\$|NZ\$|[$€£¥₹])/gi, '')
    .replace(/[\s\u00a0\u202f]/g, '')
    .trim()
  if (/^[.,]\d/.test(raw)) raw = `0${raw}`

  if (!raw || /[A-Za-z]/.test(raw) || !/^[0-9.,'’]+$/.test(raw)) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing amount must be a plain decimal value',
      'amount',
    )
  }

  if (/['’]/.test(raw)) {
    const match = raw.match(/^(\d{1,3}(?:['’]\d{3})+)([.,]\d+)?$/)
    if (!match) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has invalid grouping',
        'amount',
      )
    }
    raw = raw.replace(/['’]/g, '')
  }

  const { whole, fraction } = decimalParts(raw, minorDigits)
  if (fraction.length > minorDigits) {
    const discarded = fraction.slice(minorDigits)
    if (!/^0*$/.test(discarded)) {
      throw new CarrierBillingImportError(
        'INVALID_AMOUNT',
        'Carrier billing amount has more precision than its currency allows',
        'amount',
      )
    }
  }
  const retainedFraction = fraction
    .slice(0, minorDigits)
    .padEnd(minorDigits, '0')
  const scale = BigInt(10) ** BigInt(minorDigits)
  let minor = BigInt(whole) * scale
  if (retainedFraction) minor += BigInt(retainedFraction)
  if (negative && minor !== BigInt(0)) minor = -minor
  if (minor < MIN_BIGINT || minor > MAX_BIGINT) {
    throw new CarrierBillingImportError(
      'INVALID_AMOUNT',
      'Carrier billing amount exceeds the supported minor-unit range',
      'amount',
    )
  }
  return minor
}

function normalizedAccount(value: unknown): { raw: string; normalized: string } {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (
    raw.length < 4
    || raw.length > 128
    || /[^\x20-\x7e]/.test(raw)
  ) {
    throw new CarrierBillingImportError(
      'INVALID_ACCOUNT',
      'Carrier billing account number must be 4-128 printable ASCII characters',
      'accountNumber',
    )
  }
  const normalized = raw.toUpperCase().replace(/[\s-]+/g, '')
  if (normalized.length < 4 || normalized.length > 128) {
    throw new CarrierBillingImportError(
      'INVALID_ACCOUNT',
      'Carrier billing account number is invalid after normalization',
      'accountNumber',
    )
  }
  return { raw, normalized }
}

export function maskCarrierBillingAccount(value: unknown): string {
  const account = normalizedAccount(value)
  return account.normalized.length > 4
    ? `****${account.normalized.slice(-4)}`
    : '****'
}

export function normalizeCarrierBillingTrackingNumber(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!normalized || normalized.length > 128) {
    throw new CarrierBillingImportError(
      'INVALID_VALUE',
      'Carrier billing tracking number is invalid',
      'trackingNumber',
    )
  }
  return normalized
}

function normalizedCategoryKey(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function normalizeCarrierBillingCategory(
  value: unknown,
  description: unknown = '',
  amountMinor?: bigint,
): CarrierBillingChargeCategory {
  const source = [normalizedCategoryKey(value), normalizedCategoryKey(description)]
    .filter(Boolean)
    .join(' ')
  if (!source) {
    return amountMinor !== undefined && amountMinor < BigInt(0) ? 'credit' : 'other'
  }
  if (/\brefund(?:ed)?\b/.test(source)) return 'refund'
  if (/\bcredit\b|\bcredit adjustment\b/.test(source)) return 'credit'
  if (/\bfuel\b/.test(source)) return 'fuel_surcharge'
  if (/\bresidential\b/.test(source)) return 'residential_surcharge'
  if (/\bdelivery area\b|\bextended area\b|\bremote area\b|\bdas\b/.test(source)) {
    return 'delivery_area_surcharge'
  }
  if (/\baddress correction\b|\baddress adjustment\b/.test(source)) return 'address_correction'
  if (/\bdimensional\b|\bdimension adjustment\b|\bdim weight\b/.test(source)) {
    return 'dimensional_adjustment'
  }
  if (/\bweight adjustment\b|\bweight correction\b|\breweigh\b/.test(source)) {
    return 'weight_adjustment'
  }
  if (/\bsignature\b/.test(source)) return 'signature'
  if (/\bsaturday\b|\bweekend delivery\b/.test(source)) return 'saturday'
  if (/\bdeclared value\b|\binsurance\b/.test(source)) return 'declared_value'
  if (/\bcustoms duty\b|\bimport duty\b|\bduties\b|\bduty\b/.test(source)) return 'duty'
  if (/\btax\b|\bvat\b|\bgst\b|\bhst\b/.test(source)) return 'tax'
  if (/\blate fee\b|\blate payment\b|\bfinance charge\b/.test(source)) return 'late_fee'
  if (
    /\btransportation\b|\bshipping charge\b|\bbase charge\b|\bfreight\b|\blinehaul\b|\bpostage\b/
      .test(source)
  ) {
    return 'transportation'
  }
  return 'other'
}

function normalizedYear(value: string): number {
  const year = Number(value)
  return value.length === 2 ? (year >= 70 ? 1900 + year : 2000 + year) : year
}

function isoDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    !Number.isInteger(year)
    || year < 1900
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new CarrierBillingImportError(
      'INVALID_DATE',
      'Carrier billing date is not a valid calendar date',
    )
  }
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-')
}

export function normalizeCarrierBillingDate(value: unknown): string | null {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw) return null

  let match = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i,
  )
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  match = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  match = raw.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
  match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/)
  if (match) {
    return isoDate(normalizedYear(match[3]), Number(match[1]), Number(match[2]))
  }
  match = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (match && MONTHS[match[1].toLowerCase()]) {
    return isoDate(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]))
  }
  match = raw.match(/^(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{2}|\d{4})$/)
  if (match && MONTHS[match[2].toLowerCase()]) {
    return isoDate(normalizedYear(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]))
  }
  throw new CarrierBillingImportError(
    'INVALID_DATE',
    'Carrier billing date format is unsupported',
  )
}

export function normalizeCarrierBillingTimestamp(value: unknown): string | null {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw) return null
  if (!/[T\s]\d{1,2}:\d{2}/.test(raw)) {
    const date = normalizeCarrierBillingDate(raw)
    return date ? `${date}T00:00:00.000Z` : null
  }
  if (
    !/^\d{4}-\d{1,2}-\d{1,2}[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i
      .test(raw)
  ) {
    throw new CarrierBillingImportError(
      'INVALID_DATE',
      'Carrier billing timestamp format is unsupported',
    )
  }
  const dateParts = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!dateParts) {
    throw new CarrierBillingImportError(
      'INVALID_DATE',
      'Carrier billing timestamp is invalid',
    )
  }
  isoDate(Number(dateParts[1]), Number(dateParts[2]), Number(dateParts[3]))
  const candidate = raw.replace(' ', 'T')
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(candidate)
    ? candidate
    : `${candidate}Z`
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds)) {
    throw new CarrierBillingImportError(
      'INVALID_DATE',
      'Carrier billing timestamp is invalid',
    )
  }
  return new Date(milliseconds).toISOString()
}

function cleanText(
  value: unknown,
  field: CarrierBillingLogicalField,
  maximum: number,
  required = false,
): string | null {
  const normalized = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!normalized) {
    if (required) {
      throw new CarrierBillingImportError(
        field === 'externalStatementId' ? 'INVALID_STATEMENT_ID' : 'INVALID_VALUE',
        field === 'externalStatementId'
          ? 'Carrier billing statement ID is required'
          : `Carrier billing ${field} is required`,
        field,
      )
    }
    return null
  }
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CarrierBillingImportError(
      field === 'externalChargeId' ? 'INVALID_CHARGE_ID' : 'INVALID_VALUE',
      `Carrier billing ${field} is invalid`,
      field,
    )
  }
  return normalized
}

function resolveHeaders(
  headers: string[],
  headerMapping: CarrierBillingHeaderMapping | undefined,
): {
  indexes: Partial<Record<CarrierBillingLogicalField, number>>
  resolvedHeaders: Partial<Record<CarrierBillingLogicalField, string>>
} {
  if (headers.length === 0 || headers.length > MAX_COLUMNS) {
    throw new CarrierBillingImportError(
      'INVALID_HEADERS',
      `Carrier billing CSV must contain 1-${MAX_COLUMNS} columns`,
    )
  }
  const normalized = headers.map(normalizedHeader)
  if (normalized.some((header) => !header)) {
    throw new CarrierBillingImportError(
      'INVALID_HEADERS',
      'Carrier billing CSV headers must be present',
    )
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new CarrierBillingImportError(
      'INVALID_HEADERS',
      'Carrier billing CSV headers must be unique after normalization',
    )
  }

  const indexes: Partial<Record<CarrierBillingLogicalField, number>> = {}
  const claimedIndexes = new Set<number>()
  for (const [rawField, requestedHeader] of Object.entries(headerMapping || {})) {
    if (!LOGICAL_FIELD_SET.has(rawField)) {
      throw new CarrierBillingImportError(
        'INVALID_HEADER_MAPPING',
        `Carrier billing header mapping contains unsupported logical field ${rawField}`,
      )
    }
    const field = rawField as CarrierBillingLogicalField
    const headerKey = normalizedHeader(requestedHeader)
    const index = normalized.indexOf(headerKey)
    if (!headerKey || index < 0) {
      throw new CarrierBillingImportError(
        'INVALID_HEADER_MAPPING',
        `Carrier billing header mapping for ${field} does not match a CSV header`,
      )
    }
    if (claimedIndexes.has(index)) {
      throw new CarrierBillingImportError(
        'INVALID_HEADER_MAPPING',
        'One CSV header cannot map to multiple carrier billing fields',
      )
    }
    indexes[field] = index
    claimedIndexes.add(index)
  }

  for (const field of CARRIER_BILLING_LOGICAL_FIELDS) {
    if (indexes[field] !== undefined) continue
    const matches = normalized
      .map((header, index) => ({ header, index }))
      .filter(({ header, index }) => (
        !claimedIndexes.has(index) && NORMALIZED_HEADER_ALIASES[field].has(header)
      ))
    if (matches.length > 1) {
      throw new CarrierBillingImportError(
        'AMBIGUOUS_HEADER',
        `Carrier billing CSV has multiple candidate headers for ${field}; provide a mapping`,
      )
    }
    if (matches.length === 1) {
      indexes[field] = matches[0].index
      claimedIndexes.add(matches[0].index)
    }
  }

  for (const field of REQUIRED_HEADERS) {
    if (indexes[field] === undefined) {
      throw new CarrierBillingImportError(
        'MISSING_REQUIRED_HEADER',
        `Carrier billing CSV is missing a required ${field} header`,
      )
    }
  }
  return {
    indexes,
    resolvedHeaders: Object.fromEntries(
      Object.entries(indexes).map(([field, index]) => [field, headers[index]]),
    ) as Partial<Record<CarrierBillingLogicalField, string>>,
  }
}

function safeAccountSecret(value: unknown): AccountSecret | null {
  const raw = String(value ?? '').normalize('NFKC').trim()
  if (!raw) return null
  try {
    const account = normalizedAccount(raw)
    return {
      ...account,
      masked: account.normalized.length > 4
        ? `****${account.normalized.slice(-4)}`
        : '****',
    }
  } catch {
    const compact = raw.toUpperCase().replace(/[\s-]+/g, '')
    return {
      raw,
      normalized: compact,
      masked: compact.length > 4 ? `****${compact.slice(-4)}` : '[REDACTED_ACCOUNT]',
    }
  }
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactAccountOccurrences(value: unknown, secrets: AccountSecret[]): string {
  let redacted = String(value ?? '').normalize('NFKC')
  for (const secret of secrets) {
    const variants = [...new Set([secret.raw, secret.normalized])]
      .filter((candidate) => candidate.length >= 4)
      .sort((left, right) => right.length - left.length)
    for (const variant of variants) {
      redacted = redacted.replace(new RegExp(escapedPattern(variant), 'gi'), secret.masked)
    }
    if (/^[A-Z0-9]+$/.test(secret.normalized) && secret.normalized.length >= 6) {
      const flexible = [...secret.normalized]
        .map((character) => escapedPattern(character))
        .join('[\\s._-]*')
      redacted = redacted.replace(new RegExp(flexible, 'gi'), secret.masked)
    }
  }
  return redacted
}

function redactedEvidence(
  headers: string[],
  values: string[],
  accountIndexes: Set<number>,
): { evidence: Record<string, string>; secrets: AccountSecret[] } {
  const secrets = [...accountIndexes]
    .map((index) => safeAccountSecret(values[index]))
    .filter((secret): secret is AccountSecret => secret !== null)
  const entries = headers.map((header, index) => {
    const key = redactAccountOccurrences(header, secrets).slice(0, 200)
    const directSecret = accountIndexes.has(index) ? safeAccountSecret(values[index]) : null
    const redacted = directSecret
      ? directSecret.masked
      : redactAccountOccurrences(values[index], secrets)
    return [key, redacted.slice(0, 4_000)] as const
  })
  return { evidence: Object.fromEntries(entries), secrets }
}

function sourceRowHash(headers: string[], values: string[]): string {
  return sha256(JSON.stringify(headers.map((header, index) => [
    normalizedHeader(header),
    values[index] ?? '',
  ])))
}

function fieldValue(
  values: string[],
  indexes: Partial<Record<CarrierBillingLogicalField, number>>,
  field: CarrierBillingLogicalField,
): string {
  const index = indexes[field]
  return index === undefined ? '' : String(values[index] ?? '')
}

function safeMaskedAccount(
  values: string[],
  indexes: Partial<Record<CarrierBillingLogicalField, number>>,
): string | null {
  const secret = safeAccountSecret(fieldValue(values, indexes, 'accountNumber'))
  return secret?.masked || null
}

function rowIssue(error: unknown): CarrierBillingRowIssue {
  if (error instanceof CarrierBillingImportError) {
    const supportedCodes = new Set<CarrierBillingRowIssue['code']>([
      'INVALID_ACCOUNT',
      'INVALID_STATEMENT_ID',
      'INVALID_CHARGE_ID',
      'INVALID_AMOUNT',
      'INVALID_CURRENCY',
      'INVALID_DATE',
      'INVALID_VALUE',
    ])
    return {
      code: supportedCodes.has(error.code as CarrierBillingRowIssue['code'])
        ? error.code as CarrierBillingRowIssue['code']
        : 'INVALID_VALUE',
      field: error.field,
      message: error.message,
    }
  }
  return {
    code: 'INVALID_VALUE',
    field: null,
    message: 'Carrier billing row could not be normalized',
  }
}

function normalizedRow(
  values: string[],
  rowNumber: number,
  lineNumber: number,
  rowHash: string,
  evidence: Record<string, string>,
  secrets: AccountSecret[],
  indexes: Partial<Record<CarrierBillingLogicalField, number>>,
  options: CarrierBillingCsvParseOptions,
  provider: string,
  environment: CarrierBillingEnvironment,
  defaultCurrency: string,
): Omit<NormalizedCarrierBillingRow, 'lineSequence'> {
  const account = normalizedAccount(fieldValue(values, indexes, 'accountNumber'))
  const billedAccountMaskedReference = account.normalized.length > 4
    ? `****${account.normalized.slice(-4)}`
    : '****'
  let billedAccountFingerprint: string
  if (options.fingerprintAccountNumber) {
    try {
      billedAccountFingerprint = String(options.fingerprintAccountNumber(Object.freeze({
        accountNumber: account.raw,
        normalizedAccountNumber: account.normalized,
        provider,
        environment,
      }))).trim().toLowerCase()
    } catch {
      throw new CarrierBillingImportError(
        'INVALID_ACCOUNT',
        'Carrier billing account fingerprint could not be generated',
        'accountNumber',
      )
    }
  } else {
    billedAccountFingerprint = sha256(
      `clawpilot:carrier-billing-account:v1\0${provider}\0${environment}\0${account.normalized}`,
    )
  }
  if (!/^[a-f0-9]{64}$/.test(billedAccountFingerprint)) {
    throw new CarrierBillingImportError(
      'INVALID_ACCOUNT',
      'Carrier billing account fingerprint must be a SHA-256 hex value',
      'accountNumber',
    )
  }

  const externalStatementId = cleanText(
    fieldValue(values, indexes, 'externalStatementId'),
    'externalStatementId',
    250,
    true,
  ) as string
  const currency = normalizeCarrierBillingCurrency(
    fieldValue(values, indexes, 'currency'),
    defaultCurrency,
  )
  const amountMinor = decimalToMinorUnits(fieldValue(values, indexes, 'amount'), currency)
  const suppliedChargeId = cleanText(
    fieldValue(values, indexes, 'externalChargeId'),
    'externalChargeId',
    250,
  )
  const externalChargeId = suppliedChargeId || `row-${rowHash.slice(0, 32)}`
  const descriptionValue = cleanText(
    fieldValue(values, indexes, 'description'),
    'description',
    2_000,
  )
  const description = descriptionValue
    ? redactAccountOccurrences(descriptionValue, secrets)
    : null
  const shipmentDate = normalizeCarrierBillingDate(
    fieldValue(values, indexes, 'shipmentDate'),
  )
  const statementPeriodStart = normalizeCarrierBillingDate(
    fieldValue(values, indexes, 'statementPeriodStart'),
  )
  const statementPeriodEnd = normalizeCarrierBillingDate(
    fieldValue(values, indexes, 'statementPeriodEnd'),
  )
  if (
    statementPeriodStart
    && statementPeriodEnd
    && statementPeriodEnd < statementPeriodStart
  ) {
    throw new CarrierBillingImportError(
      'INVALID_DATE',
      'Carrier billing statement period ends before it starts',
      'statementPeriodEnd',
    )
  }
  const statementTotalRaw = fieldValue(values, indexes, 'statementTotal').trim()

  return {
    rowNumber,
    lineNumber,
    provider,
    environment,
    externalStatementId: redactAccountOccurrences(externalStatementId, secrets),
    externalChargeId: redactAccountOccurrences(externalChargeId, secrets),
    billedAccountMaskedReference,
    billedAccountFingerprint,
    trackingNumber: normalizeCarrierBillingTrackingNumber(
      fieldValue(values, indexes, 'trackingNumber'),
    ),
    providerLabelId: cleanText(
      fieldValue(values, indexes, 'providerLabelId'),
      'providerLabelId',
      250,
    ),
    packageReference: cleanText(
      fieldValue(values, indexes, 'packageReference'),
      'packageReference',
      250,
    ),
    serviceCode: cleanText(
      fieldValue(values, indexes, 'serviceCode'),
      'serviceCode',
      100,
    ),
    chargeCategory: normalizeCarrierBillingCategory(
      fieldValue(values, indexes, 'chargeCategory'),
      description,
      amountMinor,
    ),
    description,
    amountMinor,
    currency,
    shipmentDate,
    billedAt: normalizeCarrierBillingTimestamp(fieldValue(values, indexes, 'billedAt')),
    statementPeriodStart,
    statementPeriodEnd,
    issuedAt: normalizeCarrierBillingTimestamp(fieldValue(values, indexes, 'issuedAt')),
    statementTotalMinor: statementTotalRaw
      ? decimalToMinorUnits(statementTotalRaw, currency)
      : null,
    sourceRowHash: rowHash,
    redactedEvidence: evidence,
  }
}

function statementConflict(
  statement: StatementAccumulator,
  row: Omit<NormalizedCarrierBillingRow, 'lineSequence'>,
): boolean {
  if (statement.currency !== row.currency) return true
  for (const field of [
    'statementPeriodStart',
    'statementPeriodEnd',
    'issuedAt',
    'statementTotalMinor',
  ] as const) {
    const prior = statement[field]
    const current = row[field]
    if (prior !== null && current !== null && prior !== current) return true
  }
  return false
}

function mergeStatementEvidence(
  statement: StatementAccumulator,
  row: Omit<NormalizedCarrierBillingRow, 'lineSequence'>,
) {
  statement.statementPeriodStart ||= row.statementPeriodStart
  statement.statementPeriodEnd ||= row.statementPeriodEnd
  statement.issuedAt ||= row.issuedAt
  statement.statementTotalMinor ??= row.statementTotalMinor
}

function accountHeaderIndexes(
  headers: string[],
  indexes: Partial<Record<CarrierBillingLogicalField, number>>,
): Set<number> {
  const result = new Set<number>()
  const mappedIndex = indexes.accountNumber
  if (mappedIndex !== undefined) result.add(mappedIndex)
  headers.forEach((header, index) => {
    if (NORMALIZED_HEADER_ALIASES.accountNumber.has(normalizedHeader(header))) result.add(index)
  })
  return result
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new CarrierBillingImportError('INVALID_INPUT', `${label} must be a positive integer`)
  }
  return limit
}

function parseArguments(
  sourceOrRequest: string | Buffer | Uint8Array | CarrierBillingCsvParseRequest,
  suppliedOptions?: CarrierBillingCsvParseOptions,
): { source: string | Buffer | Uint8Array; options: CarrierBillingCsvParseOptions } {
  if (
    sourceOrRequest
    && typeof sourceOrRequest === 'object'
    && !Buffer.isBuffer(sourceOrRequest)
    && !(sourceOrRequest instanceof Uint8Array)
    && 'csv' in sourceOrRequest
  ) {
    const { csv, ...options } = sourceOrRequest
    return { source: csv, options }
  }
  if (!suppliedOptions) {
    throw new CarrierBillingImportError(
      'INVALID_INPUT',
      'Carrier billing CSV parse options are required',
    )
  }
  return { source: sourceOrRequest, options: suppliedOptions }
}

export function parseCarrierBillingCsv(
  source: string | Buffer | Uint8Array,
  options: CarrierBillingCsvParseOptions,
): CarrierBillingCsvParseResult
export function parseCarrierBillingCsv(
  request: CarrierBillingCsvParseRequest,
): CarrierBillingCsvParseResult
export function parseCarrierBillingCsv(
  sourceOrRequest: string | Buffer | Uint8Array | CarrierBillingCsvParseRequest,
  suppliedOptions?: CarrierBillingCsvParseOptions,
): CarrierBillingCsvParseResult {
  const { source, options } = parseArguments(sourceOrRequest, suppliedOptions)
  const provider = normalizeCarrierBillingProvider(options.provider)
  const environment = normalizeCarrierBillingEnvironment(options.environment)
  const defaultCurrency = normalizeCarrierBillingCurrency(options.defaultCurrency, 'USD')
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_BYTES, 'Carrier billing maxBytes')
  const maxRows = positiveLimit(options.maxRows, DEFAULT_MAX_ROWS, 'Carrier billing maxRows')
  if (
    typeof source !== 'string'
    && !Buffer.isBuffer(source)
    && !(source instanceof Uint8Array)
  ) {
    throw new CarrierBillingImportError(
      'INVALID_INPUT',
      'Carrier billing CSV source must be text or bytes',
    )
  }
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source)
  if (bytes.length === 0 || !bytes.toString('utf8').trim()) {
    throw new CarrierBillingImportError('CSV_EMPTY', 'Carrier billing CSV is empty')
  }
  if (bytes.length > maxBytes) {
    throw new CarrierBillingImportError(
      'FILE_TOO_LARGE',
      `Carrier billing CSV exceeds the ${maxBytes}-byte limit`,
    )
  }

  let parsed: CsvRecordWithInfo[]
  try {
    parsed = parse(bytes, {
      bom: true,
      info: true,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      max_record_size: maxBytes,
    }) as unknown as CsvRecordWithInfo[]
  } catch (error) {
    const line = (
      error
      && typeof error === 'object'
      && 'lines' in error
      && Number.isSafeInteger(Number(error.lines))
    ) ? Number(error.lines) : null
    throw new CarrierBillingImportError(
      'CSV_MALFORMED',
      `Carrier billing CSV is malformed${line ? ` near line ${line}` : ''}`,
    )
  }
  if (parsed.length < 2) {
    throw new CarrierBillingImportError(
      'CSV_EMPTY',
      'Carrier billing CSV contains no data rows',
    )
  }
  if (parsed.length - 1 > maxRows) {
    throw new CarrierBillingImportError(
      'TOO_MANY_ROWS',
      `Carrier billing CSV exceeds the ${maxRows}-row limit`,
    )
  }

  const headers = parsed[0].record.map((header) => String(header))
  const { indexes, resolvedHeaders } = resolveHeaders(headers, options.headerMapping)
  const sensitiveIndexes = accountHeaderIndexes(headers, indexes)
  const rows: NormalizedCarrierBillingRow[] = []
  const rejectedRows: RejectedCarrierBillingRow[] = []
  const statementMap = new Map<string, StatementAccumulator>()

  parsed.slice(1).forEach((parsedRow, index) => {
    const values = parsedRow.record.map((value) => String(value ?? ''))
    const rowNumber = index + 1
    const lineNumber = parsedRow.info.lines
    const rowHash = sourceRowHash(headers, values)
    const { evidence, secrets } = redactedEvidence(headers, values, sensitiveIndexes)
    let candidate: Omit<NormalizedCarrierBillingRow, 'lineSequence'>
    try {
      candidate = normalizedRow(
        values,
        rowNumber,
        lineNumber,
        rowHash,
        evidence,
        secrets,
        indexes,
        options,
        provider,
        environment,
        defaultCurrency,
      )
    } catch (error) {
      rejectedRows.push({
        rowNumber,
        lineNumber,
        billedAccountMaskedReference: safeMaskedAccount(values, indexes),
        sourceRowHash: rowHash,
        issues: [rowIssue(error)],
        redactedEvidence: evidence,
      })
      return
    }

    const statementKey = [
      candidate.billedAccountFingerprint,
      candidate.externalStatementId,
    ].join('\0')
    const existing = statementMap.get(statementKey)
    if (existing?.sourceRowHashes.has(candidate.sourceRowHash)) {
      rejectedRows.push({
        rowNumber,
        lineNumber,
        billedAccountMaskedReference: candidate.billedAccountMaskedReference,
        sourceRowHash: rowHash,
        issues: [{
          code: 'DUPLICATE_ROW',
          field: null,
          message: 'Carrier billing row duplicates an earlier row in the same statement',
        }],
        redactedEvidence: evidence,
      })
      return
    }
    if (existing?.externalChargeIds.has(candidate.externalChargeId)) {
      rejectedRows.push({
        rowNumber,
        lineNumber,
        billedAccountMaskedReference: candidate.billedAccountMaskedReference,
        sourceRowHash: rowHash,
        issues: [{
          code: 'DUPLICATE_CHARGE',
          field: 'externalChargeId',
          message: 'Carrier billing charge ID duplicates an earlier charge in the same statement',
        }],
        redactedEvidence: evidence,
      })
      return
    }
    if (existing && statementConflict(existing, candidate)) {
      rejectedRows.push({
        rowNumber,
        lineNumber,
        billedAccountMaskedReference: candidate.billedAccountMaskedReference,
        sourceRowHash: rowHash,
        issues: [{
          code: 'INCONSISTENT_STATEMENT',
          field: null,
          message: 'Carrier billing statement metadata conflicts with an earlier row',
        }],
        redactedEvidence: evidence,
      })
      return
    }

    const statement = existing || {
      externalStatementId: candidate.externalStatementId,
      billedAccountMaskedReference: candidate.billedAccountMaskedReference,
      billedAccountFingerprint: candidate.billedAccountFingerprint,
      currency: candidate.currency,
      statementPeriodStart: candidate.statementPeriodStart,
      statementPeriodEnd: candidate.statementPeriodEnd,
      issuedAt: candidate.issuedAt,
      statementTotalMinor: candidate.statementTotalMinor,
      chargeCount: 0,
      sourceRowHashes: new Set<string>(),
      externalChargeIds: new Set<string>(),
    }
    mergeStatementEvidence(statement, candidate)
    statement.chargeCount += 1
    statement.sourceRowHashes.add(candidate.sourceRowHash)
    statement.externalChargeIds.add(candidate.externalChargeId)
    statementMap.set(statementKey, statement)
    rows.push({ ...candidate, lineSequence: statement.chargeCount })
  })

  const statements = [...statementMap.values()].map((statement) => ({
    externalStatementId: statement.externalStatementId,
    billedAccountMaskedReference: statement.billedAccountMaskedReference,
    billedAccountFingerprint: statement.billedAccountFingerprint,
    currency: statement.currency,
    statementPeriodStart: statement.statementPeriodStart,
    statementPeriodEnd: statement.statementPeriodEnd,
    issuedAt: statement.issuedAt,
    statementTotalMinor: statement.statementTotalMinor,
    chargeCount: statement.chargeCount,
  }))
  const accountMap = new Map<string, NormalizedCarrierBillingAccount & { statements: Set<string> }>()
  for (const statement of statements) {
    const account = accountMap.get(statement.billedAccountFingerprint) || {
      billedAccountMaskedReference: statement.billedAccountMaskedReference,
      billedAccountFingerprint: statement.billedAccountFingerprint,
      statementCount: 0,
      chargeCount: 0,
      statements: new Set<string>(),
    }
    account.statements.add(statement.externalStatementId)
    account.statementCount = account.statements.size
    account.chargeCount += statement.chargeCount
    accountMap.set(statement.billedAccountFingerprint, account)
  }
  const accounts = [...accountMap.values()].map((account) => ({
    billedAccountMaskedReference: account.billedAccountMaskedReference,
    billedAccountFingerprint: account.billedAccountFingerprint,
    statementCount: account.statementCount,
    chargeCount: account.chargeCount,
  }))

  if (options.failOnRejectedRows && rejectedRows.length > 0) {
    throw new CarrierBillingImportError(
      'ROWS_REJECTED',
      `Carrier billing CSV contains ${rejectedRows.length} rejected row(s)`,
    )
  }
  return {
    provider,
    environment,
    sourceChecksum: sha256(bytes),
    sourceByteLength: bytes.length,
    resolvedHeaders,
    rowCount: parsed.length - 1,
    importedRowCount: rows.length,
    rejectedRowCount: rejectedRows.length,
    accounts,
    statements,
    rows,
    rejectedRows,
  }
}
