-- Installed inert: no transition, activation, native approval, role or member
-- is created. Only exact persisted native-first member changes can pass the
-- enabled authority fence. There is no GUC, trigger-disable or timeout bypass.
CREATE TABLE crm_native_email_authority_transitions (
  transition_id text PRIMARY KEY CHECK (transition_id ~ '^[a-f0-9]{64}$'),
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  desired_change_hash text NOT NULL CHECK (desired_change_hash ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=1800000),
  actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  app_state text NOT NULL DEFAULT 'prepared' CHECK (app_state IN ('prepared','applying','committed','aborted')),
  applying_xid bigint,
  app_commit jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((app_state='applying')=(applying_xid IS NOT NULL)),
  CHECK ((app_state='committed')=(app_commit IS NOT NULL))
);
ALTER TABLE crm_native_email_publication_control ADD COLUMN active_transition_id text
  REFERENCES crm_native_email_authority_transitions(transition_id) ON DELETE RESTRICT;
ALTER TABLE crm_native_email_publication_control ADD CONSTRAINT crm_native_email_one_barrier
  CHECK (active_transition_id IS NULL OR (enabled AND active_operation_id IS NULL));

CREATE TABLE crm_native_email_authority_phases (
  transition_id text NOT NULL REFERENCES crm_native_email_authority_transitions(transition_id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (phase IN ('revoke','grant')),
  operation_id text NOT NULL UNIQUE CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  command_hash text NOT NULL CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  command jsonb NOT NULL CHECK (jsonb_typeof(command)='object' AND octet_length(command::text)<=900000),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','dispatched','unknown','committed','cancelled')),
  approval_envelope jsonb,
  approval_readback jsonb,
  native_receipt jsonb,
  receipt_hash text CHECK (receipt_hash ~ '^[a-f0-9]{64}$'),
  lease_owner uuid,
  lease_fence bigint NOT NULL DEFAULT 0 CHECK (lease_fence BETWEEN 0 AND 9007199254740991),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transition_id,phase),
  CHECK ((state IN ('committed','cancelled'))=(native_receipt IS NOT NULL)),
  CHECK ((native_receipt IS NOT NULL)=(receipt_hash IS NOT NULL)),
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK ((lease_owner IS NULL)=(lease_fence=0)),
  CHECK (approval_envelope IS NULL OR (jsonb_typeof(approval_envelope)='object' AND octet_length(approval_envelope::text)<=16000)),
  CHECK (approval_readback IS NULL OR (approval_envelope IS NOT NULL AND jsonb_typeof(approval_readback)='object')),
  CHECK (native_receipt IS NULL OR (native_receipt->>'operationId'=operation_id
    AND native_receipt->>'transitionId'=transition_id AND native_receipt->>'phase'=phase
    AND native_receipt->>'commandHash'=command_hash AND native_receipt->>'state'=state) IS TRUE)
);
CREATE TABLE crm_native_email_authority_member_changes (
  transition_id text NOT NULL REFERENCES crm_native_email_authority_transitions(transition_id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  user_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  before_row jsonb,
  after_row jsonb,
  applied boolean NOT NULL DEFAULT false,
  PRIMARY KEY (transition_id,ordinal),
  UNIQUE (transition_id,pipeline_id,user_email),
  -- Initial implementation is exact add/remove, NOT role-only edits.
  CHECK ((before_row IS NULL)<>(after_row IS NULL)),
  CHECK ((COALESCE(before_row,after_row)->>'pipeline_id'=pipeline_id::text
    AND COALESCE(before_row,after_row)->>'user_email'=user_email
    AND COALESCE(before_row,after_row)->>'access_role' IN ('viewer','editor')) IS TRUE)
);

CREATE FUNCTION clawpilot_native_email_transition_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native authority evidence is retained' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER crm_native_authority_transition_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_authority_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE TRIGGER crm_native_authority_phase_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_authority_phases
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE TRIGGER crm_native_authority_change_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_authority_member_changes
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();

CREATE FUNCTION clawpilot_native_email_transition_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; expected jsonb;
BEGIN
  IF TG_TABLE_NAME='crm_native_email_authority_transitions' THEN
    IF NOT (NEW.app_state='prepared' AND NEW.applying_xid IS NULL AND NEW.app_commit IS NULL
      AND NEW.plan->>'planHash'=NEW.plan_hash AND NEW.plan->'revoke'->>'transitionId'=NEW.transition_id
      AND NEW.plan->'grant'->>'transitionId'=NEW.transition_id
      AND NEW.plan->'revoke'->>'desiredAppChangeHash'=NEW.desired_change_hash
      AND NEW.plan->'grant'->>'desiredAppChangeHash'=NEW.desired_change_hash
      AND NEW.plan->'desiredAppChange'->>'kind'='pipeline_members_v1'
      AND jsonb_typeof(NEW.plan->'desiredAppChange'->'changes')='array'
      AND jsonb_array_length(NEW.plan->'desiredAppChange'->'changes') BETWEEN 1 AND 100) IS TRUE THEN
      RAISE EXCEPTION 'Native authority initial plan invalid' USING ERRCODE='55000'; END IF;
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
      IF NOT (expected=jsonb_build_object('before',NEW.before_row,'after',NEW.after_row)
        AND NOT NEW.applied) IS TRUE THEN
        RAISE EXCEPTION 'Native authority delta differs from immutable plan' USING ERRCODE='55000'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_transition_insert BEFORE INSERT ON crm_native_email_authority_transitions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_insert_guard();
CREATE TRIGGER crm_native_authority_phase_insert BEFORE INSERT ON crm_native_email_authority_phases
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_insert_guard();
CREATE TRIGGER crm_native_authority_change_insert BEFORE INSERT ON crm_native_email_authority_member_changes
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_insert_guard();

CREATE FUNCTION clawpilot_native_email_transition_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='crm_native_email_authority_transitions' THEN
    IF (to_jsonb(NEW)-ARRAY['app_state','applying_xid','app_commit','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['app_state','applying_xid','app_commit','updated_at'])
      OR OLD.app_state IN ('committed','aborted')
      OR NOT ((OLD.app_state='prepared' AND NEW.app_state='applying' AND NEW.applying_xid=txid_current() AND NEW.app_commit IS NULL)
        OR (OLD.app_state='applying' AND OLD.applying_xid=txid_current() AND NEW.app_state='committed' AND NEW.applying_xid IS NULL)
        OR (OLD.app_state='prepared' AND NEW.app_state='aborted' AND NEW.applying_xid IS NULL AND NEW.app_commit IS NULL)) THEN
      RAISE EXCEPTION 'Native transition immutable or invalid phase' USING ERRCODE='55000'; END IF;
  ELSIF TG_TABLE_NAME='crm_native_email_authority_phases' THEN
    IF (to_jsonb(NEW)-ARRAY['state','approval_envelope','approval_readback','native_receipt','receipt_hash','lease_owner','lease_fence','lease_until','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','approval_envelope','approval_readback','native_receipt','receipt_hash','lease_owner','lease_fence','lease_until','updated_at'])
      OR OLD.state IN ('committed','cancelled')
      OR (OLD.approval_envelope IS NOT NULL AND OLD.approval_envelope IS DISTINCT FROM NEW.approval_envelope)
      OR (OLD.approval_readback IS NOT NULL AND OLD.approval_readback IS DISTINCT FROM NEW.approval_readback)
      OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','dispatched'))
      OR (OLD.state='dispatched' AND NEW.state='prepared') OR (OLD.state='unknown' AND NEW.state IN ('prepared','dispatched')) THEN
      RAISE EXCEPTION 'Native authority phase evidence changed' USING ERRCODE='55000'; END IF;
    IF NEW.state<>'prepared' AND (NEW.approval_readback IS NULL OR NEW.lease_owner IS NULL) THEN
      RAISE EXCEPTION 'Native authority dispatch lacks approval and owned lease' USING ERRCODE='55000'; END IF;
    IF (NEW.lease_owner,NEW.lease_fence,NEW.lease_until) IS DISTINCT FROM (OLD.lease_owner,OLD.lease_fence,OLD.lease_until)
      AND (NEW.lease_fence<>OLD.lease_fence+1 OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
        OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '301 seconds') THEN
      RAISE EXCEPTION 'Native authority lease cannot be stolen or extended' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'applied') IS DISTINCT FROM (to_jsonb(OLD)-'applied') OR OLD.applied OR NOT NEW.applied THEN
      RAISE EXCEPTION 'Native authority delta is immutable' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c
      JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
      WHERE c.singleton AND t.transition_id=NEW.transition_id AND t.app_state='applying' AND t.applying_xid=txid_current()) THEN
      RAISE EXCEPTION 'Native member change lacks exact active transaction' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_transition_immutable BEFORE UPDATE ON crm_native_email_authority_transitions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_immutable();
CREATE TRIGGER crm_native_authority_phase_immutable BEFORE UPDATE ON crm_native_email_authority_phases
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_immutable();
CREATE TRIGGER crm_native_authority_change_immutable BEFORE UPDATE ON crm_native_email_authority_member_changes
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_immutable();

CREATE FUNCTION clawpilot_native_email_transition_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; delta record; actual jsonb; count_changes integer; phase_count integer;
BEGIN
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  IF t.app_state='applying' THEN RAISE EXCEPTION 'Native authority app change cannot partially commit' USING ERRCODE='55000'; END IF;
  SELECT count(*) INTO count_changes FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id;
  SELECT count(*) INTO phase_count FROM public.crm_native_email_authority_phases WHERE transition_id=t.transition_id;
  IF NOT (count_changes=jsonb_array_length(t.plan->'desiredAppChange'->'changes') AND phase_count=2) IS TRUE THEN
    RAISE EXCEPTION 'Native authority delta coverage changed' USING ERRCODE='55000'; END IF;
  FOR delta IN SELECT * FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id LOOP
    IF NOT (t.plan->'desiredAppChange'->'changes'->delta.ordinal=jsonb_build_object('before',delta.before_row,'after',delta.after_row)) IS TRUE THEN
      RAISE EXCEPTION 'Native authority delta plan mismatch' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF t.app_state='aborted' AND (NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases r
      JOIN public.crm_native_email_authority_phases g USING(transition_id)
      WHERE r.transition_id=t.transition_id AND r.phase='revoke' AND r.state='cancelled'
        AND g.phase='grant' AND g.state='prepared' AND g.approval_envelope IS NULL
        AND g.approval_readback IS NULL AND g.lease_owner IS NULL)
    OR EXISTS(SELECT 1 FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id AND applied)) THEN
    RAISE EXCEPTION 'Native authority cancellation cannot abort changed application state' USING ERRCODE='55000'; END IF;
  IF t.app_state='committed' THEN
    IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases p WHERE p.transition_id=t.transition_id
      AND p.phase='revoke' AND p.state='committed' AND p.receipt_hash=t.app_commit->>'revokeReceiptHash')
      OR NOT (t.app_commit=jsonb_build_object('version',1,'transitionId',t.transition_id,'planHash',t.plan_hash,
        'desiredAppChangeHash',t.desired_change_hash,'revokeReceiptHash',t.app_commit->>'revokeReceiptHash',
        'appAuthorityBeforeFingerprint',t.plan->>'expectedAppAuthorityBeforeFingerprint',
        'appAuthorityAfterFingerprint',t.plan->>'expectedAppAuthorityAfterFingerprint')) IS TRUE THEN
      RAISE EXCEPTION 'Native authority app receipt incomplete' USING ERRCODE='55000'; END IF;
    FOR delta IN SELECT * FROM public.crm_native_email_authority_member_changes WHERE transition_id=t.transition_id LOOP
      SELECT to_jsonb(m) INTO actual FROM public.pipeline_space_members m WHERE m.pipeline_id=delta.pipeline_id AND m.user_email=delta.user_email;
      IF NOT delta.applied OR actual IS DISTINCT FROM delta.after_row THEN
        RAISE EXCEPTION 'Native authority member postimage mismatch' USING ERRCODE='55000'; END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_native_authority_transition_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_transitions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_complete();
