// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentionally used for Node tests.
import { commerceProductDisplayName } from './commerceProductNaming.ts'

export const COMMERCE_INTAKE_CSV_MAX_BYTES = 1_048_576
export const COMMERCE_INTAKE_CSV_MAX_DATA_ROWS = 500
export const COMMERCE_INTAKE_CSV_MAX_MONEY_MINOR = 9_000_000_000_000

export const COMMERCE_PRODUCT_REVIEW_CSV_HEADERS = [
  'account_global_id',
  'candidate_global_id',
  'row_version',
  'provider',
  'external_product_id',
  'external_variant_id',
  'sku',
  'product_title',
  'variant_title',
  'source_currency',
  'source_price',
  'action',
  'existing_product_global_id',
  'create_name',
  'create_sku',
  'create_currency',
  'create_price',
  'exclude_reason',
] as const

export const COMMERCE_ORDER_SUMMARY_CSV_HEADERS = [
  'account_global_id',
  'candidate_global_id',
  'row_version',
  'provider',
  'external_order_id',
  'order_number',
  'state',
  'order_status',
  'payment_status',
  'fulfillment_status',
  'return_status',
  'currency',
  'total',
  'line_count',
  'requires_shipping',
  'blocker_codes',
  'source_updated_at',
  'canonical_order_global_id',
] as const

export const COMMERCE_ISSUE_SUMMARY_CSV_HEADERS = [
  'account_global_id',
  'rejection_global_id',
  'row_version',
  'provider',
  'resource_type',
  'external_id',
  'error_code',
  'safe_message',
] as const

export type CommerceCsvProvider = 'shopify' | 'faire'
export type CommerceProductReviewAction =
  | 'map_existing'
  | 'create'
  | 'exclude'

export type CommerceProductReviewCsvCandidate = {
  globalId: string
  rowVersion: number
  externalProductId: string
  externalVariantId: string
  sku?: string | null
  productTitle: string
  variantTitle?: string | null
  selectedOptions?: ReadonlyArray<{
    name?: string | null
    value?: string | null
  }> | null
  currency?: string | null
  priceMinor?: number | null
  productGlobalId?: string | null
}

export type CommerceOrderSummaryCsvCandidate = {
  globalId: string
  rowVersion: number
  externalOrderId: string
  orderNumber?: string | null
  state: string
  normalizedOrderStatus?: string | null
  normalizedPaymentStatus?: string | null
  normalizedFulfillmentStatus?: string | null
  normalizedReturnStatus?: string | null
  currency?: string | null
  totalMinor?: number | null
  lineCount?: number | null
  requiresShipping: boolean
  blockerCodes?: readonly string[] | null
  sourceUpdatedAt?: string | null
  canonicalOrderGlobalId?: string | null
}

export type CommerceIssueSummaryCsvRow = {
  globalId: string
  rowVersion: number
  resourceType: 'order' | 'product'
  externalId: string
  errorCode: string
  safeMessage: string
}

export type CommerceProductReviewExpectedCandidate = {
  globalId: string
  rowVersion: number
}

type CommerceProductReviewDecisionBase = {
  sourceRowNumber: number
  accountGlobalId: string
  candidateGlobalId: string
  rowVersion: number
}

export type CommerceProductReviewDecision =
  | (CommerceProductReviewDecisionBase & {
      action: 'map_existing'
      productGlobalId: string
    })
  | (CommerceProductReviewDecisionBase & {
      action: 'create'
      name: string
      sku: string | null
      currency: string
      unitPriceMinor: number
    })
  | (CommerceProductReviewDecisionBase & {
      action: 'exclude'
      reason: string
    })

export type CommerceCsvRowError = {
  rowNumber: number
  column?: string
  code: string
  message: string
}

export type CommerceProductReviewImportResult = {
  ok: boolean
  totalRows: number
  skippedRows: number
  decisions: CommerceProductReviewDecision[]
  errors: CommerceCsvRowError[]
}

