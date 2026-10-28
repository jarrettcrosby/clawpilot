CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_organizations_pipeline_id
  ON crm_organizations (pipeline_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interactions_pipeline_id
  ON crm_interactions (pipeline_id, id);

CREATE TABLE IF NOT EXISTS crm_interaction_organizations (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interaction_id, organization_id),
  CONSTRAINT crm_interaction_organizations_pipeline_interaction_fkey
    FOREIGN KEY (pipeline_id, interaction_id)
    REFERENCES crm_interactions (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_interaction_organizations_pipeline_organization_fkey
    FOREIGN KEY (pipeline_id, organization_id)
    REFERENCES crm_organizations (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_interaction_organizations_sort_order_valid CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interaction_organizations_primary
  ON crm_interaction_organizations (interaction_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_crm_interaction_organizations_organization
  ON crm_interaction_organizations (pipeline_id, organization_id, interaction_id);
CREATE INDEX IF NOT EXISTS idx_crm_interaction_organizations_interaction
  ON crm_interaction_organizations (pipeline_id, interaction_id, sort_order, organization_id);

INSERT INTO crm_interaction_organizations (
  pipeline_id, interaction_id, organization_id, is_primary, sort_order, created_by
)
SELECT pipeline_id, id, organization_id, true, 0, created_by
FROM crm_interactions WHERE organization_id IS NOT NULL
ON CONFLICT (interaction_id, organization_id) DO UPDATE SET
  is_primary = true, sort_order = 0, updated_at = now();
