#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function compactSql(source) {
  return source
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

const migrationSource = read(
  'db/migrations/0116_operations_carrier_rate_test_labels.sql',
)
const migration = compactSql(migrationSource)

for (const fragment of [
  "('gsl', 'operations.carrier_rate_test_label'",
  "('gsa', 'operations.carrier_rate_test_label_attempt'",
  'CREATE TABLE IF NOT EXISTS operations_carrier_rate_test_labels',
  'CREATE TABLE IF NOT EXISTS operations_carrier_rate_test_label_attempts',
  'label_payload bytea NOT NULL',
  'octet_length(label_payload) BETWEEN 1 AND 10485760',
  "format IN ('ZPL', 'PDF', 'PNG')",
  "media_size IN ('label_4x6', 'label_4x8')",
  "state IN ('prepared', 'succeeded', 'failed', 'unknown')",
  "action IN ('create', 'void', 'reconcile')",
  'account_number_fingerprint text NOT NULL',
  'reconciliation_outcome text',
  'reconciliation_idempotency_key text',
  'Unknown carrier rate test label attempts require an evidenced reconciliation',
  'operations_carrier_rate_test_label_attempts_reconciliation_key_unique',
  'length(btrim(reason)) BETWEEN 1 AND 500',
  "reason !~ '[[:cntrl:]]'",
  'UNIQUE (organization_id, action, idempotency_key)',
  'operations_carrier_rate_test_labels_one_active_service',
  'operations_carrier_rate_test_label_attempts_rate_request_fkey',
  'operations_carrier_rate_test_label_attempts_carrier_account_fkey',
  'protect_operations_carrier_rate_test_label_attempt',
  'Terminal carrier rate test label attempts are immutable',
  'Carrier rate test label may transition from created to voided exactly once',
  'ADD COLUMN IF NOT EXISTS source_rate_test_label_id uuid',
  'clawpilot-rate-test-label',
  'operations_print_artifacts_source_rate_test_label_fkey',
  'operations_print_artifacts_source_rate_test_label_unique',
  'ADD COLUMN IF NOT EXISTS rate_test_label_id uuid',
  'operations_print_jobs_rate_test_label_fkey',
  'operations_print_jobs_original_rate_test_label_unique',
  'NEW.rate_test_label_id',
]) {
  assert.ok(
    migration.includes(fragment),
    `Missing carrier rate-test label schema contract: ${fragment}`,
  )
}

assert.ok(
  !/\b(?:client_secret|access_token|refresh_token|account_number|full_address)\b/i
    .test(migrationSource),
  'Rate-test label schema must not add plaintext credentials or full addresses',
)
assert.ok(
  !/label_payload\s+text\b/i.test(migrationSource),
  'Rate-test label bytes must use bytea rather than encoded text',
)

