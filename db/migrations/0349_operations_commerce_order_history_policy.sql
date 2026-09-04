-- Freeze the provider-order ingestion floor when a commerce account is first
-- connected. Reconnecting credentials cannot silently widen retained history.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE operations_commerce_order_history_policies (
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  history_mode text NOT NULL CHECK (history_mode IN (
    'new_orders_only', 'last_7_days', 'last_30_days', 'last_60_days',
    'provider_all'
  )),
  ingestion_floor timestamptz,
  frozen_at timestamptz NOT NULL,
  configured_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT commerce_order_history_policy_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT commerce_order_history_policy_provider_mode_valid CHECK (
    (provider = 'shopify' AND history_mode IN (
      'new_orders_only', 'last_7_days', 'last_30_days', 'last_60_days'
    )) OR provider = 'faire'
  ),
  CONSTRAINT commerce_order_history_policy_floor_valid CHECK (
    (history_mode = 'provider_all' AND ingestion_floor IS NULL)
    OR (
      history_mode <> 'provider_all'
      AND ingestion_floor IS NOT NULL
      AND ingestion_floor <= frozen_at
    )
  )
);

COMMENT ON TABLE operations_commerce_order_history_policies IS
  'Immutable per-commerce-account provider-order ingestion floor, frozen at the first connection and preserved across credential reconnects.';

CREATE OR REPLACE FUNCTION protect_commerce_order_history_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'commerce order history policy is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_integration_accounts account
    WHERE account.organization_id = NEW.organization_id
      AND account.id = NEW.integration_account_id
      AND account.integration_type = 'commerce'
      AND account.provider = NEW.provider
  ) THEN
    RAISE EXCEPTION 'commerce order history policy account is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_order_history_policy_guard
BEFORE INSERT OR UPDATE OR DELETE ON operations_commerce_order_history_policies
FOR EACH ROW EXECUTE FUNCTION protect_commerce_order_history_policy();

WITH frozen AS (
  SELECT date_trunc('milliseconds', clock_timestamp()) AS at
)
INSERT INTO operations_commerce_order_history_policies (
  organization_id, integration_account_id, provider, history_mode,
  ingestion_floor, frozen_at, configured_by
)
SELECT account.organization_id,
       account.id,
       account.provider,
       CASE WHEN account.provider = 'shopify'
         THEN 'last_60_days' ELSE 'provider_all' END,
       CASE WHEN account.provider = 'shopify'
         THEN frozen.at - interval '60 days' ELSE NULL END,
       frozen.at,
       NULL
FROM operations_integration_accounts account
CROSS JOIN frozen
WHERE account.integration_type = 'commerce'
  AND account.provider IN ('shopify', 'faire')
ON CONFLICT (organization_id, integration_account_id) DO NOTHING;

ALTER TABLE operations_commerce_oauth_installations
  ADD COLUMN order_history_mode text NOT NULL DEFAULT 'new_orders_only';

ALTER TABLE operations_commerce_oauth_installations
  ADD CONSTRAINT commerce_oauth_order_history_mode_valid CHECK (
    order_history_mode IN (
      'new_orders_only', 'last_7_days', 'last_30_days', 'last_60_days',
      'provider_all'
    )
  );

ALTER TABLE operations_commerce_order_backfill_sessions
  DROP CONSTRAINT commerce_order_backfill_window_valid,
  DROP CONSTRAINT commerce_order_backfill_kind_valid,
  DROP CONSTRAINT commerce_order_backfill_completeness_valid;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT constraint_record.conname
  INTO constraint_name
  FROM pg_constraint constraint_record
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
   AND attribute.attnum = ANY (constraint_record.conkey)
  WHERE constraint_record.conrelid =
      'operations_commerce_order_backfill_sessions'::regclass
    AND constraint_record.contype = 'c'
    AND attribute.attname = 'coverage_basis'
    AND cardinality(constraint_record.conkey) = 1
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE operations_commerce_order_backfill_sessions DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;

  SELECT constraint_record.conname
  INTO constraint_name
  FROM pg_constraint constraint_record
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_record.conrelid
   AND attribute.attnum = ANY (constraint_record.conkey)
  WHERE constraint_record.conrelid =
      'operations_commerce_order_backfill_sessions'::regclass
    AND constraint_record.contype = 'c'
    AND attribute.attname = 'completeness_state'
    AND cardinality(constraint_record.conkey) = 1
  LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE operations_commerce_order_backfill_sessions DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END;
$$;

ALTER TABLE operations_commerce_order_backfill_sessions
  ADD CONSTRAINT commerce_order_backfill_coverage_basis_check
    CHECK (coverage_basis IN (
      'shopify_rolling_60_days',
      'shopify_configured_history_window',
      'faire_provider_available_orders',
      'faire_configured_history_window',
      'shopify_updated_at_overlap',
      'faire_updated_at_overlap_unfenced'
    )),
  ADD CONSTRAINT commerce_order_backfill_completeness_state_check
    CHECK (completeness_state IN (
      'unknown',
      'shopify_fixed_window_orders_complete',
      'shopify_fixed_window_read_attempt_complete',
      'shopify_configured_window_orders_complete',
      'shopify_configured_window_read_attempt_complete',
      'faire_provider_available_orders_complete',
      'faire_configured_window_orders_complete'
    )),
  ADD CONSTRAINT commerce_order_backfill_window_valid CHECK (
    (session_kind = 'historical_backfill'
      AND coverage_basis IN (
        'shopify_rolling_60_days',
        'shopify_configured_history_window',
        'faire_configured_history_window'
      )
      AND requested_from IS NOT NULL
      AND requested_from <= requested_through)
    OR (session_kind = 'historical_backfill'
      AND coverage_basis = 'faire_provider_available_orders'
      AND requested_from IS NULL)
    OR (session_kind = 'continuous_poll'
      AND requested_from IS NOT NULL
      AND requested_from <= requested_through)
  ),
  ADD CONSTRAINT commerce_order_backfill_kind_valid CHECK (
    (provider = 'shopify' AND session_kind = 'historical_backfill'
      AND coverage_basis IN (
        'shopify_rolling_60_days', 'shopify_configured_history_window'
      ))
    OR (provider = 'shopify' AND session_kind = 'continuous_poll'
      AND coverage_basis = 'shopify_updated_at_overlap')
    OR (provider = 'faire' AND session_kind = 'historical_backfill'
      AND coverage_basis IN (
        'faire_provider_available_orders', 'faire_configured_history_window'
      ))
    OR (provider = 'faire' AND session_kind = 'continuous_poll'
      AND coverage_basis = 'faire_updated_at_overlap_unfenced')
  ),
  ADD CONSTRAINT commerce_order_backfill_completeness_valid CHECK (
    (completeness_state IN (
        'shopify_fixed_window_orders_complete',
        'shopify_configured_window_orders_complete'
      )
      AND provider = 'shopify'
      AND session_kind = 'historical_backfill'
      AND read_all_orders_scope_observed = true
      AND status = 'succeeded')
    OR (completeness_state IN (
        'shopify_fixed_window_read_attempt_complete',
        'shopify_configured_window_read_attempt_complete'
      )
      AND provider = 'shopify'
      AND session_kind = 'historical_backfill'
      AND read_all_orders_scope_observed = false
      AND status = 'succeeded')
    OR (completeness_state IN (
        'faire_provider_available_orders_complete',
        'faire_configured_window_orders_complete'
      )
      AND provider = 'faire'
      AND session_kind = 'historical_backfill'
      AND status = 'succeeded')
    OR completeness_state = 'unknown'
  );
