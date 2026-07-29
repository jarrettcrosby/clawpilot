import assert from 'node:assert/strict'
import test from 'node:test'
const transferModulePath = '../../lib/crm/dataTransferCsv.ts'
const {
  buildCrmDataTransferCsv,
  buildCrmDataTransferCsvSegments,
  CRM_DATA_TRANSFER_MAX_BYTES,
  crmDataTransferFieldDiffs,
  crmDataTransferNaturalKey,
  crmProductUniquenessConflicts,
  crmProductUniquenessKeys,
  CrmDataTransferCsvError,
  hardenCrmCsvCell,
  parseCrmDataTransferCsv,
} = await import(transferModulePath)

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
}

const organizationRow = {
  schema_version: '1',
  global_id: 'ga1234567',
  record_version: 'revision-1',
  name: 'Acme, Inc.',
  account_type: 'Customer',
  priority: 'A',
  account_manager: 'Owner',
  website: 'https://example.com',
  linkedin_url: '',
  phone: '',
  email: 'hello@example.com',
  email_opt_out: 'no',
  address: '1 Main Street',
  city: 'Hartford',
  state: 'CT',
  postal_code: '06103',
  country: 'US',
  description: 'Line one\nLine two',
}

test('CRM transfer CSV round-trips exact headers, commas, quotes, BOM, and multiline fields', () => {
  const csv = buildCrmDataTransferCsv({
    entity: 'organizations',
    rows: [organizationRow],
  })
  const parsed = parseCrmDataTransferCsv({
    entity: 'organizations',
    csv: `\uFEFF${csv}`,
  })
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].globalId, 'ga1234567')
  assert.equal(parsed[0].fields.name, 'Acme, Inc.')
  assert.equal(parsed[0].fields.description, 'Line one\nLine two')
  assert.deepEqual(parsed[0].errors, [])
})

test('CRM transfer export hardens spreadsheet formulas and import rejects formula-capable cells after whitespace', () => {
  assert.equal(hardenCrmCsvCell('  =HYPERLINK("x")'), '\'  =HYPERLINK("x")')
  const csv = buildCrmDataTransferCsv({
    entity: 'organizations',
    rows: [{
      ...organizationRow,
      global_id: '',
      record_version: '',
      description: ' \t@SUM(1,1)',
    }],
  })
  const safe = parseCrmDataTransferCsv({ entity: 'organizations', csv })
  assert.equal(safe[0].fields.description, '@SUM(1,1)')
  assert.equal(safe[0].errors.some((error: { code: string }) => (
    error.code === 'CRM_CSV_FORMULA_INVALID'
  )), false)
  const parsed = parseCrmDataTransferCsv({
    entity: 'organizations',
    csv: csv.replace("' \t@SUM(1,1)", ' \t@SUM(1,1)'),
  })
  assert.equal(parsed[0].errors.some((error: { code: string }) => (
    error.code === 'CRM_CSV_FORMULA_INVALID'
  )), true)
})

test('CRM transfer parser requires exact headers and bounded files', () => {
  assert.throws(
    () => parseCrmDataTransferCsv({
      entity: 'organizations',
      csv: '"schema_version","global_id"\r\n"1",""\r\n',
    }),
    (error) => error instanceof CrmDataTransferCsvError
      && errorCode(error) === 'CRM_CSV_HEADERS_INVALID',
  )
  assert.throws(
    () => parseCrmDataTransferCsv({
      entity: 'organizations',
      csv: 'x'.repeat(CRM_DATA_TRANSFER_MAX_BYTES + 1),
    }),
    (error) => error instanceof CrmDataTransferCsvError
      && errorCode(error) === 'CRM_CSV_BYTE_LIMIT_EXCEEDED',
  )
})

test('CRM transfer export segments large catalogs into import-safe CSV files', () => {
  const rowBoundSegments = buildCrmDataTransferCsvSegments({
    entity: 'organizations',
    rows: Array.from({ length: 501 }, (_, index) => ({
      ...organizationRow,
      global_id: '',
      record_version: '',
      name: `Organization ${index + 1}`,
    })),
  })
  assert.equal(rowBoundSegments.length, 2)
  assert.equal(
    rowBoundSegments.reduce((total, csv) => (
      total + parseCrmDataTransferCsv({ entity: 'organizations', csv }).length
    ), 0),
    501,
  )

  const byteBoundSegments = buildCrmDataTransferCsvSegments({
    entity: 'organizations',
    rows: Array.from({ length: 120 }, (_, index) => ({
      ...organizationRow,
      global_id: '',
      record_version: '',
      name: `Large Organization ${index + 1}`,
      description: `segment-${index}-${'x'.repeat(9_900)}`,
    })),
  })
  assert.equal(byteBoundSegments.length, 2)
  for (const csv of byteBoundSegments) {
    assert.ok(new TextEncoder().encode(csv).byteLength <= CRM_DATA_TRANSFER_MAX_BYTES)
    assert.ok(parseCrmDataTransferCsv({
      entity: 'organizations',
      csv,
    }).length <= 500)
  }
})

