-- Keep the fulfillment-export claim fence monotonic while accounting for the
-- bounded automatic recovery budget separately. Runtime credential
-- maintenance may park a claim without spending a provider recovery attempt;
-- it must never rewind the `attempts` fencing token.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE operations_commerce_fulfillment_exports
  ADD COLUMN IF NOT EXISTS automatic_recovery_attempts integer;

-- Existing rows retain the conservative pre-migration interpretation where
-- every claimed attempt counted toward the automatic ceiling. A rerun does not
-- overwrite post-migration zero-budget maintenance parks because only the
-- transient NULL backfill is eligible.
UPDATE operations_commerce_fulfillment_exports
SET automatic_recovery_attempts = attempts
WHERE automatic_recovery_attempts IS NULL;

ALTER TABLE operations_commerce_fulfillment_exports
  ALTER COLUMN automatic_recovery_attempts SET DEFAULT 0,
  ALTER COLUMN automatic_recovery_attempts SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'operations_commerce_fulfillment_exports'::regclass
      AND conname =
        'operations_commerce_fulfillment_exports_recovery_budget_valid'
  ) THEN
    ALTER TABLE operations_commerce_fulfillment_exports
      ADD CONSTRAINT
        operations_commerce_fulfillment_exports_recovery_budget_valid
      CHECK (
        automatic_recovery_attempts >= 0
        AND automatic_recovery_attempts <= attempts
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS
  operations_commerce_fulfillment_exports_recovery_budget_idx
ON operations_commerce_fulfillment_exports (
  state,
  error_code,
  updated_at,
  automatic_recovery_attempts,
  attempts,
  id
)
WHERE provider IN ('shopify', 'faire')
  AND state IN ('processing', 'failed');

COMMENT ON COLUMN
  operations_commerce_fulfillment_exports.automatic_recovery_attempts IS
  'Automatic provider recovery budget. Unlike attempts, runtime credential maintenance may restore this counter while attempts remains a monotonic claim fence.';

COMMENT ON INDEX
  operations_commerce_fulfillment_exports_recovery_budget_idx IS
  'Bounded lookup for fulfillment recovery using a budget independent from the monotonic claim fence.';
