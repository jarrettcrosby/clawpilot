-- Move Shopify CarrierService provider mutations behind an exact Active
-- activation fence while preserving the immutable Shadow simulation that was
-- reviewed immediately before activation.
--
-- Existing 0150 authorizations have no provider_write_activation_revision.
-- They remain readable for audit/reconciliation, but can never be claimed
-- after this migration.

ALTER TABLE
  operations_shopify_carrier_service_mutation_authorizations
ADD COLUMN IF NOT EXISTS
  simulation_activation_revision integer,
ADD COLUMN IF NOT EXISTS
  provider_write_activation_revision integer;

-- 0150 correctly makes rows append-only. The backfill is part of this
-- transactional schema upgrade, so temporarily remove only that table's write
-- trigger while the table is held by the migration's ALTER lock. The stricter
-- trigger is recreated below before commit.
DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_mut_auth_write
  ON operations_shopify_carrier_service_mutation_authorizations;

UPDATE operations_shopify_carrier_service_mutation_authorizations
SET simulation_activation_revision = activation_revision
WHERE simulation_activation_revision IS NULL;

ALTER TABLE
  operations_shopify_carrier_service_mutation_authorizations
ALTER COLUMN simulation_activation_revision SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ops_shopify_cs_mut_auth_sim_revision_valid'
  ) THEN
    ALTER TABLE
      operations_shopify_carrier_service_mutation_authorizations
    ADD CONSTRAINT ops_shopify_cs_mut_auth_sim_revision_valid
      CHECK (simulation_activation_revision >= 1);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ops_shopify_cs_mut_auth_write_revision_valid'
  ) THEN
    ALTER TABLE
      operations_shopify_carrier_service_mutation_authorizations
    ADD CONSTRAINT ops_shopify_cs_mut_auth_write_revision_valid
      CHECK (
        provider_write_activation_revision IS NULL
        OR provider_write_activation_revision >= 1
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_cs_active_authorization_fence_hash(
    requested_legacy_fence_hash text,
    requested_simulation_activation_revision integer,
    requested_provider_write_activation_revision integer
  )
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      convert_to(
        jsonb_build_object(
          'legacyFenceHash', requested_legacy_fence_hash,
          'simulationActivationRevision',
            requested_simulation_activation_revision,
          'providerWriteActivationRevision',
            requested_provider_write_activation_revision
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_mut_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_status text;
  account_environment text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  current_activation_state text;
  current_activation_revision integer;
  config_account_id uuid;
  config_state text;
  config_service_gid text;
  config_generation integer;
  config_activation_revision integer;
  config_row_version bigint;
  config_global_id text;
  effect_account_id uuid;
  effect_provider text;
  effect_action text;
  effect_mode text;
  effect_state text;
  effect_generation integer;
  effect_activation_revision integer;
  effect_aggregate_type text;
  effect_aggregate_id text;
  effect_aggregate_revision bigint;
  effect_aggregate_hash text;
  effect_request_hash text;
  effect_provider_write_count integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation authorizations are append-only';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-carrier-service-authorization:'
        || NEW.organization_id::text || ':' || NEW.config_id::text,
      0
    )
  );

  IF NOT operations_shopify_carrier_service_actor_can_authorize(
    NEW.organization_id, NEW.authorized_by, NEW.authorized_role
  ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation requires an active owner or authorized administrator';
  END IF;

  IF NEW.activation_state IS DISTINCT FROM 'shadow'
     OR NEW.simulation_activation_revision IS NULL
     OR NEW.provider_write_activation_revision IS NULL THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation requires separate Shadow simulation and Active provider-write revisions';
  END IF;

  SELECT
    account.provider,
    account.integration_type,
    account.status,
    account.environment,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status,
    activation.state,
    activation.revision
  INTO
    account_provider,
    account_type,
    account_status,
    account_environment,
    account_generation,
    credential_generation,
    credential_status,
    current_activation_state,
    current_activation_revision
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF account_provider IS DISTINCT FROM 'shopify'
     OR account_type IS DISTINCT FROM 'commerce'
     OR account_status IS DISTINCT FROM 'active'
     OR account_environment IS DISTINCT FROM NEW.account_environment
     OR account_generation IS DISTINCT FROM NEW.credential_generation
     OR credential_generation IS DISTINCT FROM NEW.credential_generation
     OR credential_status IS DISTINCT FROM 'verified'
     OR current_activation_state IS DISTINCT FROM 'active'
     OR current_activation_revision IS DISTINCT FROM
       NEW.provider_write_activation_revision THEN
    RAISE EXCEPTION
      'Shopify CarrierService authorization account, credential, environment, or Active fence is stale';
  END IF;

  IF NEW.operation = 'create'
     AND NEW.account_environment IS DISTINCT FROM 'sandbox' THEN
    RAISE EXCEPTION
      'New Shopify CarrierService registration is sandbox-only; production is limited to exact delete reconciliation';
  END IF;

  SELECT
    config.integration_account_id,
    config.registration_state,
    config.service_gid,
    config.credential_generation,
    config.activation_revision,
    config.row_version,
    config.global_id
  INTO
    config_account_id,
    config_state,
    config_service_gid,
    config_generation,
    config_activation_revision,
    config_row_version,
    config_global_id
  FROM operations_shopify_carrier_service_configs config
  WHERE config.organization_id = NEW.organization_id
    AND config.id = NEW.config_id;

  IF config_account_id IS DISTINCT FROM NEW.integration_account_id
     OR config_generation IS DISTINCT FROM NEW.credential_generation
     OR config_activation_revision IS DISTINCT FROM NEW.activation_revision
     OR config_row_version IS DISTINCT FROM NEW.config_row_version
     OR (
       NEW.operation = 'create'
       AND (
         config_state IS DISTINCT FROM 'shadow_simulated'
         OR config_service_gid IS NOT NULL
       )
     )
     OR (
       NEW.operation = 'delete'
       AND (
         config_state IS DISTINCT FROM 'registered'
         OR config_service_gid IS DISTINCT FROM NEW.expected_service_gid
       )
     ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService authorization configuration fence is stale';
  END IF;

  SELECT
    effect.integration_account_id,
    effect.provider,
    effect.action,
    effect.desired_mode,
    effect.state,
    effect.credential_generation,
    effect.activation_revision,
    effect.aggregate_type,
    effect.aggregate_id,
    effect.aggregate_revision,
    effect.aggregate_hash,
    effect.request_hash,
    effect.provider_write_count
  INTO
    effect_account_id,
    effect_provider,
    effect_action,
    effect_mode,
    effect_state,
    effect_generation,
    effect_activation_revision,
    effect_aggregate_type,
    effect_aggregate_id,
    effect_aggregate_revision,
    effect_aggregate_hash,
    effect_request_hash,
    effect_provider_write_count
  FROM operations_commerce_external_effect_intents effect
  WHERE effect.organization_id = NEW.organization_id
    AND effect.id = NEW.simulation_effect_id;

  IF effect_account_id IS DISTINCT FROM NEW.integration_account_id
     OR effect_provider IS DISTINCT FROM 'shopify'
     OR effect_action IS DISTINCT FROM
       ('shopify.carrier_service.' || NEW.operation)
     OR effect_mode IS DISTINCT FROM 'shadow'
     OR effect_state IS DISTINCT FROM 'simulated'
     OR effect_generation IS DISTINCT FROM NEW.credential_generation
     OR effect_activation_revision IS DISTINCT FROM
       NEW.simulation_activation_revision
     OR effect_aggregate_type IS DISTINCT FROM
       'shopify_carrier_service_configuration'
     OR effect_aggregate_id IS DISTINCT FROM config_global_id
     OR effect_aggregate_revision IS DISTINCT FROM NEW.config_row_version
     OR effect_aggregate_hash IS DISTINCT FROM NEW.aggregate_hash
     OR effect_request_hash IS DISTINCT FROM NEW.request_hash
     OR effect_provider_write_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'Shopify CarrierService authorization does not match exact Shadow simulation evidence';
  END IF;

  IF (
    NEW.account_environment = 'production'
    AND NEW.confirmation_statement_version IS DISTINCT FROM
      'shopify-carrier-service-production-provider-write-v1'
  ) OR (
    NEW.account_environment = 'sandbox'
    AND NEW.confirmation_statement_version IS DISTINCT FROM
      'shopify-carrier-service-sandbox-provider-write-v1'
  ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService authorization confirmation statement is invalid for the exact environment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_mutation_authorizations prior
    LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
      ON attempt.organization_id = prior.organization_id
     AND attempt.authorization_id = prior.id
    LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
      ON outcome.organization_id = attempt.organization_id
     AND outcome.attempt_id = attempt.id
    LEFT JOIN operations_shopify_carrier_service_mutation_resolutions resolution
      ON resolution.organization_id = attempt.organization_id
     AND resolution.attempt_id = attempt.id
    WHERE prior.organization_id = NEW.organization_id
      AND prior.config_id = NEW.config_id
      AND prior.operation = NEW.operation
      AND prior.config_row_version = NEW.config_row_version
      AND prior.request_hash = NEW.request_hash
      AND prior.provider_write_activation_revision IS NOT NULL
      AND prior.idempotency_key IS DISTINCT FROM NEW.idempotency_key
      AND (
        (
          attempt.id IS NULL
          AND prior.expires_at > now()
        )
        OR (
          attempt.id IS NOT NULL
          AND NOT (
            (
              outcome.outcome = 'failed'
              AND outcome.provider_write_count = 0
            )
            OR resolution.disposition = 'confirmed_not_applied'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'An exact Shopify CarrierService mutation is already authorized, applied, or awaiting reconciliation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_mut_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorization_expires_at timestamptz;
  authorization_account_id uuid;
  authorization_config_id uuid;
  authorization_environment text;
  authorization_generation integer;
  authorization_row_version bigint;
  authorization_config_activation_revision integer;
  authorization_provider_write_activation_revision integer;
  authorization_request_hash text;
  account_environment text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  current_activation_state text;
  current_activation_revision integer;
  config_account_id uuid;
  config_generation integer;
  config_activation_revision integer;
  config_row_version bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation attempts are append-only';
  END IF;

  SELECT
    authorized_mutation.expires_at,
    authorized_mutation.integration_account_id,
    authorized_mutation.config_id,
    authorized_mutation.account_environment,
    authorized_mutation.credential_generation,
    authorized_mutation.config_row_version,
    authorized_mutation.activation_revision,
    authorized_mutation.provider_write_activation_revision,
    authorized_mutation.request_hash
  INTO
    authorization_expires_at,
    authorization_account_id,
    authorization_config_id,
    authorization_environment,
    authorization_generation,
    authorization_row_version,
    authorization_config_activation_revision,
    authorization_provider_write_activation_revision,
    authorization_request_hash
  FROM operations_shopify_carrier_service_mutation_authorizations
    authorized_mutation
  WHERE authorized_mutation.organization_id = NEW.organization_id
    AND authorized_mutation.id = NEW.authorization_id
  FOR SHARE;

  SELECT
    account.environment,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status,
    activation.state,
    activation.revision
  INTO
    account_environment,
    account_generation,
    credential_generation,
    credential_status,
    current_activation_state,
    current_activation_revision
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = authorization_account_id;

  SELECT
    config.integration_account_id,
    config.credential_generation,
    config.activation_revision,
    config.row_version
  INTO
    config_account_id,
    config_generation,
    config_activation_revision,
    config_row_version
  FROM operations_shopify_carrier_service_configs config
  WHERE config.organization_id = NEW.organization_id
    AND config.id = authorization_config_id
  FOR SHARE;

  IF authorization_expires_at IS NULL
     OR authorization_expires_at <= now()
     OR authorization_request_hash IS NULL
     OR authorization_provider_write_activation_revision IS NULL
     OR account_environment IS DISTINCT FROM authorization_environment
     OR account_generation IS DISTINCT FROM authorization_generation
     OR credential_generation IS DISTINCT FROM authorization_generation
     OR credential_status IS DISTINCT FROM 'verified'
     OR current_activation_state IS DISTINCT FROM 'active'
     OR current_activation_revision IS DISTINCT FROM
       authorization_provider_write_activation_revision
     OR config_account_id IS DISTINCT FROM authorization_account_id
     OR config_generation IS DISTINCT FROM authorization_generation
     OR config_activation_revision IS DISTINCT FROM
       authorization_config_activation_revision
     OR config_row_version IS DISTINCT FROM authorization_row_version THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation Active authorization expired or became stale before claim';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_config_mut_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  config_row_version bigint;
  config_state text;
  config_service_gid text;
  config_account_id uuid;
  config_generation integer;
  config_activation_revision integer;
  auth_config_id uuid;
  auth_account_id uuid;
  auth_operation text;
  auth_generation integer;
  auth_row_version bigint;
  auth_config_activation_revision integer;
  auth_provider_write_activation_revision integer;
  attempt_authorization_id uuid;
  outcome_attempt_id uuid;
  outcome_state text;
  outcome_provider_reference text;
  outcome_provider_write_count integer;
  resolution_attempt_id uuid;
  resolution_disposition text;
  resolution_provider_reference text;
  effective_provider_reference text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify CarrierService configuration mutation links are append-only';
  END IF;
  IF NOT operations_shopify_carrier_service_actor_can_authorize(
    NEW.organization_id, NEW.linked_by, NEW.linked_role
  ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService configuration finalization requires an active owner or authorized administrator';
  END IF;

  SELECT
    config.row_version,
    config.registration_state,
    config.service_gid,
    config.integration_account_id,
    config.credential_generation,
    config.activation_revision
  INTO
    config_row_version,
    config_state,
    config_service_gid,
    config_account_id,
    config_generation,
    config_activation_revision
  FROM operations_shopify_carrier_service_configs config
  WHERE config.organization_id = NEW.organization_id
    AND config.id = NEW.config_id
  FOR SHARE;

  SELECT
    authorized_mutation.config_id,
    authorized_mutation.integration_account_id,
    authorized_mutation.operation,
    authorized_mutation.credential_generation,
    authorized_mutation.config_row_version,
    authorized_mutation.activation_revision,
    authorized_mutation.provider_write_activation_revision
  INTO
    auth_config_id,
    auth_account_id,
    auth_operation,
    auth_generation,
    auth_row_version,
    auth_config_activation_revision,
    auth_provider_write_activation_revision
  FROM operations_shopify_carrier_service_mutation_authorizations
    authorized_mutation
  WHERE authorized_mutation.organization_id = NEW.organization_id
    AND authorized_mutation.id = NEW.authorization_id;

  SELECT attempt.authorization_id
  INTO attempt_authorization_id
  FROM operations_shopify_carrier_service_mutation_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id;

  IF NEW.outcome_id IS NOT NULL THEN
    SELECT
      outcome.attempt_id,
      outcome.outcome,
      outcome.provider_reference,
      outcome.provider_write_count
    INTO
      outcome_attempt_id,
      outcome_state,
      outcome_provider_reference,
      outcome_provider_write_count
    FROM operations_shopify_carrier_service_mutation_outcomes outcome
    WHERE outcome.organization_id = NEW.organization_id
      AND outcome.id = NEW.outcome_id;
    IF outcome_attempt_id IS DISTINCT FROM NEW.attempt_id
       OR outcome_state IS DISTINCT FROM 'succeeded'
       OR outcome_provider_write_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'Shopify CarrierService configuration requires exact succeeded provider evidence';
    END IF;
    effective_provider_reference := outcome_provider_reference;
  ELSE
    SELECT
      resolution.attempt_id,
      resolution.disposition,
      resolution.provider_reference
    INTO
      resolution_attempt_id,
      resolution_disposition,
      resolution_provider_reference
    FROM operations_shopify_carrier_service_mutation_resolutions
      resolution
    WHERE resolution.organization_id = NEW.organization_id
      AND resolution.id = NEW.resolution_id;
    IF resolution_attempt_id IS DISTINCT FROM NEW.attempt_id
       OR resolution_disposition IS DISTINCT FROM 'confirmed_applied' THEN
      RAISE EXCEPTION
        'Shopify CarrierService configuration requires exact applied reconciliation evidence';
    END IF;
    effective_provider_reference := resolution_provider_reference;
  END IF;

  -- Authorization creation and attempt insertion already fence the exact
  -- current Active revision and verified credential generation before any
  -- credential decryption or provider I/O.
  -- Once immutable succeeded or confirmed-applied provider evidence exists,
  -- this trigger performs local-only finalization. Do not re-read mutable
  -- organization activation or current credential state here: an operator may
  -- change activation, rotate the credential, or change its verification after
  -- Shopify applied the request. Those later changes must not strand an
  -- unchanged config behind already-recorded exact provider evidence.

  IF config_row_version IS DISTINCT FROM NEW.from_row_version
     OR config_state IS DISTINCT FROM NEW.from_registration_state
     OR config_service_gid IS DISTINCT FROM NEW.from_service_gid
     OR auth_config_id IS DISTINCT FROM NEW.config_id
     OR auth_account_id IS DISTINCT FROM config_account_id
     OR auth_generation IS DISTINCT FROM config_generation
     OR auth_row_version IS DISTINCT FROM NEW.from_row_version
     OR auth_config_activation_revision IS DISTINCT FROM
       config_activation_revision
     OR auth_provider_write_activation_revision IS NULL
     OR attempt_authorization_id IS DISTINCT FROM NEW.authorization_id
     OR (
       auth_operation = 'create'
       AND (
         NEW.to_registration_state <> 'registered'
         OR NEW.to_service_gid IS DISTINCT FROM
           effective_provider_reference
       )
     )
     OR (
       auth_operation = 'delete'
       AND (
         NEW.to_registration_state <> 'disabled'
         OR NEW.from_service_gid IS DISTINCT FROM
           effective_provider_reference
       )
     ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService configuration Active mutation link is stale or mismatched';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_cs_config_has_exact_finalization_link(
    requested_organization_id uuid,
    requested_config_id uuid,
    requested_integration_account_id uuid,
    requested_from_row_version bigint,
    requested_to_row_version bigint,
    requested_from_registration_state text,
    requested_to_registration_state text,
    requested_from_service_gid text,
    requested_to_service_gid text,
    requested_from_activation_revision integer,
    requested_to_activation_revision integer,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_config_mutation_links link
    JOIN operations_shopify_carrier_service_mutation_authorizations
      authorized_mutation
      ON authorized_mutation.organization_id = link.organization_id
     AND authorized_mutation.id = link.authorization_id
    WHERE link.organization_id = requested_organization_id
      AND link.config_id = requested_config_id
      AND link.from_row_version = requested_from_row_version
      AND link.to_row_version = requested_to_row_version
      AND link.from_registration_state =
        requested_from_registration_state
      AND link.to_registration_state = requested_to_registration_state
      AND link.from_service_gid IS NOT DISTINCT FROM
        requested_from_service_gid
      AND link.to_service_gid IS NOT DISTINCT FROM requested_to_service_gid
      AND authorized_mutation.config_id = requested_config_id
      AND authorized_mutation.integration_account_id =
        requested_integration_account_id
      AND authorized_mutation.config_row_version = requested_from_row_version
      AND authorized_mutation.activation_revision =
        requested_from_activation_revision
      AND authorized_mutation.provider_write_activation_revision =
        requested_to_activation_revision
      AND authorized_mutation.credential_generation =
        requested_credential_generation
      AND (
        (
          authorized_mutation.operation = 'create'
          AND requested_from_registration_state = 'shadow_simulated'
          AND requested_to_registration_state = 'registered'
        )
        OR (
          authorized_mutation.operation = 'delete'
          AND requested_from_registration_state = 'registered'
          AND requested_to_registration_state = 'disabled'
        )
      )
  )
$$;

-- Replace the inherited validator so exact provider-success finalization uses
-- the immutable claimed authorization rather than mutable post-call account,
-- credential, or organization-activation state. Every insert and ordinary edit
-- continues to require the current account generation and activation revision.
CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_environment text;
  account_generation integer;
  activation_revision integer;
  exact_finalization_link_exists boolean := false;
BEGIN
  SELECT
    provider, integration_type, environment,
    commerce_credential_generation
    INTO
      account_provider, account_type, account_environment,
      account_generation
  FROM operations_integration_accounts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.integration_account_id;
  SELECT revision INTO activation_revision
  FROM operations_activation_scopes
  WHERE organization_id = NEW.organization_id;

  IF account_provider IS DISTINCT FROM 'shopify'
     OR account_type IS DISTINCT FROM 'commerce' THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration requires a Shopify commerce account';
  END IF;
  IF (
       TG_OP = 'INSERT'
       OR NEW.registration_state IN ('shadow_simulated', 'registered')
     )
     AND account_environment IS DISTINCT FROM 'sandbox' THEN
    RAISE EXCEPTION
      'New Shopify CarrierService configuration and registration are sandbox-only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF account_generation IS DISTINCT FROM NEW.credential_generation
       OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
      RAISE EXCEPTION
        'Shopify carrier service configuration revision fence is stale';
    END IF;
    IF NEW.registration_state IS DISTINCT FROM 'unconfigured' THEN
      RAISE EXCEPTION
        'New Shopify CarrierService configuration must begin unconfigured';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration identity is immutable';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration row version must advance once';
  END IF;

  IF NEW.registration_state IN ('registered', 'disabled')
     AND NEW.registration_state IS DISTINCT FROM OLD.registration_state THEN
    exact_finalization_link_exists :=
      operations_shopify_cs_config_has_exact_finalization_link(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        OLD.registration_state,
        NEW.registration_state,
        OLD.service_gid,
        NEW.service_gid,
        OLD.activation_revision,
        NEW.activation_revision,
        NEW.credential_generation
      );
    IF NOT exact_finalization_link_exists THEN
      RAISE EXCEPTION
        'Shopify CarrierService provider state transition requires exact Active one-time mutation evidence';
    END IF;
  END IF;

  IF NOT exact_finalization_link_exists
     AND (
       account_generation IS DISTINCT FROM NEW.credential_generation
       OR activation_revision IS DISTINCT FROM NEW.activation_revision
     ) THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration revision fence is stale';
  END IF;
  IF OLD.registration_state = 'registered'
     AND NEW.registration_state NOT IN ('registered', 'disabled') THEN
    RAISE EXCEPTION
      'A registered Shopify CarrierService can leave registered state only through its exact one-time delete transition';
  END IF;
  IF OLD.registration_state = 'registered'
     AND NEW.registration_state = 'registered'
     AND NEW.service_gid IS DISTINCT FROM OLD.service_gid THEN
    RAISE EXCEPTION
      'A registered Shopify CarrierService identity is immutable outside its exact one-time mutation transition';
  END IF;

  RETURN NEW;
END;
$$;

-- Callback readiness remains a live fail-closed predicate. The only exception
-- to its write-time constraint is the exact local state-alignment transition
-- already authorized and applied at Shopify; this does not make the resulting
-- configuration callback-ready under the newer mutable state.
CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  exact_finalization_link_exists boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.registration_state IN ('registered', 'disabled')
     AND NEW.registration_state IS DISTINCT FROM OLD.registration_state THEN
    exact_finalization_link_exists :=
      operations_shopify_cs_config_has_exact_finalization_link(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        OLD.registration_state,
        NEW.registration_state,
        OLD.service_gid,
        NEW.service_gid,
        OLD.activation_revision,
        NEW.activation_revision,
        NEW.credential_generation
      );
  END IF;
  IF NEW.registration_state IN ('shadow_simulated', 'registered')
     AND NOT operations_shopify_carrier_service_config_is_ready(
       NEW.organization_id,
       NEW.id
     )
     AND NOT exact_finalization_link_exists THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration is not callback-ready';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER
  protect_ops_shopify_cs_mut_auth_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_mutation_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_mut_authorization();

COMMENT ON TABLE
  operations_shopify_carrier_service_mutation_authorizations IS
  'Immutable owner/admin grants for one exact Shopify CarrierService create or delete. Every new grant binds an exact prior zero-write Shadow simulation revision and an exact current Active provider-write revision for no more than five minutes. Legacy Shadow grants remain audit-only and unclaimable.';

COMMENT ON FUNCTION
  operations_shopify_cs_config_has_exact_finalization_link(
    uuid, uuid, uuid, bigint, bigint, text, text, text, text,
    integer, integer, integer
  ) IS
  'Returns true only for the exact immutable Active authorization and config row-version transition that may complete local provider-state alignment after post-call activation or credential drift.';
