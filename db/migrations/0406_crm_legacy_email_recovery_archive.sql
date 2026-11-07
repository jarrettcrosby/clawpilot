-- Inert on install. Private evidence inputs must be provisioned separately
-- by a trusted controller after verifying both signatures and the *live*
-- writer fence. SQL hashes bind exact local rows; they cannot prove native
-- absence, drain a remote writer, or tell us the original provider outcome.
CREATE SCHEMA crm_legacy_email_retirement;
REVOKE ALL ON SCHEMA crm_legacy_email_retirement FROM PUBLIC;

CREATE TABLE crm_legacy_email_retirement.verified_batch (
 batch uuid PRIMARY KEY,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 fence_epoch uuid NOT NULL,
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),
 expected_rows integer NOT NULL CHECK(expected_rows BETWEEN 1 AND 25),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
 fence_hash text NOT NULL CHECK(fence_hash ~ '^[0-9a-f]{64}$'),
 approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE crm_legacy_email_retirement.review (
 batch uuid NOT NULL REFERENCES crm_legacy_email_retirement.verified_batch(batch) ON DELETE RESTRICT,
 outbox_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 outbox_hash text NOT NULL CHECK(outbox_hash ~ '^[0-9a-f]{64}$'),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 fence_epoch uuid NOT NULL,
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),
 attestation text NOT NULL CHECK(attestation='verified_fenced_absence'),
 local_id uuid NOT NULL,
 pipeline_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 native_id text NOT NULL CHECK(native_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
 global_id text NOT NULL CHECK(global_id ~ '^gi([0-9]{7}|[0-9a-v]{12})$'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 key_hash text NOT NULL CHECK(key_hash ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(batch,outbox_id),
 UNIQUE(batch,local_id), UNIQUE(batch,native_id), UNIQUE(batch,global_id), UNIQUE(batch,key_hash)
);
CREATE TABLE crm_legacy_email_retirement.retained (
 outbox_id uuid PRIMARY KEY,
 batch uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
 local_id uuid NOT NULL UNIQUE,
 pipeline_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 native_id text NOT NULL UNIQUE CHECK(native_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
 global_id text NOT NULL UNIQUE CHECK(global_id ~ '^gi([0-9]{7}|[0-9a-v]{12})$'),
 original jsonb NOT NULL,
 original_hash text NOT NULL CHECK(original_hash ~ '^[0-9a-f]{64}$'),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[0-9a-f]{64}$'),
 fence_epoch uuid NOT NULL,
 historical_provider_outcome text NOT NULL CHECK(historical_provider_outcome='unknown'),
 FOREIGN KEY(batch,outbox_id) REFERENCES crm_legacy_email_retirement.review(batch,outbox_id) ON DELETE RESTRICT,
 CHECK((jsonb_typeof(original)='object' AND octet_length(original::text)<=2000000
  AND original->>'id'=outbox_id::text AND original->>'aggregate_id'=local_id::text
  AND original#>>'{payload,pipelineId}'=pipeline_id::text AND original#>>'{payload,suiteCrmId}'=native_id
  AND original#>>'{payload,attributes,global_id_c}'=global_id
  AND encode(public.digest(original::text,'sha256'),'hex')=original_hash
  AND encode(public.digest((original->'payload')::text,'sha256'),'hex')=payload_hash
  AND encode(public.digest(original->>'idempotency_key','sha256'),'hex')=key_hash) IS TRUE)
);
CREATE INDEX crm_legacy_email_retirement_retained_batch ON crm_legacy_email_retirement.retained(batch);
CREATE TABLE crm_legacy_email_retirement.consumed (
 batch uuid PRIMARY KEY REFERENCES crm_legacy_email_retirement.verified_batch(batch) ON DELETE RESTRICT,
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
 approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
 archived_rows integer NOT NULL CHECK(archived_rows BETWEEN 1 AND 25),
 consumed_at timestamptz NOT NULL CHECK(isfinite(consumed_at)),
 receipt_hash text NOT NULL UNIQUE CHECK(receipt_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE crm_legacy_email_retirement.serial (
 singleton boolean PRIMARY KEY CHECK(singleton),
 epoch bigint NOT NULL CHECK(epoch>=0)
);
INSERT INTO crm_legacy_email_retirement.serial VALUES(true,0);
REVOKE ALL ON ALL TABLES IN SCHEMA crm_legacy_email_retirement FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_retirement.immutable_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 RAISE EXCEPTION 'Legacy Email retirement evidence is immutable' USING ERRCODE='55000';
END $$;
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['verified_batch','review','retained','consumed'] LOOP
  EXECUTE format('CREATE TRIGGER crm_legacy_email_retirement_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_retirement.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
  EXECUTE format('CREATE TRIGGER crm_legacy_email_retirement_no_truncate BEFORE TRUNCATE ON crm_legacy_email_retirement.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
 END LOOP;
END $$;

-- Serialize additions to a reviewed batch with consumption. A failed or
-- expired batch never forbids a newly signed batch for the same original.
CREATE FUNCTION crm_legacy_email_retirement.check_review_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v crm_legacy_email_retirement.verified_batch;
BEGIN
 -- Use the same control -> private serial -> batch order as consumption.
 -- Do not write control: its deferred checks need authority beyond this role.
 PERFORM 1 FROM public.crm_native_email_publication_control
  WHERE singleton AND NOT enabled AND generation=NEW.generation AND active_operation_id IS NULL
    AND active_transition_id IS NULL AND active_initial_enrollment_id IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Legacy Email retirement review requires disabled idle native control' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement serialization row missing' USING ERRCODE='55000';END IF;
 SELECT * INTO v FROM crm_legacy_email_retirement.verified_batch WHERE batch=NEW.batch FOR UPDATE;
 IF NOT FOUND OR NEW.generation<>v.generation OR NEW.fence_epoch<>v.fence_epoch OR NEW.valid_until<>v.valid_until
   OR NEW.valid_until<=clock_timestamp()
   OR EXISTS(SELECT 1 FROM crm_legacy_email_retirement.consumed c WHERE c.batch=NEW.batch)
   OR (SELECT count(*) FROM crm_legacy_email_retirement.review r WHERE r.batch=NEW.batch)>=v.expected_rows THEN
  RAISE EXCEPTION 'Legacy Email retirement review does not fit its exact unconsumed batch' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_legacy_email_retirement_review_bound BEFORE INSERT ON crm_legacy_email_retirement.review
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.check_review_insert();

-- Future staging can replace this deny-only hook with exact, transaction-bound
-- stage and settlement checks. It never sees a legacy outbox ID resurrected.
CREATE FUNCTION clawpilot_crm_legacy_email_archive_allows_change(retired_id uuid,table_name text,action text,old_row jsonb,new_row jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_archive_allows_change(uuid,text,text,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_retirement.protect_retired() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE before_row jsonb; after_row jsonb; compared jsonb[]:=ARRAY[]::jsonb[]; archived_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained LIMIT 1) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL;END IF;
  IF TG_OP='DELETE' THEN RETURN OLD;END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'Legacy Email retirement prevents truncation' USING ERRCODE='55000';
 END IF;
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD);compared:=array_append(compared,before_row);END IF;
 IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW);compared:=array_append(compared,after_row);END IF;
 IF TG_TABLE_NAME='sync_outbox' AND EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained r
   WHERE r.outbox_id::text IN (before_row->>'id',after_row->>'id')) THEN
  RAISE EXCEPTION 'Original retired Email outbox ID cannot be reused' USING ERRCODE='55000';
 END IF;
 IF TG_TABLE_NAME='crm_native_email_publication_work' AND after_row->>'work_kind'='outbox'
   AND EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained r WHERE r.outbox_id::text=after_row#>>'{context,outboxId}') THEN
  RAISE EXCEPTION 'Original retired Email outbox ID cannot be admitted as work' USING ERRCODE='55000';
 END IF;
 FOR archived_id IN SELECT DISTINCT r.outbox_id FROM crm_legacy_email_retirement.retained r
  CROSS JOIN unnest(compared) AS v(item)
  WHERE CASE TG_TABLE_NAME
   WHEN 'sync_outbox' THEN item->>'target_system'='suitecrm' AND (
     (item->>'aggregate_type'='crm_interactions' AND r.local_id::text=lower(item->>'aggregate_id'))
     OR r.local_id::text=lower(item#>>'{payload,localId}') OR r.native_id=lower(item#>>'{payload,suiteCrmId}')
     OR r.global_id=lower(item#>>'{payload,attributes,global_id_c}')
     OR r.key_hash=encode(public.digest(item->>'idempotency_key','sha256'),'hex'))
   WHEN 'crm_interactions' THEN r.local_id::text=item->>'id' OR r.native_id=lower(item->>'suitecrm_id') OR r.global_id=lower(item->>'reference_code')
   WHEN 'crm_native_email_publication_admissions' THEN r.local_id::text=item->>'local_id'
     OR r.native_id=lower(item->>'native_id') OR r.global_id=lower(item->>'global_id')
   ELSE false END
 LOOP
  IF public.clawpilot_crm_legacy_email_archive_allows_change(archived_id,TG_TABLE_NAME,TG_OP,before_row,after_row) IS NOT TRUE THEN
   RAISE EXCEPTION 'Legacy Email retirement blocks an unapproved identity change' USING ERRCODE='55000';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
-- Keep lock order control -> private serial -> live rows. A prior snapshot
-- receives a serialization failure when the retirement epoch changes, without
-- firing publication control's deferred checks in a narrowly granted role.
CREATE FUNCTION crm_legacy_email_retirement.serialize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement control missing' USING ERRCODE='55000';END IF;
 PERFORM 1 FROM crm_legacy_email_retirement.serial WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement serialization row missing' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER crm_legacy_email_retired_outbox BEFORE INSERT OR UPDATE OR DELETE ON public.sync_outbox
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.protect_retired();
CREATE TRIGGER crm_legacy_email_retired_source BEFORE INSERT OR UPDATE OR DELETE ON public.crm_interactions
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.protect_retired();
CREATE TRIGGER crm_legacy_email_retired_admission BEFORE INSERT ON public.crm_native_email_publication_admissions
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.protect_retired();
CREATE TRIGGER crm_legacy_email_retired_work BEFORE INSERT ON public.crm_native_email_publication_work
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.protect_retired();
DO $$DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['sync_outbox','crm_interactions','crm_native_email_publication_admissions','crm_native_email_publication_work'] LOOP
  -- Names sort after existing control-first BEFORE STATEMENT triggers, and
  -- the archive's truncate guard must inspect rows after its serial lock.
  EXECUTE format('CREATE TRIGGER crm_zz_legacy_email_retirement_serial BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.serialize()',t);
  IF t<>'crm_native_email_publication_work' THEN
   EXECUTE format('CREATE TRIGGER crm_zzz_legacy_email_retired_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.protect_retired()',t);
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION crm_legacy_email_retirement.receipt_fingerprint(batch_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(public.digest(jsonb_build_object('version',1,'purpose','clawpilot-legacy-email-retirement-receipt-v1',
  'operationId',v.batch,'generation',v.generation::text,'manifestDigest',v.manifest_hash,'fenceDigest',v.fence_hash,
  'approvalDigest',v.approval_hash,'historicalProviderOutcome','unknown','retained',(
   SELECT jsonb_agg(jsonb_build_object('outboxId',r.outbox_id,'localId',r.local_id,'pipelineId',r.pipeline_id,
    'workspaceId',r.workspace_id,'nativeId',r.native_id,'globalId',r.global_id,'rowFingerprint',r.original_hash,
    'sourceFingerprint',r.source_hash,'payloadFingerprint',r.payload_hash,'keyFingerprint',r.key_hash)
    ORDER BY r.outbox_id) FROM crm_legacy_email_retirement.retained r WHERE r.batch=v.batch))::text,'sha256'),'hex')
 FROM crm_legacy_email_retirement.verified_batch v WHERE v.batch=batch_id
$$;

CREATE FUNCTION crm_legacy_email_retirement.retire(batch_id uuid, exact_ids uuid[], expected_approval_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; expected crm_legacy_email_retirement.review;
 verified crm_legacy_email_retirement.verified_batch; job public.sync_outbox; src public.crm_interactions;
 originals jsonb[]:=ARRAY[]::jsonb[]; kept jsonb; retired integer:=0; matched integer; consume_time timestamptz;
BEGIN
 IF batch_id IS NULL OR exact_ids IS NULL OR expected_approval_hash IS NULL OR array_ndims(exact_ids)<>1
   OR cardinality(exact_ids) NOT BETWEEN 1 AND 25
   OR cardinality(exact_ids)<>(SELECT count(DISTINCT x) FROM unnest(exact_ids) x) THEN
  RAISE EXCEPTION 'Legacy Email retirement requires an exact bounded row set' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_initial_enrollment_id IS NOT NULL OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL THEN
  RAISE EXCEPTION 'Legacy Email retirement requires disabled idle native control' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Legacy Email retirement serialization row missing' USING ERRCODE='55000';END IF;
 SELECT * INTO verified FROM crm_legacy_email_retirement.verified_batch v WHERE v.batch=batch_id FOR UPDATE;
 IF NOT FOUND OR verified.generation<>c.generation OR verified.valid_until<=clock_timestamp()
   OR verified.valid_until>clock_timestamp()+interval '120 seconds'
   OR verified.approval_hash<>expected_approval_hash OR verified.expected_rows<>cardinality(exact_ids)
   OR EXISTS(SELECT 1 FROM crm_legacy_email_retirement.consumed x WHERE x.batch=batch_id) THEN
  RAISE EXCEPTION 'Legacy Email retirement approval is missing, stale or already consumed' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM crm_legacy_email_retirement.review r WHERE r.batch=batch_id)<>cardinality(exact_ids)
   OR EXISTS(SELECT 1 FROM crm_legacy_email_retirement.review r WHERE r.batch=batch_id AND NOT (r.outbox_id=ANY(exact_ids))) THEN
  RAISE EXCEPTION 'Legacy Email retirement review set differs' USING ERRCODE='55000';
 END IF;
 -- Control -> exact source rows sorted -> exact outbox rows sorted. All
 -- original hashes are checked before any row is removed from the live queue.
 PERFORM i.id FROM public.crm_interactions i WHERE i.id IN (
   SELECT r.local_id FROM crm_legacy_email_retirement.review r WHERE r.batch=batch_id
 ) ORDER BY i.id FOR UPDATE OF i;
 FOR job IN SELECT o.* FROM public.sync_outbox o WHERE o.id=ANY(exact_ids) ORDER BY o.id FOR UPDATE LOOP
  SELECT * INTO expected FROM crm_legacy_email_retirement.review r WHERE r.batch=batch_id AND r.outbox_id=job.id;
  IF NOT FOUND OR (expected.generation=c.generation AND expected.valid_until=verified.valid_until
    AND expected.fence_epoch=verified.fence_epoch AND expected.valid_until>clock_timestamp()
    AND expected.outbox_hash=encode(public.digest(to_jsonb(job)::text,'sha256'),'hex')
    AND expected.payload_hash=encode(public.digest(job.payload::text,'sha256'),'hex')
    AND expected.key_hash=encode(public.digest(job.idempotency_key,'sha256'),'hex')) IS NOT TRUE THEN
   RAISE EXCEPTION 'Legacy Email retirement queue review changed' USING ERRCODE='55000';
  END IF;
  SELECT i.* INTO src FROM public.crm_interactions i WHERE i.id=expected.local_id;
  IF NOT FOUND OR (job.target_system='suitecrm' AND job.aggregate_type='crm_interactions' AND job.operation='upsert_record'
    AND job.status='dead' AND job.attempts=8 AND job.last_error IS NOT NULL AND job.processed_at IS NOT NULL
    AND job.locked_at IS NULL AND job.lock_token IS NULL AND job.aggregate_id=src.id::text
    AND job.payload->>'entity'='interactions' AND job.payload->>'localId'=src.id::text
    AND job.payload->>'pipelineId'=src.pipeline_id::text AND job.payload->>'suiteCrmId'=src.suitecrm_id
    AND job.payload->>'suiteCrmModule'='Emails' AND job.payload->>'previousSuiteCrmModule' IS NULL
    AND job.payload#>>'{attributes,global_id_c}'=src.reference_code AND src.suitecrm_module='Emails'
    AND src.suitecrm_synced_at IS NULL AND src.sync_status='failed' AND lower(src.source_key) NOT LIKE 'suitecrm%'
    AND job.idempotency_key='crm:interactions:v4:'||src.id::text||':Emails:'||src.source_hash
    AND jsonb_typeof(src.metadata)='object' AND NOT (src.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
    AND COALESCE(lower(src.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND expected.pipeline_id=src.pipeline_id AND expected.native_id=src.suitecrm_id AND expected.global_id=src.reference_code
    AND EXISTS(SELECT 1 FROM public.pipeline_spaces p WHERE p.id=expected.pipeline_id AND p.workspace_organization_id=expected.workspace_id)
    AND expected.source_hash=encode(public.digest(to_jsonb(src)::text,'sha256'),'hex')) IS NOT TRUE THEN
   RAISE EXCEPTION 'Legacy Email retirement source is not the exact terminal legacy Email' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w WHERE w.work_kind='outbox'
    AND (w.context->>'outboxId'=job.id::text OR w.context->>'idempotencyKey'=job.idempotency_key))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=src.id
     OR lower(a.native_id)=expected.native_id OR lower(a.global_id)=expected.global_id)
   OR EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=job.id OR h.retired_outbox_id=job.id
     OR h.local_id=src.id OR h.native_id=expected.native_id OR h.global_id=expected.global_id)
   OR EXISTS(SELECT 1 FROM public.crm_interactions i WHERE i.id<>src.id AND
     (lower(i.suitecrm_id)=expected.native_id OR lower(i.reference_code)=expected.global_id))
   OR EXISTS(SELECT 1 FROM public.sync_outbox other WHERE other.id<>job.id AND other.target_system='suitecrm'
      AND ((other.aggregate_type='crm_interactions' AND lower(other.aggregate_id)=src.id::text)
        OR lower(other.payload->>'localId')=src.id::text OR lower(other.payload->>'suiteCrmId')=expected.native_id
        OR lower(other.payload#>>'{attributes,global_id_c}')=expected.global_id OR other.idempotency_key=job.idempotency_key)) THEN
   RAISE EXCEPTION 'Legacy Email retirement found a competing identity or delivery receipt' USING ERRCODE='55000';
  END IF;
  originals:=array_append(originals,to_jsonb(job));
 END LOOP;
 IF cardinality(originals)<>cardinality(exact_ids) THEN
  RAISE EXCEPTION 'Legacy Email retirement exact queue set is missing' USING ERRCODE='55000';
 END IF;
 FOREACH kept IN ARRAY originals LOOP
  DELETE FROM public.sync_outbox WHERE id=(kept->>'id')::uuid AND to_jsonb(sync_outbox)=kept;
  GET DIAGNOSTICS matched=ROW_COUNT;
  IF matched<>1 THEN RAISE EXCEPTION 'Legacy Email retirement queue CAS changed' USING ERRCODE='55000';END IF;
  INSERT INTO crm_legacy_email_retirement.retained
   (outbox_id,batch,generation,local_id,pipeline_id,workspace_id,native_id,global_id,original,original_hash,
    source_hash,payload_hash,key_hash,fence_epoch,historical_provider_outcome)
  SELECT r.outbox_id,r.batch,r.generation,r.local_id,r.pipeline_id,r.workspace_id,r.native_id,r.global_id,kept,r.outbox_hash,
   r.source_hash,r.payload_hash,r.key_hash,r.fence_epoch,'unknown'
  FROM crm_legacy_email_retirement.review r WHERE r.outbox_id=(kept->>'id')::uuid AND r.batch=batch_id;
  retired:=retired+1;
 END LOOP;
 consume_time:=clock_timestamp();
 IF verified.valid_until<=consume_time THEN
  RAISE EXCEPTION 'Legacy Email retirement approval expired before consumption' USING ERRCODE='55000';
 END IF;
 INSERT INTO crm_legacy_email_retirement.consumed(batch,manifest_hash,approval_hash,archived_rows,consumed_at,receipt_hash)
 VALUES(verified.batch,verified.manifest_hash,verified.approval_hash,retired,consume_time,
  crm_legacy_email_retirement.receipt_fingerprint(verified.batch));
 RETURN retired;
END $$;

-- Readback is exact and survives loss of the archive COMMIT response. It is
-- not authorization to replay an uncertain old native job or rerun a batch.
CREATE FUNCTION crm_legacy_email_retirement.resolve(batch_id uuid, expected_manifest_hash text, expected_approval_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((
  SELECT jsonb_build_object('state','committed','operationId',b.batch,'manifestDigest',b.manifest_hash,
   'approvalDigest',b.approval_hash,'rows',b.expected_rows,'historicalProviderOutcome','unknown','receiptHash',c.receipt_hash)
  FROM crm_legacy_email_retirement.verified_batch b JOIN crm_legacy_email_retirement.consumed c ON c.batch=b.batch
  WHERE b.batch=batch_id AND b.manifest_hash=expected_manifest_hash AND b.approval_hash=expected_approval_hash
   AND c.manifest_hash=b.manifest_hash AND c.approval_hash=b.approval_hash AND c.archived_rows=b.expected_rows
   AND c.consumed_at<b.valid_until AND c.receipt_hash=crm_legacy_email_retirement.receipt_fingerprint(b.batch)
   AND b.expected_rows=(SELECT count(*) FROM crm_legacy_email_retirement.review r WHERE r.batch=b.batch)
   AND b.expected_rows=(SELECT count(*) FROM crm_legacy_email_retirement.retained r WHERE r.batch=b.batch)
   AND b.expected_rows=(SELECT count(*) FROM crm_legacy_email_retirement.retained r JOIN crm_legacy_email_retirement.review v
     ON v.batch=r.batch AND v.outbox_id=r.outbox_id AND v.outbox_hash=r.original_hash AND v.source_hash=r.source_hash
       AND v.generation=r.generation AND v.fence_epoch=r.fence_epoch AND v.local_id=r.local_id AND v.pipeline_id=r.pipeline_id
       AND v.workspace_id=r.workspace_id AND v.native_id=r.native_id AND v.global_id=r.global_id
       AND v.payload_hash=r.payload_hash AND v.key_hash=r.key_hash
     WHERE r.batch=b.batch AND r.generation=b.generation AND r.fence_epoch=b.fence_epoch
       AND NOT EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=r.outbox_id))
 ),'{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_legacy_email_retirement FROM PUBLIC;
