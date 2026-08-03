-- Harden the administrator-managed Product pack hierarchy before exposing
-- authenticated writers. Existing evidence remains readable. New or changed
-- active rows must satisfy the same exact-current facts consumed by the
-- Shopify checkout callback.

ALTER TABLE operations_commerce_variant_pack_mappings
  ADD COLUMN IF NOT EXISTS mapping_purpose text NOT NULL DEFAULT 'catalog';

ALTER TABLE operations_commerce_variant_pack_mappings
  DROP CONSTRAINT IF EXISTS
    operations_commerce_variant_pack_mappings_purpose_valid,
  ADD CONSTRAINT
    operations_commerce_variant_pack_mappings_purpose_valid
  CHECK (mapping_purpose IN ('catalog', 'shopify_checkout'));

DROP INDEX IF EXISTS
  idx_operations_commerce_variant_pack_mappings_one_current;
CREATE UNIQUE INDEX
  idx_operations_commerce_variant_pack_mappings_one_current
  ON operations_commerce_variant_pack_mappings (
    organization_id,
    integration_account_id,
    provider,
    external_variant_id,
    mapping_purpose
  )
  WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_product_channel_states_org_id_unique
  ON operations_product_channel_states (organization_id, id);

ALTER TABLE operations_product_pack_profile_versions
  ADD COLUMN IF NOT EXISTS provider_weight_channel_state_id uuid,
  ADD COLUMN IF NOT EXISTS provider_weight_channel_state_row_version bigint,
  ADD COLUMN IF NOT EXISTS provider_weight_source_revision text,
  ADD COLUMN IF NOT EXISTS provider_weight_source_hash text;

