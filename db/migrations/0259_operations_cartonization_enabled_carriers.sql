-- Retain the exact enabled carrier set used for each immutable cartonization
-- comparison. Existing evidence remains explicitly dual-carrier through the
-- expand-safe default.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE operations_cartonization_rate_evidence
  ADD COLUMN required_carrier_providers text[] NOT NULL
  DEFAULT ARRAY['ups_rest', 'fedex_rest']::text[];

ALTER TABLE operations_cartonization_rate_evidence
  ADD CONSTRAINT
    operations_cartonization_rate_evidence_required_carriers_valid
  CHECK (
    required_carrier_providers = ARRAY['ups_rest']::text[]
    OR required_carrier_providers = ARRAY['fedex_rest']::text[]
    OR required_carrier_providers
      = ARRAY['ups_rest', 'fedex_rest']::text[]
  );

COMMENT ON COLUMN
  operations_cartonization_rate_evidence.required_carrier_providers IS
  'Canonical nonempty subset of enabled verified UPS/FedEx sandbox connections required to support every retained package in this immutable comparison.';

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_rate_evidence_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_status text;
  required_carrier_providers text[];
  failed_result_count bigint;
  package_count bigint;
  quote_count bigint;
  result_count bigint;
  ordered_parcels jsonb;
  shipment_scope boolean;
  legacy_package_scope boolean;
