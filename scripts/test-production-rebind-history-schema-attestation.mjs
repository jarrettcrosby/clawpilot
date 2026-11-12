#!/usr/bin/env node

import {
  disposablePostgresDockerArgs,
  disposablePostgresDockerCleanupArgs,
} from './lib/disposable-postgres-docker.mjs'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
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
  PRODUCTION_REBIND_RECOVERY_RELATIONS,
  PRODUCTION_REBIND_RECOVERY_GUARD_HELPERS,
  PRE_INITIAL_ENROLLMENT_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_INITIAL_REPLAN_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_INITIAL_DEMO_QUARANTINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_ROOT_OWNER_SOURCE_FENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_UNMANAGED_PIPELINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_LEGACY_RECOVERY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_CALENDAR_OCCURRENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  PRE_HELD_ORIGINAL_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,
  ProductionRebindHistorySchemaAttestationError,
  attestProductionRebindHistorySchema,
  inspectProductionRebindHistorySchema,
  inspectPreCrmProductionRebindSchemaMetadata,
  inspectPreInitialEnrollmentProductionRebindSchemaMetadata,
  inspectPreInitialReplanProductionRebindSchemaMetadata,
  inspectPreInitialDemoQuarantineProductionRebindSchemaMetadata,
  inspectPreRootOwnerSourceFenceProductionRebindSchemaMetadata,
  inspectPreUnmanagedPipelineProductionRebindSchemaMetadata,
  inspectPreLegacyRecoveryProductionRebindSchemaMetadata,
  inspectPreCalendarOccurrenceProductionRebindSchemaMetadata,
  inspectPreFractionalProductCompatibilityProductionRebindSchemaMetadata,
  inspectPreHeldOriginalProductionRebindSchemaMetadata,
  canonicalProductionRebindHistorySchemaCatalog,
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
const ROOT_OWNER_SOURCE_FENCE_MIGRATION = '0401_crm_native_root_owner_source_fence.sql'
const ROOT_OWNER_SOURCE_FENCE_HELPER = 'public.clawpilot_crm_root_native_membership_is_independent(jsonb,jsonb)'
const UNMANAGED_PIPELINE_MIGRATION = '0402_crm_native_unmanaged_app_only_pipelines.sql'
const FRACTIONAL_PRODUCT_MIGRATION = '0373_fractional_crm_product_read.sql'
const FRACTIONAL_PRODUCT_MIGRATION_CHECKSUM = '0e01f96a2862c22e785cd16a49a5079d0e9492f7503e155941b45e111b64a764'
const FRACTIONAL_FOLDER_MIGRATION = '0403_fractional_crm_customer_folder_capability.sql'
const FROZEN_FOLDER_MIGRATION = 'scripts/fixtures/0403_fractional_crm_customer_folder_capability.v20.sql'
const FROZEN_FOLDER_MIGRATION_CHECKSUM = '3fa6f3c6db912a91e44a3a4b4ce3cb5226650a0f11227ab9e4bd985a5c05414f'
const FROZEN_V20_DIGEST_BY_MAJOR = Object.freeze({
  16: '7a302187e1c5082cb8bcb33dee6717667b8f26ee3a28a715f7ffb7cd04660ad6',
  18: '8dff7fb7b1e42d8878a3920838cb03851049426b0b1d54f1cf20a76e3ed03cca',
})
const GATEWAY_CREDENTIALS = 'public.fractional_crm_gateway_credentials'
const GATEWAY_CAPABILITY_CONSTRAINT = 'fractional_crm_gateway_credentials_capabilities_check'
const GATEWAY_BASE_CAPABILITIES = ['crm.company.read','crm.contact.read','crm.company.write','crm.contact.write','crm.onboarding.write']
const GATEWAY_CURRENT_CAPABILITIES = [...GATEWAY_BASE_CAPABILITIES,'crm.product.read','crm.customer-folder.write']
const LEGACY_RECOVERY_MIGRATION = '0411_crm_legacy_email_archive_disposition.sql'
const CALENDAR_OCCURRENCE_MIGRATION = '0412_crm_calendar_occurrence_claims.sql'
const HELD_ORIGINAL_MIGRATIONS = [
  ['0413_crm_legacy_email_terminal_hold.sql','4e2db01decaefc67669bf3f84b9ba9d9174c5a746df4343c26b846318db514d0'],
  ['0414_crm_legacy_email_hold_enrollment.sql','acb9b5dc2eb51925a41763db3e5be85fd51432df96a9d0d2dadb3f2c54d3a058'],
  ['0415_crm_legacy_held_email_recovery_stage.sql','91f9f6a5d1e6f620484209093df42644a5d80fd6faa199fa443a60a9383e7813'],
  ['0416_crm_legacy_held_email_release.sql','d9d5d612b9d1e5fa32aff71bfe35c6c9904ce8979b4893aef479dfb8add02e30'],
  ['0417_crm_legacy_held_email_settlement.sql','56f7e0e67ef8854b610d02a2d8496c575d4217b2731b49aa4f04c39b69bc82bf'],
].map(([filename,checksum])=>({filename,checksum}))
const CRM_MAINTENANCE_MIGRATION = '0418_crm_maintenance_write_fence.sql'
const CRM_MAINTENANCE_SCHEMA = 'clawpilot_crm_maintenance'
const CRM_MAINTENANCE_CHECKSUM = 'c08fde2f92b93f6920f9649d6cee280f17a09f7e01fe4920711558503a9e2829'
const HELD_ORIGINAL_SCHEMA = 'crm_legacy_email_terminal_hold'
const HELD_ORIGINAL_RELATIONS = ['verified_batch','held','consumed','verified_recovery','staged','released','verified_receipts','settled']
  .map(name=>`${HELD_ORIGINAL_SCHEMA}.${name}`)
const HELD_ORIGINAL_CONTACT_MERGE_RELATION = 'public.crm_contact_merge_outbox_dependencies'
const HELD_ORIGINAL_FUNCTIONS = [
  ...['bind_attestor()','gate_fingerprint()','relationship_fingerprint(uuid)','provider_identity_fingerprint(uuid)',
    'receipt_fingerprint(uuid)','hold(uuid,uuid[],text)','resolve(uuid,text,text)','protect_held()',
    'stage_update_allowed(jsonb,jsonb)','resolve_recovery(uuid,text,text)','stage_recovery(uuid,text,jsonb)',
    'wire_json(jsonb,integer)','register_release(uuid,text)','initial_release_write_allowed(text,text,jsonb,jsonb)',
    'check_release_binding()','resolve_unsettled_release(uuid,text,text,text)','bind_receipt_attestor()',
    'resolution_lease_write_allowed(jsonb,jsonb)','claim_resolution(uuid,text,uuid)','settlement_write_allowed(text,jsonb,jsonb)',
    'settle_release(uuid,text,uuid,bigint,jsonb)','resolve_release(uuid,text,text,text)'].map(signature=>`${HELD_ORIGINAL_SCHEMA}.${signature}`),
  'public.clawpilot_crm_native_initial_pending_quarantine(uuid,text,uuid,uuid,text,bigint)',
]
const HELD_ORIGINAL_CHANGED_FUNCTION_NAMES = [
  'clawpilot_crm_native_initial_reserve','clawpilot_crm_native_initial_admit',
  'clawpilot_crm_legacy_email_provider_identity_unambiguous','clawpilot_crm_legacy_email_relationship_guard',
  'release_crm_contact_merge_outbox_dependents','clawpilot_guard_shared_email_write',
]
const HELD_ORIGINAL_GUARDS = [
  ...['verified_batch','held','consumed'].flatMap(table=>[
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_terminal_hold_immutable',27,'crm_legacy_email_retirement.immutable_evidence()'],
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_terminal_hold_no_truncate',34,'crm_legacy_email_retirement.immutable_evidence()'],
  ]),
  ...['verified_recovery','staged','released'].flatMap(table=>[
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_held_recovery_'+(table==='released'?'release_':'')+'immutable',27,'crm_legacy_email_retirement.immutable_evidence()'],
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_held_recovery_'+(table==='released'?'release_':'')+'no_truncate',34,'crm_legacy_email_retirement.immutable_evidence()'],
  ]),
  ...['verified_receipts','settled'].flatMap(table=>[
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_held_receipt_immutable',27,'crm_legacy_email_retirement.immutable_evidence()'],
    [`${HELD_ORIGINAL_SCHEMA}.${table}`,'crm_held_receipt_no_truncate',34,'crm_legacy_email_retirement.immutable_evidence()'],
  ]),
  [`${HELD_ORIGINAL_SCHEMA}.verified_batch`,'crm_terminal_hold_attestor',7,`${HELD_ORIGINAL_SCHEMA}.bind_attestor()`],
  [`${HELD_ORIGINAL_SCHEMA}.verified_recovery`,'crm_held_recovery_direct_attestor',7,`${HELD_ORIGINAL_SCHEMA}.bind_attestor()`],
  [`${HELD_ORIGINAL_SCHEMA}.verified_receipts`,'crm_held_receipt_attestor',7,`${HELD_ORIGINAL_SCHEMA}.bind_receipt_attestor()`],
  [`${HELD_ORIGINAL_SCHEMA}.released`,'crm_held_recovery_release_binding',5,`${HELD_ORIGINAL_SCHEMA}.check_release_binding()`,true],
  ...['sync_outbox','crm_interactions','crm_native_email_publication_admissions','crm_native_email_publication_work',
    'crm_interaction_contacts','crm_interaction_organizations'].flatMap(table=>[
    [`public.${table}`,'crm_terminal_email_held',31,`${HELD_ORIGINAL_SCHEMA}.protect_held()`],
    [`public.${table}`,'crm_zzzz_terminal_email_held_no_truncate',34,`${HELD_ORIGINAL_SCHEMA}.protect_held()`],
    ...(['crm_interaction_contacts','crm_interaction_organizations'].includes(table)
      ?[[`public.${table}`,'crm_zz_legacy_email_terminal_hold_serial',62,'crm_legacy_email_retirement.serialize()']]:[]),
  ]),
]
const CALENDAR_OCCURRENCE_CLAIMS = 'public.crm_calendar_occurrence_claims'
const CALENDAR_OCCURRENCE_BINDINGS = 'public.crm_calendar_occurrence_bindings'
const CALENDAR_OCCURRENCE_RELATIONS = [CALENDAR_OCCURRENCE_BINDINGS,CALENDAR_OCCURRENCE_CLAIMS]
const CALENDAR_OCCURRENCE_AUTHORITY_RELATIONS = [
  'public.crm_calendar_discovery_events','public.crm_calendar_discovery_sources',
]
const CALENDAR_OCCURRENCE_REQUIRED_TRIGGER = 'crm_calendar_discovery_occurrence_required'
const CALENDAR_OCCURRENCE_KEEP = 'public.clawpilot_crm_keep_calendar_occurrence()'
const CALENDAR_OCCURRENCE_REQUIRE = 'public.clawpilot_crm_require_calendar_occurrence()'
const CALENDAR_OCCURRENCE_FUNCTIONS = [CALENDAR_OCCURRENCE_KEEP,CALENDAR_OCCURRENCE_REQUIRE]
const CALENDAR_OCCURRENCE_GUARDS = [
  [CALENDAR_OCCURRENCE_BINDINGS,'crm_calendar_occurrence_binding_immutable',27,CALENDAR_OCCURRENCE_KEEP],
  [CALENDAR_OCCURRENCE_BINDINGS,'crm_calendar_occurrence_binding_no_truncate',34,CALENDAR_OCCURRENCE_KEEP],
  [CALENDAR_OCCURRENCE_CLAIMS,'crm_calendar_occurrence_claim_immutable',27,CALENDAR_OCCURRENCE_KEEP],
  [CALENDAR_OCCURRENCE_CLAIMS,'crm_calendar_occurrence_claim_no_truncate',34,CALENDAR_OCCURRENCE_KEEP],
  ['public.crm_meetings',CALENDAR_OCCURRENCE_REQUIRED_TRIGGER,5,CALENDAR_OCCURRENCE_REQUIRE],
]
const CALENDAR_OCCURRENCE_FKS = [
  [CALENDAR_OCCURRENCE_CLAIMS,'crm_calendar_occurrence_claim_meeting_fkey','public.crm_meetings',['pipeline_id','meeting_id'],['pipeline_id','id']],
  [CALENDAR_OCCURRENCE_BINDINGS,'crm_calendar_occurrence_binding_claim_fkey',CALENDAR_OCCURRENCE_CLAIMS,['pipeline_id','occurrence_key','meeting_id'],['pipeline_id','occurrence_key','meeting_id']],
]
const UNMANAGED_PIPELINE_CLASSIFIER = 'public.clawpilot_native_email_app_only_change_is_independent(text,jsonb,jsonb)'
const UNMANAGED_PIPELINE_HELPERS = new Map([
  ['public.clawpilot_crm_native_json_has_pipeline(jsonb,uuid)',{language:'sql',volatility:'i',result:'boolean',arguments:2}],
  ['public.clawpilot_crm_native_outbox_pipeline(text,text)',{language:'plpgsql',volatility:'s',result:'uuid',arguments:2}],
  ['public.clawpilot_crm_native_outbox_is_non_email(text,text,text,jsonb)',{language:'sql',volatility:'s',result:'boolean',arguments:4}],
  ['public.clawpilot_crm_native_outbox_is_foreign_terminal_delete(public.sync_outbox,uuid)',{language:'plpgsql',volatility:'s',result:'boolean',arguments:2}],
  ['public.clawpilot_crm_native_unmanaged_pipeline_footprint(uuid)',{language:'plpgsql',volatility:'v',result:'boolean',arguments:1}],
  ['public.clawpilot_crm_native_unmanaged_pipeline_retained(uuid)',{language:'plpgsql',volatility:'v',result:'boolean',arguments:1}],
  ['public.clawpilot_crm_native_unmanaged_app_change(text,jsonb,jsonb)',{language:'plpgsql',volatility:'v',result:'boolean',arguments:3}],
])
const UNMANAGED_PIPELINE_RELATIONS = [
  'crm_campaign_recipients','crm_campaigns','crm_inbound_message_links','crm_inbound_messages',
  'crm_integration_action_attempts','crm_integration_actions','crm_interaction_contacts','crm_leads',
  'crm_meetings','crm_opportunities','workspace_tenant_retirement_receipts',
].map(name=>`public.${name}`)
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
  'clawpilot-production-rebind-target-schema-attestation-v22')
