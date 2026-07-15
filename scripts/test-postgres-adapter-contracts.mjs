#!/usr/bin/env node
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  assert.ok(source.includes(needle), `${label} missing ${needle}`)
}

const migration = read('db/migrations/0001_initial_railway_postgres.sql')
for (const table of [
  'execution_runs',
  'execution_results',
  'pipeline_sheet_rows',
  'sync_outbox',
  'audit_events',
]) {
  assertIncludes(migration, `CREATE TABLE IF NOT EXISTS ${table}`, 'initial migration')
}

const outboxMigration = read('db/migrations/0002_pipeline_outbox_worker.sql')
for (const column of ['idempotency_key', 'locked_at', 'lock_token', 'updated_at']) {
  assertIncludes(outboxMigration, column, 'pipeline outbox worker migration')
}

const authMigration = read('db/migrations/0003_auth_magic_codes.sql')
for (const column of ['code_digest', 'attempts', 'expires_at', 'consumed_at']) {
  assertIncludes(authMigration, column, 'auth magic-code migration')
}

const usersMigration = read('db/migrations/0005_app_users.sql')
for (const column of ['email text PRIMARY KEY', 'role text NOT NULL', 'status text NOT NULL', 'invited_by text']) {
  assertIncludes(usersMigration, column, 'app users migration')
}

const usersAdapter = read('app_src/lib/users.ts')
assertIncludes(usersAdapter, 'ensureOwnerUser', 'app users adapter')
assertIncludes(usersAdapter, 'inviteAppUser', 'app users adapter')
assertIncludes(usersAdapter, 'canInviteUsers', 'app users adapter')
assertIncludes(usersAdapter, "current?.status === 'disabled'", 'disabled user restore authorization')
assertIncludes(usersAdapter, 'Restore the disabled user before sending a new invitation', 'disabled user invitation boundary')
assertIncludes(usersAdapter, 'updateAppUserProfile', 'app users adapter')
assertIncludes(usersAdapter, "UPDATE workspace_organizations", 'atomic profile organization update')
assertIncludes(usersAdapter, "'pipeline:' || pipeline.id::text || ':provision'", 'profile Drive reconciliation enqueue')
assertIncludes(usersAdapter, 'updateAppUserAccess', 'app users adapter')
assertIncludes(usersAdapter, 'AppUserAuthorizationError', 'app user authorization errors')
assertIncludes(usersAdapter, 'AppUserNotFoundError', 'app user not-found errors')

const usersRoute = read('app_src/app/api/users/route.ts')
assertIncludes(usersRoute, 'userMutationErrorStatus', 'app user mutation status mapping')
assertIncludes(usersRoute, 'return 403', 'app user authorization HTTP status')
assertIncludes(usersRoute, 'return 404', 'app user not-found HTTP status')

const tenancyMigration = read('db/migrations/0007_multi_tenant_workspaces.sql')
for (const table of ['project_boards', 'project_board_members', 'pipeline_spaces', 'pipeline_space_members']) {
  assertIncludes(tenancyMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'multi-tenant migration')
}

const workspaceSecurityMigration = read('db/migrations/0008_workspace_security_hardening.sql')
assertIncludes(workspaceSecurityMigration, 'idx_pipeline_spaces_single_sync_source', 'workspace security migration')
assertIncludes(workspaceSecurityMigration, 'app_users_permissions_object', 'workspace security migration')
const agentDispatchMigration = read('db/migrations/0009_agent_dispatch_outbox.sql')
assertIncludes(agentDispatchMigration, 'idx_sync_outbox_agent_dispatch_due', 'agent dispatch migration')
assertIncludes(agentDispatchMigration, "target_system = 'agent_runtime'", 'agent dispatch migration')
for (const field of ['display_name', 'permissions jsonb', 'board_id uuid']) {
  assertIncludes(tenancyMigration, field, 'multi-tenant migration')
}

const invitationMigration = read('db/migrations/0010_user_invitations.sql')
assertIncludes(invitationMigration, 'CREATE TABLE IF NOT EXISTS app_user_invitations', 'invitation migration')
assertIncludes(invitationMigration, "purpose text NOT NULL DEFAULT 'sign_in'", 'invitation-purpose auth migration')
assertIncludes(invitationMigration, 'invitation_id uuid REFERENCES app_user_invitations', 'invitation-bound auth migration')

const knowledgeMigration = read('db/migrations/0011_knowledge_releases_checkpoints.sql')
for (const table of ['app_documents', 'release_entries', 'data_checkpoints']) {
  assertIncludes(knowledgeMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'knowledge and release migration')
}
assertIncludes(knowledgeMigration, 'search_vector tsvector GENERATED ALWAYS', 'document search migration')

const hardeningMigration = read('db/migrations/0012_invitation_release_hardening.sql')
assertIncludes(hardeningMigration, 'idx_app_user_invitations_one_active', 'single active invitation migration')
assertIncludes(hardeningMigration, 'ADD COLUMN IF NOT EXISTS release_key', 'release deployment identity migration')
assertIncludes(hardeningMigration, 'idx_release_entries_environment_key', 'release deployment identity migration')
const invitationDeliveryMigration = read('db/migrations/0013_invitation_delivery_coordination.sql')
assertIncludes(invitationDeliveryMigration, 'supersedes_id', 'invitation delivery coordination migration')
const invitationPendingMigration = read('db/migrations/0014_invitation_delivery_pending.sql')
assertIncludes(invitationPendingMigration, 'delivery_pending_at', 'invitation pending delivery migration')
assertIncludes(invitationPendingMigration, 'idx_app_user_invitations_one_delivery_pending', 'single pending invitation delivery')

const shortLinksMigration = read('db/migrations/0015_short_links.sql')
for (const table of ['short_links', 'short_link_clicks']) {
  assertIncludes(shortLinksMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'short-link migration')
}
assertIncludes(shortLinksMigration, "destination_url ~ '^https://'", 'HTTPS-only short-link destinations')
assertIncludes(shortLinksMigration, 'max_clicks', 'short-link click limits')

const vectorKnowledgeMigration = read('db/migrations/0016_document_vectors_and_ai_radar.sql')
for (const table of ['document_embedding_jobs', 'ai_radar_items', 'knowledge_worker_heartbeat']) {
  assertIncludes(vectorKnowledgeMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'vector knowledge migration')
}
const shortLinkHardeningMigration = read('db/migrations/0017_short_link_destination_hardening.sql')
const shortLinkPreflightMigration = read('db/migrations/0016_z_short_link_destination_preflight.sql')
assertIncludes(shortLinkPreflightMigration, "destination_url !~ '^https://'", 'legacy short-link destination preflight')
assertIncludes(shortLinkHardeningMigration, "destination_url ~ '^https://'", 'HTTPS-only short-link destination migration')
assertIncludes(shortLinkHardeningMigration, "WHERE status = 'processing'", 'stale embedding lease index')
assertIncludes(vectorKnowledgeMigration, 'CREATE EXTENSION IF NOT EXISTS vector', 'pgvector extension')
assertIncludes(vectorKnowledgeMigration, 'embedding vector(256)', 'document vectors')

const managedPipelineMigration = read('db/migrations/0019_managed_pipeline_google_resources.sql')
for (const contract of [
  'DROP INDEX IF EXISTS idx_pipeline_spaces_single_sync_source',
  'idx_pipeline_spaces_sheet_id_unique',
  'CREATE TABLE IF NOT EXISTS google_workspace_integration',
  'api_key_ciphertext',
  'service_account_ciphertext',
  'google_service_account_email',
  'google_shared_drive_id',
  'provisioning_status',
  'drive_folder_id',
  'short_link_id',
  'CREATE TABLE IF NOT EXISTS pipeline_google_permissions',
]) {
  assertIncludes(managedPipelineMigration, contract, 'managed pipeline Google resources migration')
}
assert.ok(!managedPipelineMigration.includes('maton_drive_connection_id'), 'managed pipeline migration must not bind Maton Drive')
assert.ok(!managedPipelineMigration.includes('maton_sheets_connection_id'), 'managed pipeline migration must not bind Maton Sheets')

