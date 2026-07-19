ALTER TABLE quickbooks_write_requests
  ADD COLUMN IF NOT EXISTS reviewed_maton_connection_id text;

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
  );

CREATE INDEX IF NOT EXISTS idx_quickbooks_write_requests_reviewed_connection
  ON quickbooks_write_requests (organization_id, reviewed_maton_connection_id, available_at, created_at)
  WHERE status IN ('approved', 'failed', 'processing');
