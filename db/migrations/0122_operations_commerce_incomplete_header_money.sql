-- Allow exact operational fulfillment demand to stage when a commerce
-- provider omits only shipping and/or the order header total. Missing header
-- money remains NULL and is explicitly ineligible for accounting or customer
-- charge use in the application contract.

ALTER TABLE operations_commerce_order_candidates
  ADD COLUMN IF NOT EXISTS header_money_state text NOT NULL
    DEFAULT 'complete',
  ADD COLUMN IF NOT EXISTS header_money_gaps text[] NOT NULL
    DEFAULT '{}'::text[];

ALTER TABLE operations_commerce_order_candidates
  ALTER COLUMN shipping_minor DROP DEFAULT,
  ALTER COLUMN shipping_minor DROP NOT NULL,
  ALTER COLUMN other_adjustment_minor DROP DEFAULT,
  ALTER COLUMN other_adjustment_minor DROP NOT NULL,
  ALTER COLUMN total_minor DROP NOT NULL;

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS commerce_order_candidates_header_money_state_valid,
  DROP CONSTRAINT IF EXISTS commerce_order_candidates_header_money_gaps_valid,
  DROP CONSTRAINT IF EXISTS commerce_order_candidates_money_valid,
  ADD CONSTRAINT commerce_order_candidates_header_money_state_valid CHECK (
    header_money_state IN ('complete', 'operational_incomplete')
  ),
  ADD CONSTRAINT commerce_order_candidates_header_money_gaps_valid CHECK (
    operations_commerce_code_list_valid(header_money_gaps)
  ),
  ADD CONSTRAINT commerce_order_candidates_money_valid CHECK (
    (
      header_money_state = 'complete'
      AND header_money_gaps = '{}'::text[]
      AND shipping_minor IS NOT NULL
      AND other_adjustment_minor IS NOT NULL
      AND total_minor IS NOT NULL
      AND total_minor = subtotal_minor
        - discount_minor
        - brand_discount_minor
        + shipping_minor
        + tax_minor
        + other_adjustment_minor
    )
    OR
    (
      header_money_state = 'operational_incomplete'
      AND header_money_gaps IN (
        ARRAY['shipping']::text[],
        ARRAY['total']::text[],
        ARRAY['shipping', 'total']::text[]
      )
      AND (shipping_minor IS NULL)
        = ('shipping' = ANY(header_money_gaps))
      AND (total_minor IS NULL)
        = ('total' = ANY(header_money_gaps))
      AND other_adjustment_minor IS NULL
    )
  );

COMMENT ON COLUMN operations_commerce_order_candidates.header_money_state IS
  'complete or fulfillment-only operational_incomplete; incomplete rows are not accounting or customer-charge evidence';
COMMENT ON COLUMN operations_commerce_order_candidates.header_money_gaps IS
  'Exact unavailable provider header fields; restricted to shipping and total by the money constraint';

CREATE OR REPLACE FUNCTION
  protect_operations_commerce_order_candidate_header_money()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.header_money_state IS DISTINCT FROM OLD.header_money_state
     OR NEW.header_money_gaps IS DISTINCT FROM OLD.header_money_gaps THEN
    RAISE EXCEPTION
      'Commerce order candidate header money evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_commerce_order_candidate_header_money
  ON operations_commerce_order_candidates;
CREATE TRIGGER protect_operations_commerce_order_candidate_header_money
BEFORE UPDATE OF header_money_state, header_money_gaps
  ON operations_commerce_order_candidates
FOR EACH ROW EXECUTE FUNCTION
  protect_operations_commerce_order_candidate_header_money();
