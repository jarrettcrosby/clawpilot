-- Durable safety boundaries for the one-time selective commerce workspace
-- migration.  These rows contain hashes and identifiers only; credentials and
-- provider payloads are deliberately forbidden.

CREATE TABLE IF NOT EXISTS operations_commerce_workspace_migration_cutover_fences (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  migration_name text NOT NULL CHECK (
    length(btrim(migration_name)) BETWEEN 3 AND 160
    AND migration_name !~ '[[:cntrl:]]'
  ),
  state text NOT NULL DEFAULT 'frozen'
    CHECK (state IN ('frozen', 'released')),
  frozen_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  frozen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  released_at timestamptz,
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 3 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_workspace_cutover_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_workspace_cutover_release_valid CHECK (
    (state = 'frozen' AND released_by IS NULL AND released_at IS NULL)
    OR (state = 'released' AND released_by IS NOT NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_workspace_cutover_frozen_idx
  ON operations_commerce_workspace_migration_cutover_fences (
    organization_id, integration_account_id
  ) WHERE state = 'frozen';

CREATE TABLE IF NOT EXISTS operations_commerce_migration_provider_identity_fences (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('shopify', 'faire')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  source_database_identity uuid NOT NULL,
  source_database_endpoint_sha256 text NOT NULL CHECK (
    source_database_endpoint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  target_database_endpoint_sha256 text NOT NULL CHECK (
    target_database_endpoint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  source_account_global_id text NOT NULL CHECK (
    source_account_global_id ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  expected_external_account_id_sha256 text NOT NULL CHECK (
    expected_external_account_id_sha256 ~ '^[a-f0-9]{64}$'
  ),
  reconnect_eligible boolean NOT NULL,
  verification_state text NOT NULL DEFAULT 'awaiting_provider_identity'
    CHECK (verification_state IN ('awaiting_provider_identity', 'verified')),
  verified_external_account_id_sha256 text CHECK (
    verified_external_account_id_sha256 IS NULL
    OR verified_external_account_id_sha256 ~ '^[a-f0-9]{64}$'
  ),
  verified_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  verified_at timestamptz,
  migration_event_key text NOT NULL CHECK (
    length(btrim(migration_event_key)) BETWEEN 3 AND 500
    AND migration_event_key !~ '[[:cntrl:]]'
  ),
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_migration_provider_fence_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_migration_provider_fence_verification_valid CHECK (
    (
      verification_state = 'awaiting_provider_identity'
      AND verified_external_account_id_sha256 IS NULL
      AND verified_by IS NULL
      AND verified_at IS NULL
    ) OR (
      verification_state = 'verified'
      AND reconnect_eligible = true
      AND verified_external_account_id_sha256 = expected_external_account_id_sha256
      AND verified_by IS NOT NULL
      AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT operations_commerce_migration_provider_fence_event_unique
    UNIQUE (migration_event_key, integration_account_id)
);

CREATE OR REPLACE FUNCTION protect_commerce_migration_provider_identity_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Migrated provider identity fences are immutable';
  END IF;

  IF NEW.organization_id <> OLD.organization_id
     OR NEW.integration_account_id <> OLD.integration_account_id
     OR NEW.provider <> OLD.provider
     OR NEW.environment <> OLD.environment
     OR NEW.source_database_identity <> OLD.source_database_identity
     OR NEW.source_database_endpoint_sha256
          <> OLD.source_database_endpoint_sha256
     OR NEW.target_database_endpoint_sha256
          <> OLD.target_database_endpoint_sha256
     OR NEW.source_account_global_id <> OLD.source_account_global_id
     OR NEW.expected_external_account_id_sha256
          <> OLD.expected_external_account_id_sha256
     OR NEW.reconnect_eligible <> OLD.reconnect_eligible
     OR NEW.migration_event_key <> OLD.migration_event_key
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Migrated provider identity fence identity is immutable';
  END IF;

  IF OLD.verification_state = 'verified'
     AND ROW(
       NEW.verification_state,
       NEW.verified_external_account_id_sha256,
       NEW.verified_by,
       NEW.verified_at
     ) IS DISTINCT FROM ROW(
       OLD.verification_state,
       OLD.verified_external_account_id_sha256,
       OLD.verified_by,
       OLD.verified_at
     ) THEN
    RAISE EXCEPTION 'Migrated provider identity verification is immutable';
  END IF;

  IF NEW.verification_state = 'verified'
     AND (
       NEW.reconnect_eligible IS DISTINCT FROM true
       OR NEW.verified_external_account_id_sha256
            IS DISTINCT FROM NEW.expected_external_account_id_sha256
     ) THEN
    RAISE EXCEPTION 'Migrated provider identity did not match the approved source account';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_commerce_migration_provider_identity_fence_write
  ON operations_commerce_migration_provider_identity_fences;
CREATE TRIGGER protect_commerce_migration_provider_identity_fence_write
BEFORE UPDATE OR DELETE
ON operations_commerce_migration_provider_identity_fences
FOR EACH ROW EXECUTE FUNCTION protect_commerce_migration_provider_identity_fence();

CREATE OR REPLACE FUNCTION enforce_migrated_commerce_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fence operations_commerce_migration_provider_identity_fences%ROWTYPE;
  observed_hash text;
BEGIN
  SELECT * INTO fence
  FROM operations_commerce_migration_provider_identity_fences
  WHERE organization_id = NEW.organization_id
    AND integration_account_id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.provider <> fence.provider OR NEW.environment <> fence.environment THEN
    RAISE EXCEPTION 'Migrated commerce provider and environment are immutable';
  END IF;

  IF NEW.external_account_id IS NULL THEN
    IF NEW.status = 'active' THEN
      RAISE EXCEPTION 'Migrated commerce account cannot activate without provider identity verification';
    END IF;
    RETURN NEW;
  END IF;

  observed_hash := encode(digest(NEW.external_account_id, 'sha256'), 'hex');
  IF fence.verification_state <> 'verified'
     OR observed_hash <> fence.expected_external_account_id_sha256
     OR fence.verified_external_account_id_sha256
          <> fence.expected_external_account_id_sha256 THEN
    RAISE EXCEPTION 'Migrated commerce account provider identity is not verified';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_migrated_commerce_provider_identity_write
  ON operations_integration_accounts;
CREATE TRIGGER enforce_migrated_commerce_provider_identity_write
BEFORE UPDATE OF provider, environment, external_account_id, status
ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_migrated_commerce_provider_identity();

CREATE OR REPLACE FUNCTION protect_commerce_workspace_migration_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.event_type = 'operations.commerce_workspace_migration.completed'
     AND OLD.event_key LIKE 'commerce-workspace-migration:commerce-workspace-production-migration-v2:%' THEN
    RAISE EXCEPTION 'Commerce workspace migration receipts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_commerce_workspace_migration_receipt_write
  ON audit_events;
CREATE TRIGGER protect_commerce_workspace_migration_receipt_write
BEFORE UPDATE OR DELETE
ON audit_events
FOR EACH ROW EXECUTE FUNCTION protect_commerce_workspace_migration_receipt();

COMMENT ON TABLE operations_commerce_workspace_migration_cutover_fences IS
  'Explicit source-side cutover fence. Migration also takes NOWAIT SHARE locks before snapshotting selected and queue tables.';
COMMENT ON TABLE operations_commerce_migration_provider_identity_fences IS
  'Credential-free target fence binding a migrated placeholder to the approved provider account hash before reconnect.';