assert.deepEqual(PRODUCTION_REBIND_SCHEMA_MIGRATIONS.filter(m=>m.filename===FRACTIONAL_PRODUCT_MIGRATION),
  [{filename:FRACTIONAL_PRODUCT_MIGRATION,checksum:FRACTIONAL_PRODUCT_MIGRATION_CHECKSUM}],
  'Current acceptance preserves exactly the already applied historical product grant migration')
const [currentFolderMigration] = PRODUCTION_REBIND_SCHEMA_MIGRATIONS.filter(m=>m.filename===FRACTIONAL_FOLDER_MIGRATION)
assert.equal(PRODUCTION_REBIND_SCHEMA_MIGRATIONS.filter(m=>m.filename===FRACTIONAL_FOLDER_MIGRATION).length,1)
assert.notEqual(currentFolderMigration.checksum,FROZEN_FOLDER_MIGRATION_CHECKSUM,
  'Do not mistake the superseded pending folder constraint for current acceptance')
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
assert.deepEqual(PRE_ROOT_OWNER_SOURCE_FENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'f2ffa6e838f37c018c922b5e05dfeb565f2093e898d529efa35b23fdf46cbceb',
  18:'89fce50872243d7848b233209e140cc03c67b21fc9c3aa16d8e2ea86819abc1c',
},'Owner source fencing must never retcon the independently accepted historical v16 fingerprints')
assert.deepEqual(PRE_UNMANAGED_PIPELINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'2b4e6f7ac81be403b31210026a04f4a98fd902c66198732c471f9cf267e6d441',
  18:'c62a2bb05b8f9e502163a649492c0f292c30eeb2fe05d94c60d2a6e2631fc349',
},'Historical through-0401 v17 fingerprints remain independently frozen')
assert.deepEqual(PRE_LEGACY_RECOVERY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'87612f0c87538fceb059b571b15f981f765bca69fb3bb13844be0193f6f78e3f',
  18:'8fe6418063cccbf842a777841e9876943b25f8c800aadfa64e7b1e5d9d623bcb',
},'Historical through-0402 v18 fingerprints remain independently frozen')
assert.deepEqual(PRE_CALENDAR_OCCURRENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'1f65875ffecdbb7204d00daaaa9d3dc3864f25bdd3760b86195f7f5eed224fef',
  18:'283d8d6f0728bde8c19b73975ae71c2f2d08c41360195ee88d89a94f58cce1a4',
},'Historical through-0411 v19 fingerprints remain independently frozen')
assert.deepEqual(PRE_HELD_ORIGINAL_SCHEMA_DIGEST_BY_POSTGRES_MAJOR,{
  16:'deb3985e8215284d5de69a2b5966a3740e452070a9b1ebe14fac46370718b2fc',
  18:'7006803ee42ade78f36c565b60549f8c2aeb118ca5d33484a6bf17e0f6f0d65a',
},'Historical through-0412 v21 fingerprints remain independently frozen')
assert.deepEqual(PRODUCTION_REBIND_SCHEMA_MIGRATIONS.slice(-HELD_ORIGINAL_MIGRATIONS.length),HELD_ORIGINAL_MIGRATIONS,
  'Current acceptance requires all five exact held-original migrations, never a historical floor')
