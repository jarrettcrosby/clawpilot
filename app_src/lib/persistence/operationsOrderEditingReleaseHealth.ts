// Exact current-release attestation for the additive order-editing migrations.
// The ledgers pin reviewed migration bytes. Catalog fingerprints prevent a
// correct ledger row from blessing a missing or drifted table, constraint,
// function, view, index, or trigger.

export const OPERATIONS_COMMERCE_ORDER_WORKBENCH_MIGRATION_CHECKSUM =
  'b4dd10ac0d4c220730b682db3753710cfacb627090ebc30e4075b28e7265fe6c'

export const OPERATIONS_PROVIDER_WRITE_CONTROLS_MIGRATION_CHECKSUM =
  '86e39d6e19962894b94466a6fad367682093dc6271e0df92c9cade112ad075b6'

export const OPERATIONS_ORDER_SHIPMENT_ADDRESS_MIGRATION_CHECKSUM =
  '6ad6749c89effe427baef8bbdfe51d3a04e8be6bc2ce8922916e901c069b9d06'

export const OPERATIONS_SHOPIFY_SINGLE_SAVE_MIGRATION_CHECKSUM =
  'b0f591edc2dd10c6f9a8e88ef3291b9b8b1bd056fcafa159c2686d00cde44dcb'

const tableRelationArtifact = (tableName: string) => String.raw`
  SELECT 'relation'::text AS kind,
         installed_namespace.nspname || '.' || installed_table.relname
           AS identity,
         pg_catalog.concat_ws('|',
           installed_table.relkind::text,
           installed_table.relpersistence::text,
           installed_table.relrowsecurity::text,
           installed_table.relforcerowsecurity::text
         ) AS definition
  FROM pg_catalog.pg_class installed_table
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  WHERE installed_namespace.nspname = 'public'
    AND installed_table.relname = '${tableName}'
`

const tableColumnArtifacts = (tableName: string) => String.raw`
  SELECT 'column'::text,
         installed_table.relname || '.' || installed_column.attnum::text
           || '.' || installed_column.attname,
         pg_catalog.concat_ws('|',
           pg_catalog.format_type(
             installed_column.atttypid, installed_column.atttypmod
           ),
           installed_column.attnotnull::text,
           COALESCE(pg_catalog.pg_get_expr(
             installed_default.adbin, installed_default.adrelid
           ), ''),
           installed_column.attidentity::text,
           installed_column.attgenerated::text,
           COALESCE(installed_collation.collname, '')
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
  LEFT JOIN pg_catalog.pg_collation installed_collation
    ON installed_collation.oid = installed_column.attcollation
  WHERE installed_namespace.nspname = 'public'
    AND installed_table.relname = '${tableName}'
`

const tableConstraintArtifacts = (tableName: string) => String.raw`
  SELECT 'constraint'::text,
         installed_table.relname || '.' || installed_constraint.conname,
         pg_catalog.concat_ws('|',
           installed_constraint.contype::text,
           installed_constraint.convalidated::text,
           installed_constraint.connoinherit::text,
           installed_constraint.condeferrable::text,
           installed_constraint.condeferred::text,
           installed_constraint.confdeltype::text,
           installed_constraint.confupdtype::text,
           pg_catalog.pg_get_constraintdef(installed_constraint.oid, false)
         )
  FROM pg_catalog.pg_constraint installed_constraint
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid = installed_constraint.conrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  WHERE installed_namespace.nspname = 'public'
    AND installed_table.relname = '${tableName}'
    AND installed_constraint.contype <> 'n'
`

const tableIndexArtifacts = (tableName: string) => String.raw`
  SELECT 'index'::text,
         installed_table.relname || '.' || installed_index.relname,
         pg_catalog.concat_ws('|',
           index_metadata.indisunique::text,
           index_metadata.indisprimary::text,
           index_metadata.indisvalid::text,
           index_metadata.indisready::text,
           pg_catalog.pg_get_indexdef(installed_index.oid)
         )
  FROM pg_catalog.pg_index index_metadata
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid = index_metadata.indrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  JOIN pg_catalog.pg_class installed_index
    ON installed_index.oid = index_metadata.indexrelid
  WHERE installed_namespace.nspname = 'public'
    AND installed_table.relname = '${tableName}'
`

