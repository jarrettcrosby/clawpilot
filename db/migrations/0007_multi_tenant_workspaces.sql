ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_role_check;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_role_check CHECK (role IN ('owner', 'admin', 'member'));

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{"inviteUsers":false,"manageUserAccess":false,"createBoards":true,"createPipelines":true}'::jsonb;

CREATE TABLE IF NOT EXISTS project_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_boards_name_present CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_default_owner
  ON project_boards (owner_email)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_project_boards_owner_updated
  ON project_boards (owner_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_board_members (
  board_id uuid NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  access_role text NOT NULL DEFAULT 'viewer' CHECK (access_role IN ('viewer', 'editor')),
  shared_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_project_board_members_user
  ON project_board_members (user_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  is_default boolean NOT NULL DEFAULT false,
  sheet_id text,
  sync_enabled boolean NOT NULL DEFAULT false,
  projection jsonb NOT NULL DEFAULT '{"syncedAt":null,"source":"app","summary":{"opportunities":0,"organizations":0,"contacts":0,"totalOpenValue":0},"opportunities":[]}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_spaces_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT pipeline_spaces_sync_source CHECK (NOT sync_enabled OR sheet_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_default_owner
  ON pipeline_spaces (owner_email)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_pipeline_spaces_owner_updated
  ON pipeline_spaces (owner_email, updated_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_space_members (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  access_role text NOT NULL DEFAULT 'viewer' CHECK (access_role IN ('viewer', 'editor')),
  shared_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_space_members_user
  ON pipeline_space_members (user_email, updated_at DESC);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES project_boards(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_board_updated
  ON tasks (board_id, updated_at DESC, id);
