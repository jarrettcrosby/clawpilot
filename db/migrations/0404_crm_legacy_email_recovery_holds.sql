-- Inert until a separately reviewed private recovery controller is installed.
-- This registry is a deny-only guard, never admission, authorization, or proof
-- of an old provider outcome. No backfill, role grant, queue or source changes.
CREATE TABLE crm_legacy_email_recovery_holds (
  outbox_id uuid PRIMARY KEY REFERENCES sync_outbox(id) ON DELETE RESTRICT,
  retired_outbox_id uuid NOT NULL UNIQUE CHECK(retired_outbox_id<>outbox_id),
  operation_id uuid NOT NULL UNIQUE,
  local_id uuid NOT NULL UNIQUE REFERENCES crm_interactions(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  native_id text NOT NULL UNIQUE CHECK(native_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'),
  global_id text NOT NULL UNIQUE CHECK(global_id ~ '^gi([0-9]{7}|[0-9a-v]{12})$'),
  retirement_receipt_hash text NOT NULL CHECK(retirement_receipt_hash ~ '^[0-9a-f]{64}$'),
  -- The exact intent survives expiration of any one signed release envelope.
  release_intent_hash text NOT NULL UNIQUE CHECK(release_intent_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON TABLE crm_legacy_email_recovery_holds FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_outbox_held(target_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds WHERE outbox_id=target_id OR retired_outbox_id=target_id)
$$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_outbox_held(uuid) FROM PUBLIC;

-- Archive-backed staging may provide stronger exact-XID serialization. Until
-- that private stage exists, every hold uses the control-row revision below.
CREATE FUNCTION clawpilot_crm_legacy_email_archive_serialized_hold(hold_row jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_archive_serialized_hold(jsonb) FROM PUBLIC;

CREATE FUNCTION clawpilot_crm_legacy_email_validate_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE control public.crm_native_email_publication_control; archive_serialized boolean:=false;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Private Email recovery hold is immutable' USING ERRCODE='55000';
 END IF;
 SELECT * INTO STRICT control FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
 IF control.enabled IS DISTINCT FROM true OR control.verified_generation IS DISTINCT FROM control.generation
   OR control.active_operation_id IS NOT NULL OR control.active_transition_id IS NOT NULL
   OR control.activation_receipt_hash IS NULL THEN
  RAISE EXCEPTION 'Private Email recovery hold requires idle verified authority' USING ERRCODE='55000';
 END IF;
 PERFORM 1 FROM public.crm_interactions WHERE id=NEW.local_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.crm_interactions i JOIN public.sync_outbox o ON o.id=NEW.outbox_id
   WHERE i.id=NEW.local_id AND i.pipeline_id=NEW.pipeline_id AND i.suitecrm_module='Emails'
    AND i.suitecrm_id=NEW.native_id AND i.reference_code=NEW.global_id
    AND i.suitecrm_synced_at IS NULL AND i.sync_status='failed'
    AND COALESCE(lower(i.source_payload->>'archived'),'false') NOT IN ('true','1','yes')
    AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.aggregate_id=i.id::text
    AND o.operation='upsert_record' AND o.status='processing' AND o.attempts=1
    AND o.created_at=transaction_timestamp() AND o.xmin=pg_current_xact_id()::xid
    AND o.lock_token IS NOT NULL AND o.locked_at IS NOT NULL AND o.available_at='infinity'::timestamptz
    AND o.idempotency_key='crm:interactions:v4:'||i.id::text||':Emails:'||i.source_hash
    AND o.payload->>'entity'='interactions' AND o.payload->>'localId'=i.id::text
    AND o.payload->>'pipelineId'=i.pipeline_id::text AND o.payload->>'suiteCrmId'=i.suitecrm_id
    AND o.payload->>'suiteCrmModule'='Emails' AND o.payload->>'previousSuiteCrmModule' IS NULL
    AND o.payload#>>'{attributes,global_id_c}'=i.reference_code)
   OR EXISTS(SELECT 1 FROM public.sync_outbox o WHERE o.id=NEW.retired_outbox_id OR
     (o.id<>NEW.outbox_id AND o.target_system='suitecrm' AND o.aggregate_type='crm_interactions' AND o.aggregate_id=NEW.local_id::text))
   OR EXISTS(SELECT 1 FROM public.crm_native_email_publication_admissions a
     WHERE a.local_id=NEW.local_id OR lower(a.native_id)=NEW.native_id OR lower(a.global_id)=NEW.global_id) THEN
  RAISE EXCEPTION 'Private Email recovery hold is not an exact unadmitted claim' USING ERRCODE='55000';
 END IF;
 -- Existing 0398 BEFORE STATEMENT fences lock this row for source/outbox
 -- DML. Update only its timestamp so a pre-hold REPEATABLE READ writer
 -- serializes instead of seeing the old empty registry after waiting. The
 -- exact archive stage has already written its own fenced revision instead.
 -- Other invoker roles keep the original path with no new privilege grant.
 IF has_function_privilege('public.clawpilot_crm_legacy_email_archive_serialized_hold(jsonb)','EXECUTE') THEN
  archive_serialized:=public.clawpilot_crm_legacy_email_archive_serialized_hold(to_jsonb(NEW));
 END IF;
 IF archive_serialized IS NOT TRUE THEN
  UPDATE public.crm_native_email_publication_control SET updated_at=clock_timestamp() WHERE singleton;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_validate_hold() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_recovery_hold_validate BEFORE INSERT OR UPDATE OR DELETE ON crm_legacy_email_recovery_holds
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_validate_hold();
CREATE TRIGGER crm_legacy_email_recovery_hold_no_truncate BEFORE TRUNCATE ON crm_legacy_email_recovery_holds
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_validate_hold();

-- A private hold stays inert even if an older writer or a one-off SQL tool
-- reaches these tables. No settlement bypass is installed by this migration.
CREATE FUNCTION clawpilot_crm_legacy_email_protect_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE row_view jsonb; compared jsonb[]:=ARRAY[]::jsonb[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds) THEN
   RAISE EXCEPTION 'Private Email recovery holds prevent truncation' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds LIMIT 1) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'INSERT' THEN compared:=array_append(compared,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN compared:=array_append(compared,to_jsonb(NEW)); END IF;
 FOREACH row_view IN ARRAY compared LOOP
  IF TG_TABLE_NAME='crm_interactions' THEN
   IF EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE h.local_id::text=row_view->>'id'
      OR h.native_id=lower(row_view->>'suitecrm_id') OR h.global_id=lower(row_view->>'reference_code')) THEN
    RAISE EXCEPTION 'Private Email recovery identity is held' USING ERRCODE='55000';
   END IF;
  ELSE
   IF public.clawpilot_crm_legacy_email_outbox_held((row_view->>'id')::uuid) OR
    ((row_view->>'target_system')='suitecrm' AND EXISTS(SELECT 1 FROM public.crm_legacy_email_recovery_holds h WHERE
     ((row_view->>'aggregate_type')='crm_interactions' AND h.local_id::text=row_view->>'aggregate_id')
     OR ((row_view#>>'{payload,entity}')='interactions' AND (h.local_id::text=row_view#>>'{payload,localId}'
       OR h.native_id=lower(row_view#>>'{payload,suiteCrmId}')
       OR h.global_id=lower(row_view#>>'{payload,attributes,global_id_c}'))))) THEN
    RAISE EXCEPTION 'Private Email recovery identity is held' USING ERRCODE='55000';
   END IF;
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION clawpilot_crm_legacy_email_protect_rows() FROM PUBLIC;
CREATE TRIGGER crm_legacy_email_protect_queue BEFORE INSERT OR UPDATE OR DELETE ON sync_outbox
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_protect_rows();
CREATE TRIGGER crm_legacy_email_protect_source BEFORE INSERT OR UPDATE OR DELETE ON crm_interactions
 FOR EACH ROW EXECUTE FUNCTION clawpilot_crm_legacy_email_protect_rows();
CREATE TRIGGER crm_legacy_email_protect_queue_truncate BEFORE TRUNCATE ON sync_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_protect_rows();
CREATE TRIGGER crm_legacy_email_protect_source_truncate BEFORE TRUNCATE ON crm_interactions
 FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_crm_legacy_email_protect_rows();
