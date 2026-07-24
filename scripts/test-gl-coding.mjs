#!/usr/bin/env node
import assert from 'node:assert/strict'
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

function compactSql(source) {
  return source
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function loadGlCoding() {
  const path = 'app_src/lib/operations/glCoding.ts'
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
    Date,
    Error,
    Map,
    Set,
    console,
    exports: module.exports,
    module,
    require: nodeRequire,
  }, { filename: path })
  return module.exports
}

const {
  evaluateGlCodingRule,
  glCodingChecksum,
  normalizeCarrierTrackingNumber,
  selectGlCodingRule,
  validateGlCodingConditions,
} = loadGlCoding()

const facts = {
  provider: 'ups',
  environment: 'sandbox',
  billedAccountFingerprint: 'a'.repeat(64),
  trackingNumber: '1Z999AA10123456784',
  providerLabelId: null,
  packageReference: 'package-101',
  serviceCode: '03',
  chargeCategory: 'transportation',
  description: 'Ground parcel charge',
  amountMinor: 1_245,
  currency: 'USD',
  shipmentDate: '2026-07-23',
  senderAddressFingerprint: 'b'.repeat(64),
  recipientAddressFingerprint: 'c'.repeat(64),
  routingAttributes: {
    senderPostalCode: '43015',
    recipientPostalCode: '02532',
    accountNumberLast4: '1234',
  },
}

const allConditions = validateGlCodingConditions({
  clauses: [
    { field: 'provider', operator: 'equals', value: 'UPS' },
    { field: 'environment', operator: 'in', value: ['sandbox', 'production'] },
    { field: 'routingAttributes.senderPostalCode', operator: 'starts_with', value: '430' },
    { field: 'description', operator: 'contains', value: 'parcel' },
    { field: 'trackingNumber', operator: 'exists' },
    { field: 'amountMinor', operator: 'equals', value: 1_245 },
  ],
})
const allEvaluation = evaluateGlCodingRule(
  { matchMode: 'all', conditions: allConditions },
  facts,
)
assert.equal(allEvaluation.matched, true)
assert.equal(allEvaluation.clauseResults.length, 6)

assert.equal(evaluateGlCodingRule({
  matchMode: 'any',
  conditions: validateGlCodingConditions({
    clauses: [
      { field: 'provider', operator: 'equals', value: 'fedex' },
      { field: 'routingAttributes.recipientPostalCode', operator: 'equals', value: '02532' },
    ],
  }),
}, facts).matched, true)

assert.equal(evaluateGlCodingRule({
  matchMode: 'all',
  conditions: validateGlCodingConditions({
    clauses: [
      { field: 'providerLabelId', operator: 'exists', value: false },
      { field: 'currency', operator: 'not_equals', value: 'CAD' },
    ],
  }),
}, facts).matched, true)

const baseRule = {
  id: 'rule-id',
  globalId: 'gbr1000001',
  name: 'Warehouse account routing',
  priority: 100,
  matchMode: 'all',
  conditions: validateGlCodingConditions({
    clauses: [{ field: 'provider', operator: 'equals', value: 'ups' }],
  }),
  outputs: { glAccount: 'Shipping expense' },
  targetShipperPartyId: 'shipper-id',
  targetShipperPartyGlobalId: 'grp1000001',
  targetShipperName: 'John Doe Test Shipper',
  versionNumber: 1,
}
const selected = selectGlCodingRule([
  { ...baseRule, globalId: 'gbr1000003', name: 'Later alphabetically', priority: 10 },
  { ...baseRule, globalId: 'gbr1000002', name: 'Earlier alphabetically', priority: 10, versionNumber: 1 },
  { ...baseRule, globalId: 'gbr1000004', name: 'Earlier alphabetically', priority: 10, versionNumber: 2 },
], facts)
assert.equal(selected.rule?.globalId, 'gbr1000004')
assert.equal(selected.evaluation?.matched, true)

