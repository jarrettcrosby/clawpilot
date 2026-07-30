-- Resource-scoped Shopify Product-image provider-write authority.
--
-- Product media remains globally Shadow. A provider mutation is possible only
-- after an exact zero-write Shadow simulation and one short-lived owner/admin
-- authorization for the same CRM Product, sales-channel variant, Shopify
-- Product GID, primary image revision, credential generation, and current
-- global Shadow revision. The generic external-effect state machine continues
-- to represent the provider-call intent as desired_mode = 'active'; that
-- internal effect mode does not make the integration or Operations Active.
--
-- Columns added here are nullable so historical rows remain immutable audit
-- evidence. Every new grant/authorization must populate them, and historical
-- authorizations are deliberately unclaimable.

ALTER TABLE operations_shopify_product_media_delivery_grants
  ADD COLUMN IF NOT EXISTS external_variant_id text,
  ADD COLUMN IF NOT EXISTS channel_normalized_status text,
  ADD COLUMN IF NOT EXISTS channel_provider_active boolean;

ALTER TABLE operations_shopify_product_media_delivery_grants
  DROP CONSTRAINT IF EXISTS ops_shopify_media_grant_variant_valid;
ALTER TABLE operations_shopify_product_media_delivery_grants
  ADD CONSTRAINT ops_shopify_media_grant_variant_valid CHECK (
    external_variant_id IS NULL
    OR external_variant_id
      ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'
  );

ALTER TABLE operations_shopify_product_media_delivery_grants
  DROP CONSTRAINT IF EXISTS ops_shopify_media_grant_channel_status_valid;
ALTER TABLE operations_shopify_product_media_delivery_grants
  ADD CONSTRAINT ops_shopify_media_grant_channel_status_valid CHECK (
    channel_normalized_status IS NULL
    OR channel_normalized_status IN (
      'active', 'draft', 'archived', 'unlisted', 'unavailable', 'unknown'
    )
  );

ALTER TABLE operations_shopify_product_media_write_authorizations
  ADD COLUMN IF NOT EXISTS simulation_effect_id uuid,
  ADD COLUMN IF NOT EXISTS provider_write_activation_revision integer,
  ADD COLUMN IF NOT EXISTS confirmation_statement_version text;

ALTER TABLE operations_shopify_product_media_write_authorizations
  DROP CONSTRAINT IF EXISTS ops_shopify_media_auth_simulation_effect_fkey;
ALTER TABLE operations_shopify_product_media_write_authorizations
  ADD CONSTRAINT ops_shopify_media_auth_simulation_effect_fkey
  FOREIGN KEY (organization_id, simulation_effect_id)
  REFERENCES operations_commerce_external_effect_intents(
    organization_id,
    id
  ) ON DELETE RESTRICT;

ALTER TABLE operations_shopify_product_media_write_authorizations
  DROP CONSTRAINT IF EXISTS ops_shopify_media_auth_shadow_revision_valid;
ALTER TABLE operations_shopify_product_media_write_authorizations
  ADD CONSTRAINT ops_shopify_media_auth_shadow_revision_valid CHECK (
    provider_write_activation_revision IS NULL
    OR provider_write_activation_revision >= 1
  );

ALTER TABLE operations_shopify_product_media_write_authorizations
  DROP CONSTRAINT IF EXISTS ops_shopify_media_auth_resource_ttl_valid;
