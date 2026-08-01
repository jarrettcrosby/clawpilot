-- Event-accelerated Shopify inventory reconciliation. Webhook payloads are
-- durable trigger evidence only; quantities continue to come exclusively from
-- the bounded, authoritative Shopify inventory read used by migration 0124.

CREATE TABLE IF NOT EXISTS operations_shopify_inventory_refresh_watermarks (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  dirty_version bigint NOT NULL DEFAULT 0 CHECK (dirty_version >= 0),
  reconciled_version bigint NOT NULL DEFAULT 0 CHECK (
    reconciled_version >= 0
    AND reconciled_version <= dirty_version
  ),
  last_receipt_global_id text,
  last_provider_triggered_at timestamptz,
  last_received_at timestamptz,
  last_signaled_at timestamptz,
  last_reconciled_at timestamptz,
  last_reconciled_run_global_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_shopify_inventory_refresh_watermark_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_watermark_receipt_fkey
    FOREIGN KEY (last_receipt_global_id)
    REFERENCES operations_commerce_webhook_receipts(global_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_watermark_run_fkey
    FOREIGN KEY (last_reconciled_run_global_id)
    REFERENCES operations_commerce_inventory_sync_runs(global_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_refresh_watermark_times_valid CHECK (
    (dirty_version = 0 AND last_signaled_at IS NULL)
    OR (dirty_version > 0 AND last_signaled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_refresh_watermarks_dirty
  ON operations_shopify_inventory_refresh_watermarks (
    updated_at, organization_id, integration_account_id
  )
  WHERE dirty_version > reconciled_version;

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_inventory_refresh_watermark()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Shopify inventory refresh watermarks cannot be deleted';
  END IF;

  IF ROW(NEW.organization_id, NEW.integration_account_id)
       IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.integration_account_id) THEN
    RAISE EXCEPTION
      'Shopify inventory refresh watermark identity is immutable';
  END IF;

  IF NEW.credential_generation < OLD.credential_generation
     OR NEW.dirty_version < OLD.dirty_version
     OR NEW.reconciled_version < OLD.reconciled_version THEN
    RAISE EXCEPTION
      'Shopify inventory refresh watermark versions are monotonic';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_inventory_refresh_watermark_write
  ON operations_shopify_inventory_refresh_watermarks;

CREATE TRIGGER protect_operations_shopify_inventory_refresh_watermark_write
BEFORE UPDATE OR DELETE
ON operations_shopify_inventory_refresh_watermarks
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shopify_inventory_refresh_watermark();

ALTER TABLE operations_shopify_inventory_refresh_jobs
  ADD COLUMN IF NOT EXISTS requested_dirty_version bigint NOT NULL DEFAULT 0
    CHECK (requested_dirty_version >= 0);

ALTER TABLE operations_shopify_checkout_rate_receipts
  ADD COLUMN IF NOT EXISTS inventory_refresh_version bigint NOT NULL DEFAULT 0
    CHECK (inventory_refresh_version >= 0);

COMMENT ON TABLE operations_shopify_inventory_refresh_watermarks IS
  'Monotonic per-account Shopify inventory dirty/reconciled versions. Webhook payload quantities are never projected from this table.';

COMMENT ON COLUMN
  operations_shopify_inventory_refresh_jobs.requested_dirty_version IS
  'Exact dirty version captured when this job was queued; completion acknowledges only this version so concurrent webhook signals require a follow-up refresh.';

COMMENT ON COLUMN
  operations_shopify_checkout_rate_receipts.inventory_refresh_version IS
  'Exact clean Shopify inventory watermark captured at claim time. Cache reuse and finalization fail closed if the current dirty/reconciled watermark changes.';
