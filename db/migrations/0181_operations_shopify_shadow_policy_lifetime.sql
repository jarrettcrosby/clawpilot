-- Explicit lifetime semantics for zero-write Shopify Shadow customer policies.
--
-- A NULL duration and NULL expiry must never implicitly mean "forever". The
-- until-turned-off behavior is eligible only when the new discriminator says
-- so explicitly. Existing bounded rows remain timed; every other existing row
-- is backfilled to none and therefore continues to fail closed.

ALTER TABLE operations_shopify_customer_rate_policies
  ADD COLUMN IF NOT EXISTS shadow_lifetime_mode text;

UPDATE operations_shopify_customer_rate_policies
SET shadow_lifetime_mode = CASE
  WHEN shadow_duration_minutes IS NOT NULL
    AND shadow_expires_at IS NOT NULL
    THEN 'timed'
  ELSE 'none'
END
WHERE shadow_lifetime_mode IS NULL;

-- Migration 0178 hashed version, mode, service codes, and duration. Re-seal
-- every existing row with the explicit lifetime discriminator so a backfilled
-- timed policy and a newly saved timed policy have the same semantic hash.
-- Service codes are valid lowercase identifiers without whitespace and are
-- sorted here to match the application normalizer before JSON serialization.
UPDATE operations_shopify_customer_rate_policies policy
SET policy_hash = encode(
  digest(
    '{"version":1,"mode":'
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
      || '}',
    'sha256'
  ),
  'hex'
);

ALTER TABLE operations_shopify_customer_rate_policies
  ALTER COLUMN shadow_lifetime_mode SET DEFAULT 'none',
  ALTER COLUMN shadow_lifetime_mode SET NOT NULL;

ALTER TABLE operations_shopify_customer_rate_policies
  DROP CONSTRAINT IF EXISTS
    operations_shopify_customer_rate_policy_shadow_window_valid;

ALTER TABLE operations_shopify_customer_rate_policies
  ADD CONSTRAINT
    operations_shopify_customer_rate_policy_shadow_window_valid
  CHECK (
    (
      status = 'simulated'
      AND (
        (
          shadow_lifetime_mode = 'timed'
          AND shadow_duration_minutes BETWEEN 15 AND 240
          AND shadow_expires_at IS NOT NULL
          AND shadow_expires_at = updated_at
            + (shadow_duration_minutes * interval '1 minute')
        )
        OR (
          shadow_lifetime_mode = 'until_turned_off'
          AND shadow_duration_minutes IS NULL
          AND shadow_expires_at IS NULL
        )
      )
    )
    OR (
      status IN ('blocked', 'enforced', 'error')
      AND shadow_lifetime_mode = 'none'
      AND shadow_duration_minutes IS NULL
      AND shadow_expires_at IS NULL
    )
    OR (
      status = 'removed'
      AND (
        (
          provider_state = 'not_written'
          AND (
            (
              shadow_lifetime_mode = 'timed'
              AND shadow_duration_minutes BETWEEN 15 AND 240
              AND shadow_expires_at IS NOT NULL
            )
            OR (
              shadow_lifetime_mode = 'until_turned_off'
              AND shadow_duration_minutes IS NULL
              AND shadow_expires_at IS NULL
            )
            OR (
              shadow_lifetime_mode = 'none'
              AND shadow_duration_minutes IS NULL
              AND shadow_expires_at IS NULL
            )
          )
        )
        OR (
          provider_state = 'write_blocked'
          AND shadow_lifetime_mode = 'none'
          AND shadow_duration_minutes IS NULL
          AND shadow_expires_at IS NULL
        )
      )
    )
  );

DROP INDEX IF EXISTS
  operations_shopify_customer_rate_policy_shadow_expiry_idx;
CREATE INDEX
  operations_shopify_customer_rate_policy_shadow_expiry_idx
ON operations_shopify_customer_rate_policies (
  organization_id,
  integration_account_id,
  shadow_expires_at
)
WHERE status = 'simulated'
  AND provider_state = 'not_written'
  AND shadow_lifetime_mode = 'timed';

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
     )
  THEN
    RAISE EXCEPTION
      'Only Operations Shadow may record a simulated customer rate policy';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_lifetime_mode IS
  'Explicit Shadow lifetime: timed, until_turned_off, or none. NULL duration and expiry never imply an indefinite policy.';

COMMENT ON COLUMN
  operations_shopify_customer_rate_policies.shadow_expires_at IS
  'Fail-closed end of a timed 15 through 240 minute Shadow proof. It is NULL for an explicit until_turned_off policy and for non-Shadow rows.';
