import { createHash } from 'node:crypto'

export const PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT =
  'clawpilot-production-rebind-target-schema-attestation-v5'
export const PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION =
  '0349_operations_commerce_order_history_policy.sql'
export const PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM =
  '73ae5e21d38db89a256fd0ea3d28bbf902252c1ee32cf3ee0d5f579a6287b831'
export const PRODUCTION_REBIND_SCHEMA_MIGRATIONS = Object.freeze([
  Object.freeze({
    filename: PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION,
    checksum: PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    filename: '0353_operations_commerce_workspace_migration_safety.sql',
    checksum: '07127dec7a0b8ad1ff2b661d801c89fefde5aa07a0ad0926710d784d0b7f6e09',
  }),
  Object.freeze({
    filename: '0354_operations_sales_shipping_workspace_migration_safety.sql',
    checksum: '322e822d66cc6b6e9d4fd9d662fe3e1064db7b9fe08279e7024e9644e422c399',
  }),
  Object.freeze({
    filename: '0355_operations_migrated_provider_rebind_receipt_immutability.sql',
    checksum: 'a1134b017e630d3b2b9674a2f7ac9cf815defcd9a5eb43b17b4237d94df61294',
  }),
  Object.freeze({
    filename: '0356_operations_integration_credential_key_attestation.sql',
    checksum: '7d66bab80f112d4c07466c8530921c514d67f4db8231ea97019b71005b74506f',
  }),
  Object.freeze({
    filename: '0357_operations_commerce_product_image_runtime_parking.sql',
    checksum: 'e8636998cfa8e8e24717ba7ffda11f4e2e0031fc83a439914a18f6d568c836a2',
  }),
  Object.freeze({
    filename: '0358_operations_hosted_production_sandbox_read_authority.sql',
    checksum: '3e99c87a322816df28a76d0e00a2001d5301f978163679f950c1be856c1b5b79',
  }),
  Object.freeze({
    filename: '0359_operations_commerce_fulfillment_recovery_budget.sql',
    checksum: 'f1ff432cb7e8af0ca83e87db75d1a6372a74fb25fcff1648c2d07eb7b3e54e11',
  }),
])

// The rebind caller can take ACCESS SHARE locks on this exact, static list
// before the in-transaction attestation. ACCESS SHARE allows ordinary DML but
// conflicts with the ACCESS EXCLUSIVE lock required by schema-changing DDL.
// Catalog inspection alone does not lock the described relations.
export const PRODUCTION_REBIND_CRITICAL_RELATIONS = Object.freeze([
  'public.app_settings',
  'public.app_users',
  'public.audit_events',
  'public.crm_reference_registry',
  'public.operations_carrier_account_migration_placeholders',
  'public.operations_carrier_accounts',
  'public.operations_carrier_credentials',
  'public.operations_commerce_credentials',
  'public.operations_commerce_fulfillment_exports',
  'public.operations_commerce_hosted_production_sandbox_read_authorizations',
  'public.operations_commerce_intake_continuations',
  'public.operations_commerce_intake_read_intents',
  'public.operations_commerce_inventory_location_mappings',
  'public.operations_commerce_migration_provider_identity_fences',
  'public.operations_commerce_oauth_installations',
  'public.operations_commerce_order_candidates',
  'public.operations_commerce_order_history_policies',
  'public.operations_commerce_order_workbench',
  'public.operations_commerce_product_image_import_jobs',
  'public.operations_commerce_store_sync_controls',
  'public.operations_commerce_sync_cursors',
  'public.operations_commerce_webhook_receipts',
  'public.operations_commerce_workspace_migration_cutover_fences',
  'public.operations_integration_accounts',
  'public.operations_integration_credential_key_attestations',
  'public.operations_order_shipment_address_working_copies',
  'public.operations_shopify_fulfillment_notification_policies',
  'public.operations_warehouses',
  'public.schema_migrations',
  'public.workspace_organizations',
])

