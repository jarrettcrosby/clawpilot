-- Durable, product-only commerce catalog reconciliation.
--
-- Enabling the account's automatic product-intake policy creates the first
-- job. The runtime worker consumes one bounded provider page at a time using
-- the existing encrypted intake continuation and normalization pipeline.
-- No order, inventory, fulfillment, shipment, or provider write is permitted
-- through this queue.

CREATE TABLE IF NOT EXISTS operations_commerce_catalog_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  requested_by text NOT NULL
    CHECK (
      length(btrim(requested_by)) BETWEEN 3 AND 320
      AND requested_by !~ '[[:cntrl:]]'
    ),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'failed',
      'succeeded', 'cancelled', 'dead'
    )),
  continuation_run_global_id text
    CHECK (
      continuation_run_global_id IS NULL
      OR continuation_run_global_id ~ '^gcir[0-9]{7}$'
    ),
  read_generation integer NOT NULL DEFAULT 0 CHECK (read_generation >= 0),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  provider_records_seen bigint NOT NULL DEFAULT 0
    CHECK (provider_records_seen >= 0),
  products_created bigint NOT NULL DEFAULT 0 CHECK (products_created >= 0),
  products_mapped bigint NOT NULL DEFAULT 0 CHECK (products_mapped >= 0),
  products_unchanged bigint NOT NULL DEFAULT 0
    CHECK (products_unchanged >= 0),
  products_skipped bigint NOT NULL DEFAULT 0 CHECK (products_skipped >= 0),
  products_failed bigint NOT NULL DEFAULT 0 CHECK (products_failed >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8
    CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  last_error_code text
    CHECK (
      last_error_code IS NULL
      OR (
        length(btrim(last_error_code)) BETWEEN 1 AND 128
        AND last_error_code !~ '[[:cntrl:]]'
      )
    ),
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result_summary) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_catalog_sync_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_catalog_sync_policy_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_commerce_product_intake_policies(
      organization_id, integration_account_id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_catalog_sync_lease_valid CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND lock_token IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND locked_at IS NULL
      AND locked_by IS NULL
      AND lock_token IS NULL
    )
  ),
  CONSTRAINT operations_commerce_catalog_sync_completion_valid CHECK (
    (status IN ('succeeded', 'cancelled', 'dead')) = (completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_operations_commerce_catalog_sync_active_account
  ON operations_commerce_catalog_sync_jobs (
    organization_id, integration_account_id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS
  idx_operations_commerce_catalog_sync_claim
  ON operations_commerce_catalog_sync_jobs (
    status, available_at, created_at, id
  )
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS
  idx_operations_commerce_catalog_sync_history
  ON operations_commerce_catalog_sync_jobs (
    organization_id, integration_account_id, created_at DESC, id DESC
  );

COMMENT ON TABLE operations_commerce_catalog_sync_jobs IS
  'Product-only Shopify/Faire catalog backfill and periodic reconciliation jobs. Provider cursors remain encrypted in commerce intake continuations.';
