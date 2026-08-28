#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [
  migration,
  unitCartonizationMigration,
  duplicateWorkbenchMigration,
  persistence,
  route,
  operationsRoute,
  operations,
  types,
  intake,
  candidateResolver,
  drawer,
] = await Promise.all([
  read('db/migrations/0307_operations_commerce_order_workbench.sql'),
  read('db/migrations/0321_operations_unit_item_cartonization.sql'),
  read('db/migrations/0322_operations_duplicate_order_workbench_recovery.sql'),
  read('app_src/lib/persistence/commerceOrderWorkbench.ts'),
  read('app_src/app/api/operations/order-workbench/route.ts'),
  read('app_src/app/api/operations/route.ts'),
  read('app_src/lib/persistence/operations.ts'),
  read('app_src/lib/operations/types.ts'),
  read('app_src/lib/integrations/commerceIntake.ts'),
  read('app_src/lib/persistence/commerceIntake.ts'),
  read('app_src/components/operations/ImportedOrderWorkingCopyDrawer.tsx'),
])

for (const fragment of [
  'duplicate_workbenches',
  'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL',
  "receipt.status = 'processing'",
  'canonical.external_order_id = candidate.external_order_id',
  'SET canonical_order_id = canonical.id',
]) {
  assert.ok(
    duplicateWorkbenchMigration.includes(fragment),
    `Duplicate workbench recovery migration is missing ${fragment}`,
  )
}

for (const fragment of [
  'unit_multiplier = 1',
  "packaging_state = 'not_required'",
  "array_remove(blocking_codes, 'packaging_required')",
  'line.unit_multiplier <> 1',
  'cartonization chooses',
]) {
  assert.ok(
    unitCartonizationMigration.includes(fragment),
    `Unit cartonization migration is missing ${fragment}`,
  )
}

for (const fragment of [
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '30s'",
  'SET LOCAL search_path = public, pg_catalog, pg_temp',
  'CREATE TABLE operations_commerce_order_workbench',
  'accepted_provider_source_hash',
  'ship_to_ciphertext bytea',
  "'local_missing'",
  "'local_incomplete'",
  "'local_carrier_ready'",
  "'local_only'",
  'operations_commerce_order_workbench_candidate_fkey',
  'operations_commerce_order_workbench_receipt_fkey',
  'accepted provider binding is immutable',
  'operations.commerce_order_workbench.refresh',
  'matching durable refresh receipt',
  'customer_global_id_draft text',
  'requested_delivery_at_draft timestamptz',
  'line_resolution_drafts jsonb',
  'operations_commerce_order_workbench_line_drafts_valid',
  'Commerce order working copy customer draft is invalid',
  'Commerce order working copy line draft is invalid',
]) {
  assert.ok(migration.includes(fragment), `0307 is missing ${fragment}`)
}
assert.equal(
  migration.includes('ALTER TABLE operations_orders'),
  false,
  '0307 must not weaken canonical operations orders',
)
assert.equal(
  migration.includes('ALTER TABLE operations_commerce_order_candidates'),
  false,
  '0307 must not reinterpret immutable intake candidates',
)

for (const fragment of [
  'readCommerceOrderWorkbenchFromPostgres',
  'updateCommerceOrderWorkbenchShipToInPostgres',
  'acceptCommerceOrderWorkbenchInPostgres',
  "sync_state = 'local_only'",
  'providerWrites: 0',
  'providerWriteIntentCreated: false',
  'expectedRowVersion',
  'operations_command_receipts',
  'recordAuditEvent',
  'OPERATIONS_IMPORTED_ORDER_PROTECTED_DATA_UNREADABLE',
  'selected_candidate_ids',
  "ILIKE $3 ESCAPE '!'",
  'latest_provider_source_hash',
  'confirmCommerceCandidateAddressInPostgres',
  'validateCommerceCandidateInPostgres',
  'promoteCommerceCandidateInPostgres',
  "promotionStatus: 'promoted'",
  "remainingBlockerCodes: ['provider_refresh_rebase_required']",
  'retained.canonical_order_id IS NULL',
  'retained_candidate.canonical_order_id IS NULL',
  'canonical_order_id = canonical.canonical_order_id',
  'mergeCommerceOrderWorkbenchProviderAddress',
  'mergeCommerceOrderWorkbenchRequestedDelivery',
  'mergeCommerceOrderWorkbenchLineDrafts',
  'rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres',
  'readCommerceOrderWorkbenchRefreshTargetFromPostgres',
  'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT',
  'provider_rebased',
  'resolveCommerceCandidateCustomerInPostgres',
  'resolveCommerceCandidateDeliveryInPostgres',
  'resolveCommerceCandidateProductInPostgres',
  'resolveCommerceCandidatePackageInPostgres',
  'applyWorkbenchResolutionDraft',
  'includeResolutionDetails',
  'preservedLineDrafts',
  "input.action === 'save'",
  'AS requires_carrier_address',
  'saved.candidate.requires_carrier_address',
  'requested_delivery_at_draft = $15::timestamptz',
  "field: 'requestedDeliveryAt'",
]) {
  assert.ok(persistence.includes(fragment), `Persistence is missing ${fragment}`)
}
assert.equal(
  persistence.includes('INSERT INTO operations_commerce_external_effect_intents'),
  false,
  'A local save must create zero provider-write intents',
)
assert.equal(
  /UPDATE operations_commerce_order_candidates/u.test(persistence),
  false,
  'A local save must not mutate the provider intake candidate',
)
assert.ok(
  persistence.indexOf("ILIKE $3 ESCAPE '!'")
    < persistence.indexOf('LIMIT 200`'),
  'Search must execute in SQL before the bounded result cap',
)
assert.equal(
  persistence.includes('.filter((order)'),
  false,
  'Bounded rows must not be filtered in memory after the SQL limit',
)

