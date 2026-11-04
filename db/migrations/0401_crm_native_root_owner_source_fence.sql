-- Operator ownership is authority even when all employees are app-only.
-- Preserve the retained employee rules; add only the missing owner source.
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid=to_regprocedure('public.clawpilot_crm_root_native_membership_is_independent(jsonb,jsonb)')
      AND encode(public.digest(p.prosrc,'sha256'),'hex')='1453d556e6f1d460a67ec83147ffbd91dd9347c5b560b92bdf092752e6a7aa20') THEN
    RAISE EXCEPTION 'Expected exact retained root membership classifier before owner correction' USING ERRCODE='55000';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_crm_root_native_membership_is_independent(old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; relevant boolean:=false; required_source boolean:=false;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
    IF candidate IS NULL THEN CONTINUE; END IF;
    -- Account ownership is a source in its own right. Do not infer that an
    -- owner is independent merely because its employees have no native IDs.
    -- Retained disabled account/binding intent is still pinned evidence.
    IF EXISTS(SELECT 1 FROM public.crm_operator_accounts a
      WHERE candidate->>'user_email'=a.owner_email
        AND (candidate->>'organization_id'=a.root_workspace_id::text
          OR EXISTS(SELECT 1 FROM public.crm_operator_workspace_bindings b
            WHERE b.operator_account_id=a.id AND b.workspace_id::text=candidate->>'organization_id'))) THEN
      relevant:=true;required_source:=true;
    END IF;
    -- Include retained disabled intent: it remains part of the exact source
    -- snapshot and must not be silently rewritten during an admitted action.
    IF EXISTS(SELECT 1 FROM public.crm_root_employee_access_grants g
      JOIN public.crm_operator_accounts a ON a.id=g.operator_account_id
      JOIN public.crm_operator_workspace_bindings b ON b.operator_account_id=a.id
      JOIN public.app_users employee ON employee.email=g.user_email
      WHERE employee.suitecrm_user_id IS NOT NULL
        AND ((candidate->>'user_email'=g.user_email AND candidate->>'organization_id' IN (g.source_workspace_id::text,b.workspace_id::text))
          OR (candidate->>'user_email'=a.owner_email AND candidate->>'organization_id' IN (a.root_workspace_id::text,b.workspace_id::text))))
      THEN relevant:=true; END IF;
    IF EXISTS(SELECT 1 FROM public.crm_root_employee_access_grants g
      JOIN public.crm_operator_accounts a ON a.id=g.operator_account_id
      JOIN public.app_users employee ON employee.email=g.user_email
      WHERE employee.suitecrm_user_id IS NOT NULL
        AND ((candidate->>'user_email'=g.user_email AND candidate->>'organization_id'=g.source_workspace_id::text)
          OR candidate->>'user_email'=a.owner_email)) THEN required_source:=true; END IF;
  END LOOP;
  IF NOT relevant THEN RETURN true; END IF;
  IF old_row IS NOT NULL AND new_row IS NOT NULL THEN
    RETURN (old_row->'user_email',old_row->'organization_id') IS NOT DISTINCT FROM
      (new_row->'user_email',new_row->'organization_id')
      AND public.clawpilot_crm_root_native_membership_state(old_row)
        IS NOT DISTINCT FROM public.clawpilot_crm_root_native_membership_state(new_row);
  END IF;
  -- An absent optional target membership already permits inherited reading.
  -- Adding an active CRM-enabled member preserves that exact read scope. A
  -- denied/trashed target must instead pass a native-first eligibility action.
  IF NOT required_source AND old_row IS NULL THEN
    RETURN public.clawpilot_crm_root_native_membership_state(new_row)=
      '{"valid":true,"active":true,"owner":false,"crm":true}'::jsonb;
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_root_native_membership_is_independent(jsonb,jsonb) FROM PUBLIC;
