BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- An ordinary item can have order-specific physical facts without being
-- assigned to a Product pack. Weight-only facts remain valid for a truthful
-- one-unit fallback; when dimensions are recorded, all three are required.
ALTER TABLE public.operations_order_unit_weight_facts
  ADD COLUMN unit_length_mm integer,
  ADD COLUMN unit_width_mm integer,
  ADD COLUMN unit_height_mm integer,
  ADD COLUMN dimension_evidence_basis text;

ALTER TABLE public.operations_order_unit_weight_facts
  ADD CONSTRAINT operations_order_unit_weight_facts_dimensions_valid CHECK (
    (
      unit_length_mm IS NULL
      AND unit_width_mm IS NULL
      AND unit_height_mm IS NULL
      AND dimension_evidence_basis IS NULL
    ) OR (
      unit_length_mm BETWEEN 1 AND 1000000
      AND unit_width_mm BETWEEN 1 AND 1000000
      AND unit_height_mm BETWEEN 1 AND 1000000
      AND dimension_evidence_basis = 'operator_recorded_order_dimensions'
    )
  );

CREATE OR REPLACE FUNCTION public.validate_operations_order_unit_weight_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior public.operations_order_unit_weight_facts%ROWTYPE;
BEGIN
  IF NEW.fact_hash IS DISTINCT FROM pg_catalog.encode(
    public.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'candidateGlobalId', (
            SELECT candidate.global_id
            FROM public.operations_commerce_order_candidates candidate
            WHERE candidate.id = NEW.candidate_id
          ),
          'candidateRowVersion', NEW.candidate_row_version,
          'factGlobalId', NEW.global_id,
          'factVersion', NEW.fact_version,
          'lineGlobalId', NEW.planning_line_global_id,
          'lineSourceHash', NEW.line_source_hash,
          'lineSourceRevision', NEW.line_source_revision,
          'unitDimensionsMm', CASE
            WHEN NEW.unit_length_mm IS NULL THEN NULL
            ELSE pg_catalog.jsonb_build_object(
              'height', NEW.unit_height_mm,
              'length', NEW.unit_length_mm,
              'width', NEW.unit_width_mm
            )
          END,
          'unitWeightGrams', NEW.unit_weight_grams
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) THEN
    RAISE EXCEPTION 'Order unit fact hash is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_commerce_current_planning_lines line
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = line.organization_id
     AND candidate.id = line.order_candidate_id
    JOIN public.operations_orders order_row
      ON order_row.organization_id = candidate.organization_id
     AND order_row.id = candidate.canonical_order_id
    JOIN public.operations_current_order_lines order_line
      ON order_line.organization_id = order_row.organization_id
     AND order_line.order_id = order_row.id
     AND order_line.id = line.canonical_order_line_id
    LEFT JOIN public.operations_commerce_order_revision_application_lines
      revision_line
      ON revision_line.organization_id = line.organization_id
     AND revision_line.integration_account_id = line.integration_account_id
     AND revision_line.pipeline_id = line.pipeline_id
     AND revision_line.application_id =
           candidate.accepted_revision_application_id
     AND revision_line.planning_line_id = line.id
     AND revision_line.planning_global_id = line.global_id
     AND revision_line.active = true
    LEFT JOIN public.operations_product_channel_states channel_state
      ON channel_state.organization_id = line.organization_id
     AND channel_state.integration_account_id = line.integration_account_id
     AND channel_state.pipeline_id = line.pipeline_id
     AND channel_state.provider = line.provider
     AND channel_state.external_product_id = line.external_product_id
     AND channel_state.external_variant_id = line.external_variant_id
     AND channel_state.product_id = line.product_id
     AND channel_state.product_mapping_id = line.product_mapping_id
    WHERE line.organization_id = NEW.organization_id
      AND line.integration_account_id = NEW.integration_account_id
      AND line.pipeline_id = NEW.pipeline_id
      AND line.order_candidate_id = NEW.candidate_id
      AND line.id = NEW.planning_line_id
      AND line.global_id = NEW.planning_line_global_id
      AND line.source_revision = NEW.line_source_revision
      AND line.source_hash = NEW.line_source_hash
      AND line.canonical_order_line_id = NEW.order_line_id
      AND (
        (
          candidate.accepted_revision_application_id IS NULL
          AND NEW.candidate_line_id = line.id
          AND NEW.revision_application_line_id IS NULL
        ) OR (
          candidate.accepted_revision_application_id IS NOT NULL
          AND NEW.candidate_line_id IS NULL
          AND NEW.revision_application_line_id = revision_line.id
        )
      )
      AND candidate.workflow_state = 'promoted'
      AND candidate.row_version = NEW.candidate_row_version
      AND candidate.canonical_order_id = NEW.order_id
      AND order_row.status IN ('imported', 'validated', 'held')
      AND line.workflow_state = 'promoted'
      AND line.requires_shipping = true
      AND line.unfulfilled_quantity > 0
      AND line.unit_multiplier = 1
      AND line.mapping_state = 'resolved'
      AND line.product_id IS NOT NULL
      AND line.product_mapping_id IS NOT NULL
      AND line.packaging_state = 'not_required'
      AND line.packaging_source = 'none'
      AND line.commerce_variant_pack_mapping_id IS NULL
      AND line.pack_profile_version_id IS NULL
      AND (
        (
          line.packaging_weight_source = 'provider_order'
          AND COALESCE(line.weight_grams, 0) > 0
          AND NEW.unit_weight_grams = line.weight_grams
        ) OR (
          (
            line.packaging_weight_source IS DISTINCT FROM 'provider_order'
            OR COALESCE(line.weight_grams, 0) <= 0
          )
          AND COALESCE(channel_state.weight_grams, 0) > 0
          AND NEW.unit_weight_grams = channel_state.weight_grams
        ) OR (
          (
            line.packaging_weight_source IS DISTINCT FROM 'provider_order'
            OR COALESCE(line.weight_grams, 0) <= 0
          )
          AND COALESCE(channel_state.weight_grams, 0) <= 0
        )
      )
      AND length(pg_catalog.btrim(line.source_revision)) > 0
      AND line.source_hash ~ '^[a-f0-9]{64}$'
  ) THEN
    RAISE EXCEPTION
      'Order unit facts require one current exact ordinary-unit line';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.operations_command_receipts receipt
    JOIN public.operations_commerce_order_candidates candidate
      ON candidate.organization_id = receipt.organization_id
     AND candidate.id = NEW.candidate_id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.command_receipt_id
      AND receipt.command_type = 'operations.record_order_unit_weights'
      AND receipt.status = 'processing'
      AND receipt.request_hash = NEW.request_hash
      AND receipt.target_global_id = candidate.global_id
      AND receipt.actor_email = NEW.recorded_by
  ) THEN
    RAISE EXCEPTION
      'Order unit facts require their exact processing command receipt';
  END IF;

  IF NEW.fact_version = 1 THEN
    IF NEW.supersedes_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'First order unit fact cannot supersede another fact';
    END IF;
  ELSE
    SELECT * INTO prior
    FROM public.operations_order_unit_weight_facts fact
    WHERE fact.id = NEW.supersedes_fact_id
    FOR SHARE;
    IF NOT FOUND
      OR prior.organization_id IS DISTINCT FROM NEW.organization_id
      OR prior.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR prior.candidate_line_id IS DISTINCT FROM NEW.candidate_line_id
      OR prior.revision_application_line_id IS DISTINCT FROM
           NEW.revision_application_line_id
      OR prior.planning_line_global_id IS DISTINCT FROM NEW.planning_line_global_id
      OR prior.line_source_revision IS DISTINCT FROM NEW.line_source_revision
      OR prior.line_source_hash IS DISTINCT FROM NEW.line_source_hash
      OR prior.fact_version + 1 IS DISTINCT FROM NEW.fact_version
      OR EXISTS (
        SELECT 1
        FROM public.operations_order_unit_weight_facts newer
        WHERE newer.supersedes_fact_id = prior.id
      )
    THEN
      RAISE EXCEPTION
        'Order unit fact correction must extend the latest exact fact';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  public.validate_operations_cartonization_unit_material_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retained_package jsonb;
  retained_evidence jsonb;
  fit_evidence jsonb;
  allocation_quantity integer;
  material_global_id text;
