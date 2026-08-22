// Exact runtime attestation for migrations 0301 and 0313. Keep this expression shared by
// /api/health and the disposable-PostgreSQL tamper suite so presence-only
// checks cannot bless weakened Shipping authority.
export const SHIPPING_INDEPENDENCE_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations
    WHERE filename = '0301_shipping_independent_one_off_items.sql'
      AND checksum =
        '21d58421f998e503f16c1f4ebc4c95dee9c986c0e5049a2dedb18df686058f53'
  )
  AND EXISTS (
    SELECT 1
    FROM public.schema_migrations
    WHERE filename = '0313_shipping_one_off_documents_minimal_fields.sql'
      AND checksum =
        'b3b801e2469fc4bf596256a12514ac910173154b97c48d04103cfee4b8170df2'
  )
  AND EXISTS (
    SELECT 1
    FROM public.schema_migrations
    WHERE filename =
      '0314_operations_local_work_independent_activation.sql'
      AND checksum =
        '2c69fa93d265ced3a0019cc5f5b6770ae2890146e4bc00d213d9b67ae18d7d3c'
  )
  AND (
    WITH required_function(signature) AS (
      VALUES
        ('public.operations_one_off_lines_are_pure_ad_hoc(jsonb)'),
        ('public.operations_one_off_plan_package_set_is_exact(uuid,uuid,uuid)'),
        ('public.operations_one_off_purchase_quote_is_valid(uuid,uuid,uuid,uuid)'),
        ('public.protect_operations_one_off_ad_hoc_evidence()'),
        ('public.validate_operations_one_off_ad_hoc_content_lineage()'),
        ('public.validate_operations_one_off_ad_hoc_line_lineage()'),
        ('public.validate_operations_one_off_direct_recipient()'),
        ('public.validate_operations_one_off_group_prepare()'),
        ('public.validate_operations_one_off_group_shipment()'),
        ('public.validate_ops_activation_canonical_plans()'),
        ('public.validate_ops_plan_cartonization_evidence()')
    )
    SELECT count(*) = 11
      AND count(installed_function.oid) = 11
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                required_function.signature,
                installed_namespace.nspname,
                installed_language.lanname,
                installed_function.prokind::text,
                installed_function.provolatile::text,
                installed_function.proparallel::text,
                installed_function.proisstrict::text,
                installed_function.prosecdef::text,
                installed_function.proleakproof::text,
                COALESCE(array_to_string(installed_function.proconfig, ','), ''),
                pg_get_function_result(installed_function.oid),
                btrim(regexp_replace(
                  installed_function.prosrc,
                  '[[:space:]]+',
                  ' ',
                  'g'
                ))
              ),
              chr(10) ORDER BY required_function.signature
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = '0a001c617305af01c38792cb906847303de4f1b117736b04e072491a1818ff86'
    FROM required_function
    LEFT JOIN pg_catalog.pg_proc installed_function
      ON installed_function.oid = to_regprocedure(required_function.signature)
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_function.pronamespace
    LEFT JOIN pg_catalog.pg_language installed_language
      ON installed_language.oid = installed_function.prolang
  )
  AND (
    SELECT count(*) = 30
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                installed_namespace.nspname,
                installed_table.relname,
                installed_table.relkind::text,
                installed_column.attnum::text,
                installed_column.attname,
                format_type(
                  installed_column.atttypid,
                  installed_column.atttypmod
                ),
                installed_column.attnotnull::text,
                COALESCE(pg_get_expr(
                  installed_default.adbin,
                  installed_default.adrelid
                ), ''),
                installed_column.attidentity::text,
                installed_column.attgenerated::text
              ),
              chr(10) ORDER BY
                installed_table.relname,
                installed_column.attnum
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = '11d9d6ff6728efc8b33092b4d7bfca186d991a05125d5c74e19cbffe3d664a31'
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
      AND installed_table.relname IN (
        'operations_shipping_scopes',
        'operations_one_off_ad_hoc_order_lines',
        'operations_one_off_ad_hoc_package_contents'
      )
  )
  AND (
    SELECT count(*) = 8
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                installed_namespace.nspname,
                installed_table.relname,
                installed_column.attname,
                format_type(
                  installed_column.atttypid,
                  installed_column.atttypmod
                ),
                installed_column.attnotnull::text,
                COALESCE(pg_get_expr(
                  installed_default.adbin,
                  installed_default.adrelid
                ), ''),
                installed_column.attidentity::text,
                installed_column.attgenerated::text
              ),
              chr(10) ORDER BY
                installed_table.relname,
                installed_column.attname
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = 'a9cd8a54815b8bd1bbe64cf7ca5c490fd78e21de1227e721058b7f352e2bcce0'
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
      AND (
        (
          installed_table.relname = 'operations_one_off_shipment_quotes'
          AND installed_column.attname IN (
            'customer_id',
            'inventory_pool_id',
            'receiving_location_id',
            'lines_snapshot'
          )
        )
        OR (
          installed_table.relname = 'operations_orders'
          AND installed_column.attname IN (
            'customer_id',
            'source_provider',
            'order_type',
            'ship_to'
          )
        )
      )
  )
  AND (
    SELECT count(*) = 38
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                installed_namespace.nspname,
                installed_table.relname,
                installed_constraint.conname,
                installed_constraint.contype::text,
                installed_constraint.convalidated::text,
                installed_constraint.condeferrable::text,
                installed_constraint.condeferred::text,
                installed_constraint.confdeltype::text,
                installed_constraint.confupdtype::text,
                pg_get_constraintdef(installed_constraint.oid)
              ),
              chr(10) ORDER BY
                installed_table.relname,
                installed_constraint.conname
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = 'cdab4cdb5dca40269d61e47ad23c7d6f4d2fa91d65d057413a18968349267bb9'
    FROM pg_catalog.pg_constraint installed_constraint
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_constraint.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_constraint.contype <> 'n'
      AND (
        installed_table.relname IN (
          'operations_shipping_scopes',
          'operations_one_off_ad_hoc_order_lines',
          'operations_one_off_ad_hoc_package_contents'
        )
        OR (
          installed_table.relname = 'operations_one_off_shipment_quotes'
          AND installed_constraint.conname IN (
            'operations_one_off_shipment_quotes_inventory_scope_valid',
            'operations_one_off_shipment_quotes_customer_scope_valid'
          )
        )
        OR (
          installed_table.relname = 'operations_orders'
          AND installed_constraint.conname =
            'operations_orders_recipient_scope_valid'
        )
      )
  )
  AND (
    SELECT count(*) = 10
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                table_namespace.nspname,
                installed_table.relname,
                installed_index_class.relname,
                access_method.amname,
                installed_index.indisprimary::text,
                installed_index.indisunique::text,
                installed_index.indisexclusion::text,
                installed_index.indimmediate::text,
                installed_index.indisclustered::text,
                installed_index.indisvalid::text,
                installed_index.indisready::text,
                installed_index.indislive::text,
                installed_index.indnkeyatts::text,
                installed_index.indnatts::text,
                installed_index.indkey::text,
                COALESCE(pg_get_expr(
                  installed_index.indexprs,
                  installed_index.indrelid
                ), ''),
                COALESCE(pg_get_expr(
                  installed_index.indpred,
                  installed_index.indrelid
                ), ''),
                pg_get_indexdef(installed_index.indexrelid)
              ),
              chr(10) ORDER BY
                installed_table.relname,
                installed_index_class.relname
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = '911e175d57db8a766f63ca11a0c927b8abb3a9a9be4b40363b4c575769a4a6ea'
    FROM pg_catalog.pg_index installed_index
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_index.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = installed_table.relnamespace
    JOIN pg_catalog.pg_class installed_index_class
      ON installed_index_class.oid = installed_index.indexrelid
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = installed_index_class.relam
    WHERE table_namespace.nspname = 'public'
      AND installed_table.relname IN (
        'operations_shipping_scopes',
        'operations_one_off_ad_hoc_order_lines',
        'operations_one_off_ad_hoc_package_contents'
      )
  )
  AND (
    WITH required_trigger(table_name, trigger_name) AS (
      VALUES
        ('operations_activation_scopes',
          'validate_ops_activation_canonical_plans'),
        ('operations_fulfillment_plans',
          'validate_ops_plan_cartonization_evidence'),
        ('operations_one_off_ad_hoc_order_lines',
          'protect_operations_one_off_ad_hoc_line_write'),
        ('operations_one_off_ad_hoc_order_lines',
          'validate_operations_one_off_ad_hoc_line_lineage_write'),
        ('operations_one_off_ad_hoc_package_contents',
          'protect_operations_one_off_ad_hoc_content_write'),
        ('operations_one_off_ad_hoc_package_contents',
          'validate_operations_one_off_ad_hoc_content_lineage_write'),
        ('operations_one_off_ad_hoc_package_contents',
          'validate_operations_one_off_ad_hoc_content_set_deferred'),
        ('operations_one_off_carrier_group_attempts',
          'validate_operations_one_off_group_prepare_write'),
        ('operations_orders',
          'validate_operations_one_off_direct_recipient_deferred'),
        ('operations_shipments',
          'validate_operations_one_off_group_shipment_write')
    )
    SELECT count(*) = 10
      AND count(installed_trigger.oid) = 10
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                required_trigger.table_name,
                table_namespace.nspname,
                required_trigger.trigger_name,
                installed_trigger.tgtype::text,
                installed_trigger.tgenabled::text,
                installed_trigger.tgisinternal::text,
                installed_trigger.tgdeferrable::text,
                installed_trigger.tginitdeferred::text,
                installed_trigger.tgattr::text,
                COALESCE(pg_get_expr(
                  installed_trigger.tgqual,
                  installed_trigger.tgrelid
                ), ''),
                procedure_namespace.nspname || '.' || installed_procedure.proname
                  || '(' || pg_get_function_identity_arguments(
                    installed_procedure.oid
                  ) || ')',
                btrim(regexp_replace(
                  pg_get_triggerdef(installed_trigger.oid),
                  '[[:space:]]+',
                  ' ',
                  'g'
                ))
              ),
              chr(10) ORDER BY
                required_trigger.table_name,
                required_trigger.trigger_name
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = 'e5f5b475936e4d2792a3fd766f2d1f0c62f329456c607f75bfb2f2492cb9e1c9'
    FROM required_trigger
    LEFT JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = to_regclass(
        'public.' || required_trigger.table_name
      )
    LEFT JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = installed_table.relnamespace
    LEFT JOIN pg_catalog.pg_trigger installed_trigger
      ON installed_trigger.tgrelid = installed_table.oid
     AND installed_trigger.tgname = required_trigger.trigger_name
    LEFT JOIN pg_catalog.pg_proc installed_procedure
      ON installed_procedure.oid = installed_trigger.tgfoid
    LEFT JOIN pg_catalog.pg_namespace procedure_namespace
      ON procedure_namespace.oid = installed_procedure.pronamespace
  )
  AND (
    SELECT count(*) = 2
      AND bool_and(
        (prefix = 'goi'
          AND entity_type = 'operations.one_off_ad_hoc_order_line'
          AND display_name = 'One-off ad-hoc item')
        OR
        (prefix = 'gohc'
          AND entity_type = 'operations.one_off_ad_hoc_package_content'
          AND display_name = 'One-off ad-hoc package content')
      )
    FROM public.global_reference_entity_types
    WHERE prefix IN ('goi', 'gohc')
  )
`
