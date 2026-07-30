-- Narrow Shopify CarrierService provider-write authorization while the
-- organization remains in Operations Shadow.
--
-- This does not make Shadow generally writable. One owner/admin-confirmed
-- grant authorizes one exact CarrierService create or delete request against
-- one exact account, credential generation, environment, configuration row,
-- activation revision, aggregate hash, and request hash. Claiming a grant
-- appends one immutable attempt before any network call. An incomplete or
-- unknown attempt is never reusable and requires explicit reconciliation.

INSERT INTO global_reference_entity_types (
  prefix, entity_type, display_name
) VALUES
  (
    'gsca',
    'operations.shopify_carrier_service_mutation_authorization',
    'Shopify carrier service mutation authorization'
  ),
  (
    'gscm',
    'operations.shopify_carrier_service_mutation_attempt',
    'Shopify carrier service mutation attempt'
  ),
  (
    'gsco',
    'operations.shopify_carrier_service_mutation_outcome',
    'Shopify carrier service mutation outcome'
  ),
  (
    'gscr',
    'operations.shopify_carrier_service_mutation_resolution',
    'Shopify carrier service mutation resolution'
  ),
  (
    'gscl',
    'operations.shopify_carrier_service_config_mutation_link',
    'Shopify carrier service configuration mutation link'
  )
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_authorization_fence_hash(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_config_id uuid,
    requested_simulation_effect_id uuid,
    requested_operation text,
    requested_account_environment text,
    requested_credential_generation integer,
    requested_config_row_version bigint,
    requested_activation_state text,
    requested_activation_revision integer,
    requested_aggregate_hash text,
    requested_request_hash text,
    requested_expected_service_gid text,
    requested_confirmation_hash text,
    requested_confirmation_statement_version text,
    requested_idempotency_key text
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
          'organizationId', requested_organization_id::text,
          'integrationAccountId',
            requested_integration_account_id::text,
          'configId', requested_config_id::text,
          'simulationEffectId', requested_simulation_effect_id::text,
          'operation', requested_operation,
          'accountEnvironment', requested_account_environment,
          'credentialGeneration', requested_credential_generation,
          'configRowVersion', requested_config_row_version,
          'activationState', requested_activation_state,
          'activationRevision', requested_activation_revision,
          'aggregateHash', requested_aggregate_hash,
          'requestHash', requested_request_hash,
          'expectedServiceGid', requested_expected_service_gid,
          'confirmationHash', requested_confirmation_hash,
          'confirmationStatementVersion',
            requested_confirmation_statement_version,
          'idempotencyKey', requested_idempotency_key
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_mutation_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsca'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    config_id uuid NOT NULL,
    simulation_effect_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('create', 'delete')),
    account_environment text NOT NULL CHECK (
      account_environment IN ('sandbox', 'production')
    ),
    credential_generation integer NOT NULL CHECK (
      credential_generation > 0
    ),
    config_row_version bigint NOT NULL CHECK (config_row_version >= 0),
    activation_state text NOT NULL DEFAULT 'shadow' CHECK (
      activation_state = 'shadow'
    ),
    activation_revision integer NOT NULL CHECK (
      activation_revision >= 1
    ),
    aggregate_hash text NOT NULL CHECK (
      aggregate_hash ~ '^[a-f0-9]{64}$'
    ),
    request_hash text NOT NULL CHECK (
      request_hash ~ '^[a-f0-9]{64}$'
    ),
    expected_service_gid text,
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    confirmation_statement_version text NOT NULL,
    idempotency_key text NOT NULL,
    authorization_fence_hash text GENERATED ALWAYS AS (
      operations_shopify_carrier_service_authorization_fence_hash(
        organization_id,
        integration_account_id,
        config_id,
        simulation_effect_id,
        operation,
        account_environment,
        credential_generation,
        config_row_version,
        activation_state,
        activation_revision,
        aggregate_hash,
        request_hash,
        expected_service_gid,
        confirmation_hash,
        confirmation_statement_version,
        idempotency_key
      )
    ) STORED,
    authorized_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    authorized_role text NOT NULL CHECK (
      authorized_role IN ('owner', 'admin')
    ),
    authorized_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT
      ops_shopify_cs_mut_auth_global_valid
      CHECK (global_id ~ '^gsca[0-9]{7}$'),
    CONSTRAINT
      ops_shopify_cs_mut_auth_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      ops_shopify_cs_mut_auth_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_auth_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_auth_config_fkey
      FOREIGN KEY (organization_id, config_id)
      REFERENCES operations_shopify_carrier_service_configs(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_auth_effect_fkey
      FOREIGN KEY (organization_id, simulation_effect_id)
      REFERENCES operations_commerce_external_effect_intents(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_auth_membership_fkey
      FOREIGN KEY (authorized_by, organization_id)
      REFERENCES app_user_organization_memberships(
        user_email, organization_id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_auth_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT
      ops_shopify_cs_mut_auth_idempotency
      UNIQUE (
        organization_id, integration_account_id, operation,
        idempotency_key
      ),
    CONSTRAINT
      ops_shopify_cs_mut_auth_service_valid
      CHECK (
        (
          operation = 'create'
          AND expected_service_gid IS NULL
        )
        OR (
          operation = 'delete'
          AND expected_service_gid ~
            '^gid://shopify/DeliveryCarrierService/[0-9]+$'
        )
      ),
    CONSTRAINT
      ops_shopify_cs_mut_auth_expiry_valid
      CHECK (
        expires_at > authorized_at
        AND expires_at <= authorized_at + interval '5 minutes'
      ),
    CONSTRAINT
      ops_shopify_cs_mut_auth_text_valid
      CHECK (
        length(btrim(idempotency_key)) BETWEEN 8 AND 200
        AND idempotency_key !~ '[[:cntrl:]]'
        AND length(btrim(confirmation_statement_version))
          BETWEEN 8 AND 160
        AND confirmation_statement_version !~ '[[:cntrl:]]'
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_mutation_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gscm'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    authorization_id uuid NOT NULL,
    worker_id text NOT NULL,
    adapter_version text NOT NULL,
    lease_token uuid NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    claimed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_global_valid
      CHECK (global_id ~ '^gscm[0-9]{7}$'),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_attempt_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES
        operations_shopify_carrier_service_mutation_authorizations(
          organization_id, id
        ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_attempt_auth_unique
      UNIQUE (authorization_id),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_lease_valid
      CHECK (
        lease_expires_at > claimed_at
        AND lease_expires_at <= claimed_at + interval '5 minutes'
      ),
    CONSTRAINT
      ops_shopify_cs_mut_attempt_text_valid
      CHECK (
        length(btrim(worker_id)) BETWEEN 1 AND 200
        AND worker_id !~ '[[:cntrl:]]'
        AND length(btrim(adapter_version)) BETWEEN 1 AND 160
        AND adapter_version !~ '[[:cntrl:]]'
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_mutation_outcomes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gsco'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL,
    lease_token uuid NOT NULL,
    outcome text NOT NULL CHECK (
      outcome IN ('succeeded', 'failed', 'unknown')
    ),
    redacted_result jsonb NOT NULL,
    result_hash text NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    provider_reference text,
    error_code text,
    provider_write_count integer CHECK (
      provider_write_count IN (0, 1)
    ),
    finalized_by text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_global_valid
      CHECK (global_id ~ '^gsco[0-9]{7}$'),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_outcome_attempt_fkey
      FOREIGN KEY (organization_id, attempt_id)
      REFERENCES operations_shopify_carrier_service_mutation_attempts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_outcome_attempt_unique
      UNIQUE (attempt_id),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_redacted
      CHECK (
        operations_commerce_external_effect_json_is_redacted(
          redacted_result
        )
      ),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_state_valid
      CHECK (
        (
          outcome = 'succeeded'
          AND provider_reference ~
            '^gid://shopify/DeliveryCarrierService/[0-9]+$'
          AND error_code IS NULL
          AND provider_write_count = 1
        )
        OR (
          outcome = 'failed'
          AND provider_reference IS NULL
          AND error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
          AND provider_write_count = 0
        )
        OR (
          outcome = 'unknown'
          AND error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
          AND provider_write_count IS NULL
        )
      ),
    CONSTRAINT
      ops_shopify_cs_mut_outcome_text_valid
      CHECK (
        length(btrim(finalized_by)) BETWEEN 1 AND 200
        AND finalized_by !~ '[[:cntrl:]]'
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_mutation_resolutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gscr'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    attempt_id uuid NOT NULL,
    disposition text NOT NULL CHECK (
      disposition IN ('confirmed_applied', 'confirmed_not_applied')
    ),
    provider_reference text,
    redacted_evidence jsonb NOT NULL,
    resolution_hash text NOT NULL CHECK (
      resolution_hash ~ '^[a-f0-9]{64}$'
    ),
    confirmation_hash text NOT NULL CHECK (
      confirmation_hash ~ '^[a-f0-9]{64}$'
    ),
    confirmation_statement_version text NOT NULL,
    resolved_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    resolved_role text NOT NULL CHECK (
      resolved_role IN ('owner', 'admin')
    ),
    resolved_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_global_valid
      CHECK (global_id ~ '^gscr[0-9]{7}$'),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_resolution_attempt_fkey
      FOREIGN KEY (organization_id, attempt_id)
      REFERENCES operations_shopify_carrier_service_mutation_attempts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_resolution_membership_fkey
      FOREIGN KEY (resolved_by, organization_id)
      REFERENCES app_user_organization_memberships(
        user_email, organization_id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_mut_resolution_attempt_unique
      UNIQUE (attempt_id),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_redacted
      CHECK (
        operations_commerce_external_effect_json_is_redacted(
          redacted_evidence
        )
      ),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_state_valid
      CHECK (
        (
          disposition = 'confirmed_applied'
          AND provider_reference ~
            '^gid://shopify/DeliveryCarrierService/[0-9]+$'
        )
        OR (
          disposition = 'confirmed_not_applied'
          AND provider_reference IS NULL
        )
      ),
    CONSTRAINT
      ops_shopify_cs_mut_resolution_text_valid
      CHECK (
        length(btrim(confirmation_statement_version))
          BETWEEN 8 AND 160
        AND confirmation_statement_version !~ '[[:cntrl:]]'
      )
  );

CREATE TABLE IF NOT EXISTS
  operations_shopify_carrier_service_config_mutation_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    global_id text NOT NULL DEFAULT allocate_global_reference('gscl'),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    config_id uuid NOT NULL,
    authorization_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    outcome_id uuid,
    resolution_id uuid,
    from_row_version bigint NOT NULL CHECK (from_row_version >= 0),
    to_row_version bigint NOT NULL CHECK (to_row_version >= 1),
    from_registration_state text NOT NULL,
    to_registration_state text NOT NULL CHECK (
      to_registration_state IN ('registered', 'disabled')
    ),
    from_service_gid text,
    to_service_gid text,
    linked_by text NOT NULL
      REFERENCES app_users(email) ON DELETE RESTRICT,
    linked_role text NOT NULL CHECK (
      linked_role IN ('owner', 'admin')
    ),
    linked_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_global_valid
      CHECK (global_id ~ '^gscl[0-9]{7}$'),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_global_unique
      UNIQUE (global_id),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_registry_fkey
      FOREIGN KEY (global_id)
      REFERENCES crm_reference_registry(reference_code)
      ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_config_fkey
      FOREIGN KEY (organization_id, config_id)
      REFERENCES operations_shopify_carrier_service_configs(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_auth_fkey
      FOREIGN KEY (organization_id, authorization_id)
      REFERENCES
        operations_shopify_carrier_service_mutation_authorizations(
          organization_id, id
        ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_attempt_fkey
      FOREIGN KEY (organization_id, attempt_id)
      REFERENCES operations_shopify_carrier_service_mutation_attempts(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_outcome_fkey
      FOREIGN KEY (organization_id, outcome_id)
      REFERENCES operations_shopify_carrier_service_mutation_outcomes(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_resolution_fkey
      FOREIGN KEY (organization_id, resolution_id)
      REFERENCES operations_shopify_carrier_service_mutation_resolutions(
        organization_id, id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_membership_fkey
      FOREIGN KEY (linked_by, organization_id)
      REFERENCES app_user_organization_memberships(
        user_email, organization_id
      ) ON DELETE RESTRICT,
    CONSTRAINT
      ops_shopify_cs_config_mut_link_org_id_unique
      UNIQUE (organization_id, id),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_attempt_unique
      UNIQUE (attempt_id),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_outcome_unique
      UNIQUE (outcome_id),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_resolution_unique
      UNIQUE (resolution_id),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_version_unique
      UNIQUE (organization_id, config_id, to_row_version),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_evidence_valid
      CHECK (
        (outcome_id IS NOT NULL AND resolution_id IS NULL)
        OR (outcome_id IS NULL AND resolution_id IS NOT NULL)
      ),
    CONSTRAINT
      ops_shopify_cs_config_mut_link_state_valid
      CHECK (
        to_row_version = from_row_version + 1
        AND (
          (
            from_registration_state = 'shadow_simulated'
            AND to_registration_state = 'registered'
            AND from_service_gid IS NULL
            AND to_service_gid ~
              '^gid://shopify/DeliveryCarrierService/[0-9]+$'
          )
          OR (
            from_registration_state = 'registered'
            AND to_registration_state = 'disabled'
            AND from_service_gid ~
              '^gid://shopify/DeliveryCarrierService/[0-9]+$'
            AND to_service_gid IS NULL
          )
        )
      )
  );

CREATE INDEX IF NOT EXISTS
  ops_shopify_cs_mut_auth_config_idx
  ON operations_shopify_carrier_service_mutation_authorizations (
    organization_id, config_id, authorized_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS
  ops_shopify_cs_mut_attempt_claimed_idx
  ON operations_shopify_carrier_service_mutation_attempts (
    claimed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_actor_can_authorize(
    requested_organization_id uuid,
    requested_email text,
    requested_role text
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app_user_organization_memberships membership
    WHERE membership.organization_id = requested_organization_id
      AND membership.user_email = requested_email
      AND membership.status = 'active'
      AND membership.role = requested_role
      AND (
        membership.role = 'owner'
        OR (
          membership.role = 'admin'
          AND COALESCE(
            (membership.permissions->>'manageOperations')::boolean,
            false
          )
        )
      )
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
  activation_state text;
  activation_revision integer;
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
    activation_state,
    activation_revision
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
     OR activation_state IS DISTINCT FROM 'shadow'
     OR activation_state IS DISTINCT FROM NEW.activation_state
     OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
    RAISE EXCEPTION
      'Shopify CarrierService authorization account, credential, environment, or Shadow fence is stale';
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
     OR effect_activation_revision IS DISTINCT FROM NEW.activation_revision
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
      -- An exact application-level replay reaches the unique idempotency
      -- constraint and returns the immutable original row. A different key
      -- is a new explicit grant and must honor the unresolved-attempt fence.
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

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_mut_auth_write
  ON operations_shopify_carrier_service_mutation_authorizations;
CREATE TRIGGER
  protect_ops_shopify_cs_mut_auth_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_mutation_authorizations
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_mut_authorization();

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
  authorization_activation_revision integer;
  authorization_request_hash text;
  account_environment text;
  account_generation integer;
  credential_generation integer;
  credential_status text;
  activation_state text;
  activation_revision integer;
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
    authorized_mutation.request_hash
  INTO
    authorization_expires_at,
    authorization_account_id,
    authorization_config_id,
    authorization_environment,
    authorization_generation,
    authorization_row_version,
    authorization_activation_revision,
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
    activation_state,
    activation_revision
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
     OR account_environment IS DISTINCT FROM authorization_environment
     OR account_generation IS DISTINCT FROM authorization_generation
     OR credential_generation IS DISTINCT FROM authorization_generation
     OR credential_status IS DISTINCT FROM 'verified'
     OR activation_state IS DISTINCT FROM 'shadow'
     OR activation_revision IS DISTINCT FROM
       authorization_activation_revision
     OR config_account_id IS DISTINCT FROM authorization_account_id
     OR config_generation IS DISTINCT FROM authorization_generation
     OR config_activation_revision IS DISTINCT FROM
       authorization_activation_revision
     OR config_row_version IS DISTINCT FROM authorization_row_version THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation authorization expired or became stale before claim';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_mut_attempt_write
  ON operations_shopify_carrier_service_mutation_attempts;
CREATE TRIGGER
  protect_ops_shopify_cs_mut_attempt_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_mutation_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_mut_attempt();

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_mut_outcome()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt_lease_token uuid;
  resolution_exists boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation outcomes are append-only';
  END IF;
  SELECT lease_token INTO attempt_lease_token
  FROM operations_shopify_carrier_service_mutation_attempts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.attempt_id
  FOR UPDATE;
  IF attempt_lease_token IS NULL
     OR attempt_lease_token IS DISTINCT FROM NEW.lease_token THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation outcome has no exact claimed attempt';
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_mutation_resolutions resolution
    WHERE resolution.organization_id = NEW.organization_id
      AND resolution.attempt_id = NEW.attempt_id
  ) INTO resolution_exists;
  IF resolution_exists THEN
    RAISE EXCEPTION
      'A reconciled Shopify CarrierService mutation cannot later receive an outcome';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_mut_outcome_write
  ON operations_shopify_carrier_service_mutation_outcomes;
CREATE TRIGGER
  protect_ops_shopify_cs_mut_outcome_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_mutation_outcomes
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_mut_outcome();

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_mut_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  terminal_outcome text;
  attempt_lease_expires_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation resolutions are append-only';
  END IF;
  IF NOT operations_shopify_carrier_service_actor_can_authorize(
    NEW.organization_id, NEW.resolved_by, NEW.resolved_role
  ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation reconciliation requires an active owner or authorized administrator';
  END IF;
  SELECT attempt.lease_expires_at INTO attempt_lease_expires_at
  FROM operations_shopify_carrier_service_mutation_attempts attempt
  WHERE attempt.organization_id = NEW.organization_id
    AND attempt.id = NEW.attempt_id
  FOR UPDATE;
  IF attempt_lease_expires_at IS NULL THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation reconciliation requires an exact attempt';
  END IF;
  SELECT outcome.outcome INTO terminal_outcome
  FROM operations_shopify_carrier_service_mutation_outcomes outcome
  WHERE outcome.organization_id = NEW.organization_id
    AND outcome.attempt_id = NEW.attempt_id;
  IF terminal_outcome IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION
      'Known Shopify CarrierService mutation outcomes cannot be reconciled differently';
  END IF;
  IF attempt_lease_expires_at > now() THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation cannot be reconciled while its provider-call lease is active, including an unknown outcome';
  END IF;
  IF terminal_outcome IS DISTINCT FROM 'unknown'
     AND NOT (
       terminal_outcome IS NULL
       AND attempt_lease_expires_at <= now()
     ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation reconciliation requires an unknown outcome or an expired incomplete attempt';
  END IF;
  IF NEW.confirmation_statement_version IS DISTINCT FROM
    'shopify-carrier-service-mutation-reconciliation-v1' THEN
    RAISE EXCEPTION
      'Shopify CarrierService mutation reconciliation confirmation is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_mut_resolution_write
  ON operations_shopify_carrier_service_mutation_resolutions;
CREATE TRIGGER
  protect_ops_shopify_cs_mut_resolution_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_mutation_resolutions
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_mut_resolution();

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
  auth_activation_revision integer;
  attempt_authorization_id uuid;
  outcome_attempt_id uuid;
  outcome_state text;
  outcome_provider_reference text;
  outcome_provider_write_count integer;
  resolution_attempt_id uuid;
  resolution_disposition text;
  resolution_provider_reference text;
  effective_provider_reference text;
  activation_state text;
  activation_revision integer;
  account_generation integer;
  credential_generation integer;
  credential_status text;
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
    authorized_mutation.activation_revision
  INTO
    auth_config_id,
    auth_account_id,
    auth_operation,
    auth_generation,
    auth_row_version,
    auth_activation_revision
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

  SELECT
    activation.state,
    activation.revision,
    account.commerce_credential_generation,
    credential.credential_version,
    credential.verification_status
  INTO
    activation_state,
    activation_revision,
    account_generation,
    credential_generation,
    credential_status
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = account.organization_id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = config_account_id;

  IF config_row_version IS DISTINCT FROM NEW.from_row_version
     OR config_state IS DISTINCT FROM NEW.from_registration_state
     OR config_service_gid IS DISTINCT FROM NEW.from_service_gid
     OR auth_config_id IS DISTINCT FROM NEW.config_id
     OR auth_account_id IS DISTINCT FROM config_account_id
     OR auth_generation IS DISTINCT FROM config_generation
     OR auth_row_version IS DISTINCT FROM NEW.from_row_version
     OR auth_activation_revision IS DISTINCT FROM
       config_activation_revision
     OR attempt_authorization_id IS DISTINCT FROM NEW.authorization_id
     OR activation_state IS DISTINCT FROM 'shadow'
     OR activation_revision IS DISTINCT FROM auth_activation_revision
     OR account_generation IS DISTINCT FROM auth_generation
     OR credential_generation IS DISTINCT FROM auth_generation
     OR credential_status IS DISTINCT FROM 'verified'
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
      'Shopify CarrierService configuration mutation link is stale or mismatched';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_config_mut_link_write
  ON operations_shopify_carrier_service_config_mutation_links;
CREATE TRIGGER
  protect_ops_shopify_cs_config_mut_link_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_carrier_service_config_mutation_links
FOR EACH ROW EXECUTE FUNCTION
  protect_ops_shopify_cs_config_mut_link();

-- Replace the 0149 configuration trigger. Entering registered/disabled no
-- longer requires global Active mode. Instead it requires the exact immutable
-- one-time mutation link for the row-version transition.
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
  mutation_link_exists boolean;
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
  IF account_generation IS DISTINCT FROM NEW.credential_generation
     OR activation_revision IS DISTINCT FROM NEW.activation_revision THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration revision fence is stale';
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
    SELECT EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_config_mutation_links link
      WHERE link.organization_id = NEW.organization_id
        AND link.config_id = NEW.id
        AND link.from_row_version = OLD.row_version
        AND link.to_row_version = NEW.row_version
        AND link.from_registration_state = OLD.registration_state
        AND link.to_registration_state = NEW.registration_state
        AND link.from_service_gid IS NOT DISTINCT FROM OLD.service_gid
        AND link.to_service_gid IS NOT DISTINCT FROM NEW.service_gid
    ) INTO mutation_link_exists;
    IF NOT mutation_link_exists THEN
      RAISE EXCEPTION
        'Shopify CarrierService provider state transition requires exact one-time mutation evidence';
    END IF;
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

COMMENT ON TABLE
  operations_shopify_carrier_service_mutation_authorizations IS
  'Immutable owner/admin grants for one exact Shopify CarrierService create or delete while Operations remains Shadow. Environment, account, credential, configuration, activation, aggregate, request, and confirmation are all fenced for no more than five minutes.';
COMMENT ON TABLE
  operations_shopify_carrier_service_mutation_attempts IS
  'Append-only single-consumption evidence inserted before a Shopify provider mutation. The authorization_id uniqueness constraint prevents retrying an uncertain mutation.';
COMMENT ON TABLE
  operations_shopify_carrier_service_mutation_outcomes IS
  'Append-only known or unknown outcome evidence for one consumed Shopify CarrierService mutation authorization.';
COMMENT ON TABLE
  operations_shopify_carrier_service_mutation_resolutions IS
  'Append-only owner/admin reconciliation of an incomplete or unknown Shopify CarrierService mutation; known success or failure cannot be contradicted.';
COMMENT ON TABLE
  operations_shopify_carrier_service_config_mutation_links IS
  'Append-only structural link from exact applied provider evidence to one registered or disabled configuration row-version transition.';
