-- Bind Active preparation to the operator's stated reason and the exact
-- current order version. These durable fields complement the application
-- guards that reject blocking order exceptions and package-evidence drift.

ALTER TABLE operations_active_fulfillment_executions
  ADD COLUMN IF NOT EXISTS expected_order_row_version bigint
    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT
    'Legacy Active preparation created before operator reasons were captured';

ALTER TABLE operations_active_fulfillment_executions
  ALTER COLUMN expected_order_row_version DROP DEFAULT,
  ALTER COLUMN reason DROP DEFAULT;

ALTER TABLE operations_active_fulfillment_executions
  DROP CONSTRAINT IF EXISTS
    operations_active_fulfillment_executions_order_version_valid,
  ADD CONSTRAINT operations_active_fulfillment_executions_order_version_valid
    CHECK (expected_order_row_version >= 0),
  DROP CONSTRAINT IF EXISTS
    operations_active_fulfillment_executions_reason_valid,
  ADD CONSTRAINT operations_active_fulfillment_executions_reason_valid CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]'
  );
