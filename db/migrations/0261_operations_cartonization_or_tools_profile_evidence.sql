-- Retain the exact active product-pack profile revisions used by operational
-- OR-Tools geometry. These append-only edges make every optimized package
-- re-verifiable without widening the legacy allocation JSON contract.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE TABLE IF NOT EXISTS
  operations_cartonization_rate_evidence_package_profiles (
    organization_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    package_key text NOT NULL,
    line_global_id text NOT NULL CHECK (
      line_global_id ~ '^gcol(?:[0-9]{7}|[0-9a-v]{12})$'
    ),
    product_global_id text NOT NULL CHECK (
      product_global_id ~ '^gp(?:[0-9]{7}|[0-9a-v]{12})$'
    ),
    input_pack_profile_version_id uuid NOT NULL,
    input_profile_version_global_id text NOT NULL CHECK (
      input_profile_version_global_id
        ~ '^gppv(?:[0-9]{7}|[0-9a-v]{12})$'
    ),
    input_profile_version_row_version bigint NOT NULL CHECK (
      input_profile_version_row_version >= 0
    ),
    fit_model text NOT NULL CHECK (fit_model = 'rigid_3d'),
    unit_dimensions_mm jsonb NOT NULL CHECK (
      operations_cartonization_dimensions_mm_valid(unit_dimensions_mm)
    ),
    unit_weight_grams integer NOT NULL CHECK (unit_weight_grams > 0),
    quantity integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (
      organization_id, evidence_id, package_key, line_global_id
    ),
    CONSTRAINT ops_cart_rate_profile_package_fkey
      FOREIGN KEY (organization_id, evidence_id, package_key)
      REFERENCES operations_cartonization_rate_evidence_packages(
        organization_id, evidence_id, package_key
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_cart_rate_profile_version_fkey
      FOREIGN KEY (organization_id, input_pack_profile_version_id)
      REFERENCES operations_product_pack_profile_versions(
        organization_id, id
      ) ON DELETE RESTRICT
  );

CREATE INDEX IF NOT EXISTS idx_ops_cart_rate_profile_version
  ON operations_cartonization_rate_evidence_package_profiles (
    organization_id, input_pack_profile_version_id
  );

DROP TRIGGER IF EXISTS
  validate_ops_cart_rate_profile_insert
  ON operations_cartonization_rate_evidence_package_profiles;

CREATE TRIGGER validate_ops_cart_rate_profile_insert
BEFORE INSERT
ON operations_cartonization_rate_evidence_package_profiles
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_evidence_child_insert();

DROP TRIGGER IF EXISTS
  protect_ops_cart_rate_profile_mutation
  ON operations_cartonization_rate_evidence_package_profiles;

CREATE TRIGGER protect_ops_cart_rate_profile_mutation
BEFORE UPDATE OR DELETE
ON operations_cartonization_rate_evidence_package_profiles
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_rate_profile_evidence_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence evidence
    WHERE evidence.organization_id = NEW.organization_id
      AND evidence.id = NEW.id
      AND evidence.sealed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cartonization rate evidence must be sealed before profile validation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    JOIN operations_cartonization_rate_evidence evidence
      ON evidence.organization_id = package.organization_id
     AND evidence.id = package.evidence_id
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
      AND (
        (
          package.planning_method = 'or_tools'
          AND (
            evidence.evidence_mode <> 'operational'
            OR (
              SELECT count(*)
              FROM
                operations_cartonization_rate_evidence_package_profiles
                  profile_edge
              WHERE profile_edge.organization_id = package.organization_id
                AND profile_edge.evidence_id = package.evidence_id
                AND profile_edge.package_key = package.package_key
            ) <> jsonb_array_length(package.allocations)
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(package.allocations)
                AS allocation(item)
              WHERE NOT EXISTS (
                SELECT 1
                FROM
                  operations_cartonization_rate_evidence_package_profiles
                    profile_edge
                WHERE profile_edge.organization_id =
                        package.organization_id
                  AND profile_edge.evidence_id = package.evidence_id
                  AND profile_edge.package_key = package.package_key
                  AND profile_edge.line_global_id =
                        allocation.item->>'lineGlobalId'
                  AND profile_edge.product_global_id =
                        allocation.item->>'productGlobalId'
                  AND profile_edge.quantity =
                        (allocation.item->>'quantity')::integer
              )
            )
          )
        )
        OR (
          package.planning_method <> 'or_tools'
          AND EXISTS (
            SELECT 1
            FROM operations_cartonization_rate_evidence_package_profiles
              profile_edge
            WHERE profile_edge.organization_id = package.organization_id
              AND profile_edge.evidence_id = package.evidence_id
              AND profile_edge.package_key = package.package_key
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'OR-Tools packages require one exact operational profile edge per allocation; other planners require none';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_package_profiles profile_edge
    WHERE profile_edge.organization_id = NEW.organization_id
      AND profile_edge.evidence_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM operations_cartonization_rate_evidence evidence
        JOIN operations_cartonization_rate_evidence_packages package
          ON package.organization_id = evidence.organization_id
         AND package.evidence_id = evidence.id
         AND package.package_key = profile_edge.package_key
        JOIN operations_commerce_order_candidate_lines candidate_line
          ON candidate_line.organization_id = evidence.organization_id
         AND candidate_line.integration_account_id =
              evidence.integration_account_id
         AND candidate_line.order_candidate_id = evidence.order_candidate_id
         AND candidate_line.global_id = profile_edge.line_global_id
        JOIN crm_products product
          ON product.pipeline_id = candidate_line.pipeline_id
         AND product.id = candidate_line.product_id
        JOIN operations_product_pack_profile_versions profile_version
          ON profile_version.organization_id = candidate_line.organization_id
         AND profile_version.pipeline_id = candidate_line.pipeline_id
         AND profile_version.product_id = candidate_line.product_id
         AND profile_version.id =
              profile_edge.input_pack_profile_version_id
         AND profile_version.id = candidate_line.pack_profile_version_id
        WHERE evidence.organization_id = profile_edge.organization_id
          AND evidence.id = profile_edge.evidence_id
          AND evidence.evidence_mode = 'operational'
          AND package.planning_method = 'or_tools'
          AND candidate_line.requires_shipping = true
          AND candidate_line.mapping_state = 'resolved'
          AND candidate_line.packaging_state = 'resolved'
          AND candidate_line.pack_profile_version_row_version =
                profile_version.row_version
          AND product.reference_code = profile_edge.product_global_id
          AND profile_version.global_id =
                profile_edge.input_profile_version_global_id
          AND profile_version.row_version =
                profile_edge.input_profile_version_row_version
          AND profile_version.lifecycle_state = 'active'
          AND profile_version.is_current = true
          AND profile_version.dimension_basis = 'outer'
          AND profile_version.fit_model = profile_edge.fit_model
          AND profile_version.fit_model = 'rigid_3d'
          AND profile_version.length_mm =
                (profile_edge.unit_dimensions_mm->>'length')::integer
          AND profile_version.width_mm =
                (profile_edge.unit_dimensions_mm->>'width')::integer
          AND profile_version.height_mm =
                (profile_edge.unit_dimensions_mm->>'height')::integer
          AND profile_version.gross_weight_grams =
                profile_edge.unit_weight_grams
      )
  ) THEN
    RAISE EXCEPTION
      'OR-Tools profile evidence no longer matches its candidate line and current active outer rigid profile';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_ops_cart_rate_profile_evidence_complete
  ON operations_cartonization_rate_evidence;

CREATE CONSTRAINT TRIGGER
  validate_ops_cart_rate_profile_evidence_complete
AFTER INSERT OR UPDATE
ON operations_cartonization_rate_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_rate_profile_evidence_complete();

COMMENT ON TABLE
  operations_cartonization_rate_evidence_package_profiles IS
  'Append-only exact candidate-line and active outer rigid profile revisions used by operational OR-Tools package geometry.';

COMMENT ON FUNCTION
  validate_operations_cartonization_rate_profile_evidence_complete() IS
  'Deferred seal validation requiring exact current rigid-profile lineage for every operational OR-Tools allocation and forbidding profile edges for all other planners.';
