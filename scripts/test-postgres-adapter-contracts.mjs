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
assertIncludes(usersAdapter, "COALESCE((SELECT reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gu'))", 'side-effect-free app user identity upsert')
assertIncludes(usersAdapter, "COALESCE((SELECT contact_reference_code FROM app_users WHERE email = $1), allocate_crm_reference('gc'))", 'side-effect-free app user contact identity upsert')
assertIncludes(usersAdapter, 'inviteAppUser', 'app users adapter')
assertIncludes(usersAdapter, 'INSERT INTO app_user_organization_memberships', 'invitation organization membership assignment')
assertIncludes(usersAdapter, 'ON CONFLICT (user_email, organization_id) DO UPDATE SET', 'invitation organization membership upsert')
assertIncludes(usersAdapter, 'organization_id = COALESCE(app_users.organization_id, EXCLUDED.organization_id)', 'multi-workspace compatibility organization preservation')
assertIncludes(usersAdapter, 'restoreInvitedUserAssignment', 'failed invitation assignment rollback')
assertIncludes(usersAdapter, 'previousMembership', 'failed invitation membership rollback')
assertIncludes(usersAdapter, 'canInviteUsers', 'app users adapter')
assertIncludes(usersAdapter, 'requireOrganizationInActorScope', 'organization-subtree user administration')
assertIncludes(usersAdapter, 'JOIN managed ON managed.id = membership.organization_id', 'membership-scoped organization user listing')
assertIncludes(usersAdapter, "current?.status === 'disabled'", 'disabled user restore authorization')
assertIncludes(usersAdapter, 'Restore the disabled user before sending a new invitation', 'disabled user invitation boundary')
assertIncludes(usersAdapter, 'updateAppUserProfile', 'app users adapter')
assertIncludes(usersAdapter, "UPDATE workspace_organizations", 'atomic profile organization update')
assertIncludes(usersAdapter, "'pipeline:' || pipeline.id::text || ':provision'", 'profile Drive reconciliation enqueue')
assertIncludes(usersAdapter, "VALUES ('app_users', $1, 'upsert_user_identity', 'suitecrm'", 'retryable native SuiteCRM user identity projection')
assertIncludes(usersAdapter, 'updateAppUserAccess', 'app users adapter')
assertIncludes(usersAdapter, 'updateAppUserCrmEmployee', 'explicit CRM employee access')
assertIncludes(usersAdapter, 'Reassign ${ownedCount} CRM Contact', 'CRM employee owner reassignment guard')
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

const crmOpportunityContactsMigration = read('db/migrations/0042_crm_opportunity_contacts.sql')
for (const contract of [
  'CREATE TABLE IF NOT EXISTS crm_opportunity_contacts',
  'REFERENCES crm_opportunities (pipeline_id, id)',
  'REFERENCES crm_contacts (pipeline_id, id)',
  'idx_crm_opportunity_contacts_primary',
]) {
  assertIncludes(crmOpportunityContactsMigration, contract, 'CRM opportunity contacts migration')
}

const crmInteractionUserMappingMigration = read('db/migrations/0043_crm_interaction_user_mapping.sql')
for (const contract of [
  'ADD COLUMN IF NOT EXISTS suitecrm_user_id text',
  'ADD COLUMN IF NOT EXISTS suitecrm_username text',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_suitecrm_user_id',
  'ADD COLUMN IF NOT EXISTS agent_email text',
  'FOREIGN KEY (agent_email) REFERENCES app_users(email) ON DELETE SET NULL',
  'idx_crm_interactions_agent_email',
  'HAVING count(DISTINCT app_user.email) = 1',
]) {
  assertIncludes(crmInteractionUserMappingMigration, contract, 'CRM interaction user mapping migration')
}

const pipelineCatalogMigration = read('db/migrations/0045_pipeline_people_products_and_dropdown_catalogs.sql')
for (const contract of [
  'ADD COLUMN IF NOT EXISTS pipeline_user boolean',
  "allocate_crm_reference('gp')",
  'CREATE TABLE IF NOT EXISTS crm_products',
  'CREATE TABLE IF NOT EXISTS crm_opportunity_products',
  'CREATE TABLE IF NOT EXISTS pipeline_dropdown_catalogs',
  'idx_crm_products_pipeline_name_unique',
  'idx_crm_products_pipeline_sku_unique',
  'ADD COLUMN IF NOT EXISTS desired_revision bigint',
  'ADD COLUMN IF NOT EXISTS applied_revision bigint',
  'REFERENCES crm_contacts (pipeline_id, id) ON DELETE RESTRICT',
  'REFERENCES crm_products (pipeline_id, id) ON DELETE RESTRICT',
  "reference_code ~ '^gp[0-9]{7}$'",
]) {
  assertIncludes(pipelineCatalogMigration, contract, 'pipeline people and products migration')
}

const atomicProductCatalogMigration = read('db/migrations/0046_atomic_pipeline_products_and_sync_retry_state.sql')
for (const contract of [
  'generated_product_combinations',
  "product.name LIKE '%,%'",
  "'delete_record'",
  'crm:products:combination-cleanup:v1:',
  'legacy_workflow_catalogs',
  "'{dropdowns,stage}'",
  "'{dropdowns,priority}'",
  "'{dropdowns,status}'",
  "'{dropdowns,source}'",
  "'{dropdowns,loss_reason}'",
  'pipeline-catalog-canonical:v1',
  "SET sync_status = 'pending'",
  "'pipeline.product_catalog.normalized'",
  'globalIdentifiersRetained',
]) {
  assertIncludes(atomicProductCatalogMigration, contract, 'atomic pipeline product cleanup migration')
}

const organizationBrandingMigration = read('db/migrations/0047_workspace_organization_branding.sql')
for (const contract of [
  'CREATE TABLE IF NOT EXISTS workspace_organization_branding',
  'logo_bytes bytea',
  "primary_color text NOT NULL DEFAULT '#1F2430'",
  "accent_color text NOT NULL DEFAULT '#A8C7FA'",
  'octet_length(logo_bytes) <= 2097152',
]) {
  assertIncludes(organizationBrandingMigration, contract, 'workspace organization branding migration')
}

const pipelineSpellingMigration = read('db/migrations/0048_canonical_pipeline_negotiation_spelling.sql')
for (const contract of [
  'corrected_pipeline_stages',
  "'neogotiation'",
  "'Negotiation'",
  'negotiation-spelling:v1',
  "'pipeline.workflow_spelling.normalized'",
]) {
  assertIncludes(pipelineSpellingMigration, contract, 'canonical pipeline stage spelling migration')
}

const residualPipelineCatalogMigration = read('db/migrations/0049_residual_pipeline_catalog_repair.sql')
for (const contract of [
  'residual_pipeline_catalogs',
  "catalog.catalog->'dropdowns'->'stage' = catalog.catalog->'dropdowns'->'owner'",
  'residual_canonical_products',
  'residual_invalid_products',
  'crm:products:residual-catalog-cleanup:v1:',
  "'{dropdowns,product}'",
  "'{dropdowns,stage}'",
  "'{dropdowns,priority}'",
  "'{dropdowns,status}'",
  "'{dropdowns,source}'",
  "'{dropdowns,loss_reason}'",
  'residual-catalog-repair:v1',
  "'pipeline.residual_catalog.normalized'",
  'globalIdentifiersRetained',
]) {
  assertIncludes(residualPipelineCatalogMigration, contract, 'residual pipeline catalog repair migration')
}

const historicalPipelineCatalogMigration = read('db/migrations/0050_historical_pipeline_catalog_restore.sql')
for (const contract of [
  'historical_shifted_pipeline_catalogs',
  "catalog.catalog->'dropdowns'->'stage' = catalog.catalog->'dropdowns'->'owner'",
  'historical_canonical_products',
  'historical_invalid_products',
  'crm:products:historical-catalog-cleanup:v1:',
  '"value":"AAR"',
  '"value":"Merchant y140 & y182"',
  '"value":"Linkedin"',
  '"value":"Account Transition"',
  '"value":"Price"',
  'historical-catalog-repair:v1',
  "'pipeline.historical_catalog.restored'",
  "'gitSnapshots', 4",
  "'retainedBackups', 128",
  'globalIdentifiersRetained',
]) {
  assertIncludes(historicalPipelineCatalogMigration, contract, 'historical pipeline catalog restore migration')
}

const configuredPipelineDropdownsMigration = read('db/migrations/0051_preserve_configured_pipeline_dropdowns.sql')
for (const contract of [
  'historical_dropdown_projection_regressions',
  "pipeline.owner_email = 'jarrett@suburbiasandwichco.com'",
  'projection-default-repair:v1',
  '"value":"Account Transition"',
  '"value":"Price"',
  "'pipeline.dropdown_projection_defaults.repaired'",
]) {
  assertIncludes(configuredPipelineDropdownsMigration, contract, 'configured pipeline dropdown preservation migration')
}

const canonicalDropdownLayoutMigration = read('db/migrations/0052_restore_canonical_dropdown_layout.sql')
for (const contract of [
  'canonical_dropdown_layout_regressions',
  "pipeline.owner_email = 'jarrett@suburbiasandwichco.com'",
  'crm_opportunity_products',
  "'productModel', 'many-to-many'",
  'canonical-dropdown-layout-repair:v1',
  "'merchant y140 & y182'",
  '"value":"Account Transition"',
  '"value":"Price"',
  "'pipeline.canonical_dropdown_layout.restored'",
]) {
  assertIncludes(canonicalDropdownLayoutMigration, contract, 'canonical dropdown layout restore migration')
}

