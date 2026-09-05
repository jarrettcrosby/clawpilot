-- Narrow, time-bounded provider-read authority for explicitly reviewed
-- Shopify sandbox demo accounts that remain sandbox while hosted by the
-- production ClawPilot runtime. This authority never grants provider writes,
-- receipt-driven order promotion, or a global sandbox escape hatch.

SET LOCAL search_path = public, pg_catalog, pg_temp;

CREATE TABLE IF NOT EXISTS
  operations_commerce_hosted_production_sandbox_read_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL
      REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
    integration_account_id uuid NOT NULL,
    authorization_version integer NOT NULL CHECK (authorization_version > 0),
    state text NOT NULL DEFAULT 'active'
      CHECK (state IN ('active', 'revoked')),
    capabilities text[] NOT NULL DEFAULT ARRAY[
      'catalog',
      'images',
      'inventory',
      'orders_history',
      'webhook_hydration'
    ]::text[],
    provider_writes_enabled boolean NOT NULL DEFAULT false,
    automatic_order_promotion_enabled boolean NOT NULL DEFAULT false,
    authorized_credential_generation integer NOT NULL CHECK (
      authorized_credential_generation > 0
    ),
    verified_external_account_id_sha256 text NOT NULL CHECK (
      verified_external_account_id_sha256 ~ '^[a-f0-9]{64}$'
    ),
    migration_receipt_event_key text NOT NULL CHECK (
      length(btrim(migration_receipt_event_key)) BETWEEN 16 AND 512
      AND migration_receipt_event_key !~ '[[:cntrl:]]'
    ),
    authorized_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
    authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    reason text NOT NULL CHECK (
      length(btrim(reason)) BETWEEN 8 AND 500
      AND reason !~ '[[:cntrl:]]'
    ),
    revoked_by text REFERENCES app_users(email) ON DELETE RESTRICT,
    revoked_at timestamptz,
    revocation_reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_account_fkey
      FOREIGN KEY (organization_id, integration_account_id)
      REFERENCES operations_integration_accounts(organization_id, id)
      ON DELETE RESTRICT,
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_version_unique
      UNIQUE (organization_id, integration_account_id, authorization_version),
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_capabilities_exact
      CHECK (
        capabilities = ARRAY[
          'catalog',
          'images',
          'inventory',
          'orders_history',
          'webhook_hydration'
        ]::text[]
      ),
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_only
      CHECK (
        provider_writes_enabled = false
        AND automatic_order_promotion_enabled = false
      ),
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_expiry_valid
      CHECK (
        expires_at > authorized_at + interval '1 hour'
        AND expires_at <= authorized_at + interval '180 days'
      ),
    CONSTRAINT operations_commerce_hosted_prod_sandbox_read_state_valid
      CHECK (
        (
          state = 'active'
          AND revoked_by IS NULL
          AND revoked_at IS NULL
          AND revocation_reason IS NULL
        ) OR (
          state = 'revoked'
          AND revoked_by IS NOT NULL
          AND revoked_at IS NOT NULL
          AND length(btrim(revocation_reason)) BETWEEN 8 AND 500
          AND revocation_reason !~ '[[:cntrl:]]'
        )
      )
  );

CREATE INDEX IF NOT EXISTS
  operations_commerce_hosted_prod_sandbox_read_active_idx
  ON operations_commerce_hosted_production_sandbox_read_authorizations (
    organization_id, integration_account_id
  )
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS
  operations_commerce_hosted_prod_sandbox_read_expiry_idx
  ON operations_commerce_hosted_production_sandbox_read_authorizations (
    expires_at, organization_id, integration_account_id
  )
  WHERE state = 'active';

