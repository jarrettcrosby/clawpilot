-- One private, separately attested held-job stage. No provider calls, new
-- grants, admission, release, or settlement are installed by this migration.
-- The attestor must independently verify the signed scope and the live fence.
CREATE TABLE crm_legacy_email_terminal_hold.verified_recovery (
 approval_hash text PRIMARY KEY CHECK(approval_hash ~ '^[0-9a-f]{64}$'),
 outbox_id uuid NOT NULL REFERENCES crm_legacy_email_terminal_hold.held(outbox_id) ON DELETE RESTRICT,
 proof jsonb NOT NULL,
 proof_canonical text NOT NULL CHECK(octet_length(proof_canonical) BETWEEN 1 AND 8192),
 proof_hash text NOT NULL CHECK(proof_hash ~ '^[0-9a-f]{64}$'),
 intent_hash text NOT NULL CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
 valid_until timestamptz NOT NULL CHECK(isfinite(valid_until)),
 attestor name NOT NULL DEFAULT current_user,
 CHECK((proof_canonical::jsonb=proof AND encode(public.digest(proof_canonical,'sha256'),'hex')=proof_hash
  AND proof->'version'='1'::jsonb AND proof->>'purpose'='clawpilot-private-legacy-held-email-recovery-v1'
  AND proof->>'outboxId'=outbox_id::text) IS TRUE)
);
CREATE INDEX crm_legacy_held_email_verified_recovery_outbox ON crm_legacy_email_terminal_hold.verified_recovery(outbox_id);
CREATE TRIGGER crm_held_recovery_direct_attestor BEFORE INSERT ON crm_legacy_email_terminal_hold.verified_recovery
 FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_terminal_hold.bind_attestor();

