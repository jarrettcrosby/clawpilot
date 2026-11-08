-- Private, inert evidence/hold ledger. This migration grants no access,
-- changes no existing row, does not exempt any initial-enrollment writer,
-- and cannot release or publish a held Email. The separate attestor must
-- verify both signatures, native absence and the independent live fence.
CREATE SCHEMA crm_legacy_email_terminal_hold;
REVOKE ALL ON SCHEMA crm_legacy_email_terminal_hold FROM PUBLIC;

CREATE TABLE crm_legacy_email_terminal_hold.verified_batch (
 batch uuid PRIMARY KEY,
 manifest jsonb NOT NULL,
 manifest_canonical text NOT NULL CHECK(octet_length(manifest_canonical) BETWEEN 1 AND 65536),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
 fence_hash text NOT NULL CHECK(fence_hash ~ '^[0-9a-f]{64}$'),
 approval_hash text NOT NULL UNIQUE CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),
 attestor name NOT NULL DEFAULT current_user,
 CHECK((manifest_canonical::jsonb=manifest AND encode(public.digest(manifest_canonical,'sha256'),'hex')=manifest_hash
   AND manifest->'version'='1'::jsonb AND manifest->>'operationId'=batch::text
   AND manifest->>'action'='hold_exact_legacy_terminal_rows_in_place'
   AND manifest->>'publicationDisposition'='hold_without_publication'
   AND manifest->>'historicalProviderOutcome'='unknown') IS TRUE)
);

CREATE TABLE crm_legacy_email_terminal_hold.held (
 outbox_id uuid PRIMARY KEY,
 batch uuid NOT NULL REFERENCES crm_legacy_email_terminal_hold.verified_batch(batch) ON DELETE RESTRICT,
 local_id uuid NOT NULL UNIQUE,
 pipeline_id uuid NOT NULL,
 workspace_id uuid NOT NULL,
 native_id text NOT NULL UNIQUE,
 global_id text NOT NULL UNIQUE,
 provider_alias text,
 source_key text NOT NULL,
 key_hash text NOT NULL UNIQUE,
 row_fingerprint text NOT NULL,
 original jsonb NOT NULL,
 CHECK((jsonb_typeof(original)='object' AND octet_length(original::text)<=2000000
  AND original->>'id'=outbox_id::text AND original->>'status'='dead'
  AND encode(public.digest(original::text,'sha256'),'hex')=row_fingerprint) IS TRUE),
 UNIQUE(pipeline_id,provider_alias), UNIQUE(pipeline_id,source_key)
);
CREATE INDEX crm_legacy_email_terminal_held_batch ON crm_legacy_email_terminal_hold.held(batch);

CREATE TABLE crm_legacy_email_terminal_hold.consumed (
 batch uuid PRIMARY KEY REFERENCES crm_legacy_email_terminal_hold.verified_batch(batch) ON DELETE RESTRICT,
 held_rows integer NOT NULL CHECK(held_rows BETWEEN 1 AND 25),
 consumed_at timestamptz NOT NULL CHECK(isfinite(consumed_at)),
 receipt_hash text NOT NULL UNIQUE CHECK(receipt_hash ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON ALL TABLES IN SCHEMA crm_legacy_email_terminal_hold FROM PUBLIC;

CREATE FUNCTION crm_legacy_email_terminal_hold.bind_attestor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_user<>session_user OR NEW.attestor<>session_user THEN
  RAISE EXCEPTION 'Terminal Email hold requires a direct attestor login' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_terminal_hold_attestor BEFORE INSERT ON crm_legacy_email_terminal_hold.verified_batch
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_terminal_hold.bind_attestor();
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['verified_batch','held','consumed'] LOOP
  EXECUTE format('CREATE TRIGGER crm_terminal_hold_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_terminal_hold.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
  EXECUTE format('CREATE TRIGGER crm_terminal_hold_no_truncate BEFORE TRUNCATE ON crm_legacy_email_terminal_hold.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
 END LOOP;
END $$;

CREATE FUNCTION crm_legacy_email_terminal_hold.gate_fingerprint() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(public.digest(to_jsonb(c)::text,'sha256'),'hex')
 FROM public.crm_native_email_publication_control c WHERE c.singleton
$$;

-- These bind the exact app associations and normalized provider identity at
-- hold installation. A later publication must freshly verify native links,
-- owner mailbox and the approved audience; neither hash authorizes that.
CREATE FUNCTION crm_legacy_email_terminal_hold.relationship_fingerprint(p_local uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(public.digest(jsonb_build_object('pipelineId',i.pipeline_id,'organizationId',i.organization_id,
  'contactId',i.contact_id,'organizations',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.organization_id)
   FROM public.crm_interaction_organizations l WHERE l.pipeline_id=i.pipeline_id AND l.interaction_id=i.id),'[]'::jsonb),
  'contacts',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.contact_id)
   FROM public.crm_interaction_contacts l WHERE l.pipeline_id=i.pipeline_id AND l.interaction_id=i.id),'[]'::jsonb)
  )::text,'sha256'),'hex') FROM public.crm_interactions i WHERE i.id=p_local
