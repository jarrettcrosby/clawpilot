#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()

function fail(message) {
  console.error(`predeploy check failed: ${message}`)
  process.exit(1)
}

function ok(message) {
  console.log(`OK: ${message}`)
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'))
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}`)
  }
}

console.log('Running ClawPilot predeploy verification...')

if (!existsSync(resolve(root, 'package.json'))) {
  fail('missing root package.json')
}

if (!existsSync(resolve(root, 'app_src/package.json'))) {
  fail('missing app_src/package.json')
}

if (!existsSync(resolve(root, 'app_src/vercel.json'))) {
  fail('missing app_src/vercel.json')
}

if (!existsSync(resolve(root, 'railway.json'))) {
  fail('missing railway.json')
}

const vercel = readJson('app_src/vercel.json')
if (String(vercel.installCommand || '') !== 'npm ci') {
  fail('app_src/vercel.json installCommand must be "npm ci"')
}

if (String(vercel.buildCommand || '') !== 'npm run build:vercel') {
  fail('app_src/vercel.json buildCommand must be "npm run build:vercel"')
}

if (String(vercel.outputDirectory || '') !== '.next') {
  fail('app_src/vercel.json outputDirectory must be ".next"')
}

if (!existsSync(resolve(root, 'app_src/package-lock.json'))) {
  fail('missing app_src/package-lock.json required by Vercel npm ci')
}

const railway = readJson('railway.json')
if (String(railway?.deploy?.healthcheckPath || '') !== '/api/health') {
  fail('railway.json deploy.healthcheckPath must be "/api/health"')
}

if (!String(railway?.deploy?.startCommand || '').includes('npm run start:railway')) {
  fail('railway.json deploy.startCommand must use "npm run start:railway"')
}

if (String(railway?.deploy?.preDeployCommand || '') !== 'bash scripts/predeploy-railway.sh') {
  fail('railway.json deploy.preDeployCommand must use scripts/predeploy-railway.sh')
}

const railwayPredeploy = readFileSync(resolve(root, 'scripts/predeploy-railway.sh'), 'utf8')
for (const requiredCommand of [
  'npm run mail:verify',
  'npm run db:migrate',
  'npm run demo:seed',
  'npm run demo:verify',
]) {
  if (!railwayPredeploy.includes(requiredCommand)) {
    fail(`scripts/predeploy-railway.sh must run "${requiredCommand}"`)
  }
}

const railwayStart = readFileSync(resolve(root, 'scripts/start-railway.sh'), 'utf8')
if (!railwayStart.includes('npm run release:record')) {
  fail('scripts/start-railway.sh must record a release after runtime health validation')
}

const healthGatePosition = railwayStart.indexOf('[[ "$HEALTHY" == "1" ]]')
const releaseRecordPosition = railwayStart.indexOf('npm run release:record')
if (healthGatePosition < 0 || releaseRecordPosition < healthGatePosition) {
  fail('scripts/start-railway.sh must record releases only after runtime health validation')
}

for (const requiredPath of [
  'db/migrations/0002_pipeline_outbox_worker.sql',
  'db/migrations/0009_agent_dispatch_outbox.sql',
  'db/migrations/0003_auth_magic_codes.sql',
  'db/migrations/0004_agent_chatgpt_auth.sql',
  'db/migrations/0005_app_users.sql',
  'db/migrations/0006_agent_user_attribution.sql',
  'db/migrations/0007_multi_tenant_workspaces.sql',
  'db/migrations/0008_workspace_security_hardening.sql',
  'db/migrations/0010_user_invitations.sql',
  'db/migrations/0011_knowledge_releases_checkpoints.sql',
  'db/migrations/0012_invitation_release_hardening.sql',
  'db/migrations/0013_invitation_delivery_coordination.sql',
  'db/migrations/0014_invitation_delivery_pending.sql',
  'db/migrations/0015_short_links.sql',
  'db/migrations/0016_document_vectors_and_ai_radar.sql',
  'db/migrations/0016_z_short_link_destination_preflight.sql',
  'db/migrations/0017_short_link_destination_hardening.sql',
  'db/migrations/0018_user_maton_credentials.sql',
  'db/migrations/0019_managed_pipeline_google_resources.sql',
  'db/migrations/0020_crm_gateway_and_reporting.sql',
  'db/migrations/0021_crm_identity_and_organization_hierarchy.sql',
  'db/migrations/0022_pipeline_sheet_access_links.sql',
  'db/migrations/0023_crm_modules_references_and_integrations.sql',
  'db/migrations/0024_versioned_drive_hierarchy_reconciliation.sql',
  'db/migrations/0025_profile_crm_projection_backfill.sql',
  'db/migrations/0026_legacy_drive_hierarchy_cleanup.sql',
  'db/migrations/0027_verified_legacy_drive_cleanup.sql',
  'db/migrations/0028_eventual_drive_cleanup_reconciliation.sql',
  'db/migrations/0029_verified_drive_trash_reconciliation.sql',
  'db/migrations/0030_random_crm_references_and_organization_email.sql',
  'db/migrations/0031_global_crm_reference_number_registry.sql',
  'db/migrations/0032_reference_allocation_leak_cleanup.sql',
  'db/migrations/0033_crm_board_projection_and_legacy_alias_cleanup.sql',
  'db/migrations/0034_account_membership_crm_board_scope.sql',
  'db/migrations/0035_suitecrm_inbound_sync_status.sql',
  'db/migrations/0036_crm_display_text_and_card_semantics.sql',
  'db/migrations/0037_audit_activity_indexes.sql',
  'db/migrations/0038_dedupe_crm_stage_audit.sql',
  'db/migrations/0039_agent_context_memory.sql',
  'db/migrations/0040_browser_sessions_and_impersonation.sql',
  'db/migrations/0041_dashboard_workspace_preferences.sql',
  'db/migrations/0042_crm_opportunity_contacts.sql',
  'db/migrations/0043_crm_interaction_user_mapping.sql',
  'db/migrations/0044_browser_session_ip_attribution.sql',
  'db/migrations/0045_pipeline_people_products_and_dropdown_catalogs.sql',
  'db/migrations/0046_atomic_pipeline_products_and_sync_retry_state.sql',
  'db/migrations/0047_workspace_organization_branding.sql',
  'db/migrations/0048_canonical_pipeline_negotiation_spelling.sql',
  'db/migrations/0049_residual_pipeline_catalog_repair.sql',
  'db/migrations/0050_historical_pipeline_catalog_restore.sql',
  'db/migrations/0051_preserve_configured_pipeline_dropdowns.sql',
  'db/migrations/0052_restore_canonical_dropdown_layout.sql',
  'db/migrations/0053_seed_empty_pipeline_templates.sql',
  'db/migrations/0054_crm_contact_owner_user_identity.sql',
  'db/migrations/0055_repository_runner_control_plane.sql',
  'db/migrations/0056_crm_employee_identity_and_workbook_dashboard.sql',
  'db/migrations/0057_canonical_suitecrm_usernames.sql',
  'db/migrations/0058_agent_public_research_outbox.sql',
  'db/migrations/0059_toast_restaurant_integrations.sql',
  'db/migrations/0060_multi_workspace_memberships.sql',
  'db/migrations/0061_quickbooks_organization_connector.sql',
  'db/migrations/0062_quickbooks_financial_explorer.sql',
  'db/migrations/0063_quickbooks_financial_reports.sql',
  'db/migrations/0064_quickbooks_write_control.sql',
  'db/migrations/0065_demo_and_quickbooks_crm_reconciliation.sql',
  'db/migrations/0066_demo_workspace_account.sql',
  'db/migrations/0067_toast_pos_orders.sql',
  'db/migrations/0068_quickbooks_write_connection_binding.sql',
  'db/migrations/0069_pos_accounting_profiles_and_catalog_mappings.sql',
  'db/migrations/0070_toast_menu_catalog.sql',
  'db/migrations/0071_quickbooks_accounting_reference_catalogs.sql',
  'db/migrations/0072_toast_sync_rerun_requests.sql',
  'db/migrations/0073_toast_sync_worker_hardening.sql',
  'db/migrations/0074_pos_accounting_issue_notifications.sql',
  'db/migrations/0075_quickbooks_write_binding_compatibility.sql',
  'db/migrations/0076_pos_accounting_notification_consent.sql',
  'db/migrations/0077_zero_sales_accounting_draft_suppression.sql',
  'db/migrations/0078_pos_accounting_date_commands.sql',
  'db/migrations/0079_pos_accounting_posting_outcomes.sql',
  'db/migrations/0080_external_pos_accounting_outcomes.sql',
  'db/migrations/0081_distributed_operations_foundation.sql',
  'db/migrations/0082_operations_activation_and_command_safety.sql',
  'db/migrations/0083_crm_interaction_contacts.sql',
  'db/migrations/0084_operations_command_results.sql',
  'db/migrations/0085_operations_package_workflow.sql',
  'db/migrations/0086_product_packaging_profiles.sql',
  'db/migrations/0087_operations_carrier_credentials.sql',
  'db/migrations/0088_operations_sandbox_rating_and_mock_retirement.sql',
  '.github/workflows/clawpilot-repository-runner.yml',
  '.github/workflows/deployed-runtime-monitor.yml',
  'scripts/start-railway.sh',
  'scripts/test-suitecrm-interaction-ingestion.mjs',
  'scripts/pipeline-outbox-poller.mjs',
  'scripts/verify-tenancy-provisioning.mjs',
  'scripts/validate-runtime-config.mjs',
  'scripts/smoke-deployed-runtime.mjs',
  'scripts/monitor-deployed-runtime.mjs',
  'scripts/test-deployed-runtime-monitor.mjs',
  'scripts/record-release.mjs',
  'scripts/verify-repository-hygiene.mjs',
  'scripts/vercel-build.mjs',
  'scripts/verify-mail-sender.mjs',
  'docs/index.md',
  'docs/modules/toast-and-accounting.md',
  'docs/releases/catalog.json',
  'app_src/proxy.ts',
  'app_src/app/api/auth/magic/request/route.ts',
  'app_src/app/api/auth/magic/verify/route.ts',
  'app_src/app/api/auth/session/route.ts',
  'app_src/app/api/auth/session/activity/route.ts',
  'app_src/app/api/auth/sessions/route.ts',
  'app_src/app/api/auth/impersonation/route.ts',
  'app_src/app/api/agents/auth/route.ts',
  'app_src/app/api/agents/auth/poll/route.ts',
  'app_src/app/api/agents/dispatch/process/route.ts',
  'app_src/app/api/agents/research/process/route.ts',
  'app_src/app/api/agents/repository-runs/route.ts',
  'app_src/app/api/agents/repository-runs/process/route.ts',
  'app_src/app/api/agents/repository-runs/report/route.ts',
  'app_src/app/api/ai-radar/process/route.ts',
  'app_src/app/api/docs/embeddings/process/route.ts',
  'app_src/app/api/shortlinks/route.ts',
  'app_src/app/api/crm/actions/route.ts',
  'app_src/app/api/crm/integrations/process/route.ts',
  'app_src/app/api/integrations/maton/route.ts',
  'app_src/app/api/integrations/google-workspace/route.ts',
  'app_src/app/api/integrations/toast/route.ts',
  'app_src/app/api/integrations/toast/process/route.ts',
  'app_src/app/api/integrations/quickbooks/route.ts',
  'app_src/app/api/integrations/quickbooks/process/route.ts',
  'app_src/app/s/[slug]/route.ts',
  'app_src/lib/agentDispatchWorker.ts',
  'app_src/lib/agentResearchWorker.ts',
  'app_src/lib/persistence/agentResearch.ts',
  'app_src/lib/integrations/toastClient.ts',
  'app_src/lib/integrations/toastCredentialCrypto.ts',
  'app_src/lib/integrations/toastIntegrations.ts',
  'app_src/lib/persistence/toastIntegrations.ts',
  'app_src/lib/toastSyncWorker.ts',
  'app_src/lib/integrations/quickBooksCatalog.mjs',
  'app_src/lib/integrations/quickBooksClient.ts',
  'app_src/lib/integrations/quickBooksIntegrations.ts',
  'app_src/lib/persistence/quickBooksIntegrations.ts',
  'app_src/lib/quickBooksSyncWorker.ts',
  'app_src/lib/agents/repositoryRunnerConfig.ts',
  'app_src/lib/githubApp.ts',
  'app_src/lib/persistence/repositoryRuns.ts',
  'app_src/lib/repositoryRunWorker.ts',
  'scripts/test-repository-runner.mjs',
  'app_src/lib/authSessions.ts',
  'app_src/lib/authAttribution.ts',
  'app_src/lib/requestIpAddress.ts',
  'app_src/lib/workerAuth.ts',
  'app_src/lib/aiRadar.ts',
  'app_src/lib/documentEmbeddings.ts',
  'app_src/lib/shortlinks.ts',
  'app_src/lib/crm/integrationActions.ts',
  'app_src/lib/crm/emailIngestion.ts',
  'app_src/lib/integrations/matonCredentials.ts',
  'app_src/lib/integrations/googleWorkspace.ts',
  'app_src/lib/integrations/googleWorkspaceClient.ts',
  'app_src/lib/integrations/googleWorkspaceCrypto.ts',
  'app_src/lib/persistence/googleWorkspace.ts',
  'app_src/lib/persistence/matonCredentials.ts',
  'app_src/components/settings/GoogleWorkspaceIntegrationPanel.tsx',
  'app_src/components/settings/IntegrationSettingsPanel.tsx',
  'app_src/components/settings/ToastIntegrationPanel.tsx',
  'app_src/components/settings/QuickBooksIntegrationPanel.tsx',
  'app_src/app/api/users/route.ts',
  'app_src/app/api/invitations/accept/route.ts',
  'app_src/app/api/docs/route.ts',
  'app_src/app/api/versions/route.ts',
  'app_src/app/api/pipeline/sync/outbox/process/route.ts',
]) {
  if (!existsSync(resolve(root, requiredPath))) {
    fail(`missing deployment runtime file: ${requiredPath}`)
  }
}

run('npm', ['run', 'build'])

if (!existsSync(resolve(root, 'app_src/.next/BUILD_ID'))) {
  fail('missing build artifact: app_src/.next/BUILD_ID')
}

ok('predeploy verification passed')
