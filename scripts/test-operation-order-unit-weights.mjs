#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(path, 'utf8')
const migrationPath =
  'db/migrations/0334_operations_order_unit_weight_evidence.sql'
const migration = read(migrationPath)
const expectedChecksum =
  '15a98ccbcde18418f795d319726521340b444c1cbb9d693ac5f8460cb90cfa2b'
const nullSafeMigrationPath =
  'db/migrations/0335_operations_order_unit_weight_null_safe_validation.sql'
const nullSafeMigration = read(nullSafeMigrationPath)
const expectedNullSafeChecksum =
  'e4deac2b38f157194483ee47eeb6bf32b20c158e9c330624889cbdf4419f69e6'
const physicalFactsMigrationPath =
  'db/migrations/0336_operations_order_unit_physical_facts.sql'
const physicalFactsMigration = read(physicalFactsMigrationPath)
const expectedPhysicalFactsChecksum =
  '8969fcb35a786b7c7109d544d84021b32e9637162509a6aa5a1c1761d81d995c'

assert.equal(
  createHash('sha256').update(migration).digest('hex'),
  expectedChecksum,
  'The deployed migration contract must be checksum-pinned',
)
for (const fragment of [
  'operations_order_unit_weight_facts',
  'operator_recorded_order_weight',
  'line_source_revision',
  'line_source_hash',
  'fact_hash',
  'candidate_line_fkey',
  'revision_line_fkey',
  'revision_application_line_id',
  'operations_order_unit_weight_facts_line_kind_valid',
  'facts are append-only',
  'operations.record_order_unit_weights',
  "IS DISTINCT FROM 'record-order-unit-weights'",
  "IS DISTINCT FROM '0'::jsonb",
  'Order unit weight command provenance is immutable',
  'fact.organization_id = OLD.organization_id',
  'NEW.fact_version > 1',
  "'candidateRowVersion', NEW.candidate_row_version",
]) {
  assert.ok(migration.includes(fragment), `Migration must retain ${fragment}`)
}
assert.doesNotMatch(
  migration,
  /UPDATE\s+public\.operations_commerce_order_candidate_lines/iu,
  'Order-specific weight evidence must not mutate imported packaging fields',
)
assert.equal(
  createHash('sha256').update(physicalFactsMigration).digest('hex'),
  expectedPhysicalFactsChecksum,
  'The order-specific physical-fact migration must be checksum-pinned',
)
for (const fragment of [
  'unit_length_mm',
  'unit_width_mm',
  'unit_height_mm',
  'operator_recorded_order_dimensions',
  "'unitDimensionsMm', CASE",
  'pg_catalog.jsonb_build_object(',
  'operational-unit-material-shared-stock-v3',
  'largest_rated_outer_volume_then_sorted_axes_then_material_id',
  'sharedStockSolver',
  'fixed_axis_regular_grid',
  'one_each_without_fit_claim',
  "NEW.inner_dimensions_mm->>'length'",
  "fit_evidence->>'weightCapacityUnits'",
  'Unit-material packages cannot retain recipe or Product-pack profile edges',
]) {
  assert.ok(
    physicalFactsMigration.includes(fragment),
    `Physical-fact migration must retain ${fragment}`,
  )
}
assert.equal(
  createHash('sha256').update(nullSafeMigration).digest('hex'),
  expectedNullSafeChecksum,
  'The null-safe trigger repair must be checksum-pinned',
)
for (const fragment of [
  'CREATE OR REPLACE FUNCTION public.validate_operations_order_unit_weight_fact()',
  "line.packaging_weight_source IS DISTINCT FROM 'provider_order'",
  'COALESCE(line.weight_grams, 0) <= 0',
  'COALESCE(channel_state.weight_grams, 0) = 0',
]) {
  assert.ok(
    nullSafeMigration.includes(fragment),
    `Null-safe migration must retain ${fragment}`,
  )
}
assert.doesNotMatch(
  nullSafeMigration,
  /NOT\s*\(\s*line\.packaging_weight_source\s*=\s*'provider_order'/iu,
  'A missing provider weight source must not collapse the eligibility fence to NULL',
)

const persistence = read(
  'app_src/lib/persistence/orderUnitWeightEvidence.ts',
)
for (const fragment of [
  'OPERATIONS_ORDER_UNIT_WEIGHT_CONTEXT_CHANGED',
  'missingIds.some((lineGlobalId) => !suppliedIds.includes(lineGlobalId))',
  'expectedFactVersion',
  'source.revision_application_line_id',
  'operations:order-unit-weight:',
  'operations:order:',
  'providerWriteCount: 0',
  'operations.order.unit_weights_recorded',
  'assertCurrentOrderUnitWeightEvidence',
  'newer.fact_version > fact.fact_version',
  "weightSource: 'provider_order' | 'provider_catalog' | 'order_specific'",
  'workspace: null',
  'correlation_id = $4::uuid',
  'unitDimensionsMm: exactDimensions(',
  "dimensionSource: 'order_specific' | null",
  'fact.unit_length_mm',
  '/^(?:gcol|gcal)',
]) {
  assert.ok(persistence.includes(fragment), `Persistence must retain ${fragment}`)
}
const retainedFactRead = persistence.slice(
  persistence.indexOf('LEFT JOIN LATERAL ('),
  persistence.indexOf(') fact ON true'),
)
assert.doesNotMatch(
  retainedFactRead,
  /retained\.candidate_row_version/,
  'An unrelated candidate row-version advance must not hide exact line evidence',
)
assert.match(
  persistence,
  /candidate_row_version,[\s\S]*input\.expectedCandidateRowVersion/,
  'Candidate row version remains recorded as optimistic-concurrency context',
)
assert.match(
  persistence,
  /SELECT \$1::text,[\s\S]*'factGlobalId', \$1::text/,
  'The allocated fact global ID must be typed explicitly for PostgreSQL 18',
)

const hybrid = read('app_src/lib/persistence/hybridCartonization.ts')
for (const fragment of [
  "| 'order_specific'",
  'order_unit_weight_fact_global_id',
  'order_unit_weight_fact_hash',
  'order_unit_length_mm',
  "dimensionSource: unitDimensionsMm ? 'order_specific' : null",
  'HYBRID_CARTONIZATION_UNIT_ORDER_EVIDENCE_INVALID',
  'fact.revision_application_line_id = revision_line.id',
]) {
  assert.ok(hybrid.includes(fragment), `Hybrid cartonization must retain ${fragment}`)
}
const hybridFactRead = hybrid.slice(
  hybrid.indexOf('LEFT JOIN LATERAL (\n       SELECT fact.global_id'),
  hybrid.indexOf(') order_unit_weight ON true'),
)
assert.doesNotMatch(
  hybridFactRead,
  /fact\.candidate_row_version/,
  'Cartonization must retain exact line evidence across row-version-only advances',
)

const route = read(
  'app_src/app/api/operations/order-unit-weights/route.ts',
)
for (const fragment of [
  "export async function GET",
  "export async function POST",
  "'idempotency-key'",
  'operationsCapabilities(actor).canManage',
  'expectedCandidateRowVersion',
  'requestBodyLines',
  '^(?:gcol|gcal)',
]) {
  assert.ok(route.includes(fragment), `API route must retain ${fragment}`)
}

const ui = read('app_src/components/operations/OperationsSection.tsx')
for (const fragment of [
  'order-planning-missing-unit-facts',
  'Missing unit weights',
  'Item dimensions for cartonization',
  'dimensionMissingLines',
  'Quantity {line.quantity}',
  'Unit weight (${measurementUnits(',
  "(['length', 'width', 'height'] as const)",
  'A Product pack is optional',
  'label="Audit reason"',
  'Save unit facts',
  'Boolean(planUnitWeightWorkspace?.missingLines.length)',
  'Change at least one order-specific unit fact.',
  'planUnitWeightHasUnsavedChanges',
  'planUnitWeightWorkspaceBlocked',
  'planUnitWeightWorkspaceRequired',
  '!shadowTrainingPlanTarget',
  'setPlanUnitWeightWorkspace(null)',
  "step: planUnitWeightDraftMeasurementSystem === 'metric'",
  'required={planUnitWeightHasUnsavedChanges}',
  'planUnitWeightDraftMeasurementSystem',
  'orderUnitWeightDraftValue',
  'planPreparationAbortController.current?.abort()',
  "line.variantTitle.toLowerCase() !== 'default title'",
  'Order unit facts are read-only in training.',
  'Order unit facts cannot be changed in training.',
]) {
  assert.ok(ui.includes(fragment), `Operations UI must retain ${fragment}`)
}
assert.ok(
  ui.split('|| planUnitWeightWorkspaceBlocked').length - 1 >= 4,
  'Create, confirm, Run, and Confirm must all block a missing or dirty workspace',
)
const closePlanControl = ui.slice(
  ui.indexOf('const closePlan = () => {'),
  ui.indexOf('const savePlanUnitWeights = async () => {'),
)
assert.ok(
  closePlanControl.includes('planPreparationAbortController.current?.abort()')
    && closePlanControl.includes('planPreparationAbortController.current = null')
    && closePlanControl.includes('setPlanPreparationLoading(false)'),
  'Closing preparation must abort the active request and clear its loading state',
)
const unitWeightControl = ui.slice(
  ui.indexOf('data-testid="order-planning-missing-unit-facts"'),
  ui.indexOf('Step 1 · Choose fulfillment facts'),
)
assert.ok(
  unitWeightControl.includes("setPlanCartonizationEvidenceGlobalId('')"),
  'Editing a unit weight must immediately remove stale cartonization evidence',
)
assert.ok(
  unitWeightControl.includes('operations-rate-plan:'),
  'Editing a unit weight must rotate the cartonization idempotency key',
)
assert.doesNotMatch(
  unitWeightControl,
  /E2E|test path|sandbox/iu,
  'The operator weight control must stay concise and production-facing',
)

const uiAcceptance = read('app_src/tests/operations/ui-acceptance.spec.ts')
for (const fragment of [
  "url.pathname === '/api/operations/order-unit-weights'",
  'missingUnitWeight: true',
  'Measured on the receiving scale',
  "page.getByLabel(/^Length/).fill('10')",
  "page.getByText('Vanilla · Quantity 1')",
  "page.getByText('UPS · UPS Ground')).toHaveCount(0)",
  'capture.unitWeightRequests.length).toBe(2)',
]) {
  assert.ok(
    uiAcceptance.includes(fragment),
    `UI acceptance must exercise unit weights: ${fragment}`,
  )
}

const operationsRoute = read('app_src/app/api/operations/route.ts')
for (const fragment of [
  'OperationsOrderUnitWeightError',
  'error instanceof OperationsOrderUnitWeightError',
  'code: error.code',
  'error.status',
]) {
  assert.ok(
    operationsRoute.includes(fragment),
    `Operations API must preserve unit-weight errors: ${fragment}`,
  )
}

for (const harnessPath of [
  'scripts/test-distributed-operations.mjs',
  'scripts/test-commerce-intake-staging-postgres.mjs',
  'scripts/test-operation-order-replanning-corrections-postgres.mjs',
  'scripts/test-operation-shipment-completion.mjs',
  'scripts/test-canonical-fulfillment-planning-postgres.mjs',
]) {
  assert.ok(
    read(harnessPath).includes(
      "'@/lib/persistence/orderUnitWeightEvidence'",
    ),
    `${harnessPath} must map the operations unit-weight runtime alias`,
  )
}

const health = read(
  'app_src/lib/persistence/operationsOrderUnitWeightHealth.ts',
)
assert.ok(health.includes(expectedPhysicalFactsChecksum))
assert.ok(health.includes('OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL'))
const healthRoute = read('app_src/app/api/health/route.ts')
assert.ok(healthRoute.includes('${OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL}'))
assert.ok(healthRoute.includes('operations_order_unit_weight_applied'))

console.log('Operations order unit-weight evidence contracts passed')
