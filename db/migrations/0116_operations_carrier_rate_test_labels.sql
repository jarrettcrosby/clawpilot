-- Durable sandbox labels created from one exact carrier-rate diagnostic.
--
-- The browser never supplies label bytes. A provider create/void call is
-- prepared before network I/O and finalized exactly once. Unknown outcomes
-- remain fenced until reconciliation. Printable bytes are retained on this
-- aggregate and are routed to the existing local print-agent queue without
-- requiring an operations order, package, shipment, or production label.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gsl', 'operations.carrier_rate_test_label', 'Carrier rate test label'),
  ('gsa', 'operations.carrier_rate_test_label_attempt', 'Carrier rate test label attempt')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_org_id_unique,
  ADD CONSTRAINT operations_carrier_rate_requests_org_id_unique
    UNIQUE (organization_id, id);

CREATE TABLE IF NOT EXISTS operations_carrier_rate_test_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsl'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  rate_request_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment = 'sandbox'),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  account_number_fingerprint text NOT NULL
    CHECK (account_number_fingerprint ~ '^[a-f0-9]{64}$'),
  rate_request_hash text NOT NULL CHECK (rate_request_hash ~ '^[a-f0-9]{64}$'),
  destination_fingerprint text NOT NULL
    CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  service_code text NOT NULL CHECK (
    length(service_code) BETWEEN 1 AND 80
    AND service_code !~ '[[:cntrl:]]'
  ),
  service_name text NOT NULL CHECK (
    length(service_name) BETWEEN 1 AND 160
    AND service_name !~ '[[:cntrl:]]'
  ),
  rate_type text CHECK (
    rate_type IS NULL
    OR (
      length(rate_type) BETWEEN 1 AND 80
      AND rate_type !~ '[[:cntrl:]]'
    )
  ),
  rated_amount text NOT NULL CHECK (
    rated_amount ~ '^[0-9]+([.][0-9]{1,6})?$'
  ),
  rated_currency text NOT NULL CHECK (rated_currency ~ '^[A-Z]{3}$'),
  provider_label_id text NOT NULL CHECK (
    length(provider_label_id) BETWEEN 1 AND 240
    AND provider_label_id !~ '[[:cntrl:]]'
  ),
  tracking_number text NOT NULL CHECK (
    length(tracking_number) BETWEEN 1 AND 240
    AND tracking_number !~ '[[:cntrl:]]'
  ),
  format text NOT NULL CHECK (format IN ('ZPL', 'PDF', 'PNG')),
  media_size text NOT NULL CHECK (media_size IN ('label_4x6', 'label_4x8')),
  label_payload bytea NOT NULL CHECK (
    octet_length(label_payload) BETWEEN 1 AND 10485760
  ),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  provider_reference text,
  redacted_provider_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(redacted_provider_evidence) = 'object'),
  create_attempt_id uuid NOT NULL,
  void_attempt_id uuid,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'voided')),
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  voided_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  CONSTRAINT operations_carrier_rate_test_labels_global_valid
    CHECK (global_id ~ '^gsl[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_test_labels_global_unique UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_test_labels_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_labels_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_carrier_rate_test_labels_rate_request_fkey
    FOREIGN KEY (organization_id, rate_request_id)
    REFERENCES operations_carrier_rate_requests(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_labels_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_labels_carrier_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_labels_lifecycle_valid CHECK (
    (
      status = 'created'
      AND void_attempt_id IS NULL
      AND voided_at IS NULL
      AND voided_by IS NULL
    )
    OR (
      status = 'voided'
      AND void_attempt_id IS NOT NULL
      AND voided_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_carrier_rate_test_labels_one_active_service
ON operations_carrier_rate_test_labels (
  organization_id,
  rate_request_id,
  service_code,
  COALESCE(rate_type, '')
)
WHERE status = 'created';

CREATE INDEX IF NOT EXISTS
  operations_carrier_rate_test_labels_recent_idx
ON operations_carrier_rate_test_labels (
  organization_id, created_at DESC, id DESC
);

CREATE TABLE IF NOT EXISTS operations_carrier_rate_test_label_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gsa'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  rate_request_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  label_id uuid,
  action text NOT NULL CHECK (action IN ('create', 'void', 'reconcile')),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'succeeded', 'failed', 'unknown')),
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  environment text NOT NULL DEFAULT 'sandbox' CHECK (environment = 'sandbox'),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  service_code text NOT NULL,
  rate_type text,
  selected_rate jsonb NOT NULL CHECK (jsonb_typeof(selected_rate) = 'object'),
  destination_fingerprint text NOT NULL
    CHECK (destination_fingerprint ~ '^[a-f0-9]{64}$'),
  adapter_version text NOT NULL CHECK (
    length(adapter_version) BETWEEN 1 AND 120
    AND adapter_version !~ '[[:cntrl:]]'
  ),
  reason text NOT NULL CHECK (
    length(btrim(reason)) BETWEEN 1 AND 500
    AND reason !~ '[[:cntrl:]]'
  ),
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL CHECK (jsonb_typeof(redacted_request) = 'object'),
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(redacted_response) = 'object'),
  provider_reference text,
  error_code text,
  reconciliation_outcome text CHECK (
    reconciliation_outcome IS NULL
    OR reconciliation_outcome IN (
      'confirmed_no_active_label',
      'confirmed_voided',
      'confirmed_active'
    )
  ),
  reconciliation_reason text CHECK (
    reconciliation_reason IS NULL
    OR (
      length(btrim(reconciliation_reason)) BETWEEN 1 AND 500
      AND reconciliation_reason !~ '[[:cntrl:]]'
    )
  ),
  reconciliation_idempotency_key text CHECK (
    reconciliation_idempotency_key IS NULL
    OR reconciliation_idempotency_key ~ '^[A-Za-z0-9._:-]{8,200}$'
  ),
  reconciled_by text REFERENCES app_users(email) ON DELETE SET NULL,
  reconciled_at timestamptz,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_carrier_rate_test_label_attempts_global_valid
    CHECK (global_id ~ '^gsa[0-9]{7}$'),
  CONSTRAINT operations_carrier_rate_test_label_attempts_global_unique
    UNIQUE (global_id),
  CONSTRAINT operations_carrier_rate_test_label_attempts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_attempts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_carrier_rate_test_label_attempts_rate_request_fkey
    FOREIGN KEY (organization_id, rate_request_id)
    REFERENCES operations_carrier_rate_requests(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_attempts_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_attempts_carrier_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_attempts_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_carrier_rate_test_labels(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_carrier_rate_test_label_attempts_idempotency_unique
    UNIQUE (organization_id, action, idempotency_key),
  CONSTRAINT operations_carrier_rate_test_label_attempts_completion_valid CHECK (
    (
      state = 'prepared'
      AND completed_at IS NULL
      AND error_code IS NULL
    )
    OR (
      state = 'succeeded'
      AND completed_at IS NOT NULL
      AND error_code IS NULL
      AND label_id IS NOT NULL
    )
    OR (
      state IN ('failed', 'unknown')
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    )
  ),
  CONSTRAINT operations_carrier_rate_test_label_attempts_reconciliation_valid CHECK (
    (
      reconciliation_outcome IS NULL
      AND reconciliation_reason IS NULL
      AND reconciliation_idempotency_key IS NULL
      AND reconciled_by IS NULL
      AND reconciled_at IS NULL
    )
    OR (
      reconciliation_outcome IS NOT NULL
      AND reconciliation_reason IS NOT NULL
      AND reconciliation_idempotency_key IS NOT NULL
      AND reconciled_at IS NOT NULL
      AND state IN ('succeeded', 'failed')
    )
  )
);

ALTER TABLE operations_carrier_rate_test_labels
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_labels_create_attempt_fkey,
  ADD CONSTRAINT operations_carrier_rate_test_labels_create_attempt_fkey
    FOREIGN KEY (organization_id, create_attempt_id)
    REFERENCES operations_carrier_rate_test_label_attempts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_test_labels_void_attempt_fkey,
  ADD CONSTRAINT operations_carrier_rate_test_labels_void_attempt_fkey
    FOREIGN KEY (organization_id, void_attempt_id)
    REFERENCES operations_carrier_rate_test_label_attempts(organization_id, id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS
  operations_carrier_rate_test_label_attempts_source_idx
ON operations_carrier_rate_test_label_attempts (
  organization_id, rate_request_id, service_code,
  requested_at DESC, id DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_carrier_rate_test_label_attempts_reconciliation_key_unique
ON operations_carrier_rate_test_label_attempts (
  organization_id, reconciliation_idempotency_key
)
WHERE reconciliation_idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_operations_carrier_rate_test_label_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Carrier rate test label attempts are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.rate_request_id,
    NEW.integration_account_id,
    NEW.carrier_account_id,
    NEW.action,
    NEW.provider,
    NEW.environment,
    NEW.credential_version,
    NEW.service_code,
    NEW.rate_type,
    NEW.selected_rate,
    NEW.destination_fingerprint,
    NEW.adapter_version,
    NEW.reason,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.redacted_request,
    NEW.actor_email,
    NEW.requested_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.rate_request_id,
    OLD.integration_account_id,
    OLD.carrier_account_id,
    OLD.action,
    OLD.provider,
    OLD.environment,
    OLD.credential_version,
    OLD.service_code,
    OLD.rate_type,
    OLD.selected_rate,
    OLD.destination_fingerprint,
    OLD.adapter_version,
    OLD.reason,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.redacted_request,
    OLD.actor_email,
    OLD.requested_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Carrier rate test label attempt identity and request evidence are immutable';
  END IF;

  IF OLD.state = 'unknown' THEN
    IF NEW.state NOT IN ('succeeded', 'failed')
       OR NEW.reconciliation_outcome IS NULL
       OR NEW.reconciliation_reason IS NULL
       OR NEW.reconciliation_idempotency_key IS NULL
       OR NEW.reconciled_at IS NULL THEN
      RAISE EXCEPTION
        'Unknown carrier rate test label attempts require an evidenced reconciliation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'prepared' THEN
    RAISE EXCEPTION 'Terminal carrier rate test label attempts are immutable';
  END IF;
  IF NEW.state = 'prepared' OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Carrier rate test label attempt must finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_test_label_attempt_write
  ON operations_carrier_rate_test_label_attempts;
CREATE TRIGGER protect_operations_carrier_rate_test_label_attempt_write
BEFORE UPDATE OR DELETE ON operations_carrier_rate_test_label_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_carrier_rate_test_label_attempt();

CREATE OR REPLACE FUNCTION protect_operations_carrier_rate_test_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Carrier rate test labels are immutable and cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.rate_request_id,
    NEW.integration_account_id,
    NEW.carrier_account_id,
    NEW.provider,
    NEW.environment,
    NEW.credential_version,
    NEW.account_number_fingerprint,
    NEW.rate_request_hash,
    NEW.destination_fingerprint,
    NEW.service_code,
    NEW.service_name,
    NEW.rate_type,
    NEW.rated_amount,
    NEW.rated_currency,
    NEW.provider_label_id,
    NEW.tracking_number,
    NEW.format,
    NEW.media_size,
    NEW.label_payload,
    NEW.content_sha256,
    NEW.provider_reference,
    NEW.redacted_provider_evidence,
    NEW.create_attempt_id,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.rate_request_id,
    OLD.integration_account_id,
    OLD.carrier_account_id,
    OLD.provider,
    OLD.environment,
    OLD.credential_version,
    OLD.account_number_fingerprint,
    OLD.rate_request_hash,
    OLD.destination_fingerprint,
    OLD.service_code,
    OLD.service_name,
    OLD.rate_type,
    OLD.rated_amount,
    OLD.rated_currency,
    OLD.provider_label_id,
    OLD.tracking_number,
    OLD.format,
    OLD.media_size,
    OLD.label_payload,
    OLD.content_sha256,
    OLD.provider_reference,
    OLD.redacted_provider_evidence,
    OLD.create_attempt_id,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Carrier rate test label identity and provider bytes are immutable';
  END IF;

  IF OLD.status <> 'created'
     OR NEW.status <> 'voided'
     OR NEW.void_attempt_id IS NULL
     OR NEW.voided_at IS NULL THEN
    RAISE EXCEPTION 'Carrier rate test label may transition from created to voided exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_carrier_rate_test_label_write
  ON operations_carrier_rate_test_labels;
CREATE TRIGGER protect_operations_carrier_rate_test_label_write
BEFORE UPDATE OR DELETE ON operations_carrier_rate_test_labels
FOR EACH ROW EXECUTE FUNCTION protect_operations_carrier_rate_test_label();

-- A provider-returned rate-test label is still routed through the durable
-- shipping-label printer capability, but it has no order/package/shipment.
ALTER TABLE operations_print_artifacts
  ADD COLUMN IF NOT EXISTS source_rate_test_label_id uuid;

ALTER TABLE operations_print_artifacts
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_storage_reference_valid,
  ADD CONSTRAINT operations_print_artifacts_storage_reference_valid CHECK (
    length(storage_reference) <= 1000
    AND storage_reference ~ '^[a-z][a-z0-9+.-]{1,31}:[^[:cntrl:]]+$'
    AND lower(storage_reference)
      ~ '^(https|s3|clawpilot-label|clawpilot-rate-test-label|clawpilot-document):'
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_valid,
  ADD CONSTRAINT operations_print_artifacts_source_valid CHECK (
    (
      document_type = 'shipping_label'
      AND (
        (
          source_label_id IS NOT NULL
          AND source_rate_test_label_id IS NULL
          AND source_order_id IS NOT NULL
        )
        OR (
          source_label_id IS NULL
          AND source_rate_test_label_id IS NOT NULL
          AND source_order_id IS NULL
          AND source_shipment_id IS NULL
        )
      )
    )
    OR (
      document_type = 'packing_slip'
      AND source_label_id IS NULL
      AND source_rate_test_label_id IS NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_rate_test_label_fkey,
  ADD CONSTRAINT operations_print_artifacts_source_rate_test_label_fkey
    FOREIGN KEY (organization_id, source_rate_test_label_id)
    REFERENCES operations_carrier_rate_test_labels(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_source_rate_test_label_unique
ON operations_print_artifacts (
  organization_id, source_rate_test_label_id, format, media_size
)
WHERE source_rate_test_label_id IS NOT NULL;

ALTER TABLE operations_print_jobs
  ADD COLUMN IF NOT EXISTS rate_test_label_id uuid;

ALTER TABLE operations_print_jobs
  DROP CONSTRAINT IF EXISTS operations_print_jobs_rate_test_label_fkey,
  ADD CONSTRAINT operations_print_jobs_rate_test_label_fkey
    FOREIGN KEY (organization_id, rate_test_label_id)
    REFERENCES operations_carrier_rate_test_labels(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_label_source_valid,
  ADD CONSTRAINT operations_print_jobs_label_source_valid CHECK (
    NOT (label_id IS NOT NULL AND rate_test_label_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_jobs_original_rate_test_label_unique
ON operations_print_jobs (organization_id, rate_test_label_id)
WHERE rate_test_label_id IS NOT NULL
  AND reprint_of_job_id IS NULL;

CREATE OR REPLACE FUNCTION protect_operations_print_job_intent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.artifact_id IS NOT NULL THEN
    RAISE EXCEPTION 'Durable print jobs cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF ROW(
    NEW.organization_id,
    NEW.label_id,
    NEW.rate_test_label_id,
    NEW.artifact_id,
    NEW.requested_printer_id,
    NEW.fallback_printer_id,
    NEW.request_fingerprint,
    NEW.enqueued_by,
    NEW.max_attempts,
    NEW.idempotency_key,
    NEW.reprint_of_job_id,
    NEW.reprint_reason,
    NEW.reprint_authorized_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.organization_id,
    OLD.label_id,
    OLD.rate_test_label_id,
    OLD.artifact_id,
    OLD.requested_printer_id,
    OLD.fallback_printer_id,
    OLD.request_fingerprint,
    OLD.enqueued_by,
    OLD.max_attempts,
    OLD.idempotency_key,
    OLD.reprint_of_job_id,
    OLD.reprint_reason,
    OLD.reprint_authorized_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'Print document, route intent, idempotency, and reprint provenance are immutable';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON TABLE operations_carrier_rate_test_labels IS
  'Decoded provider bytes and browser-safe metadata for one sandbox label created from an exact successful grq rate result.';
COMMENT ON TABLE operations_carrier_rate_test_label_attempts IS
  'Prepare-call-finalize evidence for rate-selected sandbox label create, void, and reconciliation.';
COMMENT ON COLUMN operations_carrier_rate_test_label_attempts.state IS
  'Unknown blocks another provider command until explicit reconciliation.';
