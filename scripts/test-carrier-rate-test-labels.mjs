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
const outputMigrationSource = read(
  'db/migrations/0118_operations_carrier_label_output_artifacts.sql',
)
const outputMigration = compactSql(outputMigrationSource)

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

for (const fragment of [
  'ADD COLUMN IF NOT EXISTS source_kind text',
  'ADD COLUMN IF NOT EXISTS provider_image_type text',
  'ADD COLUMN IF NOT EXISTS provider_stock_type text',
  "source_kind = 'provider_native'",
  "provider_image_type = 'ZPLII'",
  "provider_stock_type = 'PAPER_4X6'",
  'NEW.label_payload',
  'OLD.label_payload',
  'operations_carrier_rate_test_label_derivatives',
  'source_content_sha256 text NOT NULL',
  'artifact_payload bytea NOT NULL',
  'converter_name text NOT NULL',
  'converter_version text NOT NULL',
  'conversion_options jsonb NOT NULL',
  'Carrier label derived artifacts are immutable',
  'Carrier label derivative source hash does not match',
  'Carrier label derivative content hash does not match',
]) {
  assert.ok(
    outputMigration.includes(fragment),
    `Missing carrier label source/derivative contract: ${fragment}`,
  )
}
const outputTriggerDrop = outputMigration.indexOf(
  'DROP TRIGGER IF EXISTS protect_operations_carrier_rate_test_label_write',
)
const outputBackfill = outputMigration.indexOf(
  'UPDATE operations_carrier_rate_test_labels SET source_kind',
)
const outputFunction = outputMigration.indexOf(
  'CREATE OR REPLACE FUNCTION protect_operations_carrier_rate_test_label()',
)
const outputTriggerCreate = outputMigration.indexOf(
  'CREATE TRIGGER protect_operations_carrier_rate_test_label_write',
)
assert.ok(
  outputTriggerDrop >= 0
    && outputBackfill > outputTriggerDrop
    && outputFunction > outputBackfill
    && outputTriggerCreate > outputFunction,
  '0118 must drop the 0116 immutability trigger before backfill and recreate it after the replacement function',
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
  'closeCarrierRateTestSampleLabelInPostgres',
  "'CARRIER_RATE_TEST_SAMPLE_NO_ACTIVE_LABEL'",
  "'confirmed_no_active_label'",
  "closeMode: 'ups_cie_sample'",
  'carrierCallMade: false',
  'providerErrorCodes',
  'providerHttpStatus',
  'replayCarrierRateTestLabelVoidInPostgres',
  "state IN ('prepared', 'unknown')",
  "type: 'rate_test_label'",
  "attempt.redacted_request->>'outputFormat'",
  ') AS requested_output_format',
  'attempt.requested_output_format !== input.format',
  'CARRIER_RATE_TEST_LABEL_OUTPUT_MISMATCH',
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
  'closeCarrierRateTestSampleLabel',
  'carrierSandboxLabelLifecycleMode',
  "'CARRIER_RATE_TEST_SAMPLE_CLOSE_REQUIRED'",
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
const createActionBody = actions.slice(
  actions.indexOf('export async function createCarrierRateTestLabel'),
  actions.indexOf('export async function printCarrierRateTestLabel'),
)
assert.ok(
  createActionBody.indexOf('await resolveVerifiedLabelRuntime')
    < createActionBody.indexOf(
      'await prepareCarrierRateTestLabelCreateInPostgres',
    ),
  'Label capability and shipment context must fail before a prepared attempt is written',
)
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
  "CARRIER_SANDBOX_LABEL_ADAPTER_VERSION = 'direct-rest-sandbox-v3'",
  'carrierSandboxLabelOutputOptions',
  "providerImageType: 'ZPL'",
  "providerImageType: 'ZPLII'",
  "providerImageType: 'PDF'",
  "providerImageType: 'PNG'",
  "providerStockType: 'HEIGHT_6_WIDTH_4'",
  "providerStockType: 'STOCK_4X6'",
  "providerStockType: 'PAPER_4X6'",
  "sourceKind: 'provider_native'",
  'printablePdf',
  'printablePng',
  "'CARRIER_LABEL_OUTPUT_UNSUPPORTED'",
]) {
  assert.ok(
    adapter.includes(fragment),
    `Missing provider-native thermal label contract: ${fragment}`,
  )
}
assert.ok(
  !/\b(?:sharp|imagemagick|ghostscript|rasterize|convertLabel)\b/i.test(adapter),
  'Carrier adapter selection must request native provider output rather than convert source bytes',
)

const carrierApi = read('app_src/app/api/integrations/carriers/route.ts')
for (const fragment of [
  'rateTestLabelOutputs',
  "carrierSandboxLabelOutputOptions('ups_rest')",
  "carrierSandboxLabelOutputOptions('fedex_rest')",
  "'outputFormat'",
  'outputFormat: labelOutputFormat(body.outputFormat)',
  'sourceKind: label.sourceKind',
  'providerImageType: label.providerImageType',
  'providerStockType: label.providerStockType',
  'printArtifactGlobalId: label.printArtifactGlobalId',
  'artifactGlobalId: job.artifactGlobalId',
  'lifecycleMode: carrierSandboxLabelLifecycleMode',
  'providerErrorCodes: attempt.providerErrorCodes',
  'providerHttpStatus: attempt.providerHttpStatus',
  "action === 'close-rate-test-sample-label'",
]) {
  assert.ok(
    carrierApi.includes(fragment),
    `Missing carrier label output API contract: ${fragment}`,
  )
}
const sampleCloseApi = carrierApi.slice(
  carrierApi.indexOf("if (action === 'close-rate-test-sample-label')"),
  carrierApi.indexOf("if (action === 'reconcile-rate-test-attempt')"),
)
for (const fragment of [
  'requireExecutor(actor)',
  'requireCredentialViewer(actor)',
  'closeCarrierRateTestSampleLabel',
  'rateTestAttempts.map(safeRateTestLabelAttempt)',
]) {
  assert.ok(
    sampleCloseApi.includes(fragment),
    `UPS sample-close API authorization/result contract missing: ${fragment}`,
  )
}

const carrierUi = read(
  'app_src/components/settings/CarrierIntegrationPanel.tsx',
)
for (const fragment of [
  'Carrier label output',
  'carrier native',
  'outputFormat: selectedLabelOutput.format',
  'Provider-native',
  'source bytes immutable',
  'Close UPS sample without carrier call',
  "'close-rate-test-sample-label'",
  'provider code',
]) {
  assert.ok(
    carrierUi.includes(fragment),
    `Missing carrier label output UI contract: ${fragment}`,
  )
}

const health = read('app_src/app/api/health/route.ts')
for (const fragment of [
  "WHERE filename = '0116_operations_carrier_rate_test_labels.sql'",
  'row?.operations_carrier_rate_test_labels_migration_applied',
  "WHERE filename = '0117_operations_print_agent_capabilities.sql'",
  'row?.operations_print_agent_capabilities_migration_applied',
  "WHERE filename = '0118_operations_carrier_label_output_artifacts.sql'",
  'row?.operations_carrier_label_artifacts_migration_applied',
]) {
  assert.ok(health.includes(fragment), `Missing carrier health migration gate: ${fragment}`)
}

console.log('Carrier rate-test label schema and print contracts passed.')
