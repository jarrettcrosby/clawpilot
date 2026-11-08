-- Native output is authenticated by the pinned private transport, not by
-- trusting JSON passed to SQL. A separate direct recorder must first attest
-- the exact validated receipt bytes under the current resolution lease.
CREATE TABLE crm_legacy_email_terminal_hold.verified_receipts (
 native_operation_id text NOT NULL REFERENCES crm_legacy_email_terminal_hold.released(native_operation_id) ON DELETE RESTRICT,
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),
 lease_fence bigint NOT NULL CHECK(lease_fence BETWEEN 1 AND 9007199254740991),
 attestor name NOT NULL DEFAULT current_user,
 attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(native_operation_id,receipt_hash,lease_fence)
);
CREATE TABLE crm_legacy_email_terminal_hold.settled (
 native_operation_id text PRIMARY KEY REFERENCES crm_legacy_email_terminal_hold.released(native_operation_id) ON DELETE RESTRICT,
 receipt_hash text NOT NULL,
 lease_fence bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('committed','cancelled')),
 at_time timestamptz NOT NULL CHECK(isfinite(at_time)),
 settling_xid xid8 NOT NULL,
 controller name NOT NULL,
 old_admission_hash text NOT NULL CHECK(old_admission_hash ~ '^[0-9a-f]{64}$'),
 new_admission_hash text NOT NULL CHECK(new_admission_hash ~ '^[0-9a-f]{64}$'),
 new_outbox_hash text NOT NULL CHECK(new_outbox_hash ~ '^[0-9a-f]{64}$'),
 new_source_hash text NOT NULL CHECK(new_source_hash ~ '^[0-9a-f]{64}$'),
 FOREIGN KEY(native_operation_id,receipt_hash,lease_fence)
  REFERENCES crm_legacy_email_terminal_hold.verified_receipts(native_operation_id,receipt_hash,lease_fence) ON DELETE RESTRICT
);
REVOKE ALL ON crm_legacy_email_terminal_hold.verified_receipts,crm_legacy_email_terminal_hold.settled FROM PUBLIC;
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['verified_receipts','settled'] LOOP
  EXECUTE format('CREATE TRIGGER crm_held_receipt_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_terminal_hold.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
  EXECUTE format('CREATE TRIGGER crm_held_receipt_no_truncate BEFORE TRUNCATE ON crm_legacy_email_terminal_hold.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
 END LOOP;
END $$;
CREATE FUNCTION crm_legacy_email_terminal_hold.bind_receipt_attestor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_user<>session_user OR NEW.attestor<>session_user OR current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Held Email receipt requires a direct independent attestor' USING ERRCODE='55000';
 END IF;
 NEW.attested_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER crm_held_receipt_attestor BEFORE INSERT ON crm_legacy_email_terminal_hold.verified_receipts
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_terminal_hold.bind_receipt_attestor();

-- Keep unknown results private and resolution-only, even after the first
-- lease expires. The standard lease guard still enforces its own bounds.
CREATE FUNCTION crm_legacy_email_terminal_hold.resolution_lease_write_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.released r
  JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_operation_id=r.native_operation_id
  JOIN public.crm_native_email_publication_admissions a ON a.operation_id=r.native_operation_id
  WHERE r.controller=session_user AND current_setting('role')='none' AND r.native_operation_id=p_old->>'operation_id'
   AND r.native_operation_id=p_new->>'operation_id' AND r.request_fingerprint=p_new->>'request_fingerprint'
   AND a.state IN ('dispatched','unknown') AND c.enabled AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.settled s WHERE s.native_operation_id=r.native_operation_id))
