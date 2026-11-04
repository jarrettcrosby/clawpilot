-- Inert on install. This retained initial barrier does not install native code,
-- authenticate a native receipt, drain a remote writer or enable publication.
-- A trusted coordinator must verify the signed native approval and freshly
-- resolve the real receipt/readback. SQL enforces exact durable bindings, not
-- cryptographic proof that caller-provided JSON came from SuiteCRM.
CREATE FUNCTION clawpilot_crm_native_initial_source_snapshot() RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('version',1,'generation',c.generation::text,
  'users',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.email COLLATE "C") FROM (
    SELECT email,status,role,permissions,organization_id,suitecrm_user_id,reference_code,crm_user_enabled,suitecrm_username FROM public.app_users) s),'[]'::jsonb),
  'memberships',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.organization_id,s.user_email COLLATE "C") FROM (
    SELECT user_email,organization_id,status,role,permissions,trashed_at,trashed_by,pre_trash_status FROM public.app_user_organization_memberships) s),'[]'::jsonb),
  'workspaces',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM (
    SELECT id,parent_id,organization_type,is_demo FROM public.workspace_organizations) s),'[]'::jsonb),
  'pipelines',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM (
    SELECT id,owner_email,workspace_organization_id,reference_access_disabled FROM public.pipeline_spaces) s),'[]'::jsonb),
  'pipelineMembers',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pipeline_id,s.user_email COLLATE "C") FROM public.pipeline_space_members s),'[]'::jsonb),
  'operatorAccounts',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.crm_operator_accounts s),'[]'::jsonb),
  'operatorBindings',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.operator_account_id,s.workspace_id) FROM public.crm_operator_workspace_bindings s),'[]'::jsonb),
  'employeeGrants',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.crm_root_employee_access_grants s),'[]'::jsonb),
  'emails',COALESCE((SELECT jsonb_agg(jsonb_build_object('localId',i.id::text,'nativeId',i.suitecrm_id,'globalId',i.reference_code,
    'pipelineId',i.pipeline_id::text,'workspaceId',p.workspace_organization_id::text,
    'archived',COALESCE(lower(i.source_payload->>'archived'),'false') IN ('true','1','yes'),
    'recordFingerprint',encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')) ORDER BY i.suitecrm_id COLLATE "C",i.id)
    FROM public.crm_interactions i JOIN public.pipeline_spaces p ON p.id=i.pipeline_id
    JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id AND NOT w.is_demo
    WHERE i.suitecrm_module='Emails' AND (i.suitecrm_synced_at IS NOT NULL OR EXISTS(
      SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=i.id AND a.state='committed'))),'[]'::jsonb),
  'pendingOutbox',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'targetSystem',s.target_system,
    'aggregateType',s.aggregate_type,'aggregateId',s.aggregate_id,'operation',s.operation,'status',s.status,'attempts',s.attempts,
    'lockedAt',s.locked_at,'lockToken',s.lock_token,'hasError',s.last_error IS NOT NULL,'processedAt',s.processed_at,
    'availableAt',s.available_at,'rowFingerprint',encode(public.digest(to_jsonb(s)::text,'sha256'),'hex')) ORDER BY s.id)
    FROM public.sync_outbox s WHERE s.target_system='suitecrm' AND s.status<>'succeeded'),'[]'::jsonb),
  'capabilityPolicies',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.pipeline_id) FROM public.crm_native_email_capability_policies s),'[]'::jsonb))
 FROM public.crm_native_email_publication_control c WHERE c.singleton
$$;

