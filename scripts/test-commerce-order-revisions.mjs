import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFile(path.join(root, relative), 'utf8')

const [
  migration,
  applyMigration,
  persistence,
  evidence,
  intake,
  adapter,
  worker,
  faireWorker,
  operations,
  route,
  workspace,
  operationShipping,
  productionRerates,
  healthRoute,
  reconciliationWorker,
] = await Promise.all([
  read('db/migrations/0273_operations_commerce_order_revisions.sql'),
  read('db/migrations/0274_operations_commerce_order_revision_apply.sql'),
  read('app_src/lib/persistence/commerceOrderRevisions.ts'),
  read('app_src/lib/integrations/commerceOrderRevisionEvidence.ts'),
  read('app_src/lib/integrations/commerceIntake.ts'),
  read('app_src/lib/integrations/shopifyOrderRevision.ts'),
  read('app_src/lib/commerceShopifyOrderRevisionWorker.ts'),
  read('app_src/lib/commerceFaireOrderRevisionWorker.ts'),
  read('app_src/lib/persistence/operations.ts'),
  read('app_src/app/api/operations/route.ts'),
  read('app_src/components/operations/OperationsSection.tsx'),
  read('app_src/lib/persistence/operationShipping.ts'),
  read('app_src/lib/operations/productionFulfillmentRerates.ts'),
  read('app_src/app/api/health/route.ts'),
  read('app_src/lib/commerceOrderReconciliationWorker.ts'),
])

assert.match(migration, /operations_commerce_order_revision_observations/u)
assert.match(migration, /BEFORE UPDATE OR DELETE/u)
assert.match(migration, /commerce order revision observations are immutable/u)
assert.match(migration, /provider_write_count integer NOT NULL CHECK \(provider_write_count = 0\)/u)
assert.match(applyMigration, /purge_expired_ocr_protected_snapshots/u)
assert.match(migration, /UNIQUE \(organization_id, integration_account_id, order_id, source_hash\)/u)
assert.match(migration, /AFTER INSERT ON operations_orders/u)
assert.match(migration, /WHERE order_row\.source_provider IN \('shopify', 'faire'\)/u)
assert.match(migration, /order_row\.status NOT IN \('shipped', 'cancelled'\)/u)
assert.match(migration, /lock_token uuid/u)
assert.match(migration, /claim_state = 'processing'[\s\S]{0,100}lock_token IS NOT NULL/u)
assert.match(migration, /operations_commerce_order_revision_dispositions/u)
assert.match(migration, /action text NOT NULL CHECK \(action = 'cancel_unstarted_order'\)/u)
assert.match(migration, /commerce order revision dispositions are immutable/u)
assert.match(migration, /commerce order revision exceptions require immutable disposition evidence/u)
assert.match(migration, /provider_write_count integer NOT NULL CHECK \(provider_write_count = 0\)/u)

