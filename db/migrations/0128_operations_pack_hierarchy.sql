-- Versioned product pack hierarchy and approved case-pack recipes.
--
-- A product pack (each, inner pack, case, or pallet) is inventory identity.
-- Packaging material (carton, mailer, and similar consumables) is a separate
-- operational resource. A quantity that is an arithmetic case multiple is not
-- proof that intact case inventory exists; the recipe and inventory evidence
-- decide whether the warehouse may use an intact case, assemble a case, or
-- pick loose eaches.
--
-- Customer-supplied measurements may be staged as drafts without invented
-- tare weight, capacity weight, cost, or stock. Optimizer-active packaging
-- materials still require complete inner dimensions and operating facts.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gpph', 'operations.product_pack_profile', 'Product pack profile'),
  ('gppv', 'operations.product_pack_profile_version', 'Product pack profile version'),
  ('gphr', 'operations.product_pack_relationship', 'Product pack relationship'),
  ('gcvm', 'operations.commerce_variant_pack_mapping', 'Commerce variant pack mapping'),
  ('gpre', 'operations.approved_pack_recipe', 'Approved pack recipe')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Migration 0123 required all operating facts at record creation time. Relax
-- only drafts so a customer can enter the facts they actually knows. Active
-- rows remain fail-closed.
ALTER TABLE operations_packaging_materials
  ALTER COLUMN inner_length_mm DROP NOT NULL,
  ALTER COLUMN inner_width_mm DROP NOT NULL,
  ALTER COLUMN inner_height_mm DROP NOT NULL,
  ALTER COLUMN tare_weight_grams DROP NOT NULL,
  ALTER COLUMN max_weight_grams DROP NOT NULL;

ALTER TABLE operations_packaging_materials
  ADD COLUMN IF NOT EXISTS dimension_basis text NOT NULL DEFAULT 'unspecified',
  ADD COLUMN IF NOT EXISTS dimension_evidence_type text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS dimension_evidence_reference text,
  ADD COLUMN IF NOT EXISTS dimension_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dimension_confirmed_by text
    REFERENCES app_users(email) ON DELETE SET NULL;

UPDATE operations_packaging_materials
SET dimension_basis = 'inner'
WHERE dimension_basis = 'unspecified'
  AND inner_length_mm IS NOT NULL
  AND inner_width_mm IS NOT NULL
  AND inner_height_mm IS NOT NULL;

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_weight_capacity_valid,
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_cost_valid,
  DROP CONSTRAINT IF EXISTS operations_packaging_materials_source_check;

