-- Payload-free Shopify order webhook signals.
--
-- This is a provider-read acceleration control plane only. It stores the
-- exact Shopify Order GID and provider updated timestamp from an
-- includeFields-minimized, HMAC-verified delivery. It stores no raw payload,
-- customer, address, line, payment, fulfillment, or tracking data and creates
-- no Shopify subscription or other provider write authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  (
    'gos',
    'operations.shopify_order_webhook_signal',
    'Shopify order webhook signal'
  ),
  (
    'gow',
    'operations.shopify_order_webhook_read',
    'Shopify order webhook exact read'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_shopify_order_webhook_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gos'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  provider_event_id text NOT NULL,
  topic text NOT NULL CHECK (topic IN (
    'orders/create',
    'orders/updated',
    'orders/edited',
    'orders/cancelled',
    'orders/paid',
    'orders/fulfilled',
    'orders/partially_fulfilled'
  )),
  source_domain text NOT NULL,
  provider_api_version text,
  external_order_id text NOT NULL,
  provider_updated_at timestamptz NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 2 AND 4096),
  provider_triggered_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_order_webhook_signals_global_valid CHECK (
    global_id ~ '^gos(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_shopify_order_webhook_signals_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_order_webhook_signals_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_order_webhook_signals_org_global_unique
    UNIQUE (organization_id, global_id),
  CONSTRAINT operations_shopify_order_webhook_signals_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_signals_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_signals_policy_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_order_sync_policies(
      organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_signals_delivery_unique
    UNIQUE (organization_id, integration_account_id, provider_event_id),
  CONSTRAINT operations_shopify_order_webhook_signals_event_valid CHECK (
    length(provider_event_id) BETWEEN 8 AND 255
    AND provider_event_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,254}$'
  ),
  CONSTRAINT operations_shopify_order_webhook_signals_domain_valid CHECK (
    length(source_domain) BETWEEN 15 AND 255
    AND source_domain = lower(source_domain)
    AND source_domain ~
      '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$'
  ),
  CONSTRAINT operations_shopify_order_webhook_signals_api_valid CHECK (
    provider_api_version IS NULL
    OR provider_api_version ~ '^[0-9]{4}-[0-9]{2}$'
  ),
  CONSTRAINT operations_shopify_order_webhook_signals_order_valid CHECK (
    external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
  ),
  CONSTRAINT operations_shopify_order_webhook_signals_time_valid CHECK (
    provider_updated_at <= received_at + interval '10 minutes'
    AND (
      provider_triggered_at IS NULL
      OR provider_triggered_at <= received_at + interval '10 minutes'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_shopify_order_webhook_signals_account_time
  ON operations_shopify_order_webhook_signals (
    organization_id, integration_account_id, received_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS idx_shopify_order_webhook_signals_order_time
  ON operations_shopify_order_webhook_signals (
    organization_id, integration_account_id, external_order_id,
    provider_updated_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_shopify_order_webhook_signal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order webhook signals are immutable';
  END IF;

  SELECT
    account.provider,
    account.integration_type,
    account.status,
    account.external_account_id,
    account.commerce_credential_generation,
    account.configuration->>'shopDomain' AS shop_domain,
    credential.credential_version,
    credential.external_account_id AS credential_external_account_id,
    credential.auth_mode,
    credential.verification_status,
    policy.authority,
    policy.revision AS current_policy_revision,
    policy.continuous_observation_enabled
  INTO current_row
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_commerce_order_sync_policies policy
    ON policy.organization_id = account.organization_id
   AND policy.integration_account_id = account.id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF current_row IS NULL
     OR current_row.provider <> 'shopify'
     OR current_row.integration_type <> 'commerce'
     OR current_row.status <> 'active'
     OR current_row.external_account_id IS NULL
     OR current_row.shop_domain IS DISTINCT FROM NEW.source_domain
     OR current_row.commerce_credential_generation
          <> NEW.credential_generation
     OR current_row.credential_version <> NEW.credential_generation
     OR current_row.credential_external_account_id
          <> current_row.external_account_id
     OR current_row.auth_mode <> 'shopify_client_credentials'
     OR current_row.verification_status <> 'verified'
     OR current_row.authority <> 'provider'
     OR current_row.current_policy_revision <> NEW.policy_revision
     OR NOT current_row.continuous_observation_enabled
  THEN
    RAISE EXCEPTION
      'Shopify order webhook signal lineage is not current';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_signal_write
  ON operations_shopify_order_webhook_signals;
CREATE TRIGGER protect_shopify_order_webhook_signal_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_order_webhook_signals
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_webhook_signal();

CREATE TABLE IF NOT EXISTS operations_shopify_order_webhook_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  external_order_id text NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  dirty_version bigint NOT NULL CHECK (dirty_version > 0),
  reconciled_version bigint NOT NULL DEFAULT 0 CHECK (
    reconciled_version >= 0 AND reconciled_version <= dirty_version
  ),
  latest_signal_global_id text NOT NULL,
  latest_provider_updated_at timestamptz NOT NULL,
  last_signaled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_reconciled_at timestamptz,
  claim_state text NOT NULL DEFAULT 'pending' CHECK (
    claim_state IN ('pending', 'processing', 'failed', 'idle', 'dead')
  ),
  claimed_dirty_version bigint,
  claimed_signal_global_id text,
  claimed_provider_updated_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 12
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
  provider_read_count bigint NOT NULL DEFAULT 0 CHECK (
    provider_read_count >= 0
  ),
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (
    provider_write_count = 0
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_order_webhook_targets_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_order_webhook_targets_order_unique
    UNIQUE (organization_id, integration_account_id, external_order_id),
  CONSTRAINT operations_shopify_order_webhook_targets_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_targets_policy_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_order_sync_policies(
      organization_id, integration_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_targets_signal_fkey
    FOREIGN KEY (organization_id, latest_signal_global_id)
    REFERENCES operations_shopify_order_webhook_signals(
      organization_id, global_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_targets_claimed_signal_fkey
    FOREIGN KEY (organization_id, claimed_signal_global_id)
    REFERENCES operations_shopify_order_webhook_signals(
      organization_id, global_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_targets_order_valid CHECK (
    external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
  ),
  CONSTRAINT operations_shopify_order_webhook_targets_claim_valid CHECK (
    (
      claim_state = 'processing'
      AND claimed_dirty_version BETWEEN 1 AND dirty_version
      AND claimed_signal_global_id IS NOT NULL
      AND claimed_provider_updated_at IS NOT NULL
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
      AND lease_expires_at > locked_at
    ) OR (
      claim_state <> 'processing'
      AND claimed_dirty_version IS NULL
      AND claimed_signal_global_id IS NULL
      AND claimed_provider_updated_at IS NULL
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT operations_shopify_order_webhook_targets_state_valid CHECK (
    (claim_state = 'idle' AND dirty_version = reconciled_version)
    OR (claim_state <> 'idle' AND dirty_version > reconciled_version)
  )
);

CREATE INDEX IF NOT EXISTS idx_shopify_order_webhook_targets_claim
  ON operations_shopify_order_webhook_targets (
    claim_state, available_at, last_signaled_at,
    organization_id, integration_account_id
  )
  WHERE claim_state IN ('pending', 'failed', 'processing');

CREATE OR REPLACE FUNCTION protect_shopify_order_webhook_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  signal_row record;
  signal_count bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify order webhook targets cannot be deleted';
  END IF;

  SELECT
    signal.integration_account_id,
    signal.external_order_id,
    signal.credential_generation,
    signal.policy_revision,
    signal.provider_updated_at,
    signal.received_at
  INTO signal_row
  FROM operations_shopify_order_webhook_signals signal
  WHERE signal.organization_id = NEW.organization_id
    AND signal.global_id = NEW.latest_signal_global_id;

  SELECT count(*)
  INTO signal_count
  FROM operations_shopify_order_webhook_signals signal
  WHERE signal.organization_id = NEW.organization_id
    AND signal.integration_account_id = NEW.integration_account_id
    AND signal.external_order_id = NEW.external_order_id;

  IF signal_row IS NULL
     OR signal_row.integration_account_id <> NEW.integration_account_id
     OR signal_row.external_order_id <> NEW.external_order_id
     OR signal_row.credential_generation <> NEW.credential_generation
     OR signal_row.policy_revision > NEW.policy_revision
     OR signal_row.provider_updated_at > NEW.latest_provider_updated_at
     OR signal_row.received_at <> NEW.last_signaled_at
     OR signal_count <> NEW.dirty_version
  THEN
    RAISE EXCEPTION 'Shopify order webhook target signal lineage is invalid';
  END IF;

  IF TG_OP = 'INSERT' AND (
       signal_row.policy_revision <> NEW.policy_revision
       OR NEW.dirty_version <> 1
       OR NEW.reconciled_version <> 0
       OR NEW.claim_state <> 'pending'
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.provider_read_count <> 0
       OR NEW.provider_write_count <> 0
       OR NEW.last_reconciled_at IS NOT NULL
     )
  THEN
    RAISE EXCEPTION 'Shopify order webhook target initial state is invalid';
  END IF;

  IF TG_OP = 'UPDATE' AND ROW(
       NEW.organization_id,
       NEW.id,
       NEW.integration_account_id,
       NEW.external_order_id,
       NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.organization_id,
       OLD.id,
       OLD.integration_account_id,
       OLD.external_order_id,
       OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'Shopify order webhook target identity is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND (
     NEW.credential_generation < OLD.credential_generation
     OR NEW.policy_revision < OLD.policy_revision
     OR NEW.dirty_version < OLD.dirty_version
     OR NEW.reconciled_version < OLD.reconciled_version
     OR NEW.provider_read_count < OLD.provider_read_count
     OR NEW.provider_write_count <> 0
     OR NEW.latest_provider_updated_at < OLD.latest_provider_updated_at
     OR NEW.last_signaled_at < OLD.last_signaled_at
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook target evidence is monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_target_write
  ON operations_shopify_order_webhook_targets;
CREATE TRIGGER protect_shopify_order_webhook_target_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_order_webhook_targets
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_webhook_target();

ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_observations_observation_kind_check;
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_kind_v2_valid CHECK (
    observation_kind IN (
      'historical_backfill', 'scheduled_poll', 'webhook_exact_read'
    )
  );
ALTER TABLE operations_commerce_order_observations
  ADD COLUMN IF NOT EXISTS webhook_target_id uuid,
  ADD COLUMN IF NOT EXISTS webhook_dirty_version bigint,
  ADD COLUMN IF NOT EXISTS webhook_lock_token uuid;
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_webhook_target_fkey
  FOREIGN KEY (organization_id, webhook_target_id)
  REFERENCES operations_shopify_order_webhook_targets(organization_id, id)
  ON DELETE RESTRICT;
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_source_lineage_valid CHECK (
    (
      backfill_session_id IS NOT NULL
      AND webhook_target_id IS NULL
      AND webhook_dirty_version IS NULL
      AND webhook_lock_token IS NULL
      AND observation_kind IN ('historical_backfill', 'scheduled_poll')
    ) OR (
      backfill_session_id IS NULL
      AND webhook_target_id IS NOT NULL
      AND webhook_dirty_version > 0
      AND webhook_lock_token IS NOT NULL
      AND observation_kind = 'webhook_exact_read'
      AND provider = 'shopify'
    )
  );
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_webhook_version_unique
  UNIQUE (organization_id, webhook_target_id, webhook_dirty_version);

CREATE OR REPLACE FUNCTION protect_commerce_order_observation_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.backfill_session_id IS NOT NULL THEN
    IF NEW.webhook_target_id IS NOT NULL
       OR NEW.webhook_dirty_version IS NOT NULL
       OR NEW.webhook_lock_token IS NOT NULL
       OR NOT EXISTS (
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
  ELSIF NEW.webhook_target_id IS NOT NULL THEN
    IF NEW.observation_kind <> 'webhook_exact_read'
       OR NEW.provider <> 'shopify'
       OR NEW.webhook_dirty_version IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM operations_shopify_order_webhook_targets target
         JOIN operations_integration_accounts account
           ON account.organization_id = target.organization_id
          AND account.id = target.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider = 'shopify'
          AND account.status = 'active'
          AND account.commerce_credential_generation
              = target.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = target.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.auth_mode = 'shopify_client_credentials'
          AND credential.verification_status = 'verified'
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = target.organization_id
          AND policy.integration_account_id = target.integration_account_id
          AND policy.revision >= target.policy_revision
          AND policy.authority = 'provider'
          AND policy.continuous_observation_enabled
          AND policy.continuous_transport = 'webhook_signal_plus_poll'
          AND policy.provider_event_processor_state = 'available'
         JOIN operations_activation_scopes activation
           ON activation.organization_id = target.organization_id
          AND activation.state IN ('shadow', 'active')
         WHERE target.organization_id = NEW.organization_id
           AND target.id = NEW.webhook_target_id
           AND target.integration_account_id = NEW.integration_account_id
           AND target.external_order_id = NEW.external_order_id
           AND target.credential_generation = NEW.credential_generation
           AND target.claim_state = 'processing'
           AND target.claimed_dirty_version = NEW.webhook_dirty_version
           AND target.lock_token = NEW.webhook_lock_token
           AND target.claimed_provider_updated_at IS NOT NULL
           AND NEW.provider_updated_at IS NOT NULL
           AND NEW.provider_updated_at
                >= target.claimed_provider_updated_at
           AND NEW.provider_updated_at <= NEW.observed_at + interval '10 minutes'
           AND target.lease_expires_at > clock_timestamp()
       ) THEN
      RAISE EXCEPTION
        'commerce order observation webhook lineage is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION
      'commerce order observations require an exact read lineage';
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
  ) OR EXISTS (
    SELECT 1
    FROM operations_commerce_order_observations observation
    JOIN operations_shopify_order_webhook_targets target
      ON target.organization_id = observation.organization_id
     AND target.id = observation.webhook_target_id
     AND target.integration_account_id = observation.integration_account_id
     AND target.external_order_id = observation.external_order_id
     AND target.credential_generation = observation.credential_generation
     AND target.claimed_dirty_version = observation.webhook_dirty_version
     AND target.lock_token = observation.webhook_lock_token
     AND target.claim_state = 'processing'
     AND target.lease_expires_at > clock_timestamp()
    JOIN operations_integration_accounts account
      ON account.organization_id = target.organization_id
     AND account.id = target.integration_account_id
     AND account.integration_type = 'commerce'
     AND account.provider = 'shopify'
     AND account.status = 'active'
     AND account.commerce_credential_generation = target.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = target.credential_generation
     AND credential.external_account_id = account.external_account_id
     AND credential.auth_mode = 'shopify_client_credentials'
     AND credential.verification_status = 'verified'
    JOIN operations_commerce_order_sync_policies policy
      ON policy.organization_id = target.organization_id
     AND policy.integration_account_id = target.integration_account_id
     AND policy.revision >= target.policy_revision
     AND policy.authority = 'provider'
     AND policy.continuous_observation_enabled
     AND policy.continuous_transport = 'webhook_signal_plus_poll'
     AND policy.provider_event_processor_state = 'available'
    JOIN operations_activation_scopes activation
      ON activation.organization_id = target.organization_id
     AND activation.state IN ('shadow', 'active')
    WHERE observation.organization_id = p_organization_id
      AND observation.id = p_observation_id
      AND observation.provider = 'shopify'
      AND observation.observation_kind = 'webhook_exact_read'
  );
$$;

CREATE TABLE IF NOT EXISTS operations_shopify_order_webhook_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gow'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  target_id uuid NOT NULL,
  captured_dirty_version bigint NOT NULL CHECK (captured_dirty_version > 0),
  lock_token uuid NOT NULL,
  signal_global_id text NOT NULL,
  observation_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  external_order_id text NOT NULL,
  claimed_provider_updated_at timestamptz NOT NULL,
  observed_provider_updated_at timestamptz NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  read_all_orders_scope_observed boolean NOT NULL,
  return_history_scope_observed boolean NOT NULL,
  provider_read_count integer NOT NULL CHECK (provider_read_count = 3),
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (
    provider_write_count = 0
  ),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_order_webhook_reads_global_valid CHECK (
    global_id ~ '^gow(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_shopify_order_webhook_reads_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_shopify_order_webhook_reads_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_shopify_order_webhook_reads_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_reads_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_reads_target_fkey
    FOREIGN KEY (organization_id, target_id)
    REFERENCES operations_shopify_order_webhook_targets(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_reads_signal_fkey
    FOREIGN KEY (organization_id, signal_global_id)
    REFERENCES operations_shopify_order_webhook_signals(
      organization_id, global_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_reads_observation_fkey
    FOREIGN KEY (organization_id, observation_id)
    REFERENCES operations_commerce_order_observations(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_order_webhook_reads_target_version_unique
    UNIQUE (organization_id, target_id, captured_dirty_version),
  CONSTRAINT operations_shopify_order_webhook_reads_order_valid CHECK (
    external_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,20}$'
  ),
  CONSTRAINT operations_shopify_order_webhook_reads_time_valid CHECK (
    observed_provider_updated_at >= claimed_provider_updated_at
    AND observed_provider_updated_at <= observed_at + interval '10 minutes'
  )
);

CREATE OR REPLACE FUNCTION protect_shopify_order_webhook_read()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Shopify order webhook reads are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_shopify_order_webhook_targets target
    JOIN operations_shopify_order_webhook_signals signal
      ON signal.organization_id = target.organization_id
     AND signal.integration_account_id = target.integration_account_id
     AND signal.global_id = target.claimed_signal_global_id
     AND signal.external_order_id = target.external_order_id
     AND signal.credential_generation = target.credential_generation
     AND signal.policy_revision <= target.policy_revision
    JOIN operations_commerce_order_observations observation
      ON observation.organization_id = target.organization_id
     AND observation.id = NEW.observation_id
     AND observation.integration_account_id = target.integration_account_id
     AND observation.provider = 'shopify'
     AND observation.external_order_id = target.external_order_id
     AND observation.credential_generation = target.credential_generation
     AND observation.source_hash = NEW.source_hash
     AND observation.provider_updated_at = NEW.observed_provider_updated_at
    JOIN operations_integration_accounts account
      ON account.organization_id = target.organization_id
     AND account.id = target.integration_account_id
     AND account.integration_type = 'commerce'
     AND account.provider = 'shopify'
     AND account.status = 'active'
     AND account.commerce_credential_generation = target.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = target.credential_generation
     AND credential.external_account_id = account.external_account_id
     AND credential.auth_mode = 'shopify_client_credentials'
     AND credential.verification_status = 'verified'
    JOIN operations_commerce_order_sync_policies policy
      ON policy.organization_id = target.organization_id
     AND policy.integration_account_id = target.integration_account_id
     AND policy.revision >= target.policy_revision
     AND policy.authority = 'provider'
     AND policy.continuous_observation_enabled
     AND policy.continuous_transport = 'webhook_signal_plus_poll'
     AND policy.provider_event_processor_state = 'available'
    JOIN operations_activation_scopes activation
      ON activation.organization_id = target.organization_id
     AND activation.state IN ('shadow', 'active')
    WHERE target.organization_id = NEW.organization_id
      AND target.id = NEW.target_id
      AND target.integration_account_id = NEW.integration_account_id
      AND target.external_order_id = NEW.external_order_id
      AND target.credential_generation = NEW.credential_generation
      AND target.policy_revision = NEW.policy_revision
      AND target.claim_state = 'processing'
      AND target.claimed_dirty_version = NEW.captured_dirty_version
      AND target.lock_token = NEW.lock_token
      AND target.claimed_signal_global_id = NEW.signal_global_id
      AND target.claimed_provider_updated_at = NEW.claimed_provider_updated_at
      AND target.lease_expires_at > clock_timestamp()
      AND NEW.observed_provider_updated_at >= target.claimed_provider_updated_at
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook read lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_webhook_read_write
  ON operations_shopify_order_webhook_reads;
CREATE TRIGGER protect_shopify_order_webhook_read_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_shopify_order_webhook_reads
FOR EACH ROW EXECUTE FUNCTION protect_shopify_order_webhook_read();

CREATE OR REPLACE FUNCTION protect_shopify_order_webhook_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  signal_row record;
  signal_count bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify order webhook targets cannot be deleted';
  END IF;

  SELECT
    signal.integration_account_id,
    signal.external_order_id,
    signal.credential_generation,
    signal.policy_revision,
    signal.provider_updated_at,
    signal.received_at
  INTO signal_row
  FROM operations_shopify_order_webhook_signals signal
  WHERE signal.organization_id = NEW.organization_id
    AND signal.global_id = NEW.latest_signal_global_id;

  SELECT count(*)
  INTO signal_count
  FROM operations_shopify_order_webhook_signals signal
  WHERE signal.organization_id = NEW.organization_id
    AND signal.integration_account_id = NEW.integration_account_id
    AND signal.external_order_id = NEW.external_order_id;

  IF signal_row IS NULL
     OR signal_row.integration_account_id <> NEW.integration_account_id
     OR signal_row.external_order_id <> NEW.external_order_id
     OR signal_row.credential_generation <> NEW.credential_generation
     OR signal_row.policy_revision > NEW.policy_revision
     OR signal_row.provider_updated_at > NEW.latest_provider_updated_at
     OR signal_row.received_at <> NEW.last_signaled_at
     OR signal_count <> NEW.dirty_version
  THEN
    RAISE EXCEPTION 'Shopify order webhook target signal lineage is invalid';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF signal_row.policy_revision <> NEW.policy_revision
       OR NEW.dirty_version <> 1
       OR NEW.reconciled_version <> 0
       OR NEW.claim_state <> 'pending'
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.provider_read_count <> 0
       OR NEW.provider_write_count <> 0
       OR NEW.last_reconciled_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Shopify order webhook target initial state is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
       NEW.organization_id, NEW.id, NEW.integration_account_id,
       NEW.external_order_id, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.organization_id, OLD.id, OLD.integration_account_id,
       OLD.external_order_id, OLD.created_at
     )
  THEN
    RAISE EXCEPTION 'Shopify order webhook target identity is immutable';
  END IF;
  IF NEW.credential_generation < OLD.credential_generation
     OR NEW.policy_revision < OLD.policy_revision
     OR NEW.dirty_version < OLD.dirty_version
     OR NEW.reconciled_version < OLD.reconciled_version
     OR NEW.provider_read_count < OLD.provider_read_count
     OR NEW.provider_write_count <> 0
     OR NEW.latest_provider_updated_at < OLD.latest_provider_updated_at
     OR NEW.last_signaled_at < OLD.last_signaled_at
  THEN
    RAISE EXCEPTION 'Shopify order webhook target evidence is monotonic';
  END IF;

  -- Scheduled history requests advance the shared policy revision even when
  -- the exact webhook-plus-poll mode is preserved. Rebind unclaimed or
  -- expired-leased dirty work to that newer revision only while every identity,
  -- credential, authority, activation, and transport fence is still current.
  IF (
       OLD.claim_state IN ('pending', 'failed')
       OR (
         OLD.claim_state = 'processing'
         AND OLD.lease_expires_at <= clock_timestamp()
       )
     )
     AND NEW.claim_state = 'pending'
     AND NEW.policy_revision > OLD.policy_revision
     AND NEW.dirty_version = OLD.dirty_version
  THEN
    IF NEW.credential_generation <> OLD.credential_generation
       OR NEW.dirty_version <> OLD.dirty_version
       OR NEW.reconciled_version <> OLD.reconciled_version
       OR NEW.latest_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.latest_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.last_signaled_at <> OLD.last_signaled_at
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.available_at > clock_timestamp() + interval '1 second'
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.provider_read_count <> OLD.provider_read_count
       OR NOT EXISTS (
         SELECT 1
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = NEW.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.auth_mode = 'shopify_client_credentials'
          AND credential.verification_status = 'verified'
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = account.organization_id
          AND policy.integration_account_id = account.id
          AND policy.revision = NEW.policy_revision
          AND policy.authority = 'provider'
          AND policy.continuous_observation_enabled
          AND policy.continuous_transport = 'webhook_signal_plus_poll'
          AND policy.provider_event_processor_state = 'available'
         JOIN operations_commerce_authority_policy_current authority
           ON authority.organization_id = account.organization_id
          AND authority.integration_account_id = account.id
          AND authority.provider = 'shopify'
          AND authority.resource = 'orders'
          AND authority.authority_mode = 'provider'
          AND authority.desired_ingest_mode
                = 'windowed_history_and_core_order_signals_plus_poll'
          AND authority.provider_write_mode = 'disabled'
          AND authority.provider_write_count = 0
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
          AND activation.state IN ('shadow', 'active')
         JOIN operations_shopify_order_webhook_signals signal
           ON signal.organization_id = account.organization_id
          AND signal.integration_account_id = account.id
          AND signal.global_id = NEW.latest_signal_global_id
          AND signal.external_order_id = NEW.external_order_id
          AND signal.credential_generation = NEW.credential_generation
          AND signal.policy_revision <= OLD.policy_revision
          AND signal.source_domain = account.configuration->>'shopDomain'
          AND signal.provider_updated_at <= NEW.latest_provider_updated_at
          AND signal.received_at = NEW.last_signaled_at
         WHERE account.organization_id = NEW.organization_id
           AND account.id = NEW.integration_account_id
           AND account.integration_type = 'commerce'
           AND account.provider = 'shopify'
           AND account.status = 'active'
           AND account.external_account_id IS NOT NULL
           AND account.commerce_credential_generation
                = NEW.credential_generation
       )
    THEN
      RAISE EXCEPTION
        'Shopify order webhook policy rebase is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- Invalid unclaimed or expired-lease lineage is terminalized locally. A still-eligible
  -- target cannot be discarded through this transition.
  IF (
       OLD.claim_state IN ('pending', 'failed')
       OR (
         OLD.claim_state = 'processing'
         AND OLD.lease_expires_at <= clock_timestamp()
       )
     )
     AND NEW.claim_state = 'dead'
     AND NEW.last_error_code = 'SHOPIFY_ORDER_WEBHOOK_LINEAGE_STALE'
  THEN
    IF NEW.credential_generation <> OLD.credential_generation
       OR NEW.policy_revision <> OLD.policy_revision
       OR NEW.dirty_version <> OLD.dirty_version
       OR NEW.reconciled_version <> OLD.reconciled_version
       OR NEW.latest_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.latest_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.last_signaled_at <> OLD.last_signaled_at
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.available_at <> OLD.available_at
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.provider_read_count <> OLD.provider_read_count
       OR EXISTS (
         SELECT 1
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = OLD.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.auth_mode = 'shopify_client_credentials'
          AND credential.verification_status = 'verified'
         JOIN operations_commerce_order_sync_policies policy
           ON policy.organization_id = account.organization_id
          AND policy.integration_account_id = account.id
          AND policy.revision >= OLD.policy_revision
          AND policy.authority = 'provider'
          AND policy.continuous_observation_enabled
          AND policy.continuous_transport = 'webhook_signal_plus_poll'
          AND policy.provider_event_processor_state = 'available'
         JOIN operations_commerce_authority_policy_current authority
           ON authority.organization_id = account.organization_id
          AND authority.integration_account_id = account.id
          AND authority.provider = 'shopify'
          AND authority.resource = 'orders'
          AND authority.authority_mode = 'provider'
          AND authority.desired_ingest_mode
                = 'windowed_history_and_core_order_signals_plus_poll'
          AND authority.provider_write_mode = 'disabled'
          AND authority.provider_write_count = 0
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
          AND activation.state IN ('shadow', 'active')
         JOIN operations_shopify_order_webhook_signals signal
           ON signal.organization_id = account.organization_id
          AND signal.integration_account_id = account.id
          AND signal.global_id = OLD.latest_signal_global_id
          AND signal.external_order_id = OLD.external_order_id
          AND signal.credential_generation = OLD.credential_generation
          AND signal.policy_revision <= OLD.policy_revision
          AND signal.source_domain = account.configuration->>'shopDomain'
          AND signal.provider_updated_at <= OLD.latest_provider_updated_at
          AND signal.received_at = OLD.last_signaled_at
         WHERE account.organization_id = OLD.organization_id
           AND account.id = OLD.integration_account_id
           AND account.integration_type = 'commerce'
           AND account.provider = 'shopify'
           AND account.status = 'active'
           AND account.external_account_id IS NOT NULL
           AND account.commerce_credential_generation
                = OLD.credential_generation
       )
    THEN
      RAISE EXCEPTION
        'Shopify order webhook stale terminalization is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- One immutable signed delivery advances the dirty version exactly once.
  -- A delivery concurrent with an exact read preserves that captured lease;
  -- otherwise it resets only the coalesced work state for the current lineage.
  IF NEW.dirty_version = OLD.dirty_version + 1 THEN
    IF signal_row.policy_revision <> NEW.policy_revision
       OR NEW.reconciled_version <> OLD.reconciled_version
       OR NEW.provider_read_count <> OLD.provider_read_count
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
       OR (
         OLD.claim_state = 'processing'
         AND NEW.credential_generation = OLD.credential_generation
         AND NEW.policy_revision = OLD.policy_revision
         AND (
           NEW.claim_state <> 'processing'
           OR NEW.claimed_dirty_version <> OLD.claimed_dirty_version
           OR NEW.claimed_signal_global_id
                IS DISTINCT FROM OLD.claimed_signal_global_id
           OR NEW.claimed_provider_updated_at
                IS DISTINCT FROM OLD.claimed_provider_updated_at
           OR NEW.attempt_count <> OLD.attempt_count
           OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
           OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
           OR NEW.lock_token IS DISTINCT FROM OLD.lock_token
           OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
         )
       )
       OR (
         NOT (
           OLD.claim_state = 'processing'
           AND NEW.credential_generation = OLD.credential_generation
           AND NEW.policy_revision = OLD.policy_revision
         )
         AND (
           NEW.claim_state <> 'pending'
           OR NEW.claimed_dirty_version IS NOT NULL
           OR NEW.claimed_signal_global_id IS NOT NULL
           OR NEW.claimed_provider_updated_at IS NOT NULL
           OR NEW.attempt_count <> 0
           OR NEW.locked_at IS NOT NULL
           OR NEW.locked_by IS NOT NULL
           OR NEW.lock_token IS NOT NULL
           OR NEW.lease_expires_at IS NOT NULL
         )
       )
       OR NEW.last_error_code IS NOT NULL
    THEN
      RAISE EXCEPTION 'Shopify order webhook signal transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- Claim/reclaim exactly the currently dirty version. The claim captures the
  -- exact signed signal and provider update fence that the read must cover.
  IF NEW.claim_state = 'processing'
     AND (
       OLD.claim_state IN ('pending', 'failed')
       OR (
         OLD.claim_state = 'processing'
         AND OLD.lease_expires_at <= clock_timestamp()
       )
     )
  THEN
    IF NEW.dirty_version <> OLD.dirty_version
       OR NEW.reconciled_version <> OLD.reconciled_version
       OR NEW.credential_generation <> OLD.credential_generation
       OR NEW.policy_revision <> OLD.policy_revision
       OR NEW.latest_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.latest_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.last_signaled_at <> OLD.last_signaled_at
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
       OR NEW.claimed_dirty_version <> OLD.dirty_version
       OR NEW.claimed_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.claimed_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.attempt_count <> OLD.attempt_count + 1
       OR NEW.locked_at IS NULL
       OR NEW.locked_by IS NULL
       OR NEW.lock_token IS NULL
       OR NEW.lease_expires_at <= NEW.locked_at
       OR NEW.last_error_code IS NOT NULL
       OR NEW.provider_read_count <> OLD.provider_read_count
    THEN
      RAISE EXCEPTION 'Shopify order webhook claim transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- A captured dirty version is acknowledged only after an immutable exact
  -- read row proves the observation append/preserve completed with zero writes.
  IF OLD.claim_state = 'processing'
     AND NEW.claim_state IN ('pending', 'idle')
     AND NEW.reconciled_version > OLD.reconciled_version
  THEN
    IF NEW.dirty_version <> OLD.dirty_version
       OR NEW.reconciled_version <> OLD.claimed_dirty_version
       OR NEW.credential_generation <> OLD.credential_generation
       OR NEW.policy_revision <> OLD.policy_revision
       OR NEW.latest_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.latest_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.last_signaled_at <> OLD.last_signaled_at
       OR NEW.claim_state <> (CASE
         WHEN NEW.dirty_version = NEW.reconciled_version THEN 'idle'
         ELSE 'pending'
       END)
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.last_reconciled_at IS NULL
       OR NEW.provider_read_count <> OLD.provider_read_count + 3
       OR NOT EXISTS (
         SELECT 1
         FROM operations_shopify_order_webhook_reads read_row
         WHERE read_row.organization_id = NEW.organization_id
           AND read_row.integration_account_id = NEW.integration_account_id
           AND read_row.target_id = NEW.id
           AND read_row.captured_dirty_version = NEW.reconciled_version
           AND read_row.lock_token = OLD.lock_token
           AND read_row.signal_global_id = OLD.claimed_signal_global_id
           AND read_row.credential_generation = NEW.credential_generation
           AND read_row.policy_revision = NEW.policy_revision
           AND read_row.external_order_id = NEW.external_order_id
           AND read_row.claimed_provider_updated_at
                = OLD.claimed_provider_updated_at
           AND read_row.provider_read_count = 3
           AND read_row.provider_write_count = 0
       )
    THEN
      RAISE EXCEPTION 'Shopify order webhook completion transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.claim_state = 'processing'
     AND NEW.claim_state IN ('failed', 'dead')
  THEN
    IF NEW.dirty_version <> OLD.dirty_version
       OR NEW.reconciled_version <> OLD.reconciled_version
       OR NEW.credential_generation <> OLD.credential_generation
       OR NEW.policy_revision <> OLD.policy_revision
       OR NEW.latest_signal_global_id <> OLD.latest_signal_global_id
       OR NEW.latest_provider_updated_at <> OLD.latest_provider_updated_at
       OR NEW.last_signaled_at <> OLD.last_signaled_at
       OR NEW.last_reconciled_at IS DISTINCT FROM OLD.last_reconciled_at
       OR NEW.claimed_dirty_version IS NOT NULL
       OR NEW.claimed_signal_global_id IS NOT NULL
       OR NEW.claimed_provider_updated_at IS NOT NULL
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.locked_at IS NOT NULL
       OR NEW.locked_by IS NOT NULL
       OR NEW.lock_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.last_error_code IS NULL
       OR NEW.provider_read_count <> OLD.provider_read_count
       OR (NEW.claim_state = 'dead') <> (NEW.attempt_count >= 12)
    THEN
      RAISE EXCEPTION 'Shopify order webhook failure transition is invalid';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Shopify order webhook target transition is invalid';
END;
$$;

COMMENT ON TABLE operations_shopify_order_webhook_reads IS
  'Immutable exact-read completion evidence for one captured Shopify order webhook dirty version. It contains no raw/customer payload and records exactly three provider reads and zero writes.';

COMMENT ON TABLE operations_shopify_order_webhook_signals IS
  'Immutable, payload-free Shopify order dirty signals derived from the exact two-field HMAC-verified webhook profile. Provider writes are structurally zero.';

COMMENT ON TABLE operations_shopify_order_webhook_targets IS
  'Coalesced exact Shopify Order GID work targets. Scheduled polling remains the active read backstop until an exact-read worker acknowledges captured dirty versions.';
