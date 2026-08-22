import {
  OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACT_COUNT,
  OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACT_HASH,
  OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACTS_SQL,
  OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_MIGRATION_CHECKSUM,
} from '@/lib/persistence/operationsOrderEditingReleaseHealth'

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION =
  '0303_operations_shopify_order_webhook_reconciliation.sql' as const

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION_CHECKSUM =
  '6c1041b8d5dd33a1bdfb68f855d9b5dc7b306e90e9bfbb16fa9ac087d52d42b8' as const

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_MIGRATION =
  '0316_operations_commerce_fulfillment_authority_leases.sql' as const

const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_PRE_LEASE_FUNCTION_HASH =
  '9ccde1c41904db27900dc0800c0077e7fa1a7ce70d02f1035324d2a60e27bb43'

const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_FUNCTION_HASH =
  'aeb0974f7c1c7bd8decaeefa409b8a7cecaffc97e4d66af12aca0790162489b1'

const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_PRE_LEASE_TRIGGER_HASH =
  '0ebf3a87d12028aff7bf8252f3c82d3565e654879311f8c427eefd7d5d88c39a'

const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_TRIGGER_HASH =
  'bab09e9c0408f54b6ce113c9a60e4175d7f529f7bcc2ad53f284aa701222e5a9'

