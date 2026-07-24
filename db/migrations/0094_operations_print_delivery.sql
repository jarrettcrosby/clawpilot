-- Durable local-agent print delivery.
--
-- operations_printers is the existing printer-profile store. This migration
-- extends it and operations_print_jobs; it does not create parallel profile or
-- job tables. Browser printing remains a best-effort user interaction and
-- cannot create delivery evidence in this model.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gpt', 'operations.print_agent', 'Local print agent'),
  ('gpf', 'operations.print_artifact', 'Print artifact')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_printers
  DROP CONSTRAINT IF EXISTS operations_printers_printer_type_valid,
  DROP CONSTRAINT IF EXISTS operations_printers_type_capabilities_valid;

UPDATE operations_printers
SET printer_type = 'nonthermal'
WHERE printer_type = 'office';

UPDATE operations_printers
SET supports_zpl = 'ZPL' = ANY(supported_formats),
    supported_media = CASE
      WHEN supported_media
        && ARRAY['label_4x6', 'label_4x8']::text[]
      THEN ARRAY(
        SELECT media
        FROM unnest(supported_media) AS media
        WHERE media = ANY(ARRAY['label_4x6', 'label_4x8']::text[])
      )
      ELSE ARRAY['label_4x6']::text[]
    END
WHERE printer_type = 'thermal';

UPDATE operations_printers
SET supports_zpl = false,
    supported_formats = CASE
      WHEN supported_formats && ARRAY['PDF', 'PNG']::text[]
      THEN ARRAY(
        SELECT format
        FROM unnest(supported_formats) AS format
        WHERE format = ANY(ARRAY['PDF', 'PNG']::text[])
      )
      ELSE ARRAY['PDF']::text[]
    END,
    supported_media = CASE
      WHEN supported_media && ARRAY['letter', 'a4']::text[]
      THEN ARRAY(
        SELECT media
        FROM unnest(supported_media) AS media
        WHERE media = ANY(ARRAY['letter', 'a4']::text[])
      )
      ELSE ARRAY['letter']::text[]
    END
WHERE printer_type = 'nonthermal';

ALTER TABLE operations_printers
  ADD CONSTRAINT operations_printers_printer_type_valid
    CHECK (printer_type IN ('thermal', 'nonthermal')),
  ADD CONSTRAINT operations_printers_type_capabilities_valid CHECK (
    (
      printer_type = 'thermal'
      AND supported_media
        <@ ARRAY['label_4x6', 'label_4x8']::text[]
    )
    OR
    (
      printer_type = 'nonthermal'
      AND supported_formats <@ ARRAY['PDF', 'PNG']::text[]
      AND supported_media <@ ARRAY['letter', 'a4']::text[]
    )
  );

COMMENT ON COLUMN operations_printers.printer_type IS
  'Thermal devices accept label media and may accept ZPL. Nonthermal devices accept Letter or A4 PDF/PNG documents.';

UPDATE operations_printers primary_profile
SET fallback_printer_id = NULL,
    row_version = primary_profile.row_version + 1,
    updated_at = now()
FROM operations_printers fallback_profile
WHERE primary_profile.organization_id = fallback_profile.organization_id
  AND primary_profile.fallback_printer_id = fallback_profile.id
  AND (
    fallback_profile.status = 'disabled'
    OR NOT (
      primary_profile.supported_formats
      <@ fallback_profile.supported_formats
    )
    OR NOT (
      primary_profile.supported_media
      <@ fallback_profile.supported_media
    )
    OR NOT (
      primary_profile.supported_document_types
      <@ fallback_profile.supported_document_types
    )
  );

CREATE TABLE IF NOT EXISTS operations_print_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpt'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  name text NOT NULL,
  secret_hash text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  request_fingerprint text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  enrolled_by text REFERENCES app_users(email) ON DELETE SET NULL,
  rotated_by text REFERENCES app_users(email) ON DELETE SET NULL,
  revoked_by text REFERENCES app_users(email) ON DELETE SET NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  CONSTRAINT operations_print_agents_global_valid
    CHECK (global_id ~ '^gpt[0-9]{7}$'),
  CONSTRAINT operations_print_agents_global_unique UNIQUE (global_id),
  CONSTRAINT operations_print_agents_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agents_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_agents_name_present
    CHECK (NULLIF(btrim(name), '') IS NOT NULL),
  CONSTRAINT operations_print_agents_secret_hash_valid
    CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operations_print_agents_credential_version_valid
    CHECK (credential_version > 0),
  CONSTRAINT operations_print_agents_rotation_valid CHECK (
    (
      credential_version = 1
      AND rotated_by IS NULL
      AND rotated_at IS NULL
    )
    OR
    (
      credential_version > 1
      AND rotated_by IS NOT NULL
      AND rotated_at IS NOT NULL
    )
  ),
  CONSTRAINT operations_print_agents_request_fingerprint_valid
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operations_print_agents_idempotency_present
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT operations_print_agents_revocation_valid CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL)
    OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT operations_print_agents_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_print_agents_org_warehouse_id_unique
    UNIQUE (organization_id, warehouse_id, id),
  CONSTRAINT operations_print_agents_idempotency_unique
    UNIQUE (organization_id, idempotency_key)
);

