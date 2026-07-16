CREATE TABLE IF NOT EXISTS agent_context_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('operator', 'shared')),
  operator_id text REFERENCES app_users(email) ON DELETE CASCADE,
  identity_key text GENERATED ALWAYS AS (COALESCE(operator_id, 'shared')) STORED,
  content text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'archived')),
  source text NOT NULL DEFAULT 'agent_learning' CHECK (source IN ('seeded', 'agent_learning', 'admin')),
  evidence_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_context_memories_scope_owner CHECK (
    (scope = 'operator' AND operator_id IS NOT NULL)
    OR (scope = 'shared' AND operator_id IS NULL)
  ),
  CONSTRAINT agent_context_memories_content_present CHECK (length(btrim(content)) > 0),
  CONSTRAINT agent_context_memories_hash_format CHECK (
    char_length(content_hash) = 64
    AND content_hash ~ '^[0-9a-f]+$'
  ),
  CONSTRAINT agent_context_memories_evidence_positive CHECK (evidence_count > 0),
  UNIQUE (agent_id, scope, identity_key, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_agent_context_memories_prompt
  ON agent_context_memories (agent_id, scope, operator_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_context_memory_evidence (
  memory_id uuid NOT NULL REFERENCES agent_context_memories(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  operator_id text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, organization_id)
);

INSERT INTO agent_context_memories (
  agent_id, scope, operator_id, content, content_hash, status, source, evidence_count
)
VALUES
  (
    'projects', 'shared', NULL,
    'Sequence work from explicit acceptance criteria and preserve one concrete next action.',
    encode(digest(lower('Sequence work from explicit acceptance criteria and preserve one concrete next action.'), 'sha256'), 'hex'),
    'active', 'seeded', 1
  ),
  (
    'pipeline', 'shared', NULL,
    'Treat CRM as the authority for account and contact identity, and Sheets as the writable opportunity operator surface.',
    encode(digest(lower('Treat CRM as the authority for account and contact identity, and Sheets as the writable opportunity operator surface.'), 'sha256'), 'hex'),
    'active', 'seeded', 1
  ),
  (
    'docs', 'shared', NULL,
    'Connect durable notes through Maps of Content, stable IDs, summaries, and links instead of leaving isolated files.',
    encode(digest(lower('Connect durable notes through Maps of Content, stable IDs, summaries, and links instead of leaving isolated files.'), 'sha256'), 'hex'),
    'active', 'seeded', 1
  ),
  (
    'calendar', 'shared', NULL,
    'Confirm organizer identity, timezone, attendees, and CRM relationships before scheduling or changing a meeting.',
    encode(digest(lower('Confirm organizer identity, timezone, attendees, and CRM relationships before scheduling or changing a meeting.'), 'sha256'), 'hex'),
    'active', 'seeded', 1
  ),
  (
    'clawpilot', 'shared', NULL,
    'Keep user and organization data tenant-scoped, and coordinate work through explicit evidence, blockers, and next actions.',
    encode(digest(lower('Keep user and organization data tenant-scoped, and coordinate work through explicit evidence, blockers, and next actions.'), 'sha256'), 'hex'),
    'active', 'seeded', 1
  )
ON CONFLICT (agent_id, scope, identity_key, content_hash) DO NOTHING;
