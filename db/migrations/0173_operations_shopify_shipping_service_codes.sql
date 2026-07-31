-- Shopify's ShippingLine.code is an opaque provider shipping-method
-- reference. Carrier-native codes can be shorter than ClawPilot's own
-- CarrierService codes (for example, UPS "03"), so order intake must retain
-- any non-empty bounded value rather than inventing a three-character floor.

ALTER TABLE operations_commerce_order_candidates
  DROP CONSTRAINT IF EXISTS
    operations_commerce_order_candidates_checkout_service_valid,
  ADD CONSTRAINT
    operations_commerce_order_candidates_checkout_service_valid
    CHECK (
      checkout_shipping_service_code IS NULL
      OR (
        length(btrim(checkout_shipping_service_code)) BETWEEN 1 AND 255
        AND checkout_shipping_service_code !~ '[[:cntrl:]]'
      )
    );

COMMENT ON COLUMN
  operations_commerce_order_candidates.checkout_shipping_service_code IS
  'Opaque Shopify ShippingLine.code retained for exact checkout-to-order reconciliation; non-empty, control-free, and bounded to the normalizer limit.';
