-- Private, inert pre-archive repair for one already-failed Email. Neither
-- this migration nor the read-only preview grants authority or enqueues work.
CREATE TABLE crm_legacy_email_retirement.account_repair_approvals (
 operation_id uuid PRIMARY KEY,
 generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
 review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
 approval_digest text NOT NULL UNIQUE CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
 fence_epoch uuid NOT NULL,
 expires_at timestamptz NOT NULL CHECK (isfinite(expires_at))
);
CREATE TABLE crm_legacy_email_retirement.account_repairs (
 operation_id uuid PRIMARY KEY REFERENCES crm_legacy_email_retirement.account_repair_approvals(operation_id),
 local_id uuid NOT NULL UNIQUE,
 outbox_id uuid NOT NULL UNIQUE,
 review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
 approval_digest text NOT NULL UNIQUE CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
 receipt_hash text NOT NULL UNIQUE CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
 reviewed_plan jsonb NOT NULL,
 original_source jsonb NOT NULL,
 original_outbox jsonb NOT NULL,
 original_edges jsonb NOT NULL,
 new_source_digest text NOT NULL CHECK (new_source_digest ~ '^[0-9a-f]{64}$'),
 new_outbox_digest text NOT NULL CHECK (new_outbox_digest ~ '^[0-9a-f]{64}$'),
 committed_at timestamptz NOT NULL
);
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['account_repair_approvals','account_repairs'] LOOP
  EXECUTE format('REVOKE ALL ON crm_legacy_email_retirement.%I FROM PUBLIC',t);
  EXECUTE format('CREATE TRIGGER repair_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_retirement.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
  EXECUTE format('CREATE TRIGGER repair_no_truncate BEFORE TRUNCATE ON crm_legacy_email_retirement.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
 END LOOP;
END $$;

-- Internal planner: callers only see the compact review, never retained
-- message content, contact details, or raw source bytes. Derive the new
-- payload from the old one; a caller cannot supply replacement content.
CREATE FUNCTION crm_legacy_email_retirement.account_repair_plan(p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; src public.crm_interactions; job public.sync_outbox;
 old_account public.crm_organizations; new_account public.crm_organizations;
 target_uuid text; local uuid; outbox uuid; pipeline uuid; workspace uuid; old_id uuid; new_id uuid;
 old_native text; new_native text; exact_native text; exact_global text; edges jsonb; contacts jsonb; bindings jsonb;
 related jsonb; contact_links jsonb; old_projection jsonb; new_payload jsonb; old_source jsonb; old_job jsonb;
 review jsonb; review_digest text;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'
   OR jsonb_typeof(p_target) IS DISTINCT FROM 'object' OR octet_length(p_target::text)>4000
   OR (SELECT count(*) FROM jsonb_object_keys(p_target))<>10
   OR NOT p_target ?& ARRAY['outboxId','localId','pipelineId','workspaceId','globalId','nativeId',
     'oldPrimaryId','newPrimaryId','oldPrimaryNativeId','newPrimaryNativeId'] THEN
  RAISE EXCEPTION 'Legacy Email account repair requires one exact target and READ COMMITTED' USING ERRCODE='55000';
 END IF;
 FOREACH target_uuid IN ARRAY ARRAY['outboxId','localId','pipelineId','workspaceId','nativeId',
   'oldPrimaryId','newPrimaryId','oldPrimaryNativeId','newPrimaryNativeId'] LOOP
  IF (p_target->>target_uuid ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE THEN
   RAISE EXCEPTION 'Legacy Email account repair identity is invalid' USING ERRCODE='55000';
  END IF;
 END LOOP;
 exact_global:=p_target->>'globalId'; exact_native:=p_target->>'nativeId';
 local:=(p_target->>'localId')::uuid; outbox:=(p_target->>'outboxId')::uuid;
 pipeline:=(p_target->>'pipelineId')::uuid; workspace:=(p_target->>'workspaceId')::uuid;
 old_id:=(p_target->>'oldPrimaryId')::uuid; new_id:=(p_target->>'newPrimaryId')::uuid;
 old_native:=p_target->>'oldPrimaryNativeId'; new_native:=p_target->>'newPrimaryNativeId';
 IF (exact_global ~ '^gi([0-9]{7}|[0-9a-v]{12})$') IS NOT TRUE OR old_id=new_id OR old_native=new_native THEN
  RAISE EXCEPTION 'Legacy Email account repair identity is invalid' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL
   OR c.active_initial_enrollment_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.pipeline_spaces p
     WHERE p.id=pipeline AND p.workspace_organization_id=workspace AND NOT p.reference_access_disabled) THEN
  RAISE EXCEPTION 'Legacy Email account repair requires disabled idle authority and current workspace' USING ERRCODE='55000';
 END IF;
 PERFORM 1 FROM crm_legacy_email_retirement.serial WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement serialization row missing' USING ERRCODE='55000'; END IF;
 SELECT i.* INTO src FROM public.crm_interactions i WHERE i.id=local FOR UPDATE;
 SELECT o.* INTO job FROM public.sync_outbox o WHERE o.id=outbox FOR UPDATE;
 SELECT o.* INTO old_account FROM public.crm_organizations o WHERE o.id=old_id AND o.pipeline_id=pipeline;
 SELECT o.* INTO new_account FROM public.crm_organizations o WHERE o.id=new_id AND o.pipeline_id=pipeline;
 IF (src.id=local AND src.pipeline_id=pipeline AND src.organization_id=old_id AND src.reference_code=exact_global
   AND src.suitecrm_id=exact_native AND src.suitecrm_module='Emails' AND src.sync_status='failed' AND src.suitecrm_synced_at IS NULL
   AND lower(src.source_key) NOT LIKE 'suitecrm%' AND src.source_hash ~ '^[0-9a-f]{64}$'
   AND jsonb_typeof(src.metadata)='object'
   AND NOT (src.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication','reviewedGmailRecovery'])
   AND COALESCE(lower(src.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND NOT EXISTS(SELECT 1 FROM public.crm_email_review_decisions d WHERE d.interaction_id=local)
   AND job.id=outbox AND job.target_system='suitecrm' AND job.aggregate_type='crm_interactions'
   AND job.aggregate_id=local::text AND job.operation='upsert_record' AND job.status='dead' AND job.attempts=8
   AND job.last_error IS NOT NULL AND job.processed_at IS NOT NULL AND job.locked_at IS NULL AND job.lock_token IS NULL
   AND job.idempotency_key='crm:interactions:v4:'||local::text||':Emails:'||src.source_hash
   AND job.payload->>'entity'='interactions' AND job.payload->>'localId'=local::text AND job.payload->>'pipelineId'=pipeline::text
   AND job.payload->>'suiteCrmId'=exact_native AND job.payload->>'suiteCrmModule'='Emails'
   AND job.payload->>'previousSuiteCrmModule' IS NULL AND job.payload#>>'{attributes,global_id_c}'=exact_global
   AND job.payload#>>'{attributes,parent_type}'='Accounts' AND job.payload#>>'{attributes,parent_id}'=old_native
   AND old_account.suitecrm_id=old_native AND lower(btrim(old_account.account_type))='supplier'
   AND new_account.suitecrm_id=new_native AND lower(btrim(new_account.account_type))='customer'
   AND COALESCE(lower(old_account.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND COALESCE(lower(new_account.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND old_account.reference_code IS NOT NULL AND new_account.reference_code IS NOT NULL) IS NOT TRUE THEN
  RAISE EXCEPTION 'Legacy Email account repair requires the exact unsynced Supplier-only terminal Email and current Customer' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained r WHERE r.outbox_id=outbox OR r.local_id=local
    OR r.native_id=exact_native OR r.global_id=exact_global)
   OR EXISTS(SELECT 1 FROM crm_legacy_email_retirement.account_repairs r WHERE r.outbox_id=outbox OR r.local_id=local)
   OR EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=outbox OR h.retired_outbox_id=outbox
     OR h.local_id=local OR h.native_id=exact_native OR h.global_id=exact_global)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=local
     OR lower(a.native_id)=exact_native OR lower(a.global_id)=exact_global)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w WHERE w.work_kind='outbox'
     AND (w.context->>'outboxId'=outbox::text OR w.context->>'idempotencyKey'=job.idempotency_key))
   OR EXISTS(SELECT 1 FROM public.crm_interactions i WHERE i.id<>local AND
     (lower(i.suitecrm_id)=exact_native OR lower(i.reference_code)=exact_global OR (i.pipeline_id=pipeline AND
       lower(btrim(i.provider_message_id))=NULLIF(lower(btrim(src.provider_message_id)),''))))
   OR EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id<>outbox AND o.target_system='suitecrm'
     AND ((o.aggregate_type='crm_interactions' AND o.aggregate_id=local::text) OR lower(o.payload->>'localId')=local::text
       OR lower(o.payload->>'suiteCrmId')=exact_native OR lower(o.payload#>>'{attributes,global_id_c}')=exact_global
       OR o.idempotency_key=job.idempotency_key)) THEN
  RAISE EXCEPTION 'Legacy Email account repair found an archived, reviewed or competing identity' USING ERRCODE='55000';
 END IF;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY e.organization_id) INTO edges FROM public.crm_interaction_organizations e
  WHERE e.interaction_id=local AND e.pipeline_id=pipeline;
 IF (jsonb_array_length(edges)=1 AND edges->0->>'organization_id'=old_id::text
   AND edges->0->>'is_primary'='true') IS NOT TRUE THEN
  RAISE EXCEPTION 'Legacy Email account repair requires exactly the existing Supplier edge' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM public.crm_interaction_contacts e
   LEFT JOIN public.crm_contacts a ON a.id=e.contact_id AND a.pipeline_id=e.pipeline_id
   WHERE e.interaction_id=local AND e.pipeline_id=pipeline AND (
     (a.suitecrm_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$' AND a.organization_id=old_id) IS NOT TRUE
     OR COALESCE(lower(a.source_payload->>'archived'),'false') IN ('true','1','yes')))
   OR (src.contact_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_interaction_contacts e
     WHERE e.interaction_id=local AND e.pipeline_id=pipeline AND e.contact_id=src.contact_id)) THEN
  RAISE EXCEPTION 'Legacy Email account repair found an unmapped original Contact' USING ERRCODE='55000';
 END IF;
 SELECT COALESCE(jsonb_agg(a.suitecrm_id ORDER BY a.suitecrm_id COLLATE "C"),'[]'::jsonb),
   COALESCE(jsonb_agg(jsonb_build_object('contactId',a.suitecrm_id,'accountId',old_native) ORDER BY a.suitecrm_id COLLATE "C"),'[]'::jsonb),
   COALESCE(jsonb_agg(jsonb_build_object('linkFieldName','contacts','relatedModuleName','Contacts','relatedBeanId',a.suitecrm_id)
     ORDER BY a.suitecrm_id COLLATE "C"),'[]'::jsonb)
  INTO contacts,bindings,contact_links FROM public.crm_interaction_contacts e JOIN public.crm_contacts a
   ON a.id=e.contact_id AND a.pipeline_id=e.pipeline_id WHERE e.interaction_id=local AND e.pipeline_id=pipeline;
 old_projection:=job.payload->'emailProjection';
 related:=COALESCE(job.payload->'relationships','[]'::jsonb);
 IF (jsonb_array_length(contacts)<=25 AND jsonb_typeof(related)='array' AND jsonb_array_length(related)=1+jsonb_array_length(contacts)
   AND related @> (jsonb_build_array(jsonb_build_object('linkFieldName','accounts','relatedModuleName','Accounts','relatedBeanId',old_native))||contact_links)
   AND old_projection->'version'='1'::jsonb AND old_projection->'accounts'=jsonb_build_array(old_native)
   AND old_projection->'contacts'=contacts AND old_projection->'contactAccounts'=bindings
   AND old_projection#>'{previousManaged,accounts}'='[]'::jsonb AND old_projection#>'{previousManaged,contacts}'='[]'::jsonb) IS NOT TRUE THEN
  RAISE EXCEPTION 'Legacy Email account repair original native associations changed' USING ERRCODE='55000';
 END IF;
 old_source:=to_jsonb(src); old_job:=to_jsonb(job);
 IF octet_length(old_source::text)>2000000 OR octet_length(old_job::text)>2000000 THEN
  RAISE EXCEPTION 'Legacy Email account repair original exceeds bounds' USING ERRCODE='55000';
 END IF;
 -- Preserve all historical content, Contact links, and audience bytes. The
 -- only payload changes are its parent and one additional Accounts relation.
 new_payload:=jsonb_set(jsonb_set(jsonb_set(job.payload,'{attributes,parent_id}',to_jsonb(new_native),false),
   '{emailProjection,accounts}',(SELECT jsonb_agg(x ORDER BY x COLLATE "C") FROM unnest(ARRAY[old_native,new_native]) x),false),
   '{relationships}',related||jsonb_build_array(jsonb_build_object(
     'linkFieldName','accounts','relatedModuleName','Accounts','relatedBeanId',new_native)),false);
 review:=jsonb_build_object('version',1,'purpose','clawpilot-exact-legacy-email-account-repair-review-v1',
   'target',p_target,'generation',c.generation,'oldPrimaryReference',old_account.reference_code,'newPrimaryReference',new_account.reference_code,
   'sourceDigest',encode(public.digest(old_source::text,'sha256'),'hex'),
   'outboxDigest',encode(public.digest(old_job::text,'sha256'),'hex'),
   'edgeDigest',encode(public.digest(edges::text,'sha256'),'hex'),
   'nextPayloadDigest',encode(public.digest(new_payload::text,'sha256'),'hex'));
 review_digest:=encode(public.digest(review::text,'sha256'),'hex');
 RETURN jsonb_build_object('review',review,'reviewDigest',review_digest,'source',old_source,'outbox',old_job,'edges',edges,'newPayload',new_payload);
END $$;
REVOKE ALL ON FUNCTION crm_legacy_email_retirement.account_repair_plan(jsonb) FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_retirement.preview_account_repair(p_target jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p jsonb;
BEGIN
 p:=crm_legacy_email_retirement.account_repair_plan(p_target);
 RETURN jsonb_build_object('review',p->'review','reviewDigest',p->'reviewDigest');
END $$;
REVOKE ALL ON FUNCTION crm_legacy_email_retirement.preview_account_repair(jsonb) FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_retirement.read_account_repair(p_operation uuid,p_approval text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((SELECT jsonb_build_object('state','committed','operationId',r.operation_id,
   'reviewDigest',r.review_digest,'receiptHash',r.receipt_hash)
  FROM crm_legacy_email_retirement.account_repairs r WHERE r.operation_id=p_operation AND r.approval_digest=p_approval),
  '{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON FUNCTION crm_legacy_email_retirement.read_account_repair(uuid,text) FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_retirement.repair_account_links(p_operation uuid,p_target jsonb,p_approval text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE plan jsonb; approval crm_legacy_email_retirement.account_repair_approvals; local uuid; outbox uuid;
 pipeline uuid; old_id uuid; new_id uuid; new_hash text; new_key text; changed integer; previous_guc text;
 source_after jsonb; outbox_after jsonb; edges_after jsonb; source_digest text; outbox_digest text; receipt_hash text;
BEGIN
 IF p_operation IS NULL OR (p_approval ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'Legacy Email account repair requires exact approval' USING ERRCODE='55000';
 END IF;
 plan:=crm_legacy_email_retirement.account_repair_plan(p_target);
 SELECT a.* INTO approval FROM crm_legacy_email_retirement.account_repair_approvals a WHERE a.operation_id=p_operation;
 IF NOT FOUND OR approval.approval_digest<>p_approval OR approval.review_digest<>plan->>'reviewDigest'
   OR approval.generation<>(plan#>>'{review,generation}')::bigint
   OR approval.expires_at<=clock_timestamp() OR approval.expires_at>clock_timestamp()+interval '120 seconds' THEN
  RAISE EXCEPTION 'Legacy Email account repair approval or reviewed bytes changed' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 local:=(p_target->>'localId')::uuid; outbox:=(p_target->>'outboxId')::uuid;
 pipeline:=(p_target->>'pipelineId')::uuid; old_id:=(p_target->>'oldPrimaryId')::uuid; new_id:=(p_target->>'newPrimaryId')::uuid;
 new_hash:=encode(public.digest(jsonb_build_object('purpose','clawpilot-legacy-email-account-repair-source-v1',
   'previous',plan#>>'{source,source_hash}','review',approval.review_digest)::text,'sha256'),'hex');
 new_key:='crm:interactions:v4:'||local::text||':Emails:'||new_hash;
 previous_guc:=current_setting('clawpilot.crm_shared_write_v1',true);
 PERFORM set_config('clawpilot.crm_shared_write_v1','on',true);
 UPDATE public.crm_interactions i SET organization_id=new_id,source_hash=new_hash,updated_at=transaction_timestamp()
  WHERE i.id=local AND to_jsonb(i)=plan->'source' RETURNING to_jsonb(i) INTO source_after;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email account repair source CAS changed' USING ERRCODE='55000'; END IF;
 UPDATE public.crm_interaction_organizations e SET is_primary=false,sort_order=1,updated_at=transaction_timestamp()
  WHERE e.interaction_id=local AND e.organization_id=old_id AND to_jsonb(e)=plan#>'{edges,0}';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'Legacy Email account repair edge CAS changed' USING ERRCODE='55000'; END IF;
 INSERT INTO public.crm_interaction_organizations(pipeline_id,interaction_id,organization_id,is_primary,sort_order)
  VALUES(pipeline,local,new_id,true,0);
 PERFORM set_config('clawpilot.crm_shared_write_v1',COALESCE(previous_guc,''),true);
 UPDATE public.sync_outbox o SET payload=plan->'newPayload',idempotency_key=new_key
  WHERE o.id=outbox AND to_jsonb(o)=plan->'outbox' RETURNING to_jsonb(o) INTO outbox_after;
 SELECT jsonb_agg(to_jsonb(e) ORDER BY e.organization_id) INTO edges_after FROM public.crm_interaction_organizations e
  WHERE e.interaction_id=local AND e.pipeline_id=pipeline;
 IF (source_after=plan->'source'||jsonb_build_object('organization_id',new_id,'source_hash',new_hash,'updated_at',transaction_timestamp())
   AND outbox_after=plan->'outbox'||jsonb_build_object('payload',plan->'newPayload','idempotency_key',new_key)
   AND jsonb_array_length(edges_after)=2 AND edges_after @> jsonb_build_array(
     jsonb_build_object('organization_id',new_id,'is_primary',true,'sort_order',0),
     jsonb_build_object('organization_id',old_id,'is_primary',false,'sort_order',1))
   AND approval.expires_at>clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Legacy Email account repair exact postimage or approval changed' USING ERRCODE='55000';
 END IF;
 source_digest:=encode(public.digest(source_after::text,'sha256'),'hex');
 outbox_digest:=encode(public.digest(outbox_after::text,'sha256'),'hex');
 receipt_hash:=encode(public.digest(jsonb_build_object('operationId',p_operation,'reviewDigest',approval.review_digest,
   'approvalDigest',p_approval,'sourceDigest',source_digest,'outboxDigest',outbox_digest,
   'edgeDigest',encode(public.digest(edges_after::text,'sha256'),'hex'))::text,'sha256'),'hex');
 INSERT INTO crm_legacy_email_retirement.account_repairs(operation_id,local_id,outbox_id,review_digest,approval_digest,receipt_hash,
   reviewed_plan,original_source,original_outbox,original_edges,new_source_digest,new_outbox_digest,committed_at)
  VALUES(p_operation,local,outbox,approval.review_digest,p_approval,receipt_hash,
    plan->'review',plan->'source',plan->'outbox',plan->'edges',source_digest,outbox_digest,clock_timestamp());
 RETURN jsonb_build_object('state','committed','operationId',p_operation,'reviewDigest',approval.review_digest,'receiptHash',receipt_hash);
END $$;
REVOKE ALL ON FUNCTION crm_legacy_email_retirement.repair_account_links(uuid,jsonb,text) FROM PUBLIC;
