ALTER TABLE pos_accounting_profiles
  ALTER COLUMN email_notifications_enabled SET DEFAULT true,
  ALTER COLUMN email_notifications_enabled_at SET DEFAULT now();

-- Do not rewrite existing false/null preferences. Before this migration that
-- shape was both the product default and the persisted representation of an
-- explicit opt-out, so there is no safe way to distinguish every legacy case.
-- Keeping those rows unchanged prevents a deployment from silently restoring
-- email that an accounting administrator disabled. New profiles that omit the
-- preference receive true/now; application saves continue to write an explicit
-- false/null pair when an administrator turns alerts off.
