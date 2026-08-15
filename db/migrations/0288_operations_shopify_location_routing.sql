-- Explicit Shopify location routing for read-only multi-location inventory.
-- Existing mappings remain import-enabled and ownership-unknown so the
-- current single-location path continues to work until the provider snapshot
-- is observed. Provider writes are deliberately outside this migration.

ALTER TABLE operations_commerce_inventory_location_mappings
  ADD COLUMN IF NOT EXISTS ownership_classification text NOT NULL
    DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS provider_snapshot_json jsonb NOT NULL
    DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_snapshot_hash text,
  ADD COLUMN IF NOT EXISTS provider_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS inventory_import_enabled boolean NOT NULL
    DEFAULT true;

ALTER TABLE operations_commerce_inventory_location_mappings
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_location_mappings_ownership_valid,
  ADD CONSTRAINT
    operations_commerce_inventory_location_mappings_ownership_valid CHECK (
      ownership_classification IN (
        'unknown', 'merchant_managed', 'fulfillment_service'
      )
    ),
  DROP CONSTRAINT IF EXISTS
    operations_commerce_inventory_location_mappings_snapshot_valid,
  ADD CONSTRAINT
    operations_commerce_inventory_location_mappings_snapshot_valid CHECK (
      jsonb_typeof(provider_snapshot_json) = 'object'
      AND (
        (
          provider_snapshot_hash IS NULL
          AND provider_observed_at IS NULL
          AND provider_snapshot_json = '{}'::jsonb
        )
        OR (
          provider_snapshot_hash ~ '^[a-f0-9]{64}$'
          AND provider_observed_at IS NOT NULL
        )
      )
    );

COMMENT ON COLUMN
  operations_commerce_inventory_location_mappings.ownership_classification IS
  'Last observed Shopify ownership class. unknown preserves legacy mappings; fulfillment_service is not authorization for ClawPilot provider writes.';

COMMENT ON COLUMN
  operations_commerce_inventory_location_mappings.provider_snapshot_json IS
  'Last redacted Shopify location snapshot used to verify the exact routing decision.';

COMMENT ON COLUMN
  operations_commerce_inventory_location_mappings.provider_snapshot_hash IS
  'SHA-256 of the canonical redacted provider location snapshot.';

COMMENT ON COLUMN
  operations_commerce_inventory_location_mappings.inventory_import_enabled IS
  'Explicit per-location read-only inventory import switch. This never grants Shopify write authority.';

-- Inventory positions are keyed by the physical ClawPilot projection target,
-- not by commerce account. Two stores must never own the same live balance or
-- one store's complete snapshot could overwrite/zero the other's quantities.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_commerce_inventory_active_projection_target
  ON operations_commerce_inventory_location_mappings (
    organization_id, warehouse_id, location_id, inventory_pool_id
  )
  WHERE active = true AND inventory_import_enabled = true;

COMMENT ON INDEX
  idx_operations_commerce_inventory_active_projection_target IS
  'One active import authority per exact ClawPilot warehouse/location/pool projection target across all commerce accounts.';

-- Nullable mapping fences preserve every legacy account-scoped queue row.
-- New jobs carry the complete mapping identity so a warehouse, internal
-- location, pool, provider location, or row-version change cancels stale work.
ALTER TABLE operations_shopify_inventory_refresh_jobs
  ADD COLUMN IF NOT EXISTS location_mapping_id uuid,
  ADD COLUMN IF NOT EXISTS location_mapping_row_version bigint,
  ADD COLUMN IF NOT EXISTS provider_location_id text,
  ADD COLUMN IF NOT EXISTS inventory_location_id uuid,
  ADD COLUMN IF NOT EXISTS inventory_pool_id uuid;