const functionArtifacts = (signatures: string[]) => String.raw`
  SELECT 'function'::text,
         required.signature,
         pg_catalog.concat_ws('|',
           installed_namespace.nspname,
           installed_language.lanname,
           installed_function.prokind::text,
           installed_function.provolatile::text,
           installed_function.proparallel::text,
           installed_function.proisstrict::text,
           installed_function.prosecdef::text,
           installed_function.proleakproof::text,
           pg_catalog.pg_get_function_result(installed_function.oid),
           installed_function.pronargs::text,
           installed_function.pronargdefaults::text,
           COALESCE(pg_catalog.array_to_string(
             installed_function.proconfig, ','
           ), ''),
           pg_catalog.btrim(pg_catalog.regexp_replace(
             installed_function.prosrc, '[[:space:]]+', ' ', 'g'
           ))
         )
  FROM (VALUES
    ${signatures.map((signature) => `('${signature}')`).join(',\n    ')}
  ) required(signature)
  JOIN pg_catalog.pg_proc installed_function
    ON installed_function.oid = pg_catalog.to_regprocedure(required.signature)
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_function.pronamespace
  JOIN pg_catalog.pg_language installed_language
    ON installed_language.oid = installed_function.prolang
`

const tableTriggerArtifacts = (tableName: string) => String.raw`
  SELECT 'trigger'::text,
         installed_table.relname || '.' || installed_trigger.tgname,
         pg_catalog.concat_ws('|',
           installed_trigger.tgtype::text,
           installed_trigger.tgenabled::text,
           installed_trigger.tgisinternal::text,
           installed_trigger.tgconstraint::text,
           function_namespace.nspname || '.' || trigger_function.proname
             || '(' || pg_catalog.pg_get_function_identity_arguments(
               trigger_function.oid
             ) || ')',
           COALESCE(pg_catalog.pg_get_expr(
             installed_trigger.tgqual, installed_trigger.tgrelid
           ), ''),
           pg_catalog.btrim(pg_catalog.regexp_replace(
             pg_catalog.pg_get_triggerdef(installed_trigger.oid),
             '[[:space:]]+', ' ', 'g'
           ))
         )
  FROM pg_catalog.pg_trigger installed_trigger
  JOIN pg_catalog.pg_class installed_table
    ON installed_table.oid = installed_trigger.tgrelid
  JOIN pg_catalog.pg_namespace installed_namespace
    ON installed_namespace.oid = installed_table.relnamespace
  JOIN pg_catalog.pg_proc trigger_function
    ON trigger_function.oid = installed_trigger.tgfoid
  JOIN pg_catalog.pg_namespace function_namespace
    ON function_namespace.oid = trigger_function.pronamespace
  WHERE installed_namespace.nspname = 'public'
    AND installed_table.relname = '${tableName}'
    AND NOT installed_trigger.tgisinternal
`

export const OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACTS_SQL = String.raw`
  artifacts(kind, identity, definition) AS (
    ${tableRelationArtifact('operations_commerce_order_workbench')}
    UNION ALL
    ${tableColumnArtifacts('operations_commerce_order_workbench')}
    UNION ALL
    ${tableConstraintArtifacts('operations_commerce_order_workbench')}
    UNION ALL
    ${tableIndexArtifacts('operations_commerce_order_workbench')}
    UNION ALL
    ${functionArtifacts([
      'public.operations_commerce_order_workbench_line_drafts_valid(jsonb)',
      'public.validate_operations_commerce_order_workbench()',
    ])}
    UNION ALL
    ${tableTriggerArtifacts('operations_commerce_order_workbench')}
  )
`

export const OPERATIONS_COMMERCE_ORDER_WORKBENCH_FINGERPRINT_SQL = String.raw`
  WITH ${OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACTS_SQL}
  SELECT pg_catalog.count(*)::integer AS artifact_count,
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           pg_catalog.string_agg(
             kind || '|' || identity || '|' || definition,
             pg_catalog.chr(10) ORDER BY kind, identity
           ), 'UTF8'
         ), 'sha256'), 'hex') AS artifact_hash
  FROM artifacts
`