test('CRM transfer parser enforces Global ID revision and relationship boundaries', () => {
  const csv = buildCrmDataTransferCsv({
    entity: 'contacts',
    rows: [{
      schema_version: '1',
      global_id: 'gc1234567',
      record_version: '',
      organization_global_id: 'ga7654321',
      full_name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      priority: '',
      contact_type: '',
      account_manager: '',
      job_title: '',
      email: 'ada@example.com',
      linkedin_url: '',
      phone_work: '',
      phone_mobile: '',
      address: '',
      city: '',
      state: '',
      postal_code: '',
      country: '',
      description: '',
      email_opt_out: 'no',
    }],
  })
  const parsed = parseCrmDataTransferCsv({ entity: 'contacts', csv })
  assert.equal(parsed[0].errors.some((error: { code: string }) => (
    error.code === 'CRM_CSV_RECORD_VERSION_REQUIRED'
  )), true)
  assert.equal(parsed[0].fields.organizationGlobalId, 'ga7654321')
})

test('CRM transfer field diffs and natural keys are canonical and field-specific', () => {
  const diffs = crmDataTransferFieldDiffs(
    { ...organizationRow, description: 'Before' },
    { ...organizationRow, description: 'After' },
    'organizations',
  )
  assert.deepEqual(diffs, [{
    field: 'description',
    before: 'Before',
    after: 'After',
  }])
  assert.equal(
    crmDataTransferNaturalKey('contacts', {
      fullName: 'Ada Lovelace',
      email: ' ADA@EXAMPLE.COM ',
      organizationGlobalId: 'ga1234567',
    }),
    'email:ada@example.com',
  )
  assert.equal(
    crmDataTransferNaturalKey('products', {
      name: 'Widget',
      sku: ' SKU-1 ',
    }),
    'sku:sku-1',
  )
})

test('CRM Product uniqueness follows the database name and nonblank SKU constraints', () => {
  assert.deepEqual(
    crmProductUniquenessKeys({ name: '  Case Pack  ', sku: ' SKU-1 ' }),
    { name: 'case pack', sku: 'sku-1' },
  )
  assert.deepEqual(
    crmProductUniquenessConflicts({
      candidate: {
        identity: 'row:2',
        fields: { name: 'Case Pack', sku: 'SKU-2' },
      },
      others: [
        {
          identity: 'record:one',
          fields: { name: 'case pack', sku: 'SKU-1' },
        },
        {
          identity: 'row:3',
          fields: { name: 'Different', sku: 'sku-2' },
        },
        {
          identity: 'row:4',
          fields: { name: 'No SKU', sku: '' },
        },
      ],
    }).map((conflict: { field: string }) => conflict.field).sort(),
    ['name', 'sku'],
  )
  assert.deepEqual(
    crmProductUniquenessConflicts({
      candidate: {
        identity: 'row:2',
        fields: { name: 'No SKU A', sku: '' },
      },
      others: [{
        identity: 'row:3',
        fields: { name: 'No SKU B', sku: '' },
      }],
    }),
    [],
  )
})

test('CRM create rows cannot supply caller-created Global IDs or stale relationship formats', () => {
  const csv = buildCrmDataTransferCsv({
    entity: 'opportunities',
    rows: [{
      schema_version: '1',
      global_id: 'go1234567',
      record_version: 'revision',
      organization_global_id: 'ga1234567',
      contact_global_ids: 'gc1234567|not-a-contact',
      owner_contact_global_id: '',
      product_global_ids: 'gp1234567',
      name: 'Expansion',
      priority: '',
      owner: '',
      status: 'Open',
      stage: 'Qualified',
      loss_reason: '',
      source: '',
      value: '100.00',
      probability: '25',
      expected_close: '2026-08-01',
      notes: '',
    }],
  })
  const parsed = parseCrmDataTransferCsv({ entity: 'opportunities', csv })
  assert.equal(parsed[0].errors.some((error: { code: string }) => (
    error.code === 'CRM_CSV_RELATIONSHIP_INVALID'
  )), true)
})
