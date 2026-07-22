-- Native distributed order, warehouse, and 3PL operations foundation.
--
-- The existing crm_reference_* tables are the permanent ClawPilot Global ID
-- registry. They retain their names for compatibility, but this migration
-- extends them to every operational aggregate. Numeric suffixes remain
-- globally exclusive and are never released after archival or deletion.

CREATE TABLE IF NOT EXISTS global_reference_entity_types (
  prefix text PRIMARY KEY,
  entity_type text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_reference_entity_types_prefix_valid CHECK (prefix ~ '^g[a-z]{1,4}$'),
  CONSTRAINT global_reference_entity_types_entity_present CHECK (length(btrim(entity_type)) > 0),
  CONSTRAINT global_reference_entity_types_display_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT global_reference_entity_types_prefix_entity_unique UNIQUE (prefix, entity_type)
);

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('ga', 'crm.organization', 'CRM organization'),
  ('gc', 'crm.contact', 'CRM contact'),
  ('gl', 'crm.lead', 'CRM lead'),
  ('go', 'crm.opportunity', 'CRM opportunity'),
  ('gm', 'crm.meeting', 'CRM meeting'),
  ('gi', 'crm.interaction', 'CRM interaction'),
  ('gk', 'crm.campaign', 'CRM campaign'),
  ('gp', 'crm.product', 'Global product'),
  ('gu', 'identity.user', 'ClawPilot user'),
  ('gor', 'operations.order', 'Order'),
  ('gol', 'operations.order_line', 'Order line'),
  ('gwh', 'operations.warehouse', 'Warehouse'),
  ('gwl', 'operations.location', 'Warehouse location'),
  ('gip', 'operations.inventory_pool', 'Inventory pool'),
  ('giv', 'operations.inventory_position', 'Inventory position'),
  ('gld', 'operations.inventory_ledger', 'Inventory ledger entry'),
  ('grs', 'operations.reservation', 'Inventory reservation'),
  ('gct', 'operations.contract', 'Customer contract'),
  ('gcv', 'operations.contract_version', 'Customer contract version'),
  ('gpd', 'operations.pricing_directive', 'Pricing directive'),
  ('gfp', 'operations.fulfillment_plan', 'Fulfillment plan'),
  ('gfa', 'operations.fulfillment_allocation', 'Fulfillment allocation'),
  ('gcp', 'operations.carton_plan', 'Carton plan'),
  ('grt', 'operations.carrier_rate', 'Carrier rate'),
  ('gwv', 'operations.wave', 'Warehouse wave'),
  ('gpk', 'operations.pick_task', 'Pick task'),
  ('gpa', 'operations.package', 'Package'),
  ('glb', 'operations.label', 'Shipping label'),
  ('gsh', 'operations.shipment', 'Shipment'),
  ('gpr', 'operations.printer', 'Printer'),
  ('gpj', 'operations.print_job', 'Print job'),
  ('gbe', 'operations.billable_event', 'Billable event'),
  ('gia', 'operations.integration_account', 'Integration account'),
  ('gpm', 'operations.product_mapping', 'Product mapping'),
  ('gex', 'operations.exception', 'Operations exception'),
  ('gev', 'operations.domain_event', 'Operations event'),
  ('grl', 'operations.rule', 'Operations rule')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE crm_reference_registry
  ADD COLUMN IF NOT EXISTS entity_type text;

UPDATE crm_reference_registry registry
SET entity_type = entity.entity_type
FROM global_reference_entity_types entity
WHERE entity.prefix = registry.prefix
  AND registry.entity_type IS NULL;

ALTER TABLE crm_reference_registry
  DROP CONSTRAINT IF EXISTS crm_reference_registry_code_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_prefix_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_canonical_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_entity_type_fkey,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_prefix_entity_fkey;

ALTER TABLE crm_reference_registry
  ALTER COLUMN entity_type SET NOT NULL,
  ADD CONSTRAINT crm_reference_registry_code_valid
    CHECK (reference_code ~ '^g[a-z]{1,4}[0-9]{7}$'),
  ADD CONSTRAINT crm_reference_registry_prefix_valid
    CHECK (reference_code = prefix || right(reference_code, 7)),
  ADD CONSTRAINT crm_reference_registry_canonical_valid
    CHECK (canonical_code ~ '^g[a-z]{1,4}[0-9]{7}$'),
  ADD CONSTRAINT crm_reference_registry_prefix_entity_fkey
    FOREIGN KEY (prefix, entity_type)
    REFERENCES global_reference_entity_types(prefix, entity_type) ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS protect_crm_reference_registry_identity ON crm_reference_registry;
