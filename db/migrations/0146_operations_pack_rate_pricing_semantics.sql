-- Correct the development pack-and-rate replay pricing vocabulary.
--
-- Migration 0145 recorded a scalar `mud_markup_minor` on checkout and
-- fulfillment runs. That value was a sanitized replay fixture delta, not an
-- approved, effective-dated Markup Directive. Existing rows remain immutable
-- version-1 evidence. New rows use version 2, never carry a MUD result, and
-- retain only:
--   * the checkout shipping charge,
--   * the selected carrier estimate at each pass, and
--   * their signed estimated variance.
--
-- Carrier-billed actuals and any applicable MUD calculation belong to the
-- carrier-billing/GL workflow after an imported billing charge is matched.

ALTER TABLE operations_pack_rate_runs
  ADD COLUMN IF NOT EXISTS pricing_semantics_version smallint
  NOT NULL DEFAULT 1;

ALTER TABLE operations_pack_rate_runs
  DROP CONSTRAINT IF EXISTS
  operations_pack_rate_runs_pricing_semantics_version_valid;

ALTER TABLE operations_pack_rate_runs
  ADD CONSTRAINT operations_pack_rate_runs_pricing_semantics_version_valid
  CHECK (pricing_semantics_version IN (1, 2));

ALTER TABLE operations_pack_rate_runs
  ALTER COLUMN pricing_semantics_version SET DEFAULT 2;

ALTER TABLE operations_pack_rate_runs
  DROP CONSTRAINT IF EXISTS operations_pack_rate_runs_economics_valid;

