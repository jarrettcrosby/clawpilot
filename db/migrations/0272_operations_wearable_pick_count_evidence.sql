-- Immutable exact-count evidence for multi-unit picks confirmed by the
-- iPhone/Watch workflow. Enforcement is intentionally command-scoped: legacy
-- and web confirmations that omit the paired count-evidence fields retain the
-- pre-existing confirmation behavior.

CREATE TABLE IF NOT EXISTS operations_wearable_pick_count_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  command_receipt_id uuid NOT NULL,
  count_evidence_idempotency_key text NOT NULL,
  order_id uuid NOT NULL,
  order_row_version bigint NOT NULL CHECK (order_row_version >= 0),
  pick_task_id uuid NOT NULL,
  required_quantity bigint NOT NULL CHECK (
    required_quantity BETWEEN 2 AND 9007199254740991
  ),
  entered_quantity bigint NOT NULL CHECK (
    entered_quantity BETWEEN 2 AND 9007199254740991
  ),
  expected_product_barcode text NOT NULL,
  observed_product_barcode text NOT NULL,
  product_captured_at timestamptz NOT NULL,
  product_source text NOT NULL
    CHECK (product_source IN ('iphone_camera', 'meta')),
  counted_at timestamptz NOT NULL,
  count_source text NOT NULL CHECK (count_source IN ('iphone', 'watch')),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  recorded_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  server_observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_wearable_pick_count_evidence_receipt_fkey
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_count_evidence_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_count_evidence_task_fkey
    FOREIGN KEY (organization_id, pick_task_id)
    REFERENCES operations_pick_tasks(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_wearable_pick_count_evidence_key_valid CHECK (
    length(btrim(count_evidence_idempotency_key)) BETWEEN 8 AND 200
    AND count_evidence_idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_wearable_pick_count_evidence_quantity_exact CHECK (
    entered_quantity = required_quantity
  ),
  CONSTRAINT operations_wearable_pick_count_evidence_product_values CHECK (
    length(expected_product_barcode) BETWEEN 1 AND 512
    AND length(observed_product_barcode) BETWEEN 1 AND 512
    AND expected_product_barcode !~ '[[:cntrl:]]'
    AND observed_product_barcode !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_wearable_pick_count_evidence_sequence CHECK (
    product_captured_at < counted_at
  ),
  CONSTRAINT operations_wearable_pick_count_evidence_receipt_task_unique
    UNIQUE (organization_id, command_receipt_id, pick_task_id),
  CONSTRAINT operations_wearable_pick_count_evidence_key_task_unique
    UNIQUE (
      organization_id, count_evidence_idempotency_key, pick_task_id
    )
);

CREATE INDEX IF NOT EXISTS idx_operations_wearable_pick_count_evidence_task
  ON operations_wearable_pick_count_evidence (
    organization_id, pick_task_id, server_observed_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_operations_wearable_pick_count_evidence_order
  ON operations_wearable_pick_count_evidence (
    organization_id, order_id, server_observed_at DESC
  );

COMMENT ON TABLE operations_wearable_pick_count_evidence IS
  'Immutable exact multi-unit counts supplied by the iPhone/Watch workflow and committed atomically with the confirm-picks command receipt.';

CREATE OR REPLACE FUNCTION validate_operations_wearable_pick_count_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_wearable_pick_count_evidence AS existing
    WHERE existing.organization_id = NEW.organization_id
      AND existing.count_evidence_idempotency_key =
        NEW.count_evidence_idempotency_key
      AND existing.command_receipt_id <> NEW.command_receipt_id
  ) THEN
    RAISE EXCEPTION
      'Wearable count evidence idempotency key is already bound to another confirm-picks receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_command_receipts AS receipt
    JOIN operations_orders AS orders
      ON orders.organization_id = receipt.organization_id
     AND orders.global_id = receipt.target_global_id
    JOIN operations_fulfillment_plans AS plan
      ON plan.organization_id = orders.organization_id
     AND plan.order_id = orders.id
    JOIN operations_pick_tasks AS pick
      ON pick.organization_id = plan.organization_id
     AND pick.plan_id = plan.id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.command_receipt_id
      AND receipt.command_type = 'confirm_operations_order_picks'
      AND receipt.status = 'processing'
      AND lower(receipt.actor_email) = lower(NEW.recorded_by)
      AND orders.id = NEW.order_id
      AND orders.row_version = NEW.order_row_version
      AND pick.id = NEW.pick_task_id
      AND pick.status = 'ready'
      AND lower(pick.assigned_to) = lower(NEW.recorded_by)
      AND pick.quantity = trunc(pick.quantity)
      AND pick.quantity BETWEEN 2 AND 9007199254740991
      AND pick.quantity = NEW.required_quantity
      AND NEW.entered_quantity = NEW.required_quantity
  ) THEN
    RAISE EXCEPTION
      'Wearable count evidence must be tied to its processing confirm-picks receipt';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_wearable_pick_count_evidence_validate
  ON operations_wearable_pick_count_evidence;
CREATE TRIGGER operations_wearable_pick_count_evidence_validate
BEFORE INSERT ON operations_wearable_pick_count_evidence
FOR EACH ROW EXECUTE FUNCTION validate_operations_wearable_pick_count_evidence();

CREATE OR REPLACE FUNCTION reject_operations_wearable_pick_count_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operations_wearable_pick_count_evidence rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_wearable_pick_count_evidence_immutable
  ON operations_wearable_pick_count_evidence;
CREATE TRIGGER operations_wearable_pick_count_evidence_immutable
BEFORE UPDATE OR DELETE ON operations_wearable_pick_count_evidence
FOR EACH ROW EXECUTE FUNCTION reject_operations_wearable_pick_count_evidence_mutation();
