import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as commerceIntakeCsv from '../../lib/integrations/commerceIntakeCsv.ts'

const {
  COMMERCE_INTAKE_CSV_MAX_BYTES,
  COMMERCE_INTAKE_CSV_MAX_DATA_ROWS,
  COMMERCE_PRODUCT_REVIEW_CSV_HEADERS,
  exportCommerceIssueSummaryCsv,
  exportCommerceOrderSummaryCsv,
  exportCommerceProductReviewCsv,
  formatCommerceMoneyMajor,
  hardenCommerceCsvCell,
  parseCommerceMoneyMajor,
  parseCommerceProductReviewCsv,
} = commerceIntakeCsv

const accountGlobalId = 'gia0000001'

function csvRow(values: readonly unknown[]) {
  return values
    .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
    .join(',')
}

function reviewCsv(rows: readonly (readonly unknown[])[]) {
  return [
    csvRow(COMMERCE_PRODUCT_REVIEW_CSV_HEADERS),
    ...rows.map(csvRow),
    '',
  ].join('\r\n')
}

function productRow(input: {
  candidateGlobalId: string
  rowVersion?: number
  action?: string
  existingProductGlobalId?: string
  createName?: string
  createSku?: string
  createCurrency?: string
  createPrice?: string
  excludeReason?: string
  rowAccountGlobalId?: string
}) {
  return [
    input.rowAccountGlobalId ?? accountGlobalId,
    input.candidateGlobalId,
    input.rowVersion ?? 0,
    'faire',
    `provider-product-${input.candidateGlobalId}`,
    `provider-variant-${input.candidateGlobalId}`,
    'SKU-1',
    'Alchemy Bar',
    'Original',
    'USD',
    '4.97',
    input.action ?? '',
    input.existingProductGlobalId ?? '',
    input.createName ?? 'Alchemy Bar · Original',
    input.createSku ?? 'SKU-1',
    input.createCurrency ?? 'USD',
    input.createPrice ?? '4.97',
    input.excludeReason ?? '',
  ]
}

test('product review export is RFC 4180 safe and spreadsheet hardened', () => {
  const csv = exportCommerceProductReviewCsv({
    accountGlobalId,
    provider: 'faire',
    candidates: [{
      globalId: 'gcpc0000001',
      rowVersion: 4,
      externalProductId: 'provider-product-1',
      externalVariantId: 'provider-variant-1',
      sku: '+DANGEROUS',
      productTitle: '=SUM(1,2)\r\n"Wholesale"',
      variantTitle: '@Original',
      currency: 'USD',
      priceMinor: 497,
    }],
  })

  assert.match(csv, /\r\n/)
  assert.match(csv, /"'\+DANGEROUS"/)
  assert.match(csv, /"'=SUM\(1,2\)\r\n""Wholesale"""/)
  assert.match(csv, /"'@Original"/)
  assert.match(csv, /"4\.97"/)
  assert.equal(csv.endsWith('\r\n'), true)
})

