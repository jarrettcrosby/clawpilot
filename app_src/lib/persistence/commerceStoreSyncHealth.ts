// This expression is intentionally shared by runtime health and the
// disposable-PostgreSQL tamper test. Function OIDs and trigger bindings survive
// CREATE OR REPLACE, so object-presence checks alone cannot attest the Store
// sync safety contract.
export const OPERATIONS_COMMERCE_STORE_SYNC_FUNCTION_HEALTH_SQL = String.raw`
  (
    WITH required_function(
      signature,
      body_sha256,
      language_name,
      volatility,
      result_type
    ) AS (
      VALUES
        (
          'public.operations_commerce_store_sync_effective_reason(uuid,uuid)',
          '74bebc0fb36d86c9970249a91cef314962596faf7e17ad6d426680bc6cc7c593',
          'sql', 's', 'text'
        ),
        (
          'public.operations_commerce_store_sync_is_running(uuid,uuid)',
          '10dd931110d6c6596516a08f545807710d2433ec6de0ea2faaf600f32b5b170b',
          'sql', 's', 'boolean'
        ),
        (
          'public.seed_operations_commerce_store_sync_control()',
          '82527578c401058683ed859165997af9a89ed5cee2162d09b808b485267912e1',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.protect_operations_commerce_store_sync_receipt()',
          '16279b889782e8cc3926edd0529b70740a2f3d26e9118472351873df2de55051',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.validate_operations_commerce_store_sync_identity()',
          '9ddd587a92ded9d4e531ed1cc1bcdaa49d6f39268dd901496c623b39b06d8044',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)',
          'd0e46b48d90213824182fc6aee753253f88bda93ad7a28021b6d3f835ef25d21',
          'sql', 's', 'boolean'
        ),
        (
          'public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)',
          '4f0f62a1eef912a6a648c6df67e9e1998b5f01247df9b46d006d120ac0e2abd4',
          'sql', 's', 'boolean'
        ),
        (
          'public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)',
          '9e11bd5dd48b47d7fbee5db9e88db82bc012ba9b8feb9d62694aca8ad052d5c5',
          'sql', 's', 'boolean'
        ),
        (
          'public.guard_operations_commerce_product_image_read_authority()',
          '056c1f8a5ae21ae7cc0098e89a810dfe1c8cc7212e7d5c83d70fd7729d622b72',
          'plpgsql', 'v', 'trigger'
        ),
        (
          'public.guard_operations_commerce_store_sync_read_lease()',
          '1749c76b4da7f20107175c650cfb09c1eeb13ef6b07dbee22b1d656431368ecf',
          'plpgsql', 'v', 'trigger'
        )
    )
    SELECT count(*) = 10
      AND count(installed_function.oid) = 10
      AND bool_and(COALESCE(
        encode(
          digest(
            convert_to(
              btrim(regexp_replace(
                installed_function.prosrc,
                '[[:space:]]+', ' ', 'g'
              )),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ) = required_function.body_sha256
        AND installed_language.lanname = required_function.language_name
        AND installed_function.provolatile = required_function.volatility
        AND pg_get_function_result(installed_function.oid) =
              required_function.result_type
        AND installed_function.prokind = 'f'
        AND NOT installed_function.proisstrict
        AND NOT installed_function.prosecdef
        AND NOT installed_function.proleakproof
        AND installed_function.proparallel = 'u'
        AND installed_function.proconfig IS NULL,
        false
      ))
    FROM required_function
    LEFT JOIN pg_proc installed_function
      ON installed_function.oid = to_regprocedure(
        required_function.signature
      )
    LEFT JOIN pg_language installed_language
      ON installed_language.oid = installed_function.prolang
  )
`

