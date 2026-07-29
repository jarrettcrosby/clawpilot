-- Scale immutable cartonization evidence for high-unit orders while keeping
-- the selected packaging-material catalog independently bounded to eight.

CREATE OR REPLACE FUNCTION
  validate_operations_cartonization_rate_evidence_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence_status text;
  failed_quote_count bigint;
  package_count bigint;
  quote_count bigint;
BEGIN
  SELECT evidence.status
    INTO evidence_status
  FROM operations_cartonization_rate_evidence evidence
  WHERE evidence.organization_id = NEW.organization_id
    AND evidence.id = NEW.id
    AND evidence.sealed_at IS NOT NULL;
  IF evidence_status IS NULL THEN
    RAISE EXCEPTION
      'Cartonization rate evidence must be sealed before commit';
  END IF;

  SELECT count(*)
    INTO package_count
  FROM operations_cartonization_rate_evidence_packages package
  WHERE package.organization_id = NEW.organization_id
    AND package.evidence_id = NEW.id;
  IF package_count NOT BETWEEN 1 AND 64 OR EXISTS (
    SELECT 1
    FROM operations_cartonization_rate_evidence_packages package
    LEFT JOIN operations_cartonization_rate_evidence_quotes quote
      ON quote.organization_id = package.organization_id
     AND quote.evidence_id = package.evidence_id
     AND quote.package_key = package.package_key
    WHERE package.organization_id = NEW.organization_id
      AND package.evidence_id = NEW.id
    GROUP BY package.package_key
    HAVING count(quote.provider) <> 2
       OR count(quote.provider) FILTER (
         WHERE quote.provider = 'ups_rest'
       ) <> 1
       OR count(quote.provider) FILTER (
         WHERE quote.provider = 'fedex_rest'
       ) <> 1
  ) THEN
    RAISE EXCEPTION
      'Cartonization rate evidence requires one UPS and one FedEx quote per package';
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
      'Cartonization quote must match its exact carrier request context';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE quote.quote_status = 'failed')
    INTO quote_count, failed_quote_count
  FROM operations_cartonization_rate_evidence_quotes quote
  WHERE quote.organization_id = NEW.organization_id
    AND quote.evidence_id = NEW.id;
  IF (
    evidence_status = 'succeeded'
    AND failed_quote_count <> 0
  ) OR (
    evidence_status = 'failed'
    AND failed_quote_count <> quote_count
  ) OR (
    evidence_status = 'partial'
    AND (
      failed_quote_count = 0
      OR failed_quote_count = quote_count
    )
  ) THEN
    RAISE EXCEPTION
      'Cartonization evidence status must match its retained carrier results';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION
  validate_operations_cartonization_rate_evidence_complete() IS
  'Deferred immutable evidence validation for 1-64 physical packages, each with exactly one UPS and one FedEx retained result.';
