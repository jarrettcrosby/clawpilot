-- Persist the bounded checkout carton-plan/rate objective in every
-- organization/account/warehouse-bound Shopify CarrierService configuration.
-- A callback must never silently substitute a process-local optimizer policy.

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_plan_rate_policy_is_valid(
    input_policy jsonb
  )
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  priority jsonb;
BEGIN
  IF jsonb_typeof(input_policy) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_object_keys(input_policy) AS policy_keys(key)
    WHERE policy_keys.key IN (
      'version',
      'maxCandidates',
      'objectivePriority',
      'handlingCostMinorPerPackage',
      'handlingCostCurrency'
    )
  ) <> 5
     OR (
       SELECT count(*)
       FROM jsonb_object_keys(input_policy)
     ) <> 5
  THEN
    RETURN false;
  END IF;
  IF input_policy ->> 'version'
       IS DISTINCT FROM 'shopify-checkout-plan-rate-objective-v2'
  THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'maxCandidates')
       IS DISTINCT FROM 'number'
  THEN
    RETURN false;
  END IF;
  IF COALESCE(input_policy ->> 'maxCandidates', '') !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;
  IF (input_policy ->> 'maxCandidates')::numeric NOT BETWEEN 1 AND 4 THEN
    RETURN false;
  END IF;
  priority := input_policy -> 'objectivePriority';
  IF jsonb_typeof(priority) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(priority) <> 3 THEN
    RETURN false;
  END IF;
  IF (
    SELECT count(DISTINCT objective.value)
    FROM jsonb_array_elements_text(priority) objective(value)
    WHERE objective.value IN (
      'landed_price',
      'package_count',
      'unused_cube'
    )
  ) <> 3 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(
       input_policy -> 'handlingCostMinorPerPackage'
     ) IS DISTINCT FROM 'number'
  THEN
    RETURN false;
  END IF;
  IF COALESCE(
       input_policy ->> 'handlingCostMinorPerPackage',
       ''
     ) !~ '^[0-9]+$'
  THEN
    RETURN false;
  END IF;
  IF (
    input_policy ->> 'handlingCostMinorPerPackage'
  )::numeric NOT BETWEEN 0 AND 1000000 THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'handlingCostCurrency')
       IS DISTINCT FROM 'string'
  THEN
    RETURN false;
  END IF;
  IF COALESCE(input_policy ->> 'handlingCostCurrency', '')
       !~ '^[A-Z]{3}$'
  THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION
  canonical_operations_shopify_checkout_policy_jsonb(
    input_value jsonb
  )
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  serialized text;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      SELECT
        '{' || COALESCE(
          string_agg(
            to_jsonb(entry.key)::text
              || ':'
              || canonical_operations_shopify_checkout_policy_jsonb(
                entry.value
              ),
            ',' ORDER BY entry.key
          ),
          ''
        ) || '}'
      INTO serialized
      FROM jsonb_each(input_value) entry;
    WHEN 'array' THEN
      SELECT
        '[' || COALESCE(
          string_agg(
            canonical_operations_shopify_checkout_policy_jsonb(
              element.value
            ),
            ',' ORDER BY element.ordinality
          ),
          ''
        ) || ']'
      INTO serialized
      FROM jsonb_array_elements(input_value)
        WITH ORDINALITY AS element(value, ordinality);
    ELSE
      serialized := input_value::text;
  END CASE;
  RETURN serialized;
END;
$$;

INSERT INTO workspace_organization_preferences (
  organization_id,
  measurement_system,
  currency_code,
  revision
)
SELECT DISTINCT
  config.organization_id,
  'imperial',
  'USD',
  1
FROM operations_shopify_carrier_service_configs config
LEFT JOIN workspace_organization_preferences preference
  ON preference.organization_id = config.organization_id
WHERE preference.organization_id IS NULL
ON CONFLICT (organization_id) DO NOTHING;

WITH normalized AS (
  SELECT
    config.organization_id,
    config.id,
    config.policy_snapshot
      || jsonb_build_object(
        'planRateOptimization',
        jsonb_build_object(
          'version',
            'shopify-checkout-plan-rate-objective-v2',
          'maxCandidates', 4,
          'objectivePriority',
            jsonb_build_array(
              'landed_price',
              'package_count',
              'unused_cube'
            ),
          'handlingCostMinorPerPackage', 0,
          'handlingCostCurrency', upper(preference.currency_code)
        )
      ) AS policy_snapshot
  FROM operations_shopify_carrier_service_configs config
  JOIN workspace_organization_preferences preference
    ON preference.organization_id = config.organization_id
  WHERE operations_shopify_checkout_plan_rate_policy_is_valid(
    config.policy_snapshot -> 'planRateOptimization'
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
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'operations_shopify_configs_plan_rate_policy_valid'
  ) THEN
    ALTER TABLE operations_shopify_carrier_service_configs
      ADD CONSTRAINT
        operations_shopify_configs_plan_rate_policy_valid
      CHECK (
        operations_shopify_checkout_plan_rate_policy_is_valid(
          policy_snapshot -> 'planRateOptimization'
        ) IS TRUE
      )
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE operations_shopify_carrier_service_configs
  VALIDATE CONSTRAINT
    operations_shopify_configs_plan_rate_policy_valid;

COMMENT ON FUNCTION
  operations_shopify_checkout_plan_rate_policy_is_valid(jsonb) IS
  'Validates the persisted bounded Shopify checkout carton-plan/rate objective without applying a process-local default.';

COMMENT ON CONSTRAINT
  operations_shopify_configs_plan_rate_policy_valid
  ON operations_shopify_carrier_service_configs IS
  'Requires every tenant/account/warehouse CarrierService configuration to retain an explicit versioned checkout plan-rate policy.';
