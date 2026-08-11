-- Give assumption-backed sandbox geometry its own truthful package-planning
-- provenance. This remains evidence-only: it cannot retain approved-recipe
-- edges and does not authorize operational packaging or fulfillment writes.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

DO $$
DECLARE
  matching_constraint_count integer;
  planning_constraint_name text;
BEGIN
  SELECT count(*), min(constraint_record.conname)
    INTO matching_constraint_count, planning_constraint_name
  FROM pg_constraint constraint_record
  WHERE constraint_record.conrelid =
      'operations_cartonization_rate_evidence_packages'::regclass
    AND constraint_record.contype = 'c'
    AND position(
      'planning_method' IN pg_get_constraintdef(constraint_record.oid)
    ) > 0
    AND position(
      'approved_pack_recipe_id'
      IN pg_get_constraintdef(constraint_record.oid)
    ) = 0;
  IF matching_constraint_count <> 1 OR planning_constraint_name IS NULL THEN
    RAISE EXCEPTION
      'Expected exactly one legacy package planning-method check, found %',
      matching_constraint_count;
  END IF;
  EXECUTE format(
    'ALTER TABLE operations_cartonization_rate_evidence_packages DROP CONSTRAINT %I',
    planning_constraint_name
  );
END;
$$;

ALTER TABLE operations_cartonization_rate_evidence_packages
  ADD CONSTRAINT ops_cart_rate_pkg_planning_method_check
    CHECK (
      planning_method IN (
        'approved_recipe',
        'or_tools',
        'sandbox_fixed_axis'
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
        planning_method IN ('or_tools', 'sandbox_fixed_axis')
        AND approved_pack_recipe_id IS NULL
        AND recipe_row_version IS NULL
      )
    );

COMMENT ON COLUMN
  operations_cartonization_rate_evidence_packages.planning_method IS
  'Truthful immutable package planner provenance: approved recipe, validated OR-Tools geometry, or explicitly watermarked sandbox-only fixed-axis comparison.';

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_sandbox_fixed_axis_recipe_edges()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.evidence_id
      AND package.package_key = NEW.package_key
      AND package.planning_method = 'sandbox_fixed_axis'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence evidence
      WHERE evidence.organization_id = NEW.organization_id
        AND evidence.id = NEW.evidence_id
        AND evidence.evidence_mode = 'assumption_backed_sandbox'
    ) THEN
      RAISE EXCEPTION
        'Sandbox fixed-axis packages require assumption-backed sandbox evidence';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence_package_recipes recipe
      WHERE recipe.organization_id = NEW.organization_id
        AND recipe.evidence_id = NEW.evidence_id
        AND recipe.package_key = NEW.package_key
    ) THEN
      RAISE EXCEPTION
        'Sandbox fixed-axis cartonization packages cannot retain approved recipe edges';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  operations_cartonization_sandbox_fixed_axis_package_recipe_guard
  ON operations_cartonization_rate_evidence_packages;

CREATE CONSTRAINT TRIGGER
  operations_cartonization_sandbox_fixed_axis_package_recipe_guard
AFTER INSERT OR UPDATE
ON operations_cartonization_rate_evidence_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_sandbox_fixed_axis_recipe_edges();

DROP TRIGGER IF EXISTS
  operations_cartonization_sandbox_fixed_axis_recipe_edge_guard
  ON operations_cartonization_rate_evidence_package_recipes;

CREATE CONSTRAINT TRIGGER
  operations_cartonization_sandbox_fixed_axis_recipe_edge_guard
AFTER INSERT OR UPDATE
ON operations_cartonization_rate_evidence_package_recipes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_cartonization_sandbox_fixed_axis_recipe_edges();