CREATE TRIGGER protect_crm_reference_registry_identity
BEFORE UPDATE OF reference_code, prefix, canonical_code, entity_type ON crm_reference_registry
FOR EACH ROW EXECUTE FUNCTION protect_crm_reference_registry();

CREATE OR REPLACE FUNCTION allocate_global_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate_number text;
  candidate text;
  reserved_number text;
  resolved_entity_type text;
BEGIN
  SELECT entity_type INTO resolved_entity_type
  FROM global_reference_entity_types
  WHERE prefix = requested_prefix;

  IF resolved_entity_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported Global ID prefix: %', requested_prefix;
  END IF;

  FOR attempt IN 1..1000 LOOP
    candidate_number := (1000000 + floor(random() * 9000000)::bigint)::text;
    candidate := requested_prefix || candidate_number;
    reserved_number := NULL;

    INSERT INTO crm_reference_number_registry (number_value, allocated_at)
    VALUES (candidate_number, now())
    ON CONFLICT (number_value) DO NOTHING
    RETURNING number_value INTO reserved_number;

    IF reserved_number IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at, entity_type
    ) VALUES (
      candidate, requested_prefix, candidate, 'active', now(), resolved_entity_type
    );

    RETURN candidate;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique Global ID for prefix %', requested_prefix;
END;
$$;

CREATE OR REPLACE FUNCTION allocate_crm_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  RETURN allocate_global_reference(requested_prefix);
END;
$$;

-- Operations always binds an existing pipeline to the active workspace. The
-- composite key makes that ownership enforceable by every downstream table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_workspace_id
  ON pipeline_spaces(workspace_organization_id, id);

