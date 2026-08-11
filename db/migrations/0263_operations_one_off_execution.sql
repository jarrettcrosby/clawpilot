-- Explicit one-off shipping mode and immutable provider execution lineage.
--
-- `test` is always carrier sandbox. `live` is always production. Production
-- carrier reads and Ship calls are prepared durably before network I/O; an
-- unknown result blocks a new attempt until the exact attempt is reconciled.

INSERT INTO global_reference_entity_types (prefix, entity_type, display_name)
VALUES
  ('gora', 'operations.one_off_rate_attempt', 'One-off carrier rate attempt'),
  ('gocg', 'operations.one_off_carrier_group_attempt', 'One-off carrier shipment group attempt'),
  ('gocm', 'operations.one_off_carrier_group_member', 'One-off carrier shipment group member'),
  ('gocr', 'operations.one_off_carrier_group_result', 'One-off carrier shipment package result')
ON CONFLICT (prefix) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  display_name = EXCLUDED.display_name;

ALTER TABLE operations_carrier_rate_requests
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_environment_check,
  DROP CONSTRAINT IF EXISTS operations_carrier_rate_requests_environment_valid,
  ADD CONSTRAINT operations_carrier_rate_requests_environment_valid
    CHECK (environment IN ('sandbox', 'production'));

ALTER TABLE operations_one_off_shipment_quotes
  ADD COLUMN IF NOT EXISTS execution_mode text,
  ADD COLUMN IF NOT EXISTS packed_rerate_order_id uuid,
  ADD COLUMN IF NOT EXISTS packed_rerate_plan_id uuid;

UPDATE operations_one_off_shipment_quotes
SET execution_mode = CASE
  WHEN rate_environment = 'production' THEN 'live'
  ELSE 'test'
END
WHERE execution_mode IS NULL;

