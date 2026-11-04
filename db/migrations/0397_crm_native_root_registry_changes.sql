-- Exact native-first root intent changes. No enrollment or policy activation
-- occurs on installation. Account identity/history stays immutable.
CREATE FUNCTION clawpilot_crm_root_registry_projection(kind text,row_json jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE keys text[]; result jsonb;
BEGIN
  IF row_json IS NULL THEN RETURN NULL; END IF;
  keys:=CASE kind WHEN 'account' THEN ARRAY['id','root_workspace_id','owner_email','enabled','revision']
    WHEN 'binding' THEN ARRAY['operator_account_id','workspace_id','owner_email','enabled','revision']
    WHEN 'grant' THEN ARRAY['id','operator_account_id','user_email','source_workspace_id','enabled','revision'] END;
  IF keys IS NULL THEN RAISE EXCEPTION 'Unknown root registry source' USING ERRCODE='55000'; END IF;
  SELECT jsonb_object_agg(key,CASE WHEN key='revision' THEN to_jsonb(row_json->>key) ELSE row_json->key END)
    INTO result FROM unnest(keys) key;
  RETURN result;
END $$;

CREATE FUNCTION clawpilot_crm_root_registry_current_row(kind text,identity text,account_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF kind='account' THEN SELECT to_jsonb(a) INTO result FROM public.crm_operator_accounts a WHERE a.id=identity::uuid;
  ELSIF kind='binding' THEN SELECT to_jsonb(b) INTO result FROM public.crm_operator_workspace_bindings b
    WHERE b.operator_account_id=account_id AND b.workspace_id=identity::uuid;
  ELSIF kind='grant' THEN SELECT to_jsonb(g) INTO result FROM public.crm_root_employee_access_grants g WHERE g.id=identity::uuid;
  ELSE RAISE EXCEPTION 'Unknown root registry source' USING ERRCODE='55000'; END IF;
  RETURN public.clawpilot_crm_root_registry_projection(kind,result);
END $$;

CREATE FUNCTION clawpilot_crm_root_registry_change_rows(desired jsonb)
RETURNS TABLE(ordinal integer,registry_table text,operator_account_id uuid,row_key text,before_row jsonb,after_row jsonb)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE delta jsonb; image jsonb; keys text[]; actual_keys text[]; field text;
  root_id uuid; account_id uuid; owner_email text; previous_key text:=''; selected_key text;
  seen_users text[]:=ARRAY[]::text[]; next_revision numeric;
BEGIN
  IF NOT (jsonb_typeof(desired)='object' AND desired->>'kind'='root_registry_v1'
    AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(desired) key)=
      ARRAY['actorScope','changes','contextFingerprint','kind','operatorAccountId','ownerEmail','workspaceId']
    AND jsonb_typeof(desired->'changes')='array' AND jsonb_array_length(desired->'changes') BETWEEN 1 AND 100
    AND jsonb_typeof(desired->'ownerEmail')='string' AND length(desired->>'ownerEmail') BETWEEN 3 AND 320
    AND desired->>'ownerEmail'=lower(desired->>'ownerEmail') AND desired->>'ownerEmail' ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND jsonb_typeof(desired->'contextFingerprint')='string' AND desired->>'contextFingerprint' ~ '^[a-f0-9]{64}$'
    AND octet_length(desired::text)<=128000) IS TRUE THEN
    RAISE EXCEPTION 'Invalid root registry proposal' USING ERRCODE='55000'; END IF;
  root_id:=(desired->>'workspaceId')::uuid; account_id:=(desired->>'operatorAccountId')::uuid; owner_email:=desired->>'ownerEmail';
  IF desired->>'workspaceId'<>root_id::text OR desired->>'operatorAccountId'<>account_id::text
    OR NOT (jsonb_typeof(desired->'actorScope')='object'
      AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(desired->'actorScope') key)=ARRAY['ancestryJson','workspaceId']
      AND desired->'actorScope'->>'workspaceId'=root_id::text
      AND jsonb_typeof(desired->'actorScope'->'ancestryJson')='string'
      AND (desired->'actorScope'->>'ancestryJson')::jsonb=jsonb_build_array(jsonb_build_object('id',root_id,'parent_id',NULL,'is_demo',false))) IS TRUE THEN
    RAISE EXCEPTION 'Root registry actor scope differs' USING ERRCODE='55000'; END IF;
  ordinal:=0;
  FOR delta IN SELECT value FROM jsonb_array_elements(desired->'changes') LOOP
    IF NOT (jsonb_typeof(delta)='object'
      AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(delta) key)=ARRAY['afterJson','beforeJson','table']
      AND delta->>'table' IN ('account','binding','grant') AND jsonb_typeof(delta->'afterJson')='string'
      AND (delta->'beforeJson'='null'::jsonb OR jsonb_typeof(delta->'beforeJson')='string')
      AND octet_length(delta->>'afterJson')<=4096 AND COALESCE(octet_length(delta->>'beforeJson'),0)<=4096) IS TRUE THEN
      RAISE EXCEPTION 'Invalid root registry delta' USING ERRCODE='55000'; END IF;
    registry_table:=delta->>'table';before_row:=(delta->>'beforeJson')::jsonb;after_row:=(delta->>'afterJson')::jsonb;
    keys:=CASE registry_table WHEN 'account' THEN ARRAY['enabled','id','owner_email','revision','root_workspace_id']
      WHEN 'binding' THEN ARRAY['enabled','operator_account_id','owner_email','revision','workspace_id']
      WHEN 'grant' THEN ARRAY['enabled','id','operator_account_id','revision','source_workspace_id','user_email'] END;
    FOREACH image IN ARRAY ARRAY[before_row,after_row] LOOP
      IF image IS NULL THEN CONTINUE; END IF;
      IF jsonb_typeof(image)<>'object' THEN RAISE EXCEPTION 'Invalid root registry image' USING ERRCODE='55000'; END IF;
      SELECT array_agg(key ORDER BY key) INTO actual_keys FROM jsonb_object_keys(image) key;
      IF actual_keys IS DISTINCT FROM keys OR jsonb_typeof(image->'enabled')<>'boolean'
        OR jsonb_typeof(image->'revision')<>'string' OR NOT (image->>'revision' ~ '^[1-9][0-9]{0,15}$') IS TRUE THEN
        RAISE EXCEPTION 'Invalid root registry image fields' USING ERRCODE='55000'; END IF;
      next_revision:=(image->>'revision')::numeric;
      IF next_revision>9007199254740991 THEN RAISE EXCEPTION 'Root revision outside exact integer range' USING ERRCODE='55000'; END IF;
      FOREACH field IN ARRAY keys LOOP
        IF field IN ('id','operator_account_id','root_workspace_id','workspace_id','source_workspace_id') THEN
          IF jsonb_typeof(image->field)<>'string' OR image->>field IS DISTINCT FROM ((image->>field)::uuid)::text THEN
            RAISE EXCEPTION 'Root registry UUID differs' USING ERRCODE='55000'; END IF;
        ELSIF field IN ('owner_email','user_email') THEN
          IF NOT (jsonb_typeof(image->field)='string' AND length(image->>field) BETWEEN 3 AND 320
            AND image->>field=lower(image->>field) AND image->>field ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') IS TRUE THEN
            RAISE EXCEPTION 'Root registry email differs' USING ERRCODE='55000'; END IF;
        END IF;
      END LOOP;
    END LOOP;
    IF before_row IS NULL THEN
      IF after_row->>'revision'<>'1' THEN RAISE EXCEPTION 'Root intent must start at revision one' USING ERRCODE='55000'; END IF;
    ELSIF (before_row-ARRAY['enabled','revision']) IS DISTINCT FROM (after_row-ARRAY['enabled','revision'])
      OR before_row->'enabled'=after_row->'enabled'
      OR (after_row->>'revision')::numeric<>(before_row->>'revision')::numeric+1 THEN
      RAISE EXCEPTION 'Root intent identity or revision differs' USING ERRCODE='55000'; END IF;
    IF registry_table='account' THEN
      IF NOT (after_row->>'id'=account_id::text AND after_row->>'root_workspace_id'=root_id::text
        AND after_row->>'owner_email'=owner_email) IS TRUE THEN RAISE EXCEPTION 'Root account scope differs' USING ERRCODE='55000'; END IF;
    ELSE
      IF after_row->>'operator_account_id' IS DISTINCT FROM account_id::text THEN
        RAISE EXCEPTION 'Root registry account differs' USING ERRCODE='55000'; END IF;
      IF registry_table='binding' THEN
        IF after_row->>'owner_email' IS DISTINCT FROM owner_email THEN RAISE EXCEPTION 'Root binding owner differs' USING ERRCODE='55000'; END IF;
      ELSE
        IF after_row->>'source_workspace_id' IS DISTINCT FROM root_id::text OR after_row->>'user_email'=owner_email
          OR after_row->>'user_email'=ANY(seen_users) THEN RAISE EXCEPTION 'Root employee scope differs' USING ERRCODE='55000'; END IF;
        seen_users:=array_append(seen_users,after_row->>'user_email');
      END IF;
    END IF;
    row_key:=CASE WHEN registry_table='binding' THEN after_row->>'workspace_id' ELSE after_row->>'id' END;
    selected_key:=registry_table||':'||row_key;
    IF selected_key COLLATE "C"<=previous_key COLLATE "C" THEN RAISE EXCEPTION 'Root changes repeated or unordered' USING ERRCODE='55000'; END IF;
    previous_key:=selected_key;operator_account_id:=account_id;RETURN NEXT;ordinal:=ordinal+1;
  END LOOP;
EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION 'Malformed root registry proposal' USING ERRCODE='55000';
END $$;

CREATE TABLE crm_native_email_authority_root_changes (
  transition_id text NOT NULL REFERENCES crm_native_email_authority_transitions(transition_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  registry_table text NOT NULL CHECK (registry_table IN ('account','binding','grant')),
  operator_account_id uuid NOT NULL, row_key text NOT NULL,
  before_row jsonb, after_row jsonb NOT NULL CHECK (jsonb_typeof(after_row)='object'),
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY(transition_id,ordinal),UNIQUE(transition_id,registry_table,row_key)
);
CREATE TRIGGER crm_native_root_change_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_authority_root_changes
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE FUNCTION clawpilot_crm_root_change_ledger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; expected record;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Root transition evidence is permanent' USING ERRCODE='55000'; END IF;
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  IF TG_OP='INSERT' THEN
    IF NOT FOUND OR t.app_state<>'prepared' OR t.plan->'desiredAppChange'->>'kind'<>'root_registry_v1' THEN
      RAISE EXCEPTION 'Root transition is not prepared' USING ERRCODE='55000'; END IF;
    SELECT * INTO expected FROM public.clawpilot_crm_root_registry_change_rows(t.plan->'desiredAppChange') WHERE ordinal=NEW.ordinal;
    IF NOT FOUND OR (NEW.registry_table,NEW.operator_account_id,NEW.row_key,NEW.before_row,NEW.after_row,NEW.applied) IS DISTINCT FROM
      (expected.registry_table,expected.operator_account_id,expected.row_key,expected.before_row,expected.after_row,false) THEN
      RAISE EXCEPTION 'Root evidence differs from approved plan' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'applied') IS DISTINCT FROM (to_jsonb(OLD)-'applied') OR OLD.applied OR NOT NEW.applied
      OR NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c
        JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
        WHERE c.singleton AND c.enabled AND c.active_operation_id IS NULL AND c.active_transition_id=t.transition_id
          AND t.app_state='applying' AND t.applying_xid=txid_current() AND p.state='committed'
          AND c.generation=(t.plan->'revoke'->>'generationTo')::bigint AND c.verified_generation=c.generation
          AND c.activation_receipt_hash=p.receipt_hash AND c.native_policy_fingerprint=t.plan->'revoke'->>'afterPolicyFingerprint') THEN
      RAISE EXCEPTION 'Root evidence cannot be changed outside exact app commit' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- Proposed new intent is not yet visible to the ordinary root registry source
