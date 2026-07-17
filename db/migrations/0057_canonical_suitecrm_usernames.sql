-- A CRM employee has one immutable cross-system identity. The permanent gu
-- Global ID is also the native SuiteCRM username; display names and email stay
-- human-readable discovery/profile fields rather than alternate identities.
ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_suitecrm_user_id_format,
  ADD CONSTRAINT app_users_suitecrm_user_id_format CHECK (
    suitecrm_user_id IS NULL
    OR suitecrm_user_id ~* '^[a-z0-9][a-z0-9-]{0,63}$'
  );

UPDATE app_users
SET suitecrm_username = reference_code,
    updated_at = now()
WHERE suitecrm_user_id IS NOT NULL
  AND crm_user_enabled
  AND suitecrm_username IS DISTINCT FROM reference_code;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_suitecrm_identity_canonical,
  ADD CONSTRAINT app_users_suitecrm_identity_canonical CHECK (
    (suitecrm_user_id IS NULL AND suitecrm_username IS NULL)
    OR (
      suitecrm_user_id IS NOT NULL
      AND crm_user_enabled
      AND reference_code IS NOT NULL
      AND suitecrm_username = reference_code
    )
  );

INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'app_users', app_user.email, 'upsert_user_identity', 'suitecrm',
  jsonb_build_object(
    'localId', app_user.email,
    'suiteCrmUserId', app_user.suitecrm_user_id,
    'referenceCode', app_user.reference_code,
    'username', app_user.reference_code
  ),
  'queued', 0,
  'crm:suitecrm-user-identity:v2:' || app_user.email || ':' || app_user.suitecrm_user_id || ':' || app_user.reference_code,
  now(), now(), now()
FROM app_users app_user
WHERE app_user.crm_user_enabled
  AND app_user.reference_code IS NOT NULL
  AND app_user.suitecrm_user_id IS NOT NULL
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