for (const fragment of [
  'export async function GET',
  'export async function PATCH',
  'export async function POST',
  "'resolution'",
  'resolutionDraftValue(body.resolution)',
  'includeResolutionDetails: true',
  'refreshCommerceOrderWorkbenchCandidate',
  'rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres',
  'acceptCommerceOrderWorkbenchInPostgres',
  'capabilities.canManage',
  'idempotencyKeyValue(req)',
]) {
  assert.ok(route.includes(fragment), `Route is missing ${fragment}`)
}

for (const fragment of [
  'refreshCommerceOrderWorkbenchCandidate',
  'runAutomaticOrderHooks: false',
  "action: 'refresh'",
  'confirmReadOnly: true',
]) {
  assert.ok(intake.includes(fragment), `Intake refresh is missing ${fragment}`)
}
assert.ok(
  candidateResolver.includes(
    "WHEN $2 = 'provider' THEN provider_requested_delivery_at",
  ),
  'Provider delivery resolution must preserve exact stored timestamp precision',
)
for (const fragment of [
  'readCurrentLineRuntimePackMapping',
  'resolveCommerceRuntimePack({',
  "packagingSource = mappedPackaging",
  "? 'variant_pack_mapping'",
  "array_remove(blocking_codes, 'product_mapping_required')",
  "'packaging_required'",
  'packResolution:',
]) {
  assert.ok(
    candidateResolver.includes(fragment),
    `Product resolution must reconcile the current mapped Product pack: ${fragment}`,
  )
}
for (const fragment of [
  'Review each local value changed by the provider refresh.',
  'Keep mine:',
  'Use {providerLabel(order!.provider)}:',
  'Use refreshed provider item',
  'It has not been discarded.',
  'Apply choices',
  'Accept &amp; import',
  "field === 'requestedDeliveryAt'",
  'savedDraftComplete',
  "shippingRequired && draftReadiness !== 'carrier_ready'",
  'Approved pack constraint (optional)',
  'No pack constraint — use cartonization',
  'Unit item — cartonization chooses outbound packaging.',
]) {
  assert.ok(drawer.includes(fragment), `Drawer refresh is missing ${fragment}`)
}
assert.equal(
  drawer.includes('!line.requiresShipping || draft.packageProfileGlobalId'),
  false,
  'The workbench must not require a manual legacy package profile when the mapped Product pack can be reconciled during acceptance',
)
assert.ok(
  persistence.includes('canonical.external_order_id = candidate.external_order_id'),
  'Already-canonical provider identities must not remain in the imported working-copy list',
)
assert.equal(
  /reasonValue|confirmationStatement|canActivate/u.test(route),
  false,
  'Ordinary local order edits must not require activation ceremony',
)
assert.ok(
  route.includes("'requestedDeliveryAt'"),
  'Refresh choices must accept an explicit requested-delivery resolution',
)
assert.ok(
  operationsRoute.includes('error instanceof CommerceOrderWorkbenchError'),
  'The ordinary Operations route must preserve safe workbench error codes',
)

assert.ok(
  operations.includes('readCommerceOrderWorkbenchFromPostgres'),
  'Operations workspace must load imported working copies',
)
assert.ok(
  operations.includes('importedOrders,'),
  'Operations workspace must expose imported working copies',
)
assert.ok(
  types.includes('importedOrders: OperationsImportedOrderWorkingCopy[]'),
  'Workspace contract must expose imported working copies',
)
for (const fragment of [
  'canonicalOrderGlobalId: string | null',
  "promotionStatus: 'not_ready' | 'needs_info' | 'promoted'",
  'remainingBlockerCodes: string[]',
  'resolutionDetailsLoaded: boolean',
  'OperationsImportedOrderWorkingCopyDraft',
  'requestedDeliveryAt: string | null',
]) {
  assert.ok(types.includes(fragment), `Result contract is missing ${fragment}`)
}

console.log('Commerce order workbench contract passed')
