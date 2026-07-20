CREATE TABLE IF NOT EXISTS pos_accounting_issue_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  restaurant_guid uuid NOT NULL,
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  issue_fingerprint text NOT NULL CHECK (issue_fingerprint ~ '^[0-9a-f]{64}$'),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  occurrence integer NOT NULL DEFAULT 1 CHECK (occurrence > 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_notified_at timestamptz,
  notification_count integer NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, restaurant_guid)
    REFERENCES toast_locations (organization_id, restaurant_guid) ON DELETE CASCADE,
  CONSTRAINT pos_accounting_issue_resolution_valid CHECK (
    (status = 'open' AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT pos_accounting_issue_scope_unique UNIQUE (
    organization_id, restaurant_guid, business_date
  )
);

CREATE INDEX IF NOT EXISTS idx_pos_accounting_issue_states_open
  ON pos_accounting_issue_states (organization_id, last_seen_at, id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS pos_accounting_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_state_id uuid NOT NULL REFERENCES pos_accounting_issue_states(id) ON DELETE CASCADE,
  occurrence integer NOT NULL CHECK (occurrence > 0),
  issue_fingerprint text NOT NULL CHECK (issue_fingerprint ~ '^[0-9a-f]{64}$'),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  recipient_email text NOT NULL CHECK (
    recipient_email = lower(recipient_email)
    AND char_length(recipient_email) BETWEEN 3 AND 254
    AND recipient_email !~ '[[:cntrl:]]'
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'failed', 'succeeded', 'dead', 'cancelled')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text CHECK (locked_by IS NULL OR char_length(locked_by) BETWEEN 1 AND 200),
  lock_token uuid,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_accounting_notification_delivery_unique UNIQUE (
    issue_state_id, occurrence, recipient_email
  ),
  CONSTRAINT pos_accounting_notification_lease_valid CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL AND lock_token IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL AND lock_token IS NULL)
  ),
  CONSTRAINT pos_accounting_notification_result_valid CHECK (
    (status = 'succeeded' AND sent_at IS NOT NULL)
    OR (status <> 'succeeded' AND sent_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pos_accounting_notification_outbox_claim
  ON pos_accounting_notification_outbox (available_at, created_at, id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_pos_accounting_notification_outbox_issue
  ON pos_accounting_notification_outbox (issue_state_id, occurrence, status, created_at);
