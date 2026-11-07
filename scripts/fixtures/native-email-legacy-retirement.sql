-- Disposable PostgreSQL fixture only. Never installed by app migrations.
-- These roles stand in for independently authenticated, continuously fenced
-- evidence. Nothing here authenticates Railway, SuiteCRM or a real approval.
CREATE ROLE crm_fixture_retirement_attestor NOLOGIN;
CREATE ROLE crm_fixture_retirement_controller NOLOGIN;
CREATE ROLE crm_fixture_retirement_resolver NOLOGIN;
CREATE ROLE crm_fixture_ordinary_writer NOLOGIN;
CREATE SCHEMA crm_retirement_fixture;
REVOKE ALL ON SCHEMA crm_retirement_fixture FROM PUBLIC;
GRANT USAGE ON SCHEMA crm_retirement_fixture
 TO crm_fixture_retirement_attestor,crm_fixture_retirement_controller,crm_fixture_retirement_resolver;
CREATE TABLE crm_retirement_fixture.verified_batch (
 batch uuid PRIMARY KEY, generation bigint NOT NULL, fence_epoch uuid NOT NULL, valid_until timestamptz NOT NULL,
 expected_rows integer NOT NULL CHECK(expected_rows BETWEEN 1 AND 25),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
 fence_hash text NOT NULL CHECK(fence_hash ~ '^[0-9a-f]{64}$'),
 approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$')
);
GRANT INSERT ON crm_retirement_fixture.verified_batch TO crm_fixture_retirement_attestor;
CREATE TABLE crm_retirement_fixture.review (
 batch uuid NOT NULL REFERENCES crm_retirement_fixture.verified_batch(batch), outbox_id uuid PRIMARY KEY, generation bigint NOT NULL,
 outbox_hash text NOT NULL CHECK(outbox_hash ~ '^[0-9a-f]{64}$'),
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
 fence_epoch uuid NOT NULL, valid_until timestamptz NOT NULL,
 attestation text NOT NULL CHECK(attestation='synthetic_fenced_absence_only')
);
GRANT INSERT ON crm_retirement_fixture.review TO crm_fixture_retirement_attestor;
CREATE TABLE crm_retirement_fixture.retained (
 outbox_id uuid PRIMARY KEY, batch uuid NOT NULL REFERENCES crm_retirement_fixture.verified_batch(batch), generation bigint NOT NULL,
 local_id text NOT NULL UNIQUE, native_id text NOT NULL UNIQUE, global_id text NOT NULL UNIQUE,
 original jsonb NOT NULL, original_hash text NOT NULL, source_hash text NOT NULL,
 fence_epoch uuid NOT NULL, historical_provider_outcome text NOT NULL CHECK(historical_provider_outcome='unknown'),
 CHECK(original->>'id'=outbox_id::text AND original->>'aggregate_id'=local_id
  AND encode(public.digest(original::text,'sha256'),'hex')=original_hash)
);
CREATE TABLE crm_retirement_fixture.consumed (
 batch uuid PRIMARY KEY REFERENCES crm_retirement_fixture.verified_batch(batch),
 manifest_hash text NOT NULL, approval_hash text NOT NULL UNIQUE, archived_rows integer NOT NULL CHECK(archived_rows BETWEEN 1 AND 25),
 consumed_at timestamptz NOT NULL
);
CREATE TABLE crm_retirement_fixture.serial (singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL);
INSERT INTO crm_retirement_fixture.serial VALUES(true,0);
REVOKE ALL ON ALL TABLES IN SCHEMA crm_retirement_fixture FROM PUBLIC;

CREATE FUNCTION crm_retirement_fixture.serialize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 -- In READ COMMITTED, a waiting statement sees the new retained rows via
 -- the volatile row trigger. Under REPEATABLE READ, the changed singleton
 -- forces a serialization failure instead of trusting a pre-retirement view.
 PERFORM 1 FROM crm_retirement_fixture.serial WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Fixture: fence missing' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_retirement_fixture.serialize() FROM PUBLIC;
