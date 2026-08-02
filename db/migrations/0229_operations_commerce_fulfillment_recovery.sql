-- Bound the cross-tenant scheduled scan for unresolved Shopify and Faire
-- fulfillment exports. This index grants no provider authority and stores no
-- lease; the worker continues to fence claims with attempts and updated_at.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE INDEX IF NOT EXISTS
  operations_commerce_fulfillment_exports_recovery_idx
ON operations_commerce_fulfillment_exports (
  state,
  error_code,
  updated_at,
  attempts,
  id
)
WHERE provider IN ('shopify', 'faire')
  AND state IN ('processing', 'failed');

COMMENT ON INDEX
  operations_commerce_fulfillment_exports_recovery_idx IS
  'Bounded lookup for stale processing and retryable or exhausted fulfillment-export recovery; provider writes remain separately authorized.';
