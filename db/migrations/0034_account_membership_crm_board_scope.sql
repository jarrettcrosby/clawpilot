ALTER TABLE crm_board_projections
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid REFERENCES workspace_organizations(id) ON DELETE CASCADE;

UPDATE crm_board_projections projection
SET workspace_organization_id = pipeline.workspace_organization_id,
    updated_at = now()
FROM pipeline_spaces pipeline
WHERE pipeline.id = projection.pipeline_id
  AND projection.workspace_organization_id IS DISTINCT FROM pipeline.workspace_organization_id;

ALTER TABLE crm_board_projections
  ALTER COLUMN workspace_organization_id SET NOT NULL;

ALTER TABLE crm_board_projections
  DROP CONSTRAINT IF EXISTS crm_board_projections_pipeline_id_key;

CREATE INDEX IF NOT EXISTS idx_crm_board_projections_pipeline
  ON crm_board_projections (pipeline_id, board_id);

ALTER TABLE app_user_invitations
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT;

UPDATE app_user_invitations invitation
SET workspace_organization_id = app_user.organization_id,
    updated_at = now()
FROM app_users app_user
WHERE app_user.email = invitation.email
  AND invitation.workspace_organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_invitations_organization
  ON app_user_invitations (workspace_organization_id, created_at DESC)
  WHERE workspace_organization_id IS NOT NULL;

-- Historical workbook interactions often named only a Contact. Preserve that
-- relationship while materializing its Account so ClawPilot and SuiteCRM show
-- the same organization. The outbox item repairs the existing SuiteCRM Note.
WITH resolved_interactions AS (
  SELECT interaction.id,
    COALESCE(
      contact.organization_id,
      lead.organization_id,
      opportunity.organization_id,
      meeting.organization_id
    ) AS organization_id
  FROM crm_interactions interaction
  LEFT JOIN crm_contacts contact ON contact.id = interaction.contact_id
  LEFT JOIN crm_leads lead ON lead.id = interaction.lead_id
  LEFT JOIN crm_opportunities opportunity ON opportunity.id = interaction.opportunity_id
  LEFT JOIN crm_meetings meeting ON meeting.id = interaction.meeting_id
  WHERE interaction.organization_id IS NULL
), updated_interactions AS (
  UPDATE crm_interactions interaction
  SET organization_id = resolved.organization_id,
      sync_status = 'pending',
      sync_error = NULL,
      updated_at = now()
  FROM resolved_interactions resolved
  WHERE interaction.id = resolved.id
    AND resolved.organization_id IS NOT NULL
  RETURNING interaction.*
)
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, idempotency_key, attempts, available_at, created_at, updated_at
)
SELECT 'crm_interactions', interaction.id, 'upsert_record', 'suitecrm',
  jsonb_build_object(
    'entity', 'interactions',
    'pipelineId', interaction.pipeline_id,
    'localId', interaction.id,
    'suiteCrmId', interaction.suitecrm_id,
    'attributes', jsonb_build_object(
      'global_id_c', interaction.reference_code,
      'name', interaction.subject,
      'parent_type', 'Accounts',
      'parent_id', organization.suitecrm_id,
      'description', COALESCE(interaction.description, '')
    )
  ),
  'queued', 'crm:interactions:organization-backfill:v1:' || interaction.id,
  0, now(), now(), now()
FROM updated_interactions interaction
JOIN crm_organizations organization ON organization.id = interaction.organization_id
WHERE interaction.suitecrm_id IS NOT NULL
  AND organization.suitecrm_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

-- The column retains its historical name, but its value is now the exact
-- organization that owns the link. This prevents sibling companies under the
-- same root account from listing or managing one another's links.
UPDATE short_links link
SET organization_root_id = app_user.organization_id,
    updated_at = now()
FROM app_users app_user
WHERE app_user.email = link.owner_email
  AND app_user.organization_id IS NOT NULL
  AND link.organization_root_id IS DISTINCT FROM app_user.organization_id;

INSERT INTO project_boards (name, owner_email, is_default, created_at, updated_at)
SELECT 'CRM Board', app_user.email, false, now(), now()
FROM app_users app_user
WHERE app_user.status IN ('invited', 'active')
  AND app_user.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_boards existing
    WHERE existing.owner_email = app_user.email
      AND lower(btrim(existing.name)) = 'crm board'
  )
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_owner_crm_board
  ON project_boards (owner_email)
  WHERE lower(btrim(name)) = 'crm board';

WITH organization_pipeline AS (
  SELECT DISTINCT ON (pipeline.workspace_organization_id)
    pipeline.workspace_organization_id,
    pipeline.id AS pipeline_id
  FROM pipeline_spaces pipeline
  WHERE pipeline.workspace_organization_id IS NOT NULL
  ORDER BY
    pipeline.workspace_organization_id,
    EXISTS (
      SELECT 1 FROM crm_board_projections existing
      WHERE existing.pipeline_id = pipeline.id
    ) DESC,
    pipeline.is_default DESC,
    pipeline.created_at,
    pipeline.id
)
INSERT INTO crm_board_projections (
  board_id, pipeline_id, workspace_organization_id, created_at, updated_at
)
SELECT board.id, organization_pipeline.pipeline_id, app_user.organization_id, now(), now()
FROM app_users app_user
JOIN project_boards board
  ON board.owner_email = app_user.email
 AND lower(btrim(board.name)) = 'crm board'
