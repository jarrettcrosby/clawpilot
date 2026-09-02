-- Durable historical-refresh intent and bounded terminal-session health heads.
--
-- A full-history request must not masquerade a leased continuous poll as the
-- requested historical pass. The policy row is the single account-scoped
-- authority record, so it retains one coalesced follow-up without changing the
-- policy revision that fences the in-flight provider read.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE operations_commerce_order_sync_policies
  ADD COLUMN IF NOT EXISTS historical_refresh_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS historical_refresh_requested_by text
    REFERENCES app_users(email) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS historical_refresh_idempotency_key text;

ALTER TABLE operations_commerce_order_sync_policies
  DROP CONSTRAINT IF EXISTS commerce_order_sync_policy_history_request_valid;

ALTER TABLE operations_commerce_order_sync_policies
  ADD CONSTRAINT commerce_order_sync_policy_history_request_valid CHECK (
    (
      historical_refresh_requested_at IS NULL
      AND historical_refresh_requested_by IS NULL
      AND historical_refresh_idempotency_key IS NULL
    ) OR (
      historical_refresh_requested_at IS NOT NULL
      AND historical_refresh_requested_by IS NOT NULL
      AND historical_refresh_idempotency_key IS NOT NULL
      AND length(btrim(historical_refresh_idempotency_key)) BETWEEN 8 AND 120
      AND historical_refresh_idempotency_key !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX IF NOT EXISTS idx_commerce_order_history_refresh_followups
  ON operations_commerce_order_sync_policies (
    historical_refresh_requested_at,
    organization_id,
    integration_account_id
  )
  WHERE historical_refresh_requested_at IS NOT NULL;

-- Supports DISTINCT ON stream-head health without sorting the full retained
-- session ledger by a session-kind column omitted from the original index.
CREATE INDEX IF NOT EXISTS idx_commerce_order_backfill_stream_head
  ON operations_commerce_order_backfill_sessions (
    organization_id,
    integration_account_id,
    session_kind,
    created_at DESC,
    id DESC
  );

COMMENT ON COLUMN
  operations_commerce_order_sync_policies.historical_refresh_requested_at IS
  'Durable coalesced full-history follow-up retained while a current continuous poll owns the account session slot.';

COMMENT ON INDEX idx_commerce_order_backfill_stream_head IS
  'Latest retained history-session head per organization, account, and session kind for bounded operational health authority checks.';
