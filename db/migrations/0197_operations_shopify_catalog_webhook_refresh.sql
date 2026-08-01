-- Lossless Shopify product-webhook to catalog-reconciliation handoff.
--
-- Product webhook bodies remain encrypted in the immutable receipt table. This
-- table stores only a monotonic dirty/reconciled fence so an event arriving
-- during a multi-page catalog sweep cannot be lost. The next worker pass queues
-- another read-only sweep until reconciled_version catches dirty_version.

CREATE TABLE IF NOT EXISTS operations_shopify_catalog_refresh_states (
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  dirty_version bigint NOT NULL DEFAULT 0 CHECK (dirty_version >= 0),
  reconciled_version bigint NOT NULL DEFAULT 0
    CHECK (reconciled_version >= 0 AND reconciled_version <= dirty_version),
  last_receipt_global_id text,
  last_provider_triggered_at timestamptz,
  last_signaled_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_shopify_catalog_refresh_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_catalog_refresh_receipt_fkey
    FOREIGN KEY (last_receipt_global_id)
    REFERENCES operations_commerce_webhook_receipts(global_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_catalog_refresh_times_valid CHECK (
    (dirty_version = 0 AND last_signaled_at IS NULL)
    OR (dirty_version > 0 AND last_signaled_at IS NOT NULL)
  )
);

ALTER TABLE operations_commerce_catalog_sync_jobs
  ADD COLUMN IF NOT EXISTS target_dirty_version bigint NOT NULL DEFAULT 0
    CHECK (target_dirty_version >= 0);

CREATE INDEX IF NOT EXISTS idx_shopify_catalog_refresh_dirty
  ON operations_shopify_catalog_refresh_states (
    updated_at, organization_id, integration_account_id
  )
  WHERE dirty_version > reconciled_version;

COMMENT ON TABLE operations_shopify_catalog_refresh_states IS
  'Monotonic product-webhook watermark for lossless read-only Shopify catalog reconciliation.';

COMMENT ON COLUMN operations_commerce_catalog_sync_jobs.target_dirty_version IS
  'Highest Shopify product-webhook dirty version this immutable catalog sweep promises to reconcile.';

CREATE OR REPLACE FUNCTION protect_operations_shopify_catalog_refresh_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shopify catalog refresh states cannot be deleted';
  END IF;
  IF ROW(NEW.organization_id, NEW.integration_account_id)
       IS DISTINCT FROM
     ROW(OLD.organization_id, OLD.integration_account_id) THEN
    RAISE EXCEPTION 'Shopify catalog refresh state identity is immutable';
  END IF;
  IF NEW.credential_generation < OLD.credential_generation
     OR NEW.dirty_version < OLD.dirty_version
     OR NEW.reconciled_version < OLD.reconciled_version THEN
    RAISE EXCEPTION 'Shopify catalog refresh state versions are monotonic';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_shopify_catalog_refresh_state_write
  ON operations_shopify_catalog_refresh_states;
CREATE TRIGGER protect_operations_shopify_catalog_refresh_state_write
BEFORE UPDATE OR DELETE ON operations_shopify_catalog_refresh_states
FOR EACH ROW EXECUTE FUNCTION protect_operations_shopify_catalog_refresh_state();
