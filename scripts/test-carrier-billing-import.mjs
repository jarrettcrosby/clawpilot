#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadCarrierBillingImport() {
  const path = 'app_src/lib/operations/carrierBillingImport.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    BigInt,
    Buffer,
    Date,
    Error,
    Map,
    Number,
    Object,
    RegExp,
    Set,
    String,
    Uint8Array,
    console,
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === 'csv-parse/sync') return requireFromApp(specifier)
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

function stringsIn(value, seen = new Set()) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item, seen))
  return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item, seen)])
}

function assertNoPlaintextAccounts(value, accounts) {
  const strings = stringsIn(value)
  for (const account of accounts) {
    assert.ok(
      strings.every((candidate) => !candidate.includes(account)),
      `Parser output exposed raw account ${account}`,
    )
  }
}

const {
  decimalToMinorUnits,
  normalizeCarrierBillingCategory,
  normalizeCarrierBillingCurrency,
  normalizeCarrierBillingDate,
  normalizeCarrierBillingEnvironment,
  normalizeCarrierBillingProvider,
  normalizeCarrierBillingTimestamp,
  parseCarrierBillingCsv,
} = loadCarrierBillingImport()

assert.equal(normalizeCarrierBillingProvider(' United Parcel Service '), 'ups_rest')
assert.equal(normalizeCarrierBillingProvider('Federal Express'), 'fedex_rest')
assert.equal(normalizeCarrierBillingProvider('DHL Express'), 'dhl_express')
assert.equal(normalizeCarrierBillingEnvironment('CIE'), 'sandbox')
assert.equal(normalizeCarrierBillingEnvironment('live'), 'production')
assert.equal(normalizeCarrierBillingCurrency('u.s. dollar'), 'USD')
assert.equal(normalizeCarrierBillingCurrency('€'), 'EUR')
assert.equal(normalizeCarrierBillingDate('07/23/2026'), '2026-07-23')
assert.equal(normalizeCarrierBillingDate('23-Jul-2026'), '2026-07-23')
assert.equal(normalizeCarrierBillingCategory('Fuel Charge'), 'fuel_surcharge')
assert.equal(normalizeCarrierBillingCategory('DAS'), 'delivery_area_surcharge')

assert.equal(decimalToMinorUnits('$1,234.56', 'USD'), 123_456n)
assert.equal(decimalToMinorUnits('1.234,56', 'EUR'), 123_456n)
assert.equal(decimalToMinorUnits("1'234.56", 'USD'), 123_456n)
assert.equal(decimalToMinorUnits('(0.01)', 'USD'), -1n)
assert.equal(decimalToMinorUnits('1234 CR', 'USD'), -123_400n)
assert.equal(decimalToMinorUnits('1.2300', 'USD'), 123n)
assert.equal(decimalToMinorUnits('.50', 'USD'), 50n)
assert.equal(decimalToMinorUnits('1,234', 'JPY'), 1_234n)
assert.equal(decimalToMinorUnits('1,234', 'KWD'), 1_234n)
assert.equal(decimalToMinorUnits('1.2345', 'CLF'), 12_345n)
assert.equal(decimalToMinorUnits('92233720368547758.07', 'USD'), 9_223_372_036_854_775_807n)
assert.throws(
  () => decimalToMinorUnits('1.005', 'USD'),
  /more precision/,
)
assert.throws(
  () => decimalToMinorUnits('1e3', 'USD'),
  /plain decimal/,
)
assert.throws(
  () => decimalToMinorUnits('92233720368547758.08', 'USD'),
  /supported minor-unit range/,
)
assert.throws(
  () => decimalToMinorUnits('(-1.00)', 'USD'),
  /multiple sign indicators/,
)
assert.throws(
  () => normalizeCarrierBillingTimestamp('2026-02-30T10:00:00Z'),
  /valid calendar date/,
)

const primaryAccount = '1234-5678-9012'
const normalizedCsv = [
  '\uFEFFInvoice Number,Billing Account Number,Line Item ID,Tracking #,Charge Type,Net Amount,Currency Code,Ship Date,Invoice Date,Invoice Total,Description',
  `INV-1001,${primaryAccount},LINE-1,1z 999-aa-101,Fuel Surcharge,"$1,234.56",usd,07/22/2026,2026-07-23,"$1,250.00","Fuel for account ${primaryAccount}"`,
].join('\n')
const normalized = parseCarrierBillingCsv(normalizedCsv, {
  provider: ' United Parcel Service ',
  environment: 'CIE',
})

