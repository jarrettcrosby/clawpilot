CREATE TABLE IF NOT EXISTS app_user_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  invited_by text REFERENCES app_users(email) ON DELETE SET NULL,
  token_digest text NOT NULL UNIQUE,
  from_address text NOT NULL,
  delivery_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  code_requested_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_invitations_email_normalized CHECK (email = lower(email)),
  CONSTRAINT app_user_invitations_digest_format CHECK (
    char_length(token_digest) = 64
    AND token_digest ~ '^[0-9a-f]+$'
  ),
  CONSTRAINT app_user_invitations_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_app_user_invitations_email_created
  ON app_user_invitations (email, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_invitations_active_expiry
  ON app_user_invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE auth_magic_codes
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'sign_in',
  ADD COLUMN IF NOT EXISTS invitation_id uuid REFERENCES app_user_invitations(id) ON DELETE CASCADE;

ALTER TABLE auth_magic_codes
  DROP CONSTRAINT IF EXISTS auth_magic_codes_purpose_valid;

ALTER TABLE auth_magic_codes
  ADD CONSTRAINT auth_magic_codes_purpose_valid CHECK (
    (purpose = 'sign_in' AND invitation_id IS NULL)
    OR (purpose = 'invitation' AND invitation_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_auth_magic_codes_invitation
  ON auth_magic_codes (invitation_id)
  WHERE invitation_id IS NOT NULL;
