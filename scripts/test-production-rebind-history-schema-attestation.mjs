#!/usr/bin/env node

import {
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrationSqlForTest } from './lib/postgres-test-migrations.mjs'
import './test-production-rebind-catalog-canonicalization.mjs'

import {
  PRODUCTION_REBIND_CRITICAL_RELATIONS,
  PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT,
  PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM,
  PRODUCTION_REBIND_SCHEMA_MIGRATIONS,
  PRODUCTION_REBIND_CRM_GUARD_HELPERS,
  PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_INITIAL_DEMO_QUARANTINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  ProductionRebindHistorySchemaAttestationError,
  attestProductionRebindHistorySchema,
  inspectProductionRebindHistorySchema,
  inspectPreCrmProductionRebindSchemaMetadata,
  inspectPreInitialEnrollmentProductionRebindSchemaMetadata,
  inspectPreInitialReplanProductionRebindSchemaMetadata,
  inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,
  productionRebindHistorySchemaDigest,
} from './production-rebind-history-schema-attestation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

const requestedImage = process.env.CLAWPILOT_TEST_POSTGRES_IMAGE?.trim()
const images = requestedImage
  ? [requestedImage]
  : ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18']

// Historical projections re-fingerprinted with v10's complete FK descriptors
// and generated-name canonicalization. These are NOT old v6-v9 raw receipts.
// The diagnostic retains an independent byte-for-byte v9 baseline assertion.
export const PRIOR_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'f5762ced311e2ffc0bb41ef7faed223e97cadecfe3eb199676eefd913aec6106',
  18: 'c7099b117c869bc82fd4ea69d3f22fa89ab21388c198386c6f5576822347d737',
})
export const PRE_GATEWAY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: '7dfd2225224f8189f6fe1114ebe48f7e49ec15b819e15d51542d416ee2a48088',
  18: 'eb54a373cda2316718d338744027bebecd0ccd6973d066768751ab002b349729',
})
export const PRE_CALENDAR_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'f1a4e64c58206732f9e6188cdf6ab5b61bbd469351a1ff32a33edabc667d2838',
  18: '19dafed72a1fd538644007c70dc4cb37815ef7f225ca183cf166968056ff720a',
})
// Semantic v8 projection, before the exact four 0374 dependencies on a
// rebind-critical relation: their action-trigger pairs on public.app_users.
export const PRE_REVIEWED_COMPANY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16: 'cdf58d34b5d8fb6202589ddd42b03099f9e4106b4c172abbbc366a2b20e0b5dc',
  18: 'ea60f6ddbc21fec8d9e354b7fab1bc88ccab6f4bbd3971936bf1b9ff635bfa74',
})
export const PRE_NATIVE_V9_SCHEMA_DIGEST_BY_POSTGRES_MAJOR = Object.freeze({
  16:'43767ef8dec0534ca435c48281ed9bea0f9a515bd0c083bef0eafe310deb4fc4',
  18:'114ae8b25c5209b8b1f0ac3adfb49bffdc1cad176670d25efb7209580e10f7ab',
})
const REVIEWED_COMPANY_MIGRATION = '0374_crm_interaction_organizations.sql'
const INITIAL_ENROLLMENT_MIGRATION = '0398_crm_native_email_initial_enrollment.sql'
const INITIAL_REPLAN_MIGRATION = '0399_crm_native_email_initial_replan_lineage.sql'
const INITIAL_DEMO_QUARANTINE_MIGRATION = '0400_crm_native_email_demo_quarantine.sql'
const INITIAL_DEMO_QUARANTINE_HELPER = 'public.clawpilot_crm_native_initial_demo_quarantine(uuid,text)'
const INITIAL_ENROLLMENT_RELATIONS = [
  'crm_contacts','crm_email_mailbox_bindings','crm_email_mailboxes','crm_email_review_decisions',
  'crm_email_sources','crm_interaction_organizations','crm_interactions',
  'crm_native_email_initial_enrollments','crm_native_email_initial_reservations','sync_outbox',
].map(name=>`public.${name}`)
const INITIAL_SOURCE_UPDATE_COLUMNS = new Map([
  ['app_users',['email','status','role','permissions','organization_id','suitecrm_user_id','reference_code','crm_user_enabled','suitecrm_username']],
  ['app_user_organization_memberships',['user_email','organization_id','status','role','permissions','trashed_at','trashed_by','pre_trash_status']],
  ['workspace_organizations',['id','parent_id','organization_type','is_demo']],
  ['pipeline_spaces',['id','owner_email','workspace_organization_id','reference_access_disabled']],
  ['crm_products',['id','pipeline_id','suitecrm_id','source_payload']],
])
const INITIAL_FULL_SOURCE_RELATIONS = [
  'pipeline_space_members','crm_operator_accounts','crm_operator_workspace_bindings','crm_root_employee_access_grants',
  'crm_interactions','crm_organizations','crm_contacts','crm_interaction_organizations','crm_email_sources',
  'crm_email_review_decisions','crm_email_mailbox_bindings','crm_email_mailboxes','crm_native_email_publication_admissions',
  'crm_native_email_publication_work','crm_native_email_authority_transitions','crm_native_email_authority_phases',
  'crm_native_email_authority_member_changes','crm_native_email_authority_user_changes',
  'crm_native_email_authority_root_changes','crm_native_email_authority_grant_attempts',
]
const INITIAL_ENROLLMENT_TRIGGERS = [
  ...[...INITIAL_SOURCE_UPDATE_COLUMNS.keys()].flatMap(table=>{
    const prefix=table==='crm_products'?'crm_native_initial_demo_product_source':'crm_native_initial_source'
    return [
      [table,`${prefix}_fence`,46,'clawpilot_crm_native_initial_source_fence'],
      [table,`${prefix}_update_fence`,18,'clawpilot_crm_native_initial_source_fence'],
    ]
  }),
  ...INITIAL_FULL_SOURCE_RELATIONS.map(table=>[table,'crm_native_initial_source_fence',62,'clawpilot_crm_native_initial_source_fence']),
  ['crm_native_email_initial_enrollments','crm_native_initial_statement',62,'clawpilot_crm_native_initial_lock'],
  ['crm_native_email_initial_reservations','crm_native_initial_reservation_statement',62,'clawpilot_crm_native_initial_lock'],
  ['crm_native_email_initial_reservations','crm_native_initial_reserve',7,'clawpilot_crm_native_initial_reserve'],
  ['crm_native_email_initial_reservations','crm_native_initial_barrier',5,'clawpilot_crm_native_initial_barrier'],
  ['crm_native_email_initial_enrollments','crm_native_initial_admit',7,'clawpilot_crm_native_initial_admit'],
  ['crm_native_email_publication_control','crm_native_initial_control_guard',19,'clawpilot_crm_native_initial_control_guard'],
  ['crm_native_email_initial_enrollments','crm_native_initial_settle',19,'clawpilot_crm_native_initial_settle_guard'],
  ['crm_native_email_initial_reservations','crm_native_initial_reservation_settle',19,'clawpilot_crm_native_initial_reservation_settle'],
  ['sync_outbox','crm_native_initial_outbox_lock',62,'clawpilot_native_email_work_statement_lock'],
  ['sync_outbox','crm_native_initial_outbox_fence',31,'clawpilot_crm_native_initial_outbox_fence'],
  ['sync_outbox','crm_native_initial_outbox_truncate',34,'clawpilot_crm_native_initial_outbox_fence'],
  ['crm_native_email_capability_policies','crm_native_initial_policy_fence',31,'clawpilot_crm_native_initial_policy_fence'],
  ['crm_native_email_capability_policies','crm_native_initial_policy_truncate',34,'clawpilot_crm_native_initial_source_fence'],
  ['crm_native_email_initial_enrollments','crm_native_initial_complete',21,'clawpilot_crm_native_initial_complete',true],
  ['crm_native_email_initial_reservations','crm_native_initial_reservation_complete',21,'clawpilot_crm_native_initial_complete',true],
  ['crm_native_email_publication_control','crm_native_initial_control_complete',17,'clawpilot_crm_native_initial_complete',true],
]
export const REVIEWED_EMAIL_REFERENCE_CONSTRAINTS = new Map([
  ['crm_interaction_organizations_created_by_fkey', { relation: 'public.crm_interaction_organizations', column: 'created_by', deleteAction: 'n' }],
  ['crm_email_mailboxes_owner_email_fkey', { relation: 'public.crm_email_mailboxes', column: 'owner_email', deleteAction: 'a' }],
  ['crm_email_sources_owner_email_fkey', { relation: 'public.crm_email_sources', column: 'owner_email', deleteAction: 'a' }],
  ['crm_email_review_decisions_actor_email_fkey', { relation: 'public.crm_email_review_decisions', column: 'actor_email', deleteAction: 'a' }],
])
export const GATEWAY_REFERENCE_CONSTRAINTS = new Map([
  ['fractional_crm_gateway_credentials_actor_email_fkey', 'public.app_users'],
  ['fractional_crm_verified_identifiers_accepted_by_fkey', 'public.app_users'],
  ['fractional_crm_review_decisions_approved_by_fkey', 'public.app_users'],
  ['fractional_crm_gateway_credentia_workspace_organization_id_fkey', 'public.workspace_organizations'],
  ['fractional_crm_source_mappings_workspace_organization_id_fkey', 'public.workspace_organizations'],
  ['fractional_crm_verified_identifi_workspace_organization_id_fkey', 'public.workspace_organizations'],
])
export const CALENDAR_REFERENCE_CONSTRAINTS = new Map([
  ['crm_calendar_discovery_sources_workspace_organization_id_fkey', 'public.workspace_organizations'],
  ['crm_calendar_discovery_sources_credential_owner_email_fkey', 'public.app_users'],
  ['crm_calendar_discovery_sources_created_by_fkey', 'public.app_users'],
  ['crm_meeting_contacts_created_by_fkey', 'public.app_users'],
])
const CURRENT_CRM_REFERENCE_CONSTRAINTS = new Map([
  ...['crm_native_email_initial_reservations','crm_native_email_initial_enrollments'].flatMap(table=>[
    [`${table}_actor_email_fkey`,{relation:`public.${table}`,column:'actor_email',deleteAction:'r'}],
    [`${table}_operator_account_id_fkey`,{relation:`public.${table}`,column:'operator_account_id',deleteAction:'r',targetRelation:'public.crm_operator_accounts',targetColumn:'id'}],
    [`${table}_root_workspace_id_fkey`,{relation:`public.${table}`,column:'root_workspace_id',deleteAction:'r',targetRelation:'public.workspace_organizations',targetColumn:'id'}],
  ]),
  ['crm_native_email_initial_enrollments_operation_id_fkey',{relation:'public.crm_native_email_initial_enrollments',column:'operation_id',deleteAction:'r',targetRelation:'public.crm_native_email_initial_reservations',targetColumn:'operation_id'}],
  ['crm_native_email_publication__active_initial_enrollment_id_fkey',{relation:'public.crm_native_email_publication_control',column:'active_initial_enrollment_id',deleteAction:'r',targetRelation:'public.crm_native_email_initial_reservations',targetColumn:'operation_id'}],
  ['crm_native_email_authority_transitions_actor_email_fkey', {relation:'public.crm_native_email_authority_transitions',column:'actor_email',deleteAction:'r'}],
  ['crm_native_email_authority_member_changes_user_email_fkey', {relation:'public.crm_native_email_authority_member_changes',column:'user_email',deleteAction:'r'}],
  ['crm_native_email_authority_user_changes_user_email_fkey', {relation:'public.crm_native_email_authority_user_changes',column:'user_email',deleteAction:'r'}],
  ['crm_native_email_authority_user_changes_organization_id_fkey', {relation:'public.crm_native_email_authority_user_changes',column:'organization_id',deleteAction:'r',targetRelation:'public.workspace_organizations',targetColumn:'id'}],
  ...['crm_customer_drive_folders','crm_customer_folder_settings','crm_customer_folder_jobs'].map(table=>[
    `${table}_workspace_id_fkey`, {relation:`public.${table}`,column:'workspace_id',deleteAction:'r',targetRelation:'public.workspace_organizations',targetColumn:'id'},
  ]),
])
export const NEW_REFERENCE_CONSTRAINTS = new Map([
  ...GATEWAY_REFERENCE_CONSTRAINTS,
  ...CALENDAR_REFERENCE_CONSTRAINTS,
  ...[...REVIEWED_EMAIL_REFERENCE_CONSTRAINTS.keys()].map(name => [name, 'public.app_users']),
  ['app_user_login_addresses_user_email_fkey', 'public.app_users'],
  ['app_login_email_changes_user_email_fkey', 'public.app_users'],
  ['app_user_google_login_bindings_user_email_fkey', 'public.app_users'],
  ['app_user_google_login_bindings_linked_by_fkey', 'public.app_users'],
  ['app_google_subject_owners_user_email_fkey', 'public.app_users'],
  ['workspace_organization_web_preferences_updated_by_fkey', 'public.app_users'],
  ['app_user_google_login_bindings_linked_organization_id_fkey', 'public.workspace_organizations'],
  ['workspace_organization_web_preferences_organization_id_fkey', 'public.workspace_organizations'],
])

