CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_single_sync_source
  ON pipeline_spaces ((sync_enabled))
  WHERE sync_enabled;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_permissions_object
  CHECK (jsonb_typeof(permissions) = 'object');
