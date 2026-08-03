-- Upgrade Faire sandbox E2E authority from item-pack-only evidence to
-- immutable item-pack plus sealed operational parcel lineage. Migration 0231
-- is already deployed and remains checksum-immutable; this forward migration
-- applies the stronger schema and authorization predicate.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_faire_evidence
  ) THEN
    RAISE EXCEPTION
      'Existing Faire sandbox E2E evidence must be reviewed and re-authorized before parcel-lineage upgrade';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS protect_sandbox_commerce_e2e_faire_evidence_write
  ON operations_sandbox_commerce_e2e_faire_evidence;

ALTER TABLE operations_sandbox_commerce_e2e_faire_evidence
  RENAME COLUMN length_mm TO item_pack_length_mm;
ALTER TABLE operations_sandbox_commerce_e2e_faire_evidence
  RENAME COLUMN width_mm TO item_pack_width_mm;
ALTER TABLE operations_sandbox_commerce_e2e_faire_evidence
  RENAME COLUMN height_mm TO item_pack_height_mm;
ALTER TABLE operations_sandbox_commerce_e2e_faire_evidence
  RENAME COLUMN gross_weight_grams TO item_pack_gross_weight_grams;

ALTER TABLE operations_sandbox_commerce_e2e_faire_evidence
  ADD COLUMN cartonization_evidence_id uuid NOT NULL,
  ADD COLUMN cartonization_evidence_global_id text NOT NULL,
  ADD COLUMN cartonization_request_hash text NOT NULL CHECK (
    cartonization_request_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN cartonization_plan_input_hash text NOT NULL CHECK (
    cartonization_plan_input_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN cartonization_plan_result_hash text NOT NULL CHECK (
    cartonization_plan_result_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN cartonization_package_key text NOT NULL CHECK (
    length(btrim(cartonization_package_key)) BETWEEN 1 AND 80
    AND cartonization_package_key !~ '[[:cntrl:]]'
  ),
  ADD COLUMN cartonization_package_hash text NOT NULL CHECK (
    cartonization_package_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN packaging_material_id uuid NOT NULL,
  ADD COLUMN packaging_material_global_id text NOT NULL,
  ADD COLUMN packaging_material_row_version bigint NOT NULL CHECK (
    packaging_material_row_version >= 0
  ),
  ADD COLUMN approved_pack_recipe_id uuid NOT NULL,
  ADD COLUMN approved_pack_recipe_global_id text NOT NULL,
  ADD COLUMN approved_pack_recipe_row_version bigint NOT NULL CHECK (
    approved_pack_recipe_row_version >= 0
  ),
  ADD COLUMN item_pack_evidence_hash text NOT NULL CHECK (
    item_pack_evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  ADD COLUMN parcel_inner_dimensions_mm jsonb NOT NULL CHECK (
    operations_cartonization_dimensions_mm_valid(
      parcel_inner_dimensions_mm
    )
  ),
  ADD COLUMN parcel_length_mm integer NOT NULL CHECK (
    parcel_length_mm > 0
  ),
  ADD COLUMN parcel_width_mm integer NOT NULL CHECK (
    parcel_width_mm > 0
  ),
  ADD COLUMN parcel_height_mm integer NOT NULL CHECK (
    parcel_height_mm > 0
  ),
  ADD COLUMN parcel_content_weight_grams integer NOT NULL CHECK (
    parcel_content_weight_grams > 0
  ),
  ADD COLUMN parcel_tare_weight_grams integer NOT NULL CHECK (
    parcel_tare_weight_grams > 0
  ),
  ADD COLUMN parcel_gross_weight_grams integer NOT NULL CHECK (
    parcel_gross_weight_grams =
      parcel_content_weight_grams + parcel_tare_weight_grams
    AND parcel_content_weight_grams =
      item_pack_gross_weight_grams * item_quantity
  ),
  ADD CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_carton_fkey
    FOREIGN KEY (organization_id, cartonization_evidence_id)
    REFERENCES operations_cartonization_rate_evidence(
      organization_id, id
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_carton_package_fkey
    FOREIGN KEY (
      organization_id, cartonization_evidence_id,
      cartonization_package_key
    ) REFERENCES operations_cartonization_rate_evidence_packages(
      organization_id, evidence_id, package_key
    ) ON DELETE RESTRICT,
  ADD CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_material_fkey
    FOREIGN KEY (organization_id, packaging_material_id)
    REFERENCES operations_packaging_materials(organization_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT operations_sandbox_commerce_e2e_faire_evidence_recipe_fkey
    FOREIGN KEY (
      organization_id, packaging_material_id, approved_pack_recipe_id
    ) REFERENCES operations_approved_pack_recipes(
      organization_id, packaging_material_id, id
    ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION
  protect_sandbox_commerce_e2e_faire_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Faire sandbox commerce E2E evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_sandbox_commerce_e2e_faire_evidence_write
  ON operations_sandbox_commerce_e2e_faire_evidence;
CREATE TRIGGER protect_sandbox_commerce_e2e_faire_evidence_write
BEFORE UPDATE OR DELETE ON operations_sandbox_commerce_e2e_faire_evidence
FOR EACH ROW EXECUTE FUNCTION
  protect_sandbox_commerce_e2e_faire_evidence();

CREATE OR REPLACE FUNCTION
  operations_sandbox_commerce_e2e_authorization_is_current(
    requested_organization_id uuid,
    requested_authorization_id uuid,
    requested_order_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_sandbox_commerce_e2e_authorizations auth
    JOIN operations_orders source_order
      ON source_order.organization_id = auth.organization_id
     AND source_order.id = auth.order_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.order_id = requested_order_id
      AND auth.state = 'active'
      AND auth.expires_at > statement_timestamp()
      AND source_order.status = 'packed'
      AND auth.external_order_id = source_order.external_order_id
      AND (
        source_order.source_provider = 'shopify'
        OR (
          source_order.source_provider = 'faire'
          AND EXISTS (
            SELECT 1
            FROM operations_sandbox_commerce_e2e_faire_evidence evidence
            JOIN operations_integration_accounts account
              ON account.organization_id = evidence.organization_id
             AND account.id = evidence.integration_account_id
            JOIN operations_commerce_order_candidates candidate
              ON candidate.organization_id = evidence.organization_id
             AND candidate.integration_account_id =
                   evidence.integration_account_id
             AND candidate.pipeline_id = evidence.pipeline_id
             AND candidate.run_id = evidence.run_id
             AND candidate.id = evidence.order_candidate_id
            JOIN operations_commerce_order_candidate_lines candidate_line
              ON candidate_line.organization_id = evidence.organization_id
             AND candidate_line.integration_account_id =
                   evidence.integration_account_id
             AND candidate_line.pipeline_id = evidence.pipeline_id
             AND candidate_line.run_id = evidence.run_id
             AND candidate_line.order_candidate_id =
                   evidence.order_candidate_id
             AND candidate_line.id = evidence.order_line_candidate_id
            JOIN operations_order_lines canonical_line
              ON canonical_line.organization_id = evidence.organization_id
             AND canonical_line.order_id = evidence.order_id
             AND canonical_line.id = evidence.canonical_order_line_id
            JOIN operations_commerce_variant_pack_mappings pack_mapping
              ON pack_mapping.organization_id = evidence.organization_id
             AND pack_mapping.id = evidence.variant_pack_mapping_id
            JOIN operations_product_pack_profile_versions pack_version
              ON pack_version.organization_id = evidence.organization_id
             AND pack_version.id = evidence.pack_profile_version_id
            JOIN operations_fulfillment_plans plan
              ON plan.organization_id = evidence.organization_id
             AND plan.order_id = evidence.order_id
             AND plan.id = evidence.fulfillment_plan_id
            JOIN operations_warehouses warehouse
              ON warehouse.organization_id = evidence.organization_id
             AND warehouse.id = evidence.warehouse_id
            JOIN operations_cartonization_rate_evidence cartonization
              ON cartonization.organization_id = evidence.organization_id
             AND cartonization.id = evidence.cartonization_evidence_id
            JOIN operations_cartonization_rate_evidence_packages
              carton_package
              ON carton_package.organization_id = evidence.organization_id
             AND carton_package.evidence_id =
                   evidence.cartonization_evidence_id
             AND carton_package.package_key =
                   evidence.cartonization_package_key
            JOIN operations_packaging_materials material
              ON material.organization_id = evidence.organization_id
             AND material.id = evidence.packaging_material_id
            JOIN operations_approved_pack_recipes recipe
              ON recipe.organization_id = evidence.organization_id
             AND recipe.id = evidence.approved_pack_recipe_id
             AND recipe.packaging_material_id =
                   evidence.packaging_material_id
            JOIN operations_packages package
              ON package.organization_id = evidence.organization_id
             AND package.plan_id = plan.id
             AND package.id = evidence.package_id
            JOIN operations_package_contents content
              ON content.organization_id = evidence.organization_id
             AND content.plan_id = plan.id
             AND content.order_id = evidence.order_id
             AND content.package_id = package.id
             AND content.order_line_id = canonical_line.id
             AND content.id = evidence.package_content_id
            WHERE evidence.authorization_id = auth.id
              AND evidence.organization_id = auth.organization_id
              AND evidence.confirmation_hash = auth.confirmation_hash
              AND source_order.integration_account_id = account.id
              AND account.provider = 'faire'
              AND account.integration_type = 'commerce'
              AND candidate.provider = 'faire'
              AND candidate.canonical_order_id = source_order.id
              AND candidate.workflow_state = 'promoted'
              AND candidate.global_id = evidence.order_candidate_global_id
              AND candidate.row_version =
                    evidence.order_candidate_row_version
              AND candidate.source_revision =
                    evidence.order_candidate_source_revision
              AND candidate.source_hash =
                    evidence.order_candidate_source_hash
              AND candidate.ship_to_snapshot_hash =
                    evidence.order_candidate_ship_to_hash
              AND candidate_line.provider = 'faire'
              AND candidate_line.workflow_state = 'promoted'
              AND candidate_line.global_id =
                    evidence.order_line_candidate_global_id
              AND candidate_line.row_version =
                    evidence.order_line_candidate_row_version
              AND candidate_line.source_revision =
                    evidence.order_line_candidate_source_revision
              AND candidate_line.source_hash =
                    evidence.order_line_candidate_source_hash
              AND candidate_line.canonical_order_line_id = canonical_line.id
              AND candidate_line.packaging_source = 'variant_pack_mapping'
              AND candidate_line.commerce_variant_pack_mapping_id =
                    pack_mapping.id
              AND candidate_line.commerce_variant_pack_mapping_row_version =
                    evidence.variant_pack_mapping_row_version
              AND candidate_line.pack_profile_version_id = pack_version.id
              AND candidate_line.pack_profile_version_row_version =
                    evidence.pack_profile_version_row_version
              AND candidate_line.unfulfilled_quantity = 1
              AND canonical_line.quantity = 1
              AND content.quantity = evidence.item_quantity
              AND evidence.item_quantity = 1
              AND pack_mapping.provider = 'faire'
              AND pack_mapping.global_id =
                    evidence.variant_pack_mapping_global_id
              AND pack_mapping.row_version =
                    evidence.variant_pack_mapping_row_version
              AND pack_mapping.pack_evidence_hash =
                    evidence.variant_pack_evidence_hash
              AND pack_mapping.external_product_id =
                    evidence.external_product_id
              AND pack_mapping.external_variant_id =
                    evidence.external_variant_id
              AND pack_mapping.default_pack_profile_version_id =
                    pack_version.id
              AND pack_mapping.is_current = true
              AND pack_mapping.projection_state = 'current'
              AND pack_version.global_id =
                    evidence.pack_profile_version_global_id
              AND pack_version.row_version =
                    evidence.pack_profile_version_row_version
              AND pack_version.is_current = true
              AND pack_version.lifecycle_state IN (
                'customer_confirmed', 'active'
              )
              AND pack_version.base_each_quantity = 1
              AND pack_version.dimension_basis = 'outer'
              AND pack_version.length_mm = evidence.item_pack_length_mm
              AND pack_version.width_mm = evidence.item_pack_width_mm
              AND pack_version.height_mm = evidence.item_pack_height_mm
              AND pack_version.gross_weight_grams =
                    evidence.item_pack_gross_weight_grams
              AND candidate_line.length_mm = evidence.item_pack_length_mm
              AND candidate_line.width_mm = evidence.item_pack_width_mm
              AND candidate_line.height_mm = evidence.item_pack_height_mm
              AND candidate_line.weight_grams =
                    evidence.item_pack_gross_weight_grams
              AND (canonical_line.dimensions_mm->>'length')::integer =
                    evidence.item_pack_length_mm
              AND (canonical_line.dimensions_mm->>'width')::integer =
                    evidence.item_pack_width_mm
              AND (canonical_line.dimensions_mm->>'height')::integer =
                    evidence.item_pack_height_mm
              AND canonical_line.weight_grams =
                    evidence.item_pack_gross_weight_grams
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    jsonb_build_object(
                      'candidateLineGlobalId', candidate_line.global_id,
                      'canonicalOrderLineGlobalId', canonical_line.global_id,
                      'packProfileVersionGlobalId', pack_version.global_id,
                      'quantity', content.quantity,
                      'lengthMm', pack_version.length_mm,
                      'widthMm', pack_version.width_mm,
                      'heightMm', pack_version.height_mm,
                      'grossWeightGrams', pack_version.gross_weight_grams
                    )
                  ) = evidence.item_pack_evidence_hash
              AND plan.global_id = evidence.fulfillment_plan_global_id
              AND plan.version_number = evidence.fulfillment_plan_version
              AND plan.warehouse_id = evidence.warehouse_id
              AND plan.cartonization_evidence_id = cartonization.id
              AND plan.status = 'released'
              AND warehouse.address IS NOT NULL
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    warehouse.address
                  ) = evidence.warehouse_address_hash
              AND cartonization.global_id =
                    evidence.cartonization_evidence_global_id
              AND cartonization.integration_account_id = account.id
              AND cartonization.order_candidate_id = candidate.id
              AND cartonization.candidate_row_version =
                    evidence.order_candidate_row_version
              AND cartonization.candidate_source_hash =
                    evidence.order_candidate_source_hash
              AND cartonization.warehouse_id = warehouse.id
              AND cartonization.evidence_mode = 'operational'
              AND cartonization.status IN ('succeeded', 'partial')
              AND cartonization.sealed_at IS NOT NULL
              AND cartonization.request_hash =
                    evidence.cartonization_request_hash
              AND cartonization.plan_input_hash =
                    evidence.cartonization_plan_input_hash
              AND cartonization.plan_result_hash =
                    evidence.cartonization_plan_result_hash
              AND carton_package.package_hash =
                    evidence.cartonization_package_hash
              AND carton_package.planning_method = 'approved_recipe'
              AND carton_package.packaging_material_id = material.id
              AND carton_package.material_row_version =
                    evidence.packaging_material_row_version
              AND carton_package.approved_pack_recipe_id = recipe.id
              AND carton_package.recipe_row_version =
                    evidence.approved_pack_recipe_row_version
              AND jsonb_array_length(carton_package.allocations) = 1
              AND carton_package.allocations->0->>'lineGlobalId' =
                    candidate_line.global_id
              AND (
                    carton_package.allocations->0->>'quantity'
                  )::numeric = evidence.item_quantity
              AND material.global_id =
                    evidence.packaging_material_global_id
              AND material.row_version =
                    evidence.packaging_material_row_version
              AND material.status = 'active'
              AND material.rated_outer_length_mm = evidence.parcel_length_mm
              AND material.rated_outer_width_mm = evidence.parcel_width_mm
              AND material.rated_outer_height_mm = evidence.parcel_height_mm
              AND material.tare_weight_grams =
                    evidence.parcel_tare_weight_grams
              AND recipe.global_id = evidence.approved_pack_recipe_global_id
              AND recipe.row_version =
                    evidence.approved_pack_recipe_row_version
              AND recipe.is_current = true
              AND recipe.lifecycle_state IN ('customer_confirmed', 'active')
              AND recipe.input_pack_profile_version_id = pack_version.id
              AND recipe.packaging_material_id = material.id
              AND package.global_id = evidence.package_global_id
              AND package.package_number = evidence.package_number
              AND package.cartonization_evidence_id = cartonization.id
              AND package.evidence_package_key =
                    evidence.cartonization_package_key
              -- Shipment confirmation marks packages shipped immediately
              -- before the released plan transitions to fulfilled. The exact
              -- package identity and parcel evidence remain unchanged during
              -- that same transaction, so permit this transient state while
              -- the one-use authorization is still locked and active.
              AND package.status IN ('packed', 'labeled', 'shipped')
              AND carton_package.inner_dimensions_mm =
                    evidence.parcel_inner_dimensions_mm
              AND (
                    carton_package.rated_outer_dimensions_mm->>'length'
                  )::integer = evidence.parcel_length_mm
              AND (
                    carton_package.rated_outer_dimensions_mm->>'width'
                  )::integer = evidence.parcel_width_mm
              AND (
                    carton_package.rated_outer_dimensions_mm->>'height'
                  )::integer = evidence.parcel_height_mm
              AND carton_package.content_weight_grams =
                    evidence.parcel_content_weight_grams
              AND carton_package.content_weight_grams =
                    evidence.item_pack_gross_weight_grams
                      * evidence.item_quantity
              AND carton_package.tare_weight_grams =
                    evidence.parcel_tare_weight_grams
              AND carton_package.rated_gross_weight_grams =
                    evidence.parcel_gross_weight_grams
              AND package.length_mm = evidence.parcel_length_mm
              AND package.width_mm = evidence.parcel_width_mm
              AND package.height_mm = evidence.parcel_height_mm
              AND package.weight_grams = evidence.parcel_gross_weight_grams
              AND content.global_id = evidence.package_content_global_id
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    jsonb_build_object(
                      'packageGlobalId', package.global_id,
                      'contentGlobalId', content.global_id,
                      'orderLineGlobalId', canonical_line.global_id,
                      'quantity', content.quantity,
                      'cartonizationEvidenceGlobalId',
                        cartonization.global_id,
                      'cartonizationPackageKey', carton_package.package_key,
                      'packagingMaterialGlobalId', material.global_id,
                      'packagingMaterialRowVersion',
                        carton_package.material_row_version,
                      'approvedPackRecipeGlobalId', recipe.global_id,
                      'approvedPackRecipeRowVersion',
                        carton_package.recipe_row_version,
                      'innerDimensionsMm',
                        carton_package.inner_dimensions_mm,
                      'ratedOuterDimensionsMm',
                        carton_package.rated_outer_dimensions_mm,
                      'contentWeightGrams',
                        carton_package.content_weight_grams,
                      'tareWeightGrams', carton_package.tare_weight_grams,
                      'grossWeightGrams',
                        carton_package.rated_gross_weight_grams
                    )
                  ) = evidence.package_evidence_hash
              AND operations_sandbox_commerce_e2e_jsonb_hash(
                    source_order.ship_to
                  ) = evidence.ship_to_hash
              AND upper(coalesce(
                    source_order.ship_to->>'region',
                    source_order.ship_to->>'state'
                  )) = evidence.destination_region
              AND upper(coalesce(
                    source_order.ship_to->>'countryCode',
                    source_order.ship_to->>'country'
                  )) = evidence.destination_country_code
              AND length(btrim(coalesce(
                    source_order.ship_to->>'name', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'line1',
                    source_order.ship_to->>'street', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'city', ''
                  ))) > 0
              AND length(btrim(coalesce(
                    source_order.ship_to->>'postalCode',
                    source_order.ship_to->>'postal_code', ''
                  ))) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM operations_commerce_order_candidates other_candidate
                WHERE other_candidate.organization_id = source_order.organization_id
                  AND other_candidate.canonical_order_id = source_order.id
                  AND other_candidate.id <> candidate.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_commerce_order_candidate_lines other_line
                WHERE other_line.organization_id = candidate.organization_id
                  AND other_line.order_candidate_id = candidate.id
                  AND other_line.unfulfilled_quantity > 0
                  AND other_line.id <> candidate_line.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_order_lines other_order_line
                WHERE other_order_line.organization_id = source_order.organization_id
                  AND other_order_line.order_id = source_order.id
                  AND other_order_line.id <> canonical_line.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_packages other_package
                WHERE other_package.organization_id = plan.organization_id
                  AND other_package.plan_id = plan.id
                  AND other_package.id <> package.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM operations_package_contents other_content
                WHERE other_content.organization_id = package.organization_id
                  AND other_content.package_id = package.id
                  AND other_content.id <> content.id
              )
          )
        )
      )
  )
$$;

COMMENT ON TABLE operations_sandbox_commerce_e2e_faire_evidence IS
  'Immutable exact promoted-order, item-pack, sealed cartonization/material/recipe parcel, origin, and CA destination evidence for one Faire sandbox E2E authorization.';
COMMENT ON FUNCTION operations_sandbox_commerce_e2e_authorization_is_current(
  uuid, uuid, uuid
) IS
  'Preserves existing Shopify sandbox authority and requires exact immutable Faire order/item-pack/cartonization/parcel/address evidence.';
