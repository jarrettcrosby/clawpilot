-- Exact original labels imported after Shopify external-fulfillment
-- reconciliation. These bytes are evidence only: importing or printing them
-- never purchases postage or writes to Shopify.

ALTER TABLE operations_shopify_external_fulfillment_reconciliations
  DROP CONSTRAINT IF EXISTS
    operations_shopify_external_fulfillment_recon_org_id_unique,
  ADD CONSTRAINT
    operations_shopify_external_fulfillment_recon_org_id_unique
    UNIQUE (organization_id, id);

ALTER TABLE operations_print_artifacts
  ADD COLUMN IF NOT EXISTS
    source_external_fulfillment_reconciliation_id uuid,
  ADD COLUMN IF NOT EXISTS external_tracking_number text;

ALTER TABLE operations_print_artifacts
  DROP CONSTRAINT IF EXISTS
    operations_print_artifacts_external_fulfillment_fkey,
  ADD CONSTRAINT operations_print_artifacts_external_fulfillment_fkey
    FOREIGN KEY (
      organization_id,
      source_external_fulfillment_reconciliation_id
    ) REFERENCES operations_shopify_external_fulfillment_reconciliations (
      organization_id,
      id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS
    operations_print_artifacts_external_tracking_valid,
  ADD CONSTRAINT operations_print_artifacts_external_tracking_valid CHECK (
    external_tracking_number IS NULL
    OR (
      external_tracking_number = btrim(external_tracking_number)
      AND length(external_tracking_number) BETWEEN 1 AND 255
      AND external_tracking_number !~ '[[:cntrl:]]'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_storage_reference_valid,
  ADD CONSTRAINT operations_print_artifacts_storage_reference_valid CHECK (
    length(storage_reference) <= 1000
    AND storage_reference ~ '^[a-z][a-z0-9+.-]{1,31}:[^[:cntrl:]]+$'
    AND lower(storage_reference) ~
      '^(https|s3|clawpilot-label|clawpilot-rate-test-label|clawpilot-external-label|clawpilot-document):'
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_valid,
  ADD CONSTRAINT operations_print_artifacts_source_valid CHECK (
    (
      document_type = 'shipping_label'
      AND source_barcode_label_batch_id IS NULL
      AND (
        (
          source_label_id IS NOT NULL
          AND source_rate_test_label_id IS NULL
          AND source_external_fulfillment_reconciliation_id IS NULL
          AND external_tracking_number IS NULL
          AND source_order_id IS NOT NULL
        ) OR (
          source_label_id IS NULL
          AND source_rate_test_label_id IS NOT NULL
          AND source_external_fulfillment_reconciliation_id IS NULL
          AND external_tracking_number IS NULL
          AND source_order_id IS NULL
          AND source_shipment_id IS NULL
        ) OR (
          source_label_id IS NULL
          AND source_rate_test_label_id IS NULL
          AND source_external_fulfillment_reconciliation_id IS NOT NULL
          AND external_tracking_number IS NOT NULL
          AND source_order_id IS NOT NULL
          AND source_shipment_id IS NULL
          AND source_package_id IS NULL
        )
      )
    ) OR (
      document_type = 'packing_slip'
      AND source_label_id IS NULL
      AND source_rate_test_label_id IS NULL
      AND source_external_fulfillment_reconciliation_id IS NULL
      AND external_tracking_number IS NULL
      AND source_barcode_label_batch_id IS NULL
    ) OR (
      document_type IN ('product_label', 'location_label')
      AND source_label_id IS NULL
      AND source_rate_test_label_id IS NULL
      AND source_external_fulfillment_reconciliation_id IS NULL
      AND external_tracking_number IS NULL
      AND source_order_id IS NULL
      AND source_shipment_id IS NULL
      AND source_package_id IS NULL
      AND source_barcode_label_batch_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_external_fulfillment_label_unique
ON operations_print_artifacts (
  organization_id,
  source_external_fulfillment_reconciliation_id,
  external_tracking_number,
  format,
  media_size
)
WHERE source_external_fulfillment_reconciliation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_operations_print_artifacts_external_fulfillment
ON operations_print_artifacts (
  organization_id,
  source_external_fulfillment_reconciliation_id,
  created_at DESC
)
WHERE source_external_fulfillment_reconciliation_id IS NOT NULL;

COMMENT ON COLUMN
  operations_print_artifacts.source_external_fulfillment_reconciliation_id IS
  'Immutable Shopify external-fulfillment reconciliation that authorized an operator import of the exact original label bytes.';

COMMENT ON COLUMN operations_print_artifacts.external_tracking_number IS
  'Exact tracking number from the immutable external-fulfillment evidence associated with this imported label.';

COMMENT ON TABLE operations_print_artifact_payloads IS
  'Immutable rendered or operator-imported print payloads, including exact external carrier-label bytes.';
