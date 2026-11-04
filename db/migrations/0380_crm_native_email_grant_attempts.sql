-- A cancelled grant is retained forever. A retry is a new operation with the
-- same immutable command body and app receipt, never a re-signed old command.
-- Installed inert: no attempt, activation or native permission change.
CREATE TABLE crm_native_email_authority_grant_attempts (
  LIKE crm_native_email_authority_phases INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 10000),
  grant_attempt jsonb NOT NULL,
  PRIMARY KEY (transition_id,ordinal),
  UNIQUE (operation_id),
  FOREIGN KEY (transition_id) REFERENCES crm_native_email_authority_transitions(transition_id) ON DELETE RESTRICT,
  CHECK (phase='grant'),
  CHECK ((jsonb_typeof(grant_attempt)='object'
    AND grant_attempt ?& ARRAY['ordinal','originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash']
    AND grant_attempt-ARRAY['ordinal','originalOperationId','originalCommandHash','previousOperationId','previousCommandHash','previousCancellationReceiptHash']='{}'::jsonb
    AND grant_attempt->>'ordinal'=ordinal::text
    AND grant_attempt->>'originalOperationId' ~ '^[a-f0-9]{64}$'
    AND grant_attempt->>'originalCommandHash' ~ '^[a-f0-9]{64}$'
    AND grant_attempt->>'previousOperationId' ~ '^[a-f0-9]{64}$'
    AND grant_attempt->>'previousCommandHash' ~ '^[a-f0-9]{64}$'
    AND grant_attempt->>'previousCancellationReceiptHash' ~ '^[a-f0-9]{64}$') IS TRUE)
);
CREATE TRIGGER crm_native_authority_attempt_statement BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_authority_grant_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_transition_lock();

-- Original phase columns plus nullable attempt metadata. Revoke is always used;
-- grant is the last immutable attempt, or the original when no attempt exists.
CREATE VIEW crm_native_email_effective_authority_phases AS
  SELECT p.*,NULL::jsonb AS grant_attempt FROM crm_native_email_authority_phases p
    WHERE p.phase='revoke' OR NOT EXISTS(SELECT 1 FROM crm_native_email_authority_grant_attempts a WHERE a.transition_id=p.transition_id)
  UNION ALL
  SELECT a.transition_id,a.phase,a.operation_id,a.command_hash,a.command,a.state,a.approval_envelope,a.approval_readback,
    a.native_receipt,a.receipt_hash,a.lease_owner,a.lease_fence,a.lease_until,a.created_at,a.updated_at,a.grant_attempt
    FROM crm_native_email_authority_grant_attempts a
    WHERE NOT EXISTS(SELECT 1 FROM crm_native_email_authority_grant_attempts later
      WHERE later.transition_id=a.transition_id AND later.ordinal>a.ordinal);

CREATE FUNCTION clawpilot_native_email_grant_attempt_insert() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; t public.crm_native_email_authority_transitions;
  original public.crm_native_email_authority_phases; prior public.crm_native_email_effective_authority_phases; expected integer;
BEGIN
  SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.transition_id;
  SELECT * INTO original FROM public.crm_native_email_authority_phases WHERE transition_id=NEW.transition_id AND phase='grant';
  SELECT * INTO prior FROM public.crm_native_email_effective_authority_phases WHERE transition_id=NEW.transition_id AND phase='grant';
  SELECT COALESCE(max(ordinal),0)+1 INTO expected FROM public.crm_native_email_authority_grant_attempts WHERE transition_id=NEW.transition_id;
  IF NOT (c.enabled AND c.active_operation_id IS NULL AND c.active_transition_id=NEW.transition_id
    AND c.verified_generation=c.generation AND t.app_state='committed' AND t.app_commit IS NOT NULL
    AND prior.state='cancelled' AND prior.native_receipt->>'state'='cancelled'
    AND prior.native_receipt->>'operationId'=prior.operation_id AND prior.native_receipt->>'commandHash'=prior.command_hash
    AND prior.native_receipt->'result'='null'::jsonb AND prior.receipt_hash IS NOT NULL
    AND prior.approval_envelope IS NOT NULL AND prior.approval_readback IS NOT NULL
    AND c.generation=(original.command->>'generationFrom')::bigint
    AND c.native_policy_fingerprint=original.command->>'beforePolicyFingerprint'
    AND NEW.ordinal=expected AND NEW.grant_attempt=jsonb_build_object('ordinal',expected,
      'originalOperationId',original.operation_id,'originalCommandHash',original.command_hash,
      'previousOperationId',prior.operation_id,'previousCommandHash',prior.command_hash,
      'previousCancellationReceiptHash',prior.receipt_hash)
    AND NEW.command-'operationId'=original.command-'operationId'
    AND NEW.command->>'operationId'=NEW.operation_id AND NEW.command->>'transitionId'=NEW.transition_id
    AND NEW.command->>'phase'='grant' AND NEW.operation_id<>prior.operation_id AND NEW.operation_id<>original.operation_id
    AND NEW.state='prepared' AND NEW.approval_envelope IS NULL AND NEW.approval_readback IS NULL
    AND NEW.native_receipt IS NULL AND NEW.receipt_hash IS NULL AND NEW.lease_owner IS NULL
    AND NEW.lease_fence=0 AND NEW.lease_until IS NULL) IS TRUE THEN
    RAISE EXCEPTION 'Native grant retry requires exact committed app and retained cancelled predecessor' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases WHERE operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'Native grant retry operation identity is already retained' USING ERRCODE='55000'; END IF;
  -- A terminal cancellation cannot execute later. Its retained lease is audit
  -- evidence, not an ambiguous active dispatch; expiry alone never permits retry.
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_attempt_insert BEFORE INSERT ON crm_native_email_authority_grant_attempts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_grant_attempt_insert();

