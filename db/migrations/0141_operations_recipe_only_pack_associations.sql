-- A provider sell unit can be customer-confirmed as recipe-only while its
-- inner product dimensions remain unknown. Preserve the exact mapped profile
-- association for hybrid recipe planning without falsely resolving ordinary
-- package geometry or copying the outbound carton's dimensions onto the item.

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS commerce_order_lines_mapped_pack_source_valid;

ALTER TABLE operations_commerce_order_candidate_lines
  ADD CONSTRAINT commerce_order_lines_mapped_pack_source_valid CHECK (
    packaging_source <> 'variant_pack_mapping'
    OR (
      package_profile_id IS NULL
      AND commerce_variant_pack_mapping_id IS NOT NULL
      AND pack_profile_version_id IS NOT NULL
      AND (
        (
          packaging_state = 'resolved'
          AND packaging_weight_source IS NOT NULL
        )
        OR (
          packaging_state = 'unresolved'
          AND packaging_weight_source IS NULL
          AND weight_grams IS NULL
          AND length_mm IS NULL
          AND width_mm IS NULL
          AND height_mm IS NULL
          AND 'packaging_required' = ANY(blocking_codes)
        )
      )
    )
  );

COMMENT ON CONSTRAINT commerce_order_lines_mapped_pack_source_valid
  ON operations_commerce_order_candidate_lines IS
  'Exact variant-pack evidence may resolve package geometry or retain an unresolved recipe-only association. Association-only rows keep dimensions and weight null, remain blocked for ordinary package promotion, and require application verification of the current approved_recipe_only profile and recipe.';
