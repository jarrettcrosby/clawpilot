-- A retained exact measurement is itself the inner-dimension evidence. The
-- application stamps the confirming actor and time when it saves a measured
-- row; an operator-authored free-form reference is not required. Provider and
-- customer-confirmed facts still require their external evidence reference.

ALTER TABLE operations_packaging_materials
  DROP CONSTRAINT IF EXISTS
    operations_packaging_materials_dimension_evidence_valid;

ALTER TABLE operations_packaging_materials
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
      dimension_evidence_type <> 'measured'
      OR (
        inner_length_mm IS NOT NULL
        AND inner_length_mm > 0
        AND inner_width_mm IS NOT NULL
        AND inner_width_mm > 0
        AND inner_height_mm IS NOT NULL
        AND inner_height_mm > 0
        AND dimension_confirmed_at IS NOT NULL
      )
    )
    AND (
      dimension_evidence_type NOT IN ('customer_confirmed', 'provider')
      OR (
        dimension_confirmed_at IS NOT NULL
        AND dimension_evidence_reference IS NOT NULL
        AND length(btrim(dimension_evidence_reference)) BETWEEN 1 AND 500
      )
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT
  operations_packaging_materials_dimension_evidence_valid
  ON operations_packaging_materials IS
  'Measured evidence requires exact positive dimensions and a retained confirmation timestamp; provider and customer-confirmed evidence additionally require a nonblank reference. Existing rows are not fabricated or backfilled.';

CREATE OR REPLACE FUNCTION public.validate_operations_approved_pack_recipe()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
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
  FROM public.operations_product_pack_profile_versions AS version
  JOIN public.operations_product_pack_profiles AS profile
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
  FROM public.operations_product_pack_profile_versions AS version
  JOIN public.operations_product_pack_profiles AS profile
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
      FROM public.operations_packaging_materials AS material
      WHERE material.organization_id = NEW.organization_id
        AND material.id = NEW.packaging_material_id
        AND material.status = 'active'
        AND material.dimension_basis = 'inner'
        AND material.dimension_evidence_type <> 'unknown'
        AND (
          material.dimension_evidence_type = 'measured'
          OR length(btrim(material.dimension_evidence_reference))
            BETWEEN 1 AND 500
        )
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

COMMENT ON FUNCTION public.validate_operations_approved_pack_recipe() IS
  'Retains pack-level and fit-evidence boundaries while allowing timestamped exact measured material dimensions to omit a redundant free-form reference.';
