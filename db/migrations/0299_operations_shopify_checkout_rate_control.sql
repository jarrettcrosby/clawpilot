-- Decouple Shopify checkout-rate serving from the organization-wide
-- Operations activation mode. The saved account-level control selects both
-- the callback audience and the exact TEST/LIVE carrier credential lane.
-- Disabled and Frozen remain immediate runtime kill switches; Read_only is a
-- serving state because rating is read-only and performs no provider write.

SET LOCAL search_path = public, pg_catalog, pg_temp;

ALTER FUNCTION public.operations_shopify_cs_config_has_exact_finalization_link(
  uuid, uuid, uuid, bigint, bigint, text, text, text, text,
  integer, integer, integer
) SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION public.operations_shopify_carrier_service_config_is_ready(
  uuid, uuid
) SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_control_is_valid(input jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(input)) <> 3
     OR NOT (input ?& ARRAY['version', 'audience', 'rateSource'])
     OR COALESCE(input ->> 'version', '')
       <> 'shopify-checkout-rate-control-v1'
     OR COALESCE(input ->> 'audience', '') NOT IN (
       'off', 'restricted_customers', 'all_eligible'
     )
     OR COALESCE(input ->> 'rateSource', '')
       NOT IN ('sandbox', 'production')
  THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

-- Install the revision-aware validator before normalizing saved controls.
-- Live configurations may carry an older activation revision because local
-- rating policy is intentionally independent of that global display state.
CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_provider text;
  account_type text;
  account_environment text;
  account_generation integer;
  activation_revision integer;
  exact_finalization_link_exists boolean := false;
  provider_authority_fields_changed boolean := false;
BEGIN
  SELECT
    provider, integration_type, commerce_credential_generation
    INTO
      account_provider, account_type, account_generation
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

  provider_authority_fields_changed := ROW(
    NEW.registration_state,
    NEW.service_gid,
    NEW.activation_revision,
    NEW.credential_generation
  ) IS DISTINCT FROM ROW(
    OLD.registration_state,
    OLD.service_gid,
    OLD.activation_revision,
    OLD.credential_generation
  );

  IF NEW.registration_state IN ('registered', 'disabled')
     AND NEW.registration_state IS DISTINCT FROM OLD.registration_state THEN
    exact_finalization_link_exists :=
      public.operations_shopify_cs_config_has_exact_finalization_link(
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
        'Shopify CarrierService provider state transition requires exact resource-scoped one-time mutation evidence';
    END IF;
  END IF;

  IF NOT exact_finalization_link_exists
     AND provider_authority_fields_changed
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

-- The deferred callback-readiness trigger must make the same distinction.
-- A policy-only update is local desired state and cannot mutate provider
-- authority; every other update retains the legacy readiness/finalization
-- requirement byte-for-byte.
CREATE OR REPLACE FUNCTION
  validate_operations_shopify_carrier_service_config_ready()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  exact_finalization_link_exists boolean := false;
  exact_name_finalization_exists boolean := false;
  local_policy_only_update boolean := false;
  name_finalization_only_update boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    local_policy_only_update :=
      (to_jsonb(NEW) - ARRAY[
        'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
        'updated_by', 'updated_at'
      ]::text[])
      IS NOT DISTINCT FROM
      (to_jsonb(OLD) - ARRAY[
        'row_version', 'policy_snapshot', 'policy_hash', 'policy_revision',
        'updated_by', 'updated_at'
      ]::text[]);
    name_finalization_only_update :=
      NEW.registered_service_name IS DISTINCT FROM
        OLD.registered_service_name
      AND (
        to_jsonb(NEW) - ARRAY[
          'row_version', 'registered_service_name', 'updated_by', 'updated_at'
        ]::text[]
      ) IS NOT DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'row_version', 'registered_service_name', 'updated_by', 'updated_at'
        ]::text[]
      );
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.registration_state IN ('registered', 'disabled')
     AND NEW.registration_state IS DISTINCT FROM OLD.registration_state THEN
    exact_finalization_link_exists :=
      public.operations_shopify_cs_config_has_exact_finalization_link(
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

  IF TG_OP = 'UPDATE'
     AND name_finalization_only_update
     AND OLD.registration_state = 'registered'
     AND NEW.registration_state = 'registered'
     AND NEW.service_gid IS NOT DISTINCT FROM OLD.service_gid
     AND NEW.registered_service_name IS DISTINCT FROM
       OLD.registered_service_name THEN
    exact_name_finalization_exists :=
      public.operations_shopify_cs_name_has_exact_finalization_evidence(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        NEW.service_gid,
        NEW.registered_service_name,
        NEW.credential_generation
      );
  END IF;

  IF NOT local_policy_only_update
     AND NEW.registration_state IN ('shadow_simulated', 'registered')
     AND NOT public.operations_shopify_carrier_service_config_is_ready(
       NEW.organization_id,
       NEW.id
     )
     AND NOT exact_finalization_link_exists
     AND NOT exact_name_finalization_exists THEN
    RAISE EXCEPTION
      'Shopify carrier service configuration is not callback-ready';
  END IF;
  RETURN NULL;
END;
$$;

WITH normalized AS (
  SELECT
    config.organization_id,
    config.id,
    config.policy_snapshot || jsonb_build_object(
      'checkoutRateControl',
      jsonb_build_object(
        'version', 'shopify-checkout-rate-control-v1',
        'audience', CASE
          WHEN operations_shopify_checkout_audience_policy_is_valid(
            config.policy_snapshot -> 'shadowCheckoutAudience'
          )
          THEN config.policy_snapshot #>> '{shadowCheckoutAudience,mode}'
          ELSE 'restricted_customers'
        END,
        'rateSource', CASE
          WHEN account.environment = 'production'
            OR activation.state = 'active'
          THEN 'production'
          ELSE 'sandbox'
        END
      )
    ) AS policy_snapshot
  FROM public.operations_shopify_carrier_service_configs config
  JOIN operations_integration_accounts account
    ON account.organization_id = config.organization_id
   AND account.id = config.integration_account_id
  JOIN operations_activation_scopes activation
    ON activation.organization_id = config.organization_id
  WHERE operations_shopify_checkout_rate_control_is_valid(
    config.policy_snapshot -> 'checkoutRateControl'
  ) IS NOT TRUE
)
UPDATE operations_shopify_carrier_service_configs config
SET policy_snapshot = normalized.policy_snapshot,
    policy_hash = encode(
      digest(
        canonical_operations_shopify_checkout_policy_jsonb(
          normalized.policy_snapshot
        ),
        'sha256'
      ),
      'hex'
    ),
    policy_revision = config.policy_revision + 1,
    row_version = config.row_version + 1,
    updated_at = now()
FROM normalized
WHERE config.organization_id = normalized.organization_id
  AND config.id = normalized.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_shopify_configs_rate_control_valid'
  ) THEN
    ALTER TABLE operations_shopify_carrier_service_configs
      ADD CONSTRAINT operations_shopify_configs_rate_control_valid
      CHECK (
        operations_shopify_checkout_rate_control_is_valid(
          policy_snapshot -> 'checkoutRateControl'
        ) IS TRUE
      ) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE operations_shopify_carrier_service_configs
  VALIDATE CONSTRAINT operations_shopify_configs_rate_control_valid;

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_rate_control_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_environment text;
  activation_state text;
  compatibility_control jsonb;
