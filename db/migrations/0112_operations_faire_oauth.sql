-- Faire custom-application OAuth installation state and credential mode.
--
-- OAuth installation state is short lived, bound to the initiating browser
-- session and organization, and stores only a SHA-256 state digest. The
-- application secret is encrypted before persistence. Authorization codes and
-- OAuth access tokens are never stored in this table.

ALTER TABLE operations_commerce_credentials
  DROP CONSTRAINT IF EXISTS operations_commerce_credentials_auth_mode_check,
  ADD CONSTRAINT operations_commerce_credentials_auth_mode_check CHECK (
    auth_mode IN (
      'shopify_client_credentials',
      'faire_brand_token',
      'faire_oauth'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_commerce_credentials_webhook_state,
  ADD CONSTRAINT operations_commerce_credentials_webhook_state CHECK (
    (
      auth_mode = 'shopify_client_credentials'
      AND (
        (
          webhook_verification_status = 'verified'
          AND webhook_verified_at IS NOT NULL
        )
        OR (
          webhook_verification_status = 'unverified'
          AND webhook_verified_at IS NULL
        )
      )
    )
    OR (
      auth_mode IN ('faire_brand_token', 'faire_oauth')
      AND webhook_verification_status = 'not_applicable'
      AND webhook_verified_at IS NULL
    )
  );

-- Authentication mode changes are credential rotations, not provider-account
-- identity changes. They must advance the generation and replace the encrypted
-- credential exactly like any other secret rotation.
CREATE OR REPLACE FUNCTION protect_operations_commerce_credential_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  secret_changed boolean;
BEGIN
  IF ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.external_account_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.external_account_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Commerce credential identity is immutable';
  END IF;

  secret_changed := ROW(
    NEW.auth_mode,
    NEW.credential_ciphertext,
    NEW.credential_iv,
    NEW.credential_tag,
    NEW.credential_identifier_last_four
  ) IS DISTINCT FROM ROW(
    OLD.auth_mode,
    OLD.credential_ciphertext,
    OLD.credential_iv,
    OLD.credential_tag,
    OLD.credential_identifier_last_four
  );

  IF NEW.auth_mode IS DISTINCT FROM OLD.auth_mode
     AND ROW(
       NEW.credential_ciphertext,
       NEW.credential_iv,
       NEW.credential_tag
     ) IS NOT DISTINCT FROM ROW(
       OLD.credential_ciphertext,
       OLD.credential_iv,
       OLD.credential_tag
     ) THEN
    RAISE EXCEPTION 'Commerce authentication mode changes require replacement ciphertext';
  END IF;

  IF NEW.credential_version = OLD.credential_version AND secret_changed THEN
    RAISE EXCEPTION 'Commerce credential secret changes require a new generation';
  END IF;
  IF NEW.credential_version <> OLD.credential_version
     AND (
       NEW.credential_version <> OLD.credential_version + 1
       OR NOT secret_changed
     ) THEN
    RAISE EXCEPTION 'Commerce credential generations must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS operations_commerce_oauth_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'faire'),
  browser_session_id uuid NOT NULL
    REFERENCES app_sessions(id) ON DELETE CASCADE,
  actor_email text NOT NULL
    REFERENCES app_users(email) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE
    CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  redirect_url text NOT NULL
    CHECK (
      length(redirect_url) BETWEEN 12 AND 2048
      AND redirect_url ~ '^https://'
    ),
  display_name text
    CHECK (
      display_name IS NULL
      OR length(btrim(display_name)) BETWEEN 1 AND 120
    ),
  requested_scopes text[] NOT NULL
    CHECK (
      cardinality(requested_scopes) BETWEEN 1 AND 10
      AND array_position(requested_scopes, NULL) IS NULL
    ),
  application_id_last_four text NOT NULL
    CHECK (application_id_last_four ~ '^[[:print:]]{1,4}$'),
  application_credential_ciphertext bytea NOT NULL
    CHECK (octet_length(application_credential_ciphertext) > 0),
  application_credential_iv bytea NOT NULL
    CHECK (octet_length(application_credential_iv) = 12),
  application_credential_tag bytea NOT NULL
    CHECK (octet_length(application_credential_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT operations_commerce_oauth_installations_expiry_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '20 minutes'
  ),
  UNIQUE (organization_id, provider, browser_session_id)
);

CREATE INDEX IF NOT EXISTS operations_commerce_oauth_installations_expiry_idx
  ON operations_commerce_oauth_installations (expires_at);