ALTER TABLE operations_one_off_shipment_quotes
  ALTER COLUMN execution_mode SET NOT NULL,
  DROP CONSTRAINT IF EXISTS operations_one_off_quote_execution_mode_valid,
  ADD CONSTRAINT operations_one_off_quote_execution_mode_valid CHECK (
    (execution_mode = 'test' AND rate_environment = 'sandbox')
    OR (execution_mode = 'live' AND rate_environment = 'production')
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_quote_packed_rerate_pair,
  ADD CONSTRAINT operations_one_off_quote_packed_rerate_pair CHECK (
    (packed_rerate_order_id IS NULL AND packed_rerate_plan_id IS NULL)
    OR (packed_rerate_order_id IS NOT NULL AND packed_rerate_plan_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS operations_one_off_quote_packed_rerate_plan_fkey,
  ADD CONSTRAINT operations_one_off_quote_packed_rerate_plan_fkey
    FOREIGN KEY (organization_id, packed_rerate_order_id, packed_rerate_plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT;

ALTER TABLE operations_fulfillment_plans
  ADD COLUMN IF NOT EXISTS one_off_quote_id uuid,
  ADD COLUMN IF NOT EXISTS one_off_offer_id uuid,
  DROP CONSTRAINT IF EXISTS operations_fulfillment_plans_one_off_lineage_pair,
  ADD CONSTRAINT operations_fulfillment_plans_one_off_lineage_pair CHECK (
    (one_off_quote_id IS NULL AND one_off_offer_id IS NULL)
    OR (one_off_quote_id IS NOT NULL AND one_off_offer_id IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS operations_fulfillment_plans_one_off_quote_fkey,
  ADD CONSTRAINT operations_fulfillment_plans_one_off_quote_fkey
    FOREIGN KEY (organization_id, one_off_quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_fulfillment_plans_one_off_offer_fkey,
  ADD CONSTRAINT operations_fulfillment_plans_one_off_offer_fkey
    FOREIGN KEY (organization_id, one_off_quote_id, one_off_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION operations_one_off_plan_authority_is_valid(
  authority_organization_id uuid,
  authority_order_id uuid,
  authority_warehouse_id uuid,
  authority_quote_id uuid,
  authority_offer_id uuid,
  required_execution_mode text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = quote.organization_id
     AND offer.quote_id = quote.id
     AND offer.id = authority_offer_id
    JOIN operations_one_off_shipment_quote_consumptions consumption
      ON consumption.organization_id = quote.organization_id
     AND consumption.quote_id = quote.id
     AND consumption.offer_id = offer.id
     AND consumption.order_id = authority_order_id
    JOIN operations_orders source_order
      ON source_order.organization_id = consumption.organization_id
     AND source_order.id = consumption.order_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = offer.organization_id
     AND evidence.global_id = offer.rate_evidence_global_id
    WHERE quote.organization_id = authority_organization_id
      AND quote.id = authority_quote_id
      AND quote.warehouse_id = authority_warehouse_id
      AND quote.status IN ('succeeded', 'partial')
      AND source_order.source_provider = 'clawpilot_native'
      AND source_order.order_type = 'one_off'
      AND (
        required_execution_mode IS NULL
        OR quote.execution_mode = required_execution_mode
      )
      AND (
        (quote.execution_mode = 'test'
          AND quote.rate_environment = 'sandbox'
          AND offer.environment = 'sandbox'
          AND evidence.environment = 'sandbox')
        OR
        (quote.execution_mode = 'live'
          AND quote.rate_environment = 'production'
          AND offer.environment = 'production'
          AND evidence.environment = 'production')
      )
      AND evidence.status = 'succeeded'
      AND evidence.provider = offer.provider
      AND evidence.integration_account_id = offer.integration_account_id
      AND evidence.carrier_account_id = offer.carrier_account_id
      AND evidence.request_hash = offer.carrier_request_hash
  )
$$;

-- Preserve a relational bridge from the immutable one-off offer into the
-- selected canonical plan rate. The generic carrier-rate table predates
-- one-off execution and otherwise exposes only mutable JSON lineage.
ALTER TABLE operations_carrier_rates
  ADD COLUMN IF NOT EXISTS one_off_quote_id uuid,
  ADD COLUMN IF NOT EXISTS one_off_offer_id uuid,
  ADD COLUMN IF NOT EXISTS one_off_rate_evidence_global_id text,
  ADD COLUMN IF NOT EXISTS one_off_currency text,
  DROP CONSTRAINT IF EXISTS operations_carrier_rates_one_off_lineage_complete,
  ADD CONSTRAINT operations_carrier_rates_one_off_lineage_complete CHECK (
    (
      one_off_quote_id IS NULL
      AND one_off_offer_id IS NULL
      AND one_off_rate_evidence_global_id IS NULL
      AND one_off_currency IS NULL
    ) OR (
      one_off_quote_id IS NOT NULL
      AND one_off_offer_id IS NOT NULL
      AND one_off_rate_evidence_global_id IS NOT NULL
      AND one_off_currency ~ '^[A-Z]{3}$'
    )
  ),
  DROP CONSTRAINT IF EXISTS operations_carrier_rates_one_off_quote_fkey,
  ADD CONSTRAINT operations_carrier_rates_one_off_quote_fkey
    FOREIGN KEY (organization_id, one_off_quote_id)
    REFERENCES operations_one_off_shipment_quotes(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_carrier_rates_one_off_offer_fkey,
  ADD CONSTRAINT operations_carrier_rates_one_off_offer_fkey
    FOREIGN KEY (organization_id, one_off_quote_id, one_off_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_carrier_rates_one_off_evidence_fkey,
  ADD CONSTRAINT operations_carrier_rates_one_off_evidence_fkey
    FOREIGN KEY (organization_id, one_off_rate_evidence_global_id)
    REFERENCES operations_carrier_rate_requests(organization_id, global_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_operations_one_off_carrier_rate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.one_off_quote_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = plan.organization_id
     AND quote.id = plan.one_off_quote_id
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = plan.organization_id
     AND offer.quote_id = plan.one_off_quote_id
     AND offer.id = plan.one_off_offer_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = offer.organization_id
     AND evidence.global_id = offer.rate_evidence_global_id
    WHERE plan.organization_id = NEW.organization_id
      AND plan.id = NEW.plan_id
      AND plan.one_off_quote_id = NEW.one_off_quote_id
      AND NEW.one_off_offer_id = offer.id
      AND NEW.one_off_rate_evidence_global_id = offer.rate_evidence_global_id
      AND NEW.one_off_currency = offer.currency
      AND NEW.one_off_currency = quote.currency
      AND NEW.internal_cost_minor = offer.amount_minor
      AND NEW.service_code = offer.service_code
      AND lower(offer.provider) = CASE lower(NEW.carrier)
        WHEN 'ups' THEN 'ups_rest'
        WHEN 'fedex' THEN 'fedex_rest'
        ELSE lower(NEW.carrier)
      END
      AND evidence.status = 'succeeded'
      AND evidence.provider = offer.provider
      AND evidence.environment = offer.environment
      AND evidence.integration_account_id = offer.integration_account_id
      AND evidence.carrier_account_id = offer.carrier_account_id
      AND evidence.request_hash = offer.carrier_request_hash
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
              THEN evidence.redacted_response->'rates'
            ELSE '[]'::jsonb
          END
        ) retained_rate
        WHERE retained_rate->>'serviceCode' = offer.service_code
          AND upper(retained_rate->>'currency') = offer.currency
          AND retained_rate->>'amount' ~ '^[0-9]+(?:\.[0-9]{1,4})?$'
          AND round((retained_rate->>'amount')::numeric * 100)::bigint
            = offer.amount_minor
      )
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'One-off carrier rate must match its exact immutable offer and provider evidence';
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_carrier_rate_write
  ON operations_carrier_rates;
CREATE TRIGGER validate_operations_one_off_carrier_rate_write
BEFORE INSERT OR UPDATE ON operations_carrier_rates
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_carrier_rate();

CREATE OR REPLACE FUNCTION protect_operations_one_off_carrier_rate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.one_off_quote_id IS NOT NULL AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.organization_id, NEW.plan_id, NEW.carrier, NEW.service_code,
      NEW.service_name, NEW.internal_cost_minor, NEW.customer_charge_minor,
      NEW.transit_days, NEW.estimated_delivery_at, NEW.meets_promise,
      NEW.selected, NEW.quote_snapshot, NEW.one_off_quote_id,
      NEW.one_off_offer_id, NEW.one_off_rate_evidence_global_id,
      NEW.one_off_currency
    ) IS DISTINCT FROM ROW(
      OLD.organization_id, OLD.plan_id, OLD.carrier, OLD.service_code,
      OLD.service_name, OLD.internal_cost_minor, OLD.customer_charge_minor,
      OLD.transit_days, OLD.estimated_delivery_at, OLD.meets_promise,
      OLD.selected, OLD.quote_snapshot, OLD.one_off_quote_id,
      OLD.one_off_offer_id, OLD.one_off_rate_evidence_global_id,
      OLD.one_off_currency
    )
  ) THEN
    RAISE EXCEPTION 'One-off carrier-rate authority is immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_carrier_rate_write
  ON operations_carrier_rates;
CREATE TRIGGER protect_operations_one_off_carrier_rate_write
BEFORE UPDATE OR DELETE ON operations_carrier_rates
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_carrier_rate();

-- Exact set equality between the immutable quote parcels and canonical plan
-- packages. Package ordinals, physical facts, and per-line quantities are all
-- compared; count-only authority is insufficient for a multi-package Ship.
CREATE OR REPLACE FUNCTION operations_one_off_plan_package_set_is_exact(
  authority_organization_id uuid,
  authority_plan_id uuid,
  authority_quote_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH quote_row AS (
    SELECT quote.packages_snapshot
    FROM operations_one_off_shipment_quotes quote
    JOIN operations_fulfillment_plans plan
      ON plan.organization_id = quote.organization_id
     AND plan.id = authority_plan_id
     AND plan.one_off_quote_id = quote.id
    WHERE quote.organization_id = authority_organization_id
      AND quote.id = authority_quote_id
  ), expected_packages AS (
    SELECT ordinality::integer AS package_number, package_snapshot
    FROM quote_row,
      jsonb_array_elements(packages_snapshot)
        WITH ORDINALITY AS item(package_snapshot, ordinality)
  ), actual_packages AS (
    SELECT package.id, package.package_number, package.length_mm,
           package.width_mm, package.height_mm, package.weight_grams
    FROM operations_packages package
    WHERE package.organization_id = authority_organization_id
      AND package.plan_id = authority_plan_id
  ), expected_contents AS (
    SELECT expected.package_number,
           allocation->>'lineKey' AS line_key,
           (allocation->>'quantity')::numeric AS quantity
    FROM expected_packages expected,
      jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(expected.package_snapshot->'allocations') = 'array'
            THEN expected.package_snapshot->'allocations'
          ELSE '[]'::jsonb
        END
      ) allocation
  ), actual_contents AS (
    SELECT package.package_number,
           line.external_line_id AS line_key,
           content.quantity
    FROM actual_packages package
    JOIN operations_package_contents content
      ON content.organization_id = authority_organization_id
     AND content.package_id = package.id
     AND content.plan_id = authority_plan_id
    JOIN operations_order_lines line
      ON line.organization_id = content.organization_id
     AND line.id = content.order_line_id
     AND line.order_id = content.order_id
  )
  SELECT EXISTS (SELECT 1 FROM quote_row)
    AND (SELECT count(*) FROM expected_packages)
      = (SELECT count(*) FROM actual_packages)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_packages expected
      FULL JOIN actual_packages actual
        ON actual.package_number = expected.package_number
      WHERE expected.package_number IS NULL
         OR actual.package_number IS NULL
         OR actual.length_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'length')::integer
         OR actual.width_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'width')::integer
         OR actual.height_mm IS DISTINCT FROM
              (expected.package_snapshot->'dimensionsMm'->>'height')::integer
         OR actual.weight_grams IS DISTINCT FROM
              (expected.package_snapshot->>'grossWeightGrams')::integer
    )
    AND NOT EXISTS (
      (SELECT * FROM expected_contents EXCEPT SELECT * FROM actual_contents)
      UNION ALL
      (SELECT * FROM actual_contents EXCEPT SELECT * FROM expected_contents)
    )
$$;

CREATE OR REPLACE FUNCTION operations_one_off_plan_execution_is_exact(
  authority_organization_id uuid,
  authority_plan_id uuid,
  required_execution_mode text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_orders source_order
      ON source_order.organization_id = plan.organization_id
     AND source_order.id = plan.order_id
    JOIN operations_carrier_rates rate
      ON rate.organization_id = plan.organization_id
     AND rate.plan_id = plan.id
     AND rate.selected = true
     AND rate.one_off_quote_id = plan.one_off_quote_id
     AND rate.one_off_offer_id = plan.one_off_offer_id
    JOIN operations_one_off_shipment_quote_offers offer
      ON offer.organization_id = rate.organization_id
     AND offer.quote_id = rate.one_off_quote_id
     AND offer.id = rate.one_off_offer_id
    WHERE plan.organization_id = authority_organization_id
      AND plan.id = authority_plan_id
      AND operations_one_off_plan_authority_is_valid(
        plan.organization_id, plan.order_id, plan.warehouse_id,
        plan.one_off_quote_id, plan.one_off_offer_id,
        required_execution_mode
      )
      AND operations_one_off_plan_package_set_is_exact(
        plan.organization_id, plan.id, plan.one_off_quote_id
      )
      AND source_order.currency = offer.currency
      AND rate.internal_cost_minor = offer.amount_minor
      AND rate.one_off_currency = offer.currency
      AND rate.one_off_rate_evidence_global_id = offer.rate_evidence_global_id
  )
$$;

CREATE OR REPLACE FUNCTION validate_operations_one_off_plan_package_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_plan_id uuid;
  linked_quote_id uuid;
  linked_organization_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'operations_fulfillment_plans' THEN
    linked_plan_id := NEW.id;
    linked_quote_id := NEW.one_off_quote_id;
    linked_organization_id := NEW.organization_id;
  ELSIF TG_TABLE_NAME = 'operations_packages' THEN
    linked_plan_id := COALESCE(NEW.plan_id, OLD.plan_id);
    linked_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
    SELECT plan.one_off_quote_id INTO linked_quote_id
    FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = linked_organization_id
      AND plan.id = linked_plan_id;
  ELSE
    linked_plan_id := COALESCE(NEW.plan_id, OLD.plan_id);
    linked_organization_id := COALESCE(NEW.organization_id, OLD.organization_id);
    SELECT plan.one_off_quote_id INTO linked_quote_id
    FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = linked_organization_id
      AND plan.id = linked_plan_id;
  END IF;
  IF linked_quote_id IS NULL THEN RETURN NULL; END IF;
  IF NOT operations_one_off_plan_package_set_is_exact(
    linked_organization_id, linked_plan_id, linked_quote_id
  ) THEN
    RAISE EXCEPTION
      'One-off canonical package set must exactly match its immutable quote parcels';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_plan_package_set_deferred
  ON operations_fulfillment_plans;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_plan_package_set_deferred
AFTER INSERT OR UPDATE ON operations_fulfillment_plans
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_plan_package_set();

DROP TRIGGER IF EXISTS validate_operations_one_off_package_set_deferred
  ON operations_packages;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_package_set_deferred
AFTER INSERT OR UPDATE OR DELETE ON operations_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_plan_package_set();

DROP TRIGGER IF EXISTS validate_operations_one_off_package_content_set_deferred
  ON operations_package_contents;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_package_content_set_deferred
AFTER INSERT OR UPDATE OR DELETE ON operations_package_contents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_plan_package_set();

CREATE OR REPLACE FUNCTION protect_operations_one_off_package_geometry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM operations_fulfillment_plans plan
    WHERE plan.organization_id = OLD.organization_id
      AND plan.id = OLD.plan_id
      AND plan.one_off_quote_id IS NOT NULL
  ) AND (
    TG_OP = 'DELETE'
    OR ROW(
      NEW.organization_id, NEW.plan_id, NEW.package_number,
      NEW.length_mm, NEW.width_mm, NEW.height_mm, NEW.weight_grams
    ) IS DISTINCT FROM ROW(
      OLD.organization_id, OLD.plan_id, OLD.package_number,
      OLD.length_mm, OLD.width_mm, OLD.height_mm, OLD.weight_grams
    )
  ) THEN
    RAISE EXCEPTION 'One-off canonical package facts are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_package_geometry_write
  ON operations_packages;
CREATE TRIGGER protect_operations_one_off_package_geometry_write
BEFORE UPDATE OR DELETE ON operations_packages
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_package_geometry();

CREATE OR REPLACE FUNCTION validate_ops_plan_cartonization_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_sealed_at timestamptz;
  linked_mode text;
  linked_status text;
  linked_warehouse_id uuid;
  linked_candidate_order_id uuid;
  linked_candidate_state text;
  linked_candidate_source_hash text;
  evidence_candidate_source_hash text;
  linked_carrier_read_environment text;
  activation_state text;
  active_sandbox_e2e_authorization boolean;
  valid_one_off_authority boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'operations:activation:' || NEW.organization_id::text,
      0
    )
  );

  IF TG_OP = 'UPDATE' AND (
    (OLD.cartonization_evidence_id IS NOT NULL AND
      NEW.cartonization_evidence_id IS DISTINCT FROM OLD.cartonization_evidence_id)
    OR NEW.one_off_quote_id IS DISTINCT FROM OLD.one_off_quote_id
    OR NEW.one_off_offer_id IS DISTINCT FROM OLD.one_off_offer_id
  ) THEN
    RAISE EXCEPTION
      'An accepted fulfillment plan carrier-rate evidence link is immutable';
  END IF;

  IF NEW.cartonization_evidence_id IS NOT NULL
     AND NEW.one_off_quote_id IS NOT NULL THEN
    RAISE EXCEPTION
      'A fulfillment plan must use exactly one carrier-rate authority';
  END IF;

  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
    WHERE sandbox_auth.organization_id = NEW.organization_id
      AND sandbox_auth.order_id = NEW.order_id
      AND operations_sandbox_commerce_e2e_authorization_is_current(
        sandbox_auth.organization_id, sandbox_auth.id, sandbox_auth.order_id
      )
  ) INTO active_sandbox_e2e_authorization;

  valid_one_off_authority := NEW.one_off_quote_id IS NOT NULL
    AND activation_state IN ('shadow', 'active')
    AND operations_one_off_plan_authority_is_valid(
      NEW.organization_id, NEW.order_id, NEW.warehouse_id,
      NEW.one_off_quote_id, NEW.one_off_offer_id,
      CASE
        WHEN activation_state = 'active' THEN 'live'
        WHEN activation_state = 'shadow' THEN 'test'
        ELSE NULL
      END
    );

  IF NEW.one_off_quote_id IS NOT NULL AND NOT valid_one_off_authority THEN
    RAISE EXCEPTION
      'One-off fulfillment plan authority is missing, mismatched, stale, or non-production in Active mode';
  END IF;

  IF NEW.cartonization_evidence_id IS NULL THEN
    IF activation_state = 'active'
       AND (
         NEW.status IN ('planned', 'released')
         OR (TG_OP = 'UPDATE'
             AND OLD.status IN ('planned', 'released')
             AND NEW.status = 'fulfilled')
       )
       AND NOT active_sandbox_e2e_authorization
       AND NOT valid_one_off_authority
    THEN
      RAISE EXCEPTION
        'Active fulfillment planning requires sealed production carrier-read evidence';
    END IF;
    RETURN NEW;
  END IF;

  SELECT evidence.sealed_at, evidence.evidence_mode, evidence.status,
         evidence.warehouse_id, candidate.canonical_order_id,
         candidate.workflow_state, candidate.source_hash,
         evidence.candidate_source_hash,
         evidence.plan_snapshot->>'carrierReadEnvironment'
  INTO linked_sealed_at, linked_mode, linked_status,
       linked_warehouse_id, linked_candidate_order_id,
       linked_candidate_state, linked_candidate_source_hash,
       evidence_candidate_source_hash, linked_carrier_read_environment
  FROM operations_cartonization_rate_evidence evidence
  JOIN operations_commerce_order_candidates candidate
    ON candidate.organization_id = evidence.organization_id
   AND candidate.integration_account_id = evidence.integration_account_id
   AND candidate.id = evidence.order_candidate_id
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.cartonization_evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence was not found in this organization';
  END IF;
  IF linked_sealed_at IS NULL THEN
    RAISE EXCEPTION 'Fulfillment planning requires sealed cartonization evidence';
  END IF;
  IF linked_mode IS DISTINCT FROM 'operational' THEN
    RAISE EXCEPTION 'Assumption-backed sandbox evidence cannot become a fulfillment plan';
  END IF;
  IF activation_state = 'active'
     AND linked_carrier_read_environment IS DISTINCT FROM 'production'
     AND NOT active_sandbox_e2e_authorization THEN
    RAISE EXCEPTION 'Active fulfillment planning requires production carrier-read evidence';
  END IF;
  IF linked_status NOT IN ('succeeded', 'partial') THEN
    RAISE EXCEPTION 'Failed cartonization evidence cannot become a fulfillment plan';
  END IF;
  IF linked_warehouse_id IS DISTINCT FROM NEW.warehouse_id THEN
    RAISE EXCEPTION 'Fulfillment plan warehouse must match its cartonization evidence';
  END IF;
  IF linked_candidate_state IS DISTINCT FROM 'promoted'
     OR linked_candidate_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'Fulfillment plan evidence must belong to the promoted canonical order';
  END IF;
  IF linked_candidate_source_hash IS DISTINCT FROM evidence_candidate_source_hash THEN
    RAISE EXCEPTION 'Fulfillment plan cartonization evidence is stale';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_ops_activation_canonical_plans()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE incompatible_plan_global_id text;
