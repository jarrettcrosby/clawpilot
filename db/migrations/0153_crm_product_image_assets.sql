-- Durable product image payloads are app-owned CRM evidence. Provider
-- publication is deliberately outside this table and migration.
CREATE TABLE IF NOT EXISTS crm_product_image_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  asset_revision bigint NOT NULL,
  content_bytes bytea NOT NULL,
  mime_type text NOT NULL,
  content_sha256 text NOT NULL,
  byte_length integer NOT NULL,
  pixel_width integer NOT NULL,
  pixel_height integer NOT NULL,
  alt_text text NOT NULL,
  source text NOT NULL DEFAULT 'manual_upload',
  is_primary boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_product_image_assets_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_product_image_assets_product_scope_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_product_image_assets_revision_valid
    CHECK (asset_revision >= 1),
  CONSTRAINT crm_product_image_assets_mime_type_valid
    CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT crm_product_image_assets_content_sha256_valid
    CHECK (
      content_sha256 ~ '^[0-9a-f]{64}$'
      AND content_sha256 = encode(digest(content_bytes, 'sha256'), 'hex')
    ),
  CONSTRAINT crm_product_image_assets_byte_length_valid
    CHECK (
      byte_length BETWEEN 1 AND 2097152
      AND byte_length = octet_length(content_bytes)
    ),
  CONSTRAINT crm_product_image_assets_dimensions_valid
    CHECK (
      pixel_width BETWEEN 1 AND 8192
      AND pixel_height BETWEEN 1 AND 8192
      AND pixel_width::bigint * pixel_height::bigint <= 40000000
    ),
  CONSTRAINT crm_product_image_assets_alt_text_valid
    CHECK (
      length(btrim(alt_text)) BETWEEN 1 AND 500
      AND alt_text !~ '[[:cntrl:]]'
    ),
  CONSTRAINT crm_product_image_assets_source_valid
    CHECK (source IN ('manual_upload', 'provider_import', 'migration')),
  CONSTRAINT crm_product_image_assets_row_version_valid
    CHECK (row_version >= 1),
  CONSTRAINT crm_product_image_assets_product_revision_unique
    UNIQUE (organization_id, pipeline_id, product_id, asset_revision),
  CONSTRAINT crm_product_image_assets_product_content_unique
    UNIQUE (organization_id, pipeline_id, product_id, content_sha256),
  CONSTRAINT crm_product_image_assets_scoped_id_unique
    UNIQUE (organization_id, pipeline_id, product_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_product_image_assets_one_primary
  ON crm_product_image_assets (organization_id, pipeline_id, product_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_crm_product_image_assets_product_revision
  ON crm_product_image_assets (
    organization_id,
    pipeline_id,
    product_id,
    is_primary DESC,
    asset_revision,
    id
  );

CREATE OR REPLACE FUNCTION clawpilot_guard_crm_product_image_asset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CRM product image assets are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.organization_id,
    NEW.pipeline_id,
    NEW.product_id,
    NEW.asset_revision,
    NEW.content_bytes,
    NEW.mime_type,
    NEW.content_sha256,
    NEW.byte_length,
    NEW.pixel_width,
    NEW.pixel_height,
    NEW.alt_text,
    NEW.source,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.pipeline_id,
    OLD.product_id,
    OLD.asset_revision,
    OLD.content_bytes,
    OLD.mime_type,
    OLD.content_sha256,
    OLD.byte_length,
    OLD.pixel_width,
    OLD.pixel_height,
    OLD.alt_text,
    OLD.source,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'CRM product image asset content is immutable';
  END IF;

  IF NEW.is_primary IS NOT DISTINCT FROM OLD.is_primary THEN
    RAISE EXCEPTION 'CRM product image asset updates must change primary state';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'CRM product image asset row_version must advance by one';
  END IF;
  IF length(btrim(NEW.updated_by)) = 0 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'CRM product image asset update attribution is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clawpilot_guard_crm_product_image_asset
  ON crm_product_image_assets;
CREATE TRIGGER trg_clawpilot_guard_crm_product_image_asset
BEFORE UPDATE OR DELETE ON crm_product_image_assets
FOR EACH ROW
EXECUTE FUNCTION clawpilot_guard_crm_product_image_asset();
