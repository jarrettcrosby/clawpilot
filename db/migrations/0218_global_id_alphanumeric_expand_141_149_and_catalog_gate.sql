SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

SELECT expand_global_id_compatibility_constraint_batch(141, 149);

DO $$
DECLARE
  allocator_definition text;
  suffix_constraint_definition text;
  compatibility_function_count integer;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM global_id_compatibility_constraint_manifest
    WHERE expanded_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Not every generated Global ID constraint was expanded';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM global_id_compatibility_constraint_manifest manifest
    LEFT JOIN pg_constraint constraint_row
      ON constraint_row.conrelid = to_regclass(manifest.table_name)
     AND constraint_row.conname = manifest.constraint_name
    WHERE constraint_row.oid IS NULL OR NOT constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'An expanded Global ID constraint is missing or unvalidated';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND position('^g' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9]{7}' IN pg_get_constraintdef(constraint_row.oid, true)) > 0
      AND position('[0-9a-v]{12}' IN pg_get_constraintdef(constraint_row.oid, true)) = 0
  ) THEN
    RAISE EXCEPTION 'An active numeric-only Global ID CHECK remains';
  END IF;

  SELECT pg_get_constraintdef(constraint_row.oid, true)
  INTO suffix_constraint_definition
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid = 'crm_reference_number_registry'::regclass
    AND constraint_row.conname = 'crm_reference_number_registry_valid';
  IF suffix_constraint_definition IS NULL
    OR position(
      'global_reference_suffix_is_valid(number_value)'
      IN suffix_constraint_definition
    ) = 0
  THEN
    RAISE EXCEPTION 'Global reference suffix registry is not dual-format';
  END IF;

  SELECT count(*) INTO compatibility_function_count
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = current_schema()
    AND procedure.proname IN (
      'operations_cartonization_allocations_valid',
      'operations_commerce_active_cohort_json_valid',
      'operations_shopify_preview_lines_valid',
      'preserve_quarantined_pipeline_short_link_disable'
    )
    AND position('[0-9a-v]{12}' IN pg_get_functiondef(procedure.oid)) > 0;
  IF compatibility_function_count <> 4 THEN
    RAISE EXCEPTION 'Not every generated Global ID function is dual-format';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.proname = 'enforce_crm_reference_number_exclusive'
      AND position(
        'global_reference_suffix(NEW.reference_code, NEW.prefix)'
        IN pg_get_functiondef(procedure.oid)
      ) > 0
      AND position('right(' IN lower(pg_get_functiondef(procedure.oid))) = 0
  ) THEN
    RAISE EXCEPTION 'Global reference exclusivity trigger still assumes seven digits';
  END IF;

  SELECT pg_get_functiondef(procedure.oid)
  INTO allocator_definition
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = current_schema()
    AND procedure.proname = 'allocate_global_reference'
    AND pg_get_function_identity_arguments(procedure.oid) =
      'requested_prefix text';
  IF allocator_definition IS NULL
    OR position('1000000 + floor(random() * 9000000)' IN allocator_definition) = 0
    OR position('gen_random_bytes' IN allocator_definition) > 0
  THEN
    RAISE EXCEPTION 'Deployment A changed the legacy numeric allocator';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_index index_row
    WHERE index_row.indrelid = 'crm_reference_registry'::regclass
      AND index_row.indisunique
      AND position(
        'substring(reference_code'
        IN lower(pg_get_indexdef(index_row.indexrelid))
      ) > 0
  ) THEN
    RAISE EXCEPTION 'Grandfathered duplicate Global ID suffixes were made unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'short_links'::regclass
      AND trigger_row.tgname =
        'trg_enforce_global_reference_short_link_reservation'
      AND trigger_row.tgenabled <> 'D'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Global reference short-link reservation trigger is missing';
  END IF;
END;
$$;

DROP FUNCTION expand_global_id_compatibility_constraint_batch(integer, integer);
DROP TABLE global_id_compatibility_constraint_manifest;
