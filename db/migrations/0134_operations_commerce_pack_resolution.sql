-- Preserve the exact customer-confirmed provider-variant pack evidence used to
-- resolve a temporary commerce order line. The fulfillment optimizer continues
-- to consume the candidate's immutable dimensions and weight snapshot; these
-- references make that snapshot re-verifiable before canonical promotion.

ALTER TABLE operations_commerce_variant_pack_mappings
  DROP CONSTRAINT IF EXISTS
    operations_commerce_variant_pack_mappings_candidate_scope_unique;

ALTER TABLE operations_commerce_variant_pack_mappings
  ADD CONSTRAINT
    operations_commerce_variant_pack_mappings_candidate_scope_unique
  UNIQUE (
    organization_id,
    integration_account_id,
    pipeline_id,
    product_id,
    id,
    default_pack_profile_version_id
  );

ALTER TABLE operations_commerce_order_candidate_lines
  ADD COLUMN IF NOT EXISTS commerce_variant_pack_mapping_id uuid,
  ADD COLUMN IF NOT EXISTS commerce_variant_pack_mapping_row_version bigint,
  ADD COLUMN IF NOT EXISTS pack_profile_version_id uuid,
  ADD COLUMN IF NOT EXISTS pack_profile_version_row_version bigint,
  ADD COLUMN IF NOT EXISTS pack_profile_package_level text,
  ADD COLUMN IF NOT EXISTS pack_profile_base_each_quantity integer,
  ADD COLUMN IF NOT EXISTS packaging_weight_source text;

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS commerce_order_lines_packaging_source_valid,
  DROP CONSTRAINT IF EXISTS commerce_order_lines_pack_mapping_fkey,
  DROP CONSTRAINT IF EXISTS commerce_order_lines_pack_mapping_evidence_valid,
  DROP CONSTRAINT IF EXISTS commerce_order_lines_pack_weight_source_valid;

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidate_lines_packaging_source_check;

ALTER TABLE operations_commerce_order_candidate_lines
  ADD CONSTRAINT commerce_order_lines_packaging_source_valid CHECK (
    packaging_source IN (
      'none', 'profile', 'provider', 'manual', 'variant_pack_mapping'
    )
  ),
  ADD CONSTRAINT commerce_order_lines_pack_mapping_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      pipeline_id,
      product_id,
      commerce_variant_pack_mapping_id,
      pack_profile_version_id
    )
    REFERENCES operations_commerce_variant_pack_mappings (
      organization_id,
      integration_account_id,
      pipeline_id,
      product_id,
      id,
      default_pack_profile_version_id
    )
    ON DELETE RESTRICT,
  ADD CONSTRAINT commerce_order_lines_pack_mapping_evidence_valid CHECK (
    (
      commerce_variant_pack_mapping_id IS NULL
      AND commerce_variant_pack_mapping_row_version IS NULL
      AND pack_profile_version_id IS NULL
      AND pack_profile_version_row_version IS NULL
      AND pack_profile_package_level IS NULL
      AND pack_profile_base_each_quantity IS NULL
    )
    OR (
      commerce_variant_pack_mapping_id IS NOT NULL
      AND commerce_variant_pack_mapping_row_version IS NOT NULL
      AND commerce_variant_pack_mapping_row_version >= 0
      AND pack_profile_version_id IS NOT NULL
      AND pack_profile_version_row_version IS NOT NULL
      AND pack_profile_version_row_version >= 0
      AND pack_profile_package_level IN (
        'each', 'inner_pack', 'case', 'pallet'
      )
      AND pack_profile_base_each_quantity IS NOT NULL
      AND pack_profile_base_each_quantity > 0
    )
  ),
  ADD CONSTRAINT commerce_order_lines_pack_weight_source_valid CHECK (
    packaging_weight_source IS NULL
    OR packaging_weight_source IN (
      'profile_version', 'provider_order', 'provider_catalog'
    )
  );

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS commerce_order_lines_mapped_pack_source_valid;

ALTER TABLE operations_commerce_order_candidate_lines
  ADD CONSTRAINT commerce_order_lines_mapped_pack_source_valid CHECK (
    packaging_source <> 'variant_pack_mapping'
    OR (
      packaging_state = 'resolved'
      AND package_profile_id IS NULL
      AND commerce_variant_pack_mapping_id IS NOT NULL
      AND pack_profile_version_id IS NOT NULL
      AND packaging_weight_source IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS commerce_order_lines_pack_mapping_idx
  ON operations_commerce_order_candidate_lines (
    organization_id,
    commerce_variant_pack_mapping_id,
    pack_profile_version_id
  )
  WHERE commerce_variant_pack_mapping_id IS NOT NULL;

COMMENT ON COLUMN
  operations_commerce_order_candidate_lines.commerce_variant_pack_mapping_id IS
  'Exact provider-variant pack assertion observed when this temporary order line was staged.';
COMMENT ON COLUMN
  operations_commerce_order_candidate_lines.pack_profile_version_id IS
  'Exact customer-confirmed or active pack evidence version used for this line; it does not activate the stable profile or a packaging material.';
COMMENT ON COLUMN
  operations_commerce_order_candidate_lines.packaging_weight_source IS
  'Explicit positive weight evidence copied from the mapped pack version, the current provider order, or the exact-source provider catalog observation.';
