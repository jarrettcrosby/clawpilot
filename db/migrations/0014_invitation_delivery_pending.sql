ALTER TABLE app_user_invitations
  ADD COLUMN IF NOT EXISTS delivery_pending_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_invitations_one_delivery_pending
  ON app_user_invitations (email)
  WHERE delivery_pending_at IS NOT NULL;
