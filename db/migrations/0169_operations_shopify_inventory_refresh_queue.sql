-- Durable, read-only Shopify inventory refresh scheduling for checkout-rate
-- evidence. The queue is tenant/account scoped and delegates every provider
-- read and projection to the existing inventory reconciliation boundary.
-- It cannot write Shopify, import orders, or adjust order demand.

-- A browser-triggered sync and the unattended worker may use different
-- idempotency keys. Finalize expired attempts before enforcing one durable
-- provider read per Shopify account.
UPDATE operations_commerce_provider_attempts
SET state = 'unknown',
    redacted_response = jsonb_build_object(
      'inventoryApplied', false,
      'providerWrites', 0,
      'orderQuantityAdjustment', 0
    ),
    error_code = 'SHOPIFY_INVENTORY_READ_LEASE_EXPIRED',
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = now()
WHERE action = 'inventory.levels.read'
  AND state = 'prepared'
  AND (
    lease_expires_at IS NULL
    OR lease_expires_at <= now()
  )
  AND NOT EXISTS (
    SELECT 1
    FROM operations_commerce_inventory_captures capture
    WHERE capture.organization_id =
          operations_commerce_provider_attempts.organization_id
      AND capture.integration_account_id =
          operations_commerce_provider_attempts.integration_account_id
      AND capture.provider_attempt_id =
          operations_commerce_provider_attempts.id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_commerce_provider_attempts
    WHERE action = 'inventory.levels.read'
      AND state = 'prepared'
    GROUP BY organization_id, integration_account_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Multiple active Shopify inventory reads require reconciliation before migration 0169';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_read_singleflight
  ON operations_commerce_provider_attempts (
    organization_id, integration_account_id
  )
  WHERE action = 'inventory.levels.read'
    AND state = 'prepared';

CREATE TABLE IF NOT EXISTS operations_shopify_inventory_refresh_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  carrier_service_config_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  activation_revision integer NOT NULL CHECK (activation_revision >= 1),
  config_row_version bigint NOT NULL CHECK (config_row_version >= 0),
  policy_revision bigint NOT NULL CHECK (policy_revision >= 1),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  inventory_max_age_seconds integer NOT NULL CHECK (
    inventory_max_age_seconds BETWEEN 30 AND 86400
  ),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending', 'processing', 'failed',
      'succeeded', 'cancelled', 'dead'
    )
  ),
  cancel_requested boolean NOT NULL DEFAULT false,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (
    max_attempts BETWEEN 1 AND 20
  ),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL
    OR (
      length(btrim(last_error_code)) BETWEEN 3 AND 128
      AND last_error_code !~ '[[:cntrl:]]'
    )
  ),
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(result_summary) = 'object'
  ),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_shopify_inventory_refresh_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_config_fkey
    FOREIGN KEY (organization_id, carrier_service_config_id)
    REFERENCES operations_shopify_carrier_service_configs(
      organization_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_lease_valid CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at > locked_at
    )
    OR (
      status <> 'processing'
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT operations_shopify_inventory_refresh_completion_valid CHECK (
    (status IN ('succeeded', 'cancelled', 'dead'))
      = (completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_active_account
  ON operations_shopify_inventory_refresh_jobs (
    organization_id, integration_account_id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_claim
  ON operations_shopify_inventory_refresh_jobs (
    status, available_at, created_at, id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_history
  ON operations_shopify_inventory_refresh_jobs (
    organization_id, integration_account_id, created_at DESC, id DESC
  );

COMMENT ON TABLE operations_shopify_inventory_refresh_jobs IS
  'Tenant-scoped leased Shopify inventory refresh jobs that preserve fresh checkout evidence through the read-only reconciliation boundary.';
