CREATE TABLE IF NOT EXISTS auth_magic_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  code_digest text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT auth_magic_codes_email_normalized CHECK (email = lower(email)),
  CONSTRAINT auth_magic_codes_digest_format CHECK (
    char_length(code_digest) = 64
    AND code_digest ~ '^[0-9a-f]+$'
  ),
  CONSTRAINT auth_magic_codes_attempts_range CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT auth_magic_codes_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_auth_magic_codes_unconsumed_expiry
  ON auth_magic_codes (expires_at)
  WHERE consumed_at IS NULL;
