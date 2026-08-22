-- Productless paperwork is rated from the exact sealed parcel. Per-item
-- physical facts remain supported when known, but they are not fabricated or
-- duplicated when the carrier already has parcel dimensions and gross weight.

ALTER TABLE operations_one_off_ad_hoc_order_lines
  ALTER COLUMN unit_weight_grams DROP NOT NULL,
  ALTER COLUMN unit_dimensions_mm DROP NOT NULL;

ALTER TABLE operations_one_off_ad_hoc_order_lines
  ADD CONSTRAINT operations_one_off_ad_hoc_lines_physical_facts_valid CHECK (
    item_snapshot ? 'unitWeightGrams'
    AND item_snapshot ? 'unitDimensionsMm'
    AND ((
      (
        unit_weight_grams IS NULL
        AND unit_dimensions_mm IS NULL
      ) OR (
        unit_weight_grams BETWEEN 1 AND 100000000
        AND jsonb_typeof(unit_dimensions_mm) = 'object'
        AND (unit_dimensions_mm->>'length')::integer BETWEEN 1 AND 100000
        AND (unit_dimensions_mm->>'width')::integer BETWEEN 1 AND 100000
        AND (unit_dimensions_mm->>'height')::integer BETWEEN 1 AND 100000
      )
    ) IS TRUE)
    AND (item_snapshot->>'unitWeightGrams')::integer
      IS NOT DISTINCT FROM unit_weight_grams
    AND NULLIF(item_snapshot->'unitDimensionsMm', 'null'::jsonb)
      IS NOT DISTINCT FROM unit_dimensions_mm
  );

COMMENT ON COLUMN operations_one_off_ad_hoc_order_lines.unit_weight_grams IS
  'Optional factual per-item weight. NULL means the sealed parcel gross weight is the physical carrier evidence.';

COMMENT ON COLUMN operations_one_off_ad_hoc_order_lines.unit_dimensions_mm IS
  'Optional factual per-item dimensions. NULL means the sealed parcel dimensions are the physical carrier evidence.';

CREATE OR REPLACE FUNCTION validate_operations_one_off_ad_hoc_line_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_orders source_order
      ON source_order.organization_id = quote.organization_id
     AND source_order.id = NEW.order_id
     AND source_order.pipeline_id = quote.pipeline_id
     AND source_order.customer_id IS NOT DISTINCT FROM quote.customer_id
     AND source_order.ship_to = quote.destination_snapshot
     AND source_order.source_provider = 'clawpilot_native'
     AND source_order.order_type = 'one_off'
    WHERE quote.organization_id = NEW.organization_id
      AND quote.id = NEW.quote_id
      AND operations_one_off_lines_are_pure_ad_hoc(quote.lines_snapshot)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(quote.lines_snapshot) snapshot
        WHERE snapshot->>'lineKey' = NEW.line_key
          AND snapshot->>'kind' = 'ad_hoc'
          AND snapshot->>'productName' = NEW.description
          AND NULLIF(btrim(snapshot->>'sku'), '')
            IS NOT DISTINCT FROM NEW.item_reference
          AND (snapshot->>'quantity')::numeric = NEW.quantity
          AND (snapshot->>'unitPriceMinor')::bigint = NEW.unit_price_minor
          AND (snapshot->>'unitWeightGrams')::integer
            IS NOT DISTINCT FROM NEW.unit_weight_grams
          AND NULLIF(snapshot->'unitDimensionsMm', 'null'::jsonb)
            IS NOT DISTINCT FROM NEW.unit_dimensions_mm
      )
  ) THEN
    RAISE EXCEPTION
      'One-off ad-hoc item must match its exact sealed quote, recipient, and native order';
  END IF;
  RETURN NEW;
END;
$$;
