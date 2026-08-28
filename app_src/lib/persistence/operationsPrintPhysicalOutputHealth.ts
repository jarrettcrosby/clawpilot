export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_MIGRATION =
  '0338_operations_print_physical_output_attestation.sql' as const
export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_MIGRATION_CHECKSUM =
  '2ca77442275e87d8b8ee858f974ecc861fb30b0a523ae89092c1be7ab0e4e1cd' as const

export const OPERATIONS_PRINT_PHYSICAL_OUTPUT_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations migration
    WHERE migration.filename =
      '0338_operations_print_physical_output_attestation.sql'
      AND migration.checksum =
        '2ca77442275e87d8b8ee858f974ecc861fb30b0a523ae89092c1be7ab0e4e1cd'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class table_row
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_row.relname =
        'operations_print_physical_output_attestations'
      AND table_row.relkind = 'r'
      AND table_row.relpersistence = 'p'
      AND NOT table_row.relrowsecurity
  )
  AND (
    SELECT pg_catalog.count(*) = 11
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.operations_print_physical_output_attestations'
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (1, 'id', 'uuid', true, 'gen_random_uuid()'::text),
      (2, 'organization_id', 'uuid', true, NULL::text),
      (3, 'print_job_id', 'uuid', true, NULL::text),
      (4, 'delivery_attempt_id', 'uuid', true, NULL::text),
      (5, 'delivery_attempt_sequence_number', 'integer', true, NULL::text),
      (6, 'delivered_at', 'timestamp with time zone', true, NULL::text),
      (7, 'verified_at', 'timestamp with time zone', true, 'now()'::text),
      (8, 'verified_by', 'text', true, NULL::text),
      (9, 'reason', 'text', true, NULL::text),
      (10, 'idempotency_key', 'text', true, NULL::text),
      (11, 'request_fingerprint', 'text', true, NULL::text)
    ) required(
      ordinal_position, column_name, data_type, not_null, default_expression
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute attribute
      LEFT JOIN pg_catalog.pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND attribute.attnum = required.ordinal_position
        AND attribute.attname = required.column_name
        AND pg_catalog.format_type(
          attribute.atttypid, attribute.atttypmod
        ) = required.data_type
        AND attribute.attnotnull = required.not_null
        AND attribute.attidentity = ''
        AND attribute.attgenerated = ''
        AND pg_catalog.pg_get_expr(
          default_value.adbin, default_value.adrelid
        ) IS NOT DISTINCT FROM required.default_expression
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('operations_print_physical_output_attempt_fkey', 'f'),
      ('operations_print_physical_output_fingerprint_valid', 'c'),
      ('operations_print_physical_output_idempotency_present', 'c'),
      ('operations_print_physical_output_idempotency_unique', 'u'),
      ('operations_print_physical_output_job_fkey', 'f'),
      ('operations_print_physical_output_one_per_job', 'u'),
      ('operations_print_physical_output_organization_fkey', 'f'),
      ('operations_print_physical_output_pkey', 'p'),
      ('operations_print_physical_output_reason_valid', 'c'),
      ('operations_print_physical_output_sequence_positive', 'c'),
      ('operations_print_physical_output_verified_by_valid', 'c')
    ) required(constraint_name, constraint_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint constraint_row
      WHERE constraint_row.conrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND constraint_row.conname = required.constraint_name
        AND constraint_row.contype = required.constraint_type
        AND constraint_row.convalidated
    )
  )
  AND (
    SELECT pg_catalog.count(*) = 11
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            constraint_row.conname,
            constraint_row.contype::text,
            constraint_row.convalidated::text,
            constraint_row.condeferrable::text,
            constraint_row.condeferred::text,
            constraint_row.confupdtype::text,
            constraint_row.confdeltype::text,
            constraint_row.confmatchtype::text,
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY constraint_row.conname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '3fd4f54c7070a9c1c28082afe360d638621d45b8de7d8acc5db183d45daf30c0'
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = pg_catalog.to_regclass(
      'public.operations_print_physical_output_attestations'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('idx_operations_print_physical_output_verified', false, false),
      ('operations_print_physical_output_idempotency_unique', false, true),
      ('operations_print_physical_output_one_per_job', false, true),
      ('operations_print_physical_output_pkey', true, true)
    ) required(index_name, is_primary, is_unique)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index index_metadata
      JOIN pg_catalog.pg_class index_row
        ON index_row.oid = index_metadata.indexrelid
      WHERE index_metadata.indrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND index_row.relname = required.index_name
        AND index_metadata.indisprimary = required.is_primary
        AND index_metadata.indisunique = required.is_unique
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND index_metadata.indislive
    )
  )
  AND (
    SELECT pg_catalog.count(*) = 4
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            index_row.relname,
            index_metadata.indisprimary::text,
            index_metadata.indisunique::text,
            index_metadata.indisvalid::text,
            index_metadata.indisready::text,
            index_metadata.indislive::text,
            index_metadata.indisreplident::text,
            index_metadata.indnullsnotdistinct::text,
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_indexdef(index_row.oid),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY index_row.relname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        'fd15bac1d42a06fa88bae40902eed8c3f6f4ba5756f2fce1d86199c237feed02'
    FROM pg_catalog.pg_index index_metadata
    JOIN pg_catalog.pg_class index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid = pg_catalog.to_regclass(
      'public.operations_print_physical_output_attestations'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'protect_operations_append_only()',
        '747b8c3bd1c8cfeb41a10a068552b5964097a9a54c97e1f25abf8d34ef5fddc7'
      ),
      (
        'validate_operations_print_physical_output_attestation()',
        '022c9cb1b8acb275a4ac43a9bb239e4446d8e4d3bc7d047f36b1ee2942e1444a'
      )
    ) required(function_signature, function_digest)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc procedure_row
      JOIN pg_catalog.pg_namespace procedure_namespace
        ON procedure_namespace.oid = procedure_row.pronamespace
      JOIN pg_catalog.pg_language procedure_language
        ON procedure_language.oid = procedure_row.prolang
      WHERE procedure_row.oid = pg_catalog.to_regprocedure(
        'public.' || required.function_signature
      )
        AND pg_catalog.encode(public.digest(
          pg_catalog.convert_to(pg_catalog.concat_ws('|',
            procedure_namespace.nspname,
            procedure_row.oid::pg_catalog.regprocedure::text,
            procedure_language.lanname,
            procedure_row.prokind::text,
            procedure_row.provolatile::text,
            procedure_row.proparallel::text,
            procedure_row.proisstrict::text,
            procedure_row.prosecdef::text,
            procedure_row.proleakproof::text,
            pg_catalog.format_type(procedure_row.prorettype, NULL),
            procedure_row.pronargs::text,
            procedure_row.pronargdefaults::text,
            COALESCE(pg_catalog.array_to_string(
              procedure_row.proconfig, ','
            ), ''),
            pg_catalog.btrim(pg_catalog.regexp_replace(
              procedure_row.prosrc, '[[:space:]]+', ' ', 'g'
            ))
          ), 'UTF8'), 'sha256'
        ), 'hex') = required.function_digest
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'protect_operations_print_physical_output_attestation_write',
        27::smallint,
        'protect_operations_append_only()'
      ),
      (
        'validate_operations_print_physical_output_attestation_write',
        7::smallint,
        'validate_operations_print_physical_output_attestation()'
      )
    ) required(trigger_name, trigger_type, function_signature)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid = pg_catalog.to_regclass(
        'public.operations_print_physical_output_attestations'
      )
        AND trigger_row.tgname = required.trigger_name
        AND trigger_row.tgtype = required.trigger_type
        AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
          'public.' || required.function_signature
        )
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    )
  )
  AND (
    SELECT pg_catalog.count(*) = 2
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            trigger_row.tgname,
            trigger_row.tgtype::text,
            trigger_row.tgenabled::text,
            trigger_row.tgisinternal::text,
            trigger_row.tgfoid::pg_catalog.regprocedure::text,
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_triggerdef(trigger_row.oid),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY trigger_row.tgname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        'dcfc0393a532b05606f656ef31ff527ed31981bb314a187e14c2e571336ca787'
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid = pg_catalog.to_regclass(
      'public.operations_print_physical_output_attestations'
    )
      AND NOT trigger_row.tgisinternal
  )
`
