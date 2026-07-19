ALTER TABLE workspace_organizations
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_organizations_one_demo
  ON workspace_organizations ((is_demo))
  WHERE is_demo;

UPDATE app_user_organization_memberships
SET permissions = permissions || '{"accessDemo":true}'::jsonb,
    updated_at = now()
WHERE role = 'owner'
  AND COALESCE((permissions ->> 'accessDemo')::boolean, false) = false;
