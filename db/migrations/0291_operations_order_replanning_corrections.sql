-- Guarded Active-mode operational correction for an unchanged Shopify/Faire
-- order. The correction is local only: it releases an unreleased plan's
-- commitments, preserves every historical planning row, and authorizes a
-- later plan generation without editing provider-authoritative order facts.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES (
  'gorc',
  'operations.order_replanning_correction',
  'Order replanning correction'
)
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_order_replanning_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gorc'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  command_receipt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  source_plan_id uuid NOT NULL,
  correction_type text NOT NULL DEFAULT 'reopen_for_replanning'
    CHECK (correction_type = 'reopen_for_replanning'),
  source_order_status text NOT NULL
    CHECK (source_order_status = 'planned'),
  target_order_status text NOT NULL DEFAULT 'imported'
    CHECK (target_order_status = 'imported'),
  source_plan_version integer NOT NULL CHECK (source_plan_version > 0),
  activation_revision integer NOT NULL CHECK (activation_revision > 0),
  expected_order_row_version bigint NOT NULL
    CHECK (expected_order_row_version >= 0),
  resulting_order_row_version bigint NOT NULL CHECK (
    resulting_order_row_version = expected_order_row_version + 1
  ),
  correction_fingerprint text NOT NULL
    CHECK (correction_fingerprint ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (
    reason = btrim(reason)
    AND length(reason) BETWEEN 8 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  compensation_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(compensation_snapshot) = 'object'
  ),
  provider_read_count integer NOT NULL DEFAULT 0
    CHECK (provider_read_count = 0),
  provider_write_count integer NOT NULL DEFAULT 0
    CHECK (provider_write_count = 0),
  corrected_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_order_replanning_corrections_global_valid CHECK (
    global_id ~ '^gorc([0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_order_replanning_corrections_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_order_replanning_corrections_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_order_replanning_corrections_receipt_fkey
    FOREIGN KEY (organization_id, command_receipt_id)
    REFERENCES operations_command_receipts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_replanning_corrections_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_order_replanning_corrections_plan_fkey
    FOREIGN KEY (organization_id, source_plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_order_replanning_corrections_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_order_replanning_corrections_receipt_unique
    UNIQUE (organization_id, command_receipt_id),
  CONSTRAINT operations_order_replanning_corrections_plan_unique
    UNIQUE (organization_id, source_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_operations_order_replanning_corrections_order
  ON operations_order_replanning_corrections (
    organization_id, order_id, corrected_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION validate_operations_order_replanning_correction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_command_receipts receipt
    JOIN operations_orders order_row
      ON order_row.organization_id = receipt.organization_id
     AND order_row.id = NEW.order_id
    JOIN operations_fulfillment_plans plan
      ON plan.organization_id = order_row.organization_id
     AND plan.id = NEW.source_plan_id
     AND plan.order_id = order_row.id
    WHERE receipt.organization_id = NEW.organization_id
      AND receipt.id = NEW.command_receipt_id
      AND receipt.command_type = 'reopen_operations_order_for_replanning'
      AND receipt.status = 'processing'
      AND receipt.target_global_id = order_row.global_id
      AND order_row.status = 'imported'
      AND order_row.row_version = NEW.resulting_order_row_version
      AND plan.status = 'cancelled'
      AND plan.version_number = NEW.source_plan_version
  ) THEN
    RAISE EXCEPTION
      'Order replanning correction must match one compensated command, order, and unreleased plan';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operations_order_replanning_corrections_validate
  ON operations_order_replanning_corrections;
CREATE TRIGGER operations_order_replanning_corrections_validate
BEFORE INSERT ON operations_order_replanning_corrections
FOR EACH ROW EXECUTE FUNCTION validate_operations_order_replanning_correction();

CREATE OR REPLACE FUNCTION reject_operations_order_replanning_correction_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'operations_order_replanning_corrections rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS operations_order_replanning_corrections_immutable
  ON operations_order_replanning_corrections;
CREATE TRIGGER operations_order_replanning_corrections_immutable
BEFORE UPDATE OR DELETE ON operations_order_replanning_corrections
FOR EACH ROW EXECUTE FUNCTION
  reject_operations_order_replanning_correction_mutation();

COMMENT ON TABLE operations_order_replanning_corrections IS
  'Append-only evidence for zero-provider-write Active corrections that return an unchanged Shopify/Faire order from an unreleased planned state to imported for a fresh plan generation.';