COMMENT ON COLUMN operations_print_agents.global_id IS
  'Public local print-agent identity. Authentication also requires the one-time enrollment secret.';
COMMENT ON COLUMN operations_print_agents.secret_hash IS
  'SHA-256 verifier for a server-generated 256-bit enrollment secret. The plaintext secret is returned once and is never persisted.';

CREATE OR REPLACE FUNCTION protect_operations_print_agent_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Local print-agent identities cannot be deleted';
  END IF;

  IF ROW(
    NEW.id,
    NEW.global_id,
    NEW.organization_id,
    NEW.warehouse_id,
    NEW.request_fingerprint,
    NEW.idempotency_key,
    NEW.enrolled_by,
    NEW.enrolled_at
  ) IS DISTINCT FROM ROW(
    OLD.id,
    OLD.global_id,
    OLD.organization_id,
    OLD.warehouse_id,
    OLD.request_fingerprint,
    OLD.idempotency_key,
    OLD.enrolled_by,
    OLD.enrolled_at
  ) THEN
    RAISE EXCEPTION
      'Local print-agent identity, warehouse ownership, and enrollment provenance are immutable';
  END IF;

  IF NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.credential_version IS DISTINCT FROM OLD.credential_version
     OR NEW.rotated_by IS DISTINCT FROM OLD.rotated_by
     OR NEW.rotated_at IS DISTINCT FROM OLD.rotated_at THEN
    IF OLD.status <> 'active'
       OR NEW.status <> 'active'
       OR NEW.secret_hash = OLD.secret_hash
       OR NEW.credential_version <> OLD.credential_version + 1
       OR NEW.rotated_by IS NULL
       OR NEW.rotated_at IS NULL
       OR NEW.rotated_at <= COALESCE(OLD.rotated_at, OLD.enrolled_at) THEN
      RAISE EXCEPTION
        'Local print-agent credential rotation must replace an active credential and increment its version';
    END IF;
  END IF;

  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'Revoked local print-agent identities cannot be reactivated';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_print_agent_identity_write
  ON operations_print_agents;
CREATE TRIGGER protect_operations_print_agent_identity_write
BEFORE UPDATE OR DELETE ON operations_print_agents
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_agent_identity();

ALTER TABLE operations_printers
  ADD COLUMN IF NOT EXISTS local_print_agent_id uuid;

ALTER TABLE operations_printers
  DROP CONSTRAINT IF EXISTS operations_printers_local_print_agent_fkey,
  ADD CONSTRAINT operations_printers_local_print_agent_fkey
    FOREIGN KEY (organization_id, warehouse_id, local_print_agent_id)
    REFERENCES operations_print_agents(
      organization_id, warehouse_id, id
    ) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_operations_printers_local_agent
  ON operations_printers (
    organization_id, warehouse_id, local_print_agent_id, status, priority
  )
  WHERE local_print_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_print_agents_warehouse
  ON operations_print_agents (
    organization_id, warehouse_id, status, name
  );