CREATE OR REPLACE FUNCTION
  guard_hosted_production_sandbox_read_authorization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  account_record record;
  previous_version integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'hosted production sandbox read authorizations are append-only; revoke instead'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
      OR OLD.integration_account_id IS DISTINCT FROM NEW.integration_account_id
      OR OLD.authorization_version IS DISTINCT FROM NEW.authorization_version
      OR OLD.capabilities IS DISTINCT FROM NEW.capabilities
      OR OLD.provider_writes_enabled IS DISTINCT FROM NEW.provider_writes_enabled
      OR OLD.automatic_order_promotion_enabled IS DISTINCT FROM
        NEW.automatic_order_promotion_enabled
      OR OLD.authorized_credential_generation IS DISTINCT FROM
        NEW.authorized_credential_generation
      OR OLD.verified_external_account_id_sha256 IS DISTINCT FROM
        NEW.verified_external_account_id_sha256
      OR OLD.migration_receipt_event_key IS DISTINCT FROM
        NEW.migration_receipt_event_key
      OR OLD.authorized_by IS DISTINCT FROM NEW.authorized_by
      OR OLD.authorized_at IS DISTINCT FROM NEW.authorized_at
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.reason IS DISTINCT FROM NEW.reason
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
    THEN
      RAISE EXCEPTION
        'hosted production sandbox read authorization identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.state <> 'active' OR NEW.state <> 'revoked' THEN
      RAISE EXCEPTION
        'hosted production sandbox read authority only permits active to revoked transition'
        USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  -- Serialize grants and bind them to the exact, already-verified migration
  -- identity. This intentionally admits only the two compiled demo stores.
  IF NEW.authorized_at > clock_timestamp() THEN
    RAISE EXCEPTION
      'hosted production sandbox read authorization cannot begin in the future'
      USING ERRCODE = '23514';
  END IF;

  SELECT account.provider, account.integration_type, account.environment,
         account.status, credential.verification_status,
         credential.credential_version,
         account.commerce_credential_generation,
         fence.source_account_global_id,
         fence.verification_state,
         fence.expected_external_account_id_sha256,
         fence.verified_external_account_id_sha256,
         fence.migration_event_key
  INTO account_record
  FROM operations_integration_accounts account
  JOIN operations_commerce_credentials credential
    ON credential.organization_id = account.organization_id
   AND credential.integration_account_id = account.id
  JOIN operations_commerce_migration_provider_identity_fences fence
    ON fence.organization_id = account.organization_id
   AND fence.integration_account_id = account.id
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id
  FOR UPDATE OF account, credential, fence;

  IF NOT FOUND
    OR account_record.provider <> 'shopify'
    OR account_record.integration_type <> 'commerce'
    OR account_record.environment <> 'sandbox'
    OR account_record.status <> 'active'
    OR account_record.verification_status <> 'verified'
    OR account_record.credential_version < 1
    OR account_record.credential_version
      <> account_record.commerce_credential_generation
    OR NEW.authorized_credential_generation
      <> account_record.commerce_credential_generation
    OR NOT (
      (
        account_record.source_account_global_id = 'gia9286799'
        AND NEW.organization_id =
          '33785418-9927-4e10-a492-d3a44b9b6f21'::uuid
      )
      OR (
        account_record.source_account_global_id = 'giah34fedoa5b1o'
        AND NEW.organization_id =
          'c8fcf491-cf8c-469a-b03c-0026a762752c'::uuid
      )
    )
    OR account_record.verification_state <> 'verified'
    OR account_record.expected_external_account_id_sha256
      IS DISTINCT FROM account_record.verified_external_account_id_sha256
    OR NEW.verified_external_account_id_sha256
      IS DISTINCT FROM account_record.verified_external_account_id_sha256
    OR account_record.migration_event_key
      IS DISTINCT FROM NEW.migration_receipt_event_key
    OR NOT EXISTS (
      SELECT 1
      FROM audit_events receipt
      WHERE receipt.organization_id = NEW.organization_id
        AND receipt.event_type =
          'operations.commerce_workspace_migration.completed'
        AND receipt.event_key = NEW.migration_receipt_event_key
        AND receipt.payload->>'scriptVersion' =
          'sales-shipping-workspace-production-migration-v3'
        AND receipt.payload->'target'->>'organizationId' =
          NEW.organization_id::text
        AND EXISTS (
          SELECT 1
          FROM jsonb_each(
            receipt.payload->'mapping'->'operations_integration_accounts'
          ) migrated_account(source_id, target_identity)
          WHERE migrated_account.target_identity->>'id' =
            NEW.integration_account_id::text
        )
    )
  THEN
    RAISE EXCEPTION
      'hosted production sandbox read authority requires one exact verified compiled migration identity and receipt'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_commerce_hosted_production_sandbox_read_authorizations current
    WHERE current.organization_id = NEW.organization_id
      AND current.integration_account_id = NEW.integration_account_id
      AND current.state = 'active'
      AND current.expires_at > statement_timestamp()
  ) THEN
    RAISE EXCEPTION
      'a current hosted production sandbox read authority already exists'
      USING ERRCODE = '23505';
  END IF;

  SELECT COALESCE(max(existing.authorization_version), 0)
  INTO previous_version
  FROM operations_commerce_hosted_production_sandbox_read_authorizations existing
  WHERE existing.organization_id = NEW.organization_id
    AND existing.integration_account_id = NEW.integration_account_id;
  IF NEW.authorization_version <> previous_version + 1 THEN
    RAISE EXCEPTION
      'hosted production sandbox read authorization version must advance exactly once'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  guard_hosted_production_sandbox_read_authorization_trigger
  ON operations_commerce_hosted_production_sandbox_read_authorizations;
