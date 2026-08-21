#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [
  migration,
  independentControlMigration,
  domain,
  persistence,
  runtime,
  trainingRoute,
  operationsRoute,
  operationsPersistence,
  commerceActivation,
  rateEvidenceRoute,
  hybridCartonizationPersistence,
  rateEvidencePersistence,
  operationalGeometry,
] = await Promise.all([
  read('db/migrations/0290_operations_shadow_training_runs.sql'),
  read('db/migrations/0300_operations_order_training_independent_control.sql'),
  read('app_src/lib/operations/shadowTraining.ts'),
  read('app_src/lib/persistence/operationShadowTraining.ts'),
  read('app_src/lib/integrations/shadowTrainingRuntime.ts'),
  read('app_src/app/api/operations/training/route.ts'),
  read('app_src/app/api/operations/route.ts'),
  read('app_src/lib/persistence/operations.ts'),
  read('app_src/lib/persistence/commerceActiveTransitionAuthorization.ts'),
  read('app_src/app/api/integrations/commerce/intake/cartonization-rate-evidence/route.ts'),
  read('app_src/lib/persistence/hybridCartonization.ts'),
  read('app_src/lib/persistence/cartonizationRateEvidence.ts'),
  read('app_src/lib/operations/operationalGeometryCartonization.ts'),
])

for (const fragment of [
  "CHECK (account_environment IN ('sandbox', 'production'))",
  'CHECK (commerce_provider_write_count = 0)',
  'CHECK (production_postage_count = 0)',
  'CHECK (inventory_mutation_count = 0)',
  'CHECK (packaging_stock_mutation_count = 0)',
  "^gtrn([0-9]{7}|[0-9a-v]{12})$",
  "^(gcol|gcal)([0-9]{7}|[0-9a-v]{12})$",
  'validate_operations_shadow_training_package_fact',
  'validate_operations_shadow_training_pick_fact',
  'validate_operations_shadow_training_plan_coverage',
  'DEFERRABLE INITIALLY DEFERRED',
  'OPERATIONS_SHADOW_TRAINING_OVERLAY_REQUIRED',
  "NEW.state = 'active'",
  "OLD.state IS DISTINCT FROM 'active'",
  "run.state <> 'reset'",
  'reset_reason IS NOT NULL',
  'reset_blocker_code IS NOT NULL',
  "evidence.candidate_row_version = NEW.authorization_candidate_row_version",
  "evidence.candidate_source_hash = NEW.authorization_candidate_source_hash",
  "evidence.plan_snapshot->'shadowTraining'->>'version'",
  'OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN',
  'ocr_order_has_zero_downstream(',
  "OLD.state = 'completed'",
  "AND NEW.state = 'packed'",
  "OLD.status = 'packed' AND NEW.status = 'planned'",
  "OLD.status = 'picked' AND NEW.status = 'ready'",
]) {
  assert.ok(migration.includes(fragment), `0290 is missing ${fragment}`)
}
assert.equal(
  /guard_shadow_commerce_canonical_write[\s\S]*order_status\s*=\s*'imported'/.test(migration),
  false,
  'canonical Shadow write fence must not reopen after provider status mirroring',
)

for (const fragment of [
  "activation.state IN (",
  "'disabled', 'shadow', 'read_only', 'active', 'frozen'",
  'activation.revision = NEW.authorization_activation_revision',
  'Order training requires an exact current safety profile',
  'pg_advisory_xact_lock(',
  "'operations:activation:' || NEW.organization_id::text",
  'CREATE OR REPLACE FUNCTION guard_shadow_commerce_canonical_write()',
  "IF TG_OP = 'DELETE'",
  'OPERATIONS_ORDER_TRAINING_SAFETY_PROFILE_REQUIRED',
]) {
  assert.ok(
    independentControlMigration.includes(fragment),
    `0300 independent training control is missing ${fragment}`,
  )
}
assert.equal(
  independentControlMigration.includes("NEW.state = 'active'"),
  false,
  'Order training must not block switching the advanced safety profile to Active',
)
assert.equal(
  migration.includes("OLD.state = 'shadow'\n     AND NEW.state <> 'shadow'"),
  false,
  'open training must not block emergency frozen/disabled/read_only exits',
)

for (const fragment of [
  "!['sandbox', 'production'].includes(input.accountEnvironment)",
  "input.orderStatus !== 'imported'",
  "input.sourceProvider !== 'shopify' && input.sourceProvider !== 'faire'",
  "input.environment !== 'sandbox'",
  "input.purpose !== 'sandbox_rate_test'",
]) {
  assert.ok(domain.includes(fragment), `domain fence is missing ${fragment}`)
}