const PRODUCTION_REBIND_CRITICAL_FUNCTIONS = Object.freeze([
  'public.enforce_migrated_commerce_provider_identity()',
  'public.guard_hosted_production_sandbox_read_authorization()',
  'public.guard_operations_commerce_product_image_import_job()',
  'public.operations_commerce_hosted_production_sandbox_read_is_current(uuid,uuid,text)',
  'public.operations_shopify_carrier_configuration_allows_rating(jsonb,text)',
  'public.protect_active_migrated_source_authority_credential()',
  'public.protect_active_migrated_source_authority_integration()',
  'public.protect_carrier_account_migration_placeholder()',
  'public.protect_commerce_migration_provider_identity_fence()',
  'public.protect_commerce_order_history_policy()',
  'public.protect_commerce_workspace_migration_receipt()',
  'public.protect_migrated_carrier_shipper_identity()',
  'public.reject_integration_credential_key_attestation_mutation()',
  'public.validate_integration_credential_key_attestation_insert()',
])

// PostgreSQL can render equivalent catalog objects differently across major
// versions. Each supported major is therefore exercised against the complete
// migration chain and enrolled explicitly. Unknown majors fail closed.
const EXPECTED_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'e8e3ce7233e3c33e22064e4833f93dffff7ea6d585fdb55bfe69f602cf2665d2',
  18: '048935a6dca7fbe7c79850f7a326cda075eb2aa1720865f6dccdb9534be66bfe',
})