assert.equal(PRODUCTION_REBIND_HISTORY_SCHEMA_ATTESTATION_FORMAT,
  'clawpilot-production-rebind-target-schema-attestation-v16')
assert.deepEqual(PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'22808494dbdc3510bdccb57fe0a491344a1e8bc57195594d089cdf568e63842e',
  18:'f0685b9f82de44c3c1cf1c10e4ce077c43d1040992234e551e338311160f3e64',
},'Forward enrollment must never retcon the historical v13 fingerprints')
assert.deepEqual(PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'cc19a57dd52699a99a5b65f6b194898f03e2afca0427bb671a751156b71ade53',
  18:'5fd850649717454a790185f22e916c2be58a80cdc8cbc87317fd4e936cc0d553',
},'Forward replan enrollment must never retcon the historical v14 fingerprints')
assert.deepEqual(PRE_INITIAL_DEMO_QUARANTINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'efbd7c05436a394e29c45522465602790f3fa8ff9cfcb9b12802cae416b8e864',
  18:'c8da9f9b5d54395eb2527e9d472396bbf2b593b6312b2c14d4ef3ae13a3d130d',
},'Demo quarantine must never retcon the independently accepted historical v15 fingerprints')
assert.equal(PRODUCTION_REBIND_SCHEMA_MIGRATIONS.at(-1).filename,INITIAL_DEMO_QUARANTINE_MIGRATION,
  'Current acceptance requires 0400, never a historical floor')
for(const helper of ['public.clawpilot_crm_native_initial_lineage_digest(jsonb)',
  'public.clawpilot_crm_native_initial_replan_context(text,text,text)',INITIAL_DEMO_QUARANTINE_HELPER]) assert.ok(PRODUCTION_REBIND_CRM_GUARD_HELPERS.includes(helper),helper)
for(const relation of [...INITIAL_ENROLLMENT_RELATIONS,'public.crm_products']) assert.ok(PRODUCTION_REBIND_CRITICAL_RELATIONS.includes(relation),
  `${relation} must be a direct locked/fingerprinted target`)

for (const image of images) {
  assert.match(
    image,
    /(?:postgres|pgvector)(?::|\/)(?:pg)?(?:16|18)(?:-|$)/iu,
    'CLAWPILOT_TEST_POSTGRES_IMAGE must select PostgreSQL 16 or 18',
  )
}

assert.deepEqual(
  [...PRODUCTION_REBIND_CRITICAL_RELATIONS].sort(),
  [...PRODUCTION_REBIND_CRITICAL_RELATIONS],
  'critical relation lock targets are deterministic',
)
assert.equal(
  new Set(PRODUCTION_REBIND_CRITICAL_RELATIONS).size,
  PRODUCTION_REBIND_CRITICAL_RELATIONS.length,
  'critical relation lock targets are unique',
)
assert.equal(
  Object.isFrozen(PRODUCTION_REBIND_CRITICAL_RELATIONS),
  true,
  'critical relation lock targets are immutable',
)

for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
  const installed = readFileSync(
    resolve(root, 'db/migrations', expected.filename),
    'utf8',
  )
  assert.equal(
    createHash('sha256').update(installed, 'utf8').digest('hex'),
    expected.checksum,
    `the frozen ${expected.filename} checksum matches the reviewed migration bytes`,
  )
}
assert.equal(
  PRODUCTION_REBIND_SCHEMA_MIGRATIONS[0].checksum,
  PRODUCTION_REBIND_HISTORY_SCHEMA_MIGRATION_CHECKSUM,
)