export class CommerceIntakeCsvError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommerceIntakeCsvError'
    this.code = code
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
const ACCOUNT_GLOBAL_ID_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_CANDIDATE_GLOBAL_ID_PATTERN = /^gcpc(?:[0-9]{7}|[0-9a-v]{12})$/
const ORDER_CANDIDATE_GLOBAL_ID_PATTERN = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/
const REJECTION_GLOBAL_ID_PATTERN = /^gcrj(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_GLOBAL_ID_PATTERN = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const CURRENCY_PATTERN = /^[A-Z]{3}$/
const CONTROL_CHARACTER_PATTERN = /[\p{C}]/u
const SPREADSHEET_FORMULA_PATTERN =
  /^[\u0009\u000a\u000d\u0020]*[=+\-@]/

function stringValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function normalizeCurrency(value: unknown) {
  return stringValue(value).trim().toUpperCase()
}

function currencyExponent(value: unknown) {
  const currency = normalizeCurrency(value)
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_CURRENCY_INVALID',
      'Currency must be a three-letter code',
    )
  }
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3
  if (FOUR_DECIMAL_CURRENCIES.has(currency)) return 4
  return 2
}

function assertSafeMinor(value: number) {
  if (
    !Number.isSafeInteger(value)
    || Math.abs(value) > COMMERCE_INTAKE_CSV_MAX_MONEY_MINOR
  ) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_MONEY_INVALID',
      'Money must use safe integer minor units within the supported range',
    )
  }
}

export function formatCommerceMoneyMajor(
  minor: number,
  currencyValue: string,
) {
  assertSafeMinor(minor)
  const exponent = currencyExponent(currencyValue)
  const negative = minor < 0
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0')
  if (exponent === 0) return `${negative ? '-' : ''}${digits}`
  const whole = digits.slice(0, -exponent)
  const fraction = digits.slice(-exponent)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export function parseCommerceMoneyMajor(
  value: string,
  currencyValue: string,
) {
  const currency = normalizeCurrency(currencyValue)
  const exponent = currencyExponent(currency)
  const input = stringValue(value).trim()
  if (!/^\d+(?:\.\d+)?$/.test(input)) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_MONEY_INVALID',
      'Price must be a non-negative decimal amount without separators',
    )
  }
  const [whole, suppliedFraction = ''] = input.split('.')
  if (suppliedFraction.length > exponent) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_MONEY_PRECISION_INVALID',
      `${currency} accepts at most ${exponent} decimal places`,
    )
  }
  if (exponent === 0 && suppliedFraction.length > 0) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_MONEY_PRECISION_INVALID',
      `${currency} does not accept decimal places`,
    )
  }
  const fraction = suppliedFraction.padEnd(exponent, '0')
  const minorText = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  const minorBigInt = BigInt(minorText || '0')
  if (minorBigInt > BigInt(COMMERCE_INTAKE_CSV_MAX_MONEY_MINOR)) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_MONEY_INVALID',
      'Price exceeds the supported range',
    )
  }
  const minor = Number(minorBigInt)
  assertSafeMinor(minor)
  return minor
}

export function hardenCommerceCsvCell(value: unknown) {
  const text = stringValue(value)
  return SPREADSHEET_FORMULA_PATTERN.test(text) ? `'${text}` : text
}

function csvCell(value: unknown) {
  return `"${hardenCommerceCsvCell(value).replace(/"/g, '""')}"`
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function assertAccountGlobalId(value: string) {
  if (!ACCOUNT_GLOBAL_ID_PATTERN.test(value)) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_ACCOUNT_INVALID',
      'A valid commerce account Global ID is required',
    )
  }
}

function assertRowsWithinLimit(rows: readonly (readonly unknown[])[]) {
  if (rows.length > COMMERCE_INTAKE_CSV_MAX_DATA_ROWS) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_ROW_LIMIT_EXCEEDED',
      `CSV exports are limited to ${COMMERCE_INTAKE_CSV_MAX_DATA_ROWS} data rows`,
    )
  }
}

function buildCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
) {
  assertRowsWithinLimit(rows)
  const csv = [headers, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')
    .concat('\r\n')
  if (utf8Bytes(csv) > COMMERCE_INTAKE_CSV_MAX_BYTES) {
    throw new CommerceIntakeCsvError(
      'COMMERCE_CSV_BYTE_LIMIT_EXCEEDED',
      'CSV exports are limited to 1 MB',
    )
  }
  return csv
}

function validateRowVersion(value: number) {
  return Number.isSafeInteger(value) && value >= 0
}

function exportMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
) {
  if (minor === null || minor === undefined || !currency) return ''
  return formatCommerceMoneyMajor(minor, currency)
}

export function exportCommerceProductReviewCsv(input: {
  accountGlobalId: string
  provider: CommerceCsvProvider
  candidates: readonly CommerceProductReviewCsvCandidate[]
}) {
  assertAccountGlobalId(input.accountGlobalId)
  const rows = input.candidates.map((candidate) => {
    if (
      !PRODUCT_CANDIDATE_GLOBAL_ID_PATTERN.test(candidate.globalId)
      || !validateRowVersion(candidate.rowVersion)
    ) {
      throw new CommerceIntakeCsvError(
        'COMMERCE_CSV_CANDIDATE_INVALID',
        'Product review export contains an invalid candidate identity',
      )
    }
    const currency = normalizeCurrency(candidate.currency)
    const sourcePrice = candidate.priceMinor === null
      || candidate.priceMinor === undefined
      ? ''
      : exportMoney(candidate.priceMinor, currency)
    const createName = commerceProductDisplayName({
      productTitle: candidate.productTitle,
      variantTitle: candidate.variantTitle,
      selectedOptions: candidate.selectedOptions,
    })
    return [
      input.accountGlobalId,
      candidate.globalId,
      candidate.rowVersion,
      input.provider,
      candidate.externalProductId,
      candidate.externalVariantId,
      candidate.sku,
      candidate.productTitle,
      candidate.variantTitle,
      currency,
      sourcePrice,
      '',
      candidate.productGlobalId,
      createName,
      candidate.sku,
      currency,
      sourcePrice,
      '',
    ]
  })
  return buildCsv(COMMERCE_PRODUCT_REVIEW_CSV_HEADERS, rows)
}

export function exportCommerceOrderSummaryCsv(input: {
  accountGlobalId: string
  provider: CommerceCsvProvider
  candidates: readonly CommerceOrderSummaryCsvCandidate[]
}) {
  assertAccountGlobalId(input.accountGlobalId)
  const rows = input.candidates.map((candidate) => {
    if (
      !ORDER_CANDIDATE_GLOBAL_ID_PATTERN.test(candidate.globalId)
      || !validateRowVersion(candidate.rowVersion)
    ) {
      throw new CommerceIntakeCsvError(
        'COMMERCE_CSV_CANDIDATE_INVALID',
        'Order summary export contains an invalid candidate identity',
      )
    }
    const currency = normalizeCurrency(candidate.currency)
    return [
      input.accountGlobalId,
      candidate.globalId,
      candidate.rowVersion,
      input.provider,
      candidate.externalOrderId,
      candidate.orderNumber,
      candidate.state,
      candidate.normalizedOrderStatus,
      candidate.normalizedPaymentStatus,
      candidate.normalizedFulfillmentStatus,
      candidate.normalizedReturnStatus,
      currency,
      exportMoney(candidate.totalMinor, currency),
      candidate.lineCount,
      candidate.requiresShipping ? 'yes' : 'no',
      candidate.blockerCodes?.join('|'),
      candidate.sourceUpdatedAt,
      candidate.canonicalOrderGlobalId,
    ]
  })
  return buildCsv(COMMERCE_ORDER_SUMMARY_CSV_HEADERS, rows)
}