const emptyPipelineTemplateMigration = read('db/migrations/0053_seed_empty_pipeline_templates.sql')
for (const contract of [
  'empty_catalogs',
  "('stage', 'Identified Lead', 0)",
  "('status', 'On Hold', 1)",
  "('source', 'Referral', 2)",
  "COALESCE(catalog.catalog->'dropdowns', '{}'::jsonb) || base_dropdowns.value",
  'desired_revision = catalog.desired_revision + 1',
]) {
  assertIncludes(emptyPipelineTemplateMigration, contract, 'empty pipeline template migration')
}

const crmContactOwnerIdentityMigration = read('db/migrations/0054_crm_contact_owner_user_identity.sql')
for (const contract of [
  "allocate_crm_reference('gu')",
  'ADD COLUMN IF NOT EXISTS contact_reference_code text',
  "CHECK (reference_code ~ '^gu[0-9]{7}$')",
  'owner_user_reference_code text',
  'owner_email text',
  'owner_display_name text',
  'HAVING count(*) = 1',
  "'assigned_user_id', app_user.suitecrm_user_id",
  'crm:contacts:owner-backfill:v1:',
  "'upsert_user_identity'",
  "'referenceCode', app_user.reference_code",
  'crm:suitecrm-user-global-id:v1:',
]) {
  assertIncludes(crmContactOwnerIdentityMigration, contract, 'CRM contact owner user identity migration')
}

const crmEmployeeIdentityMigration = read('db/migrations/0056_crm_employee_identity_and_workbook_dashboard.sql')
for (const contract of [
  'crm_user_enabled boolean NOT NULL DEFAULT false',
  "email = 'olivia@suburbiasandwichco.com'",
  'retired_app_user_global_identities',
  "SET status = 'retired'",
  'ALTER COLUMN reference_code DROP NOT NULL',
  'app_users_crm_employee_identity_complete',
  "'provision_pipeline'",
  'managed-dashboard-v2',
]) {
  assertIncludes(crmEmployeeIdentityMigration, contract, 'CRM employee identity and workbook repair migration')
}

const canonicalSuiteCrmUsernameMigration = read('db/migrations/0057_canonical_suitecrm_usernames.sql')
for (const contract of [
  'app_users_suitecrm_identity_canonical',
  'suitecrm_username = reference_code',
  "'username', app_user.reference_code",
  'crm:suitecrm-user-identity:v2:',
]) {
  assertIncludes(canonicalSuiteCrmUsernameMigration, contract, 'canonical SuiteCRM employee username migration')
}

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
assertIncludes(invitationAdapter, 'resolveInvitationWorkspaceOrganization', 'explicit invitation organization selection')
assertIncludes(invitationAdapter, 'workspace_organization_id', 'organization-bound invitation token')
const magicCodeAdapter = read('app_src/lib/authMagicCode.ts')
assertIncludes(magicCodeAdapter, "user.status !== 'active'", 'ordinary sign-in active-user requirement')
assertIncludes(magicCodeAdapter, 'requestInvitationAuthMagicCode', 'invitation-purpose sign-in')
assertIncludes(magicCodeAdapter, 'UPDATE app_user_invitations', 'atomic invitation acceptance')
assertIncludes(magicCodeAdapter, 'AUTHORIZATION_CHANGED', 'invitation authorization rollback')
assertIncludes(magicCodeAdapter, 'membership.organization_id = invitation.workspace_organization_id', 'invitation organization acceptance boundary')
assertIncludes(magicCodeAdapter, 'UPDATE app_user_organization_memberships', 'invitation membership activation')
assertIncludes(magicCodeAdapter, 'AND organization_id = $2::uuid', 'invitation-specific membership activation')

const documentsAdapter = read('app_src/lib/documents.ts')
assertIncludes(documentsAdapter, 'WHERE owner_email = $1', 'user-scoped document reads')
assertIncludes(documentsAdapter, 'workspace_organization_id = $2::uuid', 'workspace-scoped document reads')
assertIncludes(documentsAdapter, 'ON CONFLICT (owner_email, workspace_organization_id, source_key)', 'workspace-scoped document identity')
assertIncludes(documentsAdapter, "sourceKey: 'system:build-brief'", 'generated build brief')
assertIncludes(documentsAdapter, "sourceKey: 'system:project-brief'", 'generated project brief')
assertIncludes(documentsAdapter, "sourceKey: 'system:pipeline-brief'", 'generated pipeline brief')
assertIncludes(documentsAdapter, 'document.content', 'local full-document search')
assertIncludes(documentsAdapter, 'document_embedding_jobs', 'document embedding enqueue')
assertIncludes(documentsAdapter, 'listAiRadarItems', 'AI Radar generated brief')
assertIncludes(documentsAdapter, 'pipelineSourceLabel', 'human-readable pipeline brief source')
assertIncludes(documentsAdapter, 'buildPipelineEngagementInsights', 'pipeline brief engagement analysis')
assertIncludes(documentsAdapter, 'interaction.opportunity_id = opportunity.id', 'opportunity-linked touchpoint analysis')
assertIncludes(documentsAdapter, 'opportunity-link coverage rate', 'pipeline brief attribution caveat')
assertIncludes(documentsAdapter, 'embedding <=> $4::vector', 'hybrid semantic document search')
assertIncludes(documentsAdapter, 'embedding_model = $5', 'same-model semantic document search')
assertIncludes(documentsAdapter, 'parsed.data.app_visible !== true', 'explicit repository catalog visibility')
assertIncludes(documentsAdapter, "maps: 'maps'", 'Map of Content document category')
assertIncludes(documentsAdapter, "decisions: 'decisions'", 'decision record document category')
assertIncludes(documentsAdapter, 'const area = singleLine(parsed.data.area)', 'document area search metadata')
assertIncludes(documentsAdapter, 'generateUserDocument', 'user-triggered document generation')
assertIncludes(documentsAdapter, 'user-generated:', 'immutable user-generated document source identity')
assertIncludes(documentsAdapter, 'generated-on-demand', 'on-demand document classification')

const generatedDocumentRoute = read('app_src/app/api/docs/generate/route.ts')
assertIncludes(generatedDocumentRoute, 'requireRequestUser(req)', 'signed user document generation boundary')
assertIncludes(generatedDocumentRoute, 'generateUserDocument', 'generated document API adapter')
assertIncludes(generatedDocumentRoute, "'pipeline-report'", 'pipeline report generation option')

const generatedDocumentUi = read('app_src/components/docs/DocGeneratorDialog.tsx')
assertIncludes(generatedDocumentUi, "fetch('/api/workspaces'", 'accessible document source discovery')
assertIncludes(generatedDocumentUi, "fetch('/api/docs/generate'", 'user document generation action')
assertIncludes(generatedDocumentUi, 'New document', 'document generation command label')

const agentContextMemory = read('app_src/lib/agents/contextMemory.ts')
const agentContextProvider = read('app_src/lib/agents/provider.ts')
const agentContextMigration = read('db/migrations/0039_agent_context_memory.sql')
assertIncludes(agentContextMemory, "scope = 'shared'", 'shared role context read boundary')
assertIncludes(agentContextMemory, "scope = 'operator' AND operator_id = $2", 'operator context read boundary')
assertIncludes(agentContextMemory, "'needs_review'", 'cross-organization shared memory review gate')
assertIncludes(agentContextMemory, 'SET evidence_count = evidence.count', 'shared memory evidence accounting')
assert.ok(
  !agentContextMemory.includes("THEN 'active'"),
  'shared memory evidence must not activate a lesson without administrator review',
)
assertIncludes(agentContextMemory, 'isShareableAgentLearning', 'shared memory privacy filter')
assertIncludes(agentContextProvider, 'This is a private task discussion, not an execution run', 'non-mutating discussion response contract')
assertIncludes(agentContextProvider, 'learned must be one generic reusable operating lesson', 'task execution learning contract')
assertIncludes(agentContextMigration, 'PRIMARY KEY (memory_id, organization_id)', 'independent organization evidence contract')

const agentResearchAdapter = read('app_src/lib/persistence/agentResearch.ts')
const agentResearchMigration = read('db/migrations/0058_agent_public_research_outbox.sql')
const agentResearchWorker = read('app_src/lib/agentResearchWorker.ts')
const agentResearchRoute = read('app_src/app/api/agents/research/process/route.ts')
assertIncludes(agentResearchMigration, 'CREATE TABLE IF NOT EXISTS agent_research_evidence', 'agent research evidence store')
assertIncludes(agentResearchMigration, "target_system = 'agent_research'", 'agent research outbox index')
assertIncludes(agentResearchAdapter, "input.agentId !== 'projects'", 'Projects-only public research boundary')
assertIncludes(agentResearchAdapter, 'WHERE operator_id = $1 AND board_id = $2::uuid AND task_id = $3 AND agent_id = $4', 'tenant-scoped research evidence reads')
assertIncludes(agentResearchWorker, 'runAgentWebResearch', 'isolated public research execution')
assertIncludes(agentResearchWorker, 'research.citations.length === 0', 'source citation requirement')
assertIncludes(agentResearchRoute, 'PIPELINE_OUTBOX_WORKER_SECRET', 'worker-only research route')

const matonCredentialAdapter = read('app_src/lib/persistence/matonCredentials.ts')
assertIncludes(matonCredentialAdapter, 'selectedConnectionIds', 'platform Maton connection preservation')