const crmMigration = read('db/migrations/0020_crm_gateway_and_reporting.sql')
for (const table of ['crm_organizations', 'crm_contacts', 'crm_opportunities', 'crm_interactions', 'crm_sync_runs']) {
  assertIncludes(crmMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'CRM gateway migration')
}
assertIncludes(crmMigration, "target_system = 'suitecrm'", 'SuiteCRM outbox migration')
assertIncludes(crmMigration, 'crm_projection_version', 'CRM workbook projection version')

const crmIdentityHierarchyMigration = read('db/migrations/0021_crm_identity_and_organization_hierarchy.sql')
for (const contract of [
  'CREATE TABLE IF NOT EXISTS workspace_organizations',
  'ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES workspace_organizations',
  'ADD COLUMN IF NOT EXISTS workspace_organization_id uuid REFERENCES workspace_organizations',
  'ADD COLUMN IF NOT EXISTS identity_key text',
  'ADD COLUMN IF NOT EXISTS parent_organization_id uuid REFERENCES crm_organizations',
  'idx_crm_organizations_identity',
  'idx_crm_contacts_identity',
]) {
  assertIncludes(crmIdentityHierarchyMigration, contract, 'CRM identity and organization hierarchy migration')
}

const pipelineSheetLinksMigration = read('db/migrations/0022_pipeline_sheet_access_links.sql')
for (const contract of [
  "'https://docs.google.com/spreadsheets/d/'",
  "ARRAY['pipeline', 'google-sheet']",
  "'pipeline.sheet_link.backfilled'",
  'A ready pipeline is missing its Sheet short link',
]) {
  assertIncludes(pipelineSheetLinksMigration, contract, 'pipeline Sheet access-link migration')
}

const invitationAdapter = read('app_src/lib/invitations.ts')
assertIncludes(invitationAdapter, 'requestInvitationAuthMagicCode', 'invitation adapter')
assertIncludes(invitationAdapter, 'revoked_at IS NULL', 'invitation revocation contract')
assertIncludes(invitationAdapter, 'FOR UPDATE', 'invitation issuance serialization')
assertIncludes(invitationAdapter, 'INVITATION_DELIVERY_STALE_MINUTES', 'invitation delivery serialization')
assertIncludes(invitationAdapter, 'supersedes_id', 'invitation rollback chain')
assertIncludes(invitationAdapter, 'delivery_pending_at', 'invitation two-phase delivery')
assertIncludes(invitationAdapter, 'markInvitationDelivered', 'invitation activation after delivery')
const magicCodeAdapter = read('app_src/lib/authMagicCode.ts')
assertIncludes(magicCodeAdapter, "user.status !== 'active'", 'ordinary sign-in active-user requirement')
assertIncludes(magicCodeAdapter, 'requestInvitationAuthMagicCode', 'invitation-purpose sign-in')
assertIncludes(magicCodeAdapter, 'UPDATE app_user_invitations', 'atomic invitation acceptance')
assertIncludes(magicCodeAdapter, 'AUTHORIZATION_CHANGED', 'invitation authorization rollback')

const documentsAdapter = read('app_src/lib/documents.ts')
assertIncludes(documentsAdapter, 'WHERE owner_email = $1', 'user-scoped document reads')
assertIncludes(documentsAdapter, "sourceKey: 'system:build-brief'", 'generated build brief')
assertIncludes(documentsAdapter, "sourceKey: 'system:project-brief'", 'generated project brief')
assertIncludes(documentsAdapter, "sourceKey: 'system:pipeline-brief'", 'generated pipeline brief')
assertIncludes(documentsAdapter, 'document.content', 'local full-document search')
assertIncludes(documentsAdapter, 'document_embedding_jobs', 'document embedding enqueue')
assertIncludes(documentsAdapter, 'listAiRadarItems', 'AI Radar generated brief')
assertIncludes(documentsAdapter, 'pipelineSourceLabel', 'human-readable pipeline brief source')
assertIncludes(documentsAdapter, 'embedding <=> $3::vector', 'hybrid semantic document search')
assertIncludes(documentsAdapter, 'embedding_model = $4', 'same-model semantic document search')

const matonCredentialAdapter = read('app_src/lib/persistence/matonCredentials.ts')
assertIncludes(matonCredentialAdapter, 'selectedConnectionIds', 'platform Maton connection preservation')

const embeddingsAdapter = read('app_src/lib/documentEmbeddings.ts')
assertIncludes(embeddingsAdapter, "model: config.model", 'embedding model reporting')
assertIncludes(embeddingsAdapter, 'FOR UPDATE SKIP LOCKED', 'embedding job leases')
assertIncludes(embeddingsAdapter, 'clawpilot-hash-vector-v1', 'default local vector model')
assertIncludes(embeddingsAdapter, 'ensureJobsForModel', 'embedding model upgrade queue')
assertIncludes(embeddingsAdapter, 'OPENAI_EMBEDDING_API_KEY', 'dedicated external embedding credential')
assertIncludes(embeddingsAdapter, "jobs.status = 'processing'", 'stale embedding job recovery')
assertIncludes(embeddingsAdapter, 'jobs.locked_at = $5::timestamptz', 'embedding lease ownership')

const shortLinksAdapter = read('app_src/lib/shortlinks.ts')
assertIncludes(shortLinksAdapter, 'SHORTLINK_SERVICE_CLIENTS_JSON', 'source-bound short-link service clients')
assertIncludes(shortLinksAdapter, "url.protocol !== 'https:'", 'short-link destination transport security')
assertIncludes(shortLinksAdapter, 'FOR UPDATE', 'atomic short-link click limits')
assertIncludes(shortLinksAdapter, 'NOT $4::boolean OR source_app = $5', 'service source isolation')
assertIncludes(shortLinksAdapter, 'organization_root_id = $10::uuid', 'organization-scoped short-link visibility')
assertIncludes(shortLinksAdapter, '$2::boolean OR NOT $8::boolean', 'same-organization interactive link visibility')
assertIncludes(shortLinksAdapter, 'workspaceOrganizationRootId', 'short-link tenant root resolution')

const tenancyAdapter = read('app_src/lib/tenancy.ts')
assertIncludes(tenancyAdapter, 'ensureDefaultResourcesForUser', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'resolveProjectBoardAccess', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'resolvePipelineSpaceAccess', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'Only the board owner can share it', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'Only the pipeline owner can share it', 'tenancy adapter')

const taskAdapter = read('app_src/lib/persistence/tasks.ts')
assertIncludes(taskAdapter, 'WHERE board_id = $1::uuid', 'board-scoped task reads')
assertIncludes(taskAdapter, 'DELETE FROM tasks WHERE board_id = $1::uuid', 'board-scoped task writes')
assertIncludes(taskAdapter, 'insertAgentDispatchOutbox', 'atomic task and agent dispatch writes')

const agentDispatchAdapter = read('app_src/lib/persistence/agentDispatch.ts')
assertIncludes(agentDispatchAdapter, "const TARGET_SYSTEM = 'agent_runtime'", 'agent dispatch adapter')
assertIncludes(agentDispatchAdapter, 'ON CONFLICT (target_system, idempotency_key)', 'agent dispatch idempotency')
assertIncludes(agentDispatchAdapter, 'FOR UPDATE SKIP LOCKED', 'agent dispatch leased claims')
assertIncludes(agentDispatchAdapter, 'agent worker lease expired', 'agent dispatch lease recovery')
assertIncludes(agentDispatchAdapter, 'agent.dispatch.worker.heartbeat', 'agent dispatch worker heartbeat')

const executionAdapter = read('app_src/lib/persistence/execution.ts')
assertIncludes(executionAdapter, 'INSERT INTO execution_runs', 'execution adapter')
assertIncludes(executionAdapter, 'INSERT INTO execution_results', 'execution adapter')
assertIncludes(executionAdapter, "payload->>'runId'", 'execution adapter')
assertIncludes(executionAdapter, 'ORDER BY created_at DESC, id DESC', 'execution adapter')
assertIncludes(executionAdapter, 'operator_id = $1', 'operator-scoped execution reads')
assertIncludes(executionAdapter, 'board_id = $2::uuid', 'board-scoped execution reads')

