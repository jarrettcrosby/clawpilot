const SHIPPING_ONE_OFF_PACK_ARTIFACTS_SQL = String.raw`
  artifact(kind, identity, definition) AS (
    SELECT 'relation',
           installed_namespace.nspname || '.' || installed_table.relname,
           concat_ws('|', installed_table.relkind::text,
                     installed_table.relpersistence::text)
    FROM pg_catalog.pg_class installed_table
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_table.relname =
        'operations_shipping_one_off_pack_receipts'
    UNION ALL
    SELECT 'column',
           installed_table.relname || '.'
             || installed_column.attnum::text || '.'
             || installed_column.attname,
           concat_ws('|',
             format_type(installed_column.atttypid, installed_column.atttypmod),
             installed_column.attnotnull::text,
             COALESCE(pg_get_expr(
               installed_default.adbin,
               installed_default.adrelid
             ), ''),
             installed_column.attidentity::text,
             installed_column.attgenerated::text
           )
    FROM pg_catalog.pg_class installed_table
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    JOIN pg_catalog.pg_attribute installed_column
      ON installed_column.attrelid = installed_table.oid
     AND installed_column.attnum > 0
     AND NOT installed_column.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef installed_default
      ON installed_default.adrelid = installed_column.attrelid
     AND installed_default.adnum = installed_column.attnum
    WHERE installed_namespace.nspname = 'public'
      AND installed_table.relname =
        'operations_shipping_one_off_pack_receipts'
    UNION ALL
    SELECT 'constraint',
           installed_table.relname || '.' || installed_constraint.conname,
           concat_ws('|', installed_constraint.contype::text,
             installed_constraint.convalidated::text,
             installed_constraint.condeferrable::text,
             installed_constraint.condeferred::text,
             installed_constraint.confdeltype::text,
             installed_constraint.confupdtype::text,
             pg_get_constraintdef(installed_constraint.oid, true)
           )
    FROM pg_catalog.pg_constraint installed_constraint
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_constraint.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_constraint.contype <> 'n'
      AND installed_table.relname =
        'operations_shipping_one_off_pack_receipts'
    UNION ALL
    SELECT 'index', installed_index.relname,
           pg_get_indexdef(installed_index.oid)
    FROM pg_catalog.pg_index index_metadata
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = index_metadata.indrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    JOIN pg_catalog.pg_class installed_index
      ON installed_index.oid = index_metadata.indexrelid
    WHERE installed_namespace.nspname = 'public'
      AND installed_table.relname =
        'operations_shipping_one_off_pack_receipts'
    UNION ALL
    SELECT 'function',
           installed_namespace.nspname || '.'
             || installed_function.proname || '('
             || pg_get_function_identity_arguments(installed_function.oid)
             || ')',
           concat_ws('|',
             installed_language.lanname,
             installed_function.prokind::text,
             installed_function.provolatile::text,
             installed_function.proparallel::text,
             installed_function.proisstrict::text,
             installed_function.prosecdef::text,
             installed_function.proleakproof::text,
             COALESCE(array_to_string(installed_function.proconfig, ','), ''),
             regexp_replace(
               pg_get_functiondef(installed_function.oid),
               '[[:space:]]+', ' ', 'g'
             )
           )
    FROM pg_catalog.pg_proc installed_function
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_function.pronamespace
    JOIN pg_catalog.pg_language installed_language
      ON installed_language.oid = installed_function.prolang
    WHERE installed_namespace.nspname = 'public'
      AND installed_function.proname IN (
        'operations_transport_canonical_json',
        'operations_transport_json_sha256',
        'operations_one_off_plan_execution_is_exact',
        'operations_shipping_one_off_pack_review_snapshot',
        'protect_operations_shipping_one_off_pack_evidence',
        'protect_operations_shipping_one_off_pack_receipt',
        'validate_operations_shipping_one_off_pack_receipt'
      )
    UNION ALL
    SELECT 'trigger',
           installed_table.relname || '.' || installed_trigger.tgname,
           concat_ws('|', installed_trigger.tgenabled::text,
             pg_get_triggerdef(installed_trigger.oid, true))
    FROM pg_catalog.pg_trigger installed_trigger
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_trigger.tgrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND NOT installed_trigger.tgisinternal
      AND installed_table.relname IN (
        'operations_shipping_one_off_pack_receipts',
        'operations_reservations',
        'operations_order_lines',
        'operations_fulfillment_allocations',
        'operations_package_contents',
        'operations_one_off_ad_hoc_order_lines',
        'operations_one_off_ad_hoc_package_contents'
      )
  )
`

export const SHIPPING_ONE_OFF_PACK_MIGRATION_CHECKSUM =
  '8a844c03da549100d1da669d0ba12c2cbab24f31337f37fcd0d0071ecf80b84b'

export const SHIPPING_ONE_OFF_PACK_POST_0325_MIGRATION_CHECKSUM =
  'f17aa20305e3190c6d26950aceb9c788e3b9b1ecc1cba3515e1d0d64aace50ab'

export const SHIPPING_ONE_OFF_PACK_PRE_0325_CATALOG_HASH =
  'b463547928148723e9f5b35d92b310992c57e8dfc6a646a5bb3221898ba2c992'

export const SHIPPING_ONE_OFF_PACK_POST_0325_CATALOG_HASH =
  '1878d43ef868796d1fb5bde57af30b25c3f1d1c35863593c5bd90f2d3dad3074'

export const SHIPPING_ONE_OFF_PACK_CATALOG_FINGERPRINT_SQL = String.raw`
  WITH ${SHIPPING_ONE_OFF_PACK_ARTIFACTS_SQL}
  SELECT count(*)::integer AS artifact_count,
         encode(digest(convert_to(string_agg(
           kind || '|' || identity || '|' || definition,
           chr(10) ORDER BY kind, identity
         ), 'UTF8'), 'sha256'), 'hex') AS artifact_hash
  FROM artifact
`

export const SHIPPING_ONE_OFF_PACK_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE filename = '0304_shipping_one_off_pack_confirmation.sql'
      AND checksum = '${SHIPPING_ONE_OFF_PACK_MIGRATION_CHECKSUM}'
  )
  AND (
    WITH ${SHIPPING_ONE_OFF_PACK_ARTIFACTS_SQL}
    SELECT count(*) = 75
      AND encode(digest(convert_to(string_agg(
        kind || '|' || identity || '|' || definition,
        chr(10) ORDER BY kind, identity
      ), 'UTF8'), 'sha256'), 'hex') = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0325_operations_shopify_fulfillment_reversal.sql'
            AND checksum =
              '${SHIPPING_ONE_OFF_PACK_POST_0325_MIGRATION_CHECKSUM}'
        ) THEN '${SHIPPING_ONE_OFF_PACK_POST_0325_CATALOG_HASH}'
        WHEN NOT EXISTS (
          SELECT 1 FROM public.schema_migrations
          WHERE filename =
            '0325_operations_shopify_fulfillment_reversal.sql'
        ) THEN '${SHIPPING_ONE_OFF_PACK_PRE_0325_CATALOG_HASH}'
        ELSE NULL
      END
    FROM artifact
  )
`
