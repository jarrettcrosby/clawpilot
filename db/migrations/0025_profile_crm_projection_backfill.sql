-- Existing pipelines can predate CRM profile projection. Queue every active
-- owner on a versioned internal target that outgoing workers cannot claim.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'pipeline_space',
  pipeline.id::text,
  'sync_pipeline_owner_profile_v1',
  'pipeline_internal_v1',
  jsonb_build_object('pipelineId', pipeline.id::text),
  'queued',
  0,
  'pipeline:' || pipeline.id::text || ':owner-profile:v1',
  now(),
  now(),
  now()
FROM pipeline_spaces pipeline
JOIN app_users owner ON owner.email = pipeline.owner_email
WHERE owner.status = 'active'
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
