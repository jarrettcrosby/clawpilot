BEGIN;

-- Health probes inspect only current-generation receipts that can require
-- operator attention. Keep that bounded path independent from immutable
-- succeeded and ordinary held history, which remains available as evidence.
CREATE INDEX IF NOT EXISTS operations_commerce_webhook_receipts_health_idx
  ON operations_commerce_webhook_receipts (
    organization_id,
    integration_account_id,
    credential_version,
    state,
    received_at
  )
  INCLUDE (topic, lease_expires_at, attempts, max_attempts)
  WHERE state IN ('queued', 'processing', 'failed', 'dead_letter')
     OR (state = 'held' AND topic = 'products/delete');

COMMIT;
