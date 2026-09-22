CREATE TABLE workspace_organization_web_preferences (
  organization_id uuid PRIMARY KEY REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  app_domain text NOT NULL DEFAULT 'bpo' CHECK (app_domain IN ('bpo', 'eigenracing')),
  short_link_domain text NOT NULL DEFAULT 'bpo' CHECK (short_link_domain IN ('bpo', 'eigenracing')),
  allow_user_short_link_override boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text NOT NULL REFERENCES app_users(email),
  updated_at timestamptz NOT NULL DEFAULT now()
);
