#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

class OperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'OperationsRequestError'
    this.code = code
    this.status = status
  }
}

let transactionClient = null
let auditEvents = []

function loadPersistenceModule() {
  const path = 'app_src/lib/persistence/carrierRateTestLabels.ts'
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  const sandbox = {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === '@/lib/auditWriter') {
        return {
          recordAuditEvent: async (event, client) => {
            assert.equal(client, transactionClient)
            auditEvents.push(event)
          },
        }
      }
      if (specifier === '@/lib/persistence/operationPrintDelivery') {
        return {
          enqueueOperationsPrintJobInPostgres: async () => {
            throw new Error('Print delivery is outside this sample-close test')
          },
        }
      }
      if (specifier === '@/lib/persistence/operations') {
        return { OperationsRequestError }
      }
      if (specifier === '@/lib/persistence/postgres') {
        return {
          acquireTransactionAdvisoryLock: async (client) => {
            assert.equal(client, transactionClient)
          },
          query: async () => {
            throw new Error('Sample close must stay inside its transaction')
          },
          withTransaction: async (callback) => callback(transactionClient),
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const {
  closeCarrierRateTestSampleLabelInPostgres,
} = loadPersistenceModule()

const ids = {
  organization: '11111111-1111-4111-8111-111111111111',
  label: '22222222-2222-4222-8222-222222222222',
  rate: '33333333-3333-4333-8333-333333333333',
  integration: '44444444-4444-4444-8444-444444444444',
  carrierAccount: '55555555-5555-4555-8555-555555555555',
  attempt: '66666666-6666-4666-8666-666666666666',
}
const requestHash = 'a'.repeat(64)
const input = {
  organizationId: ids.organization,
  actorEmail: 'admin@example.com',
  label: {
    labelId: ids.label,
    labelGlobalId: 'gsl2538502',
    rateRequestId: ids.rate,
    rateEvidenceGlobalId: 'grq1234567',
    integrationAccountId: ids.integration,
    integrationGlobalId: 'gint1234567',
    carrierAccountId: ids.carrierAccount,
    carrierAccountGlobalId: 'gca1234567',
    provider: 'ups_rest',
    credentialVersion: 1,
    accountNumberFingerprint: 'b'.repeat(64),
    rateRequestHash: 'c'.repeat(64),
    destinationFingerprint: 'd'.repeat(64),
    serviceCode: '03',
    serviceName: 'UPS Ground',
    rateType: 'NEGOTIATED',
    ratedAmount: '19.62',
    ratedCurrency: 'USD',
    providerLabelId: '1ZXXXXXXXXXXXXXXXX',
    trackingNumber: '1ZXXXXXXXXXXXXXXXX',
    status: 'created',
    createRequest: {},
  },
  reason: 'Close the provider-declared CIE sample after print review.',
  idempotencyKey: 'carrier-rate-test:void:sample-close-1',
  attemptRequestHash: requestHash,
  adapterVersion: 'direct-rest-sandbox-v3',
}

function browserLabelRow() {
  return {
    global_id: input.label.labelGlobalId,
    rate_evidence_global_id: input.label.rateEvidenceGlobalId,
    create_attempt_global_id: 'gsa1234567',
    void_attempt_global_id: 'gsa7654321',
    carrier_account_global_id: input.label.carrierAccountGlobalId,
    provider: 'ups_rest',
    environment: 'sandbox',
    credential_version: 1,
    service_code: '03',
    service_name: 'UPS Ground',
    rate_type: 'NEGOTIATED',
    rated_amount: '19.62',
    rated_currency: 'USD',
    tracking_number: '1ZXXXXXXXXXXXXXXXX',
    format: 'ZPL',
    media_size: 'label_4x6',
    source_kind: 'provider_native',
    provider_image_type: 'ZPL',
    provider_stock_type: 'HEIGHT_6_WIDTH_4',
    byte_length: '3424',
    content_sha256: 'e'.repeat(64),
    print_artifact_global_id: 'gpf4019061',
    status: 'voided',
    created_by: input.actorEmail,
    created_at: new Date('2026-07-27T16:00:00.000Z'),
    voided_by: input.actorEmail,
    voided_at: new Date('2026-07-27T18:00:00.000Z'),
  }
}

function createClient(mode = 'success') {
  const calls = []
  const client = {
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters })
      if (sql.includes('SELECT label_id::text, request_hash')) {
        if (mode === 'replay') {
          return {
            rows: [{
              label_id: ids.label,
              request_hash: requestHash,
              reconciliation_outcome: 'confirmed_no_active_label',
            }],
          }
        }
        if (mode === 'reused-key') {
          return {
            rows: [{
              label_id: ids.label,
              request_hash: 'f'.repeat(64),
              reconciliation_outcome: 'confirmed_no_active_label',
            }],
          }
        }
        return { rows: [] }
      }
      if (sql.includes('SELECT status, provider, environment')) {
        assert.match(sql, /organization_id = \$1::uuid/)
        assert.equal(parameters[0], ids.organization)
        if (mode === 'missing') return { rows: [] }
        return {
          rows: [{
            status: 'created',
            provider: 'ups_rest',
            environment: 'sandbox',
            tracking_number: mode === 'non-sample'
              ? '1ZSHIPMENT00000001'
              : '1ZXXXXXXXXXXXXXXXX',
            provider_label_id: mode === 'non-sample'
              ? '1ZSHIPMENT00000001'
              : '1ZXXXXXXXXXXXXXXXX',
          }],
        }
      }
      if (sql.includes('INSERT INTO operations_carrier_rate_test_label_attempts')) {
        assert.match(sql, /'void', 'failed', 'ups_rest', 'sandbox'/)
        assert.match(sql, /'confirmed_no_active_label'/)
        assert.equal(parameters.length, 18)
        assert.equal(parameters[0], ids.organization)
        assert.equal(parameters[4], ids.label)
        assert.equal(parameters[13], requestHash)
        assert.equal(parameters[17], input.actorEmail)
        assert.deepEqual(
          JSON.parse(parameters[14]),
          {
            labelGlobalId: input.label.labelGlobalId,
            rateEvidenceGlobalId: input.label.rateEvidenceGlobalId,
            closeMode: 'ups_cie_sample',
            carrierCallMade: false,
          },
        )
        return {
          rows: [{ id: ids.attempt, global_id: 'gsa7654321' }],
        }
      }
      if (sql.includes('UPDATE operations_carrier_rate_test_labels')) {
        assert.match(sql, /status = 'voided'/)
        assert.match(sql, /organization_id = \$1::uuid/)
        assert.equal(parameters[0], ids.organization)
        assert.equal(parameters[1], ids.label)
        assert.equal(parameters[2], ids.attempt)
        return { rows: [{ global_id: input.label.labelGlobalId }] }
      }
      if (sql.includes('SELECT label.global_id')) {
        return { rows: [browserLabelRow()] }
      }
      throw new Error(`Unexpected sample-close SQL: ${sql}`)
    },
  }
  return client
}