// This expression is shared by runtime health and disposable-PostgreSQL
// tamper tests. Every name is public-qualified: a search_path lookalike must
// never satisfy release health.
export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations installed_migration
    WHERE installed_migration.filename =
      '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION}'
      AND installed_migration.checksum =
        '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION_CHECKSUM}'
  )
  AND (
    WITH required_table(name) AS (
      VALUES
        ('operations_shopify_order_webhook_commands'),
        ('operations_shopify_order_webhook_attempts'),
        ('operations_shopify_order_webhook_outcomes')
    )
    SELECT count(*) = 3
      AND count(installed_table.oid) = 3
      AND bool_and(COALESCE(
        installed_namespace.nspname = 'public'
        AND installed_table.relkind = 'r'
        AND installed_table.relpersistence = 'p'
        AND NOT installed_table.relispartition,
        false
      ))
    FROM required_table
    LEFT JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = pg_catalog.to_regclass(
        'public.' || required_table.name
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
  )
  AND (
    WITH required_function(signature) AS (
      VALUES
        ('public.operations_shopify_order_webhook_plan_is_valid(jsonb)'),
        ('public.operations_shopify_order_webhook_refs_are_valid(text[])'),
        ('public.operations_shopify_order_webhook_completions_are_valid(jsonb)'),
        ('public.protect_shopify_order_webhook_command()'),
        ('public.protect_shopify_order_webhook_attempt()'),
        ('public.protect_shopify_order_webhook_outcome()'),
        ('public.protect_shopify_order_webhook_binding_drift()'),
        ('public.protect_shopify_order_webhook_credential_drift()'),
        ('public.protect_shopify_order_webhook_membership_drift()')
    )
    SELECT count(*) = 9
      AND count(installed_function.oid) = 9
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
                installed_function.proisstrict::text,
                installed_function.prosecdef::text,
                installed_function.proleakproof::text,
                installed_function.proparallel::text,
                COALESCE(array_to_string(installed_function.proconfig, ','), ''),
                pg_catalog.pg_get_function_result(installed_function.oid),
                btrim(regexp_replace(
                  installed_function.prosrc,
                  '[[:space:]]+', ' ', 'g'
                ))
              ),
              chr(10) ORDER BY required_function.signature
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) = CASE
        WHEN EXISTS (
          SELECT 1
          FROM public.schema_migrations installed_phase
          WHERE installed_phase.filename =
            '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_MIGRATION}'
        )
        THEN '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_FUNCTION_HASH}'
        ELSE '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_PRE_LEASE_FUNCTION_HASH}'
      END
    FROM required_function
    LEFT JOIN pg_catalog.pg_proc installed_function
      ON installed_function.oid = pg_catalog.to_regprocedure(
        required_function.signature
      )
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_function.pronamespace
    LEFT JOIN pg_catalog.pg_language installed_language
      ON installed_language.oid = installed_function.prolang
  )
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              table_schema,
              table_name,
              column_name,
              ordinal_position::text,
              column_default,
              is_nullable,
              data_type,
              character_maximum_length::text,
              numeric_precision::text,
              numeric_scale::text,
              datetime_precision::text,
              udt_schema,
              udt_name,
              is_identity,
              identity_generation,
              is_generated,
              generation_expression,
              collation_schema,
              collation_name
            ),
            chr(10) ORDER BY table_name, ordinal_position
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'operations_shopify_order_webhook_commands',
        'operations_shopify_order_webhook_attempts',
        'operations_shopify_order_webhook_outcomes'
      )
  ) = 'fe7d2a4a16a2fbfe8a7581371cb9eacdd5fe81409c3f05a0e55184de404eccb8'
  AND (
    SELECT encode(
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
              installed_constraint.confmatchtype::text,
              installed_constraint.confupdtype::text,
              installed_constraint.confdeltype::text,
              installed_constraint.conkey::text,
              installed_constraint.confkey::text,
              COALESCE(referenced_namespace.nspname, ''),
              COALESCE(referenced_table.relname, ''),
              pg_catalog.pg_get_constraintdef(
                installed_constraint.oid,
                false
              )
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
    FROM pg_catalog.pg_constraint installed_constraint
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_constraint.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    LEFT JOIN pg_catalog.pg_class referenced_table
      ON referenced_table.oid = installed_constraint.confrelid
    LEFT JOIN pg_catalog.pg_namespace referenced_namespace
      ON referenced_namespace.oid = referenced_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_constraint.contype <> 'n'
      AND installed_table.relname IN (
        'operations_shopify_order_webhook_commands',
        'operations_shopify_order_webhook_attempts',
        'operations_shopify_order_webhook_outcomes'
      )
  ) = '71526ec79fea222400bffe665939baf91e9d3afca42b01d564fbdcec50c7f404'
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              installed_namespace.nspname,
              installed_table.relname,
              installed_index_class.relname,
              installed_index.indisprimary::text,
              installed_index.indisunique::text,
              installed_index.indisvalid::text,
              installed_index.indisready::text,
              installed_index.indimmediate::text,
              installed_index.indisreplident::text,
              installed_index.indkey::text,
              installed_index.indoption::text,
              COALESCE(pg_catalog.pg_get_expr(
                installed_index.indexprs,
                installed_index.indrelid
              ), ''),
              COALESCE(pg_catalog.pg_get_expr(
                installed_index.indpred,
                installed_index.indrelid
              ), ''),
              pg_catalog.pg_get_indexdef(installed_index.indexrelid)
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
    FROM pg_catalog.pg_index installed_index
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_index.indrelid
    JOIN pg_catalog.pg_class installed_index_class
      ON installed_index_class.oid = installed_index.indexrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_table.relname IN (
        'operations_shopify_order_webhook_commands',
        'operations_shopify_order_webhook_attempts',
        'operations_shopify_order_webhook_outcomes'
      )
  ) = '31d9859e992272e61e9fc807c90342de58795eadf9dcc5432c404ff387ab7822'
  AND (
    WITH required_trigger(table_name, trigger_name, function_signature) AS (
      VALUES
        (
          'operations_shopify_order_webhook_commands',
          'protect_shopify_order_webhook_command_write',
          'public.protect_shopify_order_webhook_command()'
        ),
        (
          'operations_shopify_order_webhook_attempts',
          'protect_shopify_order_webhook_attempt_write',
          'public.protect_shopify_order_webhook_attempt()'
        ),
        (
          'operations_shopify_order_webhook_outcomes',
          'protect_shopify_order_webhook_outcome_write',
          'public.protect_shopify_order_webhook_outcome()'
        ),
        (
          'operations_integration_accounts',
          'protect_shopify_order_webhook_account_drift',
          'public.protect_shopify_order_webhook_binding_drift()'
        ),
        (
          'operations_commerce_credentials',
          'protect_shopify_order_webhook_credential_drift',
          'public.protect_shopify_order_webhook_credential_drift()'
        ),
        (
          'app_user_organization_memberships',
          'protect_shopify_order_webhook_membership_drift',
          'public.protect_shopify_order_webhook_membership_drift()'
        )
    )
    SELECT count(*) = 6
      AND count(installed_trigger.oid) = 6
      AND bool_and(COALESCE(
        installed_trigger.tgfoid = pg_catalog.to_regprocedure(
          required_trigger.function_signature
        )
        AND installed_trigger.tgrelid = pg_catalog.to_regclass(
          'public.' || required_trigger.table_name
        ),
        false
      ))
      AND encode(
        digest(
          convert_to(
            string_agg(
              concat_ws(
                '|',
                required_trigger.table_name,
                required_trigger.trigger_name,
                required_trigger.function_signature,
                installed_namespace.nspname,
                installed_trigger.tgenabled,
                installed_trigger.tgtype::text,
                installed_trigger.tgisinternal::text,
                installed_trigger.tgparentid::text,
                installed_trigger.tgfoid::regprocedure::text,
                COALESCE(pg_catalog.pg_get_expr(
                  installed_trigger.tgqual,
                  installed_trigger.tgrelid
                ), ''),
                pg_catalog.pg_get_triggerdef(installed_trigger.oid, false)
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
      ) = 'f6930aa4c12f9bdad14c958624eefe4b8571ef8e5c99423c03e45316744b8c30'
    FROM required_trigger
    LEFT JOIN pg_catalog.pg_trigger installed_trigger
      ON installed_trigger.tgrelid = pg_catalog.to_regclass(
           'public.' || required_trigger.table_name
         )
     AND installed_trigger.tgname = required_trigger.trigger_name
     AND NOT installed_trigger.tgisinternal
    LEFT JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_trigger.tgrelid
    LEFT JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
  )
  AND (
    SELECT encode(
      digest(
        convert_to(
          string_agg(
            concat_ws(
              '|',
              complete_namespace.nspname,
              complete_table.relname,
              complete_trigger.tgname,
              complete_trigger.tgenabled,
              complete_trigger.tgtype::text,
              complete_trigger.tgisinternal::text,
              complete_trigger.tgparentid::text,
              complete_trigger.tgfoid::regprocedure::text,
              COALESCE(pg_catalog.pg_get_expr(
                complete_trigger.tgqual,
                complete_trigger.tgrelid
              ), ''),
              pg_catalog.pg_get_triggerdef(complete_trigger.oid, false)
            ),
            chr(10) ORDER BY
              complete_table.relname,
              complete_trigger.tgname
          ),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    FROM pg_catalog.pg_trigger complete_trigger
    JOIN pg_catalog.pg_class complete_table
      ON complete_table.oid = complete_trigger.tgrelid
    JOIN pg_catalog.pg_namespace complete_namespace
      ON complete_namespace.oid = complete_table.relnamespace
    WHERE complete_namespace.nspname = 'public'
      AND NOT complete_trigger.tgisinternal
      AND complete_table.relname IN (
        'operations_shopify_order_webhook_commands',
        'operations_shopify_order_webhook_attempts',
        'operations_shopify_order_webhook_outcomes',
        'operations_integration_accounts',
        'operations_commerce_credentials',
        'app_user_organization_memberships'
      )
  ) = CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.schema_migrations installed_phase
      WHERE installed_phase.filename =
        '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_MIGRATION}'
    )
    THEN '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_TRIGGER_HASH}'
    ELSE '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_PRE_LEASE_TRIGGER_HASH}'
  END
  AND CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.schema_migrations installed_phase
      WHERE installed_phase.filename =
        '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_MIGRATION}'
    )
    THEN true
    ELSE (
      EXISTS (
        SELECT 1
        FROM public.schema_migrations installed_phase
        WHERE installed_phase.filename =
          '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_LEASE_MIGRATION}'
          AND installed_phase.checksum =
            '${OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_MIGRATION_CHECKSUM}'
      )
      AND (
        WITH ${OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACTS_SQL}
        SELECT pg_catalog.count(*) =
                 ${OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACT_COUNT}
          AND pg_catalog.encode(public.digest(pg_catalog.convert_to(
            pg_catalog.string_agg(
              kind || '|' || identity || '|' || definition,
              pg_catalog.chr(10) ORDER BY kind, identity
            ), 'UTF8'
          ), 'sha256'), 'hex') =
            '${OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_ARTIFACT_HASH}'
        FROM artifacts
      )
    )
  END
`
