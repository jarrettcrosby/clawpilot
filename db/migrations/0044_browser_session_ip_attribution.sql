ALTER TABLE app_sessions
  ADD COLUMN IF NOT EXISTS initial_ip_address inet,
  ADD COLUMN IF NOT EXISTS last_ip_address inet;

COMMENT ON COLUMN app_sessions.initial_ip_address IS
  'Validated client address reported by the hosting edge when the browser session was created.';
COMMENT ON COLUMN app_sessions.last_ip_address IS
  'Validated client address reported by the hosting edge on the latest verified user activity.';
