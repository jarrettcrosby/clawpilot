import { createHash } from 'node:crypto'

export const PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT =
  'clawpilot-production-rebind-target-schema-attestation-v15'
export const PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION =
  '0349_operations_commerce_order_history_policy.sql'
export const PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM =
  '73ae5e21d38db89a256fd0ea3d28bbf902252c1ee32cf3ee0d5f579a6287b831'
const PRE_INITIAL_ENROLLMENT_SCHEMA_MIGRATIONS = Object.freeze([
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
  Object.freeze({
    filename: '0370_verified_login_email.sql',
    checksum: 'f41d34e7fb00df0f688238e8ce851074a2861efd6103a5fc5a2e5e7e24b8cb44',
  }),
  Object.freeze({
    filename: '0371_organization_web_domains.sql',
    checksum: 'caedcbe05a2af7c88d5a17c9373d206c24a4b48dd37b43bfdd1e67dd379da416',
  }),
  Object.freeze({
    filename: '0372_fractional_crm_gateway.sql',
    checksum: '4f27ef992cf15aa55559cee9f78c2182a0d764f0638c9b22495576b6141eff8e',
  }),
  Object.freeze({
    filename: '0373_crm_calendar_discovery.sql',
    checksum: '9f8d7c862a47d99ba05c3d9176bb1780456dca3216eb1e511ccda6c40459e36d',
  }),
  Object.freeze({
    filename: '0374_crm_interaction_organizations.sql',
    checksum: '09ea3b57ed991fb2c6853f0b6855ad4ca95b8c53e8738e349e76018e0dd0203d',
  }),
  Object.freeze({ filename: '0375_crm_native_email_publication_admission.sql',
    checksum: '0650c82b7cf773d7dcc8ae46fbbc6d55293150c536d3efb987235bf15021805e' }),
  Object.freeze({ filename: '0376_crm_native_email_publication_work_context.sql',
    checksum: '685a04c63f00247cde80bf841ac47ee4921406b93d65cf6089aeee39b6f2ce16' }),
  Object.freeze({ filename: '0377_crm_native_email_authority_transitions.sql',
    checksum: 'e35e5df6061bc8cc549f75949fa10c17663c345adab954b7773346193680707e' }),
  Object.freeze({ filename: '0378_crm_native_email_capability_policies.sql',
    checksum: '1b7bcc5996e102810d4857a568fb0b46cd116555574bbdde279c2c2c8ee6027c' }),
  Object.freeze({ filename: '0379_crm_native_email_app_only_lifecycle.sql',
    checksum: '676d0ba2414df4b582cc8f8ec8bf99c15eb44a619d7825b18e75b3646923d0ca' }),
  Object.freeze({ filename: '0380_crm_native_email_grant_attempts.sql',
    checksum: '31b852ea073e9bb8025f9d4339d967316edd94e322b961d46d908537df80e54b' }),
  Object.freeze({ filename: '0381_crm_native_email_identity_quiescence.sql',
    checksum: '1db4838b4c9b96c2ec8332382ebca4f4d4bed517b0974d15cbf4faf896e5a59c' }),
  Object.freeze({ filename: '0382_crm_native_email_mapped_settings.sql',
    checksum: '160c8bcb4104a205ff6a22ac031d873c0d28059da6a6f2469a3717aa61f822b7' }),
  Object.freeze({ filename: '0383_crm_native_email_user_eligibility.sql',
    checksum: 'a21175bca217e8c71acd9b7a5a2c44e8e9284c13a72bbdbd02717bf9a0f242c7' }),
  Object.freeze({ filename: '0384_crm_native_email_member_role_changes.sql',
    checksum: 'f64874fd4efa3b84214f085e3ccf86423c865e6ab4c616ad36597f0b4d51ab26' }),
  Object.freeze({ filename: '0385_crm_employee_identity_retention.sql',
    checksum: '54124711be65674501a9196927e6afe141f0f5d40f71322ab3059be807efd2f8' }),
  Object.freeze({ filename: '0386_crm_native_email_first_access_grants.sql',
    checksum: 'f807d6eaddfe03d44ef0cd28dd4ae275b0f55d84c2f147497b1e9af28059fa94' }),
  Object.freeze({ filename: '0387_crm_native_email_shared_app_only_lifecycle.sql',
    checksum: '556779fc482a744f0eba87256226d867c4ddaea429c0368e01057be3f24db17f' }),
  Object.freeze({ filename: '0388_crm_customer_drive_folders.sql',
    checksum: '5640251843d524d2cc8701c8a3b7315776ce7f4f15043ec4bb1bbc9eb6ea17ea' }),
  Object.freeze({ filename: '0389_crm_customer_folder_jobs.sql',
    checksum: 'a8200c06a6e546f6d5ae14538d032e0430aabb9a0fa2d365202f322befd7947d' }),
  Object.freeze({ filename: '0390_crm_fractional_customer_folders.sql',
    checksum: 'ec0b5c30b12258a300cf2c5d311cea234f2e4e7fbbff00bab51677d89578a254' }),
  Object.freeze({ filename: '0391_crm_native_email_unshared_workspace_enrollment.sql',
    checksum: '2923a716da8dc27b21d2764d3325689c527e69ff72df9efda12ce7f2e2ac6fff' }),
  Object.freeze({ filename: '0392_crm_root_employee_access_registry.sql',
    checksum: 'cf4d2868e9d4a09d525ecea878c58c6deed13bf397713e76ab10a7e06894f98b' }),
  Object.freeze({ filename: '0393_crm_root_employee_read_context.sql',
    checksum: '94c333b355b1008585ebf8edb58c54977d1b772212a5a483e26491c1b5d5148c' }),
  Object.freeze({ filename: '0394_crm_native_root_source_fences.sql',
    checksum: 'c6631516843ec6a6a94e9b6dea79dc5b856012c0b25ab3b77960a8afb360ccee' }),
  Object.freeze({ filename: '0395_crm_native_email_existing_identity_links.sql',
    checksum: '0676efabc405b8f85f1f6dcbc54ed9cb3778c53a50728a3a9febc82a0ded2ca0' }),
  Object.freeze({ filename: '0396_crm_root_native_read_receipts.sql',
    checksum: 'd201a7018e691a0259895c37288b51863b59d6d7bca654bf97082a1e24d36f33' }),
  Object.freeze({ filename: '0397_crm_native_root_registry_changes.sql',
    checksum: '1ec2eedefb1241cc126f51c0dd26576f1389780ec9b442c47895045bf56d4852' }),
])
const PRE_INITIAL_REPLAN_SCHEMA_MIGRATIONS = Object.freeze([
  ...PRE_INITIAL_ENROLLMENT_SCHEMA_MIGRATIONS,
  Object.freeze({ filename: '0398_crm_native_email_initial_enrollment.sql',
    checksum: '00ba0afd16e90ef321199e0c497b0f75029b3efc3d6af7edee0673e0bc20afd7' }),
])
export const PRODUCTION_REBIND_SCHEMA_MIGRATIONS = Object.freeze([
  ...PRE_INITIAL_REPLAN_SCHEMA_MIGRATIONS,
  Object.freeze({ filename: '0399_crm_native_email_initial_replan_lineage.sql',
    checksum: 'd701ad48ad8629c3ea71d3987c5eeba4a7df33b79b98ff46ca8c220de0b31a34' }),
])

