ALTER TABLE toast_sync_outbox
  ADD COLUMN IF NOT EXISTS rerun_requested_at timestamptz;