const embeddingsAdapter = read('app_src/lib/documentEmbeddings.ts')
const embeddingSettingsRoute = read('app_src/app/api/settings/embeddings/route.ts')
const embeddingSettingsPanel = read('app_src/components/settings/EmbeddingSettingsPanel.tsx')
assertIncludes(embeddingsAdapter, "model: config.model", 'embedding model reporting')
assertIncludes(embeddingsAdapter, 'FOR UPDATE SKIP LOCKED', 'embedding job leases')
assertIncludes(embeddingsAdapter, 'clawpilot-hash-vector-v1', 'default local vector model')
assertIncludes(embeddingsAdapter, 'ensureJobsForModel', 'embedding model upgrade queue')
assertIncludes(embeddingsAdapter, 'OPENAI_EMBEDDING_API_KEY', 'dedicated external embedding credential')
assertIncludes(embeddingsAdapter, 'documents.embedding.configuration', 'database-backed embedding provider preference')
assertIncludes(embeddingsAdapter, 'effectiveDocumentEmbeddingConfiguration', 'effective embedding provider resolution')
assertIncludes(embeddingsAdapter, "jobs.status = 'processing'", 'stale embedding job recovery')
assertIncludes(embeddingsAdapter, 'jobs.locked_at = $5::timestamptz', 'embedding lease ownership')
assertIncludes(embeddingSettingsRoute, "actor.role !== 'owner'", 'owner-only embedding cost control')
assertIncludes(embeddingSettingsRoute, 'OPENAI_EMBEDDING_API_KEY', 'external embedding key gate')
assertIncludes(embeddingSettingsPanel, 'Document content stays inside ClawPilot', 'local embedding privacy status')

const shortLinksAdapter = read('app_src/lib/shortlinks.ts')
assertIncludes(shortLinksAdapter, 'SHORTLINK_SERVICE_CLIENTS_JSON', 'source-bound short-link service clients')
assertIncludes(shortLinksAdapter, "url.protocol !== 'https:'", 'short-link destination transport security')
assertIncludes(shortLinksAdapter, 'FOR UPDATE', 'atomic short-link click limits')
assertIncludes(shortLinksAdapter, 'NOT $4::boolean OR source_app = $5', 'service source isolation')
assertIncludes(shortLinksAdapter, 'organization_root_id = $10::uuid', 'exact organization-scoped short-link visibility')
assertIncludes(shortLinksAdapter, '$2::boolean OR NOT $8::boolean', 'same-organization interactive link visibility')
assertIncludes(shortLinksAdapter, 'requireWorkspaceAppUser', 'short-link exact active-workspace membership resolution')
assertIncludes(shortLinksAdapter, 'x-shortlink-organization', 'service short-link workspace selection')

const tenancyAdapter = read('app_src/lib/tenancy.ts')
assertIncludes(tenancyAdapter, 'ensureDefaultResourcesForUser', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'resolveProjectBoardAccess', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'resolvePipelineSpaceAccess', 'tenancy adapter')
assertIncludes(tenancyAdapter, "SELECT 'CRM Board'", 'per-user CRM board provisioning')
assertIncludes(tenancyAdapter, 'WHERE owner_email = $1 AND workspace_organization_id = $2::uuid AND is_default', 'per-user and per-workspace personal pipeline provisioning')
assertIncludes(tenancyAdapter, 'pipelineProvisioningRequired', 'personal pipeline Sheet provisioning signal')
assertIncludes(tenancyAdapter, 'ON CONFLICT (pipeline_id) DO UPDATE', 'empty pipeline template repair')
assertIncludes(tenancyAdapter, "((EXCLUDED.catalog->'dropdowns') - 'product')", 'pipeline product preservation')
assertIncludes(tenancyAdapter, '!personalPipeline.rows[0].short_link_id', 'personal pipeline short-link reconciliation signal')
assertIncludes(tenancyAdapter, 'workspace_organization_id = $1::uuid', 'organization-primary CRM pipeline selection')
assertIncludes(tenancyAdapter, 'Only the board owner can share it', 'tenancy adapter')
assertIncludes(tenancyAdapter, 'Only the pipeline owner can share it', 'tenancy adapter')

const organizationAdapter = read('app_src/lib/organizations.ts')
assertIncludes(organizationAdapter, 'WHERE organization.id = $1::uuid`,', 'member hierarchy exact organization boundary')

const taskAdapter = read('app_src/lib/persistence/tasks.ts')
assertIncludes(taskAdapter, 'WHERE board_id = $1::uuid', 'board-scoped task reads')
assertIncludes(taskAdapter, 'DELETE FROM tasks WHERE board_id = $1::uuid', 'board-scoped task writes')
assertIncludes(taskAdapter, 'insertAgentDispatchOutbox', 'atomic task and agent dispatch writes')
assertIncludes(taskAdapter, "source <> 'crm-projection'", 'CRM projection snapshot deletion guard')
assertIncludes(taskAdapter, "WHEN tasks.source = 'crm-projection'", 'CRM projection source preservation')

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
assertIncludes(pipelineProvisioning, 'resolveGoogleWorkspaceProvisioningBinding', 'durable provisioning queue binding')
assertIncludes(pipelineProvisioning, "appPropertyClause", 'Drive appProperties discovery')
assertIncludes(pipelineProvisioning, "corpora: 'drive'", 'Shared Drive scoped file search')
assertIncludes(pipelineProvisioning, "includeItemsFromAllDrives: 'true'", 'Shared Drive file inclusion')
assertIncludes(pipelineProvisioning, "supportsAllDrives: 'true'", 'Shared Drive request support')
assertIncludes(pipelineProvisioning, "idempotent: false", 'non-retried ambiguous Google creates')
assertIncludes(pipelineProvisioning, 'ensurePipelineShortLink(pipeline, pipeline.sheetId)', 'ready pipeline Sheet-link repair')
assertIncludes(pipelineProvisioning, "const EXPECTED_TABS", 'managed pipeline tab contract')
assertIncludes(
  pipelineProvisioning,
  "const dataColumn = title === 'Dashboard' ? 'P' : title === 'Start Here' ? 'C' : 'B'",
  'managed workbook header column mapping',
)
assertIncludes(pipelineProvisioning, "range: `'${title}'!${dataColumn}4`", 'managed workbook header projection')
assertIncludes(pipelineProvisioning, "Dropdowns: ['Owner', 'Product', 'Stage', 'Priority', 'Status', 'Source', 'Loss Reason']", 'canonical managed pipeline dropdown headers')
assertIncludes(pipelineProvisioning, 'const newlyProvisionedTitles = new Set<string>()', 'new workbook tab seed tracking')
assertIncludes(pipelineProvisioning, "title === 'Dropdowns' && !newlyProvisionedTitles.has(title)", 'configured dropdown headers and rows are not rewritten during projection')
assertIncludes(pipelineProvisioning, 'if (preserveConfiguredDropdowns) return writes', 'configured dropdown projection ownership boundary')
assertIncludes(pipelineProvisioning, 'applyPipelineWorkbookBrandingWithRequest', 'organization workbook branding')
assertIncludes(pipelineProvisioning, 'workbookBrandMark(branding)', 'organization workbook brand mark')
assert.ok(!pipelineProvisioning.includes('=IMAGE('), 'managed workbooks must not require external image approval')
for (const tab of ['Start Here', 'Calculations', 'Dashboard']) {
  assertIncludes(pipelineProvisioning, `'${tab}'`, 'managed CRM workbook tab contract')
}
assertIncludes(pipelineProvisioning, 'addProtectedRange', 'managed CRM workbook protections')
assertIncludes(pipelineProvisioning, "title !== 'Opportunities'", 'Opportunities-only workbook input boundary')
assertIncludes(pipelineProvisioning, 'createShortLink', 'managed pipeline short link')
assertIncludes(pipelineProvisioning, 'reconcilePipelineGooglePermissions', 'managed Google permission reconciliation')
assertIncludes(pipelineProvisioning, 'nextPageToken,permissions', 'permission pagination')
assertIncludes(pipelineProvisioning, "sendNotificationEmail: 'true'", 'Google visitor sharing invitation delivery')
assert.ok(
  !pipelineProvisioning.includes("sendNotificationEmail: 'false'"),
  'managed Google user permissions must notify recipients so non-Google login emails can accept visitor sharing',
)
assertIncludes(pipelineProvisioning, "['anyone', 'domain', 'group']", 'direct broad permission rejection')
assertIncludes(pipelineProvisioning, 'permissionIsInherited', 'Shared Drive governing permission preservation')
assertIncludes(pipelineProvisioning, "`hierarchy:${managedEnvironmentName()}`", 'serialized Drive hierarchy reconciliation')
assertIncludes(pipelineProvisioning, 'workspaceOrganizationId: identity.workspaceOrganizationId', 'canonical Drive organization identity')
assertIncludes(pipelineProvisioning, 'appUserReferenceCode: identity.contactReferenceCode', 'canonical Drive contact identity')
assertIncludes(pipelineProvisioning, 'GOOGLE_PIPELINE_FOLDER_MOVE_UNVERIFIED', 'verified Drive folder moves')

