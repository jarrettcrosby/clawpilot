-- clawpilot:migration-mode=nontransactional
-- Build production-sized storage-guard indexes without holding an exclusive
-- migration transaction. Each drop/create pair is deliberately retryable: a
-- failed CREATE INDEX CONCURRENTLY can leave an invalid index, and the next
-- migration attempt removes that exact artifact before rebuilding it.

DROP INDEX CONCURRENTLY IF EXISTS
  commerce_intake_read_intents_payload_purge_idx;
-- clawpilot:migration-statement-break
CREATE INDEX CONCURRENTLY commerce_intake_read_intents_payload_purge_idx
  ON operations_commerce_intake_read_intents (
    intent_state, expires_at, updated_at, id
  )
  WHERE response_ciphertext IS NOT NULL;
-- clawpilot:migration-statement-break
DROP INDEX CONCURRENTLY IF EXISTS
  operations_commerce_inventory_level_set_reuse_idx;
-- clawpilot:migration-statement-break
CREATE INDEX CONCURRENTLY operations_commerce_inventory_level_set_reuse_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, location_mapping_id,
    level_set_hash, completed_at DESC, id DESC
  )
  WHERE status = 'succeeded' AND level_set_hash IS NOT NULL;
-- clawpilot:migration-statement-break
DROP INDEX CONCURRENTLY IF EXISTS
  operations_commerce_inventory_level_set_source_idx;
-- clawpilot:migration-statement-break
CREATE INDEX CONCURRENTLY operations_commerce_inventory_level_set_source_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, source_level_set_run_id
  )
  WHERE source_level_set_run_id IS NOT NULL;
-- clawpilot:migration-statement-break
DROP INDEX CONCURRENTLY IF EXISTS
  operations_commerce_inventory_retention_idx;
-- clawpilot:migration-statement-break
CREATE INDEX CONCURRENTLY operations_commerce_inventory_retention_idx
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, location_mapping_id,
    completed_at DESC, id DESC
  )
  WHERE status = 'succeeded';
-- clawpilot:migration-statement-break
DROP INDEX CONCURRENTLY IF EXISTS
  operations_commerce_inventory_snapshot_contents_hash_unique;
-- clawpilot:migration-statement-break
CREATE UNIQUE INDEX CONCURRENTLY
  operations_commerce_inventory_snapshot_contents_hash_unique
  ON operations_commerce_inventory_snapshot_contents (
    organization_id, integration_account_id, provider_location_id,
    adapter_version, snapshot_hash
  )
  WHERE snapshot_content IS NOT NULL;
-- clawpilot:migration-statement-break
DROP INDEX CONCURRENTLY IF EXISTS
  operations_commerce_inventory_snapshot_payload_retention_idx;
-- clawpilot:migration-statement-break
CREATE INDEX CONCURRENTLY
  operations_commerce_inventory_snapshot_payload_retention_idx
  ON operations_commerce_inventory_snapshot_contents (
    organization_id, integration_account_id, provider_location_id,
    created_at DESC, id DESC
  )
  WHERE snapshot_content IS NOT NULL;
-- clawpilot:migration-statement-break
ALTER TABLE operations_commerce_inventory_sync_runs
  VALIDATE CONSTRAINT operations_commerce_inventory_level_set_source_fkey;
