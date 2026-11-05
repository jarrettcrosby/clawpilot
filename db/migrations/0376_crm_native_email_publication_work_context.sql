-- Prepared evidence/resolver ownership only. Does not activate publication,
-- authorize a repair, modify an outbox row, or release an admission on timeout.
CREATE TABLE crm_native_email_publication_work (
  operation_id text PRIMARY KEY REFERENCES crm_native_email_publication_admissions(operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  work_kind text NOT NULL CHECK (work_kind IN ('outbox','repair')),
  context jsonb NOT NULL CHECK (jsonb_typeof(context)='object' AND octet_length(context::text)<=2048),
  context_hash text NOT NULL CHECK (context_hash ~ '^[a-f0-9]{64}$'),
  lease_owner uuid NOT NULL,
  lease_fence bigint NOT NULL CHECK (lease_fence BETWEEN 1 AND 9007199254740991),
  lease_until timestamptz NOT NULL CHECK (isfinite(lease_until)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((context->>'kind'=work_kind AND CASE work_kind WHEN 'outbox' THEN
    context ?& ARRAY['kind','outboxId','idempotencyKey','sourceHash','payloadHash','attempt']
    AND context - ARRAY['kind','outboxId','idempotencyKey','sourceHash','payloadHash','attempt']='{}'::jsonb
    AND jsonb_typeof(context->'outboxId')='string'
    AND context->>'outboxId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND jsonb_typeof(context->'idempotencyKey')='string'
    AND length(context->>'idempotencyKey') BETWEEN 1 AND 256
    AND jsonb_typeof(context->'sourceHash')='string' AND context->>'sourceHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(context->'payloadHash')='string' AND context->>'payloadHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(context->'attempt')='number' AND context->>'attempt' ~ '^([1-9]|1[0-9]|20)$'
  ELSE
    context ?& ARRAY['kind','manifestHash','itemId']
    AND context - ARRAY['kind','manifestHash','itemId']='{}'::jsonb
    AND jsonb_typeof(context->'manifestHash')='string' AND context->>'manifestHash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(context->'itemId')='string' AND context->>'itemId' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  END) IS TRUE)
);

CREATE FUNCTION clawpilot_native_email_work_statement_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native Email work control missing' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER crm_native_email_work_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_publication_work
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_work_statement_lock();

CREATE FUNCTION clawpilot_native_email_work_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Native Email work evidence cannot be removed' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.lease_fence<>1 THEN RAISE EXCEPTION 'Native Email initial work fence must be one' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['lease_owner','lease_fence','lease_until','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['lease_owner','lease_fence','lease_until','updated_at'])
       OR OLD.lease_until>clock_timestamp() OR NEW.lease_fence<>OLD.lease_fence+1 THEN
      RAISE EXCEPTION 'Native Email work identity is immutable or lease is still owned' USING ERRCODE='55000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.crm_native_email_publication_admissions a
      JOIN public.crm_native_email_publication_control c ON c.singleton AND c.enabled AND c.active_operation_id=a.operation_id
      WHERE a.operation_id=NEW.operation_id AND a.request_fingerprint=NEW.request_fingerprint
        AND a.state IN ('admitted','dispatched','unknown')) THEN
      RAISE EXCEPTION 'Native Email work requires its unresolved active admission' USING ERRCODE='55000';
    END IF;
  END IF;
  IF NEW.lease_until<clock_timestamp()+interval '59 seconds' OR NEW.lease_until>clock_timestamp()+interval '301 seconds' THEN
    RAISE EXCEPTION 'Native Email work lease duration outside bounds' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_email_work_guard BEFORE INSERT OR UPDATE OR DELETE ON crm_native_email_publication_work
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_work_guard();
CREATE TRIGGER crm_native_email_work_truncate_guard BEFORE TRUNCATE ON crm_native_email_publication_work
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_work_guard();

-- Registration happens before the parent store INSERT, inside its validator.
-- Validate the binding at commit without granting authority from the context.
CREATE FUNCTION clawpilot_native_email_work_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.crm_native_email_publication_admissions a
    JOIN public.crm_native_email_publication_control c ON c.singleton AND c.enabled AND c.active_operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND a.request_fingerprint=NEW.request_fingerprint
      AND a.state IN ('admitted','dispatched','unknown') AND a.generation=c.generation AND c.verified_generation=c.generation
      AND a.native_policy_fingerprint=c.native_policy_fingerprint
      AND a.command->>'mode'=CASE NEW.work_kind WHEN 'outbox' THEN 'publish' ELSE 'repair' END
      AND (NEW.work_kind='repair' OR NEW.context->>'idempotencyKey'=
        'crm:interactions:v4:'||a.local_id::text||':Emails:'||(NEW.context->>'sourceHash'))) THEN
    RAISE EXCEPTION 'Native Email work does not match its exact admission' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_native_email_work_binding AFTER INSERT ON crm_native_email_publication_work
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_work_binding();