assert.equal(normalized.provider, 'ups_rest')
assert.equal(normalized.environment, 'sandbox')
assert.equal(
  normalized.sourceChecksum,
  createHash('sha256').update(normalizedCsv).digest('hex'),
)
assert.equal(normalized.rowCount, 1)
assert.equal(normalized.importedRowCount, 1)
assert.equal(normalized.rejectedRowCount, 0)
assert.equal(normalized.accounts.length, 1)
assert.equal(normalized.statements.length, 1)
assert.equal(normalized.rows[0].externalStatementId, 'INV-1001')
assert.equal(normalized.rows[0].externalChargeId, 'LINE-1')
assert.equal(normalized.rows[0].billedAccountMaskedReference, '****9012')
assert.match(normalized.rows[0].billedAccountFingerprint, /^[a-f0-9]{64}$/)
assert.match(normalized.rows[0].sourceRowHash, /^[a-f0-9]{64}$/)
assert.equal(normalized.rows[0].trackingNumber, '1Z999AA101')
assert.equal(normalized.rows[0].chargeCategory, 'fuel_surcharge')
assert.equal(normalized.rows[0].amountMinor, 123_456n)
assert.equal(normalized.rows[0].currency, 'USD')
assert.equal(normalized.rows[0].shipmentDate, '2026-07-22')
assert.equal(normalized.rows[0].issuedAt, '2026-07-23T00:00:00.000Z')
assert.equal(normalized.rows[0].statementTotalMinor, 125_000n)
assert.equal(normalized.rows[0].redactedEvidence['Billing Account Number'], '****9012')
assertNoPlaintextAccounts(normalized, [primaryAccount])

const mappedCsv = [
  'Acct Ref,Doc Ref,Entry Ref,Value,ISO,Kind,When',
  'FX-778899,STAT-9,ENTRY-1,"1,234",KWD,Residential Fee,20260723',
].join('\n')
const mapped = parseCarrierBillingCsv({
  csv: mappedCsv,
  provider: 'Federal Express',
  environment: 'LIVE',
  headerMapping: {
    accountNumber: 'Acct Ref',
    externalStatementId: 'Doc Ref',
    externalChargeId: 'Entry Ref',
    amount: 'Value',
    currency: 'ISO',
    chargeCategory: 'Kind',
    shipmentDate: 'When',
  },
})
assert.equal(mapped.provider, 'fedex_rest')
assert.equal(mapped.environment, 'production')
assert.equal(mapped.rows[0].amountMinor, 1_234n)
assert.equal(mapped.rows[0].chargeCategory, 'residential_surcharge')
assert.equal(mapped.rows[0].shipmentDate, '2026-07-23')
assert.equal(mapped.resolvedHeaders.accountNumber, 'Acct Ref')

const multiAccountCsv = [
  'Statement #,Shipper Number,Charge ID,Amount,Currency,Charge Description',
  'INV-MULTI,ACCT-111111,LINE-A,10.00,USD,Transportation charge',
  'INV-MULTI,ACCT-222222,LINE-B,20.00,USD,Transportation charge',
  'INV-MULTI,ACCT-111111,LINE-C,2.50,USD,Fuel surcharge',
].join('\n')
const multiAccount = parseCarrierBillingCsv(multiAccountCsv, {
  provider: 'UPS',
  environment: 'sandbox',
})
assert.equal(multiAccount.accounts.length, 2)
assert.equal(multiAccount.statements.length, 2)
assert.equal(multiAccount.rows.length, 3)
assert.notEqual(
  multiAccount.accounts[0].billedAccountFingerprint,
  multiAccount.accounts[1].billedAccountFingerprint,
)
assert.equal(
  multiAccount.accounts.find((account) => (
    account.billedAccountMaskedReference === '****1111'
  )).chargeCount,
  2,
)
assert.equal(multiAccount.rows[0].lineSequence, 1)
assert.equal(multiAccount.rows[2].lineSequence, 2)
assertNoPlaintextAccounts(multiAccount, ['ACCT-111111', 'ACCT-222222'])

