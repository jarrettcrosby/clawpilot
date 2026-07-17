-- App users and their CRM Contact projections are separate durable identities.
-- Preserve every existing gc Contact code while allocating a new gu code for
-- each app user from the permanent global registries.
ALTER TABLE crm_reference_registry
  DROP CONSTRAINT IF EXISTS crm_reference_registry_code_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_prefix_valid,
  DROP CONSTRAINT IF EXISTS crm_reference_registry_canonical_valid;

ALTER TABLE crm_reference_registry
  ADD CONSTRAINT crm_reference_registry_code_valid
    CHECK (reference_code ~ '^g[aciklmopu][0-9]{7}$'),
  ADD CONSTRAINT crm_reference_registry_prefix_valid CHECK (
    prefix IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk', 'gp', 'gu')
    AND prefix = left(reference_code, 2)
  ),
  ADD CONSTRAINT crm_reference_registry_canonical_valid
    CHECK (canonical_code ~ '^g[aciklmopu][0-9]{7}$');

CREATE OR REPLACE FUNCTION allocate_crm_reference(requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate_number text;
  candidate text;
  reserved_number text;
BEGIN
  IF requested_prefix NOT IN ('ga', 'gc', 'gl', 'go', 'gm', 'gi', 'gk', 'gp', 'gu') THEN
    RAISE EXCEPTION 'Unsupported CRM reference prefix: %', requested_prefix;
  END IF;

  FOR attempt IN 1..1000 LOOP
    candidate_number := (1000000 + floor(random() * 9000000)::bigint)::text;
    candidate := requested_prefix || candidate_number;
    reserved_number := NULL;

    INSERT INTO crm_reference_number_registry (number_value, allocated_at)
    VALUES (candidate_number, now())
    ON CONFLICT (number_value) DO NOTHING
    RETURNING number_value INTO reserved_number;

    IF reserved_number IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO crm_reference_registry (
      reference_code, prefix, canonical_code, status, allocated_at
    )
    VALUES (candidate, requested_prefix, candidate, 'active', now());

    RETURN candidate;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate a unique CRM reference for prefix %', requested_prefix;
END;
$$;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS contact_reference_code text;

UPDATE app_users
SET contact_reference_code = reference_code
WHERE contact_reference_code IS NULL;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_reference_code_valid;

CREATE TEMP TABLE app_user_global_identity_backfill (
  email text PRIMARY KEY,
  user_reference_code text NOT NULL UNIQUE
) ON COMMIT DROP;

INSERT INTO app_user_global_identity_backfill (email, user_reference_code)
SELECT email, allocate_crm_reference('gu')
FROM app_users
ORDER BY email;

UPDATE app_users app_user
SET reference_code = identity.user_reference_code,
    updated_at = now()
FROM app_user_global_identity_backfill identity
WHERE identity.email = app_user.email;

ALTER TABLE app_users
  ALTER COLUMN reference_code SET DEFAULT allocate_crm_reference('gu'),
  ALTER COLUMN contact_reference_code SET DEFAULT allocate_crm_reference('gc'),
  ALTER COLUMN contact_reference_code SET NOT NULL,
  ADD CONSTRAINT app_users_reference_code_valid CHECK (reference_code ~ '^gu[0-9]{7}$'),
  ADD CONSTRAINT app_users_contact_reference_code_valid CHECK (contact_reference_code ~ '^gc[0-9]{7}$'),
  ADD CONSTRAINT app_users_contact_reference_code_unique UNIQUE (contact_reference_code),
  ADD CONSTRAINT app_users_reference_registry_fkey
    FOREIGN KEY (reference_code) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  ADD CONSTRAINT app_users_contact_reference_registry_fkey
    FOREIGN KEY (contact_reference_code) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT;

ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS owner_user_reference_code text,
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS owner_display_name text;

ALTER TABLE crm_contacts
  ADD CONSTRAINT crm_contacts_owner_user_reference_code_valid CHECK (
    owner_user_reference_code IS NULL OR owner_user_reference_code ~ '^gu[0-9]{7}$'
  ),
  ADD CONSTRAINT crm_contacts_owner_email_normalized CHECK (
    owner_email IS NULL OR (owner_email = lower(owner_email) AND length(owner_email) <= 254)
  ),
  ADD CONSTRAINT crm_contacts_owner_identity_complete CHECK (
    (owner_user_reference_code IS NULL AND owner_email IS NULL AND owner_display_name IS NULL)
    OR (
      owner_user_reference_code IS NOT NULL
      AND NULLIF(btrim(owner_email), '') IS NOT NULL
      AND NULLIF(btrim(owner_display_name), '') IS NOT NULL
    )
  ),
  ADD CONSTRAINT crm_contacts_owner_reference_registry_fkey
    FOREIGN KEY (owner_user_reference_code)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_crm_contacts_owner_user
  ON crm_contacts (pipeline_id, owner_user_reference_code, updated_at DESC)
  WHERE owner_user_reference_code IS NOT NULL;

-- Upgrade legacy owner strings only when one active user with pipeline access is
-- the unique best match. Unmatched and ambiguous strings remain intact.
WITH candidate_matches AS (
  SELECT
    contact.id AS contact_id,
    app_user.reference_code,
    app_user.email,
    COALESCE(NULLIF(btrim(app_user.display_name), ''), app_user.email) AS display_name,
    CASE
      WHEN lower(btrim(contact.account_manager)) = app_user.email THEN 0
      ELSE 1
    END AS match_quality
  FROM crm_contacts contact
  JOIN pipeline_spaces pipeline ON pipeline.id = contact.pipeline_id
  JOIN app_users app_user
    ON app_user.status = 'active'
   AND (
     lower(btrim(contact.account_manager)) = app_user.email
     OR lower(btrim(contact.account_manager)) = lower(COALESCE(NULLIF(btrim(app_user.display_name), ''), app_user.email))
   )
  LEFT JOIN pipeline_space_members membership
    ON membership.pipeline_id = pipeline.id
   AND membership.user_email = app_user.email
  WHERE contact.owner_user_reference_code IS NULL
    AND NULLIF(btrim(contact.account_manager), '') IS NOT NULL
    AND (pipeline.owner_email = app_user.email OR membership.user_email IS NOT NULL)
), best_matches AS (
  SELECT candidate.*
  FROM candidate_matches candidate
  WHERE candidate.match_quality = (
    SELECT min(comparison.match_quality)
    FROM candidate_matches comparison
    WHERE comparison.contact_id = candidate.contact_id
  )
), unique_matches AS (
  SELECT
    contact_id,
    min(reference_code) AS reference_code,
    min(email) AS email,
    min(display_name) AS display_name
  FROM best_matches
  GROUP BY contact_id
  HAVING count(*) = 1
)
UPDATE crm_contacts contact
SET owner_user_reference_code = matched.reference_code,
    owner_email = matched.email,
    owner_display_name = matched.display_name,
    updated_at = now()
FROM unique_matches matched
WHERE matched.contact_id = contact.id;

-- Existing contacts whose newly resolved owner already has a SuiteCRM mapping
-- receive a one-time assignment refresh. The contact gc remains the payload's
-- Global ID; gu identifies only the assigned ClawPilot user.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'crm_contacts',
  contact.id::text,
  'upsert_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'contacts',
    'pipelineId', contact.pipeline_id::text,
    'localId', contact.id::text,
    'suiteCrmId', contact.suitecrm_id,
    'attributes', jsonb_build_object(
      'global_id_c', contact.reference_code,
      'first_name', COALESCE(contact.first_name, ''),
      'last_name', COALESCE(NULLIF(contact.last_name, ''), contact.full_name, ''),
      'title', COALESCE(contact.job_title, ''),
      'email1', COALESCE(contact.email, ''),
      'phone_work', COALESCE(contact.phone_work, ''),
      'phone_mobile', COALESCE(contact.phone_mobile, ''),
      'primary_address_street', COALESCE(contact.primary_address_street, ''),
      'primary_address_city', COALESCE(contact.primary_address_city, ''),
      'primary_address_state', COALESCE(contact.primary_address_state, ''),
      'primary_address_postalcode', COALESCE(contact.primary_address_postal_code, ''),
      'primary_address_country', COALESCE(contact.primary_address_country, ''),
      'account_id', COALESCE(organization.suitecrm_id, ''),
      'assigned_user_id', app_user.suitecrm_user_id,
      'description', COALESCE(contact.description, '')
    )
  ),
  'queued',
  0,
  'crm:contacts:owner-backfill:v1:' || contact.id::text || ':' || contact.owner_user_reference_code,
  now(),
  now(),
  now()
FROM crm_contacts contact
JOIN app_users app_user ON app_user.reference_code = contact.owner_user_reference_code
JOIN crm_organizations organization
  ON organization.pipeline_id = contact.pipeline_id
 AND organization.id = contact.organization_id
WHERE app_user.suitecrm_user_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

UPDATE crm_contacts contact
SET sync_status = 'pending',
    sync_error = NULL,
    updated_at = now()
FROM app_users app_user
WHERE app_user.reference_code = contact.owner_user_reference_code
  AND app_user.suitecrm_user_id IS NOT NULL;

-- Native SuiteCRM User records receive the same permanent gu identifier through
-- the retryable SuiteCRM outbox once the Users-module field is available.
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, attempts, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'app_users',
  app_user.email,
  'upsert_user_identity',
  'suitecrm',
  jsonb_build_object(
    'localId', app_user.email,
    'suiteCrmUserId', app_user.suitecrm_user_id,
    'referenceCode', app_user.reference_code
  ),
  'queued',
  0,
  'crm:suitecrm-user-global-id:v1:' || app_user.email || ':' || app_user.suitecrm_user_id || ':' || app_user.reference_code,
  now(),
  now(),
  now()
FROM app_users app_user
WHERE app_user.suitecrm_user_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;
