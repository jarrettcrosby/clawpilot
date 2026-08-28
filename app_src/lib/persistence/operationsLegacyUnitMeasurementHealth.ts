// Exact runtime attestation for migration 0327. The ledger checksum pins the
// forward migration, while exact catalog digests detect column, constraint,
// index, function-body, or trigger drift after the ledger row was written.
export const OPERATIONS_LEGACY_UNIT_MEASUREMENT_MIGRATION =
  '0327_operations_legacy_unit_pack_compatibility.sql' as const
export const OPERATIONS_LEGACY_UNIT_MEASUREMENT_MIGRATION_CHECKSUM =
  '602992b59ef3edd186a5df06f483488181886cc0cc225671d631d1862bc554ea' as const

export const OPERATIONS_LEGACY_UNIT_MEASUREMENT_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations migration
    WHERE migration.filename =
      '0327_operations_legacy_unit_pack_compatibility.sql'
      AND migration.checksum =
        '602992b59ef3edd186a5df06f483488181886cc0cc225671d631d1862bc554ea'
  )
  AND (
    SELECT pg_catalog.count(attribute.attnum) = 17
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            attribute.attnum::text,
            attribute.attname,
            pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ),
            attribute.attnotnull::text,
            COALESCE(pg_catalog.pg_get_expr(
              attribute_default.adbin,
              attribute_default.adrelid
            ), '')
          ), E'\n' ORDER BY attribute.attnum
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        'bd1fe5bc733b4abe6ea1f8cc02e21fd862c4d0d126b8f063d3be963e8f40da3a'
    FROM pg_catalog.pg_attribute attribute
    LEFT JOIN pg_catalog.pg_attrdef attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.operations_commerce_legacy_unit_measurement_evidence'
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 15
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            installed_namespace.nspname,
            table_row.relname,
            installed.conname,
            installed.contype::text,
            installed.convalidated::text,
            installed.connoinherit::text,
            pg_catalog.pg_get_constraintdef(installed.oid, true)
          ), E'\n' ORDER BY installed.conname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '50f7a63234f9a8598d950419200ae090b3a7d802904062119fd0e264483413a2'
    FROM pg_catalog.pg_constraint installed
    JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.connamespace
    WHERE installed.conrelid = pg_catalog.to_regclass(
      'public.operations_commerce_legacy_unit_measurement_evidence'
    )
      -- PostgreSQL 18 also exposes NOT NULL metadata as contype = 'n'.
      AND installed.contype <> 'n'
  )
  AND (
    SELECT pg_catalog.count(installed.indexrelid) = 2
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            index_row.relname,
            installed.indisunique::text,
            installed.indisprimary::text,
            installed.indisvalid::text,
            installed.indisready::text,
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_indexdef(installed.indexrelid),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY index_row.relname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '18131dcc43f74c35d5abafa5ef0a7ad8baa692014875e8171e785e65543976da'
    FROM pg_catalog.pg_index installed
    JOIN pg_catalog.pg_class index_row
      ON index_row.oid = installed.indexrelid
    WHERE installed.indrelid = pg_catalog.to_regclass(
      'public.operations_commerce_legacy_unit_measurement_evidence'
    )
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 3
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            required.signature,
            installed_namespace.nspname,
            language.lanname,
            installed.prokind::text,
            installed.provolatile::text,
            installed.proparallel::text,
            installed.proisstrict::text,
            installed.prosecdef::text,
            installed.proleakproof::text,
            pg_catalog.format_type(installed.prorettype, NULL),
            installed.pronargs::text,
            installed.pronargdefaults::text,
            COALESCE(pg_catalog.array_to_string(
              installed.proconfig, ','
            ), ''),
            pg_catalog.btrim(pg_catalog.regexp_replace(
              installed.prosrc, '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY required.signature
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '7579fc4cb426e8b1e07a41ead2d9dba971fde0e63fb6d8bec7547a0952fe482f'
    FROM (VALUES
      ('validate_operations_commerce_legacy_unit_measurement_evidence()'),
      ('protect_operations_commerce_legacy_unit_measurement_evidence()'),
      ('protect_operations_commerce_legacy_unit_measurement_receipt()')
    ) required(signature)
    LEFT JOIN pg_catalog.pg_proc installed
      ON installed.oid = pg_catalog.to_regprocedure(
        'public.' || required.signature
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.pronamespace
    LEFT JOIN pg_catalog.pg_language language
      ON language.oid = installed.prolang
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 3
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            required.table_name,
            table_namespace.nspname,
            installed.tgname,
            installed.tgtype::text,
            installed.tgenabled::text,
            installed.tgisinternal::text,
            function_namespace.nspname || '.' ||
              trigger_function.proname || '(' ||
              pg_catalog.pg_get_function_identity_arguments(
                trigger_function.oid
              ) || ')',
            COALESCE(pg_catalog.pg_get_expr(
              installed.tgqual, installed.tgrelid
            ), ''),
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_triggerdef(installed.oid),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY required.table_name,
            required.trigger_name
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '1ddc53f5259f2b297017ace3572d1efcc608bb1484c1c0bb3406ecb9cbb8020e'
    FROM (VALUES
      (
        'operations_commerce_legacy_unit_measurement_evidence',
        'validate_operations_commerce_legacy_unit_measurement_evidence'
      ),
      (
        'operations_commerce_legacy_unit_measurement_evidence',
        'protect_operations_commerce_legacy_unit_measurement_evidence'
      ),
      (
        'operations_command_receipts',
        'protect_operations_commerce_legacy_unit_measurement_receipt'
      )
    ) required(table_name, trigger_name)
    LEFT JOIN pg_catalog.pg_trigger installed
      ON installed.tgrelid = pg_catalog.to_regclass(
        'public.' || required.table_name
      )
     AND installed.tgname = required.trigger_name
    LEFT JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.tgrelid
    LEFT JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_row.relnamespace
    LEFT JOIN pg_catalog.pg_proc trigger_function
      ON trigger_function.oid = installed.tgfoid
    LEFT JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
  )
`
