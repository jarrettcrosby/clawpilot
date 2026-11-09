-- Release one staged original to the protected native admission. This slice
-- adds no grants, signing keys, transport, resolution or settlement writes.
CREATE TABLE crm_legacy_email_terminal_hold.released (
 outbox_id uuid PRIMARY KEY REFERENCES crm_legacy_email_terminal_hold.staged(outbox_id) ON DELETE RESTRICT,
 approval_hash text NOT NULL UNIQUE REFERENCES crm_legacy_email_terminal_hold.verified_recovery(approval_hash) ON DELETE RESTRICT,
 native_operation_id text NOT NULL UNIQUE REFERENCES public.crm_native_email_publication_admissions(operation_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
 stage_receipt_hash text NOT NULL CHECK(stage_receipt_hash ~ '^[0-9a-f]{64}$'),
 release_xid xid8 NOT NULL,
 controller name NOT NULL,
 released_at timestamptz NOT NULL CHECK(isfinite(released_at))
);
REVOKE ALL ON crm_legacy_email_terminal_hold.released FROM PUBLIC;
CREATE TRIGGER crm_held_recovery_release_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_terminal_hold.released
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence();
CREATE TRIGGER crm_held_recovery_release_no_truncate BEFORE TRUNCATE ON crm_legacy_email_terminal_hold.released
 FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence();

-- Strict wire canonicalization, used only to verify the exact independently
-- reviewed request at commit. PG jsonb's default object order is not the
-- canonical JS/native wire order. Recursion and keys are explicitly bounded.
CREATE FUNCTION crm_legacy_email_terminal_hold.wire_json(v jsonb,depth integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text:=jsonb_typeof(v); result text;
BEGIN
 IF depth<0 OR depth>32 THEN RAISE EXCEPTION 'Held Email wire value is too deep' USING ERRCODE='55000'; END IF;
 CASE k
 WHEN 'object' THEN
  IF v='{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) AS x(key) WHERE key !~ '^[A-Za-z][A-Za-z0-9_]*$') THEN
   RAISE EXCEPTION 'Held Email wire object has invalid keys' USING ERRCODE='55000';
  END IF;
  SELECT '{'||string_agg(to_jsonb(key)::text||':'||crm_legacy_email_terminal_hold.wire_json(value,depth+1),',' ORDER BY key COLLATE "C")||'}'
   INTO result FROM jsonb_each(v);
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(crm_legacy_email_terminal_hold.wire_json(value,depth+1),',' ORDER BY ord),'')||']'
   INTO result FROM jsonb_array_elements(v) WITH ORDINALITY AS x(value,ord);
 WHEN 'number' THEN
  IF v::text !~ '^-?(0|[1-9][0-9]{0,15})$' OR abs(v::numeric)>9007199254740991 THEN
   RAISE EXCEPTION 'Held Email wire value is not a safe integer' USING ERRCODE='55000';
  END IF;
  result:=v::text;
 WHEN 'string' THEN result:=replace(replace(v::text,U&'\2028','\u2028'),U&'\2029','\u2029');
 WHEN 'null' THEN result:='null';
 WHEN 'boolean' THEN result:=v::text;
 ELSE RAISE EXCEPTION 'Held Email wire value is invalid' USING ERRCODE='55000';
 END CASE;
 RETURN result;
END $$;

-- Reuse the same live relationship resolver for both private recovery origins.
-- In-flight associations must stay pinned until verified terminal settlement.
DO $held_release_relationships$
DECLARE subject regprocedure; definition text; fragment text; replacement text;
BEGIN
 subject:='public.clawpilot_crm_legacy_email_provider_identity_unambiguous(uuid,uuid)'::regprocedure;
 definition:=pg_get_functiondef(subject);
 fragment:=$old$WHERE h.local_id=p_local AND h.pipeline_id=p_pipeline) THEN$old$;
 replacement:=$new$WHERE h.local_id=p_local AND h.pipeline_id=p_pipeline)
 AND NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h
   JOIN crm_legacy_email_terminal_hold.consumed consumed ON consumed.batch=h.batch
   WHERE h.local_id=p_local AND h.pipeline_id=p_pipeline
    AND consumed.receipt_hash=crm_legacy_email_terminal_hold.receipt_fingerprint(h.batch)) THEN$new$;
 IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
  RAISE EXCEPTION 'Held Email provider resolver preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,fragment,replacement);
 subject:='public.clawpilot_crm_legacy_email_relationship_guard()'::regprocedure;
 definition:=pg_get_functiondef(subject);
 fragment:=$old$  WHERE c.singleton;
 IF active_local IS NULL THEN$old$;
 replacement:=$new$  WHERE c.singleton;
 IF active_local IS NULL THEN
  SELECT h.local_id,h.pipeline_id INTO active_local,active_pipeline
   FROM public.crm_native_email_publication_control c
   JOIN crm_legacy_email_terminal_hold.released r ON r.native_operation_id=c.active_operation_id
   JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id) WHERE c.singleton;
 END IF;
 IF active_local IS NULL THEN$new$;
 IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
  RAISE EXCEPTION 'Held Email relationship guard preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,fragment,replacement);
