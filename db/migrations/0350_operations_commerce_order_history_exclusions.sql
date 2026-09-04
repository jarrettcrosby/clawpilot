-- Retain a minimal, replayable terminal result when an exact provider read
-- proves that an unknown order predates the account's immutable intake floor.
-- No order payload, customer data, lines, or tracking data is retained.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE operations_commerce_store_sync_read_leases
  ADD COLUMN history_exclusion_code text,
  ADD COLUMN history_excluded_external_order_id text,
  ADD COLUMN history_excluded_provider_created_at timestamptz;

ALTER TABLE operations_commerce_store_sync_read_leases
  ADD CONSTRAINT commerce_store_sync_history_exclusion_valid CHECK (
    (
      history_exclusion_code IS NULL
      AND history_excluded_external_order_id IS NULL
      AND history_excluded_provider_created_at IS NULL
    )
    OR (
      history_exclusion_code = 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED'
      AND authority_kind = 'manual_read_only'
      AND read_kind = 'order_history'
      AND captured_at IS NOT NULL
      AND length(btrim(history_excluded_external_order_id)) BETWEEN 1 AND 512
      AND history_excluded_external_order_id =
            btrim(history_excluded_external_order_id)
      AND history_excluded_external_order_id !~ '[[:cntrl:]]'
      AND history_excluded_provider_created_at IS NOT NULL
      AND history_excluded_provider_created_at <= captured_at
    )
  ) NOT VALID;

ALTER TABLE operations_commerce_store_sync_read_leases
  VALIDATE CONSTRAINT commerce_store_sync_history_exclusion_valid;

COMMENT ON COLUMN operations_commerce_store_sync_read_leases.history_exclusion_code IS
  'Terminal no-payload result for a manual exact order read excluded by the immutable first-materialization floor.';

COMMENT ON COLUMN operations_commerce_store_sync_read_leases.history_excluded_external_order_id IS
  'Minimal provider identity bound to a terminal history-floor exclusion so command replay cannot change order identity.';

COMMENT ON COLUMN operations_commerce_store_sync_read_leases.history_excluded_provider_created_at IS
  'Minimal provider creation-time evidence proving that the excluded unknown order predates the immutable floor.';

CREATE OR REPLACE FUNCTION guard_commerce_order_history_lease_exclusion()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.history_exclusion_code IS NOT NULL
       OR NEW.history_excluded_external_order_id IS NOT NULL
       OR NEW.history_excluded_provider_created_at IS NOT NULL THEN
      RAISE EXCEPTION
        'Order-history exclusion requires a captured provider read';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
       OLD.history_exclusion_code,
       OLD.history_excluded_external_order_id,
       OLD.history_excluded_provider_created_at
     ) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz) THEN
    IF ROW(
         NEW.history_exclusion_code,
         NEW.history_excluded_external_order_id,
         NEW.history_excluded_provider_created_at
       ) IS DISTINCT FROM ROW(
         OLD.history_exclusion_code,
         OLD.history_excluded_external_order_id,
         OLD.history_excluded_provider_created_at
       ) THEN
      RAISE EXCEPTION 'Order-history exclusion evidence is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
       NEW.history_exclusion_code,
       NEW.history_excluded_external_order_id,
       NEW.history_excluded_provider_created_at
     ) IS DISTINCT FROM ROW(NULL::text, NULL::text, NULL::timestamptz)
     AND (
       OLD.captured_at IS NULL
       OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
       OR OLD.released_at IS NOT NULL
       OR NEW.released_at IS NOT NULL
       OR OLD.expires_at <= clock_timestamp()
       OR NOT operations_commerce_provider_read_authority_is_current(
         OLD.organization_id,
         OLD.integration_account_id,
         OLD.authority_kind
       )
       OR NOT EXISTS (
         SELECT 1
         FROM operations_commerce_store_sync_controls control
         JOIN operations_activation_scopes activation
           ON activation.organization_id = control.organization_id
          AND activation.revision = OLD.activation_revision
          AND activation.state IN ('shadow', 'active')
         JOIN operations_integration_accounts account
           ON account.organization_id = control.organization_id
          AND account.id = control.integration_account_id
          AND account.integration_type = 'commerce'
          AND account.provider IN ('shopify', 'faire')
          AND account.status = 'active'
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version =
                account.commerce_credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.verification_status = 'verified'
         JOIN operations_commerce_order_history_policies history
           ON history.organization_id = account.organization_id
          AND history.integration_account_id = account.id
          AND history.provider = account.provider
          AND history.ingestion_floor IS NOT NULL
          AND NEW.history_excluded_provider_created_at <
                history.ingestion_floor
         WHERE control.organization_id = OLD.organization_id
           AND control.integration_account_id = OLD.integration_account_id
           AND control.revision = OLD.control_revision
           AND NOT EXISTS (
             SELECT 1
             FROM operations_orders canonical
             WHERE canonical.organization_id = OLD.organization_id
               AND canonical.integration_account_id =
                     OLD.integration_account_id
               AND canonical.source_provider = account.provider
               AND canonical.external_order_id =
                     NEW.history_excluded_external_order_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operations_external_identifiers external
             WHERE external.organization_id = OLD.organization_id
               AND external.integration_account_id =
                     OLD.integration_account_id
               AND external.entity_type = 'operations.order'
               AND external.external_id =
                     NEW.history_excluded_external_order_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operations_commerce_order_candidates candidate
             WHERE candidate.organization_id = OLD.organization_id
               AND candidate.integration_account_id =
                     OLD.integration_account_id
               AND candidate.provider = account.provider
               AND candidate.external_order_id =
                     NEW.history_excluded_external_order_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operations_commerce_order_observations observation
             WHERE observation.organization_id = OLD.organization_id
               AND observation.integration_account_id =
                     OLD.integration_account_id
               AND observation.provider = account.provider
               AND observation.external_order_id =
                     NEW.history_excluded_external_order_id
           )
       )
     ) THEN
    RAISE EXCEPTION
      'Order-history exclusion requires a live captured provider read';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_commerce_order_history_lease_exclusion_write