const TARGET_SCHEMA_CATALOG_SQL = String.raw`
WITH
attesting_role AS (
  SELECT role_row.oid
  FROM pg_catalog.pg_roles role_row
  WHERE role_row.rolname = CURRENT_USER
),
database_row AS (
  SELECT database_record.datdba AS owner_oid
  FROM pg_catalog.pg_database database_record
  WHERE database_record.datname = pg_catalog.current_database()
),
expected_relations AS (
  SELECT expected.qualified_name, expected.ordinality,
         pg_catalog.to_regclass(expected.qualified_name) AS relation_oid
  FROM pg_catalog.unnest($1::text[])
    WITH ORDINALITY AS expected(qualified_name, ordinality)
),
expected_functions AS (
  SELECT expected.identity, expected.ordinality,
         pg_catalog.to_regprocedure(expected.identity) AS function_oid
  FROM pg_catalog.unnest($2::text[])
    WITH ORDINALITY AS expected(identity, ordinality)
),
relation_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'expected', expected.qualified_name,
      'present', relation.oid IS NOT NULL,
      'schema', namespace.nspname,
      'name', relation.relname,
      'kind', relation.relkind::text,
      'persistence', relation.relpersistence::text,
      'accessMethod', access_method.amname,
      'tablespace', tablespace.spcname,
      'owner', CASE
        WHEN relation.relowner = attesting_role.oid THEN '@current_user'
        WHEN relation.relowner = database_row.owner_oid THEN '@database_owner'
        ELSE pg_catalog.pg_get_userbyid(relation.relowner)
      END,
      'ownerIsCurrentUser', relation.relowner = attesting_role.oid,
      'ownerIsDatabaseOwner', relation.relowner = database_row.owner_oid,
      'rowSecurity', relation.relrowsecurity,
      'forceRowSecurity', relation.relforcerowsecurity,
      'replicaIdentity', relation.relreplident::text,
      'partition', relation.relispartition,
      'options', COALESCE(pg_catalog.to_jsonb(relation.reloptions), '[]'::jsonb),
      'aclIsDefault', relation.relacl IS NULL,
      'acl', CASE WHEN relation.relacl IS NULL THEN '[]'::jsonb ELSE COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantor', CASE
              WHEN acl.grantor = relation.relowner THEN '@owner'
              WHEN acl.grantor = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantor)
            END,
            'grantee', CASE
              WHEN acl.grantee = 0 THEN 'PUBLIC'
              WHEN acl.grantee = relation.relowner THEN '@owner'
              WHEN acl.grantee = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantee)
            END,
            'privilege', acl.privilege_type,
            'grantable', acl.is_grantable
          ) ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
        )
        FROM pg_catalog.aclexplode(relation.relacl) acl
      ), '[]'::jsonb) END,
      'currentUserPrivileges', CASE WHEN relation.oid IS NULL THEN NULL ELSE
        pg_catalog.jsonb_build_object(
          'select', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'SELECT'
          ),
          'insert', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'INSERT'
          ),
          'update', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'UPDATE'
          ),
          'delete', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'DELETE'
          ),
          'truncate', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'TRUNCATE'
          ),
          'references', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'REFERENCES'
          ),
          'trigger', pg_catalog.has_table_privilege(
            CURRENT_USER, relation.oid, 'TRIGGER'
          )
        ) END,
      'comment', pg_catalog.obj_description(relation.oid, 'pg_class')
    ) ORDER BY expected.ordinality
  ), '[]'::jsonb) AS value
  FROM expected_relations expected
  CROSS JOIN attesting_role
  CROSS JOIN database_row
  LEFT JOIN pg_catalog.pg_class relation ON relation.oid = expected.relation_oid
  LEFT JOIN pg_catalog.pg_namespace namespace
    ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_catalog.pg_am access_method ON access_method.oid = relation.relam
  LEFT JOIN pg_catalog.pg_tablespace tablespace
    ON tablespace.oid = relation.reltablespace
),
column_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'relation', expected.qualified_name,
      'position', attribute.attnum::integer,
      'name', attribute.attname,
      'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      'notNull', attribute.attnotnull,
      'identity', attribute.attidentity::text,
      'generated', attribute.attgenerated::text,
      'local', attribute.attislocal,
      'inheritanceCount', attribute.attinhcount::integer,
      'storage', attribute.attstorage::text,
      'compression', attribute.attcompression::text,
      'statisticsTarget', attribute.attstattarget::integer,
      'options', COALESCE(pg_catalog.to_jsonb(attribute.attoptions), '[]'::jsonb),
      'fdwOptions', COALESCE(
        pg_catalog.to_jsonb(attribute.attfdwoptions), '[]'::jsonb
      ),
      'default', CASE WHEN default_value.oid IS NULL THEN NULL ELSE
        pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, true)
      END,
      'collation', CASE WHEN attribute.attcollation = 0 THEN NULL ELSE
        attribute.attcollation::pg_catalog.regcollation::text
      END,
      'aclIsDefault', attribute.attacl IS NULL,
      'acl', CASE WHEN attribute.attacl IS NULL THEN '[]'::jsonb ELSE COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantor', CASE
              WHEN acl.grantor = relation.relowner THEN '@owner'
              WHEN acl.grantor = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantor)
            END,
            'grantee', CASE
              WHEN acl.grantee = 0 THEN 'PUBLIC'
              WHEN acl.grantee = relation.relowner THEN '@owner'
              WHEN acl.grantee = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantee)
            END,
            'privilege', acl.privilege_type,
            'grantable', acl.is_grantable
          ) ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
        )
        FROM pg_catalog.aclexplode(attribute.attacl) acl
      ), '[]'::jsonb) END,
      'currentUserPrivileges', pg_catalog.jsonb_build_object(
        'select', pg_catalog.has_column_privilege(
          CURRENT_USER, relation.oid, attribute.attname, 'SELECT'
        ),
        'insert', pg_catalog.has_column_privilege(
          CURRENT_USER, relation.oid, attribute.attname, 'INSERT'
        ),
        'update', pg_catalog.has_column_privilege(
          CURRENT_USER, relation.oid, attribute.attname, 'UPDATE'
        ),
        'references', pg_catalog.has_column_privilege(
          CURRENT_USER, relation.oid, attribute.attname, 'REFERENCES'
        )
      ),
      'comment', pg_catalog.col_description(relation.oid, attribute.attnum)
    ) ORDER BY expected.ordinality, attribute.attnum
  ), '[]'::jsonb) AS value
  FROM expected_relations expected
  JOIN pg_catalog.pg_class relation ON relation.oid = expected.relation_oid
  JOIN pg_catalog.pg_attribute attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  CROSS JOIN attesting_role
  LEFT JOIN pg_catalog.pg_attrdef default_value
    ON default_value.adrelid = attribute.attrelid
   AND default_value.adnum = attribute.attnum
),
constraint_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'relation', expected.qualified_name,
      'schema', constraint_namespace.nspname,
      'name', constraint_row.conname,
      'type', constraint_row.contype::text,
      'validated', constraint_row.convalidated,
      'deferrable', constraint_row.condeferrable,
      'deferred', constraint_row.condeferred,
      'local', constraint_row.conislocal,
      'inheritanceCount', constraint_row.coninhcount::integer,
      'noInherit', constraint_row.connoinherit,
      'parentConstraint', parent_constraint.conname,
      'deleteAction', constraint_row.confdeltype::text,
      'updateAction', constraint_row.confupdtype::text,
      'matchType', constraint_row.confmatchtype::text,
      'attributeNumbers', constraint_row.conkey::text,
      'referencedAttributeNumbers', constraint_row.confkey::text,
      'referencedRelation', CASE WHEN referenced_relation.oid IS NULL THEN NULL
        ELSE pg_catalog.format('%I.%I',
          referenced_namespace.nspname, referenced_relation.relname)
      END,
      'backingIndex', CASE WHEN backing_index.oid IS NULL THEN NULL
        ELSE pg_catalog.format('%I.%I',
          backing_index_namespace.nspname, backing_index.relname)
      END,
      'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
      'comment', pg_catalog.obj_description(
        constraint_row.oid, 'pg_constraint'
      )
    ) ORDER BY expected.ordinality, constraint_row.conname
  ), '[]'::jsonb) AS value
  FROM expected_relations expected
  JOIN pg_catalog.pg_constraint constraint_row
    ON constraint_row.conrelid = expected.relation_oid
  JOIN pg_catalog.pg_namespace constraint_namespace
    ON constraint_namespace.oid = constraint_row.connamespace
  LEFT JOIN pg_catalog.pg_constraint parent_constraint
    ON parent_constraint.oid = constraint_row.conparentid
  LEFT JOIN pg_catalog.pg_class referenced_relation
    ON referenced_relation.oid = constraint_row.confrelid
  LEFT JOIN pg_catalog.pg_namespace referenced_namespace
    ON referenced_namespace.oid = referenced_relation.relnamespace
  LEFT JOIN pg_catalog.pg_class backing_index
    ON backing_index.oid = constraint_row.conindid
  LEFT JOIN pg_catalog.pg_namespace backing_index_namespace
    ON backing_index_namespace.oid = backing_index.relnamespace
),
index_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'relation', expected.qualified_name,
      'schema', index_namespace.nspname,
      'name', index_relation.relname,
      'owner', CASE
        WHEN index_relation.relowner = attesting_role.oid THEN '@current_user'
        WHEN index_relation.relowner = database_row.owner_oid
          THEN '@database_owner'
        ELSE pg_catalog.pg_get_userbyid(index_relation.relowner)
      END,
      'ownerIsCurrentUser', index_relation.relowner = attesting_role.oid,
      'ownerIsDatabaseOwner', index_relation.relowner = database_row.owner_oid,
      'accessMethod', access_method.amname,
      'tablespace', tablespace.spcname,
      'options', COALESCE(
        pg_catalog.to_jsonb(index_relation.reloptions), '[]'::jsonb
      ),
      'unique', index_row.indisunique,
      'primary', index_row.indisprimary,
      'exclusion', index_row.indisexclusion,
      'valid', index_row.indisvalid,
      'ready', index_row.indisready,
      'live', index_row.indislive,
      'immediate', index_row.indimmediate,
      'replicaIdentity', index_row.indisreplident,
      'clustered', index_row.indisclustered,
      'keyAttributes', index_row.indnkeyatts::integer,
      'totalAttributes', index_row.indnatts::integer,
      'attributeNumbers', index_row.indkey::text,
      'collations', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          CASE WHEN collation_oid = 0 THEN NULL ELSE
            pg_catalog.format('%I.%I',
              collation_namespace.nspname, collation_row.collname)
          END ORDER BY indexed_collation.ordinality
        )
        FROM pg_catalog.unnest(index_row.indcollation::oid[])
          WITH ORDINALITY AS indexed_collation(collation_oid, ordinality)
        LEFT JOIN pg_catalog.pg_collation collation_row
          ON collation_row.oid = indexed_collation.collation_oid
        LEFT JOIN pg_catalog.pg_namespace collation_namespace
          ON collation_namespace.oid = collation_row.collnamespace
      ), '[]'::jsonb),
      'operatorClasses', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.format('%I.%I',
            operator_namespace.nspname, operator_class.opcname)
          ORDER BY indexed_operator.ordinality
        )
        FROM pg_catalog.unnest(index_row.indclass::oid[])
          WITH ORDINALITY AS indexed_operator(operator_class_oid, ordinality)
        JOIN pg_catalog.pg_opclass operator_class
          ON operator_class.oid = indexed_operator.operator_class_oid
        JOIN pg_catalog.pg_namespace operator_namespace
          ON operator_namespace.oid = operator_class.opcnamespace
      ), '[]'::jsonb),
      'optionsMask', index_row.indoption::text,
      'predicate', pg_catalog.pg_get_expr(
        index_row.indpred, index_row.indrelid, true
      ),
      'expressions', pg_catalog.pg_get_expr(
        index_row.indexprs, index_row.indrelid, true
      ),
      'definition', pg_catalog.pg_get_indexdef(index_row.indexrelid),
      'comment', pg_catalog.obj_description(index_relation.oid, 'pg_class')
    ) ORDER BY expected.ordinality, index_relation.relname
  ), '[]'::jsonb) AS value
  FROM expected_relations expected
  JOIN pg_catalog.pg_index index_row
    ON index_row.indrelid = expected.relation_oid
  JOIN pg_catalog.pg_class index_relation
    ON index_relation.oid = index_row.indexrelid
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  CROSS JOIN attesting_role
  CROSS JOIN database_row
  LEFT JOIN pg_catalog.pg_am access_method
    ON access_method.oid = index_relation.relam
  LEFT JOIN pg_catalog.pg_tablespace tablespace
    ON tablespace.oid = index_relation.reltablespace
),
trigger_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'relation', expected.qualified_name,
      'name', trigger_row.tgname,
      'enabled', trigger_row.tgenabled::text,
      'internal', trigger_row.tgisinternal,
      'typeMask', trigger_row.tgtype::integer,
      'argumentCount', trigger_row.tgnargs::integer,
      'argumentsHex', pg_catalog.encode(trigger_row.tgargs, 'hex'),
      'when', CASE WHEN trigger_row.tgqual IS NULL THEN NULL ELSE
        pg_catalog.pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid, true)
      END,
      'function', pg_catalog.format('%I.%I(%s)',
        function_namespace.nspname,
        trigger_function.proname,
        pg_catalog.pg_get_function_identity_arguments(trigger_function.oid)
      ),
      'constraint', constraint_row.conname,
      'constraintRelation', CASE
        WHEN constraint_relation.oid IS NULL THEN NULL
        ELSE pg_catalog.format('%I.%I',
          constraint_namespace.nspname, constraint_relation.relname)
      END,
      'deferrable', trigger_row.tgdeferrable,
      'initiallyDeferred', trigger_row.tginitdeferred,
      'parentTrigger', parent_trigger.tgname,
      'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, true),
      'comment', pg_catalog.obj_description(trigger_row.oid, 'pg_trigger')
    ) ORDER BY expected.ordinality, trigger_row.tgname
  ), '[]'::jsonb) AS value
  FROM expected_relations expected
  JOIN pg_catalog.pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_oid
  JOIN pg_catalog.pg_proc trigger_function
    ON trigger_function.oid = trigger_row.tgfoid
  JOIN pg_catalog.pg_namespace function_namespace
    ON function_namespace.oid = trigger_function.pronamespace
  LEFT JOIN pg_catalog.pg_constraint constraint_row
    ON constraint_row.oid = trigger_row.tgconstraint
  LEFT JOIN pg_catalog.pg_class constraint_relation
    ON constraint_relation.oid = trigger_row.tgconstrrelid
  LEFT JOIN pg_catalog.pg_namespace constraint_namespace
    ON constraint_namespace.oid = constraint_relation.relnamespace
  LEFT JOIN pg_catalog.pg_trigger parent_trigger
    ON parent_trigger.oid = trigger_row.tgparentid
),
selected_function_oids AS (
  SELECT function_oid FROM expected_functions WHERE function_oid IS NOT NULL
  UNION
  SELECT trigger_row.tgfoid
  FROM expected_relations expected
  JOIN pg_catalog.pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_oid
   AND NOT trigger_row.tgisinternal
),
function_catalog AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'schema', namespace.nspname,
      'name', procedure.proname,
      'identityArguments',
        pg_catalog.pg_get_function_identity_arguments(procedure.oid),
      'arguments', pg_catalog.pg_get_function_arguments(procedure.oid),
      'result', pg_catalog.pg_get_function_result(procedure.oid),
      'kind', procedure.prokind::text,
      'language', language.lanname,
      'owner', CASE
        WHEN procedure.proowner = attesting_role.oid THEN '@current_user'
        WHEN procedure.proowner = database_row.owner_oid THEN '@database_owner'
        ELSE pg_catalog.pg_get_userbyid(procedure.proowner)
      END,
      'ownerIsCurrentUser', procedure.proowner = attesting_role.oid,
      'ownerIsDatabaseOwner', procedure.proowner = database_row.owner_oid,
      'volatility', procedure.provolatile::text,
      'parallel', procedure.proparallel::text,
      'securityDefiner', procedure.prosecdef,
      'leakproof', procedure.proleakproof,
      'strict', procedure.proisstrict,
      'returnsSet', procedure.proretset,
      'argumentCount', procedure.pronargs::integer,
      'defaultArgumentCount', procedure.pronargdefaults::integer,
      'cost', procedure.procost::text,
      'rows', procedure.prorows::text,
      'configuration', COALESCE(
        pg_catalog.to_jsonb(procedure.proconfig), '[]'::jsonb
      ),
      'aclIsDefault', procedure.proacl IS NULL,
      'acl', CASE WHEN procedure.proacl IS NULL THEN '[]'::jsonb ELSE COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'grantor', CASE
              WHEN acl.grantor = procedure.proowner THEN '@owner'
              WHEN acl.grantor = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantor)
            END,
            'grantee', CASE
              WHEN acl.grantee = 0 THEN 'PUBLIC'
              WHEN acl.grantee = procedure.proowner THEN '@owner'
              WHEN acl.grantee = attesting_role.oid THEN '@current_user'
              ELSE pg_catalog.pg_get_userbyid(acl.grantee)
            END,
            'privilege', acl.privilege_type,
            'grantable', acl.is_grantable
          ) ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
        )
        FROM pg_catalog.aclexplode(procedure.proacl) acl
      ), '[]'::jsonb) END,
      'currentUserCanExecute', pg_catalog.has_function_privilege(
        CURRENT_USER, procedure.oid, 'EXECUTE'
      ),
      'source', procedure.prosrc,
      'definition', pg_catalog.pg_get_functiondef(procedure.oid),
      'comment', pg_catalog.obj_description(procedure.oid, 'pg_proc')
    ) ORDER BY namespace.nspname, procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid)
  ), '[]'::jsonb) AS value
  FROM selected_function_oids selected
  JOIN pg_catalog.pg_proc procedure ON procedure.oid = selected.function_oid
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
  CROSS JOIN attesting_role
  CROSS JOIN database_row
),
schema_catalog AS (
  SELECT pg_catalog.jsonb_build_object(
    'present', namespace.oid IS NOT NULL,
    'name', namespace.nspname,
    'owner', CASE
      WHEN namespace.nspowner = attesting_role.oid THEN '@current_user'
      WHEN namespace.nspowner = database_row.owner_oid THEN '@database_owner'
      ELSE pg_catalog.pg_get_userbyid(namespace.nspowner)
    END,
    'ownerIsCurrentUser', namespace.nspowner = attesting_role.oid,
    'ownerIsDatabaseOwner', namespace.nspowner = database_row.owner_oid,
    'aclIsDefault', namespace.nspacl IS NULL,
    'acl', CASE WHEN namespace.nspacl IS NULL THEN '[]'::jsonb ELSE COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'grantor', CASE
            WHEN acl.grantor = namespace.nspowner THEN '@owner'
            WHEN acl.grantor = attesting_role.oid THEN '@current_user'
            ELSE pg_catalog.pg_get_userbyid(acl.grantor)
          END,
          'grantee', CASE
            WHEN acl.grantee = 0 THEN 'PUBLIC'
            WHEN acl.grantee = namespace.nspowner THEN '@owner'
            WHEN acl.grantee = attesting_role.oid THEN '@current_user'
            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
          END,
          'privilege', acl.privilege_type,
          'grantable', acl.is_grantable
        ) ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
      )
      FROM pg_catalog.aclexplode(namespace.nspacl) acl
    ), '[]'::jsonb) END,
    'currentUserUsage', pg_catalog.has_schema_privilege(
      CURRENT_USER, namespace.oid, 'USAGE'
    ),
    'currentUserCreate', pg_catalog.has_schema_privilege(
      CURRENT_USER, namespace.oid, 'CREATE'
    )
  ) AS value
  FROM pg_catalog.pg_namespace namespace
  CROSS JOIN attesting_role
  CROSS JOIN database_row
  WHERE namespace.nspname = 'public'
),
migration_catalog AS (
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'filename', expected.filename,
      'checksum', expected.checksum,
      'rows', (
        SELECT pg_catalog.count(*)::integer
        FROM public.schema_migrations installed
        WHERE installed.filename = expected.filename
      ),
      'matchingRows', (
        SELECT pg_catalog.count(*)::integer
        FROM public.schema_migrations installed
        WHERE installed.filename = expected.filename
          AND installed.checksum = expected.checksum
      )
    ) ORDER BY expected.ordinality
  ) AS value
  FROM pg_catalog.unnest($3::text[])
    WITH ORDINALITY AS filenames(filename, ordinality)
  CROSS JOIN LATERAL (
    SELECT filenames.filename,
           filenames.ordinality,
           ($4::text[])[filenames.ordinality] AS checksum
  ) expected
)
SELECT
  pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
  (SELECT value FROM migration_catalog) AS migrations,
  (SELECT value FROM schema_catalog) AS schema,
  (SELECT value FROM relation_catalog) AS relations,
  (SELECT value FROM column_catalog) AS columns,
  (SELECT value FROM constraint_catalog) AS constraints,
  (SELECT value FROM index_catalog) AS indexes,
  (SELECT value FROM trigger_catalog) AS triggers,
  (SELECT value FROM function_catalog) AS functions,
  ARRAY(
    SELECT expected.qualified_name
    FROM expected_relations expected
    WHERE expected.relation_oid IS NULL
    ORDER BY expected.ordinality
  ) AS missing_relations,
  ARRAY(
    SELECT expected.identity
    FROM expected_functions expected
    WHERE expected.function_oid IS NULL
    ORDER BY expected.ordinality
  ) AS missing_functions
`