ALTER TABLE operations_packaging_materials
  ADD CONSTRAINT operations_packaging_materials_dimension_basis_valid
    CHECK (dimension_basis IN ('inner', 'outer', 'unspecified')),
  ADD CONSTRAINT operations_packaging_materials_dimension_evidence_valid
    CHECK (
      dimension_evidence_type IN (
        'unknown', 'customer_confirmed', 'measured', 'provider', 'legacy'
      )
      AND (
        dimension_evidence_reference IS NULL
        OR length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
      )
      AND (
        dimension_evidence_type NOT IN ('customer_confirmed', 'measured')
        OR dimension_confirmed_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT operations_packaging_materials_weight_capacity_valid
    CHECK (
      tare_weight_grams IS NULL
      OR max_weight_grams IS NULL
      OR max_weight_grams > tare_weight_grams
    ),
  ADD CONSTRAINT operations_packaging_materials_cost_valid
    CHECK (
      (unit_cost_minor IS NULL AND currency IS NULL)
      OR (
        unit_cost_minor IS NOT NULL
        AND unit_cost_minor > 0
        AND currency ~ '^[A-Z]{3}$'
      )
    ),
  ADD CONSTRAINT operations_packaging_materials_source_check
    CHECK (
      source IN (
        'manual', 'starter_assortment', 'customer_supplied', 'csv_import'
      )
    ),
  ADD CONSTRAINT operations_packaging_materials_active_ready
    CHECK (
      status <> 'active'
      OR (
        dimension_basis = 'inner'
        AND dimension_evidence_type <> 'unknown'
        AND inner_length_mm IS NOT NULL
        AND inner_width_mm IS NOT NULL
        AND inner_height_mm IS NOT NULL
        AND tare_weight_grams IS NOT NULL
        AND max_weight_grams IS NOT NULL
        AND max_weight_grams > tare_weight_grams
        AND unit_cost_minor IS NOT NULL
        AND unit_cost_minor > 0
        AND currency ~ '^[A-Z]{3}$'
      )
    );

COMMENT ON COLUMN operations_packaging_materials.dimension_basis IS
  'Whether the supplied dimensions are verified usable inner dimensions, outer dimensions, or not yet classified.';
COMMENT ON CONSTRAINT operations_packaging_materials_active_ready
  ON operations_packaging_materials IS
  'Drafts may retain incomplete customer facts. Active optimizer materials require verified inner dimensions, tare, capacity, cost, and currency; warehouse stock readiness is enforced separately.';

CREATE TABLE IF NOT EXISTS operations_product_pack_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpph'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL
    REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  profile_key text NOT NULL,
  profile_name text NOT NULL,
  package_level text NOT NULL CHECK (
    package_level IN ('each', 'inner_pack', 'case', 'pallet')
  ),
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'active', 'retired')
  ),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_pack_profiles_global_valid
    CHECK (global_id ~ '^gpph[0-9]{7}$'),
  CONSTRAINT operations_product_pack_profiles_global_unique UNIQUE (global_id),
  CONSTRAINT operations_product_pack_profiles_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_profiles_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_profiles_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_profiles_key_valid
    CHECK (
      length(btrim(profile_key)) BETWEEN 1 AND 80
      AND lower(profile_key) ~ '^[a-z0-9][a-z0-9._-]*$'
      AND length(btrim(profile_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT operations_product_pack_profiles_product_key_unique
    UNIQUE (organization_id, product_id, profile_key),
  CONSTRAINT operations_product_pack_profiles_scope_id_unique
    UNIQUE (organization_id, pipeline_id, product_id, id),
  CONSTRAINT operations_product_pack_profiles_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_product_pack_profiles_product
  ON operations_product_pack_profiles (
    organization_id, pipeline_id, product_id, package_level, status, id
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_pack_profiles_one_default
  ON operations_product_pack_profiles (organization_id, product_id)
  WHERE is_default AND status = 'active';

CREATE TABLE IF NOT EXISTS operations_product_pack_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gppv'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  lifecycle_state text NOT NULL DEFAULT 'draft' CHECK (
    lifecycle_state IN (
      'draft', 'customer_confirmed', 'active', 'superseded', 'retired'
    )
  ),
  base_each_quantity integer NOT NULL CHECK (base_each_quantity > 0),
  unit_of_measure text NOT NULL DEFAULT 'each',
  length_mm integer CHECK (length_mm > 0),
  width_mm integer CHECK (width_mm > 0),
  height_mm integer CHECK (height_mm > 0),
  dimension_basis text NOT NULL DEFAULT 'unspecified' CHECK (
    dimension_basis IN ('inner', 'outer', 'unspecified')
  ),
  gross_weight_grams integer CHECK (gross_weight_grams > 0),
  weight_basis text NOT NULL DEFAULT 'unspecified' CHECK (
    weight_basis IN (
      'measured', 'provider', 'customer_stated', 'derived', 'legacy',
      'unspecified'
    )
  ),
  fit_model text NOT NULL DEFAULT 'rigid_3d' CHECK (
    fit_model IN ('rigid_3d', 'compressible', 'approved_recipe_only')
  ),
  ships_as_own_package boolean NOT NULL DEFAULT false,
  assembly_policy text NOT NULL DEFAULT 'never' CHECK (
    assembly_policy IN ('never', 'allow_from_child', 'required_from_child')
  ),
  evidence_type text NOT NULL DEFAULT 'unknown' CHECK (
    evidence_type IN (
      'unknown', 'customer_confirmed', 'measured', 'provider', 'derived',
      'legacy'
    )
  ),
  evidence_reference text,
  confirmed_at timestamptz,
  confirmed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN ('manual', 'csv_import', 'provider_sync', 'customer_supplied')
  ),
  is_current boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_pack_profile_versions_global_valid
    CHECK (global_id ~ '^gppv[0-9]{7}$'),
  CONSTRAINT operations_product_pack_profile_versions_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_product_pack_profile_versions_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_profile_versions_profile_fkey
    FOREIGN KEY (organization_id, pipeline_id, product_id, profile_id)
    REFERENCES operations_product_pack_profiles(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_profile_versions_dimensions_valid
    CHECK (
      (
        length_mm IS NULL
        AND width_mm IS NULL
        AND height_mm IS NULL
      )
      OR (
        length_mm IS NOT NULL
        AND width_mm IS NOT NULL
        AND height_mm IS NOT NULL
      )
    ),
  CONSTRAINT operations_product_pack_profile_versions_weight_valid
    CHECK (
      (gross_weight_grams IS NULL AND weight_basis = 'unspecified')
      OR (
        gross_weight_grams IS NOT NULL
        AND weight_basis <> 'unspecified'
      )
    ),
  CONSTRAINT operations_product_pack_profile_versions_evidence_valid
    CHECK (
      (
        evidence_reference IS NULL
        OR length(btrim(evidence_reference)) BETWEEN 1 AND 500
      )
      AND (
        evidence_type NOT IN ('customer_confirmed', 'measured')
        OR confirmed_at IS NOT NULL
      )
    ),
  CONSTRAINT operations_product_pack_profile_versions_lifecycle_valid
    CHECK (
      effective_to IS NULL OR effective_to > effective_from
    ),
  CONSTRAINT operations_product_pack_profile_versions_active_ready
    CHECK (
      lifecycle_state <> 'active'
      OR (
        length_mm IS NOT NULL
        AND width_mm IS NOT NULL
        AND height_mm IS NOT NULL
        AND dimension_basis <> 'unspecified'
        AND gross_weight_grams IS NOT NULL
        AND weight_basis <> 'unspecified'
        AND evidence_type <> 'unknown'
      )
    ),
  CONSTRAINT operations_product_pack_profile_versions_scope_version_unique
    UNIQUE (organization_id, profile_id, version_number),
  CONSTRAINT operations_product_pack_profile_versions_scope_id_unique
    UNIQUE (organization_id, pipeline_id, product_id, id),
  CONSTRAINT operations_product_pack_profile_versions_profile_id_unique
    UNIQUE (organization_id, pipeline_id, product_id, profile_id, id),
  CONSTRAINT operations_product_pack_profile_versions_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_pack_profile_versions_one_current
  ON operations_product_pack_profile_versions (organization_id, profile_id)
  WHERE is_current;

CREATE INDEX IF NOT EXISTS
  idx_operations_product_pack_profile_versions_product
  ON operations_product_pack_profile_versions (
    organization_id, pipeline_id, product_id, lifecycle_state,
    is_current DESC, profile_id, version_number DESC
  );

CREATE OR REPLACE FUNCTION validate_operations_product_pack_profile_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_level text;
BEGIN
  SELECT profile.package_level
  INTO profile_level
  FROM operations_product_pack_profiles AS profile
  WHERE profile.organization_id = NEW.organization_id
    AND profile.pipeline_id = NEW.pipeline_id
    AND profile.product_id = NEW.product_id
    AND profile.id = NEW.profile_id;

  IF profile_level IS NULL THEN
    RAISE EXCEPTION 'Product pack profile is outside the requested scope';
  END IF;
  IF profile_level = 'each'
     AND NEW.base_each_quantity <> 1
     AND NEW.evidence_type <> 'legacy' THEN
    RAISE EXCEPTION 'Each pack profiles must represent exactly one base each';
  END IF;
  IF NEW.lifecycle_state IN ('superseded', 'retired') AND NEW.is_current THEN
    RAISE EXCEPTION 'Superseded or retired pack profile versions cannot be current';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_product_pack_profile_version
  ON operations_product_pack_profile_versions;
CREATE TRIGGER validate_operations_product_pack_profile_version
BEFORE INSERT OR UPDATE ON operations_product_pack_profile_versions
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_product_pack_profile_version();

-- Compatibility projection for the profile contract introduced in 0086.
-- Every prior profile receives one stable identity and one evidence version.
-- The default marker is retained so moving readers to the hierarchy does not
-- silently change product-package selection.
INSERT INTO operations_product_pack_profiles (
  organization_id,
  pipeline_id,
  product_id,
  profile_key,
  profile_name,
  package_level,
  is_default,
  status,
  row_version,
  created_by,
  updated_by,
  created_at,
  updated_at
)
SELECT
  legacy.organization_id,
  legacy.pipeline_id,
  legacy.product_id,
  legacy.profile_key,
  legacy.profile_name,
  CASE legacy.package_type
    WHEN 'carton' THEN 'case'
    ELSE legacy.package_type
  END,
  legacy.is_default,
  CASE WHEN legacy.active THEN 'active' ELSE 'retired' END,
  legacy.row_version,
  legacy.created_by,
  legacy.updated_by,
  legacy.created_at,
  legacy.updated_at
FROM operations_product_package_profiles AS legacy
ON CONFLICT (organization_id, product_id, profile_key) DO NOTHING;

INSERT INTO operations_product_pack_profile_versions (
  organization_id,
  pipeline_id,
  product_id,
  profile_id,
  version_number,
  lifecycle_state,
  base_each_quantity,
  unit_of_measure,
  length_mm,
  width_mm,
  height_mm,
  dimension_basis,
  gross_weight_grams,
  weight_basis,
  fit_model,
  ships_as_own_package,
  assembly_policy,
  evidence_type,
  evidence_reference,
  source,
  is_current,
  effective_from,
  effective_to,
  row_version,
  created_by,
  created_at
)
SELECT
  legacy.organization_id,
  legacy.pipeline_id,
  legacy.product_id,
  profile.id,
  1,
  CASE WHEN legacy.active THEN 'active' ELSE 'retired' END,
  legacy.units_per_package,
  legacy.unit_of_measure,
  legacy.length_mm,
  legacy.width_mm,
  legacy.height_mm,
  'outer',
  legacy.weight_grams,
  CASE WHEN legacy.source = 'provider_sync' THEN 'provider' ELSE 'legacy' END,
  'rigid_3d',
  false,
  'never',
  CASE WHEN legacy.source = 'provider_sync' THEN 'provider' ELSE 'legacy' END,
  'Compatibility projection from operations_product_package_profiles',
  legacy.source,
  legacy.active,
  legacy.created_at,
  CASE
    WHEN legacy.active THEN NULL
    ELSE GREATEST(
      legacy.updated_at,
      legacy.created_at + interval '1 microsecond'
    )
  END,
  legacy.row_version,
  legacy.created_by,
  legacy.created_at
FROM operations_product_package_profiles AS legacy
JOIN operations_product_pack_profiles AS profile
  ON profile.organization_id = legacy.organization_id
 AND profile.product_id = legacy.product_id
 AND profile.profile_key = legacy.profile_key
ON CONFLICT (organization_id, profile_id, version_number) DO NOTHING;

CREATE TABLE IF NOT EXISTS operations_product_pack_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gphr'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  parent_profile_version_id uuid NOT NULL,
  child_profile_version_id uuid NOT NULL,
  contained_quantity integer NOT NULL CHECK (contained_quantity > 0),
  evidence_type text NOT NULL DEFAULT 'unknown' CHECK (
    evidence_type IN (
      'unknown', 'customer_confirmed', 'measured', 'provider', 'derived'
    )
  ),
  evidence_reference text,
  lifecycle_state text NOT NULL DEFAULT 'draft' CHECK (
    lifecycle_state IN ('draft', 'customer_confirmed', 'active', 'retired')
  ),
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN ('manual', 'csv_import', 'provider_sync', 'customer_supplied')
  ),
  is_current boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_product_pack_relationships_global_valid
    CHECK (global_id ~ '^gphr[0-9]{7}$'),
  CONSTRAINT operations_product_pack_relationships_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_product_pack_relationships_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_relationships_parent_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id, parent_profile_version_id
    )
    REFERENCES operations_product_pack_profile_versions(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_relationships_child_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id, child_profile_version_id
    )
    REFERENCES operations_product_pack_profile_versions(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_product_pack_relationships_distinct_valid
    CHECK (parent_profile_version_id <> child_profile_version_id),
  CONSTRAINT operations_product_pack_relationships_evidence_valid
    CHECK (
      evidence_reference IS NULL
      OR length(btrim(evidence_reference)) BETWEEN 1 AND 500
    ),
  CONSTRAINT operations_product_pack_relationships_effective_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_product_pack_relationships_pair_unique
    UNIQUE (
      organization_id, parent_profile_version_id,
      child_profile_version_id, effective_from
    ),
  CONSTRAINT operations_product_pack_relationships_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_pack_relationships_one_current
  ON operations_product_pack_relationships (
    organization_id, parent_profile_version_id, child_profile_version_id
  )
  WHERE is_current;

CREATE OR REPLACE FUNCTION validate_operations_product_pack_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_level text;
  child_level text;
  parent_rank integer;
  child_rank integer;
BEGIN
  SELECT profile.package_level
  INTO parent_level
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.parent_profile_version_id;

  SELECT profile.package_level
  INTO child_level
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.child_profile_version_id;

  parent_rank := CASE parent_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;
  child_rank := CASE child_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;

  IF parent_rank <= child_rank THEN
    RAISE EXCEPTION
      'Pack hierarchy parent must be a higher packaging level than its child';
  END IF;
  IF NEW.lifecycle_state = 'retired' AND NEW.is_current THEN
    RAISE EXCEPTION 'Retired pack relationships cannot be current';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_product_pack_relationship
  ON operations_product_pack_relationships;
CREATE TRIGGER validate_operations_product_pack_relationship
BEFORE INSERT OR UPDATE ON operations_product_pack_relationships
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_product_pack_relationship();

CREATE TABLE IF NOT EXISTS operations_commerce_variant_pack_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcvm'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_product_id text NOT NULL,
  external_variant_id text NOT NULL,
  default_pack_profile_version_id uuid NOT NULL,
  provider_lifecycle_state text NOT NULL DEFAULT 'unknown' CHECK (
    provider_lifecycle_state IN (
      'active', 'draft', 'archived', 'unlisted', 'unavailable', 'unknown'
    )
  ),
  projection_state text NOT NULL DEFAULT 'current' CHECK (
    projection_state IN ('current', 'stale', 'retired')
  ),
  source_revision text,
  source_hash text CHECK (
    source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'
  ),
  provider_updated_at timestamptz,
  observed_at timestamptz NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_variant_pack_mappings_global_valid
    CHECK (global_id ~ '^gcvm[0-9]{7}$'),
  CONSTRAINT operations_commerce_variant_pack_mappings_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_commerce_variant_pack_mappings_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_variant_pack_mappings_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_variant_pack_mappings_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_variant_pack_mappings_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_variant_pack_mappings_pack_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id,
      default_pack_profile_version_id
    )
    REFERENCES operations_product_pack_profile_versions(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_variant_pack_mappings_external_valid
    CHECK (
      length(btrim(external_product_id)) BETWEEN 1 AND 512
      AND external_product_id !~ '[[:cntrl:]]'
      AND length(btrim(external_variant_id)) BETWEEN 1 AND 512
      AND external_variant_id !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_commerce_variant_pack_mappings_source_valid
    CHECK (
      (source_revision IS NULL OR (
        length(btrim(source_revision)) BETWEEN 1 AND 512
        AND source_revision !~ '[[:cntrl:]]'
      ))
      AND (
        projection_state <> 'current'
        OR (source_revision IS NOT NULL AND source_hash IS NOT NULL)
      )
    ),
  CONSTRAINT operations_commerce_variant_pack_mappings_effective_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_commerce_variant_pack_mappings_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_commerce_variant_pack_mappings_one_current
  ON operations_commerce_variant_pack_mappings (
    organization_id, integration_account_id, provider, external_variant_id
  )
  WHERE is_current;

CREATE INDEX IF NOT EXISTS
  idx_operations_commerce_variant_pack_mappings_product
  ON operations_commerce_variant_pack_mappings (
    organization_id, pipeline_id, product_id, projection_state, observed_at DESC
  );

CREATE TABLE IF NOT EXISTS operations_approved_pack_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpre'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  recipe_key text NOT NULL,
  recipe_name text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  input_pack_profile_version_id uuid NOT NULL,
  output_pack_profile_version_id uuid NOT NULL,
  packaging_material_id uuid NOT NULL,
  input_quantity integer NOT NULL CHECK (input_quantity > 0),
  output_quantity integer NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
  packaging_material_quantity integer NOT NULL DEFAULT 1
    CHECK (packaging_material_quantity > 0),
  recipe_type text NOT NULL DEFAULT 'exact_case' CHECK (
    recipe_type IN ('exact_case', 'max_capacity', 'ship_ready_unit')
  ),
  fulfillment_policy text NOT NULL DEFAULT 'prefer_full_case' CHECK (
    fulfillment_policy IN (
      'case_required', 'prefer_full_case', 'each_pick_only'
    )
  ),
  remainder_policy text NOT NULL DEFAULT 'case_plus_each' CHECK (
    remainder_policy IN ('case_plus_each', 'all_each', 'block')
  ),
  inventory_evidence_requirement text NOT NULL DEFAULT 'either' CHECK (
    inventory_evidence_requirement IN (
      'pack_level_required', 'each_assembly_allowed', 'either'
    )
  ),
  assembly_policy text NOT NULL DEFAULT 'never' CHECK (
    assembly_policy IN ('never', 'allowed', 'required')
  ),
  exclusive_contents boolean NOT NULL DEFAULT true,
  lifecycle_state text NOT NULL DEFAULT 'draft' CHECK (
    lifecycle_state IN ('draft', 'customer_confirmed', 'active', 'retired')
  ),
  fit_evidence_type text NOT NULL DEFAULT 'unknown' CHECK (
    fit_evidence_type IN (
      'unknown', 'customer_confirmed', 'measured', 'provider', 'derived'
    )
  ),
  fit_evidence_reference text,
  confirmed_at timestamptz,
  confirmed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (
    source IN ('manual', 'csv_import', 'provider_sync', 'customer_supplied')
  ),
  is_current boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_approved_pack_recipes_global_valid
    CHECK (global_id ~ '^gpre[0-9]{7}$'),
  CONSTRAINT operations_approved_pack_recipes_global_unique UNIQUE (global_id),
  CONSTRAINT operations_approved_pack_recipes_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_approved_pack_recipes_input_pack_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id,
      input_pack_profile_version_id
    )
    REFERENCES operations_product_pack_profile_versions(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_approved_pack_recipes_output_pack_fkey
    FOREIGN KEY (
      organization_id, pipeline_id, product_id,
      output_pack_profile_version_id
    )
    REFERENCES operations_product_pack_profile_versions(
      organization_id, pipeline_id, product_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_approved_pack_recipes_material_fkey
    FOREIGN KEY (organization_id, packaging_material_id)
    REFERENCES operations_packaging_materials(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_approved_pack_recipes_key_valid
    CHECK (
      length(btrim(recipe_key)) BETWEEN 1 AND 80
      AND lower(recipe_key) ~ '^[a-z0-9][a-z0-9._-]*$'
      AND length(btrim(recipe_name)) BETWEEN 1 AND 160
    ),
  CONSTRAINT operations_approved_pack_recipes_pack_distinct
    CHECK (
      input_pack_profile_version_id <> output_pack_profile_version_id
    ),
  CONSTRAINT operations_approved_pack_recipes_exact_valid
    CHECK (
      recipe_type <> 'exact_case'
      OR output_quantity = 1
    ),
  CONSTRAINT operations_approved_pack_recipes_evidence_valid
    CHECK (
      (
        fit_evidence_reference IS NULL
        OR length(btrim(fit_evidence_reference)) BETWEEN 1 AND 500
      )
      AND (
        fit_evidence_type NOT IN ('customer_confirmed', 'measured')
        OR (
          confirmed_at IS NOT NULL
          AND fit_evidence_reference IS NOT NULL
        )
      )
      AND (
        lifecycle_state <> 'active'
        OR fit_evidence_type <> 'unknown'
      )
    ),
  CONSTRAINT operations_approved_pack_recipes_effective_valid
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT operations_approved_pack_recipes_scope_version_unique
    UNIQUE (organization_id, product_id, recipe_key, version_number),
  CONSTRAINT operations_approved_pack_recipes_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_approved_pack_recipes_one_current
  ON operations_approved_pack_recipes (
    organization_id, product_id, recipe_key
  )
  WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_operations_approved_pack_recipes_product
  ON operations_approved_pack_recipes (
    organization_id, pipeline_id, product_id, lifecycle_state,
    fulfillment_policy, id
  );

CREATE OR REPLACE FUNCTION validate_operations_approved_pack_recipe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  input_level text;
  output_level text;
  input_rank integer;
  output_rank integer;
  material_status text;
BEGIN
  SELECT profile.package_level
  INTO input_level
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.input_pack_profile_version_id;

  SELECT profile.package_level
  INTO output_level
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.output_pack_profile_version_id;

  input_rank := CASE input_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;
  output_rank := CASE output_level
    WHEN 'each' THEN 1
    WHEN 'inner_pack' THEN 2
    WHEN 'case' THEN 3
    WHEN 'pallet' THEN 4
    ELSE 0
  END;

  IF output_rank <= input_rank THEN
    RAISE EXCEPTION
      'Approved pack recipe output must be a higher packaging level than input';
  END IF;
  IF NEW.lifecycle_state = 'retired' AND NEW.is_current THEN
    RAISE EXCEPTION 'Retired pack recipes cannot be current';
  END IF;

  IF NEW.lifecycle_state = 'active' THEN
    SELECT material.status
    INTO material_status
    FROM operations_packaging_materials AS material
    WHERE material.organization_id = NEW.organization_id
      AND material.id = NEW.packaging_material_id;
    IF material_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'Active pack recipes require an optimizer-ready active packaging material';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_approved_pack_recipe
  ON operations_approved_pack_recipes;
CREATE TRIGGER validate_operations_approved_pack_recipe
BEFORE INSERT OR UPDATE ON operations_approved_pack_recipes
FOR EACH ROW EXECUTE FUNCTION validate_operations_approved_pack_recipe();

COMMENT ON TABLE operations_product_pack_profiles IS
  'Stable product packaging identities at each, inner-pack, case, and pallet levels.';
COMMENT ON TABLE operations_product_pack_profile_versions IS
  'Immutable-in-practice evidence versions for product pack dimensions, weight, fit behavior, and base-each quantity.';
COMMENT ON TABLE operations_product_pack_relationships IS
  'Version-scoped contains relationships. Arithmetic quantities describe pack structure, not intact inventory evidence.';
COMMENT ON TABLE operations_commerce_variant_pack_mappings IS
  'Provider-lifecycle projection from a Shopify or Faire variant to its default ClawPilot pack version.';
COMMENT ON TABLE operations_approved_pack_recipes IS
  'Evidence-backed conversion from an input pack to a higher pack using a separate packaging material and explicit remainder policy.';