for(const helper of UNMANAGED_PIPELINE_HELPERS.keys())assert.ok(PRODUCTION_REBIND_CRM_GUARD_HELPERS.includes(helper),helper)
for(const relation of UNMANAGED_PIPELINE_RELATIONS)assert.ok(PRODUCTION_REBIND_CRITICAL_RELATIONS.includes(relation),relation)
for(const helper of ['public.clawpilot_crm_native_initial_lineage_digest(jsonb)',
  'public.clawpilot_crm_native_initial_replan_context(text,text,text)',INITIAL_DEMO_QUARANTINE_HELPER,
  ROOT_OWNER_SOURCE_FENCE_HELPER]) assert.ok(PRODUCTION_REBIND_CRM_GUARD_HELPERS.includes(helper),helper)
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
assert.equal(PRODUCTION_REBIND_RECOVERY_RELATIONS.length,12,'Retain the exact reviewed v19 recovery/folder relations')
assert.equal(PRODUCTION_REBIND_RECOVERY_GUARD_HELPERS.length,33,'Retain all exact v19 recovery helper identities')
assert.equal(new Set(PRODUCTION_REBIND_CRM_GUARD_HELPERS).size,PRODUCTION_REBIND_CRM_GUARD_HELPERS.length,
  'Helper identities are unique; duplicates cannot masquerade as complete enrollment')

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
  [inspectPreRootOwnerSourceFenceProductionRebindSchemaMetadata,INITIAL_DEMO_QUARANTINE_MIGRATION],
  [inspectPreUnmanagedPipelineProductionRebindSchemaMetadata,ROOT_OWNER_SOURCE_FENCE_MIGRATION],
  [inspectPreLegacyRecoveryProductionRebindSchemaMetadata,UNMANAGED_PIPELINE_MIGRATION],
  [inspectPreCalendarOccurrenceProductionRebindSchemaMetadata,LEGACY_RECOVERY_MIGRATION],
  [inspectPreFractionalProductCompatibilityProductionRebindSchemaMetadata,CALENDAR_OCCURRENCE_MIGRATION],
  [inspectPreHeldOriginalProductionRebindSchemaMetadata,CALENDAR_OCCURRENCE_MIGRATION],
  [inspectProductionRebindHistorySchema,HELD_ORIGINAL_MIGRATIONS.at(-1).filename],
]){
  let selectedMigrations,selectedRelations,selectedFunctions,selectedSchemas
  await inspect({query:async (_sql,values)=>{
    selectedRelations=values[0]
    selectedFunctions=values[1]
    selectedMigrations=values[2]
    selectedSchemas=values[4]
    return {rowCount:1,rows:[{server_version_num:160000,schema:{},relations:[],columns:[],constraints:[],
      additional_schemas:[],indexes:[],triggers:[],functions:[],migrations:[],missing_relations:[],missing_functions:[]}]}
  }})
  assert.equal(selectedMigrations.at(-1),lastMigration,`${inspect.name} retains its exact ledger floor`)
  const isCurrent=inspect===inspectProductionRebindHistorySchema
  assert.equal(selectedMigrations.includes(FRACTIONAL_PRODUCT_MIGRATION),isCurrent||inspect===inspectPreHeldOriginalProductionRebindSchemaMetadata,
    'The product compatibility ledger belongs to frozen v21 and its current successor only')
  const floor=Number(lastMigration.slice(0,4))
  assert.equal(selectedMigrations.includes(INITIAL_ENROLLMENT_MIGRATION),floor>=398,
    'Every exact metadata reader retains its accepted 0398 ledger floor')
  assert.equal(selectedMigrations.includes(INITIAL_REPLAN_MIGRATION),floor>=399,
    'Every exact metadata reader retains its accepted 0399 ledger floor')
  for(const currentOnly of [selectedMigrations.includes(INITIAL_DEMO_QUARANTINE_MIGRATION),
    selectedRelations.includes('public.crm_products'),selectedFunctions.includes(INITIAL_DEMO_QUARANTINE_HELPER)]){
    assert.equal(currentOnly,floor>=400,
      'Only current and exact v16 metadata enroll the complete 0400 migration, helper and direct Product source catalog')
  }
  assert.equal(selectedMigrations.includes(ROOT_OWNER_SOURCE_FENCE_MIGRATION),floor>=401,
    'Current v17 and its exact metadata reader require 0401; older readers preserve their accepted ledger floor')
  assert.equal(selectedMigrations.includes(UNMANAGED_PIPELINE_MIGRATION),floor>=402,
    'Only current and frozen v18 metadata require 0402; historical metadata cannot become a fallback')
  for(const helper of UNMANAGED_PIPELINE_HELPERS.keys())assert.equal(selectedFunctions.includes(helper),floor>=402,
    `Only current and exact v18 metadata enroll ${helper}`)
  for(const relation of UNMANAGED_PIPELINE_RELATIONS)assert.equal(selectedRelations.includes(relation),floor>=402,
    `Only current and exact v18 metadata directly fingerprint ${relation}`)
  for(const helper of PRODUCTION_REBIND_RECOVERY_GUARD_HELPERS)assert.equal(selectedFunctions.includes(helper),
    floor>=411,`Only v19+ profiles enroll ${helper}`)
  for(const relation of PRODUCTION_REBIND_RECOVERY_RELATIONS)assert.equal(selectedRelations.includes(relation),
    floor>=411,`Only v19+ profiles directly fingerprint ${relation}`)
  for(const helper of CALENDAR_OCCURRENCE_FUNCTIONS)assert.equal(selectedFunctions.includes(helper),
    floor>=412,`Only v20+ profiles enroll ${helper}`)
  for(const relation of [...CALENDAR_OCCURRENCE_RELATIONS,...CALENDAR_OCCURRENCE_AUTHORITY_RELATIONS])
    assert.equal(selectedRelations.includes(relation),floor>=412,`Only v20+ profiles directly fingerprint ${relation}`)
  for(const {filename} of HELD_ORIGINAL_MIGRATIONS) assert.equal(selectedMigrations.includes(filename),isCurrent,filename)
  for(const relation of HELD_ORIGINAL_RELATIONS) assert.equal(selectedRelations.includes(relation),isCurrent,relation)
  assert.equal(selectedRelations.includes(HELD_ORIGINAL_CONTACT_MERGE_RELATION),isCurrent,
    'Only v22 enrolls the existing contact-merge dependency relation')
  for(const identity of HELD_ORIGINAL_FUNCTIONS) assert.equal(selectedFunctions.includes(identity),isCurrent,identity)
  assert.deepEqual([...selectedSchemas].sort(),[...(floor>=411?['crm_legacy_email_retirement']:[]),...(isCurrent?[HELD_ORIGINAL_SCHEMA]:[])].sort(),
    'Private schema ownership/ACLs remain exact evidence and never alter older frozen metadata shapes')
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

function frozenFolderSql() {
  const sql=readFileSync(resolve(root,FROZEN_FOLDER_MIGRATION),'utf8')
  assert.equal(createHash('sha256').update(sql).digest('hex'),FROZEN_FOLDER_MIGRATION_CHECKSUM,
    'Historical v19/v20 must apply the exact originally reviewed 0403 bytes')
  return sql
}

async function applyFixtureMigrationRange(pool,{after='',through,bootstrap=false,frozen=true}) {
  const client=await pool.connect()
  try {
    if(bootstrap){
      const runner=readFileSync(resolve(root,'scripts/db-migrate.mjs'),'utf8')
      const bootstrapSql=runner.match(/CREATE TABLE IF NOT EXISTS schema_migrations \(\s+filename text PRIMARY KEY,\s+checksum text,\s+applied_at timestamptz NOT NULL DEFAULT now\(\)\s+\)/)?.[0]
      assert.ok(bootstrapSql,'Review changed production ledger bootstrap before historical comparison')
      await client.query(bootstrapSql)
    }
    const files=readdirSync(resolve(root,'db/migrations'))
      .filter(file=>/^\d+_.+\.sql$/u.test(file)&&file>after&&file<=through).sort()
      .filter(file=>!frozen||file!==FRACTIONAL_PRODUCT_MIGRATION)
    assert.equal(files.at(-1),through,'Fixture migration range must end at its exact requested ledger floor')
    for(const file of files){
      const sql=frozen&&file===FRACTIONAL_FOLDER_MIGRATION?frozenFolderSql()
        :readFileSync(resolve(root,'db/migrations',file),'utf8')
      await applyMigrationSqlForTest(client,file,sql,{checksum:createHash('sha256').update(sql).digest('hex')})
    }
  }finally{client.release()}
}

function verifyCalendarOccurrenceDefinitions(catalog) {
  const migrationSql=readFileSync(resolve(root,'db/migrations',CALENDAR_OCCURRENCE_MIGRATION),'utf8')
  for(const identity of CALENDAR_OCCURRENCE_FUNCTIONS){
    const name=identity.slice('public.'.length,-2)
    const matches=catalog.functions.filter(fn=>fn.schema==='public'&&fn.name===name&&fn.identityArguments==='')
    assert.equal(matches.length,1,`0412 installs ${identity} exactly once`)
    const fn=matches[0]
    assert.equal(fn.result,'trigger',identity)
    assert.equal(fn.language,'plpgsql',identity)
    assert.equal(fn.securityDefiner,true,identity)
    assert.equal(fn.aclIsDefault,false,identity)
    assert.ok(!fn.acl.some(acl=>acl.grantee==='PUBLIC'),identity)
    assert.equal(fn.configuration.length,1,identity)
    assert.match(fn.configuration[0],/^search_path=pg_catalog,\s*public$/u,identity)
    const source=migrationSql.match(new RegExp('CREATE FUNCTION public\\.'+name+'\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;'))?.[1]
    assert.ok(source,`${identity} source is present in exact 0412`)
    assert.equal(fn.source,source,`${identity} executes the exact 0412 migration body`)
  }
  const newGuards=catalog.triggers.filter(t=>!t.internal&&(CALENDAR_OCCURRENCE_RELATIONS.includes(t.relation)
    || t.relation==='public.crm_meetings'&&t.name===CALENDAR_OCCURRENCE_REQUIRED_TRIGGER))
  assert.equal(newGuards.length,CALENDAR_OCCURRENCE_GUARDS.length,'0412 enrolls exactly five user-defined occurrence guards')
  for(const [relation,name,typeMask,fn] of CALENDAR_OCCURRENCE_GUARDS){
    const matches=newGuards.filter(t=>t.relation===relation&&t.name===name)
    assert.equal(matches.length,1,`0412 installs exact guard ${relation}.${name}`)
    const t=matches[0]
    const deferred=name===CALENDAR_OCCURRENCE_REQUIRED_TRIGGER
    assert.equal(t.enabled,'O',name)
    assert.equal(t.typeMask,typeMask,name)
    assert.equal(t.function,fn,name)
    assert.equal(t.deferrable,deferred,name)
    assert.equal(t.initiallyDeferred,deferred,name)
    assert.equal(t.constraint,deferred?name:null,name)
    if(deferred){
      assert.ok(t.when?.includes('calendar-discovery:%')&&t.when.includes('google_calendar_discovery'),
        'Deferred guard must cover either discovery source marker')
      const constraint=catalog.constraints.filter(c=>c.relation===relation&&c.name===name)
      assert.equal(constraint.length,1,'Deferred guard owns one exact constraint descriptor')
      assert.ok(constraint[0].type==='t'&&constraint[0].deferrable&&constraint[0].deferred)
    }else assert.equal(t.when,null,name)
  }
  for(const [source,name,target,sourceColumns,targetColumns] of CALENDAR_OCCURRENCE_FKS){
    const constraint=catalog.constraints.filter(c=>c.relation===source&&c.name===name)
    assert.equal(constraint.length,1,name)
    assert.ok(constraint[0].type==='f'&&constraint[0].validated&&constraint[0].referencedRelation===target,name)
    const triggers=catalog.triggers.filter(t=>t.internal&&t.foreignKey?.schema==='public'&&t.foreignKey.name===name)
    assert.equal(triggers.length,4,`${name} has exact source and action pairs`)
    assert.deepEqual(triggers.filter(t=>t.relation===source).map(t=>t.typeMask).sort((a,b)=>a-b),[5,17],name)
    assert.deepEqual(triggers.filter(t=>t.relation===target).map(t=>t.typeMask).sort((a,b)=>a-b),[9,17],name)
    for(const t of triggers){
      assert.equal(t.enabled,'O',name)
      assert.equal(t.foreignKey.source,source.slice('public.'.length),name)
      assert.equal(t.foreignKey.target,target.slice('public.'.length),name)
      assert.equal(t.foreignKey.deleteAction,'c',name)
      assert.equal(t.foreignKey.updateAction,'a',name)
      assert.equal(t.foreignKey.validated,true,name)
      assert.equal(t.foreignKey.enforced,true,name)
      assert.equal(t.foreignKey.deferrable,false,name)
      assert.deepEqual(t.foreignKey.columns.filter(c=>c.side==='source').map(c=>c.name),sourceColumns,name)
      assert.deepEqual(t.foreignKey.columns.filter(c=>c.side==='target').map(c=>c.name),targetColumns,name)
    }
  }
  assert.deepEqual(catalog.constraints.filter(c=>CALENDAR_OCCURRENCE_RELATIONS.includes(c.relation)&&['p','u'].includes(c.type))
    .map(c=>[c.relation,c.definition]),[
    [CALENDAR_OCCURRENCE_BINDINGS,'PRIMARY KEY (pipeline_id, calendar_id, external_event_id)'],
    [CALENDAR_OCCURRENCE_CLAIMS,'UNIQUE (pipeline_id, occurrence_key, meeting_id)'],
    [CALENDAR_OCCURRENCE_CLAIMS,'PRIMARY KEY (pipeline_id, occurrence_key)'],
  ],'0412 uniqueness pins the occurrence claim and the precise calendar binding')
}

function gatewayCapabilityConstraint(catalog) {
  const matches=catalog.constraints.filter(c=>c.relation===GATEWAY_CREDENTIALS&&c.name===GATEWAY_CAPABILITY_CONSTRAINT)
  assert.equal(matches.length,1,'Exactly one gateway capability constraint is attested')
  return matches[0]
}

function assertGatewayCapabilityVocabulary(constraint,expected) {
  assert.equal(constraint.validated,true,'Capability CHECK must validate existing rows')
  const actual=[...constraint.definition.matchAll(/'(crm\.[a-z.\-]+)'::text/gu)].map(match=>match[1]).sort()
  assert.deepEqual(actual,[...expected].sort(),'Exact current capabilities only; no dropped read grant or expanded write access')
}

async function forgeCurrentLedgerInDisposableTransaction(client) {
  const observed=await inspectProductionRebindHistorySchema(client)
  for(const {filename,checksum} of observed.migrations.filter(m=>m.rows!==1||m.matchingRows!==1)){
    await client.query(`INSERT INTO public.schema_migrations(filename,checksum) VALUES($1,$2)
      ON CONFLICT(filename) DO UPDATE SET checksum=EXCLUDED.checksum`,[filename,checksum])
  }
}

async function verifyCalendarOccurrenceSchemaDelta(pool,frozenV21Baseline) {
  const frozen=await inspectPreCalendarOccurrenceProductionRebindSchemaMetadata(pool)
  assert.equal(frozen.format,'clawpilot-production-rebind-v19-metadata-only')
  assert.equal(frozen.schemaDigest,PRE_CALENDAR_OCCURRENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[frozen.postgresMajor],
    'Actual through-0411 schema exactly matches independently accepted v19')
  assert.deepEqual(frozen.missingRelations,[])
  assert.deepEqual(frozen.missingFunctions,[])
  assert.ok(frozen.migrations.every(m=>m.rows===1&&m.matchingRows===1))

  // Compare one identical *frozen* v20 inventory before and after actual 0412 DDL.
  // The newly attested 0373 discovery authority tables already exist, and
  // must not change as part of this migration.
  const before=await inspectPreFractionalProductCompatibilityProductionRebindSchemaMetadata(pool)
  assert.deepEqual([...before.missingRelations].sort(),CALENDAR_OCCURRENCE_RELATIONS)
  assert.deepEqual([...before.missingFunctions].sort(),CALENDAR_OCCURRENCE_FUNCTIONS)
  assert.deepEqual(before.migrations.filter(m=>m.rows!==1||m.matchingRows!==1)
    .map(({filename,rows,matchingRows})=>[filename,rows,matchingRows]),[[CALENDAR_OCCURRENCE_MIGRATION,0,0]])
  await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
    error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Exact v19 catalogue is not a fallback for absent 0412 evidence')
  const forgedLedger=await pool.connect()
  try{
    await forgedLedger.query('BEGIN')
    await forgeCurrentLedgerInDisposableTransaction(forgedLedger)
    await assert.rejects(attestProductionRebindHistorySchema(forgedLedger),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='schema_object_missing',
      'A forged 0412 ledger row is not a substitute for occurrence tables and guards')
  }finally{await forgedLedger.query('ROLLBACK');forgedLedger.release()}

  await applyFixtureMigrationRange(pool,{after:LEGACY_RECOVERY_MIGRATION,through:CALENDAR_OCCURRENCE_MIGRATION})
  const after=await inspectPreFractionalProductCompatibilityProductionRebindSchemaMetadata(pool)
  assert.equal(after.format,'clawpilot-production-rebind-v20-metadata-only')
  assert.equal(after.schemaDigest,FROZEN_V20_DIGEST_BY_MAJOR[after.postgresMajor],
    'The old through-0412 catalog retains its independently accepted v20 fingerprint')
  assert.deepEqual(after.missingRelations,[])
  assert.deepEqual(after.missingFunctions,[])
  assert.deepEqual(after.migrations.slice(0,-1),before.migrations.slice(0,-1))
  assert.deepEqual(after.migrations.at(-1),{...before.migrations.at(-1),rows:1,matchingRows:1})
  verifyCalendarOccurrenceDefinitions(after.catalog)

  for(const key of ['schema','additionalSchemas']) assert.deepEqual(after.catalog[key],before.catalog[key],`0412 preserves ${key}`)
  const newRelation=row=>CALENDAR_OCCURRENCE_RELATIONS.includes(row.relation??row.expected)
  const meetingGuard=row=>row.relation==='public.crm_meetings'&&row.name===CALENDAR_OCCURRENCE_REQUIRED_TRIGGER
  const meetingFkAction=row=>row.relation==='public.crm_meetings'&&row.internal
    &&row.foreignKey?.schema==='public'&&row.foreignKey.name===CALENDAR_OCCURRENCE_FKS[0][1]
  const newHelper=fn=>CALENDAR_OCCURRENCE_FUNCTIONS.includes(`${fn.schema}.${fn.name}(${fn.identityArguments})`)
  for(const key of ['relations','columns','constraints','indexes','triggers','functions']){
    const exclude=key==='functions'?newHelper:key==='constraints'?row=>newRelation(row)||meetingGuard(row)
      :key==='triggers'?row=>newRelation(row)||meetingGuard(row)||meetingFkAction(row):newRelation
    assert.deepEqual(after.catalog[key].filter(row=>!exclude(row)),before.catalog[key].filter(row=>!exclude(row)),
      `0412 preserves every pre-existing ${key} except its exact additive meeting guards`)
  }

  const privateForeignKeyNames=catalog=>catalog.triggers.filter(t=>t.internal
    &&t.foreignKey?.schema==='crm_legacy_email_retirement').map(t=>t.name)
  assert.equal(privateForeignKeyNames(after.catalog).length,16,
    'Exactly four private recovery FKs contribute both source and action trigger pairs')
  assert.notDeepEqual(privateForeignKeyNames(after.catalog),privateForeignKeyNames(frozenV21Baseline.catalog),
    'Real secondary database allocates different private recovery FK trigger OIDs')
  const occurrenceForeignKeyNames=catalog=>catalog.triggers.filter(t=>t.internal&&t.foreignKey?.schema==='public'
    &&CALENDAR_OCCURRENCE_FKS.some(([,name])=>name===t.foreignKey.name)).map(t=>t.name)
  assert.equal(occurrenceForeignKeyNames(after.catalog).length,8,'Both new composite FKs contribute all four guards')
  assert.notDeepEqual(occurrenceForeignKeyNames(after.catalog),occurrenceForeignKeyNames(frozenV21Baseline.catalog),
    'Real secondary database allocates different occurrence FK trigger OIDs')
  const historicalCapability=gatewayCapabilityConstraint(after.catalog)
  const currentCapability=gatewayCapabilityConstraint(frozenV21Baseline.catalog)
  assertGatewayCapabilityVocabulary(historicalCapability,[...GATEWAY_BASE_CAPABILITIES,'crm.customer-folder.write'])
  assertGatewayCapabilityVocabulary(currentCapability,GATEWAY_CURRENT_CAPABILITIES)
  assert.equal(productionRebindHistorySchemaDigest({ ...after.catalog,
    constraints:after.catalog.constraints.map(c=>c===historicalCapability?currentCapability:c) }),
  frozenV21Baseline.schemaDigest,'Exactly one validated gateway CHECK explains the frozen v20-to-v21 catalog change')
  await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
    error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Frozen v20 cannot be accepted as the current product-compatible release')
  const forgedComplete=await pool.connect()
  try{
    await forgedComplete.query('BEGIN')
    await forgeCurrentLedgerInDisposableTransaction(forgedComplete)
    await assert.rejects(attestProductionRebindHistorySchema(forgedComplete),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='schema_object_missing',
      'Forging a current ledger cannot replace the new schema/guards or the v20 gateway CHECK')
  }finally{await forgedComplete.query('ROLLBACK');forgedComplete.release()}
  console.log(`PG${after.postgresMajor}: frozen v19 and v20, exact additive 0412 delta, and exact gateway CHECK delta verified`)
  return {frozenV19Digest:frozen.schemaDigest,frozenV20Digest:after.schemaDigest,before,after}
}

function verifyHeldOriginalDefinitions(catalog) {
  const heldSchema=catalog.additionalSchemas.find(schema=>schema.name===HELD_ORIGINAL_SCHEMA)
  assert.ok(heldSchema?.ownerIsCurrentUser && !heldSchema.aclIsDefault)
  assert.ok(!heldSchema.acl.some(acl=>acl.grantee==='PUBLIC'),'Private held-original schema has no PUBLIC privileges')
  for(const expected of HELD_ORIGINAL_RELATIONS){
    const relation=catalog.relations.find(row=>row.expected===expected)
    assert.ok(relation?.present && relation.kind==='r' && relation.ownerIsCurrentUser,expected)
    assert.ok(!relation.acl.some(acl=>acl.grantee==='PUBLIC'),expected)
  }
  const definerNames=new Set(['hold','resolve','protect_held','clawpilot_crm_native_initial_pending_quarantine','resolve_recovery',
    'stage_recovery','register_release','check_release_binding','resolve_unsettled_release','claim_resolution','settle_release','resolve_release'])
  for(const identity of HELD_ORIGINAL_FUNCTIONS){
    const [schema,name]=identity.split('(')[0].split('.')
    const funcs=catalog.functions.filter(fn=>fn.schema===schema&&fn.name===name)
    assert.equal(funcs.length,1,identity)
    const [fn]=funcs
    assert.ok(fn.ownerIsCurrentUser && !fn.aclIsDefault,identity)
    assert.equal(fn.securityDefiner,definerNames.has(name),identity)
    assert.ok(fn.configuration.some(value=>/^search_path=pg_catalog,\s*pg_temp$/u.test(value)),identity)
    assert.ok(!fn.acl.some(acl=>acl.grantee==='PUBLIC'),identity)
  }
  for(const [relation,name,typeMask,identity,deferred=false] of HELD_ORIGINAL_GUARDS){
    const guards=catalog.triggers.filter(trigger=>trigger.relation===relation&&trigger.name===name)
    assert.equal(guards.length,1,`${relation}.${name}`)
    const [guard]=guards
    assert.deepEqual([guard.enabled,guard.internal,guard.typeMask,guard.function,guard.deferrable,guard.initiallyDeferred],
      ['O',false,typeMask,identity,deferred,deferred],`${relation}.${name} is exact`)
  }
}

function verifyHeldOriginalCatalogDelta(before,after) {
  verifyHeldOriginalDefinitions(after)
  const newlyScopedRelations=[...HELD_ORIGINAL_RELATIONS,HELD_ORIGINAL_CONTACT_MERGE_RELATION]
  const isNewRelation=row=>newlyScopedRelations.includes(row.relation??row.expected)
  const isHeldGuard=row=>HELD_ORIGINAL_GUARDS.some(([relation,name])=>row.relation===relation&&row.name===name)
  const isHeldFk=row=>row.internal&&row.foreignKey?.schema===HELD_ORIGINAL_SCHEMA
  for(const key of ['relations','columns','indexes','constraints','triggers']) {
    const exclude=key==='triggers'?row=>isNewRelation(row)||isHeldGuard(row)||isHeldFk(row)
      :key==='constraints'?row=>isNewRelation(row)||isHeldGuard(row):isNewRelation
    assert.deepEqual(after[key].filter(row=>!exclude(row)),before[key],`0413–0417 preserve the remaining v21 ${key}`)
  }
  assert.deepEqual(after.schema,before.schema)
  assert.deepEqual(after.additionalSchemas.filter(schema=>schema.name!==HELD_ORIGINAL_SCHEMA),before.additionalSchemas)
  const fnKey=fn=>`${fn.schema}.${fn.name}(${fn.identityArguments})`
  const oldFunctions=new Map(before.functions.map(fn=>[fnKey(fn),fn]))
  const currentFunctions=new Map(after.functions.map(fn=>[fnKey(fn),fn]))
  const changed=[]
  for(const [identity,old] of oldFunctions){
    const current=currentFunctions.get(identity)
    assert.ok(current,identity)
    if(old.schema==='public'&&HELD_ORIGINAL_CHANGED_FUNCTION_NAMES.includes(old.name)){
      assert.notEqual(current.source,old.source,identity)
      const withoutBody=({source,definition,...metadata})=>metadata
      assert.deepEqual(withoutBody(current),withoutBody(old),`0413–0417 preserve metadata and privileges of ${identity}`)
      changed.push(old.name)
    }else assert.deepEqual(current,old,`0413–0417 do not change unrelated ${identity}`)
  }
  assert.deepEqual(changed.sort(),[...HELD_ORIGINAL_CHANGED_FUNCTION_NAMES].sort())
  const allowedNewlySelected=new Set([...HELD_ORIGINAL_FUNCTIONS.map(identity=>identity.split('(')[0]),
    'public.validate_crm_contact_merge_outbox_dependency','public.protect_crm_contact_merge_evidence'])
  for(const [identity,fn] of currentFunctions)if(!oldFunctions.has(identity)){
    assert.ok(allowedNewlySelected.has(`${fn.schema}.${fn.name}`),`Unexpected newly selected function ${identity}`)
  }
}

async function verifyHeldOriginalTamper(pool,catalog,frozenV21Catalog) {
  verifyHeldOriginalDefinitions(catalog)
  await expectFailure(pool,'schema_catalog_mismatch','v22 private schema PUBLIC USAGE drift',tx=>tx.query(
    `GRANT USAGE ON SCHEMA ${HELD_ORIGINAL_SCHEMA} TO PUBLIC`))
  for(const relation of [...HELD_ORIGINAL_RELATIONS,HELD_ORIGINAL_CONTACT_MERGE_RELATION]){
    await expectFailure(pool,'schema_object_missing',`v22 missing ${relation}`,tx=>tx.query(`DROP TABLE ${relation} CASCADE`))
    await expectFailure(pool,'schema_catalog_mismatch',`v22 ${relation} PUBLIC read drift`,tx=>tx.query(`GRANT SELECT ON ${relation} TO PUBLIC`))
  }
  for(const identity of HELD_ORIGINAL_FUNCTIONS){
    await expectFailure(pool,'schema_object_missing',`v22 missing ${identity}`,tx=>tx.query(`DROP FUNCTION ${identity} CASCADE`))
    await expectFailure(pool,'schema_catalog_mismatch',`v22 ${identity} PUBLIC execution drift`,tx=>tx.query(
      `GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`))
  }
  for(const [relation,name] of HELD_ORIGINAL_GUARDS){
    await expectFailure(pool,'schema_catalog_mismatch',`v22 ${relation}.${name} disabled`,tx=>tx.query(
      `ALTER TABLE ${relation} DISABLE TRIGGER ${name}`))
  }
  for(const name of HELD_ORIGINAL_CHANGED_FUNCTION_NAMES){
    const historical=frozenV21Catalog.functions.find(fn=>fn.schema==='public'&&fn.name===name)
    assert.ok(historical?.definition,name)
    await expectFailure(pool,'schema_catalog_mismatch',`v22 restored historical body of ${name}`,tx=>tx.query(historical.definition))
  }
  await expectFailure(pool,'schema_catalog_mismatch','0413 retained original column PUBLIC read drift',tx=>tx.query(
    `GRANT SELECT (original) ON ${HELD_ORIGINAL_SCHEMA}.held TO PUBLIC`))
  await expectFailure(pool,'schema_catalog_mismatch','0417 receipt attestation is no longer write-only by default',tx=>tx.query(
    `GRANT INSERT ON ${HELD_ORIGINAL_SCHEMA}.verified_receipts TO PUBLIC`))
  await expectFailure(pool,'schema_catalog_mismatch','0417 settlement loses exact definer boundary',tx=>tx.query(
    `ALTER FUNCTION ${HELD_ORIGINAL_SCHEMA}.settle_release(uuid,text,uuid,bigint,jsonb) SECURITY INVOKER`))
  for(const {filename} of HELD_ORIGINAL_MIGRATIONS){
    await expectLedgerFailure(pool,filename)
    await expectLedgerFailure(pool,filename,true)
  }
}

function describeCatalogDifference(before,after) {
  const clean=JSON.parse(canonicalProductionRebindHistorySchemaCatalog(before))
  const upgrade=JSON.parse(canonicalProductionRebindHistorySchemaCatalog(after))
  const differences=[]
  const keyFor=(kind,row)=>kind==='triggers'&&row.internal&&row.foreignKey
    ?[row.relation,row.foreignKey.schema,row.foreignKey.source,row.foreignKey.name,row.typeMask,row.function].join('/')
    :[row.relation??row.expected??row.schema,row.name,row.identityArguments].filter(value=>typeof value==='string').join('/')
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
  for(const section of Object.keys(clean)){
    if(equal(clean[section],upgrade[section]))continue
    if(!Array.isArray(clean[section])||!Array.isArray(upgrade[section])){
      differences.push({section,changed:true});continue
    }
    const left=new Map(clean[section].map(row=>[keyFor(section,row),row]))
    const right=new Map(upgrade[section].map(row=>[keyFor(section,row),row]))
    if(left.size!==clean[section].length||right.size!==upgrade[section].length){
      differences.push({section,ambiguousKeys:true,cleanCount:clean[section].length,upgradeCount:upgrade[section].length});continue
    }
    for(const identity of new Set([...left.keys(),...right.keys()])){
      const l=left.get(identity),r=right.get(identity)
      if(equal(l,r))continue
      differences.push({section,identity,fields:l&&r?Object.keys({...l,...r}).filter(k=>!equal(l[k],r[k])):
        [l?'missing_in_upgrade':'added_in_upgrade']})
    }
  }
  return {total:differences.length,first:differences.slice(0,36)}
}

function runFixtureProductionMigrations(databaseUrl) {
  return command(process.execPath, ['scripts/db-migrate.mjs'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: 'disable' },
    timeout: 180_000,
  })
}

