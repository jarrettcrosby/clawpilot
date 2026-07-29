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
  calculateBillingMud,
  evaluateGlCodingRule,
  glCodingChecksum,
  normalizeCarrierTrackingNumber,
  selectGlCodingRule,
  validateGlCodingConditions,
} = loadGlCoding()

const calculatedMud = calculateBillingMud(1_000n, [
  {
    globalId: 'grd1000002',
    priority: 20,
    type: 'percent_markup',
    amountMinor: null,
    basisPoints: 500,
  },
  {
    globalId: 'grd1000001',
    priority: 10,
    type: 'fixed_amount',
    amountMinor: 100n,
    basisPoints: null,
  },
])
assert.equal(calculatedMud.carrierBilledActualMinor, 1_000n)
assert.equal(calculatedMud.mudAdjustmentMinor, 150n)
assert.equal(calculatedMud.contractBilledShippingMinor, 1_150n)
assert.equal(calculatedMud.appliedDirectiveGlobalIds[0], 'grd1000001')
assert.equal(calculatedMud.appliedDirectiveGlobalIds[1], 'grd1000002')

assert.equal(calculateBillingMud(333n, [{
  globalId: 'grd1000003',
  priority: 10,
  type: 'cost_plus_percent',
  amountMinor: null,
  basisPoints: 1_250,
}]).mudAdjustmentMinor, 42n)

assert.equal(calculateBillingMud(1_000n, [{
  globalId: 'grd1000004',
  priority: 10,
  type: 'minimum_charge',
  amountMinor: 1_250n,
  basisPoints: null,
}]).contractBilledShippingMinor, 1_250n)

assert.throws(
  () => calculateBillingMud(1_000n, [{
    globalId: 'grd1000005',
    priority: 10,
    type: 'maximum_charge',
    amountMinor: 900n,
    basisPoints: null,
  }]),
  /BILLING_MUD_NEGATIVE_MARGIN/,
)
assert.throws(
  () => calculateBillingMud(1_000n, []),
  /BILLING_MUD_DIRECTIVE_REQUIRED/,
)

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
  'persistApprovedBillingMudCalculations',
  'if (\n      !item.billing_match_id',
  "status: 'not_configured' | 'calculated' | 'blocked'",
  'operations_carrier_billing_mud_calculations',
  "configurationReason = first.contract_version_id",
  "'MUD_GRANT_AMBIGUOUS'",
  'billingTimeMudOnly',
  'JOIN operations_carrier_rate_directives directive',
  'directiveCandidateSnapshot',
  'directiveCandidates: directiveCandidateSnapshot',
  'child.effective_from <= $6::timestamptz',
]) {
  assert.ok(persistence.includes(fragment), `Missing GL Coding persistence contract: ${fragment}`)
}
assert.ok(
  !persistence.includes(
    'LEFT JOIN operations_carrier_rate_directives directive',
  ),
  'Billing-time MUD must count only grants with applicable actual-cost directives',
)
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
  'Run Shipment GL Coding',
  "mode: 'carrier-invoices' | 'shipment-pricing'",
  'MUD means Markup Directive',
  'independently versioned contract directive',
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
  'Billing-time MUD',
  'Customer-paid checkout shipping',
  'Carrier billed actual',
  'Contract-billed shipping',
  'Checkout vs carrier actual',
  'Checkout vs contract bill',
  'Unmatched rows never produce a MUD calculation',
]) {
  assert.ok(panel.includes(fragment), `Missing GL Coding UI contract: ${fragment}`)
}

const navigation = read('app_src/components/Navigation.tsx')
for (const fragment of [
  "id: 'operations/exceptions'",
  "id: 'operations/receiving'",
  "id: 'operations/warehouses'",
  "id: 'operations/carrier-invoices'",
  "label: 'Carrier invoicing'",
  "id: 'operations/gl-coding'",
  "label: 'Shipment pricing & GL'",
  "id: 'operations/printing'",
]) {
  assert.ok(navigation.includes(fragment), `Missing carrier-finance navigation contract: ${fragment}`)
}

const homeClient = read('app_src/app/HomeClient.tsx')
for (const fragment of [
  "'operations/carrier-invoices': 'carrier-invoices'",
  "'operations/gl-coding': 'gl-coding'",
]) {
  assert.ok(homeClient.includes(fragment), `Missing carrier-finance route contract: ${fragment}`)
}

