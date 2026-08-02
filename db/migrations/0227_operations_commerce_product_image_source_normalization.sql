-- Preserve exact source evidence when a provider image must be normalized to
-- the bounded CRM asset format. Existing imports were byte-for-byte identity
-- copies, so they are backfilled from their immutable stored assets.

ALTER TABLE operations_commerce_product_image_asset_provenance
  ADD COLUMN source_content_sha256 text,
  ADD COLUMN source_byte_length integer,
  ADD COLUMN normalization_version text;

ALTER TABLE operations_commerce_product_image_asset_provenance
  DISABLE TRIGGER guard_operations_commerce_product_image_provenance_write;

UPDATE operations_commerce_product_image_asset_provenance provenance
SET source_content_sha256 = provenance.asset_content_sha256,
    source_byte_length = asset.byte_length,
    normalization_version = 'identity-v1'
FROM crm_product_image_assets asset
WHERE asset.organization_id = provenance.organization_id
  AND asset.pipeline_id = provenance.pipeline_id
  AND asset.product_id = provenance.product_id
  AND asset.id = provenance.asset_id
  AND asset.content_sha256 = provenance.asset_content_sha256;

ALTER TABLE operations_commerce_product_image_asset_provenance
  ENABLE TRIGGER guard_operations_commerce_product_image_provenance_write;

ALTER TABLE operations_commerce_product_image_asset_provenance
  ALTER COLUMN source_content_sha256 SET NOT NULL,
  ALTER COLUMN source_byte_length SET NOT NULL,
  ALTER COLUMN normalization_version SET NOT NULL,
  ADD CONSTRAINT ops_commerce_image_provenance_source_evidence_valid CHECK (
    source_content_sha256 ~ '^[0-9a-f]{64}$'
    AND source_byte_length BETWEEN 1 AND 16777216
    AND (
      (
        normalization_version = 'identity-v1'
        AND source_content_sha256 = asset_content_sha256
      )
      OR (
        normalization_version ~
          '^sharp-0[.]35[.]3-webp-auto-orient-v1-q(82|72|62|52|42|32)$'
        AND source_byte_length > 2097152
        AND source_content_sha256 <> asset_content_sha256
      )
    )
  );

CREATE OR REPLACE FUNCTION
  guard_operations_commerce_product_image_source_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  exact_source_evidence boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Commerce product image source provenance is immutable';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.crm_product_image_assets asset
    WHERE asset.organization_id = NEW.organization_id
      AND asset.pipeline_id = NEW.pipeline_id
      AND asset.product_id = NEW.product_id
      AND asset.id = NEW.asset_id
      AND asset.asset_revision = NEW.asset_revision
      AND asset.content_sha256 = NEW.asset_content_sha256
      AND (
        (
          NEW.normalization_version = 'identity-v1'
          AND NEW.source_content_sha256 = asset.content_sha256
          AND NEW.source_byte_length = asset.byte_length
        )
        OR (
          NEW.normalization_version ~
            '^sharp-0[.]35[.]3-webp-auto-orient-v1-q(82|72|62|52|42|32)$'
          AND NEW.source_byte_length > 2097152
          AND NEW.source_content_sha256 <> asset.content_sha256
          AND asset.mime_type = 'image/webp'
          AND asset.byte_length <= 2097152
        )
      )
  ) INTO exact_source_evidence;

  IF NOT exact_source_evidence THEN
    RAISE EXCEPTION
      'Commerce product image source provenance does not match the immutable stored asset';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_operations_commerce_product_image_source_evidence_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_product_image_asset_provenance
FOR EACH ROW EXECUTE FUNCTION
  guard_operations_commerce_product_image_source_evidence();

COMMENT ON COLUMN
  operations_commerce_product_image_asset_provenance.source_content_sha256 IS
  'SHA-256 of the fully fetched provider bytes before any bounded normalization.';

COMMENT ON COLUMN
  operations_commerce_product_image_asset_provenance.source_byte_length IS
  'Provider source byte length before any bounded normalization; capped at 16 MiB.';

COMMENT ON COLUMN
  operations_commerce_product_image_asset_provenance.normalization_version IS
  'identity-v1 for exact copies, otherwise the deterministic Sharp/WebP recipe and quality.';
