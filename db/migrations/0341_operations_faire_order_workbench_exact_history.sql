BEGIN;

-- Faire exposes a complete read-only order resource by exact provider ID.
-- Extend the existing manager-requested exact-history lineage to that provider
-- while retaining the same captured lease, credential, activation, immutable
-- evidence, and zero-write fences established by 0340.
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
      AND provider IN ('shopify', 'faire')
    )
  );

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
       OR NEW.provider NOT IN ('shopify', 'faire')
       OR NEW.provider_read_count <> (
         CASE
           WHEN NEW.provider = 'shopify' THEN 3
           ELSE 2
         END
       )
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
          AND account.provider = NEW.provider
          AND account.status = 'active'
          AND account.commerce_credential_generation
              = NEW.credential_generation
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
          AND credential.credential_version = NEW.credential_generation
          AND credential.external_account_id = account.external_account_id
          AND credential.verification_status = 'verified'
          AND (
            (account.provider = 'shopify'
              AND credential.auth_mode = 'shopify_client_credentials')
            OR (account.provider = 'faire'
              AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
          )
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
     AND account.provider = observation.provider
     AND account.status = 'active'
     AND account.commerce_credential_generation
         = observation.credential_generation
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
     AND credential.credential_version = observation.credential_generation
     AND credential.external_account_id = account.external_account_id
     AND credential.verification_status = 'verified'
     AND (
       (account.provider = 'shopify'
         AND credential.auth_mode = 'shopify_client_credentials')
       OR (account.provider = 'faire'
         AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
     )
    WHERE observation.organization_id = p_organization_id
      AND observation.id = p_observation_id
      AND observation.provider IN ('shopify', 'faire')
      AND observation.observation_kind = 'manual_exact_read'
      AND operations_commerce_provider_read_authority_is_current(
        lease.organization_id,
        lease.integration_account_id,
        lease.authority_kind
      )
  );
$$;

ALTER FUNCTION protect_commerce_order_observation_lineage()
  SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION commerce_order_observation_accepts_children(uuid, uuid)
  SET search_path = pg_catalog, public, pg_temp;

COMMIT;