test('product review import returns typed map, create, and exclude decisions', () => {
  const parsed = parseCommerceProductReviewCsv({
    csv: reviewCsv([
      productRow({
        candidateGlobalId: 'gcpc0000001',
        rowVersion: 2,
        action: 'map_existing',
        existingProductGlobalId: 'gp0000001',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000002',
        rowVersion: 3,
        action: 'create',
        createName: 'New Alchemy Bar',
        createSku: 'NEW-1',
        createCurrency: 'USD',
        createPrice: '4.97',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000003',
        rowVersion: 1,
        action: 'exclude',
        excludeReason: 'Provider variant is not sold through this operation.',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000004',
        rowVersion: 0,
      }),
    ]),
    accountGlobalId,
    expectedCandidates: [
      { globalId: 'gcpc0000001', rowVersion: 2 },
      { globalId: 'gcpc0000002', rowVersion: 3 },
      { globalId: 'gcpc0000003', rowVersion: 1 },
      { globalId: 'gcpc0000004', rowVersion: 0 },
    ],
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.totalRows, 4)
  assert.equal(parsed.skippedRows, 1)
  assert.deepEqual(parsed.decisions, [
    {
      sourceRowNumber: 2,
      accountGlobalId,
      candidateGlobalId: 'gcpc0000001',
      rowVersion: 2,
      action: 'map_existing',
      productGlobalId: 'gp0000001',
    },
    {
      sourceRowNumber: 3,
      accountGlobalId,
      candidateGlobalId: 'gcpc0000002',
      rowVersion: 3,
      action: 'create',
      name: 'New Alchemy Bar',
      sku: 'NEW-1',
      currency: 'USD',
      unitPriceMinor: 497,
    },
    {
      sourceRowNumber: 4,
      accountGlobalId,
      candidateGlobalId: 'gcpc0000003',
      rowVersion: 1,
      action: 'exclude',
      reason: 'Provider variant is not sold through this operation.',
    },
  ])
})

test('product review import reports identity, version, action, and money errors by row', () => {
  const parsed = parseCommerceProductReviewCsv({
    csv: reviewCsv([
      productRow({
        candidateGlobalId: 'gcpc0000001',
        rowVersion: 1,
        action: 'map_existing',
        existingProductGlobalId: 'not-a-product',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000002',
        rowVersion: 0,
        action: 'create',
        createPrice: '4.999',
        rowAccountGlobalId: 'gia0000002',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000003',
        action: 'delete',
      }),
      productRow({
        candidateGlobalId: 'gcpc0000001',
        rowVersion: 2,
        action: 'exclude',
      }),
    ]),
    accountGlobalId,
    expectedCandidates: [
      { globalId: 'gcpc0000001', rowVersion: 2 },
      { globalId: 'gcpc0000002', rowVersion: 0 },
    ],
  })

  assert.equal(parsed.ok, false)
  assert.equal(parsed.decisions.length, 0)
  assert.deepEqual(
    parsed.errors.map((error) => [error.rowNumber, error.column, error.code]),
    [
      [2, 'row_version', 'COMMERCE_CSV_ROW_VERSION_STALE'],
      [2, 'existing_product_global_id', 'COMMERCE_CSV_PRODUCT_INVALID'],
      [3, 'account_global_id', 'COMMERCE_CSV_ACCOUNT_MISMATCH'],
      [3, 'create_price', 'COMMERCE_CSV_MONEY_PRECISION_INVALID'],
      [4, 'candidate_global_id', 'COMMERCE_CSV_CANDIDATE_UNKNOWN'],
      [4, 'action', 'COMMERCE_CSV_ACTION_INVALID'],
      [5, 'candidate_global_id', 'COMMERCE_CSV_CANDIDATE_DUPLICATE'],
      [5, 'exclude_reason', 'COMMERCE_CSV_EXCLUSION_REASON_INVALID'],
    ],
  )
})

test('product review import requires exact headers', () => {
  const headers: string[] = [...COMMERCE_PRODUCT_REVIEW_CSV_HEADERS]
  headers[0] = 'organization_id'
  const parsed = parseCommerceProductReviewCsv({
    csv: `${csvRow(headers)}\r\n`,
    accountGlobalId,
    expectedCandidates: [],
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors[0]?.code, 'COMMERCE_CSV_HEADERS_INVALID')
})

test('CSV input enforces byte and data-row limits', () => {
  const tooManyRows = Array.from(
    { length: COMMERCE_INTAKE_CSV_MAX_DATA_ROWS + 1 },
    (_, index) => productRow({
      candidateGlobalId: `gcpc${String(index).padStart(7, '0')}`,
    }),
  )
  const rowLimited = parseCommerceProductReviewCsv({
    csv: reviewCsv(tooManyRows),
    accountGlobalId,
    expectedCandidates: [],
  })
  assert.equal(
    rowLimited.errors[0]?.code,
    'COMMERCE_CSV_ROW_LIMIT_EXCEEDED',
  )

  const byteLimited = parseCommerceProductReviewCsv({
    csv: 'x'.repeat(COMMERCE_INTAKE_CSV_MAX_BYTES + 1),
    accountGlobalId,
    expectedCandidates: [],
  })
  assert.equal(
    byteLimited.errors[0]?.code,
    'COMMERCE_CSV_BYTE_LIMIT_EXCEEDED',
  )
})

test('CSV exports enforce byte and data-row limits', () => {
  const candidate = (index: number, title = 'Alchemy Bar') => ({
    globalId: `gcpc${String(index).padStart(7, '0')}`,
    rowVersion: 0,
    externalProductId: `provider-product-${index}`,
    externalVariantId: `provider-variant-${index}`,
    productTitle: title,
    currency: 'USD',
    priceMinor: 497,
  })
  assert.throws(
    () => exportCommerceProductReviewCsv({
      accountGlobalId,
      provider: 'faire',
      candidates: Array.from(
        { length: COMMERCE_INTAKE_CSV_MAX_DATA_ROWS + 1 },
        (_, index) => candidate(index),
      ),
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'COMMERCE_CSV_ROW_LIMIT_EXCEEDED'
    ),
  )
  assert.throws(
    () => exportCommerceProductReviewCsv({
      accountGlobalId,
      provider: 'faire',
      candidates: [candidate(1, 'x'.repeat(COMMERCE_INTAKE_CSV_MAX_BYTES))],
    }),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'COMMERCE_CSV_BYTE_LIMIT_EXCEEDED'
    ),
  )
})

test('money conversion is exact for ISO currency exponents', () => {
  assert.equal(formatCommerceMoneyMajor(497, 'USD'), '4.97')
  assert.equal(parseCommerceMoneyMajor('4.97', 'USD'), 497)
  assert.equal(formatCommerceMoneyMajor(4971, 'KWD'), '4.971')
  assert.equal(parseCommerceMoneyMajor('4.971', 'KWD'), 4971)
  assert.equal(formatCommerceMoneyMajor(497, 'JPY'), '497')
  assert.equal(parseCommerceMoneyMajor('497', 'JPY'), 497)
  assert.throws(
    () => parseCommerceMoneyMajor('4.971', 'USD'),
    (error: unknown) => (
      error instanceof Error
      && 'code' in error
      && error.code === 'COMMERCE_CSV_MONEY_PRECISION_INVALID'
    ),
  )
})

test('read-only order and issue exports omit PII, tokens, and raw evidence', () => {
  const order = {
    globalId: 'gcoc0000001',
    rowVersion: 2,
    externalOrderId: 'provider-order-1',
    orderNumber: '1001',
    state: 'held',
    normalizedOrderStatus: 'open',
    normalizedPaymentStatus: 'paid',
    normalizedFulfillmentStatus: 'unfulfilled',
    normalizedReturnStatus: 'none',
    currency: 'USD',
    totalMinor: 1005,
    lineCount: 2,
    requiresShipping: true,
    blockerCodes: ['COMMERCE_ORDER_PRODUCT_UNRESOLVED'],
    sourceUpdatedAt: '2026-07-27T12:00:00.000Z',
    canonicalOrderGlobalId: null,
    snapshotEmail: 'customer@example.test',
    address: '10 Customer Street',
    providerToken: 'provider-secret-token',
  }
  const issue = {
    globalId: 'gcrj0000001',
    rowVersion: 1,
    resourceType: 'product' as const,
    externalId: '=provider-product-1',
    errorCode: 'COMMERCE_PRODUCT_MONEY_INCOMPLETE',
    safeMessage: '+Correct the source price and fetch product changes.',
    sourceHash: 'raw-source-evidence',
    providerToken: 'provider-secret-token',
  }

  const orderCsv = exportCommerceOrderSummaryCsv({
    accountGlobalId,
    provider: 'faire',
    candidates: [order],
  })
  const issueCsv = exportCommerceIssueSummaryCsv({
    accountGlobalId,
    provider: 'faire',
    issues: [issue],
  })

  for (const csv of [orderCsv, issueCsv]) {
    assert.doesNotMatch(csv, /customer@example\.test/)
    assert.doesNotMatch(csv, /Customer Street/)
    assert.doesNotMatch(csv, /provider-secret-token/)
    assert.doesNotMatch(csv, /raw-source-evidence/)
  }
  assert.match(orderCsv, /"10\.05"/)
  assert.match(issueCsv, /"'=provider-product-1"/)
  assert.match(issueCsv, /"'\+Correct the source price/)
})

test('cell hardening catches formula prefixes after spaces and tabs', () => {
  assert.equal(hardenCommerceCsvCell('=1+1'), "'=1+1")
  assert.equal(hardenCommerceCsvCell('  -2+3'), "'  -2+3")
  assert.equal(hardenCommerceCsvCell('\t@cmd'), "'\t@cmd")
  assert.equal(hardenCommerceCsvCell('\n=cmd'), "'\n=cmd")
  assert.equal(hardenCommerceCsvCell('ordinary text'), 'ordinary text')
})
