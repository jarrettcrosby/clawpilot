-- Durable control plane and provider evidence for commerce sales channels.
--
-- Shopify and Faire are commerce-channel integrations owned by Distributed
-- Operations. They are not POS accounts. This migration stores only encrypted
-- provider credentials and encrypted webhook bodies; searchable metadata and
-- provider evidence remain non-secret and organization scoped.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name) VALUES
  ('gcw', 'operations.commerce_webhook_receipt', 'Commerce webhook receipt'),
  ('gxa', 'operations.commerce_provider_attempt', 'Commerce provider attempt')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

-- Nullable keeps every existing carrier, printing, and mock-commerce writer
-- compatible with the foundation singleton constraint. Shopify/Faire writers
-- set this once; the trigger prevents a durable integration identity from
-- being rebound after receipts or attempts reference its Global ID.
ALTER TABLE operations_integration_accounts
  ADD COLUMN IF NOT EXISTS external_account_id text,
  ADD COLUMN IF NOT EXISTS commerce_credential_generation integer
    NOT NULL DEFAULT 0;

ALTER TABLE operations_integration_accounts
  DROP CONSTRAINT IF EXISTS operations_integration_accounts_external_account_valid,
  ADD CONSTRAINT operations_integration_accounts_external_account_valid CHECK (
    external_account_id IS NULL
    OR length(btrim(external_account_id)) BETWEEN 1 AND 255
  ),
  DROP CONSTRAINT IF EXISTS operations_integration_accounts_commerce_generation_valid,
  ADD CONSTRAINT operations_integration_accounts_commerce_generation_valid CHECK (
    commerce_credential_generation >= 0
  );

CREATE OR REPLACE FUNCTION protect_operations_integration_external_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.external_account_id IS NOT NULL
     AND NEW.external_account_id IS DISTINCT FROM OLD.external_account_id THEN
    RAISE EXCEPTION 'Integration provider identity is immutable once assigned';
  END IF;
  IF NEW.commerce_credential_generation
     < OLD.commerce_credential_generation THEN
    RAISE EXCEPTION 'Commerce credential generation cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_integration_external_account
  ON operations_integration_accounts;
CREATE TRIGGER protect_operations_integration_external_account
BEFORE UPDATE OF external_account_id, commerce_credential_generation
ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_integration_external_account();

CREATE TABLE IF NOT EXISTS operations_commerce_credentials (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  external_account_id text NOT NULL
    CHECK (length(btrim(external_account_id)) BETWEEN 1 AND 255),
  auth_mode text NOT NULL
    CHECK (auth_mode IN (
      'shopify_client_credentials', 'faire_brand_token'
    )),
  credential_ciphertext bytea NOT NULL,
  credential_iv bytea NOT NULL,
  credential_tag bytea NOT NULL,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  credential_identifier_last_four text NOT NULL
    CHECK (credential_identifier_last_four ~ '^[[:print:]]{1,4}$'),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  verified_at timestamptz,
  last_error_code text,
  webhook_verification_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (webhook_verification_status IN (
      'not_applicable', 'unverified', 'verified'
    )),
  webhook_verified_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  updated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id),
  CONSTRAINT operations_commerce_credentials_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_credentials_verified_state CHECK (
    (
      verification_status = 'verified'
      AND verified_at IS NOT NULL
      AND last_error_code IS NULL
    )
    OR verification_status <> 'verified'
  ),
  CONSTRAINT operations_commerce_credentials_webhook_state CHECK (
    (
      auth_mode = 'shopify_client_credentials'
      AND (
        (
          webhook_verification_status = 'verified'
          AND webhook_verified_at IS NOT NULL
        )
        OR (
          webhook_verification_status = 'unverified'
          AND webhook_verified_at IS NULL
        )
      )
    )
    OR (
      auth_mode = 'faire_brand_token'
      AND webhook_verification_status = 'not_applicable'
      AND webhook_verified_at IS NULL
    )
  ),
  CONSTRAINT operations_commerce_credentials_ciphertext_valid
    CHECK (octet_length(credential_ciphertext) > 0),
  CONSTRAINT operations_commerce_credentials_iv_valid
    CHECK (octet_length(credential_iv) = 12),
  CONSTRAINT operations_commerce_credentials_tag_valid
    CHECK (octet_length(credential_tag) = 16)
);

