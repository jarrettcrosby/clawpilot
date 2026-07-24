-- Warehouse topology, location capacity, product eligibility, and inbound
-- receiving. Canonical capacity is stored in metric units; clients may enter
-- and display either metric or imperial values.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('grc', 'operations.receipt', 'Inbound receipt'),
  ('grcl', 'operations.receipt_line', 'Inbound receipt line')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_warehouses
  ADD COLUMN IF NOT EXISTS facility_type text NOT NULL DEFAULT 'distribution_center',
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 0;

ALTER TABLE operations_warehouses
  DROP CONSTRAINT IF EXISTS operations_warehouses_facility_type_valid;

ALTER TABLE operations_warehouses
  ADD CONSTRAINT operations_warehouses_facility_type_valid CHECK (
    facility_type IN (
      'distribution_center', 'store', 'dark_store', 'micro_fulfillment',
      'cross_dock', 'supplier', 'drop_ship', 'third_party'
    )
  );

ALTER TABLE operations_locations
  ADD COLUMN IF NOT EXISTS parent_location_id uuid,
  ADD COLUMN IF NOT EXISTS topology_level text NOT NULL DEFAULT 'bin',
  ADD COLUMN IF NOT EXISTS max_volume_cubic_meters numeric(20,6),
  ADD COLUMN IF NOT EXISTS max_weight_kg numeric(20,6),
  ADD COLUMN IF NOT EXISTS allow_mixed_products boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 0;

ALTER TABLE operations_locations
  DROP CONSTRAINT IF EXISTS operations_locations_topology_level_valid,
  DROP CONSTRAINT IF EXISTS operations_locations_capacity_valid,
  DROP CONSTRAINT IF EXISTS operations_locations_parent_fkey,
  DROP CONSTRAINT IF EXISTS operations_locations_parent_not_self;

ALTER TABLE operations_locations
  ADD CONSTRAINT operations_locations_topology_level_valid CHECK (
    topology_level IN (
      'building', 'zone', 'aisle', 'row', 'bay', 'level', 'shelf', 'bin',
      'staging', 'dock', 'station'
    )
  ),
  ADD CONSTRAINT operations_locations_capacity_valid CHECK (
    (max_volume_cubic_meters IS NULL OR max_volume_cubic_meters > 0)
    AND (max_weight_kg IS NULL OR max_weight_kg > 0)
  ),
  ADD CONSTRAINT operations_locations_parent_fkey
    FOREIGN KEY (organization_id, parent_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_locations_parent_not_self CHECK (
    parent_location_id IS NULL OR parent_location_id <> id
  );

CREATE INDEX IF NOT EXISTS idx_operations_locations_topology
  ON operations_locations (organization_id, warehouse_id, parent_location_id, pick_sequence, code);

CREATE TABLE IF NOT EXISTS operations_location_product_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grl'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  product_id uuid NOT NULL,
  rule_type text NOT NULL DEFAULT 'allowed'
    CHECK (rule_type IN ('allowed', 'preferred', 'restricted')),
  max_quantity numeric(20,6),
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_location_product_rules_global_valid CHECK (global_id ~ '^grl[0-9]{7}$'),
  CONSTRAINT operations_location_product_rules_global_unique UNIQUE (global_id),
  CONSTRAINT operations_location_product_rules_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_location_product_rules_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_location_product_rules_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_location_product_rules_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_location_product_rules_quantity_valid CHECK (
    max_quantity IS NULL OR max_quantity > 0
  ),
  CONSTRAINT operations_location_product_rules_unique
    UNIQUE (organization_id, location_id, product_id),
  CONSTRAINT operations_location_product_rules_org_id_unique UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_location_product_rules_lookup
  ON operations_location_product_rules (
    organization_id, location_id, active, rule_type, product_id
  );

ALTER TABLE operations_inventory_ledger
  ADD COLUMN IF NOT EXISTS damaged_delta numeric(20,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damaged_after numeric(20,6) NOT NULL DEFAULT 0;

ALTER TABLE operations_inventory_ledger
  DROP CONSTRAINT IF EXISTS operations_inventory_ledger_after_valid;

ALTER TABLE operations_inventory_ledger
  ADD CONSTRAINT operations_inventory_ledger_after_valid CHECK (
    on_hand_after >= 0
    AND reserved_after >= 0
    AND damaged_after >= 0
    AND reserved_after + damaged_after <= on_hand_after
  );

CREATE TABLE IF NOT EXISTS operations_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grc'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  reference_number text NOT NULL,
  status text NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected', 'receiving', 'completed', 'cancelled')),
  expected_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_receipts_global_valid CHECK (global_id ~ '^grc[0-9]{7}$'),
  CONSTRAINT operations_receipts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_receipts_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_receipts_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipts_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipts_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipts_reference_present CHECK (length(btrim(reference_number)) > 0),
  CONSTRAINT operations_receipts_reference_unique UNIQUE (organization_id, reference_number),
  CONSTRAINT operations_receipts_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grcl'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  target_location_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  expected_quantity numeric(20,6) NOT NULL CHECK (expected_quantity > 0),
  accepted_quantity numeric(20,6) NOT NULL DEFAULT 0,
  damaged_quantity numeric(20,6) NOT NULL DEFAULT 0,
  lot_code text NOT NULL DEFAULT '',
  unit_of_measure text NOT NULL DEFAULT 'each',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_receipt_lines_global_valid CHECK (global_id ~ '^grcl[0-9]{7}$'),
  CONSTRAINT operations_receipt_lines_global_unique UNIQUE (global_id),
  CONSTRAINT operations_receipt_lines_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_receipt_lines_receipt_fkey
    FOREIGN KEY (organization_id, receipt_id)
    REFERENCES operations_receipts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipt_lines_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipt_lines_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipt_lines_location_fkey
    FOREIGN KEY (organization_id, target_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_receipt_lines_quantities_valid CHECK (
    accepted_quantity >= 0
    AND damaged_quantity >= 0
    AND accepted_quantity + damaged_quantity <= expected_quantity
  ),
  CONSTRAINT operations_receipt_lines_uom_present CHECK (length(btrim(unit_of_measure)) > 0),
  CONSTRAINT operations_receipt_lines_number_unique UNIQUE (receipt_id, line_number),
  CONSTRAINT operations_receipt_lines_org_id_unique UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_receipts_workspace
  ON operations_receipts (organization_id, status, expected_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_receipt_lines_receipt
  ON operations_receipt_lines (organization_id, receipt_id, line_number);
