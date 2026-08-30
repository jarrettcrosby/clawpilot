CREATE TABLE career_site_linkedin_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_app text NOT NULL,
  owner_email text NOT NULL,
  workspace_organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN (
      'disconnected', 'authenticating', 'connected', 'reauth_required',
      'restricted', 'error'
    )),
  linkedin_member_name text,
  linkedin_profile_url text,
  session_ciphertext bytea,
  session_iv bytea,
  session_tag bytea,
  session_key_id text,
  session_encryption_version integer,
  session_fingerprint text,
  session_generation integer NOT NULL DEFAULT 0 CHECK (session_generation >= 0),
  session_expires_at timestamptz,
  last_authenticated_at timestamptz,
  last_scanned_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_linkedin_connections_owner_membership_fkey
    FOREIGN KEY (owner_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT career_site_linkedin_connections_source_valid CHECK (
    source_app = 'jarrett-career-agents'
  ),
  CONSTRAINT career_site_linkedin_connections_owner_normalized CHECK (
    owner_email = lower(btrim(owner_email))
    AND char_length(owner_email) BETWEEN 3 AND 254
    AND owner_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT career_site_linkedin_connections_member_valid CHECK (
    linkedin_member_name IS NULL
    OR char_length(linkedin_member_name) BETWEEN 1 AND 200
  ),
  CONSTRAINT career_site_linkedin_connections_profile_url_valid CHECK (
    linkedin_profile_url IS NULL
    OR (
      char_length(linkedin_profile_url) <= 2048
      AND linkedin_profile_url ~ '^https://([a-z0-9-]+\.)?linkedin[.]com/in/[A-Za-z0-9%._~!$&''()*+,;=:@/-]+$'
    )
  ),
  CONSTRAINT career_site_linkedin_connections_session_encryption_valid CHECK (
    (
      session_ciphertext IS NOT NULL
      AND octet_length(session_ciphertext) BETWEEN 2 AND 4194304
      AND session_iv IS NOT NULL AND octet_length(session_iv) = 12
      AND session_tag IS NOT NULL AND octet_length(session_tag) = 16
      AND session_key_id IS NOT NULL
      AND session_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND session_encryption_version = 1
      AND session_fingerprint ~ '^[0-9a-f]{64}$'
      AND session_generation > 0
    ) OR (
      session_ciphertext IS NULL
      AND session_iv IS NULL
      AND session_tag IS NULL
      AND session_key_id IS NULL
      AND session_encryption_version IS NULL
      AND session_fingerprint IS NULL
      AND session_expires_at IS NULL
    )
  ),
  CONSTRAINT career_site_linkedin_connections_status_session_valid CHECK (
    (status = 'connected' AND session_ciphertext IS NOT NULL)
    OR status <> 'connected'
  ),
  CONSTRAINT career_site_linkedin_connections_error_valid CHECK (
    (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
    AND (last_error_message IS NULL OR char_length(last_error_message) <= 1000)
  ),
  UNIQUE (source_app, owner_email, workspace_organization_id)
);

CREATE TABLE career_site_linkedin_auth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES career_site_linkedin_connections(id) ON DELETE CASCADE,
  source_app text NOT NULL,
  owner_email text NOT NULL,
  workspace_organization_id uuid NOT NULL,
  return_url text NOT NULL,
  auth_token_digest text NOT NULL,
  auth_token_redeemed_at timestamptz,
  auth_token_redeemed_lease_digest text,
  auth_token_redeemed_worker_id text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'claimed', 'awaiting_user', 'succeeded', 'failed', 'expired', 'cancelled'
    )),
  prompt_kind text NOT NULL DEFAULT 'none'
    CHECK (prompt_kind IN ('login', 'mfa', 'checkpoint', 'none')),
  prompt_message text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  lock_token text,
  worker_id text,
  expires_at timestamptz NOT NULL,
  processed_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_report_body_digest text,
  last_report_lease_digest text,
  last_report_worker_id text,
  last_report_status text,
  last_report_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_linkedin_auth_attempts_owner_membership_fkey
    FOREIGN KEY (owner_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT career_site_linkedin_auth_attempts_identity_valid CHECK (
    source_app = 'jarrett-career-agents'
    AND owner_email = lower(btrim(owner_email))
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_return_url_valid CHECK (
    char_length(return_url) BETWEEN 10 AND 2048
    AND return_url ~ '^https://'
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_token_valid CHECK (
    auth_token_digest ~ '^[0-9a-f]{64}$'
    AND (
      (
        auth_token_redeemed_at IS NULL
        AND auth_token_redeemed_lease_digest IS NULL
        AND auth_token_redeemed_worker_id IS NULL
      ) OR (
        auth_token_redeemed_at IS NOT NULL
        AND auth_token_redeemed_at <= updated_at
        AND auth_token_redeemed_lease_digest ~ '^[0-9a-f]{64}$'
        AND auth_token_redeemed_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      )
    )
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_prompt_valid CHECK (
    prompt_message IS NULL OR char_length(prompt_message) <= 500
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_lock_valid CHECK (
    (
      status IN ('claimed', 'awaiting_user')
      AND locked_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > locked_at
      AND lock_token ~ '^[0-9a-f-]{36}$'
      AND worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ) OR (
      status NOT IN ('claimed', 'awaiting_user')
      AND locked_at IS NULL
      AND lease_expires_at IS NULL
      AND lock_token IS NULL
      AND worker_id IS NULL
    )
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_terminal_valid CHECK (
    (
      status IN ('succeeded', 'failed', 'expired', 'cancelled')
      AND processed_at IS NOT NULL
    ) OR (
      status NOT IN ('succeeded', 'failed', 'expired', 'cancelled')
      AND processed_at IS NULL
    )
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_error_valid CHECK (
    (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
    AND (last_error_message IS NULL OR char_length(last_error_message) <= 1000)
  ),
  CONSTRAINT career_site_linkedin_auth_attempts_report_receipt_valid CHECK (
    (
      last_report_body_digest IS NULL
      AND last_report_lease_digest IS NULL
      AND last_report_worker_id IS NULL
      AND last_report_status IS NULL
      AND last_report_at IS NULL
    ) OR (
      last_report_body_digest ~ '^[0-9a-f]{64}$'
      AND last_report_lease_digest ~ '^[0-9a-f]{64}$'
      AND last_report_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND last_report_status IN ('awaiting_auth', 'running', 'succeeded', 'failed', 'restricted')
      AND last_report_at IS NOT NULL
      AND last_report_at <= updated_at
    )
  ),
  UNIQUE (source_app, owner_email, request_id),
  UNIQUE (auth_token_digest)
);

CREATE UNIQUE INDEX idx_career_site_linkedin_auth_active
  ON career_site_linkedin_auth_attempts (connection_id)
  WHERE status IN ('queued', 'claimed', 'awaiting_user');

CREATE INDEX idx_career_site_linkedin_auth_claim
  ON career_site_linkedin_auth_attempts (status, available_at, created_at, id)
  WHERE status IN ('queued', 'claimed', 'awaiting_user');

CREATE TABLE career_site_linkedin_scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES career_site_linkedin_connections(id) ON DELETE CASCADE,
  auth_attempt_id uuid REFERENCES career_site_linkedin_auth_attempts(id) ON DELETE SET NULL,
  source_app text NOT NULL,
  owner_email text NOT NULL,
  workspace_organization_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope = 'jobs'),
  maximum integer NOT NULL CHECK (maximum BETWEEN 1 AND 50),
  filters jsonb NOT NULL,
  filters_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'claimed', 'awaiting_auth', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count BETWEEN 0 AND 50),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  lock_token text,
  worker_id text,
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_report_body_digest text,
  last_report_lease_digest text,
  last_report_worker_id text,
  last_report_status text,
  last_report_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT career_site_linkedin_scan_runs_owner_membership_fkey
    FOREIGN KEY (owner_email, workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT career_site_linkedin_scan_runs_identity_valid CHECK (
    source_app = 'jarrett-career-agents'
    AND owner_email = lower(btrim(owner_email))
  ),
  CONSTRAINT career_site_linkedin_scan_runs_filters_valid CHECK (
    jsonb_typeof(filters) = 'object'
    AND octet_length(filters::text) <= 8192
    AND filters_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT career_site_linkedin_scan_runs_results_valid CHECK (
    jsonb_typeof(results) = 'array'
    AND jsonb_array_length(results) <= 50
    AND octet_length(results::text) <= 2097152
    AND jsonb_array_length(results) = result_count
    AND ((status = 'succeeded') OR result_count = 0)
  ),
  CONSTRAINT career_site_linkedin_scan_runs_lock_valid CHECK (
    (
      status = 'claimed'
      AND locked_at IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > locked_at
      AND lock_token ~ '^[0-9a-f-]{36}$'
      AND worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ) OR (
      status <> 'claimed'
      AND locked_at IS NULL
      AND lease_expires_at IS NULL
      AND lock_token IS NULL
      AND worker_id IS NULL
    )
  ),
  CONSTRAINT career_site_linkedin_scan_runs_terminal_valid CHECK (
    (
      status IN ('succeeded', 'failed', 'cancelled')
      AND completed_at IS NOT NULL
    ) OR (
      status NOT IN ('succeeded', 'failed', 'cancelled')
      AND completed_at IS NULL
    )
  ),
  CONSTRAINT career_site_linkedin_scan_runs_error_valid CHECK (
    (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
    AND (last_error_message IS NULL OR char_length(last_error_message) <= 1000)
  ),
  CONSTRAINT career_site_linkedin_scan_runs_report_receipt_valid CHECK (
    (
      last_report_body_digest IS NULL
      AND last_report_lease_digest IS NULL
      AND last_report_worker_id IS NULL
      AND last_report_status IS NULL
      AND last_report_at IS NULL
    ) OR (
      last_report_body_digest ~ '^[0-9a-f]{64}$'
      AND last_report_lease_digest ~ '^[0-9a-f]{64}$'
      AND last_report_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND last_report_status IN ('awaiting_auth', 'running', 'succeeded', 'failed', 'restricted')
      AND last_report_at IS NOT NULL
      AND last_report_at <= updated_at
    )
  ),
  UNIQUE (source_app, owner_email, request_id)
);

CREATE INDEX idx_career_site_linkedin_scan_claim
  ON career_site_linkedin_scan_runs (status, available_at, created_at, id)
  WHERE status IN ('queued', 'claimed');

CREATE UNIQUE INDEX idx_career_site_linkedin_scan_active
  ON career_site_linkedin_scan_runs (connection_id)
  WHERE status IN ('queued', 'claimed', 'awaiting_auth');

CREATE INDEX idx_career_site_linkedin_scan_owner_created
  ON career_site_linkedin_scan_runs (
    workspace_organization_id, owner_email, created_at DESC, id DESC
  );

CREATE TABLE career_site_linkedin_worker_nonces (
  worker_id text NOT NULL,
  nonce uuid NOT NULL,
  request_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, nonce),
  CONSTRAINT career_site_linkedin_worker_nonces_worker_valid CHECK (
    worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT career_site_linkedin_worker_nonces_expiry_valid CHECK (
    expires_at > request_timestamp
  )
);

CREATE INDEX idx_career_site_linkedin_worker_nonces_expiry
  ON career_site_linkedin_worker_nonces (expires_at);