// The historical metadata helpers retain their pre-v14 ledger projection,
// independently of the current attester's mandatory forward migration floor.
for(const [inspect,lastMigration] of [
  [inspectPreCrmProductionRebindSchemaMetadata,'0397_crm_native_root_registry_changes.sql'],
  [inspectPreInitialEnrollmentProductionRebindSchemaMetadata,'0397_crm_native_root_registry_changes.sql'],
  [inspectPreInitialReplanProductionRebindSchemaMetadata,INITIAL_ENROLLMENT_MIGRATION],
  [inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,INITIAL_REPLAN_MIGRATION],
  [inspectProductionRebindHistorySchema,INITIAL_DEMO_QUARANTINE_MIGRATION],
]){
  let selectedMigrations,selectedRelations,selectedFunctions
  await inspect({query:async (_sql,values)=>{
    selectedRelations=values[0]
    selectedFunctions=values[1]
    selectedMigrations=values[2]
    return {rowCount:1,rows:[{server_version_num:160000,schema:{},relations:[],columns:[],constraints:[],
      indexes:[],triggers:[],functions:[],migrations:[],missing_relations:[],missing_functions:[]}]}
  }})
  assert.equal(selectedMigrations.at(-1),lastMigration,`${inspect.name} retains its exact ledger floor`)
  assert.equal(selectedMigrations.includes(INITIAL_ENROLLMENT_MIGRATION),inspect===inspectProductionRebindHistorySchema
    ||inspect===inspectPreInitialReplanProductionRebindSchemaMetadata
    ||inspect===inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,'Only current and exact v14/v15 metadata include 0398')
  assert.equal(selectedMigrations.includes(INITIAL_REPLAN_MIGRATION),inspect===inspectProductionRebindHistorySchema
    ||inspect===inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,
    'Only current and exact v15 metadata enroll 0399; historical readers never provide a fallback')
  for(const currentOnly of [selectedMigrations.includes(INITIAL_DEMO_QUARANTINE_MIGRATION),
    selectedRelations.includes('public.crm_products'),selectedFunctions.includes(INITIAL_DEMO_QUARANTINE_HELPER)]){
    assert.equal(currentOnly,inspect===inspectProductionRebindHistorySchema,
      'Only current v16 enrolls the complete 0400 migration, helper and direct Product source catalog')
  }
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

let checkedTamperCases = 0
function recordTamperCase() {
  checkedTamperCases += 1
  if (checkedTamperCases % 20 === 0) console.log(`Verified ${checkedTamperCases} catalog/ledger tamper refusals with clean rollback re-attestation`)
}

async function expectFailure(pool, expectedCode, label, mutate) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const before = await inspectProductionRebindHistorySchema(client)
    await mutate(client)
    const after = await inspectProductionRebindHistorySchema(client)
    assert.notEqual(after.schemaDigest, before.schemaDigest, `${label} changes the catalog digest`)
    await assert.rejects(
      attestProductionRebindHistorySchema(client),
      (error) => (
        error instanceof ProductionRebindHistorySchemaAttestationError
        && error.code === expectedCode
      ),
      `${label} must fail with ${expectedCode}`,
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  await attestProductionRebindHistorySchema(pool)
  recordTamperCase()
}

async function expectLedgerFailure(pool, filename, missing = false) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(missing
      ? 'DELETE FROM public.schema_migrations WHERE filename = $1'
      : `UPDATE public.schema_migrations SET checksum = repeat('0', 64) WHERE filename = $1`,
    [filename])
    await assert.rejects(
      attestProductionRebindHistorySchema(client),
      (error) => (
        error instanceof ProductionRebindHistorySchemaAttestationError
        && error.code === 'migration_checksum_mismatch'
      ),
      `${filename} ${missing ? 'missing ledger row' : 'ledger drift'} fails closed`,
    )
    await client.query('ROLLBACK')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  await attestProductionRebindHistorySchema(pool)
  recordTamperCase()
}

async function verifyReviewedEmailReferenceTriggers(pool, catalog, definitions=REVIEWED_EMAIL_REFERENCE_CONSTRAINTS) {
  const verified = []
  for (const [constraint, expected] of definitions) {
  const targetRelation=expected.targetRelation??'public.app_users',targetColumn=expected.targetColumn??'email'
  const result = await pool.query(
    `SELECT constraint_row.conname AS name, constraint_row.contype::text AS type,
       source_namespace.nspname || '.' || source_relation.relname AS source_relation,
       ARRAY(SELECT attribute.attname::text
         FROM unnest(constraint_row.conkey) WITH ORDINALITY selected(attnum, position)
         JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = selected.attnum ORDER BY selected.position) AS source_columns,
       target_namespace.nspname || '.' || target_relation.relname AS target_relation,
       ARRAY(SELECT attribute.attname::text
         FROM unnest(constraint_row.confkey) WITH ORDINALITY selected(attnum, position)
         JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = selected.attnum ORDER BY selected.position) AS target_columns,
       constraint_row.convalidated AS validated,
       constraint_row.condeferrable AS deferrable, constraint_row.condeferred AS deferred,
       constraint_row.confupdtype::text AS update_action, constraint_row.confdeltype::text AS delete_action,
       constraint_row.confmatchtype::text AS match_type,
       constraint_row.confdelsetcols IS NULL AS default_delete_columns,
       COALESCE((pg_catalog.to_jsonb(constraint_row)->>'conenforced')::boolean, true) AS enforced,
       constraint_row.conparentid = 0 AS no_parent,
       constraint_row.conislocal AS local, constraint_row.coninhcount::integer AS inheritance_count
     FROM pg_catalog.pg_constraint constraint_row
     JOIN pg_catalog.pg_class source_relation ON source_relation.oid = constraint_row.conrelid
     JOIN pg_catalog.pg_namespace source_namespace ON source_namespace.oid = source_relation.relnamespace
     JOIN pg_catalog.pg_class target_relation ON target_relation.oid = constraint_row.confrelid
     JOIN pg_catalog.pg_namespace target_namespace ON target_namespace.oid = target_relation.relnamespace
     WHERE constraint_row.conrelid = $2::regclass
       AND constraint_row.conname = $1`,
    [constraint, expected.relation],
  )
  assert.equal(result.rowCount, 1, `Exactly the reviewed ${constraint} descriptor exists`)
  assert.deepEqual(result.rows[0], {
    name: constraint, type: 'f',
    source_relation: expected.relation, source_columns: [expected.column],
    target_relation: targetRelation, target_columns: [targetColumn],
    validated: true, deferrable: false, deferred: false,
    update_action: 'a', delete_action: expected.deleteAction, match_type: 's', default_delete_columns: true, enforced: true,
    no_parent: true, local: true, inheritance_count: 0,
  }, 'FK identity, columns, validation, action and deferral semantics are exact')
  const triggers = catalog.triggers.filter((trigger) => trigger.constraint === constraint && trigger.relation===targetRelation)
  assert.equal(triggers.length, 2, `0374 adds exactly two action triggers for ${constraint}`)
  assert.equal(new Set(triggers.map((trigger) => trigger.name)).size, 2)
  for (const trigger of triggers) {
    assert.match(trigger.name, /^RI_ConstraintTrigger_a_[1-9][0-9]*$/u)
    const { name, definition, foreignKey, attributeNumbers, oldTransitionTable,
      newTransitionTable, constraintIndex, physicalRelation, ...semantics } = trigger
    assert.equal(physicalRelation, targetRelation.replace(/^public\./u, ''))
    assert.equal(attributeNumbers, '')
    assert.equal(oldTransitionTable, null)
    assert.equal(newTransitionTable, null)
    assert.equal(constraintIndex, foreignKey.index)
    assert.equal(foreignKey.source, expected.relation.replace(/^public\./u, ''))
    assert.equal(foreignKey.target, targetRelation.replace(/^public\./u, ''))
    assert.equal(foreignKey.name, constraint)
    assert.equal(foreignKey.deleteAction, expected.deleteAction)
    assert.equal(foreignKey.updateAction, 'a')
    assert.deepEqual(foreignKey.columns.map(({side,name})=>({side,name})), [
      {side:'source',name:expected.column}, {side:'target',name:targetColumn},
    ])
    assert.equal(foreignKey.operators.length, 3)
    assert.ok(typeof definition === 'string' && definition.includes(name), '0374 trigger definition names its exact action trigger')
    assert.deepEqual(semantics, {
      relation: targetRelation, enabled: 'O', internal: true,
      typeMask: trigger.typeMask, argumentCount: 0, argumentsHex: '', when: null,
      function: trigger.typeMask === 9 ? (expected.deleteAction === 'n'
        ? 'pg_catalog."RI_FKey_setnull_del"()' : expected.deleteAction==='r'
          ? 'pg_catalog."RI_FKey_restrict_del"()' : 'pg_catalog."RI_FKey_noaction_del"()') : 'pg_catalog."RI_FKey_noaction_upd"()',
      constraint,
      constraintRelation: expected.relation,
      deferrable: false, initiallyDeferred: false, parentTrigger: null, comment: null,
    }, '0374 referenced-table action trigger semantics are exact')
  }
  assert.deepEqual(triggers.map((trigger) => trigger.typeMask).sort((a, b) => a - b), [9, 17])
  verified.push(...triggers)
  }
  assert.equal(verified.length,definitions.size*2,'Every individually reviewed FK has exactly two referenced-table guards')
  return verified
}