export function exportCommerceIssueSummaryCsv(input: {
  accountGlobalId: string
  provider: CommerceCsvProvider
  issues: readonly CommerceIssueSummaryCsvRow[]
}) {
  assertAccountGlobalId(input.accountGlobalId)
  const rows = input.issues.map((issue) => {
    if (
      !REJECTION_GLOBAL_ID_PATTERN.test(issue.globalId)
      || !validateRowVersion(issue.rowVersion)
    ) {
      throw new CommerceIntakeCsvError(
        'COMMERCE_CSV_REJECTION_INVALID',
        'Issue summary export contains an invalid rejection identity',
      )
    }
    return [
      input.accountGlobalId,
      issue.globalId,
      issue.rowVersion,
      input.provider,
      issue.resourceType,
      issue.externalId,
      issue.errorCode,
      issue.safeMessage,
    ]
  })
  return buildCsv(COMMERCE_ISSUE_SUMMARY_CSV_HEADERS, rows)
}

class CsvSyntaxError extends Error {
  readonly rowNumber: number

  constructor(rowNumber: number, message: string) {
    super(message)
    this.rowNumber = rowNumber
  }
}

function parseCsvRows(value: string) {
  const input = value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let quoteClosed = false
  let physicalRow = 1

  function finishField() {
    row.push(field)
    field = ''
    quoteClosed = false
  }

  function finishRow() {
    finishField()
    rows.push(row)
    row = []
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
          quoteClosed = true
        }
      } else {
        field += character
        if (character === '\n') physicalRow += 1
      }
      continue
    }

    if (quoteClosed) {
      if (character === ',') {
        finishField()
      } else if (character === '\r' || character === '\n') {
        finishRow()
        if (character === '\r' && input[index + 1] === '\n') index += 1
        physicalRow += 1
      } else {
        throw new CsvSyntaxError(
          physicalRow,
          'Unexpected text after a closing quote',
        )
      }
      continue
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new CsvSyntaxError(
          physicalRow,
          'A quoted field must begin with a quote',
        )
      }
      inQuotes = true
    } else if (character === ',') {
      finishField()
    } else if (character === '\r' || character === '\n') {
      finishRow()
      if (character === '\r' && input[index + 1] === '\n') index += 1
      physicalRow += 1
    } else {
      field += character
    }
  }

  if (inQuotes) {
    throw new CsvSyntaxError(
      physicalRow,
      'The final quoted field is not closed',
    )
  }
  if (
    field.length > 0
    || row.length > 0
    || quoteClosed
    || input.endsWith(',')
  ) finishRow()
  return rows
}

function importFailure(
  code: string,
  message: string,
  rowNumber = 0,
  column?: string,
): CommerceProductReviewImportResult {
  return {
    ok: false,
    totalRows: 0,
    skippedRows: 0,
    decisions: [],
    errors: [{ rowNumber, column, code, message }],
  }
}

function headersMatch(actual: readonly string[]) {
  return actual.length === COMMERCE_PRODUCT_REVIEW_CSV_HEADERS.length
    && COMMERCE_PRODUCT_REVIEW_CSV_HEADERS.every((
      header,
      index,
    ) => actual[index] === header)
}

function rowRecord(row: readonly string[]) {
  return Object.fromEntries(
    COMMERCE_PRODUCT_REVIEW_CSV_HEADERS.map((
      header,
      index,
    ) => [header, row[index] ?? '']),
  ) as Record<(typeof COMMERCE_PRODUCT_REVIEW_CSV_HEADERS)[number], string>
}

function readableText(
  value: string,
  minimum: number,
  maximum: number,
) {
  const text = value.trim()
  return text.length >= minimum
    && text.length <= maximum
    && !CONTROL_CHARACTER_PATTERN.test(text)
}