const legacyPipelineWorkbook = read('app_src/lib/pipelineLegacyWorkbook.ts')
assertIncludes(legacyPipelineWorkbook, 'configurePipelineTabsWithRequest', 'legacy Maton workbook layout parity')
assertIncludes(legacyPipelineWorkbook, 'safeGatewayErrorDetail', 'bounded legacy Sheets diagnostics')
assertIncludes(legacyPipelineWorkbook, '.slice(0, 800)', 'bounded legacy Sheets error detail')

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
assertIncludes(crmAdapter, "SET sync_status = 'synced', sync_error = NULL, suitecrm_synced_at = now()", 'SuiteCRM inbound records marked synced')
assertIncludes(crmAdapter, "operation IN ('upsert_record', 'delete_record', 'upsert_user_identity')", 'SuiteCRM record and user identity outbox claims')
assertIncludes(crmAdapter, 'ensurePipelineCrmHierarchy', 'workspace organization CRM hierarchy')
assertIncludes(crmAdapter, 'WITH RECURSIVE descendants AS', 'descendant organization CRM hierarchy')
assertIncludes(crmAdapter, "relationship_type = 'customer'\n       AND parent_organization_id IS NULL", 'existing nested CRM customer hierarchy preservation')
assertIncludes(crmAdapter, 'membership.organization_id = pipeline.workspace_organization_id', 'active-membership profile projection')
assertIncludes(crmAdapter, "membership.status = 'active'", 'active CRM profile workspace membership')
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
assertIncludes(crmAdapter, 'syncAppUserProfileToOwnedPipelines', 'all organization pipeline profile projection')
assertIncludes(crmAdapter, 'syncPipelineOwnerProfileToCrm', 'pipeline owner profile backfill projection')
assertIncludes(crmAdapter, 'CRM profile synchronization requires an organization pipeline', 'profile projection organization boundary')
assertIncludes(crmAdapter, 'appUserContactReferenceCode: user.contactReferenceCode', 'separate canonical app-user CRM contact identity')
assertIncludes(crmAdapter, 'COALESCE(\n           $2::uuid,', 'interaction organization relationship normalization')
assertIncludes(crmAdapter, 'organizationName: clean(row.organization_name)', 'interaction organization API projection')
assertIncludes(crmAdapter, "to_jsonb(record)->>'contact_id' AS contact_id", 'interaction relationship edit hydration')
assertIncludes(crmAdapter, 'OR organization.name ILIKE', 'interaction organization search')
assertIncludes(crmAdapter, 'needsReview?: boolean', 'unresolved interaction review filter contract')
assertIncludes(crmAdapter, 'needs_review_interactions', 'unresolved interaction review summary')
assertIncludes(crmAdapter, 'NOT $3::boolean OR COALESCE', 'unresolved interaction review query')
assertIncludes(crmAdapter, 'suiteCrmRelationships', 'SuiteCRM meeting subpanel relationships')
assertIncludes(crmAdapter, "'accounts'::text AS link_field_name", 'SuiteCRM meeting account relationship')
assertIncludes(crmAdapter, "SELECT 'contacts', 'Contacts', suitecrm_id", 'SuiteCRM meeting contact relationship')
assertIncludes(crmAdapter, "SELECT 'contact'::text AS link_field_name", 'SuiteCRM Note contact relationship')
assertIncludes(crmAdapter, 'FROM crm_opportunity_contacts relationship', 'SuiteCRM opportunity contact relationships')
assertIncludes(crmAdapter, 'Opportunity contacts must belong to the selected organization', 'opportunity contact organization boundary')
assertIncludes(crmAdapter, 'hydrateOpportunityRows', 'opportunity contact API projection')
assertIncludes(crmAdapter, 'COALESCE(organization.name, opportunity.organization_name) AS organization_name', 'canonical opportunity organization projection')
assertIncludes(crmAdapter, 'Opportunity organization was not found', 'opportunity organization identity boundary')
assertIncludes(crmAdapter, 'agentSuiteCrmUserId', 'SuiteCRM interaction assigned-user projection')
assertIncludes(crmAdapter, 'assigned_user_id: clean(fields.agentSuiteCrmUserId)', 'SuiteCRM Note assigned user field')
assertIncludes(crmAdapter, 'assigned_user_id: clean(fields.ownerSuiteCrmUserId)', 'SuiteCRM Contact assigned user field')
assertIncludes(crmAdapter, 'ownerUserReferenceCode: owner.referenceCode', 'stable Contact owner user identity')
assertIncludes(crmAdapter, 'Contact owner must be an active ClawPilot user with pipeline access', 'Contact owner pipeline-access boundary')
assertIncludes(crmAdapter, 'owner_display_name = $32', 'Contact owner identity snapshot persistence')
assertIncludes(crmAdapter, 'Interaction agent must be an active ClawPilot user with pipeline access', 'interaction ClawPilot-user boundary')
assertIncludes(crmAdapter, 'Interaction contact must belong to the selected organization', 'interaction contact organization boundary')
assertIncludes(crmAdapter, 'listCrmPipelineUsersInPostgres', 'interaction agent user catalog')
assertIncludes(crmAdapter, 'contact_id: clean(fields.contactSuiteCrmId)', 'SuiteCRM Note contact field')
assertIncludes(crmAdapter, 'global_id_c: referenceCode', 'SuiteCRM Global ID projection')
assertIncludes(crmAdapter, 'occurred_at_c: suiteCrmDateTime(fields.occurredAt)', 'SuiteCRM interaction occurrence-time projection')
assertIncludes(crmAdapter, '`crm:${input.entity}:v3:', 'versioned SuiteCRM Global ID outbox contract')
assertIncludes(crmAdapter, "WHERE sync_outbox.status IN ('succeeded', 'dead')", 'replayed SuiteCRM content revision requeue')
assertIncludes(crmAdapter, 'RETURNING idempotency_key', 'idempotent SuiteCRM outbox insertion or requeue result')
assertIncludes(crmAdapter, 'if (suiteCrmOutboxKey)', 'SuiteCRM audit noise suppression')
assertIncludes(crmAdapter, 'readPipelineCatalogInPostgres', 'tenant pipeline catalog read')
assertIncludes(crmAdapter, 'upsertPipelineCatalogPersonInPostgres', 'CRM-only pipeline person persistence')
assertIncludes(crmAdapter, 'upsertPipelineCatalogProductInPostgres', 'pipeline product persistence')
assertIncludes(crmAdapter, 'This email belongs to a ClawPilot app user and cannot be CRM-only', 'app user and CRM-only identity separation')
assertIncludes(crmAdapter, 'FROM crm_opportunity_products relationship', 'opportunity product relationship hydration')
assertIncludes(crmAdapter, "products: 'crm_products'", 'product global-reference mapping')

const rootCrmPunchoutRoute = read('app_src/app/api/crm/punchout/route.ts')
assertIncludes(rootCrmPunchoutRoute, 'organization.parentId !== null', 'root-only native SuiteCRM punchout')

const suiteCrmInteractionIngestion = read('app_src/lib/crm/suiteCrmInteractionIngestion.ts')
assertIncludes(suiteCrmInteractionIngestion, "FULL_HISTORY_START = '1970-01-01T00:00:00.000Z'", 'SuiteCRM Note historical first scan')
assertIncludes(suiteCrmInteractionIngestion, 'SUITE_CRM_INTERACTION_POLL_OVERLAP_MS', 'SuiteCRM Note poll overlap')
assertIncludes(suiteCrmInteractionIngestion, 'emitSuiteCrmOutbox: false', 'SuiteCRM Note inbound echo prevention')
assertIncludes(suiteCrmInteractionIngestion, "| 'Meetings'", 'SuiteCRM Note parent relationship coverage')

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

const referenceAllocationCleanupMigration = read('db/migrations/0032_reference_allocation_leak_cleanup.sql')
assertIncludes(referenceAllocationCleanupMigration, "SET status = 'retired'", 'orphan CRM allocation retirement')
assertIncludes(referenceAllocationCleanupMigration, 'Unreferenced active CRM allocations remain after cleanup', 'active CRM allocation integrity guard')

const crmBoardProjectionMigration = read('db/migrations/0033_crm_board_projection_and_legacy_alias_cleanup.sql')
for (const contract of [
  'CREATE TABLE IF NOT EXISTS crm_board_projections',
  'CREATE TABLE IF NOT EXISTS crm_board_cards',
  'validate_crm_board_projection_scope',
  'validate_crm_board_card_scope',
  "registry.status = 'alias'",
]) {
  assertIncludes(crmBoardProjectionMigration, contract, 'CRM board projection migration')
}

const accountMembershipMigration = read('db/migrations/0034_account_membership_crm_board_scope.sql')
for (const contract of [
  'ADD COLUMN IF NOT EXISTS workspace_organization_id uuid',
  'idx_project_boards_owner_crm_board',
  'idx_app_user_invitations_organization',
  'organization_root_id = app_user.organization_id',
  'resolved_interactions AS',
  'crm:interactions:organization-backfill:v1:',
  'DELETE FROM tasks task',
  'validate_crm_board_projection_scope',
  'validate_crm_board_card_scope',
  'CREATE TRIGGER trg_validate_crm_board_card_scope',
]) {
  assertIncludes(accountMembershipMigration, contract, 'account membership and CRM board scope migration')
}

const suiteCrmInboundSyncMigration = read('db/migrations/0035_suitecrm_inbound_sync_status.sql')
for (const contract of [
  "source_payload ? 'suiteCrmInbound'",
  "outbox.status <> 'succeeded'",
  "aggregate_type = 'crm_interactions'",
  "sync_status = 'synced'",
]) {
  assertIncludes(suiteCrmInboundSyncMigration, contract, 'SuiteCRM inbound sync status migration')
}

const crmDisplayTextMigration = read('db/migrations/0036_crm_display_text_and_card_semantics.sql')
for (const contract of [
  'decode_clawpilot_display_text',
  "WHERE source = 'crm-projection'",
  "'category', 'crm'",
  'DELETE FROM agent_assignments',
  'DELETE FROM tasks',
]) {
  assertIncludes(crmDisplayTextMigration, contract, 'CRM display text and card semantics migration')
}

