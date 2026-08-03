-- Explicit, tenant-owned charge handling for one exact Shopify Shadow test
-- service. Normal carrier pricing remains the default. A zero checkout charge
-- is local simulation evidence only: it is bound to one stable Shopify service
-- code, requires a specific operator reason, and cannot survive removal or an
-- Active policy write.

ALTER TABLE operations_shopify_customer_rate_policies
  ADD COLUMN IF NOT EXISTS shadow_test_charge_mode text,
  ADD COLUMN IF NOT EXISTS shadow_test_service_code text,
  ADD COLUMN IF NOT EXISTS shadow_test_subsidy_reason text;

UPDATE operations_shopify_customer_rate_policies
SET shadow_test_charge_mode = 'carrier_rate',
    shadow_test_service_code = NULL,
    shadow_test_subsidy_reason = NULL
WHERE shadow_test_charge_mode IS NULL;

ALTER TABLE operations_shopify_customer_rate_policies
  ALTER COLUMN shadow_test_charge_mode SET DEFAULT 'carrier_rate',
  ALTER COLUMN shadow_test_charge_mode SET NOT NULL;

ALTER TABLE operations_shopify_customer_rate_policies
  DROP CONSTRAINT IF EXISTS
    operations_shopify_customer_rate_policy_shadow_test_charge_valid;

ALTER TABLE operations_shopify_customer_rate_policies
  ADD CONSTRAINT
    operations_shopify_customer_rate_policy_shadow_test_charge_valid
  CHECK (
    (
      shadow_test_charge_mode = 'carrier_rate'
      AND shadow_test_service_code IS NULL
      AND shadow_test_subsidy_reason IS NULL
    )
    OR (
      shadow_test_charge_mode = 'zero_single_service'
      AND status = 'simulated'
      AND provider_state = 'not_written'
      AND shadow_test_service_code ~
        '^clawpilot:[a-z0-9]([a-z0-9_-]{0,31}):[a-z0-9]([a-z0-9_-]{0,31})$'
      AND shadow_test_subsidy_reason = btrim(shadow_test_subsidy_reason)
      AND length(shadow_test_subsidy_reason) BETWEEN 3 AND 160
      AND shadow_test_subsidy_reason !~ '[[:cntrl:]]'
      AND (
        mode = 'show_all'
        OR (
          mode = 'include_only'
          AND service_codes ? shadow_test_service_code
        )
        OR (
          mode = 'exclude'
          AND NOT (service_codes ? shadow_test_service_code)
        )
      )
    )
  );

-- Version 2 includes the explicit Shadow test charge fields. Re-seal every
-- existing row so persisted hashes and application-generated hashes retain the
-- same canonical field order.
UPDATE operations_shopify_customer_rate_policies policy
SET policy_hash = encode(
  digest(
    '{"version":2,"mode":'
      || to_json(policy.mode)::text
      || ',"serviceCodes":'
      || replace(
        COALESCE(
          (
            SELECT jsonb_agg(code.value ORDER BY code.value)::text
            FROM jsonb_array_elements_text(policy.service_codes)
              AS code(value)
          ),
          '[]'
        ),
        ' ',
        ''
      )
      || ',"shadowLifetimeMode":'
      || CASE
        WHEN policy.shadow_lifetime_mode = 'none' THEN 'null'
        ELSE to_json(policy.shadow_lifetime_mode)::text
      END
      || ',"shadowDurationMinutes":'
      || COALESCE(policy.shadow_duration_minutes::text, 'null')
      || ',"shadowTestChargeMode":'
      || to_json(policy.shadow_test_charge_mode)::text
      || ',"shadowTestServiceCode":'
      || COALESCE(to_json(policy.shadow_test_service_code)::text, 'null')
      || ',"shadowTestSubsidyReason":'
      || COALESCE(to_json(policy.shadow_test_subsidy_reason)::text, 'null')
      || '}',
    'sha256'
  ),
  'hex'
);

CREATE OR REPLACE FUNCTION
  validate_operations_shopify_customer_rate_policy_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  integration_provider text;
  integration_type text;
  activation_state text;
BEGIN
  SELECT account.provider, account.integration_type
    INTO integration_provider, integration_type
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF integration_provider IS DISTINCT FROM 'shopify'
     OR integration_type IS DISTINCT FROM 'commerce'
  THEN
    RAISE EXCEPTION
      'Shopify customer rate policy requires a Shopify commerce account';
  END IF;

  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;

  IF activation_state IS NULL
     OR activation_state NOT IN ('shadow', 'active')
  THEN
    RAISE EXCEPTION
      'Shopify customer rate policy requires Operations Shadow or Active';
  END IF;

  IF activation_state = 'shadow'
     AND (
       NEW.status NOT IN ('simulated', 'removed')
       OR NEW.provider_state IS DISTINCT FROM 'not_written'
     )
  THEN
    RAISE EXCEPTION
      'Operations Shadow customer rate policy must remain provider-write-free';
  END IF;
  IF activation_state = 'active'
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
      'Only Operations Shadow may record a simulated customer rate policy';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_test_charge_mode IS
  'Checkout charge handling: carrier_rate, or zero_single_service for one exact simulated Shadow service.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_test_service_code IS
  'Exact stable Shopify service code eligible for a zero charge during the simulated Shadow test.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_test_subsidy_reason IS
  'Specific 3 through 160 character operator reason for the simulated Shadow checkout subsidy and durable receipt evidence.';
