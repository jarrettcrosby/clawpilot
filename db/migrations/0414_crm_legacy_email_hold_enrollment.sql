-- A consumed in-place hold is evidence of no available writer, not a
-- publication or recovery permit. Keep every pending row in the immutable
-- source snapshot and preserve the original demo-only exception separately.
CREATE FUNCTION clawpilot_crm_native_initial_pending_quarantine(p_outbox_id uuid,p_row_fingerprint text,
 p_operator_account_id uuid,p_root_workspace_id uuid,p_native_instance_id text,p_generation bigint)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
 SELECT public.clawpilot_crm_native_initial_demo_quarantine(p_outbox_id,p_row_fingerprint)
  OR EXISTS(
   SELECT 1 FROM crm_legacy_email_terminal_hold.held h
   JOIN crm_legacy_email_terminal_hold.verified_batch b ON b.batch=h.batch
   JOIN crm_legacy_email_terminal_hold.consumed receipt ON receipt.batch=b.batch
   JOIN public.sync_outbox o ON o.id=h.outbox_id
   JOIN public.crm_interactions i ON i.id=h.local_id AND i.pipeline_id=h.pipeline_id
   JOIN public.pipeline_spaces p ON p.id=h.pipeline_id AND p.workspace_organization_id=h.workspace_id
   JOIN public.workspace_organizations w ON w.id=h.workspace_id AND NOT w.is_demo
   JOIN public.crm_operator_workspace_bindings binding ON binding.operator_account_id=p_operator_account_id
    AND binding.workspace_id=w.id AND binding.enabled AND binding.owner_email=b.manifest->>'actorEmail'
   JOIN public.crm_native_email_publication_control c ON c.singleton AND NOT c.enabled AND c.generation=p_generation
    AND c.active_operation_id IS NULL AND c.active_transition_id IS NULL
   CROSS JOIN LATERAL jsonb_array_elements(b.manifest->'rows') review(value)
   WHERE h.outbox_id=p_outbox_id AND p_row_fingerprint ~ '^[0-9a-f]{64}$'
    AND h.row_fingerprint=p_row_fingerprint AND review.value->>'outboxId'=h.outbox_id::text
    AND review.value->>'rowFingerprint'=h.row_fingerprint AND review.value->>'localId'=h.local_id::text
    AND review.value->>'pipelineId'=h.pipeline_id::text AND review.value->>'workspaceId'=h.workspace_id::text
    AND b.manifest->>'operatorAccountId'=p_operator_account_id::text
    AND b.manifest->>'rootWorkspaceId'=p_root_workspace_id::text
    AND p_native_instance_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,35}$'
    AND b.manifest#>>'{scope,nativeAuthorityInstanceId}'=p_native_instance_id
    AND b.manifest->>'appGeneration'=p_generation::text
    AND b.manifest->>'action'='hold_exact_legacy_terminal_rows_in_place'
    AND b.manifest->>'publicationDisposition'='hold_without_publication'
    AND receipt.consumed_at<b.valid_until -- expiry limits consumption, never releases a committed hold
    AND receipt.held_rows=jsonb_array_length(b.manifest->'rows')
    AND receipt.held_rows=(SELECT count(*) FROM crm_legacy_email_terminal_hold.held x WHERE x.batch=b.batch)
    AND receipt.receipt_hash=crm_legacy_email_terminal_hold.receipt_fingerprint(b.batch)
    AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.operation='upsert_record'
    AND o.status='dead' AND o.attempts=8 AND o.locked_at IS NULL AND o.lock_token IS NULL
    AND to_jsonb(o)=h.original AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=p_row_fingerprint
    AND i.suitecrm_module='Emails' AND i.suitecrm_id=h.native_id AND i.reference_code=h.global_id
    AND i.sync_status='failed' AND i.suitecrm_synced_at IS NULL AND NOT p.reference_access_disabled
    AND review.value->>'sourceFingerprint'=encode(public.digest(to_jsonb(i)::text,'sha256'),'hex')
    AND review.value->>'relationshipFingerprint'=crm_legacy_email_terminal_hold.relationship_fingerprint(i.id)
    AND review.value->>'providerIdentityFingerprint'=crm_legacy_email_terminal_hold.provider_identity_fingerprint(i.id)
  )
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_pending_quarantine(uuid,text,uuid,uuid,text,bigint) FROM PUBLIC;

-- Forward-only pinned substitution. The reserve/admit bodies and their
-- privileges, signature checks, lineage, and source equality are unchanged
-- except for this one call. An unexpected database fails migration closed.
DO $terminal_hold$
DECLARE identity text; expected_body_hash text; body text; definition text; updated_definition text;
 old_predicate text:=$before$public.clawpilot_crm_native_initial_demo_quarantine(o.id,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'))$before$;
 new_predicate text:=$after$public.clawpilot_crm_native_initial_pending_quarantine(o.id,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'),
     NEW.operator_account_id,NEW.root_workspace_id,NEW.native_instance_id,NEW.generation)$after$;
BEGIN
 FOR identity,expected_body_hash IN VALUES
  ('public.clawpilot_crm_native_initial_reserve()','65048da9fee8be280c3110d00d86b8d5d486752b28afe69944e054ae06445914'),
  ('public.clawpilot_crm_native_initial_admit()','0cf446701f3a0c6bcfb9da5f11059fce380728df65cbe2e88460864e74cd4830')
 LOOP
  SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity::regprocedure;
  IF body IS NULL OR encode(public.digest(body,'sha256'),'hex')<>expected_body_hash
   OR length(body)-length(replace(body,old_predicate,''))<>length(old_predicate) THEN
   RAISE EXCEPTION 'Terminal Email hold requires its exact current enrollment function preimage' USING ERRCODE='55000';
  END IF;
  definition:=pg_catalog.pg_get_functiondef(identity::regprocedure);
  updated_definition:=replace(definition,old_predicate,new_predicate);
  IF updated_definition=definition THEN
   RAISE EXCEPTION 'Terminal Email hold enrollment predicate was not replaced' USING ERRCODE='55000';
  END IF;
  EXECUTE updated_definition;
  SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity::regprocedure;
  IF encode(public.digest(replace(body,new_predicate,old_predicate),'sha256'),'hex')<>expected_body_hash THEN
   RAISE EXCEPTION 'Terminal Email hold changed unrelated enrollment code' USING ERRCODE='55000';
  END IF;
 END LOOP;
END $terminal_hold$;