BEGIN
  IF NEW.state IS DISTINCT FROM 'active' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('operations:activation:' || NEW.organization_id::text, 0)
  );
  SELECT plan.global_id INTO incompatible_plan_global_id
  FROM operations_fulfillment_plans plan
  JOIN operations_orders source_order
    ON source_order.organization_id = plan.organization_id
   AND source_order.id = plan.order_id
  LEFT JOIN operations_cartonization_rate_evidence evidence
    ON evidence.organization_id = plan.organization_id
   AND evidence.id = plan.cartonization_evidence_id
  WHERE plan.organization_id = NEW.organization_id
    AND plan.status IN ('planned', 'released')
    AND source_order.status NOT IN ('shipped', 'cancelled')
    AND NOT (
      plan.cartonization_evidence_id IS NOT NULL
      AND evidence.plan_snapshot->>'carrierReadEnvironment' = 'production'
    )
    AND NOT operations_one_off_plan_execution_is_exact(
      plan.organization_id, plan.id, 'live'
    )
    AND NOT EXISTS (
      SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations sandbox_auth
      WHERE sandbox_auth.organization_id = plan.organization_id
        AND sandbox_auth.order_id = plan.order_id
        AND operations_sandbox_commerce_e2e_authorization_is_current(
          sandbox_auth.organization_id, sandbox_auth.id, sandbox_auth.order_id
        )
    )
  ORDER BY plan.created_at, plan.id LIMIT 1;
  IF incompatible_plan_global_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Active Operations cannot retain missing or non-production carrier-read plan %',
      incompatible_plan_global_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS operations_one_off_shipment_rate_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gora'),
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  quote_idempotency_key text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  environment text NOT NULL CHECK (environment = 'production'),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'succeeded', 'failed', 'unknown')),
  adapter_version text NOT NULL,
  attempt_idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_reference text,
  error_code text,
  rate_evidence_global_id text,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_rate_attempt_global_valid
    CHECK (global_id ~ '^gora(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_rate_attempt_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_rate_attempt_registry_fkey
    FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_rate_attempt_command_fkey
    FOREIGN KEY (organization_id, quote_idempotency_key)
    REFERENCES operations_one_off_shipment_quote_commands(
      organization_id, idempotency_key
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_rate_attempt_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_rate_attempt_carrier_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_rate_attempt_rate_evidence_fkey
    FOREIGN KEY (organization_id, rate_evidence_global_id)
    REFERENCES operations_carrier_rate_requests(organization_id, global_id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_rate_attempt_idempotency_unique
    UNIQUE (organization_id, attempt_idempotency_key),
  CONSTRAINT operations_one_off_rate_attempt_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_rate_attempt_state_valid CHECK (
    (
      state = 'prepared'
      AND completed_at IS NULL
      AND error_code IS NULL
      AND rate_evidence_global_id IS NULL
    ) OR (
      state = 'succeeded'
      AND completed_at IS NOT NULL
      AND error_code IS NULL
      AND rate_evidence_global_id IS NOT NULL
    ) OR (
      state IN ('failed', 'unknown')
      AND completed_at IS NOT NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
      AND rate_evidence_global_id IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  operations_one_off_rate_attempts_unresolved_semantic_unique
ON operations_one_off_shipment_rate_attempts (
  organization_id, provider, request_hash
)
WHERE state IN ('prepared', 'unknown');

CREATE OR REPLACE FUNCTION protect_operations_one_off_rate_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off carrier rate attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.quote_idempotency_key,
    NEW.provider, NEW.integration_account_id, NEW.carrier_account_id,
    NEW.environment, NEW.adapter_version, NEW.attempt_idempotency_key,
    NEW.request_hash, NEW.redacted_request, NEW.actor_email,
    NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.quote_idempotency_key,
    OLD.provider, OLD.integration_account_id, OLD.carrier_account_id,
    OLD.environment, OLD.adapter_version, OLD.attempt_idempotency_key,
    OLD.request_hash, OLD.redacted_request, OLD.actor_email,
    OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'One-off carrier rate request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'One-off carrier rate attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_rate_attempt_write
  ON operations_one_off_shipment_rate_attempts;
CREATE TRIGGER protect_operations_one_off_rate_attempt_write
BEFORE UPDATE OR DELETE ON operations_one_off_shipment_rate_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_rate_attempt();

-- The Active-dispatch tables from migration 0179 are intentionally bound to
-- production Active execution rows. Native one-off TEST and LIVE plans use the
-- same whole-group invariants here, but reference their canonical plan and
-- consumed one-off authority directly rather than fabricating Active rows.
CREATE TABLE IF NOT EXISTS operations_one_off_carrier_group_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gocg'),
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  planning_quote_id uuid NOT NULL,
  planning_offer_id uuid NOT NULL,
  purchase_quote_id uuid NOT NULL,
  purchase_offer_id uuid NOT NULL,
  carrier_rate_id uuid NOT NULL,
  integration_account_id uuid NOT NULL,
  carrier_account_id uuid NOT NULL,
  create_attempt_id uuid,
  action text NOT NULL CHECK (action IN ('create', 'void', 'close_sample')),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'succeeded', 'failed', 'unknown')),
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  provider text NOT NULL CHECK (provider IN ('ups_rest', 'fedex_rest')),
  service_code text NOT NULL,
  package_count integer NOT NULL CHECK (package_count BETWEEN 1 AND 40),
  selected_amount_minor bigint NOT NULL CHECK (selected_amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_charge_minor bigint CHECK (provider_charge_minor >= 0),
  provider_charge_currency text,
  charge_variance_minor bigint,
  adapter_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  redacted_request jsonb NOT NULL,
  redacted_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  master_tracking_number text,
  provider_shipment_id text,
  provider_reference text,
  error_code text,
  reason text NOT NULL,
  actor_email text REFERENCES app_users(email) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_group_global_valid
    CHECK (global_id ~ '^gocg(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_group_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_group_registry_fkey FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_order_plan_fkey
    FOREIGN KEY (organization_id, order_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_planning_offer_fkey
    FOREIGN KEY (organization_id, planning_quote_id, planning_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_purchase_offer_fkey
    FOREIGN KEY (organization_id, purchase_quote_id, purchase_offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_rate_fkey
    FOREIGN KEY (organization_id, carrier_rate_id)
    REFERENCES operations_carrier_rates(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_integration_fkey
    FOREIGN KEY (organization_id, integration_account_id)
    REFERENCES operations_integration_accounts(organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_account_fkey
    FOREIGN KEY (organization_id, integration_account_id, carrier_account_id)
    REFERENCES operations_carrier_accounts(
      organization_id, integration_account_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_group_lineage_unique
    UNIQUE (organization_id, id, order_id, plan_id),
  CONSTRAINT operations_one_off_group_idempotency_unique
    UNIQUE (organization_id, action, idempotency_key),
  CONSTRAINT operations_one_off_group_action_valid CHECK (
    (action = 'create' AND create_attempt_id IS NULL)
    OR (action IN ('void', 'close_sample') AND create_attempt_id IS NOT NULL)
  ),
  CONSTRAINT operations_one_off_group_provider_charge_valid CHECK (
    (
      provider_charge_minor IS NULL
      AND provider_charge_currency IS NULL
      AND charge_variance_minor IS NULL
    ) OR (
      provider_charge_minor IS NOT NULL
      AND provider_charge_currency ~ '^[A-Z]{3}$'
      AND (
        (
          provider_charge_currency = currency
          AND charge_variance_minor = provider_charge_minor - selected_amount_minor
        )
        OR (
          provider_charge_currency <> currency
          AND charge_variance_minor IS NULL
        )
      )
    )
  ),
  CONSTRAINT operations_one_off_group_completion_valid CHECK (
    (state = 'prepared' AND completed_at IS NULL AND error_code IS NULL)
    OR (
      state = 'succeeded' AND completed_at IS NOT NULL
      AND error_code IS NULL AND provider_shipment_id IS NOT NULL
      AND master_tracking_number IS NOT NULL
    )
    OR (
      state IN ('failed', 'unknown') AND completed_at IS NOT NULL
      AND NULLIF(btrim(error_code), '') IS NOT NULL
    )
  ),
  CONSTRAINT operations_one_off_group_text_valid CHECK (
    length(btrim(service_code)) BETWEEN 1 AND 128
    AND length(btrim(adapter_version)) BETWEEN 1 AND 100
    AND length(btrim(idempotency_key)) BETWEEN 8 AND 200
    AND length(btrim(reason)) BETWEEN 3 AND 500
  )
);

CREATE OR REPLACE FUNCTION operations_one_off_package_snapshot_hash(
  snapshot_organization_id uuid,
  snapshot_plan_id uuid,
  snapshot_package_id uuid,
  snapshot_quote_id uuid
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH package_row AS (
    SELECT package.package_number, package.length_mm, package.width_mm,
           package.height_mm, package.weight_grams
    FROM operations_packages package
    WHERE package.organization_id = snapshot_organization_id
      AND package.plan_id = snapshot_plan_id
      AND package.id = snapshot_package_id
  ), current_allocations AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'lineKey', order_line.external_line_id,
        'quantity', content.quantity
      ) ORDER BY order_line.external_line_id
    ), '[]'::jsonb) AS value
    FROM operations_package_contents content
    JOIN operations_order_lines order_line
      ON order_line.organization_id = content.organization_id
     AND order_line.id = content.order_line_id
    WHERE content.organization_id = snapshot_organization_id
      AND content.plan_id = snapshot_plan_id
      AND content.package_id = snapshot_package_id
  ), quote_parcel AS (
    SELECT quote.packages_snapshot->(package_row.package_number - 1) AS value
    FROM operations_one_off_shipment_quotes quote
    CROSS JOIN package_row
    WHERE quote.organization_id = snapshot_organization_id
      AND quote.id = snapshot_quote_id
  ), normalized AS (
    SELECT jsonb_build_object(
      'packageKey', quote_parcel.value->>'packageKey',
      'packageNumber', package_row.package_number,
      'dimensionsMm', jsonb_build_object(
        'length', package_row.length_mm,
        'width', package_row.width_mm,
        'height', package_row.height_mm
      ),
      'grossWeightGrams', package_row.weight_grams,
      'allocations', current_allocations.value
    ) AS value
    FROM package_row, current_allocations, quote_parcel
    WHERE jsonb_typeof(quote_parcel.value) = 'object'
  )
  SELECT encode(digest(convert_to(normalized.value::text, 'UTF8'), 'sha256'), 'hex')
  FROM normalized
$$;

ALTER TABLE operations_one_off_carrier_group_attempts
  DROP CONSTRAINT IF EXISTS operations_one_off_group_create_attempt_fkey,
  ADD CONSTRAINT operations_one_off_group_create_attempt_fkey
    FOREIGN KEY (organization_id, create_attempt_id)
    REFERENCES operations_one_off_carrier_group_attempts(organization_id, id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS operations_one_off_group_void_idempotency_unique
ON operations_one_off_carrier_group_attempts (organization_id, idempotency_key)
WHERE action IN ('void', 'close_sample');

CREATE UNIQUE INDEX IF NOT EXISTS operations_one_off_group_open_create_unique
ON operations_one_off_carrier_group_attempts (organization_id, order_id, plan_id)
WHERE action = 'create' AND state IN ('prepared', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS operations_one_off_group_open_void_unique
ON operations_one_off_carrier_group_attempts (organization_id, create_attempt_id)
WHERE action IN ('void', 'close_sample')
  AND state IN ('prepared', 'succeeded', 'unknown');

CREATE TABLE IF NOT EXISTS operations_one_off_purchase_quote_consumptions (
  organization_id uuid NOT NULL
    REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  carrier_group_attempt_id uuid NOT NULL,
  reason text NOT NULL,
  consumed_by text REFERENCES app_users(email) ON DELETE SET NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, quote_id),
  CONSTRAINT operations_one_off_purchase_consumption_offer_fkey
    FOREIGN KEY (organization_id, quote_id, offer_id)
    REFERENCES operations_one_off_shipment_quote_offers(
      organization_id, quote_id, id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_purchase_consumption_plan_fkey
    FOREIGN KEY (organization_id, order_id, plan_id)
    REFERENCES operations_fulfillment_plans(organization_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_purchase_consumption_attempt_fkey
    FOREIGN KEY (
      organization_id, carrier_group_attempt_id, order_id, plan_id
    ) REFERENCES operations_one_off_carrier_group_attempts(
      organization_id, id, order_id, plan_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_purchase_consumption_attempt_unique
    UNIQUE (organization_id, carrier_group_attempt_id),
  CONSTRAINT operations_one_off_purchase_consumption_reason_valid CHECK (
    length(btrim(reason)) BETWEEN 3 AND 500
    AND reason !~ '[[:cntrl:]]'
  )
);

DROP TRIGGER IF EXISTS protect_operations_one_off_purchase_consumption_write
  ON operations_one_off_purchase_quote_consumptions;
CREATE TRIGGER protect_operations_one_off_purchase_consumption_write
BEFORE UPDATE OR DELETE ON operations_one_off_purchase_quote_consumptions
FOR EACH ROW EXECUTE FUNCTION protect_operations_append_only();

CREATE TABLE IF NOT EXISTS operations_one_off_carrier_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gocm'),
  organization_id uuid NOT NULL,
  carrier_group_attempt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_number integer NOT NULL CHECK (package_number > 0),
  quote_package_key text NOT NULL,
  length_mm integer NOT NULL CHECK (length_mm > 0),
  width_mm integer NOT NULL CHECK (width_mm > 0),
  height_mm integer NOT NULL CHECK (height_mm > 0),
  weight_grams integer NOT NULL CHECK (weight_grams > 0),
  allocated_selected_cost_minor bigint NOT NULL CHECK (
    allocated_selected_cost_minor >= 0
  ),
  parcel_snapshot_hash text NOT NULL CHECK (
    parcel_snapshot_hash ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_group_member_global_valid
    CHECK (global_id ~ '^gocm(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_group_member_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_group_member_registry_fkey FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_member_attempt_fkey
    FOREIGN KEY (
      organization_id, carrier_group_attempt_id, order_id, plan_id
    ) REFERENCES operations_one_off_carrier_group_attempts(
      organization_id, id, order_id, plan_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_member_package_fkey
    FOREIGN KEY (organization_id, plan_id, package_id)
    REFERENCES operations_packages(organization_id, plan_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_member_package_unique
    UNIQUE (organization_id, carrier_group_attempt_id, package_id),
  CONSTRAINT operations_one_off_group_member_number_unique
    UNIQUE (organization_id, carrier_group_attempt_id, package_number),
  CONSTRAINT operations_one_off_group_member_key_unique
    UNIQUE (organization_id, carrier_group_attempt_id, quote_package_key),
  CONSTRAINT operations_one_off_group_member_org_id_unique
    UNIQUE (organization_id, id)
);

ALTER TABLE operations_labels
  ADD COLUMN IF NOT EXISTS one_off_carrier_group_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS one_off_void_group_attempt_id uuid,
  DROP CONSTRAINT IF EXISTS operations_labels_one_off_group_attempt_fkey,
  ADD CONSTRAINT operations_labels_one_off_group_attempt_fkey
    FOREIGN KEY (organization_id, one_off_carrier_group_attempt_id)
    REFERENCES operations_one_off_carrier_group_attempts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_one_off_void_group_attempt_fkey,
  ADD CONSTRAINT operations_labels_one_off_void_group_attempt_fkey
    FOREIGN KEY (organization_id, one_off_void_group_attempt_id)
    REFERENCES operations_one_off_carrier_group_attempts(organization_id, id)
    ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS operations_labels_one_off_group_source_valid,
  ADD CONSTRAINT operations_labels_one_off_group_source_valid CHECK (
    (
      one_off_carrier_group_attempt_id IS NULL
      AND one_off_void_group_attempt_id IS NULL
    )
    OR (
      create_attempt_id IS NULL
      AND void_attempt_id IS NULL
      AND active_carrier_group_attempt_id IS NULL
      AND active_fulfillment_execution_id IS NULL
      AND active_shipment_group_id IS NULL
      AND fulfillment_execution_id IS NULL
      AND shipment_group_id IS NULL
      AND (
        (
          status = 'created'
          AND one_off_void_group_attempt_id IS NULL
          AND voided_at IS NULL
          AND voided_by IS NULL
        )
        OR (
          status = 'voided'
          AND one_off_void_group_attempt_id IS NOT NULL
          AND voided_at IS NOT NULL
        )
      )
    )
  );

-- UPS CIE returns one documented masked tracking value for all TEST packages.
-- Production tracking remains unique; sandbox identity is group+package.
ALTER TABLE operations_labels
  DROP CONSTRAINT IF EXISTS operations_labels_tracking_unique;
CREATE UNIQUE INDEX IF NOT EXISTS operations_labels_production_tracking_unique
ON operations_labels (carrier, tracking_number)
WHERE environment = 'production';

CREATE UNIQUE INDEX IF NOT EXISTS operations_labels_sandbox_tracking_unique
ON operations_labels (carrier, tracking_number)
WHERE environment = 'sandbox'
  AND NOT (
    lower(carrier) IN ('ups', 'ups_rest')
    AND tracking_number ~* '^1Z[X]{16}$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS operations_labels_one_off_group_package_unique
ON operations_labels (
  organization_id, one_off_carrier_group_attempt_id, package_id
)
WHERE one_off_carrier_group_attempt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operations_one_off_carrier_group_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_id text NOT NULL DEFAULT allocate_global_reference('gocr'),
  organization_id uuid NOT NULL,
  carrier_group_attempt_id uuid NOT NULL,
  package_id uuid NOT NULL,
  package_number integer NOT NULL CHECK (package_number > 0),
  label_id uuid NOT NULL,
  tracking_number text NOT NULL,
  provider_package_reference text NOT NULL,
  redacted_provider_evidence jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operations_one_off_group_result_global_valid
    CHECK (global_id ~ '^gocr(?:[0-9]{7}|[0-9a-v]{12})$'),
  CONSTRAINT operations_one_off_group_result_global_unique UNIQUE (global_id),
  CONSTRAINT operations_one_off_group_result_registry_fkey FOREIGN KEY (global_id)
    REFERENCES crm_reference_registry(reference_code) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_result_member_fkey
    FOREIGN KEY (
      organization_id, carrier_group_attempt_id, package_id
    ) REFERENCES operations_one_off_carrier_group_members(
      organization_id, carrier_group_attempt_id, package_id
    ) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_result_label_fkey
    FOREIGN KEY (organization_id, label_id)
    REFERENCES operations_labels(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT operations_one_off_group_result_package_unique
    UNIQUE (organization_id, carrier_group_attempt_id, package_id),
  CONSTRAINT operations_one_off_group_result_label_unique
    UNIQUE (organization_id, label_id),
  CONSTRAINT operations_one_off_group_result_org_id_unique
    UNIQUE (organization_id, id),
  CONSTRAINT operations_one_off_group_result_text_valid CHECK (
    length(btrim(tracking_number)) BETWEEN 3 AND 160
    AND length(btrim(provider_package_reference)) BETWEEN 1 AND 200
    AND jsonb_typeof(redacted_provider_evidence) = 'object'
  )
);

ALTER TABLE operations_shipments
  ADD COLUMN IF NOT EXISTS one_off_carrier_group_attempt_id uuid,
  DROP CONSTRAINT IF EXISTS operations_shipments_one_off_group_attempt_fkey,
  ADD CONSTRAINT operations_shipments_one_off_group_attempt_fkey
    FOREIGN KEY (organization_id, one_off_carrier_group_attempt_id)
    REFERENCES operations_one_off_carrier_group_attempts(organization_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_shipment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operations:one-off-carrier-group:' || NEW.organization_id::text
      || ':' || NEW.order_id::text,
    0
  ));
  IF TG_OP = 'UPDATE' AND NEW.one_off_carrier_group_attempt_id
      IS DISTINCT FROM OLD.one_off_carrier_group_attempt_id THEN
    RAISE EXCEPTION 'One-off shipment group lineage is immutable';
  END IF;
  IF NEW.one_off_carrier_group_attempt_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM operations_labels label
      WHERE label.organization_id = NEW.organization_id
        AND label.id = NEW.label_id
        AND label.one_off_carrier_group_attempt_id IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans plan
      WHERE plan.organization_id = NEW.organization_id
        AND plan.id = NEW.plan_id
        AND plan.order_id = NEW.order_id
        AND plan.one_off_quote_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'A native one-off shipment requires the exact carrier group lineage';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.active_fulfillment_execution_id IS NOT NULL
     OR NEW.active_shipment_group_id IS NOT NULL
     OR NEW.active_carrier_group_attempt_id IS NOT NULL
     OR NEW.fulfillment_execution_id IS NOT NULL
     OR NEW.shipment_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'One-off shipment cannot mix carrier execution lineages';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts attempt
    JOIN operations_activation_scopes activation
      ON activation.organization_id = attempt.organization_id
    JOIN operations_one_off_carrier_group_members member
      ON member.organization_id = attempt.organization_id
     AND member.carrier_group_attempt_id = attempt.id
     AND member.package_id = NEW.package_id
    JOIN operations_one_off_carrier_group_results result
      ON result.organization_id = member.organization_id
     AND result.carrier_group_attempt_id = member.carrier_group_attempt_id
     AND result.package_id = member.package_id
    JOIN operations_labels label
      ON label.organization_id = result.organization_id
     AND label.id = result.label_id
     AND label.id = NEW.label_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.one_off_carrier_group_attempt_id
      AND attempt.order_id = NEW.order_id
      AND attempt.plan_id = NEW.plan_id
      AND attempt.action = 'create'
      AND attempt.state = 'succeeded'
      AND (
        (
          attempt.environment = 'sandbox'
          AND activation.state = 'shadow'
          AND operations_one_off_plan_execution_is_exact(
            attempt.organization_id, attempt.plan_id, 'test'
          )
        ) OR (
          attempt.environment = 'production'
          AND activation.state = 'active'
          AND operations_one_off_plan_execution_is_exact(
            attempt.organization_id, attempt.plan_id, 'live'
          )
        )
      )
      AND label.status = 'created'
      AND label.one_off_void_group_attempt_id IS NULL
      AND label.carrier = CASE attempt.provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
      AND label.service_code = attempt.service_code
      AND label.tracking_number = NEW.tracking_number
      AND NEW.quoted_carrier_cost_minor
        = member.allocated_selected_cost_minor
      AND (
        SELECT COALESCE(sum(group_member.allocated_selected_cost_minor), 0)
        FROM operations_one_off_carrier_group_members group_member
        WHERE group_member.organization_id = attempt.organization_id
          AND group_member.carrier_group_attempt_id = attempt.id
      ) = attempt.selected_amount_minor
      AND NOT EXISTS (
        SELECT 1
        FROM operations_one_off_carrier_group_attempts closed
        WHERE closed.organization_id = attempt.organization_id
          AND closed.create_attempt_id = attempt.id
          AND closed.action IN ('void', 'close_sample')
          AND closed.state IN ('prepared', 'succeeded', 'unknown')
      )
  ) THEN
    RAISE EXCEPTION
      'One-off shipment requires an exact complete active carrier group for its execution mode';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_group_shipment_write
  ON operations_shipments;
CREATE TRIGGER validate_operations_one_off_group_shipment_write
BEFORE INSERT OR UPDATE ON operations_shipments
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_shipment();

CREATE OR REPLACE FUNCTION protect_operations_one_off_group_shipment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.one_off_carrier_group_attempt_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'One-off carrier group shipments cannot be deleted';
  END IF;
  -- Shipment lifecycle status may advance, but the exact group membership,
  -- label, tracking identity, selected-cost allocation, and audit facts may
  -- never be rewritten after confirmation.
  IF (to_jsonb(NEW) - 'status')
      IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION
      'One-off carrier group shipment identity and cost are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_group_shipment_write
  ON operations_shipments;
CREATE TRIGGER protect_operations_one_off_group_shipment_write
BEFORE UPDATE OR DELETE ON operations_shipments
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_shipment();

CREATE OR REPLACE FUNCTION operations_one_off_purchase_quote_is_valid(
  authority_organization_id uuid,
  authority_plan_id uuid,
  authority_purchase_quote_id uuid,
  authority_purchase_offer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operations_fulfillment_plans plan
    JOIN operations_one_off_shipment_quotes planning_quote
      ON planning_quote.organization_id = plan.organization_id
     AND planning_quote.id = plan.one_off_quote_id
    JOIN operations_one_off_shipment_quote_offers planning_offer
      ON planning_offer.organization_id = plan.organization_id
     AND planning_offer.quote_id = plan.one_off_quote_id
     AND planning_offer.id = plan.one_off_offer_id
    JOIN operations_one_off_shipment_quotes purchase_quote
      ON purchase_quote.organization_id = plan.organization_id
     AND purchase_quote.id = authority_purchase_quote_id
    JOIN operations_one_off_shipment_quote_offers purchase_offer
      ON purchase_offer.organization_id = purchase_quote.organization_id
     AND purchase_offer.quote_id = purchase_quote.id
     AND purchase_offer.id = authority_purchase_offer_id
    JOIN operations_carrier_rate_requests evidence
      ON evidence.organization_id = purchase_offer.organization_id
     AND evidence.global_id = purchase_offer.rate_evidence_global_id
    WHERE plan.organization_id = authority_organization_id
      AND plan.id = authority_plan_id
      AND purchase_quote.id <> planning_quote.id
      AND purchase_quote.packed_rerate_order_id = plan.order_id
      AND purchase_quote.packed_rerate_plan_id = plan.id
      AND purchase_quote.expires_at > clock_timestamp()
      AND purchase_quote.status IN ('succeeded', 'partial')
      AND purchase_quote.execution_mode = planning_quote.execution_mode
      AND purchase_quote.rate_environment = planning_quote.rate_environment
      AND purchase_quote.warehouse_id = planning_quote.warehouse_id
      AND purchase_quote.customer_id = planning_quote.customer_id
      AND purchase_quote.inventory_pool_id = planning_quote.inventory_pool_id
      AND purchase_quote.receiving_location_id = planning_quote.receiving_location_id
      AND purchase_quote.currency = planning_quote.currency
      AND purchase_quote.destination_hash = planning_quote.destination_hash
      AND purchase_quote.packages_hash = planning_quote.packages_hash
      AND jsonb_array_length(purchase_quote.packages_snapshot) BETWEEN 1 AND 40
      AND NOT EXISTS (
        SELECT 1 FROM operations_one_off_purchase_quote_consumptions used
        WHERE used.organization_id = purchase_quote.organization_id
          AND used.quote_id = purchase_quote.id
      )
      AND purchase_offer.provider = planning_offer.provider
      AND purchase_offer.service_code = planning_offer.service_code
      AND purchase_offer.integration_account_id = planning_offer.integration_account_id
      AND purchase_offer.carrier_account_id = planning_offer.carrier_account_id
      AND purchase_offer.environment = planning_offer.environment
      AND purchase_offer.currency = planning_offer.currency
      AND evidence.status = 'succeeded'
      AND evidence.provider = purchase_offer.provider
      AND evidence.environment = purchase_offer.environment
      AND evidence.integration_account_id = purchase_offer.integration_account_id
      AND evidence.carrier_account_id = purchase_offer.carrier_account_id
      AND evidence.request_hash = purchase_offer.carrier_request_hash
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(evidence.redacted_response->'rates') = 'array'
            THEN evidence.redacted_response->'rates' ELSE '[]'::jsonb END
        ) retained_rate
        WHERE retained_rate->>'serviceCode' = purchase_offer.service_code
          AND upper(retained_rate->>'currency') = purchase_offer.currency
          AND retained_rate->>'amount' ~ '^[0-9]+(?:\.[0-9]{1,4})?$'
          AND round((retained_rate->>'amount')::numeric * 100)::bigint
            = purchase_offer.amount_minor
      )
  )
$$;

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_prepare()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_state text;
  linked_create operations_one_off_carrier_group_attempts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'operations:one-off-carrier-group:' || NEW.organization_id::text
      || ':' || NEW.order_id::text,
    0
  ));
  SELECT activation.state INTO activation_state
  FROM operations_activation_scopes activation
  WHERE activation.organization_id = NEW.organization_id;
  IF NEW.action = 'create' AND (
    (NEW.environment = 'production' AND activation_state <> 'active')
    OR (NEW.environment = 'sandbox' AND activation_state <> 'shadow')
  ) THEN
    RAISE EXCEPTION
      'One-off carrier group environment does not match Operations activation';
  END IF;
  IF NEW.action = 'create' THEN
    IF EXISTS (
      SELECT 1
      FROM operations_one_off_carrier_group_attempts prior_create
      WHERE prior_create.organization_id = NEW.organization_id
        AND prior_create.order_id = NEW.order_id
        AND prior_create.plan_id = NEW.plan_id
        AND prior_create.action = 'create'
        AND prior_create.state = 'succeeded'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_attempts prior_close
          WHERE prior_close.organization_id = prior_create.organization_id
            AND prior_close.create_attempt_id = prior_create.id
            AND prior_close.action IN ('void', 'close_sample')
            AND prior_close.state = 'succeeded'
        )
    ) THEN
      RAISE EXCEPTION
        'An active successful one-off carrier group must be voided before repurchase';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM operations_packages package
      JOIN operations_labels label
        ON label.organization_id = package.organization_id
       AND label.package_id = package.id
      WHERE package.organization_id = NEW.organization_id
        AND package.plan_id = NEW.plan_id
        AND label.status = 'created'
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase cannot begin with a competing active label';
    END IF;
    IF NOT operations_one_off_plan_execution_is_exact(
      NEW.organization_id, NEW.plan_id,
      CASE WHEN NEW.environment = 'production' THEN 'live' ELSE 'test' END
    ) OR NOT operations_one_off_purchase_quote_is_valid(
      NEW.organization_id, NEW.plan_id,
      NEW.purchase_quote_id, NEW.purchase_offer_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM operations_fulfillment_plans plan
      JOIN operations_orders source_order
        ON source_order.organization_id = plan.organization_id
       AND source_order.id = plan.order_id
      JOIN operations_one_off_shipment_quote_offers purchase_offer
        ON purchase_offer.organization_id = plan.organization_id
       AND purchase_offer.quote_id = NEW.purchase_quote_id
       AND purchase_offer.id = NEW.purchase_offer_id
      WHERE plan.organization_id = NEW.organization_id
        AND plan.id = NEW.plan_id
        AND plan.order_id = NEW.order_id
        AND plan.one_off_quote_id = NEW.planning_quote_id
        AND plan.one_off_offer_id = NEW.planning_offer_id
        AND source_order.status = 'packed'
        AND NEW.integration_account_id = purchase_offer.integration_account_id
        AND NEW.carrier_account_id = purchase_offer.carrier_account_id
        AND NEW.provider = purchase_offer.provider
        AND NEW.service_code = purchase_offer.service_code
        AND NEW.selected_amount_minor = purchase_offer.amount_minor
        AND NEW.currency = purchase_offer.currency
        AND NEW.package_count = (
          SELECT count(*) FROM operations_packages package
          WHERE package.organization_id = plan.organization_id
            AND package.plan_id = plan.id AND package.status = 'packed'
        )
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase must use a fresh exact packed rerate and complete package set';
    END IF;
  ELSE
    SELECT * INTO linked_create
    FROM operations_one_off_carrier_group_attempts candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = NEW.create_attempt_id;
    IF linked_create.id IS NULL OR linked_create.action <> 'create'
       OR linked_create.state <> 'succeeded'
       OR linked_create.order_id <> NEW.order_id
       OR linked_create.plan_id <> NEW.plan_id
       OR linked_create.planning_quote_id <> NEW.planning_quote_id
       OR linked_create.planning_offer_id <> NEW.planning_offer_id
       OR linked_create.purchase_quote_id <> NEW.purchase_quote_id
       OR linked_create.purchase_offer_id <> NEW.purchase_offer_id
       OR linked_create.carrier_rate_id <> NEW.carrier_rate_id
       OR linked_create.integration_account_id <> NEW.integration_account_id
       OR linked_create.carrier_account_id <> NEW.carrier_account_id
       OR linked_create.environment <> NEW.environment
       OR linked_create.provider <> NEW.provider
       OR linked_create.service_code <> NEW.service_code
       OR linked_create.package_count <> NEW.package_count
       OR linked_create.selected_amount_minor <> NEW.selected_amount_minor
       OR linked_create.currency <> NEW.currency
       OR linked_create.master_tracking_number <> NEW.master_tracking_number
       OR linked_create.provider_shipment_id <> NEW.provider_shipment_id
    THEN
      RAISE EXCEPTION
        'Whole-shipment void must retain the exact successful create group';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM operations_orders source_order
      WHERE source_order.organization_id = NEW.organization_id
        AND source_order.id = NEW.order_id
        AND source_order.status = 'packed'
        AND NOT EXISTS (
          SELECT 1
          FROM operations_shipments shipment
          WHERE shipment.organization_id = source_order.organization_id
            AND shipment.order_id = source_order.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM operations_one_off_carrier_group_members member
          JOIN operations_packages package
            ON package.organization_id = member.organization_id
           AND package.id = member.package_id
          WHERE member.organization_id = NEW.organization_id
            AND member.carrier_group_attempt_id = NEW.create_attempt_id
            AND package.status <> 'labeled'
        )
    ) THEN
      RAISE EXCEPTION
        'Whole-shipment void is available only before shipment confirmation';
    END IF;
    IF NEW.action = 'close_sample' AND NOT (
      NEW.environment = 'sandbox' AND NEW.provider = 'ups_rest'
      AND NEW.master_tracking_number ~* '^1Z[X]{16}$'
      AND NEW.provider_shipment_id ~* '^1Z[X]{16}$'
    ) THEN
      RAISE EXCEPTION 'Local sample close is limited to UPS CIE sample shipments';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_group_prepare_write
  ON operations_one_off_carrier_group_attempts;
CREATE TRIGGER validate_operations_one_off_group_prepare_write
BEFORE INSERT ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_prepare();

CREATE OR REPLACE FUNCTION protect_operations_one_off_group_attempt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off carrier group attempts are immutable';
  END IF;
  IF ROW(
    NEW.global_id, NEW.organization_id, NEW.order_id, NEW.plan_id,
    NEW.planning_quote_id, NEW.planning_offer_id,
    NEW.purchase_quote_id, NEW.purchase_offer_id, NEW.carrier_rate_id,
    NEW.integration_account_id, NEW.carrier_account_id, NEW.create_attempt_id,
    NEW.action, NEW.environment, NEW.provider, NEW.service_code,
    NEW.package_count, NEW.selected_amount_minor, NEW.currency,
    NEW.adapter_version, NEW.idempotency_key, NEW.request_hash,
    NEW.redacted_request, NEW.reason, NEW.actor_email,
    NEW.requested_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.global_id, OLD.organization_id, OLD.order_id, OLD.plan_id,
    OLD.planning_quote_id, OLD.planning_offer_id,
    OLD.purchase_quote_id, OLD.purchase_offer_id, OLD.carrier_rate_id,
    OLD.integration_account_id, OLD.carrier_account_id, OLD.create_attempt_id,
    OLD.action, OLD.environment, OLD.provider, OLD.service_code,
    OLD.package_count, OLD.selected_amount_minor, OLD.currency,
    OLD.adapter_version, OLD.idempotency_key, OLD.request_hash,
    OLD.redacted_request, OLD.reason, OLD.actor_email,
    OLD.requested_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'One-off carrier group request evidence is immutable';
  END IF;
  IF OLD.state <> 'prepared' OR NEW.state = 'prepared'
     OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'One-off carrier group attempts finalize exactly once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_group_attempt_write
  ON operations_one_off_carrier_group_attempts;
CREATE TRIGGER protect_operations_one_off_group_attempt_write
BEFORE UPDATE OR DELETE ON operations_one_off_carrier_group_attempts
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_attempt();

CREATE OR REPLACE FUNCTION protect_operations_one_off_group_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'One-off carrier group membership and results are immutable';
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_group_member_write
  ON operations_one_off_carrier_group_members;
CREATE TRIGGER protect_operations_one_off_group_member_write
BEFORE UPDATE OR DELETE ON operations_one_off_carrier_group_members
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_immutable();

DROP TRIGGER IF EXISTS protect_operations_one_off_group_result_write
  ON operations_one_off_carrier_group_results;
CREATE TRIGGER protect_operations_one_off_group_result_write
BEFORE UPDATE OR DELETE ON operations_one_off_carrier_group_results
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_immutable();

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_label()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  label_order_id uuid;
  label_plan_id uuid;
  label_is_one_off boolean;
BEGIN
  SELECT plan.order_id, plan.id, plan.one_off_quote_id IS NOT NULL
    INTO label_order_id, label_plan_id, label_is_one_off
  FROM operations_packages package
  JOIN operations_fulfillment_plans plan
    ON plan.organization_id = package.organization_id
   AND plan.id = package.plan_id
  WHERE package.organization_id = NEW.organization_id
    AND package.id = NEW.package_id;
  IF label_is_one_off THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'operations:one-off-carrier-group:' || NEW.organization_id::text
        || ':' || label_order_id::text,
      0
    ));
    IF EXISTS (
      SELECT 1
      FROM operations_one_off_carrier_group_attempts active_group
      WHERE active_group.organization_id = NEW.organization_id
        AND active_group.order_id = label_order_id
        AND active_group.plan_id = label_plan_id
        AND active_group.action = 'create'
        AND (
          active_group.state IN ('prepared', 'unknown')
          OR (
            active_group.state = 'succeeded'
            AND NOT EXISTS (
              SELECT 1
              FROM operations_one_off_carrier_group_attempts closed
              WHERE closed.organization_id = active_group.organization_id
                AND closed.create_attempt_id = active_group.id
                AND closed.action IN ('void', 'close_sample')
                AND closed.state = 'succeeded'
            )
          )
        )
        AND NEW.one_off_carrier_group_attempt_id IS DISTINCT FROM active_group.id
    ) THEN
      RAISE EXCEPTION
        'A native one-off package cannot mix label lineage with an active carrier group';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.one_off_carrier_group_attempt_id
      IS DISTINCT FROM OLD.one_off_carrier_group_attempt_id THEN
    RAISE EXCEPTION 'One-off label group lineage is immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.one_off_void_group_attempt_id IS NOT NULL
     AND NEW.one_off_void_group_attempt_id
       IS DISTINCT FROM OLD.one_off_void_group_attempt_id THEN
    RAISE EXCEPTION 'One-off label void-group lineage is immutable';
  END IF;
  IF NEW.environment = 'sandbox'
     AND lower(NEW.carrier) IN ('ups', 'ups_rest')
     AND NEW.tracking_number ~* '^1Z[X]{16}$'
     AND (
       NEW.one_off_carrier_group_attempt_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM operations_one_off_carrier_group_attempts masked_attempt
         WHERE masked_attempt.organization_id = NEW.organization_id
           AND masked_attempt.id = NEW.one_off_carrier_group_attempt_id
           AND masked_attempt.action = 'create'
           AND masked_attempt.environment = 'sandbox'
           AND masked_attempt.provider = 'ups_rest'
       )
     ) THEN
    RAISE EXCEPTION
      'UPS CIE masked tracking is limited to an exact sandbox one-off group';
  END IF;
  IF NEW.one_off_carrier_group_attempt_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts attempt
    JOIN operations_one_off_carrier_group_members member
      ON member.organization_id = attempt.organization_id
     AND member.carrier_group_attempt_id = attempt.id
     AND member.package_id = NEW.package_id
    WHERE attempt.organization_id = NEW.organization_id
      AND attempt.id = NEW.one_off_carrier_group_attempt_id
      AND attempt.action = 'create'
      AND attempt.carrier_rate_id = NEW.carrier_rate_id
      AND attempt.integration_account_id = NEW.integration_account_id
      AND attempt.carrier_account_id = NEW.carrier_account_id
      AND attempt.environment = NEW.environment
      AND NEW.carrier = CASE attempt.provider
        WHEN 'ups_rest' THEN 'UPS'
        WHEN 'fedex_rest' THEN 'FedEx'
      END
      AND NEW.service_code = attempt.service_code
  ) THEN
    RAISE EXCEPTION 'One-off label must belong to its exact prepared group member';
  END IF;
  IF NEW.one_off_void_group_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM operations_one_off_carrier_group_attempts void_attempt
    WHERE void_attempt.organization_id = NEW.organization_id
      AND void_attempt.id = NEW.one_off_void_group_attempt_id
      AND void_attempt.action IN ('void', 'close_sample')
      AND void_attempt.create_attempt_id = NEW.one_off_carrier_group_attempt_id
  ) THEN
    RAISE EXCEPTION 'One-off label void must reference its exact whole-shipment group';
  END IF;
  IF (
    NEW.status = 'created' AND NEW.one_off_void_group_attempt_id IS NOT NULL
  ) OR (
    NEW.status = 'voided' AND NEW.one_off_void_group_attempt_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'One-off label status and whole-shipment void lineage must transition together';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_group_label_write
  ON operations_labels;
CREATE TRIGGER validate_operations_one_off_group_label_write
BEFORE INSERT OR UPDATE ON operations_labels
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_label();

CREATE OR REPLACE FUNCTION protect_operations_one_off_group_label()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.one_off_carrier_group_attempt_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'One-off carrier group labels cannot be deleted';
  END IF;
  -- The only allowed mutation is the atomic whole-group created -> voided
  -- lifecycle transition. This future-proofs provider bytes and every
  -- identity/lineage field by comparing the complete row minus those exact
  -- lifecycle columns.
  IF (
    to_jsonb(NEW) - ARRAY[
      'status', 'one_off_void_group_attempt_id', 'voided_at', 'voided_by',
      'redacted_provider_evidence'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'status', 'one_off_void_group_attempt_id', 'voided_at', 'voided_by',
      'redacted_provider_evidence'
    ]::text[]
  ) THEN
    RAISE EXCEPTION
      'One-off carrier group label identity and provider bytes are immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    IF ROW(
      NEW.one_off_void_group_attempt_id, NEW.voided_at, NEW.voided_by,
      NEW.redacted_provider_evidence
    ) IS DISTINCT FROM ROW(
      OLD.one_off_void_group_attempt_id, OLD.voided_at, OLD.voided_by,
      OLD.redacted_provider_evidence
    ) THEN
      RAISE EXCEPTION
        'One-off carrier group label lifecycle evidence is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM 'created'
     OR NEW.status IS DISTINCT FROM 'voided'
     OR OLD.one_off_void_group_attempt_id IS NOT NULL
     OR OLD.voided_at IS NOT NULL
     OR OLD.voided_by IS NOT NULL
     OR OLD.redacted_provider_evidence ? 'void'
     OR NEW.one_off_void_group_attempt_id IS NULL
     OR NEW.voided_at IS NULL
     OR jsonb_typeof(NEW.redacted_provider_evidence->'void')
       IS DISTINCT FROM 'object'
     OR NEW.redacted_provider_evidence IS DISTINCT FROM (
       OLD.redacted_provider_evidence
       || jsonb_build_object('void', NEW.redacted_provider_evidence->'void')
     ) THEN
    RAISE EXCEPTION
      'One-off carrier group labels only support an exact whole-group void transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_operations_one_off_group_label_write
  ON operations_labels;
CREATE TRIGGER protect_operations_one_off_group_label_write
BEFORE UPDATE OR DELETE ON operations_labels
FOR EACH ROW EXECUTE FUNCTION protect_operations_one_off_group_label();

CREATE OR REPLACE FUNCTION validate_operations_one_off_group_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attempt operations_one_off_carrier_group_attempts%ROWTYPE;
  member_count bigint;
  member_mismatch bigint;
  allocated_total bigint;
  result_count bigint;
  result_mismatch bigint;
  active_label_count bigint;
  total_label_count bigint;
  voided_label_count bigint;
  succeeded_close_attempt_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'operations_one_off_carrier_group_attempts' THEN
    attempt := NEW;
  ELSE
    SELECT * INTO attempt
    FROM operations_one_off_carrier_group_attempts candidate
    WHERE candidate.organization_id = NEW.organization_id
      AND candidate.id = COALESCE(
        (to_jsonb(NEW)->>'carrier_group_attempt_id')::uuid,
        (to_jsonb(NEW)->>'one_off_carrier_group_attempt_id')::uuid
      );
  END IF;
  IF attempt.id IS NULL THEN RETURN NULL; END IF;

  IF attempt.action = 'create' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM operations_one_off_purchase_quote_consumptions consumption
      WHERE consumption.organization_id = attempt.organization_id
        AND consumption.quote_id = attempt.purchase_quote_id
        AND consumption.offer_id = attempt.purchase_offer_id
        AND consumption.order_id = attempt.order_id
        AND consumption.plan_id = attempt.plan_id
        AND consumption.carrier_group_attempt_id = attempt.id
    ) THEN
      RAISE EXCEPTION
        'One-off group purchase must consume its exact fresh packed quote once';
    END IF;
    SELECT count(*), COALESCE(sum(member.allocated_selected_cost_minor), 0)
      INTO member_count, allocated_total
    FROM operations_one_off_carrier_group_members member
    WHERE member.organization_id = attempt.organization_id
      AND member.carrier_group_attempt_id = attempt.id;
    SELECT count(*) INTO member_mismatch
    FROM operations_one_off_carrier_group_members member
    JOIN operations_packages package
      ON package.organization_id = member.organization_id
     AND package.id = member.package_id
     AND package.plan_id = member.plan_id
    JOIN operations_one_off_shipment_quotes quote
      ON quote.organization_id = attempt.organization_id
     AND quote.id = attempt.purchase_quote_id
    WHERE member.organization_id = attempt.organization_id
      AND member.carrier_group_attempt_id = attempt.id
      AND (
        member.order_id IS DISTINCT FROM attempt.order_id
        OR member.plan_id IS DISTINCT FROM attempt.plan_id
        OR member.package_number IS DISTINCT FROM package.package_number
        OR member.package_number > attempt.package_count
        OR jsonb_typeof(
          quote.packages_snapshot->(member.package_number - 1)
        ) IS DISTINCT FROM 'object'
        OR member.length_mm IS DISTINCT FROM package.length_mm
        OR member.width_mm IS DISTINCT FROM package.width_mm
        OR member.height_mm IS DISTINCT FROM package.height_mm
        OR member.weight_grams IS DISTINCT FROM package.weight_grams
        OR member.quote_package_key
          IS DISTINCT FROM quote.packages_snapshot
            ->(member.package_number - 1)->>'packageKey'
        OR member.length_mm
          IS DISTINCT FROM (quote.packages_snapshot->(member.package_number - 1)
                ->'dimensionsMm'->>'length')::integer
        OR member.width_mm
          IS DISTINCT FROM (quote.packages_snapshot->(member.package_number - 1)
                ->'dimensionsMm'->>'width')::integer
        OR member.height_mm
          IS DISTINCT FROM (quote.packages_snapshot->(member.package_number - 1)
                ->'dimensionsMm'->>'height')::integer
        OR member.weight_grams
          IS DISTINCT FROM (quote.packages_snapshot->(member.package_number - 1)
                ->>'grossWeightGrams')::integer
        OR member.parcel_snapshot_hash IS DISTINCT FROM
          operations_one_off_package_snapshot_hash(
            member.organization_id, member.plan_id, member.package_id,
            attempt.purchase_quote_id
          )
      );
    IF member_count <> attempt.package_count OR member_mismatch <> 0
       OR allocated_total <> attempt.selected_amount_minor THEN
      RAISE EXCEPTION
        'One-off group membership must exactly cover the quote and selected total';
    END IF;

    SELECT count(*) INTO result_count
    FROM operations_one_off_carrier_group_results result
    WHERE result.organization_id = attempt.organization_id
      AND result.carrier_group_attempt_id = attempt.id;
    SELECT count(*) INTO result_mismatch
    FROM operations_one_off_carrier_group_results result
    JOIN operations_one_off_carrier_group_members member
      ON member.organization_id = result.organization_id
     AND member.carrier_group_attempt_id = result.carrier_group_attempt_id
     AND member.package_id = result.package_id
    JOIN operations_labels label
      ON label.organization_id = result.organization_id
     AND label.id = result.label_id
    WHERE result.organization_id = attempt.organization_id
      AND result.carrier_group_attempt_id = attempt.id
      AND (
        result.package_number <> member.package_number
        OR label.package_id <> member.package_id
        OR label.one_off_carrier_group_attempt_id <> attempt.id
        OR label.tracking_number <> result.tracking_number
        OR label.provider_label_id <> result.provider_package_reference
        OR label.carrier_rate_id <> attempt.carrier_rate_id
        OR label.environment <> attempt.environment
        OR label.carrier IS DISTINCT FROM CASE attempt.provider
          WHEN 'ups_rest' THEN 'UPS'
          WHEN 'fedex_rest' THEN 'FedEx'
        END
        OR label.service_code IS DISTINCT FROM attempt.service_code
        OR label.format IS DISTINCT FROM 'ZPL'
        OR CASE
          WHEN result.redacted_provider_evidence->>'contentSha256'
                 ~ '^[a-f0-9]{64}$'
          THEN encode(
            digest(convert_to(label.label_payload, 'UTF8'), 'sha256'),
            'hex'
          ) IS DISTINCT FROM
            result.redacted_provider_evidence->>'contentSha256'
          ELSE true
        END
        OR CASE
          WHEN result.redacted_provider_evidence->>'byteLength'
                 ~ '^[0-9]+$'
          THEN octet_length(convert_to(label.label_payload, 'UTF8'))
            IS DISTINCT FROM
              (result.redacted_provider_evidence->>'byteLength')::integer
          ELSE true
        END
      );
    SELECT count(*) INTO active_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.id
      AND label.status = 'created';
    SELECT count(*) INTO total_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.id;
    SELECT closed.id INTO succeeded_close_attempt_id
    FROM operations_one_off_carrier_group_attempts closed
    WHERE closed.organization_id = attempt.organization_id
      AND closed.create_attempt_id = attempt.id
      AND closed.action IN ('void', 'close_sample')
      AND closed.state = 'succeeded'
    ORDER BY closed.completed_at DESC, closed.id DESC
    LIMIT 1;
    SELECT count(*) INTO voided_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.id
      AND label.status = 'voided'
      AND label.one_off_void_group_attempt_id = succeeded_close_attempt_id;
    IF attempt.state = 'succeeded' AND (
      result_count <> attempt.package_count
      OR total_label_count <> attempt.package_count
      OR result_mismatch <> 0
      OR (
        succeeded_close_attempt_id IS NULL
        AND active_label_count <> attempt.package_count
      )
      OR (
        succeeded_close_attempt_id IS NOT NULL
        AND (
          active_label_count <> 0
          OR voided_label_count <> attempt.package_count
        )
      )
      OR EXISTS (
        SELECT 1
        FROM operations_one_off_carrier_group_members member
        JOIN operations_packages package
          ON package.organization_id = member.organization_id
         AND package.id = member.package_id
        WHERE member.organization_id = attempt.organization_id
          AND member.carrier_group_attempt_id = attempt.id
          AND package.status <> CASE
            WHEN succeeded_close_attempt_id IS NULL THEN 'labeled'
            ELSE 'packed'
          END
      )
    ) THEN
      RAISE EXCEPTION
        'Succeeded one-off group requires one exact active label per package';
    END IF;
    IF attempt.state IN ('prepared', 'failed', 'unknown')
       AND (
         result_count <> 0 OR total_label_count <> 0
         OR EXISTS (
           SELECT 1
           FROM operations_one_off_carrier_group_members member
           JOIN operations_packages package
             ON package.organization_id = member.organization_id
            AND package.id = member.package_id
           WHERE member.organization_id = attempt.organization_id
             AND member.carrier_group_attempt_id = attempt.id
             AND package.status <> 'packed'
         )
       ) THEN
      RAISE EXCEPTION
        'Non-succeeded one-off group cannot retain package labels or results';
    END IF;
  ELSE
    SELECT count(*) INTO voided_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.create_attempt_id
      AND label.status = 'voided'
      AND label.one_off_void_group_attempt_id = attempt.id;
    SELECT count(*) INTO active_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.create_attempt_id
      AND label.status = 'created';
    SELECT count(*) INTO total_label_count
    FROM operations_labels label
    WHERE label.organization_id = attempt.organization_id
      AND label.one_off_carrier_group_attempt_id = attempt.create_attempt_id;
    IF attempt.state = 'succeeded' AND (
      total_label_count <> attempt.package_count
      OR voided_label_count <> attempt.package_count OR active_label_count <> 0
      OR (
        attempt.action = 'close_sample'
        AND EXISTS (
          SELECT 1
          FROM operations_labels label
          WHERE label.organization_id = attempt.organization_id
            AND label.one_off_carrier_group_attempt_id = attempt.create_attempt_id
            AND label.tracking_number !~* '^1Z[X]{16}$'
        )
      )
      OR EXISTS (
        SELECT 1
        FROM operations_one_off_carrier_group_members member
        JOIN operations_packages package
          ON package.organization_id = member.organization_id
         AND package.id = member.package_id
        WHERE member.organization_id = attempt.organization_id
          AND member.carrier_group_attempt_id = attempt.create_attempt_id
          AND package.status <> 'packed'
      )
    ) THEN
      RAISE EXCEPTION
        'Succeeded one-off whole-shipment void must close every label and package';
    END IF;
    IF attempt.state IN ('prepared', 'failed', 'unknown')
       AND EXISTS (
         SELECT 1 FROM operations_labels label
         WHERE label.organization_id = attempt.organization_id
           AND label.one_off_void_group_attempt_id = attempt.id
       ) THEN
      RAISE EXCEPTION
        'Unresolved one-off void cannot partially close package labels';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS validate_operations_one_off_group_attempt_deferred
  ON operations_one_off_carrier_group_attempts;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_group_attempt_deferred
AFTER INSERT OR UPDATE ON operations_one_off_carrier_group_attempts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_complete();

DROP TRIGGER IF EXISTS validate_operations_one_off_group_member_deferred
  ON operations_one_off_carrier_group_members;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_group_member_deferred
AFTER INSERT ON operations_one_off_carrier_group_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_complete();

DROP TRIGGER IF EXISTS validate_operations_one_off_group_result_deferred
  ON operations_one_off_carrier_group_results;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_group_result_deferred
AFTER INSERT ON operations_one_off_carrier_group_results
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_complete();

DROP TRIGGER IF EXISTS validate_operations_one_off_group_label_deferred
  ON operations_labels;
CREATE CONSTRAINT TRIGGER validate_operations_one_off_group_label_deferred
AFTER INSERT OR UPDATE ON operations_labels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_operations_one_off_group_complete();

COMMENT ON TABLE operations_one_off_carrier_group_attempts IS
  'Durable prepare-call-finalize boundary for one complete native one-off carrier shipment or whole-shipment void.';
COMMENT ON TABLE operations_one_off_carrier_group_members IS
  'Immutable exact canonical package membership and deterministic selected-rate allocation for one prepared carrier group.';
COMMENT ON TABLE operations_one_off_carrier_group_results IS
  'Complete provider package-label results materialized atomically for one successful carrier group.';

COMMENT ON COLUMN operations_one_off_shipment_quotes.execution_mode IS
  'Explicit operator contract: test uses sandbox carriers; live uses production carriers and may buy postage.';
