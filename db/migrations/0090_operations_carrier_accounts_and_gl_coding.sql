-- Address-bound carrier accounts and GL Coding runs.
--
-- Provider credentials remain on operations_carrier_credentials. A provider
-- connection may expose several carrier account numbers, each encrypted
-- independently and bound to its registered sender/recipient address.
--
-- GL Coding intentionally keeps shipment matching separate from shipper and
-- accounting assignment. An imported charge may remain unmatched to a
-- ClawPilot shipment while still being assigned to a shipper through a
-- reviewed rule or manual decision. No assignment fabricates a shipment match.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('gac', 'operations.carrier_account', 'Carrier account'),
  ('ggl', 'operations.gl_coding_run', 'GL Coding run'),
  ('ggi', 'operations.gl_coding_run_item', 'GL Coding run item')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_carrier_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gac'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  display_name text NOT NULL,
  account_number_ciphertext text NOT NULL,
  account_number_iv text NOT NULL,
  account_number_tag text NOT NULL,
  encryption_version integer NOT NULL DEFAULT 1 CHECK (encryption_version > 0),
  account_number_last_four text NOT NULL CHECK (length(account_number_last_four) = 4),
  account_number_fingerprint text NOT NULL
    CHECK (account_number_fingerprint ~ '^[a-f0-9]{64}$'),
  registered_address jsonb NOT NULL,
  registered_address_fingerprint text NOT NULL
    CHECK (registered_address_fingerprint ~ '^[a-f0-9]{64}$'),
  address_verification text NOT NULL DEFAULT 'operator_attested'
    CHECK (address_verification IN (
      'unverified', 'operator_attested', 'provider_verified'
    )),
  allow_sender_billing boolean NOT NULL DEFAULT true,
  allow_recipient_billing boolean NOT NULL DEFAULT true,
  allow_third_party_billing boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('needs_configuration', 'active', 'disabled')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_accounts_global_valid
    CHECK (global_id ~ '^gac[0-9]{7}$'),
  CONSTRAINT operations_carrier_accounts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_accounts_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_accounts_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_accounts_name_present
    CHECK (NULLIF(btrim(display_name), '') IS NOT NULL),
  CONSTRAINT operations_carrier_accounts_address_valid CHECK (
    jsonb_typeof(registered_address) = 'object'
    AND NULLIF(btrim(registered_address->>'line1'), '') IS NOT NULL
    AND NULLIF(btrim(registered_address->>'city'), '') IS NOT NULL
    AND NULLIF(btrim(registered_address->>'region'), '') IS NOT NULL
    AND NULLIF(btrim(registered_address->>'postalCode'), '') IS NOT NULL
    AND NULLIF(btrim(registered_address->>'countryCode'), '') IS NOT NULL
  ),
  CONSTRAINT operations_carrier_accounts_org_integration_id_unique
    UNIQUE (organization_id, integration_account_id, id),
  CONSTRAINT operations_carrier_accounts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_carrier_accounts_number_unique
    UNIQUE (organization_id, integration_account_id, account_number_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_operations_carrier_accounts_active
  ON operations_carrier_accounts (
    organization_id, integration_account_id, status, display_name, id
  );

CREATE OR REPLACE FUNCTION validate_operations_carrier_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  integration_type text;
BEGIN
  SELECT account.integration_type
  INTO integration_type
  FROM operations_integration_accounts account
  WHERE account.organization_id = NEW.organization_id
    AND account.id = NEW.integration_account_id;

  IF integration_type IS DISTINCT FROM 'carrier' THEN
    RAISE EXCEPTION 'Carrier account requires a carrier provider connection';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_account_write
  ON operations_carrier_accounts;
CREATE TRIGGER validate_operations_carrier_account_write
BEFORE INSERT OR UPDATE ON operations_carrier_accounts
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_account();

CREATE OR REPLACE FUNCTION protect_operations_carrier_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Carrier account ownership and record identity are immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_carrier_account_identity_mutation
  ON operations_carrier_accounts;
CREATE TRIGGER protect_operations_carrier_account_identity_mutation
BEFORE UPDATE OR DELETE ON operations_carrier_accounts
FOR EACH ROW EXECUTE FUNCTION protect_operations_carrier_account_identity();

ALTER TABLE operations_carrier_account_authorizations
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid;

-- 0089 scoped authorization versions to the provider connection. A provider
-- connection may expose several explicit carrier accounts, so both version
-- identity and supersession must be account-scoped.
ALTER TABLE operations_carrier_quote_snapshots
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_authorization_fkey;
ALTER TABLE operations_carrier_billing_account_resolutions
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_authorization_fkey;

ALTER TABLE operations_carrier_account_authorizations
  DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_version_unique,
  DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_scope_unique,
  DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_supersedes_fkey;

DROP INDEX IF EXISTS operations_carrier_account_authorizations_version_unique;
DROP INDEX IF EXISTS idx_operations_carrier_account_authorizations_account_version;

ALTER TABLE operations_carrier_account_authorizations
  DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_carrier_account_fkey,
  ADD CONSTRAINT operations_carrier_account_authorizations_carrier_account_fkey
    FOREIGN KEY (
      account_owner_organization_id, integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_account_authorizations_explicit_account,
  ADD CONSTRAINT operations_carrier_account_authorizations_explicit_account
    CHECK (carrier_account_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT operations_carrier_account_authorizations_scope_unique
    UNIQUE (
      network_id, id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    ),
  ADD CONSTRAINT operations_carrier_account_authorizations_account_id_unique
    UNIQUE (network_id, carrier_account_id, id),
  ADD CONSTRAINT operations_carrier_account_authorizations_supersedes_fkey
    FOREIGN KEY (
      network_id, carrier_account_id, supersedes_authorization_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID;

CREATE UNIQUE INDEX idx_operations_carrier_account_authorizations_account_version
  ON operations_carrier_account_authorizations (
    network_id, carrier_account_id, version_number
  )
  WHERE carrier_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_operations_carrier_account_authorization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_type text;
  owner_party_id uuid;
  superseded_owner_organization_id uuid;
  superseded_integration_account_id uuid;
  superseded_carrier_account_id uuid;
  superseded_version_number integer;
BEGIN
  SELECT integration.integration_type
  INTO account_type
  FROM operations_carrier_accounts carrier_account
  JOIN operations_integration_accounts integration
    ON integration.organization_id = carrier_account.organization_id
   AND integration.id = carrier_account.integration_account_id
  WHERE carrier_account.organization_id = NEW.account_owner_organization_id
    AND carrier_account.integration_account_id = NEW.integration_account_id
    AND carrier_account.id = NEW.carrier_account_id;

  IF account_type IS DISTINCT FROM 'carrier' THEN
    RAISE EXCEPTION
      'Carrier rate authorization requires an explicit carrier account on a carrier provider connection';
  END IF;

  SELECT party.id
  INTO owner_party_id
  FROM operations_carrier_rate_parties party
  WHERE party.network_id = NEW.network_id
    AND party.workspace_organization_id = NEW.account_owner_organization_id
    AND party.role IN ('platform_operator', 'reseller');

  IF owner_party_id IS NULL THEN
    RAISE EXCEPTION
      'Carrier account owner must be a platform or reseller party in the rate network';
  END IF;

  IF NEW.version_number > 1 AND NEW.supersedes_authorization_id IS NULL THEN
    RAISE EXCEPTION
      'Versioned carrier account authorization must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_authorization_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Initial carrier account authorization cannot supersede another version';
  END IF;

  IF NEW.supersedes_authorization_id IS NOT NULL THEN
    SELECT
      prior.account_owner_organization_id,
      prior.integration_account_id,
      prior.carrier_account_id,
      prior.version_number
    INTO
      superseded_owner_organization_id,
      superseded_integration_account_id,
      superseded_carrier_account_id,
      superseded_version_number
    FROM operations_carrier_account_authorizations prior
    WHERE prior.network_id = NEW.network_id
      AND prior.carrier_account_id = NEW.carrier_account_id
      AND prior.id = NEW.supersedes_authorization_id;

    IF superseded_owner_organization_id
         IS DISTINCT FROM NEW.account_owner_organization_id
       OR superseded_integration_account_id
         IS DISTINCT FROM NEW.integration_account_id
       OR superseded_carrier_account_id
         IS DISTINCT FROM NEW.carrier_account_id THEN
      RAISE EXCEPTION
        'Carrier account authorization may only supersede the same explicit carrier account';
    END IF;
    IF NEW.version_number IS DISTINCT FROM superseded_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier account authorization versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Keep the 0089 trigger but replace its function with account-scoped checks.

ALTER TABLE operations_carrier_rate_grants
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_grants_version_unique,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_grants_parent_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_grants_supersedes_fkey;

DROP INDEX IF EXISTS operations_carrier_rate_grants_version_unique;

ALTER TABLE operations_carrier_rate_grants
  ADD CONSTRAINT operations_carrier_rate_grants_authorization_id_unique
    UNIQUE (network_id, account_authorization_id, id),
  ADD CONSTRAINT operations_carrier_rate_grants_parent_fkey
    FOREIGN KEY (network_id, account_authorization_id, parent_grant_id)
    REFERENCES operations_carrier_rate_grants(
      network_id, account_authorization_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_rate_grants_supersedes_fkey
    FOREIGN KEY (network_id, account_authorization_id, supersedes_grant_id)
    REFERENCES operations_carrier_rate_grants(
      network_id, account_authorization_id, id
    ) ON DELETE RESTRICT NOT VALID;

CREATE UNIQUE INDEX idx_operations_carrier_rate_grants_authorization_version
  ON operations_carrier_rate_grants (
    network_id, account_authorization_id,
    grantor_party_id, grantee_party_id, version_number
  );

ALTER TABLE operations_carrier_quote_snapshots
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS billing_relationship text,
  ADD COLUMN IF NOT EXISTS billing_selection_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operations_carrier_quote_snapshots
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_carrier_account_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_scope_unique,
  ADD CONSTRAINT operations_carrier_quote_snapshots_carrier_account_fkey
    FOREIGN KEY (
      account_owner_organization_id, integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_quote_snapshots_authorization_fkey
    FOREIGN KEY (
      network_id, account_authorization_id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    ) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_explicit_account,
  ADD CONSTRAINT operations_carrier_quote_snapshots_explicit_account
    CHECK (carrier_account_id IS NOT NULL) NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_billing_relationship_valid,
  ADD CONSTRAINT operations_carrier_quote_snapshots_billing_relationship_valid CHECK (
    billing_relationship IS NULL
    OR billing_relationship IN ('sender', 'recipient', 'third_party')
  ),
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_billing_selection_valid,
  ADD CONSTRAINT operations_carrier_quote_snapshots_billing_selection_valid CHECK (
    jsonb_typeof(billing_selection_snapshot) = 'object'
  ),
  ADD CONSTRAINT operations_carrier_quote_snapshots_scope_unique
    UNIQUE (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    );

ALTER TABLE operations_carrier_billing_account_resolutions
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid;

ALTER TABLE operations_carrier_billing_account_resolutions
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_carrier_account_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_target_valid,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_supersedes_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_statement_id_unique,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_carrier_account_fkey
    FOREIGN KEY (
      account_owner_organization_id, integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_authorization_fkey
    FOREIGN KEY (
      network_id, account_authorization_id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    ) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_account_resolutions_explicit_account,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_explicit_account CHECK (
    decision <> 'matched' OR carrier_account_id IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_target_valid CHECK (
    (
      decision = 'matched'
      AND account_authorization_id IS NOT NULL
      AND account_owner_organization_id IS NOT NULL
      AND integration_account_id IS NOT NULL
      AND carrier_account_id IS NOT NULL
      AND match_method <> 'none'
    )
    OR (
      decision <> 'matched'
      AND account_authorization_id IS NULL
      AND account_owner_organization_id IS NULL
      AND integration_account_id IS NULL
      AND carrier_account_id IS NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_statement_id_unique
    UNIQUE (network_id, statement_id, id),
  ADD CONSTRAINT operations_carrier_billing_account_resolutions_supersedes_fkey
    FOREIGN KEY (network_id, statement_id, supersedes_resolution_id)
    REFERENCES operations_carrier_billing_account_resolutions(
      network_id, statement_id, id
    ) ON DELETE RESTRICT NOT VALID;

ALTER TABLE operations_carrier_rate_requests
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS network_id uuid,
  ADD COLUMN IF NOT EXISTS account_authorization_id uuid,
  ADD COLUMN IF NOT EXISTS billing_relationship text,
  ADD COLUMN IF NOT EXISTS billing_selection_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_carrier_account_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_authorization_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_authorization_scope_valid,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_scope_unique,
  ADD CONSTRAINT operations_carrier_rate_requests_carrier_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_rate_requests_authorization_fkey
    FOREIGN KEY (
      network_id, account_authorization_id, organization_id,
      integration_account_id, carrier_account_id
    )
    REFERENCES operations_carrier_account_authorizations(
      network_id, id, account_owner_organization_id,
      integration_account_id, carrier_account_id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_rate_requests_authorization_scope_valid CHECK (
    network_id IS NOT NULL
    AND account_authorization_id IS NOT NULL
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_explicit_account,
  ADD CONSTRAINT operations_carrier_rate_requests_explicit_account
    CHECK (carrier_account_id IS NOT NULL) NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_billing_relationship_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_billing_relationship_valid CHECK (
    billing_relationship IS NULL
    OR billing_relationship IN ('sender', 'recipient', 'third_party')
  ),
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_billing_selection_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_billing_selection_valid CHECK (
    jsonb_typeof(billing_selection_snapshot) = 'object'
  ),
  ADD CONSTRAINT operations_carrier_rate_requests_scope_unique
    UNIQUE (
      network_id, account_authorization_id, organization_id,
      integration_account_id, carrier_account_id, id
    );

ALTER TABLE operations_carrier_quote_snapshots
  DROP CONSTRAINT IF EXISTS operations_carrier_quote_snapshots_rate_request_fkey,
  ADD CONSTRAINT operations_carrier_quote_snapshots_rate_request_fkey
    FOREIGN KEY (
      network_id, account_authorization_id, account_owner_organization_id,
      integration_account_id, carrier_account_id, carrier_rate_request_id
    )
    REFERENCES operations_carrier_rate_requests(
      network_id, account_authorization_id, organization_id,
      integration_account_id, carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID;

-- Imported routing-rule writes become directly idempotent at the database
-- boundary. Nullable physical columns preserve legacy rows; NOT VALID checks
-- and the insert trigger reject incomplete new versions.
ALTER TABLE operations_carrier_billing_routing_rules
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_checksum text;

ALTER TABLE operations_carrier_billing_routing_rules
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_routing_rules_idempotency_present,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_routing_rules_request_checksum_valid,
  ADD CONSTRAINT operations_carrier_billing_routing_rules_idempotency_present
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL) NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_routing_rules_request_checksum_valid
    CHECK (request_checksum ~ '^[a-f0-9]{64}$') NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_carrier_billing_routing_rules_idempotency
  ON operations_carrier_billing_routing_rules (network_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_routing_rule_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NULLIF(btrim(NEW.idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'Carrier billing routing rule requires an idempotency key';
  END IF;
  IF NEW.request_checksum IS NULL
     OR NEW.request_checksum !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION
      'Carrier billing routing rule requires a SHA-256 request checksum';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_carrier_billing_routing_rule_request_write
  ON operations_carrier_billing_routing_rules;
CREATE TRIGGER validate_operations_carrier_billing_routing_rule_request_write
BEFORE INSERT ON operations_carrier_billing_routing_rules
FOR EACH ROW EXECUTE FUNCTION validate_operations_carrier_billing_routing_rule_request();

-- Settlement and reconciliation rows repeat the selected account identity so
-- their quote and supersession links cannot cross a rate network, executing
-- organization, authorization, or carrier account.
ALTER TABLE operations_settlement_entries
  ADD COLUMN IF NOT EXISTS account_authorization_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid;

ALTER TABLE operations_settlement_entries
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_quote_snapshot_id_fkey,
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_quote_snapshot_fkey,
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_reverses_fkey,
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_account_scope_valid,
  DROP CONSTRAINT IF EXISTS operations_settlement_entries_scope_unique,
  ADD CONSTRAINT operations_settlement_entries_account_scope_valid
    CHECK (
      account_authorization_id IS NOT NULL
      AND carrier_account_id IS NOT NULL
    ) NOT VALID,
  ADD CONSTRAINT operations_settlement_entries_quote_snapshot_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, quote_snapshot_id
    )
    REFERENCES operations_carrier_quote_snapshots(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_settlement_entries_scope_unique
    UNIQUE (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ),
  ADD CONSTRAINT operations_settlement_entries_reverses_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, reverses_entry_id
    )
    REFERENCES operations_settlement_entries(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID;

ALTER TABLE operations_carrier_billing_reconciliations
  ADD COLUMN IF NOT EXISTS account_authorization_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid;

ALTER TABLE operations_carrier_billing_reconciliations
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_quote_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_supersedes_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_version_unique,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_account_scope_valid,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_scope_unique,
  ADD CONSTRAINT operations_carrier_billing_reconciliations_account_scope_valid
    CHECK (
      account_authorization_id IS NOT NULL
      AND carrier_account_id IS NOT NULL
    ) NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_reconciliations_quote_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, quote_snapshot_id
    )
    REFERENCES operations_carrier_quote_snapshots(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, id
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT operations_carrier_billing_reconciliations_scope_unique
    UNIQUE (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, shipment_id, id
    ),
  ADD CONSTRAINT operations_carrier_billing_reconciliations_supersedes_fkey
    FOREIGN KEY (
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, shipment_id, supersedes_reconciliation_id
    )
    REFERENCES operations_carrier_billing_reconciliations(
      network_id, executing_organization_id, account_authorization_id,
      carrier_account_id, shipment_id, id
    ) ON DELETE RESTRICT NOT VALID;

DROP INDEX IF EXISTS operations_carrier_billing_reconciliations_version_unique;
CREATE UNIQUE INDEX idx_operations_carrier_billing_reconciliations_account_version
  ON operations_carrier_billing_reconciliations (
    network_id, executing_organization_id, account_authorization_id,
    carrier_account_id, shipment_id, version_number
  )
  WHERE account_authorization_id IS NOT NULL
    AND carrier_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations_gl_coding_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('ggl'),
  network_id uuid NOT NULL
    REFERENCES operations_carrier_rate_networks(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'running', 'needs_review', 'completed', 'failed', 'cancelled'
    )),
  selection_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  rule_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  input_checksum text NOT NULL CHECK (input_checksum ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  selected_batch_count integer NOT NULL DEFAULT 0 CHECK (selected_batch_count >= 0),
  selected_charge_count integer NOT NULL DEFAULT 0 CHECK (selected_charge_count >= 0),
  shipment_matched_count integer NOT NULL DEFAULT 0 CHECK (shipment_matched_count >= 0),
  shipper_assigned_count integer NOT NULL DEFAULT 0 CHECK (shipper_assigned_count >= 0),
  orphan_count integer NOT NULL DEFAULT 0 CHECK (orphan_count >= 0),
  excluded_count integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text,
  requested_by text REFERENCES app_users(email) ON DELETE SET NULL,
  service_actor text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_gl_coding_runs_global_valid
    CHECK (global_id ~ '^ggl[0-9]{7}$'),
  CONSTRAINT operations_gl_coding_runs_global_unique UNIQUE (global_id),
  CONSTRAINT operations_gl_coding_runs_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_runs_actor_valid CHECK (
    requested_by IS NOT NULL OR NULLIF(btrim(service_actor), '') IS NOT NULL
  ),
  CONSTRAINT operations_gl_coding_runs_selection_valid
    CHECK (jsonb_typeof(selection_snapshot) = 'object'),
  CONSTRAINT operations_gl_coding_runs_rules_valid
    CHECK (jsonb_typeof(rule_snapshot) = 'array'),
  CONSTRAINT operations_gl_coding_runs_summary_valid
    CHECK (jsonb_typeof(summary) = 'object'),
  CONSTRAINT operations_gl_coding_runs_dates_valid CHECK (
    (started_at IS NULL OR started_at >= requested_at)
    AND (completed_at IS NULL OR completed_at >= COALESCE(started_at, requested_at))
  ),
  CONSTRAINT operations_gl_coding_runs_idempotency_unique
    UNIQUE (network_id, idempotency_key),
  CONSTRAINT operations_gl_coding_runs_network_id_unique UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_gl_coding_runs_status
  ON operations_gl_coding_runs (network_id, status, requested_at DESC, id);

ALTER TABLE operations_gl_coding_runs
  DROP CONSTRAINT IF EXISTS operations_gl_coding_runs_lifecycle_valid,
  ADD CONSTRAINT operations_gl_coding_runs_lifecycle_valid CHECK (
    (
      status = 'queued'
      AND started_at IS NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'running'
      AND started_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR (
      status = 'needs_review'
      AND started_at IS NOT NULL
    )
    OR (
      status IN ('completed', 'failed', 'cancelled')
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION protect_operations_gl_coding_run_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GL Coding runs are durable lifecycle records and cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'queued'
       OR NEW.started_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'GL Coding runs must be inserted in queued status';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('needs_review', 'completed', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'Terminal GL Coding runs are immutable';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.network_id,
    NEW.selection_snapshot,
    NEW.rule_snapshot,
    NEW.input_checksum,
    NEW.idempotency_key,
    NEW.selected_batch_count,
    NEW.selected_charge_count,
    NEW.requested_by,
    NEW.service_actor,
    NEW.requested_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.network_id,
    OLD.selection_snapshot,
    OLD.rule_snapshot,
    OLD.input_checksum,
    OLD.idempotency_key,
    OLD.selected_batch_count,
    OLD.selected_charge_count,
    OLD.requested_by,
    OLD.service_actor,
    OLD.requested_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'GL Coding run inputs and request identity are immutable';
  END IF;

  IF OLD.status = 'queued' THEN
    IF NEW.status IS DISTINCT FROM 'running'
       OR NEW.started_at IS NULL
       OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Queued GL Coding runs may only transition to running';
    END IF;
  ELSIF OLD.status = 'running' THEN
    IF NEW.status NOT IN ('needs_review', 'completed', 'failed', 'cancelled') THEN
      RAISE EXCEPTION
        'Running GL Coding runs may only become needs_review, completed, failed, or cancelled';
    END IF;
    IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'GL Coding run start time is immutable after execution begins';
    END IF;
    IF NEW.status IN ('completed', 'failed', 'cancelled')
       AND NEW.completed_at IS NULL THEN
      RAISE EXCEPTION
        'Completed, failed, and cancelled GL Coding runs require completed_at';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported GL Coding run lifecycle state';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_gl_coding_run_lifecycle_write
  ON operations_gl_coding_runs;
CREATE TRIGGER protect_operations_gl_coding_run_lifecycle_write
BEFORE INSERT OR UPDATE OR DELETE ON operations_gl_coding_runs
FOR EACH ROW EXECUTE FUNCTION protect_operations_gl_coding_run_lifecycle();

CREATE TABLE IF NOT EXISTS operations_gl_coding_run_batches (
  network_id uuid NOT NULL,
  run_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, batch_id),
  CONSTRAINT operations_gl_coding_run_batches_run_fkey
    FOREIGN KEY (network_id, run_id)
    REFERENCES operations_gl_coding_runs(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_batches_batch_fkey
    FOREIGN KEY (network_id, batch_id)
    REFERENCES operations_carrier_billing_batches(network_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS operations_gl_coding_run_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('ggi'),
  network_id uuid NOT NULL,
  run_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  billing_match_id uuid,
  shipper_assignment_id uuid,
  routing_rule_id uuid,
  routing_rule_version integer,
  result text NOT NULL
    CHECK (result IN ('assigned', 'orphan', 'excluded', 'error')),
  shipment_match_status text NOT NULL
    CHECK (shipment_match_status IN ('matched', 'unmatched', 'ambiguous', 'rejected')),
  shipper_assignment_status text NOT NULL
    CHECK (shipper_assignment_status IN ('assigned', 'unassigned', 'ambiguous', 'excluded')),
  coding_outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text,
  error_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_gl_coding_run_items_global_valid
    CHECK (global_id ~ '^ggi[0-9]{7}$'),
  CONSTRAINT operations_gl_coding_run_items_global_unique UNIQUE (global_id),
  CONSTRAINT operations_gl_coding_run_items_registry_fkey
    FOREIGN KEY (global_id) REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_run_fkey
    FOREIGN KEY (network_id, run_id)
    REFERENCES operations_gl_coding_runs(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_charge_fkey
    FOREIGN KEY (network_id, charge_id)
    REFERENCES operations_carrier_billing_charges(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_match_fkey
    FOREIGN KEY (network_id, billing_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_assignment_fkey
    FOREIGN KEY (network_id, shipper_assignment_id)
    REFERENCES operations_carrier_billing_shipper_assignments(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_rule_fkey
    FOREIGN KEY (network_id, routing_rule_id)
    REFERENCES operations_carrier_billing_routing_rules(network_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_gl_coding_run_items_outputs_valid
    CHECK (jsonb_typeof(coding_outputs) = 'object'),
  CONSTRAINT operations_gl_coding_run_items_evidence_valid
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT operations_gl_coding_run_items_rule_version_valid CHECK (
    (routing_rule_id IS NULL AND routing_rule_version IS NULL)
    OR (routing_rule_id IS NOT NULL AND routing_rule_version IS NOT NULL)
  ),
  CONSTRAINT operations_gl_coding_run_items_result_valid CHECK (
    (result = 'assigned' AND shipper_assignment_status = 'assigned')
    OR (result = 'orphan' AND shipper_assignment_status IN ('unassigned', 'ambiguous'))
    OR (result = 'excluded' AND shipper_assignment_status = 'excluded')
    OR result = 'error'
  ),
  CONSTRAINT operations_gl_coding_run_items_run_charge_unique UNIQUE (run_id, charge_id),
  CONSTRAINT operations_gl_coding_run_items_network_id_unique UNIQUE (network_id, id)
);

CREATE INDEX IF NOT EXISTS idx_operations_gl_coding_run_items_result
  ON operations_gl_coding_run_items (network_id, run_id, result, created_at, id);

ALTER TABLE operations_carrier_billing_shipper_assignments
  ADD COLUMN IF NOT EXISTS gl_coding_run_id uuid,
  ADD COLUMN IF NOT EXISTS coding_outputs jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE operations_carrier_billing_shipper_assignments
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_shipper_assignments_gl_run_fkey,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_gl_run_fkey
    FOREIGN KEY (network_id, gl_coding_run_id)
    REFERENCES operations_gl_coding_runs(network_id, id) ON DELETE RESTRICT NOT VALID,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_shipper_assignments_coding_outputs_valid,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_coding_outputs_valid CHECK (
    jsonb_typeof(coding_outputs) = 'object'
  ),
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_shipper_assignments_rule_run_valid,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_rule_run_valid CHECK (
    assignment_source <> 'routing_rule' OR gl_coding_run_id IS NOT NULL
  );

ALTER TABLE operations_carrier_billing_reconciliations
  ADD COLUMN IF NOT EXISTS gl_coding_run_id uuid;

ALTER TABLE operations_carrier_billing_reconciliations
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_reconciliations_gl_run_fkey,
  ADD CONSTRAINT operations_carrier_billing_reconciliations_gl_run_fkey
    FOREIGN KEY (network_id, gl_coding_run_id)
    REFERENCES operations_gl_coding_runs(network_id, id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE operations_carrier_billing_matches
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_matches_supersedes_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_matches_charge_id_unique,
  ADD CONSTRAINT operations_carrier_billing_matches_charge_id_unique
    UNIQUE (network_id, charge_id, id),
  ADD CONSTRAINT operations_carrier_billing_matches_supersedes_fkey
    FOREIGN KEY (network_id, charge_id, supersedes_match_id)
    REFERENCES operations_carrier_billing_matches(network_id, charge_id, id)
    ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_found boolean;
  shipment_in_rate_network boolean;
  shipment_package_id uuid;
  shipment_label_id uuid;
  prior_charge_id uuid;
BEGIN
  IF NEW.supersedes_match_id IS NOT NULL THEN
    SELECT prior.charge_id
    INTO prior_charge_id
    FROM operations_carrier_billing_matches prior
    WHERE prior.network_id = NEW.network_id
      AND prior.charge_id = NEW.charge_id
      AND prior.id = NEW.supersedes_match_id;

    IF prior_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION
        'Carrier billing match may only supersede a decision for the same network charge';
    END IF;
  END IF;

  IF NEW.decision <> 'matched' THEN
    RETURN NEW;
  END IF;

  SELECT
    true,
    shipment.package_id,
    shipment.label_id,
    EXISTS (
      SELECT 1
      FROM operations_carrier_rate_parties party
      WHERE party.network_id = NEW.network_id
        AND party.role = 'shipper'
        AND (
          (
            party.entity_type = 'workspace_organization'
            AND party.workspace_organization_id = shipment.organization_id
          )
          OR (
            party.entity_type = 'crm_customer'
            AND party.crm_pipeline_id = shipment_order.pipeline_id
            AND party.crm_customer_id = shipment_order.customer_id
          )
        )
    )
  INTO
    shipment_found,
    shipment_package_id,
    shipment_label_id,
    shipment_in_rate_network
  FROM operations_shipments shipment
  JOIN operations_orders shipment_order
    ON shipment_order.organization_id = shipment.organization_id
   AND shipment_order.id = shipment.order_id
  WHERE shipment.organization_id = NEW.executing_organization_id
    AND shipment.id = NEW.shipment_id;

  IF shipment_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Matched carrier charge requires an existing shipment';
  END IF;
  IF shipment_in_rate_network IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'Matched carrier charge shipment must belong to a shipper party in the same rate network';
  END IF;
  IF NEW.package_id IS NOT NULL
     AND NEW.package_id IS DISTINCT FROM shipment_package_id THEN
    RAISE EXCEPTION 'Carrier billing package does not belong to the matched shipment';
  END IF;
  IF NEW.label_id IS NOT NULL
     AND NEW.label_id IS DISTINCT FROM shipment_label_id THEN
    RAISE EXCEPTION 'Carrier billing label does not belong to the matched shipment';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE operations_carrier_billing_shipper_assignments
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_shipper_assignments_supersedes_fkey,
  DROP CONSTRAINT IF EXISTS operations_carrier_billing_shipper_assignments_charge_id_unique,
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_charge_id_unique
    UNIQUE (network_id, charge_id, id),
  ADD CONSTRAINT operations_carrier_billing_shipper_assignments_supersedes_fkey
    FOREIGN KEY (network_id, charge_id, supersedes_assignment_id)
    REFERENCES operations_carrier_billing_shipper_assignments(
      network_id, charge_id, id
    ) ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_shipper_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  match_charge_id uuid;
  match_decision text;
  target_role text;
  rule_target_shipper uuid;
  prior_charge_id uuid;
  current_assignment_id uuid;
  current_assignment_decision text;
BEGIN
  -- Lock the append-only charge identity so concurrent assignment decisions
  -- cannot both observe the same current row.
  PERFORM 1
  FROM operations_carrier_billing_charges charge
  WHERE charge.network_id = NEW.network_id
    AND charge.id = NEW.charge_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Carrier billing assignment requires an existing network charge';
  END IF;

  IF NEW.supersedes_assignment_id IS NOT NULL THEN
    SELECT prior.charge_id
    INTO prior_charge_id
    FROM operations_carrier_billing_shipper_assignments prior
    WHERE prior.network_id = NEW.network_id
      AND prior.charge_id = NEW.charge_id
      AND prior.id = NEW.supersedes_assignment_id;

    IF prior_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION
        'Carrier billing shipper assignment may only supersede a decision for the same network charge';
    END IF;
  END IF;

  IF NEW.assignment_source = 'manual' THEN
    SELECT current.id, current.decision
    INTO current_assignment_id, current_assignment_decision
    FROM operations_carrier_billing_shipper_assignments current
    WHERE current.network_id = NEW.network_id
      AND current.charge_id = NEW.charge_id
    ORDER BY current.decided_at DESC, current.id DESC
    LIMIT 1;

    IF current_assignment_id IS NOT NULL
       AND current_assignment_decision NOT IN ('unassigned', 'ambiguous') THEN
      RAISE EXCEPTION
        'Manual shipper assignment may only replace the current unresolved decision';
    END IF;
    IF current_assignment_id IS NOT NULL
       AND NEW.supersedes_assignment_id IS DISTINCT FROM current_assignment_id THEN
      RAISE EXCEPTION
        'Manual shipper assignment must supersede the current unresolved decision';
    END IF;
  END IF;

  IF NEW.shipper_party_id IS NOT NULL THEN
    SELECT party.role
    INTO target_role
    FROM operations_carrier_rate_parties party
    WHERE party.network_id = NEW.network_id
      AND party.id = NEW.shipper_party_id;

    IF target_role IS DISTINCT FROM 'shipper' THEN
      RAISE EXCEPTION 'Carrier billing assignment target must be a shipper party';
    END IF;
  END IF;

  IF NEW.billing_match_id IS NOT NULL THEN
    SELECT match_decision_row.charge_id, match_decision_row.decision
    INTO match_charge_id, match_decision
    FROM operations_carrier_billing_matches match_decision_row
    WHERE match_decision_row.network_id = NEW.network_id
      AND match_decision_row.id = NEW.billing_match_id;

    IF match_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'Carrier billing assignment match belongs to a different charge';
    END IF;
  END IF;

  IF NEW.assignment_source = 'shipment_match'
     AND match_decision IS DISTINCT FROM 'matched' THEN
    RAISE EXCEPTION
      'Shipment-derived shipper assignment requires a matched shipment decision';
  END IF;

  IF NEW.assignment_source = 'routing_rule' THEN
    SELECT rule.target_shipper_party_id
    INTO rule_target_shipper
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id
      AND rule.version_number = NEW.routing_rule_version;

    IF rule_target_shipper IS NULL THEN
      RAISE EXCEPTION 'Carrier billing routing rule version was not found';
    END IF;
    IF NEW.decision = 'assigned'
       AND NEW.shipper_party_id IS DISTINCT FROM rule_target_shipper THEN
      RAISE EXCEPTION
        'Carrier billing assignment does not match the routing rule target';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_carrier_billing_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_network_id uuid;
  prior_executing_organization_id uuid;
  prior_account_authorization_id uuid;
  prior_carrier_account_id uuid;
  prior_shipment_id uuid;
  prior_version_number integer;
BEGIN
  IF NEW.version_number > 1 AND NEW.supersedes_reconciliation_id IS NULL THEN
    RAISE EXCEPTION
      'Versioned carrier billing reconciliation must identify the superseded version';
  END IF;
  IF NEW.version_number = 1 AND NEW.supersedes_reconciliation_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Initial carrier billing reconciliation cannot supersede another version';
  END IF;

  IF NEW.supersedes_reconciliation_id IS NOT NULL THEN
    SELECT
      prior.network_id,
      prior.executing_organization_id,
      prior.account_authorization_id,
      prior.carrier_account_id,
      prior.shipment_id,
      prior.version_number
    INTO
      prior_network_id,
      prior_executing_organization_id,
      prior_account_authorization_id,
      prior_carrier_account_id,
      prior_shipment_id,
      prior_version_number
    FROM operations_carrier_billing_reconciliations prior
    WHERE prior.id = NEW.supersedes_reconciliation_id;

    IF prior_network_id IS DISTINCT FROM NEW.network_id
       OR prior_executing_organization_id
         IS DISTINCT FROM NEW.executing_organization_id
       OR prior_account_authorization_id
         IS DISTINCT FROM NEW.account_authorization_id
       OR prior_carrier_account_id IS DISTINCT FROM NEW.carrier_account_id
       OR prior_shipment_id IS DISTINCT FROM NEW.shipment_id THEN
      RAISE EXCEPTION
        'Carrier billing reconciliation may only supersede the same network, organization, account, and shipment';
    END IF;
    IF NEW.version_number IS DISTINCT FROM prior_version_number + 1 THEN
      RAISE EXCEPTION 'Carrier billing reconciliation versions must be sequential';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_run_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_provider text;
  candidate_environment text;
  declared_provider text;
  declared_environment text;
  run_status text;
BEGIN
  SELECT batch.provider, batch.environment
  INTO candidate_provider, candidate_environment
  FROM operations_carrier_billing_batches batch
  WHERE batch.network_id = NEW.network_id
    AND batch.id = NEW.batch_id;

  IF candidate_provider IS NULL OR candidate_environment IS NULL THEN
    RAISE EXCEPTION 'GL Coding run batch was not found in the selected rate network';
  END IF;

  SELECT
    run.status,
    run.selection_snapshot->>'provider',
    run.selection_snapshot->>'environment'
  INTO run_status, declared_provider, declared_environment
  FROM operations_gl_coding_runs run
  WHERE run.network_id = NEW.network_id
    AND run.id = NEW.run_id;

  IF run_status IS DISTINCT FROM 'queued' THEN
    RAISE EXCEPTION 'GL Coding batches may only be appended while the run is queued';
  END IF;
  IF declared_provider IS NOT NULL
     AND lower(btrim(declared_provider))
       IS DISTINCT FROM lower(btrim(candidate_provider)) THEN
    RAISE EXCEPTION
      'GL Coding batch provider does not match the run selection snapshot';
  END IF;
  IF declared_environment IS NOT NULL
     AND declared_environment IS DISTINCT FROM candidate_environment THEN
    RAISE EXCEPTION
      'GL Coding batch environment does not match the run selection snapshot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_gl_coding_run_batches selected
    JOIN operations_carrier_billing_batches batch
      ON batch.network_id = selected.network_id
     AND batch.id = selected.batch_id
    WHERE selected.run_id = NEW.run_id
      AND (
        lower(btrim(batch.provider))
          IS DISTINCT FROM lower(btrim(candidate_provider))
        OR batch.environment IS DISTINCT FROM candidate_environment
      )
  ) THEN
    RAISE EXCEPTION
      'A GL Coding run may only combine billing files from one carrier provider and environment';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_run_batch_write
  ON operations_gl_coding_run_batches;
CREATE TRIGGER validate_operations_gl_coding_run_batch_write
BEFORE INSERT ON operations_gl_coding_run_batches
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_run_batch();

DROP TRIGGER IF EXISTS protect_operations_gl_coding_run_batches_mutation
  ON operations_gl_coding_run_batches;
CREATE TRIGGER protect_operations_gl_coding_run_batches_mutation
BEFORE UPDATE OR DELETE ON operations_gl_coding_run_batches
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  charge_in_selected_batch boolean;
  rule_outputs jsonb;
  run_status text;
BEGIN
  IF NEW.gl_coding_run_id IS NOT NULL THEN
    SELECT run.status
    INTO run_status
    FROM operations_gl_coding_runs run
    WHERE run.network_id = NEW.network_id
      AND run.id = NEW.gl_coding_run_id;

    IF run_status IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION 'GL Coding assignments require a running GL Coding run';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM operations_carrier_billing_charges charge
      JOIN operations_carrier_billing_statements statement
        ON statement.network_id = charge.network_id
       AND statement.id = charge.statement_id
      JOIN operations_gl_coding_run_batches selected
        ON selected.network_id = statement.network_id
       AND selected.batch_id = statement.batch_id
       AND selected.run_id = NEW.gl_coding_run_id
      WHERE charge.network_id = NEW.network_id
        AND charge.id = NEW.charge_id
    )
    INTO charge_in_selected_batch;

    IF charge_in_selected_batch IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'GL Coding assignment charge is not part of a selected billing file';
    END IF;
  END IF;

  IF NEW.assignment_source = 'routing_rule' THEN
    SELECT rule.outputs
    INTO rule_outputs
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id
      AND rule.version_number = NEW.routing_rule_version;

    IF rule_outputs IS NULL OR NEW.coding_outputs IS DISTINCT FROM rule_outputs THEN
      RAISE EXCEPTION 'GL Coding assignment must preserve the selected routing rule output snapshot';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_assignment_write
  ON operations_carrier_billing_shipper_assignments;
CREATE TRIGGER validate_operations_gl_coding_assignment_write
BEFORE INSERT ON operations_carrier_billing_shipper_assignments
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_assignment();

CREATE OR REPLACE FUNCTION validate_operations_gl_coding_run_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  charge_in_selected_batch boolean;
  matched_charge_id uuid;
  assigned_charge_id uuid;
  rule_version integer;
  run_status text;
BEGIN
  SELECT run.status
  INTO run_status
  FROM operations_gl_coding_runs run
  WHERE run.network_id = NEW.network_id
    AND run.id = NEW.run_id;

  IF run_status IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'GL Coding run items require a running GL Coding run';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM operations_carrier_billing_charges charge
    JOIN operations_carrier_billing_statements statement
      ON statement.network_id = charge.network_id
     AND statement.id = charge.statement_id
    JOIN operations_gl_coding_run_batches selected
      ON selected.network_id = statement.network_id
     AND selected.batch_id = statement.batch_id
     AND selected.run_id = NEW.run_id
    WHERE charge.network_id = NEW.network_id
      AND charge.id = NEW.charge_id
  )
  INTO charge_in_selected_batch;

  IF charge_in_selected_batch IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'GL Coding run item charge is not part of a selected billing file';
  END IF;

  IF NEW.billing_match_id IS NOT NULL THEN
    SELECT match_decision.charge_id
    INTO matched_charge_id
    FROM operations_carrier_billing_matches match_decision
    WHERE match_decision.network_id = NEW.network_id
      AND match_decision.id = NEW.billing_match_id;

    IF matched_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'GL Coding run item shipment match belongs to another charge';
    END IF;
  END IF;

  IF NEW.shipper_assignment_id IS NOT NULL THEN
    SELECT assignment.charge_id
    INTO assigned_charge_id
    FROM operations_carrier_billing_shipper_assignments assignment
    WHERE assignment.network_id = NEW.network_id
      AND assignment.id = NEW.shipper_assignment_id;

    IF assigned_charge_id IS DISTINCT FROM NEW.charge_id THEN
      RAISE EXCEPTION 'GL Coding run item shipper assignment belongs to another charge';
    END IF;
  END IF;

  IF NEW.routing_rule_id IS NOT NULL THEN
    SELECT rule.version_number
    INTO rule_version
    FROM operations_carrier_billing_routing_rules rule
    WHERE rule.network_id = NEW.network_id
      AND rule.id = NEW.routing_rule_id;

    IF rule_version IS DISTINCT FROM NEW.routing_rule_version THEN
      RAISE EXCEPTION 'GL Coding run item routing rule version does not match';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_gl_coding_run_item_write
  ON operations_gl_coding_run_items;
CREATE TRIGGER validate_operations_gl_coding_run_item_write
BEFORE INSERT ON operations_gl_coding_run_items
FOR EACH ROW EXECUTE FUNCTION validate_operations_gl_coding_run_item();

DROP TRIGGER IF EXISTS protect_operations_gl_coding_run_items_mutation
  ON operations_gl_coding_run_items;
CREATE TRIGGER protect_operations_gl_coding_run_items_mutation
BEFORE UPDATE OR DELETE ON operations_gl_coding_run_items
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_gl_coding_runs IS
  'Auditable execution of selected carrier billing files through versioned shipper and GL coding rules.';
COMMENT ON COLUMN operations_gl_coding_run_items.shipment_match_status IS
  'Independent shipment match result. A shipper assignment never changes this status.';
COMMENT ON COLUMN operations_gl_coding_run_items.shipper_assignment_status IS
  'Shipper coding result from shipment evidence, a versioned routing rule, or a manual decision.';
