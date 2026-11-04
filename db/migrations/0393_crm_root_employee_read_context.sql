-- Computed root CRM reads never manufacture workspace/resource memberships.
-- Keep the existing session -> actual membership FK. A delegated CRM context
-- retains that source membership and independently validates its target.
CREATE FUNCTION clawpilot_crm_root_read_workspaces(employee_email text)
RETURNS TABLE(workspace_id uuid,source_workspace_id uuid,grant_id uuid,projects_allowed boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT b.workspace_id,g.source_workspace_id,g.id,
    (source.role='owner' OR COALESCE(source.permissions->'viewProjects','true'::jsonb)='true'::jsonb)
      AND (target.user_email IS NULL OR target.role='owner'
        OR COALESCE(target.permissions->'viewProjects','true'::jsonb)='true'::jsonb)
  FROM public.crm_root_employee_access_grants g
  JOIN public.crm_operator_accounts a ON a.id=g.operator_account_id
  JOIN public.crm_operator_workspace_bindings b ON b.operator_account_id=a.id
  JOIN public.workspace_organizations root ON root.id=a.root_workspace_id
  JOIN public.workspace_organizations business ON business.id=b.workspace_id
  JOIN public.app_users operator ON operator.email=a.owner_email
  JOIN public.app_users employee ON employee.email=g.user_email
  JOIN public.app_user_organization_memberships source
    ON source.user_email=g.user_email AND source.organization_id=g.source_workspace_id
  JOIN public.app_user_organization_memberships root_owner
    ON root_owner.user_email=a.owner_email AND root_owner.organization_id=a.root_workspace_id
  JOIN public.app_user_organization_memberships business_owner
    ON business_owner.user_email=a.owner_email AND business_owner.organization_id=b.workspace_id
  LEFT JOIN public.app_user_organization_memberships target
    ON target.user_email=g.user_email AND target.organization_id=b.workspace_id
  JOIN public.crm_native_email_publication_control control ON control.singleton
  WHERE g.user_email=employee_email AND g.user_email<>a.owner_email
    AND g.source_workspace_id=a.root_workspace_id AND b.owner_email=a.owner_email
    AND a.enabled AND b.enabled AND g.enabled
    AND root.parent_id IS NULL AND root.organization_type='root' AND NOT root.is_demo AND NOT business.is_demo
    AND operator.status='active' AND employee.status='active'
    AND root_owner.role='owner' AND root_owner.status='active' AND root_owner.trashed_at IS NULL
    AND business_owner.role='owner' AND business_owner.status='active' AND business_owner.trashed_at IS NULL
    AND source.status='active' AND source.trashed_at IS NULL
    AND (source.role='owner' OR COALESCE(source.permissions->'viewCrm','true'::jsonb)='true'::jsonb)
    AND (target.user_email IS NULL OR (target.status='active' AND target.trashed_at IS NULL
      AND (target.role='owner' OR COALESCE(target.permissions->'viewCrm','true'::jsonb)='true'::jsonb)))
    AND jsonb_typeof(source.permissions)='object'
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(source.permissions) permission WHERE jsonb_typeof(permission.value)<>'boolean')
    AND (target.user_email IS NULL OR (jsonb_typeof(target.permissions)='object'
      AND NOT EXISTS(SELECT 1 FROM jsonb_each(target.permissions) permission WHERE jsonb_typeof(permission.value)<>'boolean')))
    AND (employee.suitecrm_user_id IS NULL OR
      (employee.suitecrm_user_id ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}$'
       AND (SELECT count(*) FROM public.app_users identity WHERE identity.suitecrm_user_id=employee.suitecrm_user_id)=1))
    -- Root native audience transitions are not wired yet. Do not silently
    -- grant root app visibility when the native policy is already activated.
    AND NOT control.enabled AND control.active_operation_id IS NULL AND control.active_transition_id IS NULL
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_root_read_workspaces(text) FROM PUBLIC;

-- Ordinary membership rows always take precedence, including explicit denied,
-- disabled or trashed rows. This function does not rewrite manual permissions.
CREATE FUNCTION clawpilot_effective_workspace_memberships(employee_email text)
RETURNS TABLE(user_email text,organization_id uuid,role text,permissions jsonb,status text,
  is_default boolean,created_at timestamptz,updated_at timestamptz,access_origin text,source_workspace_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT m.user_email,m.organization_id,m.role,m.permissions,m.status,m.is_default,m.created_at,m.updated_at,
    'membership'::text,m.organization_id
  FROM public.app_user_organization_memberships m WHERE m.user_email=employee_email
  UNION ALL
  SELECT employee_email,access.workspace_id,'member'::text,
    jsonb_build_object('viewCrm',true,'viewProjects',access.projects_allowed),'active'::text,
    false,g.created_at,g.updated_at,'root_crm'::text,access.source_workspace_id
  FROM public.clawpilot_crm_root_read_workspaces(employee_email) access
  JOIN public.crm_root_employee_access_grants g ON g.id=access.grant_id
  WHERE NOT EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
    WHERE m.user_email=employee_email AND m.organization_id=access.workspace_id)
