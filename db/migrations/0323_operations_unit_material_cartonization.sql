BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

-- Ordinary one-each lines may omit a Product pack. Their exact provider or
-- order-specific unit weight plus an operator-selected factual material form
-- a conservative one-unit-per-carton operational plan. This method does not
-- claim product geometry, recipe fit, or an OR-Tools result.
ALTER TABLE operations_cartonization_rate_evidence_packages
  DROP CONSTRAINT IF EXISTS ops_cart_rate_pkg_planning_method_check;

ALTER TABLE operations_cartonization_rate_evidence_packages
  ADD CONSTRAINT ops_cart_rate_pkg_planning_method_check
    CHECK (
      planning_method IN (
        'approved_recipe',
        'or_tools',
        'sandbox_fixed_axis',
        'unit_material_selection'
      )
    );

ALTER TABLE operations_cartonization_rate_evidence_packages
  DROP CONSTRAINT IF EXISTS
    operations_cartonization_rate_evidence_packages_recipe_valid,
  ADD CONSTRAINT
    operations_cartonization_rate_evidence_packages_recipe_valid
    CHECK (
      (
        planning_method = 'approved_recipe'
        AND approved_pack_recipe_id IS NOT NULL
        AND recipe_row_version IS NOT NULL
        AND recipe_row_version >= 0
      )
      OR (
        planning_method IN (
          'or_tools',
          'sandbox_fixed_axis',
          'unit_material_selection'
        )
        AND approved_pack_recipe_id IS NULL
        AND recipe_row_version IS NULL
      )
    );

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_unit_material_package()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.planning_method <> 'unit_material_selection' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence evidence
    WHERE evidence.organization_id = NEW.organization_id
      AND evidence.id = NEW.evidence_id
      AND evidence.evidence_mode = 'operational'
  ) THEN
    RAISE EXCEPTION
      'Unit-material packages require operational evidence';
  END IF;

  IF jsonb_array_length(NEW.allocations) <> 1
     OR (NEW.allocations->0->>'quantity')::integer <> 1 THEN
    RAISE EXCEPTION
      'Unit-material packages require exactly one one-each allocation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_package_recipes recipe
    WHERE recipe.organization_id = NEW.organization_id
      AND recipe.evidence_id = NEW.evidence_id
      AND recipe.package_key = NEW.package_key
  ) OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_package_profiles profile
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

DROP TRIGGER IF EXISTS
  validate_operations_cartonization_unit_material_package
  ON operations_cartonization_rate_evidence_packages;

CREATE CONSTRAINT TRIGGER
  validate_operations_cartonization_unit_material_package
AFTER INSERT OR UPDATE
ON operations_cartonization_rate_evidence_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_unit_material_package();

COMMENT ON COLUMN
  operations_cartonization_rate_evidence_packages.planning_method IS
  'Truthful immutable package planner provenance: approved recipe, validated OR-Tools geometry, sandbox-only fixed-axis comparison, or operational one-each material selection without a Product-pack constraint.';

COMMENT ON FUNCTION
  validate_operations_cartonization_unit_material_package() IS
  'Requires operational one-each material packages to retain exactly one unit and no recipe or Product-pack profile edges.';

COMMIT;