-- Reserve the app fence BEFORE offline installation, native forecasting or
-- approval signing. No placeholder plan/hash/signature is accepted or needed.
CREATE TABLE crm_native_email_initial_reservations (
 operation_id text PRIMARY KEY CHECK(operation_id ~ '^[a-f0-9]{64}$'),
 actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
 operator_account_id uuid NOT NULL REFERENCES crm_operator_accounts(id) ON DELETE RESTRICT,
 root_workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
 native_instance_id text NOT NULL CHECK(native_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'),
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=6000000),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','activated','cancelled')),
 settling_xid bigint,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(encode(public.digest(source_snapshot::text,'sha256'),'hex')=source_fingerprint),
 CHECK((state='reserved')=(settling_xid IS NULL))
);
CREATE TABLE crm_native_email_initial_enrollments (
 operation_id text PRIMARY KEY CHECK(operation_id ~ '^[a-f0-9]{64}$'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),plan_canonical text NOT NULL CHECK(octet_length(plan_canonical)<=1800000),
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
 native_delta jsonb NOT NULL CHECK(jsonb_typeof(native_delta)='object'),native_delta_canonical text NOT NULL CHECK(octet_length(native_delta_canonical)<=6000000),
 delta_fingerprint text NOT NULL CHECK(delta_fingerprint ~ '^[a-f0-9]{64}$'),
 approval_envelope jsonb NOT NULL,approval_canonical text NOT NULL CHECK(octet_length(approval_canonical)<=16000),
 approval_hash text NOT NULL CHECK(approval_hash ~ '^[a-f0-9]{64}$'),
 actor_email text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
 operator_account_id uuid NOT NULL REFERENCES crm_operator_accounts(id) ON DELETE RESTRICT,
 root_workspace_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
 native_instance_id text NOT NULL CHECK(native_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'),
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=6000000),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'admitted' CHECK(state IN ('admitted','dispatched','unknown','activated','cancelled')),
 native_receipt jsonb,receipt_canonical text,receipt_hash text CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 settling_xid bigint,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(plan_canonical::jsonb=plan AND encode(public.digest(plan_canonical,'sha256'),'hex')=plan_hash),
 CHECK(native_delta_canonical::jsonb=native_delta AND encode(public.digest(native_delta_canonical,'sha256'),'hex')=delta_fingerprint),
 CHECK(approval_canonical::jsonb=approval_envelope AND encode(public.digest(approval_canonical,'sha256'),'hex')=approval_hash),
 CHECK(encode(public.digest(source_snapshot::text,'sha256'),'hex')=source_fingerprint),
 FOREIGN KEY(operation_id) REFERENCES crm_native_email_initial_reservations(operation_id) ON DELETE RESTRICT,
 CHECK((state IN ('activated','cancelled'))=(native_receipt IS NOT NULL) AND (native_receipt IS NOT NULL)=(receipt_canonical IS NOT NULL)
   AND (native_receipt IS NOT NULL)=(receipt_hash IS NOT NULL) AND (state IN ('activated','cancelled'))=(settling_xid IS NOT NULL)),
 CHECK(receipt_canonical IS NULL OR (octet_length(receipt_canonical)<=16000 AND receipt_canonical::jsonb=native_receipt
   AND encode(public.digest(receipt_canonical,'sha256'),'hex')=receipt_hash))
);
ALTER TABLE crm_native_email_publication_control ADD COLUMN active_initial_enrollment_id text
 REFERENCES crm_native_email_initial_reservations(operation_id) ON DELETE RESTRICT;
ALTER TABLE crm_native_email_publication_control ADD CONSTRAINT crm_native_email_initial_exclusive
 CHECK(active_initial_enrollment_id IS NULL OR (NOT enabled AND active_operation_id IS NULL AND active_transition_id IS NULL));

CREATE FUNCTION clawpilot_crm_native_initial_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native initial control missing' USING ERRCODE='55000';END IF;
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Native initial enrollment history is retained' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER crm_native_initial_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_initial_enrollments
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_native_initial_lock();
CREATE TRIGGER crm_native_initial_reservation_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_initial_reservations
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_native_initial_lock();