$$;
REVOKE ALL ON FUNCTION clawpilot_effective_workspace_memberships(text) FROM PUBLIC;

ALTER TABLE app_sessions ADD COLUMN crm_view_workspace_organization_id uuid
  REFERENCES workspace_organizations(id) ON DELETE RESTRICT;
COMMENT ON COLUMN app_sessions.crm_view_workspace_organization_id IS
  'Optional computed CRM-only target. active_workspace_organization_id remains its actual root membership and FK.';
CREATE INDEX app_sessions_crm_view_workspace ON app_sessions(crm_view_workspace_organization_id,effective_user_email)
  WHERE revoked_at IS NULL AND crm_view_workspace_organization_id IS NOT NULL;

CREATE FUNCTION clawpilot_crm_root_session_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Browser session revocation is permanent' USING ERRCODE='42501';
  END IF;
  IF NEW.revoked_at IS NULL AND NEW.crm_view_workspace_organization_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.clawpilot_crm_root_read_workspaces(NEW.effective_user_email) access
    WHERE access.workspace_id=NEW.crm_view_workspace_organization_id
      AND access.source_workspace_id=NEW.active_workspace_organization_id
  ) THEN RAISE EXCEPTION 'Root CRM session context is not authorized' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_root_session_guard BEFORE INSERT OR UPDATE OF effective_user_email,
  active_workspace_organization_id,crm_view_workspace_organization_id,revoked_at ON app_sessions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_session_guard();
-- Take control before session row locks, including old/direct SQL writers.
-- This prevents a concurrent grant revocation from missing a late-issued
-- delegated token which could otherwise come back to life after restoration.
CREATE TRIGGER crm_root_session_statement_lock BEFORE INSERT OR UPDATE OF effective_user_email,
  active_workspace_organization_id,crm_view_workspace_organization_id ON app_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
-- Revocation is denial-only and must not acquire control after a credential
-- change has already locked its user. The row guard forbids un-revocation.
REVOKE ALL ON FUNCTION clawpilot_crm_root_session_guard() FROM PUBLIC;

-- Revoke, never silently re-parent or resurrect, delegated sessions when their
-- source/target eligibility disappears. Ordinary sessions are untouched.
CREATE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.app_sessions session SET revoked_at=now(),revoked_reason='crm_root_access_revoked'
  WHERE session.revoked_at IS NULL AND session.crm_view_workspace_organization_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.clawpilot_crm_root_read_workspaces(session.effective_user_email) access
      WHERE access.workspace_id=session.crm_view_workspace_organization_id
        AND access.source_workspace_id=session.active_workspace_organization_id);
  RETURN NULL;
END $$;
CREATE TRIGGER crm_root_account_sessions AFTER INSERT OR UPDATE OR DELETE ON crm_operator_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_binding_sessions AFTER INSERT OR UPDATE OR DELETE ON crm_operator_workspace_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_grant_sessions AFTER INSERT OR UPDATE OR DELETE ON crm_root_employee_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_membership_sessions AFTER INSERT OR DELETE ON app_user_organization_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_membership_changed_sessions AFTER UPDATE ON app_user_organization_memberships
  FOR EACH ROW WHEN (OLD.user_email IS DISTINCT FROM NEW.user_email
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.role IS DISTINCT FROM NEW.role
    OR OLD.status IS DISTINCT FROM NEW.status OR OLD.trashed_at IS DISTINCT FROM NEW.trashed_at
    OR OLD.permissions IS DISTINCT FROM NEW.permissions)
  EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_user_sessions AFTER DELETE ON app_users
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_user_changed_sessions AFTER UPDATE ON app_users
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.suitecrm_user_id IS DISTINCT FROM NEW.suitecrm_user_id)
  EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_workspace_sessions AFTER DELETE ON workspace_organizations
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_workspace_changed_sessions AFTER UPDATE ON workspace_organizations
  FOR EACH ROW WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id
    OR OLD.organization_type IS DISTINCT FROM NEW.organization_type OR OLD.is_demo IS DISTINCT FROM NEW.is_demo)
  EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
CREATE TRIGGER crm_root_control_sessions AFTER UPDATE ON crm_native_email_publication_control
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_revoke_ineligible_sessions();
REVOKE ALL ON FUNCTION clawpilot_crm_root_revoke_ineligible_sessions() FROM PUBLIC;
