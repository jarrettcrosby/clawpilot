ALTER TABLE organization_quickbooks_connections
  ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS write_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS write_verified_by text REFERENCES app_users(email) ON DELETE SET NULL;

ALTER TABLE organization_quickbooks_connections
  DROP CONSTRAINT IF EXISTS organization_quickbooks_connections_write_mode_check;

ALTER TABLE organization_quickbooks_connections
  ADD CONSTRAINT organization_quickbooks_connections_write_mode_check
  CHECK (
    write_mode = 'disabled'
    OR (
      write_mode IN ('sandbox', 'production')
      AND write_verified_at IS NOT NULL
      AND write_verified_by IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS quickbooks_write_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  operation_kind text NOT NULL CHECK (operation_kind IN ('customer.create', 'item.create', 'invoice.create')),
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'processing', 'succeeded', 'failed', 'dead', 'cancelled')
  ),
  client_request_id uuid NOT NULL,
  provider_request_id text NOT NULL,
  request_payload jsonb NOT NULL,
  request_fingerprint text NOT NULL,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_entity_type text,
  provider_entity_id text,
  provider_sync_token text,
  requested_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  submitted_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approved_by text REFERENCES app_users(email) ON DELETE SET NULL,
  cancelled_by text REFERENCES app_users(email) ON DELETE SET NULL,
  approval_note text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_at timestamptz,
  posted_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, client_request_id),
  UNIQUE (organization_id, provider_request_id),
  CONSTRAINT quickbooks_write_request_fingerprint_valid CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT quickbooks_write_provider_request_id_valid CHECK (
    provider_request_id = btrim(provider_request_id)
    AND char_length(provider_request_id) BETWEEN 1 AND 50
    AND provider_request_id ~ '^[A-Za-z0-9._-]+$'
  ),
  CONSTRAINT quickbooks_write_attempts_valid CHECK (
    attempt_count >= 0 AND attempt_count <= max_attempts AND max_attempts BETWEEN 1 AND 10
  ),
  CONSTRAINT quickbooks_write_payload_object CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT quickbooks_write_result_object CHECK (jsonb_typeof(result_payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_write_requests_due
  ON quickbooks_write_requests (available_at, created_at)
  WHERE status IN ('approved', 'failed');

CREATE INDEX IF NOT EXISTS idx_quickbooks_write_requests_workspace
  ON quickbooks_write_requests (organization_id, created_at DESC, id DESC);
