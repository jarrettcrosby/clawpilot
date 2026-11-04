-- Installed disabled. Neither migration nor application startup activates this
-- protocol. Activation needs an independently approved native policy receipt.
-- No pending admission expires or unlocks itself: unknown native outcomes are
-- reconciled by an exact committed receipt or a terminal cancellation tombstone.
CREATE TABLE crm_native_email_publication_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 9007199254740991),
  verified_generation bigint,
  native_policy_fingerprint text CHECK (native_policy_fingerprint ~ '^[a-f0-9]{64}$'),
  activation_receipt_hash text CHECK (activation_receipt_hash ~ '^[a-f0-9]{64}$'),
  active_operation_id text CHECK (active_operation_id ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR (verified_generation IS NOT NULL AND verified_generation = generation AND native_policy_fingerprint IS NOT NULL AND activation_receipt_hash IS NOT NULL)),
  CHECK (enabled OR active_operation_id IS NULL)
);
INSERT INTO crm_native_email_publication_control(singleton) VALUES (true);

CREATE TABLE crm_native_email_publication_admissions (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  local_id uuid NOT NULL,
  native_id text NOT NULL CHECK (native_id ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$'),
  global_id text NOT NULL CHECK (global_id ~ '^gi([0-9]{7}|[0-9a-v]{12})$'),
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  native_policy_fingerprint text NOT NULL CHECK (native_policy_fingerprint ~ '^[a-f0-9]{64}$'),
  command_hash text NOT NULL CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  audience_fingerprint text NOT NULL CHECK (audience_fingerprint ~ '^[a-f0-9]{64}$'),
  command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object' AND octet_length(command::text) <= 800000),
  allowed_reader_ids jsonb NOT NULL CHECK (jsonb_typeof(allowed_reader_ids) = 'array'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'admitted' CHECK (state IN ('admitted','dispatched','unknown','committed','cancelled')),
  native_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state IN ('committed','cancelled')) = (native_receipt IS NOT NULL)),
  CHECK (native_receipt IS NULL OR (
    jsonb_typeof(native_receipt) = 'object'
    AND native_receipt->>'version' = '1'
    AND native_receipt->>'state' = state
    AND native_receipt->>'operationId' = operation_id::text
    AND native_receipt->>'commandHash' = command_hash
    AND (CASE WHEN state = 'cancelled' THEN native_receipt->'result' = 'null'::jsonb ELSE
      jsonb_typeof(native_receipt->'result') = 'object'
      AND native_receipt->'result'->>'suiteCrmId' = native_id
      AND native_receipt->'result'->>'globalId' = global_id
      AND native_receipt->'result'->>'pipelineId' = pipeline_id::text
      AND native_receipt->'result'->>'audienceFingerprint' = audience_fingerprint
      AND native_receipt->'result'->>'generation' = generation::text
      AND native_receipt->'result'->'readerSuiteCrmUserIds' = allowed_reader_ids END)
  ) IS TRUE)
);
ALTER TABLE crm_native_email_publication_control ADD CONSTRAINT crm_native_email_active_operation_fkey
  FOREIGN KEY (active_operation_id) REFERENCES crm_native_email_publication_admissions(operation_id) ON DELETE RESTRICT;

CREATE FUNCTION clawpilot_native_email_control_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE active_state text;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Native Email publication control cannot be removed' USING ERRCODE = '55000';
  END IF;
  IF OLD.enabled AND NOT NEW.enabled THEN
    RAISE EXCEPTION 'Native Email authority cannot be disabled without a native-first transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.enabled AND NEW.enabled AND
    (NEW.generation, NEW.verified_generation, NEW.native_policy_fingerprint, NEW.activation_receipt_hash)
    IS DISTINCT FROM (OLD.generation, OLD.verified_generation, OLD.native_policy_fingerprint, OLD.activation_receipt_hash) THEN
    RAISE EXCEPTION 'Native Email policy changes require an explicit native-first transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id THEN
    SELECT state INTO active_state FROM public.crm_native_email_publication_admissions WHERE operation_id = OLD.active_operation_id;
    IF active_state IS NULL OR active_state NOT IN ('committed','cancelled') THEN
      RAISE EXCEPTION 'Unresolved native Email publication must retain its admission' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.active_operation_id IS NOT NULL AND NEW.active_operation_id IS DISTINCT FROM OLD.active_operation_id THEN
    IF NOT NEW.enabled OR NOT EXISTS (
      SELECT 1 FROM public.crm_native_email_publication_admissions a
      WHERE a.operation_id = NEW.active_operation_id AND a.state = 'admitted'
        AND a.generation = NEW.generation AND a.native_policy_fingerprint = NEW.native_policy_fingerprint
    ) THEN
      RAISE EXCEPTION 'Native Email admission does not match the active policy generation' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_email_control_guard BEFORE UPDATE OR DELETE ON crm_native_email_publication_control
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_control_guard();
CREATE TRIGGER crm_native_email_control_truncate_guard BEFORE TRUNCATE ON crm_native_email_publication_control
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_control_guard();

