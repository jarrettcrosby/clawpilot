#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function keyedFingerprint(organizationId, provider, environment, accountNumber) {
  return createHash('sha256')
    .update(`account:${organizationId}:${provider}:${environment}:${accountNumber}`)
    .digest('hex')
}

function unresolvedFingerprint(networkIdentity, provider, environment, accountNumber) {
  return createHash('sha256')
    .update(`unresolved:${networkIdentity}:${provider}:${environment}:${accountNumber}`)
    .digest('hex')
}

function loadPersistence() {
  const path = 'app_src/lib/persistence/carrierBilling.ts'
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
      if (specifier === '@/lib/auditWriter') {
        return { recordAuditEvent() {} }
      }
      if (specifier === '@/lib/integrations/carrierCredentialCrypto') {
        return {
          carrierAccountNumberFingerprint: keyedFingerprint,
          normalizeDirectCarrierProvider(value) {
            return String(value)
          },
          unresolvedCarrierBillingAccountFingerprint: unresolvedFingerprint,
        }
      }
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return { isIntegrationCredentialRuntimeGateError: () => false }
      }
      if (specifier === '@/lib/operations/carrierBillingImport') {
        class CarrierBillingImportError extends Error {}
        return {
          CarrierBillingImportError,
          normalizeCarrierBillingCurrency(value) {
            return String(value).toUpperCase()
          },
          normalizeCarrierBillingEnvironment(value) {
            return String(value)
          },
          normalizeCarrierBillingProvider(value) {
            return String(value)
          },
          parseCarrierBillingCsv() {
            throw new Error('Parser should not run in account resolution tests')
          },
        }
      }
      if (specifier === '@/lib/persistence/postgres') {
        return {
          acquireTransactionAdvisoryLock() {},
          withTransaction() {
            throw new Error('Database should not run in account resolution tests')
          },
        }
      }
      throw new Error(`Unexpected dependency ${specifier}`)
    },
  }, { filename: path })
  return module.exports
}

function candidate({
  organizationId,
  authorizationGlobalId,
  carrierAccountGlobalId,
  accountLastFour,
  accountNumber,
}) {
  return {
    authorizationId: `${authorizationGlobalId}-uuid`,
    authorizationGlobalId,
    accountOwnerOrganizationId: organizationId,
    accountOwnerOrganizationReference: `org-${organizationId}`,
    accountOwnerOrganizationName: `Organization ${organizationId}`,
    integrationAccountId: `integration-${organizationId}`,
    integrationAccountGlobalId: 'gxi1234567',
    integrationAccountName: 'UPS billing',
    carrierAccountId: `account-${organizationId}`,
    carrierAccountGlobalId,
    carrierAccountName: `Carrier account ${accountLastFour}`,
    accountNumberLastFour: accountLastFour,
    accountNumberFingerprint: keyedFingerprint(
      organizationId,
      'ups_rest',
      'production',
      accountNumber,
    ),
    provider: 'ups_rest',
    environment: 'production',
  }
}

function stringsIn(value, seen = new Set()) {
  if (typeof value === 'string') return [value]
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item, seen))
  return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item, seen)])
}

function assertNoRawAccount(value, rawAccount) {
  assert.ok(
    stringsIn(value).every((entry) => !entry.includes(rawAccount)),
    'Account resolution exposed the raw carrier account number',
  )
}

const { resolveCarrierBillingAccount } = loadPersistence()
const networkIdentity = 'grn1234567'
const rawAccount = 'ACCT-1234-5678'
const first = candidate({
  organizationId: '11111111-1111-4111-8111-111111111111',
  authorizationGlobalId: 'gra1234567',
  carrierAccountGlobalId: 'gac1234567',
  accountLastFour: '5678',
  accountNumber: rawAccount,
})

const matched = resolveCarrierBillingAccount({
  networkIdentity,
  provider: 'ups_rest',
  environment: 'production',
  rawAccountNumber: rawAccount,
  candidates: [first],
})
assert.equal(matched.decision, 'matched')
assert.equal(matched.fingerprint, first.accountNumberFingerprint)
assert.equal(matched.matchedCandidate.carrierAccountGlobalId, 'gac1234567')
assert.deepEqual(
  Array.from(matched.candidateSnapshot, (entry) => entry.maskedAccountReference),
  ['****5678'],
)
assertNoRawAccount(matched.candidateSnapshot, rawAccount)

const unmatched = resolveCarrierBillingAccount({
  networkIdentity,
  provider: 'ups_rest',
  environment: 'production',
  rawAccountNumber: rawAccount,
  candidates: [],
})
assert.equal(unmatched.decision, 'unmatched')
assert.equal(unmatched.matchedCandidate, null)
assert.equal(
  unmatched.fingerprint,
  unresolvedFingerprint(networkIdentity, 'ups_rest', 'production', rawAccount),
)
assert.notEqual(unmatched.fingerprint, first.accountNumberFingerprint)
assert.deepEqual(Array.from(unmatched.candidateSnapshot), [])
assertNoRawAccount(unmatched, rawAccount)

const second = candidate({
  organizationId: '22222222-2222-4222-8222-222222222222',
  authorizationGlobalId: 'gra7654321',
  carrierAccountGlobalId: 'gac7654321',
  accountLastFour: '5678',
  accountNumber: rawAccount,
})
const ambiguous = resolveCarrierBillingAccount({
  networkIdentity,
  provider: 'ups_rest',
  environment: 'production',
  rawAccountNumber: rawAccount,
  candidates: [first, second],
})
assert.equal(ambiguous.decision, 'ambiguous')
assert.equal(ambiguous.matchedCandidate, null)
assert.equal(ambiguous.candidateSnapshot.length, 2)
assert.equal(
  ambiguous.fingerprint,
  unresolvedFingerprint(networkIdentity, 'ups_rest', 'production', rawAccount),
)
assertNoRawAccount(ambiguous, rawAccount)

const persistenceSource = read('app_src/lib/persistence/carrierBilling.ts')
assert.match(persistenceSource, /authorization\.status = 'active'/)
assert.match(persistenceSource, /carrier_account\.status = 'active'/)
assert.match(persistenceSource, /integration\.status = 'active'/)
assert.match(persistenceSource, /integration\.provider = \$2/)
assert.match(persistenceSource, /integration\.environment = \$3/)
assert.match(persistenceSource, /NOT EXISTS \(\s*SELECT 1[\s\S]*supersedes_authorization_id/)
assert.match(persistenceSource, /operations_carrier_billing_import_rows/)
assert.match(persistenceSource, /redactedEvidence/)
assert.match(
  persistenceSource,
  /carrier-billing-\$\{parsed\.sourceChecksum\.slice\(0, 12\)\}\.csv/,
)
assert.doesNotMatch(
  persistenceSource,
  /source_filename[\s\S]{0,120}input\.sourceFilename/,
)
assert.match(persistenceSource, /recordAuditEvent/)
assert.match(persistenceSource, /source_checksum = \$4/)
assert.doesNotMatch(persistenceSource, /account_number_ciphertext/)

const routeSource = read(
  'app_src/app/api/operations/carrier-billing/import/route.ts',
)
assert.ok(routeSource.includes('multipart\\/form-data'))
assert.match(routeSource, /MAX_CARRIER_BILLING_CSV_BYTES/)
assert.match(routeSource, /requireRequestUser\(req\)/)
assert.match(routeSource, /activeOperationsOrganizationId\(actor\)/)
assert.match(routeSource, /canReconcileCarrierBilling/)
assert.match(routeSource, /result\.duplicate \? 200 : 201/)

console.log('Carrier billing persistence and API contract tests passed.')
