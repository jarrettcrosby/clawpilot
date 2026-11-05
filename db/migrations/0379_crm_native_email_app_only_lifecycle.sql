-- An app account is not a native SuiteCRM principal. Ordinary invitations,
-- acceptance and unrelated organization settings must not require a native
-- authority transition when the exact rows cannot affect a pipeline audience.
-- This is deliberately NOT an unbound-pipeline inference: v1 native bindings
-- may exist without a capability-policy row. Check every local pipeline, keep
-- every native-mapped account fenced, and retain the transition barrier.
CREATE FUNCTION clawpilot_native_email_app_only_change_is_independent(
  source_table text, old_row jsonb, new_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; candidate_email text; candidate_workspace text;
BEGIN
  IF source_table NOT IN ('app_users','app_user_organization_memberships')
    OR (old_row IS NULL AND new_row IS NULL) THEN RETURN false; END IF;
  FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
    IF candidate IS NULL THEN CONTINUE; END IF;
    IF source_table='app_users' THEN
      candidate_email:=candidate->>'email';
      -- Clearing or assigning a native ID, including an unrelated duplicate
      -- mapping, is never an app-only lifecycle change. Native inventory and
      -- legacy bindings are not inferred from local policy-table contents.
      IF NOT (candidate ? 'suitecrm_user_id') OR candidate->>'suitecrm_user_id' IS NOT NULL
        OR candidate_email IS NULL OR candidate_email='' THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.pipeline_spaces p WHERE p.owner_email=candidate_email)
        OR EXISTS(SELECT 1 FROM public.pipeline_space_members m WHERE m.user_email=candidate_email)
        THEN RETURN false; END IF;
    ELSE
      candidate_email:=candidate->>'user_email'; candidate_workspace:=candidate->>'organization_id';
      IF candidate_email IS NULL OR candidate_email='' OR candidate_workspace IS NULL
        OR candidate_workspace='' THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=candidate_email AND u.suitecrm_user_id IS NOT NULL)
        THEN RETURN false; END IF;
      -- Missing users are refused except for an ON DELETE CASCADE. The parent
      -- app_users AFTER guard independently checks OLD.suitecrm_user_id; a
      -- mapped-user deletion therefore rolls the entire cascade back. A
      -- pipeline ownership/member cascade still hits its unchanged fence.
      IF NOT EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=candidate_email)
        AND NOT (old_row IS NOT NULL AND new_row IS NULL) THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM public.pipeline_spaces p
          WHERE p.workspace_organization_id::text=candidate_workspace
            AND (p.owner_email=candidate_email OR EXISTS(
              SELECT 1 FROM public.pipeline_space_members m WHERE m.pipeline_id=p.id AND m.user_email=candidate_email)))
        THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_authority_row_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; keys text[]; key text; changed boolean:=TG_OP<>'UPDATE'; active boolean; transition text; matched integer;
BEGIN
  old_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  keys:=CASE TG_TABLE_NAME WHEN 'pipeline_spaces' THEN ARRAY['id','owner_email','workspace_organization_id','reference_access_disabled']
    WHEN 'pipeline_space_members' THEN ARRAY['pipeline_id','user_email','access_role']
    WHEN 'app_user_organization_memberships' THEN ARRAY['user_email','organization_id','status','role','permissions','trashed_at']
    WHEN 'app_users' THEN ARRAY['email','status','suitecrm_user_id','role','permissions','organization_id'] ELSE NULL END;
  IF keys IS NULL THEN RAISE EXCEPTION 'Unknown native authority source' USING ERRCODE='55000'; END IF;
  FOREACH key IN ARRAY keys LOOP changed:=changed OR ((old_row->key) IS DISTINCT FROM (new_row->key)); END LOOP;
  IF NOT changed THEN RETURN NEW; END IF;
  SELECT enabled,active_transition_id INTO active,transition FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF active THEN
    -- All statement-level control locks remain installed. This exception does
    -- not change generation/policy pins, native principal inventory, or any
    -- pipeline reader. Active transitions still freeze their complete source
    -- snapshot: do not use this as a coordinator or unfinished-work bypass.
    IF transition IS NULL AND public.clawpilot_native_email_app_only_change_is_independent(TG_TABLE_NAME,old_row,new_row) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END IF;
    IF TG_TABLE_NAME<>'pipeline_space_members' OR transition IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.crm_native_email_authority_transitions t JOIN public.crm_native_email_authority_phases p
        ON p.transition_id=t.transition_id AND p.phase='revoke'
      WHERE t.transition_id=transition AND t.app_state='applying' AND t.applying_xid=txid_current() AND p.state='committed') THEN
      RAISE EXCEPTION 'Native authority requires a supported exact native-first transition' USING ERRCODE='55000'; END IF;
    UPDATE public.crm_native_email_authority_member_changes d SET applied=true
      WHERE d.transition_id=transition AND NOT d.applied AND d.before_row IS NOT DISTINCT FROM old_row AND d.after_row IS NOT DISTINCT FROM new_row;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>1 THEN RAISE EXCEPTION 'Native member mutation differs from approved exact delta' USING ERRCODE='55000'; END IF;
  ELSE
    UPDATE public.crm_native_email_publication_control SET generation=generation+1,verified_generation=NULL,
      native_policy_fingerprint=NULL,activation_receipt_hash=NULL,updated_at=now() WHERE singleton;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