const secondaryAccount = 'PAY-55556666'
const securityCsv = [
  'Account Primary,Payer Account,Invoice Number,Charge ID,Amount,Notes',
  `SAFE-11223344,${secondaryAccount},SEC-1,SEC-LINE,5.00,"Primary SAFE 1122 3344 payer PAY.5555 6666"`,
].join('\n')
const security = parseCarrierBillingCsv(securityCsv, {
  provider: 'USPS REST',
  environment: 'test',
  headerMapping: {
    accountNumber: 'Account Primary',
    externalStatementId: 'Invoice Number',
    externalChargeId: 'Charge ID',
    amount: 'Amount',
    description: 'Notes',
  },
})
assert.equal(security.rows[0].redactedEvidence['Account Primary'], '****3344')
assert.equal(security.rows[0].redactedEvidence['Payer Account'], '****6666')
assertNoPlaintextAccounts(security, ['SAFE-11223344', secondaryAccount])
assertNoPlaintextAccounts(security, ['SAFE 1122 3344', 'PAY.5555 6666'])

const rejectedAccount = 'REJECT-99990000'
const rejectedCsv = [
  'Invoice #,Billing Account,Charge ID,Amount,Currency,Ship Date,Invoice Total',
  'INV-REJECT,REJECT-11112222,GOOD-1,1.00,USD,2026-07-23,10.00',
  `INV-REJECT,${rejectedAccount},BAD-AMOUNT,1.005,USD,2026-07-23,10.00`,
  'INV-REJECT,BAD,BAD-ACCOUNT,1.00,USD,2026-07-23,10.00',
  'INV-REJECT,REJECT-33334444,BAD-DATE,1.00,USD,02/30/2026,10.00',
  'INV-REJECT,REJECT-11112222,GOOD-1,1.00,USD,2026-07-23,10.00',
  'INV-REJECT,REJECT-11112222,GOOD-1,2.00,USD,2026-07-23,10.00',
  'INV-REJECT,REJECT-11112222,CONFLICT,2.00,EUR,2026-07-23,10.00',
].join('\n')
const rejected = parseCarrierBillingCsv(rejectedCsv, {
  provider: 'UPS',
  environment: 'sandbox',
})
assert.equal(rejected.rowCount, 7)
assert.equal(rejected.importedRowCount, 1)
assert.equal(rejected.rejectedRowCount, 6)
assert.equal(rejected.rejectedRows[0].issues[0].code, 'INVALID_AMOUNT')
assert.equal(rejected.rejectedRows[1].issues[0].code, 'INVALID_ACCOUNT')
assert.equal(rejected.rejectedRows[2].issues[0].code, 'INVALID_DATE')
assert.equal(rejected.rejectedRows[3].issues[0].code, 'DUPLICATE_ROW')
assert.equal(rejected.rejectedRows[4].issues[0].code, 'DUPLICATE_CHARGE')
assert.equal(rejected.rejectedRows[5].issues[0].code, 'INCONSISTENT_STATEMENT')
assertNoPlaintextAccounts(rejected, [
  'REJECT-11112222',
  rejectedAccount,
  'REJECT-33334444',
])

assert.throws(
  () => parseCarrierBillingCsv(rejectedCsv, {
    provider: 'UPS',
    environment: 'sandbox',
    failOnRejectedRows: true,
  }),
  /contains 6 rejected row/,
)
assert.throws(
  () => parseCarrierBillingCsv('Invoice Number,Amount\nINV-1,1.00', {
    provider: 'UPS',
    environment: 'sandbox',
  }),
  /missing a required accountNumber header/,
)
assert.throws(
  () => parseCarrierBillingCsv(
    'Account Number,Billing Account,Invoice Number,Amount\n11112222,33334444,INV-1,1.00',
    { provider: 'UPS', environment: 'sandbox' },
  ),
  /multiple candidate headers for accountNumber/,
)
assert.throws(
  () => parseCarrierBillingCsv(
    'Account Number,Invoice Number,Amount\n"11112222,INV-1,1.00',
    { provider: 'UPS', environment: 'sandbox' },
  ),
  /CSV is malformed/,
)
assert.throws(
  () => normalizeCarrierBillingEnvironment('preview'),
  /sandbox or production/,
)

const source = read('app_src/lib/operations/carrierBillingImport.ts')
assert.match(source, /from 'csv-parse\/sync'/)
assert.ok(!source.includes('parseFloat('), 'Carrier billing money must not use parseFloat')

console.log('Carrier billing CSV import tests passed.')