CREATE CONSTRAINT TRIGGER crm_native_authority_phase_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_phases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_complete();
CREATE CONSTRAINT TRIGGER crm_native_authority_change_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_member_changes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_complete();

-- Exact snapshots also include member metadata and workspace eligibility.
-- Their normal non-authority updates stay allowed unless the affected bound
-- scope is inside an unresolved transition. Acquire control BEFORE row locks,
-- including metadata-only UPDATEs and same-role UPSERT conflict updates.
CREATE FUNCTION clawpilot_native_email_transition_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE plan jsonb; old_row jsonb:=to_jsonb(OLD); new_row jsonb:=to_jsonb(NEW); affected boolean;
BEGIN
  SELECT t.plan INTO plan FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id WHERE c.singleton;
  IF plan IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='pipeline_space_members' THEN
    affected:=old_row IS DISTINCT FROM new_row AND EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
      WHERE b->'before'->>'pipeline_id'=OLD.pipeline_id::text OR b->'before'->>'pipeline_id'=NEW.pipeline_id::text);
  ELSIF TG_TABLE_NAME='workspace_organizations' THEN
    affected:=(old_row->'id',old_row->'is_demo') IS DISTINCT FROM (new_row->'id',new_row->'is_demo')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'revoke'->'bindings') b
        WHERE b->'before'->>'workspace_id'=OLD.id::text OR b->'before'->>'workspace_id'=NEW.id::text);
  ELSE RAISE EXCEPTION 'Unknown native snapshot source' USING ERRCODE='55000'; END IF;
  IF affected THEN RAISE EXCEPTION 'Native authority snapshot is pinned during transition' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_member_metadata_lock BEFORE UPDATE OF shared_by,created_at,updated_at ON pipeline_space_members
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE TRIGGER crm_native_authority_member_snapshot BEFORE UPDATE ON pipeline_space_members
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_snapshot_guard();
CREATE TRIGGER crm_native_authority_workspace_snapshot_lock BEFORE UPDATE OF id,is_demo ON workspace_organizations
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();
CREATE TRIGGER crm_native_authority_workspace_snapshot BEFORE UPDATE OF id,is_demo ON workspace_organizations
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_snapshot_guard();

