-- Make recipe-driven cartonization explicit and fail closed. A product may
-- participate in a mixed-product carton only when every participating recipe
-- carries the same compatibility key and customer/measured fit evidence.
-- Nullable minimum_input_quantity means the minimum is not yet known; runtime
-- planning must block that option unless a separately retained assumption is
-- supplied by an authorized sandbox caller.

ALTER TABLE operations_approved_pack_recipes
  ADD COLUMN IF NOT EXISTS minimum_input_quantity integer,
  ADD COLUMN IF NOT EXISTS content_compatibility_key text,
  ADD COLUMN IF NOT EXISTS allows_mixed_products boolean NOT NULL DEFAULT false;

ALTER TABLE operations_approved_pack_recipes
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_minimum_input_valid,
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_compatibility_key_valid,
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_mixed_products_valid,
  DROP CONSTRAINT IF EXISTS
    operations_approved_pack_recipes_active_capacity_ready;

ALTER TABLE operations_approved_pack_recipes
  ADD CONSTRAINT operations_approved_pack_recipes_minimum_input_valid
  CHECK (
    minimum_input_quantity IS NULL
    OR (
      recipe_type = 'max_capacity'
      AND minimum_input_quantity > 0
      AND minimum_input_quantity <= input_quantity
    )
  ),
  ADD CONSTRAINT operations_approved_pack_recipes_compatibility_key_valid
  CHECK (
    content_compatibility_key IS NULL
    OR (
      length(btrim(content_compatibility_key)) BETWEEN 1 AND 120
      AND lower(content_compatibility_key)
        ~ '^[a-z0-9][a-z0-9._-]*$'
    )
  ),
  ADD CONSTRAINT operations_approved_pack_recipes_mixed_products_valid
  CHECK (
    NOT allows_mixed_products
    OR (
      recipe_type = 'max_capacity'
      AND exclusive_contents = false
      AND content_compatibility_key IS NOT NULL
      AND length(btrim(content_compatibility_key)) BETWEEN 1 AND 120
      AND fit_evidence_type IN ('customer_confirmed', 'measured')
      AND fit_evidence_reference IS NOT NULL
      AND length(btrim(fit_evidence_reference)) BETWEEN 1 AND 500
      AND confirmed_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT operations_approved_pack_recipes_active_capacity_ready
  CHECK (
    lifecycle_state <> 'active'
    OR recipe_type <> 'max_capacity'
    OR minimum_input_quantity IS NOT NULL
  );

ALTER TABLE operations_product_pack_profile_versions
  DROP CONSTRAINT IF EXISTS
    operations_product_pack_profile_versions_recipe_only_evidence_valid;

ALTER TABLE operations_product_pack_profile_versions
  ADD CONSTRAINT
    operations_product_pack_profile_versions_recipe_only_evidence_valid
  CHECK (
    fit_model <> 'approved_recipe_only'
    OR (
      evidence_type IN ('customer_confirmed', 'measured', 'provider')
      AND evidence_reference IS NOT NULL
      AND length(btrim(evidence_reference)) BETWEEN 1 AND 500
      AND confirmed_at IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS
  idx_operations_approved_pack_recipes_compatibility
  ON operations_approved_pack_recipes (
    organization_id,
    content_compatibility_key,
    packaging_material_id,
    input_quantity,
    product_id
  )
  WHERE is_current
    AND allows_mixed_products
    AND content_compatibility_key IS NOT NULL;

COMMENT ON COLUMN
  operations_approved_pack_recipes.minimum_input_quantity IS
  'Customer-approved lower bound for a max-capacity recipe. NULL is unknown and blocks runtime use without separately retained sandbox assumption evidence.';
COMMENT ON COLUMN
  operations_approved_pack_recipes.content_compatibility_key IS
  'Normalized content-fit class. It permits pooling only when every product recipe and packaging material option matches exactly.';
COMMENT ON COLUMN
  operations_approved_pack_recipes.allows_mixed_products IS
  'True only when customer/measured fit evidence explicitly permits compatible products to share the same outbound material.';
COMMENT ON COLUMN
  operations_product_pack_profile_versions.fit_model IS
  'rigid_3d and compressible may enter geometric planning; approved_recipe_only must use current evidence-backed recipes and never falls back to geometry.';
