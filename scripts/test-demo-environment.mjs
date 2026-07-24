#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDemoDataset } from './demo-dataset.mjs'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const anchor = '2026-07-19'
const dataset = buildDemoDataset(anchor)
const anchorTime = Date.parse(`${anchor}T23:59:59.999Z`)
const daysAgo = (value) => Math.floor((anchorTime - Date.parse(value)) / (24 * 60 * 60 * 1000))

assert.equal(dataset.anchorDate, anchor)
assert.deepEqual(dataset.windows, { recent: 30, followUp: 60, context: 90, financial: 365 })
assert.ok(dataset.interactions.some((item) => daysAgo(item.occurredAt) <= 30), 'demo needs recent interactions')
assert.ok(dataset.interactions.some((item) => daysAgo(item.occurredAt) > 30 && daysAgo(item.occurredAt) <= 60), 'demo needs 31-60 day interactions')
assert.ok(dataset.interactions.some((item) => daysAgo(item.occurredAt) > 60 && daysAgo(item.occurredAt) <= 90), 'demo needs 61-90 day interactions')
assert.ok(dataset.interactions.every((item) => daysAgo(item.occurredAt) >= 0 && daysAgo(item.occurredAt) <= 90))
assert.ok(dataset.invoices.every((item) => {
  const age = daysAgo(`${item.transactionDate}T12:00:00.000Z`)
  return age >= 0 && age <= 90
}), 'demo invoices must remain in the rolling 90-day presentation window')

const serialized = JSON.stringify(dataset).toLowerCase()
for (const forbidden of ['episcs', 'suburbia sandwich', 'jarrett', 'olivia', 'gmail.com']) {
  assert.ok(!serialized.includes(forbidden), `synthetic dataset leaked donor token: ${forbidden}`)
}
assert.ok(dataset.organizations.every((item) => item.email.endsWith('@demo.clawpilot.example')))
assert.ok(dataset.people.every((item) => item.email.endsWith('@demo.clawpilot.example')))
assert.ok(dataset.vendors.every((item) => item.email.endsWith('@demo.clawpilot.example')))
assert.ok(dataset.organizations.every((item) => item.phone.includes('-555-')))
assert.equal(new Set(dataset.organizations.map((item) => item.name)).size, dataset.organizations.length)
assert.equal(new Set(dataset.products.map((item) => item.providerId)).size, dataset.products.length)

const migration = read('db/migrations/0066_demo_workspace_account.sql')
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS is_demo boolean'))
assert.ok(migration.includes('idx_workspace_organizations_one_demo'))
assert.ok(migration.includes("'{\"accessDemo\":true}'::jsonb"))

const demoMode = read('app_src/lib/demoMode.ts')
assert.ok(demoMode.includes("DEMO_WORKSPACE_ID = '10000000-0000-4000-8000-000000000001'"))
assert.ok(demoMode.includes("DEMO_PIPELINE_ID = '20000000-0000-4000-8000-000000000002'"))
assert.ok(demoMode.includes('demoMutationIsRestricted'))
assert.ok(demoMode.includes("'/api/auth/logout'"))
assert.ok(!demoMode.includes('CLAWPILOT_DEMO_MODE'))
assert.ok(!demoMode.includes('demo.aiapp.eigenracing.com'))

const crmPersistence = read('app_src/lib/persistence/crm.ts')
assert.ok(crmPersistence.includes('input.emitSuiteCrmOutbox !== false'))
assert.ok(crmPersistence.includes('demoWorkspace.rows[0]?.is_demo !== true'))
assert.ok(crmPersistence.includes('LEFT JOIN workspace_organizations wo ON wo.id = ps.workspace_organization_id'))
assert.ok(!crmPersistence.includes('isDemoMode'))

const loginPage = read('app_src/app/login/page.tsx')
assert.ok(!loginPage.includes('/api/auth/demo'))
assert.ok(!loginPage.includes("get('demo')"))
assert.ok(!loginPage.includes('Explore demo'))

const demoEntryRoute = read('app_src/app/api/workspaces/demo-entry/route.ts')
assert.ok(demoEntryRoute.includes('ensureDemoWorkspaceMembership(actor)'))
assert.ok(demoEntryRoute.includes('switchBrowserSessionWorkspace'))
assert.ok(demoEntryRoute.includes('export async function POST'))
assert.ok(!demoEntryRoute.includes('entryUrl'))

const workspaceSwitcher = read('app_src/components/workspaces/ActiveWorkspaceSwitcher.tsx')
assert.ok(workspaceSwitcher.includes('Open demo account'))
assert.ok(workspaceSwitcher.includes('payload?.canAccessDemo'))
assert.ok(workspaceSwitcher.includes("fetch('/api/workspaces/demo-entry', { method: 'POST' })"))
assert.ok(workspaceSwitcher.includes('Synthetic, read-only customer example'))

const accessDialog = read('app_src/components/settings/UserAccessDialog.tsx')
assert.ok(accessDialog.includes("{ key: 'accessDemo', label: 'Open demo account' }"))
assert.ok(accessDialog.includes('const [inviteDemoAccess, setInviteDemoAccess] = useState(false)'))
assert.ok(accessDialog.includes('demoAccess: inviteDemoAccess'))
assert.ok(accessDialog.includes('Off by default.'))

const users = read('app_src/lib/users.ts')
assert.ok(users.includes('{ ...OWNER_PERMISSIONS, accessDemo: target.permissions.accessDemo }'))
assert.ok(users.includes('{ ...MEMBER_PERMISSIONS, accessDemo: target.permissions.accessDemo }'))

