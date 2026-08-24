BEGIN;

-- A Product pack is a pick/constraint fact, not the outbound shipping carton.
-- Ordinary one-each lines may enter Orders without one; cartonization chooses
-- the outbound package later. Multipacks and case picks remain fail-closed.
ALTER TABLE operations_commerce_order_candidate_lines
  DROP CONSTRAINT IF EXISTS commerce_order_lines_ready_valid;

ALTER TABLE operations_commerce_order_candidate_lines
  ADD CONSTRAINT commerce_order_lines_ready_valid CHECK (
    workflow_state NOT IN ('ready', 'promoted')
    OR (
      mapping_state IN ('resolved', 'not_required')
      AND (
        mapping_state = 'not_required'
        OR (
          product_id IS NOT NULL
          AND (
            product_mapping_id IS NOT NULL
            OR (
              external_variant_id IS NULL
              AND external_product_id IS NULL
            )
          )
        )
      )
      AND (
        requires_shipping = false
        OR packaging_state = 'resolved'
        OR (
          requires_shipping = true
          AND unit_multiplier = 1
          AND packaging_state = 'not_required'
        )
      )
      AND price_resolution_state IN ('provider', 'manual')
      AND resolved_currency_code IS NOT NULL
      AND resolved_unit_price_minor IS NOT NULL
      AND unsupported_reason_code IS NULL
      AND cardinality(blocking_codes) = 0
    )
  );

UPDATE operations_commerce_order_candidate_lines
SET packaging_state = 'not_required',
    blocking_codes = array_remove(blocking_codes, 'packaging_required'),
    row_version = row_version + 1,
    updated_at = now()
WHERE workflow_state IN ('held', 'resolving')
  AND unfulfilled_quantity > 0
  AND requires_shipping = true
  AND unit_multiplier = 1
  AND packaging_state = 'unresolved';

UPDATE operations_commerce_order_candidates candidate
SET blocking_codes = array_remove(
      candidate.blocking_codes,
      'packaging_required'
    ),
    row_version = candidate.row_version + 1,
    updated_at = now()
WHERE 'packaging_required' = ANY(candidate.blocking_codes)
  AND candidate.workflow_state IN ('held', 'resolving', 'ready')
  AND NOT EXISTS (
    SELECT 1
    FROM operations_commerce_order_candidate_lines line
    WHERE line.organization_id = candidate.organization_id
      AND line.integration_account_id = candidate.integration_account_id
      AND line.order_candidate_id = candidate.id
      AND line.unfulfilled_quantity > 0
      AND line.requires_shipping = true
      AND line.unit_multiplier <> 1
      AND line.packaging_state <> 'resolved'
  );

COMMENT ON CONSTRAINT commerce_order_lines_ready_valid
  ON operations_commerce_order_candidate_lines IS
  'Unit items may defer outbound package choice to cartonization; multipacks and case picks require resolved approved Product pack evidence.';

COMMIT;
