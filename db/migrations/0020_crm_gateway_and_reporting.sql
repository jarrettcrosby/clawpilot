CREATE TABLE IF NOT EXISTS crm_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  suitecrm_id text,
  source_key text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  priority text,
  name text NOT NULL,
  account_type text,
  account_manager text,
  website text,
  linkedin_url text,
  phone text,
  billing_address_street text,
  billing_address_city text,
  billing_address_state text,
  billing_address_postal_code text,
  billing_address_country text,
  description text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_organizations_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT crm_organizations_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_organizations_source_row_valid CHECK (source_row_number IS NULL OR source_row_number >= 1),
  UNIQUE (pipeline_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_organizations_suitecrm
  ON crm_organizations (pipeline_id, suitecrm_id)
  WHERE suitecrm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_organizations_search
  ON crm_organizations (pipeline_id, lower(name), updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES crm_organizations(id) ON DELETE SET NULL,
  suitecrm_id text,
  source_key text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  priority text,
  first_name text,
  last_name text,
  full_name text NOT NULL,
  contact_type text,
  account_manager text,
  job_title text,
  email text,
  linkedin_url text,
  phone_work text,
  phone_mobile text,
  primary_address_street text,
  primary_address_city text,
  primary_address_state text,
  primary_address_postal_code text,
  primary_address_country text,
  description text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_contacts_name_present CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT crm_contacts_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_contacts_source_row_valid CHECK (source_row_number IS NULL OR source_row_number >= 1),
  UNIQUE (pipeline_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_suitecrm
  ON crm_contacts (pipeline_id, suitecrm_id)
  WHERE suitecrm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_search
  ON crm_contacts (pipeline_id, lower(full_name), updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_organization
  ON crm_contacts (organization_id, updated_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES crm_organizations(id) ON DELETE SET NULL,
  suitecrm_id text,
  source_key text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  priority text,
  name text NOT NULL,
  owner_name text,
  organization_name text,
  status text,
  stage text,
  loss_reason text,
  lead_source text,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  probability numeric(5,2) NOT NULL DEFAULT 0,
  expected_close date,
  description text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_opportunities_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT crm_opportunities_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_opportunities_probability_valid CHECK (probability BETWEEN 0 AND 100),
  CONSTRAINT crm_opportunities_source_row_valid CHECK (source_row_number IS NULL OR source_row_number >= 1),
  UNIQUE (pipeline_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opportunities_suitecrm
  ON crm_opportunities (pipeline_id, suitecrm_id)
  WHERE suitecrm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_pipeline_stage
  ON crm_opportunities (pipeline_id, stage, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_crm_opportunities_organization
  ON crm_opportunities (organization_id, updated_at DESC)
  WHERE organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES crm_organizations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  opportunity_id uuid REFERENCES crm_opportunities(id) ON DELETE SET NULL,
  suitecrm_id text,
  source_key text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  interaction_type text,
  subject text NOT NULL,
  agent_name text,
  occurred_at timestamptz,
  description text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_interactions_subject_present CHECK (length(btrim(subject)) > 0),
  CONSTRAINT crm_interactions_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_interactions_source_row_valid CHECK (source_row_number IS NULL OR source_row_number >= 1),
  UNIQUE (pipeline_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_interactions_suitecrm
  ON crm_interactions (pipeline_id, suitecrm_id)
  WHERE suitecrm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_interactions_pipeline_time
  ON crm_interactions (pipeline_id, occurred_at DESC NULLS LAST, updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('sheet_to_crm', 'crm_to_sheet', 'reconcile')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  source_system text NOT NULL,
  target_system text NOT NULL,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_by text REFERENCES app_users(email) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_sync_runs_pipeline
  ON crm_sync_runs (pipeline_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_outbox_suitecrm_due
  ON sync_outbox (status, available_at, created_at)
  WHERE target_system = 'suitecrm' AND status IN ('queued', 'failed', 'processing');

ALTER TABLE pipeline_spaces
  ADD COLUMN IF NOT EXISTS crm_provider text NOT NULL DEFAULT 'suitecrm',
  ADD COLUMN IF NOT EXISTS crm_projection_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS crm_last_synced_at timestamptz;

ALTER TABLE pipeline_spaces
  ADD CONSTRAINT pipeline_spaces_crm_provider_valid CHECK (crm_provider IN ('suitecrm')),
  ADD CONSTRAINT pipeline_spaces_crm_projection_version_valid CHECK (crm_projection_version >= 1);
