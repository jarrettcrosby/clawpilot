-- A fully fulfilled source line is retained as immutable provider evidence,
-- but it is not ClawPilot fulfillment demand and does not require an
-- operator-selected order-time price. Keep the unresolved-price blocker
-- invariant for every line that still has positive fulfillment work.

ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS commerce_order_lines_price_block_valid,
  ADD CONSTRAINT commerce_order_lines_price_block_valid CHECK (
    unfulfilled_quantity = 0
    OR price_resolution_state <> 'unresolved'
    OR 'line_price_required' = ANY(blocking_codes)
  );
