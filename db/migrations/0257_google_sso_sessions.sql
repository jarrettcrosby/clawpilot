ALTER TABLE app_sessions
  DROP CONSTRAINT IF EXISTS app_sessions_auth_method_check;

ALTER TABLE app_sessions
  ADD CONSTRAINT app_sessions_auth_method_check
  CHECK (auth_method IN (
    'magic_code',
    'google_sso',
    'operator_password',
    'legacy_upgrade',
    'demo'
  ));