BEGIN
  SELECT environment INTO account_environment
  FROM public.operations_integration_accounts
  WHERE organization_id = NEW.organization_id
    AND id = NEW.integration_account_id
    AND integration_type = 'commerce'
    AND provider = 'shopify';

  IF account_environment IS NULL THEN
    RAISE EXCEPTION
      'Shopify checkout-rate control requires its exact Shopify account';
  END IF;

  IF NOT (NEW.policy_snapshot ? 'checkoutRateControl') THEN
    IF TG_OP = 'UPDATE' THEN
      compatibility_control := OLD.policy_snapshot -> 'checkoutRateControl';
      IF public.operations_shopify_checkout_rate_control_is_valid(
           compatibility_control
         ) IS NOT TRUE THEN
        RAISE EXCEPTION
          'Legacy Shopify config update requires an exact saved checkout-rate control';
      END IF;
    ELSE
      SELECT activation.state INTO activation_state
      FROM public.operations_activation_scopes activation
      WHERE activation.organization_id = NEW.organization_id;
      IF activation_state IS NULL THEN
        RAISE EXCEPTION
          'Legacy Shopify config insert requires its exact Operations activation';
      END IF;
      compatibility_control := jsonb_build_object(
        'version', 'shopify-checkout-rate-control-v1',
        'audience', CASE
          WHEN public.operations_shopify_checkout_audience_policy_is_valid(
            NEW.policy_snapshot -> 'shadowCheckoutAudience'
          )
          THEN NEW.policy_snapshot #>> '{shadowCheckoutAudience,mode}'
          ELSE 'restricted_customers'
        END,
        'rateSource', CASE
          WHEN account_environment = 'production'
            OR activation_state = 'active'
          THEN 'production'
          ELSE 'sandbox'
        END
      );
    END IF;

    NEW.policy_snapshot := NEW.policy_snapshot || jsonb_build_object(
      'checkoutRateControl', compatibility_control
    );
    NEW.policy_hash := encode(
      digest(
        public.canonical_operations_shopify_checkout_policy_jsonb(
          NEW.policy_snapshot
        ),
        'sha256'
      ),
      'hex'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_checkout_rate_control_config_write
  ON operations_shopify_carrier_service_configs;
CREATE TRIGGER
  validate_operations_shopify_checkout_rate_control_config_write
BEFORE INSERT OR UPDATE OF policy_snapshot, integration_account_id
ON operations_shopify_carrier_service_configs
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_rate_control_config();

-- Restricted checkout customer policies are desired local rating intent.
-- Permissioned edits remain available in every Operations safety mode and
-- perform zero provider writes. Disabled/Frozen stop the effective callback,
-- not configuration. Only the saved Restricted TEST source owns the bounded
-- proof lane only on a non-production Shopify account. Production Shopify
-- stores may retain desired TEST policy intent, but it remains blocked with
-- no proof lifetime or subsidy. Restricted LIVE remains desired-only without
-- enforcement.
CREATE OR REPLACE FUNCTION
  validate_operations_shopify_customer_rate_policy_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  integration_provider text;
  integration_type text;
  account_environment text;
  desired_audience text;
  desired_rate_source text;
  test_lane boolean;
BEGIN
  SELECT
    account.provider,
    account.integration_type,
    account.environment,
    config.policy_snapshot #>> '{checkoutRateControl,audience}',
    config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
    INTO
      integration_provider,
      integration_type,
      account_environment,
      desired_audience,
      desired_rate_source
  FROM operations_integration_accounts account
  JOIN operations_shopify_carrier_service_configs config
    ON config.organization_id = account.organization_id
   AND config.integration_account_id = account.id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF integration_provider IS DISTINCT FROM 'shopify'
     OR integration_type IS DISTINCT FROM 'commerce'
     OR desired_audience IS NULL
     OR desired_rate_source IS NULL
  THEN
    RAISE EXCEPTION
      'Shopify customer rate policy requires its exact configured Shopify account';
  END IF;

  test_lane := desired_audience = 'restricted_customers'
    AND desired_rate_source = 'sandbox'
    AND account_environment <> 'production';

  IF test_lane
     AND (
       NEW.status NOT IN ('simulated', 'removed')
       OR NEW.provider_state IS DISTINCT FROM 'not_written'
     )
  THEN
    RAISE EXCEPTION
      'Restricted TEST customer policy must remain provider-write-free proof';
  END IF;

  IF NOT test_lane
     AND (
       NEW.status = 'simulated'
       OR NEW.provider_state = 'not_written'
       OR NEW.shadow_lifetime_mode IS DISTINCT FROM 'none'
       OR NEW.shadow_duration_minutes IS NOT NULL
       OR NEW.shadow_expires_at IS NOT NULL
       OR NEW.shadow_test_charge_mode IS DISTINCT FROM 'carrier_rate'
       OR NEW.shadow_test_service_code IS NOT NULL
       OR NEW.shadow_test_subsidy_reason IS NOT NULL
     )
  THEN
    RAISE EXCEPTION
      'Only the Restricted TEST source may record a simulated customer policy';
  END IF;

  RETURN NEW;
END;
$$;

-- CarrierService creation on a production Shopify store remains protected by
-- the same exact Shadow simulation, resource-scoped authorization,
-- production-confirmation, credential-generation, and one-time finalization
-- fences as every other provider mutation. Remove only the obsolete blanket
-- sandbox-store prohibition from the authorization insert guard.
DO $$
DECLARE
  definition text;
  prior text;
  needle text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'protect_ops_shopify_cs_mut_authorization()'::regprocedure
  ) INTO definition;
  needle := '  IF NEW.operation = ''create''
     AND NEW.account_environment IS DISTINCT FROM ''sandbox'' THEN
    RAISE EXCEPTION
      ''New Shopify CarrierService registration is sandbox-only; production is limited to exact delete reconciliation'';
  END IF;

