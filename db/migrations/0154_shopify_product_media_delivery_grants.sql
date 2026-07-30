-- A Shopify product image is fetched asynchronously from the URL supplied to
-- productUpdate.  Persist the exact, short-lived delivery grant before the
-- provider intent is prepared so an idempotent replay reconstructs the same
-- URL and cannot dispatch a second mutation with different media.

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_product_channel_states_scoped_id
  ON operations_product_channel_states (
    organization_id,
    integration_account_id,
    id
  );

CREATE TABLE IF NOT EXISTS operations_shopify_product_media_delivery_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  integration_account_global_id text NOT NULL,
  pipeline_id uuid NOT NULL,
  product_id uuid NOT NULL,
  channel_state_id uuid NOT NULL,
  image_asset_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  desired_mode text NOT NULL CHECK (desired_mode IN ('shadow', 'active')),
  public_origin text NOT NULL,
  product_reference_code text NOT NULL,
  product_source_hash text NOT NULL,
  product_gid text NOT NULL,
  channel_state_global_id text NOT NULL,
  channel_state_row_version bigint NOT NULL
    CHECK (channel_state_row_version >= 0),
  channel_source_revision text NOT NULL,
  channel_source_hash text NOT NULL,
  asset_revision bigint NOT NULL CHECK (asset_revision >= 1),
  asset_row_version bigint NOT NULL CHECK (asset_row_version >= 1),
  asset_content_sha256 text NOT NULL,
  asset_mime_type text NOT NULL,
  asset_byte_length integer NOT NULL,
  asset_pixel_width integer NOT NULL,
  asset_pixel_height integer NOT NULL,
  asset_alt_text text NOT NULL,
  credential_generation integer NOT NULL
    CHECK (credential_generation >= 1),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  aggregate_revision bigint NOT NULL CHECK (aggregate_revision >= 1),
  aggregate_hash text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_product_media_grants_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_product_media_grants_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_product_media_grants_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_product_media_grants_channel_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      channel_state_id
    )
    REFERENCES operations_product_channel_states(
      organization_id,
      integration_account_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_product_media_grants_asset_fkey
    FOREIGN KEY (
      organization_id,
      pipeline_id,
      product_id,
      image_asset_id
    )
    REFERENCES crm_product_image_assets(
      organization_id,
      pipeline_id,
      product_id,
      id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_product_media_grants_idempotency_valid
    CHECK (
      length(btrim(idempotency_key)) BETWEEN 1 AND 255
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_shopify_product_media_grants_account_global_valid
    CHECK (integration_account_global_id ~ '^gia[0-9]{7}$'),
  CONSTRAINT operations_shopify_product_media_grants_origin_valid
    CHECK (
      length(public_origin) BETWEEN 9 AND 2048
      AND public_origin ~ '^https://'
      AND public_origin !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_shopify_product_media_grants_product_ref_valid
    CHECK (product_reference_code ~ '^gp[0-9]{7}$'),
  CONSTRAINT operations_shopify_product_media_grants_product_hash_valid
    CHECK (product_source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operations_shopify_product_media_grants_product_gid_valid
    CHECK (product_gid ~ '^gid://shopify/Product/[1-9][0-9]*$'),
  CONSTRAINT operations_shopify_product_media_grants_channel_global_valid
    CHECK (channel_state_global_id ~ '^gpcs[0-9]{7}$'),
  CONSTRAINT operations_shopify_product_media_grants_channel_hash_valid
    CHECK (channel_source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operations_shopify_product_media_grants_asset_hash_valid
    CHECK (asset_content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operations_shopify_product_media_grants_asset_mime_valid
    CHECK (asset_mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT operations_shopify_product_media_grants_asset_size_valid
    CHECK (asset_byte_length BETWEEN 1 AND 2097152),
  CONSTRAINT operations_shopify_product_media_grants_asset_dimensions_valid
    CHECK (
      asset_pixel_width BETWEEN 1 AND 8192
      AND asset_pixel_height BETWEEN 1 AND 8192
      AND asset_pixel_width::bigint * asset_pixel_height::bigint <= 40000000
    ),
  CONSTRAINT operations_shopify_product_media_grants_alt_text_valid
    CHECK (
      length(btrim(asset_alt_text)) BETWEEN 1 AND 500
      AND asset_alt_text !~ '[[:cntrl:]]'
    ),
  CONSTRAINT operations_shopify_product_media_grants_aggregate_hash_valid
    CHECK (aggregate_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operations_shopify_product_media_grants_expiry_valid
    CHECK (
      expires_at > issued_at
      AND (
        (
          desired_mode = 'active'
          AND expires_at <= issued_at + interval '15 minutes'
        )
        OR (
          desired_mode = 'shadow'
          AND expires_at <= issued_at + interval '1 minute'
        )
      )
    ),
  CONSTRAINT operations_shopify_product_media_grants_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_shopify_product_media_grants_revision_unique
    UNIQUE (
      organization_id,
      integration_account_id,
      product_id,
      aggregate_revision
    )
);

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_product_media_grants_asset
  ON operations_shopify_product_media_delivery_grants (
    organization_id,
    product_id,
    image_asset_id,
    expires_at
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_delivery_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Shopify product media delivery grants are immutable';
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_delivery_grant_write
  ON operations_shopify_product_media_delivery_grants;
CREATE TRIGGER
  protect_operations_shopify_product_media_delivery_grant_write
BEFORE UPDATE OR DELETE
ON operations_shopify_product_media_delivery_grants
FOR EACH ROW
EXECUTE FUNCTION
  protect_operations_shopify_product_media_delivery_grant();

COMMENT ON TABLE operations_shopify_product_media_delivery_grants IS
  'Immutable, replay-stable, short-lived Shopify product-media fetch grants. Shadow rows are signed evidence only and are never publicly deliverable.';