-- guards. Fence its actual users/memberships/workspaces during the transition,
-- including a new account's preimages, without fabricating memberships.
CREATE FUNCTION clawpilot_crm_root_registry_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE desired jsonb; old_row jsonb:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row jsonb:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  users text[]; workspaces text[]; affected boolean:=false;
BEGIN
  SELECT t.plan->'desiredAppChange' INTO desired FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    WHERE c.singleton AND t.plan->'desiredAppChange'->>'kind'='root_registry_v1';
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
  END IF;
  SELECT array_agg(DISTINCT email) INTO users FROM (
    SELECT desired->>'ownerEmail' AS email
    UNION ALL SELECT g.user_email FROM public.crm_root_employee_access_grants g
      WHERE g.operator_account_id=(desired->>'operatorAccountId')::uuid
    UNION ALL SELECT r.after_row->>'user_email' FROM public.clawpilot_crm_root_registry_change_rows(desired) r WHERE r.registry_table='grant'
  ) selected;
  SELECT array_agg(DISTINCT id) INTO workspaces FROM (
    SELECT desired->>'workspaceId' AS id
    UNION ALL SELECT b.workspace_id::text FROM public.crm_operator_workspace_bindings b
      WHERE b.operator_account_id=(desired->>'operatorAccountId')::uuid
    UNION ALL SELECT r.after_row->>'workspace_id' FROM public.clawpilot_crm_root_registry_change_rows(desired) r WHERE r.registry_table='binding'
  ) selected;
  IF TG_TABLE_NAME='app_users' THEN
    affected:=(old_row->'suitecrm_user_id' IS DISTINCT FROM new_row->'suitecrm_user_id')
      OR ((old_row->>'email'=ANY(users) OR new_row->>'email'=ANY(users))
        AND (old_row->'email',old_row->'status') IS DISTINCT FROM (new_row->'email',new_row->'status'));
  ELSIF TG_TABLE_NAME='app_user_organization_memberships' THEN
    affected:=(old_row->>'user_email'=ANY(users) OR new_row->>'user_email'=ANY(users))
      AND (old_row->>'organization_id'=ANY(workspaces) OR new_row->>'organization_id'=ANY(workspaces))
      AND (old_row->'user_email',old_row->'organization_id',old_row->'status',old_row->'role',old_row->'permissions',old_row->'trashed_at') IS DISTINCT FROM
        (new_row->'user_email',new_row->'organization_id',new_row->'status',new_row->'role',new_row->'permissions',new_row->'trashed_at');
  ELSIF TG_TABLE_NAME='workspace_organizations' THEN
    affected:=(old_row->>'id'=ANY(workspaces) OR new_row->>'id'=ANY(workspaces))
      AND (old_row->'id',old_row->'parent_id',old_row->'organization_type',old_row->'is_demo') IS DISTINCT FROM
        (new_row->'id',new_row->'parent_id',new_row->'organization_type',new_row->'is_demo');
  ELSIF TG_TABLE_NAME='pipeline_spaces' THEN
    affected:=(old_row->>'workspace_organization_id'=ANY(workspaces) OR new_row->>'workspace_organization_id'=ANY(workspaces))
      AND (old_row->'id',old_row->'workspace_organization_id',old_row->'owner_email',old_row->'reference_access_disabled') IS DISTINCT FROM
        (new_row->'id',new_row->'workspace_organization_id',new_row->'owner_email',new_row->'reference_access_disabled');
  ELSE RAISE EXCEPTION 'Unknown root registry snapshot source' USING ERRCODE='55000'; END IF;
  IF affected THEN RAISE EXCEPTION 'Root registry actual source is pinned during native transition' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END $$;