BEGIN
  IF NEW.planning_method <> 'unit_material_selection' THEN
    RETURN NEW;
  END IF;

  SELECT package_plan, evidence.plan_snapshot->
           'operationalUnitMaterialPlan'->'evidence'
    INTO retained_package, retained_evidence
  FROM public.operations_cartonization_rate_evidence evidence
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
    evidence.plan_snapshot->'operationalUnitMaterialPlan'->'packages'
  ) package_plan
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.evidence_id
    AND evidence.evidence_mode = 'operational'
    AND package_plan->>'packageKey' = NEW.package_key;

  SELECT material.global_id INTO material_global_id
  FROM public.operations_packaging_materials material
  WHERE material.organization_id = NEW.organization_id
    AND material.id = NEW.packaging_material_id;

  IF retained_package IS NULL
    OR retained_evidence->>'policyVersion' IS DISTINCT FROM
         'operational-unit-material-fixed-axis-v2'
    OR retained_evidence->>'productPackConstraint' IS DISTINCT FROM
         'not_required_for_ordinary_unit'
    OR retained_evidence->'packageSelectionPolicies' IS DISTINCT FROM
         '{"dimensioned":"fewest_packages_then_material_cost_then_inner_cube","undimensioned":"largest_selected_factual_container_with_available_stock"}'::jsonb
    OR retained_evidence->>'combinationPolicy' IS DISTINCT FROM
         'same_line_fixed_axis_only'
    OR retained_evidence->>'unitWeightAuthority' IS DISTINCT FROM
         'provider_or_order_specific'
    OR retained_evidence->>'unitDimensionsAuthority' IS DISTINCT FROM
         'order_specific_or_one_each_without_fit_claim'
    OR retained_evidence->>'rotationAllowed' IS DISTINCT FROM 'false'
    OR retained_evidence->>'materialAuthority' IS DISTINCT FROM
         'current_active_material_and_unclaimed_warehouse_stock'
    OR retained_evidence->>'inventoryAuthority' NOT IN (
         'shopify_provider_commitment_less_active_reservations',
         'shadow_training_simulated'
       )
    OR pg_catalog.jsonb_typeof(retained_package->'allocations')
         IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(retained_package->'allocations') <> 1
    OR retained_package->'allocations' IS DISTINCT FROM NEW.allocations
    OR retained_package->>'planningMethod' IS DISTINCT FROM
         'unit_material_selection'
    OR retained_package->>'packageSequence' IS DISTINCT FROM
         NEW.package_sequence::text
    OR material_global_id IS NULL
    OR retained_package->>'packagingMaterialGlobalId' IS DISTINCT FROM
         material_global_id
    OR retained_package->>'materialRowVersion' IS DISTINCT FROM
         NEW.material_row_version::text
    OR retained_package->'recipes' IS DISTINCT FROM '[]'::jsonb
    OR retained_package->'orToolsProfiles' IS DISTINCT FROM '[]'::jsonb
    OR retained_package->'innerDimensionsMm' IS DISTINCT FROM
         NEW.inner_dimensions_mm
    OR retained_package->'ratedOuterDimensionsMm' IS DISTINCT FROM
         NEW.rated_outer_dimensions_mm
    OR retained_package->>'contentWeightGrams' IS DISTINCT FROM
         NEW.content_weight_grams::text
    OR retained_package->>'tareWeightGrams' IS DISTINCT FROM
         NEW.tare_weight_grams::text
    OR retained_package->>'ratedGrossWeightGrams' IS DISTINCT FROM
         NEW.rated_gross_weight_grams::text
    OR retained_package->>'maxWeightGrams' IS DISTINCT FROM
         NEW.max_weight_grams::text
  THEN
    RAISE EXCEPTION
      'Unit-material packages require exact retained operational evidence';
  END IF;

  IF retained_package->'allocations'->0->>'quantity'
       !~ '^[1-9][0-9]{0,8}$' THEN
    RAISE EXCEPTION 'Unit-material allocation quantity is invalid';
  END IF;
  allocation_quantity :=
    (retained_package->'allocations'->0->>'quantity')::integer;
  fit_evidence := retained_package->'unitMaterialEvidence';

  IF pg_catalog.jsonb_typeof(fit_evidence) IS DISTINCT FROM 'object'
    OR fit_evidence->>'policyVersion' IS DISTINCT FROM
         'operational-unit-material-fixed-axis-v2'
    OR fit_evidence->>'productPackConstraint' IS DISTINCT FROM
         'not_required_for_ordinary_unit'
    OR fit_evidence->>'unitsPerPackage' IS DISTINCT FROM
         allocation_quantity::text
    OR fit_evidence->>'unitWeightGrams' !~ '^[1-9][0-9]{0,8}$'
    OR retained_package->>'contentWeightGrams' !~ '^[1-9][0-9]{0,8}$'
    OR (fit_evidence->>'unitWeightGrams')::integer * allocation_quantity <>
         (retained_package->>'contentWeightGrams')::integer
    OR (retained_package->>'contentWeightGrams')::integer <>
         NEW.content_weight_grams
    OR fit_evidence->>'rotationAllowed' IS DISTINCT FROM 'false'
    OR fit_evidence->>'unitWeightAuthority' IS DISTINCT FROM
         'provider_or_order_specific'
    OR NEW.max_weight_grams IS NULL
    OR fit_evidence->>'weightCapacityUnits' !~ '^[1-9][0-9]{0,8}$'
    OR (fit_evidence->>'weightCapacityUnits')::integer <>
         (NEW.max_weight_grams - NEW.tare_weight_grams) /
           (fit_evidence->>'unitWeightGrams')::integer
    OR fit_evidence->>'effectiveCapacityUnits'
         !~ '^[1-9][0-9]{0,15}$'
    OR (fit_evidence->>'effectiveCapacityUnits')::integer <
         allocation_quantity
  THEN
    RAISE EXCEPTION 'Unit-material package fit evidence is invalid';
  END IF;

  IF fit_evidence->>'fitModel' = 'fixed_axis_regular_grid' THEN
    IF fit_evidence->>'packageSelectionBasis' IS DISTINCT FROM
         'fewest_packages_then_material_cost_then_inner_cube'
      OR fit_evidence->>'unitDimensionsAuthority' IS DISTINCT FROM
         'order_specific'
      OR NOT public.operations_cartonization_dimensions_mm_valid(
        fit_evidence->'unitDimensionsMm'
      )
      OR NOT public.operations_cartonization_dimensions_mm_valid(
        fit_evidence->'axisCounts'
      )
      OR (fit_evidence->'axisCounts'->>'length')::integer <>
           (NEW.inner_dimensions_mm->>'length')::integer /
             (fit_evidence->'unitDimensionsMm'->>'length')::integer
      OR (fit_evidence->'axisCounts'->>'width')::integer <>
           (NEW.inner_dimensions_mm->>'width')::integer /
             (fit_evidence->'unitDimensionsMm'->>'width')::integer
      OR (fit_evidence->'axisCounts'->>'height')::integer <>
           (NEW.inner_dimensions_mm->>'height')::integer /
             (fit_evidence->'unitDimensionsMm'->>'height')::integer
      OR fit_evidence->>'spatialCapacityUnits'
           !~ '^[1-9][0-9]{0,15}$'
      OR (fit_evidence->>'spatialCapacityUnits')::numeric <>
           (fit_evidence->'axisCounts'->>'length')::numeric *
           (fit_evidence->'axisCounts'->>'width')::numeric *
           (fit_evidence->'axisCounts'->>'height')::numeric
      OR (fit_evidence->>'effectiveCapacityUnits')::numeric <>
           LEAST(
             (fit_evidence->>'weightCapacityUnits')::numeric,
             (fit_evidence->>'spatialCapacityUnits')::numeric
           )
    THEN
      RAISE EXCEPTION 'Fixed-axis unit-material fit evidence is invalid';
    END IF;
  ELSIF fit_evidence->>'fitModel' = 'one_each_without_fit_claim' THEN
    IF fit_evidence->>'packageSelectionBasis' IS DISTINCT FROM
         'largest_selected_factual_container_with_available_stock'
      OR allocation_quantity <> 1
      OR fit_evidence->>'unitDimensionsAuthority' IS DISTINCT FROM
           'unavailable'
      OR fit_evidence->'unitDimensionsMm' IS DISTINCT FROM 'null'::jsonb
      OR fit_evidence->'axisCounts' IS DISTINCT FROM 'null'::jsonb
      OR fit_evidence->'spatialCapacityUnits' IS DISTINCT FROM 'null'::jsonb
      OR fit_evidence->>'effectiveCapacityUnits' IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'One-each unit-material evidence is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unit-material fit model is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.operations_cartonization_rate_evidence_package_recipes recipe
    WHERE recipe.organization_id = NEW.organization_id
      AND recipe.evidence_id = NEW.evidence_id
      AND recipe.package_key = NEW.package_key
  ) OR EXISTS (
    SELECT 1
    FROM public.operations_cartonization_rate_evidence_package_profiles profile
    WHERE profile.organization_id = NEW.organization_id
      AND profile.evidence_id = NEW.evidence_id
      AND profile.package_key = NEW.package_key
  ) THEN
    RAISE EXCEPTION
      'Unit-material packages cannot retain recipe or Product-pack profile edges';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON TABLE public.operations_order_unit_weight_facts IS
  'Append-only order-specific ordinary-item weight and dimension evidence for one exact imported planning-line revision. It does not create or imply a Product-pack assignment.';

COMMENT ON FUNCTION
  public.validate_operations_cartonization_unit_material_package() IS
  'Requires ordinary-unit packages to retain one allocation plus exact fixed-axis fit evidence for consolidated quantities, or a truthful one-each no-fit fallback, with no recipe or Product-pack profile edges.';

COMMIT;