// Migration 0298 deliberately rewrites several pre-existing order/webhook and
// product-image functions. Pin the complete resulting catalog, not only the
// six newly introduced control functions, so a legacy activation latch or a
// weakened projection/lineage guard cannot be restored with CREATE OR REPLACE.
export const OPERATIONS_COMMERCE_STORE_SYNC_REWRITTEN_FUNCTION_HEALTH_SQL =
  String.raw`
  (
    WITH required_function(signature) AS (
      VALUES
        ('public.operations_commerce_store_sync_effective_reason(uuid,uuid)'),
        ('public.operations_commerce_store_sync_is_running(uuid,uuid)'),
        ('public.operations_commerce_provider_read_authority_is_current(uuid,uuid,text)'),
        ('public.operations_commerce_product_image_read_authority_is_current(uuid,uuid,text,integer,text)'),
        ('public.guard_operations_commerce_product_image_read_authority()'),
        ('public.guard_operations_commerce_store_sync_read_lease()'),
        ('public.seed_operations_commerce_store_sync_control()'),
        ('public.protect_commerce_order_sync_session_lineage()'),
        ('public.protect_commerce_order_observation_lineage()'),
        ('public.commerce_order_observation_accepts_children(uuid,uuid)'),
        ('public.protect_shopify_order_webhook_read()'),
        ('public.protect_shopify_order_webhook_target()'),
        ('public.guard_operations_commerce_product_image_binding()'),
        ('public.protect_operations_commerce_store_sync_receipt()'),
        ('public.validate_operations_commerce_store_sync_identity()'),
        ('public.operations_shopify_inventory_read_config_is_ready(uuid,uuid)'),
        ('public.operations_commerce_product_image_account_is_current(uuid,uuid,text,integer)'),
        ('public.operations_commerce_product_image_account_lineage_is_current(uuid,uuid,text,integer)'),
        ('public.operations_commerce_product_image_mapping_targets(uuid,uuid,text,text)'),
        ('public.operations_commerce_product_image_job_fences_are_current(uuid,uuid)'),
        ('public.operations_commerce_product_image_projection_fences_are_current(uuid,uuid)')
    )
    SELECT count(*) = 21
      AND count(installed_function.oid) = 21
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                required_function.signature,
                btrim(regexp_replace(
                  installed_function.prosrc,
                  '[[:space:]]+', ' ', 'g'
                )),
                installed_language.lanname,
                installed_function.provolatile::text,
                installed_function.proisstrict::text,
                installed_function.prosecdef::text,
                installed_function.proleakproof::text,
                installed_function.proparallel::text,
                COALESCE(
                  array_to_string(installed_function.proconfig, ','),
                  ''
                ),
                pg_get_function_result(installed_function.oid)
              ),
              chr(10) ORDER BY required_function.signature
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = '4b2c6336c67d022571a0086f47a60cacb0ebd02b6582b1104d96a99fa76be959'
    FROM required_function
    LEFT JOIN pg_proc installed_function
      ON installed_function.oid = to_regprocedure(
        required_function.signature
      )
    LEFT JOIN pg_language installed_language
      ON installed_language.oid = installed_function.prolang
  )
`

