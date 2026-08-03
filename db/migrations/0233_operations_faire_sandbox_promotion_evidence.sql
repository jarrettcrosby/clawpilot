DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  candidate_predicate text := $old$
              AND cartonization.candidate_row_version =
                    evidence.order_candidate_row_version
$old$;
  candidate_replacement text := $new$
              AND (
                cartonization.candidate_row_version =
                  evidence.order_candidate_row_version
                OR (
                  cartonization.candidate_row_version + 1 =
                    evidence.order_candidate_row_version
                  AND cartonization.sealed_at <= candidate.updated_at
                  AND EXISTS (
                    SELECT 1
                    FROM audit_events promotion_event
                    WHERE promotion_event.organization_id =
                            candidate.organization_id
                      AND promotion_event.event_type =
                            'commerce.intake.promoted'
                      AND promotion_event.aggregate_type = 'operations.order'
                      AND promotion_event.aggregate_id = source_order.global_id
                      AND promotion_event.payload->>'candidateGlobalId' =
                            candidate.global_id
                      AND promotion_event.created_at = candidate.updated_at
                  )
                )
              )
$new$;
  region_predicate text := $old$
              AND upper(coalesce(
                    source_order.ship_to->>'region',
                    source_order.ship_to->>'state'
                  )) = evidence.destination_region
$old$;
  region_replacement text := $new$
              AND CASE upper(coalesce(
                    source_order.ship_to->>'region',
                    source_order.ship_to->>'state'
                  ))
                    WHEN 'CALIFORNIA' THEN 'CA'
                    ELSE upper(coalesce(
                      source_order.ship_to->>'region',
                      source_order.ship_to->>'state'
                    ))
                  END = evidence.destination_region
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'operations_sandbox_commerce_e2e_authorization_is_current(uuid,uuid,uuid)'
      ::regprocedure
  )
  INTO current_definition;

  IF position(candidate_predicate IN current_definition) = 0 THEN
    RAISE EXCEPTION
      'Faire sandbox current-evidence candidate predicate was not found';
  END IF;
  patched_definition := replace(
    current_definition,
    candidate_predicate,
    candidate_replacement
  );

  IF position(region_predicate IN patched_definition) = 0 THEN
    RAISE EXCEPTION
      'Faire sandbox current-evidence destination predicate was not found';
  END IF;
  patched_definition := replace(
    patched_definition,
    region_predicate,
    region_replacement
  );

  EXECUTE patched_definition;
END
$migration$;

COMMENT ON FUNCTION
  operations_sandbox_commerce_e2e_authorization_is_current(uuid,uuid,uuid)
IS
  'Confirms exact Faire sandbox evidence remains current, including the sole audited ready-to-promoted candidate row transition and normalized California destination.';