CREATE TABLE IF NOT EXISTS operations_print_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gpf'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  source_label_id uuid,
  source_order_id uuid,
  source_shipment_id uuid,
  document_type text NOT NULL
    CHECK (document_type IN ('shipping_label', 'packing_slip')),
  format text NOT NULL CHECK (format IN ('ZPL', 'PDF', 'PNG')),
  media_size text NOT NULL
    CHECK (media_size IN ('label_4x6', 'label_4x8', 'letter', 'a4')),
  content_sha256 text NOT NULL
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  storage_reference text NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_artifacts_global_valid
    CHECK (global_id ~ '^gpf[0-9]{7}$'),
  CONSTRAINT operations_print_artifacts_global_unique UNIQUE (global_id),
  CONSTRAINT operations_print_artifacts_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_print_artifacts_storage_reference_valid CHECK (
    length(storage_reference) <= 1000
    AND storage_reference ~ '^[a-z][a-z0-9+.-]{1,31}:[^[:cntrl:]]+$'
    AND lower(storage_reference)
      ~ '^(https|s3|clawpilot-label|clawpilot-document):'
  ),
  CONSTRAINT operations_print_artifacts_document_media_valid CHECK (
    (
      document_type = 'shipping_label'
      AND media_size IN ('label_4x6', 'label_4x8')
    )
    OR
    (
      document_type = 'packing_slip'
      AND media_size IN ('letter', 'a4')
      AND format IN ('PDF', 'PNG')
    )
  ),
  CONSTRAINT operations_print_artifacts_source_valid CHECK (
    (
      document_type = 'shipping_label'
      AND source_label_id IS NOT NULL
      AND source_order_id IS NOT NULL
    )
    OR
    (
      document_type = 'packing_slip'
      AND source_label_id IS NULL
    )
  ),
  CONSTRAINT operations_print_artifacts_shipment_order_valid CHECK (
    source_shipment_id IS NULL OR source_order_id IS NOT NULL
  ),
  CONSTRAINT operations_print_artifacts_source_label_fkey
    FOREIGN KEY (organization_id, source_label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_artifacts_source_order_fkey
    FOREIGN KEY (organization_id, source_order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_artifacts_source_shipment_fkey
    FOREIGN KEY (organization_id, source_shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_artifacts_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_print_artifacts_source_label_unique
    UNIQUE (organization_id, source_label_id, format, media_size),
  CONSTRAINT operations_print_artifacts_content_unique
    UNIQUE (organization_id, content_sha256, storage_reference)
);

COMMENT ON TABLE operations_print_artifacts IS
  'Immutable metadata for externally stored rendered documents. Artifact bytes are never stored in the print queue.';

CREATE INDEX IF NOT EXISTS idx_operations_print_artifacts_source_order
  ON operations_print_artifacts (
    organization_id, source_order_id, created_at DESC
  )
  WHERE source_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operations_print_artifacts_source_shipment
  ON operations_print_artifacts (
    organization_id, source_shipment_id, created_at DESC
  )
  WHERE source_shipment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_operations_print_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rendered print artifacts are immutable and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_print_artifact_write
  ON operations_print_artifacts;
CREATE TRIGGER protect_operations_print_artifact_write
BEFORE UPDATE OR DELETE ON operations_print_artifacts
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_artifact();

ALTER TABLE operations_print_jobs
  ALTER COLUMN label_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS artifact_id uuid,
  ADD COLUMN IF NOT EXISTS requested_printer_id uuid,
  ADD COLUMN IF NOT EXISTS fallback_printer_id uuid,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS enqueued_by text REFERENCES app_users(email) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claimed_by_print_agent_id uuid,
  ADD COLUMN IF NOT EXISTS current_claim_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reprint_of_job_id uuid,
  ADD COLUMN IF NOT EXISTS reprint_reason text,
  ADD COLUMN IF NOT EXISTS reprint_authorized_by text
    REFERENCES app_users(email) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE operations_print_jobs
SET requested_printer_id = printer_id
WHERE requested_printer_id IS NULL;

ALTER TABLE operations_print_jobs
  DROP CONSTRAINT IF EXISTS operations_print_jobs_status_check,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_status_valid,
  ADD CONSTRAINT operations_print_jobs_status_valid CHECK (
    status IN (
      'queued', 'claimed', 'delivered', 'failed', 'cancelled',
      'printed', 'rerouted'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_jobs_artifact_fkey,
  ADD CONSTRAINT operations_print_jobs_artifact_fkey
    FOREIGN KEY (organization_id, artifact_id)
    REFERENCES operations_print_artifacts(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_requested_printer_fkey,
  ADD CONSTRAINT operations_print_jobs_requested_printer_fkey
    FOREIGN KEY (organization_id, requested_printer_id)
    REFERENCES operations_printers(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_fallback_printer_fkey,
  ADD CONSTRAINT operations_print_jobs_fallback_printer_fkey
    FOREIGN KEY (organization_id, fallback_printer_id)
    REFERENCES operations_printers(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_claimed_agent_fkey,
  ADD CONSTRAINT operations_print_jobs_claimed_agent_fkey
    FOREIGN KEY (organization_id, claimed_by_print_agent_id)
    REFERENCES operations_print_agents(organization_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_print_jobs_delivery_shape_valid,
  ADD CONSTRAINT operations_print_jobs_delivery_shape_valid CHECK (
    artifact_id IS NULL
    OR (
      requested_printer_id IS NOT NULL
      AND (
        fallback_printer_id IS NULL
        OR requested_printer_id <> fallback_printer_id
      )
      AND request_fingerprint ~ '^[a-f0-9]{64}$'
      AND enqueued_by IS NOT NULL
      AND max_attempts BETWEEN 1 AND 10
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_jobs_reprint_shape_valid,
  ADD CONSTRAINT operations_print_jobs_reprint_shape_valid CHECK (
    (
      reprint_of_job_id IS NULL
      AND reprint_reason IS NULL
      AND reprint_authorized_by IS NULL
    )
    OR
    (
      reprint_of_job_id IS NOT NULL
      AND NULLIF(btrim(reprint_reason), '') IS NOT NULL
      AND length(reprint_reason) <= 500
      AND reprint_authorized_by IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_jobs_claim_projection_valid,
  ADD CONSTRAINT operations_print_jobs_claim_projection_valid CHECK (
    (
      status = 'claimed'
      AND claimed_by_print_agent_id IS NOT NULL
      AND current_claim_attempt_id IS NOT NULL
      AND claim_expires_at IS NOT NULL
    )
    OR
    (
      status <> 'claimed'
      AND claimed_by_print_agent_id IS NULL
      AND current_claim_attempt_id IS NULL
      AND claim_expires_at IS NULL
    )
    OR artifact_id IS NULL
  ),
  DROP CONSTRAINT IF EXISTS operations_print_jobs_reprint_fkey,
  ADD CONSTRAINT operations_print_jobs_reprint_fkey
    FOREIGN KEY (organization_id, reprint_of_job_id)
    REFERENCES operations_print_jobs(organization_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN operations_print_jobs.printed_at IS
  'Legacy adapter timestamp. It is not physical-delivery proof and is not written by the durable local-agent delivery path.';
COMMENT ON COLUMN operations_print_jobs.delivered_at IS
  'Time a local agent acknowledged handoff to its configured printer. This does not prove physical output.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_print_jobs_original_label_unique
  ON operations_print_jobs (organization_id, label_id)
  WHERE label_id IS NOT NULL
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

DROP TRIGGER IF EXISTS protect_operations_print_job_intent_write
  ON operations_print_jobs;
CREATE TRIGGER protect_operations_print_job_intent_write
BEFORE UPDATE OR DELETE ON operations_print_jobs
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_job_intent();

CREATE TABLE IF NOT EXISTS operations_print_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  print_job_id uuid NOT NULL,
  printer_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  state text NOT NULL
    CHECK (
      state IN (
        'queued', 'claimed', 'delivered', 'failed', 'cancelled', 'rerouted'
      )
    ),
  actor_type text NOT NULL
    CHECK (actor_type IN ('user', 'local_print_agent', 'system')),
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  print_agent_id uuid,
  claim_attempt_id uuid,
  claim_expires_at timestamptz,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  detail text,
  error_code text,
  error_message text,
  device_job_reference text,
  delivery_evidence text,
  physical_output_verified boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_delivery_attempts_idempotency_present
    CHECK (NULLIF(btrim(idempotency_key), '') IS NOT NULL),
  CONSTRAINT operations_print_delivery_attempts_request_fingerprint_valid
    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT operations_print_delivery_attempts_actor_valid CHECK (
    (
      actor_type = 'user'
      AND actor_email IS NOT NULL
      AND print_agent_id IS NULL
    )
    OR
    (
      actor_type = 'local_print_agent'
      AND actor_email IS NULL
      AND print_agent_id IS NOT NULL
    )
    OR
    (
      actor_type = 'system'
      AND actor_email IS NULL
      AND print_agent_id IS NULL
    )
  ),
  CONSTRAINT operations_print_delivery_attempts_state_actor_valid CHECK (
    (state = 'queued' AND actor_type IN ('user', 'system'))
    OR (state = 'claimed' AND actor_type = 'local_print_agent')
    OR (state = 'delivered' AND actor_type = 'local_print_agent')
    OR (state = 'failed' AND actor_type IN ('local_print_agent', 'system'))
    OR (state = 'cancelled' AND actor_type IN ('user', 'system'))
    OR (state = 'rerouted' AND actor_type = 'system')
  ),
  CONSTRAINT operations_print_delivery_attempts_claim_lease_valid CHECK (
    (
      state = 'claimed'
      AND claim_expires_at IS NOT NULL
      AND claim_expires_at > occurred_at
    )
    OR (state <> 'claimed' AND claim_expires_at IS NULL)
  ),
  CONSTRAINT operations_print_delivery_attempts_error_valid CHECK (
    (
      state = 'failed'
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      AND NULLIF(btrim(error_message), '') IS NOT NULL
    )
    OR
    (
      state <> 'failed'
      AND error_code IS NULL
      AND error_message IS NULL
    )
  ),
  CONSTRAINT operations_print_delivery_attempts_evidence_valid CHECK (
    (
      state = 'delivered'
      AND delivery_evidence = 'local_agent_acknowledgement'
      AND physical_output_verified = false
    )
    OR
    (
      state <> 'delivered'
      AND delivery_evidence IS NULL
      AND physical_output_verified = false
    )
  ),
  CONSTRAINT operations_print_delivery_attempts_job_fkey
    FOREIGN KEY (organization_id, print_job_id)
    REFERENCES operations_print_jobs(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_delivery_attempts_printer_fkey
    FOREIGN KEY (organization_id, printer_id)
    REFERENCES operations_printers(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_delivery_attempts_agent_fkey
    FOREIGN KEY (organization_id, print_agent_id)
    REFERENCES operations_print_agents(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_print_delivery_attempts_org_job_id_unique
    UNIQUE (organization_id, print_job_id, id),
  CONSTRAINT operations_print_delivery_attempts_job_sequence_unique
    UNIQUE (organization_id, print_job_id, sequence_number),
  CONSTRAINT operations_print_delivery_attempts_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_print_delivery_attempts_claim_fkey
    FOREIGN KEY (organization_id, print_job_id, claim_attempt_id)
    REFERENCES operations_print_delivery_attempts(
      organization_id, print_job_id, id
    ) ON DELETE RESTRICT
);

ALTER TABLE operations_print_jobs
  DROP CONSTRAINT IF EXISTS operations_print_jobs_current_claim_fkey,
  ADD CONSTRAINT operations_print_jobs_current_claim_fkey
    FOREIGN KEY (organization_id, id, current_claim_attempt_id)
    REFERENCES operations_print_delivery_attempts(
      organization_id, print_job_id, id
    ) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_operations_print_jobs_delivery_queue
  ON operations_print_jobs (
    organization_id, status, available_at, created_at, id
  )
  WHERE artifact_id IS NOT NULL
    AND status IN ('queued', 'claimed');

CREATE INDEX IF NOT EXISTS idx_operations_print_delivery_attempts_job
  ON operations_print_delivery_attempts (
    organization_id, print_job_id, sequence_number DESC
  );

CREATE OR REPLACE FUNCTION enforce_operations_printer_warehouse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fallback_profile operations_printers%ROWTYPE;
  print_agent_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'operations printer organization is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
    RAISE EXCEPTION
      'operations printer warehouse is immutable; create a new printer profile'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.local_print_agent_id IS NOT NULL THEN
    SELECT agent.status
      INTO print_agent_status
      FROM operations_print_agents agent
     WHERE agent.organization_id = NEW.organization_id
       AND agent.warehouse_id = NEW.warehouse_id
       AND agent.id = NEW.local_print_agent_id;

    IF NEW.connection_mode <> 'local_agent'
       OR print_agent_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'operations printer local-agent binding requires an active organization print agent and local_agent connection mode'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.fallback_printer_id IS NOT NULL THEN
    SELECT fallback.*
      INTO fallback_profile
      FROM operations_printers fallback
     WHERE fallback.organization_id = NEW.organization_id
       AND fallback.id = NEW.fallback_printer_id;

    IF fallback_profile.id IS NULL
       OR fallback_profile.warehouse_id <> NEW.warehouse_id THEN
      RAISE EXCEPTION
        'operations printer fallback must belong to the same warehouse'
        USING ERRCODE = '23514';
    END IF;
    IF fallback_profile.status = 'disabled' THEN
      RAISE EXCEPTION 'operations printer fallback cannot be disabled'
        USING ERRCODE = '23514';
    END IF;
    IF NOT (NEW.supported_formats <@ fallback_profile.supported_formats)
       OR NOT (NEW.supported_media <@ fallback_profile.supported_media)
       OR NOT (
         NEW.supported_document_types
         <@ fallback_profile.supported_document_types
       ) THEN
      RAISE EXCEPTION
        'operations printer fallback must have compatible document, media, and format capabilities'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1
      FROM operations_printers primary_profile
     WHERE primary_profile.organization_id = OLD.organization_id
       AND primary_profile.fallback_printer_id = OLD.id
       AND (
         NEW.status = 'disabled'
         OR NEW.warehouse_id <> primary_profile.warehouse_id
         OR NOT (primary_profile.supported_formats <@ NEW.supported_formats)
         OR NOT (primary_profile.supported_media <@ NEW.supported_media)
         OR NOT (
           primary_profile.supported_document_types
           <@ NEW.supported_document_types
         )
       )
  ) THEN
    RAISE EXCEPTION
      'operations printer update would invalidate an explicit fallback route'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operations_printers_enforce_warehouse
  ON operations_printers;
CREATE TRIGGER trg_operations_printers_enforce_warehouse
BEFORE INSERT OR UPDATE OF
  organization_id,
  warehouse_id,
  fallback_printer_id,
  local_print_agent_id,
  connection_mode,
  supported_formats,
  supported_media,
  supported_document_types,
  default_document_types,
  status
ON operations_printers
FOR EACH ROW
EXECUTE FUNCTION enforce_operations_printer_warehouse();

CREATE OR REPLACE FUNCTION validate_operations_print_job_delivery()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact operations_print_artifacts%ROWTYPE;
  requested_profile operations_printers%ROWTYPE;
  fallback_profile operations_printers%ROWTYPE;
  selected_profile operations_printers%ROWTYPE;
  selected_agent_status text;
BEGIN
  IF NEW.artifact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT value.*
    INTO artifact
    FROM operations_print_artifacts value
   WHERE value.organization_id = NEW.organization_id
     AND value.id = NEW.artifact_id;
  SELECT value.*
    INTO requested_profile
    FROM operations_printers value
   WHERE value.organization_id = NEW.organization_id
     AND value.id = NEW.requested_printer_id;
  IF NEW.fallback_printer_id IS NOT NULL THEN
    SELECT value.*
      INTO fallback_profile
      FROM operations_printers value
     WHERE value.organization_id = NEW.organization_id
       AND value.id = NEW.fallback_printer_id;
  END IF;
  SELECT value.*
    INTO selected_profile
    FROM operations_printers value
   WHERE value.organization_id = NEW.organization_id
     AND value.id = NEW.printer_id;

  IF artifact.id IS NULL
     OR requested_profile.id IS NULL
     OR selected_profile.id IS NULL THEN
    RAISE EXCEPTION
      'print delivery job requires an organization-scoped artifact and printer route'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.fallback_printer_id
     IS DISTINCT FROM requested_profile.fallback_printer_id THEN
    RAISE EXCEPTION
      'print delivery job fallback must match the requested printer route'
      USING ERRCODE = '23514';
  END IF;
  IF fallback_profile.id IS NOT NULL
     AND (
       requested_profile.id = fallback_profile.id
       OR requested_profile.warehouse_id <> fallback_profile.warehouse_id
     ) THEN
    RAISE EXCEPTION
      'print delivery job fallback must be a different printer in the same warehouse'
      USING ERRCODE = '23514';
  END IF;

  IF (
    selected_profile.id <> requested_profile.id
    AND selected_profile.id IS DISTINCT FROM fallback_profile.id
  ) OR selected_profile.status <> 'online' THEN
    RAISE EXCEPTION
      'print delivery target must be an online requested or fallback printer'
      USING ERRCODE = '23514';
  END IF;

  IF requested_profile.connection_mode <> 'local_agent'
     OR (
       fallback_profile.id IS NOT NULL
       AND fallback_profile.connection_mode <> 'local_agent'
     ) THEN
    RAISE EXCEPTION
      'durable print delivery requires local_agent printer profiles; browser printing is not delivery evidence'
      USING ERRCODE = '23514';
  END IF;

  IF artifact.document_type <> ALL(requested_profile.supported_document_types)
     OR artifact.format <> ALL(requested_profile.supported_formats)
     OR artifact.media_size <> ALL(requested_profile.supported_media)
     OR (
       fallback_profile.id IS NOT NULL
       AND (
         artifact.document_type
           <> ALL(fallback_profile.supported_document_types)
         OR artifact.format <> ALL(fallback_profile.supported_formats)
         OR artifact.media_size <> ALL(fallback_profile.supported_media)
       )
     ) THEN
    RAISE EXCEPTION
      'requested and fallback printers must both support the artifact document, media, and format'
      USING ERRCODE = '23514';
  END IF;

  IF artifact.format = 'ZPL'
     AND (
       requested_profile.printer_type <> 'thermal'
       OR (
         fallback_profile.id IS NOT NULL
         AND fallback_profile.printer_type <> 'thermal'
       )
     ) THEN
    RAISE EXCEPTION 'ZPL print delivery requires thermal printers'
      USING ERRCODE = '23514';
  END IF;

  SELECT agent.status
    INTO selected_agent_status
    FROM operations_print_agents agent
   WHERE agent.organization_id = NEW.organization_id
     AND agent.warehouse_id = selected_profile.warehouse_id
     AND agent.id = selected_profile.local_print_agent_id;

  IF selected_agent_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'selected printer requires an active local print-agent enrollment'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_print_job_delivery_write
  ON operations_print_jobs;
CREATE TRIGGER validate_operations_print_job_delivery_write
BEFORE INSERT OR UPDATE OF
  organization_id,
  artifact_id,
  printer_id,
  requested_printer_id,
  fallback_printer_id
ON operations_print_jobs
FOR EACH ROW EXECUTE FUNCTION validate_operations_print_job_delivery();

CREATE OR REPLACE FUNCTION validate_operations_print_delivery_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  print_job operations_print_jobs%ROWTYPE;
  previous_attempt operations_print_delivery_attempts%ROWTYPE;
  assigned_print_agent_id uuid;
  assigned_print_agent_status text;
  expected_attempt_number integer;
  expected_sequence_number integer;
BEGIN
  SELECT job.*
    INTO print_job
    FROM operations_print_jobs job
   WHERE job.organization_id = NEW.organization_id
     AND job.id = NEW.print_job_id
   FOR UPDATE;

  IF print_job.id IS NULL OR print_job.artifact_id IS NULL THEN
    RAISE EXCEPTION
      'delivery attempts require an existing durable print job'
      USING ERRCODE = '23514';
  END IF;

  NEW.printer_id := print_job.printer_id;
  NEW.occurred_at := now();

  SELECT attempt.*
    INTO previous_attempt
    FROM operations_print_delivery_attempts attempt
   WHERE attempt.organization_id = NEW.organization_id
     AND attempt.print_job_id = NEW.print_job_id
   ORDER BY attempt.sequence_number DESC
   LIMIT 1;

  IF previous_attempt.id IS NULL THEN
    IF NEW.state <> 'queued' OR NEW.claim_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'first print delivery state must be queued'
        USING ERRCODE = '23514';
    END IF;
    expected_sequence_number := 1;
    expected_attempt_number := 1;
  ELSE
    IF print_job.status <> previous_attempt.state THEN
      RAISE EXCEPTION
        'print delivery projection does not match its append-only attempt ledger'
        USING ERRCODE = '23514';
    END IF;
    expected_sequence_number := previous_attempt.sequence_number + 1;
    expected_attempt_number := previous_attempt.attempt_number;

    IF previous_attempt.state = 'queued' THEN
      IF NEW.state NOT IN ('claimed', 'failed', 'cancelled', 'rerouted') THEN
        RAISE EXCEPTION
          'queued print delivery may only be claimed, failed, cancelled, or rerouted'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.claim_attempt_id IS NOT NULL THEN
        RAISE EXCEPTION 'queued print delivery transition cannot reference a claim'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.state = 'claimed' THEN
        IF print_job.available_at > clock_timestamp()
           OR print_job.attempts > print_job.max_attempts THEN
          RAISE EXCEPTION 'print delivery is not available for claim'
            USING ERRCODE = '23514';
        END IF;
        SELECT printer.local_print_agent_id, agent.status
          INTO assigned_print_agent_id, assigned_print_agent_status
          FROM operations_printers printer
          LEFT JOIN operations_print_agents agent
            ON agent.organization_id = printer.organization_id
           AND agent.warehouse_id = printer.warehouse_id
           AND agent.id = printer.local_print_agent_id
         WHERE printer.organization_id = print_job.organization_id
           AND printer.id = print_job.printer_id;
        IF assigned_print_agent_id IS DISTINCT FROM NEW.print_agent_id
           OR assigned_print_agent_status IS DISTINCT FROM 'active' THEN
          RAISE EXCEPTION
            'print delivery claim requires the active agent assigned to the target printer'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF previous_attempt.state = 'rerouted' THEN
      IF NEW.state <> 'queued' OR NEW.actor_type <> 'system' THEN
        RAISE EXCEPTION
          'rerouted print delivery must be requeued by the system'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.claim_attempt_id IS NOT NULL THEN
        RAISE EXCEPTION
          'rerouted print delivery transition cannot reference a claim'
          USING ERRCODE = '23514';
      END IF;
    ELSIF previous_attempt.state = 'claimed' THEN
      IF NEW.state NOT IN ('delivered', 'failed', 'cancelled') THEN
        RAISE EXCEPTION
          'claimed print delivery may only be delivered, failed, or cancelled'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.claim_attempt_id IS DISTINCT FROM previous_attempt.id THEN
        RAISE EXCEPTION
          'print delivery acknowledgement must reference the current claim'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.actor_type = 'local_print_agent'
         AND NEW.print_agent_id
           IS DISTINCT FROM previous_attempt.print_agent_id THEN
        RAISE EXCEPTION
          'print delivery result must come from the agent that owns the current claim'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.actor_type = 'local_print_agent'
         AND previous_attempt.claim_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'print delivery claim lease expired'
          USING ERRCODE = '23514';
      END IF;
    ELSIF previous_attempt.state = 'failed' THEN
      IF NEW.state NOT IN ('queued', 'cancelled') THEN
        RAISE EXCEPTION 'failed print delivery may only be requeued or cancelled'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.claim_attempt_id IS NOT NULL THEN
        RAISE EXCEPTION 'failed print delivery transition cannot reference a claim'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.state = 'queued' THEN
        expected_attempt_number := previous_attempt.attempt_number + 1;
        IF expected_attempt_number > print_job.max_attempts THEN
          RAISE EXCEPTION 'print delivery exhausted its bounded retry attempts'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSE
      RAISE EXCEPTION 'delivered or cancelled print delivery is terminal'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.sequence_number IS NOT NULL
     AND NEW.sequence_number <> expected_sequence_number THEN
    RAISE EXCEPTION 'print delivery sequence is assigned by the database'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_number IS NOT NULL
     AND NEW.attempt_number <> expected_attempt_number THEN
    RAISE EXCEPTION 'print delivery attempt number is assigned by the database'
      USING ERRCODE = '23514';
  END IF;

  NEW.sequence_number := expected_sequence_number;
  NEW.attempt_number := expected_attempt_number;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_print_delivery_transition_write
  ON operations_print_delivery_attempts;
CREATE TRIGGER validate_operations_print_delivery_transition_write
BEFORE INSERT ON operations_print_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_print_delivery_transition();

CREATE OR REPLACE FUNCTION project_operations_print_delivery_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE operations_print_jobs
     SET status = NEW.state,
         attempts = GREATEST(attempts, NEW.attempt_number),
         claimed_by_print_agent_id = CASE
           WHEN NEW.state = 'claimed' THEN NEW.print_agent_id
           ELSE NULL
         END,
         current_claim_attempt_id = CASE
           WHEN NEW.state = 'claimed' THEN NEW.id
           ELSE NULL
         END,
         claim_expires_at = CASE
           WHEN NEW.state = 'claimed' THEN NEW.claim_expires_at
           ELSE NULL
         END,
         delivered_at = CASE
           WHEN NEW.state = 'delivered' THEN NEW.occurred_at
           ELSE delivered_at
         END,
         cancelled_at = CASE
           WHEN NEW.state = 'cancelled' THEN NEW.occurred_at
           ELSE cancelled_at
         END,
         last_error = CASE
           WHEN NEW.state = 'failed' THEN NEW.error_message
           WHEN NEW.state IN ('queued', 'claimed', 'delivered', 'rerouted') THEN NULL
           ELSE last_error
         END,
         updated_at = NEW.occurred_at
   WHERE organization_id = NEW.organization_id
     AND id = NEW.print_job_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_operations_print_delivery_attempt_write
  ON operations_print_delivery_attempts;
CREATE TRIGGER project_operations_print_delivery_attempt_write
AFTER INSERT ON operations_print_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION project_operations_print_delivery_attempt();

DROP TRIGGER IF EXISTS protect_operations_print_delivery_attempt_write
  ON operations_print_delivery_attempts;
CREATE TRIGGER protect_operations_print_delivery_attempt_write
BEFORE UPDATE OR DELETE ON operations_print_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

COMMENT ON TABLE operations_print_delivery_attempts IS
  'Append-only local-agent delivery transitions. delivered means agent acknowledgement only; physical output remains unverified.';
COMMENT ON COLUMN operations_print_delivery_attempts.delivery_evidence IS
  'Only local_agent_acknowledgement is supported. Browser dialogs and downloads are never durable delivery evidence.';