CREATE TRIGGER crm_native_root_registry_user_snapshot BEFORE INSERT OR UPDATE OR DELETE ON app_users
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_snapshot_guard();
CREATE TRIGGER crm_native_root_registry_member_snapshot BEFORE INSERT OR UPDATE OR DELETE ON app_user_organization_memberships
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_snapshot_guard();
CREATE TRIGGER crm_native_root_registry_workspace_snapshot BEFORE UPDATE OR DELETE ON workspace_organizations
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_snapshot_guard();
CREATE TRIGGER crm_native_root_registry_pipeline_snapshot BEFORE INSERT OR UPDATE OR DELETE ON pipeline_spaces
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_registry_snapshot_guard();
REVOKE ALL ON FUNCTION clawpilot_crm_root_registry_snapshot_guard() FROM PUBLIC;

-- An unlinked employee has no native principal to grant or revoke. Ordinary
-- scoped app access/status/trash updates remain possible while policy is idle;
-- mapped users and operator owners still require the native-first protocol.
-- Never allow a source snapshot to drift during publication or a transition.
CREATE FUNCTION clawpilot_crm_root_app_only_membership_is_independent(old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF old_row IS NULL OR new_row IS NULL
    OR (old_row->>'user_email',old_row->>'organization_id') IS DISTINCT FROM (new_row->>'user_email',new_row->>'organization_id')
    OR public.clawpilot_crm_root_native_membership_state(old_row)->'valid' IS DISTINCT FROM 'true'::jsonb
    OR public.clawpilot_crm_root_native_membership_state(new_row)->'valid' IS DISTINCT FROM 'true'::jsonb THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM public.app_users u WHERE u.email=old_row->>'user_email' AND u.suitecrm_user_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a WHERE a.owner_email=old_row->>'user_email');
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_root_app_only_membership_is_independent(jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION clawpilot_crm_native_root_source_guard() RETURNS trigger
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
    IF active AND transition IS NULL AND operation IS NULL AND TG_TABLE_NAME='app_user_organization_memberships' AND TG_OP='UPDATE'
      AND public.clawpilot_crm_root_app_only_membership_is_independent(old_row,new_row) THEN
      RETURN NEW;
    END IF;
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
CREATE TRIGGER crm_native_root_change_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_native_email_authority_root_changes
  FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_root_change_ledger_guard();
CREATE TRIGGER crm_native_root_change_no_truncate BEFORE TRUNCATE ON crm_native_email_authority_root_changes
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_root_change_ledger_guard();
CREATE CONSTRAINT TRIGGER crm_native_root_change_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_root_changes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_complete();
REVOKE ALL ON crm_native_email_authority_root_changes FROM PUBLIC;
REVOKE ALL ON FUNCTION clawpilot_crm_root_registry_projection(text,jsonb),
  clawpilot_crm_root_registry_current_row(text,text,uuid),clawpilot_crm_root_registry_change_rows(jsonb),
  clawpilot_crm_root_change_ledger_guard() FROM PUBLIC;

-- Forward definitions preserve every existing membership, lifecycle and identity action.
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
    ELSIF NEW.plan->'desiredAppChange'->>'kind'='root_registry_v1' THEN
      expected:=NEW.plan->'desiredAppChange';
      SELECT count(*) INTO n FROM public.clawpilot_crm_root_registry_change_rows(expected);
      IF n NOT BETWEEN 1 AND 100 OR NEW.actor_email IS DISTINCT FROM expected->>'ownerEmail'
        OR NOT (NEW.plan->'revoke'->>'version'='2' AND NEW.plan->'grant'->>'version'='2'
          AND NOT (NEW.plan->'revoke' ? 'identityLinks') AND NOT (NEW.plan->'grant' ? 'identityLinks')
          AND NOT (NEW.plan->'revoke' ? 'roleChanges') AND NOT (NEW.plan->'grant' ? 'roleChanges')
          AND NEW.plan->'revoke'->'pendingPublicationCommand'='null'::jsonb
          AND NEW.plan->'grant'->'pendingPublicationCommand'='null'::jsonb) IS TRUE THEN
        RAISE EXCEPTION 'Root registry native phases differ' USING ERRCODE='55000'; END IF;
      IF NOT EXISTS(SELECT 1 FROM public.app_users u
        JOIN public.app_user_organization_memberships m ON m.user_email=u.email
        JOIN public.workspace_organizations w ON w.id=m.organization_id
        WHERE u.email=NEW.actor_email AND u.status='active' AND m.role='owner' AND m.status='active'
          AND m.trashed_at IS NULL AND w.id=(expected->>'workspaceId')::uuid
          AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo)
        OR EXISTS(SELECT 1 FROM public.crm_operator_accounts a
          WHERE (a.id=(expected->>'operatorAccountId')::uuid OR a.root_workspace_id=(expected->>'workspaceId')::uuid)
            AND (a.id::text,a.root_workspace_id::text,a.owner_email) IS DISTINCT FROM
              (expected->>'operatorAccountId',expected->>'workspaceId',expected->>'ownerEmail'))
        OR (NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a WHERE a.id=(expected->>'operatorAccountId')::uuid)
          AND NOT EXISTS(SELECT 1 FROM public.clawpilot_crm_root_registry_change_rows(expected) r
            WHERE r.registry_table='account' AND r.before_row IS NULL))
        OR EXISTS(SELECT 1 FROM public.clawpilot_crm_root_registry_change_rows(expected) r
          WHERE public.clawpilot_crm_root_registry_current_row(r.registry_table,r.row_key,r.operator_account_id)
            IS DISTINCT FROM r.before_row) THEN
        RAISE EXCEPTION 'Root registry owner, anchor or preimage changed' USING ERRCODE='55000'; END IF;

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

