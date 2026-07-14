CREATE TABLE IF NOT EXISTS user_maton_credentials (
  owner_email text PRIMARY KEY REFERENCES app_users(email) ON DELETE CASCADE,
  login_email text,
  api_key_ciphertext bytea,
  api_key_iv bytea,
  api_key_tag bytea,
  api_key_last_four text,
  api_key_version integer NOT NULL DEFAULT 0,
  key_rotated_at timestamptz,
  key_revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_maton_credentials_login_email_valid CHECK (
    login_email IS NULL OR (
      login_email = lower(btrim(login_email))
      AND char_length(login_email) BETWEEN 3 AND 254
      AND login_email ~ '^[!-~]+$'
    )
  ),
  CONSTRAINT user_maton_credentials_key_version_valid CHECK (api_key_version >= 0),
  CONSTRAINT user_maton_credentials_key_material_valid CHECK (
    (
      api_key_ciphertext IS NULL
      AND api_key_iv IS NULL
      AND api_key_tag IS NULL
      AND api_key_last_four IS NULL
      AND key_rotated_at IS NULL
    ) OR (
      octet_length(api_key_ciphertext) > 0
      AND octet_length(api_key_iv) = 12
      AND octet_length(api_key_tag) = 16
      AND char_length(api_key_last_four) = 4
      AND key_rotated_at IS NOT NULL
      AND key_revoked_at IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS user_maton_connections (
  owner_email text NOT NULL REFERENCES user_maton_credentials(owner_email) ON DELETE CASCADE,
  connection_id text NOT NULL,
  name text NOT NULL,
  app text NOT NULL,
  status text NOT NULL,
  method text,
  account_email text,
  is_selected boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'maton' CHECK (source IN ('maton', 'manual')),
  remote_created_at timestamptz,
  remote_updated_at timestamptz,
  last_refreshed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, connection_id),
  CONSTRAINT user_maton_connections_id_valid CHECK (
    connection_id = btrim(connection_id)
    AND char_length(connection_id) BETWEEN 1 AND 512
    AND connection_id ~ '^[!-~]+$'
  ),
  CONSTRAINT user_maton_connections_name_valid CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 100
    AND name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT user_maton_connections_app_valid CHECK (
    app ~ '^[a-z][a-z0-9-]{0,63}$'
  ),
  CONSTRAINT user_maton_connections_status_valid CHECK (
    status ~ '^[A-Z][A-Z0-9_-]{0,31}$'
  ),
  CONSTRAINT user_maton_connections_method_valid CHECK (
    method IS NULL OR (
      method = btrim(method)
      AND char_length(method) BETWEEN 1 AND 64
      AND method ~ '^[!-~]+$'
    )
  ),
  CONSTRAINT user_maton_connections_account_email_valid CHECK (
    account_email IS NULL OR (
      account_email = lower(btrim(account_email))
      AND char_length(account_email) BETWEEN 3 AND 254
      AND account_email ~ '^[!-~]+$'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_user_maton_connections_owner_app
  ON user_maton_connections (owner_email, app, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_maton_connections_selected_app
  ON user_maton_connections (owner_email, app)
  WHERE is_selected;
