-- Private exact continuation from an independently fenced retirement receipt.
-- The operator controller authenticates the signed release and re-derives the
-- mailbox, source and current audience; the database binds those exact pins.
-- No production role grants, data backfill, broad replay or native dispatch.
CREATE TABLE crm_legacy_email_recovery_stages (
  hold_id uuid PRIMARY KEY REFERENCES crm_legacy_email_recovery_holds(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  outbox_id uuid NOT NULL UNIQUE REFERENCES sync_outbox(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  retired_outbox_id uuid NOT NULL UNIQUE REFERENCES crm_legacy_email_retirement.retained(outbox_id) ON DELETE RESTRICT,
  intent_hash text NOT NULL UNIQUE CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
  receipt_hash text NOT NULL UNIQUE CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),
  claim_fingerprint text NOT NULL CHECK(claim_fingerprint ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
  staged_xid xid8 NOT NULL,
  staged_at timestamptz NOT NULL,
  CHECK(outbox_id<>retired_outbox_id)
);
REVOKE ALL ON TABLE crm_legacy_email_recovery_stages FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_stage_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_recovery_stages
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();
CREATE TRIGGER crm_legacy_email_stage_no_truncate BEFORE TRUNCATE ON crm_legacy_email_recovery_stages
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_immutable_release();

-- Narrow private source read; no scan, general archive access or current
-- readiness claim. The operator separately checks the live canonical source.
CREATE FUNCTION clawpilot_crm_legacy_email_stage_source(p_retired uuid,p_retirement text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT jsonb_build_object('retiredOutboxId',r.outbox_id,
  'retirementReceiptHash',c.receipt_hash,'localId',r.local_id,'pipelineId',r.pipeline_id,'workspaceId',r.workspace_id,
  'nativeId',r.native_id,'globalId',r.global_id,'sourceFingerprint',r.source_hash,'originalFingerprint',r.original_hash,
  'payload',r.original->'payload','idempotencyKey',r.original->>'idempotency_key')
  FROM crm_legacy_email_retirement.retained r JOIN crm_legacy_email_retirement.consumed c USING(batch)
  WHERE r.outbox_id=p_retired AND c.receipt_hash=p_retirement AND r.historical_provider_outcome='unknown'
    AND NOT EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=r.outbox_id)),
  '{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_stage_source(uuid,text) FROM PUBLIC;

-- Resolution is deliberately a read, not a second stage attempt. It neither
-- consumes a refreshed approval nor claims that SuiteCRM received any Email.
CREATE FUNCTION clawpilot_crm_legacy_email_stage_read(p_hold uuid,p_intent text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT jsonb_build_object('state','staged','holdId',s.hold_id,'outboxId',s.outbox_id,
  'retiredOutboxId',s.retired_outbox_id,'intentHash',s.intent_hash,'receiptHash',s.receipt_hash)
  FROM public.crm_legacy_email_recovery_stages s
  JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=s.hold_id AND h.outbox_id=s.outbox_id
    AND h.retired_outbox_id=s.retired_outbox_id AND h.release_intent_hash=s.intent_hash
  WHERE s.hold_id=p_hold AND s.intent_hash=p_intent
    AND NOT EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=s.retired_outbox_id)),
  '{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_stage_read(uuid,text) FROM PUBLIC;

