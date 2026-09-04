#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const migration = read(
  'db/migrations/0351_operations_commerce_storage_bloat_guard.sql',
)
for (const contract of [
  'response_purged_at',
  'purge_operations_commerce_intake_read_payloads',
  "intent.intent_state = 'staged' AND intent.staged_run_id IS NOT NULL",
  "intent.expires_at <= now()",
  'FOR UPDATE SKIP LOCKED',
  'level_set_hash',
  'source_level_set_run_id',
  'operations_provider_commitment_current_support',
  'latest_run.source_level_set_run_id, latest_run.id',
  'payload_purged_at',
  'purge_operations_commerce_inventory_snapshot_payloads',
  'operations_commerce_inventory_snapshot_content_is_purgeable',
  'inventorySnapshotPayloadBacklogRows',
  'inventorySnapshotContentStorageBytes',
  'inventorySnapshotLivePayloadHardCapPerAccountLocation',
  'inventorySnapshotLivePayloadSoftCapAfter30Days',
  'operations_commerce_storage_maintenance_lanes',
  'claim_operations_commerce_storage_maintenance',
  'renew_operations_commerce_storage_maintenance',
  'complete_operations_commerce_storage_maintenance',
  'purge_operations_commerce_inventory_observation_aliases',
  'purge_operations_commerce_inventory_level_evidence',
  'convert_operations_commerce_inventory_legacy_captures',
  'operations_reservations',
  'operations_cartonization_rate_evidence',
  'last_reconciled_run_global_id',
  'operations_commerce_storage_bloat_health',
  'inventoryObservationAliasBacklogRows',
  'inventoryLevelBacklogRows',
  'inventoryObservationHardCapPerAccountLocation',
  'inventoryFullLevelSetHardCapPerAccountLocation',
  'inventoryFullLevelSetSoftCapAfter90Days',
]) {
  assert.ok(migration.includes(contract), `Migration is missing ${contract}`)
}
assert.doesNotMatch(migration, /watermark\.reconciled_run_id/)
assert.match(
  migration,
  /response_ciphertext = NULL,[\s\S]*response_iv = NULL,[\s\S]*response_tag = NULL,[\s\S]*response_purged_at = now\(\)/,
)
assert.match(
  migration,
  /ranked\.observation_rank > 128[\s\S]*DELETE FROM operations_commerce_inventory_sync_runs/,
)
assert.match(
  migration,
  /ranked\.evidence_rank > 128[\s\S]*DELETE FROM operations_commerce_inventory_levels/,
)
assert.match(
  migration,
  /payload_rank > 32[\s\S]*snapshot_content = NULL,[\s\S]*payload_purged_at = now\(\)/,
)
assert.match(
  migration,
  /capture\.snapshot_content_id = ranked\.id[\s\S]*attempt\.state = 'prepared'/,
  'Prepared provider attempts must pin replayable inventory payloads',
)
assert.ok(migration.includes('pg_advisory_xact_lock(hashtextextended('))
assert.ok(migration.includes('commerce-inventory-snapshot-content:'))
const snapshotPayloadPurgeStart = migration.indexOf(
  'CREATE OR REPLACE FUNCTION\n  purge_operations_commerce_inventory_snapshot_payloads',
)
const snapshotPayloadPurgeEnd = migration.indexOf(
  '-- Both foreground workers may offer to maintain storage every ten seconds.',
)
assert.ok(
  snapshotPayloadPurgeStart >= 0
    && snapshotPayloadPurgeEnd > snapshotPayloadPurgeStart,
)
const snapshotPayloadPurge = migration.slice(
  snapshotPayloadPurgeStart,
  snapshotPayloadPurgeEnd,
)
assert.doesNotMatch(
  snapshotPayloadPurge,
  /FOR (?:NO KEY )?UPDATE OF content/,
  'Snapshot purge candidates must not row-lock before the identity lock',
)
const snapshotPayloadAdvisoryLock = snapshotPayloadPurge.indexOf(
  'pg_advisory_xact_lock(hashtextextended(',
)
const snapshotPayloadRowLock = snapshotPayloadPurge.indexOf(
  'UPDATE operations_commerce_inventory_snapshot_contents content',
)
assert.ok(
  snapshotPayloadAdvisoryLock >= 0
    && snapshotPayloadRowLock > snapshotPayloadAdvisoryLock,
  'Snapshot purge must take the identity lock before its content-row lock',
)
const postgresAcceptance = read(
  'scripts/test-commerce-storage-bloat-guard-postgres.mjs',
)
const concurrencyAcceptanceStart = postgresAcceptance.indexOf(
  'async function testConcurrentPreparedCaptureAndPurge()',
)
const concurrencyAcceptanceEnd = postgresAcceptance.indexOf(
  '\nconst client = await pool.connect()',
)
assert.ok(
  concurrencyAcceptanceStart >= 0
    && concurrencyAcceptanceEnd > concurrencyAcceptanceStart,
)
const concurrencyAcceptance = postgresAcceptance.slice(
  concurrencyAcceptanceStart,
  concurrencyAcceptanceEnd,
)
assert.doesNotMatch(
  concurrencyAcceptance,
  /session_replication_role\s*=\s*'replica'/,
  'The lock-order acceptance fixture must keep production triggers and FKs on',
)
for (const contract of [
  "replication_role: 'origin'",
  'validation_trigger_enabled: true',
  'snapshot_content_fkey_exists: true',
  "activity.rows[0]?.wait_event === 'advisory'",
]) {
  assert.ok(
    concurrencyAcceptance.includes(contract),
    `The production lock-order acceptance test is missing ${contract}`,
  )
}
assert.equal(
  (migration.match(/LANGUAGE (?:plpgsql|sql)/gu) || []).length,
  (migration.match(/SET search_path = pg_catalog, public/gu) || []).length,
  'Every storage-guard function must pin its search path',
)
assert.match(
  migration,
  /latest_run\.id[\s\S]*level\.sync_run_id = COALESCE\([\s\S]*latest_run\.source_level_set_run_id, latest_run\.id/,
)

const intake = read('app_src/lib/persistence/commerceIntake.ts')
assert.match(
  intake,
  /SET intent_state = 'staged',[\s\S]*staged_run_id = \$2::uuid,[\s\S]*response_ciphertext = NULL,[\s\S]*response_purged_at = now\(\)/,
)

const inventory = read('app_src/lib/persistence/commerceInventory.ts')
for (const contract of [
  'inventoryLevelSetHash',
  'source_level_set_run_id IS NOT NULL AS level_set_reused',
  'run.source_level_set_run_id IS NULL',
  'if (evidenceRows.length && !reusableLevelSet)',
  'COALESCE(source_level_set_run_id, id)',
  'commerce-inventory-snapshot-content',
  'acquireTransactionAdvisoryLock',
]) {
  assert.ok(inventory.includes(contract), `Inventory writer is missing ${contract}`)
}

for (const reader of [
  'app_src/lib/persistence/cartonizationPreview.ts',
  'app_src/lib/persistence/hybridCartonization.ts',
  'app_src/lib/persistence/operations.ts',
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
]) {
  assert.ok(
    read(reader).includes('COALESCE('),
    `${reader} does not resolve aliased level evidence`,
  )
}

const maintenance = read(
  'app_src/lib/persistence/commerceStorageMaintenance.ts',
)
for (const worker of [
  'app_src/lib/commerceOrderReconciliationWorker.ts',
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
]) {
  assert.ok(
    read(worker).includes('maintainCommerceStorageInPostgres'),
    `${worker} does not run bounded storage maintenance`,
  )
}
assert.match(maintenance, /inventoryLevelLimit,[\s\S]*10000/)
assert.match(maintenance, /input\.inventoryLevelLimit,[\s\S]*10000,[\s\S]*10000/)
assert.match(maintenance, /LEVEL_PURGE_PASSES_PER_LEASE = 12/)
assert.match(maintenance, /claim_operations_commerce_storage_maintenance/)
assert.match(maintenance, /renew_operations_commerce_storage_maintenance/)
assert.match(maintenance, /purge_operations_commerce_inventory_snapshot_payloads/)
assert.match(maintenance, /status: 'failed'/)
assert.match(maintenance, /status: 'lease_lost'/)
assert.doesNotMatch(
  maintenance,
  /operations_commerce_storage_bloat_health\(/,
  'Runtime liveness must use persisted maintenance state, not ranked scans',
)

const onlineMigration = read(
  'db/migrations/0352_operations_commerce_storage_bloat_guard_online.sql',
)
assert.ok(onlineMigration.startsWith('-- clawpilot:migration-mode=nontransactional'))
assert.match(onlineMigration, /CREATE UNIQUE INDEX CONCURRENTLY/)
assert.equal((onlineMigration.match(/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY/gmu) || []).length, 6)
assert.equal((onlineMigration.match(/^DROP INDEX CONCURRENTLY/gmu) || []).length, 6)
assert.match(
  onlineMigration,
  /VALIDATE CONSTRAINT operations_commerce_inventory_level_set_source_fkey/,
)
assert.match(
  migration,
  /operations_commerce_inventory_level_set_source_fkey[\s\S]*ON DELETE RESTRICT NOT VALID/,
)
const migrator = read('scripts/db-migrate.mjs')
for (const contract of [
  'clawpilot:migration-mode=nontransactional',
  'clawpilot:migration-statement-break',
  "SET lock_timeout = '5s'",
  'SET statement_timeout = 0',
  'query_timeout: 0',
  'recordAppliedMigration',
]) {
  assert.ok(migrator.includes(contract), `Online migration runner is missing ${contract}`)
}
const preflight = read('scripts/preflight-commerce-storage-guard.mjs')
for (const contract of [
  'pg_total_relation_size',
  'pg_stat_activity',
  'pg_locks',
  "interval '5 minutes'",
  'invalidIndexes',
]) {
  assert.ok(preflight.includes(contract), `Storage preflight is missing ${contract}`)
}

const inventoryRefreshWorker = read(
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
)
assert.match(
  inventoryRefreshWorker,
  /syncShopifyInventory\([\s\S]*await maintainInventoryCommerceStorageSafely/,
  'Inventory refresh must run bounded storage maintenance after a committed snapshot',
)

const canonicalPlanningPostgres = read(
  'scripts/test-canonical-fulfillment-planning-postgres.mjs',
)
for (const contract of [
  'appendUnchangedShopifyInventoryObservation',
  'source_level_set_run_id',
  "SET status = 'consumed', released_at = now()",
]) {
  assert.ok(
    canonicalPlanningPostgres.includes(contract),
    `Canonical provider-commitment acceptance is missing ${contract}`,
  )
}

const operations = read('app_src/lib/persistence/operations.ts')
for (const contract of [
  'JOIN operations_commerce_inventory_sync_runs evidence_run',
  'level.sync_run_id = COALESCE(',
  'level.sync_run_id::text AS inventory_sync_run_id',
  'position.inventory_sync_run_id',
]) {
  assert.ok(
    operations.includes(contract),
    `Operations planning is missing alias/source evidence contract ${contract}`,
  )
}
const healthRoute = read('app_src/app/api/health/route.ts')
assert.ok(healthRoute.includes('readCommerceStorageBloatHealthFromPostgres'))
assert.ok(healthRoute.includes("maintenanceDegraded ? 'degraded' : 'ready'"))
assert.ok(healthRoute.includes('Commerce storage maintenance has an expired lease.'))
assert.ok(healthRoute.includes('Commerce storage maintenance recently failed'))
assert.ok(!healthRoute.includes("'inventorySnapshotPayloadBacklogRows',"))

const ordersProcessRoute = read(
  'app_src/app/api/integrations/commerce/orders/process/route.ts',
)
assert.ok(
  ordersProcessRoute.indexOf('const commerceStorageMaintenance =')
    < ordersProcessRoute.indexOf('if (!commerceReadRuntimeAvailable())'),
  'Order-route storage maintenance must run before its provider-disabled guard',
)
const inventoryProcessRoute = read(
  'app_src/app/api/integrations/commerce/inventory/process/route.ts',
)
assert.ok(
  inventoryProcessRoute.indexOf('const commerceStorageMaintenance =')
    < inventoryProcessRoute.indexOf('const shopifyEnabled ='),
  'Inventory-route storage maintenance must run before provider-disabled guards',
)

console.log('commerce storage bloat guard contracts passed')
