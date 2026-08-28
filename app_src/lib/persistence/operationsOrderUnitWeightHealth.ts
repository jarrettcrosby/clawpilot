export const OPERATIONS_ORDER_UNIT_WEIGHT_MIGRATION =
  '0336_operations_order_unit_physical_facts.sql' as const
export const OPERATIONS_ORDER_UNIT_WEIGHT_MIGRATION_CHECKSUM =
  '703b24f9eb3c255bb7f7594010fe40f8e0fc6fb02e99fc49fe18331204483e47' as const

export const OPERATIONS_ORDER_UNIT_WEIGHT_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1
    FROM public.schema_migrations migration
    WHERE migration.filename =
      '0336_operations_order_unit_physical_facts.sql'
      AND migration.checksum =
        '703b24f9eb3c255bb7f7594010fe40f8e0fc6fb02e99fc49fe18331204483e47'
  )
  AND pg_catalog.to_regclass(
    'public.operations_order_unit_weight_facts'
  ) IS NOT NULL
  AND (
    SELECT pg_catalog.count(*) = 29
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.operations_order_unit_weight_facts'
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  )
  AND EXISTS (
    SELECT 1
    FROM public.global_reference_entity_types entity_type
    WHERE entity_type.prefix = 'gouw'
      AND entity_type.entity_type = 'operations.order_unit_weight_fact'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM (VALUES
      ('validate_operations_order_unit_weight_fact()'),
      ('protect_operations_order_unit_weight_fact()'),
      ('protect_operations_order_unit_weight_receipt()')
    ) required(signature)
    WHERE pg_catalog.to_regprocedure(
      'public.' || required.signature
    ) IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
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
      )
    ) required(table_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger installed
      WHERE installed.tgrelid = pg_catalog.to_regclass(
        'public.' || required.table_name
      )
        AND installed.tgname = required.trigger_name
        AND installed.tgenabled = 'O'
        AND NOT installed.tgisinternal
    )
  )
`
