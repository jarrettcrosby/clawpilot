-- A provider's absence of a requested delivery date is an observed fact, not
-- an operational exception. Keep the null date explicit and distinct from a
-- non-shipping order, while preserving optional manual/SLA resolution later.

DO $$
DECLARE
  candidate_constraint record;
BEGIN
  FOR candidate_constraint IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid
        = 'operations_commerce_order_candidates'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid)
          LIKE '%delivery_resolution_state%'
      AND constraint_row.conname NOT IN (
        'commerce_order_candidates_delivery_valid',
        'commerce_order_candidates_ready_valid'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE operations_commerce_order_candidates DROP CONSTRAINT %I',
      candidate_constraint.conname
    );
  END LOOP;
END
$$;

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS commerce_order_candidates_delivery_valid,
  DROP CONSTRAINT IF EXISTS commerce_order_candidates_ready_valid,
  ADD CONSTRAINT commerce_order_candidates_delivery_state_valid CHECK (
    delivery_resolution_state IN (
      'unresolved', 'provider', 'manual', 'policy', 'not_required',
      'not_supplied'
    )
  ),
  ADD CONSTRAINT commerce_order_candidates_delivery_valid CHECK (
    (
      delivery_resolution_state = 'provider'
      AND provider_requested_delivery_at IS NOT NULL
      AND requested_delivery_at = provider_requested_delivery_at
    )
    OR (
      delivery_resolution_state IN ('manual', 'policy')
      AND requested_delivery_at IS NOT NULL
    )
    OR (
      delivery_resolution_state = 'not_required'
      AND requires_shipping = false
      AND requested_delivery_at IS NULL
    )
    OR (
      delivery_resolution_state = 'not_supplied'
      AND requires_shipping = true
      AND provider_requested_delivery_at IS NULL
      AND requested_delivery_at IS NULL
      AND delivery_policy_version IS NULL
    )
    OR (
      delivery_resolution_state = 'unresolved'
      AND requested_delivery_at IS NULL
    )
  ),
  ADD CONSTRAINT commerce_order_candidates_ready_valid CHECK (
    workflow_state NOT IN ('ready', 'promoted')
    OR (
      customer_resolution_state = 'resolved'
      AND customer_id IS NOT NULL
      AND (
        (requires_shipping = true
          AND ship_to_snapshot_state = 'confirmed')
        OR requires_shipping = false
      )
      AND delivery_resolution_state IN (
        'provider', 'manual', 'policy', 'not_required', 'not_supplied'
      )
      AND unsupported_reason_code IS NULL
      AND cardinality(blocking_codes) = 0
    )
  );

-- Do not rewrite pre-migration unresolved rows. The former normalizers did
-- not retain enough evidence to distinguish an absent provider date from a
-- malformed nonempty value. A fresh provider read classifies that boundary.

COMMENT ON CONSTRAINT commerce_order_candidates_delivery_state_valid
  ON operations_commerce_order_candidates IS
  'not_supplied is a shippable order whose provider supplied no requested delivery date; it is nonblocking and remains nullable.';
