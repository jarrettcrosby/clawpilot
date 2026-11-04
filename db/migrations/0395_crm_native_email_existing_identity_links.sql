-- First local link to an already-existing, independently verified native User.
-- No native User creation/rename, historical remapping, activation or data
-- repair. The existing exact user-delta ledger and native-first phases apply.
CREATE FUNCTION clawpilot_native_email_identity_projection(row_json jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE keys text[]:=ARRAY['email','status','suitecrm_user_id','role','permissions','organization_id',
  'reference_code','crm_user_enabled','suitecrm_username']; key text; result jsonb:='{}'::jsonb;
BEGIN
  IF row_json IS NULL THEN RETURN NULL; END IF;
  IF NOT (jsonb_typeof(row_json)='object' AND row_json ?& keys) IS TRUE THEN
    RAISE EXCEPTION 'Native identity projection is incomplete' USING ERRCODE='55000'; END IF;
  FOREACH key IN ARRAY keys LOOP result:=result||jsonb_build_object(key,row_json->key); END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION clawpilot_native_email_identity_link_rows(desired jsonb)
RETURNS TABLE(ordinal integer,source_table text,user_email text,organization_id uuid,before_row jsonb,after_row jsonb)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE candidate jsonb; identity_row jsonb; u_before jsonb; u_after jsonb; ancestry jsonb;
  path_row jsonb; path_ids text[]:='{}'::text[]; previous_parent text; path_position integer:=0;
BEGIN
  IF NOT (jsonb_typeof(desired)='object'
    AND desired ?& ARRAY['kind','workspaceId','userEmail','actorScope','contextFingerprint','appUser','nativeIdentity']
    AND desired-ARRAY['kind','workspaceId','userEmail','actorScope','contextFingerprint','appUser','nativeIdentity']='{}'::jsonb
    AND desired->>'kind'='user_identity_link_v1'
    AND desired->>'workspaceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND desired->>'userEmail'=lower(desired->>'userEmail')
    AND desired->>'userEmail' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND desired->>'contextFingerprint' ~ '^[a-f0-9]{64}$') IS TRUE THEN
    RAISE EXCEPTION 'Native identity link shape invalid' USING ERRCODE='55000'; END IF;
  candidate:=desired->'actorScope';
  IF NOT (jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['workspaceId','ancestryJson']
    AND candidate-ARRAY['workspaceId','ancestryJson']='{}'::jsonb
    AND candidate->>'workspaceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(candidate->'ancestryJson')='string' AND length(candidate->>'ancestryJson')<=100000) IS TRUE THEN
    RAISE EXCEPTION 'Native identity actor scope invalid' USING ERRCODE='55000'; END IF;
  ancestry:=(candidate->>'ancestryJson')::jsonb;
  IF NOT (jsonb_typeof(ancestry)='array' AND jsonb_array_length(ancestry) BETWEEN 1 AND 100) IS TRUE THEN
    RAISE EXCEPTION 'Native identity actor ancestry invalid' USING ERRCODE='55000'; END IF;
  FOR path_row IN SELECT value FROM jsonb_array_elements(ancestry) LOOP
    IF NOT (jsonb_typeof(path_row)='object' AND path_row ?& ARRAY['id','parent_id','is_demo']
      AND path_row-ARRAY['id','parent_id','is_demo']='{}'::jsonb
      AND path_row->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND (path_row->'parent_id'='null'::jsonb OR path_row->>'parent_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
      AND jsonb_typeof(path_row->'is_demo')='boolean' AND NOT(path_row->>'id'=ANY(path_ids))
      AND CASE WHEN path_position=0 THEN path_row->>'id'=desired->>'workspaceId' ELSE path_row->>'id'=previous_parent END) IS TRUE THEN
      RAISE EXCEPTION 'Native identity actor ancestry is not exact and acyclic' USING ERRCODE='55000'; END IF;
    path_ids:=array_append(path_ids,path_row->>'id');previous_parent:=path_row->>'parent_id';path_position:=path_position+1;
  END LOOP;
  IF path_ids[path_position] IS DISTINCT FROM desired->'actorScope'->>'workspaceId'
    OR ancestry->0->'is_demo'<>'false'::jsonb OR ancestry->(path_position-1)->'is_demo'<>'false'::jsonb THEN
    RAISE EXCEPTION 'Native identity actor ancestry lacks its real source' USING ERRCODE='55000'; END IF;
  candidate:=desired->'appUser';identity_row:=desired->'nativeIdentity';
  IF NOT (jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['beforeJson','afterJson']
    AND candidate-ARRAY['beforeJson','afterJson']='{}'::jsonb
    AND jsonb_typeof(candidate->'beforeJson')='string' AND jsonb_typeof(candidate->'afterJson')='string'
    AND length(candidate->>'beforeJson')<=100000 AND length(candidate->>'afterJson')<=100000
    AND jsonb_typeof(identity_row)='object' AND identity_row ?& ARRAY['userId','globalId','username']
    AND identity_row-ARRAY['userId','globalId','username']='{}'::jsonb
    AND identity_row->>'userId' ~* '^[a-z0-9][a-z0-9-]{0,35}$'
    AND identity_row->>'globalId' ~ '^gu([0-9]{7}|[0-9a-v]{12})$'
    AND identity_row->>'username'=identity_row->>'globalId') IS TRUE THEN
    RAISE EXCEPTION 'Native identity exact row evidence invalid' USING ERRCODE='55000'; END IF;
  u_before:=(candidate->>'beforeJson')::jsonb;u_after:=(candidate->>'afterJson')::jsonb;
  IF NOT (public.clawpilot_native_email_identity_projection(u_before)=u_before
    AND public.clawpilot_native_email_identity_projection(u_after)=u_after
    AND u_before->>'email'=desired->>'userEmail' AND u_before->'suitecrm_user_id'='null'::jsonb
    AND u_before->'suitecrm_username'='null'::jsonb AND u_before->'crm_user_enabled'='true'::jsonb
    AND u_before->>'reference_code'=identity_row->>'globalId'
    AND u_after->>'suitecrm_user_id'=identity_row->>'userId' AND u_after->>'suitecrm_username'=identity_row->>'username'
    AND u_before-ARRAY['suitecrm_user_id','suitecrm_username']=u_after-ARRAY['suitecrm_user_id','suitecrm_username']) IS TRUE THEN
    RAISE EXCEPTION 'Native identity link exceeds first-mapping delta' USING ERRCODE='55000'; END IF;
  IF NOT (u_before->>'status' IN ('active','invited','disabled') AND u_before->>'role' IN ('owner','admin','member')
    AND jsonb_typeof(u_before->'permissions')='object'
    AND (u_before->'organization_id'='null'::jsonb OR u_before->>'organization_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) IS TRUE
    OR EXISTS(SELECT 1 FROM jsonb_each(u_before->'permissions') permission WHERE jsonb_typeof(permission.value)<>'boolean') THEN
    RAISE EXCEPTION 'Native identity source principal is malformed' USING ERRCODE='55000'; END IF;
  ordinal:=0;source_table:='app_users';user_email:=desired->>'userEmail';organization_id:=NULL;before_row:=u_before;after_row:=u_after;RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_user_change_rows(desired jsonb)
RETURNS TABLE(ordinal integer,source_table text,user_email text,organization_id uuid,before_row jsonb,after_row jsonb)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE u_before jsonb; u_after jsonb; m_before jsonb; m_after jsonb; d_before jsonb;
  action jsonb; kind text; candidate jsonb; expected_keys text[]; ancestry jsonb;
  path_row jsonb; path_ids text[]:='{}'::text[]; previous_parent text; path_position integer:=0;
BEGIN
  IF desired->>'kind'='user_identity_link_v1' THEN
    RETURN QUERY SELECT * FROM public.clawpilot_native_email_identity_link_rows(desired); RETURN;
  END IF;
  IF NOT (jsonb_typeof(desired)='object'
    AND desired ?& ARRAY['kind','userEmail','workspaceId','action','appUser','membership','demoMembership','restoreFrom','pipelineIntentFingerprint','actorScope']
    AND desired-ARRAY['kind','userEmail','workspaceId','action','appUser','membership','demoMembership','restoreFrom','pipelineIntentFingerprint','actorScope']='{}'::jsonb
    AND desired->>'kind'='workspace_user_eligibility_v1'
    AND desired->>'userEmail'=lower(desired->>'userEmail') AND desired->>'userEmail' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND desired->>'workspaceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND desired->>'pipelineIntentFingerprint' ~ '^[a-f0-9]{64}$') IS TRUE THEN
    RAISE EXCEPTION 'Native user eligibility command shape invalid' USING ERRCODE='55000'; END IF;
  candidate:=desired->'actorScope';
  IF NOT (jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['workspaceId','ancestryJson']
    AND candidate-ARRAY['workspaceId','ancestryJson']='{}'::jsonb
    AND candidate->>'workspaceId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(candidate->'ancestryJson')='string') IS TRUE THEN
    RAISE EXCEPTION 'Native user actor scope invalid' USING ERRCODE='55000'; END IF;
  ancestry:=(candidate->>'ancestryJson')::jsonb;
  IF NOT (jsonb_typeof(ancestry)='array' AND jsonb_array_length(ancestry) BETWEEN 1 AND 100) IS TRUE THEN
    RAISE EXCEPTION 'Native user actor ancestry invalid' USING ERRCODE='55000'; END IF;
  FOR path_row IN SELECT value FROM jsonb_array_elements(ancestry) LOOP
    IF NOT (jsonb_typeof(path_row)='object' AND path_row ?& ARRAY['id','parent_id','is_demo']
      AND path_row-ARRAY['id','parent_id','is_demo']='{}'::jsonb
      AND path_row->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND (path_row->'parent_id'='null'::jsonb OR path_row->>'parent_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
      AND jsonb_typeof(path_row->'is_demo')='boolean' AND NOT (path_row->>'id'=ANY(path_ids))
      AND (CASE WHEN path_position=0 THEN path_row->>'id'=desired->>'workspaceId'
        ELSE path_row->>'id'=previous_parent END)) IS TRUE THEN
      RAISE EXCEPTION 'Native user actor ancestry is not an exact acyclic path' USING ERRCODE='55000'; END IF;
    path_ids:=array_append(path_ids,path_row->>'id');previous_parent:=path_row->>'parent_id';path_position:=path_position+1;
  END LOOP;
  IF path_ids[path_position] IS DISTINCT FROM desired->'actorScope'->>'workspaceId'
    OR ancestry->0->'is_demo'<>'false'::jsonb OR ancestry->(path_position-1)->'is_demo'<>'false'::jsonb THEN
    RAISE EXCEPTION 'Native user actor source does not end real-workspace ancestry' USING ERRCODE='55000'; END IF;
  FOREACH candidate IN ARRAY ARRAY[desired->'appUser',desired->'membership'] LOOP
    IF NOT (jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['beforeJson','afterJson']
      AND candidate-ARRAY['beforeJson','afterJson']='{}'::jsonb
      AND jsonb_typeof(candidate->'beforeJson')='string' AND jsonb_typeof(candidate->'afterJson')='string') IS TRUE THEN
      RAISE EXCEPTION 'Native user eligibility row evidence invalid' USING ERRCODE='55000'; END IF;
  END LOOP;
  u_before:=(desired->'appUser'->>'beforeJson')::jsonb; u_after:=(desired->'appUser'->>'afterJson')::jsonb;
  m_before:=(desired->'membership'->>'beforeJson')::jsonb; m_after:=(desired->'membership'->>'afterJson')::jsonb;
  IF NOT (public.clawpilot_native_email_user_projection('app_users',u_before)=u_before
    AND public.clawpilot_native_email_user_projection('app_users',u_after)=u_after
    AND public.clawpilot_native_email_user_projection('app_user_organization_memberships',m_before)=m_before
    AND public.clawpilot_native_email_user_projection('app_user_organization_memberships',m_after)=m_after
    AND u_before->>'email'=desired->>'userEmail' AND u_after->>'email'=desired->>'userEmail'
    AND u_before->>'suitecrm_user_id' ~ '^[a-zA-Z0-9][a-zA-Z0-9-]{0,35}$'
    AND u_before-'status'=u_after-'status'
    AND m_before->>'user_email'=desired->>'userEmail' AND m_after->>'user_email'=desired->>'userEmail'
    AND m_before->>'organization_id'=desired->>'workspaceId' AND m_after->>'organization_id'=desired->>'workspaceId'
    AND m_before IS DISTINCT FROM m_after) IS TRUE THEN
    RAISE EXCEPTION 'Native user eligibility identities or delta invalid' USING ERRCODE='55000'; END IF;
  FOREACH candidate IN ARRAY ARRAY[u_before,u_after,m_before,m_after] LOOP
    IF NOT (candidate->>'status' IN ('active','invited','disabled')
      AND candidate->>'role' IN ('owner','admin','member') AND jsonb_typeof(candidate->'permissions')='object') IS TRUE THEN
      RAISE EXCEPTION 'Native user eligibility principal is malformed' USING ERRCODE='55000'; END IF;
  END LOOP;
  FOREACH candidate IN ARRAY ARRAY[m_before,m_after] LOOP
    IF NOT (candidate->>'role' IN ('admin','member')
      AND (NOT ((candidate->'permissions') ? 'viewCrm') OR jsonb_typeof(candidate->'permissions'->'viewCrm')='boolean')
      AND ((candidate->'trashed_at'='null'::jsonb AND candidate->'trashed_by'='null'::jsonb AND candidate->'pre_trash_status'='null'::jsonb)
        OR (jsonb_typeof(candidate->'trashed_at')='string' AND jsonb_typeof(candidate->'trashed_by')='string'
          AND candidate->>'status'='disabled' AND candidate->>'pre_trash_status' IN ('active','invited','disabled')))) IS TRUE THEN
      RAISE EXCEPTION 'Native user eligibility cannot mutate owner or malformed trash state' USING ERRCODE='55000'; END IF;
  END LOOP;
  action:=desired->'action'; kind:=action->>'kind';
  expected_keys:=CASE kind WHEN 'status' THEN ARRAY['kind','status'] WHEN 'trash' THEN ARRAY['kind','trashed']
    WHEN 'access' THEN ARRAY['kind','role','permissionsJson'] ELSE NULL END;
  IF expected_keys IS NULL OR NOT (jsonb_typeof(action)='object' AND action ?& expected_keys AND action-expected_keys='{}'::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'Native user eligibility action invalid' USING ERRCODE='55000'; END IF;
  IF kind='status' THEN
    IF NOT (action->>'status' IN ('active','disabled') AND m_after->>'status'=action->>'status'
      AND m_before-'status'=m_after-'status' AND m_before->'trashed_at'='null'::jsonb
      AND NOT (m_before->>'status'='invited' AND m_after->>'status'='active')) IS TRUE THEN
      RAISE EXCEPTION 'Native user status delta exceeds selected action' USING ERRCODE='55000'; END IF;
  ELSIF kind='trash' THEN
    IF jsonb_typeof(action->'trashed')<>'boolean'
      OR m_before-ARRAY['status','trashed_at','trashed_by','pre_trash_status'] IS DISTINCT FROM
        m_after-ARRAY['status','trashed_at','trashed_by','pre_trash_status'] THEN
      RAISE EXCEPTION 'Native user trash delta exceeds selected action' USING ERRCODE='55000'; END IF;
    IF action->>'trashed'='true' THEN
      IF NOT (m_before->'trashed_at'='null'::jsonb AND m_after->>'status'='disabled'
        AND jsonb_typeof(m_after->'trashed_at')='string' AND m_after->'pre_trash_status'=m_before->'status') IS TRUE THEN
        RAISE EXCEPTION 'Native user trash must retain exact prior status' USING ERRCODE='55000'; END IF;
    ELSE
      IF NOT (jsonb_typeof(m_before->'trashed_at')='string' AND m_after->'trashed_at'='null'::jsonb
        AND m_after->'trashed_by'='null'::jsonb AND m_after->'pre_trash_status'='null'::jsonb
        AND m_after->'status'=m_before->'pre_trash_status') IS TRUE THEN
        RAISE EXCEPTION 'Native user restore must restore exact prior status' USING ERRCODE='55000'; END IF;
    END IF;
  ELSE
    IF NOT (action->>'role' IN ('admin','member') AND m_after->>'role'=action->>'role'
      AND jsonb_typeof(action->'permissionsJson')='string' AND m_after->'permissions'=(action->>'permissionsJson')::jsonb
      AND m_before-ARRAY['role','permissions']=m_after-ARRAY['role','permissions']) IS TRUE THEN
      RAISE EXCEPTION 'Native user access delta exceeds selected action' USING ERRCODE='55000'; END IF;
  END IF;
  IF desired->'restoreFrom'<>'null'::jsonb AND NOT (jsonb_typeof(desired->'restoreFrom')='object'
    AND desired->'restoreFrom' ?& ARRAY['transitionId','planHash']
    AND (desired->'restoreFrom')-ARRAY['transitionId','planHash']='{}'::jsonb
    AND desired->'restoreFrom'->>'transitionId' ~ '^[a-f0-9]{64}$'
    AND desired->'restoreFrom'->>'planHash' ~ '^[a-f0-9]{64}$') IS TRUE THEN
    RAISE EXCEPTION 'Native user restore provenance invalid' USING ERRCODE='55000'; END IF;
  IF u_before IS DISTINCT FROM u_after THEN
    ordinal:=0;source_table:='app_users';user_email:=desired->>'userEmail';organization_id:=NULL;before_row:=u_before;after_row:=u_after;RETURN NEXT;
  END IF;
  ordinal:=1;source_table:='app_user_organization_memberships';user_email:=desired->>'userEmail';organization_id:=(desired->>'workspaceId')::uuid;
  before_row:=m_before;after_row:=m_after;RETURN NEXT;
  IF desired->'demoMembership'<>'null'::jsonb THEN
    candidate:=desired->'demoMembership';
    IF NOT (jsonb_typeof(candidate)='object' AND candidate ?& ARRAY['beforeJson','afterJson']
      AND candidate-ARRAY['beforeJson','afterJson']='{}'::jsonb AND jsonb_typeof(candidate->'beforeJson')='string'
      AND candidate->'afterJson'='null'::jsonb) IS TRUE THEN
      RAISE EXCEPTION 'Native user demo delta must be an exact removal' USING ERRCODE='55000'; END IF;
    d_before:=(candidate->>'beforeJson')::jsonb;
    IF NOT (public.clawpilot_native_email_user_projection('app_user_organization_memberships',d_before)=d_before
      AND d_before->>'user_email'=desired->>'userEmail' AND d_before->>'organization_id'<>desired->>'workspaceId') IS TRUE THEN
      RAISE EXCEPTION 'Native user demo delta identity differs' USING ERRCODE='55000'; END IF;
    ordinal:=2;organization_id:=(d_before->>'organization_id')::uuid;before_row:=d_before;after_row:=NULL;RETURN NEXT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_user_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; expected record;
BEGIN
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  IF TG_OP='INSERT' THEN
    IF NOT FOUND OR t.app_state<>'prepared' OR t.plan->'desiredAppChange'->>'kind' NOT IN ('workspace_user_eligibility_v1','user_identity_link_v1') THEN
      RAISE EXCEPTION 'Native user change lacks prepared typed plan' USING ERRCODE='55000'; END IF;
    SELECT * INTO expected FROM public.clawpilot_native_email_user_change_rows(t.plan->'desiredAppChange') WHERE ordinal=NEW.ordinal;
    IF NOT FOUND OR (NEW.source_table,NEW.user_email,NEW.organization_id,NEW.before_row,NEW.after_row,NEW.applied) IS DISTINCT FROM
      (expected.source_table,expected.user_email,expected.organization_id,expected.before_row,expected.after_row,false) THEN
      RAISE EXCEPTION 'Native user change differs from immutable plan' USING ERRCODE='55000'; END IF;
    IF NEW.ordinal=2 AND NOT EXISTS(SELECT 1 FROM public.workspace_organizations WHERE id=NEW.organization_id AND is_demo) THEN
      RAISE EXCEPTION 'Native user derived removal is not a demo workspace' USING ERRCODE='55000'; END IF;
    IF NEW.ordinal=1 AND t.plan->'desiredAppChange'->'action'->>'kind'='trash'
      AND t.plan->'desiredAppChange'->'action'->>'trashed'='true' AND NEW.after_row->>'trashed_by' IS DISTINCT FROM t.actor_email THEN
      RAISE EXCEPTION 'Native user trash actor differs' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'applied') IS DISTINCT FROM (to_jsonb(OLD)-'applied') OR OLD.applied OR NOT NEW.applied THEN
      RAISE EXCEPTION 'Native user delta is immutable' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c
      JOIN public.crm_native_email_authority_phases p ON p.transition_id=c.active_transition_id AND p.phase='revoke'
      WHERE c.singleton AND c.active_transition_id=NEW.transition_id AND t.app_state='applying'
        AND t.applying_xid=txid_current() AND p.state='committed') THEN
      RAISE EXCEPTION 'Native user change lacks exact active transaction' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_transition_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; expected jsonb; n integer;
BEGIN
  IF TG_TABLE_NAME='crm_native_email_authority_transitions' THEN
    IF NOT (NEW.app_state='prepared' AND NEW.applying_xid IS NULL AND NEW.app_commit IS NULL
      AND NEW.plan->>'planHash'=NEW.plan_hash AND NEW.plan->'revoke'->>'transitionId'=NEW.transition_id
      AND NEW.plan->'grant'->>'transitionId'=NEW.transition_id
      AND NEW.plan->'revoke'->>'desiredAppChangeHash'=NEW.desired_change_hash
      AND NEW.plan->'grant'->>'desiredAppChangeHash'=NEW.desired_change_hash) IS TRUE THEN
      RAISE EXCEPTION 'Native authority initial plan invalid' USING ERRCODE='55000'; END IF;
    IF NEW.plan->'desiredAppChange'->>'kind'='pipeline_members_v1' THEN
      IF NOT (jsonb_typeof(NEW.plan->'desiredAppChange'->'changes')='array'
        AND jsonb_array_length(NEW.plan->'desiredAppChange'->'changes') BETWEEN 1 AND 100) IS TRUE THEN
        RAISE EXCEPTION 'Native member plan invalid' USING ERRCODE='55000'; END IF;
    ELSIF NEW.plan->'desiredAppChange'->>'kind'='workspace_user_eligibility_v1' THEN
      SELECT count(*) INTO n FROM public.clawpilot_native_email_user_change_rows(NEW.plan->'desiredAppChange');
      IF n NOT BETWEEN 1 AND 3 THEN RAISE EXCEPTION 'Native user delta count invalid' USING ERRCODE='55000'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements((NEW.plan->'desiredAppChange'->'actorScope'->>'ancestryJson')::jsonb) path
        LEFT JOIN public.workspace_organizations w ON w.id=(path->>'id')::uuid
        WHERE w.id IS NULL OR jsonb_build_object('id',w.id,'parent_id',w.parent_id,'is_demo',w.is_demo) IS DISTINCT FROM path) THEN
        RAISE EXCEPTION 'Native user actor ancestry changed before admission' USING ERRCODE='55000'; END IF;
      expected:=NEW.plan->'desiredAppChange'->'restoreFrom';
      IF expected<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_transitions prior
        WHERE prior.transition_id=expected->>'transitionId' AND prior.plan_hash=expected->>'planHash' AND prior.app_state='committed'
          AND prior.plan->'desiredAppChange'->>'kind'='workspace_user_eligibility_v1'
          AND prior.plan->'desiredAppChange'->>'userEmail'=NEW.plan->'desiredAppChange'->>'userEmail'
          AND prior.plan->'desiredAppChange'->>'workspaceId'=NEW.plan->'desiredAppChange'->>'workspaceId') THEN
        RAISE EXCEPTION 'Native user restore lineage does not match retained organization identity' USING ERRCODE='55000'; END IF;
    ELSIF NEW.plan->'desiredAppChange'->>'kind'='user_identity_link_v1' THEN
      SELECT count(*) INTO n FROM public.clawpilot_native_email_identity_link_rows(NEW.plan->'desiredAppChange');
      IF n<>1 THEN RAISE EXCEPTION 'Native identity delta count invalid' USING ERRCODE='55000'; END IF;
      expected:=NEW.plan->'desiredAppChange';
      IF NOT (NEW.plan->'revoke'->'identityLinks'=jsonb_build_array(expected->'nativeIdentity')
        AND NEW.plan->'grant'->'identityLinks'=jsonb_build_array(expected->'nativeIdentity')
        AND NOT (NEW.plan->'revoke' ? 'roleChanges') AND NOT (NEW.plan->'grant' ? 'roleChanges')
        AND NEW.plan->'revoke'->'pendingPublicationCommand'='null'::jsonb
        AND NEW.plan->'grant'->'pendingPublicationCommand'='null'::jsonb) IS TRUE THEN
        RAISE EXCEPTION 'Native identity phases differ from exact link' USING ERRCODE='55000'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements((expected->'actorScope'->>'ancestryJson')::jsonb) path
        LEFT JOIN public.workspace_organizations w ON w.id=(path->>'id')::uuid
        WHERE w.id IS NULL OR jsonb_build_object('id',w.id,'parent_id',w.parent_id,'is_demo',w.is_demo) IS DISTINCT FROM path)
        OR NOT EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=expected->>'userEmail'
          AND public.clawpilot_native_email_identity_projection(to_jsonb(u))=(expected->'appUser'->>'beforeJson')::jsonb)
        OR EXISTS(SELECT 1 FROM public.app_users u
          WHERE lower(u.suitecrm_user_id)=lower(expected->'nativeIdentity'->>'userId')) THEN
        RAISE EXCEPTION 'Native identity source or existing claims changed' USING ERRCODE='55000'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.app_users actor
        JOIN public.app_user_organization_memberships a ON a.user_email=actor.email
          AND a.organization_id=(expected->'actorScope'->>'workspaceId')::uuid
        JOIN public.workspace_organizations w ON w.id=a.organization_id
        JOIN public.app_user_organization_memberships target ON target.user_email=expected->>'userEmail'
          AND target.organization_id=(expected->>'workspaceId')::uuid
        WHERE actor.email=NEW.actor_email AND actor.status='active' AND a.status='active' AND a.trashed_at IS NULL
          AND NOT w.is_demo AND a.role IN ('owner','admin') AND jsonb_typeof(a.permissions)='object'
          AND (a.role='owner' OR a.permissions->'manageUserAccess'='true'::jsonb)
          AND target.trashed_at IS NULL
          AND (target.role<>'owner' OR target.user_email=actor.email AND a.role='owner')
          AND (a.role='owner' OR target.role='member')) THEN
        RAISE EXCEPTION 'Native identity actor lacks scoped user authority' USING ERRCODE='55000'; END IF;
    ELSE RAISE EXCEPTION 'Native authority action unsupported' USING ERRCODE='55000'; END IF;
  ELSE
    SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
    IF NOT FOUND OR t.app_state<>'prepared' THEN RAISE EXCEPTION 'Native authority plan not prepared' USING ERRCODE='55000'; END IF;
    IF TG_TABLE_NAME='crm_native_email_authority_phases' THEN
      IF NOT (NEW.command=t.plan->NEW.phase AND NEW.command->>'phase'=NEW.phase
        AND NEW.command->>'operationId'=NEW.operation_id AND NEW.command->>'transitionId'=NEW.transition_id
        AND NEW.state='prepared' AND NEW.approval_envelope IS NULL AND NEW.approval_readback IS NULL
        AND NEW.native_receipt IS NULL AND NEW.receipt_hash IS NULL AND NEW.lease_owner IS NULL
        AND NEW.lease_fence=0 AND NEW.lease_until IS NULL) IS TRUE THEN
        RAISE EXCEPTION 'Native authority phase differs from immutable plan' USING ERRCODE='55000'; END IF;
    ELSE
      expected:=t.plan->'desiredAppChange'->'changes'->NEW.ordinal;
      IF NOT (t.plan->'desiredAppChange'->>'kind'='pipeline_members_v1'
        AND expected=jsonb_build_object('before',NEW.before_row,'after',NEW.after_row) AND NOT NEW.applied) IS TRUE THEN
        RAISE EXCEPTION 'Native authority delta differs from immutable plan' USING ERRCODE='55000'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_authority_row_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; keys text[]; key text; changed boolean:=TG_OP<>'UPDATE'; active boolean; transition text; matched integer; kind text;
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
  SELECT enabled,active_transition_id INTO active,transition FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
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
    ELSIF kind='user_identity_link_v1' AND TG_TABLE_NAME='app_users' THEN
      UPDATE public.crm_native_email_authority_user_changes d SET applied=true WHERE d.transition_id=transition AND NOT d.applied
        AND d.source_table='app_users'
        AND d.before_row IS NOT DISTINCT FROM public.clawpilot_native_email_identity_projection(old_row)
        AND d.after_row IS NOT DISTINCT FROM public.clawpilot_native_email_identity_projection(new_row);
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

CREATE OR REPLACE FUNCTION clawpilot_native_email_transition_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE plan jsonb; desired jsonb; old_row jsonb:=to_jsonb(OLD);
  new_row jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END; affected boolean;
BEGIN
  SELECT t.plan INTO plan FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id WHERE c.singleton;
  IF plan IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  desired:=plan->'desiredAppChange';
  IF TG_TABLE_NAME='pipeline_space_members' AND TG_OP='UPDATE' AND EXISTS(
    SELECT 1 FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
    JOIN public.crm_native_email_authority_member_changes d ON d.transition_id=t.transition_id
    WHERE c.singleton AND c.enabled AND c.active_operation_id IS NULL AND t.app_state='applying'
      AND t.applying_xid=txid_current() AND p.state='committed'
      AND desired->>'kind'='pipeline_members_v1' AND d.before_row=old_row AND d.after_row=new_row
      AND old_row->>'access_role'<>new_row->>'access_role') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='pipeline_space_members' THEN
    affected:=old_row IS DISTINCT FROM new_row AND EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
      WHERE b->'before'->>'pipeline_id'=OLD.pipeline_id::text OR b->'before'->>'pipeline_id'=NEW.pipeline_id::text);
  ELSIF TG_TABLE_NAME='workspace_organizations' THEN
    affected:=(old_row->'id',old_row->'is_demo') IS DISTINCT FROM (new_row->'id',new_row->'is_demo')
      AND (EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
        WHERE b->'before'->>'workspace_id'=old_row->>'id' OR b->'before'->>'workspace_id'=new_row->>'id')
      OR (desired->>'kind' IN ('workspace_user_eligibility_v1','user_identity_link_v1') AND (
        desired->>'workspaceId' IN (old_row->>'id',new_row->>'id')
        OR EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
          WHERE m.user_email=desired->>'userEmail' AND m.organization_id::text IN (old_row->>'id',new_row->>'id'))
        OR ((desired->'demoMembership'->>'beforeJson')::jsonb)->>'organization_id' IN (old_row->>'id',new_row->>'id'))));
    affected:=affected OR (desired->>'kind' IN ('workspace_user_eligibility_v1','user_identity_link_v1')
      AND (old_row->'id',old_row->'parent_id',old_row->'is_demo') IS DISTINCT FROM
        (new_row->'id',new_row->'parent_id',new_row->'is_demo')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements((desired->'actorScope'->>'ancestryJson')::jsonb) path
        WHERE path->>'id' IN (old_row->>'id',new_row->>'id')));
  ELSE RAISE EXCEPTION 'Unknown native snapshot source' USING ERRCODE='55000'; END IF;
  IF affected THEN RAISE EXCEPTION 'Native authority snapshot is pinned during transition' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION clawpilot_native_email_transition_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; delta record; expected record; actual jsonb; n integer; kind text; desired jsonb; derived_status text;