export const OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACTS_SQL = String.raw`
  artifacts(kind, identity, definition) AS (
    ${tableRelationArtifact('operations_commerce_provider_write_controls')}
    UNION ALL
    ${tableColumnArtifacts('operations_commerce_provider_write_controls')}
    UNION ALL
    SELECT 'column'::text,
           installed.table_name || '.' || installed.ordinal_position::text
             || '.' || installed.column_name,
           pg_catalog.concat_ws('|',
             installed.data_type,
             installed.udt_schema,
             installed.udt_name,
             installed.is_nullable,
             COALESCE(installed.column_default, '')
           )
    FROM information_schema.columns installed
    WHERE installed.table_schema = 'public'
      AND (installed.table_name, installed.column_name) IN (
        ('operations_shopify_order_management_authorizations', 'activation_state'),
        ('operations_shopify_order_management_authorizations', 'activation_revision'),
        ('operations_shopify_order_management_authorizations', 'authorized_role'),
        ('operations_shopify_order_management_authorizations', 'provider_write_control_row_version'),
        ('operations_shopify_order_management_authorizations', 'provider_write_scope_digest'),
        ('operations_shopify_order_management_authorizations', 'requested_projection_hash'),
        ('operations_shopify_order_management_authorizations', 'requires_order_edits'),
        ('operations_shopify_order_management_attempts', 'activation_revision'),
        ('operations_shopify_order_management_attempts', 'provider_write_control_row_version'),
        ('operations_shopify_order_management_attempts', 'provider_write_scope_digest'),
        ('operations_shopify_order_management_attempts', 'requested_projection_hash'),
        ('operations_shopify_order_management_attempts', 'requires_order_edits')
      )
    UNION ALL
    ${tableConstraintArtifacts('operations_commerce_provider_write_controls')}
    UNION ALL
    SELECT 'constraint'::text,
           installed_table.relname || '.' || installed_constraint.conname,
           pg_catalog.concat_ws('|',
             installed_constraint.contype::text,
             installed_constraint.convalidated::text,
             installed_constraint.connoinherit::text,
             installed_constraint.condeferrable::text,
             installed_constraint.condeferred::text,
             installed_constraint.confdeltype::text,
             installed_constraint.confupdtype::text,
             pg_catalog.pg_get_constraintdef(installed_constraint.oid, false)
           )
    FROM pg_catalog.pg_constraint installed_constraint
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_constraint.conrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND (installed_table.relname, installed_constraint.conname) IN (
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_legacy_activation_valid'),
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_manage_role_valid'),
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_provider_write_binding_valid'),
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_provider_write_control_fkey'),
        ('operations_shopify_order_management_authorizations', 'operations_shopify_order_management_authorizations_action_check'),
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_action_valid'),
        ('operations_shopify_order_management_authorizations', 'ops_shopify_order_mgmt_auth_projection_hash_valid'),
        ('operations_shopify_order_management_attempts', 'ops_shopify_order_mgmt_attempt_legacy_activation_valid'),
        ('operations_shopify_order_management_attempts', 'ops_shopify_order_mgmt_attempt_provider_write_binding_valid'),
        ('operations_shopify_order_management_attempts', 'ops_shopify_order_mgmt_attempt_provider_write_control_fkey'),
        ('operations_shopify_order_management_attempts', 'operations_shopify_order_management_attempts_action_check'),
        ('operations_shopify_order_management_attempts', 'ops_shopify_order_mgmt_attempt_identity_valid'),
        ('operations_shopify_order_management_attempts', 'ops_shopify_order_mgmt_attempt_projection_hash_valid'),
        ('operations_shopify_order_management_outcomes', 'ops_shopify_order_mgmt_outcome_write_count_valid'),
        ('operations_shopify_order_management_outcomes', 'ops_shopify_order_mgmt_outcome_state_valid')
      )
    UNION ALL
    ${tableIndexArtifacts('operations_commerce_provider_write_controls')}
    UNION ALL
    ${functionArtifacts([
      'public.operations_commerce_granted_scope_snapshot(jsonb)',
      'public.operations_commerce_granted_scope_digest(text[])',
      'public.validate_operations_commerce_provider_write_control()',
      'public.reject_operations_commerce_provider_write_control_mutation()',
      'public.operations_shopify_order_management_is_current(uuid,uuid,boolean)',
      'public.protect_shopify_order_management_authorization()',
      'public.protect_shopify_order_management_attempt()',
    ])}
    UNION ALL
    ${tableTriggerArtifacts('operations_commerce_provider_write_controls')}
    UNION ALL
    SELECT 'trigger'::text,
           installed_table.relname || '.' || installed_trigger.tgname,
           pg_catalog.concat_ws('|',
             installed_trigger.tgtype::text,
             installed_trigger.tgenabled::text,
             installed_trigger.tgisinternal::text,
             installed_trigger.tgconstraint::text,
             function_namespace.nspname || '.' || trigger_function.proname
               || '(' || pg_catalog.pg_get_function_identity_arguments(
                 trigger_function.oid
               ) || ')',
             COALESCE(pg_catalog.pg_get_expr(
               installed_trigger.tgqual, installed_trigger.tgrelid
             ), ''),
             pg_catalog.btrim(pg_catalog.regexp_replace(
               pg_catalog.pg_get_triggerdef(installed_trigger.oid),
               '[[:space:]]+', ' ', 'g'
             ))
           )
    FROM pg_catalog.pg_trigger installed_trigger
    JOIN pg_catalog.pg_class installed_table
      ON installed_table.oid = installed_trigger.tgrelid
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_table.relnamespace
    JOIN pg_catalog.pg_proc trigger_function
      ON trigger_function.oid = installed_trigger.tgfoid
    JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = trigger_function.pronamespace
    WHERE installed_namespace.nspname = 'public'
      AND (installed_table.relname, installed_trigger.tgname) IN (
        ('operations_shopify_order_management_authorizations', 'protect_shopify_order_management_authorization_write'),
        ('operations_shopify_order_management_attempts', 'protect_shopify_order_management_attempt_write')
      )
      AND NOT installed_trigger.tgisinternal
    UNION ALL
    SELECT 'view'::text,
           installed_namespace.nspname || '.' || installed_view.relname,
           pg_catalog.btrim(pg_catalog.regexp_replace(
             pg_catalog.pg_get_viewdef(installed_view.oid, true),
             '[[:space:]]+', ' ', 'g'
           ))
    FROM pg_catalog.pg_class installed_view
    JOIN pg_catalog.pg_namespace installed_namespace
      ON installed_namespace.oid = installed_view.relnamespace
    WHERE installed_namespace.nspname = 'public'
      AND installed_view.relname =
        'operations_commerce_provider_write_control_current'
      AND installed_view.relkind = 'v'
  )
`