for (const invalid of [
  { clauses: [] },
  { clauses: [{ field: 'routingAttributes.deep.value', operator: 'equals', value: 'x' }] },
  { clauses: [{ field: 'provider', operator: 'regex', value: 'ups' }] },
  { clauses: [{ field: 'provider', operator: 'in', value: [] }] },
  { clauses: [{ field: 'provider', operator: 'equals', value: { unsafe: true } }] },
  { clauses: [{ field: 'trackingNumber', operator: 'exists', value: 'yes' }] },
  { clauses: [{ field: 'amountMinor', operator: 'equals', value: 1.5 }] },
]) {
  assert.throws(
    () => validateGlCodingConditions(invalid),
    /GL_CODING_RULE_CONDITIONS_INVALID/,
  )
}

assert.equal(normalizeCarrierTrackingNumber(' 1z-999 aa 10123456784 '), '1Z999AA10123456784')
assert.equal(
  glCodingChecksum({ files: ['gcb1000001'], options: { b: 2, a: 1 } }),
  glCodingChecksum({ options: { a: 1, b: 2 }, files: ['gcb1000001'] }),
)

const migration = read('db/migrations/0090_operations_carrier_accounts_and_gl_coding.sql')
const migrationSql = compactSql(migration)
for (const fragment of [
  "('gac', 'operations.carrier_account'",
  "('ggl', 'operations.gl_coding_run'",
  "('ggi', 'operations.gl_coding_run_item'",
  'CREATE TABLE IF NOT EXISTS operations_carrier_accounts',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_runs',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_run_batches',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_run_items',
  'shipment_match_status text NOT NULL',
  'shipper_assignment_status text NOT NULL',
  'protect_operations_gl_coding_run_items_mutation',
  'validate_operations_gl_coding_run_batch',
  'validate_operations_gl_coding_run_item',
  'protect_operations_gl_coding_run_lifecycle',
  'protect_operations_gl_coding_run_batches_mutation',
  'idempotency_key text',
  'request_checksum text',
  'idx_operations_carrier_billing_routing_rules_idempotency',
]) {
  assert.ok(migration.includes(fragment), `Missing GL Coding migration contract: ${fragment}`)
}

for (const fragment of [
  "IF NEW.status IS DISTINCT FROM 'queued' OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL",
  "IF OLD.status IN ('needs_review', 'completed', 'failed', 'cancelled')",
  "IF OLD.status = 'queued' THEN IF NEW.status IS DISTINCT FROM 'running'",
  "ELSIF OLD.status = 'running' THEN IF NEW.status NOT IN ('needs_review', 'completed', 'failed', 'cancelled')",
  "IF NEW.status IN ('completed', 'failed', 'cancelled') AND NEW.completed_at IS NULL",
  'NEW.selection_snapshot, NEW.rule_snapshot, NEW.input_checksum, NEW.idempotency_key',
  "IF run_status IS DISTINCT FROM 'queued'",
  'OR batch.environment IS DISTINCT FROM candidate_environment',
  'BEFORE UPDATE OR DELETE ON operations_gl_coding_run_batches',
  "IF run_status IS DISTINCT FROM 'running'",
  'BEFORE UPDATE OR DELETE ON operations_gl_coding_run_items',
  'CHECK (NULLIF(btrim(idempotency_key), \'\') IS NOT NULL) NOT VALID',
  "CHECK (request_checksum ~ '^[a-f0-9]{64}$') NOT VALID",
  'ON operations_carrier_billing_routing_rules (network_id, idempotency_key)',
]) {
  assert.ok(
    migrationSql.includes(fragment),
    `Missing hardened GL Coding SQL contract: ${fragment}`,
  )
}

