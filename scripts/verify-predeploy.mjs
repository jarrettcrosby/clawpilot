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

if (!String(railway?.deploy?.preDeployCommand || '').includes('npm run db:migrate')) {
  fail('railway.json deploy.preDeployCommand must run "npm run db:migrate"')
}

if (!String(railway?.deploy?.preDeployCommand || '').includes('npm run mail:verify')) {
  fail('railway.json deploy.preDeployCommand must verify the configured mail sender')
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
  'scripts/start-railway.sh',
  'scripts/test-suitecrm-interaction-ingestion.mjs',
  'scripts/pipeline-outbox-poller.mjs',
  'scripts/verify-tenancy-provisioning.mjs',
  'scripts/validate-runtime-config.mjs',
  'scripts/smoke-deployed-runtime.mjs',
  'scripts/record-release.mjs',
  'scripts/vercel-build.mjs',
  'scripts/verify-mail-sender.mjs',
  'docs/index.md',
  'docs/releases/catalog.json',
  'app_src/proxy.ts',
  'app_src/app/api/auth/magic/request/route.ts',
  'app_src/app/api/auth/magic/verify/route.ts',
  'app_src/app/api/agents/auth/route.ts',
  'app_src/app/api/agents/auth/poll/route.ts',
  'app_src/app/api/agents/dispatch/process/route.ts',
  'app_src/app/api/ai-radar/process/route.ts',
  'app_src/app/api/docs/embeddings/process/route.ts',
  'app_src/app/api/shortlinks/route.ts',
  'app_src/app/api/crm/actions/route.ts',
  'app_src/app/api/crm/integrations/process/route.ts',
  'app_src/app/api/integrations/maton/route.ts',
  'app_src/app/api/integrations/google-workspace/route.ts',
  'app_src/app/s/[slug]/route.ts',
  'app_src/lib/agentDispatchWorker.ts',
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