BEGIN
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  IF t.app_state='applying' THEN RAISE EXCEPTION 'Native authority app change cannot partially commit' USING ERRCODE='55000'; END IF;
  desired:=t.plan->'desiredAppChange';kind:=desired->>'kind';
  IF (SELECT count(*) FROM public.crm_native_email_authority_phases WHERE transition_id=t.transition_id)<>2 THEN
    RAISE EXCEPTION 'Native authority phase coverage changed' USING ERRCODE='55000'; END IF;
  IF kind='pipeline_members_v1' THEN
    IF (SELECT count(*) FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id)
      <>jsonb_array_length(desired->'changes') OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id) THEN
      RAISE EXCEPTION 'Native authority delta coverage changed' USING ERRCODE='55000'; END IF;
    FOR delta IN SELECT * FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id LOOP
      IF NOT (desired->'changes'->delta.ordinal=jsonb_build_object('before',delta.before_row,'after',delta.after_row)) IS TRUE THEN
        RAISE EXCEPTION 'Native authority delta plan mismatch' USING ERRCODE='55000'; END IF;
      IF t.app_state='committed' THEN
        SELECT to_jsonb(m) INTO actual FROM public.pipeline_space_members m WHERE m.pipeline_id=delta.pipeline_id AND m.user_email=delta.user_email;
        IF NOT delta.applied OR actual IS DISTINCT FROM delta.after_row THEN
          RAISE EXCEPTION 'Native authority member postimage mismatch' USING ERRCODE='55000'; END IF;
      END IF;
    END LOOP;
  ELSIF kind IN ('workspace_user_eligibility_v1','user_identity_link_v1') THEN
    SELECT count(*) INTO n FROM public.clawpilot_native_email_user_change_rows(desired);
    IF (SELECT count(*) FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id)<>n
      OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id) THEN
      RAISE EXCEPTION 'Native user delta coverage changed' USING ERRCODE='55000'; END IF;
    FOR expected IN SELECT * FROM public.clawpilot_native_email_user_change_rows(desired) LOOP
      SELECT * INTO delta FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id AND ordinal=expected.ordinal;
      IF NOT FOUND OR (delta.source_table,delta.user_email,delta.organization_id,delta.before_row,delta.after_row) IS DISTINCT FROM
        (expected.source_table,expected.user_email,expected.organization_id,expected.before_row,expected.after_row) THEN
        RAISE EXCEPTION 'Native user delta differs from immutable plan' USING ERRCODE='55000'; END IF;
      IF t.app_state='committed' THEN
        IF delta.source_table='app_users' THEN SELECT CASE WHEN kind='user_identity_link_v1' THEN public.clawpilot_native_email_identity_projection(to_jsonb(u))
          ELSE public.clawpilot_native_email_user_projection('app_users',to_jsonb(u)) END INTO actual
          FROM public.app_users u WHERE u.email=delta.user_email;
        ELSE SELECT public.clawpilot_native_email_user_projection('app_user_organization_memberships',to_jsonb(m)) INTO actual
          FROM public.app_user_organization_memberships m WHERE m.user_email=delta.user_email AND m.organization_id=delta.organization_id; END IF;
        IF NOT delta.applied OR actual IS DISTINCT FROM delta.after_row THEN
          RAISE EXCEPTION 'Native user postimage mismatch' USING ERRCODE='55000'; END IF;
      END IF;
    END LOOP;
    IF t.app_state='committed' THEN
      SELECT CASE WHEN kind='user_identity_link_v1' THEN public.clawpilot_native_email_identity_projection(to_jsonb(u))
        ELSE public.clawpilot_native_email_user_projection('app_users',to_jsonb(u)) END INTO actual
        FROM public.app_users u WHERE u.email=desired->>'userEmail';
      IF actual IS DISTINCT FROM (desired->'appUser'->>'afterJson')::jsonb THEN
        RAISE EXCEPTION 'Native user final principal differs' USING ERRCODE='55000'; END IF;
      IF kind='workspace_user_eligibility_v1' THEN
      SELECT CASE WHEN bool_or(m.status='active') THEN 'active' WHEN bool_or(m.status='invited') THEN 'invited' ELSE 'disabled' END
        INTO derived_status FROM public.app_user_organization_memberships m JOIN public.workspace_organizations w ON w.id=m.organization_id
        WHERE m.user_email=desired->>'userEmail' AND m.trashed_at IS NULL AND NOT w.is_demo;
      IF actual->>'status' IS DISTINCT FROM derived_status THEN
        RAISE EXCEPTION 'Native user global status does not preserve other real-workspace access' USING ERRCODE='55000'; END IF;
      IF desired->'demoMembership'<>'null'::jsonb AND EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
        JOIN public.workspace_organizations w ON w.id=m.organization_id WHERE m.user_email=desired->>'userEmail'
        AND m.status='active' AND m.trashed_at IS NULL AND NOT w.is_demo
        AND (m.role='owner' OR m.permissions->'accessDemo'='true'::jsonb)) THEN
        RAISE EXCEPTION 'Native user demo removal would discard legitimate access' USING ERRCODE='55000'; END IF;
      END IF;
    END IF;
  ELSE RAISE EXCEPTION 'Native authority action unsupported' USING ERRCODE='55000'; END IF;
  IF t.app_state='aborted' AND (NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases r
      JOIN public.crm_native_email_authority_phases g USING(transition_id)
      WHERE r.transition_id=t.transition_id AND r.phase='revoke' AND r.state='cancelled'
        AND g.phase='grant' AND g.state='prepared' AND g.approval_envelope IS NULL AND g.approval_readback IS NULL AND g.lease_owner IS NULL)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id AND applied)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id AND applied)) THEN
    RAISE EXCEPTION 'Native authority cancellation cannot abort changed application state' USING ERRCODE='55000'; END IF;
  IF t.app_state='committed' AND (NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases p
      WHERE p.transition_id=t.transition_id AND p.phase='revoke' AND p.state='committed' AND p.receipt_hash=t.app_commit->>'revokeReceiptHash')
    OR NOT (t.app_commit=jsonb_build_object('version',1,'transitionId',t.transition_id,'planHash',t.plan_hash,
      'desiredAppChangeHash',t.desired_change_hash,'revokeReceiptHash',t.app_commit->>'revokeReceiptHash',
      'appAuthorityBeforeFingerprint',t.plan->>'expectedAppAuthorityBeforeFingerprint',
      'appAuthorityAfterFingerprint',t.plan->>'expectedAppAuthorityAfterFingerprint')) IS TRUE) THEN
    RAISE EXCEPTION 'Native authority app receipt incomplete' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;

