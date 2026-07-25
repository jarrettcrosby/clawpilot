-- Operator-confirmed replenishment work and immutable paired inventory
-- movements. Recommendations remain advisory until this command executes.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('grpl', 'operations.replenishment_task', 'Replenishment task')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_replenishment_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grpl'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  inventory_pool_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source_location_id uuid NOT NULL,
  destination_location_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  replenishment_mode text NOT NULL
    CHECK (replenishment_mode IN ('min_max', 'order_demand')),
  recommendation_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled', 'exception')),
  idempotency_key text NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  completed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT operations_replenishment_tasks_global_valid
    CHECK (global_id ~ '^grpl[0-9]{7}$'),
  CONSTRAINT operations_replenishment_tasks_global_unique UNIQUE (global_id),
  CONSTRAINT operations_replenishment_tasks_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_pool_fkey
    FOREIGN KEY (organization_id, inventory_pool_id)
    REFERENCES operations_inventory_pools(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_source_location_fkey
    FOREIGN KEY (organization_id, source_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_destination_location_fkey
    FOREIGN KEY (organization_id, destination_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_replenishment_tasks_locations_distinct
    CHECK (source_location_id <> destination_location_id),
  CONSTRAINT operations_replenishment_tasks_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_replenishment_tasks_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_replenishment_tasks_workspace
  ON operations_replenishment_tasks (
    organization_id, warehouse_id, status, created_at DESC
  );

ALTER TABLE operations_inventory_ledger
  DROP CONSTRAINT IF EXISTS operations_inventory_ledger_event_type_check;

ALTER TABLE operations_inventory_ledger
  ADD CONSTRAINT operations_inventory_ledger_event_type_check CHECK (
    event_type IN (
      'opening_balance', 'receipt', 'reservation', 'reservation_release',
      'pick', 'ship', 'adjustment', 'damage', 'return',
      'replenishment_out', 'replenishment_in'
    )
  );