CREATE OR REPLACE FUNCTION clawpilot_native_email_transition_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; delta record; expected record; actual jsonb; n integer; kind text; desired jsonb; derived_status text;
BEGIN
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  IF t.app_state='applying' THEN RAISE EXCEPTION 'Native authority app change cannot partially commit' USING ERRCODE='55000'; END IF;
  desired:=t.plan->'desiredAppChange';kind:=desired->>'kind';
  IF (SELECT count(*) FROM public.crm_native_email_authority_phases WHERE transition_id=t.transition_id)<>2 THEN
    RAISE EXCEPTION 'Native authority phase coverage changed' USING ERRCODE='55000'; END IF;
  IF kind<>'root_registry_v1' AND EXISTS(SELECT 1 FROM public.crm_native_email_authority_root_changes WHERE transition_id=t.transition_id) THEN
    RAISE EXCEPTION 'Unrelated root registry evidence is not permitted' USING ERRCODE='55000'; END IF;
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
  ELSIF kind='root_registry_v1' THEN
    SELECT count(*) INTO n FROM public.clawpilot_crm_root_registry_change_rows(desired);
    IF (SELECT count(*) FROM public.crm_native_email_authority_root_changes WHERE transition_id=t.transition_id)<>n
      OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id)
      OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id) THEN
      RAISE EXCEPTION 'Root registry delta coverage changed' USING ERRCODE='55000'; END IF;
    FOR expected IN SELECT * FROM public.clawpilot_crm_root_registry_change_rows(desired) LOOP
      SELECT * INTO delta FROM public.crm_native_email_authority_root_changes
        WHERE transition_id=t.transition_id AND ordinal=expected.ordinal;
      IF NOT FOUND OR (delta.registry_table,delta.operator_account_id,delta.row_key,delta.before_row,delta.after_row) IS DISTINCT FROM
        (expected.registry_table,expected.operator_account_id,expected.row_key,expected.before_row,expected.after_row) THEN
        RAISE EXCEPTION 'Root registry evidence differs from immutable plan' USING ERRCODE='55000'; END IF;
      actual:=public.clawpilot_crm_root_registry_current_row(delta.registry_table,delta.row_key,delta.operator_account_id);
      IF delta.applied IS DISTINCT FROM (t.app_state='committed')
        OR actual IS DISTINCT FROM (CASE WHEN t.app_state='committed' THEN delta.after_row ELSE delta.before_row END) THEN
        RAISE EXCEPTION 'Root registry exact app image differs' USING ERRCODE='55000'; END IF;
    END LOOP;
  ELSE RAISE EXCEPTION 'Native authority action unsupported' USING ERRCODE='55000'; END IF;
  IF t.app_state='aborted' AND (NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases r
      JOIN public.crm_native_email_authority_phases g USING(transition_id)
      WHERE r.transition_id=t.transition_id AND r.phase='revoke' AND r.state='cancelled'
        AND g.phase='grant' AND g.state='prepared' AND g.approval_envelope IS NULL AND g.approval_readback IS NULL AND g.lease_owner IS NULL)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id AND applied)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_user_changes WHERE transition_id=t.transition_id AND applied)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_root_changes WHERE transition_id=t.transition_id AND applied)) THEN
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