const persistence = read('app_src/lib/persistence/operationPrintDelivery.ts')
for (const fragment of [
  "type: 'rate_test_label'",
  'sourceRateTestLabelGlobalId',
  'RATE_TEST_LABEL_GLOBAL_ID',
  'decodeStoredOperationsLabelPayload',
  'strictBase64Bytes',
  'validZplBytes',
  'validateLabelBytes',
  "encoding: input.format === 'ZPL' ? 'utf8' : 'base64'",
  'octet_length(label.label_payload)::text AS byte_length',
  'Rate-test label content failed integrity validation',
  'clawpilot-rate-test-label:',
  'assertRateTestLabelCanBeEnqueued',
  'cancelVoidedRateTestLabelJobs',
  'rate_test_label.label_payload AS rate_test_label_payload',
  'artifact.source_rate_test_label_id IS NULL',
  'original.rate_test_label_id',
  'Inactive or voided carrier rate-test labels cannot be reprinted',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Missing carrier rate-test print contract: ${fragment}`,
  )
}

assert.ok(
  !/\b(?:createCarrierSandboxLabel|voidCarrierSandboxLabel)\s*\(/.test(persistence),
  'Print delivery must never invoke a carrier label create or void API',
)

const labelPersistence = read(
  'app_src/lib/persistence/carrierRateTestLabels.ts',
)
for (const fragment of [
  'prepareCarrierRateTestLabelCreateInPostgres',
  'finalizeCarrierRateTestLabelCreateInPostgres',
  'prepareCarrierRateTestLabelVoidInPostgres',
  'finalizeCarrierRateTestLabelVoidInPostgres',
  'finalizeCarrierRateTestLabelAttemptFailureInPostgres',
  'listCarrierRateTestLabelsInPostgres',
  'queueCarrierRateTestLabelPrintInPostgres',
  'listCarrierRateTestLabelAttemptsInPostgres',
  'reconcileCarrierRateTestLabelAttemptInPostgres',
  'replayCarrierRateTestLabelVoidInPostgres',
  "state IN ('prepared', 'unknown')",
  "type: 'rate_test_label'",
]) {
  assert.ok(
    labelPersistence.includes(fragment),
    `Missing carrier rate-test persistence contract: ${fragment}`,
  )
}
const browserSafeProjection = labelPersistence.slice(
  labelPersistence.indexOf('export type CarrierRateTestLabelListItem'),
  labelPersistence.indexOf('export function carrierRateTestLabelFingerprint'),
)
assert.ok(
  !/labelPayload\s*:/i.test(browserSafeProjection),
  'Browser-safe rate-test label projections must not expose label payload bytes',
)

const actions = read(
  'app_src/lib/integrations/carrierRateTestLabelActions.ts',
)
for (const fragment of [
  'createCarrierRateTestLabel',
  'printCarrierRateTestLabel',
  'voidCarrierRateTestLabel',
  'listCarrierRateTestLabels',
  'createCarrierSandboxLabel',
  'voidCarrierSandboxLabel',
  'carrierSandboxRateSelectionRequestHash',
  'carrierSandboxPartyFingerprint',
  'CARRIER_RATE_TEST_CONTEXT_CHANGED',
  'CARRIER_RATE_TEST_SELECTION_MISMATCH',
  'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
  'reconcileCarrierRateTestLabelAttempt',
  'senderBillingOnly: true',
  'shipmentFixture',
  'payloadEncoding',
  'labelByteLength',
  'labelContentSha256',
  "state: 'unknown'",
  'CARRIER_RATE_TEST_RECONCILIATION_REQUIRED',
]) {
  assert.ok(
    actions.includes(fragment),
    `Missing carrier rate-test action contract: ${fragment}`,
  )
}
const printActionBody = actions.slice(
  actions.indexOf('export async function printCarrierRateTestLabel'),
  actions.indexOf('export async function listCarrierRateTestLabels'),
)
assert.ok(
  !/\b(?:createCarrierSandboxLabel|voidCarrierSandboxLabel)\s*\(/.test(printActionBody),
  'Stored-label print action must not invoke a carrier API',
)

const adapter = read('app_src/lib/integrations/carrierSandboxLabel.ts')
for (const fragment of [
  "CARRIER_SANDBOX_LABEL_ADAPTER_VERSION = 'direct-rest-sandbox-v2'",
  "imageType: 'ZPLII'",
  "labelStockType: 'STOCK_4X6'",
  "format: 'ZPL' as const",
  "payloadEncoding: 'utf8' as const",
  "providerImageType: provider === 'fedex_rest' ? 'ZPLII' : 'ZPL'",
]) {
  assert.ok(
    adapter.includes(fragment),
    `Missing provider-native thermal label contract: ${fragment}`,
  )
}
assert.ok(
  !/labelSpecification:\s*\{[\s\S]{0,200}imageType:\s*'PDF'/.test(adapter),
  'The bounded FedEx diagnostic must not request a laser PDF for a thermal route',
)

console.log('Carrier rate-test label schema and print contracts passed.')
