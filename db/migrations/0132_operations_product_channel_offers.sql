-- Keep the exact provider listing and offer facts beside lifecycle state so a
-- canonical ClawPilot product can safely represent more than one sales
-- channel without collapsing channel-specific titles, SKUs, or prices.

ALTER TABLE operations_product_channel_states
  ADD COLUMN IF NOT EXISTS provider_product_title text,
  ADD COLUMN IF NOT EXISTS provider_variant_title text,
  ADD COLUMN IF NOT EXISTS provider_sku text,
  ADD COLUMN IF NOT EXISTS provider_barcode text,
  ADD COLUMN IF NOT EXISTS wholesale_currency_code text,
  ADD COLUMN IF NOT EXISTS wholesale_price_minor bigint,
  ADD COLUMN IF NOT EXISTS retail_currency_code text,
  ADD COLUMN IF NOT EXISTS retail_price_minor bigint,
  ADD COLUMN IF NOT EXISTS compare_at_currency_code text,
  ADD COLUMN IF NOT EXISTS compare_at_price_minor bigint,
  ADD COLUMN IF NOT EXISTS taxable boolean,
  ADD COLUMN IF NOT EXISTS requires_shipping boolean,
  ADD COLUMN IF NOT EXISTS weight_grams integer;

WITH latest_candidate AS (
  SELECT DISTINCT ON (
    candidate.organization_id,
    candidate.integration_account_id,
    candidate.external_variant_id
  )
    candidate.*
  FROM operations_commerce_product_candidates AS candidate
  ORDER BY
    candidate.organization_id,
    candidate.integration_account_id,
    candidate.external_variant_id,
    candidate.provider_updated_at DESC NULLS LAST,
    candidate.observed_at DESC,
    candidate.created_at DESC,
    candidate.id DESC
)
UPDATE operations_product_channel_states AS state
-- Historical candidate money cannot be copied safely here: Shopify and Faire
-- used the shared price columns with different meanings. The new offer columns
-- stay null until the next verified catalog observation applies provider-aware
-- semantics.
SET provider_product_title = candidate.product_title_snapshot,
    provider_variant_title = candidate.variant_title_snapshot,
    provider_sku = candidate.sku_snapshot,
    provider_barcode = candidate.barcode_snapshot,
    taxable = candidate.taxable,
    requires_shipping = candidate.requires_shipping,
    weight_grams = candidate.weight_grams
FROM latest_candidate AS candidate
WHERE candidate.organization_id = state.organization_id
  AND candidate.integration_account_id = state.integration_account_id
  AND candidate.external_variant_id = state.external_variant_id;

ALTER TABLE operations_product_channel_states
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_listing_facts_valid,
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_wholesale_money_valid,
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_retail_money_valid,
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_compare_at_money_valid,
  DROP CONSTRAINT IF EXISTS
    operations_product_channel_states_weight_valid,
  ADD CONSTRAINT operations_product_channel_states_listing_facts_valid CHECK (
    (
      provider_product_title IS NULL
      OR (
        length(btrim(provider_product_title)) BETWEEN 1 AND 500
        AND provider_product_title !~ '[[:cntrl:]]'
      )
    )
    AND (
      provider_variant_title IS NULL
      OR (
        length(provider_variant_title) <= 512
        AND provider_variant_title !~ '[[:cntrl:]]'
      )
    )
    AND (
      provider_sku IS NULL
      OR (
        length(provider_sku) <= 255
        AND provider_sku !~ '[[:cntrl:]]'
      )
    )
    AND (
      provider_barcode IS NULL
      OR (
        length(provider_barcode) <= 255
        AND provider_barcode !~ '[[:cntrl:]]'
      )
    )
  ),
  ADD CONSTRAINT operations_product_channel_states_wholesale_money_valid
  CHECK (
    (
      wholesale_currency_code IS NULL
      AND wholesale_price_minor IS NULL
    )
    OR (
      wholesale_currency_code IS NOT NULL
      AND wholesale_currency_code ~ '^[A-Z]{3}$'
      AND wholesale_price_minor IS NOT NULL
      AND wholesale_price_minor >= 0
    )
  ),
  ADD CONSTRAINT operations_product_channel_states_retail_money_valid CHECK (
    (
      retail_currency_code IS NULL
      AND retail_price_minor IS NULL
    )
    OR (
      retail_currency_code IS NOT NULL
      AND retail_currency_code ~ '^[A-Z]{3}$'
      AND retail_price_minor IS NOT NULL
      AND retail_price_minor >= 0
    )
  ),
  ADD CONSTRAINT operations_product_channel_states_compare_at_money_valid
  CHECK (
    (
      compare_at_currency_code IS NULL
      AND compare_at_price_minor IS NULL
    )
    OR (
      compare_at_currency_code IS NOT NULL
      AND compare_at_currency_code ~ '^[A-Z]{3}$'
      AND compare_at_price_minor IS NOT NULL
      AND compare_at_price_minor >= 0
    )
  ),
  ADD CONSTRAINT operations_product_channel_states_weight_valid CHECK (
    weight_grams IS NULL OR weight_grams > 0
  );

COMMENT ON COLUMN
  operations_product_channel_states.provider_product_title IS
  'Exact current provider product title; never replaces the canonical ClawPilot product name.';

COMMENT ON COLUMN operations_product_channel_states.provider_sku IS
  'Exact current account-scoped provider SKU; matching evidence only.';

COMMENT ON COLUMN
  operations_product_channel_states.wholesale_price_minor IS
  'Exact provider wholesale offer amount in minor units when supplied.';

COMMENT ON COLUMN operations_product_channel_states.retail_price_minor IS
  'Exact provider retail offer amount in minor units when supplied.';

COMMENT ON COLUMN operations_product_channel_states.compare_at_price_minor IS
  'Exact provider compare-at amount in minor units when supplied; distinct from retail or wholesale.';
