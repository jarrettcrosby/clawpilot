-- Read-only Shopify inventory reconciliation for the development commerce
-- workflow. Provider quantity states remain immutable evidence. The projected
-- Operations position uses available + committed as its operational on-hand
-- balance and committed as its already-reserved balance, so Shopify's
-- available-to-promise quantity is preserved without subtracting imported
-- order demand a second time.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gilm', 'operations.commerce_inventory_location_mapping', 'Commerce inventory location mapping'),
  ('gisc', 'operations.commerce_inventory_capture', 'Commerce inventory capture'),
  ('gisr', 'operations.commerce_inventory_sync_run', 'Commerce inventory sync run'),
  ('giil', 'operations.commerce_inventory_level', 'Commerce inventory level')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_inventory_positions
  ADD COLUMN IF NOT EXISTS source_authority text NOT NULL
    DEFAULT 'clawpilot';

ALTER TABLE operations_inventory_positions
  DROP CONSTRAINT IF EXISTS operations_inventory_positions_source_authority_valid,
  ADD CONSTRAINT operations_inventory_positions_source_authority_valid CHECK (
    source_authority IN ('clawpilot', 'shopify')
  );

ALTER TABLE operations_inventory_ledger
  ADD COLUMN IF NOT EXISTS source_authority text NOT NULL
    DEFAULT 'clawpilot';

ALTER TABLE operations_inventory_ledger
  DROP CONSTRAINT IF EXISTS operations_inventory_ledger_source_authority_valid,
  ADD CONSTRAINT operations_inventory_ledger_source_authority_valid CHECK (
    source_authority IN ('clawpilot', 'shopify')
  );

CREATE OR REPLACE FUNCTION protect_shopify_inventory_position()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_authority = 'shopify'
       AND current_setting(
         'clawpilot.shopify_inventory_sync', true
       ) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION
        'Shopify-authoritative inventory positions can only be created through reconciliation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.source_authority IS DISTINCT FROM OLD.source_authority THEN
    RAISE EXCEPTION
      'Inventory position source authority is immutable';
  END IF;

  IF OLD.source_authority = 'shopify'
     AND current_setting(
       'clawpilot.shopify_inventory_sync', true
     ) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'Shopify-authoritative inventory positions can only change through reconciliation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_inventory_position_write
  ON operations_inventory_positions;
CREATE TRIGGER protect_shopify_inventory_position_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_inventory_positions
FOR EACH ROW EXECUTE FUNCTION protect_shopify_inventory_position();

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_locations_org_warehouse_id
  ON operations_locations (organization_id, warehouse_id, id);

