CREATE TABLE IF NOT EXISTS workspace_organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  organization_type text NOT NULL DEFAULT 'member' CHECK (organization_type IN ('root', 'member')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_organizations_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT workspace_organizations_parent_valid CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_organizations_parent
  ON workspace_organizations (parent_id, lower(name), updated_at DESC);

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES workspace_organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS organization_name text;

CREATE INDEX IF NOT EXISTS idx_app_users_organization
  ON app_users (organization_id, status, created_at)
  WHERE organization_id IS NOT NULL;

ALTER TABLE pipeline_spaces
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid REFERENCES workspace_organizations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_spaces_workspace_organization
  ON pipeline_spaces (workspace_organization_id, updated_at DESC)
  WHERE workspace_organization_id IS NOT NULL;

ALTER TABLE crm_organizations
  ADD COLUMN IF NOT EXISTS identity_key text,
  ADD COLUMN IF NOT EXISTS parent_organization_id uuid REFERENCES crm_organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workspace_organization_id uuid REFERENCES workspace_organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS relationship_type text NOT NULL DEFAULT 'customer';

ALTER TABLE crm_contacts
  ADD COLUMN IF NOT EXISTS identity_key text;

UPDATE crm_organizations
SET identity_key = 'customer:name:' || lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g'))
WHERE identity_key IS NULL;

-- Queue native SuiteCRM deletion before consolidating duplicate local accounts.
WITH ranked AS (
  SELECT
    id,
    pipeline_id,
    suitecrm_id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_organizations
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT * FROM ranked WHERE duplicate_rank > 1
)
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'crm_organizations',
  duplicate.id::text,
  'delete_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'organizations',
    'pipelineId', duplicate.pipeline_id::text,
    'localId', duplicate.id::text,
    'suiteCrmId', duplicate.suitecrm_id,
    'attributes', '{}'::jsonb
  ),
  'queued',
  'crm-delete:organizations:' || duplicate.id::text,
  now(),
  now(),
  now()
FROM duplicates duplicate
WHERE duplicate.suitecrm_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_organizations
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT id, survivor_id FROM ranked WHERE duplicate_rank > 1
)
UPDATE crm_contacts contact
SET organization_id = duplicate.survivor_id,
    updated_at = now()
FROM duplicates duplicate
WHERE contact.organization_id = duplicate.id;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_organizations
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT id, survivor_id FROM ranked WHERE duplicate_rank > 1
)
UPDATE crm_opportunities opportunity
SET organization_id = duplicate.survivor_id,
    updated_at = now()
FROM duplicates duplicate
WHERE opportunity.organization_id = duplicate.id;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_organizations
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT id, survivor_id FROM ranked WHERE duplicate_rank > 1
)
UPDATE crm_interactions interaction
SET organization_id = duplicate.survivor_id,
    updated_at = now()
FROM duplicates duplicate
WHERE interaction.organization_id = duplicate.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY pipeline_id, identity_key
      ORDER BY source_row_number NULLS LAST, created_at, id
    ) AS duplicate_rank
  FROM crm_organizations
)
DELETE FROM crm_organizations organization
USING ranked duplicate
WHERE organization.id = duplicate.id
  AND duplicate.duplicate_rank > 1;

UPDATE crm_contacts
SET identity_key = CASE
  WHEN nullif(lower(btrim(email)), '') IS NOT NULL
    THEN 'contact:email:' || lower(btrim(email))
  ELSE 'contact:name:' || lower(regexp_replace(btrim(full_name), '[[:space:]]+', ' ', 'g'))
    || ':organization:' || COALESCE(organization_id::text, 'none')
END
WHERE identity_key IS NULL;

-- Queue native SuiteCRM deletion before consolidating duplicate local contacts.
WITH ranked AS (
  SELECT
    id,
    pipeline_id,
    suitecrm_id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_contacts
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT * FROM ranked WHERE duplicate_rank > 1
)
INSERT INTO sync_outbox (
  aggregate_type, aggregate_id, operation, target_system, payload,
  status, idempotency_key, created_at, available_at, updated_at
)
SELECT
  'crm_contacts',
  duplicate.id::text,
  'delete_record',
  'suitecrm',
  jsonb_build_object(
    'entity', 'contacts',
    'pipelineId', duplicate.pipeline_id::text,
    'localId', duplicate.id::text,
    'suiteCrmId', duplicate.suitecrm_id,
    'attributes', '{}'::jsonb
  ),
  'queued',
  'crm-delete:contacts:' || duplicate.id::text,
  now(),
  now(),
  now()
FROM duplicates duplicate
WHERE duplicate.suitecrm_id IS NOT NULL
ON CONFLICT (target_system, idempotency_key)
WHERE idempotency_key IS NOT NULL
DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER duplicate_window AS survivor_id,
    row_number() OVER duplicate_window AS duplicate_rank
  FROM crm_contacts
  WINDOW duplicate_window AS (
    PARTITION BY pipeline_id, identity_key
    ORDER BY source_row_number NULLS LAST, created_at, id
  )
), duplicates AS (
  SELECT id, survivor_id FROM ranked WHERE duplicate_rank > 1
)
UPDATE crm_interactions interaction
SET contact_id = duplicate.survivor_id,
    updated_at = now()
FROM duplicates duplicate
WHERE interaction.contact_id = duplicate.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY pipeline_id, identity_key
      ORDER BY source_row_number NULLS LAST, created_at, id
    ) AS duplicate_rank
  FROM crm_contacts
)
DELETE FROM crm_contacts contact
USING ranked duplicate
WHERE contact.id = duplicate.id
  AND duplicate.duplicate_rank > 1;

-- Natural identities replace workbook row numbers as the durable import keys.
UPDATE crm_organizations
SET source_key = identity_key,
    updated_at = now()
WHERE source_key IS DISTINCT FROM identity_key;

UPDATE crm_contacts
SET source_key = identity_key,
    updated_at = now()
WHERE source_key IS DISTINCT FROM identity_key;

ALTER TABLE crm_organizations
  ALTER COLUMN identity_key SET NOT NULL,
  ADD CONSTRAINT crm_organizations_identity_key_present CHECK (length(btrim(identity_key)) > 0),
  ADD CONSTRAINT crm_organizations_relationship_type_valid CHECK (
    relationship_type IN ('workspace_root', 'workspace_member', 'customer')
  ),
  ADD CONSTRAINT crm_organizations_parent_valid CHECK (
    parent_organization_id IS NULL OR parent_organization_id <> id
  );

ALTER TABLE crm_contacts
  ALTER COLUMN identity_key SET NOT NULL,
  ADD CONSTRAINT crm_contacts_identity_key_present CHECK (length(btrim(identity_key)) > 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_organizations_identity
  ON crm_organizations (pipeline_id, identity_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_organizations_workspace
  ON crm_organizations (pipeline_id, workspace_organization_id)
  WHERE workspace_organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_organizations_parent
  ON crm_organizations (pipeline_id, parent_organization_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_identity
  ON crm_contacts (pipeline_id, identity_key);
