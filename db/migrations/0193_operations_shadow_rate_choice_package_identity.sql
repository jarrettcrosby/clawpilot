-- Fulfillment rate choices retain the exact normalized provider rate together
-- with the immutable package-plan identity required by the two-pass pack/rate
-- boundary. Repair the already-installed 0177 validator so it compares the
-- provider fact plus exactly those two lineage fields.

DO $migration$
DECLARE
  current_definition text;
  revised_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'validate_operations_fulfillment_execution()'::regprocedure
  ) INTO current_definition;

  revised_definition := replace(
    current_definition,
    'WHERE response_rate.value = choice.normalized_response',
    'WHERE choice.normalized_response = (
          response_rate.value
          || jsonb_build_object(
            ''packagePlanHash'', run.result_snapshot->>''packagePlanHash'',
            ''packageCount'', run.package_count
          )
        )'
  );

  IF revised_definition = current_definition THEN
    RAISE EXCEPTION
      'Expected raw fulfillment carrier-rate comparison was not found';
  END IF;

  IF revised_definition LIKE
       '%WHERE response_rate.value = choice.normalized_response%'
  THEN
    RAISE EXCEPTION
      'Fulfillment rate-choice package identity repair was incomplete';
  END IF;

  EXECUTE revised_definition;
END;
$migration$;

COMMENT ON FUNCTION validate_operations_fulfillment_execution() IS
  'Validates immutable fulfillment lineage. Carrier evidence must match the complete fulfillment-address fingerprint, and each normalized selected rate must equal one retained provider rate plus the exact package-plan hash and package count.';
