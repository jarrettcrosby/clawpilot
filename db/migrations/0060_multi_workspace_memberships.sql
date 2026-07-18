CREATE TABLE IF NOT EXISTS app_user_organization_memberships (
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  permissions jsonb NOT NULL DEFAULT '{"inviteUsers":false,"manageUserAccess":false,"createBoards":true,"createPipelines":true,"viewFullReleaseHistory":false,"manageBackups":false,"manageLinks":false,"viewOrganizationAudit":false,"viewSystemAudit":false}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  is_default boolean NOT NULL DEFAULT false,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_organization_memberships_default
  ON app_user_organization_memberships (user_email)
  WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_app_user_organization_memberships_organization
  ON app_user_organization_memberships (organization_id, status, role, user_email);

-- Preserve the current tenant assignment as each person's default membership.
-- No tenant-owned record is moved by this backfill.
INSERT INTO app_user_organization_memberships (
  user_email, organization_id, role, permissions, status, is_default,
  created_by, updated_by, created_at, updated_at
)
SELECT
  app_user.email,
  app_user.organization_id,
  app_user.role,
  app_user.permissions,
  app_user.status,
  true,
  COALESCE(app_user.invited_by, app_user.email),
  app_user.email,
  app_user.created_at,
  now()
FROM app_users app_user
WHERE app_user.organization_id IS NOT NULL
ON CONFLICT (user_email, organization_id) DO UPDATE SET
  role = EXCLUDED.role,
  permissions = EXCLUDED.permissions,
  status = EXCLUDED.status,
  is_default = true,
  updated_by = EXCLUDED.updated_by,
  updated_at = now();

ALTER TABLE project_boards
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT;

UPDATE project_boards board
SET workspace_organization_id = projection.workspace_organization_id,
    updated_at = now()
FROM crm_board_projections projection
WHERE projection.board_id = board.id
  AND board.workspace_organization_id IS NULL;

UPDATE project_boards board
SET workspace_organization_id = app_user.organization_id,
    updated_at = now()
FROM app_users app_user
WHERE app_user.email = board.owner_email
  AND board.workspace_organization_id IS NULL
  AND app_user.organization_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_boards WHERE workspace_organization_id IS NULL) THEN
    RAISE EXCEPTION 'Every project board must resolve to a workspace organization before migration 0060';
  END IF;
  IF EXISTS (SELECT 1 FROM pipeline_spaces WHERE workspace_organization_id IS NULL) THEN
    RAISE EXCEPTION 'Every pipeline must resolve to a workspace organization before migration 0060';
  END IF;
END;
$$;

ALTER TABLE project_boards
  ALTER COLUMN workspace_organization_id SET NOT NULL;

ALTER TABLE pipeline_spaces
  ALTER COLUMN workspace_organization_id SET NOT NULL;

DROP INDEX IF EXISTS idx_project_boards_default_owner;
DROP INDEX IF EXISTS idx_project_boards_owner_crm_board;
DROP INDEX IF EXISTS idx_pipeline_spaces_default_owner;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_default_owner_workspace
  ON project_boards (owner_email, workspace_organization_id)
  WHERE is_default;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_boards_owner_workspace_crm_board
  ON project_boards (owner_email, workspace_organization_id)
  WHERE lower(btrim(name)) = 'crm board';

CREATE INDEX IF NOT EXISTS idx_project_boards_workspace_updated
  ON project_boards (workspace_organization_id, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_spaces_default_owner_workspace
  ON pipeline_spaces (owner_email, workspace_organization_id)
  WHERE is_default;

ALTER TABLE app_documents
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE CASCADE;

UPDATE app_documents document
SET workspace_organization_id = board.workspace_organization_id,
    updated_at = now()
FROM project_boards board
WHERE document.board_id = board.id
  AND document.workspace_organization_id IS NULL;

UPDATE app_documents document
SET workspace_organization_id = pipeline.workspace_organization_id,
    updated_at = now()
FROM pipeline_spaces pipeline
WHERE document.pipeline_id = pipeline.id
  AND document.workspace_organization_id IS NULL;

UPDATE app_documents document
SET workspace_organization_id = membership.organization_id,
    updated_at = now()
FROM app_user_organization_memberships membership
WHERE membership.user_email = document.owner_email
  AND membership.is_default
  AND document.workspace_organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_documents WHERE workspace_organization_id IS NULL) THEN
    RAISE EXCEPTION 'Every document must resolve to a workspace organization before migration 0060';
  END IF;
END;
$$;

ALTER TABLE app_documents
  ALTER COLUMN workspace_organization_id SET NOT NULL;

