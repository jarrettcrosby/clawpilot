-- Provider sandboxes may return priced services without transit or delivery
-- estimates. Preserve that missing evidence instead of inventing a promise.
-- Canonical selection accepts these rates only when the source order itself
-- has no requested delivery promise.

ALTER TABLE operations_fulfillment_plans
  ALTER COLUMN promised_delivery_at DROP NOT NULL;

ALTER TABLE operations_carrier_rates
  ALTER COLUMN transit_days DROP NOT NULL,
  ALTER COLUMN estimated_delivery_at DROP NOT NULL;

COMMENT ON COLUMN operations_fulfillment_plans.promised_delivery_at IS
  'Nullable when an unpromised order selects sealed carrier evidence that does not provide a delivery estimate.';

COMMENT ON COLUMN operations_carrier_rates.transit_days IS
  'Provider-supplied transit days. NULL means the sealed rate response did not provide this fact.';

COMMENT ON COLUMN operations_carrier_rates.estimated_delivery_at IS
  'Provider-supplied or provider-transit-derived delivery estimate. NULL means the sealed rate response did not provide enough evidence to derive one.';