export const OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_FINGERPRINT_SQL = String.raw`
  WITH ${OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACTS_SQL}
  SELECT pg_catalog.count(*)::integer AS artifact_count,
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           pg_catalog.string_agg(
             kind || '|' || identity || '|' || definition,
             pg_catalog.chr(10) ORDER BY kind, identity
           ), 'UTF8'
         ), 'sha256'), 'hex') AS artifact_hash
  FROM artifacts
`

export const OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACTS_SQL = String.raw`
  artifacts(kind, identity, definition) AS (
    ${tableRelationArtifact(
      'operations_order_shipment_address_working_copies',
    )}
    UNION ALL
    ${tableColumnArtifacts(
      'operations_order_shipment_address_working_copies',
    )}
    UNION ALL
    ${tableConstraintArtifacts(
      'operations_order_shipment_address_working_copies',
    )}
    UNION ALL
    ${tableIndexArtifacts(
      'operations_order_shipment_address_working_copies',
    )}
    UNION ALL
    ${functionArtifacts([
      'public.operations_dispatch_address_core_fingerprint(jsonb)',
      'public.operations_order_dispatch_destination_matches(uuid,uuid,jsonb)',
      'public.validate_operations_production_rerate_run_insert()',
      'public.validate_operations_production_rerate_attempt_insert()',
      'public.validate_operations_production_rerate_selection_insert()',
      'public.validate_operations_active_carrier_group_attempt_prepare()',
      'public.validate_operations_order_shipment_address_working_copy()',
    ])}
    UNION ALL
    ${tableTriggerArtifacts(
      'operations_order_shipment_address_working_copies',
    )}
  )
`

