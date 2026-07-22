CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interactions_pipeline_id
  ON crm_interactions (pipeline_id, id);

CREATE TABLE IF NOT EXISTS crm_interaction_contacts (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interaction_id, contact_id),
  CONSTRAINT crm_interaction_contacts_pipeline_interaction_fkey
    FOREIGN KEY (pipeline_id, interaction_id)
    REFERENCES crm_interactions (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_interaction_contacts_pipeline_contact_fkey
    FOREIGN KEY (pipeline_id, contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_interaction_contacts_sort_order_valid CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interaction_contacts_primary
  ON crm_interaction_contacts (interaction_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_crm_interaction_contacts_contact
  ON crm_interaction_contacts (pipeline_id, contact_id, interaction_id);

CREATE INDEX IF NOT EXISTS idx_crm_interaction_contacts_interaction
  ON crm_interaction_contacts (pipeline_id, interaction_id, sort_order, contact_id);

INSERT INTO crm_interaction_contacts (
  pipeline_id, interaction_id, contact_id, is_primary, sort_order, created_by
)
SELECT interaction.pipeline_id, interaction.id, interaction.contact_id, true, 0, interaction.created_by
FROM crm_interactions interaction
WHERE interaction.contact_id IS NOT NULL
ON CONFLICT (interaction_id, contact_id) DO UPDATE SET
  is_primary = true,
  sort_order = 0,
  updated_at = now();