function normalizeCatalogText(value) {
  // Function bodies and expressions may contain significant whitespace inside
  // string literals. Preserve catalog text byte-for-byte; each PostgreSQL major
  // has its own reviewed digest, so renderer normalization is unnecessary.
  return value
}

function normalizeCatalog(value) {
  if (Array.isArray(value)) return value.map(normalizeCatalog)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCatalog(entry)]),
    )
  }
  return normalizeCatalogText(value)
}

export function canonicalProductionRebindHistorySchemaCatalog(catalog) {
  return JSON.stringify(normalizeCatalog(catalog))
}

export function productionRebindHistorySchemaDigest(catalog) {
  return createHash('sha256')
    .update(canonicalProductionRebindHistorySchemaCatalog(catalog), 'utf8')
    .digest('hex')
}

export class ProductionRebindHistorySchemaAttestationError extends Error {
  constructor(code, detail) {
    super(`Production rebind target schema attestation failed: ${detail}`)
    this.name = 'ProductionRebindHistorySchemaAttestationError'
    this.code = code
  }
}

export async function inspectProductionRebindHistorySchema(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A PostgreSQL client with query(sql, values) is required')
  }
  const result = await client.query(TARGET_SCHEMA_CATALOG_SQL, [
    PRODUCTION_REBIND_CRITICAL_RELATIONS,
    PRODUCTION_REBIND_CRITICAL_FUNCTIONS,
    PRODUCTION_REBIND_SCHEMA_MIGRATIONS.map(({ filename }) => filename),
    PRODUCTION_REBIND_SCHEMA_MIGRATIONS.map(({ checksum }) => checksum),
  ])
  if (result.rowCount !== 1) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'catalog_query_cardinality',
      'catalog query did not return exactly one row',
    )
  }
  const row = result.rows[0]
  const catalog = normalizeCatalog({
    schema: row.schema,
    relations: row.relations,
    columns: row.columns,
    constraints: row.constraints,
    indexes: row.indexes,
    triggers: row.triggers,
    functions: row.functions,
  })
  const postgresMajor = Math.trunc(Number(row.server_version_num) / 10000)
  return Object.freeze({
    format: PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT,
    postgresMajor,
    migrations: Object.freeze(normalizeCatalog(row.migrations)),
    missingRelations: Object.freeze(normalizeCatalog(row.missing_relations || [])),
    missingFunctions: Object.freeze(normalizeCatalog(row.missing_functions || [])),
    schemaDigest: productionRebindHistorySchemaDigest(catalog),
    catalog,
  })
}