for (const exportedContract of [
  'claimCommerceOrderRevisionTargetsInPostgres',
  'assertCommerceOrderRevisionStoreSyncRunningInPostgres',
  'captureCommerceOrderRevisionObservationInPostgres',
  'failCommerceOrderRevisionTargetInPostgres',
  'assertCommerceOrderRevisionExecutionCurrent',
  'readCommerceOrderRevisionHealthFromPostgres',
  'purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres',
  'cancelUnstartedCommerceOrderFromProviderRevisionInPostgres',
  'CommerceOrderRevisionDispositionError',
  'CommerceOrderRevisionStoreSyncPausedError',
]) {
  assert.match(persistence, new RegExp(`export (?:async )?(?:function|class) ${exportedContract}`))
}
assert.match(persistence, /FOR UPDATE OF target SKIP LOCKED/u)
for (const [source, adapterName] of [
  [worker, 'inspectShopifyCanonicalOrderRevision'],
  [faireWorker, 'inspectFaireCanonicalOrderRevision'],
]) {
  assert.ok(
    source.indexOf(
      'await assertCommerceOrderRevisionStoreSyncRunningInPostgres(claim)',
    ) < source.indexOf(
      'await withCommerceStoreSyncProviderReadFenceInPostgres({',
    ),
    'Revision work must recheck the exact claim before its shared provider fence',
  )
  assert.match(
    source,
    new RegExp(
      `read: async \\(providerReadLease\\) => \\{[\\s\\S]*`
        + `await ${adapterName}\\(claim\\)[\\s\\S]*providerReadLease`,
    ),
    'Revision provider I/O must run inside the shared Store sync lock',
  )
}
assert.match(worker, /error instanceof CommerceOrderRevisionStoreSyncPausedError/u)
assert.match(persistence, /COMMERCE_ORDER_REVISION_STORE_SYNC_PAUSED/u)
assert.match(persistence, /claim_state = 'processing'/u)
assert.match(persistence, /lock_token = gen_random_uuid\(\)/u)
assert.match(persistence, /target\.lock_token = \$4::uuid/u)
assert.match(persistence, /AND lock_token = \$4::uuid/u)
assert.match(persistence, /locked_until > now\(\)/u)
assert.match(persistence, /providerWrites !== 0/u)
assert.match(persistence, /managerDispositionRequired: state !== 'current'/u)
assert.match(persistence, /exception_type = \$3/u)
assert.match(persistence, /'critical', 'open'/u)
assert.match(persistence, /COMMERCE_ORDER_REVISION_REVIEW_REQUIRED/u)
assert.match(persistence, /CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT/u)
assert.match(persistence, /order_row\.status NOT IN \('shipped', 'cancelled'\)/u)
assert.match(persistence, /target\.material_state = 'provider_cancelled'/u)
assert.match(persistence, /observation\.provider_write_count = 0/u)
for (const downstreamTable of [
  'operations_fulfillment_plans',
  'operations_reservations',
  'operations_pick_tasks',
  'operations_packages',
  'operations_labels',
  'operations_shipments',
  'operations_commerce_fulfillment_exports',
  'operations_fulfillment_executions',
  'operations_active_fulfillment_executions',
]) assert.match(persistence, new RegExp(downstreamTable))
assert.match(persistence, /status = 'cancelled', row_version = row_version \+ 1/u)
assert.match(persistence, /providerWrites: 0 as const/u)
assert.match(
  persistence,
  /WHERE filename = \$1[\s\S]{0,100}\[REVISION_APPLY_MIGRATION\]/u,
  'protected snapshot purge must skip safely before 0274 is recorded',
)
assert.match(
  persistence,
  /purge_expired_ocr_protected_snapshots\(\$1\)::integer/u,
)
assert.match(persistence, /PROTECTED_SNAPSHOT_PURGE_MAX_LIMIT = 500/u)
assert.match(persistence, /expiredProtectedReadBacklog/u)
assert.match(
  reconciliationWorker,
  /purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres\(\{[\s\S]{0,100}limit: PROTECTED_SNAPSHOT_PURGE_LIMIT_PER_CYCLE/u,
)
assert.ok(
  reconciliationWorker.indexOf(
    'purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres({',
  ) < reconciliationWorker.indexOf('if (!commerceReadRuntimeAvailable())'),
  'protected snapshot retention must run before the commerce-intake early return',
)
assert.match(persistence, /operations:order:\$\{input\.organizationId\}:\$\{input\.orderGlobalId\}/u)
assert.match(operations, /COMMERCE_ORDER_REVISION_DISPOSITION_REQUIRED/u)
assert.match(evidence, /externalAccountId: source\.externalAccountId/u)
assert.doesNotMatch(evidence, /observedAt: source\.observedAt/u)

const exactReadStart = intake.indexOf(
  'export async function readCommerceShopifyOrderRevisionEnvelope',
)
assert.ok(exactReadStart >= 0, 'Shopify exact revision read must be exported')
const exactRead = intake.slice(exactReadStart, exactReadStart + 3_800)
assert.match(exactRead, /shopifyEnvelope\(runtime,/u)
assert.match(exactRead, /input\.externalOrderId/u)
assert.doesNotMatch(exactRead, /status:open/u)
assert.match(exactRead, /providerWrites: 0 as const/u)

assert.match(adapter, /shopify-canonical-order-revision-v1/u)
assert.match(adapter, /partyFingerprint/u)
assert.match(adapter, /shipToFingerprint/u)
assert.doesNotMatch(adapter, /shippingAddress/u)
assert.match(adapter, /sourceRevision: input\.order\.providerUpdatedAt \|\| input\.order\.sourceHash/u)
assert.match(adapter, /providerWrites: 0 as const/u)
assert.match(adapter, /commerceOrderRevisionHash\(snapshot\)/u)
assert.match(adapter, /encryptCommerceOrderRevisionProtectedSnapshot/u)
assert.match(adapter, /commerceOrderRevisionProtectedContentFingerprint/u)
assert.doesNotMatch(adapter, /shippingAddress/u)

assert.match(worker, /claimCommerceOrderRevisionTargetsInPostgres/u)
assert.match(worker, /captureCommerceOrderRevisionObservationInPostgres/u)
assert.match(worker, /failCommerceOrderRevisionTargetInPostgres/u)
assert.match(worker, /canonicalOrderWrites: 0 as const/u)
assert.match(worker, /managerDispositionRequired: changed/u)

for (const operation of ['plan', 'release', 'assign', 'pick', 'pack', 'ship']) {
  assert.match(
    operations,
    new RegExp(`requireCurrentCommerceOrderRevision\\(client, \\{[\\s\\S]{0,160}operation: '${operation}'`),
  )
}
const wearableScanStart = operations.indexOf(
  'export async function recordWearablePickScanEvidenceFromPostgres',
)
const wearableEvidenceInsert = operations.indexOf(
  'INSERT INTO operations_wearable_pick_scan_evidence',
  wearableScanStart,
)
assert.ok(wearableScanStart >= 0 && wearableEvidenceInsert > wearableScanStart)
assert.match(
  operations.slice(wearableScanStart, wearableEvidenceInsert),
  /requireCurrentCommerceOrderRevision\(client, \{[\s\S]{0,160}operation: 'pick'/u,
)
for (const operation of ['prepare_fulfillment', 'packing_slip', 'export']) {
  assert.match(
    operations,
    new RegExp(`requireCurrentCommerceOrderRevision\\(client, \\{[\\s\\S]{0,180}operation: '${operation}'`),
  )
}
assert.match(operationShipping, /operation: 'label'/u)
const labelPrepareStart = operationShipping.indexOf('async function prepareAttempt')
const labelCreateStart = operationShipping.indexOf(
  'export async function createOperationsSandboxLabelInPostgres',
)
const labelProviderCall = operationShipping.indexOf(
  'providerResult = await createCarrierSandboxLabel({',
  labelCreateStart,
)
assert.ok(labelPrepareStart >= 0 && labelCreateStart >= 0 && labelProviderCall > labelCreateStart)
assert.match(
  operationShipping.slice(labelPrepareStart, labelCreateStart),
  /await requireCurrentCommerceRevisionForLabel/u,
)
assert.ok(
  operationShipping.indexOf('const prepared = await prepareAttempt({', labelCreateStart)
    < labelProviderCall,
  'revision-gated label attempt must be prepared before the carrier call',
)
for (const operation of ['rate', 'select_rate', 'label']) {
  assert.match(productionRerates, new RegExp(`operation: '${operation}'`))
}

assert.match(route, /action === 'accept-provider-order-cancellation'/u)
assert.match(route, /idempotencyKeyValue\(req\)/u)
assert.match(workspace, /Accept provider cancellation/u)
assert.match(workspace, /operations-provider-cancel:\$\{command\.readGlobalId\}/u)

assert.match(healthRoute, /readCommerceOrderRevisionHealthFromPostgres/u)
assert.match(healthRoute, /0273_operations_commerce_order_revisions\.sql/u)
assert.match(healthRoute, /operations_commerce_order_revisions_applied/u)
assert.match(
  healthRoute,
  /row\?\.operations_commerce_order_revision_apply_applied\s*\? await readCommerceOrderRevisionHealthFromPostgres\(\)\s*: null/u,
)
assert.ok(
  healthRoute.indexOf('const canonicalOrderRevisionHealth =')
    < healthRoute.indexOf('commerceReadRuntimeAvailable()'),
  'protected revision evidence health must remain visible when provider reads are disabled',
)
assert.match(healthRoute, /canonicalOrderRevisions: \{[\s\S]{0,220}heartbeat:[\s\S]{0,120}durable:/u)
assert.match(healthRoute, /expiredProtectedReadBacklog/u)
assert.match(healthRoute, /canonicalOrderRevisionHealth\?\.summary\.failed/u)
assert.match(healthRoute, /canonicalOrderRevisionHealth\?\.summary\.deadLetter/u)
assert.match(healthRoute, /canonicalOrderRevisionHealth\?\.summary\.materialReviewRequired/u)
assert.match(healthRoute, /canonicalOrderRevisionHealth\?\.summary\.overdue/u)
assert.match(healthRoute, /canonicalOrderRevisionHealth\?\.summary\.stale/u)

console.log('Commerce order revision observation and unstarted-cancellation contracts passed')