const operationsSection = read('app_src/components/operations/OperationsSection.tsx')
for (const fragment of [
  '<GlCodingPanel mode="carrier-invoices" />',
  '<GlCodingPanel mode="shipment-pricing" />',
  'Assign charges to the responsible shipper, review MUD pricing',
]) {
  assert.ok(
    operationsSection.includes(fragment),
    `Missing split carrier-finance workbench contract: ${fragment}`,
  )
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

const billingMudMigration = read(
  'db/migrations/0147_operations_carrier_billing_mud.sql',
)
const billingMudMigrationSql = compactSql(billingMudMigration)
for (const fragment of [
  "'operations.carrier_billing_mud_calculation'",
  'CREATE TABLE IF NOT EXISTS operations_carrier_billing_mud_calculations',
  'CREATE TABLE IF NOT EXISTS operations_carrier_billing_mud_calculation_charges',
  'CREATE TABLE IF NOT EXISTS operations_carrier_billing_mud_calculation_directives',
  "status IN ('not_configured', 'calculated', 'blocked')",
  'billing_statement_lineage_key',
  'billing_statement_version',
  'customer_paid_checkout_shipping_minor',
  'carrier_billed_actual_minor',
  'mud_adjustment_minor',
  'contract_billed_shipping_minor',
  'checkout_to_carrier_actual_variance_minor',
  'checkout_to_contract_bill_variance_minor',
  'validate_operations_carrier_billing_mud_charge',
  'validate_operations_carrier_billing_mud_directive',
  'validate_operations_carrier_billing_mud_complete',
  'Carrier billing MUD evidence is append-only',
  'Carrier billing MUD calculation requires an approved GL Coding review',
  'Carrier billing MUD requires an uploaded CSV statement lineage',
  'Carrier billing MUD charge requires the exact current shipment match',
  'applicable approved actual-cost version',
]) {
  assert.ok(
    billingMudMigrationSql.includes(fragment),
    `Missing billing-time MUD migration contract: ${fragment}`,
  )
}
for (const fragment of [
  'UNIQUE (network_id, billing_statement_lineage_key, billing_statement_version, shipment_id, currency)',
  "checkout_charge_status = 'customer_paid'",
  "status = 'calculated'",
  'contract_billed_shipping_minor = carrier_billed_actual_minor + mud_adjustment_minor',
  'evidence_charge_count IS DISTINCT FROM calculation_row.charge_count',
  'evidence_charge_total IS DISTINCT FROM calculation_row.carrier_billed_actual_minor',
  'count(DISTINCT evidence.grant_id)::integer',
  'jsonb_array_length(calculation_row.directive_snapshot)',
  'calculation_row.directive_snapshot IS DISTINCT FROM expected_directive_snapshot',
  "calculation_row.calculation_snapshot->>'model' IS DISTINCT FROM 'billing_actual_mud_v1'",
  'expected_contract_billed_minor := calculation_row.carrier_billed_actual_minor + additive_minor',
  'calculation_row.contract_billed_shipping_minor IS DISTINCT FROM expected_contract_billed_minor',
  'calculation_row.mud_adjustment_minor IS DISTINCT FROM expected_mud_adjustment_minor',
  "calculation_row.calculation_snapshot->>'configurationReason' IS DISTINCT FROM 'MUD_CALCULATED_FROM_BILLED_ACTUAL'",
  'canonical_operations_billing_jsonb',
  'calculation_row.input_hash IS DISTINCT FROM expected_input_hash',
  'calculation_row.calculation_snapshot IS DISTINCT FROM expected_calculation_snapshot',
  'count(DISTINCT rate_grant.id)::integer',
  'directive_count <> candidate_directive_count',
  'expected_directive_snapshot IS DISTINCT FROM expected_candidate_snapshot',
  'Carrier billing MUD with multiple direct grant paths must be blocked',
  'child.effective_from <= shipment_timestamp',
  'child.effective_to > shipment_timestamp',
  'child.supersedes_assignment_id = assignment.id',
  'DROP TRIGGER IF EXISTS validate_operations_carrier_billing_mud_parent_complete',
  'DROP TRIGGER IF EXISTS validate_operations_carrier_billing_mud_charge_complete',
  'DROP TRIGGER IF EXISTS validate_operations_carrier_billing_mud_directive_complete',
]) {
  assert.ok(
    billingMudMigrationSql.includes(fragment),
    `Missing hardened billing-time MUD SQL contract: ${fragment}`,
  )
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