$$;
CREATE FUNCTION crm_legacy_email_terminal_hold.claim_resolution(p_outbox uuid,p_operation text,p_owner uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; w public.crm_native_email_publication_work;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('role')<>'none' OR p_owner IS NULL THEN
  RAISE EXCEPTION 'Held Email resolution requires a direct controller and owner' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 SELECT work.* INTO w FROM public.crm_native_email_publication_work work
  JOIN crm_legacy_email_terminal_hold.released r ON r.native_operation_id=work.operation_id AND r.request_fingerprint=work.request_fingerprint
  JOIN public.crm_native_email_publication_admissions a ON a.operation_id=work.operation_id AND a.request_fingerprint=work.request_fingerprint
  WHERE r.outbox_id=p_outbox AND r.native_operation_id=p_operation AND r.controller=session_user
   AND c.enabled AND c.active_operation_id=p_operation AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
   AND c.verified_generation=c.generation AND a.generation=c.generation AND a.native_policy_fingerprint=c.native_policy_fingerprint
   AND a.state IN ('dispatched','unknown') AND a.native_receipt IS NULL FOR UPDATE OF work;
 IF NOT FOUND OR (w.lease_until>clock_timestamp() AND w.lease_owner<>p_owner) THEN
  RAISE EXCEPTION 'Held Email resolution is unavailable or still leased' USING ERRCODE='55000';
 END IF;
 IF w.lease_until<=clock_timestamp() THEN
  UPDATE public.crm_native_email_publication_work SET lease_owner=p_owner,lease_fence=w.lease_fence+1,
   lease_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE operation_id=p_operation RETURNING * INTO w;
 END IF;
 RETURN jsonb_build_object('owner',w.lease_owner,'fence',w.lease_fence,'expiresAt',w.lease_until);
END $$;

CREATE FUNCTION crm_legacy_email_terminal_hold.settlement_write_allowed(p_table text,p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.settled done
  JOIN crm_legacy_email_terminal_hold.released r USING(native_operation_id)
  JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  JOIN crm_legacy_email_terminal_hold.staged s USING(outbox_id)
  JOIN crm_legacy_email_terminal_hold.verified_recovery v ON v.approval_hash=r.approval_hash AND v.outbox_id=h.outbox_id
  WHERE done.settling_xid=pg_current_xact_id_if_assigned() AND done.controller=session_user AND current_setting('role')='none'
   AND CASE p_table WHEN 'crm_native_email_publication_admissions' THEN p_old->>'operation_id'=r.native_operation_id
    AND encode(public.digest(p_old::text,'sha256'),'hex')=done.old_admission_hash
    AND encode(public.digest(p_new::text,'sha256'),'hex')=done.new_admission_hash
   WHEN 'sync_outbox' THEN p_old->>'id'=h.outbox_id::text
    AND encode(public.digest(p_old::text,'sha256'),'hex')=s.claim_fingerprint
    AND encode(public.digest(p_new::text,'sha256'),'hex')=done.new_outbox_hash
   WHEN 'crm_interactions' THEN done.state='committed' AND p_old->>'id'=h.local_id::text
    AND encode(public.digest(p_old::text,'sha256'),'hex')=v.proof->>'sourceFingerprint'
    AND encode(public.digest(p_new::text,'sha256'),'hex')=done.new_source_hash
   ELSE false END)
$$;
DO $held_settlement_guard$
DECLARE subject regprocedure:='crm_legacy_email_terminal_hold.protect_held()'::regprocedure;
 definition text; fragment text:=$old$ IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$old$;
 replacement text:=$new$ IF TG_OP='UPDATE' AND ((TG_TABLE_NAME='crm_native_email_publication_work'
   AND crm_legacy_email_terminal_hold.resolution_lease_write_allowed(rows[1],rows[2]))
  OR (TG_TABLE_NAME IN ('crm_native_email_publication_admissions','crm_interactions','sync_outbox')
   AND crm_legacy_email_terminal_hold.settlement_write_allowed(TG_TABLE_NAME,rows[1],rows[2]))) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$new$;
BEGIN
 definition:=pg_get_functiondef(subject);
 IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
  RAISE EXCEPTION 'Held Email settlement guard preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,fragment,replacement);
END $held_settlement_guard$;

-- Existing shared-write and contact-merge triggers run inside this SECURITY
-- DEFINER transaction. Qualify their existing tables instead of widening the
-- private controller's search path or disabling a normal writer guard.
DO $held_settlement_dependencies$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.release_crm_contact_merge_outbox_dependents()'::regprocedure);
 IF position('UPDATE sync_outbox dependent' IN definition)=0 OR position('FROM crm_contact_merge_outbox_dependencies dependency' IN definition)=0
  OR position('FROM crm_contact_merge_outbox_dependencies required' IN definition)=0 OR position('JOIN sync_outbox prerequisite' IN definition)=0 THEN
  RAISE EXCEPTION 'Contact merge outbox trigger preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(replace(replace(definition,'UPDATE sync_outbox dependent','UPDATE public.sync_outbox dependent'),
  'FROM crm_contact_merge_outbox_dependencies ','FROM public.crm_contact_merge_outbox_dependencies '),
  'JOIN sync_outbox prerequisite','JOIN public.sync_outbox prerequisite');
 definition:=pg_get_functiondef('public.clawpilot_guard_shared_email_write()'::regprocedure);
 IF position('FROM crm_interaction_organizations WHERE' IN definition)=0 THEN
  RAISE EXCEPTION 'Shared Email compatibility trigger preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,'FROM crm_interaction_organizations WHERE','FROM public.crm_interaction_organizations WHERE');