ALTER TABLE operations_shopify_product_media_write_authorizations
  ADD CONSTRAINT ops_shopify_media_auth_resource_ttl_valid CHECK (
    provider_write_activation_revision IS NULL
    OR expires_at <= authorized_at + interval '5 minutes'
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_ops_shopify_media_auth_simulation_effect
  ON operations_shopify_product_media_write_authorizations (
    organization_id,
    simulation_effect_id
  )
  WHERE simulation_effect_id IS NOT NULL;

-- A Shopify parent Product may have several variant channel rows, but every
-- mapped variant must resolve to the same ClawPilot Product. Serialize mapping
-- changes with grant preparation/claim so ambiguity cannot be introduced in
-- the interval immediately before the provider call.
CREATE OR REPLACE FUNCTION
  protect_operations_shopify_parent_product_mapping()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider <> 'shopify' OR NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-product-parent-map:'
        || NEW.organization_id::text
        || ':' || NEW.integration_account_id::text
        || ':' || NEW.external_product_id,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM operations_product_channel_states sibling
    WHERE sibling.organization_id = NEW.organization_id
      AND sibling.integration_account_id = NEW.integration_account_id
      AND sibling.provider = 'shopify'
      AND sibling.external_product_id = NEW.external_product_id
      AND sibling.product_id IS NOT NULL
      AND sibling.product_id IS DISTINCT FROM NEW.product_id
      AND sibling.id IS DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION
      'A Shopify parent Product GID cannot map to a second ClawPilot Product';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_parent_product_mapping_write
  ON operations_product_channel_states;
CREATE TRIGGER
  protect_operations_shopify_parent_product_mapping_write
BEFORE INSERT OR UPDATE
ON operations_product_channel_states
FOR EACH ROW
EXECUTE FUNCTION
  protect_operations_shopify_parent_product_mapping();

-- New delivery grants are exact snapshots. Both the simulation grant and the
-- provider-write delivery grant must be created while Operations is Shadow.
-- This eliminates the former generic Active image path at the first durable
-- boundary.
CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_delivery_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_status text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  activation_state text;
  current_activation_revision integer;
  current_product_reference text;
  current_product_source_hash text;
  current_channel_global_id text;
  current_channel_product_id uuid;
  current_channel_mapping_id uuid;
  current_channel_external_product_id text;
  current_channel_external_variant_id text;
  current_channel_status text;
  current_channel_provider_active boolean;
  current_channel_source_revision text;
  current_channel_source_hash text;
  current_channel_row_version bigint;
  current_mapping_active boolean;
  current_mapping_product_id uuid;
  current_mapping_external_product_id text;
  current_mapping_external_variant_id text;
  current_asset_revision bigint;
  current_asset_row_version bigint;
  current_asset_sha256 text;
  current_asset_mime_type text;
  current_asset_byte_length integer;
  current_asset_pixel_width integer;
  current_asset_pixel_height integer;
  current_asset_alt_text text;
  current_asset_is_primary boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'Shopify product media delivery grants are immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-product-parent-map:'
        || NEW.organization_id::text
        || ':' || NEW.integration_account_id::text
        || ':' || NEW.product_gid,
      0
    )
  );

  SELECT
    account.provider,
    account.integration_type,
    account.status,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status,
    activation.state,
    activation.revision
  INTO
    account_provider,
    account_type,
    account_status,
    account_generation,
    credential_generation,
    credential_status,
    activation_state,
    current_activation_revision
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  SELECT product.reference_code, product.source_hash
  INTO current_product_reference, current_product_source_hash
  FROM crm_products product
  WHERE product.pipeline_id = NEW.pipeline_id
    AND product.id = NEW.product_id;

  SELECT
    channel.global_id,
    channel.product_id,
    channel.product_mapping_id,
    channel.external_product_id,
    channel.external_variant_id,
    channel.normalized_status,
    channel.provider_active,
    channel.source_revision,
    channel.source_hash,
    channel.row_version
  INTO
    current_channel_global_id,
    current_channel_product_id,
    current_channel_mapping_id,
    current_channel_external_product_id,
    current_channel_external_variant_id,
    current_channel_status,
    current_channel_provider_active,
    current_channel_source_revision,
    current_channel_source_hash,
    current_channel_row_version
  FROM operations_product_channel_states channel
  WHERE channel.organization_id = NEW.organization_id
    AND channel.integration_account_id = NEW.integration_account_id
    AND channel.id = NEW.channel_state_id
    AND channel.pipeline_id = NEW.pipeline_id
    AND channel.provider = 'shopify';

  SELECT
    mapping.active,
    mapping.product_id,
    mapping.external_product_id,
    mapping.external_variant_id
  INTO
    current_mapping_active,
    current_mapping_product_id,
    current_mapping_external_product_id,
    current_mapping_external_variant_id
  FROM operations_product_mappings mapping
  WHERE mapping.organization_id = NEW.organization_id
    AND mapping.integration_account_id = NEW.integration_account_id
    AND mapping.pipeline_id = NEW.pipeline_id
    AND mapping.id = current_channel_mapping_id;

  SELECT
    asset.asset_revision,
    asset.row_version,
    asset.content_sha256,
    asset.mime_type,
    asset.byte_length,
    asset.pixel_width,
    asset.pixel_height,
    asset.alt_text,
    asset.is_primary
  INTO
    current_asset_revision,
    current_asset_row_version,
    current_asset_sha256,
    current_asset_mime_type,
    current_asset_byte_length,
    current_asset_pixel_width,
    current_asset_pixel_height,
    current_asset_alt_text,
    current_asset_is_primary
  FROM crm_product_image_assets asset
  WHERE asset.organization_id = NEW.organization_id
    AND asset.pipeline_id = NEW.pipeline_id
    AND asset.product_id = NEW.product_id
    AND asset.id = NEW.image_asset_id;

  IF account_provider IS DISTINCT FROM 'shopify'
     OR account_type IS DISTINCT FROM 'commerce'
     OR account_status NOT IN ('active', 'disabled')
     OR account_generation IS DISTINCT FROM NEW.credential_generation
     OR credential_generation IS DISTINCT FROM NEW.credential_generation
     OR credential_status IS DISTINCT FROM 'verified'
     OR activation_state IS DISTINCT FROM 'shadow'
     OR current_activation_revision IS DISTINCT FROM
       NEW.activation_revision
     OR current_product_reference IS DISTINCT FROM
       NEW.product_reference_code
     OR current_product_source_hash IS DISTINCT FROM
       NEW.product_source_hash
     OR current_channel_global_id IS DISTINCT FROM
       NEW.channel_state_global_id
     OR current_channel_product_id IS DISTINCT FROM NEW.product_id
     OR current_channel_external_product_id IS DISTINCT FROM NEW.product_gid
     OR current_channel_external_variant_id IS DISTINCT FROM
       NEW.external_variant_id
     OR current_channel_status IS DISTINCT FROM 'active'
     OR current_channel_status IS DISTINCT FROM
       NEW.channel_normalized_status
     OR current_channel_provider_active IS DISTINCT FROM true
     OR current_channel_provider_active IS DISTINCT FROM
       NEW.channel_provider_active
     OR current_channel_source_revision IS DISTINCT FROM
       NEW.channel_source_revision
     OR current_channel_source_hash IS DISTINCT FROM NEW.channel_source_hash
     OR current_channel_row_version IS DISTINCT FROM
       NEW.channel_state_row_version
     OR current_mapping_active IS DISTINCT FROM true
     OR current_mapping_product_id IS DISTINCT FROM NEW.product_id
     OR current_mapping_external_product_id IS DISTINCT FROM NEW.product_gid
     OR current_mapping_external_variant_id IS DISTINCT FROM
       NEW.external_variant_id
     OR current_asset_revision IS DISTINCT FROM NEW.asset_revision
     OR current_asset_row_version IS DISTINCT FROM NEW.asset_row_version
     OR current_asset_sha256 IS DISTINCT FROM NEW.asset_content_sha256
     OR current_asset_mime_type IS DISTINCT FROM NEW.asset_mime_type
     OR current_asset_byte_length IS DISTINCT FROM NEW.asset_byte_length
     OR current_asset_pixel_width IS DISTINCT FROM NEW.asset_pixel_width
     OR current_asset_pixel_height IS DISTINCT FROM NEW.asset_pixel_height
     OR current_asset_alt_text IS DISTINCT FROM NEW.asset_alt_text
     OR current_asset_is_primary IS DISTINCT FROM true
     OR NEW.issued_at < clock_timestamp() - interval '1 minute'
     OR NEW.issued_at > clock_timestamp() + interval '5 seconds'
     OR NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION
      'Shopify Product-image delivery grant selection or Shadow fence is stale';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_product_channel_states sibling
    WHERE sibling.organization_id = NEW.organization_id
      AND sibling.integration_account_id = NEW.integration_account_id
      AND sibling.provider = 'shopify'
      AND sibling.external_product_id = NEW.product_gid
      AND sibling.product_id IS NOT NULL
      AND sibling.product_id IS DISTINCT FROM NEW.product_id
  ) THEN
    RAISE EXCEPTION
      'Shopify Product-image authority is ambiguous because the parent Product GID maps to a second ClawPilot Product';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_delivery_grant_write
  ON operations_shopify_product_media_delivery_grants;
CREATE TRIGGER
  protect_operations_shopify_product_media_delivery_grant_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_product_media_delivery_grants
FOR EACH ROW
EXECUTE FUNCTION
  protect_operations_shopify_product_media_delivery_grant();