END $held_release_relationships$;

CREATE FUNCTION crm_legacy_email_terminal_hold.register_release(p_outbox uuid,p_approval text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE control_row public.crm_native_email_publication_control;
 staged_row crm_legacy_email_terminal_hold.staged; hold_row crm_legacy_email_terminal_hold.held;
 approved crm_legacy_email_terminal_hold.verified_recovery; o public.sync_outbox; src public.crm_interactions;
 release_proof jsonb; second_now bigint; live jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Held Email release requires a direct read-committed controller' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT control_row FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT control_row.enabled OR control_row.verified_generation IS DISTINCT FROM control_row.generation
  OR control_row.active_operation_id IS NOT NULL OR control_row.active_transition_id IS NOT NULL
  OR control_row.active_initial_enrollment_id IS NOT NULL THEN
  RAISE EXCEPTION 'Held Email release requires idle verified authority' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Held Email release serialization is missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO staged_row FROM crm_legacy_email_terminal_hold.staged WHERE outbox_id=p_outbox;
 SELECT * INTO approved FROM crm_legacy_email_terminal_hold.verified_recovery WHERE outbox_id=p_outbox AND approval_hash=p_approval;
 SELECT * INTO hold_row FROM crm_legacy_email_terminal_hold.held WHERE outbox_id=p_outbox;
 IF (staged_row.outbox_id=p_outbox AND approved.intent_hash=staged_row.intent_hash AND approved.attestor<>session_user
   AND approved.valid_until>clock_timestamp() AND approved.valid_until<=clock_timestamp()+interval '120 seconds') IS NOT TRUE
   OR EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.released WHERE outbox_id=p_outbox) THEN
  RAISE EXCEPTION 'Held Email release requires a fresh independently verified approval of the same stage' USING ERRCODE='55000';
 END IF;
 release_proof:=approved.proof;
 -- A refreshed proof can change only its signing envelope/time. Compare the
 -- unsigned intent too: the database does not trust a copied intent hash.
 IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.verified_recovery stage_approval
   WHERE stage_approval.approval_hash=staged_row.approval_hash AND stage_approval.outbox_id=p_outbox
    AND stage_approval.proof-ARRAY['keyId','issuedAt','expiresAt']=release_proof-ARRAY['keyId','issuedAt','expiresAt'])
  OR (release_proof->>'generation'=control_row.generation::text AND release_proof->>'activationReceiptHash'=control_row.activation_receipt_hash
   AND release_proof->>'issuedAt' ~ '^[1-9][0-9]{0,15}$' AND release_proof->>'expiresAt' ~ '^[1-9][0-9]{0,15}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email release intent or current authority changed' USING ERRCODE='55000';
 END IF;
 second_now:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF (release_proof->>'issuedAt')::bigint>second_now OR (release_proof->>'expiresAt')::bigint<=second_now
  OR (release_proof->>'expiresAt')::bigint-(release_proof->>'issuedAt')::bigint NOT BETWEEN 1 AND 120
  OR to_timestamp((release_proof->>'expiresAt')::bigint)<>approved.valid_until THEN
  RAISE EXCEPTION 'Held Email release approval expired' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT src FROM public.crm_interactions WHERE id=hold_row.local_id FOR UPDATE;
 SELECT * INTO STRICT o FROM public.sync_outbox WHERE id=p_outbox FOR UPDATE;
 live:=public.clawpilot_crm_legacy_email_live_relationships(hold_row.local_id,hold_row.pipeline_id);
 IF (encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=staged_row.claim_fingerprint
   AND encode(public.digest(to_jsonb(src)::text,'sha256'),'hex')=release_proof->>'sourceFingerprint'
   AND crm_legacy_email_terminal_hold.relationship_fingerprint(src.id)=release_proof->>'relationshipFingerprint'
   AND crm_legacy_email_terminal_hold.provider_identity_fingerprint(src.id)=release_proof->>'providerIdentityFingerprint'
   AND live=jsonb_build_object('parentType',o.payload#>'{attributes,parent_type}','parentId',o.payload#>'{attributes,parent_id}',
      'accounts',o.payload#>'{emailProjection,accounts}','contacts',o.payload#>'{emailProjection,contacts}',
      'contactAccounts',o.payload#>'{emailProjection,contactAccounts}')) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=hold_row.local_id
    OR lower(a.native_id)=hold_row.native_id OR lower(a.global_id)=hold_row.global_id OR a.operation_id=release_proof->>'nativeOperationId')
  OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w WHERE w.operation_id=release_proof->>'nativeOperationId'
    OR (w.work_kind='outbox' AND (w.context->>'outboxId'=p_outbox::text OR w.context->>'idempotencyKey'=o.idempotency_key))) THEN
  RAISE EXCEPTION 'Held Email release exact source, placement, or publication state changed' USING ERRCODE='55000';
 END IF;
 INSERT INTO crm_legacy_email_terminal_hold.released(outbox_id,approval_hash,native_operation_id,request_fingerprint,
  stage_receipt_hash,release_xid,controller,released_at)
 VALUES(p_outbox,p_approval,release_proof->>'nativeOperationId',release_proof->>'requestFingerprint',staged_row.receipt_hash,
  pg_current_xact_id(),session_user,clock_timestamp());
END $$;

-- This exception is same-XID only. It cannot reset the original outbox,
-- advance to unknown/terminal, permit a new lease, or override other guards.
CREATE FUNCTION crm_legacy_email_terminal_hold.initial_release_write_allowed(p_table text,p_action text,p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.released r
  JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  JOIN public.sync_outbox o ON o.id=r.outbox_id
  WHERE r.release_xid=pg_current_xact_id_if_assigned() AND r.controller=session_user
   AND current_setting('role')='none' AND p_new->>'operation_id'=r.native_operation_id
   AND p_new->>'request_fingerprint'=r.request_fingerprint AND CASE p_table
    WHEN 'crm_native_email_publication_work' THEN p_action='INSERT' AND p_new->>'work_kind'='outbox'
      AND p_new->>'lease_fence'='1' AND p_new#>>'{context,outboxId}'=h.outbox_id::text
      AND p_new#>>'{context,idempotencyKey}'=o.idempotency_key AND p_new#>>'{context,attempt}'=o.attempts::text
    WHEN 'crm_native_email_publication_admissions' THEN p_new->>'local_id'=h.local_id::text
      AND p_new->>'pipeline_id'=h.pipeline_id::text AND p_new->>'native_id'=h.native_id AND p_new->>'global_id'=h.global_id
      AND p_new->'native_receipt'='null'::jsonb
      AND ((p_action='INSERT' AND p_new->>'state'='admitted') OR (p_action='UPDATE' AND p_old->>'state'='admitted'
        AND p_new->>'state'='dispatched'))
    ELSE false END)
$$;

DO $held_release_trigger$
DECLARE subject regprocedure:='crm_legacy_email_terminal_hold.protect_held()'::regprocedure;
 definition text; fragment text:=$old$ IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$old$;
 replacement text:=$new$ IF TG_TABLE_NAME IN ('crm_native_email_publication_work','crm_native_email_publication_admissions')
  AND TG_OP IN ('INSERT','UPDATE') AND crm_legacy_email_terminal_hold.initial_release_write_allowed(TG_TABLE_NAME,TG_OP,
   CASE WHEN TG_OP='UPDATE' THEN rows[1] ELSE NULL END,rows[cardinality(rows)]) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$new$;
BEGIN
 definition:=pg_get_functiondef(subject);
 IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
  RAISE EXCEPTION 'Held Email release guard preimage changed' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,fragment,replacement);
