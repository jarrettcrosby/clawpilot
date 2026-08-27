BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Checkout unit-material packages use the same exact selected material and
-- warehouse-stock evidence as approved-recipe cartons, but retain distinct
-- planner provenance and exactly one one-each allocation.
ALTER TABLE operations_shopify_checkout_rate_receipt_packages
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_planning_method_valid,
  DROP CONSTRAINT IF EXISTS
    op_shopify_rate_packages_profile_version_valid;

ALTER TABLE operations_shopify_checkout_rate_receipt_packages
  ADD CONSTRAINT op_shopify_rate_packages_planning_method_valid
    CHECK (
      planning_method IN (
        'approved_recipe',
        'self_package',
        'unit_material_selection'
      )
    ),
  ADD CONSTRAINT op_shopify_rate_packages_profile_version_valid
    CHECK (
      (
        planning_method IN (
          'approved_recipe',
          'unit_material_selection'
        )
        AND packaging_material_id IS NOT NULL
        AND packaging_material_row_version IS NOT NULL
        AND packaging_material_stock_id IS NOT NULL
        AND packaging_material_stock_row_version IS NOT NULL
        AND packaging_material_stock_on_hand_quantity IS NOT NULL
        AND tare_weight_grams > 0
        AND pack_profile_version_id IS NULL
        AND pack_profile_version_row_version IS NULL
        AND self_package_line_key IS NULL
        AND (
          planning_method <> 'unit_material_selection'
          OR allocation_count = 1
        )
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
    );

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_carrier_request_parcel_snapshot(
    planning_method text,
    package_sequence integer,
    rated_outer_length_mm integer,
    rated_outer_width_mm integer,
    rated_outer_height_mm integer,
    gross_weight_grams integer
  )
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_build_object(
    'description',
      CASE planning_method
        WHEN 'self_package'
          THEN 'ClawPilot sealed case ' || package_sequence::text
        WHEN 'approved_recipe'
          THEN 'ClawPilot carton ' || package_sequence::text
        WHEN 'unit_material_selection'
          THEN 'ClawPilot carton ' || package_sequence::text
        ELSE NULL
      END,
    'length', ceil(rated_outer_length_mm::numeric / 25.4)::integer,
    'width', ceil(rated_outer_width_mm::numeric / 25.4)::integer,
    'height', ceil(rated_outer_height_mm::numeric / 25.4)::integer,
    'dimensionUnit', 'IN',
    'weight', greatest(
      0.1::numeric,
      ceil(
        (gross_weight_grams::numeric / 453.59237::numeric) * 10
      ) / 10
    ),
    'weightUnit', 'LB'
  );
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_status text;
  requested_organization_id uuid;
  requested_receipt_id uuid;
  material_ready boolean;
  self_package_ready boolean;
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

  IF NEW.planning_method IN (
    'approved_recipe',
    'unit_material_selection'
  ) THEN
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
       AND mapping.integration_account_id = receipt.integration_account_id
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
        AND mapping.pack_evidence_hash = state.pack_evidence_hash
        AND version.row_version = NEW.pack_profile_version_row_version
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
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_receipt_package_write
  ON operations_shopify_checkout_rate_receipt_packages;
CREATE TRIGGER
  protect_operations_shopify_checkout_rate_receipt_package_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_checkout_rate_receipt_packages
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_receipt_package();

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_unit_material_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_planning_method text;
  retained_allocation_count bigint;
BEGIN
  SELECT package.planning_method
  INTO target_planning_method
  FROM operations_shopify_checkout_rate_receipt_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.receipt_id = NEW.receipt_id
    AND package.package_key = NEW.package_key
  FOR UPDATE;
  IF target_planning_method <> 'unit_material_selection' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO retained_allocation_count
  FROM operations_shopify_checkout_rate_receipt_allocations allocation
  WHERE allocation.organization_id = NEW.organization_id
    AND allocation.receipt_id = NEW.receipt_id
    AND allocation.package_key = NEW.package_key;
  IF NEW.quantity <> 1 OR retained_allocation_count <> 0 THEN
    RAISE EXCEPTION
      'Each Shopify checkout unit-material package must allocate exactly one line unit';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_shopify_checkout_unit_material_allocation_write
  ON operations_shopify_checkout_rate_receipt_allocations;
CREATE TRIGGER
  validate_shopify_checkout_unit_material_allocation_write
BEFORE INSERT ON operations_shopify_checkout_rate_receipt_allocations
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_unit_material_allocation();

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_unit_material_finalize()
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
         AND package.planning_method = 'unit_material_selection'
       GROUP BY package.package_key
       HAVING count(allocation.line_key) <> 1
          OR sum(allocation.quantity) <> 1
     ) THEN
    RAISE EXCEPTION
      'Shopify checkout unit-material receipt evidence is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_shopify_checkout_unit_material_finalize_write
  ON operations_shopify_checkout_rate_receipts;
CREATE TRIGGER
  validate_shopify_checkout_unit_material_finalize_write
BEFORE UPDATE ON operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_unit_material_finalize();

COMMENT ON COLUMN
  operations_shopify_checkout_rate_receipt_packages.planning_method IS
  'approved_recipe and unit_material_selection retain selected material evidence; self_package retains one exact current ship-ready case profile per sell unit.';

COMMENT ON FUNCTION
  validate_operations_shopify_checkout_unit_material_allocation() IS
  'Requires each checkout unit-material package to retain only one quantity-one line allocation.';

COMMENT ON FUNCTION
  validate_operations_shopify_checkout_unit_material_finalize() IS
  'Prevents a checkout receipt from succeeding unless every unit-material package has exactly one quantity-one allocation.';

COMMIT;