-- The signed Shopify fetch URL is created only after the exact active grant
-- and authorization exist. Persist only its safe hashes/host plus the already
-- verified token payload. The raw signed URL is never stored. This binding is
-- immutable and must exist before the external effect can be inserted or
-- claimed.
CREATE TABLE IF NOT EXISTS
  operations_shopify_product_media_source_bindings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    authorization_id uuid NOT NULL,
    delivery_grant_id uuid NOT NULL,
    source_url_sha256 text NOT NULL CHECK (
      source_url_sha256 ~ '^[0-9a-f]{64}$'
    ),
    source_origin text NOT NULL CHECK (
      length(source_origin) BETWEEN 9 AND 2048
      AND source_origin ~ '^https://[^/]+$'
    ),
    source_host text NOT NULL CHECK (
      length(source_host) BETWEEN 1 AND 255
      AND source_host = lower(source_host)
      AND source_host ~ '^[a-z0-9.-]+$'
    ),
    signed_token_sha256 text NOT NULL CHECK (
      signed_token_sha256 ~ '^[0-9a-f]{64}$'
    ),
    token_product_id uuid NOT NULL,
    token_image_asset_id uuid NOT NULL,
    token_asset_content_sha256 text NOT NULL CHECK (
      token_asset_content_sha256 ~ '^[0-9a-f]{64}$'
    ),
    token_mode text NOT NULL CHECK (token_mode = 'active'),
    token_issued_at_epoch bigint NOT NULL CHECK (
      token_issued_at_epoch >= 1
    ),
    token_expires_at_epoch bigint NOT NULL CHECK (
      token_expires_at_epoch > token_issued_at_epoch
      AND token_expires_at_epoch
        <= token_issued_at_epoch + (15 * 60)
    ),
    bound_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    bound_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_shopify_media_source_binding_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_source_binding_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES operations_shopify_product_media_write_authorizations(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_source_binding_grant_fkey
      FOREIGN KEY (organization_id, delivery_grant_id)
      REFERENCES operations_shopify_product_media_delivery_grants(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_source_binding_auth_unique
      UNIQUE (organization_id, authorization_id),
    CONSTRAINT ops_shopify_media_source_binding_grant_unique
      UNIQUE (organization_id, delivery_grant_id),
    CONSTRAINT ops_shopify_media_source_binding_org_id_unique
      UNIQUE (organization_id, id)
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_source_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  auth_account_id uuid;
  auth_grant_id uuid;
  auth_actor text;
  auth_expires_at timestamptz;
  grant_mode text;
  grant_public_origin text;
  grant_product_id uuid;
  grant_image_asset_id uuid;
  grant_asset_sha256 text;
  grant_issued_at_epoch bigint;
  grant_expires_at_epoch bigint;
  grant_expires_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify Product-image signed source bindings are immutable';
  END IF;

  SELECT
    auth.integration_account_id,
    auth.delivery_grant_id,
    auth.authorized_by,
    auth.expires_at,
    media_grant.desired_mode,
    media_grant.public_origin,
    media_grant.product_id,
    media_grant.image_asset_id,
    media_grant.asset_content_sha256,
    floor(extract(epoch FROM media_grant.issued_at))::bigint,
    floor(extract(epoch FROM media_grant.expires_at))::bigint,
    media_grant.expires_at
  INTO
    auth_account_id,
    auth_grant_id,
    auth_actor,
    auth_expires_at,
    grant_mode,
    grant_public_origin,
    grant_product_id,
    grant_image_asset_id,
    grant_asset_sha256,
    grant_issued_at_epoch,
    grant_expires_at_epoch,
    grant_expires_at
  FROM operations_shopify_product_media_write_authorizations auth
  JOIN operations_shopify_product_media_delivery_grants media_grant
    ON media_grant.organization_id = auth.organization_id
   AND media_grant.id = auth.delivery_grant_id
  WHERE auth.organization_id = NEW.organization_id
    AND auth.id = NEW.authorization_id
  FOR SHARE OF auth, media_grant;

  IF auth_account_id IS DISTINCT FROM NEW.integration_account_id
     OR auth_grant_id IS DISTINCT FROM NEW.delivery_grant_id
     OR auth_actor IS DISTINCT FROM NEW.bound_by
     OR auth_expires_at IS NULL
     OR auth_expires_at <= clock_timestamp()
     OR grant_expires_at IS NULL
     OR grant_expires_at <= clock_timestamp()
     OR grant_mode IS DISTINCT FROM 'active'
     OR grant_public_origin IS DISTINCT FROM NEW.source_origin
     OR lower(split_part(
       split_part(NEW.source_origin, '://', 2),
       ':',
       1
     )) IS DISTINCT FROM NEW.source_host
     OR grant_product_id IS DISTINCT FROM NEW.token_product_id
     OR grant_image_asset_id IS DISTINCT FROM NEW.token_image_asset_id
     OR grant_asset_sha256 IS DISTINCT FROM
       NEW.token_asset_content_sha256
     OR NEW.token_mode IS DISTINCT FROM 'active'
     OR grant_issued_at_epoch IS DISTINCT FROM
       NEW.token_issued_at_epoch
     OR grant_expires_at_epoch IS DISTINCT FROM
       NEW.token_expires_at_epoch THEN
    RAISE EXCEPTION
      'Shopify Product-image signed source binding is stale or mismatched';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_source_binding_write
  ON operations_shopify_product_media_source_bindings;
CREATE TRIGGER
  protect_operations_shopify_product_media_source_binding_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_product_media_source_bindings
FOR EACH ROW
EXECUTE FUNCTION
  protect_operations_shopify_product_media_source_binding();

-- This predicate is the shared insertion and pending-to-claimed fence. It
-- intentionally returns false for every legacy authorization because the
-- resource-scoped columns added above are NULL on historical evidence.
CREATE OR REPLACE FUNCTION
  operations_shopify_product_media_authority_is_current(
    requested_organization_id uuid,
    requested_authorization_id uuid,
    requested_integration_account_id uuid,
    requested_credential_generation integer,
    requested_activation_revision integer,
    requested_aggregate_type text,
    requested_aggregate_id text,
    requested_aggregate_revision bigint,
    requested_aggregate_hash text,
    requested_idempotency_key text,
    requested_redacted_request jsonb
  )
RETURNS boolean
LANGUAGE sql
VOLATILE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_product_media_write_authorizations auth
    JOIN operations_shopify_product_media_delivery_grants active_grant
      ON active_grant.organization_id = auth.organization_id
     AND active_grant.id = auth.delivery_grant_id
    JOIN operations_shopify_product_media_source_bindings source_binding
      ON source_binding.organization_id = auth.organization_id
     AND source_binding.integration_account_id =
       auth.integration_account_id
     AND source_binding.authorization_id = auth.id
     AND source_binding.delivery_grant_id = active_grant.id
    JOIN operations_commerce_external_effect_intents simulation
      ON simulation.organization_id = auth.organization_id
     AND simulation.id = auth.simulation_effect_id
    JOIN operations_shopify_product_media_delivery_grants shadow_grant
      ON shadow_grant.organization_id = simulation.organization_id
     AND shadow_grant.integration_account_id =
       simulation.integration_account_id
     AND shadow_grant.idempotency_key = simulation.idempotency_key
     AND shadow_grant.aggregate_revision =
       simulation.aggregate_revision
     AND shadow_grant.aggregate_hash = simulation.aggregate_hash
    JOIN operations_integration_accounts account
      ON account.organization_id = auth.organization_id
     AND account.id = auth.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = auth.organization_id
    JOIN app_user_organization_memberships membership
      ON membership.organization_id = auth.organization_id
     AND membership.user_email = auth.authorized_by
    JOIN crm_products product
      ON product.pipeline_id = active_grant.pipeline_id
     AND product.id = active_grant.product_id
    JOIN operations_product_channel_states channel
      ON channel.organization_id = active_grant.organization_id
     AND channel.integration_account_id =
       active_grant.integration_account_id
     AND channel.id = active_grant.channel_state_id
    JOIN operations_product_mappings mapping
      ON mapping.organization_id = channel.organization_id
     AND mapping.integration_account_id = channel.integration_account_id
     AND mapping.pipeline_id = channel.pipeline_id
     AND mapping.id = channel.product_mapping_id
    JOIN crm_product_image_assets asset
      ON asset.organization_id = active_grant.organization_id
     AND asset.pipeline_id = active_grant.pipeline_id
     AND asset.product_id = active_grant.product_id
     AND asset.id = active_grant.image_asset_id
    WHERE auth.organization_id = requested_organization_id
      AND auth.id = requested_authorization_id
      AND auth.integration_account_id =
        requested_integration_account_id
      AND auth.expires_at > clock_timestamp()
      AND auth.expires_at <= active_grant.expires_at
      AND auth.authorized_role IN ('owner', 'admin')
      AND membership.status = 'active'
      AND membership.role = auth.authorized_role
      AND auth.confirmation_statement_version =
        'shopify-product-image-shadow-provider-write-v1'
      AND auth.provider_write_activation_revision =
        requested_activation_revision
      AND account.integration_type = 'commerce'
      AND account.provider = 'shopify'
      AND account.status IN ('active', 'disabled')
      AND account.commerce_credential_generation =
        requested_credential_generation
      AND credential.credential_version = requested_credential_generation
      AND credential.verification_status = 'verified'
      AND activation.state = 'shadow'
      AND activation.revision = requested_activation_revision
      AND requested_aggregate_type = 'shopify_product_projection'
      AND active_grant.desired_mode = 'active'
      AND active_grant.integration_account_id =
        requested_integration_account_id
      AND active_grant.credential_generation =
        requested_credential_generation
      AND active_grant.activation_revision = requested_activation_revision
      AND active_grant.product_reference_code = requested_aggregate_id
      AND active_grant.aggregate_revision = requested_aggregate_revision
      AND active_grant.aggregate_hash = requested_aggregate_hash
      AND active_grant.idempotency_key = requested_idempotency_key
      AND active_grant.external_variant_id IS NOT NULL
      AND active_grant.channel_normalized_status = 'active'
      AND active_grant.channel_provider_active = true
      AND active_grant.product_reference_code = product.reference_code
      AND active_grant.product_source_hash = product.source_hash
      AND active_grant.channel_state_global_id = channel.global_id
      AND active_grant.channel_state_row_version = channel.row_version
      AND active_grant.channel_source_revision = channel.source_revision
      AND active_grant.channel_source_hash = channel.source_hash
      AND active_grant.product_id = channel.product_id
      AND active_grant.product_gid = channel.external_product_id
      AND active_grant.external_variant_id = channel.external_variant_id
      AND channel.provider = 'shopify'
      AND channel.normalized_status = 'active'
      AND channel.provider_active = true
      AND mapping.active = true
      AND mapping.product_id = active_grant.product_id
      AND mapping.external_product_id = active_grant.product_gid
      AND mapping.external_variant_id = active_grant.external_variant_id
      AND active_grant.asset_revision = asset.asset_revision
      AND active_grant.asset_row_version = asset.row_version
      AND active_grant.asset_content_sha256 = asset.content_sha256
      AND active_grant.asset_mime_type = asset.mime_type
      AND active_grant.asset_byte_length = asset.byte_length
      AND active_grant.asset_pixel_width = asset.pixel_width
      AND active_grant.asset_pixel_height = asset.pixel_height
      AND active_grant.asset_alt_text = asset.alt_text
      AND asset.is_primary = true
      AND shadow_grant.desired_mode = 'shadow'
      AND shadow_grant.integration_account_id =
        active_grant.integration_account_id
      AND shadow_grant.pipeline_id = active_grant.pipeline_id
      AND shadow_grant.product_id = active_grant.product_id
      AND shadow_grant.channel_state_id = active_grant.channel_state_id
      AND shadow_grant.image_asset_id = active_grant.image_asset_id
      AND shadow_grant.public_origin = active_grant.public_origin
      AND shadow_grant.product_reference_code =
        active_grant.product_reference_code
      AND shadow_grant.product_source_hash =
        active_grant.product_source_hash
      AND shadow_grant.product_gid = active_grant.product_gid
      AND shadow_grant.external_variant_id =
        active_grant.external_variant_id
      AND shadow_grant.channel_state_global_id =
        active_grant.channel_state_global_id
      AND shadow_grant.channel_state_row_version =
        active_grant.channel_state_row_version
      AND shadow_grant.channel_source_revision =
        active_grant.channel_source_revision
      AND shadow_grant.channel_source_hash =
        active_grant.channel_source_hash
      AND shadow_grant.channel_normalized_status =
        active_grant.channel_normalized_status
      AND shadow_grant.channel_provider_active =
        active_grant.channel_provider_active
      AND shadow_grant.asset_revision = active_grant.asset_revision
      AND shadow_grant.asset_row_version = active_grant.asset_row_version
      AND shadow_grant.asset_content_sha256 =
        active_grant.asset_content_sha256
      AND shadow_grant.asset_mime_type = active_grant.asset_mime_type
      AND shadow_grant.asset_byte_length = active_grant.asset_byte_length
      AND shadow_grant.asset_pixel_width = active_grant.asset_pixel_width
      AND shadow_grant.asset_pixel_height = active_grant.asset_pixel_height
      AND shadow_grant.asset_alt_text = active_grant.asset_alt_text
      AND shadow_grant.credential_generation =
        active_grant.credential_generation
      AND shadow_grant.activation_revision =
        requested_activation_revision
      AND simulation.integration_account_id =
        active_grant.integration_account_id
      AND simulation.provider = 'shopify'
      AND simulation.action = 'shopify.product.update'
      AND simulation.desired_mode = 'shadow'
      AND simulation.state = 'simulated'
      AND simulation.credential_generation =
        active_grant.credential_generation
      AND simulation.activation_revision =
        requested_activation_revision
      AND simulation.aggregate_type = 'shopify_product_projection'
      AND simulation.aggregate_id = shadow_grant.product_reference_code
      AND simulation.aggregate_revision = shadow_grant.aggregate_revision
      AND simulation.aggregate_hash = shadow_grant.aggregate_hash
      AND simulation.idempotency_key = shadow_grant.idempotency_key
      AND simulation.provider_write_count = 0
      AND simulation.redacted_result->>'providerWrites' = '0'
      AND simulation.redacted_request->>'provider' = 'shopify'
      AND simulation.redacted_request->>'operation' = 'productUpdate'
      AND simulation.redacted_request->>'productGid' =
        shadow_grant.product_gid
      AND simulation.redacted_request->>'deliveryGrantId' =
        shadow_grant.id::text
      AND NOT (
        simulation.redacted_request
          ? 'productMediaAuthorizationId'
      )
      AND jsonb_typeof(
        simulation.redacted_request->'patch'->'media'
      ) = 'object'
      AND (
        SELECT count(*)
        FROM jsonb_object_keys(
          simulation.redacted_request->'patch'
        )
      ) = 1
      AND simulation.redacted_request
        ->'patch'->'media'->>'mediaContentType' = 'IMAGE'
      AND simulation.redacted_request
        ->'patch'->'media'->>'originalSourceSha256'
          ~ '^[0-9a-f]{64}$'
      AND length(btrim(
        simulation.redacted_request
          ->'patch'->'media'->>'sourceHost'
      )) BETWEEN 1 AND 255
      AND simulation.redacted_request
        ->'patch'->'media'->>'altSha256' =
          encode(digest(active_grant.asset_alt_text, 'sha256'), 'hex')
      AND requested_redacted_request->>'provider' = 'shopify'
      AND requested_redacted_request->>'operation' = 'productUpdate'
      AND requested_redacted_request->>'productGid' =
        active_grant.product_gid
      AND requested_redacted_request->>'deliveryGrantId' =
        active_grant.id::text
      AND requested_redacted_request->>'productMediaAuthorizationId' =
        auth.id::text
      AND requested_redacted_request
        ->'patch'->'media'->>'originalSourceSha256' =
        source_binding.source_url_sha256
      AND requested_redacted_request
        ->'patch'->'media'->>'sourceHost' =
        source_binding.source_host
      AND jsonb_typeof(
        requested_redacted_request->'patch'->'media'
      ) = 'object'
      AND (
        SELECT count(*)
        FROM jsonb_object_keys(requested_redacted_request->'patch')
      ) = 1
      AND requested_redacted_request
        ->'patch'->'media'->>'mediaContentType' = 'IMAGE'
      AND requested_redacted_request
        ->'patch'->'media'->>'originalSourceSha256'
          ~ '^[0-9a-f]{64}$'
      AND length(btrim(
        requested_redacted_request
          ->'patch'->'media'->>'sourceHost'
      )) BETWEEN 1 AND 255
      AND requested_redacted_request
        ->'patch'->'media'->>'altSha256' =
          encode(digest(active_grant.asset_alt_text, 'sha256'), 'hex')
      AND NOT EXISTS (
        SELECT 1
        FROM operations_product_channel_states sibling
        WHERE sibling.organization_id = active_grant.organization_id
          AND sibling.integration_account_id =
            active_grant.integration_account_id
          AND sibling.provider = 'shopify'
          AND sibling.external_product_id = active_grant.product_gid
          AND sibling.product_id IS NOT NULL
          AND sibling.product_id IS DISTINCT FROM active_grant.product_id
      )
  )
$$;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_write_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_grant record;
  shadow_grant record;
  simulation record;
  membership_role text;
  membership_status text;
  activation_state text;
  current_activation_revision integer;
  account_provider text;
  account_type text;
  account_status text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify Product-image write authorizations are immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-product-media-authorization:'
        || NEW.organization_id::text
        || ':' || NEW.integration_account_id::text
        || ':' || NEW.delivery_grant_id::text,
      0
    )
  );

  IF NEW.simulation_effect_id IS NULL
     OR NEW.provider_write_activation_revision IS NULL
     OR NEW.confirmation_statement_version IS DISTINCT FROM
       'shopify-product-image-shadow-provider-write-v1'
     OR NEW.authorized_at < clock_timestamp() - interval '5 seconds'
     OR NEW.authorized_at > clock_timestamp() + interval '5 seconds'
     OR NEW.expires_at > NEW.authorized_at + interval '5 minutes' THEN
    RAISE EXCEPTION
      'Shopify Product-image authorization requires exact short-lived Shadow simulation evidence';
  END IF;

  SELECT * INTO active_grant
  FROM operations_shopify_product_media_delivery_grants grant_row
  WHERE grant_row.organization_id = NEW.organization_id
    AND grant_row.id = NEW.delivery_grant_id
  FOR SHARE;

  IF active_grant.id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'shopify-product-parent-map:'
          || active_grant.organization_id::text
          || ':' || active_grant.integration_account_id::text
          || ':' || active_grant.product_gid,
        0
      )
    );
  END IF;

  SELECT * INTO simulation
  FROM operations_commerce_external_effect_intents effect
  WHERE effect.organization_id = NEW.organization_id
    AND effect.id = NEW.simulation_effect_id
  FOR SHARE;

  SELECT * INTO shadow_grant
  FROM operations_shopify_product_media_delivery_grants grant_row
  WHERE grant_row.organization_id = NEW.organization_id
    AND grant_row.integration_account_id =
      simulation.integration_account_id
    AND grant_row.idempotency_key = simulation.idempotency_key
    AND grant_row.aggregate_revision = simulation.aggregate_revision
    AND grant_row.aggregate_hash = simulation.aggregate_hash
  FOR SHARE;

  SELECT role, status
  INTO membership_role, membership_status
  FROM app_user_organization_memberships
  WHERE organization_id = NEW.organization_id
    AND user_email = NEW.authorized_by;

  SELECT
    account.provider,
    account.integration_type,
    account.status,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status,
    activation.state,
    activation.revision
  INTO
    account_provider,
    account_type,
    account_status,
    account_generation,
    credential_generation,
    credential_status,
    activation_state,
    current_activation_revision
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF active_grant.id IS NULL
     OR shadow_grant.id IS NULL
     OR simulation.id IS NULL
     OR active_grant.integration_account_id IS DISTINCT FROM
       NEW.integration_account_id
     OR active_grant.desired_mode IS DISTINCT FROM 'active'
     OR shadow_grant.desired_mode IS DISTINCT FROM 'shadow'
     OR active_grant.expires_at <= clock_timestamp()
     OR NEW.authorized_at < active_grant.issued_at
     OR NEW.expires_at > active_grant.expires_at
     OR membership_role IS DISTINCT FROM NEW.authorized_role
     OR membership_role NOT IN ('owner', 'admin')
     OR membership_status IS DISTINCT FROM 'active'
     OR account_provider IS DISTINCT FROM 'shopify'
     OR account_type IS DISTINCT FROM 'commerce'
     OR account_status NOT IN ('active', 'disabled')
     OR account_generation IS DISTINCT FROM
       active_grant.credential_generation
     OR credential_generation IS DISTINCT FROM
       active_grant.credential_generation
     OR credential_status IS DISTINCT FROM 'verified'
     OR activation_state IS DISTINCT FROM 'shadow'
     OR current_activation_revision IS DISTINCT FROM
       NEW.provider_write_activation_revision
     OR active_grant.activation_revision IS DISTINCT FROM
       NEW.provider_write_activation_revision
     OR shadow_grant.activation_revision IS DISTINCT FROM
       NEW.provider_write_activation_revision
     OR ROW(
       shadow_grant.organization_id,
       shadow_grant.integration_account_id,
       shadow_grant.pipeline_id,
       shadow_grant.product_id,
       shadow_grant.channel_state_id,
       shadow_grant.image_asset_id,
       shadow_grant.public_origin,
       shadow_grant.product_reference_code,
       shadow_grant.product_source_hash,
       shadow_grant.product_gid,
       shadow_grant.external_variant_id,
       shadow_grant.channel_state_global_id,
       shadow_grant.channel_state_row_version,
       shadow_grant.channel_source_revision,
       shadow_grant.channel_source_hash,
       shadow_grant.channel_normalized_status,
       shadow_grant.channel_provider_active,
       shadow_grant.asset_revision,
       shadow_grant.asset_row_version,
       shadow_grant.asset_content_sha256,
       shadow_grant.asset_mime_type,
       shadow_grant.asset_byte_length,
       shadow_grant.asset_pixel_width,
       shadow_grant.asset_pixel_height,
       shadow_grant.asset_alt_text,
       shadow_grant.credential_generation
     ) IS DISTINCT FROM ROW(
       active_grant.organization_id,
       active_grant.integration_account_id,
       active_grant.pipeline_id,
       active_grant.product_id,
       active_grant.channel_state_id,
       active_grant.image_asset_id,
       active_grant.public_origin,
       active_grant.product_reference_code,
       active_grant.product_source_hash,
       active_grant.product_gid,
       active_grant.external_variant_id,
       active_grant.channel_state_global_id,
       active_grant.channel_state_row_version,
       active_grant.channel_source_revision,
       active_grant.channel_source_hash,
       active_grant.channel_normalized_status,
       active_grant.channel_provider_active,
       active_grant.asset_revision,
       active_grant.asset_row_version,
       active_grant.asset_content_sha256,
       active_grant.asset_mime_type,
       active_grant.asset_byte_length,
       active_grant.asset_pixel_width,
       active_grant.asset_pixel_height,
       active_grant.asset_alt_text,
       active_grant.credential_generation
     )
     OR simulation.integration_account_id IS DISTINCT FROM
       NEW.integration_account_id
     OR simulation.provider IS DISTINCT FROM 'shopify'
     OR simulation.action IS DISTINCT FROM 'shopify.product.update'
     OR simulation.desired_mode IS DISTINCT FROM 'shadow'
     OR simulation.state IS DISTINCT FROM 'simulated'
     OR simulation.credential_generation IS DISTINCT FROM
       active_grant.credential_generation
     OR simulation.activation_revision IS DISTINCT FROM
       NEW.provider_write_activation_revision
     OR simulation.aggregate_type IS DISTINCT FROM
       'shopify_product_projection'
     OR simulation.aggregate_id IS DISTINCT FROM
       shadow_grant.product_reference_code
     OR simulation.aggregate_revision IS DISTINCT FROM
       shadow_grant.aggregate_revision
     OR simulation.aggregate_hash IS DISTINCT FROM
       shadow_grant.aggregate_hash
     OR simulation.idempotency_key IS DISTINCT FROM
       shadow_grant.idempotency_key
     OR simulation.provider_write_count IS DISTINCT FROM 0
     OR simulation.redacted_result->>'providerWrites' IS DISTINCT FROM '0'
     OR simulation.redacted_request->>'provider' IS DISTINCT FROM
       'shopify'
     OR simulation.redacted_request->>'operation' IS DISTINCT FROM
       'productUpdate'
     OR simulation.redacted_request->>'productGid' IS DISTINCT FROM
       shadow_grant.product_gid
     OR simulation.redacted_request->>'deliveryGrantId' IS DISTINCT FROM
       shadow_grant.id::text
     OR simulation.redacted_request
       ? 'productMediaAuthorizationId'
     OR jsonb_typeof(
       simulation.redacted_request->'patch'->'media'
     ) IS DISTINCT FROM 'object'
     OR (
       SELECT count(*)
       FROM jsonb_object_keys(simulation.redacted_request->'patch')
     ) IS DISTINCT FROM 1::bigint
     OR simulation.redacted_request
       ->'patch'->'media'->>'mediaContentType'
       IS DISTINCT FROM 'IMAGE'
     OR COALESCE(
       simulation.redacted_request
         ->'patch'->'media'->>'originalSourceSha256',
       ''
     ) !~ '^[0-9a-f]{64}$'
     OR length(btrim(COALESCE(
       simulation.redacted_request
         ->'patch'->'media'->>'sourceHost',
       ''
     ))) NOT BETWEEN 1 AND 255
     OR simulation.redacted_request
       ->'patch'->'media'->>'altSha256'
       IS DISTINCT FROM encode(
         digest(active_grant.asset_alt_text, 'sha256'),
         'hex'
       )
     OR NOT EXISTS (
       SELECT 1
       FROM crm_products product
       JOIN operations_product_channel_states channel
         ON channel.organization_id = active_grant.organization_id
        AND channel.integration_account_id =
          active_grant.integration_account_id
        AND channel.id = active_grant.channel_state_id
        AND channel.pipeline_id = active_grant.pipeline_id
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = channel.organization_id
        AND mapping.integration_account_id =
          channel.integration_account_id
        AND mapping.pipeline_id = channel.pipeline_id
        AND mapping.id = channel.product_mapping_id
       JOIN crm_product_image_assets asset
         ON asset.organization_id = active_grant.organization_id
        AND asset.pipeline_id = active_grant.pipeline_id
        AND asset.product_id = active_grant.product_id
        AND asset.id = active_grant.image_asset_id
       WHERE product.pipeline_id = active_grant.pipeline_id
         AND product.id = active_grant.product_id
         AND product.reference_code =
           active_grant.product_reference_code
         AND product.source_hash = active_grant.product_source_hash
         AND channel.provider = 'shopify'
         AND channel.product_id = active_grant.product_id
         AND channel.global_id =
           active_grant.channel_state_global_id
         AND channel.external_product_id = active_grant.product_gid
         AND channel.external_variant_id =
           active_grant.external_variant_id
         AND channel.normalized_status = 'active'
         AND channel.provider_active = true
         AND channel.row_version =
           active_grant.channel_state_row_version
         AND channel.source_revision =
           active_grant.channel_source_revision
         AND channel.source_hash = active_grant.channel_source_hash
         AND mapping.active = true
         AND mapping.product_id = active_grant.product_id
         AND mapping.external_product_id = active_grant.product_gid
         AND mapping.external_variant_id =
           active_grant.external_variant_id
         AND asset.is_primary = true
         AND asset.asset_revision = active_grant.asset_revision
         AND asset.row_version = active_grant.asset_row_version
         AND asset.content_sha256 =
           active_grant.asset_content_sha256
         AND asset.mime_type = active_grant.asset_mime_type
         AND asset.byte_length = active_grant.asset_byte_length
         AND asset.pixel_width = active_grant.asset_pixel_width
         AND asset.pixel_height = active_grant.asset_pixel_height
         AND asset.alt_text = active_grant.asset_alt_text
     )
     OR EXISTS (
       SELECT 1
       FROM operations_product_channel_states sibling
       WHERE sibling.organization_id = NEW.organization_id
         AND sibling.integration_account_id =
           NEW.integration_account_id
         AND sibling.provider = 'shopify'
         AND sibling.external_product_id = active_grant.product_gid
         AND sibling.product_id IS NOT NULL
         AND sibling.product_id IS DISTINCT FROM active_grant.product_id
     ) THEN
    RAISE EXCEPTION
      'Shopify Product-image resource-scoped Shadow authorization fence is invalid or stale';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_write_authorization_write
  ON operations_shopify_product_media_write_authorizations;