BEGIN
  SELECT
    evidence.status,
    evidence.required_carrier_providers
    INTO evidence_status, required_carrier_providers
  FROM operations_cartonization_rate_evidence evidence
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.id
    AND evidence.sealed_at IS NOT NULL;
  IF evidence_status IS NULL THEN
    RAISE EXCEPTION
      'Cartonization rate evidence must be sealed before commit';
  END IF;

  SELECT
    count(*),
    jsonb_agg(
      package.carrier_parcel_snapshot
      ORDER BY package.package_sequence, package.package_key
    )
    INTO package_count, ordered_parcels
  FROM operations_cartonization_rate_evidence_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.evidence_id = NEW.id;

  IF package_count NOT BETWEEN 1 AND 50 OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    LEFT JOIN operations_cartonization_rate_evidence_quotes quote
      ON quote.organization_id = package.organization_id
     AND quote.evidence_id = package.evidence_id
     AND quote.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
    GROUP BY package.package_key
    HAVING count(quote.provider)
      <> cardinality(required_carrier_providers)
       OR count(DISTINCT quote.provider)
      <> cardinality(required_carrier_providers)
       OR count(quote.provider) FILTER (
         WHERE NOT (
           quote.provider = ANY(required_carrier_providers)
         )
       ) <> 0
  ) THEN
    RAISE EXCEPTION
      'Cartonization rate evidence requires 1-50 packages and one supporting edge from every retained carrier per package';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    LEFT JOIN
      operations_cartonization_rate_evidence_package_recipes recipe_edge
      ON recipe_edge.organization_id = package.organization_id
     AND recipe_edge.evidence_id = package.evidence_id
     AND recipe_edge.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
    GROUP BY
      package.package_key, package.planning_method,
      package.approved_pack_recipe_id
    HAVING (
      package.planning_method = 'approved_recipe'
      AND (
        count(recipe_edge.approved_pack_recipe_id) < 1
        OR count(recipe_edge.approved_pack_recipe_id) FILTER (
          WHERE recipe_edge.approved_pack_recipe_id
            = package.approved_pack_recipe_id
        ) <> 1
      )
    ) OR (
      package.planning_method = 'or_tools'
      AND count(recipe_edge.approved_pack_recipe_id) <> 0
    )
  ) THEN
    RAISE EXCEPTION
      'Cartonization package recipe evidence is incomplete';
  END IF;

  SELECT
    count(*),
    bool_and(
      quote.rate_purpose = 'cartonization_shipment_rate'
    ),
    bool_and(
      quote.rate_purpose = 'cartonization_package_rate'
    )
    INTO quote_count, shipment_scope, legacy_package_scope
  FROM operations_cartonization_rate_evidence_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.evidence_id = NEW.id;

  IF shipment_scope THEN
    IF (
      SELECT count(DISTINCT (
        quote.provider, quote.carrier_rate_request_id
      ))
      FROM operations_cartonization_rate_evidence_quotes quote
      WHERE quote.organization_id = NEW.organization_id
        AND quote.evidence_id = NEW.id
    ) <> cardinality(required_carrier_providers) OR EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence_quotes quote
      WHERE quote.organization_id = NEW.organization_id
        AND quote.evidence_id = NEW.id
      GROUP BY quote.provider
      HAVING count(DISTINCT quote.carrier_rate_request_id) <> 1
         OR count(DISTINCT quote.package_rate_context_hash) <> 1
    ) THEN
      RAISE EXCEPTION
        'Cartonization shipment evidence requires exactly one shared carrier result per retained provider';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence_quotes quote
      JOIN operations_carrier_rate_requests rate
        ON rate.organization_id = quote.organization_id
       AND rate.provider = quote.provider
       AND rate.purpose = quote.rate_purpose
       AND rate.id = quote.carrier_rate_request_id
      JOIN operations_cartonization_rate_evidence evidence
        ON evidence.organization_id = quote.organization_id
       AND evidence.id = quote.evidence_id
      WHERE quote.organization_id = NEW.organization_id
        AND quote.evidence_id = NEW.id
        AND (
          quote.quote_status IS DISTINCT FROM rate.status
          OR quote.error_code IS DISTINCT FROM rate.error_code
          OR quote.carrier_request_hash IS DISTINCT FROM rate.request_hash
          OR rate.redacted_request #>>
            '{shipment,destinationFingerprint}'
            IS DISTINCT FROM evidence.destination_fingerprint
          OR rate.redacted_request #>>
            '{shipment,rateScope}'
            IS DISTINCT FROM 'multi_package_shipment'
          OR rate.redacted_request #> '{shipment,packageCount}'
            IS DISTINCT FROM to_jsonb(package_count)
          OR rate.redacted_request #> '{shipment,parcels}'
            IS DISTINCT FROM ordered_parcels
          OR rate.redacted_response #>> '{rateScope}'
            IS DISTINCT FROM 'multi_package_shipment'
          OR rate.redacted_response #> '{packageCount}'
            IS DISTINCT FROM to_jsonb(package_count)
        )
    ) THEN
      RAISE EXCEPTION
        'Cartonization shipment quote must match the exact ordered carrier request context';
    END IF;

    SELECT
      count(*),
      count(*) FILTER (WHERE result.quote_status = 'failed')
      INTO result_count, failed_result_count
    FROM (
      SELECT
        quote.provider,
        quote.carrier_rate_request_id,
        min(quote.quote_status) AS quote_status
      FROM operations_cartonization_rate_evidence_quotes quote
      WHERE quote.organization_id = NEW.organization_id
        AND quote.evidence_id = NEW.id
      GROUP BY quote.provider, quote.carrier_rate_request_id
    ) result;
  ELSIF legacy_package_scope THEN
    IF EXISTS (
      SELECT 1
      FROM operations_cartonization_rate_evidence_quotes quote
      JOIN operations_carrier_rate_requests rate
        ON rate.organization_id = quote.organization_id
       AND rate.provider = quote.provider
       AND rate.purpose = quote.rate_purpose
       AND rate.id = quote.carrier_rate_request_id
      JOIN operations_cartonization_rate_evidence evidence
        ON evidence.organization_id = quote.organization_id
       AND evidence.id = quote.evidence_id
      JOIN operations_cartonization_rate_evidence_packages package
        ON package.organization_id = quote.organization_id
       AND package.evidence_id = quote.evidence_id
       AND package.package_key = quote.package_key
      WHERE quote.organization_id = NEW.organization_id
        AND quote.evidence_id = NEW.id
        AND (
          quote.quote_status IS DISTINCT FROM rate.status
          OR quote.error_code IS DISTINCT FROM rate.error_code
          OR quote.carrier_request_hash IS DISTINCT FROM rate.request_hash
          OR rate.redacted_request #>>
            '{shipment,destinationFingerprint}'
            IS DISTINCT FROM evidence.destination_fingerprint
          OR rate.redacted_request #> '{shipment,parcel}'
            IS DISTINCT FROM package.carrier_parcel_snapshot
        )
    ) THEN
      RAISE EXCEPTION
        'Legacy cartonization quote must match its exact package request context';
    END IF;
    SELECT
      quote_count,
      count(*) FILTER (WHERE quote.quote_status = 'failed')
      INTO result_count, failed_result_count
    FROM operations_cartonization_rate_evidence_quotes quote
    WHERE quote.organization_id = NEW.organization_id
      AND quote.evidence_id = NEW.id;
  ELSE
    RAISE EXCEPTION
      'Cartonization evidence cannot mix package and shipment rate purposes';
  END IF;

  IF (
    evidence_status = 'succeeded'
    AND failed_result_count <> 0
  ) OR (
    evidence_status = 'failed'
    AND failed_result_count <> result_count
  ) OR (
    evidence_status = 'partial'
    AND (
      failed_result_count = 0
      OR failed_result_count = result_count
    )
  ) THEN
    RAISE EXCEPTION
      'Cartonization evidence status must match its distinct retained carrier results';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION
  validate_operations_cartonization_rate_evidence_complete() IS
  'Deferred immutable validation for legacy package evidence or 1-50 ordered packages supported by the exact retained enabled carrier set.';