-- The authority matrix pins published Email identities, not message content.
-- This predicate is identical to the adapter's known-Email inventory. Guard
-- both becoming known and ceasing to be known; a timestamp refresh alone is
-- harmless when eligibility and identity do not change.
CREATE FUNCTION clawpilot_native_email_transition_inventory_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE active text;
BEGIN
  SELECT active_transition_id INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native authority control missing' USING ERRCODE='55000'; END IF;
  IF TG_OP='TRUNCATE' AND active IS NOT NULL AND EXISTS(SELECT 1 FROM public.crm_interactions i
    WHERE i.suitecrm_module='Emails' AND (i.suitecrm_synced_at IS NOT NULL OR EXISTS(
      SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=i.id AND a.state='committed'))) THEN
    RAISE EXCEPTION 'Native authority Email inventory is pinned during transition' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION clawpilot_native_email_transition_inventory_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE active text; was_known boolean:=false; will_be_known boolean:=false; changed boolean;
BEGIN
  SELECT active_transition_id INTO active FROM public.crm_native_email_publication_control WHERE singleton;
  IF active IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN was_known:=OLD.suitecrm_module='Emails' AND (OLD.suitecrm_synced_at IS NOT NULL OR EXISTS(
    SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=OLD.id AND a.state='committed')); END IF;
  IF TG_OP<>'DELETE' THEN will_be_known:=NEW.suitecrm_module='Emails' AND (NEW.suitecrm_synced_at IS NOT NULL OR EXISTS(
    SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=NEW.id AND a.state='committed')); END IF;
  changed:=TG_OP<>'UPDATE';
  IF TG_OP='UPDATE' THEN changed:=COALESCE(was_known,false) IS DISTINCT FROM COALESCE(will_be_known,false)
    OR (OLD.id,OLD.pipeline_id,OLD.suitecrm_id,OLD.reference_code,OLD.suitecrm_module)
      IS DISTINCT FROM (NEW.id,NEW.pipeline_id,NEW.suitecrm_id,NEW.reference_code,NEW.suitecrm_module); END IF;
  IF (COALESCE(was_known,false) OR COALESCE(will_be_known,false)) AND changed THEN
    RAISE EXCEPTION 'Native authority Email inventory is pinned during transition' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_inventory_insert_delete_lock BEFORE INSERT OR DELETE OR TRUNCATE ON crm_interactions
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_inventory_lock();
CREATE TRIGGER crm_native_authority_inventory_update_lock BEFORE UPDATE OF id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at ON crm_interactions
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_inventory_lock();
CREATE TRIGGER crm_native_authority_inventory_guard BEFORE INSERT OR UPDATE OF id,pipeline_id,suitecrm_id,reference_code,suitecrm_module,suitecrm_synced_at OR DELETE ON crm_interactions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_inventory_guard();