CREATE TABLE IF NOT EXISTS operations_commerce_inventory_location_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gilm'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  external_location_id text NOT NULL,
  external_location_name text NOT NULL,
  external_location_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  mapping_method text NOT NULL CHECK (
    mapping_method IN ('automatic_single_location', 'automatic_exact_address', 'manual')
  ),
  active boolean NOT NULL DEFAULT true,
  row_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_inventory_location_mappings_global_valid
    CHECK (global_id ~ '^gilm[0-9]{7}$'),
  CONSTRAINT operations_commerce_inventory_location_mappings_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_inventory_location_mappings_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_warehouse_location_fkey
    FOREIGN KEY (organization_id, warehouse_id, location_id)
    REFERENCES operations_locations(organization_id, warehouse_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_location_mappings_location_present
    CHECK (
      length(btrim(external_location_id)) BETWEEN 1 AND 512
      AND external_location_id !~ '[[:cntrl:]]'
      AND length(btrim(external_location_name)) BETWEEN 1 AND 255
      AND external_location_name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_commerce_inventory_location_mappings_external_unique
    UNIQUE (organization_id, integration_account_id, external_location_id),
  CONSTRAINT operations_commerce_inventory_location_mappings_warehouse_unique
    UNIQUE (organization_id, integration_account_id, warehouse_id),
  CONSTRAINT operations_commerce_inventory_location_mappings_account_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_commerce_inventory_location_mappings_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_commerce_inventory_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gisc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  adapter_version text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  provider_location_id text NOT NULL,
  provider_fetched_at timestamptz NOT NULL,
  level_count integer NOT NULL CHECK (level_count >= 0),
  captured_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(captured_snapshot) = 'object'
  ),
  snapshot_bytes integer NOT NULL CHECK (
    snapshot_bytes BETWEEN 2 AND 16777216
  ),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_inventory_captures_global_valid
    CHECK (global_id ~ '^gisc[0-9]{7}$'),
  CONSTRAINT operations_commerce_inventory_captures_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_inventory_captures_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_attempt_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider_attempt_id
    )
    REFERENCES operations_commerce_provider_attempts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_warehouse_location_fkey
    FOREIGN KEY (organization_id, warehouse_id, location_id)
    REFERENCES operations_locations(organization_id, warehouse_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_captures_attempt_unique
    UNIQUE (organization_id, integration_account_id, provider_attempt_id),
  CONSTRAINT operations_commerce_inventory_captures_attempt_id_unique
    UNIQUE (
      organization_id, integration_account_id, provider_attempt_id, id
    ),
  CONSTRAINT operations_commerce_inventory_captures_account_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_commerce_inventory_captures_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_commerce_inventory_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gisr'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider_attempt_id uuid NOT NULL,
  capture_id uuid NOT NULL,
  location_mapping_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  adapter_version text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version > 0),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status = 'succeeded'),
  provider_location_id text NOT NULL,
  provider_location_name text NOT NULL,
  provider_fetched_at timestamptz NOT NULL,
  levels_seen integer NOT NULL CHECK (levels_seen >= 0),
  levels_mapped integer NOT NULL CHECK (levels_mapped >= 0),
  levels_projected integer NOT NULL CHECK (levels_projected >= 0),
  levels_unmapped integer NOT NULL CHECK (levels_unmapped >= 0),
  levels_untracked integer NOT NULL CHECK (levels_untracked >= 0),
  negative_available_levels integer NOT NULL CHECK (
    negative_available_levels >= 0
  ),
  equation_mismatch_levels integer NOT NULL CHECK (
    equation_mismatch_levels >= 0
  ),
  provider_available_quantity numeric(20,6) NOT NULL,
  provider_committed_quantity numeric(20,6) NOT NULL,
  provider_on_hand_quantity numeric(20,6) NOT NULL,
  operational_available_quantity numeric(20,6) NOT NULL CHECK (
    operational_available_quantity >= 0
  ),
  positions_created integer NOT NULL CHECK (positions_created >= 0),
  positions_updated integer NOT NULL CHECK (positions_updated >= 0),
  positions_zeroed integer NOT NULL CHECK (positions_zeroed >= 0),
  provider_writes integer NOT NULL DEFAULT 0 CHECK (provider_writes = 0),
  order_quantity_adjustment numeric(20,6) NOT NULL DEFAULT 0 CHECK (
    order_quantity_adjustment = 0
  ),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_inventory_sync_runs_global_valid
    CHECK (global_id ~ '^gisr[0-9]{7}$'),
  CONSTRAINT operations_commerce_inventory_sync_runs_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_inventory_sync_runs_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_attempt_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider_attempt_id
    )
    REFERENCES operations_commerce_provider_attempts(
      organization_id, integration_account_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_capture_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider_attempt_id, capture_id
    )
    REFERENCES operations_commerce_inventory_captures(
      organization_id, integration_account_id, provider_attempt_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, location_mapping_id
    )
    REFERENCES operations_commerce_inventory_location_mappings(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_warehouse_location_fkey
    FOREIGN KEY (organization_id, warehouse_id, location_id)
    REFERENCES operations_locations(organization_id, warehouse_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_sync_runs_counts_valid CHECK (
    levels_mapped <= levels_seen
    AND levels_projected <= levels_mapped
    AND levels_unmapped <= levels_seen
    AND levels_mapped + levels_unmapped = levels_seen
    AND levels_untracked <= levels_seen
    AND negative_available_levels <= levels_seen
    AND equation_mismatch_levels <= levels_seen
  ),
  CONSTRAINT operations_commerce_inventory_sync_runs_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_commerce_inventory_sync_runs_attempt_unique
    UNIQUE (organization_id, integration_account_id, provider_attempt_id),
  CONSTRAINT operations_commerce_inventory_sync_runs_account_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_commerce_inventory_sync_runs_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_commerce_inventory_sync_runs_latest
  ON operations_commerce_inventory_sync_runs (
    organization_id, integration_account_id, completed_at DESC, id DESC
  );

CREATE TABLE IF NOT EXISTS operations_commerce_inventory_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('giil'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  sync_run_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  location_mapping_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  pipeline_id uuid,
  product_id uuid,
  inventory_position_id uuid,
  provider_location_id text NOT NULL,
  external_inventory_item_id text NOT NULL,
  sku text,
  tracked boolean NOT NULL,
  mapping_state text NOT NULL CHECK (
    mapping_state IN ('mapped', 'unmapped')
  ),
  projection_state text NOT NULL CHECK (
    projection_state IN (
      'projected', 'unmapped', 'untracked', 'inconsistent',
      'negative_available'
    )
  ),
  provider_available_quantity numeric(20,6) NOT NULL,
  provider_incoming_quantity numeric(20,6) NOT NULL,
  provider_committed_quantity numeric(20,6) NOT NULL,
  provider_damaged_quantity numeric(20,6) NOT NULL,
  provider_on_hand_quantity numeric(20,6) NOT NULL,
  provider_quality_control_quantity numeric(20,6) NOT NULL,
  provider_reserved_quantity numeric(20,6) NOT NULL,
  provider_safety_stock_quantity numeric(20,6) NOT NULL,
  provider_quantity_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(provider_quantity_evidence) = 'object'
  ),
  operational_available_quantity numeric(20,6) NOT NULL CHECK (
    operational_available_quantity >= 0
  ),
  equation_matches boolean NOT NULL,
  provider_updated_at timestamptz,
  provider_weight_grams integer CHECK (
    provider_weight_grams IS NULL OR provider_weight_grams > 0
  ),
  provider_dimensions_mm jsonb,
  product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_inventory_levels_global_valid
    CHECK (global_id ~ '^giil[0-9]{7}$'),
  CONSTRAINT operations_commerce_inventory_levels_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_inventory_levels_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, sync_run_id
    )
    REFERENCES operations_commerce_inventory_sync_runs(
      organization_id, integration_account_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_mapping_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, location_mapping_id
    )
    REFERENCES operations_commerce_inventory_location_mappings(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_warehouse_location_fkey
    FOREIGN KEY (organization_id, warehouse_id, location_id)
    REFERENCES operations_locations(organization_id, warehouse_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_position_fkey
    FOREIGN KEY (organization_id, inventory_position_id)
    REFERENCES operations_inventory_positions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_inventory_levels_identity_present
    CHECK (
      length(btrim(provider_location_id)) BETWEEN 1 AND 512
      AND provider_location_id !~ '[[:cntrl:]]'
      AND length(btrim(external_inventory_item_id)) BETWEEN 1 AND 512
      AND external_inventory_item_id !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_commerce_inventory_levels_mapping_valid CHECK (
    (
      mapping_state = 'mapped'
      AND pipeline_id IS NOT NULL
      AND product_id IS NOT NULL
    )
    OR (
      mapping_state = 'unmapped'
      AND pipeline_id IS NULL
      AND product_id IS NULL
    )
  ),
  CONSTRAINT operations_commerce_inventory_levels_projection_valid CHECK (
    (
      projection_state = 'projected'
      AND mapping_state = 'mapped'
      AND tracked = true
      AND equation_matches = true
      AND provider_available_quantity >= 0
      AND inventory_position_id IS NOT NULL
    )
    OR (
      projection_state = 'unmapped'
      AND mapping_state = 'unmapped'
      AND inventory_position_id IS NULL
    )
    OR (
      projection_state = 'untracked'
      AND tracked = false
      AND inventory_position_id IS NULL
    )
    OR (
      projection_state = 'inconsistent'
      AND (
        equation_matches = false
        OR provider_incoming_quantity < 0
        OR provider_committed_quantity < 0
        OR provider_damaged_quantity < 0
        OR provider_on_hand_quantity < 0
        OR provider_quality_control_quantity < 0
        OR provider_reserved_quantity < 0
        OR provider_safety_stock_quantity < 0
      )
      AND inventory_position_id IS NULL
    )
    OR (
      projection_state = 'negative_available'
      AND provider_available_quantity < 0
      AND inventory_position_id IS NULL
    )
  ),
  CONSTRAINT operations_commerce_inventory_levels_run_item_unique
    UNIQUE (
      organization_id, sync_run_id, provider_location_id,
      external_inventory_item_id
    ),
  CONSTRAINT operations_commerce_inventory_levels_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_commerce_inventory_levels_review
  ON operations_commerce_inventory_levels (
    organization_id, integration_account_id, mapping_state,
    operational_available_quantity DESC, external_inventory_item_id
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_inventory_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Commerce inventory evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_inventory_sync_runs
  ON operations_commerce_inventory_sync_runs;
CREATE TRIGGER protect_operations_commerce_inventory_sync_runs
BEFORE UPDATE OR DELETE ON operations_commerce_inventory_sync_runs
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_inventory_evidence();

DROP TRIGGER IF EXISTS protect_operations_commerce_inventory_captures
  ON operations_commerce_inventory_captures;
CREATE TRIGGER protect_operations_commerce_inventory_captures
BEFORE UPDATE OR DELETE ON operations_commerce_inventory_captures
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_inventory_evidence();

DROP TRIGGER IF EXISTS protect_operations_commerce_inventory_levels
  ON operations_commerce_inventory_levels;
CREATE TRIGGER protect_operations_commerce_inventory_levels
BEFORE UPDATE OR DELETE ON operations_commerce_inventory_levels
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_inventory_evidence();

COMMENT ON TABLE operations_commerce_inventory_sync_runs IS
  'Immutable read-only Shopify inventory reconciliation evidence. Provider writes and order-demand adjustments are forbidden.';
COMMENT ON TABLE operations_commerce_inventory_captures IS
  'Immutable product-and-inventory provider capture persisted before any operational projection.';
COMMENT ON TABLE operations_commerce_inventory_levels IS
  'Immutable Shopify quantity-state and operational product evidence. Only validated projected levels expose operational availability.';
