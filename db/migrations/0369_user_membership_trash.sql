ALTER TABLE app_user_organization_memberships
  ADD COLUMN IF NOT EXISTS trashed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trashed_by text,
  ADD COLUMN IF NOT EXISTS pre_trash_status text;

ALTER TABLE app_user_organization_memberships
  ADD CONSTRAINT app_membership_trash_state CHECK (
    (trashed_at IS NULL AND trashed_by IS NULL AND pre_trash_status IS NULL)
    OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL AND status = 'disabled'
        AND pre_trash_status IN ('active', 'invited', 'disabled'))
  );

COMMENT ON COLUMN app_user_organization_memberships.trashed_at IS
  'Recoverable organization-scoped removal. Identity, ownership and audit history are retained.';
