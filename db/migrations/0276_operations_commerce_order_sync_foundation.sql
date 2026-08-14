-- Provider-authoritative, read-only order history and continuous observation.
--
-- This migration deliberately creates no provider-write authorization. A
-- historical order read may append minimized lifecycle evidence with bounded
-- sensitive tracking/provider-attribution retention and link it to an existing
-- canonical Operations order, but it cannot change the provider, project
-- inventory balances, or claim a provider-side picker.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gcob', 'operations.commerce_order_backfill_session', 'Commerce order backfill session'),
  ('gcoo', 'operations.commerce_order_observation', 'Commerce order observation'),
  ('gcoe', 'operations.commerce_order_event_observation', 'Commerce order event observation')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_commerce_order_sync_policies (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  policy_version text NOT NULL DEFAULT 'commerce-order-sync-policy-v1'
    CHECK (policy_version = 'commerce-order-sync-policy-v1'),
  authority text NOT NULL DEFAULT 'provider'
    CHECK (authority = 'provider'),
  historical_observation_enabled boolean NOT NULL DEFAULT false,
  continuous_observation_enabled boolean NOT NULL DEFAULT true,
  continuous_transport text NOT NULL DEFAULT 'scheduled_poll'
    CHECK (continuous_transport IN (
      'scheduled_poll', 'webhook_signal_plus_poll'
    )),
  provider_event_processor_state text NOT NULL
    CHECK (provider_event_processor_state IN (
      'unsupported', 'processor_pending', 'available'
    )),
  revision integer NOT NULL CHECK (revision > 0),
  continuous_high_watermark timestamptz,
  continuous_next_poll_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT commerce_order_sync_policy_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_sync_policy_transport_valid CHECK (
    continuous_transport <> 'webhook_signal_plus_poll'
    OR provider_event_processor_state = 'available'
  )
);

COMMENT ON TABLE operations_commerce_order_sync_policies IS
  'Per-account provider-authoritative order observation policy. This policy has no provider-write mode.';

CREATE OR REPLACE FUNCTION protect_credentialed_commerce_account_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.provider, NEW.integration_type)
       IS DISTINCT FROM (OLD.provider, OLD.integration_type)
     AND (
       OLD.external_account_id IS NOT NULL
       OR EXISTS (
         SELECT 1
         FROM operations_commerce_credentials credential
         WHERE credential.organization_id = OLD.organization_id
           AND credential.integration_account_id = OLD.id
       )
     ) THEN
    RAISE EXCEPTION
      'credentialed commerce account provider and type are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS credentialed_commerce_account_identity_guard
  ON operations_integration_accounts;
CREATE TRIGGER credentialed_commerce_account_identity_guard
BEFORE UPDATE OF provider, integration_type ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION protect_credentialed_commerce_account_identity();

