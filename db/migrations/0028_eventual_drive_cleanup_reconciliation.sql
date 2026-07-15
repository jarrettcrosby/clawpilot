-- Re-run legacy hierarchy cleanup with explicit deletion-convergence retries.
-- The v5 target prevents outgoing workers from claiming this item during rollout.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'pipeline_space',
  pipeline.id::text,
  'reconcile_pipeline_hierarchy_v5',
  'google_workspace_v5',
  jsonb_build_object('pipelineId', pipeline.id::text, 'layoutVersion', 5),
  'queued',
  0,
  'pipeline:' || pipeline.id::text || ':hierarchy:v5',
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

UPDATE pipeline_spaces
SET provisioning_status = 'queued',
    provisioning_error = NULL,
    provisioning_requested_at = now(),
    provisioning_completed_at = NULL,
    updated_at = now()
WHERE drive_folder_id IS NOT NULL
  AND google_service_account_email IS NOT NULL
  AND google_shared_drive_id IS NOT NULL;
