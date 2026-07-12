ALTER TABLE sync_outbox
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS lock_token text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_idempotency
  ON sync_outbox (target_system, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_due
  ON sync_outbox (target_system, status, available_at, created_at)
  WHERE status IN ('queued', 'failed', 'processing');
