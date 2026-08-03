-- Narrow Shopify Product-image provider-write authority and asynchronous
-- media reconciliation.
--
-- A verified Shopify credential may remain receipt-disabled. One explicit
-- owner/admin confirmation creates one immutable authorization for one exact
-- active delivery grant (account, Product GID, source aggregate, CRM image,
-- credential generation, and Operations activation revision). The generic
-- external-effect outbox may bypass only the account-status fence for that
-- exact shopify.product.update intent. No other provider action is widened.

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_shopify_product_media_grants_org_id
  ON operations_shopify_product_media_delivery_grants (
    organization_id,
    id
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_product_media_write_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    delivery_grant_id uuid NOT NULL,
    authorized_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    authorized_role text NOT NULL CHECK (
      authorized_role IN ('owner', 'admin')
    ),
    authorized_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT ops_shopify_product_media_write_auth_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_product_media_write_auth_grant_fkey
      FOREIGN KEY (organization_id, delivery_grant_id)
      REFERENCES operations_shopify_product_media_delivery_grants(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_product_media_write_auth_grant_unique
      UNIQUE (organization_id, delivery_grant_id),
    CONSTRAINT ops_shopify_product_media_write_auth_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT ops_shopify_product_media_write_auth_expiry_valid
      CHECK (
        expires_at > authorized_at
        AND expires_at <= authorized_at + interval '15 minutes'
      )
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_write_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  grant_account_id uuid;
  grant_mode text;
  grant_expires_at timestamptz;
  membership_role text;
  membership_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify Product-image write authorizations are immutable';
  END IF;

  SELECT integration_account_id, desired_mode, expires_at
    INTO grant_account_id, grant_mode, grant_expires_at
  FROM operations_shopify_product_media_delivery_grants
  WHERE organization_id = NEW.organization_id
    AND id = NEW.delivery_grant_id;

  SELECT role, status
    INTO membership_role, membership_status
  FROM app_user_organization_memberships
  WHERE organization_id = NEW.organization_id
    AND user_email = NEW.authorized_by;

  IF grant_account_id IS DISTINCT FROM NEW.integration_account_id
     OR grant_mode IS DISTINCT FROM 'active'
     OR grant_expires_at IS NULL
     OR NEW.expires_at > grant_expires_at
     OR membership_role IS DISTINCT FROM NEW.authorized_role
     OR membership_role NOT IN ('owner', 'admin')
     OR membership_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Shopify Product-image write authorization fence is invalid';
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

ALTER TABLE operations_commerce_external_effect_intents
  ADD COLUMN IF NOT EXISTS
    shopify_product_media_authorization_id uuid;

ALTER TABLE operations_commerce_external_effect_intents
  DROP CONSTRAINT IF EXISTS
    ops_commerce_effect_shopify_product_media_auth_fkey;
ALTER TABLE operations_commerce_external_effect_intents
  ADD CONSTRAINT
    ops_commerce_effect_shopify_product_media_auth_fkey
  FOREIGN KEY (
    organization_id,
    shopify_product_media_authorization_id
  )
  REFERENCES operations_shopify_product_media_write_authorizations(
    organization_id,
    id
  ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_ops_commerce_effect_shopify_product_media_auth
  ON operations_commerce_external_effect_intents (
    organization_id,
    shopify_product_media_authorization_id
  )
  WHERE shopify_product_media_authorization_id IS NOT NULL;

ALTER TABLE operations_commerce_external_effect_intents
  DROP CONSTRAINT IF EXISTS
    ops_commerce_effect_shopify_product_media_auth_valid;
ALTER TABLE operations_commerce_external_effect_intents
  ADD CONSTRAINT
    ops_commerce_effect_shopify_product_media_auth_valid
  CHECK (
    shopify_product_media_authorization_id IS NULL
    OR (
      provider = 'shopify'
      AND action = 'shopify.product.update'
      AND desired_mode = 'active'
    )
  );

-- Replace the original immutable-intent trigger with the same state machine
-- plus one exact authorization exception to the integration-account status
-- fence. Credential, activation, aggregate, and provider-attempt fences remain
-- mandatory.
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

    IF NEW.shopify_product_media_authorization_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM operations_shopify_product_media_write_authorizations auth
        JOIN operations_shopify_product_media_delivery_grants media_grant
          ON media_grant.organization_id = auth.organization_id
         AND media_grant.id = auth.delivery_grant_id
        WHERE auth.organization_id = NEW.organization_id
          AND auth.id = NEW.shopify_product_media_authorization_id
          AND auth.integration_account_id = NEW.integration_account_id
          AND auth.expires_at > clock_timestamp()
          AND media_grant.desired_mode = 'active'
          AND media_grant.integration_account_id =
                NEW.integration_account_id
          AND media_grant.credential_generation =
                NEW.credential_generation
          AND media_grant.activation_revision = NEW.activation_revision
          AND media_grant.product_reference_code = NEW.aggregate_id
          AND media_grant.aggregate_revision = NEW.aggregate_revision
          AND media_grant.aggregate_hash = NEW.aggregate_hash
          AND media_grant.idempotency_key = NEW.idempotency_key
      ) INTO exact_product_media_authority;
    END IF;

    IF account_type IS DISTINCT FROM 'commerce'
       OR account_provider IS DISTINCT FROM NEW.provider
       OR (
         NEW.desired_mode = 'active'
         AND account_status IS DISTINCT FROM 'active'
         AND NOT exact_product_media_authority
       )
       OR (
         NEW.desired_mode = 'shadow'
         AND account_status NOT IN ('active', 'disabled')
       )
       OR account_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_generation IS DISTINCT FROM NEW.credential_generation
       OR credential_status IS DISTINCT FROM 'verified' THEN
      RAISE EXCEPTION
        'Commerce external-effect credential fence is stale';
    END IF;

    IF activation_state IS DISTINCT FROM NEW.desired_mode
       OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
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
        'Only a current Active external effect can be claimed';
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

CREATE TABLE IF NOT EXISTS
  operations_shopify_product_media_status_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    delivery_grant_id uuid NOT NULL,
    external_effect_id uuid NOT NULL,
    media_image_gid text NOT NULL,
    media_status text NOT NULL CHECK (
      media_status IN ('FAILED', 'PROCESSING', 'READY', 'UPLOADED')
    ),
    media_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    terminal boolean GENERATED ALWAYS AS (
      media_status IN ('FAILED', 'READY')
    ) STORED,
    observed_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    observed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ops_shopify_product_media_status_grant_fkey
      FOREIGN KEY (organization_id, delivery_grant_id)
      REFERENCES operations_shopify_product_media_delivery_grants(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_product_media_status_effect_fkey
      FOREIGN KEY (organization_id, external_effect_id)
      REFERENCES operations_commerce_external_effect_intents(
        organization_id,
        id
      ) ON DELETE RESTRICT,
    CONSTRAINT ops_shopify_product_media_status_gid_valid
      CHECK (
        media_image_gid ~ '^gid://shopify/MediaImage/[1-9][0-9]*$'
      ),
    CONSTRAINT ops_shopify_product_media_status_errors_valid
      CHECK (
        jsonb_typeof(media_errors) = 'array'
        AND octet_length(media_errors::text) <= 65536
        AND operations_commerce_external_effect_json_is_redacted(
          jsonb_build_object('mediaErrors', media_errors)
        )
      )
  );

CREATE INDEX IF NOT EXISTS
  idx_ops_shopify_product_media_status_latest
  ON operations_shopify_product_media_status_observations (
    organization_id,
    external_effect_id,
    observed_at DESC,
    id DESC
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_ops_shopify_product_media_status_terminal
  ON operations_shopify_product_media_status_observations (
    organization_id,
    external_effect_id
  )
  WHERE terminal;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_product_media_status_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_grant_id uuid;
  expected_media_gid text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify Product-media status observations are append-only';
  END IF;

  SELECT
    auth.delivery_grant_id,
    effect.redacted_result->'media'->>'id'
  INTO expected_grant_id, expected_media_gid
  FROM operations_commerce_external_effect_intents effect
  JOIN operations_shopify_product_media_write_authorizations auth
    ON auth.organization_id = effect.organization_id
   AND auth.id = effect.shopify_product_media_authorization_id
  WHERE effect.organization_id = NEW.organization_id
    AND effect.id = NEW.external_effect_id
    AND effect.provider = 'shopify'
    AND effect.action = 'shopify.product.update'
    AND effect.desired_mode = 'active'
    AND effect.state = 'succeeded';

  IF expected_grant_id IS DISTINCT FROM NEW.delivery_grant_id
     OR expected_media_gid IS DISTINCT FROM NEW.media_image_gid THEN
    RAISE EXCEPTION
      'Shopify Product-media status observation identity is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_product_media_status_observation_write
  ON operations_shopify_product_media_status_observations;
CREATE TRIGGER
  protect_operations_shopify_product_media_status_observation_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_product_media_status_observations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_product_media_status_observation();

COMMENT ON TABLE
  operations_shopify_product_media_write_authorizations IS
  'Immutable owner/admin authority for one exact Shopify Product-image append while generic receipt and provider-write account status may remain disabled.';
COMMENT ON TABLE
  operations_shopify_product_media_status_observations IS
  'Append-only provider reads that reconcile asynchronous Shopify MediaImage processing to READY or FAILED without repeating productUpdate.';