export const OPERATIONS_ORDER_SHIPMENT_ADDRESS_FINGERPRINT_SQL = String.raw`
  WITH ${OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACTS_SQL}
  SELECT pg_catalog.count(*)::integer AS artifact_count,
         pg_catalog.encode(public.digest(pg_catalog.convert_to(
           pg_catalog.string_agg(
             kind || '|' || identity || '|' || definition,
             pg_catalog.chr(10) ORDER BY kind, identity
           ), 'UTF8'
         ), 'sha256'), 'hex') AS artifact_hash
  FROM artifacts
`

export const OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACT_COUNT = 55
export const OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACT_HASH =
  '72324e014c76e161ee66133f7980aa22620bf76914adc9bbc53a2bad3cf0f164'
export const OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACT_COUNT = 74
export const OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACT_HASH =
  '5332f582504b1632421f74018cd4d4c2f9b8ac561b9d4f65ca96b74977e580e0'
export const OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACT_COUNT = 50
export const OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACT_HASH =
  'f0ac6b2e4600a1fa13f45ca9e3ce89e39805c64187b6b6a5d4c9d0cc91cfe9bf'

export const OPERATIONS_ORDER_EDITING_RELEASE_HEALTH_SQL = String.raw`
  EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE filename = '0307_operations_commerce_order_workbench.sql'
      AND checksum = '${OPERATIONS_COMMERCE_ORDER_WORKBENCH_MIGRATION_CHECKSUM}'
  )
  AND EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE filename = '0308_operations_commerce_provider_write_controls.sql'
      AND checksum = '${OPERATIONS_PROVIDER_WRITE_CONTROLS_MIGRATION_CHECKSUM}'
  )
  AND EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE filename =
      '0310_operations_order_shipment_address_working_copy.sql'
      AND checksum = '${OPERATIONS_ORDER_SHIPMENT_ADDRESS_MIGRATION_CHECKSUM}'
  )
  AND EXISTS (
    SELECT 1 FROM public.schema_migrations
    WHERE filename = '0312_operations_shopify_order_single_save.sql'
      AND checksum = '${OPERATIONS_SHOPIFY_SINGLE_SAVE_MIGRATION_CHECKSUM}'
  )
  AND (
    WITH ${OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACTS_SQL}
    SELECT pg_catalog.count(*) =
             ${OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACT_COUNT}
      AND pg_catalog.encode(public.digest(pg_catalog.convert_to(
        pg_catalog.string_agg(
          kind || '|' || identity || '|' || definition,
          pg_catalog.chr(10) ORDER BY kind, identity
        ), 'UTF8'
      ), 'sha256'), 'hex') =
        '${OPERATIONS_COMMERCE_ORDER_WORKBENCH_ARTIFACT_HASH}'
    FROM artifacts
  )
  AND (
    WITH ${OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACTS_SQL}
    SELECT pg_catalog.count(*) =
             ${OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACT_COUNT}
      AND pg_catalog.encode(public.digest(pg_catalog.convert_to(
        pg_catalog.string_agg(
          kind || '|' || identity || '|' || definition,
          pg_catalog.chr(10) ORDER BY kind, identity
        ), 'UTF8'
      ), 'sha256'), 'hex') =
        '${OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_ARTIFACT_HASH}'
    FROM artifacts
  )
  AND (
    WITH ${OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACTS_SQL}
    SELECT pg_catalog.count(*) =
             ${OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACT_COUNT}
      AND pg_catalog.encode(public.digest(pg_catalog.convert_to(
        pg_catalog.string_agg(
          kind || '|' || identity || '|' || definition,
          pg_catalog.chr(10) ORDER BY kind, identity
        ), 'UTF8'
      ), 'sha256'), 'hex') =
        '${OPERATIONS_ORDER_SHIPMENT_ADDRESS_ARTIFACT_HASH}'
    FROM artifacts
  )
`