CREATE OR REPLACE FUNCTION clawpilot_crm_root_registry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; account_owner text; root_id uuid; target_id uuid;
  native_enabled boolean; active_operation text; active_transition text; authorized boolean:=false;
  kind text; matched integer; actor text;
BEGIN
  SELECT enabled,active_operation_id,active_transition_id
    INTO native_enabled,active_operation,active_transition
    FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF native_enabled OR active_operation IS NOT NULL OR active_transition IS NOT NULL THEN
    IF TG_OP NOT IN ('INSERT','UPDATE') THEN
      RAISE EXCEPTION 'Root CRM history cannot be removed' USING ERRCODE='55000'; END IF;
    kind:=CASE TG_TABLE_NAME WHEN 'crm_operator_accounts' THEN 'account'
      WHEN 'crm_operator_workspace_bindings' THEN 'binding' WHEN 'crm_root_employee_access_grants' THEN 'grant' END;
    old_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;new_row:=to_jsonb(NEW);
    SELECT t.actor_email INTO actor FROM public.crm_native_email_authority_transitions t
      JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
      JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_transition_id=t.transition_id
      WHERE native_enabled AND active_operation IS NULL AND t.transition_id=active_transition
        AND t.plan->'desiredAppChange'->>'kind'='root_registry_v1' AND t.app_state='applying'
        AND t.applying_xid=txid_current() AND p.state='committed' AND c.verified_generation=c.generation
        AND c.generation=(t.plan->'revoke'->>'generationTo')::bigint AND c.activation_receipt_hash=p.receipt_hash
        AND c.native_policy_fingerprint=t.plan->'revoke'->>'afterPolicyFingerprint';
    IF NOT FOUND OR NEW.updated_by IS DISTINCT FROM actor
      OR (TG_OP='INSERT' AND (NEW.created_by IS DISTINCT FROM actor OR NEW.created_at IS DISTINCT FROM transaction_timestamp())) THEN
      RAISE EXCEPTION 'Root CRM intent requires the exact native-first integration' USING ERRCODE='55000'; END IF;
    UPDATE public.crm_native_email_authority_root_changes d SET applied=true
      WHERE d.transition_id=active_transition AND d.registry_table=kind AND NOT d.applied
        AND d.before_row IS NOT DISTINCT FROM public.clawpilot_crm_root_registry_projection(kind,old_row)
        AND d.after_row=public.clawpilot_crm_root_registry_projection(kind,new_row);
    GET DIAGNOSTICS matched=ROW_COUNT;
    IF matched<>1 THEN RAISE EXCEPTION 'Root write differs from exact approved delta' USING ERRCODE='55000'; END IF;
    authorized:=true;
  END IF;
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Root CRM registry history must be disabled, not removed' USING ERRCODE='55000';
  END IF;
  new_row:=to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN
    old_row:=to_jsonb(OLD);
    IF (old_row-ARRAY['enabled','revision','updated_by','updated_at'])
       IS DISTINCT FROM (new_row-ARRAY['enabled','revision','updated_by','updated_at'])
      OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Root CRM identity is permanent and changes require the next revision' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.revision<>1 THEN
    RAISE EXCEPTION 'Root CRM registry must start at revision one' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='crm_operator_accounts' THEN
    account_owner:=NEW.owner_email; root_id:=NEW.root_workspace_id; target_id:=root_id;
    IF NOT EXISTS(SELECT 1 FROM public.workspace_organizations w WHERE w.id=root_id
      AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo) THEN
      RAISE EXCEPTION 'Root CRM anchor is not a real root workspace' USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT owner_email,root_workspace_id INTO account_owner,root_id FROM public.crm_operator_accounts
      WHERE id=NEW.operator_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Root CRM account missing' USING ERRCODE='55000'; END IF;
    IF TG_TABLE_NAME='crm_operator_workspace_bindings' THEN target_id:=NEW.workspace_id;
    ELSE
      target_id:=root_id;
      IF NEW.source_workspace_id<>root_id OR NEW.user_email=account_owner THEN
        RAISE EXCEPTION 'Root CRM employee source differs from its anchor' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  -- An inactive owner may still disable historical intent. Creating or enabling
  -- intent requires current ownership and an active real operator workspace.
  IF TG_OP='INSERT' OR NEW.enabled THEN
    IF NOT EXISTS(SELECT 1 FROM public.app_user_organization_memberships m
      JOIN public.app_users u ON u.email=m.user_email JOIN public.workspace_organizations w ON w.id=m.organization_id
      WHERE m.user_email=account_owner AND m.organization_id=target_id AND m.role='owner'
        AND m.status='active' AND m.trashed_at IS NULL AND u.status='active' AND NOT w.is_demo) THEN
      RAISE EXCEPTION 'Root CRM intent requires current operator ownership' USING ERRCODE='55000';
    END IF;
  END IF;
  IF NOT authorized THEN
    UPDATE public.crm_native_email_publication_control SET generation=generation+1,verified_generation=NULL,
      native_policy_fingerprint=NULL,activation_receipt_hash=NULL,updated_at=now() WHERE singleton;
  END IF;
  RETURN NEW;
END $$;
