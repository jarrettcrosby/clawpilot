-- Forward-only initial-enrollment replan lineage. No table, column, signer,
-- installation rewrite, renewal, activation or native noncommit claim.
-- SQL validates immutable retained facts; the trusted DAL separately verifies
-- RSA and the actual native installer independently verifies the root source.
CREATE FUNCTION clawpilot_crm_native_initial_lineage_digest(v jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE canonical text;
BEGIN
 IF NOT public.clawpilot_crm_native_initial_shape(v,ARRAY['version','purpose','rootOperationId',
   'rootInstallationJournalFingerprint','rootSourceArtifactDigest','rootStockRuntimeFingerprint',
   'predecessorOperationId','predecessorPlanHash','predecessorApprovalHash','predecessorCancellationReceiptHash',
   'previousLineageHash','depth','cancelledHistoryFingerprint','freshSourceArtifactDigest','freshInstalledRuntimeFingerprint'])
   OR NOT (v->'version'='1'::jsonb AND v->>'purpose'='clawpilot-native-email-initial-installation-lineage'
     AND jsonb_typeof(v->'depth')='number' AND v->>'depth' ~ '^[1-9][0-9]{0,2}$') IS TRUE THEN
  RAISE EXCEPTION 'Exact native initial lineage shape required' USING ERRCODE='55000';END IF;
 IF (v->>'depth')::int>500 OR EXISTS(SELECT 1 FROM jsonb_each(v) x
   WHERE x.key NOT IN ('version','purpose','depth','previousLineageHash')
    AND (jsonb_typeof(x.value)<>'string' OR x.value#>>'{}' !~ '^[a-f0-9]{64}$'))
   OR NOT (v->'previousLineageHash'='null'::jsonb OR
     (jsonb_typeof(v->'previousLineageHash')='string' AND v->>'previousLineageHash' ~ '^[a-f0-9]{64}$')) IS TRUE
   OR NOT (CASE WHEN v->>'depth'='1' THEN v->'predecessorOperationId'=v->'rootOperationId' AND v->'previousLineageHash'='null'::jsonb
     ELSE v->'predecessorOperationId'<>v->'rootOperationId' AND v->'previousLineageHash'<>'null'::jsonb END) IS TRUE THEN
  RAISE EXCEPTION 'Invalid native initial lineage anchors or depth' USING ERRCODE='55000';END IF;
 -- This fixed scalar grammar admits ASCII purposes/hashes, bounded integer
 -- values and null only. Compact ordered values match native canonical bytes;
 -- jsonb::text itself is deliberately NOT used as a protocol hash.
 SELECT '{'||string_agg(to_jsonb(x.key)::text||':'||x.value::text,',' ORDER BY x.key COLLATE "C")||'}'
 INTO canonical FROM jsonb_each(v) x;
 RETURN encode(public.digest(canonical,'sha256'),'hex');
END $$;

CREATE FUNCTION clawpilot_crm_native_initial_replan_context(current_operation text,predecessor_operation text,root_source_digest text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control;b public.crm_native_email_initial_reservations;
 e public.crm_native_email_initial_enrollments;r public.crm_native_email_initial_reservations;
 root_record public.crm_native_email_initial_enrollments;prior public.crm_native_email_initial_enrollments;
 proof jsonb;receipt jsonb;lineage jsonb;expected jsonb;history jsonb:='[]'::jsonb;chain text[]:=ARRAY[]::text[];
 cursor_operation text:=predecessor_operation;history_count integer:=0;i integer;history_hash text;previous_hash text;effective text;
BEGIN
 IF current_operation !~ '^[a-f0-9]{64}$' OR predecessor_operation !~ '^[a-f0-9]{64}$'
   OR root_source_digest !~ '^[a-f0-9]{64}$' OR current_operation IS NULL OR predecessor_operation IS NULL OR root_source_digest IS NULL THEN
  RAISE EXCEPTION 'Exact replan operation and independent source pin required' USING ERRCODE='55000';END IF;
 SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 SELECT * INTO b FROM public.crm_native_email_initial_reservations WHERE operation_id=current_operation FOR UPDATE;
 IF NOT FOUND OR c.enabled OR c.active_initial_enrollment_id IS DISTINCT FROM current_operation
   OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL OR b.state<>'reserved'
   OR b.generation<>c.generation OR b.source_snapshot IS DISTINCT FROM public.clawpilot_crm_native_initial_source_snapshot() THEN
  RAISE EXCEPTION 'Replan requires its exact current reservation and source fence' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_operator_accounts a JOIN public.workspace_organizations w ON w.id=a.root_workspace_id
   JOIN public.app_users u ON u.email=a.owner_email JOIN public.app_user_organization_memberships m ON m.user_email=u.email AND m.organization_id=w.id
   WHERE a.id=b.operator_account_id AND a.root_workspace_id=b.root_workspace_id AND a.owner_email=b.actor_email AND a.enabled
     AND w.parent_id IS NULL AND w.organization_type='root' AND NOT w.is_demo AND u.status='active' AND u.role='owner'
     AND m.status='active' AND m.trashed_at IS NULL AND m.role='owner') THEN
  RAISE EXCEPTION 'Replan requires the current exact root owner' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.crm_native_email_initial_reservations reservation
   LEFT JOIN public.crm_native_email_initial_enrollments enrollment ON enrollment.operation_id=reservation.operation_id
   WHERE reservation.native_instance_id=b.native_instance_id AND reservation.operation_id<>current_operation AND enrollment.operation_id IS NULL) THEN
  RAISE EXCEPTION 'Unresolved historical reservation prevents replan' USING ERRCODE='55000';END IF;
 FOR e IN SELECT * FROM public.crm_native_email_initial_enrollments
   WHERE native_instance_id=b.native_instance_id AND operation_id<>current_operation ORDER BY operation_id COLLATE "C" FOR SHARE LOOP
  history_count:=history_count+1;
  IF history_count>500 THEN RAISE EXCEPTION 'Replan cancellation history bound exceeded' USING ERRCODE='55000';END IF;
  SELECT * INTO r FROM public.crm_native_email_initial_reservations WHERE operation_id=e.operation_id FOR SHARE;
  proof:=e.approval_envelope->'proof';receipt:=e.native_receipt;
  IF NOT FOUND OR e.state<>'cancelled' OR r.state<>'cancelled' OR e.settling_xid IS DISTINCT FROM r.settling_xid
    OR (e.actor_email,e.operator_account_id,e.root_workspace_id,e.native_instance_id,e.generation,e.source_snapshot,e.source_fingerprint)
      IS DISTINCT FROM (r.actor_email,r.operator_account_id,r.root_workspace_id,r.native_instance_id,r.generation,r.source_snapshot,r.source_fingerprint)
    OR (e.operator_account_id,e.root_workspace_id,e.native_instance_id) IS DISTINCT FROM (b.operator_account_id,b.root_workspace_id,b.native_instance_id)
    OR e.plan_canonical::jsonb IS DISTINCT FROM e.plan OR encode(public.digest(e.plan_canonical,'sha256'),'hex')<>e.plan_hash
    OR e.native_delta_canonical::jsonb IS DISTINCT FROM e.native_delta OR encode(public.digest(e.native_delta_canonical,'sha256'),'hex')<>e.delta_fingerprint
    OR e.approval_canonical::jsonb IS DISTINCT FROM e.approval_envelope OR encode(public.digest(e.approval_canonical,'sha256'),'hex')<>e.approval_hash
    OR e.receipt_canonical::jsonb IS DISTINCT FROM receipt OR encode(public.digest(e.receipt_canonical,'sha256'),'hex')<>e.receipt_hash
    OR encode(public.digest(r.source_snapshot::text,'sha256'),'hex')<>r.source_fingerprint
    OR NOT (e.plan->>'operationId'=e.operation_id AND e.plan->>'nativeInstanceId'=e.native_instance_id
      AND e.plan->>'appGeneration'=e.generation::text AND e.plan->>'appSourceFingerprint'=e.source_fingerprint
      AND proof->>'operationId'=e.operation_id AND proof->>'planHash'=e.plan_hash
      AND proof->>'nativeInstanceId'=e.native_instance_id AND proof->>'appGeneration'=e.generation::text
      AND proof->>'appSourceFingerprint'=e.source_fingerprint AND proof->>'deltaFingerprint'=e.delta_fingerprint
      AND proof->>'sourceRuntimeFingerprint' ~ '^[a-f0-9]{64}$'
      AND proof->>'installedRuntimeFingerprint' ~ '^[a-f0-9]{64}$'
      AND proof->>'installationJournalFingerprint' ~ '^[a-f0-9]{64}$') IS TRUE
    OR NOT public.clawpilot_crm_native_initial_shape(receipt,ARRAY['version','purpose','operationId','planHash','approvalHash','state','result'])
    OR NOT (receipt->'version'='1'::jsonb AND receipt->>'purpose'='clawpilot-native-email-initial-enrollment-receipt'
      AND receipt->>'operationId'=e.operation_id AND receipt->>'planHash'=e.plan_hash AND receipt->>'approvalHash'=e.approval_hash
      AND receipt->>'state'='cancelled' AND receipt->'result'='null'::jsonb) IS TRUE THEN
   RAISE EXCEPTION 'Historical cancellation, canonical evidence or operator scope differs' USING ERRCODE='55000';END IF;
  history:=history||jsonb_build_array(jsonb_build_object('operationId',e.operation_id,'planHash',e.plan_hash,
    'deltaFingerprint',e.delta_fingerprint,'approvalHash',e.approval_hash,'cancellationReceiptHash',e.receipt_hash));
 END LOOP;
 IF history_count=0 THEN RAISE EXCEPTION 'A real retained cancellation is required for replan' USING ERRCODE='55000';END IF;
 LOOP
  IF cursor_operation=current_operation OR cursor_operation=ANY(chain) THEN
   RAISE EXCEPTION 'Cyclic replan history refused' USING ERRCODE='55000';END IF;
  SELECT * INTO e FROM public.crm_native_email_initial_enrollments
    WHERE operation_id=cursor_operation AND native_instance_id=b.native_instance_id;
  IF NOT FOUND OR e.state<>'cancelled' THEN RAISE EXCEPTION 'Missing exact cancelled predecessor' USING ERRCODE='55000';END IF;
  chain:=array_prepend(cursor_operation,chain);
  IF cardinality(chain)>history_count THEN RAISE EXCEPTION 'Replan chain exceeds retained history' USING ERRCODE='55000';END IF;
  IF e.plan->>'kind'='initial_enrollment_plan_v1' THEN
   IF e.plan ? 'installationLineage' THEN RAISE EXCEPTION 'Original installation plan has unexpected lineage' USING ERRCODE='55000';END IF;
   root_record:=e;EXIT;
  END IF;
  IF e.plan->>'kind'<>'initial_enrollment_replan_v1' THEN RAISE EXCEPTION 'Unknown historical replan kind' USING ERRCODE='55000';END IF;
  PERFORM public.clawpilot_crm_native_initial_lineage_digest(e.plan->'installationLineage');
  cursor_operation:=e.plan->'installationLineage'->>'predecessorOperationId';
 END LOOP;
 IF cardinality(chain)<>history_count THEN RAISE EXCEPTION 'Branched or incomplete cancellation history refused' USING ERRCODE='55000';END IF;
 FOR i IN 1..history_count LOOP
  SELECT * INTO prior FROM public.crm_native_email_initial_enrollments WHERE operation_id=chain[i];
  IF i>1 THEN
   lineage:=prior.plan->'installationLineage';
   IF (lineage->>'depth')::int<>i-1 OR lineage->>'freshInstalledRuntimeFingerprint' IS DISTINCT FROM prior.plan->>'nativeRuntimeBeforeFingerprint'
     OR lineage->>'freshInstalledRuntimeFingerprint' IS DISTINCT FROM prior.approval_envelope->'proof'->>'sourceRuntimeFingerprint'
     OR lineage->>'freshInstalledRuntimeFingerprint' IS DISTINCT FROM prior.approval_envelope->'proof'->>'installedRuntimeFingerprint'
     OR (lineage-ARRAY['purpose','freshSourceArtifactDigest','freshInstalledRuntimeFingerprint']) IS DISTINCT FROM (expected-'purpose') THEN
    RAISE EXCEPTION 'Historical replan lineage differs from exact preceding chain' USING ERRCODE='55000';END IF;
   effective:=encode(public.digest('{"installationLineageHash":"'
     ||public.clawpilot_crm_native_initial_lineage_digest(lineage)||'","purpose":"clawpilot-native-email-initial-effective-installation","rootInstallationJournalFingerprint":"'
     ||(lineage->>'rootInstallationJournalFingerprint')||'","version":1}','sha256'),'hex');
   IF prior.approval_envelope->'proof'->>'installationJournalFingerprint' IS DISTINCT FROM effective THEN
    RAISE EXCEPTION 'Historical effective installation differs' USING ERRCODE='55000';END IF;
  END IF;
  previous_hash:=CASE WHEN i=1 THEN NULL ELSE public.clawpilot_crm_native_initial_lineage_digest(prior.plan->'installationLineage') END;
  SELECT encode(public.digest('['||string_agg('{"approvalHash":"'||(entry->>'approvalHash')
    ||'","cancellationReceiptHash":"'||(entry->>'cancellationReceiptHash')||'","deltaFingerprint":"'||(entry->>'deltaFingerprint')
    ||'","operationId":"'||(entry->>'operationId')||'","planHash":"'||(entry->>'planHash')||'"}',',' ORDER BY entry->>'operationId' COLLATE "C")||']','sha256'),'hex')
   INTO history_hash FROM jsonb_array_elements(history) entry WHERE entry->>'operationId'=ANY(chain[1:i]);
  expected:=jsonb_build_object('version',1,'purpose','clawpilot-native-email-initial-replan-context',
    'rootOperationId',root_record.operation_id,'rootInstallationJournalFingerprint',root_record.approval_envelope->'proof'->>'installationJournalFingerprint',
    'rootSourceArtifactDigest',root_source_digest,'rootStockRuntimeFingerprint',root_record.approval_envelope->'proof'->>'sourceRuntimeFingerprint',
    'predecessorOperationId',prior.operation_id,'predecessorPlanHash',prior.plan_hash,'predecessorApprovalHash',prior.approval_hash,
    'predecessorCancellationReceiptHash',prior.receipt_hash,'previousLineageHash',previous_hash,'depth',i,'cancelledHistoryFingerprint',history_hash);
 END LOOP;
 RETURN expected;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_lineage_digest(jsonb),
 clawpilot_crm_native_initial_replan_context(text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION clawpilot_crm_native_initial_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control;p jsonb:=NEW.plan;d jsonb:=NEW.native_delta;
 proof jsonb:=NEW.approval_envelope->'proof';r jsonb:=d->'result';entry jsonb;known jsonb;policy jsonb;n integer;
 reservation public.crm_native_email_initial_reservations;lineage jsonb;expected_context jsonb;lineage_hash text;effective_journal text;
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
   'principalSuiteCrmUserIds','defaults','emails','pipelines','reviewedRevocations','rootEmployeeGrants']
     || CASE WHEN p->>'kind'='initial_enrollment_replan_v1' THEN ARRAY['installationLineage'] ELSE ARRAY[]::text[] END)
   OR NOT (p->>'version'='1' AND p->>'kind' IN ('initial_enrollment_plan_v1','initial_enrollment_replan_v1') AND p->>'operationId'=NEW.operation_id
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
 IF p->>'kind'='initial_enrollment_replan_v1' THEN
  lineage:=p->'installationLineage';lineage_hash:=public.clawpilot_crm_native_initial_lineage_digest(lineage);
  expected_context:=public.clawpilot_crm_native_initial_replan_context(NEW.operation_id,lineage->>'predecessorOperationId',lineage->>'rootSourceArtifactDigest');
  effective_journal:=encode(public.digest('{"installationLineageHash":"'||lineage_hash
   ||'","purpose":"clawpilot-native-email-initial-effective-installation","rootInstallationJournalFingerprint":"'
   ||(lineage->>'rootInstallationJournalFingerprint')||'","version":1}','sha256'),'hex');
  IF (lineage-ARRAY['purpose','freshSourceArtifactDigest','freshInstalledRuntimeFingerprint']) IS DISTINCT FROM (expected_context-'purpose')
    OR lineage->>'freshInstalledRuntimeFingerprint' IS DISTINCT FROM p->>'nativeRuntimeBeforeFingerprint'
    OR lineage->>'freshInstalledRuntimeFingerprint' IS DISTINCT FROM r->>'installedRuntimeFingerprint'
    OR proof->>'installationJournalFingerprint' IS DISTINCT FROM effective_journal THEN
   RAISE EXCEPTION 'Replan requires exact cancelled lineage and fresh installed source' USING ERRCODE='55000';END IF;
 ELSIF EXISTS(SELECT 1 FROM public.crm_native_email_initial_enrollments history WHERE history.native_instance_id=NEW.native_instance_id
   AND history.operation_id<>NEW.operation_id) THEN
  RAISE EXCEPTION 'Direct initial plan cannot bypass retained cancellation history' USING ERRCODE='55000';
 END IF;
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

