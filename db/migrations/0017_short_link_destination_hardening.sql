ALTER TABLE short_links
  DROP CONSTRAINT IF EXISTS short_links_destination_valid;

ALTER TABLE short_links
  ADD CONSTRAINT short_links_destination_valid CHECK (
    char_length(destination_url) BETWEEN 8 AND 4096
    AND destination_url ~ '^https://'
  );

CREATE INDEX IF NOT EXISTS idx_document_embedding_jobs_stale_processing
  ON document_embedding_jobs (locked_at, updated_at)
  WHERE status = 'processing';
