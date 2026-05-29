CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_objects (
  object_type text NOT NULL,
  object_id text NOT NULL,
  payload jsonb NOT NULL,
  source text NOT NULL DEFAULT 'app',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('backlog', 'todo', 'in-progress', 'review', 'done')),
  priority text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  category text NOT NULL DEFAULT 'clawpilot',
  assigned_agent text,
  due_date date,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  deleted_at timestamptz,
  payload jsonb NOT NULL,
  payload_hash text,
  source text NOT NULL DEFAULT 'app',
  inserted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks (assigned_agent) WHERE assigned_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks (category);
CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks (archived);
CREATE INDEX IF NOT EXISTS idx_tasks_payload_gin ON tasks USING gin (payload);

CREATE TABLE IF NOT EXISTS task_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text REFERENCES tasks(id) ON DELETE CASCADE,
  activity_type text NOT NULL,
  actor text,
  message text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_task_activity_task_time ON task_activity (task_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS task_comments (
  id text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (task_id, id)
);

CREATE TABLE IF NOT EXISTS task_checklist_items (
  id text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  assignee text,
  agent_id text,
  due_date date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (task_id, id)
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id text PRIMARY KEY,
  agent_id text NOT NULL,
  task_id text,
  status text NOT NULL DEFAULT 'active',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  routing jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  context_snapshot jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_message_at timestamptz,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_agent ON agent_threads (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_threads_task ON agent_threads (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_threads_status ON agent_threads (status);

CREATE TABLE IF NOT EXISTS agent_thread_messages (
  id text NOT NULL,
  thread_id text NOT NULL REFERENCES agent_threads(thread_id) ON DELETE CASCADE,
  role text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'committed',
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (thread_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_time ON agent_thread_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_assignments (
  task_id text PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text,
  agent_id text,
  status text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_runs_task_time ON execution_runs (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text,
  agent_id text,
  result_type text NOT NULL DEFAULT 'execution-result',
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execution_results_task_time ON execution_results (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_sheet_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  sheet_id text NOT NULL,
  tab_name text NOT NULL,
  role text NOT NULL,
  owning_system text NOT NULL DEFAULT 'google_sheets',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, tab_name)
);

CREATE TABLE IF NOT EXISTS pipeline_sheet_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id text NOT NULL,
  tab_name text NOT NULL,
  row_number integer NOT NULL,
  external_id text,
  object_type text NOT NULL,
  title text,
  payload jsonb NOT NULL,
  sheet_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  sheet_hash text,
  last_synced_at timestamptz,
  last_sheet_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sheet_id, tab_name, row_number)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_sheet_rows_external ON pipeline_sheet_rows (external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_sheet_rows_object ON pipeline_sheet_rows (object_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_sheet_rows_payload ON pipeline_sheet_rows USING gin (payload);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  source_system text NOT NULL,
  target_system text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs (status, queued_at);

CREATE TABLE IF NOT EXISTS sync_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  operation text NOT NULL,
  target_system text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_status ON sync_outbox (status, available_at);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_aggregate ON sync_outbox (aggregate_type, aggregate_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text,
  event_type text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_aggregate ON audit_events (aggregate_type, aggregate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_time ON audit_events (event_type, created_at DESC);

