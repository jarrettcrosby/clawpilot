BEGIN;

ALTER TABLE operations_commerce_order_observations
  ADD COLUMN IF NOT EXISTS manual_provider_read_lease_id uuid;

-- Exact reads carry independent provider-read lineage. Keep the original
-- content/clock replay fence within an observation kind, but never let a
-- scheduled/backfill row consume the unique slot for a manual or webhook
-- exact observation with the same provider facts.
ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS commerce_order_observation_source_unique;
ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS commerce_order_observation_source_kind_unique;
DROP INDEX IF EXISTS commerce_order_observation_source_lineage_unique;
CREATE UNIQUE INDEX commerce_order_observation_source_lineage_unique
  ON operations_commerce_order_observations (
    organization_id, integration_account_id, provider, external_order_id,
    observation_kind, observed_at, source_hash, backfill_session_id,
    webhook_target_id, webhook_dirty_version, manual_provider_read_lease_id
  ) NULLS NOT DISTINCT;

ALTER TABLE operations_commerce_order_event_observations
  ADD COLUMN IF NOT EXISTS tracking_url text;

ALTER TABLE operations_commerce_order_observation_lines
  ADD COLUMN IF NOT EXISTS returned_quantity bigint;

ALTER TABLE operations_commerce_order_observation_lines
  DROP CONSTRAINT IF EXISTS commerce_order_observation_line_returned_quantity_valid;
ALTER TABLE operations_commerce_order_observation_lines
  ADD CONSTRAINT commerce_order_observation_line_returned_quantity_valid CHECK (
    returned_quantity IS NULL
    OR returned_quantity BETWEEN 0 AND original_quantity
  );

ALTER TABLE operations_commerce_order_event_observations
  DROP CONSTRAINT IF EXISTS commerce_order_event_tracking_url_valid;
