-- App settings are not native SuiteCRM roles. Permit only mapped UPDATEs
-- proven not to change the existing canonical Email audience or native writer
-- policy. No identity/status/trash mutation, enrollment, activation or grant.
-- Active transitions still pin the COMPLETE app snapshot, including settings.
CREATE FUNCTION clawpilot_native_email_mapped_settings_are_independent(
  source_table text, old_row jsonb, new_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; candidate_email text; native_id text; eligible_before boolean; eligible_after boolean;
BEGIN
  IF old_row IS NULL OR new_row IS NULL OR source_table NOT IN ('app_users','app_user_organization_memberships')
    THEN RETURN false; END IF;
  IF source_table='app_users' THEN
    IF NOT (old_row ?& ARRAY['email','suitecrm_user_id','status','role','permissions','organization_id']
      AND new_row ?& ARRAY['email','suitecrm_user_id','status','role','permissions','organization_id'])
      OR (old_row->'email',old_row->'suitecrm_user_id',old_row->'status') IS DISTINCT FROM
        (new_row->'email',new_row->'suitecrm_user_id',new_row->'status') THEN RETURN false; END IF;
    candidate_email:=new_row->>'email'; native_id:=new_row->>'suitecrm_user_id';
    -- The canonical reader uses scoped membership role/permissions, never
    -- global role/permissions/default organization. Valid app shapes only.
    FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
      IF NOT (candidate->>'role' IN ('owner','admin','member')
        AND candidate->>'status' IN ('active','invited','disabled')
        AND jsonb_typeof(candidate->'permissions')='object') IS TRUE THEN RETURN false; END IF;
    END LOOP;
  ELSE
    IF NOT (old_row ?& ARRAY['user_email','organization_id','status','trashed_at','role','permissions']
      AND new_row ?& ARRAY['user_email','organization_id','status','trashed_at','role','permissions'])
      OR (old_row->'user_email',old_row->'organization_id',old_row->'status',old_row->'trashed_at') IS DISTINCT FROM
        (new_row->'user_email',new_row->'organization_id',new_row->'status',new_row->'trashed_at') THEN RETURN false; END IF;
    candidate_email:=new_row->>'user_email';
    SELECT suitecrm_user_id INTO native_id FROM public.app_users WHERE email=candidate_email;
    IF NOT FOUND THEN RETURN false; END IF;
    FOREACH candidate IN ARRAY ARRAY[old_row,new_row] LOOP
      -- Match crm.ts reviewedEmailAudienceUnderNativeControlWithClient and
      -- users.permissionsForRole: malformed viewCrm holds even for owners.
      IF NOT (candidate->>'role' IN ('owner','admin','member')
        AND candidate->>'status' IN ('active','invited','disabled')
        AND jsonb_typeof(candidate->'permissions')='object'
        AND (NOT ((candidate->'permissions') ? 'viewCrm')
          OR jsonb_typeof(candidate->'permissions'->'viewCrm')='boolean')) IS TRUE THEN RETURN false; END IF;
    END LOOP;
    eligible_before:=old_row->>'status'='active' AND old_row->'trashed_at'='null'::jsonb
      AND (old_row->>'role'='owner' OR COALESCE(old_row->'permissions'->>'viewCrm','true')='true');
    eligible_after:=new_row->>'status'='active' AND new_row->'trashed_at'='null'::jsonb
      AND (new_row->>'role'='owner' OR COALESCE(new_row->'permissions'->>'viewCrm','true')='true');
    IF eligible_before IS DISTINCT FROM eligible_after THEN RETURN false; END IF;
    -- Denied remains denied. Do not filter a denied legacy member from the
    -- canonical candidate, turn a malformed candidate valid, or enroll anyone.
    -- Native write rights derive pipeline ownership/access_role and installed
    -- capability contracts; neither is modified by these app settings.
  END IF;
  IF candidate_email IS NULL OR candidate_email='' OR native_id IS NULL
    OR native_id !~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}$'
    OR (SELECT count(*) FROM public.app_users WHERE suitecrm_user_id=native_id)<>1
    OR NOT EXISTS(SELECT 1 FROM public.app_users WHERE email=candidate_email AND suitecrm_user_id=native_id)
    THEN RETURN false; END IF;
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
    -- Preserve existing app-only lifecycle behavior and control-first locks.
    -- Both exceptions preserve current native pins and are unavailable while
    -- any authority transition pins its full before/after app snapshot.
    IF transition IS NULL AND (public.clawpilot_native_email_app_only_change_is_independent(TG_TABLE_NAME,old_row,new_row)
      OR (TG_OP='UPDATE' AND public.clawpilot_native_email_mapped_settings_are_independent(TG_TABLE_NAME,old_row,new_row))) THEN
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
