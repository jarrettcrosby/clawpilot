-- Track all organizations associated with each pending invitation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE app_user_invitations
  ADD COLUMN IF NOT EXISTS workspace_organization_ids uuid[] DEFAULT ARRAY[]::uuid[];

UPDATE app_user_invitations
SET workspace_organization_ids = ARRAY[workspace_organization_id]
WHERE COALESCE(cardinality(workspace_organization_ids), 0) = 0
  AND workspace_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_invitations_workspace_organization_ids
  ON app_user_invitations USING GIN (workspace_organization_ids);
