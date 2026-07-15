CREATE TABLE IF NOT EXISTS crm_board_projections (
  board_id uuid PRIMARY KEY REFERENCES project_boards(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL UNIQUE REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_board_cards (
  board_id uuid NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
  task_id text NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('organizations', 'contacts')),
  entity_id uuid NOT NULL,
  reference_code text NOT NULL CHECK (reference_code ~ '^g[ac][0-9]{7}$'),
  last_synced_description text NOT NULL DEFAULT '',
  last_common_hash text NOT NULL DEFAULT '',
  card_description_hash text NOT NULL DEFAULT '',
  crm_description_hash text NOT NULL DEFAULT '',
  sync_status text NOT NULL DEFAULT 'synced' CHECK (sync_status IN ('synced', 'conflict')),
  conflict_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, entity_type, entity_id),
  UNIQUE (board_id, reference_code)
);

CREATE INDEX IF NOT EXISTS idx_crm_board_cards_pipeline
  ON crm_board_cards(pipeline_id, entity_type, entity_id);

CREATE OR REPLACE FUNCTION validate_crm_board_projection_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  board_owner text;
  pipeline_owner text;
BEGIN
  SELECT owner_email INTO board_owner FROM project_boards WHERE id = NEW.board_id;
  SELECT owner_email INTO pipeline_owner FROM pipeline_spaces WHERE id = NEW.pipeline_id;
  IF board_owner IS NULL OR pipeline_owner IS NULL OR board_owner <> pipeline_owner THEN
    RAISE EXCEPTION 'CRM board and pipeline must have the same owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_board_projection_scope ON crm_board_projections;
CREATE TRIGGER trg_validate_crm_board_projection_scope
BEFORE INSERT OR UPDATE OF board_id, pipeline_id ON crm_board_projections
FOR EACH ROW EXECUTE FUNCTION validate_crm_board_projection_scope();

CREATE OR REPLACE FUNCTION validate_crm_board_card_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crm_board_projections projection
    WHERE projection.board_id = NEW.board_id AND projection.pipeline_id = NEW.pipeline_id
  ) THEN
    RAISE EXCEPTION 'CRM card board and pipeline are not bound';
  END IF;

  SELECT source INTO task_source
  FROM tasks
  WHERE id = NEW.task_id AND board_id = NEW.board_id;
  IF task_source IS NULL OR task_source <> 'crm-projection' THEN
    RAISE EXCEPTION 'CRM card task is missing or is not a CRM projection';
  END IF;

  IF NEW.entity_type = 'organizations' AND NOT EXISTS (
    SELECT 1 FROM crm_organizations organization
    WHERE organization.id = NEW.entity_id
      AND organization.pipeline_id = NEW.pipeline_id
      AND organization.reference_code = NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'CRM organization card is outside the bound pipeline';
  ELSIF NEW.entity_type = 'contacts' AND NOT EXISTS (
    SELECT 1 FROM crm_contacts contact
    WHERE contact.id = NEW.entity_id
      AND contact.pipeline_id = NEW.pipeline_id
      AND contact.reference_code = NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'CRM contact card is outside the bound pipeline';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_board_card_scope ON crm_board_cards;
CREATE CONSTRAINT TRIGGER trg_validate_crm_board_card_scope
AFTER INSERT OR UPDATE OF board_id, task_id, pipeline_id, entity_type, entity_id, reference_code
ON crm_board_cards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_crm_board_card_scope();

-- Mirror the operator's dedicated board into environments where only the
-- canonical default resources existed before this feature shipped.
INSERT INTO project_boards (name, owner_email, is_default)
SELECT 'CRM Board', pipeline.owner_email, false
FROM pipeline_spaces pipeline
JOIN project_boards default_board
  ON default_board.owner_email = pipeline.owner_email
 AND default_board.is_default
WHERE pipeline.is_default
  AND default_board.name = 'ClawPilot board'
  AND NOT EXISTS (
    SELECT 1
    FROM project_boards existing
    WHERE existing.owner_email = pipeline.owner_email
      AND lower(btrim(existing.name)) = 'crm board'
  )
ON CONFLICT DO NOTHING;

INSERT INTO crm_board_projections (board_id, pipeline_id)
SELECT board.id, pipeline.id
FROM project_boards board
JOIN LATERAL (
  SELECT candidate.id
  FROM pipeline_spaces candidate
  WHERE candidate.owner_email = board.owner_email
  ORDER BY candidate.is_default DESC, candidate.created_at, candidate.id
  LIMIT 1
) pipeline ON true
WHERE lower(btrim(board.name)) = 'crm board'
ON CONFLICT DO NOTHING;

-- Old sequential Global IDs remain permanently reserved in the reference
-- registry, but they are no longer valid public aliases or visible links.
UPDATE short_links link
SET deleted_at = COALESCE(link.deleted_at, now()),
    disabled_at = COALESCE(link.disabled_at, now()),
    updated_at = now()
WHERE link.source_app = 'clawpilot-crm'
  AND link.deleted_at IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM unnest(COALESCE(link.tags, ARRAY[]::text[])) tag
      WHERE tag LIKE 'legacy-alias-%'
    )
    OR EXISTS (
      SELECT 1
      FROM crm_reference_registry registry
      WHERE registry.reference_code = link.slug
        AND registry.status = 'alias'
    )
  );