CREATE TABLE crm_legacy_email_terminal_hold.staged (
 outbox_id uuid PRIMARY KEY REFERENCES crm_legacy_email_terminal_hold.held(outbox_id) ON DELETE RESTRICT,
 approval_hash text NOT NULL UNIQUE REFERENCES crm_legacy_email_terminal_hold.verified_recovery(approval_hash) ON DELETE RESTRICT,
 intent_hash text NOT NULL UNIQUE CHECK(intent_hash ~ '^[0-9a-f]{64}$'),
 claim_fingerprint text NOT NULL CHECK(claim_fingerprint ~ '^[0-9a-f]{64}$'),
 staged_xid xid8 NOT NULL,
 staged_at timestamptz NOT NULL CHECK(isfinite(staged_at)),
 receipt_hash text NOT NULL UNIQUE CHECK(receipt_hash ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON crm_legacy_email_terminal_hold.verified_recovery,crm_legacy_email_terminal_hold.staged FROM PUBLIC;
DO $$DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['verified_recovery','staged'] LOOP
  EXECUTE format('CREATE TRIGGER crm_held_recovery_immutable BEFORE UPDATE OR DELETE ON crm_legacy_email_terminal_hold.%I FOR EACH ROW EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
  EXECUTE format('CREATE TRIGGER crm_held_recovery_no_truncate BEFORE TRUNCATE ON crm_legacy_email_terminal_hold.%I FOR EACH STATEMENT EXECUTE FUNCTION crm_legacy_email_retirement.immutable_evidence()',t);
 END LOOP;
END $$;

-- The guard recognizes only this exact stage transaction and its full
-- pre/postimages. A staged row never gives subsequent callers a bypass.
CREATE FUNCTION crm_legacy_email_terminal_hold.stage_update_allowed(before_row jsonb,after_row jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.staged s
  JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  WHERE s.outbox_id::text=before_row->>'id' AND s.outbox_id::text=after_row->>'id'
   AND s.staged_xid=pg_current_xact_id_if_assigned() AND h.original=before_row
   AND encode(public.digest(after_row::text,'sha256'),'hex')=s.claim_fingerprint)
$$;

-- Pin and replace only the guard's one entry point; the rest still rejects
-- all ordinary updates, duplicate aliases, admissions and work inserts.
DO $held_stage$
DECLARE identity regprocedure:='crm_legacy_email_terminal_hold.protect_held()'::regprocedure;
 expected_body_hash text:='a4c3e466236272646f7b7afd06002eb71d09093f21f9f625a7b2c2da0b108ab8';
 body text; definition text; updated_definition text;
 old_entry text:=$before$ IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$before$;
 new_entry text:=$after$ IF TG_TABLE_NAME='sync_outbox' AND TG_OP='UPDATE'
  AND crm_legacy_email_terminal_hold.stage_update_allowed(rows[1],rows[2]) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.held h CROSS JOIN unnest(rows) AS v(item) WHERE CASE TG_TABLE_NAME$after$;
BEGIN
 SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity;
 IF body IS NULL OR encode(public.digest(body,'sha256'),'hex')<>expected_body_hash
  OR length(body)-length(replace(body,old_entry,''))<>length(old_entry) THEN
  RAISE EXCEPTION 'Held Email stage guard preimage changed' USING ERRCODE='55000';
 END IF;
 definition:=pg_catalog.pg_get_functiondef(identity);
 updated_definition:=replace(definition,old_entry,new_entry);
 IF definition=updated_definition THEN RAISE EXCEPTION 'Held Email stage guard was not updated' USING ERRCODE='55000'; END IF;
 EXECUTE updated_definition;
 SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity;
 IF encode(public.digest(replace(body,new_entry,old_entry),'sha256'),'hex')<>expected_body_hash THEN
  RAISE EXCEPTION 'Held Email stage changed unrelated protections' USING ERRCODE='55000';
 END IF;
END $held_stage$;

CREATE FUNCTION crm_legacy_email_terminal_hold.resolve_recovery(p_outbox uuid,p_intent text,p_approval text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT COALESCE((SELECT jsonb_build_object('state','staged','outboxId',s.outbox_id,'holdBatchId',h.batch,
  'intentHash',s.intent_hash,'approvalHash',s.approval_hash,'receiptHash',s.receipt_hash)
  FROM crm_legacy_email_terminal_hold.staged s JOIN crm_legacy_email_terminal_hold.held h USING(outbox_id)
  JOIN crm_legacy_email_terminal_hold.verified_recovery r ON r.approval_hash=s.approval_hash AND r.outbox_id=s.outbox_id
  JOIN public.sync_outbox o ON o.id=s.outbox_id
  WHERE s.outbox_id=p_outbox AND s.intent_hash=p_intent AND s.approval_hash=p_approval AND r.intent_hash=p_intent
   AND s.staged_at<r.valid_until AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=s.claim_fingerprint),
  jsonb_build_object('state','unknown'))
$$;

CREATE FUNCTION crm_legacy_email_terminal_hold.stage_recovery(p_outbox uuid,p_approval text,p_staged_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
DECLARE c public.crm_native_email_publication_control; review crm_legacy_email_terminal_hold.verified_recovery;
 h crm_legacy_email_terminal_hold.held; o public.sync_outbox; i public.crm_interactions;
 policy_row public.crm_native_email_capability_policies; proof jsonb; old_projection jsonb;
 audience jsonb; actual_accounts jsonb; actual_contacts jsonb; actual_contact_accounts jsonb;
 primary_native text; links_ok boolean; stage_time timestamptz; claim_hash text; actual_hash text; receipt text;
 hold_receipt text; hold_scope jsonb; now_second bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('role')<>'none'
  OR p_outbox IS NULL OR (p_approval ~ '^[0-9a-f]{64}$') IS NOT TRUE
  OR jsonb_typeof(p_staged_payload) IS DISTINCT FROM 'object' OR octet_length(p_staged_payload::text)>1800000 THEN
  RAISE EXCEPTION 'Held Email stage requires a direct controller and bounded exact input' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF NOT c.enabled OR c.verified_generation IS DISTINCT FROM c.generation OR c.activation_receipt_hash IS NULL
  OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR c.active_initial_enrollment_id IS NOT NULL THEN
  RAISE EXCEPTION 'Held Email stage requires idle verified authority' USING ERRCODE='55000';
 END IF;
 UPDATE crm_legacy_email_retirement.serial SET epoch=epoch+1 WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'Held Email stage serialization is missing' USING ERRCODE='55000'; END IF;
 SELECT * INTO review FROM crm_legacy_email_terminal_hold.verified_recovery r
  WHERE r.outbox_id=p_outbox AND r.approval_hash=p_approval FOR UPDATE;
 IF NOT FOUND OR review.attestor=session_user OR review.valid_until<=clock_timestamp()
  OR review.valid_until>clock_timestamp()+interval '120 seconds'
  OR EXISTS(SELECT 1 FROM crm_legacy_email_terminal_hold.staged s WHERE s.outbox_id=p_outbox) THEN
  RAISE EXCEPTION 'Held Email stage requires fresh independent approval; inspect an existing stage instead of retrying' USING ERRCODE='55000';
 END IF;
 proof:=review.proof;
 IF (proof->>'issuedAt' ~ '^[1-9][0-9]{0,15}$' AND proof->>'expiresAt' ~ '^[1-9][0-9]{0,15}$'
  AND proof->>'lockToken' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  AND proof->>'generation'=c.generation::text AND proof->>'activationReceiptHash'=c.activation_receipt_hash
  AND proof->>'nativeOperationId' ~ '^[0-9a-f]{64}$' AND proof->>'requestFingerprint' ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email stage authority or proof shape changed' USING ERRCODE='55000';
 END IF;
 now_second:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF (proof->>'issuedAt')::bigint>now_second OR (proof->>'expiresAt')::bigint<=now_second
  OR (proof->>'expiresAt')::bigint-(proof->>'issuedAt')::bigint NOT BETWEEN 1 AND 120
  OR to_timestamp((proof->>'expiresAt')::bigint)<>review.valid_until THEN
  RAISE EXCEPTION 'Held Email stage signed time window changed' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT h FROM crm_legacy_email_terminal_hold.held WHERE outbox_id=p_outbox;
 SELECT settled.receipt_hash,b.manifest INTO hold_receipt,hold_scope
 FROM crm_legacy_email_terminal_hold.verified_batch b JOIN crm_legacy_email_terminal_hold.consumed settled USING(batch)
 WHERE b.batch=h.batch AND settled.consumed_at<b.valid_until
  AND settled.receipt_hash=crm_legacy_email_terminal_hold.receipt_fingerprint(b.batch)
  AND settled.held_rows=jsonb_array_length(b.manifest->'rows')
  AND settled.held_rows=(SELECT count(*) FROM crm_legacy_email_terminal_hold.held x WHERE x.batch=b.batch);
 IF (proof->>'holdReceiptHash'=hold_receipt AND proof->>'holdBatchId'=h.batch::text
  AND proof->>'nativeAuthorityInstanceId'=hold_scope#>>'{scope,nativeAuthorityInstanceId}'
  AND proof->>'localId'=h.local_id::text AND proof->>'pipelineId'=h.pipeline_id::text AND proof->>'workspaceId'=h.workspace_id::text
  AND proof->>'nativeId'=h.native_id AND proof->>'globalId'=h.global_id AND proof->>'originalFingerprint'=h.row_fingerprint) IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email stage scope is not the exact consumed hold' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations root ON root.id=a.root_workspace_id
  JOIN public.app_users u ON u.email=a.owner_email
  JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=root.id
  JOIN public.crm_operator_workspace_bindings b ON b.operator_account_id=a.id AND b.owner_email=a.owner_email
  JOIN public.workspace_organizations w ON w.id=b.workspace_id
  JOIN public.pipeline_spaces p ON p.workspace_organization_id=w.id
  WHERE a.id::text=hold_scope->>'operatorAccountId' AND a.owner_email=hold_scope->>'actorEmail'
   AND root.id::text=hold_scope->>'rootWorkspaceId' AND a.enabled AND b.enabled
   AND root.parent_id IS NULL AND root.organization_type='root' AND NOT root.is_demo
   AND u.status='active' AND u.role='owner' AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner'
   AND w.id=h.workspace_id AND p.id=h.pipeline_id AND NOT w.is_demo AND NOT p.reference_access_disabled) THEN
  RAISE EXCEPTION 'Held Email stage requires the exact current operator root and pipeline binding' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT i FROM public.crm_interactions WHERE id=h.local_id FOR UPDATE;
 SELECT * INTO STRICT o FROM public.sync_outbox WHERE id=p_outbox FOR UPDATE;
 IF (to_jsonb(o)=h.original AND o.status='dead' AND o.attempts=8 AND o.lock_token IS NULL AND o.locked_at IS NULL
  AND i.pipeline_id=h.pipeline_id AND i.suitecrm_id=h.native_id AND i.reference_code=h.global_id
  AND i.sync_status='failed' AND i.suitecrm_synced_at IS NULL
  AND proof->>'sourceFingerprint'=encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')
  AND proof->>'relationshipFingerprint'=crm_legacy_email_terminal_hold.relationship_fingerprint(i.id)
  AND proof->>'providerIdentityFingerprint'=crm_legacy_email_terminal_hold.provider_identity_fingerprint(i.id)) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a WHERE a.local_id=h.local_id
   OR lower(a.native_id)=h.native_id OR lower(a.global_id)=h.global_id)
  OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_work w WHERE w.work_kind='outbox'
   AND (w.context->>'outboxId'=p_outbox::text OR w.context->>'idempotencyKey'=o.idempotency_key)) THEN
  RAISE EXCEPTION 'Held Email stage source changed or has competing publication evidence' USING ERRCODE='55000';
 END IF;
 -- Re-read Account/Contact mappings. The hold protects association edges, but
 -- an Account's native ID or a Contact's owning Account can change separately.
 WITH selected_accounts AS (
  SELECT l.organization_id,l.is_primary FROM public.crm_interaction_organizations l
  WHERE l.interaction_id=i.id AND l.pipeline_id=h.pipeline_id
 ), accounts AS (
  SELECT s.organization_id,s.is_primary,org.suitecrm_id AS native_id,org.source_payload
  FROM selected_accounts s LEFT JOIN public.crm_organizations org ON org.id=s.organization_id AND org.pipeline_id=h.pipeline_id
 ), contacts AS (
  SELECT l.contact_id,person.suitecrm_id AS native_id,person.source_payload,a.native_id AS account_id
  FROM public.crm_interaction_contacts l LEFT JOIN public.crm_contacts person ON person.id=l.contact_id AND person.pipeline_id=h.pipeline_id
  LEFT JOIN accounts a ON a.organization_id=person.organization_id
  WHERE l.interaction_id=i.id AND l.pipeline_id=h.pipeline_id
 ) SELECT (SELECT native_id FROM accounts WHERE is_primary AND organization_id=i.organization_id),
   (SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM accounts),
   COALESCE((SELECT jsonb_agg(native_id ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb),
   COALESCE((SELECT jsonb_agg(jsonb_build_object('contactId',native_id,'accountId',account_id) ORDER BY native_id COLLATE "C") FROM contacts),'[]'::jsonb),
   ((SELECT count(*) FROM accounts WHERE is_primary)=1
    AND (i.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts WHERE contact_id=i.contact_id))
    AND (SELECT count(*)=count(DISTINCT native_id) FROM accounts)
    AND (SELECT count(*)=count(DISTINCT native_id) FROM contacts)
    AND NOT EXISTS(SELECT 1 FROM accounts WHERE (native_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
     OR COALESCE(lower(source_payload->>'archived'),'false') IN ('true','1','yes'))
    AND NOT EXISTS(SELECT 1 FROM contacts WHERE (native_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$') IS NOT TRUE OR account_id IS NULL
     OR COALESCE(lower(source_payload->>'archived'),'false') IN ('true','1','yes')))
 INTO primary_native,actual_accounts,actual_contacts,actual_contact_accounts,links_ok;
 old_projection:=o.payload->'emailProjection';
 IF (links_ok AND primary_native=proof->>'primaryAccountId' AND actual_accounts=proof->'accountIds'
   AND o.payload#>>'{attributes,parent_type}'='Accounts' AND o.payload#>>'{attributes,parent_id}'=primary_native
   AND old_projection->'version'='1'::jsonb AND old_projection->'accounts'=actual_accounts
   AND old_projection->'contacts'=actual_contacts AND old_projection->'contactAccounts'=actual_contact_accounts
   AND old_projection->'previousManaged'='{"accounts":[],"contacts":[]}'::jsonb) IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email stage approved Account or Contact placement changed' USING ERRCODE='55000';
 END IF;
 IF jsonb_typeof(o.payload->'relationships') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Held Email stage requires exact native relationship inputs' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(o.payload->'relationships') AS r(link)
   WHERE ((link->>'linkFieldName'='accounts' AND link->>'relatedModuleName'='Accounts')
    OR (link->>'linkFieldName'='contacts' AND link->>'relatedModuleName'='Contacts')) IS NOT TRUE)
  OR (SELECT COALESCE(jsonb_agg(link->>'relatedBeanId' ORDER BY (link->>'relatedBeanId') COLLATE "C"),'[]'::jsonb)
    FROM jsonb_array_elements(o.payload->'relationships') AS r(link) WHERE link->>'linkFieldName'='accounts') IS DISTINCT FROM actual_accounts
  OR (SELECT COALESCE(jsonb_agg(link->>'relatedBeanId' ORDER BY (link->>'relatedBeanId') COLLATE "C"),'[]'::jsonb)
    FROM jsonb_array_elements(o.payload->'relationships') AS r(link) WHERE link->>'linkFieldName'='contacts') IS DISTINCT FROM actual_contacts THEN
  RAISE EXCEPTION 'Held Email stage native relationship inputs differ from the reviewed placement' USING ERRCODE='55000';
 END IF;
 SELECT * INTO policy_row FROM public.crm_native_email_capability_policies WHERE pipeline_id=h.pipeline_id;
 IF (policy_row.generation=c.generation AND policy_row.policy->>'version'='2'
  AND policy_row.policy->>'pipelineId'=h.pipeline_id::text AND policy_row.policy->>'workspaceId'=h.workspace_id::text
  AND policy_row.policy->>'ownerSuiteCrmId'=o.payload#>>'{attributes,assigned_user_id}'
  AND policy_row.policy->>'audienceFingerprint' ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(policy_row.policy#>'{futureCreate,view}')='array') IS NOT TRUE THEN
  RAISE EXCEPTION 'Held Email stage reviewed audience changed' USING ERRCODE='55000';
 END IF;
 audience:=jsonb_build_object('policy','pipeline-internal','pipelineId',h.pipeline_id,'workspaceId',h.workspace_id,
  'ownerSuiteCrmId',policy_row.policy->>'ownerSuiteCrmId','allowedSuiteCrmUserIds',policy_row.policy#>'{futureCreate,view}',
  'fingerprint',policy_row.policy->>'audienceFingerprint');
 IF p_staged_payload IS DISTINCT FROM jsonb_set(o.payload,'{emailProjection,audience}',audience,true)
  OR proof->>'stagedPayloadFingerprint' IS DISTINCT FROM encode(public.digest(p_staged_payload::text,'sha256'),'hex') THEN
  RAISE EXCEPTION 'Held Email stage exact postimage changed' USING ERRCODE='55000';
 END IF;
 stage_time:=transaction_timestamp();
 o.payload:=p_staged_payload; o.status:='processing'; o.attempts:=1; o.last_error:=NULL; o.processed_at:=NULL;
 o.lock_token:=proof->>'lockToken'; o.locked_at:=stage_time; o.available_at:='infinity'::timestamptz; o.updated_at:=stage_time;
 claim_hash:=encode(public.digest(to_jsonb(o)::text,'sha256'),'hex');
 receipt:=encode(public.digest(jsonb_build_object('version',1,'purpose','clawpilot-held-email-stage-receipt-v1',
  'outboxId',p_outbox,'holdBatchId',h.batch,'holdReceiptHash',hold_receipt,'approvalHash',p_approval,
  'intentHash',review.intent_hash,'claimFingerprint',claim_hash)::text,'sha256'),'hex');
 INSERT INTO crm_legacy_email_terminal_hold.staged(outbox_id,approval_hash,intent_hash,claim_fingerprint,staged_xid,staged_at,receipt_hash)
 VALUES(p_outbox,p_approval,review.intent_hash,claim_hash,pg_current_xact_id(),stage_time,receipt);
 UPDATE public.sync_outbox x SET payload=o.payload,status=o.status,attempts=o.attempts,last_error=o.last_error,processed_at=o.processed_at,
  lock_token=o.lock_token,locked_at=o.locked_at,available_at=o.available_at,updated_at=o.updated_at
 WHERE x.id=p_outbox AND to_jsonb(x)=h.original
 RETURNING encode(public.digest(to_jsonb(x)::text,'sha256'),'hex') INTO actual_hash;
 IF actual_hash IS DISTINCT FROM claim_hash OR review.valid_until<=clock_timestamp() THEN
  RAISE EXCEPTION 'Held Email stage row changed or approval expired' USING ERRCODE='55000';
 END IF;
 RETURN crm_legacy_email_terminal_hold.resolve_recovery(p_outbox,review.intent_hash,p_approval);
END $$;
REVOKE ALL ON FUNCTION crm_legacy_email_terminal_hold.stage_update_allowed(jsonb,jsonb),
 crm_legacy_email_terminal_hold.resolve_recovery(uuid,text,text),crm_legacy_email_terminal_hold.stage_recovery(uuid,text,jsonb) FROM PUBLIC;