END $held_settlement_dependencies$;

CREATE FUNCTION crm_legacy_email_terminal_hold.settle_release(p_outbox uuid,p_operation text,p_owner uuid,p_fence bigint,p_receipt jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; a public.crm_native_email_publication_admissions;
 w public.crm_native_email_publication_work; src public.crm_interactions; o public.sync_outbox;
 h crm_legacy_email_terminal_hold.held; r crm_legacy_email_terminal_hold.released; s crm_legacy_email_terminal_hold.staged;
 v crm_legacy_email_terminal_hold.verified_recovery; att crm_legacy_email_terminal_hold.verified_receipts;
 outcome text; receipt_digest text; prior_admission text; next_admission text; next_outbox text; next_source text;
 value jsonb; projection jsonb; attrs jsonb; requested jsonb; live jsonb; at_time timestamptz; shared_write text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('role')<>'none'
  OR jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR octet_length(p_receipt::text)>1000000 THEN
  RAISE EXCEPTION 'Held Email settlement requires direct controller and bounded receipt' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 SELECT * INTO r FROM crm_legacy_email_terminal_hold.released WHERE outbox_id=p_outbox AND native_operation_id=p_operation;
 IF NOT FOUND OR r.controller<>session_user OR c.active_operation_id IS DISTINCT FROM p_operation THEN
  RAISE EXCEPTION 'Held Email settlement cannot lock an unrelated or already settled job' USING ERRCODE='55000';
 END IF;
 SELECT * INTO h FROM crm_legacy_email_terminal_hold.held WHERE outbox_id=p_outbox;
 SELECT * INTO s FROM crm_legacy_email_terminal_hold.staged WHERE outbox_id=p_outbox;
 SELECT * INTO v FROM crm_legacy_email_terminal_hold.verified_recovery WHERE outbox_id=p_outbox AND approval_hash=r.approval_hash;
 SELECT * INTO a FROM public.crm_native_email_publication_admissions WHERE operation_id=p_operation FOR UPDATE;
 SELECT * INTO w FROM public.crm_native_email_publication_work WHERE operation_id=p_operation FOR UPDATE;
 SELECT * INTO src FROM public.crm_interactions WHERE id=h.local_id FOR UPDATE;
 SELECT * INTO o FROM public.sync_outbox WHERE id=p_outbox FOR UPDATE;
 receipt_digest:=encode(public.digest(p_receipt::text,'sha256'),'hex');
 SELECT * INTO att FROM crm_legacy_email_terminal_hold.verified_receipts evidence
  WHERE evidence.native_operation_id=p_operation AND evidence.receipt_hash=receipt_digest AND evidence.lease_fence=p_fence;
 live:=public.clawpilot_crm_legacy_email_live_relationships(h.local_id,h.pipeline_id);
 IF (r.controller=session_user AND att.attestor<>session_user AND att.attested_at>=r.released_at
  AND att.attested_at>clock_timestamp()-interval '120 seconds' AND att.attested_at<=clock_timestamp()
  AND c.enabled AND c.active_operation_id=p_operation AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
  AND c.verified_generation=c.generation AND a.generation=c.generation AND a.native_policy_fingerprint=c.native_policy_fingerprint
  AND c.activation_receipt_hash=v.proof->>'activationReceiptHash' AND a.state IN ('dispatched','unknown') AND a.native_receipt IS NULL
  AND a.request_fingerprint=r.request_fingerprint AND w.request_fingerprint=r.request_fingerprint
  AND w.work_kind='outbox' AND w.context->>'outboxId'=p_outbox::text AND w.context->>'idempotencyKey'=o.idempotency_key
  AND w.lease_owner=p_owner AND w.lease_fence=p_fence AND w.lease_until>clock_timestamp()
  AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=s.claim_fingerprint
  AND encode(public.digest(to_jsonb(src)::text,'sha256'),'hex')=v.proof->>'sourceFingerprint'
  AND live=jsonb_build_object('parentType',o.payload#>'{attributes,parent_type}','parentId',o.payload#>'{attributes,parent_id}',
   'accounts',o.payload#>'{emailProjection,accounts}','contacts',o.payload#>'{emailProjection,contacts}',
   'contactAccounts',o.payload#>'{emailProjection,contactAccounts}')) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.crm_contact_merge_outbox_dependencies d
   WHERE d.prerequisite_outbox_id=p_outbox OR d.dependent_outbox_id=p_outbox) THEN
  RAISE EXCEPTION 'Held Email settlement needs the exact independently attested receipt and live lease' USING ERRCODE='55000';
 END IF;
 outcome:=p_receipt->>'state';
 IF (public.clawpilot_crm_native_initial_shape(p_receipt,ARRAY['version','operationId','commandHash','state','replayed','result'])
   AND p_receipt->'version'='2'::jsonb AND p_receipt->>'operationId'=p_operation AND p_receipt->>'commandHash'=a.command_hash
   AND jsonb_typeof(p_receipt->'replayed')='boolean' AND outcome IN ('committed','cancelled')) IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email terminal receipt identity changed' USING ERRCODE='55000';
 END IF;
 value:=p_receipt->'result';
 at_time:=clock_timestamp();
 IF outcome='cancelled' THEN
  IF value IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Held Email cancellation must prove no write' USING ERRCODE='55000'; END IF;
 ELSE
  projection:=value->'projection'; attrs:=projection->'attributes'; requested:=a.command#>'{projection,attributes}';
  IF (public.clawpilot_crm_native_initial_shape(value,ARRAY['version','mode','suiteCrmId','globalId','pipelineId','generation',
    'audienceFingerprint','recordFingerprint','readerSuiteCrmUserIds','projection','capabilityPolicyFingerprint','principalSuiteCrmUserIds','expectedCapabilities'])
   AND value->'version'='2'::jsonb AND value->>'mode'='publish' AND value->>'suiteCrmId'=h.native_id
   AND value->>'globalId'=h.global_id AND value->>'pipelineId'=h.pipeline_id::text AND value->'generation'=to_jsonb(c.generation)
   AND value->>'audienceFingerprint'=a.audience_fingerprint AND value->'readerSuiteCrmUserIds'=a.allowed_reader_ids
   AND value->'capabilityPolicyFingerprint'=a.command->'capabilityPolicyFingerprint'
   AND value->'principalSuiteCrmUserIds'=a.command->'principalSuiteCrmUserIds' AND value->'expectedCapabilities'=a.command->'expectedCapabilities'
   AND public.clawpilot_crm_native_initial_shape(projection,ARRAY['version','suiteCrmId','attributes','sourceAttributes',
    'accounts','contacts','contactAccounts','snapshotFingerprint','dateSentReceivedUtc'])
   AND projection->'version'='2'::jsonb AND projection->>'suiteCrmId'=h.native_id AND value->>'recordFingerprint' ~ '^[0-9a-f]{64}$'
   AND projection->>'snapshotFingerprint'=value->>'recordFingerprint' AND projection->'sourceAttributes'=requested
   AND projection->'accounts'=a.command#>'{projection,accounts}' AND projection->'contacts'=a.command#>'{projection,contacts}'
   AND projection->'contactAccounts'=a.command#>'{projection,contactAccounts}'
   AND public.clawpilot_crm_native_initial_shape(attrs,ARRAY['name','date_sent_received','type','status','parent_type','parent_id',
    'assigned_user_id','created_by','deleted','global_id_c','description','description_html','from_addr_name',
    'to_addrs_names','cc_addrs_names','bcc_addrs_names','reply_to_addrs_names'])
   AND attrs->>'deleted'='0' AND attrs->'created_by'=requested->'assigned_user_id'
   AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['global_id_c','name','type','status','parent_type','parent_id','assigned_user_id','description']) AS x(key)
    WHERE attrs->key IS DISTINCT FROM requested->key)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Held Email native projection or audience differs from the approved request' USING ERRCODE='55000';
  END IF;
  src.metadata:=src.metadata||jsonb_build_object('suiteCrmEmailProjection',projection||jsonb_build_object(
   'operationId',p_operation,'sourceHash',src.source_hash,'capturedAt',to_char(at_time,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'audience',jsonb_build_object('fingerprint',a.audience_fingerprint,'readerSuiteCrmUserIds',a.allowed_reader_ids),
   'capabilityPolicyFingerprint',value->'capabilityPolicyFingerprint','principalSuiteCrmUserIds',value->'principalSuiteCrmUserIds',
   'expectedCapabilities',value->'expectedCapabilities'));
  src.sync_status:='synced'; src.sync_error:=NULL; src.suitecrm_synced_at:=at_time; src.updated_at:=at_time;
 END IF;
 prior_admission:=encode(public.digest(to_jsonb(a)::text,'sha256'),'hex');
 a.state:=outcome; a.native_receipt:=p_receipt; a.updated_at:=at_time;
 o.status:=CASE outcome WHEN 'committed' THEN 'succeeded' ELSE 'dead' END;
 o.last_error:=CASE outcome WHEN 'committed' THEN NULL ELSE 'Native Email cancelled before write' END;
 o.locked_at:=NULL; o.lock_token:=NULL; o.processed_at:=at_time; o.updated_at:=at_time;
 next_admission:=encode(public.digest(to_jsonb(a)::text,'sha256'),'hex');
 next_outbox:=encode(public.digest(to_jsonb(o)::text,'sha256'),'hex');
 next_source:=encode(public.digest(to_jsonb(src)::text,'sha256'),'hex');
 INSERT INTO crm_legacy_email_terminal_hold.settled(native_operation_id,receipt_hash,lease_fence,state,at_time,settling_xid,
  controller,old_admission_hash,new_admission_hash,new_outbox_hash,new_source_hash)
 VALUES(p_operation,receipt_digest,p_fence,outcome,at_time,pg_current_xact_id(),session_user,prior_admission,next_admission,next_outbox,next_source);
 UPDATE public.crm_native_email_publication_admissions SET state=a.state,native_receipt=a.native_receipt,updated_at=at_time
  WHERE operation_id=p_operation;
 shared_write:=current_setting('clawpilot.crm_shared_write_v1',true);
 PERFORM set_config('clawpilot.crm_shared_write_v1','on',true);
 UPDATE public.sync_outbox SET status=o.status,last_error=o.last_error,locked_at=NULL,lock_token=NULL,processed_at=at_time,updated_at=at_time
  WHERE id=p_outbox;
 IF outcome='committed' THEN
  UPDATE public.crm_interactions SET sync_status='synced',sync_error=NULL,suitecrm_synced_at=at_time,updated_at=at_time,metadata=src.metadata
   WHERE id=h.local_id;
 END IF;
 PERFORM set_config('clawpilot.crm_shared_write_v1',COALESCE(shared_write,''),true);
 IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions q WHERE q.operation_id=p_operation
   AND encode(public.digest(to_jsonb(q)::text,'sha256'),'hex')=next_admission)
  OR NOT EXISTS(SELECT 1 FROM public.sync_outbox q WHERE q.id=p_outbox AND encode(public.digest(to_jsonb(q)::text,'sha256'),'hex')=next_outbox)
  OR NOT EXISTS(SELECT 1 FROM public.crm_interactions q WHERE q.id=h.local_id AND encode(public.digest(to_jsonb(q)::text,'sha256'),'hex')=next_source)
  OR w.lease_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Held Email settlement postimage changed or lease expired' USING ERRCODE='55000';
 END IF;
 UPDATE public.crm_native_email_publication_control SET active_operation_id=NULL,updated_at=at_time
  WHERE singleton AND active_operation_id=p_operation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Held Email settlement lost active authority' USING ERRCODE='55000'; END IF;
 RETURN outcome;
END $$;

ALTER FUNCTION crm_legacy_email_terminal_hold.resolve_release(uuid,text,text,text) RENAME TO resolve_unsettled_release;
CREATE FUNCTION crm_legacy_email_terminal_hold.resolve_release(p_outbox uuid,p_stage_receipt text,p_operation text,p_request text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE((SELECT jsonb_build_object('state',done.state) FROM crm_legacy_email_terminal_hold.settled done
  JOIN crm_legacy_email_terminal_hold.released r USING(native_operation_id)
  JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  JOIN public.crm_native_email_publication_admissions a ON a.operation_id=r.native_operation_id
  JOIN public.sync_outbox o ON o.id=r.outbox_id JOIN public.crm_interactions i ON i.id=h.local_id
  JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_operation_id IS DISTINCT FROM a.operation_id
  WHERE r.outbox_id=p_outbox AND r.stage_receipt_hash=p_stage_receipt AND r.native_operation_id=p_operation AND r.request_fingerprint=p_request
   AND a.state=done.state AND encode(public.digest(a.native_receipt::text,'sha256'),'hex')=done.receipt_hash
   AND encode(public.digest(to_jsonb(a)::text,'sha256'),'hex')=done.new_admission_hash
   AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=done.new_outbox_hash
   AND encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')=done.new_source_hash),
  crm_legacy_email_terminal_hold.resolve_unsettled_release(p_outbox,p_stage_receipt,p_operation,p_request))
$$;
REVOKE ALL ON FUNCTION crm_legacy_email_terminal_hold.bind_receipt_attestor(),
 crm_legacy_email_terminal_hold.resolution_lease_write_allowed(jsonb,jsonb),crm_legacy_email_terminal_hold.claim_resolution(uuid,text,uuid),
 crm_legacy_email_terminal_hold.settlement_write_allowed(text,jsonb,jsonb),
 crm_legacy_email_terminal_hold.settle_release(uuid,text,uuid,bigint,jsonb),
 crm_legacy_email_terminal_hold.resolve_release(uuid,text,text,text) FROM PUBLIC;
