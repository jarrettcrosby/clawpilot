-- Measurement display preferences are presentation metadata only. Operational
-- measurements remain canonical integer millimeters and grams (with existing
-- warehouse capacity stored in cubic meters and kilograms).

CREATE TABLE IF NOT EXISTS workspace_organization_preferences (
  organization_id uuid PRIMARY KEY
    REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  measurement_system text NOT NULL DEFAULT 'imperial',
  revision bigint NOT NULL DEFAULT 1,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_organization_preferences_measurement_system_valid
    CHECK (measurement_system IN ('imperial', 'metric')),
  CONSTRAINT workspace_organization_preferences_revision_valid
    CHECK (revision >= 1)
);

INSERT INTO workspace_organization_preferences (
  organization_id,
  measurement_system,
  revision,
  updated_by,
  created_at,
  updated_at
)
SELECT
  organization.id,
  'imperial',
  1,
  COALESCE(organization.updated_by, organization.created_by),
  now(),
  now()
FROM workspace_organizations organization
ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE app_user_workspace_preferences
  ADD COLUMN IF NOT EXISTS measurement_system_override text;

ALTER TABLE app_user_workspace_preferences
  DROP CONSTRAINT IF EXISTS app_user_workspace_preferences_measurement_override_valid,
  ADD CONSTRAINT app_user_workspace_preferences_measurement_override_valid
    CHECK (
      measurement_system_override IS NULL
      OR measurement_system_override IN ('imperial', 'metric')
    );

CREATE INDEX IF NOT EXISTS idx_workspace_organization_preferences_updated
  ON workspace_organization_preferences (updated_at DESC, organization_id);