const crmWorkbookOrganizationProjection = read('app_src/lib/crm/workbookProjection.ts')
assertIncludes(crmWorkbookOrganizationProjection, 'record.organizationName, record.agentName', 'interaction workbook organization projection')
assertIncludes(pipelineProvisioning, "Interactions: ['Priority', 'Interaction', 'Owner', 'Organization'", 'interaction workbook organization header')

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
assertIncludes(crmIntegrationActions, 'appendTextReplyMarkers', 'outbound CRM reply markers')
assertIncludes(crmIntegrationActions, 'appendHtmlReplyMarkers', 'outbound CRM HTML reply markers')
assertIncludes(crmIntegrationActions, '`%gslt${normalizeReference(referenceCode)}`', 'exact outbound CRM marker syntax')
assertIncludes(crmIntegrationActions, 'outboundEmailReferenceCodes', 'contact and organization outbound marker resolution')
assertIncludes(crmIntegrationActions, 'FROM crm_organizations', 'related organization outbound marker lookup')
assertIncludes(crmIntegrationActions, 'crm_campaign_recipients', 'campaign recipient deduplication')
assertIncludes(crmIntegrationActions, "target.entity !== 'organizations'", 'organization email actions')
assertIncludes(crmIntegrationActions, 'recipientEmail: normalizeEmail(target.email', 'queued CRM recipient snapshot')
assertIncludes(crmIntegrationActions, 'calendarEventIdForMeeting', 'meeting-reference Google Calendar event identity')
assertIncludes(crmIntegrationActions, 'conferenceDataVersion=1', 'Google Meet conference data support')
assertIncludes(crmIntegrationActions, "type: 'hangoutsMeet'", 'Google Meet conference request')
assertIncludes(crmIntegrationActions, 'meetingCalendarDescription', 'meeting short-link Calendar description')
assertIncludes(crmIntegrationActions, 'clawpilotMeetingReference', 'private Google Calendar meeting correlation')
assertIncludes(crmIntegrationActions, 'meetingUrl', 'meeting short-link Calendar action result')
assertIncludes(crmIntegrationActions, "method: 'PATCH'", 'Google Calendar reschedule update')
assertIncludes(crmIntegrationActions, 'sendUpdates=all', 'Google Calendar attendee notifications')
assertIncludes(crmIntegrationActions, "method: 'DELETE'", 'Google Calendar cancellation propagation')
assertIncludes(crmIntegrationActions, "meetingStatus: 'cancelled'", 'cancelled meeting terminal state preservation')
assertIncludes(crmIntegrationActions, 'finalMeetingStatus', 'completed meeting terminal state preservation')
assertIncludes(crmIntegrationActions, 'parentSuiteCrmType: parentSuiteCrmType || undefined', 'SuiteCRM meeting parent projection')
assertIncludes(crmIntegrationActions, 'organizerEmail', 'audited selected Calendar organizer')
assertIncludes(crmIntegrationActions, 'senderEmail', 'audited selected Gmail sender')

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
assertIncludes(crmEmailIngestion, "DEFAULT_ARCHIVE_EMAIL = 'archive@eigenracing.com'", 'archive mailbox default')
assertIncludes(crmEmailIngestion, 'archiveCandidateAddresses', 'forwarded archive body address matching')
assertIncludes(crmEmailIngestion, "matchedBy: 'archive-email'", 'archive match attribution')
assertIncludes(crmEmailIngestion, 'groupReferenceTargets', 'related marker interaction consolidation')
assertIncludes(crmEmailIngestion, 'connection.account_email', 'connected mailbox address exclusion')

const crmIntegrationWorkerRoute = read('app_src/app/api/crm/integrations/process/route.ts')
assertIncludes(crmIntegrationWorkerRoute, 'processDueCrmIntegrationActions', 'CRM action retry worker')
assertIncludes(crmIntegrationWorkerRoute, 'processInboundGmailIngestion', 'inbound Gmail worker')
assertIncludes(crmIntegrationWorkerRoute, 'processCalendarIngestion', 'Google Calendar reconciliation worker')
assertIncludes(crmIntegrationWorkerRoute, 'processSuiteCrmAccountContactIngestion', 'SuiteCRM account/contact reconciliation worker')
assertIncludes(crmIntegrationWorkerRoute, 'processSuiteCrmMeetingIngestion', 'SuiteCRM meeting reconciliation worker')

const crmCalendarIngestion = read('app_src/lib/crm/calendarIngestion.ts')
assertIncludes(crmCalendarIngestion, 'clawpilotMeetingReference', 'Calendar meeting reference correlation')
assertIncludes(crmCalendarIngestion, 'meeting.external_event_id = $2', 'Calendar provider event correlation')
assertIncludes(crmCalendarIngestion, 'meetingHasMeaningfulChanges', 'Calendar echo loop prevention')
assertIncludes(crmCalendarIngestion, "eventStatus === 'cancelled'", 'Calendar cancellation reconciliation')
assertIncludes(crmCalendarIngestion, "meeting.source_payload->>'calendarOwnerEmail'", 'organizer-scoped Calendar reconciliation')

const crmSuiteCrmMeetingIngestion = read('app_src/lib/crm/suiteCrmMeetingIngestion.ts')
assertIncludes(crmSuiteCrmMeetingIngestion, 'listSuiteCrmMeetingsUpdatedSince', 'native SuiteCRM meeting polling')
assertIncludes(crmSuiteCrmMeetingIngestion, 'hasMeaningfulChanges', 'SuiteCRM meeting echo prevention')
assertIncludes(crmSuiteCrmMeetingIngestion, 'crm:suitecrm-meeting-calendar:', 'SuiteCRM to Calendar update idempotency')
assertIncludes(crmSuiteCrmMeetingIngestion, 'meetingCalendarOwnerEmail', 'original Calendar organizer routing')

const crmSuiteCrmAccountContactIngestion = read('app_src/lib/crm/suiteCrmAccountContactIngestion.ts')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'crm.suitecrm.account_contact_ingestion.cursor', 'SuiteCRM account/contact cursor')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'snapshot.attributes.global_id_c', 'SuiteCRM Global ID correlation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'organization.suitecrm_id = $1', 'SuiteCRM account ID correlation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'contact.suitecrm_id = $1', 'SuiteCRM contact ID correlation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'AND organization.pipeline_id = contact.pipeline_id', 'tenant-scoped contact account correlation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'hasMeaningfulOrganizationChanges', 'SuiteCRM account echo prevention')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'hasMeaningfulContactChanges', 'SuiteCRM contact echo prevention')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'emitSuiteCrmOutbox: false', 'SuiteCRM inbound outbox suppression')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'stagedPipelineIds.add(row.pipeline_id)', 'post-stage CRM-card pipeline collection')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'workspaceOrganizationId', 'SuiteCRM account app-only field preservation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'appUserEmail', 'SuiteCRM contact app-only field preservation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'appUserContactReferenceCode', 'SuiteCRM contact gc identity preservation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'SELECT DISTINCT pipeline_id::text', 'bound CRM-board pipeline backfill')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'const projectionPipelineIds = new Set(await boundCrmBoardPipelineIds())', 'deduplicated CRM-board pipeline reconciliation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'reconcileCrmBoardProjectionsForPipeline', 'SuiteCRM CRM-card projection reconciliation')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'suiteCrmSnapshotIsDeleted', 'non-destructive SuiteCRM deletion handling')
assertIncludes(crmSuiteCrmAccountContactIngestion, 'deletedRecordsIgnored', 'audited ignored SuiteCRM deletions')
const noEchoStageProjectionBlocks = crmSuiteCrmAccountContactIngestion.match(
  /await stageCrmRecordInPostgres\(\{[\s\S]*?emitSuiteCrmOutbox: false,[\s\S]*?\n    \}\)\n    staged \+= 1\n    stagedPipelineIds\.add\(row\.pipeline_id\)/g,
) || []
assert.equal(noEchoStageProjectionBlocks.length, 2, 'Account and Contact pipelines must be projected only after successful no-echo staging')
assert.ok(!crmSuiteCrmAccountContactIngestion.includes('deleteSuiteCrmRecord'), 'SuiteCRM inbound reconciliation must not delete provider records')
assert.ok(!crmSuiteCrmAccountContactIngestion.includes('DELETE FROM crm_'), 'SuiteCRM inbound reconciliation must not delete local CRM records')

const crmActionsRoute = read('app_src/app/api/crm/actions/route.ts')
assertIncludes(crmActionsRoute, 'requireResourceEditor', 'CRM action editor authorization')
assertIncludes(crmActionsRoute, 'idempotency-key', 'CRM action idempotency header')

const crmWriteRoute = read('app_src/app/api/crm/route.ts')
assertIncludes(crmWriteRoute, 'enqueueCrmIntegrationAction', 'CRM meeting Calendar synchronization enqueue')
assertIncludes(crmWriteRoute, 'crm:meeting-calendar-sync:', 'idempotent CRM meeting Calendar synchronization')
assertIncludes(crmWriteRoute, 'providerIdentities', 'visible CRM provider identities')
assertIncludes(crmWriteRoute, 'calendarOwnerEmail', 'meeting Calendar organizer persistence')

const crmReferenceRoute = read('app_src/app/crm/[reference]/route.ts')
assertIncludes(crmReferenceRoute, "new URL('/', appPublicUrl())", 'trusted public CRM reference redirect origin')
assertIncludes(crmReferenceRoute, 'resolveCrmReferenceRoute', 'legacy CRM reference alias and pipeline resolution')
assertIncludes(crmReferenceRoute, 'resolved.pipelineId', 'CRM reference inferred owning pipeline handoff')
assertIncludes(crmReferenceRoute, "destination.searchParams.set('pipeline', pipelineId)", 'CRM reference owning pipeline handoff')
assertIncludes(crmReferenceRoute, "crmAction', 'compose-email'", 'CRM email action deep link')
assertIncludes(crmReferenceRoute, "|p)[0-9]{7}$", 'product Global ID deep link')