export function parseCommerceProductReviewCsv(input: {
  csv: string
  accountGlobalId: string
  expectedCandidates: readonly CommerceProductReviewExpectedCandidate[]
}): CommerceProductReviewImportResult {
  if (!ACCOUNT_GLOBAL_ID_PATTERN.test(input.accountGlobalId)) {
    return importFailure(
      'COMMERCE_CSV_ACCOUNT_INVALID',
      'A valid commerce account Global ID is required',
    )
  }
  if (utf8Bytes(input.csv) > COMMERCE_INTAKE_CSV_MAX_BYTES) {
    return importFailure(
      'COMMERCE_CSV_BYTE_LIMIT_EXCEEDED',
      'CSV imports are limited to 1 MB',
    )
  }

  let rows: string[][]
  try {
    rows = parseCsvRows(input.csv)
  } catch (error) {
    if (error instanceof CsvSyntaxError) {
      return importFailure(
        'COMMERCE_CSV_MALFORMED',
        error.message,
        error.rowNumber,
      )
    }
    return importFailure(
      'COMMERCE_CSV_MALFORMED',
      'CSV could not be parsed',
    )
  }

  if (rows.length === 0) {
    return importFailure(
      'COMMERCE_CSV_EMPTY',
      'CSV must include the product review header',
    )
  }
  if (!headersMatch(rows[0])) {
    return importFailure(
      'COMMERCE_CSV_HEADERS_INVALID',
      'Product review CSV headers or header order do not match the template',
      1,
    )
  }

  const dataRows = rows.slice(1)
  if (dataRows.length > COMMERCE_INTAKE_CSV_MAX_DATA_ROWS) {
    return importFailure(
      'COMMERCE_CSV_ROW_LIMIT_EXCEEDED',
      `CSV imports are limited to ${COMMERCE_INTAKE_CSV_MAX_DATA_ROWS} data rows`,
    )
  }

  const expected = new Map<string, number>()
  for (const candidate of input.expectedCandidates) {
    if (
      !PRODUCT_CANDIDATE_GLOBAL_ID_PATTERN.test(candidate.globalId)
      || !validateRowVersion(candidate.rowVersion)
      || expected.has(candidate.globalId)
    ) {
      throw new CommerceIntakeCsvError(
        'COMMERCE_CSV_EXPECTED_CANDIDATE_INVALID',
        'Expected product candidate identities must be valid and unique',
      )
    }
    expected.set(candidate.globalId, candidate.rowVersion)
  }

  const decisions: CommerceProductReviewDecision[] = []
  const errors: CommerceCsvRowError[] = []
  const seenCandidates = new Set<string>()
  let skippedRows = 0

  dataRows.forEach((row, dataIndex) => {
    const rowNumber = dataIndex + 2
    const rowErrors: CommerceCsvRowError[] = []
    const addError = (column: string, code: string, message: string) => {
      rowErrors.push({ rowNumber, column, code, message })
    }
    if (row.length !== COMMERCE_PRODUCT_REVIEW_CSV_HEADERS.length) {
      errors.push({
        rowNumber,
        code: 'COMMERCE_CSV_COLUMN_COUNT_INVALID',
        message: `Expected ${COMMERCE_PRODUCT_REVIEW_CSV_HEADERS.length} columns but found ${row.length}`,
      })
      return
    }

    const record = rowRecord(row)
    const accountGlobalId = record.account_global_id.trim()
    const candidateGlobalId = record.candidate_global_id.trim()
    const rowVersionText = record.row_version.trim()
    const action = record.action.trim()

    if (accountGlobalId !== input.accountGlobalId) {
      addError(
        'account_global_id',
        'COMMERCE_CSV_ACCOUNT_MISMATCH',
        'Row belongs to a different commerce account',
      )
    }
    if (!PRODUCT_CANDIDATE_GLOBAL_ID_PATTERN.test(candidateGlobalId)) {
      addError(
        'candidate_global_id',
        'COMMERCE_CSV_CANDIDATE_INVALID',
        'Product candidate Global ID is invalid',
      )
    } else if (!expected.has(candidateGlobalId)) {
      addError(
        'candidate_global_id',
        'COMMERCE_CSV_CANDIDATE_UNKNOWN',
        'Product candidate is not present in the current review set',
      )
    } else if (seenCandidates.has(candidateGlobalId)) {
      addError(
        'candidate_global_id',
        'COMMERCE_CSV_CANDIDATE_DUPLICATE',
        'Product candidate appears more than once in this file',
      )
    } else {
      seenCandidates.add(candidateGlobalId)
    }

    const rowVersion = /^\d+$/.test(rowVersionText)
      ? Number(rowVersionText)
      : Number.NaN
    if (!validateRowVersion(rowVersion)) {
      addError(
        'row_version',
        'COMMERCE_CSV_ROW_VERSION_INVALID',
        'Row version must be a non-negative safe integer',
      )
    } else if (
      expected.has(candidateGlobalId)
      && expected.get(candidateGlobalId) !== rowVersion
    ) {
      addError(
        'row_version',
        'COMMERCE_CSV_ROW_VERSION_STALE',
        'Product candidate changed after this CSV was exported',
      )
    }

    if (action === '') {
      skippedRows += 1
      errors.push(...rowErrors)
      return
    }
    if (
      action !== 'map_existing'
      && action !== 'create'
      && action !== 'exclude'
    ) {
      addError(
        'action',
        'COMMERCE_CSV_ACTION_INVALID',
        'Action must be map_existing, create, exclude, or blank',
      )
      errors.push(...rowErrors)
      return
    }

    if (action === 'map_existing') {
      const productGlobalId = record.existing_product_global_id.trim()
      if (!PRODUCT_GLOBAL_ID_PATTERN.test(productGlobalId)) {
        addError(
          'existing_product_global_id',
          'COMMERCE_CSV_PRODUCT_INVALID',
          'Map existing requires a valid product Global ID',
        )
      }
      if (rowErrors.length === 0) {
        decisions.push({
          sourceRowNumber: rowNumber,
          accountGlobalId,
          candidateGlobalId,
          rowVersion,
          action,
          productGlobalId,
        })
      }
      errors.push(...rowErrors)
      return
    }

    if (action === 'create') {
      const name = record.create_name.trim()
      const sku = record.create_sku.trim()
      const currency = normalizeCurrency(record.create_currency)
      if (!readableText(name, 1, 255)) {
        addError(
          'create_name',
          'COMMERCE_CSV_PRODUCT_NAME_INVALID',
          'Create requires a product name of 1 to 255 readable characters',
        )
      }
      if (sku && !readableText(sku, 1, 25)) {
        addError(
          'create_sku',
          'COMMERCE_CSV_PRODUCT_SKU_INVALID',
          'Create SKU must be 25 readable characters or fewer',
        )
      }
      if (!CURRENCY_PATTERN.test(currency)) {
        addError(
          'create_currency',
          'COMMERCE_CSV_CURRENCY_INVALID',
          'Create requires a three-letter currency',
        )
      }
      let unitPriceMinor: number | null = null
      if (CURRENCY_PATTERN.test(currency)) {
        try {
          unitPriceMinor = parseCommerceMoneyMajor(
            record.create_price,
            currency,
          )
        } catch (error) {
          addError(
            'create_price',
            error instanceof CommerceIntakeCsvError
              ? error.code
              : 'COMMERCE_CSV_MONEY_INVALID',
            error instanceof Error ? error.message : 'Create price is invalid',
          )
        }
      }
      if (rowErrors.length === 0 && unitPriceMinor !== null) {
        decisions.push({
          sourceRowNumber: rowNumber,
          accountGlobalId,
          candidateGlobalId,
          rowVersion,
          action,
          name,
          sku: sku || null,
          currency,
          unitPriceMinor,
        })
      }
      errors.push(...rowErrors)
      return
    }

    const reason = record.exclude_reason.trim()
    if (!readableText(reason, 1, 1_000)) {
      addError(
        'exclude_reason',
        'COMMERCE_CSV_EXCLUSION_REASON_INVALID',
        'Exclude requires a reason of 1 to 1000 readable characters',
      )
    }
    if (rowErrors.length === 0) {
      decisions.push({
        sourceRowNumber: rowNumber,
        accountGlobalId,
        candidateGlobalId,
        rowVersion,
        action,
        reason,
      })
    }
    errors.push(...rowErrors)
  })

  return {
    ok: errors.length === 0,
    totalRows: dataRows.length,
    skippedRows,
    decisions,
    errors,
  }
}
