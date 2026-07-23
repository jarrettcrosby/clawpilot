-- Organization-scoped credentials for direct small-parcel carrier accounts.
--
-- operations_integration_accounts remains the searchable, non-secret account
-- record. This companion table stores only authenticated ciphertext and masked
-- metadata. Provider access tokens are intentionally never persisted.

CREATE TABLE IF NOT EXISTS operations_carrier_credentials (
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  credential_ciphertext bytea NOT NULL,
  credential_iv bytea NOT NULL,
  credential_tag bytea NOT NULL,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  client_id_last_four text NOT NULL CHECK (client_id_last_four ~ '^[[:print:]]{1,4}$'),
  account_number_last_four text CHECK (account_number_last_four ~ '^[[:print:]]{1,4}$'),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  verified_at timestamptz,
  last_error_code text,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_carrier_credentials_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_credentials_verified_state CHECK (
    (verification_status = 'verified' AND verified_at IS NOT NULL AND last_error_code IS NULL)
    OR verification_status <> 'verified'
  )
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_credentials_verification
  ON operations_carrier_credentials (organization_id, verification_status, updated_at DESC);
