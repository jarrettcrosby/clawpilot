-- Organization-controlled Google sign-in and explicit existing-user identity linking.
-- The platform owns the OAuth client configuration. Organizations only decide
-- whether their active members may use a previously linked Google identity.

CREATE TABLE IF NOT EXISTS app_organization_auth_policies (
  organization_id uuid PRIMARY KEY
    REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  google_sign_in_enabled boolean NOT NULL DEFAULT false,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user_external_identities (
  provider text NOT NULL CHECK (provider = 'google'),
  provider_subject text NOT NULL,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  verified_email text NOT NULL,
  linked_organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  linked_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version = 0),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject),
  CONSTRAINT app_user_external_identities_provider_subject_valid CHECK (
    length(btrim(provider_subject)) BETWEEN 1 AND 255
    AND provider_subject !~ '[[:cntrl:]]'
  ),
  CONSTRAINT app_user_external_identities_verified_email_matches CHECK (
    verified_email = user_email
    AND verified_email = lower(btrim(verified_email))
  ),
  CONSTRAINT app_user_external_identities_user_provider_unique
    UNIQUE (provider, user_email)
);

CREATE INDEX IF NOT EXISTS idx_app_user_external_identities_user
  ON app_user_external_identities (user_email, provider, linked_at DESC);

-- A durable receipt prevents a retried security command from applying a
-- different payload. Results contain only sanitized policy/link state, never
-- an OAuth token or provider subject.
CREATE TABLE IF NOT EXISTS app_auth_mutation_receipts (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  command_type text NOT NULL CHECK (
    command_type IN ('google_policy_update', 'google_identity_link')
  ),
  request_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, actor_email, idempotency_key),
  CONSTRAINT app_auth_mutation_receipts_idempotency_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT app_auth_mutation_receipts_request_hash_valid CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS idx_app_auth_mutation_receipts_created
  ON app_auth_mutation_receipts (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_app_auth_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS app_user_external_identities_immutable
  ON app_user_external_identities;
CREATE TRIGGER app_user_external_identities_immutable
BEFORE UPDATE OR DELETE ON app_user_external_identities
FOR EACH ROW EXECUTE FUNCTION reject_app_auth_immutable_mutation();

DROP TRIGGER IF EXISTS app_auth_mutation_receipts_immutable
  ON app_auth_mutation_receipts;
CREATE TRIGGER app_auth_mutation_receipts_immutable
BEFORE UPDATE OR DELETE ON app_auth_mutation_receipts
FOR EACH ROW EXECUTE FUNCTION reject_app_auth_immutable_mutation();
