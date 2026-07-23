-- Team-managed packaging profiles for canonical CRM products.
--
-- Product identity remains in crm_products. Packaging is an operational
-- concern that may eventually have several profiles (each, case, pallet), so
-- it is stored separately and linked through the immutable product Global ID.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES ('gpp', 'operations.product_package_profile', 'Product package profile')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_product_package_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpp'),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  profile_key text NOT NULL DEFAULT 'default',
  profile_name text NOT NULL DEFAULT 'Default package',
  package_type text NOT NULL DEFAULT 'each'
    CHECK (package_type IN ('each', 'inner_pack', 'case', 'carton', 'pallet')),
  unit_of_measure text NOT NULL DEFAULT 'each',
  units_per_package integer NOT NULL DEFAULT 1 CHECK (units_per_package > 0),
  measurement_system text NOT NULL DEFAULT 'metric'
    CHECK (measurement_system IN ('metric', 'imperial')),
  length_mm integer NOT NULL CHECK (length_mm > 0),
  width_mm integer NOT NULL CHECK (width_mm > 0),
  height_mm integer NOT NULL CHECK (height_mm > 0),
  weight_grams integer NOT NULL CHECK (weight_grams > 0),
  is_default boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv_import', 'provider_sync')),
  row_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_package_profiles_global_valid CHECK (global_id ~ '^gpp[0-9]{7}$'),
  CONSTRAINT operations_product_package_profiles_global_unique UNIQUE (global_id),
  CONSTRAINT operations_product_package_profiles_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_package_profiles_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_package_profiles_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_package_profiles_profile_key_present CHECK (length(btrim(profile_key)) > 0),
  CONSTRAINT operations_product_package_profiles_profile_name_present CHECK (length(btrim(profile_name)) > 0),
  CONSTRAINT operations_product_package_profiles_uom_present CHECK (length(btrim(unit_of_measure)) > 0),
  CONSTRAINT operations_product_package_profiles_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT operations_product_package_profiles_product_key_unique
    UNIQUE (organization_id, product_id, profile_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_product_package_profiles_one_default
  ON operations_product_package_profiles (organization_id, product_id)
  WHERE is_default = true AND active = true;

CREATE INDEX IF NOT EXISTS idx_operations_product_package_profiles_catalog
  ON operations_product_package_profiles (
    organization_id, pipeline_id, product_id, active DESC, is_default DESC, lower(profile_name)
  );