async function verifyInstalledMaintenanceCatalog(pool, frozenV22) {
  const state = await pool.query(`SELECT fence_id IS NULL AS open,
      clawpilot_crm_maintenance.coverage() AS covered
    FROM clawpilot_crm_maintenance.write_fence WHERE singleton`)
  assert.deepEqual(state.rows, [{ open: true, covered: true }],
    '0418 starts open with complete trigger coverage')
  const ledger = await pool.query('SELECT filename, checksum FROM public.schema_migrations ORDER BY filename')
  assert.deepEqual(ledger.rows.filter(row => row.filename === CRM_MAINTENANCE_MIGRATION),
    [{ filename: CRM_MAINTENANCE_MIGRATION, checksum: CRM_MAINTENANCE_CHECKSUM }],
    'The production runner records exactly one reviewed 0418 migration')
  const inspection = await inspectProductionRebindHistorySchema(pool)
  assert.equal(inspection.maintenanceFencePresent, true)
  const { catalog } = inspection
  const maintenanceTriggers = catalog.triggers.filter(trigger =>
    trigger.function.startsWith(`${CRM_MAINTENANCE_SCHEMA}.`))
  assert.ok(maintenanceTriggers.length > 0, 'Current catalog contains the new maintenance guards')
  for (const trigger of maintenanceTriggers) {
    assert.equal(trigger.enabled, 'A')
    assert.equal(trigger.internal, false)
    assert.ok([
      ['clawpilot_crm_fence_write', 31, `${CRM_MAINTENANCE_SCHEMA}.check_mixed_row()`],
      ['clawpilot_crm_fence_write', 62, `${CRM_MAINTENANCE_SCHEMA}.check_relation()`],
      ['clawpilot_crm_fence_truncate', 34, `${CRM_MAINTENANCE_SCHEMA}.check_relation()`],
    ].some(([name, mask, fn]) => trigger.name === name && trigger.typeMask === mask && trigger.function === fn),
    'Every new guard on a rebind-enrolled relation uses an exact reviewed trigger contract')
  }
  // This exact delta assertion is test-only. The operator attester rejects the
  // new schema; it does not project out the maintenance guards or issue v22.
  const previousCatalog = {
    ...catalog,
    triggers: catalog.triggers.filter(trigger => !maintenanceTriggers.includes(trigger)),
    functions: catalog.functions.filter(fn => fn.schema !== CRM_MAINTENANCE_SCHEMA),
  }
  assert.equal(productionRebindHistorySchemaDigest(previousCatalog), frozenV22.schemaDigest,
    '0418 changes the rebind-enrolled catalog only by adding the exact maintenance guards')
  await assert.rejects(attestProductionRebindHistorySchema(pool), error =>
    error instanceof ProductionRebindHistorySchemaAttestationError && error.code === 'maintenance_schema_unattested',
    'An installed 0418 cannot issue a v22 operator receipt')
  return { catalog, schemaDigest: inspection.schemaDigest, ledger: ledger.rows }
}