CREATE TRIGGER
  guard_hosted_production_sandbox_read_authorization_trigger
BEFORE INSERT OR UPDATE OR DELETE
ON operations_commerce_hosted_production_sandbox_read_authorizations
FOR EACH ROW
EXECUTE FUNCTION guard_hosted_production_sandbox_read_authorization();

CREATE OR REPLACE FUNCTION
  operations_commerce_hosted_production_sandbox_read_is_current(
    requested_organization_id uuid,
    requested_integration_account_id uuid,
    requested_capability text
  )
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_commerce_hosted_production_sandbox_read_authorizations authority
    JOIN operations_integration_accounts account
      ON account.organization_id = authority.organization_id
     AND account.id = authority.integration_account_id
    JOIN operations_commerce_credentials credential
      ON credential.organization_id = account.organization_id
     AND credential.integration_account_id = account.id
    WHERE authority.organization_id = requested_organization_id
      AND authority.integration_account_id = requested_integration_account_id
      AND authority.state = 'active'
      AND authority.revoked_at IS NULL
      AND authority.authorized_at <= statement_timestamp()
      AND authority.expires_at > statement_timestamp()
      AND requested_capability = ANY(authority.capabilities)
      AND authority.provider_writes_enabled = false
      AND authority.automatic_order_promotion_enabled = false
      AND authority.authorized_credential_generation =
        account.commerce_credential_generation
      AND authority.verified_external_account_id_sha256 =
        encode(digest(account.external_account_id, 'sha256'), 'hex')
      AND account.provider = 'shopify'
      AND account.integration_type = 'commerce'
      AND account.environment = 'sandbox'
      AND account.status = 'active'
      AND credential.external_account_id = account.external_account_id
      AND credential.verification_status = 'verified'
      AND credential.credential_version = account.commerce_credential_generation
      AND authority.verified_external_account_id_sha256 = (
        SELECT fence.verified_external_account_id_sha256
        FROM operations_commerce_migration_provider_identity_fences fence
        WHERE fence.organization_id = account.organization_id
          AND fence.integration_account_id = account.id
          AND fence.verification_state = 'verified'
          AND fence.expected_external_account_id_sha256 =
            fence.verified_external_account_id_sha256
      )
  )
$$;

COMMENT ON TABLE
  operations_commerce_hosted_production_sandbox_read_authorizations IS
  'Append-only, revocable, expiring authority for exact reviewed Shopify sandbox demo accounts to perform provider reads in hosted production. Never grants provider writes or automatic order promotion.';

COMMENT ON FUNCTION
  operations_commerce_hosted_production_sandbox_read_is_current(uuid, uuid, text) IS
  'Fail-closed exact account/capability predicate for hosted-production Shopify sandbox provider reads.';