BEFORE INSERT OR UPDATE
ON operations_commerce_store_sync_read_leases
FOR EACH ROW EXECUTE FUNCTION guard_commerce_order_history_lease_exclusion();

ALTER FUNCTION guard_commerce_order_history_lease_exclusion()
  SET search_path = pg_catalog, public, pg_temp;

ALTER TABLE operations_shopify_order_webhook_reads
  ALTER COLUMN observation_id DROP NOT NULL,
  ADD COLUMN history_exclusion_code text,
  ADD COLUMN excluded_provider_created_at timestamptz;

ALTER TABLE operations_shopify_order_webhook_reads
  ADD CONSTRAINT shopify_order_webhook_history_exclusion_valid CHECK (
    (
      observation_id IS NOT NULL
      AND history_exclusion_code IS NULL
      AND excluded_provider_created_at IS NULL
    )
    OR (
      observation_id IS NULL
      AND history_exclusion_code =
        'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED'
      AND excluded_provider_created_at IS NOT NULL
      AND excluded_provider_created_at <= observed_provider_updated_at
      AND excluded_provider_created_at <= observed_at
    )
  ) NOT VALID;

ALTER TABLE operations_shopify_order_webhook_reads
  VALIDATE CONSTRAINT shopify_order_webhook_history_exclusion_valid;

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
    JOIN operations_commerce_order_history_policies history
      ON history.organization_id = target.organization_id
     AND history.integration_account_id = target.integration_account_id
     AND history.provider = 'shopify'
    JOIN operations_activation_scopes activation
      ON activation.organization_id = target.organization_id
     AND activation.state IN ('shadow', 'active')
    LEFT JOIN operations_commerce_order_observations observation
      ON observation.organization_id = target.organization_id
     AND observation.id = NEW.observation_id
     AND observation.integration_account_id = target.integration_account_id
     AND observation.provider = 'shopify'
     AND observation.external_order_id = target.external_order_id
     AND observation.credential_generation = target.credential_generation
     AND observation.source_hash = NEW.source_hash
     AND observation.provider_updated_at = NEW.observed_provider_updated_at
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
      AND (
        (
          NEW.history_exclusion_code IS NULL
          AND NEW.observation_id IS NOT NULL
          AND observation.id IS NOT NULL
        )
        OR (
          NEW.history_exclusion_code =
            'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED'
          AND NEW.observation_id IS NULL
          AND history.ingestion_floor IS NOT NULL
          AND NEW.excluded_provider_created_at < history.ingestion_floor
          AND NEW.excluded_provider_created_at <=
                NEW.observed_provider_updated_at
          AND NEW.excluded_provider_created_at <= NEW.observed_at
          AND NOT EXISTS (
            SELECT 1
            FROM operations_orders canonical
            WHERE canonical.organization_id = NEW.organization_id
              AND canonical.integration_account_id =
                    NEW.integration_account_id
              AND canonical.source_provider = 'shopify'
              AND canonical.external_order_id = NEW.external_order_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM operations_external_identifiers external
            WHERE external.organization_id = NEW.organization_id
              AND external.integration_account_id =
                    NEW.integration_account_id
              AND external.entity_type = 'operations.order'
              AND external.external_id = NEW.external_order_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM operations_commerce_order_candidates candidate
            WHERE candidate.organization_id = NEW.organization_id
              AND candidate.integration_account_id =
                    NEW.integration_account_id
              AND candidate.provider = 'shopify'
              AND candidate.external_order_id = NEW.external_order_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM operations_commerce_order_observations retained
            WHERE retained.organization_id = NEW.organization_id
              AND retained.integration_account_id =
                    NEW.integration_account_id
              AND retained.provider = 'shopify'
              AND retained.external_order_id = NEW.external_order_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Shopify order webhook read lineage is invalid';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION protect_shopify_order_webhook_read()
  SET search_path = pg_catalog, public, pg_temp;

COMMENT ON COLUMN operations_shopify_order_webhook_reads.history_exclusion_code IS
  'Terminal no-payload acknowledgement when an unknown webhook order predates the frozen first-materialization floor.';
