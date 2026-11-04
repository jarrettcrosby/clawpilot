-- Preserve terminal demo quarantine as evidence, never as replayable work.
-- No outbox row, native record, permission, reservation or control is changed.
-- The existing immutable snapshot still includes EVERY pending outbox row and
-- its complete fingerprint. Live, uncertain and identity work remain held.
CREATE FUNCTION clawpilot_crm_native_initial_demo_quarantine(outbox_id uuid,expected_row_fingerprint text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.sync_outbox o
  LEFT JOIN public.crm_products product
    ON o.aggregate_type='crm_products' AND product.id::text=o.aggregate_id
  LEFT JOIN public.crm_interactions interaction
    ON o.aggregate_type='crm_interactions' AND interaction.id::text=o.aggregate_id
  JOIN public.pipeline_spaces pipeline ON pipeline.id=COALESCE(product.pipeline_id,interaction.pipeline_id)
  JOIN public.workspace_organizations workspace ON workspace.id=pipeline.workspace_organization_id
  WHERE o.id=outbox_id AND expected_row_fingerprint ~ '^[a-f0-9]{64}$'
    AND encode(public.digest(to_jsonb(o)::text,'sha256'),'hex')=expected_row_fingerprint
    AND o.target_system='suitecrm' AND o.status='dead'
    AND o.last_error='Demo pipeline quarantined; immutable CRM identity evidence preserved'
    AND o.available_at='infinity'::timestamptz AND o.processed_at IS NOT NULL
    AND o.locked_at IS NULL AND o.lock_token IS NULL
    AND workspace.id='10000000-0000-4000-8000-000000000001'::uuid
    AND workspace.is_demo AND workspace.organization_type='root' AND workspace.parent_id IS NULL
    AND pipeline.reference_access_disabled AND pipeline.owner_email='demo-system@clawpilot.example'
    AND o.payload->>'pipelineId'=pipeline.id::text AND o.payload->>'localId'=o.aggregate_id
    AND jsonb_typeof(o.payload->'attributes')='object'
    AND (
      (o.aggregate_type='crm_products' AND o.operation='upsert_record' AND product.id IS NOT NULL
        AND o.payload->>'entity'='products' AND o.payload->>'suiteCrmId'=product.suitecrm_id
        AND COALESCE(o.payload->>'suiteCrmModule','AOS_Products')='AOS_Products'
        AND o.payload->>'previousSuiteCrmModule' IS NULL
        AND product.source_payload->'synthetic'='true'::jsonb
        AND product.source_payload->>'provider'='quickbooks')
      OR
      (o.aggregate_type='crm_interactions' AND o.operation='reproject_record' AND interaction.id IS NOT NULL
        AND o.payload->>'entity'='interactions' AND o.payload->>'suiteCrmId'=interaction.suitecrm_id
        AND o.payload->>'suiteCrmModule'='Emails' AND o.payload->>'previousSuiteCrmModule'='Notes'
        AND interaction.suitecrm_module='Emails'
        AND interaction.source_payload->'synthetic'='true'::jsonb
        AND interaction.source_payload->>'source'='demo')
    )
 )
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_native_initial_demo_quarantine(uuid,text) FROM PUBLIC;

-- These are the only new source dependencies: the existing enrollment fence
-- already protects the outbox, interactions, workspace and pipeline authority.
-- Take control before row locks, including when an UPDATE names these columns
-- but would leave their values unchanged. Ordinary product content is not a
-- classification input; no broad product-read or price-edit grant is added.
CREATE TRIGGER crm_native_initial_demo_product_source_fence
 BEFORE INSERT OR DELETE OR TRUNCATE ON crm_products FOR EACH STATEMENT
 EXECUTE FUNCTION clawpilot_crm_native_initial_source_fence();
CREATE TRIGGER crm_native_initial_demo_product_source_update_fence
 BEFORE UPDATE OF id,pipeline_id,suitecrm_id,source_payload ON crm_products FOR EACH STATEMENT
 EXECUTE FUNCTION clawpilot_crm_native_initial_source_fence();

-- Forward-only, checksum-pinned surgery on the two exact current functions.
-- Preserve the rest of the reserve and replan-aware admission bodies, their
-- ACLs, attributes and all existing signature/source/lineage/receipt checks.
-- Refuse an unknown preimage rather than silently patching an operator change.
DO $quarantine$
DECLARE identity text;expected_body_hash text;body text;definition text;updated_definition text;
 old_predicate text:=$before$ IF EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.target_system='suitecrm' AND o.status<>'succeeded'
   AND (o.operation='upsert_user_identity' OR o.status<>'queued' OR o.attempts<>0 OR o.locked_at IS NOT NULL
     OR o.lock_token IS NOT NULL OR o.last_error IS NOT NULL OR o.processed_at IS NOT NULL)) THEN$before$;
 new_predicate text:=$after$ IF EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.target_system='suitecrm' AND o.status<>'succeeded'
   AND (o.operation='upsert_user_identity' OR o.status<>'queued' OR o.attempts<>0 OR o.locked_at IS NOT NULL
     OR o.lock_token IS NOT NULL OR o.last_error IS NOT NULL OR o.processed_at IS NOT NULL)
   AND NOT public.clawpilot_crm_native_initial_demo_quarantine(o.id,encode(public.digest(to_jsonb(o)::text,'sha256'),'hex'))) THEN$after$;
BEGIN
 FOR identity,expected_body_hash IN VALUES
  ('public.clawpilot_crm_native_initial_reserve()','0f4965805739f3e8f51c454c7145b3045dab34c33948d0b1facef7e2a03ba4b7'),
  ('public.clawpilot_crm_native_initial_admit()','ae3a6ac733efa6d3d39d50a563e29f32eb35b229f393f6c9da6f3630cc86b32e')
 LOOP
  SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity::regprocedure;
  IF body IS NULL OR encode(public.digest(body,'sha256'),'hex')<>expected_body_hash
    OR (length(body)-length(replace(body,old_predicate,'')))<>length(old_predicate) THEN
   RAISE EXCEPTION 'Native demo quarantine requires its exact current enrollment function preimage' USING ERRCODE='55000';
  END IF;
  definition:=pg_catalog.pg_get_functiondef(identity::regprocedure);
  updated_definition:=replace(definition,old_predicate,new_predicate);
  IF updated_definition=definition THEN
   RAISE EXCEPTION 'Native demo quarantine enrollment predicate was not replaced' USING ERRCODE='55000';
  END IF;
  EXECUTE updated_definition;
  SELECT prosrc INTO body FROM pg_catalog.pg_proc WHERE oid=identity::regprocedure;
  IF encode(public.digest(replace(body,new_predicate,old_predicate),'sha256'),'hex')<>expected_body_hash THEN
   RAISE EXCEPTION 'Native demo quarantine changed unrelated enrollment code' USING ERRCODE='55000';
  END IF;
 END LOOP;
END $quarantine$;