const persistence = read('app_src/lib/persistence/glCoding.ts')
for (const fragment of [
  'const requestChecksum = glCodingChecksum({',
  'WHERE network_id = $1::uuid AND idempotency_key = $2',
  "priorRequest.rows[0].request_checksum !== requestChecksum",
  "'GL_CODING_IDEMPOTENCY_CONFLICT'",
  'idempotency_key, request_checksum',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Missing GL Coding persistence idempotency contract: ${fragment}`,
  )
}
for (const fragment of [
  'runSelectedGlCodingFilesInPostgres',
  'assignGlCodingOrphanInPostgres',
  'createGlCodingRuleInPostgres',
  'persistShipmentMatch',
  'persistShipperAssignment',
  "current_assignment_source === 'manual'",
  'SAVEPOINT gl_coding_charge',
  'GL_CODING_BATCH_SCOPE_MISMATCH',
  'GL_CODING_IDEMPOTENCY_CONFLICT',
  'operations_gl_coding_run_items',
  'operations.gl_coding.run_completed',
  'operations.gl_coding.orphan_assigned',
  'reviewGlCodingRunInPostgres',
  'recordGlCodingSettlementEventInPostgres',
  "'carrier_payable'",
  "'carrier_cost_reimbursement'",
  "'credit'",
  'quoteTimePlatformAndResellerFeesExcluded',
]) {
  assert.ok(persistence.includes(fragment), `Missing GL Coding persistence contract: ${fragment}`)
}
assert.ok(
  persistence.indexOf('persistShipmentMatch') !== persistence.indexOf('persistShipperAssignment'),
  'Shipment matching and shipper assignment must remain separate decisions',
)

const route = read('app_src/app/api/operations/gl-coding/route.ts')
for (const fragment of [
  "action === 'run-selected-files'",
  "action === 'assign-orphan'",
  "action === 'create-rule'",
  "action === 'review-run'",
  "action === 'record-settlement-event'",
  'canReconcileCarrierBilling',
  'canApproveCarrierSettlement',
  'canManageNetworks',
  'Idempotency-Key',
  'Cache-Control',
  'assertFields',
]) {
  assert.ok(route.includes(fragment), `Missing GL Coding API contract: ${fragment}`)
}

const panel = read('app_src/components/operations/GlCodingPanel.tsx')
for (const fragment of [
  'Run GL Coding',
  'Orphan queue',
  'Assignment reason',
  'shipmentMatchStatus',
  'shipperAssignmentStatus',
  'canManageNetworks',
  'environmentConflict',
  'Import carrier billing CSV',
  'Approve actuals',
  'Reject run',
  'Settlement ledger',
  'canApproveCarrierSettlement',
]) {
  assert.ok(panel.includes(fragment), `Missing GL Coding UI contract: ${fragment}`)
}

const reviewMigration = read('db/migrations/0093_operations_carrier_billing_import_and_review.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS operations_carrier_billing_import_rows',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_reviews',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_review_items',
  'CREATE TABLE IF NOT EXISTS operations_gl_coding_review_settlements',
  'validate_operations_gl_coding_review',
  'validate_operations_gl_coding_review_item',
  'validate_operations_gl_coding_review_settlement',
  "'carrier_payable', 'carrier_cost_reimbursement', 'credit'",
  'Only a completed GL Coding run without orphan or error items may be approved',
  'GL Coding review settlement must preserve the exact reviewed billed-actual decision',
]) {
  assert.ok(reviewMigration.includes(fragment), `Missing GL Coding review contract: ${fragment}`)
}

const settlementLifecycleMigration = read('db/migrations/0097_operations_settlement_lifecycle.sql')
for (const fragment of [
  'validate_operations_settlement_event_lifecycle',
  'Settlement events are append-only',
  'Settlement lifecycle event requires an operator reason',
  'Billed and paid settlement events require an external reference',
  "NEW.event_type = 'approved'",
  "NEW.event_type = 'billed'",
  "NEW.event_type = 'paid'",
  "NEW.event_type = 'disputed'",
  "NEW.event_type = 'resolved'",
  "NEW.event_type = 'reversed'",
  "NEW.event_type = 'voided'",
  'CREATE OR REPLACE VIEW operations_settlement_current_status',
]) {
  assert.ok(
    settlementLifecycleMigration.includes(fragment),
    `Missing settlement lifecycle contract: ${fragment}`,
  )
}

console.log('gl coding tests passed')