for (const fragment of [
  'ocr_order_has_zero_downstream(',
  'resolved_training_lines',
  'promoted_candidate',
  'OPERATIONS_SHADOW_TRAINING_DOWNSTREAM_EXISTS',
  "candidate.workflow_state = 'promoted'",
  'evidence.candidateRowVersion !== Number(run.authorization_candidate_row_version)',
  'evidence.candidateSourceHash !== run.authorization_candidate_source_hash',
  'undoOperationsShadowTrainingInPostgres',
  "eventType: 'shadow_training.undo'",
  'commerceProviderWrites: 0',
  'packagingStockMutations: 0',
  'activationChanged',
  'candidateChanged',
  'training_evidence_sealed',
  "evidence.status IN ('succeeded', 'partial')",
  'restartRequiredBeforePlan',
  'This order has an open local training run',
]) {
  assert.ok(persistence.includes(fragment), `persistence fence is missing ${fragment}`)
}
for (const forbidden of [
  'executeShopify',
  'executeCurrentFaire',
  'INSERT INTO operations_reservations',
  'INSERT INTO operations_fulfillment_plans',
  'INSERT INTO operations_shipments',
  'INSERT INTO operations_commerce_fulfillment_exports',
  'UPDATE operations_inventory',
  'UPDATE operations_packaging_material',
]) {
  assert.equal(
    persistence.includes(forbidden),
    false,
    `training overlay must not contain canonical/provider mutation ${forbidden}`,
  )
}

for (const action of [
  'plan-order',
  'release-order',
  'assign-picks',
  'manage-pick-assignment',
  'request-pick-handoff',
  'record-pick-scan-evidence',
  'confirm-picks',
  'verify-pack',
  'authorize-sandbox-commerce-e2e',
  'prepare-shipment-execution',
  'generate-packing-slip',
  'confirm-shipment',
  'create-sandbox-label',
  'void-sandbox-label',
]) {
  assert.ok(
    operationsRoute.includes(`'${action}',`),
    `canonical Shadow action preflight is missing ${action}`,
  )
}
const actionSet = operationsRoute.slice(
  operationsRoute.indexOf('const SHADOW_COMMERCE_CANONICAL_ORDER_ACTIONS'),
  operationsRoute.indexOf('const ACTIVATION_STATES'),
)
for (const providerMirrorAction of [
  'reconcile-external-fulfillment',
  'accept-provider-order-cancellation',
]) {
  assert.equal(
    actionSet.includes(providerMirrorAction),
    false,
    `${providerMirrorAction} must remain available for provider mirroring`,
  )
}

assert.equal(
  operationsPersistence.includes('assertNoOpenOperationsShadowTrainingRunsForActivation'),
  false,
  'Order training must not block a direct advanced safety profile change',
)
assert.equal(
  commerceActivation.includes('assertNoOpenOperationsShadowTrainingRunsForActivation'),
  false,
  'Order training must not block an authorized Active transition',
)

for (const fragment of [
  'shadowTraining: null | {',
  'expectedRunRowVersion: request.shadowTraining.expectedRowVersion',
  '&& !request.shadowTraining',
  "? 'shadow_training_simulated'",
  "version: 'shadow-training-evidence-v1'",
  "assignmentPolicy: 'local_simulation_only'",
  "'shadow_training_simulated_order_and_material_availability'",
]) {
  assert.ok(
    rateEvidenceRoute.includes(fragment),
    `training evidence route is missing ${fragment}`,
  )
}
assert.match(
  rateEvidenceRoute,
  /operationalProvider === 'shopify'\s*&& !request\.shadowTraining\s*\? await inspectShopifyOrderPlanningAuthority/,
  'only the exact authenticated training request may skip Shopify planning authority',
)
for (const fragment of [
  "'shadow_training_simulated'",
  "availabilityAuthority = input.mode === 'shadow_training_simulated'",
  "if (input.mode === 'shadow_training_simulated') return null",
  "availableQuantity: input.mode === 'shadow_training_simulated'",
]) {
  assert.ok(
    hybridCartonizationPersistence.includes(fragment),
    `training cartonization simulation is missing ${fragment}`,
  )
}
assert.ok(
  rateEvidencePersistence.includes('if (!shadowTrainingEvidence)'),
  'training evidence persistence must bypass stock locking only for quarantined training evidence',
)
assert.ok(
  operationalGeometry.includes("availabilityMode?: 'operational' | 'shadow_training_simulated'"),
  'training OR-Tools cartonization must use explicit simulated availability',
)
for (const fragment of [
  "Object.hasOwn(evidence.planSnapshot, 'shadowTraining')",
  "Object.hasOwn(order.evidence_plan_snapshot, 'shadowTraining')",
  'OPERATIONS_SHADOW_TRAINING_EVIDENCE_CANONICAL_FORBIDDEN',
]) {
  assert.ok(
    operationsPersistence.includes(fragment),
    `canonical planning quarantine is missing ${fragment}`,
  )
}

for (const fragment of [
  "available: false",
  'Shipping Settings',
  'assertShadowTrainingLabelRuntimeBeforeIo',
  'requireBoundShadowTrainingLabelCapability',
]) {
  assert.ok(runtime.includes(fragment), `runtime boundary is missing ${fragment}`)
}
for (const forbidden of ["action === 'create-label'", "action === 'print-label'"]) {
  assert.equal(trainingRoute.includes(forbidden), false, `training API exposes dead action ${forbidden}`)
}
assert.ok(
  trainingRoute.includes("action === 'undo'"),
  'training API must expose only the local audited undo command',
)

console.log('Shadow exact-order training source contract passed.')
