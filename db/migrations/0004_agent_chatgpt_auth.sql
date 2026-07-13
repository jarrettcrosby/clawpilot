CREATE TABLE IF NOT EXISTS agent_chatgpt_pending_logins (
  operator_id text NOT NULL,
  provider text NOT NULL,
  login_id uuid NOT NULL,
  verification_url text NOT NULL,
  device_auth_id_ciphertext bytea NOT NULL,
  device_auth_id_iv bytea NOT NULL,
  device_auth_id_tag bytea NOT NULL,
  user_code_ciphertext bytea NOT NULL,
  user_code_iv bytea NOT NULL,
  user_code_tag bytea NOT NULL,
  poll_interval_seconds integer NOT NULL,
  last_polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, provider),
  UNIQUE (login_id),
  CONSTRAINT agent_chatgpt_pending_operator_valid CHECK (
    operator_id = btrim(operator_id)
    AND char_length(operator_id) BETWEEN 1 AND 512
  ),
  CONSTRAINT agent_chatgpt_pending_provider_valid CHECK (
    provider = btrim(provider)
    AND char_length(provider) BETWEEN 1 AND 128
  ),
  CONSTRAINT agent_chatgpt_pending_verification_url_valid CHECK (
    verification_url = 'https://auth.openai.com/codex/device'
  ),
  CONSTRAINT agent_chatgpt_pending_device_cipher_valid CHECK (
    octet_length(device_auth_id_ciphertext) > 0
    AND octet_length(device_auth_id_iv) = 12
    AND octet_length(device_auth_id_tag) = 16
  ),
  CONSTRAINT agent_chatgpt_pending_user_code_cipher_valid CHECK (
    octet_length(user_code_ciphertext) > 0
    AND octet_length(user_code_iv) = 12
    AND octet_length(user_code_tag) = 16
  ),
  CONSTRAINT agent_chatgpt_pending_poll_interval_valid CHECK (
    poll_interval_seconds BETWEEN 1 AND 60
  ),
  CONSTRAINT agent_chatgpt_pending_expiry_valid CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_agent_chatgpt_pending_expiry
  ON agent_chatgpt_pending_logins (expires_at);

CREATE TABLE IF NOT EXISTS agent_chatgpt_credentials (
  operator_id text NOT NULL,
  provider text NOT NULL,
  access_token_ciphertext bytea NOT NULL,
  access_token_iv bytea NOT NULL,
  access_token_tag bytea NOT NULL,
  refresh_token_ciphertext bytea NOT NULL,
  refresh_token_iv bytea NOT NULL,
  refresh_token_tag bytea NOT NULL,
  account_id text,
  account_email text,
  plan_type text,
  expires_at timestamptz NOT NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, provider),
  CONSTRAINT agent_chatgpt_credentials_operator_valid CHECK (
    operator_id = btrim(operator_id)
    AND char_length(operator_id) BETWEEN 1 AND 512
  ),
  CONSTRAINT agent_chatgpt_credentials_provider_valid CHECK (
    provider = btrim(provider)
    AND char_length(provider) BETWEEN 1 AND 128
  ),
  CONSTRAINT agent_chatgpt_credentials_access_cipher_valid CHECK (
    octet_length(access_token_ciphertext) > 0
    AND octet_length(access_token_iv) = 12
    AND octet_length(access_token_tag) = 16
  ),
  CONSTRAINT agent_chatgpt_credentials_refresh_cipher_valid CHECK (
    octet_length(refresh_token_ciphertext) > 0
    AND octet_length(refresh_token_iv) = 12
    AND octet_length(refresh_token_tag) = 16
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_chatgpt_credentials_expiry
  ON agent_chatgpt_credentials (expires_at);
