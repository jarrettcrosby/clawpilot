BEGIN;

-- A fresh provider observation may outlive an earlier successful promotion.
-- The imported-order workbench must converge on that canonical identity rather
-- than offering a second Accept action that can only hit the uniqueness fence.
WITH duplicate_workbenches AS (
  SELECT workbench.organization_id,
         workbench.last_command_receipt_id,
         canonical.global_id AS canonical_order_global_id
  FROM operations_commerce_order_workbench workbench
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = workbench.organization_id
   AND candidate.integration_account_id = workbench.integration_account_id
   AND candidate.id = workbench.candidate_id
  JOIN operations_orders canonical
    ON canonical.organization_id = candidate.organization_id
   AND canonical.integration_account_id = candidate.integration_account_id
   AND canonical.external_order_id = candidate.external_order_id
  WHERE workbench.canonical_order_id IS NULL
    AND candidate.canonical_order_id IS NULL
)
UPDATE operations_command_receipts receipt
SET status = 'failed',
    result_global_id = duplicate.canonical_order_global_id,
    error_code = 'OPERATIONS_IMPORTED_ORDER_ALREADY_CANONICAL',
    error_message = 'This provider order is already available in Orders',
    completed_at = now(),
    updated_at = now()
FROM duplicate_workbenches duplicate
WHERE receipt.organization_id = duplicate.organization_id
  AND receipt.id = duplicate.last_command_receipt_id
  AND receipt.status = 'processing';

UPDATE operations_commerce_order_workbench workbench
SET canonical_order_id = canonical.id,
    row_version = workbench.row_version + 1,
    updated_at = now()
FROM operations_commerce_order_candidates candidate,
     operations_orders canonical
WHERE candidate.organization_id = workbench.organization_id
  AND candidate.integration_account_id = workbench.integration_account_id
  AND candidate.id = workbench.candidate_id
  AND canonical.organization_id = candidate.organization_id
  AND canonical.integration_account_id = candidate.integration_account_id
  AND canonical.external_order_id = candidate.external_order_id
  AND workbench.canonical_order_id IS NULL
  AND candidate.canonical_order_id IS NULL;

COMMENT ON COLUMN operations_commerce_order_workbench.canonical_order_id IS
  'Canonical order reached by this accepted provider identity, including convergence when an older candidate already promoted the same provider order.';

COMMIT;