const pipelineAdapter = read('app_src/lib/persistence/pipeline.ts')
assertIncludes(pipelineAdapter, 'INSERT INTO pipeline_sheet_rows', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'DELETE FROM pipeline_sheet_rows', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'INSERT INTO sync_outbox', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'INSERT INTO audit_events', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'pipeline.normalized.current', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'FOR UPDATE SKIP LOCKED', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'worker lease expired', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'superseded by newer outbox item', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'upsertPipelineDropdownCatalogAndEnqueueInPostgres', 'pipeline adapter')
assertIncludes(pipelineAdapter, 'pipeline.outbox.worker.heartbeat', 'pipeline adapter')
assertIncludes(pipelineAdapter, "'provision_pipeline', 'google_workspace'", 'pipeline provisioning outbox')
assertIncludes(pipelineAdapter, "'sync_pipeline_permissions'", 'pipeline permission outbox')
assertIncludes(pipelineAdapter, 'google_service_account_email = COALESCE', 'immutable service-account binding')
assertIncludes(pipelineAdapter, 'google_shared_drive_id = COALESCE', 'immutable Shared Drive binding')
assertIncludes(pipelineAdapter, 'Pipeline Google Workspace binding cannot be changed', 'managed binding immutability')
assertIncludes(pipelineAdapter, 'FROM google_workspace_integration', 'queue-time platform integration validation')
assertIncludes(pipelineAdapter, 'FOR SHARE', 'queue-time credential and binding serialization')
assertIncludes(
  pipelineAdapter,
  "target_system IN ('google_sheets', 'google_workspace', 'google_workspace_v2', 'google_workspace_v3', 'google_workspace_v4', 'google_workspace_v5', 'google_workspace_v6', 'pipeline_internal_v1')",
  'managed workspace outbox claims',
)
assertIncludes(pipelineAdapter, 'resolvePipelineSheetBindingInPostgres', 'validated pipeline Sheet binding resolver')
assertIncludes(pipelineAdapter, "item.operation === 'reconcile_pipeline_hierarchy_v6'", 'superseded Drive cleanup finalization')
assertIncludes(pipelineAdapter, 'pipeline.owner_email !== configuredOwner', 'configured-owner legacy fallback boundary')
assertIncludes(pipelineAdapter, 'AND sheet_id = $2', 'pipeline and Sheet pair isolation')

const pipelineProvisioning = read('app_src/lib/pipelineProvisioning.ts')
assert.ok(!pipelineProvisioning.includes('maton'), 'managed provisioning must not use Maton')
assertIncludes(pipelineProvisioning, 'resolveManagedGoogleWorkspaceRuntime', 'native managed binding validation')
assertIncludes(pipelineProvisioning, "appPropertyClause", 'Drive appProperties discovery')
assertIncludes(pipelineProvisioning, "corpora: 'drive'", 'Shared Drive scoped file search')
assertIncludes(pipelineProvisioning, "includeItemsFromAllDrives: 'true'", 'Shared Drive file inclusion')
assertIncludes(pipelineProvisioning, "supportsAllDrives: 'true'", 'Shared Drive request support')
assertIncludes(pipelineProvisioning, "idempotent: false", 'non-retried ambiguous Google creates')
assertIncludes(pipelineProvisioning, 'ensurePipelineShortLink(pipeline, pipeline.sheetId)', 'ready pipeline Sheet-link repair')
assertIncludes(pipelineProvisioning, "const EXPECTED_TABS", 'managed pipeline tab contract')
assertIncludes(pipelineProvisioning, "range: `'${title}'!B4`", 'managed pipeline B4 headers')
for (const tab of ['Start Here', 'Calculations', 'Dashboard']) {
  assertIncludes(pipelineProvisioning, `'${tab}'`, 'managed CRM workbook tab contract')
}
assertIncludes(pipelineProvisioning, 'addProtectedRange', 'managed CRM workbook protections')
assertIncludes(pipelineProvisioning, "title !== 'Opportunities'", 'Opportunities-only workbook input boundary')
assertIncludes(pipelineProvisioning, 'createShortLink', 'managed pipeline short link')
assertIncludes(pipelineProvisioning, 'reconcilePipelineGooglePermissions', 'managed Google permission reconciliation')
assertIncludes(pipelineProvisioning, 'nextPageToken,permissions', 'permission pagination')
assertIncludes(pipelineProvisioning, "['anyone', 'domain', 'group']", 'direct broad permission rejection')
assertIncludes(pipelineProvisioning, 'permissionIsInherited', 'Shared Drive governing permission preservation')
assertIncludes(pipelineProvisioning, "`hierarchy:${managedEnvironmentName()}`", 'serialized Drive hierarchy reconciliation')
assertIncludes(pipelineProvisioning, 'workspaceOrganizationId: identity.workspaceOrganizationId', 'canonical Drive organization identity')
assertIncludes(pipelineProvisioning, 'appUserReferenceCode: identity.contactReferenceCode', 'canonical Drive contact identity')
assertIncludes(pipelineProvisioning, 'GOOGLE_PIPELINE_FOLDER_MOVE_UNVERIFIED', 'verified Drive folder moves')

const legacyPipelineWorkbook = read('app_src/lib/pipelineLegacyWorkbook.ts')
assertIncludes(legacyPipelineWorkbook, 'configurePipelineTabsWithRequest', 'legacy Maton workbook layout parity')

const pipelineSync = read('app_src/lib/pipelineSync.ts')
assertIncludes(pipelineSync, 'resolvePipelineSheetBindingInPostgres', 'pipeline pull binding resolution')
assertIncludes(pipelineSync, 'resolveManagedGoogleWorkspaceRuntime', 'pipeline pull native binding resolution')
assertIncludes(pipelineSync, 'googleSheetsJson', 'pipeline pull native Sheets transport')
assertIncludes(pipelineSync, 'binding.legacyOwnerFallback', 'pipeline pull legacy transport boundary')
assertIncludes(pipelineSync, "opportunities: 'Opportunities!A5:M2000'", 'stable opportunity record identifiers')
assertIncludes(pipelineSync, 'stageCrmRecordInPostgres', 'opportunity Sheet to CRM staging')

const crmAdapter = read('app_src/lib/persistence/crm.ts')
assertIncludes(crmAdapter, 'stageCrmRecordInPostgres', 'CRM projection adapter')
assertIncludes(crmAdapter, "target_system, payload", 'CRM outbox persistence')
assertIncludes(crmAdapter, "'upsert_record', 'suitecrm'", 'SuiteCRM outbox target')
assertIncludes(crmAdapter, "operation IN ('upsert_record', 'delete_record')", 'SuiteCRM deletion outbox claims')
assertIncludes(crmAdapter, 'ensurePipelineCrmHierarchy', 'workspace organization CRM hierarchy')
assertIncludes(crmAdapter, 'ON CONFLICT (pipeline_id, identity_key)', 'natural CRM identity upserts')
assertIncludes(crmAdapter, "$23, $24, $25::jsonb, $26,\n        'pending', NULL, $27, $27", 'CRM contact insert bindings')
assert.ok(
  !crmAdapter.includes("$24, $25, $26::jsonb, $27,\n        'pending', NULL, $28, $28"),
  'CRM contact insert must not provide more expressions than target columns',
)
assertIncludes(crmAdapter, 'FOR UPDATE SKIP LOCKED', 'SuiteCRM leased outbox claims')
assertIncludes(crmAdapter, 'pipeline_id = $1::uuid', 'pipeline-scoped CRM reads')
assertIncludes(crmAdapter, 'readCrmWorkbookProjectionReadiness', 'reconciliation-gated CRM workbook projection')
assertIncludes(crmAdapter, "importStatus === 'succeeded'", 'successful source reconciliation projection gate')
assertIncludes(crmAdapter, 'syncAppUserProfileToOwnedPipelines', 'all owned pipeline profile projection')
assertIncludes(crmAdapter, 'syncPipelineOwnerProfileToCrm', 'pipeline owner profile backfill projection')
assertIncludes(crmAdapter, 'CRM profile synchronization requires an owned pipeline', 'profile projection ownership boundary')
assertIncludes(crmAdapter, 'appUserReferenceCode: user.referenceCode', 'canonical app-user CRM contact identity')