CREATE FUNCTION clawpilot_native_email_grant_attempt_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['state','approval_envelope','approval_readback','native_receipt','receipt_hash','lease_owner','lease_fence','lease_until','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','approval_envelope','approval_readback','native_receipt','receipt_hash','lease_owner','lease_fence','lease_until','updated_at'])
    OR OLD.state IN ('committed','cancelled')
    OR (OLD.approval_envelope IS NOT NULL AND OLD.approval_envelope IS DISTINCT FROM NEW.approval_envelope)
    OR (OLD.approval_readback IS NOT NULL AND OLD.approval_readback IS DISTINCT FROM NEW.approval_readback)
    OR (OLD.state='prepared' AND NEW.state NOT IN ('prepared','dispatched'))
    OR (OLD.state='dispatched' AND NEW.state='prepared') OR (OLD.state='unknown' AND NEW.state IN ('prepared','dispatched')) THEN
    RAISE EXCEPTION 'Native grant attempt evidence is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.state<>'prepared' AND (NEW.approval_readback IS NULL OR NEW.lease_owner IS NULL) THEN
    RAISE EXCEPTION 'Native grant attempt lacks approval and owned lease' USING ERRCODE='55000'; END IF;
  IF (NEW.lease_owner,NEW.lease_fence,NEW.lease_until) IS DISTINCT FROM (OLD.lease_owner,OLD.lease_fence,OLD.lease_until)
    AND (NEW.lease_fence<>OLD.lease_fence+1 OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
      OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '301 seconds') THEN
    RAISE EXCEPTION 'Native grant attempt lease cannot be stolen or extended' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control c
    JOIN public.crm_native_email_authority_transitions t ON t.transition_id=c.active_transition_id
    JOIN public.crm_native_email_effective_authority_phases p ON p.transition_id=t.transition_id AND p.phase='grant'
    WHERE c.singleton AND c.enabled AND c.active_operation_id IS NULL AND t.transition_id=NEW.transition_id
      AND t.app_state='committed' AND p.operation_id=NEW.operation_id
      AND c.generation=(NEW.command->>'generationFrom')::bigint
      AND c.native_policy_fingerprint=NEW.command->>'beforePolicyFingerprint') THEN
    RAISE EXCEPTION 'Native grant attempt is not the exact active grant' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_authority_attempt_immutable BEFORE UPDATE ON crm_native_email_authority_grant_attempts
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_grant_attempt_update();

-- Upgrade only phase readers. Keep base phase insertion/immutability and the
-- original exactly-two-phases coverage check intact. No GUC/session bypass.
DO $$
DECLARE name text; definition text;
BEGIN
  FOREACH name IN ARRAY ARRAY['clawpilot_native_email_control_guard','clawpilot_native_email_capability_policy_lock',
    'clawpilot_native_email_capability_policy_generation','clawpilot_native_email_capability_phase_complete'] LOOP
    definition:=pg_get_functiondef(('public.'||name||'()')::regprocedure);
    IF position('public.crm_native_email_authority_phases' IN definition)=0 THEN
      RAISE EXCEPTION 'Expected exact native phase reader missing: %',name; END IF;
    EXECUTE replace(definition,'public.crm_native_email_authority_phases','public.crm_native_email_effective_authority_phases');
  END LOOP;
END $$;
CREATE CONSTRAINT TRIGGER crm_native_authority_attempt_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_grant_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_transition_complete();
CREATE CONSTRAINT TRIGGER crm_native_capability_attempt_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_grant_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_phase_complete();