ALTER TABLE operations_product_pack_profile_versions
  DROP CONSTRAINT IF EXISTS
    operations_product_pack_versions_provider_weight_state_fkey,
  DROP CONSTRAINT IF EXISTS
    operations_product_pack_versions_provider_weight_evidence_valid,
  ADD CONSTRAINT
    operations_product_pack_versions_provider_weight_state_fkey
  FOREIGN KEY (
    organization_id,
    provider_weight_channel_state_id
  )
  REFERENCES operations_product_channel_states(organization_id, id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT
    operations_product_pack_versions_provider_weight_evidence_valid
  CHECK (
    (
      weight_basis <> 'provider'
      AND provider_weight_channel_state_id IS NULL
      AND provider_weight_channel_state_row_version IS NULL
      AND provider_weight_source_revision IS NULL
      AND provider_weight_source_hash IS NULL
    )
    OR (
      weight_basis = 'provider'
      AND evidence_type = 'provider'
      AND provider_weight_channel_state_id IS NOT NULL
      AND provider_weight_channel_state_row_version >= 0
      AND length(btrim(provider_weight_source_revision)) BETWEEN 1 AND 512
      AND provider_weight_source_hash ~ '^[a-f0-9]{64}$'
    )
    OR (
      lifecycle_state IN ('superseded', 'retired')
      AND provider_weight_channel_state_id IS NULL
      AND provider_weight_channel_state_row_version IS NULL
      AND provider_weight_source_revision IS NULL
      AND provider_weight_source_hash IS NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_product_pack_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'active'
     AND EXISTS (
       SELECT 1
       FROM operations_product_pack_profile_versions version
       WHERE version.organization_id = NEW.organization_id
         AND version.profile_id = NEW.id
         AND version.is_current = true
         AND version.lifecycle_state = 'active'
     ) THEN
    RAISE EXCEPTION
      'A Product pack profile with a current active version must remain active';
  END IF;

  IF NEW.status = 'retired'
     AND EXISTS (
       SELECT 1
       FROM operations_product_pack_profile_versions version
       WHERE version.organization_id = NEW.organization_id
         AND version.profile_id = NEW.id
         AND version.is_current = true
     ) THEN
    RAISE EXCEPTION
      'Retire the current Product pack version before retiring its profile';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_product_pack_profile
  ON operations_product_pack_profiles;
CREATE TRIGGER validate_operations_product_pack_profile
BEFORE UPDATE OF status ON operations_product_pack_profiles
FOR EACH ROW EXECUTE FUNCTION validate_operations_product_pack_profile();

CREATE OR REPLACE FUNCTION validate_operations_product_pack_profile_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_level text;
  profile_status text;
  provider_state operations_product_channel_states%ROWTYPE;
BEGIN
  SELECT profile.package_level, profile.status
  INTO profile_level, profile_status
  FROM operations_product_pack_profiles AS profile
  WHERE profile.organization_id = NEW.organization_id
    AND profile.pipeline_id = NEW.pipeline_id
    AND profile.product_id = NEW.product_id
    AND profile.id = NEW.profile_id;

  IF profile_level IS NULL THEN
    RAISE EXCEPTION 'Product pack profile is outside the requested scope';
  END IF;
  IF NEW.is_current
     OR NEW.lifecycle_state NOT IN ('superseded', 'retired') THEN
    IF profile_level = 'each'
       AND (
         NEW.base_each_quantity <> 1
         OR NEW.unit_of_measure <> 'each'
       ) THEN
      RAISE EXCEPTION
        'Each pack profiles must represent exactly one base each';
    END IF;
    IF profile_level = 'case'
       AND (
         NEW.base_each_quantity < 2
         OR NEW.unit_of_measure <> 'case'
       ) THEN
      RAISE EXCEPTION
        'Case pack profiles must contain at least two base eaches';
    END IF;
  END IF;
  IF NEW.lifecycle_state IN ('superseded', 'retired') AND NEW.is_current THEN
    RAISE EXCEPTION
      'Superseded or retired pack profile versions cannot be current';
  END IF;

  IF NEW.lifecycle_state = 'active' THEN
    IF profile_status <> 'active' THEN
      RAISE EXCEPTION
        'An active Product pack version requires an active stable profile';
    END IF;
    IF NEW.is_current <> true THEN
      RAISE EXCEPTION
        'An active Product pack version must be the current version';
    END IF;
    IF NEW.dimension_basis <> 'outer'
       OR NEW.length_mm IS NULL
       OR NEW.width_mm IS NULL
       OR NEW.height_mm IS NULL THEN
      RAISE EXCEPTION
        'Active Product pack versions require complete outer dimensions';
    END IF;
    IF NEW.gross_weight_grams IS NULL
       OR NEW.weight_basis = 'unspecified' THEN
      RAISE EXCEPTION
        'Active Product pack versions require an evidenced gross weight';
    END IF;
    IF NEW.evidence_type = 'unknown'
       OR NEW.evidence_reference IS NULL
       OR length(btrim(NEW.evidence_reference)) NOT BETWEEN 1 AND 500
       OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION
        'Active Product pack versions require confirmed evidence';
    END IF;
    IF NEW.weight_basis = 'provider' THEN
      SELECT state.*
      INTO provider_state
      FROM operations_product_channel_states state
      WHERE state.organization_id = NEW.organization_id
        AND state.pipeline_id = NEW.pipeline_id
        AND state.product_id = NEW.product_id
        AND state.id = NEW.provider_weight_channel_state_id;
      IF provider_state.id IS NULL
         OR NEW.evidence_type <> 'provider'
         OR NEW.provider_weight_channel_state_row_version
              IS DISTINCT FROM provider_state.row_version
         OR NEW.provider_weight_source_revision
              IS DISTINCT FROM provider_state.source_revision
         OR NEW.provider_weight_source_hash
              IS DISTINCT FROM provider_state.source_hash
         OR NEW.gross_weight_grams
              IS DISTINCT FROM provider_state.weight_grams THEN
        RAISE EXCEPTION
          'Active provider weight must exactly match retained channel-state evidence';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_commerce_variant_pack_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel_state operations_product_channel_states%ROWTYPE;
  account_provider text;
  account_type text;
  account_environment text;
  account_status text;
  version_is_current boolean;
  version_lifecycle_state text;
  version_gross_weight_grams integer;
  version_base_each_quantity integer;
  version_ships_as_own_package boolean;
  profile_package_level text;
  profile_status text;
BEGIN
  -- Historical mappings must remain retireable even if a provider row was
  -- removed after the evidence was captured. Exact-current checks apply only
  -- to the live projection consumed by checkout.
  IF NOT (NEW.is_current AND NEW.projection_state = 'current') THEN
    RETURN NEW;
  END IF;

  SELECT state.*
  INTO channel_state
  FROM operations_product_channel_states state
  WHERE state.organization_id = NEW.organization_id
    AND state.integration_account_id = NEW.integration_account_id
    AND state.pipeline_id = NEW.pipeline_id
    AND state.external_product_id = NEW.external_product_id
    AND state.external_variant_id = NEW.external_variant_id;

  IF channel_state.id IS NULL THEN
    RAISE EXCEPTION
      'Variant-pack mappings require an exact retained channel-state row';
  END IF;

  SELECT
    account.provider,
    account.integration_type,
    account.environment,
    account.status
  INTO
    account_provider,
    account_type,
    account_environment,
    account_status
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF account_type <> 'commerce'
     OR account_provider <> NEW.provider
     OR channel_state.provider <> NEW.provider
     OR channel_state.product_id IS DISTINCT FROM NEW.product_id THEN
    RAISE EXCEPTION
      'Variant-pack mapping scope does not match its commerce channel state';
  END IF;

  SELECT
    version.is_current,
    version.lifecycle_state,
    version.gross_weight_grams,
    version.base_each_quantity,
    version.ships_as_own_package,
    profile.package_level,
    profile.status
  INTO
    version_is_current,
    version_lifecycle_state,
    version_gross_weight_grams,
    version_base_each_quantity,
    version_ships_as_own_package,
    profile_package_level,
    profile_status
  FROM operations_product_pack_profile_versions version
  JOIN operations_product_pack_profiles profile
    ON profile.organization_id = version.organization_id
   AND profile.pipeline_id = version.pipeline_id
   AND profile.product_id = version.product_id
   AND profile.id = version.profile_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.default_pack_profile_version_id;

  IF version_is_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'A current variant-pack mapping requires the current pack version';
  END IF;

  IF NEW.provider_lifecycle_state <> channel_state.normalized_status
     OR NEW.source_revision IS DISTINCT FROM channel_state.source_revision
     OR NEW.source_hash IS DISTINCT FROM channel_state.source_hash
     OR NEW.provider_updated_at
          IS DISTINCT FROM channel_state.provider_updated_at
     OR NEW.observed_at IS DISTINCT FROM channel_state.observed_at THEN
    RAISE EXCEPTION
      'Current variant-pack mapping evidence must exactly match channel state';
  END IF;

  IF NEW.mapping_purpose = 'shopify_checkout' THEN
    IF NEW.provider <> 'shopify'
       OR account_environment <> 'sandbox'
       OR account_status <> 'active'
       OR channel_state.normalized_status <> 'active'
       OR channel_state.provider_active IS DISTINCT FROM true
       OR channel_state.requires_shipping IS DISTINCT FROM true
       OR channel_state.weight_grams IS NULL
       OR channel_state.weight_grams < 1
       OR version_lifecycle_state <> 'active'
       OR profile_status <> 'active'
       OR version_gross_weight_grams
            IS DISTINCT FROM channel_state.weight_grams THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires exact active sandbox shipping and pack evidence';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_configs config
      WHERE config.organization_id = NEW.organization_id
        AND config.integration_account_id = NEW.integration_account_id
        AND config.registration_state = 'registered'
        AND operations_shopify_carrier_service_config_is_ready(
          config.organization_id,
          config.id
        )
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires a registered ready CarrierService';
    END IF;

    IF NOT (
      profile_package_level = 'case'
      AND version_base_each_quantity > 1
      AND version_ships_as_own_package = true
    ) AND NOT EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_configs config
      JOIN operations_approved_pack_recipes recipe
        ON recipe.organization_id = config.organization_id
       AND recipe.input_pack_profile_version_id
            = NEW.default_pack_profile_version_id
       AND recipe.lifecycle_state = 'active'
       AND recipe.is_current = true
      JOIN operations_shopify_carrier_service_config_materials selected
        ON selected.organization_id = config.organization_id
       AND selected.config_id = config.id
       AND selected.packaging_material_id = recipe.packaging_material_id
      WHERE config.organization_id = NEW.organization_id
        AND config.integration_account_id = NEW.integration_account_id
        AND config.registration_state = 'registered'
        AND operations_shopify_carrier_service_config_is_ready(
          config.organization_id,
          config.id
        )
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout mapping requires either an active self-packaged case or a selected active recipe';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_commerce_variant_pack_mapping
  ON operations_commerce_variant_pack_mappings;
CREATE TRIGGER validate_operations_commerce_variant_pack_mapping
BEFORE INSERT OR UPDATE ON operations_commerce_variant_pack_mappings
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_commerce_variant_pack_mapping();

CREATE OR REPLACE FUNCTION validate_operations_approved_pack_recipe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  input_level text;
  output_level text;
  input_rank integer;
  output_rank integer;
  input_base_each_quantity integer;
  output_base_each_quantity integer;
  input_version_state text;
  output_version_state text;
  input_version_current boolean;
  output_version_current boolean;
  input_profile_status text;
  output_profile_status text;
BEGIN
  SELECT
    profile.package_level,
    version.base_each_quantity,
    version.lifecycle_state,
    version.is_current,
    profile.status
  INTO
    input_level,
    input_base_each_quantity,
    input_version_state,
    input_version_current,
    input_profile_status
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
   AND profile.organization_id = version.organization_id
  WHERE version.organization_id = NEW.organization_id
    AND version.pipeline_id = NEW.pipeline_id
    AND version.product_id = NEW.product_id
    AND version.id = NEW.input_pack_profile_version_id;

  SELECT
    profile.package_level,
    version.base_each_quantity,
    version.lifecycle_state,
    version.is_current,
    profile.status
  INTO
    output_level,
    output_base_each_quantity,
    output_version_state,
    output_version_current,
    output_profile_status
  FROM operations_product_pack_profile_versions AS version
  JOIN operations_product_pack_profiles AS profile
    ON profile.id = version.profile_id
   AND profile.organization_id = version.organization_id
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

  IF NEW.recipe_type = 'exact_case'
     AND (
       input_base_each_quantity * NEW.input_quantity
       <> output_base_each_quantity * NEW.output_quantity
     ) THEN
    RAISE EXCEPTION
      'Exact-case recipe quantities must conserve base eaches';
  END IF;

  IF NEW.lifecycle_state = 'active' THEN
    IF NEW.is_current <> true
       OR input_version_current IS DISTINCT FROM true
       OR output_version_current IS DISTINCT FROM true
       OR input_version_state <> 'active'
       OR output_version_state <> 'active'
       OR input_profile_status <> 'active'
       OR output_profile_status <> 'active' THEN
      RAISE EXCEPTION
        'Active pack recipes require exact current active input and output packs';
    END IF;

    IF NEW.fit_evidence_type = 'unknown'
       OR NEW.fit_evidence_reference IS NULL
       OR length(btrim(NEW.fit_evidence_reference)) NOT BETWEEN 1 AND 500
       OR NEW.confirmed_at IS NULL THEN
      RAISE EXCEPTION
        'Active pack recipes require confirmed fit evidence';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM operations_packaging_materials AS material
      WHERE material.organization_id = NEW.organization_id
        AND material.id = NEW.packaging_material_id
        AND material.status = 'active'
        AND material.dimension_basis = 'inner'
        AND material.dimension_evidence_type <> 'unknown'
        AND length(btrim(material.dimension_evidence_reference))
          BETWEEN 1 AND 500
        AND material.dimension_confirmed_at IS NOT NULL
        AND material.inner_length_mm > 0
        AND material.inner_width_mm > 0
        AND material.inner_height_mm > 0
        AND material.rated_outer_length_mm > 0
        AND material.rated_outer_width_mm > 0
        AND material.rated_outer_height_mm > 0
        AND material.rated_outer_dimension_evidence_type IN (
          'customer_confirmed', 'measured', 'provider', 'legacy'
        )
        AND length(
          btrim(material.rated_outer_dimension_evidence_reference)
        ) BETWEEN 1 AND 500
        AND material.rated_outer_dimension_confirmed_at IS NOT NULL
        AND material.tare_weight_grams > 0
        AND material.max_weight_grams > material.tare_weight_grams
        AND material.unit_cost_minor > 0
        AND material.currency ~ '^[A-Z]{3}$'
    ) THEN
      RAISE EXCEPTION
        'Active pack recipes require an optimizer-ready active packaging material';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- A Shopify sell unit that is already a sealed, carrier-ready case is not an
-- approved-recipe carton. Retain its exact profile revision on the quote
-- receipt and keep recipe packages bound to material and stock evidence.
ALTER TABLE operations_shopify_checkout_rate_receipt_packages
  ADD COLUMN IF NOT EXISTS planning_method text
    NOT NULL DEFAULT 'approved_recipe',
  ADD COLUMN IF NOT EXISTS pack_profile_version_id uuid,
  ADD COLUMN IF NOT EXISTS pack_profile_version_row_version bigint,
  ADD COLUMN IF NOT EXISTS self_package_line_key text,
  ALTER COLUMN packaging_material_id DROP NOT NULL,
  ALTER COLUMN packaging_material_row_version DROP NOT NULL,
  ALTER COLUMN packaging_material_stock_id DROP NOT NULL,
  ALTER COLUMN packaging_material_stock_row_version DROP NOT NULL,
  ALTER COLUMN packaging_material_stock_on_hand_quantity DROP NOT NULL;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid =
      'operations_shopify_checkout_rate_receipt_packages'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid)
        ~ 'tare_weight_grams[^)]*> 0'
  LOOP
    EXECUTE format(
      'ALTER TABLE operations_shopify_checkout_rate_receipt_packages '
      || 'DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE operations_shopify_checkout_rate_receipt_packages
  DROP CONSTRAINT IF EXISTS
    operations_shopify_checkout_rate_receipt_packages_tare_weight_grams_check,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_planning_method_valid,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_profile_version_valid,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_profile_version_fkey,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_self_line_fkey,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_tare_nonnegative,
  ADD CONSTRAINT op_shopify_rate_packages_tare_nonnegative
    CHECK (tare_weight_grams >= 0),
  ADD CONSTRAINT op_shopify_rate_packages_planning_method_valid
    CHECK (planning_method IN ('approved_recipe', 'self_package')),
  ADD CONSTRAINT op_shopify_rate_packages_profile_version_valid
    CHECK (
      (
        planning_method = 'approved_recipe'
        AND packaging_material_id IS NOT NULL
        AND packaging_material_row_version IS NOT NULL
        AND packaging_material_stock_id IS NOT NULL
        AND packaging_material_stock_row_version IS NOT NULL
        AND packaging_material_stock_on_hand_quantity IS NOT NULL
        AND tare_weight_grams > 0
        AND pack_profile_version_id IS NULL
        AND pack_profile_version_row_version IS NULL
        AND self_package_line_key IS NULL
      )
      OR (
        planning_method = 'self_package'
        AND packaging_material_id IS NULL
        AND packaging_material_row_version IS NULL
        AND packaging_material_stock_id IS NULL
        AND packaging_material_stock_row_version IS NULL
        AND packaging_material_stock_on_hand_quantity IS NULL
        AND tare_weight_grams = 0
        AND pack_profile_version_id IS NOT NULL
        AND pack_profile_version_row_version >= 0
        AND length(btrim(self_package_line_key)) BETWEEN 1 AND 120
      )
    ),
  ADD CONSTRAINT op_shopify_rate_packages_profile_version_fkey
    FOREIGN KEY (organization_id, pack_profile_version_id)
    REFERENCES operations_product_pack_profile_versions(organization_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT op_shopify_rate_packages_self_line_fkey
    FOREIGN KEY (organization_id, receipt_id, self_package_line_key)
    REFERENCES operations_shopify_checkout_rate_receipt_lines(
      organization_id, receipt_id, line_key
    ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_child()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  requested_organization_id uuid;
  requested_receipt_id uuid;
  retained_count bigint;
  material_ready boolean;
  self_package_ready boolean;
  offer_ready boolean;
  target_planning_method text;
  target_self_package_line_key text;
BEGIN
  requested_organization_id := COALESCE(
    NEW.organization_id, OLD.organization_id
  );
  requested_receipt_id := COALESCE(NEW.receipt_id, OLD.receipt_id);
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt child evidence is immutable';
  END IF;
  SELECT status INTO receipt_status
  FROM operations_shopify_checkout_rate_receipts
  WHERE organization_id = requested_organization_id
    AND id = requested_receipt_id;
  IF receipt_status IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION
      'Shopify checkout receipt children require a processing claim';
  END IF;

  IF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_lines' THEN
    SELECT count(*) INTO retained_count
    FROM operations_shopify_checkout_rate_receipt_lines
    WHERE organization_id = NEW.organization_id
      AND receipt_id = NEW.receipt_id;
    IF retained_count >= (
      SELECT line_count
      FROM operations_shopify_checkout_rate_receipts
      WHERE organization_id = NEW.organization_id
        AND id = NEW.receipt_id
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout receipt line count is already complete';
    END IF;
  ELSIF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_packages' THEN
    IF NEW.planning_method = 'approved_recipe' THEN
      PERFORM 1
      FROM operations_packaging_material_stock stock
      WHERE stock.organization_id = NEW.organization_id
        AND stock.id = NEW.packaging_material_stock_id
      FOR SHARE;
      SELECT EXISTS (
        SELECT 1
        FROM operations_shopify_checkout_rate_receipts receipt
        JOIN operations_shopify_carrier_service_config_materials selected
          ON selected.organization_id = receipt.organization_id
         AND selected.config_id = receipt.config_id
         AND selected.packaging_material_id = NEW.packaging_material_id
        JOIN operations_packaging_materials material
          ON material.organization_id = selected.organization_id
         AND material.id = selected.packaging_material_id
        JOIN operations_packaging_material_stock stock
          ON stock.organization_id = material.organization_id
         AND stock.id = NEW.packaging_material_stock_id
         AND stock.packaging_material_id = material.id
         AND stock.warehouse_id = receipt.warehouse_id
        WHERE receipt.organization_id = NEW.organization_id
          AND receipt.id = NEW.receipt_id
          AND selected.packaging_material_row_version
            = NEW.packaging_material_row_version
          AND material.row_version = NEW.packaging_material_row_version
          AND stock.row_version
            = NEW.packaging_material_stock_row_version
          AND stock.on_hand_quantity
            = NEW.packaging_material_stock_on_hand_quantity
          AND stock.is_available = true
          AND stock.on_hand_quantity > 0
          AND material.rated_outer_length_mm
            = NEW.rated_outer_length_mm
          AND material.rated_outer_width_mm
            = NEW.rated_outer_width_mm
          AND material.rated_outer_height_mm
            = NEW.rated_outer_height_mm
          AND material.tare_weight_grams = NEW.tare_weight_grams
          AND (
            material.max_weight_grams IS NULL
            OR NEW.gross_weight_grams <= material.max_weight_grams
          )
      ) INTO material_ready;
      IF NOT material_ready THEN
        RAISE EXCEPTION
          'Shopify checkout package must use an exact selected material revision';
      END IF;
    ELSE
      PERFORM 1
      FROM operations_product_pack_profile_versions version
      JOIN operations_commerce_variant_pack_mappings mapping
        ON mapping.organization_id = version.organization_id
       AND mapping.default_pack_profile_version_id = version.id
      WHERE version.organization_id = NEW.organization_id
        AND version.id = NEW.pack_profile_version_id
      FOR SHARE OF version, mapping;
      SELECT EXISTS (
        SELECT 1
        FROM operations_shopify_checkout_rate_receipts receipt
        JOIN operations_shopify_checkout_rate_receipt_lines line
          ON line.organization_id = receipt.organization_id
         AND line.receipt_id = receipt.id
         AND line.line_key = NEW.self_package_line_key
        JOIN operations_commerce_variant_pack_mappings mapping
          ON mapping.organization_id = receipt.organization_id
         AND mapping.integration_account_id =
               receipt.integration_account_id
         AND mapping.provider = 'shopify'
         AND mapping.external_variant_id = line.provider_variant_id
         AND mapping.mapping_purpose = 'shopify_checkout'
         AND mapping.projection_state = 'current'
         AND mapping.is_current = true
         AND mapping.default_pack_profile_version_id =
               NEW.pack_profile_version_id
        JOIN operations_product_channel_states state
          ON state.organization_id = mapping.organization_id
         AND state.integration_account_id = mapping.integration_account_id
         AND state.provider = mapping.provider
         AND state.external_product_id = mapping.external_product_id
         AND state.external_variant_id = mapping.external_variant_id
         AND state.product_id = mapping.product_id
        JOIN operations_product_pack_profile_versions version
          ON version.organization_id = mapping.organization_id
         AND version.pipeline_id = mapping.pipeline_id
         AND version.product_id = mapping.product_id
         AND version.id = mapping.default_pack_profile_version_id
        JOIN operations_product_pack_profiles profile
          ON profile.organization_id = version.organization_id
         AND profile.pipeline_id = version.pipeline_id
         AND profile.product_id = version.product_id
         AND profile.id = version.profile_id
        WHERE receipt.organization_id = NEW.organization_id
          AND receipt.id = NEW.receipt_id
          AND state.normalized_status = 'active'
          AND state.provider_active = true
          AND state.requires_shipping = true
          AND state.weight_grams = line.unit_weight_grams
          AND mapping.provider_lifecycle_state = state.normalized_status
          AND mapping.source_revision = state.source_revision
          AND mapping.source_hash = state.source_hash
          AND version.row_version =
                NEW.pack_profile_version_row_version
          AND version.is_current = true
          AND version.lifecycle_state = 'active'
          AND version.ships_as_own_package = true
          AND version.base_each_quantity > 1
          AND version.dimension_basis = 'outer'
          AND version.length_mm = NEW.rated_outer_length_mm
          AND version.width_mm = NEW.rated_outer_width_mm
          AND version.height_mm = NEW.rated_outer_height_mm
          AND version.gross_weight_grams = NEW.gross_weight_grams
          AND version.gross_weight_grams = NEW.content_weight_grams
          AND version.gross_weight_grams = line.unit_weight_grams
          AND profile.package_level = 'case'
          AND profile.status = 'active'
          AND NEW.tare_weight_grams = 0
      ) INTO self_package_ready;
      IF NOT self_package_ready THEN
        RAISE EXCEPTION
          'Shopify checkout self-package must use the exact current active case revision';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_allocations' THEN
    SELECT package.planning_method, package.self_package_line_key
    INTO target_planning_method, target_self_package_line_key
    FROM operations_shopify_checkout_rate_receipt_packages package
    WHERE package.organization_id = NEW.organization_id
      AND package.receipt_id = NEW.receipt_id
      AND package.package_key = NEW.package_key;
    IF target_planning_method = 'self_package'
       AND (
         NEW.line_key <> target_self_package_line_key
         OR NEW.quantity <> 1
       ) THEN
      RAISE EXCEPTION
        'Each self-package must allocate exactly one sell unit from its source line';
    END IF;
  ELSIF TG_TABLE_NAME
       = 'operations_shopify_checkout_rate_receipt_offers' THEN
    SELECT EXISTS (
      SELECT 1
      FROM operations_shopify_checkout_rate_receipts receipt
      JOIN operations_shopify_carrier_service_config_carriers selected
        ON selected.organization_id = receipt.organization_id
       AND selected.config_id = receipt.config_id
       AND selected.carrier_provider = NEW.carrier_provider
       AND selected.carrier_account_id = NEW.carrier_account_id
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = selected.organization_id
       AND carrier_account.id = selected.carrier_account_id
      JOIN operations_carrier_rate_requests rate_evidence
        ON rate_evidence.organization_id = receipt.organization_id
       AND rate_evidence.id = NEW.carrier_rate_request_id
       AND rate_evidence.integration_account_id
         = carrier_account.integration_account_id
       AND rate_evidence.provider = NEW.carrier_provider
       AND rate_evidence.purpose = NEW.carrier_rate_purpose
       AND rate_evidence.carrier_account_id = NEW.carrier_account_id
       AND rate_evidence.status = 'succeeded'
       AND rate_evidence.request_hash = NEW.carrier_request_hash
       AND rate_evidence.requested_at >= receipt.created_at
       AND rate_evidence.completed_at
         <= receipt.created_at + interval '30 seconds'
      JOIN operations_carrier_credentials current_credential
        ON current_credential.organization_id
          = carrier_account.organization_id
       AND current_credential.integration_account_id
          = carrier_account.integration_account_id
       AND current_credential.credential_version
          = rate_evidence.credential_version
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.id = NEW.receipt_id
        AND rate_evidence.redacted_request #>>
          '{shipment,destinationFingerprint}'
          = receipt.carrier_destination_fingerprint
        AND rate_evidence.redacted_request #>>
          '{shipment,rateScope}' = 'multi_package_shipment'
        AND rate_evidence.redacted_request #>
          '{shipment,packageCount}' = (
            SELECT to_jsonb(count(*)::integer)
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND rate_evidence.redacted_request #>
          '{shipment,parcels}' = (
            SELECT jsonb_agg(
              package.carrier_parcel_snapshot
              ORDER BY package.package_sequence, package.package_key
            )
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND rate_evidence.redacted_response #>>
          '{rateScope}' = 'multi_package_shipment'
        AND rate_evidence.redacted_response #>
          '{packageCount}' = (
            SELECT to_jsonb(count(*)::integer)
            FROM operations_shopify_checkout_rate_receipt_packages package
            WHERE package.organization_id = receipt.organization_id
              AND package.receipt_id = receipt.id
          )
        AND operations_shopify_checkout_carrier_rate_matches(
          rate_evidence.redacted_response,
          NEW.service_code,
          NEW.service_name,
          NEW.carrier_cost_minor,
          NEW.currency,
          NEW.carrier_response_rate_hash
        )
        AND (
          (
            NEW.carrier_provider = 'ups_rest'
            AND NEW.shopify_service_code LIKE 'clawpilot:ups:%'
          )
          OR (
            NEW.carrier_provider = 'fedex_rest'
            AND NEW.shopify_service_code LIKE 'clawpilot:fedex:%'
          )
        )
    ) INTO offer_ready;
    IF NOT offer_ready THEN
      RAISE EXCEPTION
        'Shopify checkout offer requires exact configured carrier and rate evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_self_package_finalize()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'succeeded'
     AND EXISTS (
       SELECT 1
       FROM operations_shopify_checkout_rate_receipt_packages package
       LEFT JOIN operations_shopify_checkout_rate_receipt_allocations allocation
         ON allocation.organization_id = package.organization_id
        AND allocation.receipt_id = package.receipt_id
        AND allocation.package_key = package.package_key
       WHERE package.organization_id = NEW.organization_id
         AND package.receipt_id = NEW.id
         AND package.planning_method = 'self_package'
       GROUP BY
         package.package_key,
         package.self_package_line_key,
         package.content_weight_grams,
         package.gross_weight_grams,
         package.tare_weight_grams
       HAVING count(allocation.line_key) <> 1
          OR min(allocation.line_key)
               IS DISTINCT FROM package.self_package_line_key
          OR sum(allocation.quantity) <> 1
          OR package.tare_weight_grams <> 0
          OR package.content_weight_grams <> package.gross_weight_grams
     ) THEN
    RAISE EXCEPTION
      'Shopify checkout self-package receipt evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_checkout_self_package_finalize_write
  ON operations_shopify_checkout_rate_receipts;
CREATE TRIGGER
  validate_operations_shopify_checkout_self_package_finalize_write
BEFORE UPDATE ON operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_self_package_finalize();

COMMENT ON FUNCTION
  validate_operations_commerce_variant_pack_mapping() IS
  'Prevents current provider-pack mappings from drifting from the exact retained channel-state revision and current pack version.';
COMMENT ON COLUMN
  operations_commerce_variant_pack_mappings.mapping_purpose IS
  'catalog retains an exact provider-to-pack association; shopify_checkout additionally proves the active registered checkout path is ready.';
COMMENT ON COLUMN
  operations_product_pack_profile_versions.provider_weight_channel_state_id IS
  'Exact retained provider channel-state row used as the authority for a provider-basis gross weight.';
COMMENT ON FUNCTION validate_operations_approved_pack_recipe() IS
  'Requires active recipes to bind exact current active packs, confirmed fit evidence, an active material, and conserved exact-case quantities.';
COMMENT ON COLUMN
  operations_shopify_checkout_rate_receipt_packages.planning_method IS
  'approved_recipe retains selected material evidence; self_package retains one exact current ship-ready case profile per sell unit.';