CREATE TABLE IF NOT EXISTS operations_integration_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gia'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  integration_type text NOT NULL CHECK (integration_type IN ('commerce', 'carrier', 'printing')),
  environment text NOT NULL DEFAULT 'mock' CHECK (environment IN ('mock', 'sandbox', 'production')),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_reference text,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_integration_accounts_global_valid CHECK (global_id ~ '^gia[0-9]{7}$'),
  CONSTRAINT operations_integration_accounts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_integration_accounts_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_integration_accounts_provider_present CHECK (length(btrim(provider)) > 0),
  CONSTRAINT operations_integration_accounts_name_present CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT operations_integration_accounts_provider_unique
    UNIQUE (organization_id, integration_type, provider, environment),
  CONSTRAINT operations_integration_accounts_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gwh'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  cutoff_time time,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_warehouses_global_valid CHECK (global_id ~ '^gwh[0-9]{7}$'),
  CONSTRAINT operations_warehouses_global_unique UNIQUE (global_id),
  CONSTRAINT operations_warehouses_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_warehouses_code_present CHECK (length(btrim(code)) > 0),
  CONSTRAINT operations_warehouses_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT operations_warehouses_org_code_unique UNIQUE (organization_id, code),
  CONSTRAINT operations_warehouses_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gwl'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  zone text NOT NULL DEFAULT 'STORAGE',
  location_type text NOT NULL DEFAULT 'storage'
    CHECK (location_type IN ('receiving', 'storage', 'pick', 'pack', 'staging', 'shipping', 'returns')),
  pick_sequence integer NOT NULL DEFAULT 0 CHECK (pick_sequence >= 0),
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_locations_global_valid CHECK (global_id ~ '^gwl[0-9]{7}$'),
  CONSTRAINT operations_locations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_locations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_locations_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_locations_code_present CHECK (length(btrim(code)) > 0),
  CONSTRAINT operations_locations_org_code_unique UNIQUE (organization_id, warehouse_id, code),
  CONSTRAINT operations_locations_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_inventory_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gip'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  owner_customer_id uuid,
  name text NOT NULL,
  pool_type text NOT NULL CHECK (pool_type IN ('customer_dedicated', 'shared')),
  allocation_policy text NOT NULL DEFAULT 'fifo'
    CHECK (allocation_policy IN ('fifo', 'fefo', 'priority')),
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_inventory_pools_global_valid CHECK (global_id ~ '^gip[0-9]{7}$'),
  CONSTRAINT operations_inventory_pools_global_unique UNIQUE (global_id),
  CONSTRAINT operations_inventory_pools_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pools_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pools_customer_fkey
    FOREIGN KEY (pipeline_id, owner_customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pools_owner_valid CHECK (
    (pool_type = 'customer_dedicated' AND owner_customer_id IS NOT NULL)
    OR pool_type = 'shared'
  ),
  CONSTRAINT operations_inventory_pools_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT operations_inventory_pools_org_name_unique UNIQUE (organization_id, name),
  CONSTRAINT operations_inventory_pools_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_inventory_pool_customers (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pool_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, customer_id, effective_from),
  CONSTRAINT operations_inventory_pool_customers_pool_fkey
    FOREIGN KEY (organization_id, pool_id)
    REFERENCES operations_inventory_pools(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pool_customers_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pool_customers_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_pool_customers_dates_valid CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

CREATE TABLE IF NOT EXISTS operations_inventory_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('giv'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  pool_id uuid NOT NULL,
  product_id uuid NOT NULL,
  lot_code text NOT NULL DEFAULT '',
  on_hand_quantity numeric(20,6) NOT NULL DEFAULT 0,
  reserved_quantity numeric(20,6) NOT NULL DEFAULT 0,
  damaged_quantity numeric(20,6) NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_inventory_positions_global_valid CHECK (global_id ~ '^giv[0-9]{7}$'),
  CONSTRAINT operations_inventory_positions_global_unique UNIQUE (global_id),
  CONSTRAINT operations_inventory_positions_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_pool_fkey
    FOREIGN KEY (organization_id, pool_id)
    REFERENCES operations_inventory_pools(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_positions_balances_valid CHECK (
    on_hand_quantity >= 0
    AND reserved_quantity >= 0
    AND damaged_quantity >= 0
    AND reserved_quantity + damaged_quantity <= on_hand_quantity
  ),
  CONSTRAINT operations_inventory_positions_natural_unique
    UNIQUE (organization_id, warehouse_id, location_id, pool_id, product_id, lot_code),
  CONSTRAINT operations_inventory_positions_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_inventory_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gld'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  position_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'opening_balance', 'receipt', 'reservation', 'reservation_release',
    'pick', 'ship', 'adjustment', 'damage', 'return'
  )),
  on_hand_delta numeric(20,6) NOT NULL DEFAULT 0,
  reserved_delta numeric(20,6) NOT NULL DEFAULT 0,
  on_hand_after numeric(20,6) NOT NULL,
  reserved_after numeric(20,6) NOT NULL,
  source_global_id text,
  reason text,
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_inventory_ledger_global_valid CHECK (global_id ~ '^gld[0-9]{7}$'),
  CONSTRAINT operations_inventory_ledger_global_unique UNIQUE (global_id),
  CONSTRAINT operations_inventory_ledger_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_ledger_position_fkey
    FOREIGN KEY (organization_id, position_id)
    REFERENCES operations_inventory_positions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_inventory_ledger_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_inventory_ledger_after_valid CHECK (
    on_hand_after >= 0 AND reserved_after >= 0 AND reserved_after <= on_hand_after
  )
);

CREATE TABLE IF NOT EXISTS operations_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gct'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'expired', 'terminated')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_contracts_global_valid CHECK (global_id ~ '^gct[0-9]{7}$'),
  CONSTRAINT operations_contracts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_contracts_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_contracts_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_contracts_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_contracts_org_customer_name_unique UNIQUE (organization_id, customer_id, name),
  CONSTRAINT operations_contracts_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_contract_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcv'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_contract_versions_global_valid CHECK (global_id ~ '^gcv[0-9]{7}$'),
  CONSTRAINT operations_contract_versions_global_unique UNIQUE (global_id),
  CONSTRAINT operations_contract_versions_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_contract_versions_contract_fkey
    FOREIGN KEY (organization_id, contract_id)
    REFERENCES operations_contracts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_contract_versions_dates_valid CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_contract_versions_number_unique UNIQUE (contract_id, version_number),
  CONSTRAINT operations_contract_versions_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_pricing_directives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpd'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  contract_version_id uuid NOT NULL,
  directive_type text NOT NULL CHECK (directive_type IN (
    'fixed_order_fee', 'pick_fee', 'tiered_pick_fee', 'pack_fee',
    'freight_markup_percent', 'storage_fee', 'special_handling'
  )),
  priority integer NOT NULL DEFAULT 100,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_pricing_directives_global_valid CHECK (global_id ~ '^gpd[0-9]{7}$'),
  CONSTRAINT operations_pricing_directives_global_unique UNIQUE (global_id),
  CONSTRAINT operations_pricing_directives_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_pricing_directives_contract_version_fkey
    FOREIGN KEY (organization_id, contract_version_id)
    REFERENCES operations_contract_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pricing_directives_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gor'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  contract_version_id uuid,
  source_provider text NOT NULL,
  external_order_id text NOT NULL,
  order_number text NOT NULL,
  order_type text NOT NULL DEFAULT 'standard' CHECK (order_type IN ('standard', 'backorder', 'transfer', 'replacement')),
  status text NOT NULL DEFAULT 'imported' CHECK (status IN (
    'imported', 'validated', 'held', 'promised', 'reserved', 'planned',
    'released', 'picking', 'packed', 'shipped', 'cancelled', 'exception'
  )),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  merchandise_total_minor bigint NOT NULL DEFAULT 0 CHECK (merchandise_total_minor >= 0),
  requested_delivery_at timestamptz,
  promised_delivery_at timestamptz,
  ship_to jsonb NOT NULL,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  hold_reason text,
  row_version bigint NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_orders_global_valid CHECK (global_id ~ '^gor[0-9]{7}$'),
  CONSTRAINT operations_orders_global_unique UNIQUE (global_id),
  CONSTRAINT operations_orders_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_orders_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_orders_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_orders_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_orders_contract_version_fkey
    FOREIGN KEY (organization_id, contract_version_id)
    REFERENCES operations_contract_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_orders_external_unique
    UNIQUE (organization_id, integration_account_id, external_order_id),
  CONSTRAINT operations_orders_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gol'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  external_line_id text NOT NULL,
  channel_sku text NOT NULL,
  description text NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  weight_grams integer NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  dimensions_mm jsonb NOT NULL DEFAULT '{"length":100,"width":100,"height":100}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_order_lines_global_valid CHECK (global_id ~ '^gol[0-9]{7}$'),
  CONSTRAINT operations_order_lines_global_unique UNIQUE (global_id),
  CONSTRAINT operations_order_lines_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_order_lines_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_order_lines_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT operations_order_lines_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_order_lines_external_unique UNIQUE (order_id, external_line_id),
  CONSTRAINT operations_order_lines_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_product_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpm'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  channel_sku text NOT NULL,
  external_product_id text,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_mappings_global_valid CHECK (global_id ~ '^gpm[0-9]{7}$'),
  CONSTRAINT operations_product_mappings_global_unique UNIQUE (global_id),
  CONSTRAINT operations_product_mappings_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_mappings_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_mappings_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_mappings_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_mappings_sku_unique UNIQUE (organization_id, integration_account_id, channel_sku)
);

