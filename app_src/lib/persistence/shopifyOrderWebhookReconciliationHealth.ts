export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION =
  '0303_operations_shopify_order_webhook_reconciliation.sql' as const

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION_CHECKSUM =
  'a80246b6e9ec80daf438bae7ef77f9ae1dc73d28eb18d8603335447a0dc7d337' as const

export const SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE filename =
      '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION}'
      AND checksum =
        '${SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_MIGRATION_CHECKSUM}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('operations_shopify_order_webhook_commands'),
      ('operations_shopify_order_webhook_attempts'),
      ('operations_shopify_order_webhook_outcomes')
    ) required_table(name)
    WHERE to_regclass(required_table.name) IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('operations_shopify_order_webhook_commands', 'idempotency_key'),
      ('operations_shopify_order_webhook_commands', 'status'),
      ('operations_shopify_order_webhook_attempts', 'attempt_number'),
      ('operations_shopify_order_webhook_attempts', 'mutation_plan'),
      ('operations_shopify_order_webhook_outcomes', 'completed_mutations'),
      ('operations_shopify_order_webhook_outcomes', 'stopped_mutation'),
      ('operations_shopify_order_webhook_outcomes', 'stop_classification')
    ) required_column(table_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass(required_column.table_name)
        AND attribute.attname = required_column.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('operations_shopify_order_webhook_plan_is_valid(jsonb)'),
      ('operations_shopify_order_webhook_refs_are_valid(text[])'),
      ('operations_shopify_order_webhook_completions_are_valid(jsonb)'),
      ('protect_shopify_order_webhook_command()'),
      ('protect_shopify_order_webhook_attempt()'),
      ('protect_shopify_order_webhook_outcome()'),
      ('protect_shopify_order_webhook_binding_drift()'),
      ('protect_shopify_order_webhook_credential_drift()')
    ) required_function(signature)
    WHERE to_regprocedure(required_function.signature) IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      (
        'operations_shopify_order_webhook_commands',
        'protect_shopify_order_webhook_command_write',
        'protect_shopify_order_webhook_command()', 23
      ),
      (
        'operations_shopify_order_webhook_attempts',
        'protect_shopify_order_webhook_attempt_write',
        'protect_shopify_order_webhook_attempt()', 31
      ),
      (
        'operations_shopify_order_webhook_outcomes',
        'protect_shopify_order_webhook_outcome_write',
        'protect_shopify_order_webhook_outcome()', 31
      ),
      (
        'operations_integration_accounts',
        'protect_shopify_order_webhook_account_drift',
        'protect_shopify_order_webhook_binding_drift()', 19
      ),
      (
        'operations_commerce_credentials',
        'protect_shopify_order_webhook_credential_drift',
        'protect_shopify_order_webhook_credential_drift()', 19
      )
    ) required_trigger(table_name, trigger_name, function_signature, type_bits)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger installed
      WHERE installed.tgrelid = to_regclass(required_trigger.table_name)
        AND installed.tgname = required_trigger.trigger_name
        AND installed.tgfoid = to_regprocedure(
          required_trigger.function_signature
        )
        AND installed.tgtype = required_trigger.type_bits
        AND installed.tgenabled = 'O'
        AND NOT installed.tgisinternal
    )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_index installed_index
    WHERE installed_index.indexrelid = to_regclass(
      'ops_shopify_order_webhook_one_open_idx'
    )
      AND installed_index.indisunique
      AND installed_index.indisvalid
      AND installed_index.indisready
  )
`
