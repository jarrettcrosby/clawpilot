-- A new workspace membership is not a pipeline grant. An already linked,
-- active user can join another real workspace only when no pipeline in that
-- workspace names them as owner or intended member. Existing membership
-- edits, pipeline sharing, native identities and reader/writer policies retain
-- their exact native-first fences. No enrollment or activation is performed.
CREATE FUNCTION clawpilot_native_email_unshared_workspace_is_independent(
  source_table text, old_row jsonb, new_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate_email text; candidate_workspace uuid; native_id text;
BEGIN
  IF source_table <> 'app_user_organization_memberships' OR old_row IS NOT NULL OR new_row IS NULL
    THEN RETURN false; END IF;
  IF NOT (new_row ?& ARRAY['user_email','organization_id','status','role','permissions',
      'trashed_at','trashed_by','pre_trash_status']
    AND new_row->>'user_email'=lower(new_row->>'user_email')
    AND new_row->>'user_email' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND new_row->>'organization_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND new_row->>'status'='active' AND new_row->>'role'='member'
    AND jsonb_typeof(new_row->'permissions')='object'
    AND new_row->'trashed_at'='null'::jsonb AND new_row->'trashed_by'='null'::jsonb
    AND new_row->'pre_trash_status'='null'::jsonb) IS TRUE THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(new_row->'permissions') item WHERE jsonb_typeof(item.value)<>'boolean')
    THEN RETURN false; END IF;
  candidate_email:=new_row->>'user_email'; candidate_workspace:=(new_row->>'organization_id')::uuid;
  SELECT suitecrm_user_id INTO native_id FROM public.app_users
    WHERE email=candidate_email AND status='active';
  IF NOT FOUND OR native_id IS NULL OR native_id !~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}$'
    OR (SELECT count(*) FROM public.app_users WHERE suitecrm_user_id=native_id)<>1
    OR NOT EXISTS(SELECT 1 FROM public.workspace_organizations WHERE id=candidate_workspace AND NOT is_demo)
    OR EXISTS(SELECT 1 FROM public.pipeline_spaces p WHERE p.workspace_organization_id=candidate_workspace
      AND (p.owner_email=candidate_email OR EXISTS(SELECT 1 FROM public.pipeline_space_members m
        WHERE m.pipeline_id=p.id AND m.user_email=candidate_email))) THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_authority_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; keys text[]; key text; changed boolean:=TG_OP<>'UPDATE';
  active boolean; transition text; matched integer; kind text;
BEGIN
  old_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  keys:=CASE TG_TABLE_NAME WHEN 'pipeline_spaces' THEN ARRAY['id','owner_email','workspace_organization_id','reference_access_disabled']
    WHEN 'pipeline_space_members' THEN ARRAY['pipeline_id','user_email','access_role']
    WHEN 'app_user_organization_memberships' THEN ARRAY['user_email','organization_id','status','role','permissions','trashed_at','trashed_by','pre_trash_status']
    WHEN 'app_users' THEN ARRAY['email','status','suitecrm_user_id','role','permissions','organization_id'] ELSE NULL END;
  IF keys IS NULL THEN RAISE EXCEPTION 'Unknown native authority source' USING ERRCODE='55000'; END IF;
  FOREACH key IN ARRAY keys LOOP changed:=changed OR ((old_row->key) IS DISTINCT FROM (new_row->key)); END LOOP;
  IF NOT changed THEN RETURN NEW; END IF;
  SELECT enabled,active_transition_id INTO active,transition
    FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF active THEN
    IF transition IS NULL AND (public.clawpilot_native_email_app_only_change_is_independent(TG_TABLE_NAME,old_row,new_row)
      OR public.clawpilot_native_email_unshared_workspace_is_independent(TG_TABLE_NAME,old_row,new_row)
      OR (TG_OP='UPDATE'
        AND (TG_TABLE_NAME<>'app_user_organization_memberships'
          OR (old_row->'trashed_by',old_row->'pre_trash_status') IS NOT DISTINCT FROM (new_row->'trashed_by',new_row->'pre_trash_status'))
        AND public.clawpilot_native_email_mapped_settings_are_independent(TG_TABLE_NAME,old_row,new_row))) THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END IF;
    SELECT t.plan->'desiredAppChange'->>'kind' INTO kind FROM public.crm_native_email_authority_transitions t
      JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
      WHERE t.transition_id=transition AND t.app_state='applying' AND t.applying_xid=txid_current() AND p.state='committed';
    IF NOT FOUND THEN RAISE EXCEPTION 'Native authority requires a supported exact native-first transition' USING ERRCODE='55000'; END IF;
    IF kind='pipeline_members_v1' AND TG_TABLE_NAME='pipeline_space_members' THEN
      UPDATE public.crm_native_email_authority_member_changes d SET applied=true WHERE d.transition_id=transition AND NOT d.applied
        AND d.before_row IS NOT DISTINCT FROM old_row AND d.after_row IS NOT DISTINCT FROM new_row;
    ELSIF kind='workspace_user_eligibility_v1' AND TG_TABLE_NAME IN ('app_users','app_user_organization_memberships') THEN
      UPDATE public.crm_native_email_authority_user_changes d SET applied=true WHERE d.transition_id=transition AND NOT d.applied
        AND d.source_table=TG_TABLE_NAME AND d.before_row IS NOT DISTINCT FROM public.clawpilot_native_email_user_projection(TG_TABLE_NAME,old_row)
        AND d.after_row IS NOT DISTINCT FROM public.clawpilot_native_email_user_projection(TG_TABLE_NAME,new_row);
    ELSE RAISE EXCEPTION 'Native authority mutation differs from selected action' USING ERRCODE='55000'; END IF;
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>1 THEN RAISE EXCEPTION 'Native mutation differs from approved exact delta' USING ERRCODE='55000'; END IF;
  ELSE
    UPDATE public.crm_native_email_publication_control SET generation=generation+1,verified_generation=NULL,
      native_policy_fingerprint=NULL,activation_receipt_hash=NULL,updated_at=now() WHERE singleton;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