CREATE TABLE IF NOT EXISTS operations_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grs'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  position_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  idempotency_key text NOT NULL,
  expires_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT operations_reservations_global_valid CHECK (global_id ~ '^grs[0-9]{7}$'),
  CONSTRAINT operations_reservations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_reservations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_reservations_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_reservations_line_fkey
    FOREIGN KEY (organization_id, order_line_id)
    REFERENCES operations_order_lines(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_reservations_position_fkey
    FOREIGN KEY (organization_id, position_id)
    REFERENCES operations_inventory_positions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_reservations_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_reservations_org_id_unique UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_reservations_active_position
  ON operations_reservations(order_line_id, position_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS operations_fulfillment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfp'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'fulfilled', 'cancelled')),
  method text NOT NULL CHECK (method IN ('optimizer', 'deterministic_fallback', 'manual_override')),
  solver_status text NOT NULL DEFAULT 'not_run',
  fallback_reason text,
  estimated_cost_minor bigint NOT NULL DEFAULT 0,
  estimated_revenue_minor bigint NOT NULL DEFAULT 0,
  estimated_margin_minor bigint NOT NULL DEFAULT 0,
  promised_delivery_at timestamptz NOT NULL,
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_fulfillment_plans_global_valid CHECK (global_id ~ '^gfp[0-9]{7}$'),
  CONSTRAINT operations_fulfillment_plans_global_unique UNIQUE (global_id),
  CONSTRAINT operations_fulfillment_plans_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_plans_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_plans_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_plans_version_unique UNIQUE (order_id, version_number),
  CONSTRAINT operations_fulfillment_plans_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_fulfillment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfa'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  position_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_fulfillment_allocations_global_valid CHECK (global_id ~ '^gfa[0-9]{7}$'),
  CONSTRAINT operations_fulfillment_allocations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_fulfillment_allocations_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_allocations_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT operations_fulfillment_allocations_line_fkey
    FOREIGN KEY (organization_id, order_line_id)
    REFERENCES operations_order_lines(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_allocations_reservation_fkey
    FOREIGN KEY (organization_id, reservation_id)
    REFERENCES operations_reservations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_allocations_position_fkey
    FOREIGN KEY (organization_id, position_id)
    REFERENCES operations_inventory_positions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_fulfillment_allocations_plan_line_position_unique
    UNIQUE (plan_id, order_line_id, position_id),
  CONSTRAINT operations_fulfillment_allocations_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_carton_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcp'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  algorithm text NOT NULL DEFAULT 'deterministic_single_carton',
  package_count integer NOT NULL CHECK (package_count > 0),
  total_weight_grams integer NOT NULL CHECK (total_weight_grams >= 0),
  packages jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carton_plans_global_valid CHECK (global_id ~ '^gcp[0-9]{7}$'),
  CONSTRAINT operations_carton_plans_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carton_plans_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carton_plans_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT operations_carton_plans_plan_unique UNIQUE (plan_id),
  CONSTRAINT operations_carton_plans_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_carrier_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grt'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  carrier text NOT NULL,
  service_code text NOT NULL,
  service_name text NOT NULL,
  internal_cost_minor bigint NOT NULL CHECK (internal_cost_minor >= 0),
  customer_charge_minor bigint NOT NULL CHECK (customer_charge_minor >= 0),
  transit_days integer NOT NULL CHECK (transit_days >= 0),
  estimated_delivery_at timestamptz NOT NULL,
  meets_promise boolean NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  quote_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rates_global_valid CHECK (global_id ~ '^grt[0-9]{7}$'),
  CONSTRAINT operations_carrier_rates_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rates_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rates_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT operations_carrier_rates_service_unique UNIQUE (plan_id, carrier, service_code),
  CONSTRAINT operations_carrier_rates_org_id_unique UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_rates_selected
  ON operations_carrier_rates(plan_id) WHERE selected = true;

CREATE TABLE IF NOT EXISTS operations_waves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gwv'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'released' CHECK (status IN ('planned', 'released', 'in_progress', 'completed', 'cancelled')),
  optimization_method text NOT NULL DEFAULT 'deterministic_fallback',
  released_by text REFERENCES app_users(email) ON DELETE SET NULL,
  released_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_waves_global_valid CHECK (global_id ~ '^gwv[0-9]{7}$'),
  CONSTRAINT operations_waves_global_unique UNIQUE (global_id),
  CONSTRAINT operations_waves_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_waves_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_waves_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_pick_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpk'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  wave_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  from_location_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'in_progress', 'picked', 'short', 'cancelled')),
  assigned_to text REFERENCES app_users(email) ON DELETE SET NULL,
  picked_quantity numeric(20,6),
  picked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_pick_tasks_global_valid CHECK (global_id ~ '^gpk[0-9]{7}$'),
  CONSTRAINT operations_pick_tasks_global_unique UNIQUE (global_id),
  CONSTRAINT operations_pick_tasks_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_pick_tasks_wave_fkey
    FOREIGN KEY (organization_id, wave_id)
    REFERENCES operations_waves(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pick_tasks_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pick_tasks_allocation_fkey
    FOREIGN KEY (organization_id, allocation_id)
    REFERENCES operations_fulfillment_allocations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pick_tasks_location_fkey
    FOREIGN KEY (organization_id, from_location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_pick_tasks_allocation_unique UNIQUE (allocation_id),
  CONSTRAINT operations_pick_tasks_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpa'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  package_number integer NOT NULL CHECK (package_number > 0),
  length_mm integer NOT NULL CHECK (length_mm > 0),
  width_mm integer NOT NULL CHECK (width_mm > 0),
  height_mm integer NOT NULL CHECK (height_mm > 0),
  weight_grams integer NOT NULL CHECK (weight_grams >= 0),
  status text NOT NULL DEFAULT 'packed' CHECK (status IN ('planned', 'packed', 'labeled', 'shipped')),
  packed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  packed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_packages_global_valid CHECK (global_id ~ '^gpa[0-9]{7}$'),
  CONSTRAINT operations_packages_global_unique UNIQUE (global_id),
  CONSTRAINT operations_packages_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_packages_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_packages_plan_number_unique UNIQUE (plan_id, package_number),
  CONSTRAINT operations_packages_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_printers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpr'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  station_type text NOT NULL DEFAULT 'pack' CHECK (station_type IN ('pack', 'shipping', 'receiving', 'office')),
  supports_zpl boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'offline', 'disabled')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_printers_global_valid CHECK (global_id ~ '^gpr[0-9]{7}$'),
  CONSTRAINT operations_printers_global_unique UNIQUE (global_id),
  CONSTRAINT operations_printers_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_printers_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_printers_code_unique UNIQUE (organization_id, warehouse_id, code),
  CONSTRAINT operations_printers_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('grl'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  rule_type text NOT NULL CHECK (rule_type IN ('printer_route', 'inventory_priority', 'carrier_selection', 'hold')),
  name text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_rules_global_valid CHECK (global_id ~ '^grl[0-9]{7}$'),
  CONSTRAINT operations_rules_global_unique UNIQUE (global_id),
  CONSTRAINT operations_rules_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_rules_org_name_unique UNIQUE (organization_id, rule_type, name),
  CONSTRAINT operations_rules_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('glb'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  package_id uuid NOT NULL,
  carrier_rate_id uuid NOT NULL,
  carrier text NOT NULL,
  service_code text NOT NULL,
  tracking_number text NOT NULL,
  format text NOT NULL DEFAULT 'ZPL' CHECK (format IN ('ZPL', 'PDF', 'PNG')),
  label_payload text NOT NULL,
  provider_label_id text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'voided', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_labels_global_valid CHECK (global_id ~ '^glb[0-9]{7}$'),
  CONSTRAINT operations_labels_global_unique UNIQUE (global_id),
  CONSTRAINT operations_labels_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_labels_package_fkey
    FOREIGN KEY (organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_labels_carrier_rate_fkey
    FOREIGN KEY (organization_id, carrier_rate_id)
    REFERENCES operations_carrier_rates(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_labels_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_labels_tracking_unique UNIQUE (carrier, tracking_number),
  CONSTRAINT operations_labels_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpj'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  label_id uuid NOT NULL,
  printer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printed', 'failed', 'rerouted')),
  routing_reason text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL,
  printed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_jobs_global_valid CHECK (global_id ~ '^gpj[0-9]{7}$'),
  CONSTRAINT operations_print_jobs_global_unique UNIQUE (global_id),
  CONSTRAINT operations_print_jobs_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_print_jobs_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_jobs_printer_fkey
    FOREIGN KEY (organization_id, printer_id)
    REFERENCES operations_printers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_jobs_idempotency_unique UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_print_jobs_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsh'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  package_id uuid NOT NULL,
  label_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'in_transit', 'delivered', 'exception', 'voided')),
  tracking_number text NOT NULL,
  shipped_at timestamptz NOT NULL DEFAULT now(),
  actual_carrier_cost_minor bigint NOT NULL CHECK (actual_carrier_cost_minor >= 0),
  confirmed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shipments_global_valid CHECK (global_id ~ '^gsh[0-9]{7}$'),
  CONSTRAINT operations_shipments_global_unique UNIQUE (global_id),
  CONSTRAINT operations_shipments_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shipments_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipments_plan_fkey
    FOREIGN KEY (organization_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipments_package_fkey
    FOREIGN KEY (organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipments_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shipments_package_unique UNIQUE (package_id),
  CONSTRAINT operations_shipments_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_billable_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbe'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  contract_version_id uuid NOT NULL,
  directive_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('order', 'pick', 'pack', 'freight', 'storage', 'special_handling', 'credit')),
  quantity numeric(20,6) NOT NULL DEFAULT 1,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'unbilled' CHECK (status IN ('estimated', 'unbilled', 'billed', 'credited')),
  source_global_id text NOT NULL,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_billable_events_global_valid CHECK (global_id ~ '^gbe[0-9]{7}$'),
  CONSTRAINT operations_billable_events_global_unique UNIQUE (global_id),
  CONSTRAINT operations_billable_events_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_customer_fkey
    FOREIGN KEY (pipeline_id, customer_id)
    REFERENCES crm_organizations(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_contract_version_fkey
    FOREIGN KEY (organization_id, contract_version_id)
    REFERENCES operations_contract_versions(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_directive_fkey
    FOREIGN KEY (organization_id, directive_id)
    REFERENCES operations_pricing_directives(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_billable_events_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS operations_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gex'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid,
  exception_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_to text REFERENCES app_users(email) ON DELETE SET NULL,
  resolved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_exceptions_global_valid CHECK (global_id ~ '^gex[0-9]{7}$'),
  CONSTRAINT operations_exceptions_global_unique UNIQUE (global_id),
  CONSTRAINT operations_exceptions_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_exceptions_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_exceptions_org_id_unique UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS operations_domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gev'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_global_id text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  correlation_id uuid NOT NULL,
  causation_id uuid,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_domain_events_global_valid CHECK (global_id ~ '^gev[0-9]{7}$'),
  CONSTRAINT operations_domain_events_global_unique UNIQUE (global_id),
  CONSTRAINT operations_domain_events_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_domain_events_idempotency_unique UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS operations_external_identifiers (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_global_id text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id, entity_type, external_id),
  CONSTRAINT operations_external_identifiers_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_external_identifiers_global_fkey
    FOREIGN KEY (entity_global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_external_identifiers_global_unique
    UNIQUE (organization_id, integration_account_id, entity_type, entity_global_id)
);

CREATE INDEX IF NOT EXISTS idx_operations_orders_workbench
  ON operations_orders(organization_id, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_operations_inventory_available
  ON operations_inventory_positions(organization_id, pipeline_id, product_id, warehouse_id, pool_id);
CREATE INDEX IF NOT EXISTS idx_operations_events_aggregate
  ON operations_domain_events(organization_id, aggregate_type, aggregate_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_operations_exceptions_open
  ON operations_exceptions(organization_id, severity, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_operations_billable_unbilled
  ON operations_billable_events(organization_id, customer_id, occurred_at) WHERE status = 'unbilled';

CREATE OR REPLACE FUNCTION protect_operations_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Operational ledger, event, and billing evidence is append-only';
END;
$$;

CREATE TRIGGER protect_operations_inventory_ledger_mutation
BEFORE UPDATE OR DELETE ON operations_inventory_ledger
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_domain_events_mutation
BEFORE UPDATE OR DELETE ON operations_domain_events
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_billable_events_mutation
BEFORE UPDATE OR DELETE ON operations_billable_events
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_contract_versions_mutation
BEFORE UPDATE OR DELETE ON operations_contract_versions
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TRIGGER protect_operations_pricing_directives_mutation
BEFORE UPDATE OR DELETE ON operations_pricing_directives
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

-- New permissions are least-privilege for existing non-owner memberships.
UPDATE app_users
SET permissions = permissions || '{"viewOperations":false,"manageOperations":false,"executeWarehouse":false}'::jsonb
WHERE role <> 'owner';

UPDATE app_user_organization_memberships
SET permissions = permissions || CASE
  WHEN role = 'owner' THEN '{"viewOperations":true,"manageOperations":true,"executeWarehouse":true}'::jsonb
  ELSE '{"viewOperations":false,"manageOperations":false,"executeWarehouse":false}'::jsonb
END;

-- The existing outbox is the durable delivery boundary for channel updates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_operations_idempotency
  ON sync_outbox(target_system, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND aggregate_type LIKE 'operations.%';