-- Replace the earlier explicit hold with one exact, ledger-bound exception.
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

CREATE OR REPLACE FUNCTION clawpilot_native_email_control_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE active_state text; phase record;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native control cannot be removed' USING ERRCODE='55000'; END IF;
  IF OLD.enabled AND NOT NEW.enabled THEN RAISE EXCEPTION 'Native authority cannot be disabled' USING ERRCODE='55000'; END IF;
  IF OLD.active_transition_id IS NOT NULL AND (NEW.enabled IS DISTINCT FROM OLD.enabled
    OR NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id) THEN
    RAISE EXCEPTION 'Native transition control identity is pinned' USING ERRCODE='55000'; END IF;
  IF OLD.active_transition_id IS DISTINCT FROM NEW.active_transition_id THEN
    IF OLD.active_transition_id IS NOT NULL THEN
      IF NEW.active_transition_id IS NOT NULL OR (NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases p
        JOIN public.crm_native_email_authority_transitions t USING(transition_id)
        WHERE p.transition_id=OLD.active_transition_id AND p.phase='grant' AND p.state='committed' AND t.app_state='committed'
          AND NEW.generation=(p.command->>'generationTo')::bigint AND NEW.native_policy_fingerprint=p.command->>'afterPolicyFingerprint')
        AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_authority_transitions t
          JOIN public.crm_native_email_authority_phases p ON p.transition_id=t.transition_id AND p.phase='revoke'
          WHERE t.transition_id=OLD.active_transition_id AND t.app_state='aborted' AND p.state='cancelled'
            AND NEW.generation=OLD.generation AND NEW.generation=(p.command->>'generationFrom')::bigint
            AND NEW.verified_generation IS NOT DISTINCT FROM OLD.verified_generation
            AND NEW.activation_receipt_hash IS NOT DISTINCT FROM OLD.activation_receipt_hash
            AND NEW.native_policy_fingerprint=OLD.native_policy_fingerprint
            AND NEW.native_policy_fingerprint=p.command->>'beforePolicyFingerprint')) THEN
        RAISE EXCEPTION 'Native transition remains unresolved' USING ERRCODE='55000'; END IF;
    ELSIF NOT NEW.enabled OR NEW.active_operation_id IS NOT NULL OR NOT EXISTS(
      SELECT 1 FROM public.crm_native_email_authority_transitions t WHERE t.transition_id=NEW.active_transition_id
      AND t.app_state='prepared' AND NEW.generation=(t.plan->'revoke'->>'generationFrom')::bigint
      AND NEW.native_policy_fingerprint=t.plan->'revoke'->>'beforePolicyFingerprint') THEN
      RAISE EXCEPTION 'Native transition does not match current authority' USING ERRCODE='55000'; END IF;
  END IF;
  IF OLD.enabled AND NEW.enabled AND (NEW.generation,NEW.verified_generation,NEW.native_policy_fingerprint,NEW.activation_receipt_hash)
    IS DISTINCT FROM (OLD.generation,OLD.verified_generation,OLD.native_policy_fingerprint,OLD.activation_receipt_hash) THEN
    SELECT p.* INTO phase FROM public.crm_native_email_authority_phases p
      WHERE p.transition_id=OLD.active_transition_id AND p.state='committed'
      AND OLD.generation=(p.command->>'generationFrom')::bigint AND NEW.generation=(p.command->>'generationTo')::bigint
      AND OLD.native_policy_fingerprint=p.command->>'beforePolicyFingerprint' AND NEW.native_policy_fingerprint=p.command->>'afterPolicyFingerprint'
      AND NEW.verified_generation=NEW.generation AND NEW.activation_receipt_hash=p.receipt_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'Native control change lacks exact committed phase receipt' USING ERRCODE='55000'; END IF;
  END IF;
  IF OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id THEN
    SELECT state INTO active_state FROM public.crm_native_email_publication_admissions WHERE operation_id=OLD.active_operation_id;
    IF active_state IS NULL OR active_state NOT IN ('committed','cancelled') THEN RAISE EXCEPTION 'Native publication unresolved' USING ERRCODE='55000'; END IF;
  END IF;
  IF NEW.active_operation_id IS NOT NULL AND NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id THEN
    IF NEW.active_transition_id IS NOT NULL OR NOT NEW.enabled OR NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a
      WHERE a.operation_id=NEW.active_operation_id AND a.state='admitted' AND a.generation=NEW.generation
      AND a.native_policy_fingerprint=NEW.native_policy_fingerprint) THEN RAISE EXCEPTION 'Native admission is blocked' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION clawpilot_native_email_transition_blocks_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE active text;
BEGIN
  SELECT active_transition_id INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF active IS NOT NULL THEN RAISE EXCEPTION 'Native publication awaits authority transition' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_blocks_publication BEFORE INSERT OR UPDATE ON crm_native_email_publication_admissions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_blocks_publication();
