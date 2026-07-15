CREATE SEQUENCE IF NOT EXISTS crm_organization_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_contact_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_opportunity_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_interaction_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_lead_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_meeting_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS crm_campaign_reference_seq
  AS bigint MINVALUE 5999999 START WITH 5999999 MAXVALUE 9999999 NO CYCLE;

-- Workspace organizations and app users own the durable account/contact identities.
-- Pipeline CRM rows are projections and reuse these codes across a user's pipelines.
ALTER TABLE workspace_organizations ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS reference_code text;

UPDATE workspace_organizations
SET reference_code = 'ga' || lpad(nextval('crm_organization_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

UPDATE app_users
SET reference_code = 'gc' || lpad(nextval('crm_contact_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

ALTER TABLE workspace_organizations
  ALTER COLUMN reference_code SET DEFAULT ('ga' || lpad(nextval('crm_organization_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT workspace_organizations_reference_code_valid CHECK (reference_code ~ '^ga[0-9]{7}$'),
  ADD CONSTRAINT workspace_organizations_reference_code_unique UNIQUE (reference_code);

ALTER TABLE app_users
  ALTER COLUMN reference_code SET DEFAULT ('gc' || lpad(nextval('crm_contact_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT app_users_reference_code_valid CHECK (reference_code ~ '^gc[0-9]{7}$'),
  ADD CONSTRAINT app_users_reference_code_unique UNIQUE (reference_code);

ALTER TABLE short_links
  ADD COLUMN IF NOT EXISTS organization_root_id uuid REFERENCES workspace_organizations(id) ON DELETE RESTRICT;

WITH RECURSIVE owner_ancestors AS (
  SELECT
    app_user.email AS owner_email,
    organization.id,
    organization.parent_id,
    ARRAY[organization.id] AS path
  FROM app_users app_user
  JOIN workspace_organizations organization ON organization.id = app_user.organization_id
  UNION ALL
  SELECT
    ancestor.owner_email,
    parent.id,
    parent.parent_id,
    ancestor.path || parent.id
  FROM owner_ancestors ancestor
  JOIN workspace_organizations parent ON parent.id = ancestor.parent_id
  WHERE NOT parent.id = ANY(ancestor.path)
),
owner_roots AS (
  SELECT DISTINCT ON (owner_email) owner_email, id
  FROM owner_ancestors
  ORDER BY owner_email, (parent_id IS NULL) DESC
)
UPDATE short_links link
SET organization_root_id = root.id
FROM owner_roots root
WHERE root.owner_email = link.owner_email
  AND link.organization_root_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_short_links_organization_updated
  ON short_links (organization_root_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;

ALTER TABLE crm_organizations ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS app_user_email text;
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS reference_code text;
ALTER TABLE crm_interactions ADD COLUMN IF NOT EXISTS reference_code text;

UPDATE crm_organizations organization
SET reference_code = workspace.reference_code
FROM workspace_organizations workspace
WHERE workspace.id = organization.workspace_organization_id
  AND organization.reference_code IS NULL;

UPDATE crm_organizations
SET reference_code = 'ga' || lpad(nextval('crm_organization_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

UPDATE crm_contacts contact
SET app_user_email = app_user.email,
    reference_code = app_user.reference_code
FROM app_users app_user
WHERE lower(nullif(contact.source_payload->>'userEmail', '')) = app_user.email
  AND contact.source_payload->>'source' = 'clawpilot_profile';

UPDATE crm_contacts
SET reference_code = 'gc' || lpad(nextval('crm_contact_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

UPDATE crm_opportunities
SET reference_code = 'go' || lpad(nextval('crm_opportunity_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

UPDATE crm_interactions
SET reference_code = 'gi' || lpad(nextval('crm_interaction_reference_seq')::text, 7, '0')
WHERE reference_code IS NULL;

ALTER TABLE crm_organizations
  ALTER COLUMN reference_code SET DEFAULT ('ga' || lpad(nextval('crm_organization_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT crm_organizations_reference_code_valid CHECK (reference_code ~ '^ga[0-9]{7}$'),
  ADD CONSTRAINT crm_organizations_reference_code_unique UNIQUE (pipeline_id, reference_code);

ALTER TABLE crm_contacts
  ALTER COLUMN reference_code SET DEFAULT ('gc' || lpad(nextval('crm_contact_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT crm_contacts_reference_code_valid CHECK (reference_code ~ '^gc[0-9]{7}$'),
  ADD CONSTRAINT crm_contacts_reference_code_unique UNIQUE (pipeline_id, reference_code),
  ADD CONSTRAINT crm_contacts_app_user_email_fkey FOREIGN KEY (app_user_email) REFERENCES app_users(email) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_pipeline_app_user
  ON crm_contacts (pipeline_id, app_user_email)
  WHERE app_user_email IS NOT NULL;

ALTER TABLE crm_opportunities
  ALTER COLUMN reference_code SET DEFAULT ('go' || lpad(nextval('crm_opportunity_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD CONSTRAINT crm_opportunities_reference_code_valid CHECK (reference_code ~ '^go[0-9]{7}$'),
  ADD CONSTRAINT crm_opportunities_reference_code_unique UNIQUE (reference_code);

ALTER TABLE crm_interactions
  ALTER COLUMN reference_code SET DEFAULT ('gi' || lpad(nextval('crm_interaction_reference_seq')::text, 7, '0')),
  ALTER COLUMN reference_code SET NOT NULL,
  ADD COLUMN IF NOT EXISTS lead_id uuid,
  ADD COLUMN IF NOT EXISTS meeting_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS delivery_status text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS provider_thread_id text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT crm_interactions_reference_code_valid CHECK (reference_code ~ '^gi[0-9]{7}$'),
  ADD CONSTRAINT crm_interactions_reference_code_unique UNIQUE (reference_code),
  ADD CONSTRAINT crm_interactions_direction_valid CHECK (direction IN ('inbound', 'outbound', 'internal'));

-- A contact always belongs to an organization in the same pipeline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_organizations_pipeline_id
  ON crm_organizations (pipeline_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_pipeline_id
  ON crm_contacts (pipeline_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_opportunities_pipeline_id
  ON crm_opportunities (pipeline_id, id);

ALTER TABLE crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_organization_id_fkey;
ALTER TABLE crm_contacts ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE crm_contacts
  ADD CONSTRAINT crm_contacts_pipeline_organization_fkey
  FOREIGN KEY (pipeline_id, organization_id)
  REFERENCES crm_organizations (pipeline_id, id)
  ON DELETE RESTRICT;

ALTER TABLE crm_opportunities DROP CONSTRAINT IF EXISTS crm_opportunities_organization_id_fkey;
ALTER TABLE crm_opportunities
  ADD CONSTRAINT crm_opportunities_pipeline_organization_fkey
  FOREIGN KEY (pipeline_id, organization_id)
  REFERENCES crm_organizations (pipeline_id, id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  organization_id uuid,
  converted_contact_id uuid,
  converted_opportunity_id uuid,
  suitecrm_id text,
  source_key text NOT NULL,
  reference_code text NOT NULL DEFAULT ('gl' || lpad(nextval('crm_lead_reference_seq')::text, 7, '0')),
  first_name text,
  last_name text,
  full_name text NOT NULL,
  company_name text,
  job_title text,
  email text,
  phone_work text,
  phone_mobile text,
  status text,
  lead_source text,
  assigned_to text,
  description text,
  email_opt_out boolean NOT NULL DEFAULT false,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_leads_name_present CHECK (length(btrim(full_name)) > 0),
  CONSTRAINT crm_leads_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_leads_reference_code_valid CHECK (reference_code ~ '^gl[0-9]{7}$'),
  CONSTRAINT crm_leads_reference_code_unique UNIQUE (reference_code),
  CONSTRAINT crm_leads_pipeline_source_unique UNIQUE (pipeline_id, source_key),
  CONSTRAINT crm_leads_pipeline_organization_fkey FOREIGN KEY (pipeline_id, organization_id)
    REFERENCES crm_organizations (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_leads_pipeline_converted_contact_fkey FOREIGN KEY (pipeline_id, converted_contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_leads_pipeline_converted_opportunity_fkey FOREIGN KEY (pipeline_id, converted_opportunity_id)
    REFERENCES crm_opportunities (pipeline_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_pipeline_id
  ON crm_leads (pipeline_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_suitecrm
  ON crm_leads (pipeline_id, suitecrm_id) WHERE suitecrm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_leads_search
  ON crm_leads (pipeline_id, lower(full_name), lower(email), updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  organization_id uuid,
  contact_id uuid,
  lead_id uuid,
  opportunity_id uuid,
  suitecrm_id text,
  source_key text NOT NULL,
  reference_code text NOT NULL DEFAULT ('gm' || lpad(nextval('crm_meeting_reference_seq')::text, 7, '0')),
  subject text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  location text,
  attendee_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'planned',
  provider text,
  external_event_id text,
  external_event_url text,
  join_url text,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_meetings_subject_present CHECK (length(btrim(subject)) > 0),
  CONSTRAINT crm_meetings_time_valid CHECK (ends_at > starts_at),
  CONSTRAINT crm_meetings_status_valid CHECK (status IN ('planned', 'queued', 'scheduled', 'completed', 'cancelled', 'failed')),
  CONSTRAINT crm_meetings_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_meetings_reference_code_valid CHECK (reference_code ~ '^gm[0-9]{7}$'),
  CONSTRAINT crm_meetings_reference_code_unique UNIQUE (reference_code),
  CONSTRAINT crm_meetings_pipeline_source_unique UNIQUE (pipeline_id, source_key),
  CONSTRAINT crm_meetings_pipeline_organization_fkey FOREIGN KEY (pipeline_id, organization_id)
    REFERENCES crm_organizations (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_meetings_pipeline_contact_fkey FOREIGN KEY (pipeline_id, contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_meetings_pipeline_lead_fkey FOREIGN KEY (pipeline_id, lead_id)
    REFERENCES crm_leads (pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT crm_meetings_pipeline_opportunity_fkey FOREIGN KEY (pipeline_id, opportunity_id)
    REFERENCES crm_opportunities (pipeline_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_meetings_pipeline_id
  ON crm_meetings (pipeline_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_meetings_suitecrm
  ON crm_meetings (pipeline_id, suitecrm_id) WHERE suitecrm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_meetings_time
  ON crm_meetings (pipeline_id, starts_at, status, id);

-- Campaign uses gk because gc is reserved for contacts.
CREATE TABLE IF NOT EXISTS crm_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  suitecrm_id text,
  source_key text NOT NULL,
  reference_code text NOT NULL DEFAULT ('gk' || lpad(nextval('crm_campaign_reference_seq')::text, 7, '0')),
  name text NOT NULL,
  campaign_type text NOT NULL DEFAULT 'email',
  status text NOT NULL DEFAULT 'draft',
  start_date date,
  end_date date,
  subject_template text,
  body_template text,
  sender_email text,
  description text,
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_hash text NOT NULL,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'syncing', 'synced', 'failed')),
  sync_error text,
  suitecrm_synced_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_campaigns_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT crm_campaigns_type_valid CHECK (campaign_type IN ('email')),
  CONSTRAINT crm_campaigns_status_valid CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'paused', 'failed')),
  CONSTRAINT crm_campaigns_dates_valid CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CONSTRAINT crm_campaigns_counts_valid CHECK (recipient_count >= 0 AND sent_count >= 0 AND failed_count >= 0),
  CONSTRAINT crm_campaigns_source_key_present CHECK (length(btrim(source_key)) > 0),
  CONSTRAINT crm_campaigns_reference_code_valid CHECK (reference_code ~ '^gk[0-9]{7}$'),
  CONSTRAINT crm_campaigns_reference_code_unique UNIQUE (reference_code),
  CONSTRAINT crm_campaigns_pipeline_source_unique UNIQUE (pipeline_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_campaigns_suitecrm
  ON crm_campaigns (pipeline_id, suitecrm_id) WHERE suitecrm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_campaigns_pipeline_id
  ON crm_campaigns (pipeline_id, id);
CREATE INDEX IF NOT EXISTS idx_crm_campaigns_status
  ON crm_campaigns (pipeline_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS crm_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  contact_id uuid,
  lead_id uuid,
  email text NOT NULL,
  merge_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  integration_action_id uuid,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_campaign_recipients_target_valid CHECK ((contact_id IS NOT NULL) <> (lead_id IS NOT NULL)),
  CONSTRAINT crm_campaign_recipients_email_present CHECK (length(btrim(email)) > 0),
  CONSTRAINT crm_campaign_recipients_status_valid CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'suppressed')),
  CONSTRAINT crm_campaign_recipients_campaign_email_unique UNIQUE (campaign_id, email),
  CONSTRAINT crm_campaign_recipients_pipeline_campaign_fkey FOREIGN KEY (pipeline_id, campaign_id)
    REFERENCES crm_campaigns (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_campaign_recipients_pipeline_contact_fkey FOREIGN KEY (pipeline_id, contact_id)
    REFERENCES crm_contacts (pipeline_id, id) ON DELETE CASCADE,
  CONSTRAINT crm_campaign_recipients_pipeline_lead_fkey FOREIGN KEY (pipeline_id, lead_id)
    REFERENCES crm_leads (pipeline_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS crm_integration_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  provider text,
  app text NOT NULL,
  action_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  reference_code text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lock_token text,
  external_id text,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  idempotency_key text NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_integration_actions_provider_valid CHECK (
    provider IS NULL OR provider IN ('maton', 'direct-google', 'internal')
  ),
  CONSTRAINT crm_integration_actions_app_valid CHECK (app ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT crm_integration_actions_type_valid CHECK (
    action_type IN ('send_email', 'create_calendar_event', 'log_call', 'send_campaign', 'create_invoice')
  ),
  CONSTRAINT crm_integration_actions_status_valid CHECK (
    status IN ('queued', 'processing', 'succeeded', 'failed', 'dead', 'cancelled')
  ),
  CONSTRAINT crm_integration_actions_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT crm_integration_actions_idempotency_unique UNIQUE (actor_email, idempotency_key)
);

ALTER TABLE crm_campaign_recipients
  ADD CONSTRAINT crm_campaign_recipients_action_fkey
  FOREIGN KEY (integration_action_id) REFERENCES crm_integration_actions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_integration_actions_due
  ON crm_integration_actions (status, available_at, created_at)
  WHERE status IN ('queued', 'failed', 'processing');
CREATE INDEX IF NOT EXISTS idx_crm_integration_actions_pipeline
  ON crm_integration_actions (pipeline_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_integration_action_attempts (
  id bigserial PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES crm_integration_actions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  provider text NOT NULL,
  connection_id text,
  status text NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
  external_id text,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT crm_integration_action_attempts_number_valid CHECK (attempt_number > 0),
  CONSTRAINT crm_integration_action_attempts_unique UNIQUE (action_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS crm_inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  external_thread_id text,
  sender_email text NOT NULL,
  recipient_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  subject text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  snippet text,
  body_text text,
  marker_references text[] NOT NULL DEFAULT ARRAY[]::text[],
  contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES crm_leads(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES crm_organizations(id) ON DELETE SET NULL,
  interaction_id uuid REFERENCES crm_interactions(id) ON DELETE SET NULL,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_inbound_messages_owner_external_unique UNIQUE (owner_email, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_inbound_messages_pipeline_time
  ON crm_inbound_messages (pipeline_id, received_at DESC, id);

CREATE TABLE IF NOT EXISTS crm_inbound_message_links (
  inbound_message_id uuid NOT NULL REFERENCES crm_inbound_messages(id) ON DELETE CASCADE,
  reference_code text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  interaction_id uuid REFERENCES crm_interactions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inbound_message_id, reference_code),
  CONSTRAINT crm_inbound_message_links_reference_valid CHECK (
    reference_code ~ '^g[aciklmo][0-9]{7}$'
  )
);

CREATE TABLE IF NOT EXISTS crm_integration_cursors (
  owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  app text NOT NULL,
  cursor_key text NOT NULL,
  cursor_value text,
  last_polled_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, app, cursor_key)
);

ALTER TABLE crm_interactions DROP CONSTRAINT IF EXISTS crm_interactions_organization_id_fkey;
ALTER TABLE crm_interactions DROP CONSTRAINT IF EXISTS crm_interactions_contact_id_fkey;
ALTER TABLE crm_interactions DROP CONSTRAINT IF EXISTS crm_interactions_opportunity_id_fkey;
ALTER TABLE crm_interactions
  ADD CONSTRAINT crm_interactions_pipeline_organization_fkey
    FOREIGN KEY (pipeline_id, organization_id) REFERENCES crm_organizations (pipeline_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_interactions_pipeline_contact_fkey
    FOREIGN KEY (pipeline_id, contact_id) REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_interactions_pipeline_opportunity_fkey
    FOREIGN KEY (pipeline_id, opportunity_id) REFERENCES crm_opportunities (pipeline_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_interactions_pipeline_lead_fkey
    FOREIGN KEY (pipeline_id, lead_id) REFERENCES crm_leads (pipeline_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_interactions_pipeline_meeting_fkey
    FOREIGN KEY (pipeline_id, meeting_id) REFERENCES crm_meetings (pipeline_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT crm_interactions_pipeline_campaign_fkey
    FOREIGN KEY (pipeline_id, campaign_id) REFERENCES crm_campaigns (pipeline_id, id) ON DELETE RESTRICT;

-- Repair historical contact/account links after organization deduplication.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'crm_contacts',
  contact.id::text,
  'upsert_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'contacts',
    'pipelineId', contact.pipeline_id::text,
    'localId', contact.id::text,
    'suiteCrmId', contact.suitecrm_id,
    'attributes', jsonb_build_object(
      'first_name', COALESCE(contact.first_name, ''),
      'last_name', COALESCE(NULLIF(contact.last_name, ''), contact.full_name),
      'title', COALESCE(contact.job_title, ''),
      'email1', COALESCE(contact.email, ''),
      'phone_work', COALESCE(contact.phone_work, ''),
      'phone_mobile', COALESCE(contact.phone_mobile, ''),
      'primary_address_street', COALESCE(contact.primary_address_street, ''),
      'primary_address_city', COALESCE(contact.primary_address_city, ''),
      'primary_address_state', COALESCE(contact.primary_address_state, ''),
      'primary_address_postalcode', COALESCE(contact.primary_address_postal_code, ''),
      'primary_address_country', COALESCE(contact.primary_address_country, ''),
      'account_id', organization.suitecrm_id,
      'description', COALESCE(contact.description, '')
    )
  ),
  'queued',
  'crm-contact-account-repair-v1:' || contact.id::text || ':' || organization.suitecrm_id,
  now(),
  now(),
  now()
FROM crm_contacts contact
JOIN crm_organizations organization ON organization.id = contact.organization_id
WHERE contact.suitecrm_id IS NOT NULL
  AND organization.suitecrm_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

-- Reconcile existing managed Drive resources into the CRM-backed organization/contact hierarchy.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'pipeline_space',
  pipeline.id::text,
  'provision_pipeline',
  'google_workspace',
  jsonb_build_object('pipelineId', pipeline.id::text),
  'queued',
  0,
  'pipeline:' || pipeline.id::text || ':provision',
  now(),
  now(),
  now()
FROM pipeline_spaces pipeline
WHERE pipeline.drive_folder_id IS NOT NULL
  AND pipeline.google_service_account_email IS NOT NULL
  AND pipeline.google_shared_drive_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO UPDATE SET
  status = 'queued',
  attempts = 0,
  last_error = NULL,
  available_at = now(),
  processed_at = NULL,
  locked_at = NULL,
  lock_token = NULL,
  updated_at = now();

UPDATE pipeline_spaces
SET provisioning_status = 'queued',
    provisioning_error = NULL,
    provisioning_requested_at = now(),
    provisioning_completed_at = NULL,
    updated_at = now()
WHERE drive_folder_id IS NOT NULL
  AND google_service_account_email IS NOT NULL
  AND google_shared_drive_id IS NOT NULL;
