-- Phase-one shadow evidence for a future bounded Shopify inventory read.
-- Signed webhook quantities remain untrusted and the existing complete
-- authoritative inventory reconciliation remains the only execution path.

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_commerce_webhook_receipts_target_signal_fkey_idx
  ON operations_commerce_webhook_receipts (
    organization_id,
    integration_account_id,
    id,
    global_id
  );

CREATE TABLE IF NOT EXISTS operations_shopify_inventory_target_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  credential_generation integer NOT NULL CHECK (credential_generation > 0),
  receipt_id uuid NOT NULL,
  receipt_global_id text NOT NULL,
  dirty_version bigint NOT NULL CHECK (dirty_version > 0),
  topic text NOT NULL CHECK (topic IN (
    'inventory_items/create',
    'inventory_items/delete',
    'inventory_items/update',
    'inventory_levels/connect',
    'inventory_levels/disconnect',
    'inventory_levels/update'
  )),
  inventory_item_gid text,
  source_location_gid text,
  targeting_state text NOT NULL CHECK (
    targeting_state IN ('targeted', 'full_required')
  ),
  reason_code text NOT NULL CHECK (reason_code IN (
    'exact_identity',
    'unsupported_topic',
    'payload_not_object',
    'multiple_identity',
    'inventory_item_identity_missing',
    'inventory_item_identity_malformed',
    'inventory_item_identity_oversized',
    'inventory_item_identity_conflict',
    'location_identity_missing',
    'location_identity_malformed',
    'location_identity_oversized',
    'location_identity_conflict',
    'inventory_level_identity_malformed',
    'inventory_level_identity_oversized'
  )),
  provider_triggered_at timestamptz,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL DEFAULT 'system' CHECK (created_by = 'system'),
  CONSTRAINT operations_shopify_inventory_target_signals_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_target_signals_receipt_fkey
    FOREIGN KEY (
      organization_id,
      integration_account_id,
      receipt_id,
      receipt_global_id
    )
    REFERENCES operations_commerce_webhook_receipts (
      organization_id,
      integration_account_id,
      id,
      global_id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_shopify_inventory_target_signals_receipt_unique
    UNIQUE (receipt_global_id),
  CONSTRAINT operations_shopify_inventory_target_signals_version_unique
    UNIQUE (organization_id, integration_account_id, dirty_version),
  CONSTRAINT operations_shopify_inventory_target_signals_item_gid_valid CHECK (
    inventory_item_gid IS NULL
    OR inventory_item_gid ~
      '^gid://shopify/InventoryItem/[1-9][0-9]{0,19}$'
  ),
  CONSTRAINT operations_shopify_inventory_target_signals_location_gid_valid
    CHECK (
      source_location_gid IS NULL
      OR source_location_gid ~
        '^gid://shopify/Location/[1-9][0-9]{0,19}$'
    ),
  CONSTRAINT operations_shopify_inventory_target_signals_projection_valid
    CHECK (
      (
        targeting_state = 'targeted'
        AND reason_code = 'exact_identity'
        AND inventory_item_gid IS NOT NULL
        AND (
          (
            topic LIKE 'inventory_items/%'
            AND source_location_gid IS NULL
          )
          OR
          (
            topic LIKE 'inventory_levels/%'
            AND source_location_gid IS NOT NULL
          )
        )
      )
      OR
      (
        targeting_state = 'full_required'
        AND reason_code <> 'exact_identity'
        AND inventory_item_gid IS NULL
        AND source_location_gid IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS
  idx_operations_shopify_inventory_target_signals_metrics
  ON operations_shopify_inventory_target_signals (
    organization_id,
    integration_account_id,
    received_at DESC,
    targeting_state,
    reason_code
  );

CREATE OR REPLACE FUNCTION
  protect_operations_shopify_inventory_target_signal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'Shopify inventory target signals are append-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operations_commerce_webhook_receipts receipt
    JOIN operations_shopify_inventory_refresh_watermarks watermark
      ON watermark.organization_id = receipt.organization_id
     AND watermark.integration_account_id = receipt.integration_account_id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.integration_account_id = NEW.integration_account_id
      AND receipt.id = NEW.receipt_id
      AND receipt.global_id = NEW.receipt_global_id
      AND receipt.provider = 'shopify'
      AND receipt.credential_version = NEW.credential_generation
      AND receipt.topic = NEW.topic
      AND watermark.credential_generation = NEW.credential_generation
      AND watermark.dirty_version = NEW.dirty_version
      AND watermark.last_receipt_global_id = NEW.receipt_global_id
      AND receipt.provider_triggered_at
            IS NOT DISTINCT FROM NEW.provider_triggered_at
      AND receipt.received_at = NEW.received_at
  ) THEN
    RAISE EXCEPTION
      'Shopify inventory target signal must match its exact receipt and dirty watermark';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  protect_operations_shopify_inventory_target_signal_write
  ON operations_shopify_inventory_target_signals;

CREATE TRIGGER protect_operations_shopify_inventory_target_signal_write
BEFORE INSERT OR UPDATE OR DELETE
ON operations_shopify_inventory_target_signals
FOR EACH ROW
EXECUTE FUNCTION protect_operations_shopify_inventory_target_signal();

CREATE OR REPLACE VIEW
  operations_shopify_inventory_target_signal_metrics AS
SELECT
  organization_id,
  integration_account_id,
  date_trunc('hour', received_at) AS received_hour,
  topic,
  targeting_state,
  reason_code,
  count(*)::bigint AS signal_count,
  count(DISTINCT inventory_item_gid)::bigint AS distinct_item_targets,
  count(DISTINCT source_location_gid)::bigint AS distinct_location_targets,
  avg(
    GREATEST(
      0::numeric,
      EXTRACT(EPOCH FROM (received_at - provider_triggered_at))
    )
  ) FILTER (WHERE provider_triggered_at IS NOT NULL)
    AS average_delivery_lag_seconds
FROM operations_shopify_inventory_target_signals
GROUP BY
  organization_id,
  integration_account_id,
  date_trunc('hour', received_at),
  topic,
  targeting_state,
  reason_code;

COMMENT ON TABLE operations_shopify_inventory_target_signals IS
  'Append-only Phase-one classification evidence for one bounded inventory-item target per signed Shopify receipt. These rows are metrics only and never select worker execution or project webhook quantities.';

COMMENT ON VIEW operations_shopify_inventory_target_signal_metrics IS
  'Hourly shadow-only Shopify targetability, reason, distinct-target, and delivery-lag metrics. Inventory execution remains a complete authoritative read.';
