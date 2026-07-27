-- Server-owned, resumable pagination for bounded commerce order intake.
--
-- Provider cursors are encrypted at rest and are never API identifiers. The
-- browser continues with the Global ID of the source intake run while this
-- table resolves that handle to one tenant-scoped provider cursor. These rows
-- are deliberately independent from operations_commerce_sync_cursors: held
-- intake must not advance a durable provider synchronization checkpoint.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  (
    'gcrj',
    'operations.commerce_intake_rejection',
    'Commerce intake rejection'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Faire can report signed available inventory. Preserve that source evidence
-- within the already-deployed numeric(20,6) column boundary.
ALTER TABLE operations_commerce_product_candidates
  DROP CONSTRAINT IF EXISTS commerce_product_candidates_quantity_valid,
  ADD CONSTRAINT commerce_product_candidates_quantity_valid CHECK (
    inventory_quantity IS NULL
    OR inventory_quantity BETWEEN
      -99999999999999.999999 AND 99999999999999.999999
  );

CREATE TABLE IF NOT EXISTS operations_commerce_intake_read_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  resource text NOT NULL CHECK (resource IN ('orders', 'products')),
  intake_action text NOT NULL CHECK (intake_action IN (
    'fetch', 'fetch-next', 'refresh', 'retry-rejection',
    'fetch-products', 'fetch-next-products'
  )),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  target_kind text NOT NULL CHECK (target_kind IN (
    'none', 'candidate', 'rejection', 'continuation'
  )),
  target_global_id text,
  target_source_hash text,
  target_external_id_hash text,
  continuation_id uuid,
  continuation_cursor_hash text,
  continuation_row_version bigint,
  session_id uuid NOT NULL,
  batch_number integer NOT NULL DEFAULT 1 CHECK (batch_number > 0),
  window_start timestamptz,
  window_end timestamptz NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  intent_state text NOT NULL DEFAULT 'prepared'
    CHECK (intent_state IN (
      'prepared', 'reading', 'captured', 'staged', 'uncertain', 'expired'
    )),
  provider_attempt_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  response_ciphertext bytea,
  response_iv bytea,
  response_tag bytea,
  response_hash text,
  response_bytes integer,
  response_encryption_version integer,
  last_error_code text,
  staged_run_id uuid,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_intake_read_intents_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_read_intents_pipeline_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_read_intents_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, staged_run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_read_intents_attempt_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, provider_attempt_id
    )
    REFERENCES operations_commerce_provider_attempts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_read_intents_idempotency_unique
    UNIQUE (
      organization_id, integration_account_id, intake_action, idempotency_key
    ),
  CONSTRAINT commerce_intake_read_intents_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_read_intents_target_valid CHECK (
    (
      target_kind = 'none'
      AND target_global_id IS NULL
      AND target_source_hash IS NULL
      AND target_external_id_hash IS NULL
      AND continuation_id IS NULL
      AND continuation_cursor_hash IS NULL
      AND continuation_row_version IS NULL
    )
    OR (
      target_kind = 'candidate'
      AND target_global_id IS NOT NULL
      AND target_global_id ~ '^gcoc[0-9]{7}$'
      AND target_source_hash IS NOT NULL
      AND target_source_hash ~ '^[a-f0-9]{64}$'
      AND target_external_id_hash IS NOT NULL
      AND target_external_id_hash ~ '^[a-f0-9]{64}$'
      AND continuation_id IS NULL
      AND continuation_cursor_hash IS NULL
      AND continuation_row_version IS NULL
    )
    OR (
      target_kind = 'rejection'
      AND target_global_id IS NOT NULL
      AND target_global_id ~ '^gcrj[0-9]{7}$'
      AND target_source_hash IS NOT NULL
      AND target_source_hash ~ '^[a-f0-9]{64}$'
      AND target_external_id_hash IS NOT NULL
      AND target_external_id_hash ~ '^[a-f0-9]{64}$'
      AND continuation_id IS NULL
      AND continuation_cursor_hash IS NULL
      AND continuation_row_version IS NULL
    )
    OR (
      target_kind = 'continuation'
      AND target_global_id IS NOT NULL
      AND target_global_id ~ '^gcir[0-9]{7}$'
      AND target_source_hash IS NULL
      AND target_external_id_hash IS NULL
      AND continuation_id IS NOT NULL
      AND continuation_cursor_hash IS NOT NULL
      AND continuation_cursor_hash ~ '^[a-f0-9]{64}$'
      AND continuation_row_version IS NOT NULL
      AND continuation_row_version >= 0
    )
  ),
  CONSTRAINT commerce_intake_read_intents_action_target_valid CHECK (
    (intake_action IN ('fetch', 'fetch-products') AND target_kind = 'none')
    OR (intake_action = 'refresh' AND target_kind = 'candidate')
    OR (
      intake_action = 'retry-rejection'
      AND target_kind = 'rejection'
    )
    OR (
      intake_action IN ('fetch-next', 'fetch-next-products')
      AND target_kind = 'continuation'
    )
  ),
  CONSTRAINT commerce_intake_read_intents_resource_action_valid CHECK (
    (
      resource = 'orders'
      AND intake_action IN (
        'fetch', 'fetch-next', 'refresh', 'retry-rejection'
      )
    )
    OR (
      resource = 'products'
      AND intake_action IN ('fetch-products', 'fetch-next-products')
    )
  ),
  CONSTRAINT commerce_intake_read_intents_batch_valid CHECK (
    (
      target_kind <> 'continuation'
      AND batch_number = 1
    )
    OR (
      target_kind = 'continuation'
      AND batch_number >= 2
    )
  ),
  CONSTRAINT commerce_intake_read_intents_window_valid CHECK (
    window_start IS NULL OR window_start <= window_end
  ),
  CONSTRAINT commerce_intake_read_intents_lease_valid CHECK (
    (
      lease_token IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT commerce_intake_read_intents_response_valid CHECK (
    (
      response_ciphertext IS NULL
      AND response_iv IS NULL
      AND response_tag IS NULL
      AND response_hash IS NULL
      AND response_bytes IS NULL
      AND response_encryption_version IS NULL
    )
    OR (
      response_ciphertext IS NOT NULL
      AND octet_length(response_ciphertext) BETWEEN 2 AND 8388608
      AND response_iv IS NOT NULL
      AND octet_length(response_iv) = 12
      AND response_tag IS NOT NULL
      AND octet_length(response_tag) = 16
      AND response_hash IS NOT NULL
      AND response_hash ~ '^[a-f0-9]{64}$'
      AND response_bytes BETWEEN 2 AND 8388608
      AND response_encryption_version = 1
    )
  ),
  CONSTRAINT commerce_intake_read_intents_error_valid CHECK (
    last_error_code IS NULL
    OR (
      length(btrim(last_error_code)) BETWEEN 2 AND 128
      AND last_error_code ~ '^[A-Z][A-Z0-9_]+$'
    )
  ),
  CONSTRAINT commerce_intake_read_intents_state_valid CHECK (
    (
      intent_state = 'prepared'
      AND provider_attempt_id IS NULL
      AND lease_token IS NULL
      AND response_ciphertext IS NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'reading'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND response_ciphertext IS NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'captured'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_ciphertext IS NOT NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'staged'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_ciphertext IS NOT NULL
      AND last_error_code IS NULL
      AND staged_run_id IS NOT NULL
    )
    OR (
      intent_state = 'uncertain'
      AND provider_attempt_id IS NOT NULL
      AND lease_token IS NULL
      AND response_ciphertext IS NULL
      AND last_error_code IS NOT NULL
      AND staged_run_id IS NULL
    )
    OR (
      intent_state = 'expired'
      AND lease_token IS NULL
      AND (
        response_ciphertext IS NULL
        OR (
          provider_attempt_id IS NOT NULL
          AND response_ciphertext IS NOT NULL
        )
      )
      AND staged_run_id IS NULL
    )
  ),
  CONSTRAINT commerce_intake_read_intents_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_intake_read_intents_expiry_idx
  ON operations_commerce_intake_read_intents (expires_at, id)
  WHERE intent_state IN ('prepared', 'reading', 'captured');

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_read_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_action text;
  attempt_idempotency_key text;
  attempt_request_hash text;
  attempt_state text;
  attempt_lease_token uuid;
  attempt_lease_expires_at timestamptz;
  run_provider text;
  run_resource text;
  run_credential_version integer;
  run_idempotency_key text;
  run_provider_attempt_id uuid;
  run_window_start timestamptz;
  run_window_end timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.intent_state <> 'prepared'
       OR NEW.provider_attempt_id IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.response_ciphertext IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.staged_run_id IS NOT NULL
       OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION
        'Commerce intake read intent must begin prepared at row version zero';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.provider,
    NEW.resource,
    NEW.intake_action,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.credential_version,
    NEW.target_kind,
    NEW.target_global_id,
    NEW.target_source_hash,
    NEW.target_external_id_hash,
    NEW.continuation_id,
    NEW.continuation_cursor_hash,
    NEW.continuation_row_version,
    NEW.session_id,
    NEW.batch_number,
    NEW.window_start,
    NEW.window_end,
    NEW.query_hash,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.provider,
    OLD.resource,
    OLD.intake_action,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.credential_version,
    OLD.target_kind,
    OLD.target_global_id,
    OLD.target_source_hash,
    OLD.target_external_id_hash,
    OLD.continuation_id,
    OLD.continuation_cursor_hash,
    OLD.continuation_row_version,
    OLD.session_id,
    OLD.batch_number,
    OLD.window_start,
    OLD.window_end,
    OLD.query_hash,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce intake read intent identity is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce intake read intent update requires the next row version';
  END IF;
  IF OLD.provider_attempt_id IS NOT NULL
     AND NEW.provider_attempt_id IS DISTINCT FROM OLD.provider_attempt_id THEN
    RAISE EXCEPTION
      'Commerce intake read intent provider attempt is immutable once reserved';
  END IF;
  IF OLD.response_ciphertext IS NOT NULL
     AND ROW(
       NEW.response_ciphertext,
       NEW.response_iv,
       NEW.response_tag,
       NEW.response_hash,
       NEW.response_bytes,
       NEW.response_encryption_version
     ) IS DISTINCT FROM ROW(
       OLD.response_ciphertext,
       OLD.response_iv,
       OLD.response_tag,
       OLD.response_hash,
       OLD.response_bytes,
       OLD.response_encryption_version
     ) THEN
    RAISE EXCEPTION
      'Captured commerce intake response evidence is immutable';
  END IF;
  IF NOT (
    (
      OLD.intent_state = 'prepared'
      AND NEW.intent_state IN ('reading', 'expired')
    )
    OR (
      OLD.intent_state = 'reading'
      AND NEW.intent_state IN ('captured', 'uncertain')
    )
    OR (
      OLD.intent_state = 'captured'
      AND NEW.intent_state IN ('staged', 'expired')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid commerce intake read intent transition';
  END IF;
  IF NEW.intent_state = 'reading' THEN
    SELECT
      attempt.action,
      attempt.idempotency_key,
      attempt.request_hash,
      attempt.state,
      attempt.lease_token,
      attempt.lease_expires_at
    INTO
      attempt_action,
      attempt_idempotency_key,
      attempt_request_hash,
      attempt_state,
      attempt_lease_token,
      attempt_lease_expires_at
    FROM operations_commerce_provider_attempts AS attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.id = NEW.provider_attempt_id;
    IF NOT FOUND
       OR attempt_action <> 'commerce.intake.read'
       OR attempt_idempotency_key <> NEW.idempotency_key
       OR attempt_request_hash <> NEW.request_hash
       OR attempt_state <> 'prepared'
       OR attempt_lease_token IS DISTINCT FROM NEW.lease_token
       OR attempt_lease_expires_at IS DISTINCT FROM NEW.lease_expires_at THEN
      RAISE EXCEPTION
        'Commerce intake reading lease must match its prepared provider attempt';
    END IF;
  END IF;
  IF NEW.intent_state IN ('captured', 'uncertain') THEN
    SELECT attempt.state
    INTO attempt_state
    FROM operations_commerce_provider_attempts AS attempt
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.id = NEW.provider_attempt_id;
    IF NOT FOUND
       OR (
         NEW.intent_state = 'captured'
         AND attempt_state <> 'succeeded'
       )
       OR (
         NEW.intent_state = 'uncertain'
         AND attempt_state <> 'unknown'
       ) THEN
      RAISE EXCEPTION
        'Commerce intake read outcome must match its provider attempt';
    END IF;
  END IF;
  IF NEW.intent_state = 'staged' THEN
    SELECT
      run.provider,
      run.resource,
      run.credential_version,
      run.idempotency_key,
      run.provider_attempt_id,
      run.window_start,
      run.window_end
    INTO
      run_provider,
      run_resource,
      run_credential_version,
      run_idempotency_key,
      run_provider_attempt_id,
      run_window_start,
      run_window_end
    FROM operations_commerce_intake_runs AS run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.pipeline_id = NEW.pipeline_id
      AND run.id = NEW.staged_run_id;
    IF NOT FOUND
       OR run_provider <> NEW.provider
       OR run_credential_version <> NEW.credential_version
       OR run_idempotency_key <> NEW.idempotency_key
       OR run_provider_attempt_id IS DISTINCT FROM NEW.provider_attempt_id
       OR run_window_start IS DISTINCT FROM NEW.window_start
       OR run_window_end IS DISTINCT FROM NEW.window_end
       OR (
         NEW.resource = 'orders'
         AND run_resource <> 'products_and_orders'
       )
       OR (
         NEW.resource = 'products'
         AND run_resource <> 'products'
       ) THEN
      RAISE EXCEPTION
        'Commerce intake staged run must match its provider-read intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_intake_read_intent
  ON operations_commerce_intake_read_intents;
CREATE TRIGGER protect_operations_commerce_intake_read_intent
BEFORE INSERT OR UPDATE ON operations_commerce_intake_read_intents
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_intake_read_intent();

CREATE TABLE IF NOT EXISTS operations_commerce_intake_continuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  previous_run_id uuid,
  consumed_by_run_id uuid,
  session_id uuid NOT NULL,
  batch_number integer NOT NULL CHECK (batch_number > 0),
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  resource text NOT NULL DEFAULT 'orders'
    CHECK (resource IN ('orders', 'products')),
  intake_mode text NOT NULL DEFAULT 'operational'
    CHECK (intake_mode = 'operational'),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  window_start timestamptz,
  window_end timestamptz NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  cursor_state text NOT NULL
    CHECK (cursor_state IN (
      'available', 'consumed', 'exhausted', 'invalid', 'expired', 'superseded'
    )),
  cursor_ciphertext bytea,
  cursor_iv bytea,
  cursor_tag bytea,
  cursor_hash text,
  encryption_version integer,
  provider_rows_seen integer NOT NULL DEFAULT 0
    CHECK (provider_rows_seen >= 0),
  eligible_orders_seen integer NOT NULL DEFAULT 0
    CHECK (
      eligible_orders_seen >= 0
      AND eligible_orders_seen <= provider_rows_seen
    ),
  consumed_idempotency_key text,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_intake_continuations_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT commerce_intake_continuations_previous_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, previous_run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_continuations_consumed_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, consumed_by_run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_continuations_run_unique
    UNIQUE (organization_id, integration_account_id, run_id),
  CONSTRAINT commerce_intake_continuations_session_batch_unique
    UNIQUE (
      organization_id, integration_account_id, session_id, batch_number
    ),
  CONSTRAINT commerce_intake_continuations_window_valid CHECK (
    window_start IS NULL OR window_start <= window_end
  ),
  CONSTRAINT commerce_intake_continuations_cursor_valid CHECK (
    (
      cursor_state = 'available'
      AND cursor_ciphertext IS NOT NULL
      AND octet_length(cursor_ciphertext) BETWEEN 2 AND 8192
      AND cursor_iv IS NOT NULL
      AND octet_length(cursor_iv) = 12
      AND cursor_tag IS NOT NULL
      AND octet_length(cursor_tag) = 16
      AND cursor_hash IS NOT NULL
      AND cursor_hash ~ '^[a-f0-9]{64}$'
      AND encryption_version = 1
    )
    OR (
      cursor_state <> 'available'
      AND cursor_ciphertext IS NULL
      AND cursor_iv IS NULL
      AND cursor_tag IS NULL
      AND cursor_hash IS NULL
      AND encryption_version IS NULL
    )
  ),
  CONSTRAINT commerce_intake_continuations_consumption_valid CHECK (
    (
      cursor_state = 'consumed'
      AND consumed_by_run_id IS NOT NULL
      AND consumed_idempotency_key IS NOT NULL
      AND length(btrim(consumed_idempotency_key)) BETWEEN 1 AND 255
      AND consumed_idempotency_key !~ '[[:cntrl:]]'
    )
    OR (
      cursor_state <> 'consumed'
      AND consumed_by_run_id IS NULL
      AND consumed_idempotency_key IS NULL
    )
  ),
  CONSTRAINT commerce_intake_continuations_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_intake_continuations_active_idx
  ON operations_commerce_intake_continuations (
    organization_id, integration_account_id, created_at DESC, id
  )
  WHERE cursor_state IN ('available', 'exhausted', 'invalid', 'expired');

CREATE INDEX IF NOT EXISTS commerce_intake_continuations_expiry_idx
  ON operations_commerce_intake_continuations (expires_at, id)
  WHERE cursor_state = 'available';

CREATE UNIQUE INDEX IF NOT EXISTS
  commerce_intake_continuations_scope_id_unique
  ON operations_commerce_intake_continuations (
    organization_id, integration_account_id, pipeline_id, id
  );

ALTER TABLE operations_commerce_intake_read_intents
  ADD CONSTRAINT commerce_intake_read_intents_continuation_fkey
  FOREIGN KEY (
    organization_id, integration_account_id, pipeline_id, continuation_id
  )
  REFERENCES operations_commerce_intake_continuations(
    organization_id, integration_account_id, pipeline_id, id
  ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  commerce_intake_read_intents_active_continuation_unique
  ON operations_commerce_intake_read_intents (
    organization_id, integration_account_id, continuation_id
  )
  WHERE continuation_id IS NOT NULL
    AND intent_state IN ('prepared', 'reading', 'captured');

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_continuation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_provider text;
  run_resource text;
  run_credential_version integer;
  run_window_start timestamptz;
  run_window_end timestamptz;
  previous_session uuid;
  previous_batch integer;
  previous_state text;
  previous_consumed_by_run_id uuid;
  previous_provider text;
  previous_resource text;
  previous_intake_mode text;
  previous_credential_version integer;
  previous_window_start timestamptz;
  previous_window_end timestamptz;
  previous_query_hash text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cursor_state NOT IN ('available', 'exhausted')
       OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION
        'Commerce intake continuation must begin available or exhausted at row version zero';
    END IF;
    SELECT run.provider, run.resource, run.credential_version,
           run.window_start, run.window_end
    INTO run_provider, run_resource, run_credential_version,
         run_window_start, run_window_end
    FROM operations_commerce_intake_runs AS run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.pipeline_id = NEW.pipeline_id
      AND run.id = NEW.run_id;

    IF NOT FOUND
       OR run_provider <> NEW.provider
       OR (
         NEW.resource = 'orders'
         AND run_resource <> 'products_and_orders'
       )
       OR (
         NEW.resource = 'products'
         AND run_resource <> 'products'
       )
       OR run_credential_version <> NEW.credential_version
       OR run_window_start IS DISTINCT FROM NEW.window_start
       OR run_window_end IS DISTINCT FROM NEW.window_end THEN
      RAISE EXCEPTION
        'Commerce intake continuation must match its tenant run';
    END IF;

    IF NEW.previous_run_id IS NULL THEN
      IF NEW.batch_number <> 1 THEN
        RAISE EXCEPTION
          'Initial commerce intake continuation must be batch one';
      END IF;
    ELSE
      SELECT previous.session_id, previous.batch_number,
             previous.cursor_state, previous.consumed_by_run_id,
             previous.provider, previous.resource, previous.intake_mode,
             previous.credential_version, previous.window_start,
             previous.window_end, previous.query_hash
      INTO previous_session, previous_batch,
           previous_state, previous_consumed_by_run_id,
           previous_provider, previous_resource, previous_intake_mode,
           previous_credential_version, previous_window_start,
           previous_window_end, previous_query_hash
      FROM operations_commerce_intake_continuations AS previous
      WHERE previous.organization_id = NEW.organization_id
        AND previous.integration_account_id = NEW.integration_account_id
        AND previous.pipeline_id = NEW.pipeline_id
        AND previous.run_id = NEW.previous_run_id;
      IF NOT FOUND
         OR previous_session <> NEW.session_id
         OR previous_batch + 1 <> NEW.batch_number
         OR previous_state <> 'consumed'
         OR previous_consumed_by_run_id <> NEW.run_id
         OR previous_provider <> NEW.provider
         OR previous_resource <> NEW.resource
         OR previous_intake_mode <> NEW.intake_mode
         OR previous_credential_version <> NEW.credential_version
         OR previous_window_start IS DISTINCT FROM NEW.window_start
         OR previous_window_end IS DISTINCT FROM NEW.window_end
         OR previous_query_hash <> NEW.query_hash THEN
        RAISE EXCEPTION
          'Commerce intake continuation batch lineage is invalid';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.run_id,
    NEW.previous_run_id,
    NEW.session_id,
    NEW.batch_number,
    NEW.provider,
    NEW.resource,
    NEW.intake_mode,
    NEW.credential_version,
    NEW.window_start,
    NEW.window_end,
    NEW.query_hash,
    NEW.provider_rows_seen,
    NEW.eligible_orders_seen,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.run_id,
    OLD.previous_run_id,
    OLD.session_id,
    OLD.batch_number,
    OLD.provider,
    OLD.resource,
    OLD.intake_mode,
    OLD.credential_version,
    OLD.window_start,
    OLD.window_end,
    OLD.query_hash,
    OLD.provider_rows_seen,
    OLD.eligible_orders_seen,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce intake continuation identity is immutable';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce intake continuation update requires the next row version';
  END IF;

  IF OLD.cursor_state <> 'available'
     OR NEW.cursor_state NOT IN (
       'consumed', 'invalid', 'expired', 'superseded'
     ) THEN
    RAISE EXCEPTION 'Invalid commerce intake continuation transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_intake_continuation
  ON operations_commerce_intake_continuations;
CREATE TRIGGER protect_operations_commerce_intake_continuation
BEFORE INSERT OR UPDATE ON operations_commerce_intake_continuations
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_intake_continuation();

COMMENT ON TABLE operations_commerce_intake_continuations IS
  'Encrypted server-only next-page state for bounded read-only commerce intake; never a durable provider sync cursor.';

CREATE TABLE IF NOT EXISTS operations_commerce_intake_rejections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcrj'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  resource_type text NOT NULL CHECK (resource_type IN ('order', 'product')),
  external_id text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  error_code text NOT NULL,
  safe_message text NOT NULL,
  disposition text NOT NULL DEFAULT 'open'
    CHECK (disposition IN (
      'open', 'retried', 'excluded', 'superseded'
    )),
  retry_run_id uuid,
  exclusion_reason text,
  disposition_receipt_id uuid,
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT commerce_intake_rejections_global_valid
    CHECK (global_id ~ '^gcrj[0-9]{7}$'),
  CONSTRAINT commerce_intake_rejections_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_intake_rejections_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_rejections_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT commerce_intake_rejections_retry_run_fkey
    FOREIGN KEY (
      organization_id, integration_account_id, pipeline_id, retry_run_id
    )
    REFERENCES operations_commerce_intake_runs(
      organization_id, integration_account_id, pipeline_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_rejections_receipt_fkey
    FOREIGN KEY (organization_id, disposition_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_intake_rejections_run_identity_unique
    UNIQUE (
      organization_id, integration_account_id, run_id,
      resource_type, external_id, source_hash
    ),
  CONSTRAINT commerce_intake_rejections_external_id_valid CHECK (
    length(btrim(external_id)) BETWEEN 1 AND 512
    AND external_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_rejections_error_valid CHECK (
    error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
    AND length(btrim(safe_message)) BETWEEN 1 AND 500
    AND safe_message !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_intake_rejections_disposition_valid CHECK (
    (
      disposition = 'open'
      AND retry_run_id IS NULL
      AND exclusion_reason IS NULL
      AND disposition_receipt_id IS NULL
    )
    OR (
      disposition = 'retried'
      AND retry_run_id IS NOT NULL
      AND exclusion_reason IS NULL
      AND disposition_receipt_id IS NULL
    )
    OR (
      disposition = 'excluded'
      AND retry_run_id IS NULL
      AND exclusion_reason IS NOT NULL
      AND length(btrim(exclusion_reason)) BETWEEN 1 AND 500
      AND exclusion_reason !~ '[[:cntrl:]]'
      AND disposition_receipt_id IS NOT NULL
    )
    OR (
      disposition = 'superseded'
      AND retry_run_id IS NULL
      AND exclusion_reason IS NULL
      AND disposition_receipt_id IS NULL
    )
  ),
  CONSTRAINT commerce_intake_rejections_retention_valid CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '30 days'
  )
);

CREATE INDEX IF NOT EXISTS commerce_intake_rejections_open_idx
  ON operations_commerce_intake_rejections (
    organization_id, integration_account_id, created_at DESC, id
  )
  WHERE disposition = 'open';

CREATE OR REPLACE FUNCTION protect_operations_commerce_intake_rejection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_provider text;
  run_resource text;
  retry_evidence_exists boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.disposition <> 'open'
       OR NEW.retry_run_id IS NOT NULL
       OR NEW.exclusion_reason IS NOT NULL
       OR NEW.disposition_receipt_id IS NOT NULL
       OR NEW.row_version <> 0 THEN
      RAISE EXCEPTION
        'Commerce intake rejection must begin open at row version zero';
    END IF;
    SELECT run.provider, run.resource
    INTO run_provider, run_resource
    FROM operations_commerce_intake_runs AS run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.pipeline_id = NEW.pipeline_id
      AND run.id = NEW.run_id;
    IF NOT FOUND
       OR run_provider <> NEW.provider
       OR (
         NEW.resource_type = 'order'
         AND run_resource <> 'products_and_orders'
       )
       OR (
         NEW.resource_type = 'product'
         AND run_resource <> 'products'
       ) THEN
      RAISE EXCEPTION
        'Commerce intake rejection must match its tenant run resource';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.pipeline_id,
    NEW.run_id,
    NEW.provider,
    NEW.resource_type,
    NEW.external_id,
    NEW.source_hash,
    NEW.error_code,
    NEW.safe_message,
    NEW.created_by,
    NEW.created_at,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.pipeline_id,
    OLD.run_id,
    OLD.provider,
    OLD.resource_type,
    OLD.external_id,
    OLD.source_hash,
    OLD.error_code,
    OLD.safe_message,
    OLD.created_by,
    OLD.created_at,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Commerce intake rejection identity is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Commerce intake rejection update requires the next row version';
  END IF;
  IF OLD.disposition <> 'open'
     OR NEW.disposition NOT IN ('retried', 'excluded', 'superseded') THEN
    RAISE EXCEPTION 'Invalid commerce intake rejection transition';
  END IF;
  IF NEW.disposition = 'retried' THEN
    SELECT run.provider, run.resource
    INTO run_provider, run_resource
    FROM operations_commerce_intake_runs AS run
    WHERE run.organization_id = NEW.organization_id
      AND run.integration_account_id = NEW.integration_account_id
      AND run.pipeline_id = NEW.pipeline_id
      AND run.id = NEW.retry_run_id;
    IF NOT FOUND
       OR run_provider <> NEW.provider
       OR NEW.retry_run_id = NEW.run_id
       OR (
         NEW.resource_type = 'order'
         AND run_resource <> 'products_and_orders'
       )
       OR (
         NEW.resource_type = 'product'
         AND run_resource <> 'products'
       ) THEN
      RAISE EXCEPTION
        'Commerce intake retry run must match its rejection resource';
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM operations_commerce_order_candidates AS candidate
      WHERE NEW.resource_type = 'order'
        AND candidate.organization_id = NEW.organization_id
        AND candidate.integration_account_id = NEW.integration_account_id
        AND candidate.pipeline_id = NEW.pipeline_id
        AND candidate.run_id = NEW.retry_run_id
        AND candidate.external_order_id = NEW.external_id
      UNION ALL
      SELECT 1
      FROM operations_commerce_product_candidates AS candidate
      WHERE NEW.resource_type = 'product'
        AND candidate.organization_id = NEW.organization_id
        AND candidate.integration_account_id = NEW.integration_account_id
        AND candidate.pipeline_id = NEW.pipeline_id
        AND candidate.run_id = NEW.retry_run_id
        AND (
          candidate.external_product_id = NEW.external_id
          OR candidate.external_variant_id = NEW.external_id
        )
      UNION ALL
      SELECT 1
      FROM operations_commerce_intake_rejections AS replacement
      WHERE replacement.organization_id = NEW.organization_id
        AND replacement.integration_account_id = NEW.integration_account_id
        AND replacement.pipeline_id = NEW.pipeline_id
        AND replacement.run_id = NEW.retry_run_id
        AND replacement.id <> NEW.id
        AND replacement.resource_type = NEW.resource_type
        AND replacement.external_id = NEW.external_id
    ) INTO retry_evidence_exists;
    IF NOT retry_evidence_exists THEN
      RAISE EXCEPTION
        'Commerce intake retry run must contain exact target evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_intake_rejection
  ON operations_commerce_intake_rejections;
CREATE TRIGGER protect_operations_commerce_intake_rejection
BEFORE INSERT OR UPDATE ON operations_commerce_intake_rejections
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_intake_rejection();

COMMENT ON TABLE operations_commerce_intake_read_intents IS
  'Durable server-owned provider-read identity created before a commerce API call so retries reuse the same bounded window and target.';

COMMENT ON TABLE operations_commerce_intake_rejections IS
  'Record-isolated normalization failures with executable exact-retry or audited exclusion dispositions.';
