-- Root intent participates in the native audience even without a physical
-- pipeline share. Legacy "unshared workspace" and settings exceptions must
-- not bypass a required native-first revocation. No policy is activated here.
CREATE FUNCTION clawpilot_crm_root_native_membership_state(row_json jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE valid boolean;
BEGIN
  IF row_json IS NULL THEN RETURN NULL; END IF;
  valid:=(row_json->>'role' IN ('owner','admin','member')
    AND row_json->>'status' IN ('active','invited','disabled')
    AND jsonb_typeof(row_json->'permissions')='object'
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(row_json->'permissions')='object'
      THEN row_json->'permissions' ELSE '{}'::jsonb END) permission WHERE jsonb_typeof(permission.value)<>'boolean')) IS TRUE;
  RETURN jsonb_build_object('valid',valid,'active',row_json->>'status'='active' AND row_json->'trashed_at'='null'::jsonb,
    'owner',row_json->>'role'='owner','crm',row_json->>'role'='owner'
      OR COALESCE(row_json->'permissions'->'viewCrm','true'::jsonb)='true'::jsonb);
END $$;

CREATE FUNCTION clawpilot_crm_root_native_membership_is_independent(old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; relevant boolean:=false; required_source boolean:=false;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
    IF candidate IS NULL THEN CONTINUE; END IF;
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

CREATE FUNCTION clawpilot_crm_native_root_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  active boolean; transition text; operation text; affected boolean;
BEGIN
  IF TG_TABLE_NAME='app_user_organization_memberships' THEN
    affected:=NOT public.clawpilot_crm_root_native_membership_is_independent(old_row,new_row);
  ELSIF TG_TABLE_NAME='workspace_organizations' THEN
    affected:=(old_row->'id',old_row->'parent_id',old_row->'organization_type',old_row->'is_demo') IS DISTINCT FROM
      (new_row->'id',new_row->'parent_id',new_row->'organization_type',new_row->'is_demo')
      AND (EXISTS(SELECT 1 FROM public.crm_operator_accounts a WHERE a.root_workspace_id::text=old_row->>'id')
        OR EXISTS(SELECT 1 FROM public.crm_operator_workspace_bindings b WHERE b.workspace_id::text=old_row->>'id'));
  ELSE RAISE EXCEPTION 'Unknown root CRM authority source' USING ERRCODE='55000'; END IF;
  IF affected THEN
    SELECT enabled,active_transition_id,active_operation_id INTO active,transition,operation
      FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
    IF active OR transition IS NOT NULL OR operation IS NOT NULL THEN
      -- The existing exact row-delta guard independently matches this row to
      -- the approved ledger. A merely present transition/receipt is not enough.
      IF TG_TABLE_NAME<>'app_user_organization_memberships' OR NOT EXISTS(
        SELECT 1 FROM public.crm_native_email_authority_transitions t
        JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
        WHERE t.transition_id=transition AND t.app_state='applying' AND t.applying_xid=txid_current()
          AND p.state='committed' AND t.plan->'desiredAppChange'->>'kind'='workspace_user_eligibility_v1') THEN
        RAISE EXCEPTION 'Root CRM source change requires an exact native-first transition' USING ERRCODE='55000';
      END IF;
    ELSIF TG_TABLE_NAME='workspace_organizations' THEN
      UPDATE public.crm_native_email_publication_control SET generation=generation+1,verified_generation=NULL,
        native_policy_fingerprint=NULL,activation_receipt_hash=NULL,updated_at=now() WHERE singleton;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER crm_native_root_membership_source BEFORE INSERT OR UPDATE OR DELETE ON app_user_organization_memberships
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_root_source_guard();
-- Existing hierarchy/is_demo statement locks remain in place. Add the missing
-- root-type key so direct SQL writers also acquire control before a row lock.
CREATE TRIGGER crm_native_root_workspace_source_statement BEFORE UPDATE OF organization_type ON workspace_organizations
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_root_workspace_source BEFORE UPDATE OF id,parent_id,organization_type,is_demo OR DELETE ON workspace_organizations
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_root_source_guard();
REVOKE ALL ON FUNCTION clawpilot_crm_root_native_membership_state(jsonb),
  clawpilot_crm_root_native_membership_is_independent(jsonb,jsonb),clawpilot_crm_native_root_source_guard() FROM PUBLIC;
