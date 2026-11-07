-- An exact private continuation of a 0404 hold. Nothing is enrolled or granted
-- here. The separately authorized controller verifies signed approval/native
-- evidence; hashes below bind that evidence, they do not authenticate it.
CREATE TABLE crm_legacy_email_recovery_releases (
  hold_id uuid PRIMARY KEY REFERENCES crm_legacy_email_recovery_holds(operation_id) ON DELETE RESTRICT,
  outbox_id uuid NOT NULL UNIQUE REFERENCES crm_legacy_email_recovery_holds(outbox_id) ON DELETE RESTRICT,
  native_operation_id text NOT NULL UNIQUE CHECK(native_operation_id ~ '^[0-9a-f]{64}$')
    REFERENCES crm_native_email_publication_admissions(operation_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  activation_receipt_hash text NOT NULL CHECK(activation_receipt_hash ~ '^[0-9a-f]{64}$'),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
  -- The envelope consumed by this admission may be newer than the hold.
  approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
  source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
  claim_fingerprint text NOT NULL CHECK(claim_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE crm_legacy_email_recovery_settlements (
  native_operation_id text PRIMARY KEY REFERENCES crm_legacy_email_recovery_releases(native_operation_id) ON DELETE RESTRICT,
  state text NOT NULL CHECK(state IN ('committed','cancelled')),
  receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),
  metadata_hash text CHECK(metadata_hash ~ '^[0-9a-f]{64}$'),
  settled_at timestamptz NOT NULL,
  settling_xid xid8 NOT NULL,
  CHECK((state='committed')=(metadata_hash IS NOT NULL))
);
REVOKE ALL ON crm_legacy_email_recovery_releases,crm_legacy_email_recovery_settlements FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_immutable_release() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 RAISE EXCEPTION 'Private Email recovery release evidence is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_immutable_release() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_release_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_recovery_releases
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();
CREATE TRIGGER crm_legacy_email_release_no_truncate BEFORE TRUNCATE ON crm_legacy_email_recovery_releases
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();
CREATE TRIGGER crm_legacy_email_settlement_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_recovery_settlements
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();
CREATE TRIGGER crm_legacy_email_settlement_no_truncate BEFORE TRUNCATE ON crm_legacy_email_recovery_settlements
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();

-- Called only inside the publication store's validator, after work registration
-- but before admission insert. The commit-time binding closes the reverse edge.
CREATE FUNCTION clawpilot_crm_legacy_email_register_release(p_hold uuid,p_outbox uuid,p_operation text,
 p_request text,p_activation text,p_intent text,p_approval text,p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; h public.crm_legacy_email_recovery_holds;
 w public.crm_native_email_publication_work; i public.crm_interactions; o public.sync_outbox;
BEGIN
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled IS DISTINCT FROM true OR c.verified_generation IS DISTINCT FROM c.generation
   OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR c.active_initial_enrollment_id IS NOT NULL
   OR p_activation IS NULL OR c.activation_receipt_hash IS DISTINCT FROM p_activation THEN
  RAISE EXCEPTION 'Private Email recovery release requires exact idle verified authority' USING ERRCODE='55000';
 END IF;
 SELECT * INTO h FROM public.crm_legacy_email_recovery_holds WHERE operation_id=p_hold AND outbox_id=p_outbox;
 IF NOT FOUND OR h.release_intent_hash IS DISTINCT FROM p_intent
   OR (p_approval ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'Private Email recovery release does not match its approved hold' USING ERRCODE='55000';
 END IF;
 SELECT * INTO w FROM public.crm_native_email_publication_work WHERE operation_id=p_operation FOR UPDATE;
 SELECT * INTO i FROM public.crm_interactions WHERE id=h.local_id FOR UPDATE;
 SELECT * INTO o FROM public.sync_outbox WHERE id=h.outbox_id FOR UPDATE;
 IF (w.work_kind='outbox' AND w.request_fingerprint=p_request AND w.lease_fence=1 AND w.lease_until>clock_timestamp()
   AND w.context->>'outboxId'=o.id::text AND w.context->>'idempotencyKey'=o.idempotency_key
   AND w.context->>'sourceHash'=i.source_hash AND w.context->>'attempt'=o.attempts::text
   AND i.pipeline_id=h.pipeline_id AND i.suitecrm_module='Emails' AND i.suitecrm_id=h.native_id AND i.reference_code=h.global_id
   AND i.sync_status='failed' AND i.suitecrm_synced_at IS NULL AND lower(i.source_key) NOT LIKE 'suitecrm%'
   AND COALESCE(lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND jsonb_typeof(i.metadata)='object' AND NOT (i.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
   AND p_source=encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')
   AND o.id=h.outbox_id AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text
   AND o.operation='upsert_record' AND o.status='processing' AND o.attempts=1 AND o.processed_at IS NULL
   AND o.lock_token IS NOT NULL AND o.locked_at IS NOT NULL AND o.available_at='infinity'::timestamptz
   AND o.idempotency_key='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
   AND o.payload->>'entity'='interactions' AND o.payload->>'localId'=i.id::text AND o.payload->>'pipelineId'=i.pipeline_id::text
   AND o.payload->>'suiteCrmId'=h.native_id AND o.payload->>'suiteCrmModule'='Emails' AND o.payload->>'previousSuiteCrmModule' IS NULL
   AND o.payload#>>'{attributes,global_id_c}'=h.global_id) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.sync_outbox x WHERE x.id=h.retired_outbox_id)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a
       WHERE a.local_id=h.local_id OR lower(a.native_id)=h.native_id OR lower(a.global_id)=h.global_id) THEN
  RAISE EXCEPTION 'Private Email recovery release source or claim changed' USING ERRCODE='55000';
 END IF;
 INSERT INTO public.crm_legacy_email_recovery_releases(hold_id,outbox_id,native_operation_id,request_fingerprint,generation,
   activation_receipt_hash,intent_hash,approval_hash,source_fingerprint,claim_fingerprint)
 VALUES(h.operation_id,o.id,p_operation,p_request,c.generation,p_activation,p_intent,p_approval,p_source,
   encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'));
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_register_release(uuid,uuid,text,text,text,text,text,text) FROM PUBLIC;

-- Even a caller reaching the ordinary admission table cannot sidestep a hold.
-- The statement lock is first so a pre-hold REPEATABLE READ snapshot must
-- serialize on 0404's control update instead of silently missing the hold.
CREATE FUNCTION clawpilot_crm_legacy_email_admission_insert_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Private Email recovery control missing' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_admission_insert_lock() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_admission_insert_lock BEFORE INSERT ON crm_native_email_publication_admissions
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_admission_insert_lock();

CREATE FUNCTION clawpilot_crm_legacy_email_admission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h
     WHERE h.local_id=NEW.local_id OR h.native_id=lower(NEW.native_id) OR h.global_id=lower(NEW.global_id))
   AND NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_releases r
     JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=r.hold_id AND h.outbox_id=r.outbox_id
     WHERE r.native_operation_id=NEW.operation_id AND r.request_fingerprint=NEW.request_fingerprint
       AND h.local_id=NEW.local_id AND h.native_id=NEW.native_id AND h.global_id=NEW.global_id AND h.pipeline_id=NEW.pipeline_id) THEN
  RAISE EXCEPTION 'Private Email recovery admission requires its exact release' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_admission_guard() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_admission_guard BEFORE INSERT ON crm_native_email_publication_admissions
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_admission_guard();

CREATE FUNCTION clawpilot_crm_legacy_email_release_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h
   JOIN public.crm_native_email_publication_admissions a ON a.operation_id=NEW.native_operation_id
   JOIN public.crm_native_email_publication_work w ON w.operation_id=a.operation_id
   JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_operation_id=a.operation_id
   JOIN public.pipeline_spaces p ON p.id=h.pipeline_id
   JOIN public.sync_outbox o ON o.id=h.outbox_id
   LEFT JOIN public.crm_native_email_capability_policies policy ON policy.pipeline_id=h.pipeline_id
   WHERE h.operation_id=NEW.hold_id AND h.outbox_id=NEW.outbox_id AND h.release_intent_hash=NEW.intent_hash
     AND a.request_fingerprint=NEW.request_fingerprint AND w.request_fingerprint=a.request_fingerprint
     AND a.pipeline_id=h.pipeline_id AND a.local_id=h.local_id AND a.native_id=h.native_id AND a.global_id=h.global_id
     AND a.state='admitted' AND a.command->>'mode'='publish' AND a.command->'expectedRecordFingerprint'='null'::jsonb
     AND a.command->>'operationId'=a.operation_id AND a.command->>'workspaceId'=p.workspace_organization_id::text
     AND a.command->>'pipelineId'=h.pipeline_id::text AND a.command->>'localId'=h.local_id::text
     AND a.command->>'suiteCrmId'=h.native_id AND a.command->>'globalId'=h.global_id
     AND a.command->>'generation'=a.generation::text AND a.command->>'audienceFingerprint'=a.audience_fingerprint
     AND a.command#>'{projection,previousManaged}'='{"accounts":[],"contacts":[]}'::jsonb
     AND a.command#>'{projection,attributes}'=o.payload->'attributes'
     AND a.command#>'{projection,accounts}'=o.payload#>'{emailProjection,accounts}'
     AND a.command#>'{projection,contacts}'=o.payload#>'{emailProjection,contacts}'
     AND a.command#>'{projection,contactAccounts}'=o.payload#>'{emailProjection,contactAccounts}'
     AND a.audience_fingerprint=o.payload#>>'{emailProjection,audience,fingerprint}'
     AND a.allowed_reader_ids=o.payload#>'{emailProjection,audience,allowedSuiteCrmUserIds}'
     AND c.enabled AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
     AND a.generation=NEW.generation AND c.generation=a.generation AND c.verified_generation=c.generation
     AND c.activation_receipt_hash=NEW.activation_receipt_hash AND a.native_policy_fingerprint=c.native_policy_fingerprint
     AND w.work_kind='outbox' AND w.context->>'outboxId'=h.outbox_id::text
     AND ((a.command->>'version'='1' AND policy.pipeline_id IS NULL) OR (a.command->>'version'='2'
       AND policy.generation=a.generation AND policy.fingerprint=a.command->>'capabilityPolicyFingerprint'
       AND policy.policy->'principalSuiteCrmUserIds'=a.command->'principalSuiteCrmUserIds'
       AND policy.policy->'futureCreate'=a.command->'expectedCapabilities'
       AND policy.policy->>'audienceFingerprint'=a.audience_fingerprint
       AND policy.policy#>'{futureCreate,view}'=a.allowed_reader_ids))) THEN
  RAISE EXCEPTION 'Private Email recovery release has no exact new native admission' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_release_binding() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER crm_legacy_email_release_binding AFTER INSERT ON crm_legacy_email_recovery_releases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_release_binding();

-- The normal publication store must not clear a held job's terminal barrier
-- without its private receipt-bound settlement. Deferred because the trusted
-- controller writes the verified admission receipt before exact finalization.
CREATE FUNCTION clawpilot_crm_legacy_email_require_settlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.state IN ('committed','cancelled') AND EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_releases r
     WHERE r.native_operation_id=NEW.operation_id)
   AND NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_settlements s WHERE s.native_operation_id=NEW.operation_id
     AND s.state=NEW.state AND s.receipt_hash=encode(public.digest(NEW.native_receipt::text,'sha256'),'hex')) THEN
  RAISE EXCEPTION 'Private Email recovery terminal admission lacks exact settlement' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_require_settlement() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER crm_legacy_email_require_settlement AFTER UPDATE OF state ON crm_native_email_publication_admissions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_require_settlement();

-- This exception permits only a protected same-transaction preimage -> exact
-- postimage. A custom GUC, regular worker, public endpoint or stale lease never
-- creates the permit. It cannot permit writes to the retired outbox UUID.
CREATE FUNCTION clawpilot_crm_legacy_email_allowed_settlement(p_table text,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_settlements s
   JOIN public.crm_legacy_email_recovery_releases r USING(native_operation_id)
   JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=r.hold_id AND h.outbox_id=r.outbox_id
   WHERE s.settling_xid=pg_current_xact_id_if_assigned()
     AND CASE p_table WHEN 'crm_interactions' THEN
       s.state='committed' AND p_old->>'id'=h.local_id::text
       AND encode(public.digest(p_old::text,'sha256'),'hex')=r.source_fingerprint
       AND p_new-ARRAY['sync_status','sync_error','suitecrm_synced_at','updated_at','metadata']
           =p_old-ARRAY['sync_status','sync_error','suitecrm_synced_at','updated_at','metadata']
       AND p_new->>'sync_status'='synced' AND p_new->'sync_error'='null'::jsonb
       AND p_new->'suitecrm_synced_at'=to_jsonb(s.settled_at) AND p_new->'updated_at'=to_jsonb(s.settled_at)
       AND encode(public.digest((p_new->'metadata')::text,'sha256'),'hex')=s.metadata_hash
     WHEN 'sync_outbox' THEN
       p_old->>'id'=h.outbox_id::text AND encode(public.digest(p_old::text,'sha256'),'hex')=r.claim_fingerprint
       AND p_new-ARRAY['status','last_error','locked_at','lock_token','processed_at','updated_at']
           =p_old-ARRAY['status','last_error','locked_at','lock_token','processed_at','updated_at']
       AND p_new->'locked_at'='null'::jsonb AND p_new->'lock_token'='null'::jsonb
       AND p_new->'processed_at'=to_jsonb(s.settled_at) AND p_new->'updated_at'=to_jsonb(s.settled_at)
       AND (CASE s.state WHEN 'committed' THEN p_new->>'status'='succeeded' AND p_new->'last_error'='null'::jsonb
         ELSE p_new->>'status'='dead' AND p_new->>'last_error'='Native Email cancelled before write' END)
     ELSE false END)
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_allowed_settlement(text,jsonb,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION clawpilot_crm_legacy_email_protect_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_view jsonb; compared jsonb[]:=ARRAY[]::jsonb[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds) THEN
   RAISE EXCEPTION 'Private Email recovery holds prevent truncation' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds LIMIT 1) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN compared:=array_append(compared,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN compared:=array_append(compared,to_jsonb(NEW)); END IF;
 FOREACH row_view IN ARRAY compared LOOP
  IF TG_TABLE_NAME='crm_interactions' THEN
   IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.local_id::text=row_view->>'id'
      OR h.native_id=lower(row_view->>'suitecrm_id') OR h.global_id=lower(row_view->>'reference_code')) THEN
    IF TG_OP='UPDATE' AND public.clawpilot_crm_legacy_email_allowed_settlement(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Private Email recovery identity is held' USING ERRCODE='55000';
   END IF;
  ELSE
   IF public.clawpilot_crm_legacy_email_outbox_held((row_view->>'id')::uuid) OR
    ((row_view->>'target_system')='suitecrm' AND EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE
     ((row_view->>'aggregate_type')='crm_interactions' AND h.local_id::text=row_view->>'aggregate_id')
     OR ((row_view#>>'{payload,entity}')='interactions' AND (h.local_id::text=row_view#>>'{payload,localId}'
       OR h.native_id=lower(row_view#>>'{payload,suiteCrmId}')
       OR h.global_id=lower(row_view#>>'{payload,attributes,global_id_c}'))))) THEN
    IF TG_OP='UPDATE' AND public.clawpilot_crm_legacy_email_allowed_settlement(TG_TABLE_NAME,to_jsonb(OLD),to_jsonb(NEW)) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Private Email recovery identity is held' USING ERRCODE='55000';
   END IF;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_protect_rows() FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_settle_release(p_hold uuid,p_operation text,p_owner uuid,p_fence bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; a public.crm_native_email_publication_admissions;
 w public.crm_native_email_publication_work; r public.crm_legacy_email_recovery_releases; h public.crm_legacy_email_recovery_holds;
 i public.crm_interactions; o public.sync_outbox; at_time timestamptz; new_metadata jsonb; value jsonb; old_shared_write text;
BEGIN
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 SELECT * INTO a FROM public.crm_native_email_publication_admissions WHERE operation_id=p_operation
   AND xmin=pg_current_xact_id()::xid FOR UPDATE;
 SELECT * INTO w FROM public.crm_native_email_publication_work WHERE operation_id=p_operation FOR UPDATE;
 SELECT * INTO r FROM public.crm_legacy_email_recovery_releases WHERE hold_id=p_hold AND native_operation_id=p_operation;
 SELECT * INTO h FROM public.crm_legacy_email_recovery_holds WHERE operation_id=r.hold_id AND outbox_id=r.outbox_id;
 SELECT * INTO i FROM public.crm_interactions WHERE id=h.local_id FOR UPDATE;
 SELECT * INTO o FROM public.sync_outbox WHERE id=h.outbox_id FOR UPDATE;
 IF (c.enabled AND c.active_operation_id=p_operation AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
   AND c.generation=a.generation AND c.verified_generation=c.generation AND c.generation=r.generation
   AND c.activation_receipt_hash=r.activation_receipt_hash AND c.native_policy_fingerprint=a.native_policy_fingerprint
   AND a.state IN ('committed','cancelled') AND a.native_receipt IS NOT NULL AND a.request_fingerprint=r.request_fingerprint
   AND a.local_id=h.local_id AND a.native_id=h.native_id AND a.global_id=h.global_id AND a.pipeline_id=h.pipeline_id
   AND w.request_fingerprint=r.request_fingerprint AND w.work_kind='outbox' AND w.context->>'outboxId'=o.id::text
   AND w.lease_owner=p_owner AND w.lease_fence=p_fence AND w.lease_until>clock_timestamp()
   AND o.status='processing' AND o.available_at='infinity'::timestamptz AND o.attempts=1
   AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=r.claim_fingerprint
   AND encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')=r.source_fingerprint) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.sync_outbox x WHERE x.id=h.retired_outbox_id) THEN
  RAISE EXCEPTION 'Private Email recovery settlement evidence changed or lease not owned' USING ERRCODE='55000';
 END IF;
 at_time:=clock_timestamp();
 IF a.state='committed' THEN
  value:=a.native_receipt->'result';
  IF (jsonb_typeof(value->'projection')='object' AND value#>>'{projection,version}'='2'
     AND value#>>'{projection,suiteCrmId}'=h.native_id AND value->>'recordFingerprint' ~ '^[0-9a-f]{64}$'
     AND value#>>'{projection,snapshotFingerprint}'=value->>'recordFingerprint'
     AND value#>'{projection,sourceAttributes}'=a.command#>'{projection,attributes}'
     AND value#>'{projection,accounts}'=a.command#>'{projection,accounts}'
     AND value#>'{projection,contacts}'=a.command#>'{projection,contacts}'
     AND value#>'{projection,contactAccounts}'=a.command#>'{projection,contactAccounts}') IS NOT TRUE THEN
   RAISE EXCEPTION 'Private Email recovery native projection missing' USING ERRCODE='55000';
  END IF;
  new_metadata:=i.metadata || jsonb_build_object('suiteCrmEmailProjection',(value->'projection') || jsonb_build_object(
    'operationId',a.operation_id,'sourceHash',i.source_hash,
    'capturedAt',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'audience',jsonb_build_object('fingerprint',value->>'audienceFingerprint','readerSuiteCrmUserIds',value->'readerSuiteCrmUserIds'))
    || CASE WHEN a.command->>'version'='2' THEN jsonb_build_object('capabilityPolicyFingerprint',value->'capabilityPolicyFingerprint',
      'principalSuiteCrmUserIds',value->'principalSuiteCrmUserIds','expectedCapabilities',value->'expectedCapabilities') ELSE '{}'::jsonb END);
 END IF;
 INSERT INTO public.crm_legacy_email_recovery_settlements(native_operation_id,state,receipt_hash,metadata_hash,settled_at,settling_xid)
 VALUES(a.operation_id,a.state,encode(public.digest(a.native_receipt::text,'sha256'),'hex'),
   encode(public.digest(new_metadata::text,'sha256'),'hex'),at_time,pg_current_xact_id());
 old_shared_write:=current_setting('clawpilot.crm_shared_write_v1',true);
 PERFORM set_config('clawpilot.crm_shared_write_v1','on',true);
 UPDATE public.sync_outbox SET status=CASE a.state WHEN 'committed' THEN 'succeeded' ELSE 'dead' END,
   last_error=CASE a.state WHEN 'committed' THEN NULL ELSE 'Native Email cancelled before write' END,
   locked_at=NULL,lock_token=NULL,processed_at=at_time,updated_at=at_time WHERE id=h.outbox_id AND status='processing';
 IF NOT FOUND THEN RAISE EXCEPTION 'Private Email recovery outbox settlement changed' USING ERRCODE='55000'; END IF;
 IF a.state='committed' THEN
  UPDATE public.crm_interactions SET sync_status='synced',sync_error=NULL,suitecrm_synced_at=at_time,updated_at=at_time,metadata=new_metadata
   WHERE id=h.local_id AND sync_status='failed' AND suitecrm_synced_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private Email recovery source settlement changed' USING ERRCODE='55000'; END IF;
 END IF;
 PERFORM set_config('clawpilot.crm_shared_write_v1',COALESCE(old_shared_write,''),true);
 RETURN a.state;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_settle_release(uuid,text,uuid,bigint) FROM PUBLIC;