const crmBoardProjection = read('app_src/lib/crm/boardProjection.ts')
assertIncludes(crmBoardProjection, 'updateCrmDescriptionWithClient', 'transactional CRM card description write-through')
assertIncludes(crmBoardProjection, 'expectedDescriptionHash', 'CRM card optimistic concurrency')
assertIncludes(crmBoardProjection, 'FOR UPDATE OF card', 'CRM card write lock')
assertIncludes(crmBoardProjection, 'card.payload', 'CRM card dedicated payload storage')
assertIncludes(crmBoardProjection, 'WITH RECURSIVE visible_organizations', 'CRM board account-subtree scope')
assertIncludes(crmBoardProjection, 'DELETE FROM crm_board_cards', 'stale CRM projection removal')

const organizationsAdapter = read('app_src/lib/organizations.ts')
assertIncludes(organizationsAdapter, 'resolveInvitationWorkspaceOrganization', 'invitation membership resolver')
assertIncludes(organizationsAdapter, 'outside your managed account graph', 'invitation organization subtree boundary')
assertIncludes(organizationsAdapter, 'WHERE organization.id = $1::uuid', 'organization hierarchy scoped root')
assertIncludes(organizationsAdapter, 'defines your admin scope', 'organization reparenting scope boundary')
assertIncludes(organizationsAdapter, "relationship_type = 'workspace_member'", 'CRM customer account promotion')
assertIncludes(organizationsAdapter, 'retireUnusedWorkspaceOrganization', 'failed child organization cleanup')

const shortLinks = read('app_src/lib/shortlinks.ts')
assertIncludes(shortLinks, 'normalizeSlug(input.slug, { allowCrmReference: true })', 'public CRM short-link resolution')
assertIncludes(shortLinks, '!options.allowCrmReference && (CRM_REFERENCE_SLUG_PATTERN.test(slug) || CRM_ACTION_SLUG_PATTERN.test(slug))', 'creation-only CRM slug reservation')
assertIncludes(shortLinks, 'g[aciklmop][0-9]{7}', 'product Global ID short-link reservation')

const zonedDateTime = read('app_src/lib/zonedDateTime.ts')
assertIncludes(zonedDateTime, 'export function zonedDateTimeToIso', 'timezone-aware CRM meeting conversion')
assertIncludes(zonedDateTime, 'export function dateTimeLocalValue', 'timezone-aware CRM meeting editor value')

const suiteCrmClient = read('app_src/lib/crm/suiteCrmClient.ts')
const suiteCrmInteractionContactBackfill = read('scripts/backfill-suitecrm-interaction-contacts.mjs')
const unresolvedCrmInteractionCleanup = read('scripts/delete-unresolved-crm-interactions.mjs')
const productionTestDataCleanup = read('scripts/retire-production-test-data.mjs')
const nickAccessReconciliation = read('scripts/reconcile-nick-access.mjs')
assertIncludes(suiteCrmClient, '/Api/access_token', 'SuiteCRM OAuth client credentials')
assertIncludes(suiteCrmClient, '/Api/V8/module', 'SuiteCRM JSON API')
assertIncludes(suiteCrmClient, 'deleteSuiteCrmRecord', 'SuiteCRM duplicate deletion')
assertIncludes(suiteCrmClient, "hostname.endsWith('.railway.internal')", 'private Railway SuiteCRM transport')
assertIncludes(suiteCrmClient, '/relationships/${linkFieldName}', 'SuiteCRM subpanel relationship endpoint')
assertIncludes(suiteCrmClient, "'contact', 'contacts'", 'SuiteCRM Note and Meeting contact link fields')
assertIncludes(suiteCrmClient, 'alreadyLinked', 'idempotent SuiteCRM relationship creation')
assertIncludes(suiteCrmClient, "'filter[date_modified][gte]'", 'incremental SuiteCRM meeting polling')
assertIncludes(suiteCrmClient, 'listSuiteCrmAccountContactRecordsUpdatedSince', 'incremental SuiteCRM account/contact polling')
assertIncludes(suiteCrmClient, 'findSuiteCrmUser', 'SuiteCRM app-user mapping lookup')
assertIncludes(suiteCrmClient, '/Api/V8/module/Users', 'SuiteCRM active user module lookup')
assertIncludes(suiteCrmClient, 'upsertSuiteCrmUserIdentity', 'SuiteCRM native user Global ID projection')
assertIncludes(suiteCrmClient, 'attributes: { user_name: username, global_id_c: referenceCode }', 'SuiteCRM canonical gu username projection')
assertIncludes(suiteCrmClient, 'SuiteCRM employee username must equal the permanent ClawPilot Global ID', 'SuiteCRM canonical username guard')
assertIncludes(suiteCrmClient, 'SuiteCRM user already has a different permanent ClawPilot Global ID', 'SuiteCRM user Global ID overwrite protection')
assertIncludes(suiteCrmClient, 'ClawPilot user Global ID is already assigned to another SuiteCRM user', 'SuiteCRM user Global ID duplicate protection')
assertIncludes(suiteCrmClient, "products: 'AOS_Products'", 'SuiteCRM product module mapping')
assertIncludes(suiteCrmInteractionContactBackfill, "CLAWPILOT_BACKFILL_CONFIRM !== 'interaction-contacts-v1'", 'guarded SuiteCRM interaction contact backfill')
assertIncludes(suiteCrmInteractionContactBackfill, "linkFieldName: 'contact'", 'SuiteCRM Note contact backfill relationship')
assertIncludes(suiteCrmInteractionContactBackfill, 'contact_id: row.contact_suitecrm_id', 'SuiteCRM Note contact backfill field')
assertIncludes(unresolvedCrmInteractionCleanup, "REFERENCE_CODES = ['gi4623602', 'gi6564750']", 'operator-approved unresolved interaction cleanup scope')
assertIncludes(unresolvedCrmInteractionCleanup, "sourceSuffix: ':interactions:22'", 'development interaction mirror fingerprint')
assertIncludes(unresolvedCrmInteractionCleanup, 'proofsupport.com/4yaemq7gve', 'verified unresolved interaction description fingerprint')
assertIncludes(unresolvedCrmInteractionCleanup, "CLAWPILOT_DELETE_CONFIRM !== 'unresolved-interactions-v1'", 'guarded unresolved interaction cleanup')
assertIncludes(unresolvedCrmInteractionCleanup, "operation = 'upsert_record'", 'cancel stale SuiteCRM interaction upserts before deletion')
assertIncludes(unresolvedCrmInteractionCleanup, "status = 'retired'", 'deleted CRM references remain permanently reserved')
assertIncludes(productionTestDataCleanup, "INTERACTION_REFERENCES = ['gi4021276', 'gi9599849']", 'approved production test interaction cleanup scope')
assertIncludes(productionTestDataCleanup, "EXPECTED_MEETING_REFERENCE = 'gm1880682'", 'approved production test meeting cleanup scope')
assertIncludes(productionTestDataCleanup, "CLAWPILOT_RETIRE_CONFIRM !== CONFIRMATION", 'guarded production test cleanup')
assertIncludes(productionTestDataCleanup, "status = 'retired'", 'retired test Global IDs remain reserved')
assertIncludes(productionTestDataCleanup, "sync.outbox.superseded_by_operator", 'obsolete outbox history receives durable supersession audit evidence')
assertIncludes(nickAccessReconciliation, 'Nick\'s Organization', 'Nick organization name remains unchanged')
assertIncludes(nickAccessReconciliation, "role = 'admin'", 'Nick retains global app admin role')
assertIncludes(nickAccessReconciliation, "status = 'disabled'", 'Nick remains disabled while retaining admin role')
assertIncludes(nickAccessReconciliation, "revoked_reason = 'account_disabled_by_operator'", 'Nick disabled reconciliation revokes browser sessions')
assertIncludes(nickAccessReconciliation, 'nick-disabled-admin-v2', 'Nick disabled reconciliation requires explicit operator confirmation')
assert.doesNotMatch(nickAccessReconciliation, /status\s*=\s*'active'/, 'Nick reconciliation must never reactivate access')
assertIncludes(nickAccessReconciliation, "if (!current.rows[0].parent_id)", 'Nick remains scoped to a child organization')
assertIncludes(suiteCrmClient, "'Accounts' | 'Contacts'", 'bounded SuiteCRM account/contact modules')
assertIncludes(suiteCrmClient, 'type !== moduleName && type !== recordType', 'SuiteCRM singular JSON API record types')

