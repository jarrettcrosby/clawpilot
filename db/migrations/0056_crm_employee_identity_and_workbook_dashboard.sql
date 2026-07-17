-- A ClawPilot login is not automatically a CRM employee. CRM employees receive
-- a permanent gu identity; every login still retains its separate gc Contact
-- identity. Preserve Jarrett (the root owner) and Olivia as the initial CRM
-- employees and retire every mistakenly issued gu without making it reusable.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS crm_user_enabled boolean NOT NULL DEFAULT false;

UPDATE app_users
SET crm_user_enabled = role = 'owner' OR email = 'olivia@suburbiasandwichco.com',
    updated_at = now();

CREATE TEMP TABLE retired_app_user_global_identities (
  email text PRIMARY KEY,
  reference_code text NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO retired_app_user_global_identities (email, reference_code)
SELECT email, reference_code
FROM app_users
WHERE NOT crm_user_enabled
  AND reference_code IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crm_contacts contact
    JOIN retired_app_user_global_identities retired
      ON retired.reference_code = contact.owner_user_reference_code
  ) THEN
    RAISE EXCEPTION 'A non-employee CRM user still owns Contacts; reassign those Contacts before retiring the gu identity';
  END IF;
END;
$$;

ALTER TABLE app_users
  ALTER COLUMN reference_code DROP DEFAULT,
  ALTER COLUMN reference_code DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS app_users_reference_code_valid,
  ADD CONSTRAINT app_users_reference_code_valid CHECK (
    reference_code IS NULL OR reference_code ~ '^gu[0-9]{7}$'
  );

UPDATE app_users
SET reference_code = NULL,
    suitecrm_user_id = NULL,
    suitecrm_username = NULL,
    updated_at = now()
WHERE NOT crm_user_enabled;

UPDATE crm_reference_registry registry
SET status = 'retired',
    retired_at = COALESCE(registry.retired_at, now())
FROM retired_app_user_global_identities retired
WHERE registry.reference_code = retired.reference_code
  AND registry.status = 'active';

ALTER TABLE app_users
  ADD CONSTRAINT app_users_crm_employee_identity_complete CHECK (
    (
      crm_user_enabled
      AND reference_code IS NOT NULL
      AND reference_code ~ '^gu[0-9]{7}$'
    )
    OR (
      NOT crm_user_enabled
      AND reference_code IS NULL
      AND suitecrm_user_id IS NULL
      AND suitecrm_username IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_app_users_crm_employees
  ON app_users (organization_id, status, email)
  WHERE crm_user_enabled AND reference_code IS NOT NULL;

-- Re-project every managed workbook once so existing Dashboard tabs receive the
-- current logo, formulas, chart set, and fixed chart anchors after deployment.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'pipeline_space',
  pipeline.id::text,
  'provision_pipeline',
  'google_workspace',
  jsonb_build_object(
    'pipelineId', pipeline.id::text,
    'reason', 'managed-dashboard-v2'
  ),
  'queued',
  0,
  'pipeline:' || pipeline.id::text || ':managed-dashboard-v2',
  now(),
  now(),
  now()
FROM pipeline_spaces pipeline
WHERE pipeline.sheet_id IS NOT NULL
  AND pipeline.google_service_account_email IS NOT NULL
  AND pipeline.google_shared_drive_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO UPDATE SET
  payload = EXCLUDED.payload,
  status = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.status ELSE 'queued' END,
  attempts = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.attempts ELSE 0 END,
  last_error = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.last_error ELSE NULL END,
  available_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.available_at ELSE now() END,
  processed_at = CASE WHEN sync_outbox.status = 'processing' THEN sync_outbox.processed_at ELSE NULL END,
  updated_at = now();