async function verifyHistoricalCatalogCompatibility(currentUrl, currentBaseline) {
  // Historical comparison only. Current acceptance uses the production runner
  // and complete unmodified current catalog, never this metadata-only profile.
  const controlPool=new Pool({connectionString:currentUrl,max:1})
  try {await controlPool.query('CREATE DATABASE clawpilot_rebind_v9_fixture')}
  finally {await controlPool.end()}
  const url=new URL(currentUrl);url.pathname='/clawpilot_rebind_v9_fixture'
  const pool=new Pool({connectionString:url.toString(),max:1})
  try {
    const client=await pool.connect()
    try {
      const runner=readFileSync(resolve(root,'scripts/db-migrate.mjs'),'utf8')
      const bootstrap=runner.match(/CREATE TABLE IF NOT EXISTS schema_migrations \(\s+filename text PRIMARY KEY,\s+checksum text,\s+applied_at timestamptz NOT NULL DEFAULT now\(\)\s+\)/)?.[0]
      assert.ok(bootstrap,'Review changed production ledger bootstrap before historical comparison')
      await client.query(bootstrap)
      for(const file of readdirSync(resolve(root,'db/migrations')).filter(f=>/^\d+_.+\.sql$/.test(f)&&f<='0374_crm_interaction_organizations.sql').sort()){
        const sql=readFileSync(resolve(root,'db/migrations',file),'utf8')
        await applyMigrationSqlForTest(client,file,sql,{checksum:createHash('sha256').update(sql).digest('hex')})
      }
    } finally {client.release()}
    const baseline=await inspectPreCrmProductionRebindSchemaMetadata(pool)
    assert.equal(baseline.format,'clawpilot-production-rebind-v9-metadata-only')
    assert.equal(baseline.schemaDigest,PRE_NATIVE_V9_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[baseline.postgresMajor],
      'Historical fixture must equal the enrolled pre-native semantic catalog before its earlier projections')
    const reviewedEmailTriggers = await verifyReviewedEmailReferenceTriggers(pool, baseline.catalog)
    // This projection is test evidence only. Runtime attestation always hashes
    // and accepts the complete, unmodified catalog for its enrolled PG major.
    const v8Catalog = {
      ...baseline.catalog,
      triggers: baseline.catalog.triggers.filter((trigger) => !reviewedEmailTriggers.includes(trigger)),
    }
    assert.equal(productionRebindHistorySchemaDigest(v8Catalog),
      PRE_REVIEWED_COMPANY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[baseline.postgresMajor],
      'only the exact four verified 0374 FK pairs explain the change from attestation v8')
    for (const [constraint, relation] of NEW_REFERENCE_CONSTRAINTS) {
      const triggers = baseline.catalog.triggers.filter((trigger) => (
        trigger.constraint === constraint && trigger.relation === relation
      ))
      assert.equal(triggers.length, 2, `${constraint} has both referenced-table guards`)
      assert.deepEqual(
        triggers.map(({ typeMask }) => typeMask).sort((left, right) => left - right),
        [9, 17],
        `${constraint} guards both referenced-table DELETE and UPDATE`,
      )
      assert.ok(triggers.every((trigger) => trigger.internal && trigger.enabled === 'O'))
    }
    const loginAddressGuard = baseline.catalog.triggers.filter((trigger) => (
      trigger.relation === 'public.app_users'
      && trigger.name === 'app_users_guard_login_address'
    ))
    assert.equal(loginAddressGuard.length, 1)
    assert.equal(loginAddressGuard[0].internal, false)
    assert.equal(loginAddressGuard[0].enabled, 'O')
    assert.equal(loginAddressGuard[0].function, 'public.guard_clawpilot_login_address()')
    const addedTriggers = baseline.catalog.triggers.filter((trigger) => (
      NEW_REFERENCE_CONSTRAINTS.has(trigger.constraint)
      || trigger.name === 'app_users_guard_login_address'
    ))
    assert.equal(addedTriggers.length, NEW_REFERENCE_CONSTRAINTS.size * 2 + 1,
      'only the individually reviewed FK pairs and login guard are new')
    const addedFunctions = baseline.catalog.functions.filter((fn) => (
      fn.schema === 'public' && fn.name === 'guard_clawpilot_login_address'
    ))
    assert.equal(addedFunctions.length, 1)
    assert.equal(addedFunctions[0].result, 'trigger')
    const gatewayTriggers = baseline.catalog.triggers.filter((trigger) => (
      GATEWAY_REFERENCE_CONSTRAINTS.has(trigger.constraint)
    ))
    assert.equal(gatewayTriggers.length, 12, '0372 adds exactly six referenced-table FK pairs')
    const calendarTriggers = baseline.catalog.triggers.filter((trigger) => (
      CALENDAR_REFERENCE_CONSTRAINTS.has(trigger.constraint)
    ))
    assert.equal(calendarTriggers.length, 8, '0373 adds exactly four referenced-table FK pairs')
    assert.equal(
      productionRebindHistorySchemaDigest({
        ...v8Catalog,
        triggers: v8Catalog.triggers.filter((trigger) => !calendarTriggers.includes(trigger)),
      }),
      PRE_CALENDAR_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[baseline.postgresMajor],
      'only the reviewed 0373 foreign-key guards explain the change from attestation v7',
    )
    assert.equal(
      productionRebindHistorySchemaDigest({
        ...v8Catalog,
        triggers: v8Catalog.triggers.filter((trigger) => (
          !gatewayTriggers.includes(trigger) && !calendarTriggers.includes(trigger)
        )),
      }),
      PRE_GATEWAY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[baseline.postgresMajor],
      'only the reviewed 0372 foreign-key guards explain the change from attestation v6',
    )
    const projectedPriorCatalog = {
      ...baseline.catalog,
      triggers: baseline.catalog.triggers.filter((trigger) => !addedTriggers.includes(trigger)),
      functions: baseline.catalog.functions.filter((fn) => !addedFunctions.includes(fn)),
    }
    assert.equal(
      productionRebindHistorySchemaDigest(projectedPriorCatalog),
      PRIOR_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[baseline.postgresMajor],
      'the reviewed 0370 through 0374 trigger and function additions alone explain the digest change',
    )
    const upgrade=await pool.connect()
    try {
      for(const file of readdirSync(resolve(root,'db/migrations')).filter(f=>/^\d+_.+\.sql$/.test(f)
        &&f>REVIEWED_COMPANY_MIGRATION&&f<INITIAL_ENROLLMENT_MIGRATION).sort()){
        const sql=readFileSync(resolve(root,'db/migrations',file),'utf8')
        await applyMigrationSqlForTest(upgrade,file,sql,{checksum:createHash('sha256').update(sql).digest('hex')})
      }
    } finally {upgrade.release()}
    const beforeInitial=await inspectPreInitialEnrollmentProductionRebindSchemaMetadata(pool)
    assert.equal(beforeInitial.format,'clawpilot-production-rebind-v13-metadata-only')
    assert.equal(beforeInitial.schemaDigest,PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[beforeInitial.postgresMajor],
      'Exact through-0397 schema preserves its independently enrolled v13 digest before forward migration 0398')
    assert.deepEqual(beforeInitial.missingRelations,[])
    assert.deepEqual(beforeInitial.missingFunctions,[])
    assert.ok(beforeInitial.migrations.every(m=>m.rows===1&&m.matchingRows===1))
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Historical v13 metadata is not a fallback attestation for the current target lacking forward migrations')
    const initialSql=readFileSync(resolve(root,'db/migrations',INITIAL_ENROLLMENT_MIGRATION),'utf8')
    const initialClient=await pool.connect()
    try{await applyMigrationSqlForTest(initialClient,INITIAL_ENROLLMENT_MIGRATION,initialSql,
      {checksum:createHash('sha256').update(initialSql).digest('hex')})}finally{initialClient.release()}
    const beforeReplan=await inspectPreInitialReplanProductionRebindSchemaMetadata(pool)
    assert.equal(beforeReplan.format,'clawpilot-production-rebind-v14-metadata-only')
    assert.equal(beforeReplan.schemaDigest,PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[beforeReplan.postgresMajor],
      'Exact through0398 preserves the independently enrolled v14 catalog before0399')
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Historical v14 metadata is not a fallback for a current target lacking0399/0400')
    const replanSql=readFileSync(resolve(root,'db/migrations',INITIAL_REPLAN_MIGRATION),'utf8')
    const replanClient=await pool.connect()
    try{await applyMigrationSqlForTest(replanClient,INITIAL_REPLAN_MIGRATION,replanSql,
      {checksum:createHash('sha256').update(replanSql).digest('hex')})}finally{replanClient.release()}
    const beforeQuarantine=await inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata(pool)
    assert.equal(beforeQuarantine.format,'clawpilot-production-rebind-v15-metadata-only')
    assert.equal(beforeQuarantine.schemaDigest,
      PRE_INITIAL_DEMO_QUARANTINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[beforeQuarantine.postgresMajor],
      'Exact through0399 preserves the independently accepted v15 catalog before0400')
    assert.deepEqual(beforeQuarantine.missingRelations,[])
    assert.deepEqual(beforeQuarantine.missingFunctions,[])
    assert.ok(beforeQuarantine.migrations.every(m=>m.rows===1&&m.matchingRows===1))
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Historical v15 metadata is not a fallback for a current v16 target lacking0400')
    command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL:url.toString(), PGSSLMODE:'disable' }, timeout:180_000,
    })
    const completed = await inspectProductionRebindHistorySchema(pool)
    const sourceSnapshot=catalog=>catalog.functions.find(fn=>fn.schema==='public'
      &&fn.name==='clawpilot_crm_native_initial_source_snapshot')
    assert.ok(sourceSnapshot(beforeQuarantine.catalog))
    assert.equal(sourceSnapshot(completed.catalog)?.source,sourceSnapshot(beforeQuarantine.catalog).source,
      '0400 must preserve the complete historical source snapshot bytes, not filter demo evidence out')
    assert.equal(sourceSnapshot(completed.catalog)?.definition,sourceSnapshot(beforeQuarantine.catalog).definition,
      '0400 must not replace or weaken the historical source snapshot function')
    assert.notDeepEqual(completed.catalog.triggers.filter(t=>t.internal).map(t=>t.name),
      currentBaseline.catalog.triggers.filter(t=>t.internal).map(t=>t.name),
      'Second database must exercise genuinely different generated trigger OIDs')
    assert.equal(completed.schemaDigest, currentBaseline.schemaDigest,
      'Equivalent migrated databases with different OID allocation have identical v16 fingerprints')
    await attestProductionRebindHistorySchema(pool)
    console.log(`PG${completed.postgresMajor}: second-database historical upgrade and OID-independent attestation passed`)
  } finally {await pool.end()}
}