// Pin every control/receipt constraint and every unique index, including the
// exact constrained key order. Count/type checks do not detect a same-named
// CHECK (true) replacement or a re-keyed unique index.
export const OPERATIONS_COMMERCE_STORE_SYNC_STRUCTURE_HEALTH_SQL = String.raw`
  (
    (
      SELECT encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                installed_table.relname,
                installed_constraint.conname,
                installed_constraint.contype::text,
                installed_constraint.convalidated::text,
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
      )
      FROM pg_constraint installed_constraint
      JOIN pg_class installed_table
        ON installed_table.oid = installed_constraint.conrelid
      JOIN pg_namespace installed_namespace
        ON installed_namespace.oid = installed_table.relnamespace
      WHERE installed_namespace.nspname = 'public'
        AND (
          installed_constraint.conrelid IN (
            to_regclass('public.operations_commerce_store_sync_controls'),
            to_regclass('public.operations_commerce_store_sync_change_receipts'),
            to_regclass('public.operations_commerce_store_sync_read_leases')
          )
          OR (
            installed_constraint.conrelid = to_regclass(
              'public.operations_commerce_intake_read_intents'
            )
            AND installed_constraint.conname =
              'commerce_intake_read_intents_authority_valid'
          )
          OR (
            installed_constraint.conrelid = to_regclass(
              'public.operations_commerce_product_image_observation_sets'
            )
            AND installed_constraint.conname =
              'ops_commerce_image_set_authority_valid'
          )
          OR (
            installed_constraint.conrelid = to_regclass(
              'public.operations_commerce_product_image_import_jobs'
            )
            AND installed_constraint.conname =
              'ops_commerce_image_job_authority_valid'
          )
        )
    ) = 'a28138f13bf3b2eaf60624e9efb6e7fff669032bcf27043adff648b2d82528da'
    AND (
      SELECT encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                installed_table.relname,
                installed_index_class.relname,
                installed_index.indisprimary::text,
                installed_index.indisunique::text,
                installed_index.indisvalid::text,
                installed_index.indisready::text,
                installed_index.indkey::text,
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
      )
      FROM pg_index installed_index
      JOIN pg_class installed_table
        ON installed_table.oid = installed_index.indrelid
      JOIN pg_class installed_index_class
        ON installed_index_class.oid = installed_index.indexrelid
      JOIN pg_namespace installed_namespace
        ON installed_namespace.oid = installed_table.relnamespace
      WHERE installed_namespace.nspname = 'public'
        AND installed_index.indrelid IN (
          to_regclass('public.operations_commerce_store_sync_controls'),
          to_regclass('public.operations_commerce_store_sync_change_receipts'),
          to_regclass('public.operations_commerce_store_sync_read_leases')
        )
    ) = '05e6f2a2a4ea7612265a6063c89670f73aa5030a26ddffe80601ba24fd310498'
    AND (
      SELECT encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                table_name,
                column_name,
                ordinal_position::text,
                data_type,
                udt_schema,
                udt_name,
                is_nullable,
                COALESCE(column_default, '<null>'),
                is_identity,
                COALESCE(identity_generation, '<null>'),
                is_generated,
                COALESCE(generation_expression, '<null>'),
                COALESCE(collation_schema, '<null>'),
                COALESCE(collation_name, '<null>'),
                COALESCE(character_maximum_length::text, '<null>'),
                COALESCE(numeric_precision::text, '<null>'),
                COALESCE(numeric_scale::text, '<null>'),
                COALESCE(datetime_precision::text, '<null>')
              ),
              chr(10) ORDER BY table_name, column_name
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          table_name IN (
            'operations_commerce_store_sync_controls',
            'operations_commerce_store_sync_change_receipts',
            'operations_commerce_store_sync_read_leases'
          )
          OR (
            table_name IN (
              'operations_commerce_intake_read_intents',
              'operations_commerce_product_image_observation_sets',
              'operations_commerce_product_image_import_jobs'
            )
            AND column_name = 'provider_read_authority'
          )
        )
    ) = '11af8d59cf42933abe8fd264e69d9714d0fe2d83e455cc1f1096393cac066eb1'
    AND (
      SELECT string_agg(
        concat_ws(
          '|',
          trigger_table.relname,
          installed_trigger.tgname,
          installed_trigger.tgfoid::regprocedure::text,
          installed_trigger.tgenabled,
          installed_trigger.tgtype::text,
          installed_trigger.tgisinternal::text,
          COALESCE(pg_get_expr(
            installed_trigger.tgqual,
            installed_trigger.tgrelid
          ), '')
        ),
        chr(10) ORDER BY trigger_table.relname, installed_trigger.tgname
      )
      FROM pg_trigger installed_trigger
      JOIN pg_class trigger_table
        ON trigger_table.oid = installed_trigger.tgrelid
      JOIN pg_namespace trigger_namespace
        ON trigger_namespace.oid = trigger_table.relnamespace
      WHERE trigger_namespace.nspname = 'public'
        AND (
          (installed_trigger.tgrelid = to_regclass(
             'public.operations_commerce_store_sync_read_leases'
           ) AND installed_trigger.tgname =
             'guard_operations_commerce_store_sync_read_lease_write')
          OR (installed_trigger.tgrelid = to_regclass(
             'public.operations_commerce_store_sync_controls'
           ) AND installed_trigger.tgname =
             'validate_operations_commerce_store_sync_identity_write')
          OR (installed_trigger.tgrelid = to_regclass(
             'public.operations_commerce_store_sync_change_receipts'
           ) AND installed_trigger.tgname =
             'protect_operations_commerce_store_sync_receipt_write')
          OR (installed_trigger.tgrelid = to_regclass(
             'public.operations_integration_accounts'
           ) AND installed_trigger.tgname =
             'seed_operations_commerce_store_sync_control_write')
          OR (installed_trigger.tgrelid = to_regclass(
             'public.operations_commerce_product_image_observation_sets'
           ) AND installed_trigger.tgname =
             'guard_operations_commerce_image_set_authority_write')
          OR (installed_trigger.tgrelid = to_regclass(
             'public.operations_commerce_product_image_import_jobs'
           ) AND installed_trigger.tgname =
             'guard_operations_commerce_image_job_authority_write')
        )
    ) = concat_ws(
      chr(10),
      'operations_commerce_product_image_import_jobs|guard_operations_commerce_image_job_authority_write|guard_operations_commerce_product_image_read_authority()|O|19|false|',
      'operations_commerce_product_image_observation_sets|guard_operations_commerce_image_set_authority_write|guard_operations_commerce_product_image_read_authority()|O|19|false|',
      'operations_commerce_store_sync_change_receipts|protect_operations_commerce_store_sync_receipt_write|protect_operations_commerce_store_sync_receipt()|O|27|false|',
      'operations_commerce_store_sync_controls|validate_operations_commerce_store_sync_identity_write|validate_operations_commerce_store_sync_identity()|O|23|false|',
      'operations_commerce_store_sync_read_leases|guard_operations_commerce_store_sync_read_lease_write|guard_operations_commerce_store_sync_read_lease()|O|31|false|',
      'operations_integration_accounts|seed_operations_commerce_store_sync_control_write|seed_operations_commerce_store_sync_control()|O|5|false|'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM operations_commerce_store_sync_read_leases lease
      WHERE lease.released_at IS NULL
        AND lease.expires_at <= clock_timestamp()
    )
  )
`