CREATE FUNCTION clawpilot_crm_native_initial_shape(v jsonb,expected text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT (jsonb_typeof(v)='object' AND v ?& expected AND v-expected='{}'::jsonb) IS TRUE
$$;
CREATE FUNCTION clawpilot_crm_native_initial_reserve() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control;
BEGIN
 SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR c.active_initial_enrollment_id IS NOT NULL
   OR NEW.state<>'reserved' OR NEW.settling_xid IS NOT NULL OR NEW.generation<>c.generation THEN
  RAISE EXCEPTION 'Native initial reservation requires disabled idle publication' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations w ON w.id=a.root_workspace_id
   JOIN public.app_users u ON u.email=a.owner_email JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
   WHERE a.id=NEW.operator_account_id AND a.root_workspace_id=NEW.root_workspace_id AND a.owner_email=NEW.actor_email AND a.enabled
     AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo AND u.status='active' AND u.role='owner'
     AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner') THEN
  RAISE EXCEPTION 'Native initial reservation requires the exact current operator root owner' USING ERRCODE='55000';END IF;
 IF NEW.source_snapshot IS DISTINCT FROM public.clawpilot_crm_native_initial_source_snapshot() THEN
  RAISE EXCEPTION 'Native initial reservation source snapshot changed' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.target_system='suitecrm' AND o.status<>'succeeded'
   AND (o.operation='upsert_user_identity' OR o.status<>'queued' OR o.attempts<>0 OR o.locked_at IS NOT NULL
     OR o.lock_token IS NOT NULL OR o.last_error IS NOT NULL OR o.processed_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'Native initial reservation requires unresolved writers and all identity work to be drained' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_reserve BEFORE INSERT ON crm_native_email_initial_reservations
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_reserve();
CREATE FUNCTION clawpilot_crm_native_initial_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control;p jsonb:=NEW.plan;d jsonb:=NEW.native_delta;
 proof jsonb:=NEW.approval_envelope->'proof';r jsonb:=d->'result';entry jsonb;known jsonb;policy jsonb;n integer;
 reservation public.crm_native_email_initial_reservations;
BEGIN
 SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR c.active_initial_enrollment_id IS DISTINCT FROM NEW.operation_id
   OR NEW.state<>'admitted' OR NEW.native_receipt IS NOT NULL OR NEW.generation<>c.generation THEN
  RAISE EXCEPTION 'Native initial admission requires its already-held reservation' USING ERRCODE='55000';END IF;
 SELECT * INTO reservation FROM public.crm_native_email_initial_reservations WHERE operation_id=NEW.operation_id;
 IF NOT FOUND OR reservation.state<>'reserved' OR (NEW.actor_email,NEW.operator_account_id,NEW.root_workspace_id,NEW.native_instance_id,
   NEW.generation,NEW.source_snapshot,NEW.source_fingerprint) IS DISTINCT FROM (reservation.actor_email,reservation.operator_account_id,
   reservation.root_workspace_id,reservation.native_instance_id,reservation.generation,reservation.source_snapshot,reservation.source_fingerprint) THEN
  RAISE EXCEPTION 'Native initial final plan differs from immutable reservation' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations w ON w.id=a.root_workspace_id
   JOIN public.app_users u ON u.email=a.owner_email JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
   WHERE a.id=NEW.operator_account_id AND a.root_workspace_id=NEW.root_workspace_id AND a.owner_email=NEW.actor_email AND a.enabled
     AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo AND u.status='active' AND u.role='owner'
     AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner') THEN
  RAISE EXCEPTION 'Native initial admission requires the exact current operator root owner' USING ERRCODE='55000';END IF;
 IF NEW.source_snapshot IS DISTINCT FROM public.clawpilot_crm_native_initial_source_snapshot() THEN
  RAISE EXCEPTION 'Native initial source snapshot changed' USING ERRCODE='55000';END IF;
 -- Only untouched queued ordinary work may remain. It is retained and frozen,
 -- not called drained. A retry or uncertain provider outcome must resolve first.
 IF EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.target_system='suitecrm' AND o.status<>'succeeded'
   AND (o.operation='upsert_user_identity' OR o.status<>'queued' OR o.attempts<>0 OR o.locked_at IS NOT NULL
     OR o.lock_token IS NOT NULL OR o.last_error IS NOT NULL OR o.processed_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'Native initial admission requires unresolved writers and all identity work to be drained' USING ERRCODE='55000';END IF;
 IF NOT public.clawpilot_crm_native_initial_shape(p,ARRAY['version','kind','operationId','nativeInstanceId','appGeneration','appSourceFingerprint',
   'nativePolicyBeforeFingerprint','nativeRuntimeBeforeFingerprint','nativePolicyAfterFingerprint','nativeRuntimeAfterFingerprint',
   'principalSuiteCrmUserIds','defaults','emails','pipelines','reviewedRevocations','rootEmployeeGrants'])
   OR NOT (p->>'version'='1' AND p->>'kind'='initial_enrollment_plan_v1' AND p->>'operationId'=NEW.operation_id
     AND p->>'nativeInstanceId'=NEW.native_instance_id AND p->>'appGeneration'=NEW.generation::text
     AND p->>'appSourceFingerprint'=NEW.source_fingerprint AND p->'rootEmployeeGrants'='[]'::jsonb
     AND jsonb_typeof(p->'emails')='array' AND jsonb_array_length(p->'emails') BETWEEN 1 AND 500
     AND jsonb_typeof(p->'pipelines')='array' AND jsonb_array_length(p->'pipelines') BETWEEN 1 AND 100
     AND jsonb_typeof(p->'principalSuiteCrmUserIds')='array' AND jsonb_array_length(p->'principalSuiteCrmUserIds') BETWEEN 1 AND 500) IS TRUE THEN
  RAISE EXCEPTION 'Native initial exact plan shape or source differs' USING ERRCODE='55000';END IF;
 IF NOT public.clawpilot_crm_native_initial_shape(d,ARRAY['version','purpose','operationId','planHash','preparedAt','changes','result','policies'])
   OR NOT (d->>'version'='1' AND d->>'purpose'='clawpilot-native-email-initial-policy-delta'
     AND d->>'operationId'=NEW.operation_id AND d->>'planHash'=NEW.plan_hash
     AND d->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$') IS TRUE
   OR NOT public.clawpilot_crm_native_initial_shape(d->'changes',ARRAY['acl_actions','securitygroups','securitygroups_users','securitygroups_records'])
   OR EXISTS(SELECT 1 FROM jsonb_each(d->'changes') x WHERE jsonb_typeof(x.value)<>'array') THEN
  RAISE EXCEPTION 'Native initial delta differs from exact native forecast' USING ERRCODE='55000';END IF;
 IF NOT public.clawpilot_crm_native_initial_shape(r,ARRAY['generation','appSourceFingerprint','beforePolicyFingerprint','afterPolicyFingerprint',
   'sourceRuntimeFingerprint','installedRuntimeFingerprint','runtimeFingerprint','identityFingerprint','capabilitiesFingerprint','bindingsFingerprint',
   'defaultsFingerprint','emailCount','principalCount']) OR NOT (r->>'generation'=NEW.generation::text
     AND r->>'appSourceFingerprint'=NEW.source_fingerprint AND r->'beforePolicyFingerprint'=p->'nativePolicyBeforeFingerprint'
     AND r->'afterPolicyFingerprint'=p->'nativePolicyAfterFingerprint' AND r->'sourceRuntimeFingerprint'=p->'nativeRuntimeBeforeFingerprint'
     AND r->'runtimeFingerprint'=p->'nativeRuntimeAfterFingerprint' AND r->>'emailCount'=jsonb_array_length(p->'emails')::text
     AND r->>'principalCount'=jsonb_array_length(p->'principalSuiteCrmUserIds')::text) IS TRUE
   OR EXISTS(SELECT 1 FROM jsonb_each(r) x WHERE CASE WHEN x.key IN ('generation','emailCount','principalCount')
     THEN jsonb_typeof(x.value)<>'number' ELSE jsonb_typeof(x.value)<>'string' OR x.value#>>'{}' !~ '^[a-f0-9]{64}$' END) THEN
  RAISE EXCEPTION 'Native initial forecast result is incomplete or differs from plan' USING ERRCODE='55000';END IF;
 IF NOT public.clawpilot_crm_native_initial_shape(NEW.approval_envelope,ARRAY['proof','signature'])
   OR jsonb_typeof(NEW.approval_envelope->'signature')<>'string' OR length(NEW.approval_envelope->>'signature')<>512
   OR NEW.approval_envelope->>'signature' !~ '^[A-Za-z0-9+/]+$'
   OR NOT public.clawpilot_crm_native_initial_shape(proof,ARRAY['version','purpose','issuer','audience','keyId','nativeInstanceId','serviceUserId','oauthClientId',
     'issuedAt','expiresAt','operationId','planHash','appGeneration','appSourceFingerprint','deltaFingerprint','sourceRuntimeFingerprint',
     'installedRuntimeFingerprint','installationJournalFingerprint','preparedAt'])
   OR NOT (proof->>'version'='1' AND proof->>'purpose'='clawpilot-native-email-initial-enrollment-approval'
     AND proof->>'issuer'='clawpilot-pg-initial-enrollment' AND proof->>'audience'='clawpilot-suitecrm-initial-enrollment'
     AND proof->>'operationId'=NEW.operation_id AND proof->>'planHash'=NEW.plan_hash AND proof->>'nativeInstanceId'=NEW.native_instance_id
     AND proof->>'appGeneration'=NEW.generation::text AND proof->>'appSourceFingerprint'=NEW.source_fingerprint
     AND proof->>'deltaFingerprint'=NEW.delta_fingerprint AND proof->'sourceRuntimeFingerprint'=r->'sourceRuntimeFingerprint'
     AND proof->'installedRuntimeFingerprint'=r->'installedRuntimeFingerprint' AND proof->'preparedAt'=d->'preparedAt'
     AND proof->>'keyId' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$'
     AND proof->>'serviceUserId' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
     AND proof->>'oauthClientId' ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
     AND jsonb_typeof(proof->'issuedAt')='number' AND jsonb_typeof(proof->'expiresAt')='number'
     AND proof->>'installationJournalFingerprint' ~ '^[a-f0-9]{64}$' AND proof->>'issuedAt' ~ '^[0-9]{1,16}$'
     AND proof->>'expiresAt' ~ '^[0-9]{1,16}$') IS TRUE THEN
  RAISE EXCEPTION 'Native initial approval differs from admitted plan and delta' USING ERRCODE='55000';END IF;
 IF (proof->>'issuedAt')::bigint<=0 OR (proof->>'issuedAt')::bigint>floor(extract(epoch FROM clock_timestamp()))::bigint+30
   OR (proof->>'expiresAt')::bigint<=floor(extract(epoch FROM clock_timestamp()))::bigint
   OR (proof->>'expiresAt')::bigint<=(proof->>'issuedAt')::bigint
   OR (proof->>'expiresAt')::bigint-(proof->>'issuedAt')::bigint>300 THEN
  RAISE EXCEPTION 'Native initial admission approval expired or outside bounds' USING ERRCODE='55000';END IF;
 IF jsonb_array_length(p->'emails')<>jsonb_array_length(NEW.source_snapshot->'emails') THEN
  RAISE EXCEPTION 'Native initial complete Email inventory differs' USING ERRCODE='55000';END IF;
 FOR known IN SELECT value FROM jsonb_array_elements(NEW.source_snapshot->'emails') LOOP
  SELECT count(*) INTO n FROM jsonb_array_elements(p->'emails') x WHERE x.value->'before'->'localId'=known->'localId'
    AND x.value->'before'->'nativeId'=known->'nativeId' AND x.value->'before'->'globalId'=known->'globalId'
    AND x.value->'before'->'pipelineId'=known->'pipelineId' AND x.value->'before'->'workspaceId'=known->'workspaceId'
    AND x.value->'before'->'archived'=known->'archived'
    AND ((x.value->'before')-'capabilities')=((x.value->'after')-'capabilities');
  IF n<>1 THEN RAISE EXCEPTION 'Native initial Email identity or archive differs' USING ERRCODE='55000';END IF;
 END LOOP;
 IF jsonb_typeof(d->'policies')<>'array' OR jsonb_array_length(d->'policies')<>jsonb_array_length(p->'pipelines') THEN
  RAISE EXCEPTION 'Native initial policy inventory differs' USING ERRCODE='55000';END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p->'pipelines') LOOP
  IF NOT EXISTS(SELECT 1 FROM public.pipeline_spaces s JOIN public.crm_operator_workspace_bindings b ON b.workspace_id=s.workspace_organization_id
    WHERE s.id=(entry->'policy'->>'pipelineId')::uuid AND s.workspace_organization_id=(entry->'policy'->>'workspaceId')::uuid
      AND b.operator_account_id=NEW.operator_account_id AND b.owner_email=NEW.actor_email AND b.enabled AND NOT s.reference_access_disabled) THEN
   RAISE EXCEPTION 'Native initial pipeline is outside explicit operator bindings' USING ERRCODE='55000';END IF;
  SELECT count(*) INTO n FROM jsonb_array_elements(d->'policies') x WHERE public.clawpilot_crm_native_initial_shape(x.value,ARRAY['pipelineId','generation','policy','fingerprint'])
    AND x.value->'policy'=entry->'policy' AND x.value->'pipelineId'=entry->'policy'->'pipelineId'
    AND x.value->>'generation'=NEW.generation::text AND x.value->>'fingerprint' ~ '^[a-f0-9]{64}$';
  IF n<>1 THEN RAISE EXCEPTION 'Native initial policy is not the exact reviewed forecast' USING ERRCODE='55000';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies current WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(d->'policies') x WHERE x.value->>'pipelineId'=current.pipeline_id::text
     AND x.value->>'generation'=current.generation::text AND x.value->'policy'=current.policy AND x.value->>'fingerprint'=current.fingerprint)) THEN
  RAISE EXCEPTION 'Native initial existing policy differs from reviewed forecast' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_admit BEFORE INSERT ON crm_native_email_initial_enrollments
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_admit();
CREATE FUNCTION clawpilot_crm_native_initial_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.crm_native_email_publication_control SET active_initial_enrollment_id=NEW.operation_id,updated_at=clock_timestamp() WHERE singleton;
 RETURN NULL;
END $$;
CREATE TRIGGER crm_native_initial_barrier AFTER INSERT ON crm_native_email_initial_reservations
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_barrier();

CREATE FUNCTION clawpilot_crm_native_initial_control_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE e public.crm_native_email_initial_enrollments;r public.crm_native_email_initial_reservations;
BEGIN
 IF OLD.active_initial_enrollment_id IS NOT NULL THEN
  SELECT * INTO r FROM public.crm_native_email_initial_reservations WHERE operation_id=OLD.active_initial_enrollment_id;
  SELECT * INTO e FROM public.crm_native_email_initial_enrollments WHERE operation_id=OLD.active_initial_enrollment_id;
  IF NEW.active_initial_enrollment_id IS DISTINCT FROM OLD.active_initial_enrollment_id THEN
   IF NOT (NEW.active_initial_enrollment_id IS NULL AND r.state=e.state AND r.settling_xid=txid_current() AND e.settling_xid=txid_current()
    AND ((NEW.enabled AND e.state='activated'
     AND NEW.generation=e.generation AND NEW.verified_generation=e.generation AND NEW.activation_receipt_hash=e.receipt_hash
     AND NEW.native_policy_fingerprint=e.native_delta->'result'->>'afterPolicyFingerprint'
     AND NEW.active_operation_id IS NULL AND NEW.active_transition_id IS NULL)
    OR (NOT NEW.enabled AND e.state='cancelled'
     AND (to_jsonb(NEW)-ARRAY['active_initial_enrollment_id','updated_at'])=(to_jsonb(OLD)-ARRAY['active_initial_enrollment_id','updated_at'])))) IS TRUE THEN
    RAISE EXCEPTION 'Native initial enrollment remains unresolved' USING ERRCODE='55000';END IF;
  ELSIF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
   RAISE EXCEPTION 'Native initial control is pinned while unresolved' USING ERRCODE='55000';END IF;
 ELSIF NEW.active_initial_enrollment_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_initial_reservations x WHERE x.operation_id=NEW.active_initial_enrollment_id
    AND x.state='reserved' AND x.generation=OLD.generation AND NOT OLD.enabled AND NOT NEW.enabled
    AND (to_jsonb(NEW)-ARRAY['active_initial_enrollment_id','updated_at'])=(to_jsonb(OLD)-ARRAY['active_initial_enrollment_id','updated_at'])) THEN
   RAISE EXCEPTION 'Native initial control lacks its exact admission' USING ERRCODE='55000';END IF;
 ELSIF NEW.enabled AND NOT OLD.enabled THEN
  RAISE EXCEPTION 'First native Email enable requires its retained committed initial receipt' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_control_guard BEFORE UPDATE ON crm_native_email_publication_control
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_control_guard();

CREATE FUNCTION clawpilot_crm_native_initial_settle_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r jsonb:=NEW.native_receipt;c public.crm_native_email_publication_control;
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','native_receipt','receipt_canonical','receipt_hash','settling_xid','updated_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','native_receipt','receipt_canonical','receipt_hash','settling_xid','updated_at'])
   OR OLD.state IN ('activated','cancelled') OR (OLD.state='unknown' AND NEW.state IN ('admitted','dispatched'))
   OR (OLD.state='dispatched' AND NEW.state='admitted') THEN
  RAISE EXCEPTION 'Native initial identity or terminal evidence is immutable' USING ERRCODE='55000';END IF;
 SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.active_initial_enrollment_id IS DISTINCT FROM NEW.operation_id OR c.enabled OR c.generation<>NEW.generation
   OR (public.clawpilot_crm_native_initial_source_snapshot()-'capabilityPolicies') IS DISTINCT FROM (NEW.source_snapshot-'capabilityPolicies') THEN
  RAISE EXCEPTION 'Native initial settlement lost exact source or barrier' USING ERRCODE='55000';END IF;
 IF NEW.state IN ('activated','cancelled') AND NOT (NEW.settling_xid=txid_current()
   AND public.clawpilot_crm_native_initial_shape(r,ARRAY['version','purpose','operationId','planHash','approvalHash','state','result'])
   AND r->>'version'='1' AND r->>'purpose'='clawpilot-native-email-initial-enrollment-receipt'
   AND r->>'operationId'=NEW.operation_id AND r->>'planHash'=NEW.plan_hash AND r->>'approvalHash'=NEW.approval_hash
   AND ((NEW.state='activated' AND r->>'state'='committed' AND r->'result'=NEW.native_delta->'result')
     OR (NEW.state='cancelled' AND r->>'state'='cancelled' AND r->'result'='null'::jsonb
       AND floor(extract(epoch FROM clock_timestamp()))::bigint>=(NEW.approval_envelope->'proof'->>'expiresAt')::bigint
       AND public.clawpilot_crm_native_initial_source_snapshot()=NEW.source_snapshot))) IS TRUE THEN
  RAISE EXCEPTION 'Native initial settlement needs exact committed or expired-cancelled native receipt' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_settle BEFORE UPDATE ON crm_native_email_initial_enrollments
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_settle_guard();
CREATE FUNCTION clawpilot_crm_native_initial_reservation_settle() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','settling_xid','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','settling_xid','updated_at'])
   OR OLD.state<>'reserved' OR NEW.state NOT IN ('activated','cancelled') OR NEW.settling_xid IS DISTINCT FROM txid_current()
   OR NOT EXISTS(SELECT 1 FROM public.crm_native_email_initial_enrollments e JOIN public.crm_native_email_publication_control c
     ON c.singleton AND c.active_initial_enrollment_id=e.operation_id
     WHERE e.operation_id=NEW.operation_id AND e.state=NEW.state AND e.settling_xid=NEW.settling_xid AND NOT c.enabled) THEN
  RAISE EXCEPTION 'Native initial reservation identity or terminal receipt differs' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_reservation_settle BEFORE UPDATE ON crm_native_email_initial_reservations
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_reservation_settle();

CREATE FUNCTION clawpilot_crm_native_initial_source_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE active text;
BEGIN
 SELECT active_initial_enrollment_id INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native initial control missing' USING ERRCODE='55000';END IF;
 IF active IS NOT NULL THEN RAISE EXCEPTION 'Native initial enrollment pins all reviewed sources and writers' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $$;
DO $$DECLARE t text;columns text;BEGIN
 -- Harmless profile/login timestamps and display names are not authority
 -- inputs. Freeze the exact projected keys without globally stopping login.
 FOREACH t IN ARRAY ARRAY['app_users','app_user_organization_memberships','workspace_organizations','pipeline_spaces'] LOOP
  columns:=CASE t WHEN 'app_users' THEN 'email,status,role,permissions,organization_id,suitecrm_user_id,reference_code,crm_user_enabled,suitecrm_username'
    WHEN 'app_user_organization_memberships' THEN 'user_email,organization_id,status,role,permissions,trashed_at,trashed_by,pre_trash_status'
    WHEN 'workspace_organizations' THEN 'id,parent_id,organization_type,is_demo'
    WHEN 'pipeline_spaces' THEN 'id,owner_email,workspace_organization_id,reference_access_disabled' END;
  EXECUTE format('CREATE TRIGGER crm_native_initial_source_fence BEFORE INSERT OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()',t);
  EXECUTE format('CREATE TRIGGER crm_native_initial_source_update_fence BEFORE UPDATE OF %s ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()',columns,t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['pipeline_space_members',
  'crm_operator_accounts','crm_operator_workspace_bindings','crm_root_employee_access_grants','crm_interactions','crm_organizations','crm_contacts',
  'crm_interaction_organizations','crm_email_sources','crm_email_review_decisions','crm_email_mailbox_bindings','crm_email_mailboxes',
  'crm_native_email_publication_admissions','crm_native_email_publication_work','crm_native_email_authority_transitions',
  'crm_native_email_authority_phases','crm_native_email_authority_member_changes','crm_native_email_authority_user_changes',
  'crm_native_email_authority_root_changes','crm_native_email_authority_grant_attempts'] LOOP
  EXECUTE format('CREATE TRIGGER crm_native_initial_source_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()',t);
 END LOOP;
END $$;
-- A shared outbox can contain unrelated provider work. Take control before its
-- row locks, but refuse only rows touching SuiteCRM; never erase/relabel jobs.
CREATE TRIGGER crm_native_initial_outbox_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON sync_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_work_statement_lock();
CREATE FUNCTION clawpilot_crm_native_initial_outbox_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.crm_native_email_publication_control WHERE singleton AND active_initial_enrollment_id IS NOT NULL)
   AND (TG_OP='TRUNCATE' OR (TG_OP<>'INSERT' AND OLD.target_system='suitecrm') OR (TG_OP<>'DELETE' AND NEW.target_system='suitecrm')) THEN
  RAISE EXCEPTION 'Native initial enrollment freezes native outbox writes and identity dispatch' USING ERRCODE='55000';END IF;
 IF TG_LEVEL='STATEMENT' THEN RETURN NULL;END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_outbox_fence BEFORE INSERT OR UPDATE OR DELETE ON sync_outbox
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_outbox_fence();
CREATE TRIGGER crm_native_initial_outbox_truncate BEFORE TRUNCATE ON sync_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_native_initial_outbox_fence();

CREATE FUNCTION clawpilot_crm_native_initial_policy_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE e public.crm_native_email_initial_enrollments;active text;
BEGIN
 SELECT active_initial_enrollment_id INTO active FROM public.crm_native_email_publication_control WHERE singleton;
 SELECT x.* INTO e FROM public.crm_native_email_publication_control c JOIN public.crm_native_email_initial_enrollments x
  ON x.operation_id=c.active_initial_enrollment_id WHERE c.singleton;
 IF active IS NOT NULL AND NOT (FOUND AND TG_OP IN ('INSERT','UPDATE') AND e.state='activated' AND e.settling_xid=txid_current()
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.native_delta->'policies') p WHERE p.value->>'pipelineId'=NEW.pipeline_id::text
     AND p.value->>'generation'=NEW.generation::text AND p.value->'policy'=NEW.policy AND p.value->>'fingerprint'=NEW.fingerprint)) IS TRUE THEN
  RAISE EXCEPTION 'Native initial capability policy is not its exact atomic postimage' USING ERRCODE='55000';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER crm_native_initial_policy_fence BEFORE INSERT OR UPDATE OR DELETE ON crm_native_email_capability_policies
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_policy_fence();
CREATE TRIGGER crm_native_initial_policy_truncate BEFORE TRUNCATE ON crm_native_email_capability_policies
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_native_initial_source_fence();

