-- Organization-owned pack-out material catalog and warehouse stock readiness.
--
-- Materials describe the physical cartons and mailers that a future
-- cartonization optimizer may select. Product dimensions and historical
-- shipped demand remain separate evidence. Starter records are deliberately
-- drafts: they do not become optimizer-eligible until an operator records an
-- actual unit cost and warehouse stock availability.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gmat', 'operations.packaging_material', 'Packaging material'),
  ('gmas', 'operations.packaging_material_stock', 'Packaging material warehouse stock')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_packaging_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gmat'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  material_type text NOT NULL CHECK (
    material_type IN ('carton', 'poly_mailer', 'padded_mailer')
  ),
  inner_length_mm integer NOT NULL CHECK (inner_length_mm > 0),
  inner_width_mm integer NOT NULL CHECK (inner_width_mm > 0),
  inner_height_mm integer NOT NULL CHECK (inner_height_mm > 0),
  tare_weight_grams integer NOT NULL CHECK (tare_weight_grams > 0),
  max_weight_grams integer NOT NULL CHECK (max_weight_grams > 0),
  unit_cost_minor bigint,
  currency text,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'active')
  ),
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN ('manual', 'starter_assortment')
  ),
  row_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_packaging_materials_global_valid
    CHECK (global_id ~ '^gmat[0-9]{7}$'),
  CONSTRAINT operations_packaging_materials_global_unique UNIQUE (global_id),
  CONSTRAINT operations_packaging_materials_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_packaging_materials_code_present
    CHECK (
      length(btrim(code)) BETWEEN 2 AND 40
      AND upper(code) ~ '^[A-Z0-9][A-Z0-9._-]+$'
    ),
  CONSTRAINT operations_packaging_materials_name_present
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT operations_packaging_materials_weight_capacity_valid
    CHECK (max_weight_grams > tare_weight_grams),
  CONSTRAINT operations_packaging_materials_cost_valid
    CHECK (
      (
        unit_cost_minor IS NULL
        AND currency IS NULL
        AND status = 'draft'
      )
      OR
      (
        unit_cost_minor IS NOT NULL
        AND unit_cost_minor > 0
        AND currency ~ '^[A-Z]{3}$'
      )
    ),
  CONSTRAINT operations_packaging_materials_org_code_unique
    UNIQUE (organization_id, code),
  CONSTRAINT operations_packaging_materials_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_packaging_materials_catalog
  ON operations_packaging_materials (
    organization_id, status DESC, material_type, lower(name), id
  );

CREATE TABLE IF NOT EXISTS operations_packaging_material_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gmas'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  packaging_material_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  is_available boolean NOT NULL DEFAULT false,
  on_hand_quantity integer,
  reorder_point_quantity integer,
  reorder_to_quantity integer,
  row_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_packaging_material_stock_global_valid
    CHECK (global_id ~ '^gmas[0-9]{7}$'),
  CONSTRAINT operations_packaging_material_stock_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_packaging_material_stock_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_packaging_material_stock_material_fkey
    FOREIGN KEY (organization_id, packaging_material_id)
    REFERENCES operations_packaging_materials(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_packaging_material_stock_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_packaging_material_stock_quantity_valid
    CHECK (
      (on_hand_quantity IS NULL OR on_hand_quantity >= 0)
      AND (
        reorder_point_quantity IS NULL
        OR reorder_point_quantity >= 0
      )
      AND (
        reorder_to_quantity IS NULL
        OR reorder_to_quantity > 0
      )
      AND (
        reorder_point_quantity IS NULL
        OR reorder_to_quantity IS NULL
        OR reorder_point_quantity <= reorder_to_quantity
      )
      AND (NOT is_available OR on_hand_quantity IS NOT NULL)
    ),
  CONSTRAINT operations_packaging_material_stock_org_material_warehouse_unique
    UNIQUE (organization_id, packaging_material_id, warehouse_id),
  CONSTRAINT operations_packaging_material_stock_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_packaging_material_stock_readiness
  ON operations_packaging_material_stock (
    organization_id, warehouse_id, is_available, packaging_material_id
  );

COMMENT ON TABLE operations_packaging_materials IS
  'Organization-owned physical cartons and mailers. Draft records are not eligible for cartonization.';
COMMENT ON TABLE operations_packaging_material_stock IS
  'Warehouse-specific availability, physical on-hand count, and reorder policy for packaging materials.';
