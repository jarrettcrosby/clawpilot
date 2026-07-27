-- Fail-closed local print-agent capabilities.
--
-- Existing enrolled agents are the bundled raw-ZPL Zebra runtime unless an
-- operator enrolls a custom agent with an explicit broader capability set.
-- Printer profiles and claims must remain within the enrolled agent boundary.

ALTER TABLE operations_print_agents
  ADD COLUMN IF NOT EXISTS supported_formats text[] NOT NULL
    DEFAULT ARRAY['ZPL']::text[],
  ADD COLUMN IF NOT EXISTS supported_media text[] NOT NULL
    DEFAULT ARRAY['label_4x6']::text[],
  ADD COLUMN IF NOT EXISTS supported_document_types text[] NOT NULL
    DEFAULT ARRAY['shipping_label']::text[];

-- The existing printer trigger validates both directions of a fallback pair.
-- Rebuild it around the set-based backfill so row update order cannot make an
-- otherwise valid pair fail transiently while both profiles are narrowed.
DROP TRIGGER IF EXISTS trg_operations_printers_enforce_warehouse
  ON operations_printers;

-- Every agent enrolled before this migration used the bundled raw-ZPL Zebra
-- worker. Narrow its bound thermal printer profiles to the same truthful
-- capability set before capability enforcement begins. Preserve the binding,
-- online status, priority, and default-shipping intent. A nonthermal profile
-- cannot truthfully remain attached to the bundled raw-ZPL worker, so fail it
-- closed by unbinding and taking it offline.
UPDATE operations_printers
SET
  supports_zpl = true,
  supported_formats = ARRAY['ZPL']::text[],
  supported_media = ARRAY['label_4x6']::text[],
  supported_document_types = ARRAY['shipping_label']::text[],
  default_document_types = CASE
    WHEN 'shipping_label' = ANY(default_document_types)
      THEN ARRAY['shipping_label']::text[]
    ELSE ARRAY[]::text[]
  END,
  row_version = row_version + 1,
  updated_at = now()
WHERE local_print_agent_id IS NOT NULL
  AND printer_type = 'thermal'
  AND (
    supports_zpl IS DISTINCT FROM true
    OR supported_formats IS DISTINCT FROM ARRAY['ZPL']::text[]
    OR supported_media IS DISTINCT FROM ARRAY['label_4x6']::text[]
    OR supported_document_types
      IS DISTINCT FROM ARRAY['shipping_label']::text[]
    OR default_document_types
      && ARRAY[
        'packing_slip',
        'pick_ticket',
        'carton_label',
        'pallet_label',
        'bill_of_lading',
        'customs_document',
        'return_label',
        'customer_insert'
      ]::text[]
  );

UPDATE operations_printers
SET
  local_print_agent_id = NULL,
  status = 'offline',
  row_version = row_version + 1,
  updated_at = now()
WHERE local_print_agent_id IS NOT NULL
  AND printer_type <> 'thermal';

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

ALTER TABLE operations_print_agents
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_formats_valid,
  ADD CONSTRAINT operations_print_agents_supported_formats_valid CHECK (
    cardinality(supported_formats) BETWEEN 1 AND 3
    AND supported_formats <@ ARRAY['ZPL', 'PDF', 'PNG']::text[]
    AND array_position(supported_formats, NULL) IS NULL
  ),
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_media_valid,
  ADD CONSTRAINT operations_print_agents_supported_media_valid CHECK (
    cardinality(supported_media) BETWEEN 1 AND 4
    AND supported_media <@ ARRAY[
      'label_4x6', 'label_4x8', 'letter', 'a4'
    ]::text[]
    AND array_position(supported_media, NULL) IS NULL
  ),
  DROP CONSTRAINT IF EXISTS operations_print_agents_supported_documents_valid,
  ADD CONSTRAINT operations_print_agents_supported_documents_valid CHECK (
    cardinality(supported_document_types) BETWEEN 1 AND 9
    AND supported_document_types <@ ARRAY[
      'shipping_label',
      'packing_slip',
      'pick_ticket',
      'carton_label',
      'pallet_label',
      'bill_of_lading',
      'customs_document',
      'return_label',
      'customer_insert'
    ]::text[]
    AND array_position(supported_document_types, NULL) IS NULL
  );

COMMENT ON COLUMN operations_print_agents.supported_formats IS
  'Exact print formats this enrolled runtime can deliver. Existing agents default to bundled raw-ZPL Zebra support.';
COMMENT ON COLUMN operations_print_agents.supported_media IS
  'Exact media sizes this enrolled runtime can deliver. Existing agents default to 4 x 6 labels.';
COMMENT ON COLUMN operations_print_agents.supported_document_types IS
  'Exact document classes this enrolled runtime can deliver. Existing agents default to shipping labels.';

CREATE OR REPLACE FUNCTION enforce_operations_print_agent_capabilities()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  agent_status text;
  agent_formats text[];
  agent_media text[];
  agent_documents text[];
BEGIN
  IF TG_TABLE_NAME = 'operations_printers' THEN
    IF NEW.local_print_agent_id IS NULL THEN
      RETURN NEW;
    END IF;

    SELECT
      status,
      supported_formats,
      supported_media,
      supported_document_types
    INTO
      agent_status,
      agent_formats,
      agent_media,
      agent_documents
    FROM operations_print_agents
    WHERE organization_id = NEW.organization_id
      AND warehouse_id = NEW.warehouse_id
      AND id = NEW.local_print_agent_id;

    IF agent_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'A printer can only be assigned to an active local print agent';
    END IF;
    IF NOT (NEW.supported_formats <@ agent_formats)
       OR NOT (NEW.supported_media <@ agent_media)
       OR NOT (NEW.supported_document_types <@ agent_documents) THEN
      RAISE EXCEPTION
        'Printer capabilities must be a subset of its local print agent capabilities';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_printers printer
    WHERE printer.organization_id = NEW.organization_id
      AND printer.warehouse_id = NEW.warehouse_id
      AND printer.local_print_agent_id = NEW.id
      AND (
        NEW.status <> 'active'
        OR NOT (printer.supported_formats <@ NEW.supported_formats)
        OR NOT (printer.supported_media <@ NEW.supported_media)
        OR NOT (
          printer.supported_document_types
          <@ NEW.supported_document_types
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Assigned printer capabilities must remain within active local print agent capabilities';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_operations_printer_agent_capabilities_write
  ON operations_printers;
CREATE TRIGGER enforce_operations_printer_agent_capabilities_write
BEFORE INSERT OR UPDATE OF
  local_print_agent_id,
  supported_formats,
  supported_media,
  supported_document_types,
  organization_id,
  warehouse_id
ON operations_printers
FOR EACH ROW EXECUTE FUNCTION enforce_operations_print_agent_capabilities();

DROP TRIGGER IF EXISTS enforce_operations_print_agent_capabilities_write
  ON operations_print_agents;
CREATE TRIGGER enforce_operations_print_agent_capabilities_write
BEFORE UPDATE OF
  status,
  supported_formats,
  supported_media,
  supported_document_types
ON operations_print_agents
FOR EACH ROW EXECUTE FUNCTION enforce_operations_print_agent_capabilities();
