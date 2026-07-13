CREATE TABLE IF NOT EXISTS app_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  source_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('system', 'repository', 'user', 'agent')),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded', 'historical', 'generated')),
  title text NOT NULL,
  slug text NOT NULL,
  category text NOT NULL,
  content text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_path text,
  content_hash text NOT NULL,
  board_id uuid REFERENCES project_boards(id) ON DELETE SET NULL,
  pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE SET NULL,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(content, '')), 'C')
  ) STORED,
  CONSTRAINT app_documents_owner_normalized CHECK (owner_email = lower(owner_email)),
  CONSTRAINT app_documents_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT app_documents_slug_present CHECK (length(btrim(slug)) > 0),
  CONSTRAINT app_documents_content_hash_format CHECK (
    char_length(content_hash) = 64
    AND content_hash ~ '^[0-9a-f]+$'
  ),
  UNIQUE (owner_email, source_key),
  UNIQUE (owner_email, slug)
);

CREATE INDEX IF NOT EXISTS idx_app_documents_owner_updated
  ON app_documents (owner_email, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_documents_owner_category
  ON app_documents (owner_email, category, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_documents_search
  ON app_documents USING gin (search_vector);

CREATE TABLE IF NOT EXISTS release_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_hash text NOT NULL,
  environment text NOT NULL,
  branch text,
  deployment_id text,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  features text[] NOT NULL DEFAULT ARRAY[]::text[],
  fixes text[] NOT NULL DEFAULT ARRAY[]::text[],
  source text NOT NULL DEFAULT 'deployment' CHECK (source IN ('deployment', 'historical', 'manual')),
  deployed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT release_entries_hash_present CHECK (length(btrim(commit_hash)) >= 7),
  CONSTRAINT release_entries_title_present CHECK (length(btrim(title)) > 0),
  UNIQUE (environment, commit_hash)
);

CREATE INDEX IF NOT EXISTS idx_release_entries_deployed
  ON release_entries (deployed_at DESC, id);

CREATE TABLE IF NOT EXISTS data_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid REFERENCES release_entries(id) ON DELETE SET NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  label text NOT NULL,
  reason text NOT NULL,
  object_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  snapshot jsonb NOT NULL,
  checksum text NOT NULL,
  size_bytes integer NOT NULL,
  provider_backup_status text NOT NULL DEFAULT 'not_verified' CHECK (
    provider_backup_status IN ('not_verified', 'verified', 'failed')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_checkpoints_checksum_format CHECK (
    char_length(checksum) = 64
    AND checksum ~ '^[0-9a-f]+$'
  ),
  CONSTRAINT data_checkpoints_size_nonnegative CHECK (size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_data_checkpoints_created
  ON data_checkpoints (created_at DESC, id);

UPDATE app_users
SET permissions = permissions || '{"viewFullReleaseHistory":false,"manageBackups":false}'::jsonb
WHERE role = 'member';

UPDATE app_users
SET permissions = permissions || '{"viewFullReleaseHistory":true,"manageBackups":true}'::jsonb
WHERE role IN ('owner', 'admin');