const suiteCrmGlobalIdBootstrap = read('services/suitecrm/bootstrap-global-id.php')
assertIncludes(suiteCrmGlobalIdBootstrap, "const CLAWPILOT_GLOBAL_ID_FIELD = 'global_id_c'", 'native SuiteCRM Global ID field')
assertIncludes(suiteCrmGlobalIdBootstrap, "const CLAWPILOT_NOTE_OCCURRED_AT_FIELD = 'occurred_at_c'", 'native SuiteCRM interaction occurrence field')
assertIncludes(suiteCrmGlobalIdBootstrap, '$field->unified_search = $unifiedSearch ? 1 : 0', 'module-scoped native SuiteCRM Global ID unified search')
assertIncludes(suiteCrmGlobalIdBootstrap, "ensure_global_id_field('Users', false)", 'native SuiteCRM User Global ID field')
assertIncludes(suiteCrmGlobalIdBootstrap, "'Meetings'", 'SuiteCRM meeting Global ID field')
assertIncludes(suiteCrmGlobalIdBootstrap, "'AOS_Products'", 'SuiteCRM product Global ID field')
assertIncludes(suiteCrmGlobalIdBootstrap, 'expose_global_id_in_detail_view', 'SuiteCRM Global ID detail layout')
assertIncludes(suiteCrmGlobalIdBootstrap, 'expose_global_id_in_list_view', 'SuiteCRM Global ID list layout')
assertIncludes(suiteCrmGlobalIdBootstrap, "expose_global_id_in_search_view($module, 'basic_search')", 'SuiteCRM Global ID basic search layout')
assertIncludes(suiteCrmGlobalIdBootstrap, "expose_global_id_in_search_view($module, 'advanced_search')", 'SuiteCRM Global ID advanced search layout')
assertIncludes(suiteCrmGlobalIdBootstrap, 'ensure_global_id_search_field', 'SuiteCRM Global ID search field metadata')
assertIncludes(suiteCrmGlobalIdBootstrap, "'force_unifiedsearch' => true", 'SuiteCRM immediate unified search inclusion')
assertIncludes(suiteCrmGlobalIdBootstrap, 'rebuild_and_verify_global_search', 'SuiteCRM Global ID search cache verification')
assertIncludes(suiteCrmGlobalIdBootstrap, "sugar_cached('modules/unified_search_modules.php')", 'SuiteCRM unified search cache invalidation')
assertIncludes(suiteCrmGlobalIdBootstrap, 'ensure_note_occurred_at_field', 'SuiteCRM Note occurrence field bootstrap')

const suiteCrmEntrypoint = read('services/suitecrm/entrypoint.sh')
assertIncludes(suiteCrmEntrypoint, 'APP_ENV=prod php bin/console cache:clear --no-warmup', 'strict SuiteCRM application cache clear')
assertIncludes(suiteCrmEntrypoint, 'APP_ENV=prod php bin/console cache:warmup', 'SuiteCRM application cache warmup')

const suiteCrmGlobalIdBackfill = read('scripts/backfill-suitecrm-global-ids.mjs')
assertIncludes(suiteCrmGlobalIdBackfill, 'global_id_c: row.reference_code', 'existing SuiteCRM Global ID backfill')
assertIncludes(suiteCrmGlobalIdBackfill, 'meetingRelationships', 'existing SuiteCRM meeting relationship backfill')

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
assertIncludes(crmWorker, 'upsertSuiteCrmUserIdentity(item.payload)', 'SuiteCRM user identity outbox worker')
assertIncludes(crmWorker, "item.operation !== 'upsert_user_identity'", 'SuiteCRM user identity workbook projection isolation')
assertIncludes(crmWorker, "operation: 'project_crm_workbook'", 'CRM to workbook projection enqueue')

const crmPunchoutRoute = read('app_src/app/api/crm/punchout/route.ts')
assertIncludes(crmPunchoutRoute, 'effectiveAuthorizationRole(actor)', 'active-workspace role for native CRM punchout')
assertIncludes(crmPunchoutRoute, "role !== 'owner' && role !== 'admin'", 'admin-only native CRM punchout')
assertIncludes(crmPunchoutRoute, 'suiteCrmPublicUrl()', 'validated native CRM destination')
assertIncludes(crmPunchoutRoute, "'Cache-Control': 'no-store'", 'native CRM punchout cache boundary')

const crmRoute = read('app_src/app/api/crm/route.ts')
assertIncludes(crmRoute, 'suiteCrmAdminUsername()', 'admin native CRM username guidance')
assertIncludes(crmRoute, 'suiteCrmAdminPortalUrl()', 'admin native CRM password-management link')

const crmUi = read('app_src/components/crm/CrmSection.tsx')
assertIncludes(crmUi, 'SuiteCRM sign in', 'native CRM access dialog')
assertIncludes(crmUi, 'SUITECRM_ADMIN_PASSWORD', 'native CRM protected password guidance')
assertIncludes(crmUi, "parameters.set('needsReview', 'true')", 'unresolved interaction review UI filter')
assertIncludes(crmUi, 'openRelatedContact', 'organization related-contact drawer navigation')
assertIncludes(crmUi, 'openRelatedOrganization', 'contact related-organization drawer navigation')
assertIncludes(crmUi, 'Related organization', 'contact organization relationship panel')
assertIncludes(crmUi, 'Contact Full Name', 'contact full-name field label')
assertIncludes(crmUi, 'priorityOptions.map', 'contact priority catalog selector')
assertIncludes(crmUi, 'openRelatedOpportunity', 'account and contact opportunity navigation')
assertIncludes(crmUi, 'No related opportunities', 'account and contact opportunity empty state')
assertIncludes(crmUi, 'crm-primary-actions', 'contained mobile CRM command row')
assertIncludes(crmUi, 'CRM record types', 'accessible mobile CRM tabs')
assertIncludes(crmUi, 'No related contacts', 'organization contact subpanel empty state')
assertIncludes(crmUi, 'LinkedIn URL', 'organization and contact metadata editing')
assertIncludes(crmUi, 'Postal code', 'organization and contact address metadata editing')
assertIncludes(crmUi, 'pipelineUsers', 'interaction ClawPilot agent catalog')
assertIncludes(crmUi, 'select required label="Type"', 'interaction controlled type selector')
assertIncludes(crmUi, 'select label="Contact"', 'interaction contact selector')
assertIncludes(crmUi, 'label="Agent"', 'interaction ClawPilot user selector')
assertIncludes(crmUi, 'LEGACY_CONTACT_OWNER', 'legacy Contact owner display state')
assertIncludes(crmUi, 'ownerUserReferenceCode: referenceCode', 'Contact owner stable-identity selection')
assertIncludes(crmUi, '<MenuItem value="">Unassigned</MenuItem>', 'Contact owner unassigned option')
assertIncludes(crmUi, 'delete saved.ownerUserReferenceCode', 'untouched legacy Contact owner preservation')
assertIncludes(crmRoute, '...(fields.ownerUserReferenceCode === undefined ? {}', 'legacy Contact owner API omission')
assertIncludes(crmAdapter, 'fields.ownerSuiteCrmUserId === undefined ? {}', 'legacy SuiteCRM owner assignment preservation')

const userAccessUi = read('app_src/components/settings/UserAccessDialog.tsx')
assertIncludes(userAccessUi, 'Sync CRM identity', 'admin canonical SuiteCRM identity command')
assertIncludes(userAccessUi, "action: 'crm-user-sync'", 'admin canonical SuiteCRM identity request')
assertIncludes(userAccessUi, 'Permanent ClawPilot user Global ID', 'read-only canonical SuiteCRM username guidance')
assertIncludes(userAccessUi, "action: 'crm-employee'", 'explicit CRM employee access request')
assertIncludes(userAccessUi, 'CRM employee', 'CRM employee invitation and access control')
assertIncludes(userAccessUi, 'label="CRM user Global ID"', 'gu app-user identity display')
assertIncludes(userAccessUi, 'currentUser.contactReferenceCode', 'separate gc Contact identity display')
assertIncludes(usersRoute, "body?.action === 'crm-user-sync'", 'SuiteCRM app-user identity sync route')
assertIncludes(usersRoute, "body?.action === 'crm-employee'", 'CRM employee access route')
assertIncludes(usersAdapter, 'syncAppUserSuiteCrmIdentity', 'SuiteCRM canonical app-user identity persistence')
assertIncludes(usersAdapter, 'username: user.referenceCode', 'SuiteCRM gu username outbox payload')

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
const pipelinePersistence = read('app_src/lib/persistence/pipeline.ts')
assertIncludes(pipelinePersistence, 'syncPipelineProductDropdownCatalogInPostgres', 'generated product and owner dropdown synchronization')
assertIncludes(pipelinePersistence, 'ownerNames?: string[]', 'tenant owner dropdown input')
assertIncludes(pipelinePersistence, 'pipeline_dropdown_catalogs', 'app-managed dropdown persistence')
assertIncludes(pipelinePersistence, "operation: 'patch_dropdowns'", 'Sheet-backed dropdown patch outbox')
assertIncludes(pipelinePersistence, 'desired_revision = desired_revision + 1', 'monotonic dropdown desired revision')
assertIncludes(pipelinePersistence, 'applied_revision = GREATEST', 'successful dropdown applied revision')
assertIncludes(pipelinePersistence, "status IN ('failed', 'dead')", 'terminal dropdown delivery requeue')

const opportunityRoute = read('app_src/app/api/pipeline/opportunity/[id]/route.ts')
assertIncludes(opportunityRoute, 'readCrmOpportunityInPostgres', 'CRM-authoritative opportunity route')
assertIncludes(opportunityRoute, 'stageCrmRecordInPostgres', 'CRM-authoritative opportunity route')
assertIncludes(opportunityRoute, "entity: 'interactions'", 'CRM interaction writeback')
assertIncludes(opportunityRoute, 'updateCrmOpportunityInPostgres', 'atomic CRM opportunity writeback')
assertIncludes(crmAdapter, "entity: 'opportunities'", 'CRM opportunity persistence writeback')
assertIncludes(opportunityRoute, 'expectedUpdatedAt', 'opportunity optimistic write contract')
assertIncludes(crmAdapter, 'different opportunity update', 'payload-bound opportunity update idempotency')
assertIncludes(crmAdapter, 'different opportunity comment', 'payload-bound opportunity comment idempotency')
assertIncludes(opportunityRoute, 'resolvePipelineSpaceAccess', 'opportunity tenancy contract')
assertIncludes(opportunityRoute, 'requireResourceEditor', 'opportunity edit access contract')
assert.ok(!opportunityRoute.includes('upsertPipelineProjectionInPostgres'), 'opportunity route must not bypass CRM authority')
assert.ok(!opportunityRoute.includes('googleSheetsJson'), 'opportunity route must not write Google Sheets directly')

