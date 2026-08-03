-- Permit one exact, audited, name-only CarrierService update while Operations
-- remains Shadow. The desired name defaults to provider-verified Shopify
-- store-entity evidence and may be replaced by an audited administrator
-- override; the existing service identity, callback, profile attachments,
-- active state, and discovery state remain unchanged.

ALTER TABLE operations_shopify_carrier_service_configs
ADD COLUMN IF NOT EXISTS checkout_brand_name_override text;

ALTER TABLE operations_shopify_carrier_service_configs
ADD COLUMN IF NOT EXISTS registered_service_name text;

ALTER TABLE operations_shopify_carrier_service_configs
DROP CONSTRAINT IF EXISTS
  operations_shopify_carrier_service_configs_brand_name_valid;

ALTER TABLE operations_shopify_carrier_service_configs
ADD CONSTRAINT
  operations_shopify_carrier_service_configs_brand_name_valid
CHECK (
  (
    checkout_brand_name_override IS NULL
    OR (
      length(btrim(checkout_brand_name_override)) BETWEEN 1 AND 120
      AND checkout_brand_name_override !~ '[[:cntrl:]]'
    )
  )
  AND (
    registered_service_name IS NULL
    OR (
      length(btrim(registered_service_name)) BETWEEN 1 AND 255
      AND registered_service_name !~ '[[:cntrl:]]'
    )
  )
);

COMMENT ON COLUMN
  operations_shopify_carrier_service_configs.registered_service_name IS
  'Provider-confirmed name currently applied to the exact registered Shopify CarrierService. NULL means no applied-name evidence is held.';

DO $$
DECLARE
  operation_constraint record;
BEGIN
  FOR operation_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    JOIN pg_class table_row
      ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND table_row.relname =
        'operations_shopify_carrier_service_mutation_authorizations'
      AND constraint_row.contype = 'c'
      AND constraint_row.conname <>
        'ops_shopify_cs_mut_auth_service_valid'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%operation%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%create%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%delete%'
  LOOP
    EXECUTE format(
      'ALTER TABLE operations_shopify_carrier_service_mutation_authorizations DROP CONSTRAINT %I',
      operation_constraint.conname
    );
  END LOOP;
END
$$;

ALTER TABLE
  operations_shopify_carrier_service_mutation_authorizations
ADD CONSTRAINT ops_shopify_cs_mut_auth_operation_valid
CHECK (operation IN ('create', 'update', 'delete'));

ALTER TABLE
  operations_shopify_carrier_service_mutation_authorizations
DROP CONSTRAINT IF EXISTS ops_shopify_cs_mut_auth_service_valid;

ALTER TABLE
  operations_shopify_carrier_service_mutation_authorizations
ADD CONSTRAINT ops_shopify_cs_mut_auth_service_valid
CHECK (
  (
    operation = 'create'
    AND expected_service_gid IS NULL
  )
  OR (
    operation IN ('update', 'delete')
    AND expected_service_gid ~
      '^gid://shopify/DeliveryCarrierService/[0-9]+$'
  )
);

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_name_update_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  config_state text;
  config_service_gid text;
  store_entity_name text;
  simulated_mutation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-carrier-service-authorization:'
        || NEW.organization_id::text || ':' || NEW.config_id::text,
      0
    )
  );

  SELECT
    config.registration_state,
    config.service_gid,
    COALESCE(
      NULLIF(
        regexp_replace(
          btrim(config.checkout_brand_name_override),
          '[[:space:]]+', ' ', 'g'
        ),
        ''
      ),
      NULLIF(
        regexp_replace(
          btrim(account.configuration->>'accountName'),
          '[[:space:]]+', ' ', 'g'
        ),
        ''
      )
    ),
    simulation.redacted_request->'mutation'
  INTO
    config_state,
    config_service_gid,
    store_entity_name,
    simulated_mutation
  FROM operations_shopify_carrier_service_configs config
  JOIN operations_integration_accounts account
    ON account.organization_id = config.organization_id
   AND account.id = config.integration_account_id
  JOIN operations_commerce_external_effect_intents simulation
    ON simulation.organization_id = config.organization_id
   AND simulation.id = NEW.simulation_effect_id
  WHERE config.organization_id = NEW.organization_id
    AND config.id = NEW.config_id
    AND config.integration_account_id = NEW.integration_account_id;

  IF config_state IS DISTINCT FROM 'registered'
     OR config_service_gid IS DISTINCT FROM NEW.expected_service_gid
     OR store_entity_name IS NULL
     OR length(btrim(store_entity_name)) < 1
     OR simulated_mutation IS NULL
     OR jsonb_typeof(simulated_mutation) IS DISTINCT FROM 'object'
     OR (
       SELECT count(*)
       FROM jsonb_object_keys(simulated_mutation)
     ) <> 3
     OR simulated_mutation->>'operation' IS DISTINCT FROM 'update'
     OR simulated_mutation->>'carrierServiceId' IS DISTINCT FROM
       NEW.expected_service_gid
     OR simulated_mutation->>'serviceName' IS DISTINCT FROM
       store_entity_name THEN
    RAISE EXCEPTION
      'Shopify CarrierService name update requires the registered service and exact provider-verified store entity';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_name_update_auth_write
  ON operations_shopify_carrier_service_mutation_authorizations;

