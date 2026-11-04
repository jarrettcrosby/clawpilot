-- Enable computed root reads only from exact retained native execution proof.
-- This neither activates native policy nor enrolls any registry intent/user.
CREATE INDEX crm_native_authority_committed_receipt_lookup
  ON crm_native_email_authority_phases(receipt_hash) WHERE state='committed';

CREATE FUNCTION clawpilot_crm_root_native_pipeline_read(pipeline uuid,workspace uuid,native_user text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE evidence record; pair jsonb; binding jsonb; policy jsonb; entry jsonb;
  matched integer:=0; surface text; readers jsonb;
BEGIN
  IF native_user IS NULL OR native_user !~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}$'
    OR (SELECT count(*) FROM public.app_users u WHERE lower(u.suitecrm_user_id)=lower(native_user))<>1 THEN RETURN false; END IF;
  -- Control can point to a committed revoke while the app delta is pending.
  -- Its reduced reader matrix safely retains unaffected employees, but never
  -- grants the new/restored reader before a committed native grant. Ordinary
  -- publication does not change authority and need not log everyone out.
  SELECT p.command INTO STRICT evidence
  FROM public.crm_native_email_publication_control c
  JOIN public.crm_native_email_authority_phases p ON p.receipt_hash=c.activation_receipt_hash
  JOIN public.crm_native_email_authority_transitions t ON t.transition_id=p.transition_id
  WHERE c.singleton AND c.enabled AND c.verified_generation=c.generation
    AND p.state='committed' AND p.command->>'version'='2'
    AND p.command->>'generationTo'=c.generation::text
    AND p.command->>'afterPolicyFingerprint'=c.native_policy_fingerprint
    AND ((p.phase='grant' AND t.app_state='committed') OR
      (p.phase='revoke' AND c.active_transition_id=t.transition_id AND t.app_state IN ('prepared','applying','committed')));
  IF jsonb_typeof(evidence.command->'bindings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(evidence.command->'bindings')>100
    OR jsonb_typeof(evidence.command->'capabilities') IS DISTINCT FROM 'array'
    OR jsonb_array_length(evidence.command->'capabilities')>500 THEN RETURN false; END IF;
  FOR pair IN SELECT value FROM jsonb_array_elements(evidence.command->'bindings') LOOP
    IF pair->'after'->>'pipeline_id'<>pipeline::text THEN CONTINUE; END IF;
    matched:=matched+1; binding:=pair->'after';
    IF binding->>'workspace_id' IS DISTINCT FROM workspace::text OR binding->>'enabled' IS DISTINCT FROM '1'
      OR binding->>'generation' IS DISTINCT FROM evidence.command->>'generationTo' THEN RETURN false; END IF;
    readers:=(binding->>'readers_json')::jsonb;
    IF (jsonb_typeof(readers)='array' AND readers @> jsonb_build_array(native_user)) IS NOT TRUE THEN RETURN false; END IF;
    policy:=(binding->>'capability_policy_json')::jsonb;
    IF policy->>'version' IS DISTINCT FROM '2' OR policy->>'pipelineId' IS DISTINCT FROM pipeline::text
      OR policy->>'workspaceId' IS DISTINCT FROM workspace::text THEN RETURN false; END IF;
    FOREACH surface IN ARRAY ARRAY['view','list','export'] LOOP
      readers:=policy->'futureCreate'->surface;
      IF (jsonb_typeof(readers)='array' AND readers @> jsonb_build_array(native_user)) IS NOT TRUE THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  IF matched<>1 THEN RETURN false; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(evidence.command->'capabilities') LOOP
    IF entry->>'pipelineId'<>pipeline::text THEN CONTINUE; END IF;
    FOREACH surface IN ARRAY ARRAY['view','list','export'] LOOP
      readers:=entry->'after'->surface;
      IF (jsonb_typeof(readers)='array' AND readers @> jsonb_build_array(native_user)) IS NOT TRUE THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN no_data_found OR too_many_rows OR invalid_text_representation OR data_exception THEN
  -- A missing, ambiguous or malformed retained proof never supplies access.
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_root_native_pipeline_read(uuid,uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION clawpilot_crm_root_read_workspaces(employee_email text)
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
       AND (SELECT count(*) FROM public.app_users identity WHERE lower(identity.suitecrm_user_id)=lower(employee.suitecrm_user_id))=1))
    AND ((NOT control.enabled AND control.active_operation_id IS NULL AND control.active_transition_id IS NULL)
      OR (control.enabled AND control.verified_generation=control.generation
        AND (employee.suitecrm_user_id IS NULL OR NOT EXISTS(
          SELECT 1 FROM public.pipeline_spaces pipeline
          WHERE pipeline.workspace_organization_id=b.workspace_id AND NOT pipeline.reference_access_disabled
            AND NOT public.clawpilot_crm_root_native_pipeline_read(pipeline.id,b.workspace_id,employee.suitecrm_user_id)))))
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_root_read_workspaces(text) FROM PUBLIC;
