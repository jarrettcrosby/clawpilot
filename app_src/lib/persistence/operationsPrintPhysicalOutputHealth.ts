export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_MIGRATION =
  '0338_operations_print_physical_output_attestation.sql' as const
export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_MIGRATION_CHECKSUM =
  'de6379a35f682bea29aaea4ede56d65ea66e209324c04150fd89e4c17ec31239' as const

export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations migration
    WHERE migration.filename =
      '0338_operations_print_physical_output_attestation.sql'
      AND migration.checksum =
        'de6379a35f682bea29aaea4ede56d65ea66e209324c04150fd89e4c17ec31239'
  )
  AND pg_catalog.to_regclass(
    'public.operations_print_physical_output_attestations'
  ) IS NOT NULL
  AND (
    SELECT pg_catalog.count(*) = 11
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.operations_print_physical_output_attestations'
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  )
  AND pg_catalog.to_regprocedure(
    'public.validate_operations_print_physical_output_attestation()'
  ) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('operations_print_physical_output_one_per_job'),
      ('operations_print_physical_output_idempotency_unique'),
      ('operations_print_physical_output_job_fkey'),
      ('operations_print_physical_output_attempt_fkey')
    ) required(constraint_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint installed
      WHERE installed.conrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND installed.conname = required.constraint_name
        AND installed.convalidated
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'validate_operations_print_physical_output_attestation_write',
        'validate_operations_print_physical_output_attestation()'
      ),
      (
        'protect_operations_print_physical_output_attestation_write',
        'protect_operations_append_only()'
      )
    ) required(trigger_name, function_signature)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger installed
      WHERE installed.tgrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND installed.tgname = required.trigger_name
        AND installed.tgfoid = pg_catalog.to_regprocedure(
          'public.' || required.function_signature
        )
        AND installed.tgenabled = 'O'
        AND NOT installed.tgisinternal
    )
  )
`