-- Identity metadata is normally independent of reader roles, but it is an
-- exact first-link preimage while that action is in flight. Serialize before
-- user row locks; only its matching native-first app transaction can change it.
CREATE TRIGGER crm_native_identity_metadata_statement BEFORE UPDATE OF reference_code,crm_user_enabled,suitecrm_username
  ON app_users FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE FUNCTION clawpilot_native_email_identity_metadata_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; revoke_state text;
BEGIN
  IF (OLD.reference_code,OLD.crm_user_enabled,OLD.suitecrm_username) IS NOT DISTINCT FROM
    (NEW.reference_code,NEW.crm_user_enabled,NEW.suitecrm_username) THEN RETURN NEW; END IF;
  SELECT transition.* INTO t FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions transition ON transition.transition_id=c.active_transition_id WHERE c.singleton;
  IF NOT FOUND OR t.plan->'desiredAppChange'->>'kind'<>'user_identity_link_v1'
    OR t.plan->'desiredAppChange'->>'userEmail'<>OLD.email THEN RETURN NEW; END IF;
  SELECT state INTO revoke_state FROM public.crm_native_email_authority_phases WHERE transition_id=t.transition_id AND phase='revoke';
  IF NOT (t.app_state='applying' AND t.applying_xid=txid_current() AND revoke_state='committed'
    AND public.clawpilot_native_email_identity_projection(to_jsonb(OLD))=(t.plan->'desiredAppChange'->'appUser'->>'beforeJson')::jsonb
    AND public.clawpilot_native_email_identity_projection(to_jsonb(NEW))=(t.plan->'desiredAppChange'->'appUser'->>'afterJson')::jsonb) IS TRUE THEN
    RAISE EXCEPTION 'Native identity metadata is pinned during first link' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_identity_metadata_guard BEFORE UPDATE OF reference_code,crm_user_enabled,suitecrm_username
  ON app_users FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_identity_metadata_guard();
REVOKE ALL ON FUNCTION clawpilot_native_email_identity_projection(jsonb),
  clawpilot_native_email_identity_link_rows(jsonb),clawpilot_native_email_identity_metadata_guard() FROM PUBLIC;