CREATE FUNCTION clawpilot_crm_native_initial_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE e public.crm_native_email_initial_enrollments;r public.crm_native_email_initial_reservations;c public.crm_native_email_publication_control;n integer;
BEGIN
 SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton;
 FOR r IN SELECT * FROM public.crm_native_email_initial_reservations LOOP
  SELECT * INTO e FROM public.crm_native_email_initial_enrollments WHERE operation_id=r.operation_id;
  IF r.state='reserved' AND (c.active_initial_enrollment_id IS DISTINCT FROM r.operation_id OR e.state IN ('activated','cancelled')) THEN
   RAISE EXCEPTION 'Unresolved initial enrollment must retain its durable barrier' USING ERRCODE='55000';END IF;
  IF r.state IN ('activated','cancelled') AND r.settling_xid=txid_current() THEN
   IF NOT (e.state=r.state AND e.settling_xid=r.settling_xid AND c.active_initial_enrollment_id IS NULL) IS TRUE THEN
    RAISE EXCEPTION 'Native initial reservation, receipt and control must settle together' USING ERRCODE='55000';END IF;
   IF r.state='cancelled' THEN
    IF c.enabled OR public.clawpilot_crm_native_initial_source_snapshot() IS DISTINCT FROM r.source_snapshot THEN
     RAISE EXCEPTION 'Native initial cancellation must retain disabled unchanged baseline' USING ERRCODE='55000';END IF;
    CONTINUE;
   END IF;
   IF NOT (c.enabled AND c.active_initial_enrollment_id IS NULL AND c.generation=e.generation AND c.verified_generation=e.generation
     AND c.native_policy_fingerprint=e.native_delta->'result'->>'afterPolicyFingerprint' AND c.activation_receipt_hash=e.receipt_hash) IS TRUE THEN
    RAISE EXCEPTION 'Native initial receipt and activation must commit atomically' USING ERRCODE='55000';END IF;
   SELECT count(*) INTO n FROM public.crm_native_email_capability_policies;
   IF n<>jsonb_array_length(e.native_delta->'policies') OR EXISTS(SELECT 1 FROM jsonb_array_elements(e.native_delta->'policies') p
     WHERE NOT EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies current WHERE current.pipeline_id::text=p.value->>'pipelineId'
       AND current.generation::text=p.value->>'generation' AND current.policy=p.value->'policy' AND current.fingerprint=p.value->>'fingerprint')) THEN
    RAISE EXCEPTION 'Native initial activation lacks complete exact policy postimages' USING ERRCODE='55000';END IF;
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_native_initial_complete AFTER INSERT OR UPDATE ON crm_native_email_initial_enrollments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_complete();
CREATE CONSTRAINT TRIGGER crm_native_initial_reservation_complete AFTER INSERT OR UPDATE ON crm_native_email_initial_reservations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_complete();
CREATE CONSTRAINT TRIGGER crm_native_initial_control_complete AFTER UPDATE ON crm_native_email_publication_control
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_native_initial_complete();
REVOKE ALL ON crm_native_email_initial_enrollments,crm_native_email_initial_reservations FROM PUBLIC;
REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_source_snapshot(),clawpilot_crm_native_initial_lock(),
 clawpilot_crm_native_initial_shape(jsonb,text[]),clawpilot_crm_native_initial_reserve(),clawpilot_crm_native_initial_admit(),clawpilot_crm_native_initial_barrier(),
 clawpilot_crm_native_initial_reservation_settle(),
 clawpilot_crm_native_initial_control_guard(),clawpilot_crm_native_initial_settle_guard(),clawpilot_crm_native_initial_source_fence(),
 clawpilot_crm_native_initial_outbox_fence(),clawpilot_crm_native_initial_policy_fence(),clawpilot_crm_native_initial_complete() FROM PUBLIC;
