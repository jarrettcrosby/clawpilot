CREATE TABLE IF NOT EXISTS crm_opportunity_contacts (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, contact_id),
  CONSTRAINT crm_opportunity_contacts_pipeline_opportunity_fkey
    FOREIGN KEY (pipeline_id, opportunity_id)
    REFERENCES crm_opportunities (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_opportunity_contacts_pipeline_contact_fkey
    FOREIGN KEY (pipeline_id, contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_opportunity_contacts_sort_order_valid CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opportunity_contacts_primary
  ON crm_opportunity_contacts (opportunity_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_contacts_contact
  ON crm_opportunity_contacts (pipeline_id, contact_id, opportunity_id);

CREATE INDEX IF NOT EXISTS idx_crm_opportunity_contacts_opportunity
  ON crm_opportunity_contacts (pipeline_id, opportunity_id, sort_order, contact_id);
