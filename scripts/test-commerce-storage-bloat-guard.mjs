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

const inventoryRefreshWorker = read(
  'app_src/lib/shopifyInventoryRefreshWorker.ts',
)
assert.match(
  inventoryRefreshWorker,
  /syncShopifyInventory\([\s\S]*await maintainCommerceStorageInPostgres/,
  'Inventory refresh must run bounded storage maintenance after a committed snapshot',
)

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
assert.ok(
  read('app_src/app/api/health/route.ts')
    .includes('readCommerceStorageBloatHealthFromPostgres'),
)

console.log('commerce storage bloat guard contracts passed')