export async function attestProductionRebindHistorySchema(client) {
  const inspection = await inspectProductionRebindHistorySchema(client)
  if (inspection.migrations.some(
    (migration) => migration.rows !== 1 || migration.matchingRows !== 1,
  )) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'migration_checksum_mismatch',
      'expected one exact ledger row for migrations 0349 and 0353 through 0359',
    )
  }
  if (
    inspection.missingRelations.length > 0
    || inspection.missingFunctions.length > 0
  ) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'schema_object_missing',
      'one or more rebind-critical relations or functions are missing',
    )
  }
  const expectedDigest = EXPECTED_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[
    inspection.postgresMajor
  ]
  if (!expectedDigest) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'unsupported_postgres_major',
      `PostgreSQL ${inspection.postgresMajor} has no reviewed catalog fingerprint`,
    )
  }
  if (inspection.schemaDigest !== expectedDigest) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'schema_catalog_mismatch',
      `expected catalog ${expectedDigest}, observed ${inspection.schemaDigest}`,
    )
  }
  return Object.freeze({
    format: inspection.format,
    postgresMajor: inspection.postgresMajor,
    migrations: PRODUCTION_REBIND_SCHEMA_MIGRATIONS,
    schemaDigest: inspection.schemaDigest,
  })
}

// Compatibility aliases retained for the integration point that originally
// consumed the narrower order-history-only attestation.
export const attestProductionRebindTargetSchema =
  attestProductionRebindHistorySchema
export const inspectProductionRebindTargetSchema =
  inspectProductionRebindHistorySchema
