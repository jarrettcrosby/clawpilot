-- Opt-in calendar discovery. No connection or import is enabled by migration.
CREATE TABLE crm_calendar_discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  workspace_organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  credential_owner_email text NOT NULL REFERENCES app_users(email),
  connection_id text NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 512),
  calendar_id text NOT NULL CHECK (length(calendar_id) BETWEEN 1 AND 1024 AND calendar_id <> 'primary'),
  account_email text NOT NULL,
  time_zone text NOT NULL DEFAULT 'America/New_York',
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz NOT NULL,
  cursor_state jsonb,
  last_polled_at timestamptz,
  last_error text,
  created_by text REFERENCES app_users(email),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, calendar_id),
  UNIQUE (pipeline_id, id, calendar_id),
  CHECK (cursor_state IS NULL OR jsonb_typeof(cursor_state) = 'object')
);

CREATE INDEX idx_crm_calendar_discovery_due
  ON crm_calendar_discovery_sources (last_polled_at, id) WHERE enabled;

CREATE TABLE crm_meeting_contacts (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, contact_id),
  FOREIGN KEY (pipeline_id, meeting_id) REFERENCES crm_meetings(pipeline_id, id) ON DELETE CASCADE,
  FOREIGN KEY (pipeline_id, contact_id) REFERENCES crm_contacts(pipeline_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_crm_meeting_contacts_contact ON crm_meeting_contacts (pipeline_id, contact_id, meeting_id);

INSERT INTO crm_meeting_contacts (pipeline_id, meeting_id, contact_id, created_by)
SELECT pipeline_id, id, contact_id, created_by FROM crm_meetings WHERE contact_id IS NOT NULL;

-- Identity is scoped to the actual Google calendar, not a mutable selected
-- connection or an email alias. Reconnects cannot duplicate imported meetings.
CREATE TABLE crm_calendar_discovery_events (
  pipeline_id uuid NOT NULL,
  source_id uuid NOT NULL,
  calendar_id text NOT NULL,
  external_event_id text NOT NULL CHECK (length(external_event_id) BETWEEN 1 AND 1000),
  meeting_id uuid NOT NULL,
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, calendar_id, external_event_id),
  FOREIGN KEY (pipeline_id, source_id, calendar_id) REFERENCES crm_calendar_discovery_sources(pipeline_id, id, calendar_id) ON DELETE CASCADE,
  FOREIGN KEY (pipeline_id, meeting_id) REFERENCES crm_meetings(pipeline_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_crm_calendar_discovery_meeting ON crm_calendar_discovery_events (pipeline_id, meeting_id);
