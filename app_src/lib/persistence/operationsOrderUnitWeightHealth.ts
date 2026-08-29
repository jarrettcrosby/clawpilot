export const OPERATIONS_ORDER_UNIT_WEIGHT_MIGRATION =
  '0336_operations_order_unit_physical_facts.sql' as const
export const OPERATIONS_ORDER_UNIT_WEIGHT_MIGRATION_CHECKSUM =
  '37620c5cdac39bbea692deadc8a152ee55ffc050117b53864a0455ae16a7a971' as const

export const OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations migration
    WHERE migration.filename =
      '0336_operations_order_unit_physical_facts.sql'
      AND migration.checksum =
        '37620c5cdac39bbea692deadc8a152ee55ffc050117b53864a0455ae16a7a971'
  )
  AND (
    SELECT pg_catalog.count(installed_table.oid) = 1
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            installed_namespace.nspname,
            installed_table.relname,
            installed_table.relkind::text,
            installed_table.relpersistence::text,
            installed_table.relrowsecurity::text,
            installed_table.relforcerowsecurity::text
          ), E'\n' ORDER BY installed_table.relname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        'fe542dc7f63dac34582c55c19cf6d69d9ea0ae564e96687b675422c532ae6c0b'
    FROM pg_catalog.pg_class installed_table
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_table.relname = 'operations_order_unit_weight_facts'
  )
  AND (
    SELECT pg_catalog.count(attribute.attnum) = 29
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
            ), ''),
            attribute.attidentity::text,
            attribute.attgenerated::text,
            COALESCE(installed_collation.collname, '')
          ), E'\n' ORDER BY attribute.attnum
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '5c244efbb97fe637321a90cddac760b339bc8eae8e0d22d69d349b305e2b849c'
    FROM pg_catalog.pg_attribute attribute
    LEFT JOIN pg_catalog.pg_attrdef attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
    LEFT JOIN pg_catalog.pg_collation installed_collation
      ON installed_collation.oid = attribute.attcollation
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.operations_order_unit_weight_facts'
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 27
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            installed_namespace.nspname,
            table_row.relname,
            installed.conname,
            installed.contype::text,
            installed.convalidated::text,
            installed.connoinherit::text,
            installed.condeferrable::text,
            installed.condeferred::text,
            installed.confdeltype::text,
            installed.confupdtype::text,
            pg_catalog.btrim(pg_catalog.regexp_replace(
              pg_catalog.pg_get_constraintdef(installed.oid, false),
              '[[:space:]]+', ' ', 'g'
            ))
          ), E'\n' ORDER BY installed.conname
        ), 'UTF8'), 'sha256'
      ), 'hex') =
        '598ec8450b2c12cb1243e3380e82df2e539d9f4cf4c20e50a58942bccabaa3e1'
    FROM pg_catalog.pg_constraint installed
    JOIN pg_catalog.pg_class table_row
      ON table_row.oid = installed.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed.connamespace
    WHERE installed.conrelid = pg_catalog.to_regclass(
      'public.operations_order_unit_weight_facts'
    )
      -- PostgreSQL 18 also represents NOT NULL metadata as contype = 'n'.
      AND installed.contype <> 'n'
  )
  AND (
    SELECT pg_catalog.count(installed.indexrelid) = 8
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
        '84ffab44d05e590bb5274522ad1343fef1f91594e8c42e0507360f4f4a00b12c'
    FROM pg_catalog.pg_index installed
    JOIN pg_catalog.pg_class index_row
      ON index_row.oid = installed.indexrelid
    WHERE installed.indrelid = pg_catalog.to_regclass(
      'public.operations_order_unit_weight_facts'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM public.global_reference_entity_types entity_type
    WHERE entity_type.prefix = 'gouw'
      AND entity_type.entity_type = 'operations.order_unit_weight_fact'
  )
  AND (
    SELECT pg_catalog.count(installed.oid) = 4
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
        'a4d8bb6af56923e3e436f37049ea0a043e5242b5ccd80d95556c595ac6c6a7d3'
    FROM (VALUES
      ('validate_operations_order_unit_weight_fact()'),
      ('protect_operations_order_unit_weight_fact()'),
      ('protect_operations_order_unit_weight_receipt()'),
      ('validate_operations_cartonization_unit_material_package()')
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
    SELECT pg_catalog.count(installed.oid) = 4
      AND pg_catalog.encode(public.digest(
        pg_catalog.convert_to(pg_catalog.string_agg(
          pg_catalog.concat_ws('|',
            required.table_name,
            table_namespace.nspname,
            installed.tgname,
            installed.tgtype::text,
            installed.tgenabled::text,
            installed.tgisinternal::text,
            installed.tgdeferrable::text,
            installed.tginitdeferred::text,
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
        '5891892eceb2840512db9cd83a3d0d9a5a37753cd2665e0661aa3c9eee024111'
    FROM (VALUES
      (
        'operations_order_unit_weight_facts',
        'validate_operations_order_unit_weight_fact'
      ),
      (
        'operations_order_unit_weight_facts',
        'protect_operations_order_unit_weight_fact'
      ),
      (
        'operations_command_receipts',
        'protect_operations_order_unit_weight_receipt'
      ),
      (
        'operations_cartonization_rate_evidence_packages',
        'validate_operations_cartonization_unit_material_package'
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