const crmModulesMigration = read('db/migrations/0023_crm_modules_references_and_integrations.sql')
assertIncludes(crmModulesMigration, 'workspace_organizations_reference_code_unique', 'canonical workspace organization reference')
assertIncludes(crmModulesMigration, 'app_users_reference_code_unique', 'canonical app user reference')
assertIncludes(crmModulesMigration, 'UNIQUE (pipeline_id, reference_code)', 'pipeline projection reference uniqueness')
assertIncludes(crmModulesMigration, 'idx_crm_contacts_pipeline_app_user', 'one user contact projection per pipeline')
for (const table of [
  'crm_leads',
  'crm_meetings',
  'crm_campaigns',
  'crm_integration_actions',
  'crm_integration_action_attempts',
  'crm_inbound_messages',
  'crm_inbound_message_links',
]) {
  assertIncludes(crmModulesMigration, `CREATE TABLE IF NOT EXISTS ${table}`, 'CRM module and integration migration')
}

const randomCrmReferencesMigration = read('db/migrations/0030_random_crm_references_and_organization_email.sql')
assertIncludes(randomCrmReferencesMigration, 'CREATE TABLE IF NOT EXISTS crm_reference_registry', 'permanent CRM reference registry')
assertIncludes(randomCrmReferencesMigration, 'allocate_crm_reference', 'random CRM reference allocator')
assertIncludes(randomCrmReferencesMigration, "1000000 + floor(random() * 9000000)", 'seven-digit random CRM suffix')
assertIncludes(randomCrmReferencesMigration, "status = 'alias'", 'legacy CRM reference aliases')
assertIncludes(randomCrmReferencesMigration, 'protect_crm_reference_registry_delete', 'non-reusable CRM reference allocations')
assertIncludes(randomCrmReferencesMigration, 'ADD COLUMN IF NOT EXISTS email text', 'organization email delivery field')

const globalCrmReferenceNumbersMigration = read('db/migrations/0031_global_crm_reference_number_registry.sql')
assertIncludes(globalCrmReferenceNumbersMigration, 'CREATE TABLE IF NOT EXISTS crm_reference_number_registry', 'permanent CRM number registry')
assertIncludes(globalCrmReferenceNumbersMigration, 'ON CONFLICT (number_value) DO NOTHING', 'concurrent CRM number allocation')
assertIncludes(globalCrmReferenceNumbersMigration, 'protect_crm_reference_number_registry_delete', 'immutable CRM number allocation')
assertIncludes(globalCrmReferenceNumbersMigration, 'enforce_crm_reference_number_exclusive_insert', 'cross-module CRM number exclusivity')
assertIncludes(globalCrmReferenceNumbersMigration, 'Current CRM records contain duplicate numeric reference values', 'current CRM number collision guard')

const driveHierarchyMigration = read('db/migrations/0024_versioned_drive_hierarchy_reconciliation.sql')
assertIncludes(driveHierarchyMigration, "'reconcile_pipeline_hierarchy_v2'", 'versioned Drive hierarchy operation')
assertIncludes(driveHierarchyMigration, "'google_workspace_v2'", 'versioned Drive hierarchy worker target')
assertIncludes(driveHierarchyMigration, "'layoutVersion', 2", 'versioned Drive hierarchy payload')

const profileProjectionMigration = read('db/migrations/0025_profile_crm_projection_backfill.sql')
assertIncludes(profileProjectionMigration, "'sync_pipeline_owner_profile_v1'", 'owner profile projection operation')
assertIncludes(profileProjectionMigration, "'pipeline_internal_v1'", 'versioned internal pipeline target')
assertIncludes(profileProjectionMigration, "owner.status = 'active'", 'active owner profile projection boundary')

const driveCleanupMigration = read('db/migrations/0026_legacy_drive_hierarchy_cleanup.sql')
assertIncludes(driveCleanupMigration, "'reconcile_pipeline_hierarchy_v3'", 'legacy Drive cleanup operation')
assertIncludes(driveCleanupMigration, "'google_workspace_v3'", 'legacy Drive cleanup worker target')
assertIncludes(driveCleanupMigration, "'layoutVersion', 3", 'legacy Drive cleanup payload')

const verifiedDriveCleanupMigration = read('db/migrations/0027_verified_legacy_drive_cleanup.sql')
assertIncludes(verifiedDriveCleanupMigration, "'reconcile_pipeline_hierarchy_v4'", 'verified Drive cleanup operation')
assertIncludes(verifiedDriveCleanupMigration, "'google_workspace_v4'", 'verified Drive cleanup worker target')
assertIncludes(verifiedDriveCleanupMigration, "'layoutVersion', 4", 'verified Drive cleanup payload')

const eventualDriveCleanupMigration = read('db/migrations/0028_eventual_drive_cleanup_reconciliation.sql')
assertIncludes(eventualDriveCleanupMigration, "'reconcile_pipeline_hierarchy_v5'", 'eventual Drive cleanup operation')
assertIncludes(eventualDriveCleanupMigration, "'google_workspace_v5'", 'eventual Drive cleanup worker target')
assertIncludes(eventualDriveCleanupMigration, "'layoutVersion', 5", 'eventual Drive cleanup payload')

const verifiedDriveTrashMigration = read('db/migrations/0029_verified_drive_trash_reconciliation.sql')
assertIncludes(verifiedDriveTrashMigration, "'reconcile_pipeline_hierarchy_v6'", 'verified Drive trash operation')
assertIncludes(verifiedDriveTrashMigration, "'google_workspace_v6'", 'verified Drive trash worker target')
assertIncludes(verifiedDriveTrashMigration, "'layoutVersion', 6", 'verified Drive trash payload')
assertIncludes(verifiedDriveTrashMigration, "status = 'succeeded'", 'superseded Drive cleanup terminal state')

const crmIntegrationActions = read('app_src/lib/crm/integrationActions.ts')
for (const action of ['send_email', 'create_calendar_event', 'log_call', 'send_campaign']) {
  assertIncludes(crmIntegrationActions, `'${action}'`, 'CRM integration action')
}
assertIncludes(crmIntegrationActions, 'FOR UPDATE SKIP LOCKED', 'leased CRM integration actions')
assertIncludes(crmIntegrationActions, 'appendTextReplyMarker', 'outbound CRM reply marker')
assertIncludes(crmIntegrationActions, 'appendHtmlReplyMarker', 'outbound CRM HTML reply marker')
assertIncludes(crmIntegrationActions, '`%gslt${normalizeReference(referenceCode)}`', 'exact outbound CRM marker syntax')
assertIncludes(crmIntegrationActions, 'crm_campaign_recipients', 'campaign recipient deduplication')
assertIncludes(crmIntegrationActions, "target.entity !== 'organizations'", 'organization email actions')
assertIncludes(crmIntegrationActions, 'recipientEmail: normalizeEmail(target.email', 'queued CRM recipient snapshot')
assertIncludes(crmIntegrationActions, 'calendarEventIdForAction', 'deterministic Google Calendar event identity')
assertIncludes(crmIntegrationActions, "method: 'PATCH'", 'Google Calendar reschedule update')
assertIncludes(crmIntegrationActions, 'sendUpdates=all', 'Google Calendar attendee notifications')
assertIncludes(crmIntegrationActions, 'parentSuiteCrmType: parentSuiteCrmType || undefined', 'SuiteCRM meeting parent projection')

const crmEmailIngestion = read('app_src/lib/crm/emailIngestion.ts')
assertIncludes(crmEmailIngestion, 'export function truncateEmailImportContent', 'email import boundary')
assertIncludes(crmEmailIngestion, 'content.search(/%xx/i)', 'case-insensitive email import boundary')
assertIncludes(crmEmailIngestion, '/%gslt(g[aciklmo][0-9]{7})(?![A-Za-z0-9_])/gi', 'exact inbound CRM marker syntax')
assertIncludes(crmEmailIngestion, 'if (seen.has(reference)) continue', 'quoted-thread marker deduplication')
assertIncludes(crmEmailIngestion, 'ON CONFLICT (owner_email, external_message_id) DO NOTHING', 'Gmail message deduplication')
assertIncludes(crmEmailIngestion, 'ownedPipelines', 'cross-owned-pipeline marker resolution')
assertIncludes(crmEmailIngestion, 'pipelineId: input.target.pipelineId', 'matched-pipeline interaction staging')
assertIncludes(crmEmailIngestion, "organizations: 'Accounts'", 'organization marker SuiteCRM relationship')
assertIncludes(crmEmailIngestion, "contacts: 'Contacts'", 'contact marker SuiteCRM relationship')

