-- Shared Drive permanent deletion can acknowledge before the item disappears.
-- Reconcile through the immediately verifiable trash state on the v6 worker target.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'pipeline_space',
  pipeline.id::text,
  'reconcile_pipeline_hierarchy_v6',
  'google_workspace_v6',
  jsonb_build_object('pipelineId', pipeline.id::text, 'layoutVersion', 6),
  'queued',
  0,
  'pipeline:' || pipeline.id::text || ':hierarchy:v6',
  now(),
  now(),
  now()
FROM pipeline_spaces pipeline
WHERE pipeline.drive_folder_id IS NOT NULL
  AND pipeline.google_service_account_email IS NOT NULL
  AND pipeline.google_shared_drive_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO UPDATE SET
  status = 'queued',
  attempts = 0,
  last_error = NULL,
  available_at = now(),
  processed_at = NULL,
  locked_at = NULL,
  lock_token = NULL,
  updated_at = now();

-- Versioned cleanup attempts are superseded by the v6 item in the same transaction.
UPDATE sync_outbox
SET status = 'succeeded',
    last_error = NULL,
    processed_at = now(),
    locked_at = NULL,
    lock_token = NULL,
    updated_at = now()
WHERE operation IN (
  'reconcile_pipeline_hierarchy_v2',
  'reconcile_pipeline_hierarchy_v3',
  'reconcile_pipeline_hierarchy_v4',
  'reconcile_pipeline_hierarchy_v5'
)
  AND status IN ('queued', 'failed', 'dead');

UPDATE pipeline_spaces
SET provisioning_status = 'queued',
    provisioning_error = NULL,
    provisioning_requested_at = now(),
    provisioning_completed_at = NULL,
    updated_at = now()
WHERE drive_folder_id IS NOT NULL
  AND google_service_account_email IS NOT NULL
  AND google_shared_drive_id IS NOT NULL;
