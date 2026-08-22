#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [
  migration,
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
  'Review each local value changed by the provider refresh.',
  'Keep mine:',
  'Use {providerLabel(order!.provider)}:',
  'Use refreshed provider item',
  'It has not been discarded.',
  'Apply choices',
  'Accept &amp; import',
]) {
  assert.ok(drawer.includes(fragment), `Drawer refresh is missing ${fragment}`)
}
assert.equal(
  /reasonValue|confirmationStatement|canActivate/u.test(route),
  false,
  'Ordinary local order edits must not require activation ceremony',
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
