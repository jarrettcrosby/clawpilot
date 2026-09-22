ALTER TABLE app_user_workspace_preferences
  ADD COLUMN short_link_default_domain text;

ALTER TABLE app_user_workspace_preferences
  ADD CONSTRAINT app_user_workspace_preferences_short_link_default_domain_allowed
  CHECK (
    short_link_default_domain IS NULL
    OR short_link_default_domain IN ('eigenracing', 'bpo')
  );
