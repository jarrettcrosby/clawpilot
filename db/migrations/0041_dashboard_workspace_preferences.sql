CREATE TABLE IF NOT EXISTS app_user_workspace_preferences (
  user_email text PRIMARY KEY REFERENCES app_users(email) ON DELETE CASCADE,
  default_board_id uuid REFERENCES project_boards(id) ON DELETE SET NULL,
  default_pipeline_id uuid REFERENCES pipeline_spaces(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_user_workspace_preferences_board
  ON app_user_workspace_preferences (default_board_id)
  WHERE default_board_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_workspace_preferences_pipeline
  ON app_user_workspace_preferences (default_pipeline_id)
  WHERE default_pipeline_id IS NOT NULL;
