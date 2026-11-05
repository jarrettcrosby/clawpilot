-- Trusted, reviewed future-create capability policy only. Empty by default;
-- no install, activation, native inventory or historical authority is inferred.
-- Replace only the legacy full receipt constraint (its generated name varies).
DO $$
DECLARE found_name text; matches integer;
BEGIN
  SELECT count(*),min(conname::text) INTO matches,found_name FROM pg_constraint
    WHERE conrelid='public.crm_native_email_publication_admissions'::regclass AND contype='c'
      AND position('native_receipt' IN pg_get_constraintdef(oid))>0
      AND position('commandHash' IN pg_get_constraintdef(oid))>0
      AND position('readerSuiteCrmUserIds' IN pg_get_constraintdef(oid))>0;
  IF matches<>1 THEN RAISE EXCEPTION 'Expected one exact legacy native receipt constraint'; END IF;
  EXECUTE format('ALTER TABLE public.crm_native_email_publication_admissions DROP CONSTRAINT %I',found_name);
END $$;
ALTER TABLE crm_native_email_publication_admissions ADD CONSTRAINT crm_native_email_versioned_receipt CHECK (
  native_receipt IS NULL OR (
    jsonb_typeof(native_receipt)='object' AND command->>'version' IN ('1','2')
    AND native_receipt->>'version'=command->>'version' AND native_receipt->>'state'=state
    AND native_receipt->>'operationId'=operation_id AND native_receipt->>'commandHash'=command_hash
    AND CASE WHEN state='cancelled' THEN native_receipt->'result'='null'::jsonb ELSE
      jsonb_typeof(native_receipt->'result')='object'
      AND native_receipt->'result'->>'version'=command->>'version'
      AND native_receipt->'result'->>'mode'=command->>'mode'
      AND native_receipt->'result'->>'suiteCrmId'=native_id AND native_receipt->'result'->>'globalId'=global_id
      AND native_receipt->'result'->>'pipelineId'=pipeline_id::text
      AND native_receipt->'result'->>'audienceFingerprint'=audience_fingerprint
      AND native_receipt->'result'->>'generation'=generation::text
      AND native_receipt->'result'->'readerSuiteCrmUserIds'=allowed_reader_ids
      AND CASE WHEN command->>'version'='2' THEN
        command->>'capabilityPolicyFingerprint' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(command->'principalSuiteCrmUserIds')='array'
        AND jsonb_typeof(command->'expectedCapabilities')='object'
        AND native_receipt->'result'->'capabilityPolicyFingerprint'=command->'capabilityPolicyFingerprint'
        AND native_receipt->'result'->'principalSuiteCrmUserIds'=command->'principalSuiteCrmUserIds'
        AND native_receipt->'result'->'expectedCapabilities'=command->'expectedCapabilities'
      ELSE NOT (native_receipt->'result' ?| ARRAY['capabilityPolicyFingerprint','principalSuiteCrmUserIds','expectedCapabilities']) END
    END
  ) IS TRUE
);
CREATE TABLE crm_native_email_capability_policies (
  pipeline_id uuid PRIMARY KEY REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object' AND octet_length(policy::text)<=600000),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK ((policy ?& ARRAY['version','pipelineId','workspaceId','ownerSuiteCrmId','audienceFingerprint',
    'principalSuiteCrmUserIds','futureCreate','historical']
    AND policy-ARRAY['version','pipelineId','workspaceId','ownerSuiteCrmId','audienceFingerprint',
      'principalSuiteCrmUserIds','futureCreate','historical']='{}'::jsonb
    AND policy->>'version'='2' AND policy->>'pipelineId'=pipeline_id::text
    AND policy->'historical'='[]'::jsonb AND jsonb_typeof(policy->'futureCreate')='object'
    AND jsonb_typeof(policy->'principalSuiteCrmUserIds')='array') IS TRUE)
);
CREATE FUNCTION clawpilot_native_email_capability_policy_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control;
BEGIN
  SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF FOUND AND c.enabled AND TG_OP='UPDATE' AND c.active_operation_id IS NULL AND c.active_transition_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases p
      WHERE p.transition_id=c.active_transition_id AND p.state='committed' AND p.command->>'version'='2'
        AND (p.command->>'generationFrom')::bigint=c.generation AND p.command->>'beforePolicyFingerprint'=c.native_policy_fingerprint
        AND p.approval_envelope IS NOT NULL AND p.approval_readback IS NOT NULL AND p.native_receipt IS NOT NULL) THEN
    RETURN NULL; -- Row and deferred guards require the complete exact phase.
  END IF;
  IF NOT FOUND OR c.enabled OR c.active_operation_id IS NOT NULL OR c.active_transition_id IS NOT NULL THEN
    RAISE EXCEPTION 'Native capability policy changes require disabled publication and no active work' USING ERRCODE='55000'; END IF;
  -- Installation/changes invalidate activation evidence; an independent native
  -- policy approval is required before publication can be enabled again.
  UPDATE public.crm_native_email_publication_control SET verified_generation=NULL,native_policy_fingerprint=NULL,
    activation_receipt_hash=NULL,updated_at=clock_timestamp() WHERE singleton;
  RETURN NULL;
