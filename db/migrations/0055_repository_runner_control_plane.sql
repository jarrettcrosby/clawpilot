-- Repository automation is a separate, patch-only execution boundary. The
-- application stores lifecycle state and dispatch intent; GitHub Actions owns
-- the isolated checkout and validation environment.
CREATE TABLE IF NOT EXISTS repository_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
  github_repository_id bigint NOT NULL,
  github_installation_id bigint NOT NULL,
  repository_full_name text NOT NULL,
  base_branch text NOT NULL DEFAULT 'dev',
  workflow_file text NOT NULL DEFAULT 'clawpilot-repository-runner.yml',
  enabled boolean NOT NULL DEFAULT true,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repository_bindings_repository_name_valid CHECK (
    repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  ),
  CONSTRAINT repository_bindings_base_branch_valid CHECK (
    base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
    AND base_branch !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT repository_bindings_workflow_file_valid CHECK (
    workflow_file ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$'
  ),
  CONSTRAINT repository_bindings_board_unique UNIQUE (board_id)
);

CREATE INDEX IF NOT EXISTS idx_repository_bindings_repository
  ON repository_bindings (github_repository_id, enabled, board_id);

CREATE TABLE IF NOT EXISTS repository_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES repository_bindings(id) ON DELETE RESTRICT,
  board_id uuid NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operator_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  agent_id text NOT NULL,
  instruction text NOT NULL,
  base_ref text NOT NULL,
  base_sha text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'dispatching', 'dispatched', 'running',
    'patch_ready', 'policy_rejected', 'failed', 'cancelled'
  )),
  workflow_run_id bigint,
  workflow_url text,
  artifact_url text,
  patch_digest text,
  changed_paths jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text,
  error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repository_runs_agent_present CHECK (length(btrim(agent_id)) > 0),
  CONSTRAINT repository_runs_instruction_present CHECK (
    length(btrim(instruction)) BETWEEN 1 AND 12000
  ),
  CONSTRAINT repository_runs_base_ref_valid CHECK (
    base_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'
    AND base_ref !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT repository_runs_base_sha_valid CHECK (
    base_sha IS NULL OR base_sha ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT repository_runs_patch_digest_valid CHECK (
    patch_digest IS NULL OR patch_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT repository_runs_changed_paths_array CHECK (
    jsonb_typeof(changed_paths) = 'array'
  ),
  CONSTRAINT repository_runs_validation_object CHECK (
    jsonb_typeof(validation_result) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_runs_active_task
  ON repository_runs (board_id, task_id)
  WHERE status IN ('queued', 'dispatching', 'dispatched', 'running');

CREATE INDEX IF NOT EXISTS idx_repository_runs_task_time
  ON repository_runs (board_id, task_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_repository_runs_workflow_run
  ON repository_runs (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;
