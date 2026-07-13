ALTER TABLE app_user_invitations
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES app_user_invitations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_invitations_supersedes
  ON app_user_invitations (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