CREATE TRIGGER
  protect_ops_shopify_cs_name_update_auth_write
BEFORE INSERT
ON operations_shopify_carrier_service_mutation_authorizations
FOR EACH ROW
WHEN (NEW.operation = 'update')
EXECUTE FUNCTION
  protect_ops_shopify_cs_name_update_authorization();

COMMENT ON FUNCTION
  protect_ops_shopify_cs_name_update_authorization() IS
  'Restricts resource-scoped CarrierService update authorization to the existing registered GID and provider-verified Shopify store entity name.';

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_brand_override_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.checkout_brand_name_override IS NOT DISTINCT FROM
     OLD.checkout_brand_name_override THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-carrier-service-authorization:'
        || NEW.organization_id::text || ':' || NEW.id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM operations_shopify_carrier_service_mutation_authorizations
      authorized_mutation
    LEFT JOIN operations_shopify_carrier_service_mutation_attempts attempt
      ON attempt.organization_id = authorized_mutation.organization_id
     AND attempt.authorization_id = authorized_mutation.id
    LEFT JOIN operations_shopify_carrier_service_mutation_outcomes outcome
      ON outcome.organization_id = attempt.organization_id
     AND outcome.attempt_id = attempt.id
    LEFT JOIN operations_shopify_carrier_service_mutation_resolutions
      resolution
      ON resolution.organization_id = attempt.organization_id
     AND resolution.attempt_id = attempt.id
    WHERE authorized_mutation.organization_id = OLD.organization_id
      AND authorized_mutation.config_id = OLD.id
      AND authorized_mutation.config_row_version = OLD.row_version
      AND (
        (
          outcome.outcome = 'failed'
          AND outcome.provider_write_count = 0
        )
        OR resolution.disposition = 'confirmed_not_applied'
        OR (
          attempt.id IS NULL
          AND authorized_mutation.expires_at <= now()
        )
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION
      'Shopify CarrierService name cannot change while current-row provider authorization may still apply';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_brand_override_write
  ON operations_shopify_carrier_service_configs;

CREATE TRIGGER
  protect_ops_shopify_cs_brand_override_write
BEFORE UPDATE OF checkout_brand_name_override
ON operations_shopify_carrier_service_configs
FOR EACH ROW
EXECUTE FUNCTION
  protect_ops_shopify_cs_brand_override_update();

COMMENT ON FUNCTION
  protect_ops_shopify_cs_brand_override_update() IS
  'Serializes brand-name edits with exact CarrierService authorization and rejects edits while current-row provider-write authority is not proven zero-write.';

CREATE OR REPLACE FUNCTION
  protect_ops_shopify_cs_attempt_authorization_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authorization_config_id uuid;
BEGIN
  SELECT authorized_mutation.config_id
  INTO authorization_config_id
  FROM operations_shopify_carrier_service_mutation_authorizations
    authorized_mutation
  WHERE authorized_mutation.organization_id = NEW.organization_id
    AND authorized_mutation.id = NEW.authorization_id;

  IF authorization_config_id IS NULL THEN
    RAISE EXCEPTION
      'Shopify CarrierService attempt authorization was not found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'shopify-carrier-service-authorization:'
        || NEW.organization_id::text || ':'
        || authorization_config_id::text,
      0
    )
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_ops_shopify_cs_attempt_authorization_lock_write
  ON operations_shopify_carrier_service_mutation_attempts;

CREATE TRIGGER
  protect_ops_shopify_cs_attempt_authorization_lock_write
BEFORE INSERT
ON operations_shopify_carrier_service_mutation_attempts
FOR EACH ROW
EXECUTE FUNCTION
  protect_ops_shopify_cs_attempt_authorization_lock();

COMMENT ON FUNCTION
  protect_ops_shopify_cs_attempt_authorization_lock() IS
  'Serializes attempt creation with current-row CarrierService name-preference edits so an expired never-claimed grant is deterministically zero-write.';