-- Mapped work uses a distinct lifecycle so binaries deployed before this
-- migration continue to infer their original account-wide ON CONFLICT index
-- and cannot claim new location-routed rows.
ALTER TABLE operations_shopify_inventory_refresh_jobs
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_jobs_status_check,
  ADD CONSTRAINT
    operations_shopify_inventory_refresh_jobs_status_check CHECK (
      status IN (
        'pending', 'processing', 'failed',
        'succeeded', 'cancelled', 'dead',
        'mapped_pending', 'mapped_processing', 'mapped_failed',
        'mapped_succeeded', 'mapped_cancelled', 'mapped_dead'
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_lease_valid,
  ADD CONSTRAINT operations_shopify_inventory_refresh_lease_valid CHECK (
    (
      status IN ('processing', 'mapped_processing')
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > locked_at
    )
    OR (
      status NOT IN ('processing', 'mapped_processing')
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
      AND lease_expires_at IS NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_completion_valid,
  ADD CONSTRAINT operations_shopify_inventory_refresh_completion_valid CHECK (
    (
      status IN (
        'succeeded', 'cancelled', 'dead',
        'mapped_succeeded', 'mapped_cancelled', 'mapped_dead'
      )
    ) = (completed_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_jobs_status_check;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT operations_shopify_inventory_refresh_lease_valid;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT operations_shopify_inventory_refresh_completion_valid;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_mapping_fence_complete,
  ADD CONSTRAINT
    operations_shopify_inventory_refresh_mapping_fence_complete CHECK (
      (
        location_mapping_id IS NULL
        AND location_mapping_row_version IS NULL
        AND provider_location_id IS NULL
        AND inventory_location_id IS NULL
        AND inventory_pool_id IS NULL
      )
      OR (
        location_mapping_id IS NOT NULL
        AND location_mapping_row_version IS NOT NULL
        AND location_mapping_row_version >= 0
        AND provider_location_id IS NOT NULL
        AND length(btrim(provider_location_id)) BETWEEN 1 AND 512
        AND provider_location_id !~ '[[:cntrl:]]'
        AND inventory_location_id IS NOT NULL
        AND inventory_pool_id IS NOT NULL
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_mapping_status_consistent,
  ADD CONSTRAINT
    operations_shopify_inventory_refresh_mapping_status_consistent CHECK (
      (
        location_mapping_id IS NULL
        AND status NOT LIKE 'mapped_%'
      )
      OR (
        location_mapping_id IS NOT NULL
        AND status LIKE 'mapped_%'
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_mapping_fkey,
  ADD CONSTRAINT operations_shopify_inventory_refresh_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, location_mapping_id
    ) REFERENCES operations_commerce_inventory_location_mappings (
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_inventory_location_fkey,
  ADD CONSTRAINT operations_shopify_inventory_refresh_inventory_location_fkey
    FOREIGN KEY (organization_id, warehouse_id, inventory_location_id)
    REFERENCES operations_locations (organization_id, warehouse_id, id)
    ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS
    operations_shopify_inventory_refresh_inventory_pool_fkey,
  ADD CONSTRAINT operations_shopify_inventory_refresh_inventory_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools (organization_id, id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_mapping_fence_complete;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_mapping_status_consistent;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_mapping_fkey;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_inventory_location_fkey;

ALTER TABLE operations_shopify_inventory_refresh_jobs
  VALIDATE CONSTRAINT
    operations_shopify_inventory_refresh_inventory_pool_fkey;

-- Keep idx_operations_shopify_inventory_refresh_active_account unchanged.
-- Old binaries infer it using the exact legacy status predicate. Mapped
-- statuses remain outside that predicate and receive their own invariants.

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_active_mapping
  ON operations_shopify_inventory_refresh_jobs (
    organization_id, integration_account_id, location_mapping_id
  )
  WHERE location_mapping_id IS NOT NULL
    AND status IN (
      'mapped_pending', 'mapped_processing', 'mapped_failed'
    );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_processing_account
  ON operations_shopify_inventory_refresh_jobs (
    organization_id, integration_account_id
  )
  WHERE status = 'mapped_processing';

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_mapping_history
  ON operations_shopify_inventory_refresh_jobs (
    organization_id,
    integration_account_id,
    location_mapping_id,
    requested_dirty_version DESC,
    created_at DESC,
    id DESC
  );

COMMENT ON COLUMN
  operations_shopify_inventory_refresh_jobs.location_mapping_id IS
  'Exact Shopify-location-to-ClawPilot-location mapping. NULL identifies a legacy single-location queue job.';

COMMENT ON INDEX
  idx_operations_shopify_inventory_refresh_processing_account IS
  'At most one mapped provider inventory read may process for a Shopify account. Legacy processing remains guarded by the pre-existing provider-attempt singleflight during a rolling deployment.';
