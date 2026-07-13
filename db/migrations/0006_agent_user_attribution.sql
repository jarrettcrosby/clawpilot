ALTER TABLE agent_threads
  ADD COLUMN IF NOT EXISTS operator_id text;

ALTER TABLE agent_thread_messages
  ADD COLUMN IF NOT EXISTS actor_operator_id text;

ALTER TABLE execution_runs
  ADD COLUMN IF NOT EXISTS operator_id text;

ALTER TABLE execution_results
  ADD COLUMN IF NOT EXISTS operator_id text;

CREATE INDEX IF NOT EXISTS idx_agent_threads_operator_updated
  ON agent_threads (operator_id, updated_at DESC, thread_id)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_thread_messages_actor_time
  ON agent_thread_messages (actor_operator_id, created_at DESC)
  WHERE actor_operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_runs_operator_task_time
  ON execution_runs (operator_id, task_id, created_at DESC)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_results_operator_task_time
  ON execution_results (operator_id, task_id, created_at DESC)
  WHERE operator_id IS NOT NULL;