const workspaceMemberships = read('app_src/lib/workspaceMemberships.ts')
for (const permission of [
  'viewOperations: true',
  'manageOperations: false',
  'executeWarehouse: false',
]) {
  assert.ok(workspaceMemberships.includes(permission), `demo workspace must set ${permission}`)
}

const seed = read('scripts/seed-demo-environment.mjs')
assert.ok(seed.includes("'ClawPilot Demo Company'"))
assert.ok(seed.includes('is_demo'))
assert.ok(seed.includes('demo-system@clawpilot.example'))
assert.ok(seed.includes("PIPELINE_ID = '20000000-0000-4000-8000-000000000002'"))
assert.ok(seed.includes('immutableDemoPipelines'))
assert.ok(seed.includes('immutablePipelineIds'))
assert.ok(seed.includes('crm_contact_source_aliases'))
assert.ok(seed.includes('crm_contact_merges'))
assert.ok(seed.includes('Archived demo identity evidence'))
assert.ok(seed.includes('DELETE FROM pipeline_space_members'))
assert.ok(seed.includes('quarantinedPipelines'))
assert.ok(seed.includes("dataset_key IN ('workspace-demo', 'public-demo')"))
assert.ok(seed.includes('DELETE FROM pipeline_spaces pipeline'))
assert.ok(seed.includes('quickbooks_crm_links'))
assert.ok(seed.includes('toast_pos_orders'))
assert.ok(seed.includes('toast_menu_catalog_items'))
assert.ok(seed.includes('pos_accounting_profiles'))
assert.ok(seed.includes('pos_accounting_catalog_mappings'))
assert.ok(seed.includes("DELETE FROM sync_outbox\n       WHERE target_system = 'suitecrm'"))
assert.ok(seed.includes('quickbooks_tax_codes'))
assert.ok(seed.includes('quickbooks_classes'))
assert.ok(seed.includes('quickbooks_departments'))
assert.ok(seed.includes("'summary:card_settlement'"))
assert.ok(seed.includes("'Harbor Street Kitchen'"))
assert.ok(seed.includes('demo-pos-draft:'))
assert.ok(!seed.includes('TRUNCATE TABLE'))
assert.ok(!seed.includes('DISABLE TRIGGER'))
assert.ok(!seed.includes('CLAWPILOT_DEMO_MODE'))

const verifier = read('scripts/verify-demo-environment.mjs')
assert.ok(verifier.includes('unsafe_emails'))
assert.ok(verifier.includes('live_identity_overlaps'))
assert.ok(verifier.includes('unsafe_legacy_pipelines'))
assert.ok(verifier.includes('legacy_pipeline_memberships'))
assert.ok(verifier.includes('legacy_default_preferences'))
assert.ok(verifier.includes('pos_business_days'))
assert.ok(verifier.includes('pos_menu_items'))
assert.ok(verifier.includes('accounting_profiles'))
assert.ok(verifier.includes('accounting_mappings'))
assert.ok(verifier.includes("dataset_key = 'workspace-demo'"))

const predeploy = read('scripts/predeploy-railway.sh')
assert.ok(predeploy.includes('npm run demo:seed'))
assert.ok(predeploy.includes('npm run demo:verify'))
assert.ok(predeploy.includes('npm run mail:verify'))
assert.ok(!predeploy.includes('CLAWPILOT_DEMO_MODE'))

const railwayStart = read('scripts/start-railway.sh')
assert.ok(!railwayStart.includes('DEMO_REFRESH_INTERVAL_SECONDS'))
assert.ok(!railwayStart.includes('CLAWPILOT_DEMO_MODE'))

const health = read('app_src/app/api/health/route.ts')
assert.ok(health.includes("filename = '0065_demo_and_quickbooks_crm_reconciliation.sql'"))
assert.ok(health.includes("filename = '0066_demo_workspace_account.sql'"))
assert.ok(health.includes("filename = '0067_toast_pos_orders.sql'"))
assert.ok(health.includes("filename = '0068_quickbooks_write_connection_binding.sql'"))
assert.ok(health.includes("filename = '0069_pos_accounting_profiles_and_catalog_mappings.sql'"))
assert.ok(health.includes("filename = '0070_toast_menu_catalog.sql'"))
assert.ok(health.includes("filename = '0071_quickbooks_accounting_reference_catalogs.sql'"))
assert.ok(health.includes("filename = '0072_toast_sync_rerun_requests.sql'"))
assert.ok(health.includes("filename = '0073_toast_sync_worker_hardening.sql'"))
assert.ok(health.includes("filename = '0074_pos_accounting_issue_notifications.sql'"))
assert.ok(health.includes("filename = '0075_quickbooks_write_binding_compatibility.sql'"))
assert.ok(health.includes("filename = '0079_pos_accounting_posting_outcomes.sql'"))
assert.ok(health.includes("filename = '0080_external_pos_accounting_outcomes.sql'"))
assert.ok(!health.includes('demoEnvironment'))

const proxy = read('app_src/proxy.ts')
assert.ok(proxy.includes('session.activeWorkspaceOrganizationId'))
assert.ok(proxy.includes('This demo account is read-only.'))

const reconciliation = read('app_src/lib/persistence/quickBooksCrmSync.ts')
for (const fragment of [
  'quickbooks:customer:',
  'quickbooks:item:',
  "provider_entity_type = 'customer'",
  "crm_entity_type = 'organization'",
  'localId: linkedOrganization.rows[0]?.crm_record_id || null',
  'syncPipelineProductDropdownCatalogInPostgres',
]) assert.ok(reconciliation.includes(fragment), `QuickBooks CRM reconciliation missing ${fragment}`)

console.log('demo account contract tests passed')