CREATE TABLE IF NOT EXISTS operations_commerce_order_backfill_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcob'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  session_kind text NOT NULL DEFAULT 'historical_backfill' CHECK (
    session_kind IN ('historical_backfill', 'continuous_poll')
  ),
  read_all_orders_scope_observed boolean,
  return_history_state text NOT NULL DEFAULT 'unknown' CHECK (
    return_history_state IN (
      'unknown', 'available', 'unavailable', 'provider_embedded'
    )
  ),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  coverage_basis text NOT NULL CHECK (coverage_basis IN (
    'shopify_rolling_60_days',
    'faire_provider_available_orders',
    'shopify_updated_at_overlap', 'faire_updated_at_overlap_unfenced'
  )),
  completeness_state text NOT NULL DEFAULT 'unknown' CHECK (
    completeness_state IN (
      'unknown', 'shopify_fixed_window_orders_complete',
      'shopify_fixed_window_read_attempt_complete',
      'faire_provider_available_orders_complete'
    )
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'failed', 'succeeded', 'cancelled',
    'dead', 'blocked'
  )),
  requested_from timestamptz,
  requested_through timestamptz NOT NULL,
  cursor_ciphertext bytea,
  cursor_iv bytea,
  cursor_tag bytea,
  cursor_key_id text,
  cursor_hash text,
  cursor_encryption_version integer,
  cursor_aad_version text,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  provider_records_seen bigint NOT NULL DEFAULT 0
    CHECK (provider_records_seen >= 0),
  observations_appended bigint NOT NULL DEFAULT 0
    CHECK (observations_appended >= 0),
  observations_preserved bigint NOT NULL DEFAULT 0
    CHECK (observations_preserved >= 0),
  oldest_provider_order_at timestamptz,
  newest_provider_order_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  max_pages integer NOT NULL DEFAULT 10000 CHECK (
    max_pages BETWEEN 1 AND 10000
  ),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL
    OR (
      last_error_code ~ '^[A-Z][A-Z0-9_]{2,127}$'
      AND length(last_error_code) <= 128
    )
  ),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  requested_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  reason text NOT NULL,
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_backfill_global_valid CHECK (
    global_id ~ '^gcob(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT commerce_order_backfill_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_order_backfill_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT commerce_order_backfill_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_backfill_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_backfill_policy_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_order_sync_policies(
      organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_backfill_idempotency_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT commerce_order_backfill_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
    AND length(btrim(reason)) BETWEEN 10 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT commerce_order_backfill_window_valid CHECK (
    (provider = 'shopify' AND session_kind = 'historical_backfill'
      AND coverage_basis = 'shopify_rolling_60_days'
      AND requested_from = requested_through - interval '60 days')
    OR (NOT (provider = 'shopify' AND session_kind = 'historical_backfill')
      AND (requested_from IS NULL OR requested_from <= requested_through))
  ),
  CONSTRAINT commerce_order_backfill_cursor_valid CHECK (
    (
      cursor_ciphertext IS NOT NULL
      AND octet_length(cursor_ciphertext) BETWEEN 2 AND 8192
      AND cursor_iv IS NOT NULL
      AND octet_length(cursor_iv) = 12
      AND cursor_tag IS NOT NULL
      AND octet_length(cursor_tag) = 16
      AND cursor_key_id IS NOT NULL
      AND cursor_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND cursor_hash IS NOT NULL
      AND cursor_hash ~ '^[a-f0-9]{64}$'
      AND cursor_encryption_version = 1
      AND cursor_aad_version = 'commerce-order-sync-cursor-aad-v1'
      AND page_count > 0
      AND status IN ('pending', 'processing', 'failed')
    ) OR (
      cursor_ciphertext IS NULL
      AND cursor_iv IS NULL
      AND cursor_tag IS NULL
      AND cursor_key_id IS NULL
      AND cursor_hash IS NULL
      AND cursor_encryption_version IS NULL
      AND cursor_aad_version IS NULL
    )
  ),
  CONSTRAINT commerce_order_backfill_cursor_resume_valid CHECK (
    status NOT IN ('pending', 'processing', 'failed')
    OR page_count = 0
    OR cursor_ciphertext IS NOT NULL
  ),
  CONSTRAINT commerce_order_backfill_scope_evidence_valid CHECK (
    provider = 'shopify' OR read_all_orders_scope_observed IS NULL
  ),
  CONSTRAINT commerce_order_backfill_return_evidence_valid CHECK (
    (provider = 'shopify' AND return_history_state IN (
      'unknown', 'available', 'unavailable'
    )) OR (provider = 'faire' AND return_history_state IN (
      'unknown', 'provider_embedded'
    ))
  ),
  CONSTRAINT commerce_order_backfill_kind_valid CHECK (
    (provider = 'shopify' AND session_kind = 'historical_backfill'
      AND coverage_basis = 'shopify_rolling_60_days')
    OR (provider = 'shopify' AND session_kind = 'continuous_poll'
      AND coverage_basis = 'shopify_updated_at_overlap')
    OR (provider = 'faire' AND session_kind = 'historical_backfill'
      AND coverage_basis = 'faire_provider_available_orders')
    OR (provider = 'faire' AND session_kind = 'continuous_poll'
      AND coverage_basis = 'faire_updated_at_overlap_unfenced')
  ),
  CONSTRAINT commerce_order_backfill_lease_valid CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > locked_at
    ) OR (
      status <> 'processing'
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT commerce_order_backfill_completion_valid CHECK (
    (status IN ('succeeded', 'cancelled', 'dead', 'blocked'))
      = (completed_at IS NOT NULL)
  ),
  CONSTRAINT commerce_order_backfill_completeness_valid CHECK (
    (completeness_state = 'shopify_fixed_window_orders_complete'
      AND provider = 'shopify'
      AND session_kind = 'historical_backfill'
      AND read_all_orders_scope_observed = true
      AND status = 'succeeded')
    OR (completeness_state = 'shopify_fixed_window_read_attempt_complete'
      AND provider = 'shopify'
      AND session_kind = 'historical_backfill'
      AND read_all_orders_scope_observed = false
      AND status = 'succeeded')
    OR (completeness_state = 'faire_provider_available_orders_complete'
      AND provider = 'faire'
      AND session_kind = 'historical_backfill'
      AND status = 'succeeded')
    OR completeness_state = 'unknown'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_commerce_order_backfill_active_account
  ON operations_commerce_order_backfill_sessions (
    organization_id, integration_account_id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_commerce_order_backfill_claim
  ON operations_commerce_order_backfill_sessions (
    status, available_at, created_at, id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_commerce_order_backfill_history
  ON operations_commerce_order_backfill_sessions (
    organization_id, integration_account_id, created_at DESC, id DESC
  );

COMMENT ON TABLE operations_commerce_order_backfill_sessions IS
  'Explicit, resumable provider-read sessions. Shopify v1 is a fixed rolling 60-day window that is retained locally after it ages out; provider cursors are stored only as account/session/query-bound AES-GCM ciphertext.';

CREATE OR REPLACE FUNCTION protect_commerce_order_sync_session_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND (
       NEW.requested_through < clock_timestamp() - interval '10 minutes'
       OR NEW.requested_through > clock_timestamp() + interval '1 minute'
     ) THEN
    RAISE EXCEPTION 'commerce order sync session end is not request-time bounded';
  END IF;
  IF TG_OP = 'INSERT' AND (
       NEW.status NOT IN ('pending', 'blocked')
       OR NEW.read_all_orders_scope_observed IS NOT NULL
       OR NEW.return_history_state <> 'unknown'
       OR NEW.completeness_state <> 'unknown'
       OR NEW.page_count <> 0
       OR NEW.provider_records_seen <> 0
       OR NEW.observations_appended <> 0
       OR NEW.observations_preserved <> 0
       OR NEW.oldest_provider_order_at IS NOT NULL
       OR NEW.newest_provider_order_at IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.cursor_ciphertext IS NOT NULL
       OR NEW.cursor_iv IS NOT NULL
       OR NEW.cursor_tag IS NOT NULL
       OR NEW.cursor_key_id IS NOT NULL
       OR NEW.cursor_hash IS NOT NULL
       OR NEW.cursor_encryption_version IS NOT NULL
       OR NEW.cursor_aad_version IS NOT NULL
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.started_at IS NOT NULL
       OR (NEW.status = 'pending' AND (
         NEW.last_error_code IS NOT NULL OR NEW.completed_at IS NOT NULL
       ))
       OR (NEW.status = 'blocked' AND (
         NEW.last_error_code IS NULL OR NEW.completed_at IS NULL
       ))
     ) THEN
    RAISE EXCEPTION 'commerce order sync initial session state is invalid';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IN ('dead', 'cancelled', 'blocked')
     AND OLD.status IN ('pending', 'processing', 'failed')
     AND (to_jsonb(NEW) - ARRAY[
       'status', 'last_error_code', 'completed_at', 'updated_at',
       'locked_at', 'locked_by', 'lock_token', 'lease_expires_at',
       'cursor_ciphertext', 'cursor_iv', 'cursor_tag', 'cursor_key_id',
       'cursor_hash', 'cursor_encryption_version', 'cursor_aad_version'
     ]) = (to_jsonb(OLD) - ARRAY[
       'status', 'last_error_code', 'completed_at', 'updated_at',
       'locked_at', 'locked_by', 'lock_token', 'lease_expires_at',
       'cursor_ciphertext', 'cursor_iv', 'cursor_tag', 'cursor_key_id',
       'cursor_hash', 'cursor_encryption_version', 'cursor_aad_version'
     ]) THEN
    -- Stale authority must be recoverably terminalizable so the active-account
    -- uniqueness fence cannot strand an account forever. Evidence columns and
    -- identity remain protected by the table's immutability/lineage guards.
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = NEW.credential_generation
     AND credential.external_account_id = account.external_account_id
    JOIN operations_commerce_order_sync_policies policy
      ON policy.organization_id = account.organization_id
     AND policy.integration_account_id = account.id
     AND policy.revision = NEW.policy_revision
     AND policy.authority = 'provider'
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = NEW.provider
      AND account.commerce_credential_generation = NEW.credential_generation
      AND (
        (NEW.session_kind = 'historical_backfill'
          AND policy.historical_observation_enabled)
        OR (NEW.session_kind = 'continuous_poll'
          AND policy.continuous_observation_enabled)
      )
  ) THEN
    RAISE EXCEPTION 'commerce order sync session lineage is invalid';
  END IF;
  IF NEW.status IN ('pending', 'processing', 'failed', 'succeeded')
     AND NOT EXISTS (
       SELECT 1
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version = NEW.credential_generation
        AND credential.external_account_id = account.external_account_id
        AND (
          (account.provider = 'shopify'
            AND credential.auth_mode = 'shopify_client_credentials')
          OR (account.provider = 'faire'
            AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
        )
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.organization_id = NEW.organization_id
         AND account.id = NEW.integration_account_id
         AND account.status = 'active'
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
     ) THEN
    RAISE EXCEPTION 'commerce order sync session eligibility is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_sync_session_lineage_guard
  ON operations_commerce_order_backfill_sessions;
CREATE TRIGGER commerce_order_sync_session_lineage_guard
BEFORE INSERT OR UPDATE OF organization_id, integration_account_id, provider,
  credential_generation, policy_revision, session_kind, status,
  lock_token, lease_expires_at
ON operations_commerce_order_backfill_sessions
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_sync_session_lineage();

CREATE OR REPLACE FUNCTION protect_commerce_order_sync_session_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commerce order sync sessions are append-only';
  END IF;
  IF OLD.status IN ('succeeded', 'cancelled', 'dead', 'blocked') THEN
    RAISE EXCEPTION 'completed commerce order sync sessions are immutable';
  END IF;

  IF ROW(
       NEW.id, NEW.global_id, NEW.organization_id,
       NEW.integration_account_id, NEW.provider, NEW.session_kind,
       NEW.credential_generation, NEW.policy_revision, NEW.coverage_basis,
       NEW.requested_from, NEW.requested_through, NEW.max_attempts,
       NEW.max_pages, NEW.idempotency_key, NEW.request_hash, NEW.query_hash,
       NEW.requested_by, NEW.reason, NEW.provider_write_count, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.global_id, OLD.organization_id,
       OLD.integration_account_id, OLD.provider, OLD.session_kind,
       OLD.credential_generation, OLD.policy_revision, OLD.coverage_basis,
       OLD.requested_from, OLD.requested_through, OLD.max_attempts,
       OLD.max_pages, OLD.idempotency_key, OLD.request_hash, OLD.query_hash,
       OLD.requested_by, OLD.reason, OLD.provider_write_count, OLD.created_at
     ) THEN
    RAISE EXCEPTION 'commerce order sync session identity is immutable';
  END IF;

  -- Claim or reclaim an eligible session. No provider evidence is changed by
  -- this transition; attempt_count is the consecutive claim/failure counter.
  IF NEW.status = 'processing'
     AND OLD.status IN ('pending', 'processing', 'failed') THEN
    IF (to_jsonb(NEW) - ARRAY[
         'status', 'attempt_count', 'locked_at', 'locked_by', 'lock_token',
         'lease_expires_at', 'started_at', 'last_error_code', 'updated_at'
       ]) <> (to_jsonb(OLD) - ARRAY[
         'status', 'attempt_count', 'locked_at', 'locked_by', 'lock_token',
         'lease_expires_at', 'started_at', 'last_error_code', 'updated_at'
       ])
       OR NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.last_error_code IS NOT NULL
       OR NEW.locked_at IS NULL
       OR NEW.locked_by IS NULL
       OR NEW.lock_token IS NULL
       OR NEW.lease_expires_at IS NULL
       OR NEW.started_at IS NULL
       OR (OLD.started_at IS NOT NULL AND NEW.started_at <> OLD.started_at)
       OR (OLD.status = 'processing'
         AND OLD.lease_expires_at > clock_timestamp()) THEN
      RAISE EXCEPTION 'commerce order sync claim transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- A committed provider page is the only transition that may advance the
  -- cursor, counters, observed scope, or completeness evidence.
  IF OLD.status = 'processing' AND NEW.status IN ('pending', 'succeeded') THEN
    IF (to_jsonb(NEW) - ARRAY[
         'status', 'read_all_orders_scope_observed',
         'return_history_state', 'completeness_state',
         'cursor_ciphertext', 'cursor_iv', 'cursor_tag', 'cursor_key_id',
         'cursor_hash', 'cursor_encryption_version', 'cursor_aad_version',
         'page_count', 'provider_records_seen', 'observations_appended',
         'observations_preserved', 'oldest_provider_order_at',
         'newest_provider_order_at', 'attempt_count', 'available_at',
         'locked_at', 'locked_by', 'lock_token', 'lease_expires_at',
         'completed_at', 'updated_at'
       ]) <> (to_jsonb(OLD) - ARRAY[
         'status', 'read_all_orders_scope_observed',
         'return_history_state', 'completeness_state',
         'cursor_ciphertext', 'cursor_iv', 'cursor_tag', 'cursor_key_id',
         'cursor_hash', 'cursor_encryption_version', 'cursor_aad_version',
         'page_count', 'provider_records_seen', 'observations_appended',
         'observations_preserved', 'oldest_provider_order_at',
         'newest_provider_order_at', 'attempt_count', 'available_at',
         'locked_at', 'locked_by', 'lock_token', 'lease_expires_at',
         'completed_at', 'updated_at'
       ])
       OR NEW.page_count <> OLD.page_count + 1
       OR NEW.attempt_count <> 0
       OR NEW.provider_records_seen < OLD.provider_records_seen
       OR NEW.observations_appended < OLD.observations_appended
       OR NEW.observations_preserved < OLD.observations_preserved
       OR (
         OLD.read_all_orders_scope_observed IS NOT NULL
         AND NEW.read_all_orders_scope_observed
           IS DISTINCT FROM OLD.read_all_orders_scope_observed
       )
       OR (
         OLD.return_history_state <> 'unknown'
         AND NEW.return_history_state <> OLD.return_history_state
       )
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR (NEW.status = 'pending' AND (
         NEW.completeness_state <> 'unknown'
         OR NEW.completed_at IS NOT NULL
       ))
       OR (NEW.status = 'succeeded' AND NEW.completed_at IS NULL) THEN
      RAISE EXCEPTION 'commerce order sync page transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- A failed read may only release its lease and record a sanitized code.
  -- Permanent/retry-exhausted failures and explicit stale-session recovery may
  -- additionally clear the encrypted cursor and terminalize the session.
  IF NEW.status IN ('failed', 'dead', 'cancelled', 'blocked')
     AND OLD.status IN ('pending', 'processing', 'failed') THEN
    IF (to_jsonb(NEW) - ARRAY[
         'status', 'last_error_code', 'available_at', 'locked_at',
         'locked_by', 'lock_token', 'lease_expires_at', 'cursor_ciphertext',
         'cursor_iv', 'cursor_tag', 'cursor_key_id', 'cursor_hash',
         'cursor_encryption_version', 'cursor_aad_version', 'completed_at',
         'updated_at'
       ]) <> (to_jsonb(OLD) - ARRAY[
         'status', 'last_error_code', 'available_at', 'locked_at',
         'locked_by', 'lock_token', 'lease_expires_at', 'cursor_ciphertext',
         'cursor_iv', 'cursor_tag', 'cursor_key_id', 'cursor_hash',
         'cursor_encryption_version', 'cursor_aad_version', 'completed_at',
         'updated_at'
       ])
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR (NEW.status = 'failed' AND (
         NEW.completed_at IS NOT NULL
         OR ROW(
           NEW.cursor_ciphertext, NEW.cursor_iv, NEW.cursor_tag,
           NEW.cursor_key_id, NEW.cursor_hash, NEW.cursor_encryption_version,
           NEW.cursor_aad_version
         ) IS DISTINCT FROM ROW(
           OLD.cursor_ciphertext, OLD.cursor_iv, OLD.cursor_tag,
           OLD.cursor_key_id, OLD.cursor_hash, OLD.cursor_encryption_version,
           OLD.cursor_aad_version
         )
       ))
       OR (NEW.status <> 'failed' AND (
         NEW.completed_at IS NULL
         OR NEW.cursor_ciphertext IS NOT NULL
         OR NEW.cursor_iv IS NOT NULL
         OR NEW.cursor_tag IS NOT NULL
         OR NEW.cursor_key_id IS NOT NULL
         OR NEW.cursor_hash IS NOT NULL
         OR NEW.cursor_encryption_version IS NOT NULL
         OR NEW.cursor_aad_version IS NOT NULL
       )) THEN
      RAISE EXCEPTION 'commerce order sync failure transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'commerce order sync session transition is invalid';
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_sync_session_mutation_guard
  ON operations_commerce_order_backfill_sessions;
CREATE TRIGGER commerce_order_sync_session_mutation_guard
BEFORE UPDATE OR DELETE ON operations_commerce_order_backfill_sessions
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_sync_session_mutation();

CREATE TABLE IF NOT EXISTS operations_commerce_order_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcoo'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  backfill_session_id uuid,
  order_id uuid,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  observation_kind text NOT NULL CHECK (observation_kind IN (
    'historical_backfill', 'scheduled_poll'
  )),
  external_order_id text NOT NULL,
  order_number text NOT NULL,
  source_revision text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  raw_lifecycle_state text,
  raw_payment_state text,
  raw_fulfillment_state text,
  raw_return_state text,
  canonical_lifecycle_state text NOT NULL CHECK (
    canonical_lifecycle_state IN ('open', 'closed', 'cancelled', 'unknown')
  ),
  canonical_payment_state text NOT NULL CHECK (
    canonical_payment_state IN (
      'authorized', 'paid', 'partially_paid', 'partially_refunded',
      'pending', 'refunded', 'voided', 'unknown'
    )
  ),
  canonical_fulfillment_state text NOT NULL CHECK (
    canonical_fulfillment_state IN (
      'unfulfilled', 'partial', 'fulfilled', 'on_hold', 'unknown'
    )
  ),
  canonical_return_state text NOT NULL CHECK (
    canonical_return_state IN (
      'none', 'requested', 'in_progress', 'returned', 'unknown'
    )
  ),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  provider_total_minor bigint CHECK (
    provider_total_minor IS NULL
    OR provider_total_minor BETWEEN -9007199254740991 AND 9007199254740991
  ),
  provider_inventory_reservation_state text NOT NULL DEFAULT 'unavailable'
    CHECK (provider_inventory_reservation_state IN (
      'reported_reserved', 'reported_not_reserved', 'unavailable'
    )),
  provider_created_at timestamptz,
  provider_processed_at timestamptz,
  provider_updated_at timestamptz,
  provider_cancelled_at timestamptz,
  provider_closed_at timestamptz,
  observed_at timestamptz NOT NULL,
  provider_read_count integer NOT NULL CHECK (provider_read_count BETWEEN 1 AND 8),
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (provider_write_count = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_observation_global_valid CHECK (
    global_id ~ '^gcoo(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT commerce_order_observation_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_order_observation_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT commerce_order_observation_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_observation_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_observation_session_fkey
    FOREIGN KEY (organization_id, backfill_session_id)
    REFERENCES operations_commerce_order_backfill_sessions(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_observation_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_observation_source_unique
    UNIQUE (
      organization_id, integration_account_id, provider,
      external_order_id, observed_at, source_hash
    ),
  CONSTRAINT commerce_order_observation_identity_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND length(btrim(order_number)) BETWEEN 1 AND 255
    AND length(btrim(source_revision)) BETWEEN 1 AND 512
  ),
  CONSTRAINT commerce_order_observation_money_valid CHECK (
    (currency IS NULL) = (provider_total_minor IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_order_observations_latest
  ON operations_commerce_order_observations (
    organization_id, integration_account_id, provider, external_order_id,
    observed_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS idx_commerce_order_observations_canonical
  ON operations_commerce_order_observations (
    organization_id, order_id, observed_at DESC, id DESC
  ) WHERE order_id IS NOT NULL;

COMMENT ON TABLE operations_commerce_order_observations IS
  'Append-only non-protected order lifecycle snapshots. Party and address values are excluded; order-demand facts do not represent an inventory balance.';

CREATE TABLE IF NOT EXISTS operations_commerce_order_observation_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  observation_id uuid NOT NULL,
  external_line_id text NOT NULL,
  external_product_id text,
  external_variant_id text,
  sku text,
  original_quantity bigint NOT NULL CHECK (
    original_quantity BETWEEN 0 AND 9007199254740991
  ),
  current_quantity bigint CHECK (
    current_quantity IS NULL
    OR current_quantity BETWEEN 0 AND 9007199254740991
  ),
  unfulfilled_quantity bigint CHECK (
    unfulfilled_quantity IS NULL
    OR unfulfilled_quantity BETWEEN 0 AND 9007199254740991
  ),
  fulfilled_quantity bigint CHECK (
    fulfilled_quantity IS NULL
    OR fulfilled_quantity BETWEEN 0 AND 9007199254740991
  ),
  requires_shipping boolean,
  inventory_semantics text NOT NULL DEFAULT 'order_demand'
    CHECK (inventory_semantics = 'order_demand'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_observation_line_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_observations(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_observation_line_unique
    UNIQUE (organization_id, observation_id, external_line_id),
  CONSTRAINT commerce_order_observation_line_identity_valid CHECK (
    length(btrim(external_line_id)) BETWEEN 1 AND 512
    AND (external_product_id IS NULL
      OR length(btrim(external_product_id)) BETWEEN 1 AND 512)
    AND (external_variant_id IS NULL
      OR length(btrim(external_variant_id)) BETWEEN 1 AND 512)
    AND (sku IS NULL OR length(btrim(sku)) BETWEEN 1 AND 512)
  ),
  CONSTRAINT commerce_order_observation_line_quantities_valid CHECK (
    (current_quantity IS NULL OR current_quantity <= original_quantity)
    AND (
      unfulfilled_quantity IS NULL
      OR (
        current_quantity IS NOT NULL
        AND unfulfilled_quantity <= current_quantity
      )
    )
    AND (
      fulfilled_quantity IS NULL
      OR (
        current_quantity IS NOT NULL
        AND fulfilled_quantity <= current_quantity
        AND fulfilled_quantity <= original_quantity
      )
    )
    AND (
      unfulfilled_quantity IS NULL
      OR fulfilled_quantity IS NULL
      OR current_quantity = unfulfilled_quantity + fulfilled_quantity
    )
  )
);

COMMENT ON TABLE operations_commerce_order_observation_lines IS
  'Historical provider line quantities are order-demand and fulfillment facts only. They never project or reconstruct an order-time inventory balance.';

CREATE TABLE IF NOT EXISTS operations_commerce_order_event_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcoe'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  order_id uuid,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  external_order_id text NOT NULL,
  external_event_id text,
  external_subject_id text,
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  event_kind text NOT NULL CHECK (event_kind IN (
    'order_created', 'order_updated', 'order_cancelled', 'order_closed',
    'payment_updated', 'fulfillment_created', 'fulfillment_updated',
    'shipment_created', 'tracking_updated', 'refund_created',
    'refund_updated', 'return_created', 'return_updated',
    'return_state_observed'
  )),
  event_status text,
  quantity bigint CHECK (
    quantity IS NULL OR quantity BETWEEN 0 AND 9007199254740991
  ),
  amount_minor bigint CHECK (
    amount_minor IS NULL
    OR amount_minor BETWEEN -9007199254740991 AND 9007199254740991
  ),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  inventory_effect_kind text NOT NULL DEFAULT 'none' CHECK (
    inventory_effect_kind IN (
      'none', 'order_demand', 'provider_reservation_signal',
      'restock_instruction', 'unknown'
    )
  ),
  attribution_source text NOT NULL DEFAULT 'unavailable' CHECK (
    attribution_source IN (
      'provider_staff', 'provider_system', 'unavailable'
    )
  ),
  actor_email text CHECK (actor_email IS NULL),
  provider_actor_fingerprint text CHECK (
    provider_actor_fingerprint IS NULL
    OR provider_actor_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  provider_location_id text,
  tracking_carrier text,
  tracking_number text,
  sensitive_evidence_expires_at timestamptz NOT NULL,
  sensitive_evidence_redacted_at timestamptz,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (provider_write_count = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_event_global_valid CHECK (
    global_id ~ '^gcoe(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT commerce_order_event_global_unique UNIQUE (global_id),
  CONSTRAINT commerce_order_event_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT commerce_order_event_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_event_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_event_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_observations(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_event_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT commerce_order_event_hash_unique
    UNIQUE (
      organization_id, integration_account_id, provider,
      external_order_id, event_hash
    ),
  CONSTRAINT commerce_order_event_identity_valid CHECK (
    length(btrim(external_order_id)) BETWEEN 1 AND 512
    AND (external_event_id IS NULL
      OR length(btrim(external_event_id)) BETWEEN 1 AND 512)
    AND (external_subject_id IS NULL
      OR length(btrim(external_subject_id)) BETWEEN 1 AND 512)
    AND (provider_location_id IS NULL
      OR length(btrim(provider_location_id)) BETWEEN 1 AND 512)
    AND (tracking_carrier IS NULL
      OR length(btrim(tracking_carrier)) BETWEEN 1 AND 255)
    AND (tracking_number IS NULL
      OR length(btrim(tracking_number)) BETWEEN 1 AND 512)
  ),
  CONSTRAINT commerce_order_event_money_valid CHECK (
    (amount_minor IS NULL) = (currency IS NULL)
  ),
  CONSTRAINT commerce_order_event_attribution_valid CHECK (
    (attribution_source = 'provider_staff'
      AND actor_email IS NULL
      AND provider_actor_fingerprint IS NOT NULL)
    OR (attribution_source IN ('provider_system', 'unavailable')
      AND actor_email IS NULL
      AND provider_actor_fingerprint IS NULL)
  ),
  CONSTRAINT commerce_order_event_sensitive_retention_valid CHECK (
    occurred_at <= observed_at + interval '5 minutes'
    AND sensitive_evidence_expires_at >= LEAST(occurred_at, observed_at)
    AND sensitive_evidence_expires_at
      <= LEAST(occurred_at, observed_at) + interval '400 days'
    AND (
      sensitive_evidence_redacted_at IS NULL
      OR (
        provider_actor_fingerprint IS NULL
        AND tracking_number IS NULL
        AND attribution_source <> 'provider_staff'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_order_events_timeline
  ON operations_commerce_order_event_observations (
    organization_id, integration_account_id, provider, external_order_id,
    occurred_at, id
  );

CREATE INDEX IF NOT EXISTS idx_commerce_order_events_canonical
  ON operations_commerce_order_event_observations (
    organization_id, order_id, occurred_at, id
  ) WHERE order_id IS NOT NULL;

COMMENT ON TABLE operations_commerce_order_event_observations IS
  'Append-only provider lifecycle facts. Provider-only history uses unavailable attribution unless the provider explicitly returns staff identity evidence; it never infers a picker.';

CREATE OR REPLACE FUNCTION protect_commerce_order_observation_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.backfill_session_id IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1
         FROM operations_commerce_order_backfill_sessions session
         JOIN operations_integration_accounts account
           ON account.organization_id = session.organization_id
          AND account.id = session.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider = session.provider
          AND account.status = 'active'
          AND account.commerce_credential_generation
              = session.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = session.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.verification_status = 'verified'
          AND (
            (account.provider = 'shopify'
              AND credential.auth_mode = 'shopify_client_credentials')
            OR (account.provider = 'faire'
              AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
          )
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = session.organization_id
          AND policy.integration_account_id = session.integration_account_id
          AND policy.revision = session.policy_revision
          AND policy.authority = 'provider'
         JOIN operations_activation_scopes activation
           ON activation.organization_id = session.organization_id
          AND activation.state IN ('shadow', 'active')
         WHERE session.organization_id = NEW.organization_id
           AND session.id = NEW.backfill_session_id
           AND session.integration_account_id = NEW.integration_account_id
           AND session.provider = NEW.provider
           AND session.credential_generation = NEW.credential_generation
           AND session.status = 'processing'
           AND session.lease_expires_at > clock_timestamp()
           AND (
             (session.session_kind = 'historical_backfill'
               AND policy.historical_observation_enabled)
             OR (session.session_kind = 'continuous_poll'
               AND policy.continuous_observation_enabled)
           )
           AND (
             (session.session_kind = 'historical_backfill'
               AND NEW.observation_kind = 'historical_backfill')
             OR (session.session_kind = 'continuous_poll'
               AND NEW.observation_kind = 'scheduled_poll')
           )
           AND (
             (session.provider = 'shopify'
               AND session.session_kind = 'historical_backfill'
               AND NEW.provider_created_at IS NOT NULL
               AND NEW.provider_created_at >= session.requested_from
               AND NEW.provider_created_at <= session.requested_through)
             OR (session.provider = 'shopify'
               AND session.session_kind = 'continuous_poll'
               AND NEW.provider_updated_at IS NOT NULL
               AND NEW.provider_updated_at >= session.requested_from
               AND NEW.provider_updated_at <= session.requested_through)
             OR (session.provider = 'faire'
               AND session.session_kind = 'historical_backfill')
             OR (session.provider = 'faire'
               AND session.session_kind = 'continuous_poll'
               AND NEW.provider_updated_at IS NOT NULL
               AND NEW.provider_updated_at >= session.requested_from
               AND NEW.provider_updated_at <= session.requested_through)
           )
       ) THEN
      RAISE EXCEPTION
        'commerce order observation backfill lineage is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION
      'commerce order observations require an exact scheduled session';
  END IF;

  IF NEW.order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_orders order_row
    WHERE order_row.organization_id = NEW.organization_id
      AND order_row.id = NEW.order_id
      AND order_row.integration_account_id = NEW.integration_account_id
      AND order_row.source_provider = NEW.provider
      AND order_row.external_order_id = NEW.external_order_id
  ) THEN
    RAISE EXCEPTION
      'commerce order observation canonical order lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_observations_lineage_guard
  ON operations_commerce_order_observations;
CREATE TRIGGER commerce_order_observations_lineage_guard
BEFORE INSERT ON operations_commerce_order_observations
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_observation_lineage();

CREATE OR REPLACE FUNCTION commerce_order_observation_accepts_children(
  p_organization_id uuid,
  p_observation_id uuid
)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_commerce_order_observations observation
    JOIN operations_commerce_order_backfill_sessions session
      ON session.organization_id = observation.organization_id
     AND session.id = observation.backfill_session_id
     AND session.integration_account_id = observation.integration_account_id
     AND session.provider = observation.provider
     AND session.credential_generation = observation.credential_generation
     AND session.status = 'processing'
     AND session.lease_expires_at > clock_timestamp()
    JOIN operations_integration_accounts account
      ON account.organization_id = session.organization_id
     AND account.id = session.integration_account_id
     AND account.integration_type = 'commerce'
     AND account.provider = session.provider
     AND account.status = 'active'
     AND account.commerce_credential_generation = session.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = session.credential_generation
     AND credential.external_account_id = account.external_account_id
     AND credential.verification_status = 'verified'
     AND (
       (account.provider = 'shopify'
         AND credential.auth_mode = 'shopify_client_credentials')
       OR (account.provider = 'faire'
         AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
     )
    JOIN operations_commerce_order_sync_policies policy
      ON policy.organization_id = session.organization_id
     AND policy.integration_account_id = session.integration_account_id
     AND policy.revision = session.policy_revision
     AND policy.authority = 'provider'
    JOIN operations_activation_scopes activation
      ON activation.organization_id = session.organization_id
     AND activation.state IN ('shadow', 'active')
    WHERE observation.organization_id = p_organization_id
      AND observation.id = p_observation_id
      AND (
        (session.session_kind = 'historical_backfill'
          AND observation.observation_kind = 'historical_backfill'
          AND policy.historical_observation_enabled)
        OR (session.session_kind = 'continuous_poll'
          AND observation.observation_kind = 'scheduled_poll'
          AND policy.continuous_observation_enabled)
      )
  );
$$;

CREATE OR REPLACE FUNCTION protect_commerce_order_observation_line_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT commerce_order_observation_accepts_children(
    NEW.organization_id,
    NEW.observation_id
  ) THEN
    RAISE EXCEPTION 'commerce order observation line lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_observation_lines_lineage_guard
  ON operations_commerce_order_observation_lines;
CREATE TRIGGER commerce_order_observation_lines_lineage_guard
BEFORE INSERT ON operations_commerce_order_observation_lines
FOR EACH ROW EXECUTE FUNCTION
  protect_commerce_order_observation_line_lineage();

CREATE OR REPLACE FUNCTION protect_commerce_order_event_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_observations observation
    WHERE observation.organization_id = NEW.organization_id
      AND observation.id = NEW.observation_id
      AND observation.integration_account_id = NEW.integration_account_id
      AND observation.provider = NEW.provider
      AND observation.external_order_id = NEW.external_order_id
      AND observation.order_id IS NOT DISTINCT FROM NEW.order_id
  ) THEN
    RAISE EXCEPTION 'commerce order event observation lineage is invalid';
  END IF;
  IF NOT commerce_order_observation_accepts_children(
    NEW.organization_id,
    NEW.observation_id
  ) THEN
    RAISE EXCEPTION 'commerce order event observation session is sealed';
  END IF;
  IF (
       NEW.tracking_number IS NOT NULL
       AND (
         position(NEW.tracking_number IN COALESCE(NEW.external_event_id, '')) > 0
         OR position(NEW.tracking_number IN COALESCE(NEW.external_subject_id, '')) > 0
       )
     ) OR (
       NEW.provider_actor_fingerprint IS NOT NULL
       AND (
         position(
           NEW.provider_actor_fingerprint IN COALESCE(NEW.external_event_id, '')
         ) > 0
         OR position(
           NEW.provider_actor_fingerprint IN COALESCE(NEW.external_subject_id, '')
         ) > 0
       )
     ) THEN
    RAISE EXCEPTION
      'sensitive commerce evidence cannot be embedded in durable identifiers';
  END IF;
  IF NEW.sensitive_evidence_expires_at <= clock_timestamp()
     AND (
       NEW.provider_actor_fingerprint IS NOT NULL
       OR NEW.tracking_number IS NOT NULL
     ) THEN
    NEW.provider_actor_fingerprint := NULL;
    NEW.tracking_number := NULL;
    IF NEW.attribution_source = 'provider_staff' THEN
      NEW.attribution_source := 'unavailable';
    END IF;
    NEW.sensitive_evidence_redacted_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_event_observations_lineage_guard
  ON operations_commerce_order_event_observations;
CREATE TRIGGER commerce_order_event_observations_lineage_guard
BEFORE INSERT ON operations_commerce_order_event_observations
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_event_lineage();

CREATE OR REPLACE FUNCTION reject_commerce_order_sync_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'operations_commerce_order_event_observations'
     AND TG_OP = 'UPDATE'
     AND OLD.sensitive_evidence_expires_at <= clock_timestamp()
     AND NEW.provider_actor_fingerprint IS NULL
     AND NEW.tracking_number IS NULL
     AND NEW.attribution_source <> 'provider_staff'
     AND NEW.sensitive_evidence_redacted_at IS NOT NULL
     AND OLD.sensitive_evidence_redacted_at IS NULL
     AND (
       OLD.provider_actor_fingerprint IS NOT NULL
       OR OLD.tracking_number IS NOT NULL
     )
     AND (to_jsonb(NEW) - ARRAY[
       'provider_actor_fingerprint', 'tracking_number',
       'attribution_source', 'sensitive_evidence_redacted_at'
     ]) = (to_jsonb(OLD) - ARRAY[
       'provider_actor_fingerprint', 'tracking_number',
       'attribution_source', 'sensitive_evidence_redacted_at'
     ]) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commerce order observation evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_observations_immutable
  ON operations_commerce_order_observations;
CREATE TRIGGER commerce_order_observations_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_observations
FOR EACH ROW EXECUTE FUNCTION reject_commerce_order_sync_evidence_mutation();

DROP TRIGGER IF EXISTS commerce_order_observation_lines_immutable
  ON operations_commerce_order_observation_lines;
CREATE TRIGGER commerce_order_observation_lines_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_observation_lines
FOR EACH ROW EXECUTE FUNCTION reject_commerce_order_sync_evidence_mutation();

DROP TRIGGER IF EXISTS commerce_order_event_observations_immutable
  ON operations_commerce_order_event_observations;
CREATE TRIGGER commerce_order_event_observations_immutable
BEFORE UPDATE OR DELETE ON operations_commerce_order_event_observations
FOR EACH ROW EXECUTE FUNCTION reject_commerce_order_sync_evidence_mutation();

CREATE OR REPLACE FUNCTION redact_expired_commerce_order_sensitive_evidence(
  requested_limit integer DEFAULT 250
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  bounded_limit integer;
  redacted_count integer;
BEGIN
  bounded_limit := LEAST(GREATEST(COALESCE(requested_limit, 250), 1), 1000);
  WITH candidates AS (
    SELECT id
    FROM operations_commerce_order_event_observations
    WHERE sensitive_evidence_redacted_at IS NULL
      AND sensitive_evidence_expires_at <= now()
      AND (
        provider_actor_fingerprint IS NOT NULL
        OR tracking_number IS NOT NULL
      )
    ORDER BY sensitive_evidence_expires_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  UPDATE operations_commerce_order_event_observations event
  SET provider_actor_fingerprint = NULL,
      tracking_number = NULL,
      attribution_source = CASE
        WHEN event.attribution_source = 'provider_staff'
          THEN 'unavailable'
        ELSE event.attribution_source
      END,
      sensitive_evidence_redacted_at = now()
  FROM candidates
  WHERE event.id = candidates.id;
  GET DIAGNOSTICS redacted_count = ROW_COUNT;
  RETURN redacted_count;
END;
$$;
