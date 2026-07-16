CREATE TABLE IF NOT EXISTS app_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  authenticated_user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  effective_user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  auth_method text NOT NULL CHECK (auth_method IN ('magic_code', 'operator_password', 'legacy_upgrade')),
  device_label text NOT NULL,
  user_agent text,
  initial_network_fingerprint text,
  last_network_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_user_activity_at timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz NOT NULL DEFAULT now(),
  idle_timeout_seconds integer NOT NULL CHECK (idle_timeout_seconds BETWEEN 300 AND 2592000),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  impersonation_started_at timestamptz,
  impersonation_expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT app_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT app_sessions_expiry_order CHECK (absolute_expires_at > created_at),
  CONSTRAINT app_sessions_impersonation_state CHECK (
    (effective_user_email = authenticated_user_email
      AND impersonation_started_at IS NULL
      AND impersonation_expires_at IS NULL)
    OR
    (effective_user_email <> authenticated_user_email
      AND impersonation_started_at IS NOT NULL
      AND impersonation_expires_at IS NOT NULL
      AND impersonation_expires_at > impersonation_started_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_authenticated_active
  ON app_sessions (authenticated_user_email, last_seen_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_sessions_effective_active
  ON app_sessions (effective_user_email, last_seen_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_sessions_expiration
  ON app_sessions (LEAST(idle_expires_at, absolute_expires_at))
  WHERE revoked_at IS NULL;