-- This is called independently for every matching archived identity. 0406
-- never delegates an original UUID or a TRUNCATE to this hook. The transient
-- insert permit exists only for the exact full parked postimage in this XID.
-- 0405 owns the much narrower admission and terminal settlement boundaries.
CREATE OR REPLACE FUNCTION clawpilot_crm_legacy_email_archive_allows_change(retired_id uuid,table_name text,action text,
 old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_stages s
  LEFT JOIN public.crm_legacy_email_recovery_holds h ON h.operation_id=s.hold_id AND h.outbox_id=s.outbox_id
   AND h.retired_outbox_id=s.retired_outbox_id AND h.release_intent_hash=s.intent_hash
  WHERE s.retired_outbox_id=retired_id AND CASE
   WHEN table_name='sync_outbox' AND action='INSERT' THEN
    s.staged_xid=pg_current_xact_id_if_assigned() AND new_row->>'id'=s.outbox_id::text
    AND encode(public.digest(new_row::text,'sha256'),'hex')=s.claim_fingerprint
   WHEN table_name='crm_native_email_publication_admissions' AND action='INSERT' THEN
    h.outbox_id IS NOT NULL AND new_row->>'local_id'=h.local_id::text AND new_row->>'pipeline_id'=h.pipeline_id::text
    AND new_row->>'native_id'=h.native_id AND new_row->>'global_id'=h.global_id
    AND EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_releases r WHERE r.hold_id=h.operation_id
      AND r.outbox_id=s.outbox_id AND r.intent_hash=s.intent_hash AND r.generation=s.generation
      AND r.claim_fingerprint=s.claim_fingerprint AND r.native_operation_id=new_row->>'operation_id'
      AND r.request_fingerprint=new_row->>'request_fingerprint')
   WHEN table_name IN ('sync_outbox','crm_interactions') AND action='UPDATE' THEN
    h.outbox_id IS NOT NULL AND CASE WHEN table_name='sync_outbox' THEN old_row->>'id'=s.outbox_id::text
      ELSE old_row->>'id'=h.local_id::text END
    AND public.clawpilot_crm_legacy_email_allowed_settlement(table_name,old_row,new_row)
   ELSE false END)
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_archive_allows_change(uuid,text,text,jsonb,jsonb) FROM PUBLIC;

