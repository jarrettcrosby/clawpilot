-- Audited product and warehouse-location barcode label generation.
--
-- Product labels preserve a valid provider UPC/EAN/GTIN when one exists.
-- Products without one receive a stable ClawPilot Code 128 identity. Location
-- labels use a distinct versioned Code 128 payload. Generation is immutable;
-- delivery remains an explicit durable-print command.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES ('gbl', 'operations.barcode_label_batch', 'Barcode label batch')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS operations_product_barcodes (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  barcode_value text NOT NULL,
  symbology text NOT NULL
    CHECK (symbology IN ('UPC-A', 'EAN-8', 'EAN-13', 'CODE128')),
  source_identity text NOT NULL
    CHECK (source_identity IN ('UPC-A', 'EAN-8', 'EAN-13', 'GTIN-14', 'CODE128')),
  barcode_source text NOT NULL CHECK (barcode_source IN ('provider', 'internal')),
  assigned_by text REFERENCES app_users(email) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, pipeline_id, product_id),
  CONSTRAINT operations_product_barcodes_pipeline_scope_fkey
    FOREIGN KEY (organization_id, pipeline_id)
    REFERENCES pipeline_spaces(workspace_organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_product_barcodes_product_fkey
    FOREIGN KEY (pipeline_id, product_id)
    REFERENCES crm_products(pipeline_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_product_barcodes_value_valid CHECK (
    (
      barcode_source = 'internal'
      AND barcode_value ~ '^CP1P-GP(?:[0-9]{7}|[0-9A-V]{12})$'
      AND symbology = 'CODE128'
      AND source_identity = 'CODE128'
    ) OR (
      barcode_source = 'provider'
      AND barcode_value ~ '^[0-9]+$'
      AND (
        (length(barcode_value) = 8 AND symbology = 'EAN-8' AND source_identity = 'EAN-8')
        OR (length(barcode_value) = 12 AND symbology = 'UPC-A' AND source_identity = 'UPC-A')
        OR (length(barcode_value) = 13 AND symbology = 'EAN-13' AND source_identity = 'EAN-13')
        OR (length(barcode_value) = 14 AND symbology = 'CODE128' AND source_identity = 'GTIN-14')
      )
    )
  ),
  CONSTRAINT operations_product_barcodes_value_unique
    UNIQUE (organization_id, barcode_value)
);

CREATE OR REPLACE FUNCTION protect_operations_product_barcode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Assigned product barcodes are immutable and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_product_barcode_write
  ON operations_product_barcodes;
CREATE TRIGGER protect_operations_product_barcode_write
BEFORE UPDATE OR DELETE ON operations_product_barcodes
FOR EACH ROW EXECUTE FUNCTION protect_operations_product_barcode();

CREATE TABLE IF NOT EXISTS operations_barcode_label_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gbl'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('product', 'location')),
  media_size text NOT NULL CHECK (media_size IN (
    'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8'
  )),
  label_count integer NOT NULL CHECK (label_count BETWEEN 1 AND 500),
  items_snapshot jsonb NOT NULL,
  template_version text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  created_by text REFERENCES app_users(email) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_barcode_label_batches_global_valid
    CHECK (global_id ~ '^gbl(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_barcode_label_batches_global_unique UNIQUE (global_id),
  CONSTRAINT operations_barcode_label_batches_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_barcode_label_batches_warehouse_fkey
    FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES operations_warehouses(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_barcode_label_batches_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_barcode_label_batches_idempotency_unique
    UNIQUE (organization_id, idempotency_key),
  CONSTRAINT operations_barcode_label_batches_key_valid CHECK (
    length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT operations_barcode_label_batches_items_valid CHECK (
    jsonb_typeof(items_snapshot) = 'array'
    AND jsonb_array_length(items_snapshot) BETWEEN 1 AND 100
    AND length(template_version) BETWEEN 1 AND 100
  )
);

CREATE INDEX IF NOT EXISTS idx_operations_barcode_label_batches_recent
  ON operations_barcode_label_batches (
    organization_id, warehouse_id, created_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION protect_operations_barcode_label_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Generated barcode label batches are immutable and cannot be updated or deleted';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_barcode_label_batch_write
  ON operations_barcode_label_batches;
CREATE TRIGGER protect_operations_barcode_label_batch_write
BEFORE UPDATE OR DELETE ON operations_barcode_label_batches
FOR EACH ROW EXECUTE FUNCTION protect_operations_barcode_label_batch();

ALTER TABLE operations_print_artifacts
  ADD COLUMN IF NOT EXISTS source_barcode_label_batch_id uuid;

ALTER TABLE operations_print_artifacts
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_document_type_check,
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_document_type_valid,
  ADD CONSTRAINT operations_print_artifacts_document_type_valid CHECK (
    document_type IN (
      'shipping_label', 'packing_slip', 'product_label', 'location_label'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_media_size_check,
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_media_size_valid,
  ADD CONSTRAINT operations_print_artifacts_media_size_valid CHECK (
    media_size IN (
      'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8',
      'letter', 'a4'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_document_media_valid,
  ADD CONSTRAINT operations_print_artifacts_document_media_valid CHECK (
    (
      document_type = 'shipping_label'
      AND media_size IN ('label_4x6', 'label_4x8')
    ) OR (
      document_type = 'packing_slip'
      AND media_size IN ('letter', 'a4')
      AND format IN ('PDF', 'PNG')
    ) OR (
      document_type IN ('product_label', 'location_label')
      AND media_size IN (
        'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8'
      )
      AND format = 'ZPL'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_valid,
  ADD CONSTRAINT operations_print_artifacts_source_valid CHECK (
    (
      document_type = 'shipping_label'
      AND source_barcode_label_batch_id IS NULL
      AND (
        (
          source_label_id IS NOT NULL
          AND source_rate_test_label_id IS NULL
          AND source_order_id IS NOT NULL
        ) OR (
          source_label_id IS NULL
          AND source_rate_test_label_id IS NOT NULL
          AND source_order_id IS NULL
          AND source_shipment_id IS NULL
        )
      )
    ) OR (
      document_type = 'packing_slip'
      AND source_label_id IS NULL
      AND source_rate_test_label_id IS NULL
      AND source_barcode_label_batch_id IS NULL
    ) OR (
      document_type IN ('product_label', 'location_label')
      AND source_label_id IS NULL
      AND source_rate_test_label_id IS NULL
      AND source_order_id IS NULL
      AND source_shipment_id IS NULL
      AND source_package_id IS NULL
      AND source_barcode_label_batch_id IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_print_artifacts_source_barcode_batch_fkey,
  ADD CONSTRAINT operations_print_artifacts_source_barcode_batch_fkey
    FOREIGN KEY (organization_id, source_barcode_label_batch_id)
    REFERENCES operations_barcode_label_batches(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_print_artifacts_source_barcode_batch_unique
ON operations_print_artifacts (
  organization_id, source_barcode_label_batch_id, format, media_size
)
WHERE source_barcode_label_batch_id IS NOT NULL;

ALTER TABLE operations_print_artifact_payloads
  DROP CONSTRAINT IF EXISTS operations_print_artifact_payloads_mime_type_check,
  DROP CONSTRAINT IF EXISTS operations_print_artifact_payloads_mime_type_valid,
  ADD CONSTRAINT operations_print_artifact_payloads_mime_type_valid CHECK (
    mime_type IN (
      'application/vnd.zebra-zpl', 'application/pdf', 'image/png'
    )
  );

ALTER TABLE operations_printers
  DROP CONSTRAINT IF EXISTS operations_printers_media_valid,
  ADD CONSTRAINT operations_printers_media_valid CHECK (
    cardinality(supported_media) > 0
    AND supported_media <@ ARRAY[
      'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8',
      'letter', 'a4'
    ]::text[]
  ),
  DROP CONSTRAINT IF EXISTS operations_printers_type_capabilities_valid,
  ADD CONSTRAINT operations_printers_type_capabilities_valid CHECK (
    (
      printer_type = 'thermal'
      AND supported_media <@ ARRAY[
        'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8'
      ]::text[]
    ) OR (
      printer_type = 'nonthermal'
      AND supported_formats <@ ARRAY['PDF', 'PNG']::text[]
      AND supported_media <@ ARRAY['letter', 'a4']::text[]
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_printers_document_types_valid,
  ADD CONSTRAINT operations_printers_document_types_valid CHECK (
    cardinality(supported_document_types) > 0
    AND supported_document_types <@ ARRAY[
      'shipping_label',
      'packing_slip',
      'pick_ticket',
      'carton_label',
      'pallet_label',
      'bill_of_lading',
      'customs_document',
      'return_label',
      'customer_insert',
      'product_label',
      'location_label'
    ]::text[]
  );

ALTER TABLE operations_print_agents
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_formats_valid,
  DROP CONSTRAINT IF EXISTS operations_print_agents_formats_valid,
  ADD CONSTRAINT operations_print_agents_supported_formats_valid CHECK (
    cardinality(supported_formats) BETWEEN 1 AND 3
    AND supported_formats <@ ARRAY['ZPL', 'PDF', 'PNG']::text[]
    AND array_position(supported_formats, NULL) IS NULL
  ),
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_media_valid,
  DROP CONSTRAINT IF EXISTS operations_print_agents_media_valid,
  ADD CONSTRAINT operations_print_agents_supported_media_valid CHECK (
    cardinality(supported_media) BETWEEN 1 AND 7
    AND supported_media <@ ARRAY[
      'label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8',
      'letter', 'a4'
    ]::text[]
    AND array_position(supported_media, NULL) IS NULL
  ),
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_documents_valid,
  DROP CONSTRAINT IF EXISTS operations_print_agents_document_types_valid,
  ADD CONSTRAINT operations_print_agents_supported_documents_valid CHECK (
    cardinality(supported_document_types) BETWEEN 1 AND 11
    AND supported_document_types <@ ARRAY[
      'shipping_label',
      'packing_slip',
      'pick_ticket',
      'carton_label',
      'pallet_label',
      'bill_of_lading',
      'customs_document',
      'return_label',
      'customer_insert',
      'product_label',
      'location_label'
    ]::text[]
    AND array_position(supported_document_types, NULL) IS NULL
  );

COMMENT ON TABLE operations_product_barcodes IS
  'Immutable scan-authoritative product barcode assignments. Initial assignment preserves a valid provider UPC/EAN/GTIN or allocates a stable ClawPilot Code 128 value.';
COMMENT ON TABLE operations_barcode_label_batches IS
  'Immutable selected-target and rendered-label evidence. A separate explicit command enqueues durable printer delivery.';
COMMENT ON COLUMN operations_printers.supported_document_types IS
  'New barcode-label capabilities remain opt-in. Migration 0262 does not claim them for an existing printer or print agent.';
