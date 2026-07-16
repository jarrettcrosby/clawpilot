ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION clawpilot_scope_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scoped_organization_id uuid;
  scoped_organization_text text;
  scoped_pipeline_id text;
  scoped_board_id text;
BEGIN
  NEW.subject := COALESCE(NULLIF(NEW.subject, ''), NULLIF(NEW.payload->>'subject', ''), NEW.actor);

  scoped_organization_text := NULLIF(NEW.payload->>'organizationId', '');
  IF NEW.organization_id IS NULL
    AND scoped_organization_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    NEW.organization_id := scoped_organization_text::uuid;
  END IF;

  IF NEW.organization_id IS NULL THEN
    SELECT app_user.organization_id INTO scoped_organization_id
    FROM app_users app_user
    WHERE lower(app_user.email) = lower(COALESCE(NEW.actor, NEW.subject, ''))
    LIMIT 1;
    NEW.organization_id := scoped_organization_id;
  END IF;

  scoped_pipeline_id := COALESCE(
    NULLIF(NEW.payload->>'pipelineId', ''),
    CASE WHEN NEW.aggregate_type = 'pipeline_space' THEN NEW.aggregate_id END
  );
  IF NEW.organization_id IS NULL
    AND scoped_pipeline_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT pipeline.workspace_organization_id INTO scoped_organization_id
    FROM pipeline_spaces pipeline
    WHERE pipeline.id = scoped_pipeline_id::uuid
    LIMIT 1;
    NEW.organization_id := scoped_organization_id;
  END IF;

  scoped_board_id := NULLIF(NEW.payload->>'boardId', '');
  IF NEW.organization_id IS NULL
    AND scoped_board_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT app_user.organization_id INTO scoped_organization_id
    FROM project_boards board
    JOIN app_users app_user ON app_user.email = board.owner_email
    WHERE board.id = scoped_board_id::uuid
    LIMIT 1;
    NEW.organization_id := scoped_organization_id;
  END IF;

  NEW.is_system := NEW.is_system
    OR NEW.event_type LIKE 'system.%'
    OR NEW.event_type LIKE 'pipeline.sync.%'
    OR NEW.event_type LIKE 'agent.dispatch.succeeded%'
    OR NEW.event_type LIKE 'agent.dispatch.failed%'
    OR NEW.event_type LIKE 'agent.dispatch.dead%'
    OR NEW.event_type LIKE 'crm.integration_action.leased%'
    OR NEW.event_type LIKE 'crm.integration_action.succeeded%'
    OR NEW.event_type LIKE 'crm.integration_action.failed%'
    OR NEW.event_type LIKE 'crm.integration_action.dead%'
    OR NEW.event_type LIKE 'checkpoint.%'
    OR NEW.event_type LIKE 'release.%';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clawpilot_scope_audit_event ON audit_events;
CREATE TRIGGER trg_clawpilot_scope_audit_event
BEFORE INSERT ON audit_events
FOR EACH ROW
EXECUTE FUNCTION clawpilot_scope_audit_event();

UPDATE audit_events event
SET subject = COALESCE(event.subject, event.actor),
    organization_id = COALESCE(event.organization_id, actor_user.organization_id),
    is_system = event.is_system
      OR event.event_type LIKE 'system.%'
      OR event.event_type LIKE 'pipeline.sync.%'
      OR event.event_type LIKE 'agent.dispatch.succeeded%'
      OR event.event_type LIKE 'agent.dispatch.failed%'
      OR event.event_type LIKE 'agent.dispatch.dead%'
      OR event.event_type LIKE 'crm.integration_action.leased%'
      OR event.event_type LIKE 'crm.integration_action.succeeded%'
      OR event.event_type LIKE 'crm.integration_action.failed%'
      OR event.event_type LIKE 'crm.integration_action.dead%'
      OR event.event_type LIKE 'checkpoint.%'
      OR event.event_type LIKE 'release.%'
FROM app_users actor_user
WHERE lower(actor_user.email) = lower(event.actor);

UPDATE audit_events
SET is_system = true
WHERE event_type LIKE 'system.%'
   OR event_type LIKE 'pipeline.sync.%'
   OR event_type LIKE 'agent.dispatch.succeeded%'
   OR event_type LIKE 'agent.dispatch.failed%'
   OR event_type LIKE 'agent.dispatch.dead%'
   OR event_type LIKE 'crm.integration_action.leased%'
   OR event_type LIKE 'crm.integration_action.succeeded%'
   OR event_type LIKE 'crm.integration_action.failed%'
   OR event_type LIKE 'crm.integration_action.dead%'
   OR event_type LIKE 'checkpoint.%'
   OR event_type LIKE 'release.%';

UPDATE audit_events event
SET organization_id = pipeline.workspace_organization_id
FROM pipeline_spaces pipeline
WHERE event.organization_id IS NULL
  AND pipeline.id::text = COALESCE(
    NULLIF(event.payload->>'pipelineId', ''),
    CASE WHEN event.aggregate_type = 'pipeline_space' THEN event.aggregate_id END
  );

UPDATE audit_events event
SET organization_id = owner_user.organization_id
FROM project_boards board
JOIN app_users owner_user ON owner_user.email = board.owner_email
WHERE event.organization_id IS NULL
  AND board.id::text = event.payload->>'boardId';

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_time
  ON audit_events (lower(actor), created_at DESC)
  WHERE actor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject_time
  ON audit_events (lower(subject), created_at DESC)
  WHERE subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_organization_time
  ON audit_events (organization_id, created_at DESC, id DESC)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_system_time
  ON audit_events (created_at DESC, id DESC)
  WHERE is_system;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_event_key
  ON audit_events (event_key)
  WHERE event_key IS NOT NULL;

INSERT INTO audit_events (
  actor, event_type, aggregate_type, aggregate_id, payload, event_key, created_at
)
SELECT
  COALESCE(NULLIF(activity.event->>'actor', ''), 'system'),
  'project.task.' || regexp_replace(lower(COALESCE(activity.event->>'type', 'updated')), '[^a-z0-9]+', '_', 'g'),
  'project_task',
  task.id,
  jsonb_strip_nulls(jsonb_build_object(
    'boardId', task.board_id::text,
    'taskId', task.id,
    'taskTitle', task.title,
    'activityOrdinal', activity.ordinal,
    'occurredAt', CASE
      WHEN COALESCE(activity.event->>'timestamp', '') ~ '^\d{4}-\d{2}-\d{2}T'
        THEN (activity.event->>'timestamp')::timestamptz
      ELSE task.updated_at
    END,
    'message', activity.event->>'message',
    'from', activity.event->>'from',
    'to', activity.event->>'to',
    'commentId', activity.event->>'commentId'
  )),
  'project-task:' || task.board_id::text || ':' || task.id || ':' || (activity.ordinal - 1)::text,
  CASE
    WHEN COALESCE(activity.event->>'timestamp', '') ~ '^\d{4}-\d{2}-\d{2}T'
      THEN (activity.event->>'timestamp')::timestamptz
    ELSE task.updated_at
  END
FROM tasks task
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(task.payload->'activity', '[]'::jsonb))
  WITH ORDINALITY AS activity(event, ordinal)
WHERE task.board_id IS NOT NULL
ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
