-- Carrier test systems may reuse sentinel tracking numbers across accounts,
-- organizations, packages, and time. Production tracking remains globally
-- unique, while sandbox and mock labels are fenced by their package and
-- immutable attempt evidence instead.

ALTER TABLE operations_labels
  DROP CONSTRAINT IF EXISTS operations_labels_tracking_unique;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_labels_production_tracking_unique
ON operations_labels (carrier, tracking_number)
WHERE environment = 'production';

-- Before the production-only index existed, a successful sandbox provider
-- response could fail local finalization when its reusable tracking sentinel
-- matched an older sandbox label. Those responses did not retain the
-- provider-native label payload and therefore cannot be materialized. Retire
-- only the exact collision-shaped unknown attempts so a new sandbox command
-- can be issued; production and all other unknown outcomes stay fenced.
DROP TRIGGER IF EXISTS protect_operations_label_attempt_write
  ON operations_label_attempts;

UPDATE operations_label_attempts AS attempt
SET state = 'failed',
    error_code = 'OPERATIONS_SANDBOX_TRACKING_COLLISION_RETRYABLE',
    redacted_response = attempt.redacted_response || jsonb_build_object(
      'persistenceDisposition', 'sandbox_tracking_collision',
      'retryAuthorizedByMigration',
      '0319_operations_sandbox_label_tracking_uniqueness'
    )
WHERE attempt.state = 'unknown'
  AND attempt.action = 'create'
  AND attempt.environment = 'sandbox'
  AND attempt.error_code = 'OPERATIONS_LABEL_PERSISTENCE_UNKNOWN'
  AND NULLIF(attempt.redacted_response ->> 'trackingNumber', '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM operations_labels AS package_label
    WHERE package_label.organization_id = attempt.organization_id
      AND package_label.package_id = attempt.package_id
      AND package_label.status = 'created'
  )
  AND EXISTS (
    SELECT 1
    FROM operations_labels AS collision
    WHERE collision.environment = 'sandbox'
      AND collision.carrier = CASE attempt.provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
        ELSE ''
      END
      AND collision.tracking_number =
        attempt.redacted_response ->> 'trackingNumber'
  );

CREATE TRIGGER protect_operations_label_attempt_write
BEFORE UPDATE OR DELETE ON operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_label_attempt();

COMMENT ON INDEX operations_labels_production_tracking_unique IS
  'Production carrier tracking is globally unique. Sandbox providers may reuse non-tracking sentinel values.';