async function exerciseImage(image) {
  checkedTamperCases = 0
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const container = `clawpilot-target-schema-attestation-${suffix}`
  const password = `target-schema-attestation-${suffix}`
  let pool
  command('docker', disposablePostgresDockerArgs([
    'run', '--detach', '--rm', '--name', container,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_DB=clawpilot_target_schema_attestation',
    '--publish', '127.0.0.1::5432',
    image,
  ]))
  try {
    const portOutput = command('docker', ['port', container, '5432/tcp']).trim()
    const port = portOutput.slice(portOutput.lastIndexOf(':') + 1)
    assert.match(port, /^\d+$/u, 'Docker published a PostgreSQL port')
    const databaseUrl =
      `postgresql://postgres:${password}@127.0.0.1:${port}/clawpilot_target_schema_attestation`
    await waitForPostgres(databaseUrl)

    // Use the production migration runner against a blank database. This is
    // intentionally not a hand-built fixture: the real 0349, 0353-0359,
    // 0370 through 0400
    // migrations, their prerequisites, and their real ledger rows execute.
    const migrationOutput = command(process.execPath, ['scripts/db-migrate.mjs'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGSSLMODE: 'disable',
      },
      timeout: 180_000,
    })
    for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
      assert.ok(
        migrationOutput.includes(`apply ${expected.filename}`),
        `${expected.filename} executed through the real migration runner`,
      )
    }

    pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const applied = await pool.query(
      `SELECT filename, checksum, applied_at IS NOT NULL AS has_applied_at
       FROM public.schema_migrations
       WHERE filename = ANY($1::text[])
       ORDER BY filename`,
      [PRODUCTION_REBIND_SCHEMA_MIGRATIONS.map(({ filename }) => filename)],
    )
    assert.equal(applied.rowCount, PRODUCTION_REBIND_SCHEMA_MIGRATIONS.length)
    assert.ok(applied.rows.every((row) => row.has_applied_at === true))

    const baseline = await inspectProductionRebindHistorySchema(pool)
    // Both source/check and referenced/action FK triggers are now enrolled.
    // These historical mutation probes specifically target the referenced
    // table's action pair; never select a source trigger by array position.
    const gatewayTriggers = baseline.catalog.triggers.filter(t=>GATEWAY_REFERENCE_CONSTRAINTS.get(t.constraint)===t.relation)
    const calendarTriggers = baseline.catalog.triggers.filter(t=>CALENDAR_REFERENCE_CONSTRAINTS.get(t.constraint)===t.relation)
    // This is serial acceptance; do not retain idle catalog-heavy backends in
    // both databases inside the deliberately bounded disposable container.
    await pool.end(); pool = undefined
    await verifyHistoricalCatalogCompatibility(databaseUrl, baseline)
    pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const reviewedEmailTriggers = await verifyReviewedEmailReferenceTriggers(pool, baseline.catalog)
    await verifyReviewedEmailReferenceTriggers(pool, baseline.catalog, CURRENT_CRM_REFERENCE_CONSTRAINTS)
    const initialTriggers=baseline.catalog.triggers.filter(t=>t.name.startsWith('crm_native_initial_'))
    assert.equal(initialTriggers.length,INITIAL_ENROLLMENT_TRIGGERS.length,
      'Every initial-enrollment trigger is directly fingerprinted, including the 0400 Product source fences')
    for(const [table,name,typeMask,fn,deferred=false] of INITIAL_ENROLLMENT_TRIGGERS){
      const installed=initialTriggers.filter(t=>t.name===name&&t.relation===`public.${table}`)
      assert.equal(installed.length,1,`${table}.${name}`)
      assert.equal(installed[0].enabled,'O');assert.equal(installed[0].typeMask,typeMask)
      assert.equal(installed[0].internal,false);assert.equal(installed[0].function,`public.${fn}()`)
      assert.equal(installed[0].deferrable,deferred);assert.equal(installed[0].initiallyDeferred,deferred)
    }
    for(const [table,columns] of INITIAL_SOURCE_UPDATE_COLUMNS){
      const name=table==='crm_products'?'crm_native_initial_demo_product_source_update_fence':'crm_native_initial_source_update_fence'
      const selected=await pool.query(`SELECT ARRAY(SELECT a.attname::text
        FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY chosen(attnum,position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=chosen.attnum ORDER BY chosen.position) AS columns
        FROM pg_catalog.pg_trigger t WHERE t.tgrelid=$1::regclass AND t.tgname=$2`,[`public.${table}`,name])
      assert.deepEqual(selected.rows,[{columns}],`${table} freezes exactly its source snapshot authority keys`)
    }
    for(const [name,relation,typeMask,fn] of [
      ['crm_native_email_user_authority','public.app_users',29,'clawpilot_native_email_authority_row_guard'],
      ['crm_native_email_user_statement','public.app_users',46,'clawpilot_native_email_authority_statement_lock'],
      ['crm_native_email_user_update_statement','public.app_users',18,'clawpilot_native_email_authority_statement_lock'],
      ['crm_native_authority_workspace_snapshot','public.workspace_organizations',19,'clawpilot_native_email_transition_snapshot_guard'],
      ['crm_native_authority_workspace_snapshot_lock','public.workspace_organizations',18,'clawpilot_native_email_transition_lock'],
      ['crm_native_email_workspace_hierarchy_guard','public.workspace_organizations',27,'clawpilot_native_email_transition_snapshot_guard'],
      ['crm_native_email_workspace_hierarchy_statement','public.workspace_organizations',58,'clawpilot_native_email_authority_statement_lock'],
      ['app_users_keep_issued_employee_identity','public.app_users',19,'clawpilot_keep_issued_employee_identity'],
      ['crm_native_identity_metadata_statement','public.app_users',18,'clawpilot_native_email_transition_lock'],
      ['crm_native_identity_metadata_guard','public.app_users',19,'clawpilot_native_email_identity_metadata_guard'],
      ['crm_root_session_guard','public.app_sessions',23,'clawpilot_crm_root_session_guard'],
      ['crm_native_root_membership_source','public.app_user_organization_memberships',31,'clawpilot_crm_native_root_source_guard'],
    ]){
      const installed=baseline.catalog.triggers.filter(t=>t.name===name&&t.relation===relation)
      assert.equal(installed.length,1,name)
      assert.equal(installed[0].enabled,'O');assert.equal(installed[0].typeMask,typeMask)
      assert.equal(installed[0].internal,false);assert.equal(installed[0].function,`public.${fn}()`)
    }
    const functionNames=new Set(baseline.catalog.functions.filter(f=>f.schema==='public').map(f=>f.name))
    for(const f of baseline.catalog.functions)for(const [,called] of f.source.matchAll(/public\.((?:clawpilot_|global_reference_)[a-z_]+)\s*\(/g))
      assert.ok(functionNames.has(called),`Called helper ${called} must have its runtime body fingerprinted`)
    const quarantineHelper=baseline.catalog.functions.filter(fn=>fn.schema==='public'
      &&fn.name==='clawpilot_crm_native_initial_demo_quarantine')
    assert.equal(quarantineHelper.length,1,'0400 enrolls one exact quarantine helper identity')
    assert.equal(quarantineHelper[0].result,'boolean')
    assert.equal(quarantineHelper[0].argumentCount,2)
    assert.equal(quarantineHelper[0].defaultArgumentCount,0)
    assert.equal(quarantineHelper[0].returnsSet,false)
    assert.equal(quarantineHelper[0].strict,false,'NULL source identities must return false, never SQL UNKNOWN')
    assert.equal(quarantineHelper[0].volatility,'s','Quarantine is a stable read-only predicate')
    assert.equal(quarantineHelper[0].securityDefiner,false,'Quarantine never elevates the attesting principal')
    assert.equal(quarantineHelper[0].aclIsDefault,false,'Quarantine helper execution is explicitly restricted')
    assert.ok(!quarantineHelper[0].acl.some(entry=>entry.grantee==='PUBLIC'),
      'PUBLIC must not execute the quarantine predicate')
    assert.deepEqual(baseline.missingRelations, [])
    assert.deepEqual(baseline.missingFunctions, [])
    assert.equal(
      baseline.catalog.relations.length,
      PRODUCTION_REBIND_CRITICAL_RELATIONS.length,
      'every critical relation is fingerprinted',
    )
    for (const relation of PRODUCTION_REBIND_CRITICAL_RELATIONS) {
      assert.ok(
        baseline.catalog.columns.some((column) => column.relation === relation),
        `${relation} columns are fingerprinted`,
      )
    }
    for (const requiredTrigger of [
      'protect_commerce_migration_provider_identity_fence_write',
      'protect_carrier_account_migration_placeholder_write',
      'protect_migrated_carrier_shipper_identity_write',
      'protect_active_migrated_source_authority_integration_write',
      'protect_active_migrated_source_authority_credential_write',
      'enforce_migrated_commerce_provider_identity_write',
      'protect_commerce_workspace_migration_receipt_write',
      'guard_operations_commerce_product_image_import_job_write',
      'validate_integration_credential_key_attestation_insert',
      'reject_integration_credential_key_attestation_update_delete',
      'reject_integration_credential_key_attestation_truncate',
      'guard_hosted_production_sandbox_read_authorization_trigger',
    ]) {
      assert.ok(
        baseline.catalog.triggers.some((trigger) => trigger.name === requiredTrigger),
        `${requiredTrigger} is fingerprinted`,
      )
    }
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name === 'validate_integration_credential_key_attestation_insert',
      ),
      '0356 validation function is fingerprinted',
    )
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name === 'guard_operations_commerce_product_image_import_job',
      ),
      '0357 image-import runtime-parking function is fingerprinted',
    )
    const hostedSandboxAuthorizationGuard = baseline.catalog.functions.find(
      (fn) => fn.name === 'guard_hosted_production_sandbox_read_authorization',
    )
    assert.ok(
      hostedSandboxAuthorizationGuard,
      '0358 hosted sandbox read authorization guard is fingerprinted',
    )
    for (const exactIdentity of [
      'gia9286799',
      '33785418-9927-4e10-a492-d3a44b9b6f21',
      'giah34fedoa5b1o',
      'c8fcf491-cf8c-469a-b03c-0026a762752c',
    ]) {
      assert.ok(
        hostedSandboxAuthorizationGuard.source.includes(exactIdentity),
        `0358 guard pins exact compiled account/organization identity ${exactIdentity}`,
      )
    }
    assert.ok(
      baseline.catalog.functions.some(
        (fn) => fn.name
          === 'operations_commerce_hosted_production_sandbox_read_is_current',
      ),
      '0358 hosted sandbox read capability predicate is fingerprinted',
    )
    const recoveryBudgetColumn = baseline.catalog.columns.find(
      (column) => (
        column.relation === 'public.operations_commerce_fulfillment_exports'
        && column.name === 'automatic_recovery_attempts'
      ),
    )
    assert.equal(recoveryBudgetColumn?.type, 'integer')
    assert.equal(recoveryBudgetColumn?.notNull, true)
    assert.equal(recoveryBudgetColumn?.default, '0')
    const recoveryBudgetConstraint = baseline.catalog.constraints.find(
      (constraint) => (
        constraint.relation === 'public.operations_commerce_fulfillment_exports'
        && constraint.name
          === 'operations_commerce_fulfillment_exports_recovery_budget_valid'
      ),
    )
    assert.ok(
      recoveryBudgetConstraint?.validated === true,
      '0359 recovery-budget check constraint is fingerprinted',
    )
    assert.equal(
      recoveryBudgetConstraint.definition.replace(/[()\s]/gu, ''),
      'CHECKautomatic_recovery_attempts>=0ANDautomatic_recovery_attempts<=attempts',
    )
    const recoveryBudgetIndex = baseline.catalog.indexes.find(
      (index) => (
        index.relation === 'public.operations_commerce_fulfillment_exports'
        && index.name
          === 'operations_commerce_fulfillment_exports_recovery_budget_idx'
      ),
    )
    assert.ok(
      recoveryBudgetIndex?.valid === true && recoveryBudgetIndex?.ready === true,
      '0359 recovery-budget index is fingerprinted and ready',
    )
    assert.equal(
      recoveryBudgetIndex.predicate.replace(/[()\s]/gu, ''),
      "provider=ANYARRAY['shopify'::text,'faire'::text]ANDstate=ANYARRAY['processing'::text,'failed'::text]",
    )

    console.log(`${image} candidate v16 semantic target schema digest ${baseline.schemaDigest} (diagnostic only until full tamper acceptance)`)
    const evidence = await attestProductionRebindHistorySchema(pool)
    assert.equal(evidence.postgresMajor, baseline.postgresMajor)
    assert.equal(evidence.schemaDigest, baseline.schemaDigest)

    const initialFunctionIdentities=[...new Set(INITIAL_ENROLLMENT_TRIGGERS.map(([, , ,fn])=>`public.${fn}()`))]
      .filter(identity=>identity.startsWith('public.clawpilot_crm_native_initial_'))
    for(const identity of [...PRODUCTION_REBIND_CRM_GUARD_HELPERS,...initialFunctionIdentities]){
      const name=identity.slice('public.'.length).split('(')[0]
      const fn=baseline.catalog.functions.find(f=>f.schema==='public'&&f.name===name)
      assert.ok(fn,identity)
      assert.ok(['sql','plpgsql'].includes(fn.language),identity)
      // A raising PL/pgSQL body is valid for scalar and table-returning
      // helpers alike. No helper runs during catalog inspection, so this
      // tests actual body replacement without inventing its return shape.
      const changed=fn.definition.replace(/LANGUAGE sql\b/,'LANGUAGE plpgsql')
        .replace(/(AS \$function\$)[\s\S]*?(\$function\$)/,
          "$1BEGIN RAISE EXCEPTION 'attestation tamper fixture'; END;$2")
      assert.notEqual(changed,fn.definition,'Replace the actual helper body')
      await expectFailure(pool,'schema_catalog_mismatch',`${identity} helper body tamper`,tx=>tx.query(changed))
    }
    for(const [table,name] of INITIAL_ENROLLMENT_TRIGGERS) await expectFailure(pool,'schema_catalog_mismatch',
      `0398 ${table}.${name} disabled`,tx=>tx.query(`ALTER TABLE public.${table} DISABLE TRIGGER ${name}`))
    for(const constraint of baseline.catalog.constraints.filter(c=>c.type==='c'&&(
      ['public.crm_native_email_initial_enrollments','public.crm_native_email_initial_reservations'].includes(c.relation)
      ||c.name==='crm_native_email_initial_exclusive'))){
      await expectFailure(pool,'schema_catalog_mismatch',`0398 missing ${constraint.name}`,tx=>tx.query(
        `ALTER TABLE ${constraint.relation} DROP CONSTRAINT ${constraint.name}`))
    }
    for(const relation of [...INITIAL_ENROLLMENT_RELATIONS,'public.crm_products']) await expectFailure(pool,'schema_catalog_mismatch',
      `Initial enrollment ${relation} PUBLIC read privilege drift`,tx=>tx.query(`GRANT SELECT ON ${relation} TO PUBLIC`))
    for(const identity of ['public.clawpilot_crm_native_initial_source_snapshot()',
      'public.clawpilot_crm_native_initial_shape(jsonb,text[])','public.clawpilot_crm_native_initial_lineage_digest(jsonb)',
      'public.clawpilot_crm_native_initial_replan_context(text,text,text)',INITIAL_DEMO_QUARANTINE_HELPER,...initialFunctionIdentities]){
      await expectFailure(pool,'schema_catalog_mismatch',`0398 ${identity} PUBLIC execution drift`,tx=>tx.query(
        `GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`))
    }
    await expectFailure(pool,'schema_object_missing','0398 missing source snapshot helper',tx=>tx.query(
      'DROP FUNCTION public.clawpilot_crm_native_initial_source_snapshot()'))
    for(const identity of ['public.clawpilot_crm_native_initial_lineage_digest(jsonb)',
      'public.clawpilot_crm_native_initial_replan_context(text,text,text)',INITIAL_DEMO_QUARANTINE_HELPER]) await expectFailure(pool,'schema_object_missing',
      `Forward enrollment missing ${identity}`,tx=>tx.query(`DROP FUNCTION ${identity}`))
    for(const [label,alteration] of [['security definer','SECURITY DEFINER'],
      ['NULL becomes UNKNOWN','STRICT'],['mutable predicate','VOLATILE']]) await expectFailure(pool,'schema_catalog_mismatch',
      `0400 quarantine ${label}`,tx=>tx.query(`ALTER FUNCTION ${INITIAL_DEMO_QUARANTINE_HELPER} ${alteration}`))
    for(const name of ['crm_native_initial_demo_product_source_fence','crm_native_initial_demo_product_source_update_fence']){
      await expectFailure(pool,'schema_catalog_mismatch',`0400 Product missing ${name}`,tx=>tx.query(
        `DROP TRIGGER ${name} ON public.crm_products`))
    }
    await expectFailure(pool,'schema_catalog_mismatch','0400 Product source INSERT/DELETE/TRUNCATE coverage reduced',async tx=>{
      await tx.query('DROP TRIGGER crm_native_initial_demo_product_source_fence ON public.crm_products')
      await tx.query(`CREATE TRIGGER crm_native_initial_demo_product_source_fence BEFORE INSERT OR DELETE ON public.crm_products
        FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()`)
    })
    await expectFailure(pool,'schema_catalog_mismatch','0400 Product source UPDATE authority key coverage reduced',async tx=>{
      await tx.query('DROP TRIGGER crm_native_initial_demo_product_source_update_fence ON public.crm_products')
      await tx.query(`CREATE TRIGGER crm_native_initial_demo_product_source_update_fence BEFORE UPDATE OF id,pipeline_id,suitecrm_id ON public.crm_products
        FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()`)
    })
    for(const relation of ['public.crm_native_email_initial_enrollments','public.crm_native_email_initial_reservations']){
      await expectFailure(pool,'schema_object_missing',`0398 missing retained ledger ${relation}`,tx=>tx.query(`DROP TABLE ${relation} CASCADE`))
    }
    await expectFailure(pool,'schema_catalog_mismatch','0398 source UPDATE authority key coverage reduced',async tx=>{
      await tx.query('DROP TRIGGER crm_native_initial_source_update_fence ON public.app_users')
      await tx.query(`CREATE TRIGGER crm_native_initial_source_update_fence BEFORE UPDATE OF email ON public.app_users
        FOR EACH STATEMENT EXECUTE FUNCTION public.clawpilot_crm_native_initial_source_fence()`)
    })
    await expectFailure(pool,'schema_object_missing','missing unshared-workspace helper',tx=>tx.query(
      'DROP FUNCTION public.clawpilot_native_email_unshared_workspace_is_independent(text,jsonb,jsonb)'))
    await expectFailure(pool,'schema_catalog_mismatch','missing committed native receipt lookup index',tx=>tx.query(
      'DROP INDEX public.crm_native_authority_committed_receipt_lookup'))
    await expectFailure(pool,'schema_catalog_mismatch','missing exact root registry ledger guard',tx=>tx.query(
      'ALTER TABLE public.crm_native_email_authority_root_changes DISABLE TRIGGER crm_native_root_change_guard'))

    for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
      await expectLedgerFailure(pool, expected.filename)
    }
    await expectLedgerFailure(pool, REVIEWED_COMPANY_MIGRATION, true)
    await expectLedgerFailure(pool, INITIAL_ENROLLMENT_MIGRATION, true)
    await expectLedgerFailure(pool, INITIAL_DEMO_QUARANTINE_MIGRATION, true)

    for (const [constraint, expected] of REVIEWED_EMAIL_REFERENCE_CONSTRAINTS) {
      await expectFailure(pool, 'schema_catalog_mismatch', `0374 missing ${constraint}`,
        (client) => client.query(`ALTER TABLE ${expected.relation} DROP CONSTRAINT ${constraint}`))
      for (const [label, actions] of [
        ['DELETE CASCADE', 'ON DELETE CASCADE'],
        ['UPDATE CASCADE', `ON UPDATE CASCADE ON DELETE ${expected.deleteAction === 'n' ? 'SET NULL' : 'NO ACTION'}`],
      ]) {
        await expectFailure(pool, 'schema_catalog_mismatch', `0374 altered ${constraint} ${label}`,
          (client) => client.query(`ALTER TABLE ${expected.relation}
            DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint}
              FOREIGN KEY (${expected.column}) REFERENCES public.app_users(email) ${actions}`))
      }
      await expectFailure(pool, 'schema_catalog_mismatch', `0374 deferred ${constraint} without replacing trigger identities`,
        (client) => client.query(`ALTER TABLE ${expected.relation}
          ALTER CONSTRAINT ${constraint} DEFERRABLE INITIALLY DEFERRED`))
      await expectFailure(pool, 'schema_catalog_mismatch', `0374 renamed ${constraint}`,
        (client) => client.query(`ALTER TABLE ${expected.relation}
          RENAME CONSTRAINT ${constraint} TO unreviewed_email_fkey`))
    }
    for (const trigger of reviewedEmailTriggers) {
      await expectFailure(pool, 'schema_catalog_mismatch', `0374 disabled ${trigger.constraint} action trigger ${trigger.typeMask}`,
        (client) => client.query(`ALTER TABLE public.app_users DISABLE TRIGGER "${trigger.name}"`))
    }
    for (const [constraint, expected] of CURRENT_CRM_REFERENCE_CONSTRAINTS) {
      const targetRelation=expected.targetRelation??'public.app_users',targetColumn=expected.targetColumn??'email'
      await expectFailure(pool,'schema_catalog_mismatch',`CRM missing ${constraint}`,tx=>tx.query(
        `ALTER TABLE ${expected.relation} DROP CONSTRAINT ${constraint}`))
      await expectFailure(pool,'schema_catalog_mismatch',`CRM altered ${constraint} delete action`,tx=>tx.query(
        `ALTER TABLE ${expected.relation} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint}
          FOREIGN KEY (${expected.column}) REFERENCES ${targetRelation}(${targetColumn}) ON DELETE CASCADE`))
      for(const trigger of baseline.catalog.triggers.filter(t=>t.constraint===constraint&&t.relation===targetRelation))
        await expectFailure(pool,'schema_catalog_mismatch',`CRM disabled ${constraint} guard ${trigger.typeMask}`,tx=>tx.query(
          `ALTER TABLE ${targetRelation} DISABLE TRIGGER "${trigger.name}"`))
    }
    for(const relation of PRODUCTION_REBIND_CRITICAL_RELATIONS.filter(name=>
      name.startsWith('public.crm_native_email_')||name.startsWith('public.crm_operator_')
      ||name==='public.crm_root_employee_access_grants'||name==='public.app_sessions')){
      await expectFailure(pool,'schema_catalog_mismatch',`${relation} PUBLIC read privilege drift`,tx=>tx.query(
        `GRANT SELECT ON ${relation} TO PUBLIC`))
    }
    for(const name of ['crm_native_identity_metadata_guard','crm_native_identity_metadata_statement',
      'crm_root_session_guard','crm_native_root_membership_source','crm_employee_grants_guard']){
      const trigger=baseline.catalog.triggers.find(t=>t.name===name)
      assert.ok(trigger,`${name} is included in the complete inventory`)
      await expectFailure(pool,'schema_catalog_mismatch',`${name} disabled`,tx=>tx.query(
        `ALTER TABLE ${trigger.relation} DISABLE TRIGGER "${name}"`))
    }
    const conditional=baseline.catalog.triggers.find(t=>t.name==='crm_root_membership_changed_sessions')
    assert.ok(conditional?.when?.includes('old.')&&conditional.when.includes('new.'),
      'Actual OLD/NEW trigger qualification is rendered and retained completely')
    const alteredCondition=conditional.definition.replace(/ WHEN \([\s\S]*\) EXECUTE FUNCTION /,
      ' WHEN (false) EXECUTE FUNCTION ')
    assert.notEqual(alteredCondition,conditional.definition,'Change only the actual WHEN predicate')
    await expectFailure(pool,'schema_catalog_mismatch','OLD/NEW eligibility predicate replaced',async tx=>{
      await tx.query(`DROP TRIGGER "${conditional.name}" ON ${conditional.relation}`)
      await tx.query(alteredCondition)
    })
    await expectFailure(pool, 'schema_catalog_mismatch', 'unreviewed additional referenced-table FK pair',
      (client) => client.query(`CREATE TABLE public.rebind_unreviewed_fk_fixture (
        owner_email text REFERENCES public.app_users(email)
      )`))

    for (const [constraint] of GATEWAY_REFERENCE_CONSTRAINTS) {
      const referencedGuard = gatewayTriggers.find((trigger) => trigger.constraint === constraint)
      assert.ok(referencedGuard?.constraintRelation)
      await expectFailure(
        pool,
        'schema_catalog_mismatch',
        `0372 referenced-table guard drift: ${constraint}`,
        (client) => client.query(
          `ALTER TABLE ${referencedGuard.constraintRelation} DROP CONSTRAINT ${constraint}`,
        ),
      )
    }
    for (const [constraint] of CALENDAR_REFERENCE_CONSTRAINTS) {
      const referencedGuard = calendarTriggers.find((trigger) => trigger.constraint === constraint)
      assert.ok(referencedGuard?.constraintRelation)
      await expectFailure(
        pool,
        'schema_catalog_mismatch',
        `0373 referenced-table guard drift: ${constraint}`,
        (client) => client.query(
          `ALTER TABLE ${referencedGuard.constraintRelation} DROP CONSTRAINT ${constraint}`,
        ),
      )
    }

    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0353 check constraint drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_workspace_migration_cutover_fences
         DROP CONSTRAINT operations_commerce_workspace_cutover_release_valid,
         ADD CONSTRAINT operations_commerce_workspace_cutover_release_valid
           CHECK (true)`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0354 index drift',
      (client) => client.query(
        `DROP INDEX public.operations_carrier_migration_placeholder_state_idx`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0356 column default drift',
      (client) => client.query(
        `ALTER TABLE public.operations_integration_credential_key_attestations
         ALTER COLUMN singleton_id SET DEFAULT 2`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget column default drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_fulfillment_exports
         ALTER COLUMN automatic_recovery_attempts SET DEFAULT 1`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget check drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_fulfillment_exports
         DROP CONSTRAINT operations_commerce_fulfillment_exports_recovery_budget_valid,
         ADD CONSTRAINT operations_commerce_fulfillment_exports_recovery_budget_valid
           CHECK (automatic_recovery_attempts >= 0)`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0359 recovery-budget index drift',
      (client) => client.query(
        `DROP INDEX public.operations_commerce_fulfillment_exports_recovery_budget_idx`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation row-security drift',
      (client) => client.query(
        `ALTER TABLE public.operations_commerce_migration_provider_identity_fences
         ENABLE ROW LEVEL SECURITY`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation ACL drift',
      (client) => client.query(
        `GRANT SELECT ON public.operations_carrier_account_migration_placeholders
         TO PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'column ACL drift',
      (client) => client.query(
        `GRANT SELECT (key_id)
         ON public.operations_integration_credential_key_attestations TO PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'relation owner drift',
      async (client) => {
        await client.query('CREATE ROLE target_schema_drift_owner NOLOGIN')
        await client.query(
          `ALTER TABLE public.operations_commerce_workspace_migration_cutover_fences
           OWNER TO target_schema_drift_owner`,
        )
      },
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'function ACL drift',
      (client) => client.query(
        `REVOKE EXECUTE
         ON FUNCTION public.protect_commerce_migration_provider_identity_fence()
         FROM PUBLIC`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'function owner drift',
      async (client) => {
        await client.query('CREATE ROLE target_function_drift_owner NOLOGIN')
        await client.query(
          `ALTER FUNCTION public.protect_carrier_account_migration_placeholder()
           OWNER TO target_function_drift_owner`,
        )
      },
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0356 function body drift',
      (client) => client.query(String.raw`
        CREATE OR REPLACE FUNCTION
          public.reject_integration_credential_key_attestation_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NULL;
        END;
        $$
      `),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      '0357 function body drift',
      (client) => client.query(String.raw`
        CREATE OR REPLACE FUNCTION
          public.guard_operations_commerce_product_image_import_job()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'disabled 0354 trigger',
      (client) => client.query(
        `ALTER TABLE public.operations_carrier_accounts
         DISABLE TRIGGER protect_migrated_carrier_shipper_identity_write`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'altered 0356 trigger event mask',
      (client) => client.query(
        `DROP TRIGGER reject_integration_credential_key_attestation_update_delete
           ON public.operations_integration_credential_key_attestations;
         CREATE TRIGGER reject_integration_credential_key_attestation_update_delete
         BEFORE UPDATE ON public.operations_integration_credential_key_attestations
         FOR EACH ROW EXECUTE FUNCTION
           public.reject_integration_credential_key_attestation_mutation()`,
      ),
    )
    await expectFailure(
      pool,
      'schema_catalog_mismatch',
      'public schema ACL drift',
      (client) => client.query('GRANT CREATE ON SCHEMA public TO PUBLIC'),
    )
    await expectFailure(
      pool,
      'schema_object_missing',
      'missing 0356 safety relation',
      (client) => client.query(
        `DROP TABLE public.operations_integration_credential_key_attestations CASCADE`,
      ),
    )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `LOCK TABLE ${PRODUCTION_REBIND_CRITICAL_RELATIONS.join(', ')}
         IN ACCESS SHARE MODE`,
      )
      await attestProductionRebindHistorySchema(client)
      await client.query(
        `ALTER TABLE public.operations_commerce_migration_provider_identity_fences
         DISABLE TRIGGER protect_commerce_migration_provider_identity_fence_write`,
      )
      await assert.rejects(
        attestProductionRebindHistorySchema(client),
        (error) => (
          error instanceof ProductionRebindHistorySchemaAttestationError
          && error.code === 'schema_catalog_mismatch'
        ),
        'caller-owned transaction can re-attest after taking DDL-protection locks',
      )
      await client.query('ROLLBACK')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    await attestProductionRebindHistorySchema(pool)
    console.log(`${image}: ${checkedTamperCases} catalog/ledger tamper refusals passed; final transaction-lock check passed`)
  } catch (error) {
    try {console.error('Disposable fixture state:', command('docker', ['inspect','--format','{{json .State}}',container]).trim())}
    catch {/* Preserve the original test error if Docker is unavailable. */}
    throw error
  } finally {
    if (pool) await pool.end().catch(() => undefined)
    command('docker', disposablePostgresDockerCleanupArgs(container), { stdio: 'ignore' })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const image of images) await exerciseImage(image)
  console.log(`production rebind target schema attestation passed (${images.join(', ')})`)
}