ALTER TABLE operations_pack_rate_runs
  ADD CONSTRAINT operations_pack_rate_runs_economics_valid CHECK (
    (
      pricing_semantics_version = 1
      AND (
        (
          status = 'succeeded'
          AND provider = 'faire'
          AND purpose = 'checkout_quote'
          AND checkout_source = 'faire_checkout_estimate_captured'
          AND line_count = 0
          AND package_count = 0
          AND rate_choice_count = 0
          AND selected_provider IS NULL
          AND selected_service_code IS NULL
          AND selected_service_name IS NULL
          AND selected_carrier_cost_minor IS NULL
          AND customer_charge_minor >= 0
          AND mud_markup_minor IS NULL
          AND margin_minor IS NULL
        )
        OR (
          status = 'succeeded'
          AND line_count BETWEEN 1 AND 500
          AND package_count BETWEEN 1 AND 50
          AND rate_choice_count BETWEEN 2 AND 50
          AND selected_provider IS NOT NULL
          AND selected_service_code IS NOT NULL
          AND selected_service_name IS NOT NULL
          AND selected_carrier_cost_minor >= 0
          AND customer_charge_minor >= 0
          AND mud_markup_minor >= 0
          AND margin_minor
            = customer_charge_minor - selected_carrier_cost_minor
          AND (
            purpose = 'fulfillment_execution'
            OR (
              customer_charge_minor
                = selected_carrier_cost_minor + mud_markup_minor
              AND margin_minor = mud_markup_minor
            )
          )
        )
        OR (
          status IN ('blocked', 'failed')
          AND line_count = 0
          AND package_count = 0
          AND rate_choice_count = 0
          AND selected_provider IS NULL
          AND selected_service_code IS NULL
          AND selected_service_name IS NULL
          AND selected_carrier_cost_minor IS NULL
          AND customer_charge_minor IS NULL
          AND mud_markup_minor IS NULL
          AND margin_minor IS NULL
        )
      )
    )
    OR (
      pricing_semantics_version = 2
      AND (
        (
          status = 'succeeded'
          AND provider = 'faire'
          AND purpose = 'checkout_quote'
          AND checkout_source = 'faire_checkout_estimate_captured'
          AND line_count = 0
          AND package_count = 0
          AND rate_choice_count = 0
          AND selected_provider IS NULL
          AND selected_service_code IS NULL
          AND selected_service_name IS NULL
          AND selected_carrier_cost_minor IS NULL
          AND customer_charge_minor >= 0
          AND mud_markup_minor IS NULL
          AND margin_minor IS NULL
        )
        OR (
          status = 'succeeded'
          AND line_count BETWEEN 1 AND 500
          AND package_count BETWEEN 1 AND 50
          AND rate_choice_count BETWEEN 2 AND 50
          AND selected_provider IS NOT NULL
          AND selected_service_code IS NOT NULL
          AND selected_service_name IS NOT NULL
          AND selected_carrier_cost_minor >= 0
          AND customer_charge_minor >= 0
          AND mud_markup_minor IS NULL
          AND margin_minor
            = customer_charge_minor - selected_carrier_cost_minor
        )
        OR (
          status IN ('blocked', 'failed')
          AND line_count = 0
          AND package_count = 0
          AND rate_choice_count = 0
          AND selected_provider IS NULL
          AND selected_service_code IS NULL
          AND selected_service_name IS NULL
          AND selected_carrier_cost_minor IS NULL
          AND customer_charge_minor IS NULL
          AND mud_markup_minor IS NULL
          AND margin_minor IS NULL
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION validate_operations_pack_rate_run_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  checkout_row operations_pack_rate_runs%ROWTYPE;
BEGIN
  IF NEW.purpose = 'checkout_quote' THEN
    IF NEW.prior_checkout_run_id IS NOT NULL
       OR NEW.customer_resolution_outcome <> 'not_attempted'
       OR NEW.pipeline_id IS NOT NULL
       OR NEW.customer_id IS NOT NULL
       OR NEW.status <> 'succeeded'
       OR NEW.expires_at IS NULL
       OR NEW.expires_at <= NEW.created_at
    THEN
      RAISE EXCEPTION
        'Checkout quote runs require an expiring, customer-neutral succeeded snapshot';
    END IF;
    IF NEW.pricing_semantics_version = 2
       AND NEW.mud_markup_minor IS NOT NULL
    THEN
      RAISE EXCEPTION
        'Pack-and-rate replay cannot calculate MUD before carrier billing';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.prior_checkout_run_id IS NULL OR NEW.expires_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Fulfillment execution runs require one checkout predecessor and do not expire';
  END IF;

  SELECT *
    INTO checkout_row
  FROM operations_pack_rate_runs
  WHERE organization_id = NEW.organization_id
    AND id = NEW.prior_checkout_run_id;
  IF NOT FOUND
     OR checkout_row.purpose <> 'checkout_quote'
     OR checkout_row.replay_group_key <> NEW.replay_group_key
     OR checkout_row.scenario_id <> NEW.scenario_id
     OR checkout_row.provider <> NEW.provider
     OR checkout_row.checkout_source <> NEW.checkout_source
     OR checkout_row.source_kind <> NEW.source_kind
     OR checkout_row.source_reference <> NEW.source_reference
     OR checkout_row.pricing_semantics_version
       <> NEW.pricing_semantics_version
  THEN
    RAISE EXCEPTION
      'Fulfillment execution lineage must reference the exact checkout quote context';
  END IF;

  IF NEW.status = 'succeeded' AND (
    NEW.customer_resolution_outcome NOT IN ('created', 'reused')
    OR NEW.pipeline_id IS NULL
    OR NEW.customer_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Succeeded fulfillment execution requires one resolved CRM customer';
  END IF;
  IF NEW.status = 'succeeded'
     AND NEW.customer_charge_minor
       IS DISTINCT FROM checkout_row.customer_charge_minor
  THEN
    RAISE EXCEPTION
      'Fulfillment must preserve the recorded checkout shipping charge';
  END IF;
  IF NEW.status = 'succeeded'
     AND NEW.pricing_semantics_version = 1
     AND NEW.provider = 'shopify'
     AND NEW.mud_markup_minor
       IS DISTINCT FROM checkout_row.mud_markup_minor
  THEN
    RAISE EXCEPTION
      'Legacy Shopify fulfillment must preserve its version-1 fixture markup';
  END IF;
  IF NEW.pricing_semantics_version = 2
     AND NEW.mud_markup_minor IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Pack-and-rate replay cannot calculate MUD before carrier billing';
  END IF;
  IF NEW.status = 'blocked' AND (
    NEW.customer_resolution_outcome NOT IN ('not_attempted', 'ambiguous')
    OR NEW.pipeline_id IS NOT NULL
    OR NEW.customer_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Blocked fulfillment execution requires an unresolved ambiguous customer';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN operations_pack_rate_runs.pricing_semantics_version IS
  'Version 1 preserves legacy fixture-markup evidence. Version 2 records checkout charge and carrier-estimate variance only; MUD requires matched carrier-billing evidence.';
COMMENT ON COLUMN operations_pack_rate_runs.customer_charge_minor IS
  'Recorded checkout shipping charge retained unchanged through fulfillment. It is not carrier-billed actual cost.';
COMMENT ON COLUMN operations_pack_rate_runs.mud_markup_minor IS
  'Deprecated for version-2 replay rows and required to be null. Version-1 values are immutable legacy fixture evidence, not directive-backed MUD.';
COMMENT ON COLUMN operations_pack_rate_runs.margin_minor IS
  'Signed customer checkout shipping charge minus the selected carrier estimate for this pass. It is estimated variance, not realized margin or MUD.';
COMMENT ON TABLE operations_pack_rate_variances IS
  'Immutable checkout-to-pre-label package, selected carrier-estimate, checkout shipping charge, estimated variance, and cause comparison. Billed actual and MUD are separate carrier-billing facts.';
