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

-- Provider acquisition is independent of a CRM placement. Legacy rows remain
-- explicitly unverified; selecting today's OAuth connection cannot adopt them.
CREATE TABLE crm_email_mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL REFERENCES app_users(email),
  provider text NOT NULL CHECK (provider = 'gmail'),
  provider_account_id text NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 512),
  account_email text NOT NULL,
  verified_at timestamptz NOT NULL,
  UNIQUE (owner_email, provider, provider_account_id),
  UNIQUE (id, owner_email)
);
CREATE TABLE crm_email_mailbox_bindings (
  owner_email text NOT NULL,
  connection_id text NOT NULL,
  mailbox_id uuid NOT NULL,
  account_email text NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (owner_email, connection_id),
  FOREIGN KEY (mailbox_id, owner_email) REFERENCES crm_email_mailboxes(id, owner_email)
);
CREATE TABLE crm_email_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL,
  owner_email text NOT NULL REFERENCES app_users(email),
  provider_message_id text NOT NULL,
  provider_thread_id text,
  intake_pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id),
  intake_workspace_id uuid NOT NULL,
  observed_connection_id text NOT NULL,
  observed_account_email text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, provider_message_id),
  FOREIGN KEY (mailbox_id, owner_email) REFERENCES crm_email_mailboxes(id, owner_email)
);
ALTER TABLE crm_inbound_messages
  ADD COLUMN mailbox_id uuid REFERENCES crm_email_mailboxes(id),
  ADD COLUMN canonical_source_id uuid UNIQUE REFERENCES crm_email_sources(id);
ALTER TABLE crm_interactions
  ADD COLUMN canonical_source_id uuid REFERENCES crm_email_sources(id);
CREATE UNIQUE INDEX idx_crm_interactions_canonical_source
  ON crm_interactions(pipeline_id, canonical_source_id) WHERE canonical_source_id IS NOT NULL;
CREATE TABLE crm_email_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES crm_email_sources(id),
  revision integer NOT NULL CHECK (revision > 0),
  decision_hash text NOT NULL CHECK (decision_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('review', 'correction', 'late-contact', 'legacy-adoption')),
  actor_email text NOT NULL REFERENCES app_users(email),
  associations jsonb NOT NULL,
  audience jsonb NOT NULL,
  provenance jsonb NOT NULL,
  previous_decision_id uuid REFERENCES crm_email_review_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (pipeline_id, interaction_id) REFERENCES crm_interactions(pipeline_id, id),
  UNIQUE (interaction_id, revision),
  UNIQUE (interaction_id, decision_hash)
);

-- Mixed-company rows are a compatibility floor. An old scalar writer must
-- fail atomically rather than silently deleting associations. This is not a
-- permission grant: only the new authorized staging transaction sets the GUC.
CREATE FUNCTION clawpilot_guard_shared_email_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid; target_ids uuid[]; shared boolean;
BEGIN
  IF TG_TABLE_NAME = 'crm_interactions' THEN target_ids := ARRAY[OLD.id];
  ELSIF TG_OP = 'INSERT' THEN target_ids := ARRAY[NEW.interaction_id];
  ELSIF TG_OP = 'DELETE' THEN target_ids := ARRAY[OLD.interaction_id];
  ELSE target_ids := ARRAY[OLD.interaction_id, NEW.interaction_id]; END IF;
  FOREACH target_id IN ARRAY target_ids LOOP
    SELECT count(*) > 1 OR (TG_TABLE_NAME='crm_interaction_organizations' AND TG_OP='INSERT' AND count(*) > 0)
      INTO shared FROM crm_interaction_organizations WHERE interaction_id = target_id;
    IF shared AND current_setting('clawpilot.crm_shared_write_v1', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Shared Email requires a compatible authorized writer' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER crm_shared_email_write_guard BEFORE UPDATE OR DELETE ON crm_interactions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_guard_shared_email_write();
CREATE TRIGGER crm_shared_email_contact_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_interaction_contacts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_guard_shared_email_write();
CREATE TRIGGER crm_shared_email_company_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_interaction_organizations
  FOR EACH ROW EXECUTE FUNCTION clawpilot_guard_shared_email_write();

-- Keep ordinary, still-single-company old writers coherent during the drain.
CREATE FUNCTION clawpilot_bridge_primary_email_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('clawpilot.crm_shared_write_v1', true) IS DISTINCT FROM 'on' THEN
    DELETE FROM crm_interaction_organizations WHERE interaction_id = NEW.id;
    IF NEW.organization_id IS NOT NULL THEN
      INSERT INTO crm_interaction_organizations(pipeline_id, interaction_id, organization_id, is_primary)
        VALUES (NEW.pipeline_id, NEW.id, NEW.organization_id, true);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_single_company_compatibility_bridge AFTER INSERT OR UPDATE OF organization_id ON crm_interactions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_bridge_primary_email_company();

CREATE FUNCTION clawpilot_lock_participant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE address text; owner_id text; addresses text[];
BEGIN
  IF TG_OP='INSERT' THEN addresses := ARRAY[lower(btrim(NEW.email))];
  ELSIF TG_OP='DELETE' THEN addresses := ARRAY[lower(btrim(OLD.email))];
  ELSE addresses := ARRAY[lower(btrim(OLD.email)),lower(btrim(NEW.email))]; END IF;
  SELECT owner_email INTO owner_id FROM pipeline_spaces WHERE id=COALESCE(NEW.pipeline_id,OLD.pipeline_id);
  FOR address IN SELECT DISTINCT value FROM unnest(addresses) value WHERE value IS NOT NULL AND value<>'' ORDER BY value LOOP
    PERFORM pg_advisory_xact_lock(hashtext('crm-participant:' || owner_id || ':' || address));
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER crm_contact_identity_fence BEFORE INSERT OR UPDATE OR DELETE ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_lock_participant_identity();
CREATE TRIGGER crm_lead_identity_fence BEFORE INSERT OR UPDATE OR DELETE ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION clawpilot_lock_participant_identity();

CREATE FUNCTION clawpilot_protect_email_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Canonical Email evidence and review decisions are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER crm_email_source_immutable BEFORE UPDATE OR DELETE ON crm_email_sources
  FOR EACH ROW EXECUTE FUNCTION clawpilot_protect_email_evidence();
CREATE TRIGGER crm_email_decision_immutable BEFORE UPDATE OR DELETE ON crm_email_review_decisions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_protect_email_evidence();

CREATE FUNCTION clawpilot_protect_shared_contact_company() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id AND EXISTS (
    SELECT 1 FROM crm_interaction_contacts contact_link WHERE contact_link.contact_id=OLD.id
      AND (SELECT count(*) FROM crm_interaction_organizations company_link WHERE company_link.interaction_id=contact_link.interaction_id)>1
  ) THEN RAISE EXCEPTION 'Correct shared Email associations before reassigning its Contact company' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_shared_contact_company_guard BEFORE UPDATE OF organization_id ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_protect_shared_contact_company();

CREATE FUNCTION clawpilot_protect_mailbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.id,OLD.owner_email,OLD.provider,OLD.provider_account_id) IS DISTINCT FROM
     (NEW.id,NEW.owner_email,NEW.provider,NEW.provider_account_id) THEN
    RAISE EXCEPTION 'Verified provider mailbox identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_email_mailbox_identity_immutable BEFORE UPDATE ON crm_email_mailboxes
  FOR EACH ROW EXECUTE FUNCTION clawpilot_protect_mailbox_identity();
