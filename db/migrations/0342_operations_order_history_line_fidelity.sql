BEGIN;

-- Exact provider reads already normalize the descriptive and monetary facts
-- below. Retain them with the append-only observation line so externally
-- fulfilled and subsequently edited orders remain reviewable without
-- rewriting ClawPilot's immutable fulfillment demand.
ALTER TABLE operations_commerce_order_observation_lines
  ADD COLUMN IF NOT EXISTS title_snapshot text,
  ADD COLUMN IF NOT EXISTS variant_title_snapshot text,
  ADD COLUMN IF NOT EXISTS vendor_snapshot text,
  ADD COLUMN IF NOT EXISTS unit_price_currency text,
  ADD COLUMN IF NOT EXISTS unit_price_minor bigint,
  ADD COLUMN IF NOT EXISTS subtotal_currency text,
  ADD COLUMN IF NOT EXISTS subtotal_minor bigint,
  ADD COLUMN IF NOT EXISTS discount_currency text,
  ADD COLUMN IF NOT EXISTS discount_minor bigint,
  ADD COLUMN IF NOT EXISTS tax_currency text,
  ADD COLUMN IF NOT EXISTS tax_minor bigint;

ALTER TABLE operations_commerce_order_observation_lines
  DROP CONSTRAINT IF EXISTS commerce_order_observation_line_snapshots_valid;
ALTER TABLE operations_commerce_order_observation_lines
  ADD CONSTRAINT commerce_order_observation_line_snapshots_valid CHECK (
    (title_snapshot IS NULL OR (
      length(btrim(title_snapshot)) BETWEEN 1 AND 512
      AND title_snapshot !~ '[[:cntrl:]]'
    ))
    AND (variant_title_snapshot IS NULL OR (
      length(btrim(variant_title_snapshot)) BETWEEN 1 AND 512
      AND variant_title_snapshot !~ '[[:cntrl:]]'
    ))
    AND (vendor_snapshot IS NULL OR (
      length(btrim(vendor_snapshot)) BETWEEN 1 AND 512
      AND vendor_snapshot !~ '[[:cntrl:]]'
    ))
  );

ALTER TABLE operations_commerce_order_observation_lines
  DROP CONSTRAINT IF EXISTS commerce_order_observation_line_money_valid;
ALTER TABLE operations_commerce_order_observation_lines
  ADD CONSTRAINT commerce_order_observation_line_money_valid CHECK (
    (unit_price_currency IS NULL) = (unit_price_minor IS NULL)
    AND (subtotal_currency IS NULL) = (subtotal_minor IS NULL)
    AND (discount_currency IS NULL) = (discount_minor IS NULL)
    AND (tax_currency IS NULL) = (tax_minor IS NULL)
    AND (
      unit_price_currency IS NULL
      OR unit_price_currency ~ '^[A-Z]{3}$'
    )
    AND (
      subtotal_currency IS NULL
      OR subtotal_currency ~ '^[A-Z]{3}$'
    )
    AND (
      discount_currency IS NULL
      OR discount_currency ~ '^[A-Z]{3}$'
    )
    AND (
      tax_currency IS NULL
      OR tax_currency ~ '^[A-Z]{3}$'
    )
    AND (
      unit_price_minor IS NULL
      OR unit_price_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
    AND (
      subtotal_minor IS NULL
      OR subtotal_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
    AND (
      discount_minor IS NULL
      OR discount_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
    AND (
      tax_minor IS NULL
      OR tax_minor BETWEEN -9007199254740991 AND 9007199254740991
    )
  );

COMMENT ON COLUMN operations_commerce_order_observation_lines.title_snapshot IS
  'Provider-observed line title retained with this immutable order revision.';
COMMENT ON COLUMN operations_commerce_order_observation_lines.unit_price_minor IS
  'Exact provider primary unit price for this revision; paired with its own currency.';
COMMENT ON COLUMN operations_commerce_order_observation_lines.subtotal_minor IS
  'Exact provider primary line subtotal for this revision; paired with its own currency.';
COMMENT ON COLUMN operations_commerce_order_observation_lines.discount_minor IS
  'Exact provider primary line discount for this revision; paired with its own currency.';
COMMENT ON COLUMN operations_commerce_order_observation_lines.tax_minor IS
  'Exact provider primary line tax for this revision; paired with its own currency.';

COMMIT;