END $$;
CREATE TRIGGER crm_native_capability_policy_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON crm_native_email_capability_policies
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_capability_policy_lock();
CREATE FUNCTION clawpilot_native_email_capability_policy_generation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; p public.crm_native_email_authority_phases; pair jsonb;
BEGIN
  SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton;
  IF TG_OP='UPDATE' AND c.enabled AND c.active_transition_id IS NOT NULL AND c.active_operation_id IS NULL THEN
    SELECT * INTO p FROM public.crm_native_email_authority_phases
      WHERE transition_id=c.active_transition_id AND state='committed' AND command->>'version'='2'
        AND (command->>'generationFrom')::bigint=c.generation AND command->>'beforePolicyFingerprint'=c.native_policy_fingerprint;
    IF FOUND THEN
      SELECT value INTO pair FROM jsonb_array_elements(p.command->'bindings')
        WHERE value->'before'->>'pipeline_id'=OLD.pipeline_id::text;
      IF (pair IS NOT NULL AND NEW.pipeline_id=OLD.pipeline_id AND OLD.generation=c.generation
        AND NEW.generation=(p.command->>'generationTo')::bigint
        AND OLD.policy=(pair->'before'->>'capability_policy_json')::jsonb
        AND OLD.fingerprint=pair->'before'->>'capability_policy_fingerprint'
        AND NEW.policy=(pair->'after'->>'capability_policy_json')::jsonb
        AND NEW.fingerprint=pair->'after'->>'capability_policy_fingerprint'
        AND p.approval_envelope IS NOT NULL AND p.approval_readback IS NOT NULL
        AND p.native_receipt->>'state'='committed' AND p.native_receipt->>'version'='2'
        AND p.native_receipt->>'commandHash'=p.command_hash
        AND p.native_receipt->'result'->>'afterBindingsFingerprint'=p.command->>'afterBindingsFingerprint') IS TRUE THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Native capability update differs from exact committed phase' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.crm_native_email_publication_control install_control WHERE install_control.singleton AND NOT install_control.enabled
    AND install_control.generation=NEW.generation AND install_control.active_operation_id IS NULL AND install_control.active_transition_id IS NULL) THEN
    RAISE EXCEPTION 'Native capability policy generation differs from reviewed install scope' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_capability_policy_generation BEFORE INSERT OR UPDATE ON crm_native_email_capability_policies
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_policy_generation();