-- The 0406 BEFORE STATEMENT fences observe the private serial revision in
-- old snapshots. This permit only substitutes that revision for 0404's
-- control timestamp bump; it cannot bypass any hold or outbox checks.
CREATE OR REPLACE FUNCTION clawpilot_crm_legacy_email_archive_serialized_hold(hold_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
 SELECT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_stages s
  JOIN crm_legacy_email_retirement.retained r ON r.outbox_id=s.retired_outbox_id
  JOIN crm_legacy_email_retirement.consumed c ON c.batch=r.batch
  JOIN public.sync_outbox o ON o.id=s.outbox_id
  JOIN public.crm_native_email_publication_control authority ON authority.singleton AND authority.generation=s.generation
  JOIN crm_legacy_email_retirement.serial revision ON revision.singleton
  WHERE s.staged_xid=pg_current_xact_id_if_assigned()
    AND revision.xmin=s.staged_xid::xid AND o.xmin=s.staged_xid::xid
    AND s.hold_id::text=hold_row->>'operation_id' AND s.outbox_id::text=hold_row->>'outbox_id'
    AND s.retired_outbox_id::text=hold_row->>'retired_outbox_id' AND s.intent_hash=hold_row->>'release_intent_hash'
    AND r.local_id::text=hold_row->>'local_id' AND r.pipeline_id::text=hold_row->>'pipeline_id'
    AND r.native_id=hold_row->>'native_id' AND r.global_id=hold_row->>'global_id'
    AND c.receipt_hash=hold_row->>'retirement_receipt_hash'
    AND s.claim_fingerprint=encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'))
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_archive_serialized_hold(jsonb) FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_stage(p_hold uuid,p_outbox uuid,p_retired uuid,p_lock text,p_retirement text,
 p_activation text,p_intent text,p_approval text,p_issued bigint,p_expires bigint,p_audience jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; r crm_legacy_email_retirement.retained;
 s public.crm_legacy_email_recovery_stages; i public.crm_interactions; o public.sync_outbox;
 policy_row public.crm_native_email_capability_policies; actual_fingerprint text; expected_fingerprint text;
 request_fingerprint text; stage_receipt text; now_seconds bigint; stage_time timestamptz;
BEGIN
 -- An old snapshot can miss a same-provider row whose writer acquired the
 -- serial lock without changing its revision before this transaction did.
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
  RAISE EXCEPTION 'Private Email recovery stage requires READ COMMITTED' USING ERRCODE='55000';
 END IF;
 IF p_hold IS NULL OR p_outbox IS NULL OR p_retired IS NULL OR p_outbox=p_retired
   OR (p_lock ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
   OR (p_retirement ~ '^[0-9a-f]{64}$' AND p_activation ~ '^[0-9a-f]{64}$'
       AND p_intent ~ '^[0-9a-f]{64}$' AND p_approval ~ '^[0-9a-f]{64}$') IS NOT TRUE
   OR (p_issued BETWEEN 1 AND 9007199254740991 AND p_expires BETWEEN 1 AND 9007199254740991
       AND p_expires::numeric-p_issued::numeric BETWEEN 1 AND 120) IS NOT TRUE
   OR jsonb_typeof(p_audience) IS DISTINCT FROM 'object' OR octet_length(p_audience::text)>100000 THEN
  RAISE EXCEPTION 'Private Email recovery stage scope is invalid' USING ERRCODE='55000';
 END IF;
 request_fingerprint:=encode(public.digest(jsonb_build_object('holdId',p_hold,'outboxId',p_outbox,
  'retiredOutboxId',p_retired,'lockToken',p_lock,'retirementReceiptHash',p_retirement,'activationReceiptHash',p_activation,
  'intentHash',p_intent,'approvalHash',p_approval,'issuedAt',p_issued,'expiresAt',p_expires,'audience',p_audience)::text,'sha256'),'hex');
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 SELECT * INTO s FROM public.crm_legacy_email_recovery_stages WHERE hold_id=p_hold;
 IF FOUND THEN
  IF s.request_hash IS DISTINCT FROM request_fingerprint THEN
   RAISE EXCEPTION 'Private Email recovery stage operation already differs' USING ERRCODE='55000';
  END IF;
  RETURN public.clawpilot_crm_legacy_email_stage_read(p_hold,p_intent);
 END IF;
 now_seconds:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF now_seconds<p_issued OR now_seconds>=p_expires OR NOT c.enabled OR c.verified_generation IS DISTINCT FROM c.generation
   OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR c.active_initial_enrollment_id IS NOT NULL
   OR c.activation_receipt_hash IS DISTINCT FROM p_activation THEN
  RAISE EXCEPTION 'Private Email recovery stage requires current idle authority and approval' USING ERRCODE='55000';
 END IF;
 -- Use the same control -> private serial -> source/outbox order as 0406.
 -- This revision fences a concurrent pre-hold snapshot without scheduling
 -- the control table's deferred invoker callbacks under the stage caller.
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement serialization row missing' USING ERRCODE='55000'; END IF;
 SELECT a.* INTO r FROM crm_legacy_email_retirement.retained a JOIN crm_legacy_email_retirement.consumed b USING(batch)
  WHERE a.outbox_id=p_retired AND b.receipt_hash=p_retirement AND a.historical_provider_outcome='unknown';
 IF NOT FOUND THEN RAISE EXCEPTION 'Private Email recovery retirement receipt is missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO i FROM public.crm_interactions WHERE id=r.local_id FOR UPDATE;
 IF (i.pipeline_id=r.pipeline_id AND i.suitecrm_id=r.native_id AND i.reference_code=r.global_id
   AND i.suitecrm_module='Emails' AND i.sync_status='failed' AND i.suitecrm_synced_at IS NULL
   AND lower(i.source_key) NOT LIKE 'suitecrm%' AND COALESCE(lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND jsonb_typeof(i.metadata)='object' AND NOT (i.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
   AND encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')=r.source_hash
   AND r.original->>'idempotency_key'='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
   AND EXISTS(SELECT 1 FROM public.pipeline_spaces p WHERE p.id=r.pipeline_id AND p.workspace_organization_id=r.workspace_id
     AND NOT p.reference_access_disabled)) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM public.crm_interactions x WHERE x.id<>r.local_id
     AND (lower(x.suitecrm_id)=r.native_id OR lower(x.reference_code)=r.global_id
       OR (x.pipeline_id=i.pipeline_id
         AND lower(btrim(x.provider_message_id))=NULLIF(lower(btrim(i.provider_message_id)),''))))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions x WHERE x.local_id=r.local_id
     OR lower(x.native_id)=r.native_id OR lower(x.global_id)=r.global_id)
   OR EXISTS(SELECT 1 FROM public.sync_outbox x WHERE x.id IN (p_retired,p_outbox) OR
      (x.target_system='suitecrm' AND ((x.aggregate_type='crm_interactions' AND x.aggregate_id=r.local_id::text)
       OR (x.payload->>'entity'='interactions' AND (x.payload->>'localId'=r.local_id::text
        OR lower(x.payload->>'suiteCrmId')=r.native_id OR lower(x.payload#>>'{attributes,global_id_c}')=r.global_id))))) THEN
  RAISE EXCEPTION 'Private Email recovery staged source changed or has another publication' USING ERRCODE='55000';
 END IF;
 SELECT * INTO policy_row FROM public.crm_native_email_capability_policies WHERE pipeline_id=r.pipeline_id;
 IF (policy_row.generation=c.generation AND policy_row.policy->>'version'='2'
   AND policy_row.policy->>'pipelineId'=r.pipeline_id::text AND policy_row.policy->>'workspaceId'=r.workspace_id::text
   AND policy_row.policy->>'ownerSuiteCrmId'=r.original#>>'{payload,attributes,assigned_user_id}'
   AND policy_row.policy->>'audienceFingerprint' ~ '^[0-9a-f]{64}$'
   AND jsonb_typeof(policy_row.policy#>'{futureCreate,view}')='array'
   AND jsonb_typeof(r.original#>'{payload,emailProjection}')='object'
   AND p_audience=jsonb_build_object('policy','pipeline-internal','pipelineId',r.pipeline_id,'workspaceId',r.workspace_id,
    'ownerSuiteCrmId',policy_row.policy->>'ownerSuiteCrmId','allowedSuiteCrmUserIds',policy_row.policy#>'{futureCreate,view}',
    'fingerprint',policy_row.policy->>'audienceFingerprint')) IS NOT TRUE THEN
  RAISE EXCEPTION 'Private Email recovery staged audience changed' USING ERRCODE='55000';
 END IF;

 stage_time:=transaction_timestamp();
 o.id:=p_outbox; o.aggregate_type:='crm_interactions'; o.aggregate_id:=r.local_id::text;
 o.operation:='upsert_record'; o.target_system:='suitecrm'; o.status:='processing'; o.attempts:=1;
 o.payload:=jsonb_set(r.original->'payload','{emailProjection,audience}',p_audience,true);
 o.idempotency_key:=r.original->>'idempotency_key'; o.lock_token:=p_lock; o.locked_at:=stage_time;
 o.available_at:='infinity'::timestamptz; o.created_at:=stage_time; o.updated_at:=stage_time;
 expected_fingerprint:=encode(public.digest(to_jsonb(o)::text,'sha256'),'hex');
 stage_receipt:=encode(public.digest(jsonb_build_object('version',1,'action','stage-exact-archived-email',
  'requestFingerprint',request_fingerprint,'claimFingerprint',expected_fingerprint,'sourceFingerprint',r.source_hash,
  'retirementReceiptHash',p_retirement,'historicalProviderOutcome','unknown','generation',c.generation)::text,'sha256'),'hex');
 INSERT INTO public.crm_legacy_email_recovery_stages(hold_id,outbox_id,retired_outbox_id,intent_hash,request_hash,
  approval_hash,receipt_hash,claim_fingerprint,generation,staged_xid,staged_at)
 VALUES(p_hold,p_outbox,p_retired,p_intent,request_fingerprint,p_approval,stage_receipt,expected_fingerprint,
  c.generation,pg_current_xact_id(),stage_time);
 INSERT INTO public.sync_outbox(id,aggregate_type,aggregate_id,operation,target_system,payload,status,attempts,last_error,
  created_at,available_at,processed_at,idempotency_key,locked_at,lock_token,updated_at)
 VALUES(o.id,o.aggregate_type,o.aggregate_id,o.operation,o.target_system,o.payload,o.status,o.attempts,o.last_error,
  o.created_at,o.available_at,o.processed_at,o.idempotency_key,o.locked_at,o.lock_token,o.updated_at)
 RETURNING encode(public.digest(to_jsonb(sync_outbox)::text,'sha256'),'hex') INTO actual_fingerprint;
 IF actual_fingerprint IS DISTINCT FROM expected_fingerprint THEN
  RAISE EXCEPTION 'Private Email recovery stage postimage changed' USING ERRCODE='55000';
 END IF;
 INSERT INTO public.crm_legacy_email_recovery_holds(outbox_id,retired_outbox_id,operation_id,local_id,pipeline_id,native_id,
   global_id,retirement_receipt_hash,release_intent_hash)
 VALUES(p_outbox,p_retired,p_hold,r.local_id,r.pipeline_id,r.native_id,r.global_id,p_retirement,p_intent);
 IF floor(extract(epoch FROM clock_timestamp()))::bigint>=p_expires THEN
  RAISE EXCEPTION 'Private Email recovery stage approval expired during admission' USING ERRCODE='55000';
 END IF;
 RETURN public.clawpilot_crm_legacy_email_stage_read(p_hold,p_intent);
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_stage(uuid,uuid,uuid,text,text,text,text,text,bigint,bigint,jsonb) FROM PUBLIC;