';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one obsolete production CarrierService creation block, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(definition, needle, '');
  IF definition = prior
     OR position('New Shopify CarrierService registration is sandbox-only'
       IN definition) > 0 THEN
    RAISE EXCEPTION
      'Unable to remove obsolete production CarrierService creation block';
  END IF;
  EXECUTE definition;
END;
$$;

-- Checkout-specific CarrierService simulation is terminal zero-provider-write
-- evidence. Permit that exact aggregate/action family to record a Shadow-mode
-- simulation while any global safety state is observed, but retain the exact
-- current activation revision, credential, aggregate, request, and immutable
-- zero-write fences. No other external effect receives this exception.
DO $$
DECLARE
  definition text;
  prior text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'protect_operations_commerce_external_effect_intent()'::regprocedure
  ) INTO definition;

  occurrence_count := regexp_count(
    definition,
    'request_contains_product_media boolean := false;'
  );
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one commerce-effect product-media declaration, found %',
      occurrence_count;
  END IF;
  definition := replace(
    definition,
    'request_contains_product_media boolean := false;',
    'request_contains_product_media boolean := false;
  checkout_carrier_service_simulation boolean := false;'
  );

  prior := definition;
  definition := regexp_replace(
    definition,
    '(request_contains_product_media := \([[:space:]]+NEW[.]provider = ''shopify''[[:space:]]+AND NEW[.]action = ''shopify[.]product[.]update''[[:space:]]+AND COALESCE\(NEW[.]redacted_request->''patch'', ''\{\}''::jsonb\) \? ''media''[[:space:]]+\);)',
    E'\\1\n\n    checkout_carrier_service_simulation := (\n      NEW.provider = ''shopify''\n      AND NEW.desired_mode = ''shadow''\n      AND NEW.aggregate_type = ''shopify_carrier_service_configuration''\n      AND NEW.action IN (\n        ''shopify.carrier_service.create'',\n        ''shopify.carrier_service.update'',\n        ''shopify.carrier_service.delete''\n      )\n    );',
    'g'
  );
  IF definition = prior
     OR regexp_count(definition, 'checkout_carrier_service_simulation :=')
       <> 1 THEN
    RAISE EXCEPTION
      'Unable to add exact CarrierService zero-write simulation identity';
  END IF;

  prior := definition;
  definition := regexp_replace(
    definition,
    'NOT exact_product_media_authority[[:space:]]+AND NOT exact_faire_write_authority[[:space:]]+AND \([[:space:]]+activation_state IS DISTINCT FROM NEW[.]desired_mode[[:space:]]+OR activation_revision IS DISTINCT FROM NEW[.]activation_revision[[:space:]]+\)',
    'NOT exact_product_media_authority
      AND NOT exact_faire_write_authority
      AND (
        activation_revision IS DISTINCT FROM NEW.activation_revision
        OR (
          NOT checkout_carrier_service_simulation
          AND activation_state IS DISTINCT FROM NEW.desired_mode
        )
      )',
    'g'
  );
  IF definition = prior
     OR position(
       'NOT checkout_carrier_service_simulation' IN definition
     ) = 0 THEN
    RAISE EXCEPTION
      'Unable to decouple exact CarrierService simulation from global mode';
  END IF;
  EXECUTE definition;
END;
$$;

-- A CarrierService provider mutation remains a one-time resource-scoped
-- write. The authorization records the observed safety mode, but authority is
-- the exact config/credential/simulation/request/confirmation fence. Read
-- only, Shadow, and Active may claim; Disabled and Frozen fail closed both at
-- authorization insert and at the final pre-network attempt insert.
DO $$
DECLARE
  constraint_name text;
  constraint_count integer;
BEGIN
  SELECT count(*), min(installed.conname)
  INTO constraint_count, constraint_name
  FROM pg_constraint installed
  WHERE installed.conrelid =
    'operations_shopify_carrier_service_mutation_authorizations'::regclass
    AND installed.contype = 'c'
    AND pg_get_constraintdef(installed.oid) =
      'CHECK ((activation_state = ''shadow''::text))';
  IF constraint_count <> 1 OR constraint_name IS NULL THEN
    RAISE EXCEPTION
      'Expected one legacy Shadow-only CarrierService authorization CHECK, found %',
      constraint_count;
  END IF;
  EXECUTE format(
    'ALTER TABLE operations_shopify_carrier_service_mutation_authorizations DROP CONSTRAINT %I',
    constraint_name
  );
  ALTER TABLE operations_shopify_carrier_service_mutation_authorizations
    ADD CONSTRAINT ops_shopify_cs_mut_auth_activation_state_valid
    CHECK (activation_state IN ('shadow', 'read_only', 'active'));
END;
$$;

DO $$
DECLARE
  definition text;
  prior text;
