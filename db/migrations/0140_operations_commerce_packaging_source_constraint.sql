-- PostgreSQL shortened the original inline packaging-source check to this
-- generated identifier. Migration 0134 dropped the unshortened spelling, so
-- the legacy four-value check survived beside the new mapped-pack check and
-- rejected otherwise valid variant_pack_mapping evidence.

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidate_line_packaging_source_check,
  DROP CONSTRAINT IF EXISTS commerce_order_lines_packaging_source_valid;

ALTER TABLE operations_commerce_order_candidate_lines
  ADD CONSTRAINT commerce_order_lines_packaging_source_valid CHECK (
    packaging_source IN (
      'none', 'profile', 'provider', 'manual', 'variant_pack_mapping'
    )
  );
