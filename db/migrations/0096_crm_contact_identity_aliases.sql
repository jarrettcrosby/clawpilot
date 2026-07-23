-- Preserve contact source identities and public references when a duplicate
-- Contact is consolidated into a canonical survivor.
CREATE TABLE IF NOT EXISTS crm_contact_source_aliases (
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  contact_id uuid NOT NULL,
  alias_kind text NOT NULL,
  source_sheet_id text,
  source_row_number integer,
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pipeline_id, source_key),
  CONSTRAINT crm_contact_source_aliases_contact_fkey
    FOREIGN KEY (pipeline_id, contact_id)
    REFERENCES crm_contacts (pipeline_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT crm_contact_source_aliases_key_present
    CHECK (length(btrim(source_key)) BETWEEN 1 AND 500),
  CONSTRAINT crm_contact_source_aliases_kind_valid
    CHECK (alias_kind IN ('source', 'former_identity', 'merged_contact')),
  CONSTRAINT crm_contact_source_aliases_source_row_valid
    CHECK (source_row_number IS NULL OR source_row_number >= 1),
  CONSTRAINT crm_contact_source_aliases_payload_object
    CHECK (jsonb_typeof(source_payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_source_aliases_contact
  ON crm_contact_source_aliases (pipeline_id, contact_id, created_at);

CREATE TABLE IF NOT EXISTS crm_reference_aliases (
  alias_code text PRIMARY KEY
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  canonical_code text NOT NULL
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_reference_aliases_alias_valid CHECK (alias_code ~ '^gc[0-9]{7}$'),
  CONSTRAINT crm_reference_aliases_canonical_valid CHECK (canonical_code ~ '^gc[0-9]{7}$'),
  CONSTRAINT crm_reference_aliases_distinct CHECK (alias_code <> canonical_code),
  CONSTRAINT crm_reference_aliases_reason_present CHECK (length(btrim(reason)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS idx_crm_reference_aliases_canonical
  ON crm_reference_aliases (canonical_code, alias_code);

CREATE TABLE IF NOT EXISTS crm_contact_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  survivor_contact_id uuid NOT NULL,
  duplicate_contact_id uuid NOT NULL,
  survivor_reference_code text NOT NULL
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  duplicate_reference_code text NOT NULL
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  survivor_suitecrm_id text,
  duplicate_suitecrm_id text,
  duplicate_snapshot jsonb NOT NULL,
  rewired_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  survivor_outbox_id uuid REFERENCES sync_outbox(id) ON DELETE RESTRICT,
  duplicate_delete_outbox_id uuid REFERENCES sync_outbox(id) ON DELETE RESTRICT,
  merged_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  reason text NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_contact_merges_survivor_fkey
    FOREIGN KEY (pipeline_id, survivor_contact_id)
    REFERENCES crm_contacts (pipeline_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT crm_contact_merges_contacts_distinct
    CHECK (survivor_contact_id <> duplicate_contact_id),
  CONSTRAINT crm_contact_merges_survivor_reference_valid
    CHECK (survivor_reference_code ~ '^gc[0-9]{7}$'),
  CONSTRAINT crm_contact_merges_duplicate_reference_valid
    CHECK (duplicate_reference_code ~ '^gc[0-9]{7}$'),
  CONSTRAINT crm_contact_merges_references_distinct
    CHECK (survivor_reference_code <> duplicate_reference_code),
  CONSTRAINT crm_contact_merges_duplicate_snapshot_object
    CHECK (jsonb_typeof(duplicate_snapshot) = 'object'),
  CONSTRAINT crm_contact_merges_rewired_counts_object
    CHECK (jsonb_typeof(rewired_counts) = 'object'),
  CONSTRAINT crm_contact_merges_actor_present
    CHECK (length(btrim(merged_by)) BETWEEN 1 AND 320),
  CONSTRAINT crm_contact_merges_reason_present
    CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  UNIQUE (pipeline_id, duplicate_contact_id),
  UNIQUE (duplicate_reference_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contact_merges_duplicate_suitecrm
  ON crm_contact_merges (duplicate_suitecrm_id)
  WHERE duplicate_suitecrm_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_contact_merges_survivor
  ON crm_contact_merges (pipeline_id, survivor_contact_id, merged_at DESC);

-- A dependent SuiteCRM outbox item remains queued at an infinite availability
-- timestamp until every prerequisite succeeds. This lets the guarded repair
-- sequence survivor upsert -> relationship repairs -> duplicate delete without
-- changing the shared worker claim contract.
CREATE TABLE IF NOT EXISTS crm_contact_merge_outbox_dependencies (
  dependent_outbox_id uuid NOT NULL REFERENCES sync_outbox(id) ON DELETE RESTRICT,
  prerequisite_outbox_id uuid NOT NULL REFERENCES sync_outbox(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dependent_outbox_id, prerequisite_outbox_id),
  CONSTRAINT crm_contact_merge_outbox_dependencies_distinct
    CHECK (dependent_outbox_id <> prerequisite_outbox_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_contact_merge_outbox_prerequisite
  ON crm_contact_merge_outbox_dependencies (prerequisite_outbox_id, dependent_outbox_id);

CREATE OR REPLACE FUNCTION validate_crm_reference_alias()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crm_reference_aliases nested
    WHERE nested.alias_code = NEW.canonical_code
  ) THEN
    RAISE EXCEPTION 'CRM reference aliases must point directly to a canonical reference';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crm_contacts contact
    WHERE contact.reference_code = NEW.canonical_code
  ) THEN
    RAISE EXCEPTION 'Canonical CRM Contact reference is not active';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_reference_alias ON crm_reference_aliases;
CREATE TRIGGER trg_validate_crm_reference_alias
BEFORE INSERT ON crm_reference_aliases
FOR EACH ROW EXECUTE FUNCTION validate_crm_reference_alias();

CREATE OR REPLACE FUNCTION validate_crm_contact_merge_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM crm_contacts survivor
    WHERE survivor.pipeline_id = NEW.pipeline_id
      AND survivor.id = NEW.survivor_contact_id
      AND survivor.reference_code = NEW.survivor_reference_code
      AND survivor.suitecrm_id IS NOT DISTINCT FROM NEW.survivor_suitecrm_id
  ) THEN
    RAISE EXCEPTION 'CRM Contact merge survivor evidence does not match the live Contact';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crm_contacts duplicate
    WHERE duplicate.pipeline_id = NEW.pipeline_id
      AND duplicate.id = NEW.duplicate_contact_id
      AND duplicate.reference_code = NEW.duplicate_reference_code
      AND duplicate.suitecrm_id IS NOT DISTINCT FROM NEW.duplicate_suitecrm_id
  ) THEN
    RAISE EXCEPTION 'CRM Contact merge duplicate evidence does not match the live Contact';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM crm_reference_aliases alias
    WHERE alias.alias_code = NEW.duplicate_reference_code
      AND alias.canonical_code = NEW.survivor_reference_code
  ) THEN
    RAISE EXCEPTION 'CRM Contact merge requires its permanent public reference alias';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_contact_merge_evidence
  ON crm_contact_merges;
CREATE TRIGGER trg_validate_crm_contact_merge_evidence
BEFORE INSERT ON crm_contact_merges
FOR EACH ROW EXECUTE FUNCTION validate_crm_contact_merge_evidence();

CREATE OR REPLACE FUNCTION protect_crm_contact_alias_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CRM contact alias evidence is append-only';
  END IF;
  IF NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
     OR NEW.source_key IS DISTINCT FROM OLD.source_key THEN
    RAISE EXCEPTION 'CRM contact alias identities are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_crm_contact_source_aliases
  ON crm_contact_source_aliases;
CREATE TRIGGER trg_protect_crm_contact_source_aliases
BEFORE UPDATE OR DELETE ON crm_contact_source_aliases
FOR EACH ROW EXECUTE FUNCTION protect_crm_contact_alias_evidence();

CREATE OR REPLACE FUNCTION protect_crm_contact_merge_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CRM contact merge evidence is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_crm_reference_aliases ON crm_reference_aliases;
CREATE TRIGGER trg_protect_crm_reference_aliases
BEFORE UPDATE OR DELETE ON crm_reference_aliases
FOR EACH ROW EXECUTE FUNCTION protect_crm_contact_merge_evidence();

DROP TRIGGER IF EXISTS trg_protect_crm_contact_merges ON crm_contact_merges;
CREATE TRIGGER trg_protect_crm_contact_merges
BEFORE UPDATE OR DELETE ON crm_contact_merges
FOR EACH ROW EXECUTE FUNCTION protect_crm_contact_merge_evidence();

CREATE OR REPLACE FUNCTION validate_crm_contact_merge_outbox_dependency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM sync_outbox dependent
    WHERE dependent.id = NEW.dependent_outbox_id
      AND dependent.target_system = 'suitecrm'
      AND dependent.status IN ('queued', 'failed')
      AND dependent.available_at = 'infinity'::timestamptz
  ) THEN
    RAISE EXCEPTION 'Dependent CRM merge outbox item must be a held SuiteCRM job';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM sync_outbox prerequisite
    WHERE prerequisite.id = NEW.prerequisite_outbox_id
      AND prerequisite.target_system = 'suitecrm'
      AND prerequisite.status IN ('queued', 'failed', 'processing')
  ) THEN
    RAISE EXCEPTION 'CRM merge outbox prerequisite must be an active SuiteCRM job';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_contact_merge_outbox_dependency
  ON crm_contact_merge_outbox_dependencies;
CREATE TRIGGER trg_validate_crm_contact_merge_outbox_dependency
BEFORE INSERT ON crm_contact_merge_outbox_dependencies
FOR EACH ROW EXECUTE FUNCTION validate_crm_contact_merge_outbox_dependency();

DROP TRIGGER IF EXISTS trg_protect_crm_contact_merge_outbox_dependencies
  ON crm_contact_merge_outbox_dependencies;
CREATE TRIGGER trg_protect_crm_contact_merge_outbox_dependencies
BEFORE UPDATE OR DELETE ON crm_contact_merge_outbox_dependencies
FOR EACH ROW EXECUTE FUNCTION protect_crm_contact_merge_evidence();

CREATE OR REPLACE FUNCTION release_crm_contact_merge_outbox_dependents()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'succeeded' OR OLD.status = 'succeeded' THEN
    RETURN NEW;
  END IF;

  UPDATE sync_outbox dependent
  SET available_at = now(),
      last_error = NULL,
      updated_at = now()
  WHERE dependent.id IN (
    SELECT dependency.dependent_outbox_id
    FROM crm_contact_merge_outbox_dependencies dependency
    WHERE dependency.prerequisite_outbox_id = NEW.id
      AND NOT EXISTS (
        SELECT 1
        FROM crm_contact_merge_outbox_dependencies required
        JOIN sync_outbox prerequisite ON prerequisite.id = required.prerequisite_outbox_id
        WHERE required.dependent_outbox_id = dependency.dependent_outbox_id
          AND prerequisite.status <> 'succeeded'
      )
  )
    AND dependent.status IN ('queued', 'failed')
    AND dependent.available_at = 'infinity'::timestamptz;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_crm_contact_merge_outbox_dependents
  ON sync_outbox;
CREATE TRIGGER trg_release_crm_contact_merge_outbox_dependents
AFTER UPDATE OF status ON sync_outbox
FOR EACH ROW EXECUTE FUNCTION release_crm_contact_merge_outbox_dependents();