CREATE TRIGGER
  protect_operations_shopify_product_media_write_authorization_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_product_media_write_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_product_media_write_authorization();

-- Preserve the provider-neutral external-effect state machine. Only the exact
-- Product-image authorization above may enter/claim an internally Active
-- effect while the current global state is Shadow. Ordinary effects retain
-- their original Active/Shadow fences, and an image-bearing Active effect
-- without exact authority is rejected.
CREATE OR REPLACE FUNCTION
  protect_operations_commerce_external_effect_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_status text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  activation_state text;
  activation_revision integer;
  fence_revision bigint;
  fence_hash text;
  attempt_action text;
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
  attempt_lease_token uuid;
  attempt_redacted_response jsonb;
  attempt_provider_reference text;
  attempt_error_code text;
  exact_product_media_authority boolean := false;
  request_contains_product_media boolean := false;
  exact_product_media_parent_gid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Commerce external-effect intents are immutable and cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.action,
    NEW.desired_mode,
    NEW.credential_generation,
    NEW.activation_revision,
    NEW.aggregate_type,
    NEW.aggregate_id,
    NEW.aggregate_revision,
    NEW.aggregate_hash,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.shopify_product_media_authorization_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.provider,
    OLD.action,
    OLD.desired_mode,
    OLD.credential_generation,
    OLD.activation_revision,
    OLD.aggregate_type,
    OLD.aggregate_id,
    OLD.aggregate_revision,
    OLD.aggregate_hash,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.shopify_product_media_authorization_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Commerce external-effect intent identity and request are immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.provider_write_count IS DISTINCT FROM OLD.provider_write_count
     AND NOT (
       OLD.state = 'claimed'
       AND NEW.state IN ('succeeded', 'failed', 'unknown')
     ) THEN
    RAISE EXCEPTION
      'Commerce external-effect provider write count changes only at terminal finalization';
  END IF;

  IF TG_OP = 'INSERT' OR (
    TG_OP = 'UPDATE' AND OLD.state = 'pending' AND NEW.state = 'claimed'
  ) THEN
    SELECT
      account.provider,
      account.integration_type,
      account.status,
      account.commerce_credential_generation,
      credential.credential_version,
      credential.verification_status,
      activation.state,
      activation.revision,
      fence.aggregate_revision,
      fence.aggregate_hash
    INTO
      account_provider,
      account_type,
      account_status,
      account_generation,
      credential_generation,
      credential_status,
      activation_state,
      activation_revision,
      fence_revision,
      fence_hash
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = account.organization_id
    JOIN operations_commerce_external_effect_aggregate_fences fence
      ON fence.organization_id = account.organization_id
     AND fence.integration_account_id = account.id
     AND fence.provider = account.provider
     AND fence.aggregate_type = NEW.aggregate_type
     AND fence.aggregate_id = NEW.aggregate_id
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id;

    request_contains_product_media := (
      NEW.provider = 'shopify'
      AND NEW.action = 'shopify.product.update'
      AND COALESCE(NEW.redacted_request->'patch', '{}'::jsonb) ? 'media'
    );

    IF NEW.shopify_product_media_authorization_id IS NOT NULL THEN
      SELECT media_grant.product_gid
      INTO exact_product_media_parent_gid
      FROM operations_shopify_product_media_write_authorizations auth
      JOIN operations_shopify_product_media_delivery_grants media_grant
        ON media_grant.organization_id = auth.organization_id
       AND media_grant.id = auth.delivery_grant_id
      WHERE auth.organization_id = NEW.organization_id
        AND auth.id = NEW.shopify_product_media_authorization_id;

      IF exact_product_media_parent_gid IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
          hashtextextended(
            'shopify-product-parent-map:'
              || NEW.organization_id::text
              || ':' || NEW.integration_account_id::text
              || ':' || exact_product_media_parent_gid,
            0
          )
        );
      END IF;

      exact_product_media_authority :=
        operations_shopify_product_media_authority_is_current(
          NEW.organization_id,
          NEW.shopify_product_media_authorization_id,
          NEW.integration_account_id,
          NEW.credential_generation,
          NEW.activation_revision,
          NEW.aggregate_type,
          NEW.aggregate_id,
          NEW.aggregate_revision,
          NEW.aggregate_hash,
          NEW.idempotency_key,
          NEW.redacted_request
        );
      IF NOT exact_product_media_authority THEN
        RAISE EXCEPTION
          'Shopify Product-image resource-scoped Shadow authority is stale, mismatched, or already invalid';
      END IF;
    END IF;

    IF NEW.desired_mode = 'active'
       AND request_contains_product_media
       AND NOT exact_product_media_authority THEN
      RAISE EXCEPTION
        'An Active Shopify Product-image effect requires exact resource-scoped Shadow authority';
    END IF;

    IF account_type IS DISTINCT FROM 'commerce'
       OR account_provider IS DISTINCT FROM NEW.provider
       OR (
         NEW.desired_mode = 'active'
         AND account_status IS DISTINCT FROM 'active'
         AND NOT exact_product_media_authority
       )
       OR (
         (
           NEW.desired_mode = 'shadow'
           OR exact_product_media_authority
         )
         AND account_status NOT IN ('active', 'disabled')
       )
       OR account_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION
        'Commerce external-effect credential fence is stale';
    END IF;

    IF (
      exact_product_media_authority
      AND (
        NEW.desired_mode IS DISTINCT FROM 'active'
        OR activation_state IS DISTINCT FROM 'shadow'
        OR activation_revision IS DISTINCT FROM NEW.activation_revision
      )
    ) OR (
      NOT exact_product_media_authority
      AND (
        activation_state IS DISTINCT FROM NEW.desired_mode
        OR activation_revision IS DISTINCT FROM NEW.activation_revision
      )
    ) THEN
      RAISE EXCEPTION
        'Commerce external-effect activation fence is stale';
    END IF;

    IF fence_revision IS DISTINCT FROM NEW.aggregate_revision
       OR fence_hash IS DISTINCT FROM NEW.aggregate_hash THEN
      RAISE EXCEPTION
        'Commerce external-effect aggregate fence is stale';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (
      NEW.desired_mode = 'shadow'
      AND NEW.state <> 'simulated'
    ) OR (
      NEW.desired_mode = 'active'
      AND NEW.state <> 'pending'
    ) THEN
      RAISE EXCEPTION
        'Commerce external-effect intent has an invalid initial state';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('simulated', 'succeeded', 'failed', 'unknown') THEN
    RAISE EXCEPTION
      'Terminal commerce external-effect evidence is immutable';
  END IF;

  IF OLD.state = 'pending' THEN
    IF NEW.state <> 'claimed'
       OR OLD.desired_mode <> 'active'
       OR NEW.provider_attempt_id IS NULL
       OR NEW.lease_token IS NULL THEN
      RAISE EXCEPTION
        'Only a current provider-write external effect can be claimed';
    END IF;

    SELECT
      action,
      idempotency_key,
      request_hash,
      state,
      lease_token
    INTO
      attempt_action,
      attempt_idempotency_key,
      attempt_request_hash,
      attempt_state,
      attempt_lease_token
    FROM operations_commerce_provider_attempts
    WHERE id = NEW.provider_attempt_id
      AND organization_id = NEW.organization_id
      AND integration_account_id = NEW.integration_account_id;

    IF attempt_action IS DISTINCT FROM
         ('external_effect:' || NEW.action)
       OR attempt_idempotency_key IS DISTINCT FROM NEW.idempotency_key
       OR attempt_request_hash IS DISTINCT FROM NEW.request_hash
       OR attempt_state IS DISTINCT FROM 'prepared'
       OR attempt_lease_token IS DISTINCT FROM NEW.lease_token THEN
      RAISE EXCEPTION
        'Commerce external-effect provider attempt does not match its intent';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'claimed'
     OR NEW.state NOT IN ('succeeded', 'failed', 'unknown')
     OR NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id
     OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.redacted_result IS NULL
     OR NEW.terminal_evidence_hash IS NULL
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'Claimed commerce external effect must finalize exactly once';
  END IF;

  SELECT
    state,
    redacted_response,
    provider_reference,
    error_code
  INTO
    attempt_state,
    attempt_redacted_response,
    attempt_provider_reference,
    attempt_error_code
  FROM operations_commerce_provider_attempts
  WHERE id = NEW.provider_attempt_id
    AND organization_id = NEW.organization_id
    AND integration_account_id = NEW.integration_account_id;

  IF attempt_state IS DISTINCT FROM NEW.state
     OR attempt_redacted_response IS DISTINCT FROM NEW.redacted_result
     OR attempt_provider_reference IS DISTINCT FROM NEW.provider_reference
     OR attempt_error_code IS DISTINCT FROM NEW.error_code THEN
    RAISE EXCEPTION
      'Commerce external-effect terminal evidence must match its provider attempt';
  END IF;
  RETURN NEW;