$$;

CREATE FUNCTION crm_legacy_email_terminal_hold.provider_identity_fingerprint(p_local uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(public.digest(jsonb_build_object('pipelineId',i.pipeline_id,'sourceKey',i.source_key,
   'providerAlias',NULLIF(lower(btrim(i.provider_message_id)),''))::text,'sha256'),'hex')
 FROM public.crm_interactions i WHERE i.id=p_local
$$;

CREATE FUNCTION crm_legacy_email_terminal_hold.receipt_fingerprint(batch_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(public.digest(jsonb_build_object('version',1,'purpose','clawpilot-legacy-email-terminal-hold-receipt-v1',
  'operationId',b.batch,'manifestDigest',b.manifest_hash,'fenceDigest',b.fence_hash,'approvalDigest',b.approval_hash,
  'originals',(SELECT jsonb_agg(jsonb_build_object('outboxId',h.outbox_id,'rowFingerprint',h.row_fingerprint)
   ORDER BY h.outbox_id) FROM crm_legacy_email_terminal_hold.held h WHERE h.batch=b.batch))::text,'sha256'),'hex')
 FROM crm_legacy_email_terminal_hold.verified_batch b WHERE b.batch=batch_id
$$;

CREATE FUNCTION crm_legacy_email_terminal_hold.hold(batch_id uuid, exact_ids uuid[], expected_approval_hash text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; b crm_legacy_email_terminal_hold.verified_batch;
 m jsonb; reviewed jsonb; job public.sync_outbox; src public.crm_interactions; message_alias text;
 n integer:=0; held_at timestamptz; keys text[]:=ARRAY['outboxId','localId','pipelineId','workspaceId','nativeId','globalId',
  'attempts','rowFingerprint','sourceFingerprint','payloadFingerprint','keyFingerprint','relationshipFingerprint','providerIdentityFingerprint'];
BEGIN
 -- Every command after acquiring the fence must see changes committed by a
 -- preceding writer, including relationship rows outside the source snapshot.
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Terminal Email hold requires a direct controller login in a fresh read-committed transaction' USING ERRCODE='55000';
 END IF;
 IF batch_id IS NULL OR exact_ids IS NULL OR expected_approval_hash IS NULL OR array_ndims(exact_ids)<>1
  OR cardinality(exact_ids) NOT BETWEEN 1 AND 25
  OR cardinality(exact_ids)<>(SELECT count(DISTINCT x) FROM unnest(exact_ids) x) THEN
  RAISE EXCEPTION 'Terminal Email hold requires an exact bounded set' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF c.enabled OR c.active_initial_enrollment_id IS NOT NULL OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL THEN
  RAISE EXCEPTION 'Terminal Email hold requires disabled idle native control' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Terminal Email hold serialization missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO b FROM crm_legacy_email_terminal_hold.verified_batch v WHERE v.batch=batch_id FOR UPDATE;
 IF NOT FOUND OR b.attestor=session_user OR b.valid_until<=clock_timestamp()
  OR b.valid_until>clock_timestamp()+interval '120 seconds' OR b.approval_hash<>expected_approval_hash
  OR EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.consumed x WHERE x.batch=batch_id) THEN
  RAISE EXCEPTION 'Terminal Email hold requires fresh unconsumed independent approval' USING ERRCODE='55000';
 END IF;
 m:=b.manifest;
 IF (m->>'appGeneration'=c.generation::text AND m->>'gateFingerprint'=crm_legacy_email_terminal_hold.gate_fingerprint()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Terminal Email hold authority generation or gate changed' USING ERRCODE='55000';
 END IF;
 IF (m->>'appSourceFingerprint'=encode(public.digest(public.clawpilot_crm_native_initial_source_snapshot()::text,'sha256'),'hex')
   AND jsonb_typeof(m->'rows')='array') IS NOT TRUE THEN
  RAISE EXCEPTION 'Terminal Email hold source snapshot or reviewed shape changed' USING ERRCODE='55000';
 END IF;
 IF jsonb_array_length(m->'rows')<>cardinality(exact_ids)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(m->'rows') r WHERE NOT public.clawpilot_crm_native_initial_shape(r,keys)
   OR NOT COALESCE(r->>'outboxId'=ANY(exact_ids::text[]),false))
  OR (SELECT count(DISTINCT r->>'outboxId') FROM jsonb_array_elements(m->'rows') r)<>cardinality(exact_ids) THEN
  RAISE EXCEPTION 'Terminal Email hold review set differs' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations w ON w.id=a.root_workspace_id
  JOIN public.app_users u ON u.email=a.owner_email JOIN public.app_user_organization_memberships x ON x.user_email=u.email AND x.organization_id=w.id
  WHERE a.id::text=m->>'operatorAccountId' AND w.id::text=m->>'rootWorkspaceId' AND a.owner_email=m->>'actorEmail' AND a.enabled
   AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo AND u.status='active' AND u.role='owner'
   AND x.status='active' AND x.trashed_at IS NULL AND x.role='owner') THEN
  RAISE EXCEPTION 'Terminal Email hold requires the exact current operator root owner' USING ERRCODE='55000';
 END IF;
 -- Existing writers take control and the shared serial before these row locks.
 PERFORM i.id FROM public.crm_interactions i WHERE i.id::text IN (
  SELECT r->>'localId' FROM jsonb_array_elements(m->'rows') r) ORDER BY i.id FOR UPDATE OF i;
 FOR job IN SELECT o.* FROM public.sync_outbox o WHERE o.id=ANY(exact_ids) ORDER BY o.id FOR UPDATE LOOP
  SELECT r INTO STRICT reviewed FROM jsonb_array_elements(m->'rows') r WHERE r->>'outboxId'=job.id::text;
  SELECT i.* INTO src FROM public.crm_interactions i WHERE i.id::text=reviewed->>'localId';
  IF NOT FOUND OR (job.target_system='suitecrm' AND job.aggregate_type='crm_interactions' AND job.operation='upsert_record'
   AND job.status='dead' AND job.attempts=8 AND reviewed->'attempts'='8'::jsonb
   AND job.last_error='native_projection_proof_unavailable' AND job.processed_at IS NOT NULL AND job.locked_at IS NULL AND job.lock_token IS NULL
   AND job.aggregate_id=src.id::text AND job.payload->>'entity'='interactions' AND job.payload->>'localId'=src.id::text
   AND job.payload->>'pipelineId'=src.pipeline_id::text AND job.payload->>'suiteCrmId'=src.suitecrm_id
   AND job.payload->>'suiteCrmModule'='Emails' AND job.payload->>'previousSuiteCrmModule' IS NULL
   AND job.payload#>>'{attributes,global_id_c}'=src.reference_code AND src.suitecrm_module='Emails'
   AND src.suitecrm_synced_at IS NULL AND src.sync_status='failed' AND lower(src.source_key) NOT LIKE 'suitecrm%'
   AND job.idempotency_key='crm:interactions:v4:'||src.id::text||':Emails:'||src.source_hash
   AND jsonb_typeof(src.metadata)='object' AND NOT (src.metadata ?| ARRAY['suiteCrmEmailProjection','suiteCrmEmailPublication'])
   AND COALESCE(lower(src.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
   AND src.pipeline_id::text=reviewed->>'pipelineId' AND src.suitecrm_id=reviewed->>'nativeId' AND src.reference_code=reviewed->>'globalId'
   AND src.suitecrm_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' AND src.reference_code ~ '^gi([0-9]{7}|[0-9a-v]{12})$'
   AND reviewed->>'rowFingerprint'=encode(public.digest(to_jsonb(job)::text,'sha256'),'hex')
   AND reviewed->>'sourceFingerprint'=encode(public.digest(to_jsonb(src)::text,'sha256'),'hex')
   AND reviewed->>'payloadFingerprint'=encode(public.digest(job.payload::text,'sha256'),'hex')
   AND reviewed->>'keyFingerprint'=encode(public.digest(job.idempotency_key,'sha256'),'hex')
   AND reviewed->>'relationshipFingerprint'=crm_legacy_email_terminal_hold.relationship_fingerprint(src.id)
   AND reviewed->>'providerIdentityFingerprint'=crm_legacy_email_terminal_hold.provider_identity_fingerprint(src.id)
   AND EXISTS(SELECT 1 FROM public.pipeline_spaces p JOIN public.workspace_organizations w ON w.id=p.workspace_organization_id
    JOIN public.crm_operator_workspace_bindings x ON x.workspace_id=w.id
    WHERE p.id=src.pipeline_id AND w.id::text=reviewed->>'workspaceId' AND NOT w.is_demo AND NOT p.reference_access_disabled
     AND x.operator_account_id::text=m->>'operatorAccountId' AND x.owner_email=m->>'actorEmail' AND x.enabled)) IS NOT TRUE THEN
   RAISE EXCEPTION 'Terminal Email hold exact job, source or relationship evidence changed' USING ERRCODE='55000';
  END IF;
  message_alias:=NULLIF(lower(btrim(src.provider_message_id)),'');
  IF EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w WHERE w.work_kind='outbox'
    AND (w.context->>'outboxId'=job.id::text OR w.context->>'idempotencyKey'=job.idempotency_key))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=src.id
     OR lower(a.native_id)=src.suitecrm_id OR lower(a.global_id)=src.reference_code)
   OR EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.outbox_id=job.id OR h.retired_outbox_id=job.id
     OR h.local_id=src.id OR h.native_id=src.suitecrm_id OR h.global_id=src.reference_code)
   OR EXISTS(SELECT 1 FROM crm_legacy_email_retirement.retained h WHERE h.outbox_id=job.id OR h.local_id=src.id
     OR h.native_id=src.suitecrm_id OR h.global_id=src.reference_code)
   OR EXISTS(SELECT 1 FROM public.crm_interactions i WHERE i.id<>src.id AND (lower(i.suitecrm_id)=src.suitecrm_id
     OR lower(i.reference_code)=src.reference_code OR (i.pipeline_id=src.pipeline_id
      AND (lower(btrim(i.provider_message_id))=message_alias OR i.source_key=src.source_key))))
   OR EXISTS(SELECT 1 FROM public.sync_outbox other WHERE other.id<>job.id AND other.target_system='suitecrm'
     AND ((other.aggregate_type='crm_interactions' AND lower(other.aggregate_id)=src.id::text)
      OR lower(other.payload->>'localId')=src.id::text OR lower(other.payload->>'suiteCrmId')=src.suitecrm_id
      OR lower(other.payload#>>'{attributes,global_id_c}')=src.reference_code OR other.idempotency_key=job.idempotency_key)) THEN
   RAISE EXCEPTION 'Terminal Email hold found competing identity or delivery evidence' USING ERRCODE='55000';
  END IF;
  INSERT INTO crm_legacy_email_terminal_hold.held(outbox_id,batch,local_id,pipeline_id,workspace_id,native_id,global_id,
   provider_alias,source_key,key_hash,row_fingerprint,original)
  VALUES(job.id,batch_id,src.id,src.pipeline_id,(reviewed->>'workspaceId')::uuid,src.suitecrm_id,src.reference_code,
   message_alias,src.source_key,reviewed->>'keyFingerprint',reviewed->>'rowFingerprint',to_jsonb(job));
  n:=n+1;
 END LOOP;
 held_at:=clock_timestamp();
 IF n<>cardinality(exact_ids) OR b.valid_until<=held_at THEN
  RAISE EXCEPTION 'Terminal Email hold set missing or expired before consumption' USING ERRCODE='55000';
 END IF;
 INSERT INTO crm_legacy_email_terminal_hold.consumed(batch,held_rows,consumed_at,receipt_hash)
 VALUES(batch_id,n,held_at,crm_legacy_email_terminal_hold.receipt_fingerprint(batch_id));
 RETURN n;
END $$;

CREATE FUNCTION crm_legacy_email_terminal_hold.resolve(batch_id uuid, expected_manifest_hash text, expected_approval_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE((SELECT jsonb_build_object('state','committed','operationId',b.batch,'manifestDigest',b.manifest_hash,
  'approvalDigest',b.approval_hash,'rows',c.held_rows,'receiptHash',c.receipt_hash,'historicalProviderOutcome','unknown')
  FROM crm_legacy_email_terminal_hold.verified_batch b JOIN crm_legacy_email_terminal_hold.consumed c USING(batch)
  WHERE b.batch=batch_id AND b.manifest_hash=expected_manifest_hash AND b.approval_hash=expected_approval_hash
   AND c.consumed_at<b.valid_until AND c.receipt_hash=crm_legacy_email_terminal_hold.receipt_fingerprint(b.batch)
   AND c.held_rows=jsonb_array_length(b.manifest->'rows')
   AND c.held_rows=(SELECT count(*) FROM crm_legacy_email_terminal_hold.held h JOIN public.sync_outbox o ON o.id=h.outbox_id
    WHERE h.batch=b.batch AND to_jsonb(o)=h.original)),jsonb_build_object('state','unknown'))
$$;

-- Holds persist regardless of expiry or activation. Neither the ordinary
-- worker nor direct DML may reset, delete, or replace a held identity.
CREATE FUNCTION crm_legacy_email_terminal_hold.protect_held() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE rows jsonb[]:=ARRAY[]::jsonb[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held LIMIT 1) THEN
  IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Terminal Email hold prevents truncation' USING ERRCODE='55000'; END IF;
 IF TG_OP<>'INSERT' THEN rows:=array_append(rows,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN rows:=array_append(rows,to_jsonb(NEW)); END IF;
 IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME
  WHEN 'sync_outbox' THEN h.outbox_id::text=item->>'id' OR (item->>'target_system'='suitecrm' AND
   ((item->>'aggregate_type'='crm_interactions' AND h.local_id::text=lower(item->>'aggregate_id'))
     OR h.local_id::text=lower(item#>>'{payload,localId}') OR h.native_id=lower(item#>>'{payload,suiteCrmId}')
     OR h.global_id=lower(item#>>'{payload,attributes,global_id_c}')
     OR h.key_hash=encode(public.digest(item->>'idempotency_key','sha256'),'hex')))
  WHEN 'crm_interactions' THEN h.local_id::text=item->>'id' OR h.native_id=lower(item->>'suitecrm_id')
   OR h.global_id=lower(item->>'reference_code') OR (h.pipeline_id::text=item->>'pipeline_id'
    AND (h.provider_alias=lower(btrim(item->>'provider_message_id')) OR h.source_key=item->>'source_key'))
  WHEN 'crm_native_email_publication_admissions' THEN h.local_id::text=item->>'local_id'
   OR h.native_id=lower(item->>'native_id') OR h.global_id=lower(item->>'global_id')
  WHEN 'crm_native_email_publication_work' THEN item->>'work_kind'='outbox'
   AND (h.outbox_id::text=item#>>'{context,outboxId}' OR h.key_hash=encode(public.digest(item#>>'{context,idempotencyKey}','sha256'),'hex'))
  WHEN 'crm_interaction_contacts' THEN h.local_id::text=item->>'interaction_id'
  WHEN 'crm_interaction_organizations' THEN h.local_id::text=item->>'interaction_id'
  ELSE false END) THEN
  RAISE EXCEPTION 'Terminal Email hold blocks an unapproved identity change' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sync_outbox','crm_interactions','crm_native_email_publication_admissions',
   'crm_native_email_publication_work','crm_interaction_contacts','crm_interaction_organizations'] LOOP
  EXECUTE format('CREATE TRIGGER crm_terminal_email_held BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_terminal_hold.protect_held()',t);
  EXECUTE format('CREATE TRIGGER crm_zzzz_terminal_email_held_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_terminal_hold.protect_held()',t);
  IF t IN ('crm_interaction_contacts','crm_interaction_organizations') THEN
   EXECUTE format('CREATE TRIGGER crm_zz_legacy_email_terminal_hold_serial BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.serialize()',t);
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_legacy_email_terminal_hold FROM PUBLIC;