ALTER TABLE operations_commerce_order_event_observations
  ADD CONSTRAINT commerce_order_event_tracking_url_valid CHECK (
    tracking_url IS NULL
    OR (
      length(btrim(tracking_url)) BETWEEN 1 AND 2048
      AND tracking_url ~ '^https?://'
      AND tracking_url !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE operations_commerce_order_event_observations
  DROP CONSTRAINT IF EXISTS commerce_order_event_sensitive_retention_valid;
ALTER TABLE operations_commerce_order_event_observations
  ADD CONSTRAINT commerce_order_event_sensitive_retention_valid CHECK (
    occurred_at <= observed_at + interval '5 minutes'
    AND sensitive_evidence_expires_at >= LEAST(occurred_at, observed_at)
    AND sensitive_evidence_expires_at
      <= LEAST(occurred_at, observed_at) + interval '400 days'
    AND (
      sensitive_evidence_redacted_at IS NULL
      OR (
        provider_actor_fingerprint IS NULL
        AND tracking_number IS NULL
        AND tracking_url IS NULL
        AND attribution_source <> 'provider_staff'
      )
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commerce_order_observation_manual_read_lease_fkey'
      AND conrelid = 'operations_commerce_order_observations'::regclass
  ) THEN
    ALTER TABLE operations_commerce_order_observations
      ADD CONSTRAINT commerce_order_observation_manual_read_lease_fkey
      FOREIGN KEY (manual_provider_read_lease_id)
      REFERENCES operations_commerce_store_sync_read_leases(id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS commerce_order_observation_kind_v2_valid;
ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS commerce_order_observation_kind_v3_valid;
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_kind_v3_valid CHECK (
    observation_kind IN (
      'historical_backfill', 'scheduled_poll', 'webhook_exact_read',
      'manual_exact_read'
    )
  );

ALTER TABLE operations_commerce_order_observations
  DROP CONSTRAINT IF EXISTS commerce_order_observation_source_lineage_valid;
ALTER TABLE operations_commerce_order_observations
  ADD CONSTRAINT commerce_order_observation_source_lineage_valid CHECK (
    (
      backfill_session_id IS NOT NULL
      AND webhook_target_id IS NULL
      AND webhook_dirty_version IS NULL
      AND webhook_lock_token IS NULL
      AND manual_provider_read_lease_id IS NULL
      AND observation_kind IN ('historical_backfill', 'scheduled_poll')
    ) OR (
      backfill_session_id IS NULL
      AND webhook_target_id IS NOT NULL
      AND webhook_dirty_version > 0
      AND webhook_lock_token IS NOT NULL
      AND manual_provider_read_lease_id IS NULL
      AND observation_kind = 'webhook_exact_read'
      AND provider = 'shopify'
    ) OR (
      backfill_session_id IS NULL
      AND webhook_target_id IS NULL
      AND webhook_dirty_version IS NULL
      AND webhook_lock_token IS NULL
      AND manual_provider_read_lease_id IS NOT NULL
      AND observation_kind = 'manual_exact_read'
      AND provider = 'shopify'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_order_observation_manual_read
  ON operations_commerce_order_observations (
    organization_id, integration_account_id, manual_provider_read_lease_id
  )
  WHERE manual_provider_read_lease_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_commerce_order_observation_lineage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.backfill_session_id IS NOT NULL THEN
    IF NEW.webhook_target_id IS NOT NULL
       OR NEW.webhook_dirty_version IS NOT NULL
       OR NEW.webhook_lock_token IS NOT NULL
       OR NEW.manual_provider_read_lease_id IS NOT NULL
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
    IF NEW.manual_provider_read_lease_id IS NOT NULL
       OR NEW.observation_kind <> 'webhook_exact_read'
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
  ELSIF NEW.manual_provider_read_lease_id IS NOT NULL THEN
    IF NEW.observation_kind <> 'manual_exact_read'
       OR NEW.provider <> 'shopify'
       OR NEW.provider_read_count <> 3
       OR NOT EXISTS (
         SELECT 1
         FROM operations_commerce_store_sync_read_leases lease
         JOIN operations_commerce_store_sync_controls control
           ON control.organization_id = lease.organization_id
          AND control.integration_account_id = lease.integration_account_id
          AND control.revision = lease.control_revision
         JOIN operations_activation_scopes activation
           ON activation.organization_id = lease.organization_id
          AND activation.revision = lease.activation_revision
         JOIN operations_integration_accounts account
           ON account.organization_id = lease.organization_id
          AND account.id = lease.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider = 'shopify'
          AND account.status = 'active'
          AND account.commerce_credential_generation
              = NEW.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = NEW.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.auth_mode = 'shopify_client_credentials'
          AND credential.verification_status = 'verified'
         WHERE lease.id = NEW.manual_provider_read_lease_id
           AND lease.organization_id = NEW.organization_id
           AND lease.integration_account_id = NEW.integration_account_id
           AND lease.authority_kind = 'manual_read_only'
           AND lease.read_kind = 'order_history'
           AND lease.captured_at IS NOT NULL
           AND lease.released_at IS NULL
           AND lease.expires_at > clock_timestamp()
           AND operations_commerce_provider_read_authority_is_current(
             lease.organization_id,
             lease.integration_account_id,
             lease.authority_kind
           )
           AND NEW.observed_at >= lease.acquired_at - interval '5 minutes'
           AND NEW.observed_at <= lease.expires_at + interval '10 minutes'
       ) THEN
      RAISE EXCEPTION
        'commerce order observation manual exact-read lineage is invalid';
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
  ) OR EXISTS (
    SELECT 1
    FROM operations_commerce_order_observations observation
    JOIN operations_commerce_store_sync_read_leases lease
      ON lease.id = observation.manual_provider_read_lease_id
     AND lease.organization_id = observation.organization_id
     AND lease.integration_account_id = observation.integration_account_id
     AND lease.authority_kind = 'manual_read_only'
     AND lease.read_kind = 'order_history'
     AND lease.captured_at IS NOT NULL
     AND lease.released_at IS NULL
     AND lease.expires_at > clock_timestamp()
    JOIN operations_commerce_store_sync_controls control
      ON control.organization_id = lease.organization_id
     AND control.integration_account_id = lease.integration_account_id
     AND control.revision = lease.control_revision
    JOIN operations_activation_scopes activation
      ON activation.organization_id = lease.organization_id
     AND activation.revision = lease.activation_revision
    JOIN operations_integration_accounts account
      ON account.organization_id = lease.organization_id
     AND account.id = lease.integration_account_id
     AND account.integration_type = 'commerce'
     AND account.provider = 'shopify'
     AND account.status = 'active'
     AND account.commerce_credential_generation
         = observation.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = observation.credential_generation
     AND credential.external_account_id = account.external_account_id
     AND credential.auth_mode = 'shopify_client_credentials'
     AND credential.verification_status = 'verified'
    WHERE observation.organization_id = p_organization_id
      AND observation.id = p_observation_id
      AND observation.provider = 'shopify'
      AND observation.observation_kind = 'manual_exact_read'
      AND operations_commerce_provider_read_authority_is_current(
        lease.organization_id,
        lease.integration_account_id,
        lease.authority_kind
      )
  );
$$;

CREATE OR REPLACE FUNCTION protect_commerce_order_event_tracking_url()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.tracking_url IS NOT NULL AND (
    length(btrim(NEW.tracking_url)) NOT BETWEEN 1 AND 2048
    OR NEW.tracking_url !~ '^https?://'
    OR NEW.tracking_url ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'commerce order tracking URL is invalid';
  END IF;
  IF NEW.tracking_url IS NOT NULL AND (
    position(NEW.tracking_url IN COALESCE(NEW.external_event_id, '')) > 0
    OR position(NEW.tracking_url IN COALESCE(NEW.external_subject_id, '')) > 0
  ) THEN
    RAISE EXCEPTION
      'sensitive commerce evidence cannot be embedded in durable identifiers';
  END IF;
  IF NEW.sensitive_evidence_expires_at <= clock_timestamp()
     AND NEW.tracking_url IS NOT NULL THEN
    NEW.tracking_url := NULL;
    IF NEW.attribution_source = 'provider_staff' THEN
      NEW.attribution_source := 'unavailable';
    END IF;
    NEW.sensitive_evidence_redacted_at := COALESCE(
      NEW.sensitive_evidence_redacted_at,
      clock_timestamp()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commerce_order_event_tracking_url_guard
  ON operations_commerce_order_event_observations;
CREATE TRIGGER commerce_order_event_tracking_url_guard
BEFORE INSERT ON operations_commerce_order_event_observations
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_event_tracking_url();

CREATE OR REPLACE FUNCTION reject_commerce_order_sync_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'operations_commerce_order_event_observations'
     AND TG_OP = 'UPDATE'
     AND OLD.sensitive_evidence_expires_at <= clock_timestamp()
     AND NEW.provider_actor_fingerprint IS NULL
     AND NEW.tracking_number IS NULL
     AND NEW.tracking_url IS NULL
     AND NEW.attribution_source <> 'provider_staff'
     AND NEW.sensitive_evidence_redacted_at IS NOT NULL
     AND OLD.sensitive_evidence_redacted_at IS NULL
     AND (
       OLD.provider_actor_fingerprint IS NOT NULL
       OR OLD.tracking_number IS NOT NULL
       OR OLD.tracking_url IS NOT NULL
     )
     AND (to_jsonb(NEW) - ARRAY[
       'provider_actor_fingerprint', 'tracking_number', 'tracking_url',
       'attribution_source', 'sensitive_evidence_redacted_at'
     ]) = (to_jsonb(OLD) - ARRAY[
       'provider_actor_fingerprint', 'tracking_number', 'tracking_url',
       'attribution_source', 'sensitive_evidence_redacted_at'
     ]) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commerce order observation evidence is immutable';
END;
$$;

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
        OR tracking_url IS NOT NULL
      )
    ORDER BY sensitive_evidence_expires_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT bounded_limit
  )
  UPDATE operations_commerce_order_event_observations event
  SET provider_actor_fingerprint = NULL,
      tracking_number = NULL,
      tracking_url = NULL,
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

ALTER FUNCTION protect_commerce_order_observation_lineage()
  SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION commerce_order_observation_accepts_children(uuid, uuid)
  SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION reject_commerce_order_sync_evidence_mutation()
  SET search_path = pg_catalog, public, pg_temp;

COMMIT;