auditEvents = []
transactionClient = createClient()
const closed = await closeCarrierRateTestSampleLabelInPostgres(input)
assert.equal(closed.globalId, input.label.labelGlobalId)
assert.equal(closed.status, 'voided')
assert.equal(auditEvents.length, 1)
assert.equal(
  auditEvents[0].eventType,
  'carrier.rate_test_label.sample_closed',
)
assert.equal(auditEvents[0].organizationId, ids.organization)
assert.equal(auditEvents[0].payload.carrierCallMade, false)
assert.equal(
  transactionClient.calls.filter((entry) => (
    entry.sql.includes('INSERT INTO operations_carrier_rate_test_label_attempts')
  )).length,
  1,
)

auditEvents = []
transactionClient = createClient('replay')
const replayed = await closeCarrierRateTestSampleLabelInPostgres(input)
assert.equal(replayed.status, 'voided')
assert.equal(auditEvents.length, 0)
assert.equal(
  transactionClient.calls.some((entry) => (
    entry.sql.includes('INSERT INTO operations_carrier_rate_test_label_attempts')
  )),
  false,
)

transactionClient = createClient('reused-key')
await assert.rejects(
  closeCarrierRateTestSampleLabelInPostgres(input),
  (error) => error.code === 'CARRIER_RATE_TEST_LABEL_IDEMPOTENCY_REUSED',
)

transactionClient = createClient('non-sample')
await assert.rejects(
  closeCarrierRateTestSampleLabelInPostgres(input),
  (error) => error.code === 'CARRIER_RATE_TEST_SAMPLE_CLOSE_UNAVAILABLE',
)

transactionClient = createClient('missing')
await assert.rejects(
  closeCarrierRateTestSampleLabelInPostgres(input),
  (error) => error.code === 'CARRIER_RATE_TEST_LABEL_NOT_FOUND',
)
assert.equal(
  transactionClient.calls.some((entry) => (
    entry.sql.includes('INSERT INTO operations_carrier_rate_test_label_attempts')
  )),
  false,
)

process.stdout.write('Carrier rate-test UPS CIE sample-close execution tests passed.\n')