ALTER TABLE app_documents
  DROP CONSTRAINT IF EXISTS app_documents_owner_email_source_key_key,
  DROP CONSTRAINT IF EXISTS app_documents_owner_email_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_documents_owner_workspace_source
  ON app_documents (owner_email, workspace_organization_id, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_documents_owner_workspace_slug
  ON app_documents (owner_email, workspace_organization_id, slug);

CREATE INDEX IF NOT EXISTS idx_app_documents_workspace_updated
  ON app_documents (workspace_organization_id, owner_email, updated_at DESC);

ALTER TABLE app_user_workspace_preferences
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE CASCADE;

UPDATE app_user_workspace_preferences preference
SET workspace_organization_id = app_user.organization_id,
    updated_at = now()
FROM app_users app_user
WHERE app_user.email = preference.user_email
  AND preference.workspace_organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_user_workspace_preferences
    WHERE workspace_organization_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every dashboard preference must resolve to a workspace organization before migration 0060';
  END IF;
END;
$$;

ALTER TABLE app_user_workspace_preferences
  ALTER COLUMN workspace_organization_id SET NOT NULL;

ALTER TABLE app_user_workspace_preferences
  DROP CONSTRAINT IF EXISTS app_user_workspace_preferences_pkey;

ALTER TABLE app_user_workspace_preferences
  ADD CONSTRAINT app_user_workspace_preferences_pkey
    PRIMARY KEY (user_email, workspace_organization_id);

ALTER TABLE app_sessions
  ADD COLUMN IF NOT EXISTS active_workspace_organization_id uuid,
  ADD COLUMN IF NOT EXISTS active_workspace_switched_at timestamptz NOT NULL DEFAULT now();

UPDATE app_sessions session
SET active_workspace_organization_id = membership.organization_id,
    active_workspace_switched_at = now()
FROM app_user_organization_memberships membership
WHERE membership.user_email = session.effective_user_email
  AND membership.is_default
  AND session.active_workspace_organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app_sessions WHERE active_workspace_organization_id IS NULL) THEN
    RAISE EXCEPTION 'Every browser session must resolve to an active workspace before migration 0060';
  END IF;
END;
$$;

ALTER TABLE app_sessions
  ALTER COLUMN active_workspace_organization_id SET NOT NULL;

ALTER TABLE app_sessions
  DROP CONSTRAINT IF EXISTS app_sessions_active_workspace_membership_fkey;

ALTER TABLE app_sessions
  ADD CONSTRAINT app_sessions_active_workspace_membership_fkey
    FOREIGN KEY (effective_user_email, active_workspace_organization_id)
    REFERENCES app_user_organization_memberships (user_email, organization_id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_app_sessions_active_workspace
  ON app_sessions (active_workspace_organization_id, effective_user_email, last_seen_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE agent_context_memories
  ADD COLUMN IF NOT EXISTS organization_id uuid
    REFERENCES workspace_organizations(id) ON DELETE CASCADE;

UPDATE agent_context_memories memory
SET organization_id = membership.organization_id,
    updated_at = now()
FROM app_user_organization_memberships membership
WHERE memory.scope = 'operator'
  AND memory.operator_id = membership.user_email
  AND membership.is_default
  AND memory.organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_context_memories
    WHERE scope = 'operator' AND organization_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Every private agent memory must resolve to a workspace organization before migration 0060';
  END IF;
END;
$$;

ALTER TABLE agent_context_memories
  DROP CONSTRAINT IF EXISTS agent_context_memories_scope_owner;

ALTER TABLE agent_context_memories
  ADD CONSTRAINT agent_context_memories_scope_owner CHECK (
    (scope = 'operator' AND operator_id IS NOT NULL AND organization_id IS NOT NULL)
    OR (scope = 'shared' AND operator_id IS NULL AND organization_id IS NULL)
  );

ALTER TABLE agent_context_memories
  DROP CONSTRAINT IF EXISTS agent_context_memories_agent_id_scope_identity_key_content_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_context_memories_workspace_identity
  ON agent_context_memories (agent_id, scope, identity_key, organization_id, content_hash)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_agent_context_memories_workspace_prompt
  ON agent_context_memories (organization_id, operator_id, agent_id, status, updated_at DESC);

CREATE OR REPLACE FUNCTION validate_crm_board_projection_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  board_organization uuid;
  pipeline_organization uuid;
BEGIN
  SELECT workspace_organization_id INTO board_organization
  FROM project_boards
  WHERE id = NEW.board_id;

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

  scoped_board_id := COALESCE(
    NULLIF(NEW.payload->>'boardId', ''),
    CASE WHEN NEW.aggregate_type = 'project_board' THEN NEW.aggregate_id END
  );
  IF NEW.organization_id IS NULL
    AND scoped_board_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT board.workspace_organization_id INTO scoped_organization_id
    FROM project_boards board
    WHERE board.id = scoped_board_id::uuid
    LIMIT 1;
    NEW.organization_id := scoped_organization_id;
  END IF;

  IF NEW.organization_id IS NULL THEN
    SELECT membership.organization_id INTO scoped_organization_id
    FROM app_user_organization_memberships membership
    WHERE lower(membership.user_email) = lower(COALESCE(NEW.actor, NEW.subject, ''))
      AND membership.is_default
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
