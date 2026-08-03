-- Preserve uncertain Shopify Product-image writes while allowing a later,
-- read-only provider reconciliation to prove that the exact parent Product
-- still has no media. Two provider observations, both made after the
-- asynchronous-settlement window and at least one minute apart, are required
-- before a different Active image intent can be authorized.

CREATE TABLE IF NOT EXISTS
  operations_shopify_product_media_unknown_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    delivery_grant_id uuid NOT NULL,
    external_effect_id uuid NOT NULL,
    authorization_id uuid NOT NULL,
    product_id uuid NOT NULL,
    image_asset_id uuid NOT NULL,
    product_gid text NOT NULL,
    asset_content_sha256 text NOT NULL,
    source_url_sha256 text NOT NULL,
    signed_token_sha256 text NOT NULL,
    credential_generation integer NOT NULL CHECK (
      credential_generation >= 1
    ),
    provider_shop_gid text NOT NULL CHECK (
      provider_shop_gid ~ '^gid://shopify/Shop/[1-9][0-9]*$'
    ),
    observed_product_gid text NOT NULL,
    observed_product_title text NOT NULL,
    provider_media_count integer NOT NULL CHECK (
      provider_media_count BETWEEN 0 AND 1000000000
    ),
    latest_media_gid text,
    latest_media_content_type text,
    latest_media_status text,
    provider_response_sha256 text NOT NULL,
    provider_query_contract text NOT NULL CHECK (
      provider_query_contract =
        'shopify-graphql-2026-07-product-media-absence-v1'
    ),
    provider_network_call_count integer NOT NULL CHECK (
      provider_network_call_count = 3
    ),
    provider_write_count integer NOT NULL DEFAULT 0 CHECK (
      provider_write_count = 0
    ),
    observed_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    -- Supplied by the service immediately after the provider response is
    -- received. The trigger rejects delayed storage so spacing is measured
    -- between actual Shopify reads rather than database insert attempts.
    observed_at timestamptz NOT NULL,
    CONSTRAINT ops_shopify_media_unknown_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_unknown_grant_fkey
      FOREIGN KEY (organization_id, delivery_grant_id)
      REFERENCES operations_shopify_product_media_delivery_grants(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_unknown_effect_fkey
      FOREIGN KEY (organization_id, external_effect_id)
      REFERENCES operations_commerce_external_effect_intents(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_unknown_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES operations_shopify_product_media_write_authorizations(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_media_unknown_product_gid_valid
      CHECK (
        product_gid ~ '^gid://shopify/Product/[1-9][0-9]*$'
        AND observed_product_gid = product_gid
      ),
    CONSTRAINT ops_shopify_media_unknown_asset_hash_valid
      CHECK (asset_content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ops_shopify_media_unknown_source_hash_valid
      CHECK (
        source_url_sha256 ~ '^[0-9a-f]{64}$'
        AND signed_token_sha256 ~ '^[0-9a-f]{64}$'
      ),
    CONSTRAINT ops_shopify_media_unknown_response_hash_valid
      CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ops_shopify_media_unknown_latest_media_valid
      CHECK (
        (
          provider_media_count = 0
          AND latest_media_gid IS NULL
          AND latest_media_content_type IS NULL
          AND latest_media_status IS NULL
        )
        OR (
          provider_media_count > 0
          AND latest_media_gid ~
            '^gid://shopify/[A-Za-z][A-Za-z0-9]*/[1-9][0-9]*$'
          AND latest_media_content_type IN (
            'EXTERNAL_VIDEO',
            'IMAGE',
            'MODEL_3D',
            'VIDEO'
          )
          AND latest_media_status IN (
            'FAILED',
            'PROCESSING',
            'READY',
            'UPLOADED'
          )
        )
      ),
    CONSTRAINT ops_shopify_media_unknown_title_valid
      CHECK (
        length(btrim(observed_product_title)) BETWEEN 1 AND 255
        AND observed_product_title !~ '[[:cntrl:]]'
      )
  );

CREATE INDEX IF NOT EXISTS
  idx_ops_shopify_product_media_unknown_latest
  ON operations_shopify_product_media_unknown_observations (
    organization_id,
    external_effect_id,
    observed_at,
    id
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_unknown_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_account_id uuid;
  expected_grant_id uuid;
  expected_authorization_id uuid;
  expected_product_id uuid;
  expected_image_asset_id uuid;
  expected_product_gid text;
  expected_asset_sha256 text;
  expected_source_url_sha256 text;
  expected_signed_token_sha256 text;
  expected_credential_generation integer;
  expected_shop_gid text;
  expected_account_status text;
  expected_account_generation integer;
  expected_credential_version integer;
  expected_credential_status text;
  expected_auth_mode text;
  expected_eligible_after timestamptz;
  membership_role text;
  membership_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify Product-image unknown observations are append-only';
  END IF;

  SELECT
    media_grant.integration_account_id,
    media_grant.id,
    auth.id,
    media_grant.product_id,
    media_grant.image_asset_id,
    media_grant.product_gid,
    media_grant.asset_content_sha256,
    source_binding.source_url_sha256,
    source_binding.signed_token_sha256,
    media_grant.credential_generation,
    account.external_account_id,
    account.status,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status,
    credential.auth_mode,
    GREATEST(
      COALESCE(
        effect.completed_at,
        effect.updated_at,
        effect.created_at
      ),
      media_grant.expires_at
    ) + interval '5 minutes'
  INTO
    expected_account_id,
    expected_grant_id,
    expected_authorization_id,
    expected_product_id,
    expected_image_asset_id,
    expected_product_gid,
    expected_asset_sha256,
    expected_source_url_sha256,
    expected_signed_token_sha256,
    expected_credential_generation,
    expected_shop_gid,
    expected_account_status,
    expected_account_generation,
    expected_credential_version,
    expected_credential_status,
    expected_auth_mode,
    expected_eligible_after
  FROM operations_commerce_external_effect_intents effect
  JOIN operations_shopify_product_media_write_authorizations auth
    ON auth.organization_id = effect.organization_id
   AND auth.id = effect.shopify_product_media_authorization_id
  JOIN operations_shopify_product_media_delivery_grants media_grant
    ON media_grant.organization_id = auth.organization_id
   AND media_grant.id = auth.delivery_grant_id
   AND media_grant.integration_account_id =
         effect.integration_account_id
   AND media_grant.idempotency_key = effect.idempotency_key
  JOIN operations_shopify_product_media_source_bindings source_binding
    ON source_binding.organization_id = auth.organization_id
   AND source_binding.integration_account_id =
         auth.integration_account_id
   AND source_binding.authorization_id = auth.id
   AND source_binding.delivery_grant_id = media_grant.id
  JOIN operations_integration_accounts account
    ON account.organization_id = media_grant.organization_id
   AND account.id = media_grant.integration_account_id
   AND account.provider = 'shopify'
   AND account.integration_type = 'commerce'
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  WHERE effect.organization_id = NEW.organization_id
    AND effect.id = NEW.external_effect_id
    AND effect.provider = 'shopify'
    AND effect.action = 'shopify.product.update'
    AND effect.desired_mode = 'active'
    AND effect.state = 'unknown'
    AND effect.provider_write_count = 0
    AND media_grant.desired_mode = 'active'
  FOR SHARE OF effect, auth, media_grant, source_binding;

  SELECT membership.role, membership.status
  INTO membership_role, membership_status
  FROM app_user_organization_memberships membership
  WHERE membership.organization_id = NEW.organization_id
    AND membership.user_email = NEW.observed_by;

  IF expected_account_id IS DISTINCT FROM NEW.integration_account_id
     OR expected_grant_id IS DISTINCT FROM NEW.delivery_grant_id
     OR expected_authorization_id IS DISTINCT FROM NEW.authorization_id
     OR expected_product_id IS DISTINCT FROM NEW.product_id
     OR expected_image_asset_id IS DISTINCT FROM NEW.image_asset_id
     OR expected_product_gid IS DISTINCT FROM NEW.product_gid
     OR expected_product_gid IS DISTINCT FROM NEW.observed_product_gid
     OR expected_asset_sha256 IS DISTINCT FROM
       NEW.asset_content_sha256
     OR expected_source_url_sha256 IS DISTINCT FROM
       NEW.source_url_sha256
     OR expected_signed_token_sha256 IS DISTINCT FROM
       NEW.signed_token_sha256
     OR expected_credential_generation IS DISTINCT FROM
       NEW.credential_generation
     OR expected_shop_gid IS DISTINCT FROM NEW.provider_shop_gid
     OR expected_account_status NOT IN ('active', 'disabled')
     OR expected_account_generation IS DISTINCT FROM
       NEW.credential_generation
     OR expected_credential_version IS DISTINCT FROM
       NEW.credential_generation
     OR expected_credential_status IS DISTINCT FROM 'verified'
     OR expected_auth_mode IS DISTINCT FROM
       'shopify_client_credentials'
     OR expected_eligible_after IS NULL
     OR NEW.observed_at < expected_eligible_after
     OR NEW.observed_at <
       statement_timestamp() - interval '5 seconds'
     OR NEW.observed_at >
       statement_timestamp() + interval '1 second'
     OR membership_role NOT IN ('owner', 'admin')
     OR membership_status IS DISTINCT FROM 'active'
     OR NEW.provider_query_contract IS DISTINCT FROM
       'shopify-graphql-2026-07-product-media-absence-v1'
     OR NEW.provider_network_call_count IS DISTINCT FROM 3
     OR NEW.provider_write_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'Shopify Product-image unknown observation identity is invalid';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_unknown_observation_write
  ON operations_shopify_product_media_unknown_observations;
CREATE TRIGGER
  protect_operations_shopify_product_media_unknown_observation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_product_media_unknown_observations
FOR EACH ROW
EXECUTE FUNCTION
  protect_operations_shopify_product_media_unknown_observation();

CREATE OR REPLACE FUNCTION
  operations_shopify_product_media_unknown_is_reconciled(
    scoped_organization_id uuid,
    scoped_external_effect_id uuid,
    scoped_delivery_grant_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT
      count(observation.id) >= 2
      AND bool_and(observation.provider_media_count = 0)
      AND min(observation.observed_at) >=
        GREATEST(
          COALESCE(
            effect.completed_at,
            effect.updated_at,
            effect.created_at
          ),
          media_grant.expires_at
        ) + interval '5 minutes'
      AND max(observation.observed_at)
        - min(observation.observed_at) >= interval '1 minute'
      AND max(observation.observed_at)
        >= statement_timestamp() - interval '5 minutes'
    FROM operations_commerce_external_effect_intents effect
    JOIN operations_shopify_product_media_delivery_grants media_grant
      ON media_grant.organization_id = effect.organization_id
     AND media_grant.id = scoped_delivery_grant_id
     AND media_grant.integration_account_id =
           effect.integration_account_id
     AND media_grant.idempotency_key = effect.idempotency_key
    LEFT JOIN
      operations_shopify_product_media_unknown_observations observation
      ON observation.organization_id = effect.organization_id
     AND observation.external_effect_id = effect.id
     AND observation.delivery_grant_id = media_grant.id
     AND observation.integration_account_id =
           media_grant.integration_account_id
     AND observation.product_id = media_grant.product_id
     AND observation.image_asset_id = media_grant.image_asset_id
     AND observation.product_gid = media_grant.product_gid
     AND observation.asset_content_sha256 =
           media_grant.asset_content_sha256
     AND observation.credential_generation =
           media_grant.credential_generation
     AND observation.provider_query_contract =
           'shopify-graphql-2026-07-product-media-absence-v1'
     AND observation.provider_write_count = 0
    WHERE effect.organization_id = scoped_organization_id
      AND effect.id = scoped_external_effect_id
      AND effect.provider = 'shopify'
      AND effect.action = 'shopify.product.update'
      AND effect.desired_mode = 'active'
      AND effect.state = 'unknown'
      AND effect.provider_write_count = 0
    GROUP BY
      effect.id,
      effect.completed_at,
      effect.updated_at,
      effect.created_at,
      media_grant.expires_at
  ), false)
$$;

COMMENT ON TABLE
  operations_shopify_product_media_unknown_observations IS
  'Append-only, exact-identity Shopify Product reads used to prove no media exists after an uncertain image append. Two zero-media observations after settlement are required; the original unknown effect remains immutable.';

COMMENT ON FUNCTION
  operations_shopify_product_media_unknown_is_reconciled(
    uuid,
    uuid,
    uuid
  ) IS
  'Returns true only after two exact zero-media provider observations made at least five minutes after both the uncertain attempt and signed-source expiry, one minute apart, with fresh latest evidence.';
