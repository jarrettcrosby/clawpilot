-- Durable carrier-label execution evidence.
--
-- Provider calls are prepared before network I/O and finalized exactly once.
-- A timeout remains unknown until reconciliation; it must never be retried as
-- a fresh purchase against the same package.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES ('gla', 'operations.label_attempt', 'Carrier label attempt')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_labels
  ADD COLUMN IF NOT EXISTS integration_account_id uuid,
  ADD COLUMN IF NOT EXISTS carrier_account_id uuid,
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'mock',
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS redacted_provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS create_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS void_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text REFERENCES app_users(email) ON DELETE SET NULL;

ALTER TABLE operations_labels
  DROP CONSTRAINT IF EXISTS operations_labels_environment_valid,
  ADD CONSTRAINT operations_labels_environment_valid
    CHECK (environment IN ('mock', 'sandbox', 'production')),
  DROP CONSTRAINT IF EXISTS operations_labels_request_hash_valid,
  ADD CONSTRAINT operations_labels_request_hash_valid
    CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS operations_labels_integration_account_fkey,
  ADD CONSTRAINT operations_labels_integration_account_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_carrier_account_fkey,
  ADD CONSTRAINT operations_labels_carrier_account_fkey
    FOREIGN KEY (organization_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_labels_one_active_per_package
ON operations_labels (organization_id, package_id)
WHERE status = 'created';

CREATE TABLE IF NOT EXISTS operations_label_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gla'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  package_id uuid NOT NULL,
  carrier_rate_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  label_id uuid,
  action text NOT NULL CHECK (action IN ('create', 'void', 'reconcile')),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'succeeded', 'failed', 'unknown')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  adapter_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_reference text,
  error_code text,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_label_attempts_global_valid
    CHECK (global_id ~ '^gla[0-9]{7}$'),
  CONSTRAINT operations_label_attempts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_label_attempts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_package_fkey
    FOREIGN KEY (organization_id, package_id)
    REFERENCES operations_packages(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_rate_fkey
    FOREIGN KEY (organization_id, carrier_rate_id)
    REFERENCES operations_carrier_rates(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_carrier_account_fkey
    FOREIGN KEY (organization_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_label_attempts_idempotency_unique
    UNIQUE (organization_id, action, idempotency_key),
  CONSTRAINT operations_label_attempts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_label_attempts_completion_valid CHECK (
    (state = 'prepared' AND completed_at IS NULL)
    OR (state <> 'prepared' AND completed_at IS NOT NULL)
  )
);

ALTER TABLE operations_labels
  DROP CONSTRAINT IF EXISTS operations_labels_create_attempt_fkey,
  ADD CONSTRAINT operations_labels_create_attempt_fkey
    FOREIGN KEY (organization_id, create_attempt_id)
    REFERENCES operations_label_attempts(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_void_attempt_fkey,
  ADD CONSTRAINT operations_labels_void_attempt_fkey
    FOREIGN KEY (organization_id, void_attempt_id)
    REFERENCES operations_label_attempts(organization_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS operations_label_attempts_order_idx
  ON operations_label_attempts (
    organization_id, order_id, requested_at DESC, id DESC
  );

CREATE INDEX IF NOT EXISTS operations_label_attempts_package_idx
  ON operations_label_attempts (
    organization_id, package_id, requested_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_label_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Carrier label attempts are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.order_id,
    NEW.package_id,
    NEW.carrier_rate_id,
    NEW.integration_account_id,
    NEW.carrier_account_id,
    NEW.action,
    NEW.environment,
    NEW.provider,
    NEW.adapter_version,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.actor_email,
    NEW.requested_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.order_id,
    OLD.package_id,
    OLD.carrier_rate_id,
    OLD.integration_account_id,
    OLD.carrier_account_id,
    OLD.action,
    OLD.environment,
    OLD.provider,
    OLD.adapter_version,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.actor_email,
    OLD.requested_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Carrier label attempt identity and request evidence are immutable';
  END IF;

  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION 'Terminal carrier label attempts are immutable';
  END IF;
  IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Carrier label attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_label_attempt_write
  ON operations_label_attempts;
CREATE TRIGGER protect_operations_label_attempt_write
BEFORE UPDATE OR DELETE ON operations_label_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_label_attempt();

COMMENT ON TABLE operations_label_attempts IS
  'Immutable prepare-call-finalize evidence for carrier label create, void, and reconciliation commands.';

COMMENT ON COLUMN operations_label_attempts.state IS
  'Unknown means a network result was ambiguous and requires reconciliation before another provider command.';
