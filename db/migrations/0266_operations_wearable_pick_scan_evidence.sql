-- Durable, immutable scan observations for warehouses that explicitly require
-- location-first wearable picking. A missing/off policy continues to require
-- no scan-evidence receipt, preserving the pre-policy confirmation workflow.

CREATE TABLE IF NOT EXISTS operations_wearable_pick_scan_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  command_receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_row_version bigint NOT NULL CHECK (order_row_version >= 0),
  pick_task_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  location_id uuid NOT NULL,
  policy_row_version bigint NOT NULL CHECK (policy_row_version > 0),
  expected_location_barcode text NOT NULL,
  observed_location_barcode text NOT NULL,
  location_captured_at timestamptz NOT NULL,
  location_source text NOT NULL
    CHECK (location_source IN ('iphone_camera', 'meta')),
  expected_product_barcode text NOT NULL,
  observed_product_barcode text NOT NULL,
  product_captured_at timestamptz NOT NULL,
  product_source text NOT NULL
    CHECK (product_source IN ('iphone_camera', 'meta')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  server_observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_wearable_pick_scan_evidence_receipt_fkey
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_scan_evidence_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_scan_evidence_task_fkey
    FOREIGN KEY (organization_id, pick_task_id)
    REFERENCES operations_pick_tasks(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_scan_evidence_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_scan_evidence_location_fkey
    FOREIGN KEY (organization_id, location_id)
    REFERENCES operations_locations(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_scan_evidence_location_exact CHECK (
    expected_location_barcode = observed_location_barcode
    AND observed_location_barcode
      ~ '^CP1L-GWL(?:[0-9]{7}|[0-9A-V]{12})$'
  ),
  CONSTRAINT operations_wearable_pick_scan_evidence_product_values CHECK (
    length(expected_product_barcode) BETWEEN 1 AND 512
    AND length(observed_product_barcode) BETWEEN 1 AND 512
    AND expected_product_barcode !~ '[[:cntrl:]]'
    AND observed_product_barcode !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_wearable_pick_scan_evidence_sequence CHECK (
    location_captured_at <= product_captured_at
  ),
  CONSTRAINT operations_wearable_pick_scan_evidence_receipt_task_unique
    UNIQUE (organization_id, command_receipt_id, pick_task_id)
);

CREATE INDEX IF NOT EXISTS idx_operations_wearable_pick_scan_evidence_task
  ON operations_wearable_pick_scan_evidence (
    organization_id, pick_task_id, server_observed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_operations_wearable_pick_scan_evidence_order
  ON operations_wearable_pick_scan_evidence (
    organization_id, order_id, server_observed_at DESC
  );

COMMENT ON TABLE operations_wearable_pick_scan_evidence IS
  'Immutable client scan facts acknowledged by ClawPilot before location-policy pick confirmation. server_observed_at is authoritative receipt time.';

CREATE OR REPLACE FUNCTION reject_operations_wearable_pick_scan_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operations_wearable_pick_scan_evidence rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_wearable_pick_scan_evidence_immutable
  ON operations_wearable_pick_scan_evidence;
CREATE TRIGGER operations_wearable_pick_scan_evidence_immutable
BEFORE UPDATE OR DELETE ON operations_wearable_pick_scan_evidence
FOR EACH ROW EXECUTE FUNCTION reject_operations_wearable_pick_scan_evidence_mutation();