async function verifyCleanMaintenanceCatalog(databaseUrl, frozenV22) {
  const controlPool = new Pool({ connectionString: databaseUrl, max: 1 })
  try { await controlPool.query('CREATE DATABASE clawpilot_rebind_current_clean_fixture') }
  finally { await controlPool.end() }
  const url = new URL(databaseUrl)
  url.pathname = '/clawpilot_rebind_current_clean_fixture'
  const migrationOutput = runFixtureProductionMigrations(url.toString())
  for (const filename of [...PRODUCTION_REBIND_SCHEMA_MIGRATIONS.map(migration => migration.filename), CRM_MAINTENANCE_MIGRATION]) {
    assert.ok(migrationOutput.includes(`apply ${filename}`), `${filename} executed through the real migration runner`)
  }
  const pool = new Pool({ connectionString: url.toString(), max: 1 })
  try {
    // Simulate catalog drift where the fence schema (and its attached guards)
    // has been dropped, but the real migration ledger still proves 0418 ran.
    const current = await verifyInstalledMaintenanceCatalog(pool, frozenV22)
    const drift = await pool.connect()
    try {
      await drift.query('BEGIN')
      await drift.query(`DROP SCHEMA ${CRM_MAINTENANCE_SCHEMA} CASCADE`)
      await assert.rejects(attestProductionRebindHistorySchema(drift), error =>
        error instanceof ProductionRebindHistorySchemaAttestationError && error.code === 'maintenance_schema_unattested',
        'Dropping the 0418 guards cannot restore v22 eligibility')
    } finally { await drift.query('ROLLBACK'); drift.release() }
    return current
  } finally { await pool.end() }
}

async function verifyProductCompatibleUpgrade(databaseUrl,currentBaseline,{attestCurrent,cleanMaintenance}) {
  const controlPool=new Pool({connectionString:databaseUrl,max:1})
  try{await controlPool.query('CREATE DATABASE clawpilot_rebind_product_upgrade_fixture')}
  finally{await controlPool.end()}
  const url=new URL(databaseUrl);url.pathname='/clawpilot_rebind_product_upgrade_fixture'
  const pool=new Pool({connectionString:url.toString(),max:1})
  try{
    await applyFixtureMigrationRange(pool,{through:UNMANAGED_PIPELINE_MIGRATION,bootstrap:true,frozen:false})
    const pre=await inspectProductionRebindHistorySchema(pool)
    assertGatewayCapabilityVocabulary(gatewayCapabilityConstraint(pre.catalog),[...GATEWAY_BASE_CAPABILITIES,'crm.product.read'])
    assert.deepEqual(pre.migrations.filter(m=>m.filename===FRACTIONAL_PRODUCT_MIGRATION).map(m=>[m.rows,m.matchingRows]),[[1,1]])
    const owner='product-compatibility@example.invalid',workspace=randomUUID(),pipeline=randomUUID(),credential=randomUUID()
    await pool.query("INSERT INTO app_users(email,role,status) VALUES($1,'owner','active')",[owner])
    await pool.query("INSERT INTO workspace_organizations(id,name,organization_type) VALUES($1,'Synthetic compatibility workspace','root')",[workspace])
    await pool.query("INSERT INTO pipeline_spaces(id,name,owner_email,workspace_organization_id) VALUES($1,'Synthetic compatibility pipeline',$2,$3)",[pipeline,owner,workspace])
    await pool.query(`INSERT INTO public.fractional_crm_gateway_credentials(id,token_hash,source_instance_id,
      workspace_organization_id,pipeline_id,root_company_global_id,allowed_company_global_ids,capabilities,
      fractional_deployment_id,fractional_organization_id,actor_email,expires_at,enabled)
      VALUES($1,$2,$3,$4,$5,'ga0000403',ARRAY['ga0000403'],ARRAY['crm.company.read','crm.product.read'],$6,
        'synthetic-product-read',$7,now()+interval '1 hour',true)`,
    [credential,createHash('sha256').update('synthetic product grant').digest('hex'),randomUUID(),workspace,pipeline,randomUUID(),owner])
    const readCredential=async()=>{
      const result=await pool.query(`SELECT to_jsonb(c) AS value FROM ${GATEWAY_CREDENTIALS} c WHERE id=$1`,[credential])
      assert.equal(result.rowCount,1)
      return result.rows[0].value
    }
    const retainedCredential=await readCredential()
    const client=await pool.connect()
    try{
      await assert.rejects(applyMigrationSqlForTest(client,FRACTIONAL_FOLDER_MIGRATION,frozenFolderSql(),
        {checksum:FROZEN_FOLDER_MIGRATION_CHECKSUM}),error=>error.cause?.code==='23514',
      'Original pending 0403 fails the exact existing product grant instead of removing or revoking it')
    }finally{client.release()}
    const afterRefusal=await inspectProductionRebindHistorySchema(pool)
    assert.equal(afterRefusal.schemaDigest,pre.schemaDigest,'Failed old 0403 leaves the prior CHECK untouched')
    assert.deepEqual(afterRefusal.migrations,pre.migrations,'Failed old 0403 records no migration ledger row')
    assert.deepEqual(await readCredential(),retainedCredential,'Failed old 0403 preserves the exact grant')
    await applyFixtureMigrationRange(pool,{after:UNMANAGED_PIPELINE_MIGRATION,through:CALENDAR_OCCURRENCE_MIGRATION,frozen:false})
    const frozenV21=await inspectPreHeldOriginalProductionRebindSchemaMetadata(pool)
    assert.deepEqual(await readCredential(),retainedCredential,'Forward 0403 and the suffix preserve every credential field')
    assertGatewayCapabilityVocabulary(gatewayCapabilityConstraint(frozenV21.catalog),GATEWAY_CURRENT_CAPABILITIES)
    assert.equal(frozenV21.format,'clawpilot-production-rebind-v21-metadata-only')
    assert.equal(frozenV21.schemaDigest,PRE_HELD_ORIGINAL_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[frozenV21.postgresMajor],
      'Product-compatible through-0412 keeps its independently enrolled v21 fingerprint')
    assert.deepEqual(frozenV21.missingRelations,[])
    assert.deepEqual(frozenV21.missingFunctions,[])
    assert.ok(frozenV21.migrations.every(m=>m.rows===1&&m.matchingRows===1))
    const beforeHeld=await inspectProductionRebindHistorySchema(pool)
    assert.deepEqual([...beforeHeld.missingRelations].sort(),[...HELD_ORIGINAL_RELATIONS].sort())
    assert.deepEqual([...beforeHeld.missingFunctions].sort(),[...HELD_ORIGINAL_FUNCTIONS].sort())
    assert.deepEqual(beforeHeld.migrations.filter(m=>m.rows!==1||m.matchingRows!==1)
      .map(({filename,rows,matchingRows})=>[filename,rows,matchingRows]),HELD_ORIGINAL_MIGRATIONS.map(({filename})=>[filename,0,0]))
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
      'Exact v21 is not a fallback for the current held-original migration floor')
    const forgedHeld=await pool.connect()
    try{
      await forgedHeld.query('BEGIN')
      await forgeCurrentLedgerInDisposableTransaction(forgedHeld)
      await assert.rejects(attestProductionRebindHistorySchema(forgedHeld),error=>
        error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='schema_object_missing',
        'Forged 0413–0417 ledger rows cannot substitute for the actual held-original schema and guards')
    }finally{await forgedHeld.query('ROLLBACK');forgedHeld.release()}
    await applyFixtureMigrationRange(pool,{after:CALENDAR_OCCURRENCE_MIGRATION,through:HELD_ORIGINAL_MIGRATIONS.at(-1).filename,frozen:false})
    const after=await inspectProductionRebindHistorySchema(pool)
    assert.deepEqual(await readCredential(),retainedCredential,'Held-original schema preserves the existing product credential byte-for-byte')
    assert.deepEqual(after.migrations,currentBaseline.migrations)
    assert.equal(after.schemaDigest,currentBaseline.schemaDigest,after.schemaDigest===currentBaseline.schemaDigest
      ?'Exact clean and product-enabled predecessor upgrades converge at v22'
      :`Exact clean and product-enabled predecessor upgrades must converge at v22: ${JSON.stringify(describeCatalogDifference(currentBaseline.catalog,after.catalog))}`)
    verifyHeldOriginalCatalogDelta(frozenV21.catalog,after.catalog)
    if(attestCurrent)await attestProductionRebindHistorySchema(pool)
    console.log(`PG${after.postgresMajor}: exact frozen v21 and additive held-original v22 catalog; retained product grant unchanged`)
    if (cleanMaintenance) {
      assert.ok(runFixtureProductionMigrations(url.toString()).includes(`apply ${CRM_MAINTENANCE_MIGRATION}`),
        'The real production runner applies the maintenance migration to the populated v22 predecessor')
      const upgraded = await verifyInstalledMaintenanceCatalog(pool, after)
      assert.deepEqual(upgraded.ledger, cleanMaintenance.ledger, 'Fresh and upgraded migration ledgers converge through 0418')
      assert.equal(upgraded.schemaDigest, cleanMaintenance.schemaDigest,
        upgraded.schemaDigest === cleanMaintenance.schemaDigest ? 'Fresh and upgraded current catalogs converge through 0418'
          : `Fresh and upgraded current catalogs must converge through 0418: ${JSON.stringify(describeCatalogDifference(cleanMaintenance.catalog, upgraded.catalog))}`)
      assert.deepEqual(await readCredential(), retainedCredential, 'The maintenance migration preserves the existing product credential')
      console.log(`PG${after.postgresMajor}: exact 0418 clean/upgrade convergence, open fence and v22 rebind refusal verified`)
    }
    return {frozenV21,upgradedSchemaDigest:after.schemaDigest}
  }finally{await pool.end()}
}