-- No enrollment, downgrade or unrelated policy rewrite during a transition.
-- V2 commands include every installed policy and preserve nullable mode.
CREATE FUNCTION clawpilot_native_email_capability_transition_hold() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.crm_native_email_authority_transitions; pair jsonb; row public.crm_native_email_capability_policies; n integer;
BEGIN
  IF NEW.active_transition_id IS NOT NULL AND NEW.active_transition_id IS DISTINCT FROM OLD.active_transition_id THEN
    SELECT * INTO t FROM public.crm_native_email_authority_transitions WHERE transition_id=NEW.active_transition_id;
    IF t.plan->'revoke'->>'version'='1' THEN
      IF EXISTS(SELECT 1 FROM public.crm_native_email_capability_policies) THEN
        RAISE EXCEPTION 'Native v2 policies require an exact v2 transition' USING ERRCODE='55000'; END IF;
      RETURN NEW;
    END IF;
    IF NOT (t.plan->'revoke'->>'version'='2' AND t.plan->'grant'->>'version'='2') IS TRUE THEN
      RAISE EXCEPTION 'Native capability transition version invalid' USING ERRCODE='55000'; END IF;
    n:=0;
    FOR pair IN SELECT value FROM jsonb_array_elements(t.plan->'revoke'->'bindings') LOOP
      IF pair->'before'->>'capability_policy_json' IS NOT NULL THEN
        n:=n+1;
        SELECT * INTO row FROM public.crm_native_email_capability_policies WHERE pipeline_id=(pair->'before'->>'pipeline_id')::uuid;
        IF NOT (FOUND AND row.generation=NEW.generation AND row.policy=(pair->'before'->>'capability_policy_json')::jsonb
          AND row.fingerprint=pair->'before'->>'capability_policy_fingerprint') IS TRUE THEN
          RAISE EXCEPTION 'Native capability transition preimage differs' USING ERRCODE='55000'; END IF;
      END IF;
    END LOOP;
    IF n<>(SELECT count(*) FROM public.crm_native_email_capability_policies) THEN
      RAISE EXCEPTION 'Native capability transition inventory differs' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_capability_transition_hold BEFORE UPDATE OF active_transition_id ON crm_native_email_publication_control
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_transition_hold();

-- A receipt, all policy postimages and global generation commit together.
-- This also rejects settling only the receipt, partial updates, or advancing
-- control without the policies. No session flag or caller bypass is used.
CREATE FUNCTION clawpilot_native_email_capability_phase_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public.crm_native_email_publication_control; p public.crm_native_email_authority_phases; pair jsonb; row public.crm_native_email_capability_policies; n integer;
BEGIN
  SELECT * INTO c FROM public.crm_native_email_publication_control WHERE singleton;
  IF NOT c.enabled THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.crm_native_email_authority_phases x WHERE x.transition_id=c.active_transition_id
    AND x.state='committed' AND x.command->>'version'='2' AND (x.command->>'generationFrom')::bigint=c.generation) THEN
    RAISE EXCEPTION 'Native capability phase receipt was not atomically settled' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM public.crm_native_email_authority_phases
    WHERE state='committed' AND command->>'version'='2' AND (command->>'generationTo')::bigint=c.generation
      AND command->>'afterPolicyFingerprint'=c.native_policy_fingerprint AND receipt_hash=c.activation_receipt_hash;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  n:=0;
  FOR pair IN SELECT value FROM jsonb_array_elements(p.command->'bindings') LOOP
    IF pair->'after'->>'capability_policy_json' IS NOT NULL THEN
      n:=n+1;
      SELECT * INTO row FROM public.crm_native_email_capability_policies WHERE pipeline_id=(pair->'after'->>'pipeline_id')::uuid;
      IF NOT (FOUND AND row.generation=c.generation AND row.policy=(pair->'after'->>'capability_policy_json')::jsonb
        AND row.fingerprint=pair->'after'->>'capability_policy_fingerprint') IS TRUE THEN
        RAISE EXCEPTION 'Native capability phase postimages incomplete' USING ERRCODE='55000'; END IF;
    END IF;
  END LOOP;
  IF n<>(SELECT count(*) FROM public.crm_native_email_capability_policies) THEN
    RAISE EXCEPTION 'Native capability phase policy inventory incomplete' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crm_native_capability_phase_complete AFTER INSERT OR UPDATE ON crm_native_email_authority_phases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_phase_complete();
CREATE CONSTRAINT TRIGGER crm_native_capability_rows_complete AFTER INSERT OR UPDATE ON crm_native_email_capability_policies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_phase_complete();
CREATE CONSTRAINT TRIGGER crm_native_capability_control_complete AFTER UPDATE ON crm_native_email_publication_control
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_capability_phase_complete();
