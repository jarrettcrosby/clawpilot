CREATE OR REPLACE FUNCTION pg_temp.decode_clawpilot_display_text(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  decoded text := value;
  previous text;
  pass integer;
BEGIN
  FOR pass IN 1..3 LOOP
    previous := decoded;
    decoded := replace(decoded, '&amp;', '&');
    decoded := replace(decoded, '&#039;', '''');
    decoded := replace(decoded, '&#39;', '''');
    decoded := replace(decoded, '&#x27;', '''');
    decoded := replace(decoded, '&#X27;', '''');
    decoded := replace(decoded, '&apos;', '''');
    decoded := replace(decoded, '&#034;', '"');
    decoded := replace(decoded, '&#34;', '"');
    decoded := replace(decoded, '&#x22;', '"');
    decoded := replace(decoded, '&#X22;', '"');
    decoded := replace(decoded, '&quot;', '"');
    decoded := replace(decoded, '&nbsp;', ' ');
    decoded := replace(decoded, '&lt;', '<');
    decoded := replace(decoded, '&gt;', '>');
    decoded := replace(decoded, '&ndash;', '-');
    decoded := replace(decoded, '&mdash;', '-');
    decoded := replace(decoded, '&hellip;', '...');
    EXIT WHEN decoded = previous;
  END LOOP;
  RETURN decoded;
END;
$$;

UPDATE workspace_organizations
SET name = pg_temp.decode_clawpilot_display_text(name),
    updated_at = now()
WHERE name ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE app_users
SET display_name = pg_temp.decode_clawpilot_display_text(display_name),
    updated_at = now()
WHERE display_name ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_organizations
SET name = pg_temp.decode_clawpilot_display_text(name),
    updated_at = now()
WHERE name ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_contacts
SET first_name = pg_temp.decode_clawpilot_display_text(first_name),
    last_name = pg_temp.decode_clawpilot_display_text(last_name),
    full_name = pg_temp.decode_clawpilot_display_text(full_name),
    updated_at = now()
WHERE concat_ws(' ', first_name, last_name, full_name) ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_leads
SET first_name = pg_temp.decode_clawpilot_display_text(first_name),
    last_name = pg_temp.decode_clawpilot_display_text(last_name),
    full_name = pg_temp.decode_clawpilot_display_text(full_name),
    company_name = pg_temp.decode_clawpilot_display_text(company_name),
    updated_at = now()
WHERE concat_ws(' ', first_name, last_name, full_name, company_name) ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_opportunities
SET name = pg_temp.decode_clawpilot_display_text(name),
    organization_name = pg_temp.decode_clawpilot_display_text(organization_name),
    updated_at = now()
WHERE concat_ws(' ', name, organization_name) ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_meetings
SET subject = pg_temp.decode_clawpilot_display_text(subject),
    updated_at = now()
WHERE subject ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_interactions
SET subject = pg_temp.decode_clawpilot_display_text(subject),
    updated_at = now()
WHERE subject ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

UPDATE crm_campaigns
SET name = pg_temp.decode_clawpilot_display_text(name),
    updated_at = now()
WHERE name ~* '&(#x?[0-9a-f]+|[a-z][a-z0-9]+);';

ALTER TABLE crm_board_cards
  ADD COLUMN card_id text,
  ADD COLUMN payload jsonb;

UPDATE crm_board_cards card
SET card_id = task.id,
    payload = jsonb_set(
      jsonb_set(
        jsonb_set(
          (task.payload - 'assignedAgent' - 'assignee' - 'dueDate' - 'execution' - 'workItem' - 'workstream' - 'outcomeStatement')
            || jsonb_build_object(
              'title', pg_temp.decode_clawpilot_display_text(task.title),
              'category', 'crm',
              'checklist', '[]'::jsonb
            ),
          '{crm,recordName}',
          to_jsonb(pg_temp.decode_clawpilot_display_text(COALESCE(task.payload #>> '{crm,recordName}', ''))),
          true
        ),
        '{crm,accountName}',
        to_jsonb(pg_temp.decode_clawpilot_display_text(COALESCE(task.payload #>> '{crm,accountName}', ''))),
        true
      ),
      '{crm,description}',
      to_jsonb(COALESCE(task.payload #>> '{crm,description}', '')),
      true
    )
FROM tasks task
WHERE task.id = card.task_id
  AND task.board_id = card.board_id
  AND task.source = 'crm-projection';

ALTER TABLE crm_board_cards
  ALTER COLUMN card_id SET NOT NULL,
  ALTER COLUMN payload SET NOT NULL,
  ADD CONSTRAINT crm_board_cards_card_id_unique UNIQUE (card_id);

DELETE FROM agent_assignments assignment
USING tasks task
WHERE assignment.task_id = task.id
  AND task.source = 'crm-projection';

DROP TRIGGER IF EXISTS trg_validate_crm_board_card_scope ON crm_board_cards;

ALTER TABLE crm_board_cards DROP COLUMN task_id;

CREATE OR REPLACE FUNCTION validate_crm_board_card_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scoped_organization uuid;
BEGIN
  SELECT projection.workspace_organization_id INTO scoped_organization
  FROM crm_board_projections projection
  WHERE projection.board_id = NEW.board_id
    AND projection.pipeline_id = NEW.pipeline_id;
  IF scoped_organization IS NULL THEN
    RAISE EXCEPTION 'CRM card board and pipeline are not bound';
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

CREATE TRIGGER trg_validate_crm_board_card_scope
BEFORE INSERT OR UPDATE OF board_id, pipeline_id, entity_type, entity_id, reference_code
ON crm_board_cards
FOR EACH ROW EXECUTE FUNCTION validate_crm_board_card_scope();

DELETE FROM tasks
WHERE source = 'crm-projection';