CREATE FUNCTION clawpilot_native_email_admission_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Native Email admission evidence cannot be removed' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','native_receipt','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['state','native_receipt','updated_at'])
     OR OLD.state IN ('committed','cancelled')
     OR (OLD.state = 'dispatched' AND NEW.state = 'admitted')
     OR (OLD.state = 'unknown' AND NEW.state IN ('admitted','dispatched')) THEN
    RAISE EXCEPTION 'Native Email admission identity or terminal state is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crm_native_email_admission_immutable BEFORE UPDATE OR DELETE ON crm_native_email_publication_admissions
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_admission_immutable();
CREATE TRIGGER crm_native_email_admission_truncate_guard BEFORE TRUNCATE ON crm_native_email_publication_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_admission_immutable();

-- Acquire the same singleton before actual authority statements. UPDATE OF
-- below excludes ordinary login/profile/projection/provisioning timestamps:
-- those do not affect a reader and must not globally serialize on this row.
-- Transactions that prelock authority rows must explicitly lock control first.
-- Do not hold a transaction over provider I/O; durable admission is the barrier.
CREATE FUNCTION clawpilot_native_email_authority_statement_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE active boolean;
BEGIN
  SELECT enabled INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native Email authority control missing' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'TRUNCATE' THEN
    IF active THEN RAISE EXCEPTION 'Native Email authority is frozen pending native-first policy transition' USING ERRCODE = '55000'; END IF;
    UPDATE public.crm_native_email_publication_control SET generation = generation + 1,
      verified_generation = NULL, native_policy_fingerprint = NULL, activation_receipt_hash = NULL, updated_at = now() WHERE singleton;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION clawpilot_native_email_authority_row_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE old_row jsonb; new_row jsonb; keys text[]; key text; changed boolean := TG_OP <> 'UPDATE'; active boolean;
BEGIN
  old_row := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  keys := CASE TG_TABLE_NAME
    WHEN 'pipeline_spaces' THEN ARRAY['id','owner_email','workspace_organization_id','reference_access_disabled']
    WHEN 'pipeline_space_members' THEN ARRAY['pipeline_id','user_email','access_role']
    WHEN 'app_user_organization_memberships' THEN ARRAY['user_email','organization_id','status','role','permissions','trashed_at']
    WHEN 'app_users' THEN ARRAY['email','status','suitecrm_user_id','role','permissions','organization_id']
    ELSE NULL END;
  IF keys IS NULL THEN RAISE EXCEPTION 'Unknown native Email authority source' USING ERRCODE = '55000'; END IF;
  FOREACH key IN ARRAY keys LOOP changed := changed OR ((old_row->key) IS DISTINCT FROM (new_row->key)); END LOOP;
  IF NOT changed THEN RETURN NEW; END IF;
  SELECT enabled INTO active FROM public.crm_native_email_publication_control WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Native Email authority control missing' USING ERRCODE = '55000'; END IF;
  -- Deliberately conservative initial mode: no audience change, including a
  -- revocation, commits while historical native access could remain. There is
  -- no GUC bypass and no background/eventual-sync promise. A separate exact
  -- native-first membership transition protocol is required to lift this hold.
  IF active THEN RAISE EXCEPTION 'Native Email authority is frozen pending native-first policy transition' USING ERRCODE = '55000'; END IF;
  UPDATE public.crm_native_email_publication_control SET generation = generation + 1,
    verified_generation = NULL, native_policy_fingerprint = NULL, activation_receipt_hash = NULL, updated_at = now() WHERE singleton;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER crm_native_email_pipeline_statement BEFORE INSERT OR DELETE OR TRUNCATE ON pipeline_spaces
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_pipeline_update_statement
  BEFORE UPDATE OF id, owner_email, workspace_organization_id, reference_access_disabled ON pipeline_spaces
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_pipeline_authority AFTER INSERT OR UPDATE OR DELETE ON pipeline_spaces
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_authority_row_guard();
CREATE TRIGGER crm_native_email_member_statement BEFORE INSERT OR DELETE OR TRUNCATE ON pipeline_space_members
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_member_update_statement
  BEFORE UPDATE OF pipeline_id, user_email, access_role ON pipeline_space_members
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_member_authority AFTER INSERT OR UPDATE OR DELETE ON pipeline_space_members
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_authority_row_guard();
CREATE TRIGGER crm_native_email_workspace_member_statement BEFORE INSERT OR DELETE OR TRUNCATE ON app_user_organization_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_workspace_member_update_statement
  BEFORE UPDATE OF user_email, organization_id, status, role, permissions, trashed_at ON app_user_organization_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_workspace_member_authority AFTER INSERT OR UPDATE OR DELETE ON app_user_organization_memberships
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_authority_row_guard();
CREATE TRIGGER crm_native_email_user_statement BEFORE INSERT OR DELETE OR TRUNCATE ON app_users
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_user_update_statement
  BEFORE UPDATE OF email, status, suitecrm_user_id, role, permissions, organization_id ON app_users
  FOR EACH STATEMENT EXECUTE FUNCTION clawpilot_native_email_authority_statement_lock();
CREATE TRIGGER crm_native_email_user_authority AFTER INSERT OR UPDATE OR DELETE ON app_users
  FOR EACH ROW EXECUTE FUNCTION clawpilot_native_email_authority_row_guard();