async function verifyCalendarOccurrenceTamper(pool,catalog) {
  verifyCalendarOccurrenceDefinitions(catalog)
  for(const relation of [...CALENDAR_OCCURRENCE_RELATIONS,...CALENDAR_OCCURRENCE_AUTHORITY_RELATIONS]){
    await expectFailure(pool,'schema_object_missing',`0412 missing ${relation}`,tx=>tx.query(`DROP TABLE ${relation} CASCADE`))
    await expectFailure(pool,'schema_catalog_mismatch',`0412 ${relation} PUBLIC read drift`,tx=>tx.query(`GRANT SELECT ON ${relation} TO PUBLIC`))
  }
  for(const identity of CALENDAR_OCCURRENCE_FUNCTIONS){
    await expectFailure(pool,'schema_object_missing',`0412 missing ${identity}`,tx=>tx.query(`DROP FUNCTION ${identity} CASCADE`))
    await expectFailure(pool,'schema_catalog_mismatch',`0412 ${identity} PUBLIC execution drift`,tx=>tx.query(`GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`))
    await expectFailure(pool,'schema_catalog_mismatch',`0412 ${identity} guard body bypass`,tx=>tx.query(`
      CREATE OR REPLACE FUNCTION ${identity} RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public AS $$ BEGIN RETURN NULL; END $$`))
  }
  for(const [relation,name] of CALENDAR_OCCURRENCE_GUARDS){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 ${relation}.${name} disabled`,tx=>tx.query(`ALTER TABLE ${relation} DISABLE TRIGGER ${name}`))
  }
  for(const [deferral,predicate] of [
    ['NOT DEFERRABLE INITIALLY IMMEDIATE',"NEW.source_key LIKE 'calendar-discovery:%' OR NEW.source_payload->>'source'='google_calendar_discovery'"],
    ['DEFERRABLE INITIALLY DEFERRED','false'],
  ]){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 occurrence barrier ${deferral}/${predicate==='false'?'bypassed':'same predicate'}`,async tx=>{
      await tx.query(`DROP TRIGGER ${CALENDAR_OCCURRENCE_REQUIRED_TRIGGER} ON public.crm_meetings`)
      await tx.query(`CREATE CONSTRAINT TRIGGER ${CALENDAR_OCCURRENCE_REQUIRED_TRIGGER}
        AFTER INSERT ON public.crm_meetings ${deferral} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION ${CALENDAR_OCCURRENCE_REQUIRE}`)
    })
  }
  const occurrenceConstraints=catalog.constraints.filter(c=>CALENDAR_OCCURRENCE_RELATIONS.includes(c.relation)&&['p','u','f','c'].includes(c.type))
  assert.deepEqual(occurrenceConstraints.map(c=>c.type).sort(),['c','c','c','f','f','p','p','u'],
    'Every 0412 identity, uniqueness and referential constraint has an individual tamper probe')
  for(const {relation,name} of occurrenceConstraints){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 missing ${relation}.${name}`,tx=>tx.query(`ALTER TABLE ${relation} DROP CONSTRAINT ${name} CASCADE`))
  }
  for(const [relation,name,target,sourceColumns,targetColumns] of CALENDAR_OCCURRENCE_FKS){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 ${name} no longer cascades an intentional hard delete`,async tx=>{
      await tx.query(`ALTER TABLE ${relation} DROP CONSTRAINT ${name}`)
      await tx.query(`ALTER TABLE ${relation} ADD CONSTRAINT ${name} FOREIGN KEY (${sourceColumns.join(',')}) REFERENCES ${target} (${targetColumns.join(',')}) ON DELETE NO ACTION`)
    })
  }
  for(const index of ['idx_crm_calendar_occurrence_bindings_claim','idx_crm_calendar_occurrence_claims_meeting']){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 missing occurrence/cascade lookup ${index}`,tx=>tx.query(`DROP INDEX public.${index}`))
  }
  for(const relation of CALENDAR_OCCURRENCE_RELATIONS){
    await expectFailure(pool,'schema_catalog_mismatch',`0412 nullable ${relation}.meeting_id would bypass its FK`,tx=>tx.query(`ALTER TABLE ${relation} ALTER COLUMN meeting_id DROP NOT NULL`))
  }
  await expectLedgerFailure(pool,CALENDAR_OCCURRENCE_MIGRATION)
  await expectLedgerFailure(pool,CALENDAR_OCCURRENCE_MIGRATION,true)
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
    await applyFixtureMigrationRange(pool,{through:REVIEWED_COMPANY_MIGRATION,bootstrap:true})
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
    'Historical v15 metadata is not a fallback for a current target lacking0400/0401')
    const quarantineSql=readFileSync(resolve(root,'db/migrations',INITIAL_DEMO_QUARANTINE_MIGRATION),'utf8')
    const quarantineClient=await pool.connect()
    try{await applyMigrationSqlForTest(quarantineClient,INITIAL_DEMO_QUARANTINE_MIGRATION,quarantineSql,
      {checksum:createHash('sha256').update(quarantineSql).digest('hex')})}finally{quarantineClient.release()}
    const beforeOwnerFence=await inspectPreRootOwnerSourceFenceProductionRebindSchemaMetadata(pool)
    assert.equal(beforeOwnerFence.format,'clawpilot-production-rebind-v16-metadata-only')
    assert.equal(beforeOwnerFence.schemaDigest,
      PRE_ROOT_OWNER_SOURCE_FENCE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[beforeOwnerFence.postgresMajor],
      'Exact through0400 preserves the independently accepted v16 catalog before0401')
    assert.deepEqual(beforeOwnerFence.missingRelations,[])
    assert.deepEqual(beforeOwnerFence.missingFunctions,[])
    assert.ok(beforeOwnerFence.migrations.every(m=>m.rows===1&&m.matchingRows===1))
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
    'Historical v16 metadata is not a fallback for a current v17 target lacking0401')
    const ownerHelperName='clawpilot_crm_root_native_membership_is_independent'
    const retainedOwnerHelper=beforeOwnerFence.catalog.functions.find(fn=>fn.schema==='public'&&fn.name===ownerHelperName)
    assert.ok(retainedOwnerHelper)
    assert.equal(createHash('sha256').update(retainedOwnerHelper.source).digest('hex'),
      '1453d556e6f1d460a67ec83147ffbd91dd9347c5b560b92bdf092752e6a7aa20',
      'The historical v16 owner helper retains the exact independently reviewed 0401 preimage')
    const ownerSql=readFileSync(resolve(root,'db/migrations',ROOT_OWNER_SOURCE_FENCE_MIGRATION),'utf8')
    const ownerClient=await pool.connect()
    try{await applyMigrationSqlForTest(ownerClient,ROOT_OWNER_SOURCE_FENCE_MIGRATION,ownerSql,
      {checksum:createHash('sha256').update(ownerSql).digest('hex')})}finally{ownerClient.release()}
    const beforeUnmanaged=await inspectPreUnmanagedPipelineProductionRebindSchemaMetadata(pool)
    assert.equal(beforeUnmanaged.format,'clawpilot-production-rebind-v17-metadata-only')
    assert.equal(beforeUnmanaged.schemaDigest,PRE_UNMANAGED_PIPELINE_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[beforeUnmanaged.postgresMajor],
      'Exact through0401 preserves the independently accepted v17 catalog before0402')
    assert.deepEqual(beforeUnmanaged.missingRelations,[])
    assert.deepEqual(beforeUnmanaged.missingFunctions,[])
    assert.ok(beforeUnmanaged.migrations.every(m=>m.rows===1&&m.matchingRows===1))
    const sourceSnapshot=catalog=>catalog.functions.find(fn=>fn.schema==='public'
      &&fn.name==='clawpilot_crm_native_initial_source_snapshot')
    assert.ok(sourceSnapshot(beforeQuarantine.catalog))
    assert.equal(sourceSnapshot(beforeUnmanaged.catalog)?.source,sourceSnapshot(beforeQuarantine.catalog).source,
      '0400 must preserve the complete historical source snapshot bytes, not filter demo evidence out')
    assert.equal(sourceSnapshot(beforeUnmanaged.catalog)?.definition,sourceSnapshot(beforeQuarantine.catalog).definition,
      '0400/0401 must not replace or weaken the historical source snapshot function')
    const currentOwnerHelper=beforeUnmanaged.catalog.functions.find(fn=>fn.schema==='public'&&fn.name===ownerHelperName)
    assert.ok(currentOwnerHelper)
    assert.notEqual(currentOwnerHelper.source,retainedOwnerHelper.source,'0401 changes its one reviewed owner-source predicate')
    assert.notEqual(currentOwnerHelper.definition,retainedOwnerHelper.definition)
    const withoutBody=({source,definition,...metadata})=>metadata
    assert.deepEqual(withoutBody(currentOwnerHelper),withoutBody(retainedOwnerHelper),
      '0401 preserves the exact owner-helper identity, privileges and execution attributes')
    for(const key of Object.keys(beforeOwnerFence.catalog)){
      if(key==='functions'){
        assert.deepEqual(beforeUnmanaged.catalog.functions.map(fn=>fn===currentOwnerHelper?retainedOwnerHelper:fn),
          beforeOwnerFence.catalog.functions,'0401 changes no other catalog function')
      }else assert.deepEqual(beforeUnmanaged.catalog[key],beforeOwnerFence.catalog[key],
        `0401 preserves the complete historical ${key} catalog`)
    }
    const appOnlyName=UNMANAGED_PIPELINE_CLASSIFIER.slice('public.'.length).split('(')[0]
    const retainedAppOnlyHelper=beforeUnmanaged.catalog.functions.find(fn=>fn.schema==='public'&&fn.name===appOnlyName)
    assert.ok(retainedAppOnlyHelper)
    assert.equal(createHash('sha256').update(retainedAppOnlyHelper.source).digest('hex'),
      '5ba06eacd5fc5dfc5c87343812c023d4c634d41c11c8b8cb804f22c84c0cbf2e',
      '0402 requires the exact independently retained app-only classifier preimage')
    // Compare the actual 0402 DDL using one identical frozen v18 inventory on
    // both sides. The separately frozen v17 projection above proves history;
    // expanding that projection to v18 must not masquerade as new SQL DDL.
    const beforeUnmanagedCurrent=await inspectPreLegacyRecoveryProductionRebindSchemaMetadata(pool)
    assert.deepEqual(beforeUnmanagedCurrent.missingRelations,[])
    assert.deepEqual([...beforeUnmanagedCurrent.missingFunctions].sort(),[...UNMANAGED_PIPELINE_HELPERS.keys()].sort(),
      'Before 0402 the frozen v18 inventory lacks exactly its seven new helper identities')
    assert.deepEqual(beforeUnmanagedCurrent.migrations.filter(m=>m.filename===UNMANAGED_PIPELINE_MIGRATION).map(m=>[m.rows,m.matchingRows]),[[0,0]])
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
      'Historical v17 metadata never attests a current target lacking0402')
    const unmanagedSql=readFileSync(resolve(root,'db/migrations',UNMANAGED_PIPELINE_MIGRATION),'utf8')
    const unmanagedClient=await pool.connect()
    try{await applyMigrationSqlForTest(unmanagedClient,UNMANAGED_PIPELINE_MIGRATION,unmanagedSql,
      {checksum:createHash('sha256').update(unmanagedSql).digest('hex')})}finally{unmanagedClient.release()}
    const completed = await inspectPreLegacyRecoveryProductionRebindSchemaMetadata(pool)
    assert.equal(completed.format,'clawpilot-production-rebind-v18-metadata-only')
    assert.equal(completed.schemaDigest,PRE_LEGACY_RECOVERY_SCHEMA_DIGEST_BY_POSTGRES_MAJOR[completed.postgresMajor],
      'Exact through0402 retains the independently accepted, unmodified v18 fingerprint')
    const afterUnmanagedHistorical=await inspectPreUnmanagedPipelineProductionRebindSchemaMetadata(pool)
    const changedAppOnlyHelper=afterUnmanagedHistorical.catalog.functions.find(fn=>fn.schema==='public'&&fn.name===appOnlyName)
    assert.ok(changedAppOnlyHelper)
    assert.notEqual(changedAppOnlyHelper.source,retainedAppOnlyHelper.source)
    assert.deepEqual(withoutBody(changedAppOnlyHelper),withoutBody(retainedAppOnlyHelper),
      '0402 preserves the original app-only classifier identity, privileges and execution attributes')
    for(const key of Object.keys(beforeUnmanaged.catalog)){
      if(key==='functions')assert.deepEqual(afterUnmanagedHistorical.catalog.functions.map(fn=>
        fn===changedAppOnlyHelper?retainedAppOnlyHelper:fn),beforeUnmanaged.catalog.functions,
        '0402 changes only its reviewed classifier in the complete frozen v17 function projection')
      else assert.deepEqual(afterUnmanagedHistorical.catalog[key],beforeUnmanaged.catalog[key],
        `0402 preserves the complete frozen historical ${key} catalog`)
    }
    const functionKey=fn=>`${fn.schema}.${fn.name}(${fn.identityArguments})`
    const beforeFunctions=new Map(beforeUnmanagedCurrent.catalog.functions.map(fn=>[functionKey(fn),fn]))
    const afterFunctions=new Map(completed.catalog.functions.map(fn=>[functionKey(fn),fn]))
    assert.equal(beforeFunctions.size,beforeUnmanagedCurrent.catalog.functions.length)
    assert.equal(afterFunctions.size,completed.catalog.functions.length)
    assert.equal(afterFunctions.size,beforeFunctions.size+UNMANAGED_PIPELINE_HELPERS.size,
      'Actual 0402 DDL adds exactly seven functions to the same frozen v18 inventory')
    for(const [identity,before] of beforeFunctions){
      const after=afterFunctions.get(identity)
      assert.ok(after,`0402 does not remove historical function ${identity}`)
      if(before.schema==='public'&&before.name===appOnlyName){
        assert.deepEqual(withoutBody(after),withoutBody(before),
          'Actual 0402 DDL changes only its existing wrapper body, not execution metadata')
        assert.equal(after.definition,changedAppOnlyHelper.definition)
      }else assert.deepEqual(after,before,`0402 leaves existing function ${identity} unchanged`)
    }
    const addedUnmanagedFunctions=[]
    for(const [identity,fn] of afterFunctions)if(!beforeFunctions.has(identity))addedUnmanagedFunctions.push(fn)
    assert.deepEqual(addedUnmanagedFunctions.map(fn=>`${fn.schema}.${fn.name}`).sort(),
      [...UNMANAGED_PIPELINE_HELPERS.keys()].map(identity=>identity.split('(')[0]).sort(),
      'The only actual 0402 function additions are its seven exact named helpers')
    for(const key of Object.keys(beforeUnmanagedCurrent.catalog))if(key!=='functions'){
      assert.deepEqual(completed.catalog[key],beforeUnmanagedCurrent.catalog[key],
        `Actual 0402 DDL leaves the identical v18 ${key} inventory unchanged`)
    }
    assert.deepEqual(completed.missingRelations,[])
    assert.deepEqual(completed.missingFunctions,[])
    console.log(`PG${completed.postgresMajor}: exact 0402 DDL delta is seven helper additions and one wrapper replacement; identical v18 relation/column/constraint/index/trigger inventories unchanged`)
    assert.equal(sourceSnapshot(completed.catalog)?.definition,sourceSnapshot(beforeQuarantine.catalog).definition,
      '0402 preserves exact source snapshot bytes and every retained demo source row')
    await assert.rejects(attestProductionRebindHistorySchema(pool),error=>
      error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='migration_checksum_mismatch',
      'A complete frozen v18 catalog is not a fallback for missing current recovery/calendar evidence')
    const forgedLedger=await pool.connect()
    try{
      await forgedLedger.query('BEGIN')
      await forgeCurrentLedgerInDisposableTransaction(forgedLedger)
      await assert.rejects(attestProductionRebindHistorySchema(forgedLedger),error=>
        error instanceof ProductionRebindHistorySchemaAttestationError&&error.code==='schema_object_missing',
        'Forged current suffix ledger cannot attest an older v18 catalog without the actual recovery schema/guards')
    }finally{await forgedLedger.query('ROLLBACK');forgedLedger.release()}
    await applyFixtureMigrationRange(pool,{after:UNMANAGED_PIPELINE_MIGRATION,through:LEGACY_RECOVERY_MIGRATION})
    await verifyCalendarOccurrenceSchemaDelta(pool,currentBaseline)
    return Object.freeze({rootOwnerBeforeDefinition:retainedOwnerHelper.definition,
      appOnlyBeforeDefinition:retainedAppOnlyHelper.definition})
  } finally {await pool.end()}
}

async function verifyBoundedCalendarOccurrenceUpgrade(databaseUrl,frozenV21Baseline) {
  const controlPool=new Pool({connectionString:databaseUrl,max:1})
  try{await controlPool.query('CREATE DATABASE clawpilot_rebind_v19_calendar_fixture')}
  finally{await controlPool.end()}
  const url=new URL(databaseUrl);url.pathname='/clawpilot_rebind_v19_calendar_fixture'
  const pool=new Pool({connectionString:url.toString(),max:1})
  try{
    await applyFixtureMigrationRange(pool,{through:LEGACY_RECOVERY_MIGRATION,bootstrap:true})
    return await verifyCalendarOccurrenceSchemaDelta(pool,frozenV21Baseline)
  }finally{await pool.end()}
}

async function exerciseImage(image,{diagnosticOnly=false,calendarDeltaOnly=false,heldOriginalDeltaOnly=false,maintenanceDeltaOnly=false}={}) {
  checkedTamperCases = 0
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const container = `clawpilot-target-schema-attestation-${suffix}`
  const password = `target-schema-attestation-${suffix}`
  let pool
  command('docker', disposablePostgresDockerArgs([
    'run', '--detach', '--rm', '--pull', 'never', '--name', container,
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', 'POSTGRES_DB=clawpilot_target_schema_attestation',
    '--publish', '127.0.0.1::5432',
    image,
  ]))
  try {
    const portOutput = command('docker', ['port', container, '5432/tcp']).trim()
    const port = portOutput.match(/^127\.0\.0\.1:(\d+)$/u)?.[1]
    assert.ok(port,'Docker published an exact loopback-only PostgreSQL port')
    const databaseUrl =
      `postgresql://postgres:${password}@127.0.0.1:${port}/clawpilot_target_schema_attestation`
    await waitForPostgres(databaseUrl)

    // Preserve genuine v22 history rather than running old tamper tests on a
    // post-0418 catalog. The current clean/upgrade checks below run the real
    // production migration runner with the entire, unfiltered migration tree.
    pool = new Pool({ connectionString: databaseUrl, max: 1 })
    await applyFixtureMigrationRange(pool, {
      through: HELD_ORIGINAL_MIGRATIONS.at(-1).filename, bootstrap: true, frozen: false,
    })
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
    if(diagnosticOnly||calendarDeltaOnly||heldOriginalDeltaOnly){
      await pool.end(); pool=undefined
      const {frozenV21,upgradedSchemaDigest}=await verifyProductCompatibleUpgrade(databaseUrl,baseline,{attestCurrent:!diagnosticOnly})
      if(heldOriginalDeltaOnly){
        pool=new Pool({connectionString:databaseUrl,max:1})
        await attestProductionRebindHistorySchema(pool)
        await verifyHeldOriginalTamper(pool,baseline.catalog,frozenV21.catalog)
        console.log(`${image}: ${checkedTamperCases} focused 0413–0417 tamper refusals passed; full historical matrix is a separate gate`)
        return
      }
      const proof=await verifyBoundedCalendarOccurrenceUpgrade(databaseUrl,frozenV21)
      if(calendarDeltaOnly){
        pool=new Pool({connectionString:databaseUrl,max:1})
        await attestProductionRebindHistorySchema(pool)
        await verifyCalendarOccurrenceTamper(pool,baseline.catalog)
        console.log(`${image}: ${checkedTamperCases} focused 0412 tamper refusals passed; full historical matrix is a separate gate`)
        return
      }
      // This mode only inspects disposable migrated databases and never
      // attests or reports acceptance. Pins still require independent review
      // followed by the full normal historical/tamper acceptance run.
      const directory=mkdtempSync(resolve(tmpdir(),'clawpilot-rebind-v22-diagnostic-'))
      const path=resolve(directory,`pg${baseline.postgresMajor}.json`)
      const manifest=JSON.stringify(baseline,null,2)+'\n'
      writeFileSync(path,manifest,{flag:'wx',mode:0o600})
      const pre0412Path=resolve(directory,`pg${baseline.postgresMajor}-before-0412.json`)
      const pre0412Manifest=JSON.stringify({frozenV19Digest:proof.frozenV19Digest,frozenV20Digest:proof.frozenV20Digest,
        currentProjection:proof.before},null,2)+'\n'
      writeFileSync(pre0412Path,pre0412Manifest,{flag:'wx',mode:0o600})
      console.log(JSON.stringify({diagnosticOnly:true,image,postgresMajor:baseline.postgresMajor,
        schemaDigest:baseline.schemaDigest,upgradedSchemaDigest,frozenV21Digest:frozenV21.schemaDigest,
        manifestSha256:createHash('sha256').update(manifest).digest('hex'),path,
        pre0412Path,pre0412ManifestSha256:createHash('sha256').update(pre0412Manifest).digest('hex')}))
      return
    }
    // Both source/check and referenced/action FK triggers are now enrolled.
    // These historical mutation probes specifically target the referenced
    // table's action pair; never select a source trigger by array position.
    const gatewayTriggers = baseline.catalog.triggers.filter(t=>GATEWAY_REFERENCE_CONSTRAINTS.get(t.constraint)===t.relation)
    const calendarTriggers = baseline.catalog.triggers.filter(t=>CALENDAR_REFERENCE_CONSTRAINTS.get(t.constraint)===t.relation)
    // This is serial acceptance; do not retain idle catalog-heavy backends in
    // both databases inside the deliberately bounded disposable container.
    await pool.end(); pool = undefined
    const cleanMaintenance = await verifyCleanMaintenanceCatalog(databaseUrl, baseline)
    const {frozenV21}=await verifyProductCompatibleUpgrade(databaseUrl,baseline,{attestCurrent:true,cleanMaintenance})
    if (maintenanceDeltaOnly) return
    const historical = await verifyHistoricalCatalogCompatibility(databaseUrl, frozenV21)
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
    const ownerHelper=baseline.catalog.functions.filter(fn=>fn.schema==='public'
      &&fn.name==='clawpilot_crm_root_native_membership_is_independent')
    assert.equal(ownerHelper.length,1,'0401 retains one exact pre-existing owner-source helper')
    assert.equal(ownerHelper[0].result,'boolean')
    assert.equal(ownerHelper[0].argumentCount,2)
    assert.equal(ownerHelper[0].defaultArgumentCount,0)
    assert.equal(ownerHelper[0].language,'plpgsql')
    assert.equal(ownerHelper[0].volatility,'v')
    assert.equal(ownerHelper[0].securityDefiner,false)
    assert.equal(ownerHelper[0].strict,false)
    assert.equal(ownerHelper[0].returnsSet,false)
    assert.equal(ownerHelper[0].aclIsDefault,false)
    assert.ok(!ownerHelper[0].acl.some(entry=>entry.grantee==='PUBLIC'),
      '0401 does not grant PUBLIC execution of owner-source classification')
    const unmanagedSql=readFileSync(resolve(root,'db/migrations',UNMANAGED_PIPELINE_MIGRATION),'utf8')
    for(const [identity,expected] of UNMANAGED_PIPELINE_HELPERS){
      const name=identity.slice('public.'.length).split('(')[0]
      const installed=baseline.catalog.functions.filter(fn=>fn.schema==='public'&&fn.name===name)
      assert.equal(installed.length,1,`${identity} has one exact installed identity`)
      const fn=installed[0]
      assert.equal(fn.result,expected.result,identity)
      assert.equal(fn.argumentCount,expected.arguments,identity)
      assert.equal(fn.language,expected.language,identity)
      assert.equal(fn.volatility,expected.volatility,identity)
      assert.equal(fn.defaultArgumentCount,0,identity)
      assert.equal(fn.strict,false,identity)
      assert.equal(fn.returnsSet,false,identity)
      assert.equal(fn.securityDefiner,false,identity)
      assert.equal(fn.aclIsDefault,false,identity)
      assert.ok(!fn.acl.some(entry=>entry.grantee==='PUBLIC'),identity)
      assert.equal(fn.configuration.length,1,identity)
      assert.match(fn.configuration[0],/^search_path=pg_catalog,\s*public$/u,identity)
      const source=unmanagedSql.match(new RegExp('CREATE FUNCTION '+name+'\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;'))?.[1]
      assert.ok(source,`${identity} source is present in frozen 0402`)
      assert.equal(fn.source,source,`${identity} executes the exact frozen migration body`)
    }
    assert.deepEqual(baseline.catalog.additionalSchemas.map(schema=>schema.name).sort(),
      ['crm_legacy_email_retirement',HELD_ORIGINAL_SCHEMA].sort(),'v22 enrolls both exact private schemas')
    const privateSchema=baseline.catalog.additionalSchemas.find(schema=>schema.name==='crm_legacy_email_retirement')
    assert.equal(privateSchema.name,'crm_legacy_email_retirement')
    assert.equal(privateSchema.ownerIsCurrentUser,true)
    assert.equal(privateSchema.aclIsDefault,false)
    assert.ok(!privateSchema.acl.some(entry=>entry.grantee==='PUBLIC'),
      'Private recovery schema must grant neither USAGE nor CREATE to PUBLIC')
    const capabilityCheck=gatewayCapabilityConstraint(baseline.catalog)
    assertGatewayCapabilityVocabulary(capabilityCheck,GATEWAY_CURRENT_CAPABILITIES)
    const disposition=baseline.catalog.columns.find(c=>
      c.relation==='crm_legacy_email_retirement.verified_batch'&&c.name==='publication_disposition')
    assert.equal(disposition?.notNull,true)
    assert.equal(disposition.default,"'archive_only'::text")
    assert.ok(baseline.catalog.constraints.some(c=>c.relation==='crm_legacy_email_retirement.verified_batch'
      &&c.type==='c'&&c.validated&&c.definition.includes("'reviewed_recovery'::text")),
      '0411 archive/recovery disposition is a direct validated catalog invariant')
    for(const identity of PRODUCTION_REBIND_RECOVERY_GUARD_HELPERS){
      const [schema,name]=identity.split('(')[0].split('.')
      const fn=baseline.catalog.functions.find(f=>f.schema===schema&&f.name===name)
      assert.ok(fn,`v19 exact helper ${identity}`)
      assert.equal(fn.aclIsDefault,false,identity)
      assert.ok(!fn.acl.some(entry=>entry.grantee==='PUBLIC'),identity)
      assert.ok(fn.configuration.some(value=>/^search_path=pg_catalog,\s*public$/u.test(value)),identity)
    }
    const narrowedControlColumns=new Map([
      ['crm_root_control_sessions',['enabled','active_transition_id','active_initial_enrollment_id','generation',
        'verified_generation','native_policy_fingerprint','activation_receipt_hash']],
      ['crm_root_inactive_publication_sessions',['active_operation_id']],
      ['crm_native_capability_control_complete',['enabled','active_transition_id','generation','verified_generation',
        'native_policy_fingerprint','activation_receipt_hash']],
      ['crm_native_initial_control_complete',['enabled','active_initial_enrollment_id','generation','verified_generation',
        'native_policy_fingerprint','activation_receipt_hash']],
    ])
    for(const [name,columns] of narrowedControlColumns){
      const trigger=baseline.catalog.triggers.find(t=>t.relation==='public.crm_native_email_publication_control'&&t.name===name)
      assert.ok(trigger?.when?.includes('old.')&&trigger.when.includes('new.'),name)
      assert.equal(trigger.enabled,'O',name)
      assert.equal(trigger.typeMask,17,name)
      assert.equal(trigger.deferrable,name.endsWith('_complete'),name)
      assert.equal(trigger.initiallyDeferred,name.endsWith('_complete'),name)
      const installed=await pool.query(`SELECT ARRAY(SELECT a.attname::text
        FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY chosen(attnum,position)
        JOIN pg_catalog.pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=chosen.attnum ORDER BY chosen.position) AS columns
        FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.crm_native_email_publication_control'::regclass AND t.tgname=$1`,[name])
      assert.deepEqual(installed.rows,[{columns}],`0409 ${name} retains exactly reviewed UPDATE columns`)
    }
    const settlementGuard=baseline.catalog.triggers.find(t=>
      t.relation==='public.crm_native_email_publication_admissions'&&t.name==='crm_legacy_email_require_settlement')
    assert.ok(settlementGuard)
    assert.equal(settlementGuard.typeMask,17)
    assert.equal(settlementGuard.deferrable,true)
    assert.equal(settlementGuard.initiallyDeferred,true)
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

    console.log(`${image} candidate v22 semantic target schema digest ${baseline.schemaDigest} (diagnostic only until full tamper acceptance)`)
    const evidence = await attestProductionRebindHistorySchema(pool)
    assert.equal(evidence.format,'clawpilot-production-rebind-target-schema-attestation-v22',
      'Current evidence never reuses a historical v19, v20 or v21 receipt format')
    assert.equal(evidence.postgresMajor, baseline.postgresMajor)
    assert.equal(evidence.schemaDigest, baseline.schemaDigest)
    await verifyCalendarOccurrenceTamper(pool,baseline.catalog)
    await verifyHeldOriginalTamper(pool,baseline.catalog,frozenV21.catalog)

    // The reviewed suffix is part of the complete current catalog, not an
    // exclusion by trigger name or a blanket acceptance of additive objects.
    for(const relation of PRODUCTION_REBIND_RECOVERY_RELATIONS){
      await expectFailure(pool,'schema_object_missing',`v19 missing ${relation}`,tx=>tx.query(`DROP TABLE ${relation} CASCADE`))
      await expectFailure(pool,'schema_catalog_mismatch',`v19 ${relation} PUBLIC read drift`,tx=>tx.query(`GRANT SELECT ON ${relation} TO PUBLIC`))
    }
    for(const identity of PRODUCTION_REBIND_RECOVERY_GUARD_HELPERS){
      await expectFailure(pool,'schema_object_missing',`v19 missing ${identity}`,tx=>tx.query(`DROP FUNCTION ${identity} CASCADE`))
      await expectFailure(pool,'schema_catalog_mismatch',`v19 ${identity} PUBLIC execution drift`,tx=>tx.query(`GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`))
    }
    const recoveryTriggers=baseline.catalog.triggers.filter(t=>!t.internal&&(
      t.name.includes('legacy_email')||t.name.startsWith('repair_')||narrowedControlColumns.has(t.name))
      &&!HELD_ORIGINAL_GUARDS.some(([relation,name])=>t.relation===relation&&t.name===name))
    assert.equal(recoveryTriggers.length,55,'All exact reviewed recovery guards on old and new relations are directly enrolled')
    for(const trigger of recoveryTriggers){
      await expectFailure(pool,'schema_catalog_mismatch',`v19 ${trigger.relation}.${trigger.name} disabled`,tx=>tx.query(
        `ALTER TABLE ${trigger.relation} DISABLE TRIGGER ${trigger.name}`))
    }
    await expectFailure(pool,'schema_catalog_mismatch','0403 narrowed capability vocabulary restored',tx=>tx.query(
      `ALTER TABLE public.fractional_crm_gateway_credentials DROP CONSTRAINT fractional_crm_gateway_credentials_capabilities_check,
       ADD CONSTRAINT fractional_crm_gateway_credentials_capabilities_check CHECK (capabilities <@ ARRAY[
       'crm.company.read','crm.contact.read','crm.company.write','crm.contact.write','crm.onboarding.write']::text[])`))
    for(const [label,capabilities] of [
      ['drops previously granted product read',GATEWAY_CURRENT_CAPABILITIES.filter(cap=>cap!=='crm.product.read')],
      ['drops reviewed folder publication',GATEWAY_CURRENT_CAPABILITIES.filter(cap=>cap!=='crm.customer-folder.write')],
      ['adds unreviewed product writes',[...GATEWAY_CURRENT_CAPABILITIES,'crm.product.write']],
      ['skips validation of existing grants',null],
    ]){
      const definition=capabilities?`CHECK (capabilities <@ ARRAY[${capabilities.map(cap=>`'${cap}'`).join(',')}]::text[])`
        :`${capabilityCheck.definition} NOT VALID`
      await expectFailure(pool,'schema_catalog_mismatch',`v21 capability CHECK ${label}`,tx=>tx.query(
        `ALTER TABLE ${GATEWAY_CREDENTIALS} DROP CONSTRAINT ${GATEWAY_CAPABILITY_CONSTRAINT};
         ALTER TABLE ${GATEWAY_CREDENTIALS} ADD CONSTRAINT ${GATEWAY_CAPABILITY_CONSTRAINT} ${definition}`))
    }
    await expectFailure(pool,'schema_catalog_mismatch','0405 deferred exact settlement guard removed',tx=>tx.query(
      'DROP TRIGGER crm_legacy_email_require_settlement ON public.crm_native_email_publication_admissions'))
    for(const name of ['crm_native_capability_control_complete','crm_native_initial_control_complete']){
      const trigger=baseline.catalog.triggers.find(t=>t.relation==='public.crm_native_email_publication_control'&&t.name===name)
      await expectFailure(pool,'schema_catalog_mismatch',`0409 ${name} eligibility predicate replaced`,async tx=>{
        await tx.query(`DROP TRIGGER ${name} ON public.crm_native_email_publication_control`)
        await tx.query(trigger.definition.replace(/ WHEN \([\s\S]*\) EXECUTE FUNCTION /,' WHEN (false) EXECUTE FUNCTION '))
      })
    }
    await expectFailure(pool,'schema_catalog_mismatch','0411 archive disposition default permits unreviewed recovery',tx=>tx.query(
      "ALTER TABLE crm_legacy_email_retirement.verified_batch ALTER COLUMN publication_disposition SET DEFAULT 'reviewed_recovery'"))
    await expectFailure(pool,'schema_catalog_mismatch','0411 archive disposition validation removed',tx=>tx.query(
      'ALTER TABLE crm_legacy_email_retirement.verified_batch DROP CONSTRAINT crm_legacy_email_retirement_publication_disposition'))
    await expectFailure(pool,'schema_catalog_mismatch','0411 archive disposition NULL bypass',tx=>tx.query(
      'ALTER TABLE crm_legacy_email_retirement.verified_batch ALTER COLUMN publication_disposition DROP NOT NULL'))
    await expectFailure(pool,'schema_catalog_mismatch','0411 disposition stage guard removed',tx=>tx.query(
      'DROP TRIGGER crm_legacy_email_stage_reviewed_disposition ON public.crm_legacy_email_recovery_stages'))
    for(const privilege of ['USAGE','CREATE'])await expectFailure(pool,'schema_catalog_mismatch',`Private schema PUBLIC ${privilege} drift`,tx=>tx.query(
      `GRANT ${privilege} ON SCHEMA crm_legacy_email_retirement TO PUBLIC`))
    await expectFailure(pool,'schema_catalog_mismatch','Private schema owner drift',async tx=>{
      await tx.query('CREATE ROLE private_recovery_schema_drift_owner NOLOGIN')
      await tx.query('ALTER SCHEMA crm_legacy_email_retirement OWNER TO private_recovery_schema_drift_owner')
    })

    const initialFunctionIdentities=[...new Set(INITIAL_ENROLLMENT_TRIGGERS.map(([, , ,fn])=>`public.${fn}()`))]
      .filter(identity=>identity.startsWith('public.clawpilot_crm_native_initial_'))
    for(const identity of [...PRODUCTION_REBIND_CRM_GUARD_HELPERS,...initialFunctionIdentities]
      .filter(identity=>!CALENDAR_OCCURRENCE_FUNCTIONS.includes(identity))){
      const [schema,name]=identity.split('(')[0].split('.')
      const fn=baseline.catalog.functions.find(f=>f.schema===schema&&f.name===name)
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
    await expectFailure(pool,'schema_catalog_mismatch','0401 historical owner-source bypass restored',tx=>tx.query(
      historical.rootOwnerBeforeDefinition))
    await expectFailure(pool,'schema_catalog_mismatch','0401 owner-source PUBLIC execution drift',tx=>tx.query(
      `GRANT EXECUTE ON FUNCTION ${ROOT_OWNER_SOURCE_FENCE_HELPER} TO PUBLIC`))
    await expectFailure(pool,'schema_catalog_mismatch','0401 owner-source SECURITY DEFINER drift',tx=>tx.query(
      `ALTER FUNCTION ${ROOT_OWNER_SOURCE_FENCE_HELPER} SECURITY DEFINER`))
    await expectFailure(pool,'schema_object_missing','0401 missing owner-source helper',tx=>tx.query(
      `DROP FUNCTION ${ROOT_OWNER_SOURCE_FENCE_HELPER}`))
    await expectFailure(pool,'schema_catalog_mismatch','0402 old global app-only sharing hold restored',tx=>tx.query(
      historical.appOnlyBeforeDefinition))
    for(const [identity,expected] of UNMANAGED_PIPELINE_HELPERS){
      await expectFailure(pool,'schema_object_missing',`0402 missing ${identity}`,tx=>tx.query(`DROP FUNCTION ${identity}`))
      for(const [label,alteration] of [['PUBLIC execution',null],['SECURITY DEFINER','SECURITY DEFINER'],
        ['NULL handling','STRICT'],['search path','SET search_path=public,pg_catalog'],
        ['volatility',expected.volatility==='v'?'STABLE':'VOLATILE']]){
        await expectFailure(pool,'schema_catalog_mismatch',`0402 ${identity} ${label} drift`,tx=>tx.query(alteration
          ?`ALTER FUNCTION ${identity} ${alteration}`:`GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC`))
      }
    }
    for(const relation of UNMANAGED_PIPELINE_RELATIONS){
      await expectFailure(pool,'schema_object_missing',`0402 missing footprint relation ${relation}`,tx=>tx.query(`DROP TABLE ${relation} CASCADE`))
      await expectFailure(pool,'schema_catalog_mismatch',`0402 ${relation} PUBLIC read drift`,tx=>tx.query(`GRANT SELECT ON ${relation} TO PUBLIC`))
      const column=relation==='public.workspace_tenant_retirement_receipts'?'suitecrm_records'
        :['public.crm_inbound_message_links','public.crm_integration_action_attempts'].includes(relation)?'id':'pipeline_id'
      const actualColumn=relation==='public.crm_inbound_message_links'?'inbound_message_id':column
      await expectFailure(pool,'schema_catalog_mismatch',`0402 ${relation}.${actualColumn} removed`,tx=>tx.query(
        `ALTER TABLE ${relation} DROP COLUMN ${actualColumn} CASCADE`))
    }
    await expectFailure(pool,'schema_catalog_mismatch','0402 inbound footprint lookup index removed',tx=>tx.query(
      'DROP INDEX public.idx_crm_inbound_messages_pipeline_time'))
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

    const focusedLedgerTamper=new Set([CALENDAR_OCCURRENCE_MIGRATION,...HELD_ORIGINAL_MIGRATIONS.map(m=>m.filename)])
    for (const expected of PRODUCTION_REBIND_SCHEMA_MIGRATIONS) {
      if(focusedLedgerTamper.has(expected.filename)) continue // Covered by focused tamper probes.
      await expectLedgerFailure(pool, expected.filename)
    }
    await expectLedgerFailure(pool, REVIEWED_COMPANY_MIGRATION, true)
    await expectLedgerFailure(pool, FRACTIONAL_PRODUCT_MIGRATION, true)
    await expectLedgerFailure(pool, INITIAL_ENROLLMENT_MIGRATION, true)
    await expectLedgerFailure(pool, INITIAL_DEMO_QUARANTINE_MIGRATION, true)
    await expectLedgerFailure(pool, ROOT_OWNER_SOURCE_FENCE_MIGRATION, true)
    for(const migration of PRODUCTION_REBIND_SCHEMA_MIGRATIONS.filter(m=>Number(m.filename.slice(0,4))>=403
      &&!focusedLedgerTamper.has(m.filename)))
      await expectLedgerFailure(pool,migration.filename,true)

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
  const args=process.argv.slice(2)
  assert.ok(args.length===0||(args.length===1&&['--diagnostic-current-schema','--check-calendar-schema-delta',
    '--check-held-original-schema-delta','--check-maintenance-schema-delta'].includes(args[0])),
    'Unknown schema test arguments')
  const diagnosticOnly=args[0]==='--diagnostic-current-schema'
  const calendarDeltaOnly=args[0]==='--check-calendar-schema-delta'
  const heldOriginalDeltaOnly=args[0]==='--check-held-original-schema-delta'
  const maintenanceDeltaOnly=args[0]==='--check-maintenance-schema-delta'
  for (const image of images) await exerciseImage(image,{diagnosticOnly,calendarDeltaOnly,heldOriginalDeltaOnly,maintenanceDeltaOnly})
  console.log(diagnosticOnly?'Disposable v22 diagnostics only; no current schema acceptance performed'
    :calendarDeltaOnly?`0412 focused schema delta passed (${images.join(', ')})`
    :heldOriginalDeltaOnly?`0413–0417 focused schema delta passed (${images.join(', ')})`
    :maintenanceDeltaOnly?`0418 focused schema delta passed (${images.join(', ')})`
    :`production rebind target schema attestation passed (${images.join(', ')})`)
}