END;
$$;

-- Shopify may fetch the image after productUpdate is accepted. Serving bytes
-- is allowed only for the exact delivery grant linked to the single claimed
-- effect; no generic Active grant is sufficient.
CREATE OR REPLACE FUNCTION
  operations_shopify_product_media_delivery_is_authorized(
    requested_organization_id uuid,
    requested_delivery_grant_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_product_media_write_authorizations auth
    JOIN operations_shopify_product_media_delivery_grants media_grant
      ON media_grant.organization_id = auth.organization_id
     AND media_grant.id = auth.delivery_grant_id
    JOIN operations_shopify_product_media_source_bindings source_binding
      ON source_binding.organization_id = auth.organization_id
     AND source_binding.integration_account_id =
       auth.integration_account_id
     AND source_binding.authorization_id = auth.id
     AND source_binding.delivery_grant_id = media_grant.id
    JOIN operations_commerce_external_effect_intents effect
      ON effect.organization_id = auth.organization_id
     AND effect.shopify_product_media_authorization_id = auth.id
    WHERE auth.organization_id = requested_organization_id
      AND auth.delivery_grant_id = requested_delivery_grant_id
      AND media_grant.desired_mode = 'active'
      AND effect.provider = 'shopify'
      AND effect.action = 'shopify.product.update'
      AND effect.desired_mode = 'active'
      AND effect.state IN ('claimed', 'succeeded', 'unknown')
      AND effect.provider_attempt_id IS NOT NULL
      AND effect.integration_account_id =
        media_grant.integration_account_id
      AND effect.credential_generation =
        media_grant.credential_generation
      AND effect.activation_revision = media_grant.activation_revision
      AND effect.aggregate_type = 'shopify_product_projection'
      AND effect.aggregate_id = media_grant.product_reference_code
      AND effect.aggregate_revision = media_grant.aggregate_revision
      AND effect.aggregate_hash = media_grant.aggregate_hash
      AND effect.idempotency_key = media_grant.idempotency_key
      AND effect.redacted_request->>'deliveryGrantId' =
        media_grant.id::text
      AND effect.redacted_request->>'productMediaAuthorizationId' =
        auth.id::text
      AND effect.redacted_request->>'productGid' =
        media_grant.product_gid
      AND effect.redacted_request
        ->'patch'->'media'->>'originalSourceSha256' =
        source_binding.source_url_sha256
      AND effect.redacted_request
        ->'patch'->'media'->>'sourceHost' =
        source_binding.source_host
  )
$$;

COMMENT ON COLUMN
  operations_shopify_product_media_delivery_grants.external_variant_id IS
  'Exact Shopify ProductVariant GID captured with the parent Product GID; NULL marks legacy audit-only evidence.';
COMMENT ON COLUMN
  operations_shopify_product_media_write_authorizations.simulation_effect_id IS
  'Exact immutable zero-write Shadow effect consumed once by this provider-write authorization.';
COMMENT ON COLUMN
  operations_shopify_product_media_write_authorizations.provider_write_activation_revision IS
  'Current global Shadow revision at provider-write authorization and claim; NULL legacy rows are unclaimable.';
COMMENT ON TABLE
  operations_shopify_product_media_source_bindings IS
  'Immutable hash-only binding between one verified signed Shopify media URL, its exact active grant/authorization, and the token payload checked before external-effect preparation.';
COMMENT ON TABLE
  operations_shopify_product_media_write_authorizations IS
  'Immutable one-use owner/admin grants for one exact Shopify Product-image append after matching zero-write Shadow simulation. New grants expire within five minutes and never change global Operations from Shadow.';
