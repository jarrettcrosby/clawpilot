-- Durable shipment-completion evidence.
--
-- Shipment confirmation writes an immutable packing-slip payload, the first
-- append-only tracking observation, and an explicit commerce-fulfillment
-- export intent in the same database transaction as the shipment.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gto', 'operations.tracking_observation', 'Tracking observation'),
  ('gfe', 'operations.fulfillment_export', 'Commerce fulfillment export')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_print_artifact_payloads (
  artifact_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf', 'image/png')),
  filename text NOT NULL CHECK (
    length(filename) BETWEEN 1 AND 240
    AND filename !~ '[[:cntrl:]/\\]'
  ),
  payload bytea NOT NULL CHECK (octet_length(payload) BETWEEN 1 AND 52428800),
  template_version text NOT NULL CHECK (length(template_version) BETWEEN 1 AND 100),
  render_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_print_artifact_payloads_artifact_fkey
    FOREIGN KEY (organization_id, artifact_id)
    REFERENCES operations_print_artifacts(organization_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION protect_operations_print_artifact_payload()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Rendered print artifact payloads are immutable and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_print_artifact_payload_write
  ON operations_print_artifact_payloads;
CREATE TRIGGER protect_operations_print_artifact_payload_write
BEFORE UPDATE OR DELETE ON operations_print_artifact_payloads
FOR EACH ROW EXECUTE FUNCTION protect_operations_print_artifact_payload();

COMMENT ON TABLE operations_print_artifact_payloads IS
  'Immutable rendered payloads for ClawPilot-owned packing slips. Provider label bytes remain on operations_labels.';

COMMENT ON TABLE operations_print_artifacts IS
  'Immutable metadata for rendered shipping labels and packing slips. ClawPilot-owned packing-slip bytes are stored in operations_print_artifact_payloads.';

CREATE TABLE IF NOT EXISTS operations_tracking_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gto'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  shipment_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'confirmed',
      'in_transit',
      'out_for_delivery',
      'delivered',
      'exception',
      'voided'
    )
  ),
  provider text NOT NULL,
  provider_event_id text,
  location text,
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (
    source IN ('shipment_confirmation', 'carrier_webhook', 'carrier_poll', 'manual')
  ),
  raw_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_tracking_observations_global_valid
    CHECK (global_id ~ '^gto[0-9]{7}$'),
  CONSTRAINT operations_tracking_observations_global_unique UNIQUE (global_id),
  CONSTRAINT operations_tracking_observations_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_tracking_observations_shipment_fkey
    FOREIGN KEY (organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_tracking_observations_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_tracking_observations_org_id_unique
    UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_tracking_observations_provider_event_unique
ON operations_tracking_observations (
  organization_id, shipment_id, provider, provider_event_id
)
WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS operations_tracking_observations_shipment_idx
  ON operations_tracking_observations (
    organization_id, shipment_id, observed_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_tracking_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Tracking observations are append-only and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_tracking_observation_write
  ON operations_tracking_observations;
CREATE TRIGGER protect_operations_tracking_observation_write
BEFORE UPDATE OR DELETE ON operations_tracking_observations
FOR EACH ROW EXECUTE FUNCTION protect_operations_tracking_observation();

COMMENT ON TABLE operations_tracking_observations IS
  'Append-only carrier and operator tracking evidence. operations_shipments is the current-state projection.';

CREATE TABLE IF NOT EXISTS operations_commerce_fulfillment_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gfe'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  provider text NOT NULL,
  external_order_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'processing', 'succeeded', 'failed', 'unsupported')),
  payload_snapshot jsonb NOT NULL,
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  provider_reference text,
  error_code text,
  error_message text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_commerce_fulfillment_exports_global_valid
    CHECK (global_id ~ '^gfe[0-9]{7}$'),
  CONSTRAINT operations_commerce_fulfillment_exports_global_unique UNIQUE (global_id),
  CONSTRAINT operations_commerce_fulfillment_exports_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_fulfillment_exports_order_fkey
    FOREIGN KEY (organization_id, order_id)
    REFERENCES operations_orders(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_fulfillment_exports_shipment_fkey
    FOREIGN KEY (organization_id, shipment_id)
    REFERENCES operations_shipments(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_commerce_fulfillment_exports_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_commerce_fulfillment_exports_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_commerce_fulfillment_exports_completion_valid CHECK (
    (
      state IN ('queued', 'processing')
      AND completed_at IS NULL
    )
    OR
    (
      state IN ('succeeded', 'failed', 'unsupported')
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS operations_commerce_fulfillment_exports_queue_idx
  ON operations_commerce_fulfillment_exports (
    state, requested_at, id
  )
  WHERE state IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS operations_commerce_fulfillment_exports_order_idx
  ON operations_commerce_fulfillment_exports (
    organization_id, order_id, requested_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_commerce_fulfillment_export()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Commerce fulfillment exports cannot be deleted';
  END IF;

  IF ROW(
    NEW.global_id,
    NEW.organization_id,
    NEW.order_id,
    NEW.shipment_id,
    NEW.provider,
    NEW.external_order_id,
    NEW.payload_snapshot,
    NEW.idempotency_key,
    NEW.requested_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id,
    OLD.organization_id,
    OLD.order_id,
    OLD.shipment_id,
    OLD.provider,
    OLD.external_order_id,
    OLD.payload_snapshot,
    OLD.idempotency_key,
    OLD.requested_at
  ) THEN
    RAISE EXCEPTION 'Commerce fulfillment export identity and payload are immutable';
  END IF;

  IF OLD.state IN ('succeeded', 'unsupported') THEN
    RAISE EXCEPTION 'Terminal commerce fulfillment exports are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_fulfillment_export_write
  ON operations_commerce_fulfillment_exports;
CREATE TRIGGER protect_operations_commerce_fulfillment_export_write
BEFORE UPDATE OR DELETE ON operations_commerce_fulfillment_exports
FOR EACH ROW EXECUTE FUNCTION protect_operations_commerce_fulfillment_export();

COMMENT ON TABLE operations_commerce_fulfillment_exports IS
  'Durable provider-export intents and outcomes. Provider network calls execute only after shipment commit.';
