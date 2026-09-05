-- Durable safety boundaries for the one-time selective sales-and-shipping
-- workspace migration. These rows contain hashes and identifiers only;
-- credentials, account-number ciphertext, webhook secrets, cursors, and
-- provider payload/state are deliberately forbidden.

SET LOCAL search_path = public, pg_catalog, pg_temp;

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

-- A carrier account cannot be copied safely because its required row contains
-- encrypted account-number material and a full registered address. Preserve a
-- preallocated ID/Global ID plus masked identity evidence only. The normal
-- target credential/account flow must create the real carrier row and advance
-- this marker atomically. Source-managed AG delegations additionally bind to
-- the independently verified, existing production source authority.
CREATE TABLE IF NOT EXISTS operations_carrier_account_migration_placeholders (
  id uuid PRIMARY KEY,
  global_id text NOT NULL,
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  display_name text NOT NULL CHECK (
    length(btrim(display_name)) BETWEEN 1 AND 160
    AND display_name !~ '[[:cntrl:]]'
  ),
  sender_name text NOT NULL CHECK (
    length(btrim(sender_name)) BETWEEN 1 AND 120
    AND sender_name !~ '[[:cntrl:]]'
  ),
  source_carrier_account_id uuid NOT NULL,
  source_carrier_account_global_id text NOT NULL CHECK (
    source_carrier_account_global_id ~ '^gac(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  source_account_number_last_four text NOT NULL CHECK (
    source_account_number_last_four ~ '^[[:print:]]{4}$'
  ),
  source_account_number_fingerprint text NOT NULL CHECK (
    source_account_number_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  source_registered_address_fingerprint text NOT NULL CHECK (
    source_registered_address_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  rebind_mode text NOT NULL CHECK (
    rebind_mode IN ('direct_credential', 'source_authority')
  ),
  required_source_authority_organization_id uuid,
  required_source_authority_integration_account_id uuid,
  required_source_authority_carrier_account_id uuid,
  required_source_organization_reference text,
  required_source_integration_global_id text,
  required_source_carrier_account_global_id text,
  state text NOT NULL DEFAULT 'awaiting_credential_rebind'
    CHECK (state IN ('awaiting_credential_rebind', 'materialized')),
  target_account_number_fingerprint text CHECK (
    target_account_number_fingerprint IS NULL
    OR target_account_number_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  materialized_by text REFERENCES app_users(email) ON DELETE RESTRICT,
  materialized_at timestamptz,
  created_by text NOT NULL REFERENCES app_users(email) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operations_carrier_migration_placeholder_global_valid CHECK (
    global_id ~ '^gac(?:[0-9]{7}|[0-9a-v]{12})$'
  ),
  CONSTRAINT operations_carrier_migration_placeholder_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_carrier_migration_placeholder_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_migration_placeholder_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_migration_placeholder_source_unique
    UNIQUE (source_carrier_account_id),
  CONSTRAINT operations_carrier_migration_placeholder_connection_unique
    UNIQUE (organization_id, integration_account_id),
  CONSTRAINT operations_carrier_migration_placeholder_authority_org_fkey
    FOREIGN KEY (required_source_authority_organization_id)
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_migration_placeholder_authority_integration_fkey
    FOREIGN KEY (
      required_source_authority_organization_id,
      required_source_authority_integration_account_id
    ) REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_migration_placeholder_authority_account_fkey
    FOREIGN KEY (
      required_source_authority_organization_id,
      required_source_authority_integration_account_id,
      required_source_authority_carrier_account_id
    ) REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    )
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_migration_placeholder_rebind_valid CHECK (
    (
      rebind_mode = 'direct_credential'
      AND required_source_authority_organization_id IS NULL
      AND required_source_authority_integration_account_id IS NULL
      AND required_source_authority_carrier_account_id IS NULL
      AND required_source_organization_reference IS NULL
      AND required_source_integration_global_id IS NULL
      AND required_source_carrier_account_global_id IS NULL
    ) OR (
      rebind_mode = 'source_authority'
      AND required_source_authority_organization_id IS NOT NULL
      AND required_source_authority_integration_account_id IS NOT NULL
      AND required_source_authority_carrier_account_id IS NOT NULL
      AND required_source_organization_reference
        ~ '^ga(?:[0-9]{7}|[0-9a-v]{12})$'
      AND required_source_integration_global_id
        ~ '^gia(?:[0-9]{7}|[0-9a-v]{12})$'
      AND required_source_carrier_account_global_id
        ~ '^gac(?:[0-9]{7}|[0-9a-v]{12})$'
    )
  ),
  CONSTRAINT operations_carrier_migration_placeholder_state_valid CHECK (
    (
      state = 'awaiting_credential_rebind'
      AND target_account_number_fingerprint IS NULL
      AND materialized_by IS NULL
      AND materialized_at IS NULL
    ) OR (
      state = 'materialized'
      AND target_account_number_fingerprint IS NOT NULL
      AND materialized_by IS NOT NULL
      AND materialized_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS operations_carrier_migration_placeholder_state_idx
  ON operations_carrier_account_migration_placeholders (
    organization_id, integration_account_id, state
  );

CREATE OR REPLACE FUNCTION protect_carrier_account_migration_placeholder()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Migrated carrier-account placeholders are immutable';
  END IF;
  IF ROW(
    NEW.id, NEW.global_id, NEW.organization_id, NEW.integration_account_id,
    NEW.provider, NEW.environment, NEW.display_name, NEW.sender_name,
    NEW.source_carrier_account_id, NEW.source_carrier_account_global_id,
    NEW.source_account_number_last_four,
    NEW.source_account_number_fingerprint,
    NEW.source_registered_address_fingerprint, NEW.rebind_mode,
    NEW.required_source_authority_organization_id,
    NEW.required_source_authority_integration_account_id,
    NEW.required_source_authority_carrier_account_id,
    NEW.required_source_organization_reference,
    NEW.required_source_integration_global_id,
    NEW.required_source_carrier_account_global_id,
    NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.global_id, OLD.organization_id, OLD.integration_account_id,
    OLD.provider, OLD.environment, OLD.display_name, OLD.sender_name,
    OLD.source_carrier_account_id, OLD.source_carrier_account_global_id,
    OLD.source_account_number_last_four,
    OLD.source_account_number_fingerprint,
    OLD.source_registered_address_fingerprint, OLD.rebind_mode,
    OLD.required_source_authority_organization_id,
    OLD.required_source_authority_integration_account_id,
    OLD.required_source_authority_carrier_account_id,
    OLD.required_source_organization_reference,
    OLD.required_source_integration_global_id,
    OLD.required_source_carrier_account_global_id,
    OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Migrated carrier-account placeholder identity is immutable';
  END IF;
  IF OLD.state = 'materialized' THEN
    RAISE EXCEPTION 'Migrated carrier-account materialization is immutable';
  END IF;
  IF NEW.state = 'materialized' THEN
    PERFORM 1
    FROM operations_carrier_accounts carrier_account
    JOIN operations_integration_accounts integration
      ON integration.organization_id = carrier_account.organization_id
     AND integration.id = carrier_account.integration_account_id
    JOIN operations_carrier_credentials credential
      ON credential.organization_id = integration.organization_id
     AND credential.integration_account_id = integration.id
     AND credential.verification_status = 'verified'
    WHERE carrier_account.organization_id = NEW.organization_id
      AND carrier_account.id = NEW.id
      AND carrier_account.global_id = NEW.global_id
      AND carrier_account.integration_account_id = NEW.integration_account_id
      AND carrier_account.account_number_last_four
        = NEW.source_account_number_last_four
      AND carrier_account.account_number_fingerprint
        = NEW.target_account_number_fingerprint
      AND carrier_account.registered_address_fingerprint
        = NEW.source_registered_address_fingerprint
      AND carrier_account.address_verification IN (
        'operator_attested', 'provider_verified'
      )
      AND carrier_account.status = 'active'
      AND integration.provider = NEW.provider
      AND integration.environment = NEW.environment
      AND integration.integration_type = 'carrier'
      AND integration.status <> 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Migrated carrier account requires a verified target credential and exact shipper identity';
    END IF;

    IF NEW.rebind_mode = 'source_authority' THEN
      PERFORM 1
      FROM workspace_organizations authority_org
      JOIN operations_integration_accounts authority_integration
        ON authority_integration.organization_id = authority_org.id
       AND authority_integration.id
          = NEW.required_source_authority_integration_account_id
      JOIN operations_carrier_accounts authority_account
        ON authority_account.organization_id = authority_org.id
       AND authority_account.id = NEW.required_source_authority_carrier_account_id
       AND authority_account.integration_account_id = authority_integration.id
      JOIN operations_carrier_credentials authority_credential
        ON authority_credential.organization_id = authority_org.id
       AND authority_credential.integration_account_id = authority_integration.id
       AND authority_credential.verification_status = 'verified'
      WHERE authority_org.id = NEW.required_source_authority_organization_id
        AND authority_org.reference_code
          = NEW.required_source_organization_reference
        AND authority_integration.global_id
          = NEW.required_source_integration_global_id
        AND authority_integration.integration_type = 'carrier'
        AND authority_integration.provider = NEW.provider
        AND authority_integration.environment = NEW.environment
        AND authority_integration.status = 'active'
        AND authority_account.global_id
          = NEW.required_source_carrier_account_global_id
        AND authority_account.account_number_last_four
          = NEW.source_account_number_last_four
        AND authority_account.registered_address_fingerprint
          = NEW.source_registered_address_fingerprint
        AND authority_account.address_verification IN (
          'operator_attested', 'provider_verified'
        )
        AND authority_account.allow_sender_billing = true
        AND authority_account.status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Migrated source-managed carrier requires its verified production source authority';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_carrier_account_migration_placeholder_write
  ON operations_carrier_account_migration_placeholders;
CREATE TRIGGER protect_carrier_account_migration_placeholder_write
BEFORE UPDATE OR DELETE
ON operations_carrier_account_migration_placeholders
FOR EACH ROW EXECUTE FUNCTION protect_carrier_account_migration_placeholder();

CREATE TABLE IF NOT EXISTS operations_commerce_migration_provider_identity_fences (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (
    provider IN ('shopify', 'faire', 'ups_rest', 'fedex_rest')
  ),
  integration_type text NOT NULL CHECK (
    integration_type IN ('commerce', 'carrier')
  ),
  identity_kind text NOT NULL CHECK (
    identity_kind IN ('external_account_id', 'carrier_shipper_account')
  ),
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
  source_provider_identity_sha256 text NOT NULL CHECK (
    source_provider_identity_sha256 ~ '^[a-f0-9]{64}$'
  ),
  expected_external_account_id_sha256 text CHECK (
    expected_external_account_id_sha256 IS NULL
    OR expected_external_account_id_sha256 ~ '^[a-f0-9]{64}$'
  ),
  reconnect_eligible boolean NOT NULL,
  verification_state text NOT NULL DEFAULT 'awaiting_provider_identity'
    CHECK (verification_state IN ('awaiting_provider_identity', 'verified')),
  verified_external_account_id_sha256 text CHECK (
    verified_external_account_id_sha256 IS NULL
    OR verified_external_account_id_sha256 ~ '^[a-f0-9]{64}$'
  ),
  verified_carrier_account_id uuid,
  verified_carrier_account_identity_sha256 text CHECK (
    verified_carrier_account_identity_sha256 IS NULL
    OR verified_carrier_account_identity_sha256 ~ '^[a-f0-9]{64}$'
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
  CONSTRAINT operations_commerce_migration_provider_fence_carrier_account_fkey
    FOREIGN KEY (organization_id, verified_carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_migration_provider_fence_kind_valid CHECK (
    (
      integration_type = 'commerce'
      AND identity_kind = 'external_account_id'
      AND provider IN ('shopify', 'faire')
      AND expected_external_account_id_sha256 IS NOT NULL
      AND expected_external_account_id_sha256
        = source_provider_identity_sha256
    ) OR (
      integration_type = 'carrier'
      AND identity_kind = 'carrier_shipper_account'
      AND provider IN ('ups_rest', 'fedex_rest')
      AND expected_external_account_id_sha256 IS NULL
    )
  ),
  CONSTRAINT operations_commerce_migration_provider_fence_verification_valid CHECK (
    (
      verification_state = 'awaiting_provider_identity'
      AND verified_external_account_id_sha256 IS NULL
      AND verified_carrier_account_id IS NULL
      AND verified_carrier_account_identity_sha256 IS NULL
      AND verified_by IS NULL
      AND verified_at IS NULL
    ) OR (
      verification_state = 'verified'
      AND reconnect_eligible = true
      AND (
        (
          integration_type = 'commerce'
          AND verified_external_account_id_sha256
            = expected_external_account_id_sha256
          AND verified_carrier_account_id IS NULL
          AND verified_carrier_account_identity_sha256 IS NULL
        ) OR (
          integration_type = 'carrier'
          AND verified_external_account_id_sha256 IS NULL
          AND verified_carrier_account_id IS NOT NULL
          AND verified_carrier_account_identity_sha256 IS NOT NULL
        )
      )
      AND verified_by IS NOT NULL
      AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT operations_commerce_migration_provider_fence_event_unique
    UNIQUE (migration_event_key, integration_account_id)
);

-- 0353 was reviewed in draft form before the carrier scope was added. Make
-- this follow-up safe both for a fresh install and for a database that already
-- recorded the commerce-only draft migration.
ALTER TABLE operations_commerce_migration_provider_identity_fences
  ADD COLUMN IF NOT EXISTS integration_type text,
  ADD COLUMN IF NOT EXISTS identity_kind text,
  ADD COLUMN IF NOT EXISTS source_provider_identity_sha256 text,
  ADD COLUMN IF NOT EXISTS verified_carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS verified_carrier_account_identity_sha256 text;

UPDATE operations_commerce_migration_provider_identity_fences
SET integration_type = 'commerce',
    identity_kind = 'external_account_id',
    source_provider_identity_sha256 = expected_external_account_id_sha256
WHERE integration_type IS NULL
   OR identity_kind IS NULL
   OR source_provider_identity_sha256 IS NULL;

ALTER TABLE operations_commerce_migration_provider_identity_fences
  ALTER COLUMN integration_type SET NOT NULL,
  ALTER COLUMN identity_kind SET NOT NULL,
  ALTER COLUMN source_provider_identity_sha256 SET NOT NULL,
  ALTER COLUMN expected_external_account_id_sha256 DROP NOT NULL;

DO $$
DECLARE
  constraint_name text;
  target_attribute smallint;
BEGIN
  SELECT attnum INTO target_attribute
  FROM pg_attribute
  WHERE attrelid = 'operations_commerce_migration_provider_identity_fences'::regclass
    AND attname = 'provider';
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'operations_commerce_migration_provider_identity_fences'::regclass
      AND contype = 'c'
      AND conkey = ARRAY[target_attribute]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE operations_commerce_migration_provider_identity_fences DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE operations_commerce_migration_provider_identity_fences
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_provider_valid,
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_type_valid,
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_identity_kind_valid,
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_kind_valid,
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_verification_valid,
  DROP CONSTRAINT IF EXISTS operations_commerce_migration_provider_fence_carrier_account_fkey;

ALTER TABLE operations_commerce_migration_provider_identity_fences
  ADD CONSTRAINT operations_commerce_migration_provider_fence_provider_valid
    CHECK (provider IN ('shopify', 'faire', 'ups_rest', 'fedex_rest')),
  ADD CONSTRAINT operations_commerce_migration_provider_fence_type_valid
    CHECK (integration_type IN ('commerce', 'carrier')),
  ADD CONSTRAINT operations_commerce_migration_provider_fence_identity_kind_valid
    CHECK (identity_kind IN ('external_account_id', 'carrier_shipper_account')),
  ADD CONSTRAINT operations_commerce_migration_provider_fence_kind_valid CHECK (
    (
      integration_type = 'commerce'
      AND identity_kind = 'external_account_id'
      AND provider IN ('shopify', 'faire')
      AND expected_external_account_id_sha256 IS NOT NULL
      AND expected_external_account_id_sha256
        = source_provider_identity_sha256
    ) OR (
      integration_type = 'carrier'
      AND identity_kind = 'carrier_shipper_account'
      AND provider IN ('ups_rest', 'fedex_rest')
      AND expected_external_account_id_sha256 IS NULL
    )
  ),
  ADD CONSTRAINT operations_commerce_migration_provider_fence_verification_valid CHECK (
    (
      verification_state = 'awaiting_provider_identity'
      AND verified_external_account_id_sha256 IS NULL
      AND verified_carrier_account_id IS NULL
      AND verified_carrier_account_identity_sha256 IS NULL
      AND verified_by IS NULL
      AND verified_at IS NULL
    ) OR (
      verification_state = 'verified'
      AND reconnect_eligible = true
      AND (
        (
          integration_type = 'commerce'
          AND verified_external_account_id_sha256
            = expected_external_account_id_sha256
          AND verified_carrier_account_id IS NULL
          AND verified_carrier_account_identity_sha256 IS NULL
        ) OR (
          integration_type = 'carrier'
          AND verified_external_account_id_sha256 IS NULL
          AND verified_carrier_account_id IS NOT NULL
          AND verified_carrier_account_identity_sha256 IS NOT NULL
        )
      )
      AND verified_by IS NOT NULL
      AND verified_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT operations_commerce_migration_provider_fence_carrier_account_fkey
    FOREIGN KEY (organization_id, verified_carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION protect_commerce_migration_provider_identity_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Migrated provider identity fences are immutable';
  END IF;

  IF ROW(
    NEW.organization_id, NEW.integration_account_id, NEW.provider,
    NEW.integration_type, NEW.identity_kind, NEW.environment,
    NEW.source_database_identity, NEW.source_database_endpoint_sha256,
    NEW.target_database_endpoint_sha256, NEW.source_account_global_id,
    NEW.source_provider_identity_sha256,
    NEW.expected_external_account_id_sha256, NEW.reconnect_eligible,
    NEW.migration_event_key, NEW.created_by, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id, OLD.integration_account_id, OLD.provider,
    OLD.integration_type, OLD.identity_kind, OLD.environment,
    OLD.source_database_identity, OLD.source_database_endpoint_sha256,
    OLD.target_database_endpoint_sha256, OLD.source_account_global_id,
    OLD.source_provider_identity_sha256,
    OLD.expected_external_account_id_sha256, OLD.reconnect_eligible,
    OLD.migration_event_key, OLD.created_by, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Migrated provider identity fence identity is immutable';
  END IF;

  IF OLD.verification_state = 'verified' THEN
    RAISE EXCEPTION 'Migrated provider identity verification is immutable';
  END IF;

  IF NEW.verification_state = 'verified' THEN
    IF NEW.reconnect_eligible IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Migrated provider identity is not eligible for reconnect';
    END IF;
    IF NEW.integration_type = 'commerce'
       AND NEW.verified_external_account_id_sha256
            IS DISTINCT FROM NEW.expected_external_account_id_sha256 THEN
      RAISE EXCEPTION 'Migrated provider identity did not match the approved source account';
    END IF;
    IF NEW.integration_type = 'carrier' THEN
      PERFORM 1
      FROM operations_carrier_account_migration_placeholders placeholder
      JOIN operations_carrier_accounts carrier_account
        ON carrier_account.organization_id = placeholder.organization_id
       AND carrier_account.id = placeholder.id
       AND carrier_account.integration_account_id
         = placeholder.integration_account_id
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = placeholder.organization_id
       AND credential.integration_account_id
         = placeholder.integration_account_id
       AND credential.verification_status = 'verified'
      WHERE placeholder.organization_id = NEW.organization_id
        AND placeholder.integration_account_id = NEW.integration_account_id
        AND placeholder.state = 'materialized'
        AND placeholder.id = NEW.verified_carrier_account_id
        AND placeholder.target_account_number_fingerprint
          = NEW.verified_carrier_account_identity_sha256
        AND carrier_account.account_number_fingerprint
          = NEW.verified_carrier_account_identity_sha256;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Migrated carrier identity requires a materialized target shipper account';
      END IF;
    END IF;
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

CREATE OR REPLACE FUNCTION protect_migrated_carrier_shipper_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_carrier_account_migration_placeholders placeholder
    JOIN operations_integration_accounts delegated_integration
      ON delegated_integration.organization_id = placeholder.organization_id
     AND delegated_integration.id = placeholder.integration_account_id
     AND delegated_integration.status = 'active'
    WHERE placeholder.rebind_mode = 'source_authority'
      AND placeholder.required_source_authority_organization_id
        = OLD.organization_id
      AND placeholder.required_source_authority_integration_account_id
        = OLD.integration_account_id
      AND placeholder.required_source_authority_carrier_account_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.id, NEW.global_id, NEW.organization_id, NEW.integration_account_id,
      NEW.sender_name, NEW.account_number_last_four, NEW.registered_address,
      NEW.registered_address_fingerprint, NEW.address_verification,
      NEW.allow_sender_billing, NEW.status
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.global_id, OLD.organization_id, OLD.integration_account_id,
      OLD.sender_name, OLD.account_number_last_four, OLD.registered_address,
      OLD.registered_address_fingerprint, OLD.address_verification,
      OLD.allow_sender_billing, OLD.status
    )
  ) THEN
    RAISE EXCEPTION 'Active migrated delegation source carrier authority is immutable';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_commerce_migration_provider_identity_fences fence
    WHERE fence.organization_id = OLD.organization_id
      AND fence.verified_carrier_account_id = OLD.id
      AND fence.integration_type = 'carrier'
      AND fence.verification_state = 'verified'
  ) AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.id, NEW.global_id, NEW.organization_id, NEW.integration_account_id,
      NEW.sender_name, NEW.account_number_last_four, NEW.account_number_fingerprint,
      NEW.registered_address, NEW.registered_address_fingerprint,
      NEW.address_verification, NEW.allow_sender_billing, NEW.status
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.global_id, OLD.organization_id, OLD.integration_account_id,
      OLD.sender_name, OLD.account_number_last_four, OLD.account_number_fingerprint,
      OLD.registered_address, OLD.registered_address_fingerprint,
      OLD.address_verification, OLD.allow_sender_billing, OLD.status
    )
  ) THEN
    RAISE EXCEPTION 'Migrated verified carrier shipper identity is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_migrated_carrier_shipper_identity_write
  ON operations_carrier_accounts;
CREATE TRIGGER protect_migrated_carrier_shipper_identity_write
BEFORE UPDATE OR DELETE
ON operations_carrier_accounts
FOR EACH ROW EXECUTE FUNCTION protect_migrated_carrier_shipper_identity();

CREATE OR REPLACE FUNCTION protect_active_migrated_source_authority_integration()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_carrier_account_migration_placeholders placeholder
    JOIN operations_integration_accounts delegated_integration
      ON delegated_integration.organization_id = placeholder.organization_id
     AND delegated_integration.id = placeholder.integration_account_id
     AND delegated_integration.status = 'active'
    WHERE placeholder.rebind_mode = 'source_authority'
      AND placeholder.required_source_authority_organization_id
        = OLD.organization_id
      AND placeholder.required_source_authority_integration_account_id = OLD.id
  ) AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.id, NEW.global_id, NEW.organization_id, NEW.provider,
      NEW.integration_type, NEW.environment, NEW.status
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.global_id, OLD.organization_id, OLD.provider,
      OLD.integration_type, OLD.environment, OLD.status
    )
  ) THEN
    RAISE EXCEPTION 'Active migrated delegation source integration authority is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_active_migrated_source_authority_integration_write
  ON operations_integration_accounts;
CREATE TRIGGER protect_active_migrated_source_authority_integration_write
BEFORE UPDATE OR DELETE
ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION
  protect_active_migrated_source_authority_integration();

CREATE OR REPLACE FUNCTION protect_active_migrated_source_authority_credential()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM operations_carrier_account_migration_placeholders placeholder
    JOIN operations_integration_accounts delegated_integration
      ON delegated_integration.organization_id = placeholder.organization_id
     AND delegated_integration.id = placeholder.integration_account_id
     AND delegated_integration.status = 'active'
    WHERE placeholder.rebind_mode = 'source_authority'
      AND placeholder.required_source_authority_organization_id
        = OLD.organization_id
      AND placeholder.required_source_authority_integration_account_id
        = OLD.integration_account_id
  ) AND (
    TG_OP = 'DELETE'
    OR NEW.verification_status IS DISTINCT FROM 'verified'
  ) THEN
    RAISE EXCEPTION 'Active migrated delegation source credential authority must remain verified';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_active_migrated_source_authority_credential_write
  ON operations_carrier_credentials;
CREATE TRIGGER protect_active_migrated_source_authority_credential_write
BEFORE UPDATE OR DELETE
ON operations_carrier_credentials
FOR EACH ROW EXECUTE FUNCTION
  protect_active_migrated_source_authority_credential();

CREATE OR REPLACE FUNCTION enforce_migrated_commerce_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fence operations_commerce_migration_provider_identity_fences%ROWTYPE;
  placeholder operations_carrier_account_migration_placeholders%ROWTYPE;
  observed_hash text;
BEGIN
  SELECT * INTO fence
  FROM operations_commerce_migration_provider_identity_fences
  WHERE organization_id = NEW.organization_id
    AND integration_account_id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.provider <> fence.provider
     OR NEW.integration_type <> fence.integration_type
     OR NEW.environment <> fence.environment THEN
    RAISE EXCEPTION 'Migrated provider, integration type, and environment are immutable';
  END IF;

  IF fence.integration_type = 'commerce' THEN
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
  END IF;

  IF NEW.external_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Migrated carrier account cannot store a commerce provider identity';
  END IF;
  SELECT * INTO placeholder
  FROM operations_carrier_account_migration_placeholders
  WHERE organization_id = NEW.organization_id
    AND integration_account_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migrated carrier account lacks its shipper placeholder';
  END IF;
  IF placeholder.rebind_mode = 'source_authority' AND (
    NEW.configuration->>'managedBy'
      IS DISTINCT FROM 'ag-alchemy-episcs-sandbox-rating-delegation'
    OR NEW.configuration->'credentialRevealAllowed' IS DISTINCT FROM 'false'::jsonb
    OR NEW.configuration->>'delegatedFromOrganizationReferenceCode'
      IS DISTINCT FROM placeholder.required_source_organization_reference
    OR NEW.configuration->>'sourceIntegrationGlobalId'
      IS DISTINCT FROM placeholder.required_source_integration_global_id
    OR NEW.configuration->>'sourceCarrierAccountGlobalId'
      IS DISTINCT FROM placeholder.required_source_carrier_account_global_id
    OR NULLIF(NEW.configuration->>'senderOriginWarehouseGlobalId', '') IS NULL
    OR COALESCE(NEW.configuration->>'authorizationScope', '') NOT IN (
      'sandbox_rating_only', 'sandbox_fulfillment_diagnostic'
    )
    OR NOT COALESCE((
      NEW.configuration->'allowedCapabilities' = '[]'::jsonb
      OR (
        NEW.configuration->>'authorizationScope' = 'sandbox_rating_only'
        AND NEW.configuration->'allowedCapabilities' = '["sandbox_rate"]'::jsonb
      ) OR (
        NEW.configuration->>'authorizationScope'
          = 'sandbox_fulfillment_diagnostic'
        AND NEW.configuration->'allowedCapabilities'
          = '["sandbox_rate","sandbox_label"]'::jsonb
      )
    ), false)
  ) THEN
    RAISE EXCEPTION 'Migrated source-managed carrier delegation identity is immutable';
  END IF;
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;
  IF fence.verification_state <> 'verified' THEN
    RAISE EXCEPTION 'Migrated carrier account provider and shipper identity is not verified';
  END IF;

  IF placeholder.state <> 'materialized' THEN
    RAISE EXCEPTION 'Migrated carrier account is not materialized';
  END IF;

  PERFORM 1
  FROM operations_carrier_accounts carrier_account
  JOIN operations_carrier_credentials credential
    ON credential.organization_id = carrier_account.organization_id
   AND credential.integration_account_id = carrier_account.integration_account_id
   AND credential.verification_status = 'verified'
  WHERE carrier_account.organization_id = NEW.organization_id
    AND carrier_account.id = fence.verified_carrier_account_id
    AND carrier_account.integration_account_id = NEW.id
    AND carrier_account.account_number_fingerprint
      = fence.verified_carrier_account_identity_sha256
    AND carrier_account.account_number_last_four
      = placeholder.source_account_number_last_four
    AND carrier_account.registered_address_fingerprint
      = placeholder.source_registered_address_fingerprint
    AND carrier_account.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Migrated carrier account lost its verified target credential or shipper identity';
  END IF;

  IF placeholder.rebind_mode = 'source_authority' THEN
    PERFORM 1
    FROM workspace_organizations authority_org
    JOIN operations_integration_accounts authority_integration
      ON authority_integration.organization_id = authority_org.id
     AND authority_integration.id
       = placeholder.required_source_authority_integration_account_id
    JOIN operations_carrier_accounts authority_account
      ON authority_account.organization_id = authority_org.id
     AND authority_account.id
       = placeholder.required_source_authority_carrier_account_id
     AND authority_account.integration_account_id = authority_integration.id
    JOIN operations_carrier_credentials authority_credential
      ON authority_credential.organization_id = authority_org.id
     AND authority_credential.integration_account_id = authority_integration.id
     AND authority_credential.verification_status = 'verified'
    WHERE authority_org.id
        = placeholder.required_source_authority_organization_id
      AND authority_org.reference_code
        = placeholder.required_source_organization_reference
      AND authority_integration.global_id
        = placeholder.required_source_integration_global_id
      AND authority_integration.provider = NEW.provider
      AND authority_integration.integration_type = 'carrier'
      AND authority_integration.environment = NEW.environment
      AND authority_integration.status = 'active'
      AND authority_account.global_id
        = placeholder.required_source_carrier_account_global_id
      AND authority_account.account_number_last_four
        = placeholder.source_account_number_last_four
      AND authority_account.registered_address_fingerprint
        = placeholder.source_registered_address_fingerprint
      AND authority_account.allow_sender_billing = true
      AND authority_account.status = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Migrated source-managed carrier lost its verified production source authority';
    END IF;
    IF NEW.configuration->>'managedBy'
         IS DISTINCT FROM 'ag-alchemy-episcs-sandbox-rating-delegation'
       OR NEW.configuration->'credentialRevealAllowed' IS DISTINCT FROM 'false'::jsonb
       OR NEW.configuration->'migrationSourceAuthorityVerified'
         IS DISTINCT FROM 'true'::jsonb
       OR NEW.configuration->>'delegatedFromOrganizationReferenceCode'
         IS DISTINCT FROM placeholder.required_source_organization_reference
       OR NEW.configuration->>'sourceIntegrationGlobalId'
         IS DISTINCT FROM placeholder.required_source_integration_global_id
       OR NEW.configuration->>'sourceCarrierAccountGlobalId'
         IS DISTINCT FROM placeholder.required_source_carrier_account_global_id
       OR NULLIF(NEW.configuration->>'senderOriginWarehouseGlobalId', '') IS NULL
       OR NOT COALESCE((
         (
           NEW.configuration->>'authorizationScope' = 'sandbox_rating_only'
           AND NEW.configuration->'allowedCapabilities'
             = '["sandbox_rate"]'::jsonb
         ) OR (
           NEW.configuration->>'authorizationScope'
             = 'sandbox_fulfillment_diagnostic'
           AND NEW.configuration->'allowedCapabilities'
             = '["sandbox_rate","sandbox_label"]'::jsonb
         )
       ), false)
       OR NOT EXISTS (
         SELECT 1 FROM operations_warehouses origin
         WHERE origin.organization_id = NEW.organization_id
           AND origin.global_id
             = NEW.configuration->>'senderOriginWarehouseGlobalId'
           AND origin.status = 'active'
       ) THEN
      RAISE EXCEPTION 'Migrated source-managed carrier delegation policy is not rebound';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_migrated_commerce_provider_identity_write
  ON operations_integration_accounts;
CREATE TRIGGER enforce_migrated_commerce_provider_identity_write
BEFORE UPDATE OF provider, integration_type, environment, external_account_id,
  status, configuration, credential_reference
ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_migrated_commerce_provider_identity();

CREATE OR REPLACE FUNCTION protect_commerce_workspace_migration_receipt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.event_type = 'operations.commerce_workspace_migration.completed'
     AND (
       OLD.event_key LIKE 'commerce-workspace-migration:commerce-workspace-production-migration-v2:%'
       OR OLD.event_key LIKE 'commerce-workspace-migration:sales-shipping-workspace-production-migration-v3:%'
     ) THEN
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

CREATE OR REPLACE FUNCTION
  public.operations_shopify_carrier_configuration_allows_rating(
    configuration jsonb,
    requested_environment text
  )
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE requested_environment
    WHEN 'sandbox' THEN CASE
      WHEN COALESCE(
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        OR (
          configuration ->> 'authorizationScope' IN (
            'sandbox_rating_only',
            'sandbox_fulfillment_diagnostic'
          )
          AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        ),
        false
      ) THEN (
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        AND (
          configuration ->> 'senderOriginWarehouseGlobalId' = 'gwh5366613'
          OR (
            configuration -> 'migrationSourceAuthorityVerified' = 'true'::jsonb
            AND configuration ->> 'delegatedFromOrganizationReferenceCode'
              = 'ga5122758'
            AND concat(
              configuration ->> 'sourceIntegrationGlobalId',
              ':',
              configuration ->> 'sourceCarrierAccountGlobalId'
            ) IN ('gia7335302:gac2368052', 'gia2057284:gac5139730')
            AND configuration ->> 'senderOriginWarehouseGlobalId'
              ~ '^gwh(?:[0-9]{7}|[0-9a-v]{12})$'
          )
        )
        AND (
          (
            configuration ->> 'authorizationScope' = 'sandbox_rating_only'
            AND configuration -> 'allowedCapabilities'
              = '["sandbox_rate"]'::jsonb
          ) OR (
            configuration ->> 'authorizationScope'
              = 'sandbox_fulfillment_diagnostic'
            AND configuration -> 'allowedCapabilities'
              = '["sandbox_rate","sandbox_label"]'::jsonb
          )
        )
      )
      ELSE (
        jsonb_typeof(configuration -> 'allowedCapabilities')
          IS DISTINCT FROM 'array'
        OR configuration -> 'allowedCapabilities' ? 'sandbox_rate'
      )
    END
    WHEN 'production' THEN (
      NOT COALESCE(
        configuration ->> 'managedBy'
          = 'ag-alchemy-episcs-sandbox-rating-delegation'
        OR (
          configuration ->> 'authorizationScope' IN (
            'sandbox_rating_only',
            'sandbox_fulfillment_diagnostic'
          )
          AND configuration -> 'credentialRevealAllowed' = 'false'::jsonb
        ),
        false
      )
      AND jsonb_typeof(configuration -> 'allowedCapabilities') = 'array'
      AND configuration -> 'allowedCapabilities' ? 'production_rate'
    )
    ELSE false
  END;
$$;

ALTER FUNCTION
  public.operations_shopify_carrier_configuration_allows_rating(jsonb, text)
  SET search_path = pg_catalog, public, pg_temp;

COMMENT ON TABLE operations_commerce_workspace_migration_cutover_fences IS
  'Explicit source-side cutover fence for selected commerce and carrier integrations. Migration also takes NOWAIT SHARE locks before snapshotting selected and queue tables.';
COMMENT ON TABLE operations_carrier_account_migration_placeholders IS
  'Credential-free preallocated carrier identity mapping. Materialization requires target reauthentication, exact last-four/address identity, and any compiled source-authority dependency.';
COMMENT ON TABLE operations_commerce_migration_provider_identity_fences IS
  'Credential-free target fence binding migrated commerce and carrier placeholders to their approved provider/environment/identity before activation.';
