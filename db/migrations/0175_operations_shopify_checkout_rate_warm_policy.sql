-- Persist the customer-neutral, tenant-owned checkout rate-warming policy in
-- every Shopify CarrierService configuration. The policy defaults disabled;
-- no process-local fallback may silently activate storefront warming.

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_rate_warm_policy_is_valid(
    input_policy jsonb
  )
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  countries jsonb;
BEGIN
  IF jsonb_typeof(input_policy) IS DISTINCT FROM 'object' THEN
    RETURN false;
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_object_keys(input_policy) AS policy_keys(key)
    WHERE policy_keys.key IN (
      'version',
      'enabled',
      'mode',
      'zoneScope',
      'concurrency',
      'debounceMs',
      'minIntervalMs',
      'supportedCountries',
      'staleCartAbort'
    )
  ) <> 9
     OR (
       SELECT count(*)
       FROM jsonb_object_keys(input_policy)
     ) <> 9
  THEN
    RETURN false;
  END IF;
  IF input_policy ->> 'version'
       IS DISTINCT FROM 'shopify-checkout-rate-warm-v1'
  THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'enabled')
       IS DISTINCT FROM 'boolean'
  THEN
    RETURN false;
  END IF;
  IF input_policy ->> 'mode' IS DISTINCT FROM 'hosted_ajax' THEN
    RETURN false;
  END IF;
  IF input_policy ->> 'zoneScope'
       IS DISTINCT FROM 'all_saved_rate_zones'
  THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'concurrency')
       IS DISTINCT FROM 'number'
     OR COALESCE(input_policy ->> 'concurrency', '')
       !~ '^[0-9]+$'
     OR (input_policy ->> 'concurrency')::numeric
       NOT BETWEEN 1 AND 8
  THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'debounceMs')
       IS DISTINCT FROM 'number'
     OR COALESCE(input_policy ->> 'debounceMs', '')
       !~ '^[0-9]+$'
     OR (input_policy ->> 'debounceMs')::numeric
       NOT BETWEEN 0 AND 5000
  THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(input_policy -> 'minIntervalMs')
       IS DISTINCT FROM 'number'
     OR COALESCE(input_policy ->> 'minIntervalMs', '')
       !~ '^[0-9]+$'
     OR (input_policy ->> 'minIntervalMs')::numeric
       NOT BETWEEN 250 AND 60000
  THEN
    RETURN false;
  END IF;
  countries := input_policy -> 'supportedCountries';
  IF jsonb_typeof(countries) IS DISTINCT FROM 'array'
     OR countries IS DISTINCT FROM jsonb_build_array('US')
  THEN
    RETURN false;
  END IF;
  IF input_policy -> 'staleCartAbort' IS DISTINCT FROM 'true'::jsonb
  THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END;
$$;

WITH normalized AS (
  SELECT
    config.organization_id,
    config.id,
    config.policy_snapshot
      || jsonb_build_object(
        'checkoutRateWarm',
        jsonb_build_object(
          'version', 'shopify-checkout-rate-warm-v1',
          'enabled', false,
          'mode', 'hosted_ajax',
          'zoneScope', 'all_saved_rate_zones',
          'concurrency', 2,
          'debounceMs', 350,
          'minIntervalMs', 1000,
          'supportedCountries', jsonb_build_array('US'),
          'staleCartAbort', true
        )
      ) AS policy_snapshot
  FROM operations_shopify_carrier_service_configs config
  WHERE operations_shopify_checkout_rate_warm_policy_is_valid(
    config.policy_snapshot -> 'checkoutRateWarm'
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
      'operations_shopify_configs_rate_warm_policy_valid'
  ) THEN
    ALTER TABLE operations_shopify_carrier_service_configs
      ADD CONSTRAINT
        operations_shopify_configs_rate_warm_policy_valid
      CHECK (
        operations_shopify_checkout_rate_warm_policy_is_valid(
          policy_snapshot -> 'checkoutRateWarm'
        ) IS TRUE
      )
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE operations_shopify_carrier_service_configs
  VALIDATE CONSTRAINT
    operations_shopify_configs_rate_warm_policy_valid;

COMMENT ON FUNCTION
  operations_shopify_checkout_rate_warm_policy_is_valid(jsonb) IS
  'Validates the explicit customer-neutral Shopify hosted AJAX, United States-only checkout rate-warming v1 policy without applying a process-local default.';

COMMENT ON CONSTRAINT
  operations_shopify_configs_rate_warm_policy_valid
  ON operations_shopify_carrier_service_configs IS
  'Requires every tenant CarrierService configuration to retain a strict versioned checkout rate-warming policy covering all saved rate zones.';
