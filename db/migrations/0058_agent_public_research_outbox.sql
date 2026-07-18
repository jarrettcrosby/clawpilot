CREATE TABLE IF NOT EXISTS agent_research_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE,
  operator_id text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  board_id uuid NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  agent_id text NOT NULL,
  query text NOT NULL,
  result_text text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider text NOT NULL,
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_research_evidence_agent CHECK (agent_id = 'projects'),
  CONSTRAINT agent_research_evidence_query_present CHECK (length(btrim(query)) > 0),
  CONSTRAINT agent_research_evidence_result_present CHECK (length(btrim(result_text)) > 0),
  CONSTRAINT agent_research_evidence_citations_array CHECK (jsonb_typeof(citations) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_agent_research_evidence_task
  ON agent_research_evidence (operator_id, board_id, task_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_agent_research_due
  ON sync_outbox (status, available_at, created_at)
  WHERE target_system = 'agent_research'
    AND aggregate_type = 'agent_research'
    AND operation = 'web_search'
    AND status IN ('queued', 'failed', 'processing');