CREATE INDEX IF NOT EXISTS operations_commerce_credentials_verification_idx
  ON operations_commerce_credentials (
    organization_id, verification_status, updated_at DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_credential_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  secret_changed boolean;
BEGIN
  IF ROW(
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.external_account_id,
    NEW.auth_mode,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.external_account_id,
    OLD.auth_mode,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Commerce credential identity is immutable';
  END IF;

  secret_changed := ROW(
    NEW.credential_ciphertext,
    NEW.credential_iv,
    NEW.credential_tag,
    NEW.credential_identifier_last_four
  ) IS DISTINCT FROM ROW(
    OLD.credential_ciphertext,
    OLD.credential_iv,
    OLD.credential_tag,
    OLD.credential_identifier_last_four
  );

  IF NEW.credential_version = OLD.credential_version AND secret_changed THEN
    RAISE EXCEPTION 'Commerce credential secret changes require a new generation';
  END IF;
  IF NEW.credential_version <> OLD.credential_version
     AND (
       NEW.credential_version <> OLD.credential_version + 1
       OR NOT secret_changed
     ) THEN
    RAISE EXCEPTION 'Commerce credential generations must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_credential_generation
  ON operations_commerce_credentials;
CREATE TRIGGER protect_operations_commerce_credential_generation
BEFORE UPDATE ON operations_commerce_credentials
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_credential_generation();

CREATE TABLE IF NOT EXISTS operations_commerce_sync_cursors (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  resource text NOT NULL
    CHECK (resource IN (
      'orders', 'products', 'inventory', 'fulfillments', 'returns', 'shipments'
    )),
  provider_cursor text,
  high_watermark timestamptz,
  reconciliation_status text NOT NULL DEFAULT 'idle'
    CHECK (reconciliation_status IN ('idle', 'running', 'succeeded', 'failed')),
  records_seen bigint NOT NULL DEFAULT 0 CHECK (records_seen >= 0),
  records_applied bigint NOT NULL DEFAULT 0 CHECK (records_applied >= 0),
  records_held bigint NOT NULL DEFAULT 0 CHECK (records_held >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code text,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id, resource),
  CONSTRAINT operations_commerce_sync_cursors_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_sync_cursors_completion_valid CHECK (
    reconciliation_status <> 'running'
    OR last_started_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_sync_cursors_health_idx
  ON operations_commerce_sync_cursors (
    organization_id, reconciliation_status, updated_at DESC
  );

CREATE TABLE IF NOT EXISTS operations_commerce_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gcw'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = 'shopify'),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  provider_event_id text NOT NULL,
  topic text NOT NULL,
  source_domain text NOT NULL,
  provider_api_version text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload_ciphertext bytea NOT NULL,
  payload_iv bytea NOT NULL,
  payload_tag bytea NOT NULL,
  payload_encryption_version integer NOT NULL DEFAULT 1
    CHECK (payload_encryption_version > 0),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 2 AND 524288),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN (
      'held', 'queued', 'processing', 'succeeded', 'failed', 'dead_letter'
    )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  provider_triggered_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_webhook_receipts_global_valid
    CHECK (global_id ~ '^gcw[0-9]{7}$'),
  CONSTRAINT operations_commerce_webhook_receipts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_commerce_webhook_receipts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_webhook_receipts_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_webhook_receipts_delivery_unique
    UNIQUE (organization_id, integration_account_id, provider_event_id),
  CONSTRAINT operations_commerce_webhook_receipts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_webhook_receipts_lease_valid CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT operations_commerce_webhook_receipts_completion_valid CHECK (
    (state IN ('held', 'queued', 'processing') AND processed_at IS NULL)
    OR (state IN ('succeeded', 'failed', 'dead_letter') AND processed_at IS NOT NULL)
  ),
  CONSTRAINT operations_commerce_webhook_receipts_ciphertext_valid
    CHECK (octet_length(payload_ciphertext) > 0),
  CONSTRAINT operations_commerce_webhook_receipts_iv_valid
    CHECK (octet_length(payload_iv) = 12),
  CONSTRAINT operations_commerce_webhook_receipts_tag_valid
    CHECK (octet_length(payload_tag) = 16),
  CONSTRAINT operations_commerce_webhook_receipts_attempt_limit_valid
    CHECK (attempts <= max_attempts)
);

CREATE INDEX IF NOT EXISTS operations_commerce_webhook_receipts_queue_idx
  ON operations_commerce_webhook_receipts (
    state, available_at, received_at, id
  )
  WHERE state IN ('queued', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS operations_commerce_webhook_receipts_account_idx
  ON operations_commerce_webhook_receipts (
    organization_id, integration_account_id, received_at DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_webhook_receipt_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce webhook receipts are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.provider,
    NEW.credential_version,
    NEW.provider_event_id,
    NEW.topic,
    NEW.source_domain,
    NEW.provider_api_version,
    NEW.payload_hash,
    NEW.payload_ciphertext,
    NEW.payload_iv,
    NEW.payload_tag,
    NEW.payload_encryption_version,
    NEW.payload_bytes,
    NEW.provider_triggered_at,
    NEW.received_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.provider,
    OLD.credential_version,
    OLD.provider_event_id,
    OLD.topic,
    OLD.source_domain,
    OLD.provider_api_version,
    OLD.payload_hash,
    OLD.payload_ciphertext,
    OLD.payload_iv,
    OLD.payload_tag,
    OLD.payload_encryption_version,
    OLD.payload_bytes,
    OLD.provider_triggered_at,
    OLD.received_at
  ) THEN
    RAISE EXCEPTION 'Commerce webhook receipt identity and payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_webhook_receipt_identity
  ON operations_commerce_webhook_receipts;
CREATE TRIGGER protect_operations_commerce_webhook_receipt_identity
BEFORE UPDATE OR DELETE ON operations_commerce_webhook_receipts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_webhook_receipt_identity();

CREATE TABLE IF NOT EXISTS operations_commerce_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gxa'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  integration_account_id uuid NOT NULL,
  action text NOT NULL,
  adapter_version text NOT NULL,
  external_object_id text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL DEFAULT '{}'::jsonb,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN (
      'prepared', 'succeeded', 'failed', 'unknown', 'dead_letter'
    )),
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  provider_reference text,
  error_code text,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  CONSTRAINT operations_commerce_provider_attempts_global_valid
    CHECK (global_id ~ '^gxa[0-9]{7}$'),
  CONSTRAINT operations_commerce_provider_attempts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_commerce_provider_attempts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_attempts_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_provider_attempts_idempotency_unique
    UNIQUE (
      organization_id, integration_account_id, action, idempotency_key,
      attempt_number
    ),
  CONSTRAINT operations_commerce_provider_attempts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_provider_attempts_lease_valid CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT operations_commerce_provider_attempts_completion_valid CHECK (
    (state = 'prepared' AND completed_at IS NULL)
    OR (state <> 'prepared' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_provider_attempts_replay_idx
  ON operations_commerce_provider_attempts (
    state, next_attempt_at, requested_at, id
  )
  WHERE state IN ('failed', 'unknown', 'dead_letter');

CREATE INDEX IF NOT EXISTS operations_commerce_provider_attempts_account_idx
  ON operations_commerce_provider_attempts (
    organization_id, integration_account_id, requested_at DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_provider_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce provider attempts are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.integration_account_id,
    NEW.action,
    NEW.adapter_version,
    NEW.external_object_id,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.attempt_number,
    NEW.requested_at,
    NEW.created_by
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.integration_account_id,
    OLD.action,
    OLD.adapter_version,
    OLD.external_object_id,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.attempt_number,
    OLD.requested_at,
    OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Commerce provider attempt identity and request evidence are immutable';
  END IF;

  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION 'Terminal commerce provider attempts are immutable';
  END IF;
  IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Commerce provider attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_provider_attempt_write
  ON operations_commerce_provider_attempts;
CREATE TRIGGER protect_operations_commerce_provider_attempt_write
BEFORE UPDATE OR DELETE ON operations_commerce_provider_attempts
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_provider_attempt();

COMMENT ON TABLE operations_commerce_credentials IS
  'Write-only encrypted credentials and immutable provider identity for one Shopify or Faire account per provider/environment.';
COMMENT ON TABLE operations_commerce_sync_cursors IS
  'Durable high-water marks and reconciliation health for provider polling.';
COMMENT ON TABLE operations_commerce_webhook_receipts IS
  'Verified Shopify deliveries with immutable encrypted raw payload evidence.';
COMMENT ON TABLE operations_commerce_provider_attempts IS
  'Durable redacted provider-call evidence and retry/dead-letter boundary.';
