CREATE TABLE IF NOT EXISTS operations_activation_scopes (
  organization_id uuid PRIMARY KEY REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  data_pipeline_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'shadow'
    CHECK (state IN ('disabled', 'shadow', 'read_only', 'active', 'frozen')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  reason text,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_activation_scopes_pipeline_fkey
    FOREIGN KEY (organization_id, data_pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id) ON DELETE RESTRICT
);

-- Existing CRM records are intentionally projected into a pipeline per user.
-- Operations needs one authoritative projection so the same Global ID cannot
-- appear once for every user-owned pipeline in the active organization.
WITH ranked_pipelines AS (
  SELECT
    pipeline.workspace_organization_id AS organization_id,
    pipeline.id AS data_pipeline_id,
    pipeline.owner_email,
    row_number() OVER (
      PARTITION BY pipeline.workspace_organization_id
      ORDER BY
        CASE
          WHEN membership.status = 'active' AND membership.role = 'owner' THEN 0
          WHEN membership.status = 'active' AND membership.role = 'admin' THEN 1
          WHEN membership.status = 'active' AND membership.role = 'member' THEN 2
          ELSE 3
        END,
        pipeline.is_default DESC,
        pipeline.updated_at DESC,
        pipeline.id
    ) AS pipeline_rank
  FROM pipeline_spaces pipeline
  LEFT JOIN app_user_organization_memberships membership
    ON membership.user_email = pipeline.owner_email
   AND membership.organization_id = pipeline.workspace_organization_id
  WHERE pipeline.workspace_organization_id IS NOT NULL
)
INSERT INTO operations_activation_scopes (
  organization_id, data_pipeline_id, state, reason, updated_by
)
SELECT
  organization_id,
  data_pipeline_id,
  'shadow',
  'Initial authoritative CRM projection selected during Operations hardening',
  owner_email
FROM ranked_pipelines
WHERE pipeline_rank = 1
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS operations_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  command_type text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  -- Interactive commands use the signed-in email. Background commerce imports
  -- use a stable service actor such as system:shopify, so this is intentionally
  -- not constrained to app_users.
  actor_email text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'succeeded', 'failed')),
  correlation_id uuid NOT NULL,
  result_global_id text,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_command_receipts_type_present
    CHECK (length(btrim(command_type)) > 0),
  CONSTRAINT operations_command_receipts_key_present
    CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT operations_command_receipts_hash_valid
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operations_command_receipts_result_fkey
    FOREIGN KEY (result_global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_command_receipts_idempotency_unique
    UNIQUE (organization_id, command_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_command_receipts_health
  ON operations_command_receipts(organization_id, status, updated_at DESC);

ALTER TABLE operations_external_identifiers
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'stale', 'retired')),
  ADD COLUMN IF NOT EXISTS match_method text,
  ADD COLUMN IF NOT EXISTS match_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz NOT NULL DEFAULT now();

-- Several provider customer IDs can legitimately identify one canonical CRM
-- organization. External IDs remain unique, while the canonical target is a
-- many-to-one mapping.
ALTER TABLE operations_external_identifiers
  DROP CONSTRAINT IF EXISTS operations_external_identifiers_global_unique;

CREATE INDEX IF NOT EXISTS idx_operations_external_identifiers_entity
  ON operations_external_identifiers(organization_id, entity_type, entity_global_id, status);