const crmIntegrationWorkerRoute = read('app_src/app/api/crm/integrations/process/route.ts')
assertIncludes(crmIntegrationWorkerRoute, 'processDueCrmIntegrationActions', 'CRM action retry worker')
assertIncludes(crmIntegrationWorkerRoute, 'processInboundGmailIngestion', 'inbound Gmail worker')

const crmActionsRoute = read('app_src/app/api/crm/actions/route.ts')
assertIncludes(crmActionsRoute, 'requireResourceEditor', 'CRM action editor authorization')
assertIncludes(crmActionsRoute, 'idempotency-key', 'CRM action idempotency header')

const crmReferenceRoute = read('app_src/app/crm/[reference]/route.ts')
assertIncludes(crmReferenceRoute, "new URL('/', appPublicUrl())", 'trusted public CRM reference redirect origin')
assertIncludes(crmReferenceRoute, 'resolveCrmReferenceCode', 'legacy CRM reference alias resolution')
assertIncludes(crmReferenceRoute, "destination.searchParams.set('pipeline', pipelineId)", 'CRM reference owning pipeline handoff')

const shortLinks = read('app_src/lib/shortlinks.ts')
assertIncludes(shortLinks, 'normalizeSlug(input.slug, { allowCrmReference: true })', 'public CRM short-link resolution')
assertIncludes(shortLinks, '!options.allowCrmReference && CRM_REFERENCE_SLUG_PATTERN.test(slug)', 'creation-only CRM slug reservation')

const zonedDateTime = read('app_src/lib/zonedDateTime.ts')
assertIncludes(zonedDateTime, 'export function zonedDateTimeToIso', 'timezone-aware CRM meeting conversion')
assertIncludes(zonedDateTime, 'export function dateTimeLocalValue', 'timezone-aware CRM meeting editor value')

const suiteCrmClient = read('app_src/lib/crm/suiteCrmClient.ts')
assertIncludes(suiteCrmClient, '/Api/access_token', 'SuiteCRM OAuth client credentials')
assertIncludes(suiteCrmClient, '/Api/V8/module', 'SuiteCRM JSON API')
assertIncludes(suiteCrmClient, 'deleteSuiteCrmRecord', 'SuiteCRM duplicate deletion')
assertIncludes(suiteCrmClient, "hostname.endsWith('.railway.internal')", 'private Railway SuiteCRM transport')

const crmWorkbookProjection = read('app_src/lib/crm/workbookProjection.ts')
assertIncludes(crmWorkbookProjection, 'projectCrmWorkbook', 'CRM workbook projection')
assertIncludes(crmWorkbookProjection, "'Organizations', 'Contacts', 'Opportunities', 'Interactions'", 'CRM workbook projections')
assertIncludes(crmWorkbookProjection, "'UPDATE pipeline_spaces SET crm_last_synced_at", 'CRM projection checkpoint')
assertIncludes(crmWorkbookProjection, 'waiting for reconciliation', 'CRM projection completeness gate')

const crmWorkbookImport = read('app_src/lib/crm/workbookImport.ts')
assertIncludes(crmWorkbookImport, 'Full Name (First, Last)', 'legacy contact name header mapping')
assertIncludes(crmWorkbookImport, 'CRM workbook import was incomplete', 'CRM import count reconciliation')
assertIncludes(crmWorkbookImport, 'uniqueSourceRecords', 'CRM source duplicate consolidation')
assertIncludes(crmWorkbookImport, 'duplicatesSkipped', 'CRM import duplicate evidence')
assertIncludes(crmWorkbookImport, 'registerReferencedOrganization', 'referenced organization derivation')
assertIncludes(crmWorkbookImport, 'sourceCounts.organizations += derivedOrganizations.size', 'derived organization reconciliation')

const crmWorker = read('app_src/lib/crm/worker.ts')
assertIncludes(crmWorker, 'upsertSuiteCrmRecord', 'SuiteCRM outbox worker')
assertIncludes(crmWorker, 'deleteSuiteCrmRecord', 'SuiteCRM deletion worker')
assertIncludes(crmWorker, "operation: 'project_crm_workbook'", 'CRM to workbook projection enqueue')

const crmPunchoutRoute = read('app_src/app/api/crm/punchout/route.ts')
assertIncludes(crmPunchoutRoute, "actor.role !== 'owner' && actor.role !== 'admin'", 'admin-only native CRM punchout')
assertIncludes(crmPunchoutRoute, 'suiteCrmPublicUrl()', 'validated native CRM destination')
assertIncludes(crmPunchoutRoute, "'Cache-Control': 'no-store'", 'native CRM punchout cache boundary')

const crmRoute = read('app_src/app/api/crm/route.ts')
assertIncludes(crmRoute, 'suiteCrmAdminUsername()', 'admin native CRM username guidance')
assertIncludes(crmRoute, 'suiteCrmAdminPortalUrl()', 'admin native CRM password-management link')

const crmUi = read('app_src/components/crm/CrmSection.tsx')
assertIncludes(crmUi, 'SuiteCRM sign in', 'native CRM access dialog')
assertIncludes(crmUi, 'SUITECRM_ADMIN_PASSWORD', 'native CRM protected password guidance')

const pipelineUi = read('app_src/components/pipeline/PipelineSection.tsx')
assertIncludes(pipelineUi, 'Open Sheet', 'pipeline Sheet command')
assertIncludes(pipelineUi, 'Create Sheet', 'pipeline Sheet setup command')
assertIncludes(pipelineUi, 'Restore Sheet Link', 'pipeline Sheet-link repair command')

const crmHierarchyRoute = read('app_src/app/api/crm/hierarchy/route.ts')
assertIncludes(crmHierarchyRoute, 'updateWorkspaceOrganizationParent', 'admin-managed organization hierarchy')
assertIncludes(crmHierarchyRoute, 'ensurePipelineCrmHierarchy', 'hierarchy propagation to CRM pipelines')

const pipelineDropdownSync = read('app_src/lib/pipelineDropdownSync.ts')
assertIncludes(pipelineDropdownSync, 'resolvePipelineSheetBindingInPostgres', 'dropdown binding resolution')
assertIncludes(pipelineDropdownSync, 'resolveManagedGoogleWorkspaceRuntime', 'dropdown native binding resolution')
assertIncludes(pipelineDropdownSync, 'googleSheetsJson', 'dropdown native Sheets transport')

const opportunityRoute = read('app_src/app/api/pipeline/opportunity/[id]/route.ts')
assertIncludes(opportunityRoute, 'enqueuePipelineSyncOutboxInPostgres', 'opportunity route')
assertIncludes(opportunityRoute, 'upsertPipelineProjectionAndEnqueueInPostgres', 'opportunity route')
assertIncludes(opportunityRoute, "operation: 'append_interaction'", 'opportunity route')
assertIncludes(opportunityRoute, "operation: 'update_opportunity'", 'opportunity route')
assertIncludes(opportunityRoute, 'beforeValues', 'opportunity optimistic write contract')
assertIncludes(opportunityRoute, 'resolvePipelineSpaceAccess', 'opportunity tenancy contract')
assertIncludes(opportunityRoute, 'requireResourceEditor', 'opportunity edit access contract')
assertIncludes(opportunityRoute, 'managedRuntimeForPipelineSheet', 'opportunity direct Sheet binding resolution')
assertIncludes(opportunityRoute, 'googleSheetsJson', 'opportunity direct native Sheet transport')