BEGIN
  SELECT pg_get_functiondef(
    'protect_ops_shopify_cs_mut_authorization()'::regprocedure
  ) INTO definition;

  prior := definition;
  definition := regexp_replace(
    definition,
    'IF NEW[.]activation_state IS DISTINCT FROM ''shadow''[[:space:]]+OR NEW[.]simulation_activation_revision IS NULL',
    'IF NEW.activation_state NOT IN (''shadow'', ''read_only'', ''active'')
     OR NEW.simulation_activation_revision IS NULL',
    'g'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to generalize CarrierService authorization safety mode';
  END IF;

  prior := definition;
  definition := regexp_replace(
    definition,
    'OR current_activation_state IS DISTINCT FROM ''shadow''[[:space:]]+OR current_activation_revision IS DISTINCT FROM[[:space:]]+NEW[.]provider_write_activation_revision',
    'OR current_activation_state NOT IN (''shadow'', ''read_only'', ''active'')',
    'g'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to remove global activation revision as CarrierService write authority';
  END IF;
  definition := replace(
    definition,
    'resource-scoped Shadow fence is stale',
    'resource-scoped checkout-setup fence is stale'
  );
  definition := replace(
    definition,
    'does not match exact Shadow simulation evidence',
    'does not match exact zero-write simulation evidence'
  );
  EXECUTE definition;
END;
$$;

DO $$
DECLARE
  definition text;
  prior text;
BEGIN
  SELECT pg_get_functiondef(
    'protect_ops_shopify_cs_mut_attempt()'::regprocedure
  ) INTO definition;

  prior := definition;
  definition := replace(
    definition,
    'authorization_config_activation_revision integer;',
    'authorization_config_activation_revision integer;
  authorization_activation_state text;'
  );
  definition := replace(
    definition,
    'authorized_mutation.activation_revision,
    authorized_mutation.provider_write_activation_revision,',
    'authorized_mutation.activation_revision,
    authorized_mutation.activation_state,
    authorized_mutation.provider_write_activation_revision,'
  );
  definition := replace(
    definition,
    'authorization_config_activation_revision,
    authorization_provider_write_activation_revision,',
    'authorization_config_activation_revision,
    authorization_activation_state,
    authorization_provider_write_activation_revision,'
  );
  IF definition = prior
     OR regexp_count(definition, 'authorization_activation_state text;')
       <> 1 THEN
    RAISE EXCEPTION
      'Unable to add CarrierService attempt authorization safety state';
  END IF;

  prior := definition;
  definition := replace(
    definition,
    'OR authorization_provider_write_activation_revision IS NULL',
    'OR authorization_provider_write_activation_revision IS NULL
     OR authorization_activation_state NOT IN (
       ''shadow'', ''read_only'', ''active''
     )'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to validate CarrierService authorization safety state';
  END IF;

  prior := definition;
  definition := regexp_replace(
    definition,
    'OR current_activation_state IS DISTINCT FROM ''shadow''[[:space:]]+OR current_activation_revision IS DISTINCT FROM[[:space:]]+authorization_provider_write_activation_revision',
    'OR current_activation_state NOT IN (''shadow'', ''read_only'', ''active'')',
    'g'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to decouple CarrierService attempt from global activation revision';
  END IF;
  definition := replace(
    definition,
    'resource-scoped Shadow authorization expired or became stale before claim',
    'resource-scoped checkout-setup authorization expired or became stale before claim'
  );
  EXECUTE definition;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_cs_name_has_exact_finalization_evidence(
    requested_organization_id uuid,
    requested_config_id uuid,
    requested_integration_account_id uuid,
    requested_from_row_version bigint,
    requested_to_row_version bigint,
    requested_service_gid text,
    requested_registered_service_name text,
    requested_credential_generation integer
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT requested_to_row_version = requested_from_row_version + 1
    AND EXISTS (
      SELECT 1
      FROM operations_shopify_carrier_service_mutation_authorizations auth
      JOIN operations_commerce_external_effect_intents simulation
        ON simulation.organization_id = auth.organization_id
       AND simulation.id = auth.simulation_effect_id
      JOIN operations_shopify_carrier_service_mutation_attempts attempt
        ON attempt.organization_id = auth.organization_id
       AND attempt.authorization_id = auth.id
      LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
        ON outcome.organization_id = attempt.organization_id
       AND outcome.attempt_id = attempt.id
      LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
        resolution
        ON resolution.organization_id = attempt.organization_id
       AND resolution.attempt_id = attempt.id
      WHERE auth.organization_id = requested_organization_id
        AND auth.config_id = requested_config_id
        AND auth.integration_account_id = requested_integration_account_id
        AND auth.operation = 'update'
        AND auth.activation_state IN ('shadow', 'read_only', 'active')
        AND auth.provider_write_activation_revision IS NOT NULL
        AND auth.config_row_version = requested_from_row_version
        AND auth.credential_generation = requested_credential_generation
        AND auth.expected_service_gid = requested_service_gid
        AND simulation.desired_mode = 'shadow'
        AND simulation.state = 'simulated'
        AND simulation.provider_write_count = 0
        AND simulation.redacted_request -> 'mutation' =
          jsonb_build_object(
            'operation', 'update',
            'carrierServiceId', requested_service_gid,
            'serviceName', requested_registered_service_name
          )
        AND (
          (
            outcome.outcome = 'succeeded'
            AND outcome.provider_reference = requested_service_gid
            AND outcome.provider_write_count = 1
          )
          OR (
            resolution.disposition = 'confirmed_applied'
            AND resolution.provider_reference = requested_service_gid
          )
        )
    )
$$;

DO $$
DECLARE
  definition text;
  prior text;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_shopify_carrier_service_config()'::regprocedure
  ) INTO definition;

  prior := definition;
  definition := replace(
    definition,
    'exact_finalization_link_exists boolean := false;',
    'exact_finalization_link_exists boolean := false;
  exact_name_finalization_exists boolean := false;'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to add exact CarrierService name finalization evidence state';
  END IF;

  prior := definition;
  definition := replace(
    definition,
    '  IF NOT exact_finalization_link_exists
     AND provider_authority_fields_changed',
    '  IF OLD.registration_state = ''registered''
     AND NEW.registration_state = ''registered''
     AND NEW.service_gid IS NOT DISTINCT FROM OLD.service_gid
     AND NEW.registered_service_name IS DISTINCT FROM
       OLD.registered_service_name THEN
    IF (
         to_jsonb(NEW) - ARRAY[
           ''row_version'', ''registered_service_name'',
           ''updated_by'', ''updated_at''
         ]::text[]
       ) IS DISTINCT FROM (
         to_jsonb(OLD) - ARRAY[
           ''row_version'', ''registered_service_name'',
           ''updated_by'', ''updated_at''
         ]::text[]
       ) THEN
      RAISE EXCEPTION
        ''Shopify CarrierService name finalization must be name-only'';
    END IF;
    exact_name_finalization_exists :=
      public.operations_shopify_cs_name_has_exact_finalization_evidence(
        NEW.organization_id,
        NEW.id,
        NEW.integration_account_id,
        OLD.row_version,
        NEW.row_version,
        NEW.service_gid,
        NEW.registered_service_name,
        NEW.credential_generation
      );
    IF NOT exact_name_finalization_exists THEN
      RAISE EXCEPTION
        ''Shopify CarrierService name transition requires exact applied one-time mutation evidence'';
    END IF;
  END IF;

  IF NOT exact_finalization_link_exists
     AND provider_authority_fields_changed'
  );
  IF definition = prior
     OR position('exact_name_finalization_exists :=' IN definition) = 0 THEN
    RAISE EXCEPTION
      'Unable to bind CarrierService name finalization to applied evidence';
  END IF;
  EXECUTE definition;
END;
$$;

-- Clone the established warehouse/package/carrier fact predicate under a
-- rating-runtime-only name. Never weaken the shared function: legacy
-- provider-write and fulfillment transitions still require its exact
-- sandbox-store plus activation-revision fence, while global mode transitions
-- no longer mutate checkout configuration merely to advance that revision.
DO $$
DECLARE
  definition text;
  prior text;
  needle text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'::regprocedure
  ) INTO definition;

  needle := 'operations_shopify_carrier_service_config_environment_is_ready';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one Shopify config environment readiness symbol, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(
    definition,
    needle,
    'operations_shopify_carrier_service_rating_environment_is_ready'
  );
  IF definition = prior
     OR position(
       'operations_shopify_carrier_service_config_environment_is_ready'
       IN definition
     ) > 0 THEN
    RAISE EXCEPTION
      'Unable to clone Shopify rating environment readiness exactly';
  END IF;

  needle := 'AND account.environment = ''sandbox''';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one Shopify account environment fence, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(
    definition,
    needle,
    'AND account.environment IN (''sandbox'', ''production'')'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to generalize Shopify rating readiness for production stores';
  END IF;

  needle := 'AND activation.revision = config.activation_revision';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one activation revision fence in rating clone, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(
    definition,
    needle,
    'AND activation.state IN (''disabled'', ''shadow'', ''read_only'', ''active'', ''frozen'')'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to separate Shopify rating readiness from activation revision';
  END IF;

  EXECUTE definition;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_carrier_service_rating_runtime_is_ready(
    requested_organization_id uuid,
    requested_config_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT
      operations_shopify_checkout_rate_control_is_valid(
        config.policy_snapshot -> 'checkoutRateControl'
      )
      AND config.policy_snapshot #>> '{checkoutRateControl,audience}'
        <> 'off'
      AND NOT (
        config.policy_snapshot #>> '{checkoutRateControl,audience}'
          = 'restricted_customers'
        AND config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
          = 'production'
      )
      AND activation.state IN ('shadow', 'read_only', 'active')
      AND config.registration_state = 'registered'
      AND (
        account.environment <> 'production'
        OR config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
          = 'production'
      )
      AND operations_shopify_carrier_service_rating_environment_is_ready(
        config.organization_id,
        config.id,
        config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
      )
    FROM operations_shopify_carrier_service_configs config
    JOIN operations_integration_accounts account
      ON account.organization_id = config.organization_id
     AND account.id = config.integration_account_id
    JOIN operations_activation_scopes activation
      ON activation.organization_id = config.organization_id
    WHERE config.organization_id = requested_organization_id
      AND config.id = requested_config_id
  ), false)
$$;

-- Checkout product/variant mapping is a rating-only local fact. Preserve the
-- established exact lifecycle/weight predicate while permitting verified
-- Shopify production channel evidence; no product publication or provider
-- mutation consumes this predicate. The mapping trigger binds readiness to
-- the saved TEST/LIVE rating environment rather than Active registration
-- authority or the organization activation revision.
CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rating_channel_is_eligible(
    requested_provider text,
    requested_environment text,
    requested_provider_status_raw text,
    requested_normalized_status text,
    requested_provider_active boolean,
    requested_requires_shipping boolean,
    requested_weight_grams integer
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    lower(btrim(requested_provider)) = 'shopify'
    AND lower(btrim(requested_environment)) IN ('sandbox', 'production')
    AND (
      (
        lower(btrim(requested_normalized_status)) = 'active'
        AND lower(btrim(requested_provider_status_raw)) = 'active'
        AND requested_provider_active IS TRUE
      )
      OR (
        lower(btrim(requested_normalized_status)) = 'unlisted'
        AND lower(btrim(requested_provider_status_raw)) = 'unlisted'
        AND requested_provider_active IS FALSE
      )
    )
    AND requested_requires_shipping IS TRUE
    AND requested_weight_grams >= 1,
    false
  )
$$;

DO $$
DECLARE
  definition text;
  prior text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_commerce_variant_pack_mapping()'::regprocedure
  ) INTO definition;

  occurrence_count := regexp_count(
    definition,
    'operations_shopify_checkout_channel_is_eligible'
  );
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one legacy checkout channel predicate, found %',
      occurrence_count;
  END IF;
  definition := replace(
    definition,
    'operations_shopify_checkout_channel_is_eligible',
    'operations_shopify_checkout_rating_channel_is_eligible'
  );

  occurrence_count := regexp_count(
    definition,
    'operations_shopify_carrier_service_config_is_ready\([[:space:]]+config[.]organization_id,[[:space:]]+config[.]id[[:space:]]+\)'
  );
  IF occurrence_count <> 2 THEN
    RAISE EXCEPTION
      'Expected two legacy CarrierService mapping readiness calls, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := regexp_replace(
    definition,
    'operations_shopify_carrier_service_config_is_ready\([[:space:]]+config[.]organization_id,[[:space:]]+config[.]id[[:space:]]+\)',
    'operations_shopify_carrier_service_rating_environment_is_ready(
          config.organization_id,
          config.id,
          config.policy_snapshot #>> ''{checkoutRateControl,rateSource}''
        )',
    'g'
  );
  IF definition = prior THEN
    RAISE EXCEPTION
      'Unable to bind checkout mappings to explicit rating environment';
  END IF;
  definition := replace(
    definition,
    'eligible sandbox shipping and pack evidence',
    'eligible Shopify rating-channel and pack evidence'
  );
  EXECUTE definition;
END;
$$;

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_control_response_is_valid(input jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(input)) <> 9
     OR NOT (input ?& ARRAY[
       'version', 'accountGlobalId', 'configGlobalId', 'idempotencyKey',
       'requestHash', 'checkoutRateControl', 'rowVersion',
       'policyRevision', 'providerWrites'
     ])
     OR COALESCE(input ->> 'version', '')
       <> 'shopify-checkout-rate-control-command-result-v1'
     OR operations_shopify_checkout_rate_control_is_valid(
       input -> 'checkoutRateControl'
     ) IS NOT TRUE
     OR COALESCE(input ->> 'accountGlobalId', '')
       !~ '^gia([0-9]{7}|[0-9a-v]{12})$'
     OR COALESCE(input ->> 'configGlobalId', '')
       !~ '^gscf([0-9]{7}|[0-9a-v]{12})$'
     OR length(COALESCE(input ->> 'idempotencyKey', '')) NOT BETWEEN 8 AND 200
     OR COALESCE(input ->> 'idempotencyKey', '')
       !~ '^[A-Za-z0-9._:-]+$'
     OR COALESCE(input ->> 'requestHash', '') !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(input -> 'rowVersion') IS DISTINCT FROM 'number'
     OR jsonb_typeof(input -> 'policyRevision') IS DISTINCT FROM 'number'
     OR input -> 'providerWrites' IS DISTINCT FROM '0'::jsonb
  THEN
    RETURN false;
  END IF;
  PERFORM (input ->> 'rowVersion')::bigint;
  PERFORM (input ->> 'policyRevision')::bigint;
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_shopify_configs_org_id_account_unique'
  ) THEN
    ALTER TABLE operations_shopify_carrier_service_configs
      ADD CONSTRAINT operations_shopify_configs_org_id_account_unique
      UNIQUE (organization_id, id, integration_account_id);
  END IF;
END;
$$;

-- Persist an immutable, replayable command receipt for every administrator
-- control change. The configuration row_version is the optimistic revision;
-- the receipt binds the exact key, body hash, reason, prior value, and result.
CREATE TABLE IF NOT EXISTS operations_shopify_checkout_rate_control_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  config_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_row_version bigint NOT NULL CHECK (expected_row_version >= 0),
  prior_control jsonb NOT NULL CHECK (
    operations_shopify_checkout_rate_control_is_valid(prior_control)
  ),
  requested_control jsonb NOT NULL CHECK (
    operations_shopify_checkout_rate_control_is_valid(requested_control)
  ),
  resulting_row_version bigint NOT NULL CHECK (
    resulting_row_version = expected_row_version + 1
  ),
  resulting_policy_revision bigint NOT NULL CHECK (
    resulting_policy_revision >= 1
  ),
  response_json jsonb NOT NULL,
  reason text NOT NULL,
  actor_email text NOT NULL,
  provider_write_count integer NOT NULL DEFAULT 0 CHECK (
    provider_write_count = 0
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_rate_control_receipt_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_rate_control_receipt_config_fkey
    FOREIGN KEY (organization_id, config_id, integration_account_id)
    REFERENCES operations_shopify_carrier_service_configs(
      organization_id, id, integration_account_id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_rate_control_receipt_key_unique
    UNIQUE (organization_id, integration_account_id, idempotency_key),
  CONSTRAINT operations_shopify_rate_control_receipt_text_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    AND length(btrim(reason)) BETWEEN 3 AND 500
    AND reason !~ '[[:cntrl:]]'
    AND length(btrim(actor_email)) BETWEEN 3 AND 320
    AND actor_email !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_shopify_rate_control_receipt_response_valid CHECK (
    operations_shopify_checkout_rate_control_response_is_valid(response_json)
    AND (response_json ->> 'rowVersion')::bigint
      = resulting_row_version
    AND (response_json ->> 'policyRevision')::bigint
      = resulting_policy_revision
    AND response_json -> 'checkoutRateControl' = requested_control
    AND response_json ->> 'idempotencyKey' = idempotency_key
    AND response_json ->> 'requestHash' = request_hash
    AND response_json -> 'providerWrites' = '0'::jsonb
  )
);

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_checkout_rate_control_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_account_global_id text;
  expected_config_global_id text;
BEGIN
  SELECT account.global_id, config.global_id
  INTO expected_account_global_id, expected_config_global_id
  FROM operations_integration_accounts account
  JOIN operations_shopify_carrier_service_configs config
    ON config.organization_id = account.organization_id
   AND config.integration_account_id = account.id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id
    AND config.id = NEW.config_id
  FOR SHARE OF account, config;

  IF expected_account_global_id IS NULL
     OR NEW.response_json ->> 'accountGlobalId'
       IS DISTINCT FROM expected_account_global_id
     OR NEW.response_json ->> 'configGlobalId'
       IS DISTINCT FROM expected_config_global_id
  THEN
    RAISE EXCEPTION
      'Shopify checkout-rate control receipt response identity is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  validate_operations_shopify_checkout_rate_control_receipt_write
  ON operations_shopify_checkout_rate_control_receipts;
CREATE TRIGGER validate_operations_shopify_checkout_rate_control_receipt_write
BEFORE INSERT
ON operations_shopify_checkout_rate_control_receipts
FOR EACH ROW EXECUTE FUNCTION
  validate_operations_shopify_checkout_rate_control_receipt();

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_checkout_rate_control_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Shopify checkout-rate control receipts are immutable';
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_checkout_rate_control_receipt_write
  ON operations_shopify_checkout_rate_control_receipts;
CREATE TRIGGER protect_operations_shopify_checkout_rate_control_receipt_write
BEFORE UPDATE OR DELETE
ON operations_shopify_checkout_rate_control_receipts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_shopify_checkout_rate_control_receipt();

ALTER TABLE operations_shopify_checkout_rate_receipts
  ADD COLUMN IF NOT EXISTS rate_source text;

DO $$
DECLARE
  expected_trigger text;
BEGIN
  FOREACH expected_trigger IN ARRAY ARRAY[
    'protect_operations_shopify_checkout_rate_receipt_write',
    'validate_op_shopify_checkout_attempt_finalization'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      WHERE table_row.oid =
        'operations_shopify_checkout_rate_receipts'::regclass
        AND trigger_row.tgname = expected_trigger
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION
        'Expected enabled Shopify checkout receipt trigger % before rate-source backfill',
        expected_trigger;
    END IF;
  END LOOP;
END;
$$;

-- The pre-0299 immutability trigger rejects every receipt update, while the
-- terminal attempt validator re-evaluates historical evidence that predates
-- its latest shape. Disable only those two exact UPDATE triggers inside this
-- migration transaction, change only the new deterministic rate_source
-- column, then restore both. A failure rolls trigger state and data back
-- together; no insert/provider-attempt/package evidence guard is relaxed.
ALTER TABLE operations_shopify_checkout_rate_receipts
  DISABLE TRIGGER protect_operations_shopify_checkout_rate_receipt_write;
ALTER TABLE operations_shopify_checkout_rate_receipts
  DISABLE TRIGGER validate_op_shopify_checkout_attempt_finalization;

UPDATE operations_shopify_checkout_rate_receipts
SET rate_source = CASE activation_state
  WHEN 'active' THEN 'production'
  ELSE 'sandbox'
END
WHERE rate_source IS NULL;

ALTER TABLE operations_shopify_checkout_rate_receipts
  ENABLE TRIGGER protect_operations_shopify_checkout_rate_receipt_write;
ALTER TABLE operations_shopify_checkout_rate_receipts
  ENABLE TRIGGER validate_op_shopify_checkout_attempt_finalization;

DO $$
DECLARE
  expected_trigger text;
BEGIN
  FOREACH expected_trigger IN ARRAY ARRAY[
    'protect_operations_shopify_checkout_rate_receipt_write',
    'validate_op_shopify_checkout_attempt_finalization'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
      WHERE table_row.oid =
        'operations_shopify_checkout_rate_receipts'::regclass
        AND trigger_row.tgname = expected_trigger
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION
        'Shopify checkout receipt trigger % was not restored after rate-source backfill',
        expected_trigger;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE operations_shopify_checkout_rate_receipts
  ALTER COLUMN rate_source SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE operations_shopify_checkout_rate_receipts
    DROP CONSTRAINT IF EXISTS
      operations_shopify_checkout_rate_receipts_activation_state_check;
  ALTER TABLE operations_shopify_checkout_rate_receipts
    DROP CONSTRAINT IF EXISTS
      operations_shopify_checkout_rate_receipt_activation_state_check;
  ALTER TABLE operations_shopify_checkout_rate_receipts
    DROP CONSTRAINT IF EXISTS
      operations_shopify_checkout_receipts_activation_state_valid;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname =
      'operations_shopify_checkout_receipts_activation_state_valid'
  ) THEN
    ALTER TABLE operations_shopify_checkout_rate_receipts
      ADD CONSTRAINT
        operations_shopify_checkout_receipts_activation_state_valid
      CHECK (activation_state IN ('shadow', 'read_only', 'active'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operations_shopify_checkout_receipts_rate_source_valid'
  ) THEN
    ALTER TABLE operations_shopify_checkout_rate_receipts
      ADD CONSTRAINT operations_shopify_checkout_receipts_rate_source_valid
      CHECK (rate_source IN ('sandbox', 'production'));
  END IF;
END;
$$;

-- Expand-phase rolling compatibility: the previously deployed callback omits
-- rate_source. Derive only the exact source already saved on the same current
-- config identity; the existing receipt validator still enforces every
-- configuration, activation, inventory, and rating-runtime fence afterward.
CREATE OR REPLACE FUNCTION
  derive_operations_shopify_checkout_rate_source_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  derived_rate_source text;
BEGIN
  IF NEW.rate_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT config.policy_snapshot #>> '{checkoutRateControl,rateSource}'
    INTO derived_rate_source
  FROM public.operations_shopify_carrier_service_configs config
  WHERE config.organization_id = NEW.organization_id
    AND config.integration_account_id = NEW.integration_account_id
    AND config.id = NEW.config_id
    AND config.row_version = NEW.config_row_version
    AND config.credential_generation = NEW.credential_generation
    AND config.policy_revision = NEW.policy_revision
    AND config.policy_hash = NEW.policy_hash
  FOR SHARE;

  IF derived_rate_source IS NULL
     OR derived_rate_source NOT IN ('sandbox', 'production')
     OR derived_rate_source IS DISTINCT FROM (
       CASE NEW.activation_state
         WHEN 'shadow' THEN 'sandbox'
         WHEN 'active' THEN 'production'
         ELSE NULL
       END
     ) THEN
    RAISE EXCEPTION
      'Shopify checkout receipt rate source compatibility fence is stale';
  END IF;

  NEW.rate_source := derived_rate_source;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  derive_operations_shopify_checkout_rate_source_compat_write
  ON public.operations_shopify_checkout_rate_receipts;
CREATE TRIGGER derive_operations_shopify_checkout_rate_source_compat_write
BEFORE INSERT
ON public.operations_shopify_checkout_rate_receipts
FOR EACH ROW EXECUTE FUNCTION
  derive_operations_shopify_checkout_rate_source_compat();

-- Keep the receipt's observed activation as audit evidence, but validate its
-- irreversible rating lane against the saved source and rating-runtime facts.
DO $$
DECLARE
  definition text;
  prior text;
  needle text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_shopify_checkout_rate_receipt_insert()'::regprocedure
  ) INTO definition;
  needle := 'OR NOT operations_shopify_carrier_service_config_is_ready(';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one callback readiness predicate in receipt validator, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(
    definition,
    needle,
    'OR NOT operations_shopify_carrier_service_rating_runtime_is_ready('
  );
  IF definition = prior THEN
    RAISE EXCEPTION 'Unable to bind checkout receipt insert to rating runtime';
  END IF;
  needle := 'OR current_algorithm_version IS DISTINCT FROM NEW.algorithm_version';
  occurrence_count := (
    length(definition) - length(replace(definition, needle, ''))
  ) / length(needle);
  IF occurrence_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one algorithm-version receipt fence, found %',
      occurrence_count;
  END IF;
  prior := definition;
  definition := replace(
    definition,
    needle,
    'OR current_algorithm_version IS DISTINCT FROM NEW.algorithm_version
     OR (SELECT policy_snapshot #>> ''{checkoutRateControl,rateSource}''
         FROM operations_shopify_carrier_service_configs
         WHERE organization_id = NEW.organization_id
           AND id = NEW.config_id) IS DISTINCT FROM NEW.rate_source'
  );
  IF definition = prior THEN
    RAISE EXCEPTION 'Unable to bind checkout receipt to saved rate source';
  END IF;
  EXECUTE definition;
END;
$$;

-- The receipt source, not the unrelated activation label, is authoritative
-- for carrier evidence and later fulfillment lineage.
DO $$
DECLARE
  function_name text;
  definition text;
  prior text;
  activation_source_pattern text;
  occurrence_count integer;
  expected_count integer;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'operations_legacy_shopify_config_carrier_account_id(uuid,text,text)',
    'derive_operations_legacy_shopify_carrier_selection_key()',
    'validate_one_off_rate_selection_key()',
    'protect_op_shopify_checkout_provider_attempt()',
    'validate_operations_pack_rate_run_complete()'
  ]
  LOOP
    SELECT pg_get_functiondef(function_name::regprocedure) INTO definition;
    prior := definition;
    activation_source_pattern :=
      'CASE[[:space:]]+receipt[.]activation_state'
      || '[[:space:]]+WHEN[[:space:]]+''shadow'''
      || '[[:space:]]+THEN[[:space:]]+''sandbox'''
      || '[[:space:]]+WHEN[[:space:]]+''active'''
      || '[[:space:]]+THEN[[:space:]]+''production'''
      || '[[:space:]]+ELSE[[:space:]]+(NULL|''__invalid__'')'
      || '[[:space:]]+END';
    occurrence_count := regexp_count(
      definition,
      activation_source_pattern
    );
    expected_count := CASE function_name
      WHEN 'validate_operations_pack_rate_run_complete()' THEN 2
      ELSE 1
    END;
    IF occurrence_count <> expected_count THEN
      RAISE EXCEPTION
        'Expected % activation-derived sources in %, found %',
        expected_count, function_name, occurrence_count;
    END IF;
    definition := regexp_replace(
      definition,
      activation_source_pattern,
      'receipt.rate_source /* rolling-health compatibility:'
        || ' carrier_integration.environment = CASE receipt.activation_state */',
      'g'
    );
    IF definition = prior
       OR regexp_count(definition, activation_source_pattern) > 0 THEN
      RAISE EXCEPTION
        'Unable to bind % to receipt rate_source', function_name;
    END IF;
    EXECUTE definition;
  END LOOP;
END;
$$;

-- Finalization must use the immutable receipt source as well. Two legacy
-- activation-derived carrier-environment checks remain in the 0285 body.
DO $$
DECLARE
  definition text;
  activation_source_pattern text;
  occurrence_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'validate_op_shopify_checkout_attempt_finalization()'::regprocedure
  ) INTO definition;
  activation_source_pattern :=
    'CASE[[:space:]]+NEW[.]activation_state'
    || '[[:space:]]+WHEN[[:space:]]+''shadow'''
    || '[[:space:]]+THEN[[:space:]]+''sandbox'''
    || '[[:space:]]+WHEN[[:space:]]+''active'''
    || '[[:space:]]+THEN[[:space:]]+''production'''
    || '[[:space:]]+ELSE[[:space:]]+''__invalid__'''
    || '[[:space:]]+END';
  occurrence_count := regexp_count(definition, activation_source_pattern);
  IF occurrence_count <> 2 THEN
    RAISE EXCEPTION
      'Expected two activation-derived finalization sources, found %',
      occurrence_count;
  END IF;
  definition := regexp_replace(
    definition,
    activation_source_pattern,
    'NEW.rate_source /* rolling-health compatibility:'
      || ' carrier_integration.environment = CASE NEW.activation_state */',
    'g'
  );
  IF regexp_count(definition, activation_source_pattern) > 0
     OR regexp_count(definition, 'NEW[.]rate_source') < 2 THEN
    RAISE EXCEPTION
      'Unable to bind checkout attempt finalization to receipt rate_source';
  END IF;
  EXECUTE definition;
END;
$$;

-- Add rate_source to the immutable receipt identity fence.
DO $$
DECLARE
  definition text;
  prior text;
  new_count integer;
  old_count integer;
BEGIN
  SELECT pg_get_functiondef(
    'protect_operations_shopify_checkout_rate_receipt()'::regprocedure
  ) INTO definition;
  prior := definition;
  new_count := (
    length(definition) - length(replace(definition, 'NEW.activation_state,', ''))
  ) / length('NEW.activation_state,');
  old_count := (
    length(definition) - length(replace(definition, 'OLD.activation_state,', ''))
  ) / length('OLD.activation_state,');
  IF new_count <> 1 OR old_count <> 1 THEN
    RAISE EXCEPTION
      'Expected one NEW and OLD activation identity in checkout receipt guard, found % and %',
      new_count, old_count;
  END IF;
  definition := replace(
    definition,
    'NEW.activation_state,',
    'NEW.activation_state,
    NEW.rate_source,'
  );
  definition := replace(
    definition,
    'OLD.activation_state,',
    'OLD.activation_state,
    OLD.rate_source,'
  );
  IF definition = prior
     OR position('NEW.activation_state,
    NEW.rate_source,' IN definition) = 0
     OR position('OLD.activation_state,
    OLD.rate_source,' IN definition) = 0 THEN
    RAISE EXCEPTION 'Unable to protect checkout receipt rate_source';
  END IF;
  EXECUTE definition;
END;
$$;

-- Every 0299 relation-reading authority function resolves system objects
-- first, exact public application relations second, and the session temp
-- schema last. This prevents caller-controlled schemas or temporary tables
-- from substituting authorization/readiness evidence at runtime.
DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'operations_shopify_checkout_rate_control_is_valid(jsonb)',
    'operations_shopify_checkout_rate_control_response_is_valid(jsonb)',
    'validate_operations_shopify_checkout_rate_control_config()',
    'validate_operations_shopify_customer_rate_policy_write()',
    'validate_operations_shopify_carrier_service_config()',
    'validate_operations_shopify_carrier_service_config_ready()',
    'operations_shopify_cs_config_has_exact_finalization_link(uuid,uuid,uuid,bigint,bigint,text,text,text,text,integer,integer,integer)',
    'protect_operations_commerce_external_effect_intent()',
    'protect_ops_shopify_cs_mut_authorization()',
    'protect_ops_shopify_cs_mut_attempt()',
    'protect_ops_shopify_cs_attempt_authorization_lock()',
    'protect_ops_shopify_cs_mut_outcome()',
    'protect_ops_shopify_cs_mut_resolution()',
    'protect_ops_shopify_cs_name_update_authorization()',
    'protect_ops_shopify_cs_brand_override_update()',
    'protect_ops_shopify_cs_config_mut_link()',
    'operations_shopify_cs_name_has_exact_finalization_evidence(uuid,uuid,uuid,bigint,bigint,text,text,integer)',
    'operations_shopify_carrier_configuration_allows_rating(jsonb,text)',
    'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)',
    'operations_shopify_carrier_service_config_is_ready(uuid,uuid)',
    'operations_shopify_carrier_service_rating_environment_is_ready(uuid,uuid,text)',
    'operations_shopify_carrier_service_rating_runtime_is_ready(uuid,uuid)',
    'validate_operations_commerce_variant_pack_mapping()',
    'validate_operations_shopify_checkout_rate_control_receipt()',
    'protect_operations_shopify_checkout_rate_control_receipt()',
    'validate_operations_shopify_checkout_rate_receipt_insert()',
    'protect_operations_shopify_checkout_rate_receipt()',
    'operations_legacy_shopify_config_carrier_account_id(uuid,text,text)',
    'derive_operations_legacy_shopify_carrier_selection_key()',
    'validate_one_off_rate_selection_key()',
    'protect_op_shopify_checkout_provider_attempt()',
    'validate_op_shopify_checkout_attempt_finalization()',
    'validate_operations_pack_rate_run_complete()',
    'derive_operations_shopify_checkout_rate_source_compat()'
  ]::text[] LOOP
    IF to_regprocedure('public.' || function_signature) IS NULL THEN
      RAISE EXCEPTION
        'Unable to pin missing 0299 authority function %', function_signature;
    END IF;
    EXECUTE format(
      'ALTER FUNCTION public.%s SET search_path = pg_catalog, public, pg_temp',
      function_signature
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION
  operations_shopify_checkout_rate_control_is_valid(jsonb) IS
  'Validates the exact account-level checkout audience and explicit TEST/LIVE carrier rate source.';
COMMENT ON FUNCTION
  operations_shopify_carrier_service_rating_runtime_is_ready(uuid, uuid) IS
  'Checkout rating readiness uses saved audience/source and exact current credential/config/carrier facts; Disabled/Frozen, Off, production-store TEST, and Restricted LIVE without verified provider enforcement fail closed while eligible Shadow/Read_only/Active controls may serve without activation-revision rebinding.';
COMMENT ON TABLE operations_shopify_checkout_rate_control_receipts IS
  'Immutable idempotent administrator command evidence for zero-provider-write checkout audience/source changes.';
COMMENT ON COLUMN operations_shopify_checkout_rate_receipts.rate_source IS
  'Exact saved sandbox or production carrier credential lane used for this receipt; independent of the observed Operations activation label.';
COMMENT ON FUNCTION validate_op_shopify_checkout_attempt_finalization() IS
  'Requires one immutable attempt per rate-source-applicable configured direct carrier account and exact succeeded account evidence for every public offer; successful losing accounts may have no deduplicated offer and the opposite configured environment is not executed.';
