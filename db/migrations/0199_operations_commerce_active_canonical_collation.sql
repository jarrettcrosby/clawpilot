-- Keep commerce Active evidence canonical across PostgreSQL database locales.
-- JavaScript Array#sort uses Unicode code-point order. PostgreSQL ICU locales
-- can order underscores differently and reject the same exact scope evidence.

DO $$
DECLARE
  function_identity regprocedure;
  original_definition text;
  repaired_definition text;
BEGIN
  FOREACH function_identity IN ARRAY ARRAY[
    'operations_commerce_active_list_digest(text,text[])'::regprocedure,
    'operations_commerce_active_configuration_scopes(jsonb)'::regprocedure,
    'operations_commerce_active_cohort_json_valid(jsonb)'::regprocedure,
    'operations_commerce_active_cohort_hash(uuid,text,integer,text,integer,jsonb)'::regprocedure,
    'operations_commerce_active_cohort_matches_current(uuid,jsonb,text,integer,text)'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(function_identity::oid)
      INTO original_definition;
    repaired_definition := original_definition;
    repaired_definition := replace(repaired_definition,
      'SELECT DISTINCT scope.value',
      'SELECT DISTINCT scope.value COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'SELECT DISTINCT capability.value',
      'SELECT DISTINCT capability.value COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY item.value', 'ORDER BY item.value COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY scope.value', 'ORDER BY scope.value COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY capability.value', 'ORDER BY capability.value COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY cohort.member->>''accountGlobalId''',
      'ORDER BY (cohort.member->>''accountGlobalId'') COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY cohort.member ->> ''accountGlobalId''::text',
      'ORDER BY (cohort.member ->> ''accountGlobalId''::text) COLLATE "C"');
    repaired_definition := replace(repaired_definition,
      'ORDER BY (cohort.member ->> ''accountGlobalId''::text)',
      'ORDER BY (cohort.member ->> ''accountGlobalId''::text) COLLATE "C"');
    IF repaired_definition = original_definition THEN
      RAISE EXCEPTION
        'Commerce Active canonical collation repair found no ordering in %',
        function_identity::text;
    END IF;
    EXECUTE repaired_definition;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION operations_commerce_active_cohort_json_valid(jsonb) IS
  'Validates exact Active cohort evidence using locale-independent C ordering.';