const outboxWorker = read('app_src/lib/pipelineOutboxWorker.ts')
assertIncludes(outboxWorker, 'claimPipelineSyncOutboxInPostgres', 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'update_opportunity'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'append_interaction'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'replace_dropdowns'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'project_crm_workbook'", 'CRM projection worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'sync_pipeline_owner_profile_v1'", 'owner profile projection worker dispatch')
assertIncludes(outboxWorker, 'Opportunity Sheet row changed', 'pipeline outbox worker optimistic check')
assertIncludes(outboxWorker, '[ClawPilot sync:', 'pipeline outbox worker append idempotency')
assertIncludes(outboxWorker, "item.operation === 'provision_pipeline'", 'pipeline provisioning worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'reconcile_pipeline_hierarchy_v2'", 'versioned Drive hierarchy worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'reconcile_pipeline_hierarchy_v3'", 'legacy Drive cleanup worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'reconcile_pipeline_hierarchy_v4'", 'verified Drive cleanup worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'reconcile_pipeline_hierarchy_v5'", 'eventual Drive cleanup worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'reconcile_pipeline_hierarchy_v6'", 'verified Drive trash worker dispatch')
assertIncludes(outboxWorker, "item.operation === 'sync_pipeline_permissions'", 'pipeline permission worker dispatch')
assertIncludes(outboxWorker, 'resolveManagedGoogleWorkspaceRuntime', 'bound managed pipeline runtime resolution')
assertIncludes(outboxWorker, 'googleSheetsJson', 'bound managed pipeline Sheet writes')
assert.ok(
  outboxWorker.indexOf("item.operation === 'provision_pipeline'")
    < outboxWorker.indexOf('resolvePipelineOutboxSheetContextInPostgres(item)'),
  'pipeline provisioning must dispatch before normal Sheet-context resolution',
)

const workspacesRoute = read('app_src/app/api/workspaces/route.ts')
assertIncludes(workspacesRoute, "action === 'provision-pipeline'", 'owner-confirmed pipeline provisioning action')
assertIncludes(workspacesRoute, "pipeline.accessRole !== 'owner'", 'pipeline provisioning owner access')
assert.ok(!workspacesRoute.includes('driveConnectionId: body'), 'workspace route must not accept a Drive connection binding')
assert.ok(!workspacesRoute.includes('sheetsConnectionId: body'), 'workspace route must not accept a Sheets connection binding')
assertIncludes(workspacesRoute, 'const { projection, sheetId, shortLinkId, ...summary }', 'workspace pipeline resource ID redaction')
assertIncludes(tenancyAdapter, 'enqueuePipelinePermissionSyncWithClient', 'pipeline membership permission synchronization')

const googleWorkspaceCrypto = read('app_src/lib/integrations/googleWorkspaceCrypto.ts')
for (const optionalField of [
  'auth_uri',
  'auth_provider_x509_cert_url',
  'client_x509_cert_url',
  'universe_domain',
]) {
  assertIncludes(googleWorkspaceCrypto, `'${optionalField}'`, 'downloaded service-account JSON support')
}
assertIncludes(googleWorkspaceCrypto, 'aes-256-gcm', 'Google Workspace secret encryption')
assertIncludes(googleWorkspaceCrypto, 'clawpilot:google-workspace:platform:', 'stable Google Workspace encryption AAD')
assertIncludes(googleWorkspaceCrypto, 'Unsupported service-account field:', 'unknown service-account field rejection')

assertIncludes(pipelineProvisioning, 'cleanupLegacyOwnerHierarchy', 'legacy Drive hierarchy discovery cleanup')
assertIncludes(pipelineProvisioning, "fileProperties('users-root'", 'environment-scoped legacy Drive cleanup')
assertIncludes(pipelineProvisioning, 'fields: \'nextPageToken,files(id,parents)\'', 'verified Drive child response shape')
assertIncludes(pipelineProvisioning, 'child.id === folderId', 'Drive folder self-reference rejection')
assertIncludes(pipelineProvisioning, 'child.parents?.includes(folderId)', 'Drive child parent verification')
assertIncludes(pipelineProvisioning, 'waitForDriveChildRemoval', 'eventual Drive cleanup verification')
assertIncludes(pipelineProvisioning, 'trashLegacyDriveFolder', 'Shared Drive legacy folder trashing')
assertIncludes(pipelineProvisioning, "body: { trashed: true }", 'verified Shared Drive trash state')
assertIncludes(pipelineProvisioning, 'GOOGLE_DRIVE_TRASH_UNVERIFIED', 'retryable Drive trash verification error')

const googleWorkspacePersistence = read('app_src/lib/persistence/googleWorkspace.ts')
assertIncludes(googleWorkspacePersistence, 'expectedVersion', 'Google Workspace optimistic persistence')
assertIncludes(googleWorkspacePersistence, 'google_service_account_email IS DISTINCT FROM $1', 'service-account binding immutability')
assertIncludes(googleWorkspacePersistence, 'Disconnect is blocked while managed pipelines are bound', 'managed binding disconnect guard')
assertIncludes(googleWorkspacePersistence, 'WHERE google_service_account_email IS NOT NULL', 'managed pipeline disconnect check')

const googleWorkspaceClient = read('app_src/lib/integrations/googleWorkspaceClient.ts')
assertIncludes(googleWorkspaceClient, "url.searchParams.set('key', apiKey)", 'Google API key quota attribution')
assertIncludes(googleWorkspaceClient, 'Authorization: `Bearer ${token}`', 'service-account OAuth authorization')
assertIncludes(googleWorkspaceClient, "redirect: 'error'", 'native Google redirect rejection')
assertIncludes(googleWorkspaceClient, "cache: 'no-store'", 'native Google cache bypass')
assertIncludes(googleWorkspaceClient, 'readBoundedResponse', 'bounded Google response reading')
assertIncludes(googleWorkspaceClient, "'/discovery/v1/apis/drive/v3/rest'", 'independent API key validation')
assertIncludes(googleWorkspaceClient, 'validateGoogleServiceAccount', 'OAuth Drive service-account validation')
assertIncludes(googleWorkspaceClient, 'clawpilot_google_sheets_api_probe', 'Google Sheets API access validation')
assertIncludes(googleWorkspaceClient, 'GOOGLE_SHEETS_ACCESS_DENIED', 'actionable Google Sheets configuration error')
assertIncludes(googleWorkspaceClient, 'capabilities(canAddChildren,canShare)', 'Shared Drive capability validation')
assertIncludes(googleWorkspaceClient, 'GOOGLE_SHARED_DRIVE_INSUFFICIENT_ACCESS', 'actionable Shared Drive role error')
assertIncludes(googleWorkspaceClient, 'nextPageToken', 'Shared Drive pagination')

const googleWorkspaceIntegration = read('app_src/lib/integrations/googleWorkspace.ts')
const integrationStateBlock = googleWorkspaceIntegration.slice(
  googleWorkspaceIntegration.indexOf('export type GoogleWorkspaceIntegrationState'),
  googleWorkspaceIntegration.indexOf('export class GoogleWorkspaceRequestError'),
)
for (const field of [
  'configured',
  'ready',
  'apiKeyConfigured',
  'apiKeyLastFour',
  'serviceAccountConfigured',
  'projectId',
  'serviceAccountEmail',
  'privateKeyId',
  'credentialVersion',
  'sharedDriveConfigured',
  'sharedDriveName',
  'verifiedAt',
  'updatedAt',
]) {
  assertIncludes(integrationStateBlock, field, 'sanitized Google Workspace state')
}
for (const forbiddenField of ['apiKey:', 'privateKey:', 'selectedSharedDriveId', 'serviceAccountSecret']) {
  assert.ok(!integrationStateBlock.includes(forbiddenField), `sanitized integration state must omit ${forbiddenField}`)
}
assertIncludes(
  googleWorkspaceIntegration,
  'apiKeyConfigured && serviceAccountConfigured && sharedDriveConfigured && Boolean(record.verifiedAt)',
  'complete Google Workspace readiness contract',
)
for (const prerequisiteCode of [
  'GOOGLE_API_KEY_REQUIRED',
  'GOOGLE_SERVICE_ACCOUNT_REQUIRED',
  'GOOGLE_SHARED_DRIVE_REQUIRED',
  'GOOGLE_WORKSPACE_VALIDATION_REQUIRED',
]) {
  assertIncludes(googleWorkspaceIntegration, prerequisiteCode, 'managed provisioning prerequisite error')
}
const updateCredentialBody = googleWorkspaceIntegration.slice(
  googleWorkspaceIntegration.indexOf('export async function updateGoogleWorkspaceCredential'),
  googleWorkspaceIntegration.indexOf('async function configuredRuntime'),
)
assert.ok(
  updateCredentialBody.indexOf('await validateGoogleApiKey')
    < updateCredentialBody.indexOf('await writeGoogleWorkspaceCredentialInPostgres'),
  'API key candidate must validate before persistence',
)
assert.ok(
  updateCredentialBody.indexOf('await validateGoogleServiceAccount')
    < updateCredentialBody.indexOf('await writeGoogleWorkspaceCredentialInPostgres'),
  'service-account candidate must validate before persistence',
)
assert.ok(
  updateCredentialBody.indexOf('validateGoogleSheetsAccess')
    < updateCredentialBody.indexOf('await writeGoogleWorkspaceCredentialInPostgres'),
  'Google Sheets access must validate before persistence',
)
assertIncludes(updateCredentialBody, ': current.apiKeySecret', 'untouched API key ciphertext preservation')
assertIncludes(updateCredentialBody, ': current.serviceAccountSecret', 'untouched service-account ciphertext preservation')
assertIncludes(
  updateCredentialBody,
  'else if (input.setApiKey && effectiveServiceAccount)',
  'API key rotation must revalidate the stored service account and Shared Drive',
)
assertIncludes(pipelineProvisioning, 'await validateGoogleSheetsAccess(runtime)', 'pipeline Sheets preflight')

const googleWorkspaceRoute = read('app_src/app/api/integrations/google-workspace/route.ts')
assertIncludes(googleWorkspaceRoute, "actor.role !== 'owner'", 'owner-only Google Workspace administration')
assertIncludes(googleWorkspaceRoute, 'MAX_REQUEST_BYTES', 'bounded Google Workspace API body')
for (const action of [
  'update-credential',
  'refresh-shared-drives',
  'select-shared-drive',
  'test-connection',
  'disconnect',
]) {
  assertIncludes(googleWorkspaceRoute, `'${action}'`, 'Google Workspace API action')
}
assertIncludes(googleWorkspaceRoute, '{ ok: true, integration', 'Google Workspace success envelope')
assertIncludes(googleWorkspaceRoute, '{ ok: false, error: error.message, code: error.code }', 'Google Workspace error envelope')
assertIncludes(googleWorkspaceRoute, 'requireOnlyFields', 'strict Google Workspace API fields')
assert.ok(!workspacesRoute.includes('googleSharedDriveId'), 'workspace payload must not expose Shared Drive IDs')

const agentDispatchWorker = read('app_src/lib/agentDispatchWorker.ts')
assertIncludes(agentDispatchWorker, 'claimAgentDispatchOutboxInPostgres', 'agent dispatch worker')
assertIncludes(agentDispatchWorker, "path: '/api/agents/threads'", 'agent dispatch execution route')
assertIncludes(agentDispatchWorker, 'createSessionToken(item.operatorId)', 'per-user agent dispatch session')
assertIncludes(agentDispatchWorker, "status === 'dead' ? 'failed' : 'queued'", 'agent dispatch retry visibility')

const pullRoute = read('app_src/app/api/pipeline/sync/pull/route.ts')
assertIncludes(pullRoute, 'syncPipelineFromSheets', 'pipeline pull route')

const railwayStart = read('scripts/start-railway.sh')
assertIncludes(railwayStart, 'pipeline-outbox-poller.mjs', 'Railway start script')
const outboxPoller = read('scripts/pipeline-outbox-poller.mjs')
assertIncludes(outboxPoller, '/api/agents/dispatch/process', 'Railway agent dispatch polling')
assertIncludes(outboxPoller, 'Promise.all', 'independent outbox polling loops')
for (const requiredVariable of [
  'CLAWPILOT_STORAGE',
  'CLAWPILOT_DB_FALLBACK_TO_FILE',
  'CLAWPILOT_EXECUTION_ENABLED',
    'APP_AUTH_REQUIRED',
    'APP_LOGIN_EMAIL',
    'APP_LOGIN_PASSWORD',
  'APP_SESSION_SECRET',
  'AGENT_CREDENTIAL_ENCRYPTION_KEY',
  'AGENT_CREDENTIAL_DATABASE_URL',
    'DATABASE_URL',
    'MATON_API_KEY',
    'MATON_GMAIL_CONNECTION_ID',
    'CLAWPILOT_MAIL_FROM',
    'CLAWPILOT_PUBLIC_URL',
  'PIPELINE_SHEET_ID',
  'PIPELINE_OUTBOX_WORKER_SECRET',
  'CRM_ENABLED',
  'SUITECRM_BASE_URL',
  'SUITECRM_CLIENT_ID',
  'SUITECRM_CLIENT_SECRET',
]) {
  assertIncludes(railwayStart, requiredVariable, 'Railway startup validation')
}

const authProxy = read('app_src/proxy.ts')
assertIncludes(authProxy, 'validSession', 'auth proxy')
assertIncludes(authProxy, 'activeSessionUser', 'disabled-session revocation')
assertIncludes(authProxy, '_next/static', 'auth proxy matcher')
assertIncludes(authProxy, '/api/pipeline/sync/outbox/process', 'auth proxy public worker route')
assertIncludes(authProxy, '/api/agents/dispatch/process', 'auth proxy public agent worker route')
assertIncludes(authProxy, 'HOSTED_RUNTIME', 'auth proxy fail-closed hosted mode')

const loginRoute = read('app_src/app/api/auth/login/route.ts')
assertIncludes(loginRoute, 'MAX_ATTEMPTS', 'login rate limit')
assertIncludes(loginRoute, 'timingSafeEqual', 'login password comparison')
assertIncludes(loginRoute, 'x-clawpilot-operator-secret', 'login automation secret boundary')
assertIncludes(loginRoute, "return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })", 'login automation hidden boundary')

const magicRequestRoute = read('app_src/app/api/auth/magic/request/route.ts')
assertIncludes(magicRequestRoute, 'requestAuthMagicCode', 'magic-code request route')
assertIncludes(magicRequestRoute, 'MAX_REQUESTS', 'magic-code request rate limit')

const magicVerifyRoute = read('app_src/app/api/auth/magic/verify/route.ts')
assertIncludes(magicVerifyRoute, 'verifyAuthMagicCode', 'magic-code verify route')
assertIncludes(magicVerifyRoute, 'createSessionToken', 'magic-code session issuance')

const dispatchBridge = read('app_src/lib/dispatchBridge.ts')
assertIncludes(dispatchBridge, 'execution succeeded but completion telemetry could not be persisted', 'dispatch replay guard')

const healthRoute = read('app_src/app/api/health/route.ts')
assertIncludes(healthRoute, 'readPipelineOutboxWorkerHeartbeatFromPostgres', 'hosted worker health')
assertIncludes(healthRoute, '0002_pipeline_outbox_worker.sql', 'hosted migration health')
assertIncludes(healthRoute, '0003_auth_magic_codes.sql', 'hosted auth migration health')
assertIncludes(healthRoute, '0004_agent_chatgpt_auth.sql', 'hosted agent auth migration health')
assertIncludes(healthRoute, '0005_app_users.sql', 'hosted users migration health')
assertIncludes(healthRoute, '0006_agent_user_attribution.sql', 'hosted attribution migration health')
assertIncludes(healthRoute, '0007_multi_tenant_workspaces.sql', 'hosted workspace migration health')
assertIncludes(healthRoute, '0008_workspace_security_hardening.sql', 'hosted workspace security migration health')
assertIncludes(healthRoute, '0009_agent_dispatch_outbox.sql', 'hosted agent dispatch migration health')
assertIncludes(healthRoute, '0010_user_invitations.sql', 'hosted invitation migration health')
assertIncludes(healthRoute, '0011_knowledge_releases_checkpoints.sql', 'hosted knowledge migration health')
assertIncludes(healthRoute, '0012_invitation_release_hardening.sql', 'hosted release hardening migration health')
assertIncludes(healthRoute, '0013_invitation_delivery_coordination.sql', 'hosted invitation delivery migration health')
assertIncludes(healthRoute, '0014_invitation_delivery_pending.sql', 'hosted invitation pending migration health')
assertIncludes(healthRoute, '0015_short_links.sql', 'hosted short-links migration health')
assertIncludes(healthRoute, '0023_crm_modules_references_and_integrations.sql', 'hosted CRM integrations migration health')
assertIncludes(healthRoute, '0016_document_vectors_and_ai_radar.sql', 'hosted vector knowledge migration health')
assertIncludes(healthRoute, '0016_z_short_link_destination_preflight.sql', 'hosted short-link preflight migration health')
assertIncludes(healthRoute, '0017_short_link_destination_hardening.sql', 'hosted short-link hardening migration health')
assertIncludes(healthRoute, '0020_crm_gateway_and_reporting.sql', 'hosted CRM gateway migration health')
assertIncludes(healthRoute, '0021_crm_identity_and_organization_hierarchy.sql', 'hosted CRM identity hierarchy migration health')
assertIncludes(healthRoute, '0022_pipeline_sheet_access_links.sql', 'hosted pipeline Sheet access-link migration health')
assertIncludes(healthRoute, 'readSuiteCrmWorkerHeartbeat', 'hosted SuiteCRM worker health')
assertIncludes(healthRoute, 'migration_checksums_present', 'hosted migration checksum health')
assertIncludes(healthRoute, 'queryAgentCredentials', 'shared agent credential store health')
assertIncludes(healthRoute, 'readAgentDispatchWorkerHeartbeatFromPostgres', 'hosted agent worker health')
assertIncludes(healthRoute, 'getAgentRuntime', 'hosted agent runtime health')

const agentProvider = read('app_src/lib/agents/provider.ts')
assertIncludes(agentProvider, 'https://api.openai.com/v1/responses', 'OpenAI agent provider')
assertIncludes(agentProvider, 'Execution provider not connected', 'honest agent provider status')

const agentsRoute = read('app_src/app/api/agents/route.ts')
assertIncludes(agentsRoute, "runtime.ready ? 'ready' : 'not connected'", 'agent status route')

const agentThreadsRoute = read('app_src/app/api/agents/threads/route.ts')
assertIncludes(agentThreadsRoute, 'assignmentError(task, agentId)', 'task-bound agent thread contract')
assertIncludes(agentThreadsRoute, 'runOpenAIAgent', 'hosted agent execution route')
assertIncludes(agentThreadsRoute, 'appendExecutionRunToPostgres', 'agent execution run writeback')
assertIncludes(agentThreadsRoute, 'appendExecutionResultToPostgres', 'agent execution result writeback')
assertIncludes(agentThreadsRoute, 'agent-dispatch-${dispatchId}-result', 'idempotent dispatched thread result')

const tasksRoute = read('app_src/app/api/tasks/route.ts')
assert.ok(!tasksRoute.includes('buildGovernanceAdvisory'), 'task route must not create governance advisory mutations')
assertIncludes(tasksRoute, 'TASK_NOT_ACTIONABLE', 'explicit active-task validation')
assertIncludes(tasksRoute, 'prepareAgentDispatch', 'task agent dispatch enqueue')
assertIncludes(tasksRoute, '_agentDispatchState', 'worker-owned dispatch state updates')

const assignmentsRoute = read('app_src/app/api/agents/assignments/route.ts')
assertIncludes(assignmentsRoute, 'prepareAgentDispatch', 'assignment agent dispatch enqueue')
assertIncludes(assignmentsRoute, 'task: tasks[idx]', 'assignment UI task refresh')

const agentsSection = read('app_src/components/agents/AgentsSection.tsx')
assertIncludes(agentsSection, 'setSelectedAgentId(agentId)', 'new assignment agent focus')
assertIncludes(agentsSection, 'setSelectedTaskId(taskId)', 'new assignment task focus')

const migrator = read('scripts/db-migrate.mjs')
assertIncludes(migrator, "pg_advisory_lock(hashtext('clawpilot-schema-migrations'))", 'serialized database migrations')
assertIncludes(migrator, "createHash('sha256')", 'migration checksums')
assertIncludes(migrator, 'migration checksum mismatch', 'migration drift detection')

const vercelConfig = read('app_src/vercel.json')
assertIncludes(vercelConfig, 'npm run build:vercel', 'Vercel deployment migration gate')
const vercelBuild = read('scripts/vercel-build.mjs')
assertIncludes(vercelBuild, "if (environment === 'production')", 'production Vercel deployment gate')
assertIncludes(vercelBuild, "if (branch !== 'main')", 'production Vercel fail-closed branch gate')
assertIncludes(vercelBuild, "environment === 'preview' && branch === 'dev'", 'development Vercel deployment gate')
assertIncludes(vercelBuild, "run('npm', ['run', 'build'], appRoot)", 'Vercel compile-before-migrate ordering')

const versionsRoute = read('app_src/app/api/versions/route.ts')
assertIncludes(versionsRoute, 'getLocalReleaseOverview', 'local release history')

assertIncludes(usersAdapter, "target.status === 'invited'", 'invitation-only user activation')
assertIncludes(usersAdapter, "role === 'member'", 'member permission sanitization')

const typescriptModule = await import(pathToFileURL(resolve(root, 'app_src/node_modules/typescript/lib/typescript.js')).href)
const typescript = typescriptModule.default || typescriptModule
const transpiledCrypto = typescript.transpileModule(googleWorkspaceCrypto, {
  compilerOptions: {
    module: typescript.ModuleKind.ESNext,
    target: typescript.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText
const cryptoContract = await import(`data:text/javascript;base64,${Buffer.from(transpiledCrypto).toString('base64')}#google-workspace-contract`)
const previousEncryptionKey = process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY = 'google-workspace-contract-encryption-key'
try {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const clientEmail = 'clawpilot-drive@logical-bird-344400.iam.gserviceaccount.com'
  const downloadedCredential = {
    type: 'service_account',
    project_id: 'logical-bird-344400',
    private_key_id: '0123456789abcdef0123456789abcdef01234567',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: clientEmail,
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(clientEmail)}`,
    universe_domain: 'googleapis.com',
  }
  const normalized = cryptoContract.normalizeGoogleServiceAccount(downloadedCredential)
  assert.deepEqual(
    Object.keys(normalized).sort(),
    ['client_email', 'client_id', 'private_key', 'private_key_id', 'project_id', 'token_uri', 'type'],
    'normalized service-account credential must discard validated optional metadata',
  )
  assert.throws(
    () => cryptoContract.normalizeGoogleServiceAccount({ ...downloadedCredential, arbitrary_endpoint: 'https://example.com' }),
    /Unsupported service-account field/,
  )
  assert.throws(
    () => cryptoContract.normalizeGoogleServiceAccount({
      ...downloadedCredential,
      client_x509_cert_url: 'https://example.com/robot/v1/metadata/x509/account',
    }),
    /client_x509_cert_url is invalid/,
  )

  const apiKey = 'AIzaSyContractTestKey0123456789'
  const encryptedApiKey = cryptoContract.encryptGoogleApiKey(apiKey)
  assert.equal(cryptoContract.decryptGoogleApiKey(encryptedApiKey), apiKey, 'Google API key encryption round trip')
  const encryptedServiceAccount = cryptoContract.encryptGoogleServiceAccount(downloadedCredential)
  assert.equal(
    cryptoContract.decryptGoogleServiceAccount(encryptedServiceAccount).client_email,
    clientEmail,
    'Google service-account encryption round trip',
  )
  const tampered = {
    ...encryptedApiKey,
    ciphertext: Buffer.from(encryptedApiKey.ciphertext),
  }
  tampered.ciphertext[0] ^= 1
  assert.throws(() => cryptoContract.decryptGoogleApiKey(tampered), /could not be decrypted/)
  assert.throws(() => cryptoContract.decryptGoogleApiKey(encryptedServiceAccount), /could not be decrypted/)
} finally {
  if (previousEncryptionKey === undefined) delete process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY
  else process.env.AGENT_CREDENTIAL_ENCRYPTION_KEY = previousEncryptionKey
}

await import('./test-maton-user-credentials.mjs')
await import('./test-maton-runtime-credentials.mjs')

console.log('PASS test-postgres-adapter-contracts')
