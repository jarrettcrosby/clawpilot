CREATE TABLE IF NOT EXISTS app_users (
  email text PRIMARY KEY,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invited_by text REFERENCES app_users(email) ON DELETE SET NULL,
  invited_at timestamptz,
  activated_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_users_email_normalized CHECK (email = lower(email))
);

CREATE INDEX IF NOT EXISTS idx_app_users_status ON app_users (status, created_at);