END $held_release_trigger$;

CREATE FUNCTION crm_legacy_email_terminal_hold.check_release_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.staged s
  JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  JOIN crm_legacy_email_terminal_hold.verified_recovery v ON v.approval_hash=NEW.approval_hash AND v.outbox_id=h.outbox_id
  JOIN public.sync_outbox o ON o.id=h.outbox_id JOIN public.crm_interactions i ON i.id=h.local_id
  JOIN public.crm_native_email_publication_work w ON w.operation_id=NEW.native_operation_id
  JOIN public.crm_native_email_publication_admissions a ON a.operation_id=w.operation_id
  JOIN public.crm_native_email_publication_control c ON c.singleton AND c.active_operation_id=a.operation_id
  JOIN public.crm_native_email_capability_policies p ON p.pipeline_id=h.pipeline_id
  WHERE s.outbox_id=NEW.outbox_id AND NEW.stage_receipt_hash=s.receipt_hash AND v.intent_hash=s.intent_hash
   AND v.valid_until>clock_timestamp() AND NEW.release_xid=pg_current_xact_id_if_assigned() AND NEW.controller=session_user
   AND a.state='dispatched' AND a.native_receipt IS NULL AND w.work_kind='outbox' AND w.lease_fence=1 AND w.lease_until>clock_timestamp()
   AND a.request_fingerprint=NEW.request_fingerprint AND w.request_fingerprint=NEW.request_fingerprint
   AND w.context->>'outboxId'=o.id::text AND w.context->>'idempotencyKey'=o.idempotency_key
   AND w.context->>'sourceHash'=i.source_hash AND w.context->>'attempt'=o.attempts::text
   AND w.context_hash=encode(public.digest(crm_legacy_email_terminal_hold.wire_json(w.context,0),'sha256'),'hex')
   AND a.operation_id=encode(public.digest(crm_legacy_email_terminal_hold.wire_json(jsonb_build_object(
     'outboxId',o.id,'idempotencyKey',o.idempotency_key,'payloadHash',w.context->>'payloadHash',
     'attempt',o.attempts,'claim',o.lock_token,'generation',c.generation),0),'sha256'),'hex')
   AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=s.claim_fingerprint
   AND c.enabled AND c.active_transition_id IS NULL AND c.active_initial_enrollment_id IS NULL
   AND c.generation=a.generation AND c.verified_generation=c.generation AND p.generation=c.generation
   AND v.proof->>'activationReceiptHash'=c.activation_receipt_hash AND a.native_policy_fingerprint=c.native_policy_fingerprint
   AND a.pipeline_id=h.pipeline_id AND a.local_id=h.local_id AND a.native_id=h.native_id AND a.global_id=h.global_id
   AND a.command->'version'='2'::jsonb AND a.command->>'mode'='publish' AND a.command->'expectedRecordFingerprint'='null'::jsonb
   AND a.command->>'operationId'=a.operation_id AND a.command->>'workspaceId'=h.workspace_id::text
   AND a.command->>'pipelineId'=h.pipeline_id::text AND a.command->>'localId'=h.local_id::text
   AND a.command->>'suiteCrmId'=h.native_id AND a.command->>'globalId'=h.global_id
   AND a.command->'generation'=to_jsonb(c.generation) AND a.command->>'audienceFingerprint'=a.audience_fingerprint
   AND a.command->'projection'=jsonb_build_object('attributes',o.payload->'attributes','accounts',o.payload#>'{emailProjection,accounts}',
     'contacts',o.payload#>'{emailProjection,contacts}','contactAccounts',o.payload#>'{emailProjection,contactAccounts}',
     'previousManaged','{"accounts":[],"contacts":[]}'::jsonb)
   AND a.audience_fingerprint=o.payload#>>'{emailProjection,audience,fingerprint}' AND p.policy->>'audienceFingerprint'=a.audience_fingerprint
   AND a.allowed_reader_ids=o.payload#>'{emailProjection,audience,allowedSuiteCrmUserIds}' AND p.policy#>'{futureCreate,view}'=a.allowed_reader_ids
   AND p.fingerprint=a.command->>'capabilityPolicyFingerprint' AND p.policy->'principalSuiteCrmUserIds'=a.command->'principalSuiteCrmUserIds'
   AND p.policy->'futureCreate'=a.command->'expectedCapabilities'
   AND a.command_hash=encode(public.digest(crm_legacy_email_terminal_hold.wire_json(a.command,0),'sha256'),'hex')
   AND a.request_fingerprint=encode(public.digest(crm_legacy_email_terminal_hold.wire_json(jsonb_build_object(
     'commandHash',a.command_hash,'allowedReaderSuiteCrmUserIds',a.allowed_reader_ids,'nativePolicyFingerprint',a.native_policy_fingerprint),0),'sha256'),'hex')
   AND public.clawpilot_crm_legacy_email_live_relationships(h.local_id,h.pipeline_id)=jsonb_build_object(
     'parentType',o.payload#>'{attributes,parent_type}','parentId',o.payload#>'{attributes,parent_id}',
     'accounts',o.payload#>'{emailProjection,accounts}','contacts',o.payload#>'{emailProjection,contacts}',
     'contactAccounts',o.payload#>'{emailProjection,contactAccounts}')) THEN
  RAISE EXCEPTION 'Held Email release must atomically bind the exact first native dispatch' USING ERRCODE='55000';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_held_recovery_release_binding AFTER INSERT ON crm_legacy_email_terminal_hold.released
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_terminal_hold.check_release_binding();

-- Resolve a lost database acknowledgement by its exact pins only. A staged
-- result does not itself authorize a publish or certify native absence. A
-- dispatched result means resolution-only, never send again.
CREATE FUNCTION crm_legacy_email_terminal_hold.resolve_release(p_outbox uuid,p_stage_receipt text,p_operation text,p_request text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE((SELECT CASE
  WHEN r.outbox_id IS NULL AND c.active_operation_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_work competing
    WHERE competing.operation_id=p_operation OR competing.context->>'outboxId'=p_outbox::text
     OR competing.context->>'idempotencyKey'=o.idempotency_key)
   AND NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions competing
    WHERE competing.operation_id=p_operation OR competing.local_id=h.local_id
     OR lower(competing.native_id)=h.native_id OR lower(competing.global_id)=h.global_id)
   THEN jsonb_build_object('state','staged')
  WHEN r.stage_receipt_hash=p_stage_receipt AND r.native_operation_id=p_operation AND r.request_fingerprint=p_request
   AND c.active_operation_id=p_operation AND a.state='dispatched' AND a.native_receipt IS NULL
   AND a.request_fingerprint=p_request AND a.generation=c.generation AND a.native_policy_fingerprint=c.native_policy_fingerprint
   AND a.pipeline_id=h.pipeline_id AND a.local_id=h.local_id AND a.native_id=h.native_id AND a.global_id=h.global_id
   AND w.request_fingerprint=p_request AND w.context->>'outboxId'=p_outbox::text AND w.context->>'idempotencyKey'=o.idempotency_key
   THEN jsonb_build_object('state','dispatched')
  ELSE jsonb_build_object('state','unknown') END
 FROM crm_legacy_email_terminal_hold.staged s
 JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
 JOIN crm_legacy_email_terminal_hold.verified_recovery v ON v.approval_hash=s.approval_hash AND v.outbox_id=h.outbox_id
 JOIN public.sync_outbox o ON o.id=h.outbox_id
 CROSS JOIN public.crm_native_email_publication_control c
 LEFT JOIN crm_legacy_email_terminal_hold.released r ON r.outbox_id=h.outbox_id
 LEFT JOIN public.crm_native_email_publication_admissions a ON a.operation_id=r.native_operation_id
 LEFT JOIN public.crm_native_email_publication_work w ON w.operation_id=a.operation_id
 WHERE s.outbox_id=p_outbox AND s.receipt_hash=p_stage_receipt AND v.proof->>'nativeOperationId'=p_operation
  AND v.proof->>'requestFingerprint'=p_request AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=s.claim_fingerprint
  AND c.singleton AND c.enabled AND c.verified_generation=c.generation AND c.generation::text=v.proof->>'generation'
  AND c.active_initial_enrollment_id IS NULL AND c.active_transition_id IS NULL
  AND c.activation_receipt_hash=v.proof->>'activationReceiptHash'),jsonb_build_object('state','unknown'))
$$;
REVOKE ALL ON FUNCTION crm_legacy_email_terminal_hold.wire_json(jsonb,integer),
 crm_legacy_email_terminal_hold.register_release(uuid,text),
 crm_legacy_email_terminal_hold.initial_release_write_allowed(text,text,jsonb,jsonb),
 crm_legacy_email_terminal_hold.check_release_binding(),
 crm_legacy_email_terminal_hold.resolve_release(uuid,text,text,text) FROM PUBLIC;
