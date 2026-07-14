CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE app_documents
  ADD COLUMN IF NOT EXISTS embedding vector(256),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS embedding_content_hash text,
  ADD COLUMN IF NOT EXISTS embedded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_app_documents_embedding_hnsw
  ON app_documents USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_embedding_jobs (
  document_id uuid PRIMARY KEY REFERENCES app_documents(id) ON DELETE CASCADE,
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_embedding_jobs_owner_normalized CHECK (owner_email = lower(owner_email)),
  CONSTRAINT document_embedding_jobs_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT document_embedding_jobs_hash_format CHECK (
    char_length(content_hash) = 64 AND content_hash ~ '^[0-9a-f]+$'
  )
);

CREATE INDEX IF NOT EXISTS idx_document_embedding_jobs_claim
  ON document_embedding_jobs (status, available_at, updated_at)
  WHERE status IN ('pending', 'failed');

INSERT INTO document_embedding_jobs (document_id, owner_email, content_hash)
SELECT id, owner_email, content_hash
FROM app_documents
WHERE embedding_content_hash IS DISTINCT FROM content_hash
ON CONFLICT (document_id) DO UPDATE SET
  owner_email = EXCLUDED.owner_email,
  content_hash = EXCLUDED.content_hash,
  status = 'pending',
  available_at = now(),
  locked_at = NULL,
  last_error = NULL,
  updated_at = now();

CREATE TABLE IF NOT EXISTS ai_radar_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  source_name text NOT NULL,
  source_url text NOT NULL,
  item_url text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'AI',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  published_at timestamptz NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_radar_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT ai_radar_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT ai_radar_source_url_valid CHECK (source_url ~ '^https://'),
  CONSTRAINT ai_radar_item_url_valid CHECK (item_url ~ '^https://')
);

CREATE INDEX IF NOT EXISTS idx_ai_radar_items_published
  ON ai_radar_items (published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ai_radar_items_tags
  ON ai_radar_items USING gin (tags);

CREATE TABLE IF NOT EXISTS knowledge_worker_heartbeat (
  worker_name text PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  phase text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