-- Named after the existing control-first BEFORE STATEMENT triggers.
CREATE TRIGGER crm_retirement_fixture_serial BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.sync_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION crm_retirement_fixture.serialize();

CREATE FUNCTION crm_retirement_fixture.protect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE records jsonb[]:=ARRAY[]::jsonb[]; item jsonb;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM crm_retirement_fixture.retained) THEN
   RAISE EXCEPTION 'Fixture: retained Email prevents queue truncate' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF TG_OP<>'INSERT' THEN records:=array_append(records,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN records:=array_append(records,to_jsonb(NEW)); END IF;
 FOREACH item IN ARRAY records LOOP
  IF EXISTS(SELECT 1 FROM crm_retirement_fixture.retained r WHERE
    r.outbox_id::text=item->>'id' OR
    (item->>'target_system'='suitecrm' AND (
      (item->>'aggregate_type'='crm_interactions' AND r.local_id=item->>'aggregate_id')
      OR (item#>>'{payload,entity}'='interactions' AND (
        r.local_id=item#>>'{payload,localId}' OR r.native_id=item#>>'{payload,suiteCrmId}'
        OR r.global_id=item#>>'{payload,attributes,global_id_c}'))))
   ) THEN RAISE EXCEPTION 'Fixture: exact retired Email requires reviewed release' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crm_retirement_fixture.protect() FROM PUBLIC;
CREATE TRIGGER crm_retirement_fixture_hold BEFORE INSERT OR UPDATE OR DELETE ON public.sync_outbox
 FOR EACH ROW EXECUTE FUNCTION crm_retirement_fixture.protect();
CREATE TRIGGER crm_retirement_fixture_truncate BEFORE TRUNCATE ON public.sync_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION crm_retirement_fixture.protect();

CREATE FUNCTION crm_retirement_fixture.retire(batch_id uuid, exact_ids uuid[], expected_approval_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; expected crm_retirement_fixture.review;
 verified crm_retirement_fixture.verified_batch;
 job public.sync_outbox; src public.crm_interactions; originals jsonb[]:=ARRAY[]::jsonb[];
 kept jsonb; retired integer:=0; epoch uuid; matched integer; consume_time timestamptz;
BEGIN
 IF batch_id IS NULL OR exact_ids IS NULL OR expected_approval_hash IS NULL OR cardinality(exact_ids) NOT BETWEEN 1 AND 25
   OR cardinality(exact_ids)<>(SELECT count(DISTINCT x) FROM unnest(exact_ids) x) THEN
  RAISE EXCEPTION 'Fixture: invalid exact set' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_initial_enrollment_id IS NOT NULL OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL THEN
  RAISE EXCEPTION 'Fixture: control not disabled idle' USING ERRCODE='55000';
 END IF;
 SELECT * INTO verified FROM crm_retirement_fixture.verified_batch v WHERE v.batch=batch_id FOR UPDATE;
 IF NOT FOUND OR verified.generation<>c.generation OR verified.valid_until<=clock_timestamp()
    OR verified.approval_hash<>expected_approval_hash OR verified.expected_rows<>cardinality(exact_ids)
    OR EXISTS(SELECT 1 FROM crm_retirement_fixture.consumed x WHERE x.batch=batch_id) THEN
  RAISE EXCEPTION 'Fixture: verified approval missing, expired or already consumed' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM crm_retirement_fixture.review r WHERE r.batch=batch_id)<>cardinality(exact_ids) THEN
  RAISE EXCEPTION 'Fixture: exact reviewed set differs' USING ERRCODE='55000';
 END IF;
 UPDATE crm_retirement_fixture.serial s SET epoch=s.epoch+1 WHERE s.singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Fixture: fence missing' USING ERRCODE='55000'; END IF;
 -- Control -> exact source rows sorted -> exact outbox rows sorted.
 PERFORM i.id FROM public.crm_interactions i WHERE i.id::text IN (
   SELECT o.aggregate_id FROM public.sync_outbox o WHERE o.id=ANY(exact_ids)
 ) ORDER BY i.id FOR UPDATE OF i;
 FOR job IN SELECT o.* FROM public.sync_outbox o WHERE o.id=ANY(exact_ids) ORDER BY o.id FOR UPDATE LOOP
  SELECT * INTO expected FROM crm_retirement_fixture.review r WHERE r.batch=batch_id AND r.outbox_id=job.id;
  IF NOT FOUND OR expected.generation<>c.generation OR expected.valid_until<>verified.valid_until
   OR expected.fence_epoch<>verified.fence_epoch OR expected.valid_until<=clock_timestamp()
   OR (epoch IS NOT NULL AND expected.fence_epoch<>epoch)
   OR expected.outbox_hash<>encode(public.digest(to_jsonb(job)::text,'sha256'),'hex') THEN
   RAISE EXCEPTION 'Fixture: stale or mismatched review' USING ERRCODE='55000';
  END IF;
  epoch:=expected.fence_epoch;
  SELECT i.* INTO src FROM public.crm_interactions i WHERE i.id::text=job.aggregate_id;
  IF NOT FOUND OR (job.target_system='suitecrm' AND job.aggregate_type='crm_interactions' AND job.operation='upsert_record'
    AND job.status='dead' AND job.attempts=8 AND job.last_error IS NOT NULL AND job.processed_at IS NOT NULL
    AND job.locked_at IS NULL AND job.lock_token IS NULL
    AND job.payload->>'entity'='interactions' AND job.payload->>'localId'=src.id::text
    AND job.payload->>'pipelineId'=src.pipeline_id::text AND job.payload->>'suiteCrmId'=src.suitecrm_id
    AND job.payload->>'suiteCrmModule'='Emails' AND job.payload->>'previousSuiteCrmModule' IS NULL
    AND job.payload#>>'{attributes,global_id_c}'=src.reference_code AND src.suitecrm_module='Emails'
    AND src.suitecrm_synced_at IS NULL AND src.sync_status='failed'
    AND job.idempotency_key='crm:interactions:v4:'||src.id::text||':Emails:'||src.source_hash
    AND NOT (src.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
    AND COALESCE(lower(src.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND expected.source_hash=encode(public.digest(to_jsonb(src)::text,'sha256'),'hex')) IS NOT TRUE THEN
   RAISE EXCEPTION 'Fixture: not exact terminal legacy Email' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w
    WHERE w.work_kind='outbox' AND w.context->>'outboxId'=job.id::text)
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=src.id)
   OR EXISTS(SELECT 1 FROM public.crm_interactions i WHERE i.id<>src.id AND
     (lower(i.suitecrm_id)=lower(src.suitecrm_id) OR lower(i.reference_code)=lower(src.reference_code)))
   OR EXISTS(SELECT 1 FROM public.sync_outbox other WHERE other.id<>job.id AND other.target_system='suitecrm'
      AND ((other.aggregate_type='crm_interactions' AND other.aggregate_id=src.id::text)
        OR (other.payload->>'entity'='interactions' AND
         (other.payload->>'localId'=src.id::text OR lower(other.payload->>'suiteCrmId')=lower(src.suitecrm_id)
          OR lower(other.payload#>>'{attributes,global_id_c}')=lower(src.reference_code))))) THEN
   RAISE EXCEPTION 'Fixture: another delivery or receipt exists' USING ERRCODE='55000';
  END IF;
  originals:=array_append(originals,to_jsonb(job));
 END LOOP;
 IF cardinality(originals)<>cardinality(exact_ids) THEN
  RAISE EXCEPTION 'Fixture: missing exact queue rows' USING ERRCODE='55000';
 END IF;
 -- RESTRICT foreign keys on the production schema still apply. Only the
 -- source/queue control lock holder can get between delete and retention.
 FOREACH kept IN ARRAY originals LOOP
  DELETE FROM public.sync_outbox WHERE id=(kept->>'id')::uuid AND to_jsonb(sync_outbox)=kept;
  GET DIAGNOSTICS matched=ROW_COUNT;
  IF matched<>1 THEN RAISE EXCEPTION 'Fixture: queue CAS changed' USING ERRCODE='55000'; END IF;
  INSERT INTO crm_retirement_fixture.retained
   (outbox_id,batch,generation,local_id,native_id,global_id,original,original_hash,source_hash,fence_epoch,historical_provider_outcome)
  SELECT r.outbox_id,r.batch,r.generation,kept->>'aggregate_id',kept#>>'{payload,suiteCrmId}',
   kept#>>'{payload,attributes,global_id_c}',kept,r.outbox_hash,r.source_hash,r.fence_epoch,'unknown'
  FROM crm_retirement_fixture.review r WHERE r.outbox_id=(kept->>'id')::uuid AND r.batch=batch_id;
  retired:=retired+1;
 END LOOP;
 -- Consumed only in the same transaction as every exact archived original.
 consume_time:=clock_timestamp();
 IF verified.valid_until<=consume_time THEN
  RAISE EXCEPTION 'Fixture: verified approval expired before consumption' USING ERRCODE='55000';
 END IF;
 INSERT INTO crm_retirement_fixture.consumed(batch,manifest_hash,approval_hash,archived_rows,consumed_at)
 VALUES(verified.batch,verified.manifest_hash,verified.approval_hash,retired,consume_time);
 RETURN retired;
END $$;
REVOKE ALL ON FUNCTION crm_retirement_fixture.retire(uuid,uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_retirement_fixture.retire(uuid,uuid[],text) TO crm_fixture_retirement_controller;
CREATE FUNCTION crm_retirement_fixture.resolve(batch_id uuid, expected_manifest_hash text, expected_approval_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT COALESCE((
  SELECT jsonb_build_object('state','committed','operationId',b.batch,'manifestDigest',b.manifest_hash,
   'approvalDigest',b.approval_hash,'rows',b.expected_rows,'historicalProviderOutcome','unknown')
  FROM crm_retirement_fixture.verified_batch b JOIN crm_retirement_fixture.consumed c ON c.batch=b.batch
  WHERE b.batch=batch_id AND b.manifest_hash=expected_manifest_hash AND b.approval_hash=expected_approval_hash
   AND c.manifest_hash=b.manifest_hash AND c.approval_hash=b.approval_hash AND c.archived_rows=b.expected_rows
   AND c.consumed_at < b.valid_until
   AND b.expected_rows=(SELECT count(*) FROM crm_retirement_fixture.review r WHERE r.batch=b.batch)
   AND b.expected_rows=(SELECT count(*) FROM crm_retirement_fixture.retained r WHERE r.batch=b.batch)
   AND b.expected_rows=(SELECT count(*) FROM crm_retirement_fixture.retained r JOIN crm_retirement_fixture.review v
     ON v.batch=r.batch AND v.outbox_id=r.outbox_id AND v.outbox_hash=r.original_hash AND v.source_hash=r.source_hash
       AND v.generation=r.generation AND v.fence_epoch=r.fence_epoch
     WHERE r.batch=b.batch AND r.generation=b.generation AND r.fence_epoch=b.fence_epoch
       AND NOT EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=r.outbox_id))
 ),'{"state":"unknown"}'::jsonb)
$$;
REVOKE ALL ON FUNCTION crm_retirement_fixture.resolve(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_retirement_fixture.resolve(uuid,text,text) TO crm_fixture_retirement_resolver;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.sync_outbox TO crm_fixture_ordinary_writer;
GRANT SELECT ON public.crm_native_email_publication_control TO crm_fixture_ordinary_writer;
GRANT UPDATE(updated_at) ON public.crm_native_email_publication_control TO crm_fixture_ordinary_writer;
