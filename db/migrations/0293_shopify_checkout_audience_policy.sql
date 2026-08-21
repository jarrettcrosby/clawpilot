-- Separate Shopify checkout-rate audience from the organization-wide
-- Operations activation state. The callback remains registered store-wide;
-- this policy controls whether Shadow returns no rates, admits only exact
-- customer-policy proofs, or serves every otherwise eligible sandbox cart.
--
-- Missing policy remains valid during a rolling deployment and is interpreted
-- by new readers as restricted_customers. The migration backfills every
-- current row, while an old writer that omits the field can only narrow the
-- audience back to that fail-closed legacy behavior.

CREATE OR REPLACE FUNCTION
  operations_shopify_checkout_audience_policy_is_valid(input jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(input)) <> 2
     OR NOT (input ? 'version')
     OR NOT (input ? 'mode')
     OR input ->> 'version' <> 'shopify-checkout-audience-v1'
     OR input ->> 'mode' NOT IN (
       'off',
       'restricted_customers',
       'all_eligible'
     )
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
        'shadowCheckoutAudience',
        jsonb_build_object(
          'version', 'shopify-checkout-audience-v1',
          'mode', 'restricted_customers'
        )
      ) AS policy_snapshot
  FROM operations_shopify_carrier_service_configs config
  WHERE operations_shopify_checkout_audience_policy_is_valid(
    config.policy_snapshot -> 'shadowCheckoutAudience'
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
      'operations_shopify_configs_checkout_audience_valid'
  ) THEN
    ALTER TABLE operations_shopify_carrier_service_configs
      ADD CONSTRAINT
        operations_shopify_configs_checkout_audience_valid
      CHECK (
        operations_shopify_checkout_audience_policy_is_valid(
          policy_snapshot -> 'shadowCheckoutAudience'
        ) IS NOT FALSE
      )
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE operations_shopify_carrier_service_configs
  VALIDATE CONSTRAINT
    operations_shopify_configs_checkout_audience_valid;

COMMENT ON FUNCTION
  operations_shopify_checkout_audience_policy_is_valid(jsonb) IS
  'Validates the explicit Shadow checkout audience. Missing policy is a rolling-compatible restricted-customer default; malformed present policy fails closed.';

COMMENT ON CONSTRAINT
  operations_shopify_configs_checkout_audience_valid
  ON operations_shopify_carrier_service_configs IS
  'Rejects malformed present Shadow checkout-audience policy while permitting older writers to omit it and retain the restricted-customer runtime default.';
