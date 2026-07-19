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
assert.ok(dataset.organizations.every((item) => item.email.endsWith('@example.com')))
assert.ok(dataset.people.every((item) => item.email.endsWith('@example.com')))
assert.ok(dataset.organizations.every((item) => item.phone.includes('-555-')))
assert.equal(new Set(dataset.organizations.map((item) => item.name)).size, dataset.organizations.length)
assert.equal(new Set(dataset.products.map((item) => item.providerId)).size, dataset.products.length)

const migration = read('db/migrations/0065_demo_and_quickbooks_crm_reconciliation.sql')
for (const fragment of [
  "'legacy_upgrade', 'demo'",
  'CREATE TABLE IF NOT EXISTS demo_dataset_metadata',
  'crm_customer_sync_enabled boolean NOT NULL DEFAULT false',
  'crm_product_sync_enabled boolean NOT NULL DEFAULT false',
  'CREATE TABLE IF NOT EXISTS quickbooks_crm_links',
]) assert.ok(migration.includes(fragment), `demo migration missing ${fragment}`)

const demoMode = read('app_src/lib/demoMode.ts')
assert.ok(demoMode.includes("CLAWPILOT_DEMO_MODE === '1'"))
assert.ok(demoMode.includes("RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() === 'demo'"))
assert.ok(demoMode.includes("'/api/integrations/'"))
assert.ok(demoMode.includes("'/api/agents/'"))

const crmPersistence = read('app_src/lib/persistence/crm.ts')
assert.ok(crmPersistence.includes("input.emitSuiteCrmOutbox !== false && !isDemoMode()"))

const demoRoute = read('app_src/app/api/auth/demo/route.ts')
assert.ok(demoRoute.includes("authMethod: 'demo'"))
assert.ok(demoRoute.includes('assertDemoEnvironment()'))

const seed = read('scripts/seed-demo-environment.mjs')
assert.ok(seed.includes("CLAWPILOT_DEMO_MODE !== '1'"))
assert.ok(seed.includes("environment !== 'demo'"))
assert.ok(seed.includes('demo_dataset_metadata'))
assert.ok(seed.includes('quickbooks_crm_links'))
assert.ok(seed.includes('TRUNCATE TABLE app_users, workspace_organizations'))

const predeploy = read('scripts/predeploy-railway.sh')
assert.ok(predeploy.includes('npm run demo:seed'))
assert.ok(predeploy.includes('npm run demo:verify'))
assert.ok(predeploy.includes('npm run mail:verify'))

const railwayStart = read('scripts/start-railway.sh')
assert.ok(railwayStart.includes('DEMO_REFRESH_INTERVAL_SECONDS:-86400'))
assert.ok(railwayStart.includes('CLAWPILOT_DEMO_MODE=1 is only valid in the demo environment'))

const health = read('app_src/app/api/health/route.ts')
assert.ok(health.includes("filename = '0065_demo_and_quickbooks_crm_reconciliation.sql'"))
assert.ok(health.includes('!demoEnvironment && String(process.env.MATON_API_KEY'))

const reconciliation = read('app_src/lib/persistence/quickBooksCrmSync.ts')
for (const fragment of [
  'quickbooks:customer:',
  'quickbooks:item:',
  "provider_entity_type = 'customer'",
  "crm_entity_type = 'organization'",
  'localId: linkedOrganization.rows[0]?.crm_record_id || null',
  'syncPipelineProductDropdownCatalogInPostgres',
]) assert.ok(reconciliation.includes(fragment), `QuickBooks CRM reconciliation missing ${fragment}`)

console.log('demo environment contract tests passed')