JOIN organization_pipeline
  ON organization_pipeline.workspace_organization_id = app_user.organization_id
WHERE app_user.status IN ('invited', 'active')
ON CONFLICT (board_id) DO UPDATE SET
  pipeline_id = EXCLUDED.pipeline_id,
  workspace_organization_id = EXCLUDED.workspace_organization_id,
  updated_at = now();

DELETE FROM tasks task
USING crm_board_cards card, crm_board_projections projection
WHERE card.task_id = task.id
  AND projection.board_id = card.board_id
  AND card.pipeline_id <> projection.pipeline_id
  AND task.source = 'crm-projection';

INSERT INTO pipeline_space_members (
  pipeline_id, user_email, access_role, shared_by, created_at, updated_at
)
SELECT projection.pipeline_id, board.owner_email, 'editor', pipeline.owner_email, now(), now()
FROM crm_board_projections projection
JOIN project_boards board ON board.id = projection.board_id
JOIN pipeline_spaces pipeline ON pipeline.id = projection.pipeline_id
WHERE board.owner_email <> pipeline.owner_email
ON CONFLICT (pipeline_id, user_email) DO UPDATE SET
  access_role = 'editor',
  shared_by = EXCLUDED.shared_by,
  updated_at = now();

CREATE OR REPLACE FUNCTION validate_crm_board_projection_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  board_organization uuid;
  pipeline_organization uuid;
BEGIN
  SELECT app_user.organization_id INTO board_organization
  FROM project_boards board
  JOIN app_users app_user ON app_user.email = board.owner_email
  WHERE board.id = NEW.board_id;

  SELECT workspace_organization_id INTO pipeline_organization
  FROM pipeline_spaces
  WHERE id = NEW.pipeline_id;

  IF board_organization IS NULL
    OR pipeline_organization IS NULL
    OR board_organization <> NEW.workspace_organization_id
    OR pipeline_organization <> NEW.workspace_organization_id
  THEN
    RAISE EXCEPTION 'CRM board, account, and pipeline must share an organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_board_projection_scope ON crm_board_projections;
CREATE TRIGGER trg_validate_crm_board_projection_scope
BEFORE INSERT OR UPDATE OF board_id, pipeline_id, workspace_organization_id
ON crm_board_projections
FOR EACH ROW EXECUTE FUNCTION validate_crm_board_projection_scope();

CREATE OR REPLACE FUNCTION validate_crm_board_card_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  task_source text;
  scoped_organization uuid;
BEGIN
  SELECT projection.workspace_organization_id INTO scoped_organization
  FROM crm_board_projections projection
  WHERE projection.board_id = NEW.board_id
    AND projection.pipeline_id = NEW.pipeline_id;
  IF scoped_organization IS NULL THEN
    RAISE EXCEPTION 'CRM card board and pipeline are not bound';
  END IF;

  SELECT source INTO task_source
  FROM tasks
  WHERE id = NEW.task_id AND board_id = NEW.board_id;
  IF task_source IS NULL OR task_source <> 'crm-projection' THEN
    RAISE EXCEPTION 'CRM card task is missing or is not a CRM projection';
  END IF;

  IF NEW.entity_type = 'organizations' AND NOT EXISTS (
    WITH RECURSIVE visible_organizations AS (
      SELECT organization.id, ARRAY[organization.id] AS path
      FROM crm_organizations organization
      WHERE organization.pipeline_id = NEW.pipeline_id
        AND organization.workspace_organization_id = scoped_organization
      UNION ALL
      SELECT child.id, parent.path || child.id
      FROM crm_organizations child
      JOIN visible_organizations parent ON child.parent_organization_id = parent.id
      WHERE child.pipeline_id = NEW.pipeline_id
        AND NOT child.id = ANY(parent.path)
    )
    SELECT 1
    FROM visible_organizations visible
    JOIN crm_organizations organization ON organization.id = visible.id
    WHERE organization.id = NEW.entity_id
      AND organization.reference_code = NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'CRM organization card is outside the board account graph';
  ELSIF NEW.entity_type = 'contacts' AND NOT EXISTS (
    WITH RECURSIVE visible_organizations AS (
      SELECT organization.id, ARRAY[organization.id] AS path
      FROM crm_organizations organization
      WHERE organization.pipeline_id = NEW.pipeline_id
        AND organization.workspace_organization_id = scoped_organization
      UNION ALL
      SELECT child.id, parent.path || child.id
      FROM crm_organizations child
      JOIN visible_organizations parent ON child.parent_organization_id = parent.id
      WHERE child.pipeline_id = NEW.pipeline_id
        AND NOT child.id = ANY(parent.path)
    )
    SELECT 1
    FROM crm_contacts contact
    JOIN visible_organizations visible ON visible.id = contact.organization_id
    WHERE contact.id = NEW.entity_id
      AND contact.pipeline_id = NEW.pipeline_id
      AND contact.reference_code = NEW.reference_code
  ) THEN
    RAISE EXCEPTION 'CRM contact card is outside the board account graph';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_crm_board_card_scope ON crm_board_cards;
CREATE TRIGGER trg_validate_crm_board_card_scope
BEFORE INSERT OR UPDATE OF board_id, pipeline_id, task_id, entity_type, entity_id, reference_code
ON crm_board_cards
FOR EACH ROW EXECUTE FUNCTION validate_crm_board_card_scope();