// The rebind caller can take ACCESS SHARE locks on this exact, static list
// before the in-transaction attestation. ACCESS SHARE allows ordinary DML but
// conflicts with the ACCESS EXCLUSIVE lock required by schema-changing DDL.
// Catalog inspection alone does not lock the described relations.
const PRE_CRM_PRODUCTION_REBIND_CRITICAL_RELATIONS = Object.freeze([
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

// These are direct lock/fingerprint targets, not only incoming FK descriptors.
// The native ledger, root session/access sources and customer-folder identity
// guards must retain their complete columns, indexes, triggers and ACLs too.
const PRE_INITIAL_ENROLLMENT_CRITICAL_RELATIONS = Object.freeze([
  ...PRE_CRM_PRODUCTION_REBIND_CRITICAL_RELATIONS,
  'public.app_sessions',
  'public.app_user_organization_memberships',
  'public.crm_board_projections',
  'public.crm_customer_drive_folders',
  'public.crm_customer_folder_jobs',
  'public.crm_customer_folder_settings',
  'public.crm_fractional_customer_folders',
  'public.crm_native_email_authority_grant_attempts',
  'public.crm_native_email_authority_member_changes',
  'public.crm_native_email_authority_phases',
  'public.crm_native_email_authority_root_changes',
  'public.crm_native_email_authority_transitions',
  'public.crm_native_email_authority_user_changes',
  'public.crm_native_email_capability_policies',
  'public.crm_native_email_publication_admissions',
  'public.crm_native_email_publication_control',
  'public.crm_native_email_publication_work',
  'public.crm_operator_accounts',
  'public.crm_operator_workspace_bindings',
  'public.crm_organizations',
  'public.crm_root_employee_access_grants',
  'public.fractional_crm_source_mappings',
  'public.pipeline_space_members',
  'public.pipeline_spaces',
  'public.project_boards',
].sort())

// Initial enrollment also fences the full native Email source inventory and
// the shared outbox. These are direct lock/catalog targets: an incoming FK or
// a trigger function alone does not fingerprint their own complete guards.
export const PRODUCTION_REBIND_CRITICAL_RELATIONS = Object.freeze([
  ...PRE_INITIAL_ENROLLMENT_CRITICAL_RELATIONS,
  'public.crm_contacts',
  'public.crm_email_mailbox_bindings',
  'public.crm_email_mailboxes',
  'public.crm_email_review_decisions',
  'public.crm_email_sources',
  'public.crm_interaction_organizations',
  'public.crm_interactions',
  'public.crm_native_email_initial_enrollments',
  'public.crm_native_email_initial_reservations',
  'public.sync_outbox',
].sort())

const PRE_CRM_PRODUCTION_REBIND_CRITICAL_FUNCTIONS = Object.freeze([
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

// PL/pgSQL calls in trigger bodies are not necessarily recorded as pg_depend
// edges. Pin these exact helpers in addition to every installed trigger body.
// This is an inventory, not an exception/filter on the complete catalog.
const PRE_INITIAL_ENROLLMENT_CRM_GUARD_HELPERS = Object.freeze([
  'public.clawpilot_crm_root_app_only_membership_is_independent(jsonb,jsonb)',
  'public.clawpilot_crm_root_native_membership_is_independent(jsonb,jsonb)',
  'public.clawpilot_crm_root_native_membership_state(jsonb)',
  'public.clawpilot_crm_root_read_workspaces(text)',
  'public.clawpilot_crm_root_native_pipeline_read(uuid,uuid,text)',
  'public.clawpilot_crm_root_registry_projection(text,jsonb)',
  'public.clawpilot_crm_root_registry_current_row(text,text,uuid)',
  'public.clawpilot_crm_root_registry_change_rows(jsonb)',
  'public.clawpilot_effective_workspace_memberships(text)',
  'public.clawpilot_native_email_app_only_change_is_independent(text,jsonb,jsonb)',
  'public.clawpilot_native_email_identity_link_rows(jsonb)',
  'public.clawpilot_native_email_identity_projection(jsonb)',
  'public.clawpilot_native_email_mapped_settings_are_independent(text,jsonb,jsonb)',
  'public.clawpilot_native_email_unshared_workspace_is_independent(text,jsonb,jsonb)',
  'public.clawpilot_native_email_user_change_rows(jsonb)',
  'public.clawpilot_native_email_user_is_eligible(jsonb,jsonb)',
  'public.clawpilot_native_email_user_projection(text,jsonb)',
  'public.global_reference_code_is_valid(text,text)',
  'public.global_reference_prefix_is_valid(text)',
])
const PRE_INITIAL_REPLAN_CRM_GUARD_HELPERS = Object.freeze([
  ...PRE_INITIAL_ENROLLMENT_CRM_GUARD_HELPERS,
  'public.clawpilot_crm_native_initial_source_snapshot()',
  'public.clawpilot_crm_native_initial_shape(jsonb,text[])',
])
export const PRODUCTION_REBIND_CRM_GUARD_HELPERS = Object.freeze([
  ...PRE_INITIAL_REPLAN_CRM_GUARD_HELPERS,
  'public.clawpilot_crm_native_initial_lineage_digest(jsonb)',
  'public.clawpilot_crm_native_initial_replan_context(text,text,text)',
])
const PRE_INITIAL_ENROLLMENT_CRITICAL_FUNCTIONS = Object.freeze([
  ...PRE_CRM_PRODUCTION_REBIND_CRITICAL_FUNCTIONS,
  ...PRE_INITIAL_ENROLLMENT_CRM_GUARD_HELPERS,
])
const PRODUCTION_REBIND_CRITICAL_FUNCTIONS = Object.freeze([
  ...PRE_CRM_PRODUCTION_REBIND_CRITICAL_FUNCTIONS,
  ...PRODUCTION_REBIND_CRM_GUARD_HELPERS,
])
const PRE_INITIAL_REPLAN_CRITICAL_FUNCTIONS = Object.freeze([
  ...PRE_CRM_PRODUCTION_REBIND_CRITICAL_FUNCTIONS,
  ...PRE_INITIAL_REPLAN_CRM_GUARD_HELPERS,
])

// PostgreSQL can render equivalent catalog objects differently across major
// versions. Each supported major is therefore exercised against the complete
// migration chain and enrolled explicitly. Unknown majors fail closed.
export const PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: '22808494dbdc3510bdccb57fe0a491344a1e8bc57195594d089cdf568e63842e',
  18: 'f0685b9f82de44c3c1cf1c10e4ce077c43d1040992234e551e338311160f3e64',
})
export const PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'cc19a57dd52699a99a5b65f6b194898f03e2afca0427bb671a751156b71ade53',
  18: '5fd850649717454a790185f22e916c2be58a80cdc8cbc87317fd4e936cc0d553',
})
// Actual full-catalog PG16/18 diagnostics r467/r468; the full tamper gate must
// independently accept these pins. Never learn a replacement from runtime.
const EXPECTED_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'efbd7c05436a394e29c45522465602790f3fa8ff9cfcb9b12802cae416b8e864',
  18: 'c8da9f9b5d54395eb2527e9d472396bbf2b593b6312b2c14d4ef3ae13a3d130d',
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
      'physicalRelation', trigger_row.tgrelid::regclass::text,
      'name', trigger_row.tgname,
      'enabled', trigger_row.tgenabled::text,
      'internal', trigger_row.tgisinternal,
      'typeMask', trigger_row.tgtype::integer,
      'argumentCount', trigger_row.tgnargs::integer,
      'argumentsHex', pg_catalog.encode(trigger_row.tgargs, 'hex'),
      -- A row-trigger WHEN can reference BOTH OLD and NEW. pg_get_expr only
      -- supports one relation and fails on these real root-session guards.
      -- pg_get_triggerdef is the native renderer with both transition rows;
      -- retain its whole definition, not a lossy regex-extracted predicate.
      'when', CASE WHEN trigger_row.tgqual IS NULL THEN NULL ELSE
        pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
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
      'attributeNumbers', trigger_row.tgattr::text,
      'oldTransitionTable', trigger_row.tgoldtable,
      'newTransitionTable', trigger_row.tgnewtable,
      'constraintIndex', CASE WHEN trigger_row.tgconstrindid = 0 THEN NULL
        ELSE trigger_row.tgconstrindid::regclass::text END,
      'foreignKey', CASE WHEN constraint_row.contype IS DISTINCT FROM 'f' THEN NULL ELSE
        pg_catalog.jsonb_build_object(
          'schema', constraint_owner.nspname,
          'name', constraint_row.conname,
          'type', constraint_row.contype::text,
          'source', constraint_row.conrelid::regclass::text,
          'target', constraint_row.confrelid::regclass::text,
          'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
          'validated', constraint_row.convalidated,
          'enforced', COALESCE((pg_catalog.to_jsonb(constraint_row)->>'conenforced')::boolean, true),
          'deferrable', constraint_row.condeferrable,
          'initiallyDeferred', constraint_row.condeferred,
          'updateAction', constraint_row.confupdtype::text,
          'deleteAction', constraint_row.confdeltype::text,
          'matchType', constraint_row.confmatchtype::text,
          'deleteColumnNumbers', constraint_row.confdelsetcols,
          'hasParent', constraint_row.conparentid <> 0,
          'local', constraint_row.conislocal,
          'inheritanceCount', constraint_row.coninhcount::integer,
          'noInherit', constraint_row.connoinherit,
          'index', constraint_row.conindid::regclass::text,
          'columns', (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'side', selected.side, 'position', selected.position,
              'number', attribute.attnum, 'name', attribute.attname,
              'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
              'notNull', attribute.attnotnull,
              'identity', attribute.attidentity::text, 'generated', attribute.attgenerated::text,
              'collation', CASE WHEN attribute.attcollation = 0 THEN NULL
                ELSE attribute.attcollation::regcollation::text END
            ) ORDER BY selected.side, selected.position)
            FROM (
              SELECT 'source' AS side, constraint_row.conrelid AS relation,
                key.attnum, key.position
              FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY key(attnum, position)
              UNION ALL
              SELECT 'target', constraint_row.confrelid, key.attnum, key.position
              FROM pg_catalog.unnest(constraint_row.confkey) WITH ORDINALITY key(attnum, position)
            ) selected
            JOIN pg_catalog.pg_attribute attribute
              ON attribute.attrelid = selected.relation AND attribute.attnum = selected.attnum
          ),
          'operators', (
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'kind', selected.kind, 'position', selected.position,
              'operator', selected.operator::regoperator::text
            ) ORDER BY selected.kind, selected.position)
            FROM (
              SELECT 'parentParent' AS kind, op.operator, op.position
              FROM pg_catalog.unnest(constraint_row.conppeqop) WITH ORDINALITY op(operator, position)
              UNION ALL
              SELECT 'parentForeign', op.operator, op.position
              FROM pg_catalog.unnest(constraint_row.conpfeqop) WITH ORDINALITY op(operator, position)
              UNION ALL
              SELECT 'foreignForeign', op.operator, op.position
              FROM pg_catalog.unnest(constraint_row.conffeqop) WITH ORDINALITY op(operator, position)
            ) selected
          )
        ) END,
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
  LEFT JOIN pg_catalog.pg_namespace constraint_owner
    ON constraint_owner.oid = constraint_row.connamespace
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
  // PostgreSQL appends a cluster-local OID to these internal FK trigger names.
  // Never strip digits from arbitrary identifiers, expressions or function
  // bodies. Only the generated name token is replaced; the complete backing
  // FK descriptor and every other trigger field remain in the fingerprint.
  const triggers = catalog.triggers?.map((trigger) => {
    const side = /^RI_ConstraintTrigger_([ac])_[1-9][0-9]*$/u.exec(trigger.name)?.[1]
    const fk = trigger.foreignKey
    const fn = /^pg_catalog\."RI_FKey_(check_ins|check_upd|(?:noaction|restrict|cascade|setnull|setdefault)_(?:del|upd))"\(\)$/u.exec(trigger.function)?.[1]
    const bare = (relation) => relation?.replace(/^public\./u, '')
    const source = side === 'c'
    const expectedType = source && fn === 'check_ins' ? 5 : fn?.endsWith('_del') ? 9 : 17
    const prefix = `CREATE CONSTRAINT TRIGGER "${trigger.name}" `
    if (!side || !fk || fk.type !== 'f' || !fn || trigger.internal !== true
      || fk.name !== trigger.constraint || fk.schema !== 'public'
      || trigger.physicalRelation !== (source ? fk.source : fk.target)
      || bare(trigger.constraintRelation) !== (source ? fk.target : fk.source)
      || source !== fn.startsWith('check_') || trigger.typeMask !== expectedType
      || trigger.argumentCount !== 0 || trigger.argumentsHex !== '' || trigger.when !== null
      || trigger.parentTrigger !== null || trigger.attributeNumbers !== ''
      || trigger.oldTransitionTable !== null || trigger.newTransitionTable !== null
      || fk.hasParent !== false || fk.local !== true || fk.inheritanceCount !== 0
      || !fk.index || trigger.constraintIndex !== fk.index
      || !Array.isArray(fk.columns) || fk.columns.length < 2
      || !Array.isArray(fk.operators) || fk.operators.length < 3
      || !trigger.definition?.startsWith(prefix)) return trigger
    const identity = createHash('sha256').update(JSON.stringify([
      fk.schema, fk.source, fk.name, side, trigger.typeMask,
    ])).digest('hex')
    const name = `RI_ConstraintTrigger_${side}_@${identity}`
    return { ...trigger, name,
      definition: `CREATE CONSTRAINT TRIGGER "${name}" ${trigger.definition.slice(prefix.length)}` }
  })
  // Keep all rows, including duplicates and unexpected triggers. Only array
  // ordering changes: cluster OIDs must not determine the catalog digest.
  const orderedTriggers = triggers?.map(value => ({ value,
    key:JSON.stringify(normalizeCatalog(value)) })).sort((a,b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({value})=>value)
  return JSON.stringify(normalizeCatalog({ ...catalog, ...(orderedTriggers ? { triggers:orderedTriggers } : {}) }))
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

async function inspectSchemaWithFunctions(client, criticalFunctions,
  criticalRelations = PRODUCTION_REBIND_CRITICAL_RELATIONS,
  criticalMigrations = PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A PostgreSQL client with query(sql, values) is required')
  }
  const result = await client.query(TARGET_SCHEMA_CATALOG_SQL, [
    criticalRelations,
    criticalFunctions,
    criticalMigrations.map(({ filename }) => filename),
    criticalMigrations.map(({ checksum }) => checksum),
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

export async function inspectProductionRebindHistorySchema(client) {
  return inspectSchemaWithFunctions(client, PRODUCTION_REBIND_CRITICAL_FUNCTIONS)
}

/** Read-only historical comparison, never an attestation or fallback. Current
 * attestProductionRebindHistorySchema always uses the fixed current inventory. */
export async function inspectPreCrmProductionRebindSchemaMetadata(client) {
  const result = await inspectSchemaWithFunctions(client, PRE_CRM_PRODUCTION_REBIND_CRITICAL_FUNCTIONS,
    PRE_CRM_PRODUCTION_REBIND_CRITICAL_RELATIONS, PRE_INITIAL_ENROLLMENT_SCHEMA_MIGRATIONS)
  return Object.freeze({ ...result, format:'clawpilot-production-rebind-v9-metadata-only' })
}

/** Exact through-0397 v13 comparison only. It cannot attest a v14 target or
 * provide a fallback for missing initial-enrollment objects/ledger evidence. */
export async function inspectPreInitialEnrollmentProductionRebindSchemaMetadata(client) {
  const result = await inspectSchemaWithFunctions(client,
    PRE_INITIAL_ENROLLMENT_CRITICAL_FUNCTIONS,
    PRE_INITIAL_ENROLLMENT_CRITICAL_RELATIONS,
    PRE_INITIAL_ENROLLMENT_SCHEMA_MIGRATIONS)
  return Object.freeze({ ...result, format:'clawpilot-production-rebind-v13-metadata-only' })
}

/** Exact through-0398 v14 comparison only, never a current v15 attestation. */
export async function inspectPreInitialReplanProductionRebindSchemaMetadata(client) {
  const result = await inspectSchemaWithFunctions(client,
    PRE_INITIAL_REPLAN_CRITICAL_FUNCTIONS,
    PRODUCTION_REBIND_CRITICAL_RELATIONS,
    PRE_INITIAL_REPLAN_SCHEMA_MIGRATIONS)
  return Object.freeze({ ...result, format:'clawpilot-production-rebind-v14-metadata-only' })
}

export async function attestProductionRebindHistorySchema(client) {
  const inspection = await inspectProductionRebindHistorySchema(client)
  if (inspection.migrations.some(
    (migration) => migration.rows !== 1 || migration.matchingRows !== 1,
  )) {
    throw new ProductionRebindHistorySchemaAttestationError(
      'migration_checksum_mismatch',
      'expected one exact ledger row for migrations 0349, 0353 through 0359, and 0370 through 0399',
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