const outboxWorker = read('app_src/lib/pipelineOutboxWorker.ts')
assertIncludes(outboxWorker, 'claimPipelineSyncOutboxInPostgres', 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'update_opportunity'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'append_interaction'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'replace_dropdowns'", 'pipeline outbox worker')
assertIncludes(outboxWorker, "item.operation === 'patch_dropdowns'", 'pipeline dropdown patch worker')
assertIncludes(outboxWorker, "item.operation === 'apply_workbook_branding'", 'pipeline workbook branding worker')
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
assertIncludes(
  outboxWorker,
  'error instanceof GoogleWorkspaceClientError && !error.retryable',
  'terminal Google Workspace failure classification',
)
assertIncludes(outboxWorker, '? item.attempts', 'terminal Google Workspace failure retry suppression')
assert.ok(
  outboxWorker.indexOf("item.operation === 'provision_pipeline'")
    < outboxWorker.indexOf('resolvePipelineOutboxSheetContextInPostgres(item)'),
  'pipeline provisioning must dispatch before normal Sheet-context resolution',
)

const workspacesRoute = read('app_src/app/api/workspaces/route.ts')
const dashboardWorkspaceAdapter = read('app_src/lib/dashboardWorkspace.ts')
assertIncludes(workspacesRoute, "action === 'provision-pipeline'", 'owner-confirmed pipeline provisioning action')
assertIncludes(workspacesRoute, "pipeline.accessRole !== 'owner'", 'pipeline provisioning owner access')
assert.ok(!workspacesRoute.includes('driveConnectionId: body'), 'workspace route must not accept a Drive connection binding')
assert.ok(!workspacesRoute.includes('sheetsConnectionId: body'), 'workspace route must not accept a Sheets connection binding')
assertIncludes(dashboardWorkspaceAdapter, 'const { projection, sheetId, shortLinkId, ...summary }', 'workspace pipeline resource ID redaction')
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
assertIncludes(googleWorkspaceClient, 'googleUpstreamErrorDetails', 'bounded Google upstream error details')
assertIncludes(googleWorkspaceClient, 'GOOGLE_REQUEST_REJECTED', 'actionable Google request rejection')
assertIncludes(googleWorkspaceClient, "'[email]'", 'Google upstream email redaction')
assertIncludes(googleWorkspaceClient, "'[redacted]'", 'Google upstream token redaction')

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
assertIncludes(agentDispatchWorker, "'X-ClawPilot-Operator': input.item.operatorId", 'scoped agent dispatch operator identity')
assertIncludes(agentDispatchWorker, "'X-ClawPilot-Board-Id': input.item.boardId", 'scoped agent dispatch board identity')
assert.ok(!agentDispatchWorker.includes('Cookie:'), 'agent dispatch worker must not fabricate browser cookies')
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
assertIncludes(authProxy, 'resolveRequestSession', 'durable auth proxy')
assertIncludes(authProxy, 'createAuthAttributionHeaders', 'signed request attribution')
assertIncludes(authProxy, 'authorizedWorkerRequest', 'separate worker authentication')
assertIncludes(authProxy, '_next/static', 'auth proxy matcher')
assertIncludes(authProxy, '/api/runtime', 'auth proxy public runtime diagnostic')
assertIncludes(authProxy, '/api/persistence/status', 'auth proxy public persistence diagnostic')
assertIncludes(authProxy, '/api/pipeline/sync/outbox/process', 'auth proxy public worker route')
assertIncludes(authProxy, '/api/agents/dispatch/process', 'auth proxy public agent worker route')
assertIncludes(authProxy, '/api/agents/research/process', 'auth proxy public agent research worker route')
assertIncludes(authProxy, '/api/agents/repository-runs/process', 'auth proxy public repository worker route')
assertIncludes(authProxy, '/api/integrations/toast/process', 'auth proxy public Toast worker route')
assertIncludes(authProxy, '/api/integrations/quickbooks/process', 'auth proxy public QuickBooks worker route')
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
assertIncludes(magicVerifyRoute, 'createBrowserSession', 'durable magic-code session issuance')
assertIncludes(magicVerifyRoute, 'queuePipelineProvisioning', 'automatic personal pipeline Sheet provisioning')

const tenancyDataVerifier = read('scripts/verify-tenancy-provisioning.mjs')
assertIncludes(tenancyDataVerifier, "pipeline.provisioning_status = 'ready'", 'personal pipeline ready-state invariant')
assertIncludes(tenancyDataVerifier, "outbox.status IN ('queued', 'processing')", 'durable personal pipeline provisioning invariant')
assertIncludes(tenancyDataVerifier, 'count(DISTINCT projection.pipeline_id) <> 1', 'organization-primary CRM pipeline invariant')

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
assertIncludes(healthRoute, '0033_crm_board_projection_and_legacy_alias_cleanup.sql', 'hosted CRM board projection migration health')
assertIncludes(healthRoute, '0035_suitecrm_inbound_sync_status.sql', 'hosted SuiteCRM inbound sync migration health')
assertIncludes(healthRoute, '0036_crm_display_text_and_card_semantics.sql', 'hosted CRM display text migration health')
assertIncludes(healthRoute, '0040_browser_sessions_and_impersonation.sql', 'hosted browser session migration health')
assertIncludes(healthRoute, '0045_pipeline_people_products_and_dropdown_catalogs.sql', 'hosted pipeline catalog migration health')
assertIncludes(healthRoute, '0046_atomic_pipeline_products_and_sync_retry_state.sql', 'hosted atomic product catalog migration health')
assertIncludes(healthRoute, '0047_workspace_organization_branding.sql', 'hosted organization branding migration health')
assertIncludes(healthRoute, '0053_seed_empty_pipeline_templates.sql', 'hosted empty pipeline template migration health')
assertIncludes(healthRoute, '0054_crm_contact_owner_user_identity.sql', 'hosted CRM contact owner identity migration health')
assertIncludes(healthRoute, '0056_crm_employee_identity_and_workbook_dashboard.sql', 'hosted CRM employee identity migration health')
assertIncludes(healthRoute, '0057_canonical_suitecrm_usernames.sql', 'hosted canonical SuiteCRM username migration health')
assertIncludes(healthRoute, '0058_agent_public_research_outbox.sql', 'hosted agent research migration health')
assertIncludes(healthRoute, '0059_toast_restaurant_integrations.sql', 'hosted Toast integration migration health')
assertIncludes(healthRoute, '0060_multi_workspace_memberships.sql', 'hosted multi-workspace membership migration health')
assertIncludes(healthRoute, '0048_canonical_pipeline_negotiation_spelling.sql', 'hosted pipeline spelling migration health')
assertIncludes(healthRoute, '0049_residual_pipeline_catalog_repair.sql', 'hosted residual pipeline catalog migration health')
assertIncludes(healthRoute, '0050_historical_pipeline_catalog_restore.sql', 'hosted historical pipeline catalog migration health')
assertIncludes(healthRoute, '0051_preserve_configured_pipeline_dropdowns.sql', 'hosted configured pipeline dropdown preservation health')
assertIncludes(healthRoute, '0052_restore_canonical_dropdown_layout.sql', 'hosted canonical dropdown layout migration health')
assertIncludes(healthRoute, 'readSuiteCrmWorkerHeartbeat', 'hosted SuiteCRM worker health')
assertIncludes(healthRoute, 'migration_checksums_present', 'hosted migration checksum health')
assertIncludes(healthRoute, 'queryAgentCredentials', 'shared agent credential store health')
assertIncludes(healthRoute, 'readAgentDispatchWorkerHeartbeatFromPostgres', 'hosted agent worker health')
assertIncludes(healthRoute, 'readAgentResearchWorkerHeartbeatFromPostgres', 'hosted agent research worker health')
assertIncludes(healthRoute, 'readToastWorkerHeartbeatFromPostgres', 'hosted Toast worker health')
assertIncludes(healthRoute, 'getAgentRuntime', 'hosted agent runtime health')
for (const migration of [
  '0067_toast_pos_orders.sql',
  '0068_quickbooks_write_connection_binding.sql',
  '0069_pos_accounting_profiles_and_catalog_mappings.sql',
  '0070_toast_menu_catalog.sql',
  '0071_quickbooks_accounting_reference_catalogs.sql',
  '0072_toast_sync_rerun_requests.sql',
  '0073_toast_sync_worker_hardening.sql',
  '0074_pos_accounting_issue_notifications.sql',
  '0075_quickbooks_write_binding_compatibility.sql',
  '0076_pos_accounting_notification_consent.sql',
  '0078_pos_accounting_date_commands.sql',
  '0079_pos_accounting_posting_outcomes.sql',
  '0080_external_pos_accounting_outcomes.sql',
]) {
  assertIncludes(healthRoute, migration, 'hosted POS and accounting migration health')
}

const persistenceStatusRoute = read('app_src/app/api/persistence/status/route.ts')
assertIncludes(persistenceStatusRoute, 'deployment.database.identity', 'deployment database identity lookup')
assertIncludes(persistenceStatusRoute, 'Boolean(databaseFingerprint)', 'missing database identity health failure')
assertIncludes(persistenceStatusRoute, "status: hosted ? 503 : 200", 'hosted file-storage health failure')

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
assertIncludes(tasksRoute, 'CRM cards are created from CRM accounts and contacts', 'managed CRM board creation guard')
assertIncludes(tasksRoute, 'resolvePipelineSpaceAccess', 'CRM board and pipeline access intersection')
assertIncludes(tasksRoute, 'CrmDescriptionConflictError', 'stale CRM card update rejection')

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
