ALTER TABLE quickbooks_write_requests
  ADD COLUMN IF NOT EXISTS reviewed_maton_connection_id text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM quickbooks_write_requests
    WHERE reviewed_maton_connection_id IS NULL AND status = 'processing'
  ) THEN
    RAISE EXCEPTION 'Cannot bind QuickBooks write requests while a legacy write is processing';
  END IF;
END;
$$;

UPDATE quickbooks_write_requests
SET status = 'cancelled',
    cancelled_at = COALESCE(cancelled_at, now()),
    locked_at = NULL,
    locked_by = NULL,
    lock_token = NULL,
    last_error_code = 'QUICKBOOKS_WRITE_BINDING_MIGRATION_REQUIRED',
    last_error_message = 'Accounting change cancelled because its reviewed QuickBooks connection was not recorded.',
    updated_at = now()
WHERE reviewed_maton_connection_id IS NULL
  AND status IN ('draft', 'pending_approval', 'approved', 'failed', 'dead');

ALTER TABLE quickbooks_write_requests
  DROP CONSTRAINT IF EXISTS quickbooks_write_reviewed_connection_valid,
  DROP CONSTRAINT IF EXISTS quickbooks_write_reviewed_connection_required;

ALTER TABLE quickbooks_write_requests
  ADD CONSTRAINT quickbooks_write_reviewed_connection_valid CHECK (
    reviewed_maton_connection_id IS NULL
    OR (
      reviewed_maton_connection_id = btrim(reviewed_maton_connection_id)
      AND char_length(reviewed_maton_connection_id) BETWEEN 1 AND 512
      AND reviewed_maton_connection_id ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT quickbooks_write_reviewed_connection_required CHECK (
    reviewed_maton_connection_id IS NOT NULL OR status IN ('succeeded', 'cancelled')
  );

CREATE INDEX IF NOT EXISTS idx_quickbooks_write_requests_reviewed_connection
  ON quickbooks_write_requests (organization_id, reviewed_maton_connection_id, available_at, created_at)
  WHERE status IN ('approved', 'failed', 'processing');
