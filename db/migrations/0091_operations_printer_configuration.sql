ALTER TABLE operations_printers
  ADD COLUMN IF NOT EXISTS printer_type text NOT NULL DEFAULT 'thermal',
  ADD COLUMN IF NOT EXISTS connection_mode text NOT NULL DEFAULT 'local_agent',
  ADD COLUMN IF NOT EXISTS supported_formats text[] NOT NULL DEFAULT ARRAY['ZPL']::text[],
  ADD COLUMN IF NOT EXISTS supported_media text[] NOT NULL DEFAULT ARRAY['label_4x6']::text[],
  ADD COLUMN IF NOT EXISTS supported_document_types text[] NOT NULL
    DEFAULT ARRAY['shipping_label']::text[],
  ADD COLUMN IF NOT EXISTS default_document_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS fallback_printer_id uuid,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

UPDATE operations_printers
SET
  printer_type = CASE WHEN station_type = 'office' THEN 'office' ELSE 'thermal' END,
  connection_mode = 'local_agent',
  supported_formats = CASE
    WHEN supports_zpl THEN ARRAY['ZPL']::text[]
    ELSE ARRAY['PDF', 'PNG']::text[]
  END,
  supported_media = CASE
    WHEN station_type = 'office' THEN ARRAY['letter', 'a4']::text[]
    ELSE ARRAY['label_4x6']::text[]
  END,
  supported_document_types = CASE
    WHEN station_type = 'office' THEN
      ARRAY['packing_slip', 'pick_ticket', 'bill_of_lading', 'customs_document', 'customer_insert']::text[]
    WHEN station_type = 'receiving' THEN
      ARRAY['carton_label', 'pallet_label', 'pick_ticket']::text[]
    ELSE
      ARRAY['shipping_label', 'return_label', 'carton_label', 'packing_slip']::text[]
  END
WHERE printer_type = 'thermal'
  AND connection_mode = 'local_agent'
  AND supported_formats = ARRAY['ZPL']::text[]
  AND supported_media = ARRAY['label_4x6']::text[]
  AND supported_document_types = ARRAY['shipping_label']::text[];

ALTER TABLE operations_printers
  DROP CONSTRAINT IF EXISTS operations_printers_printer_type_valid,
  ADD CONSTRAINT operations_printers_printer_type_valid
    CHECK (printer_type IN ('thermal', 'office')),
  DROP CONSTRAINT IF EXISTS operations_printers_connection_mode_valid,
  ADD CONSTRAINT operations_printers_connection_mode_valid
    CHECK (connection_mode IN ('local_agent', 'browser', 'system_service')),
  DROP CONSTRAINT IF EXISTS operations_printers_formats_valid,
  ADD CONSTRAINT operations_printers_formats_valid
    CHECK (
      cardinality(supported_formats) > 0
      AND supported_formats <@ ARRAY['ZPL', 'PDF', 'PNG']::text[]
    ),
  DROP CONSTRAINT IF EXISTS operations_printers_media_valid,
  ADD CONSTRAINT operations_printers_media_valid
    CHECK (
      cardinality(supported_media) > 0
      AND supported_media <@ ARRAY['label_4x6', 'label_4x8', 'letter', 'a4']::text[]
    ),
  DROP CONSTRAINT IF EXISTS operations_printers_document_types_valid,
  ADD CONSTRAINT operations_printers_document_types_valid
    CHECK (
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
        'customer_insert'
      ]::text[]
    ),
  DROP CONSTRAINT IF EXISTS operations_printers_defaults_supported,
  ADD CONSTRAINT operations_printers_defaults_supported
    CHECK (default_document_types <@ supported_document_types),
  DROP CONSTRAINT IF EXISTS operations_printers_row_version_valid,
  ADD CONSTRAINT operations_printers_row_version_valid
    CHECK (row_version >= 0),
  DROP CONSTRAINT IF EXISTS operations_printers_fallback_not_self,
  ADD CONSTRAINT operations_printers_fallback_not_self
    CHECK (fallback_printer_id IS NULL OR fallback_printer_id <> id),
  DROP CONSTRAINT IF EXISTS operations_printers_fallback_fkey,
  ADD CONSTRAINT operations_printers_fallback_fkey
    FOREIGN KEY (organization_id, fallback_printer_id)
    REFERENCES operations_printers(organization_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_operations_printers_routing
  ON operations_printers (organization_id, warehouse_id, status, priority, name);

COMMENT ON COLUMN operations_printers.connection_mode IS
  'local_agent is the reliable warehouse path; browser printing remains best effort and cannot acknowledge a durable print job.';
COMMENT ON COLUMN operations_printers.default_document_types IS
  'Document routes owned by this printer within its warehouse. Application writes keep one default per document type.';
COMMENT ON COLUMN operations_printers.fallback_printer_id IS
  'Same-organization fallback. Application validation further requires the same warehouse and compatible capabilities.';

CREATE OR REPLACE FUNCTION enforce_operations_printer_warehouse()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fallback_warehouse_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
    RAISE EXCEPTION 'operations printer warehouse is immutable; create a new printer profile'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.fallback_printer_id IS NOT NULL THEN
    SELECT warehouse_id
      INTO fallback_warehouse_id
      FROM operations_printers
     WHERE organization_id = NEW.organization_id
       AND id = NEW.fallback_printer_id;

    IF fallback_warehouse_id IS NULL OR fallback_warehouse_id <> NEW.warehouse_id THEN
      RAISE EXCEPTION 'operations printer fallback must belong to the same warehouse'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_operations_printers_enforce_warehouse
  ON operations_printers;
CREATE TRIGGER trg_operations_printers_enforce_warehouse
BEFORE INSERT OR UPDATE OF warehouse_id, fallback_printer_id
ON operations_printers
FOR EACH ROW
EXECUTE FUNCTION enforce_operations_printer_warehouse();
