#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

function runTypeScript(path, stubs) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array, Boolean, Date, Error, JSON, Map, Math, Number, Object,
    Promise, RegExp, Set, String, console, exports: module.exports, module,
    process,
    require: (specifier) => stubs[specifier] || requireFromApp(specifier),
  }, { filename: path })
  return module.exports
}

const users = runTypeScript('app_src/lib/users.ts', {
  '@/lib/persistence/postgres': { query: async () => ({ rows: [] }), withTransaction: async () => {} },
  '@/lib/auditWriter': { recordAuditEvent: async () => {} },
  '@/lib/crm/suiteCrmClient': { findSuiteCrmUser: async () => null },
  '@/lib/demoMode': { DEMO_WORKSPACE_ID: 'demo' },
})
const authorization = runTypeScript('app_src/lib/operations/authorization.ts', {
  '@/lib/users': users,
})

const basePermissions = users.MEMBER_PERMISSIONS
const actor = (role, permissions) => ({
  role,
  permissions,
  organizationRole: null,
  organizationPermissions: null,
})

assert.deepEqual(
  Array.from(Object.keys(users.OWNER_PERMISSIONS).filter((key) => key.includes('Shipping') || key.includes('Shipment') || key.includes('Postage'))),
  ['viewShipping', 'createShipments', 'purchaseLivePostage'],
  'Owner payload must expose all three Shipping permissions',
)
assert.equal(users.permissionsForRole('admin', {}).viewShipping, true)
assert.equal(users.permissionsForRole('admin', {}).createShipments, true)
assert.equal(users.permissionsForRole('admin', {}).purchaseLivePostage, true)
assert.equal(users.permissionsForRole('admin', { purchaseLivePostage: false }).purchaseLivePostage, false)
assert.equal(users.permissionsForRole('member', {}).purchaseLivePostage, false)
assert.equal(users.permissionsForRole('member', { purchaseLivePostage: true }).purchaseLivePostage, true)

const grantedMember = authorization.shippingCapabilities(actor('member', {
  ...basePermissions,
  viewShipping: true,
  createShipments: true,
  purchaseLivePostage: true,
}))
assert.equal(grantedMember.canView, true)
assert.equal(grantedMember.canCreate, true)
assert.equal(grantedMember.canPurchaseLivePostage, true)
assert.equal(
  authorization.shippingCapabilities(actor('member', basePermissions)).canPurchaseLivePostage,
  false,
  'Ordinary members must default to no live-postage authority',
)
assert.equal(
  authorization.shippingCapabilities(actor('member', {
    ...basePermissions,
    purchaseLivePostage: true,
  })).canPurchaseLivePostage,
  false,
  'Live-postage authority must depend on view + create Shipping access',
)

const route = read('app_src/app/api/operations/one-off-shipments/route.ts')
const persistence = read('app_src/lib/persistence/oneOffShipments.ts')
const execution = read('app_src/lib/persistence/operationOneOffShipping.ts')
const migration = read('db/migrations/0301_shipping_independent_one_off_items.sql')
const health = read('app_src/app/api/health/route.ts')
const healthContract = read('app_src/lib/persistence/shippingIndependenceHealth.ts')
const ui = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const accessUi = read('app_src/components/settings/UserAccessDialog.tsx')

assert.doesNotMatch(route, /operationsCapabilities|operations_activation_scopes/)
assert.doesNotMatch(persistence, /operations_activation_scopes/)
assert.doesNotMatch(execution, /operations_activation_scopes|activation_state/)
assert.match(route, /!capabilities\.canCreate/)
assert.match(route, /!capabilities\.canPurchaseLivePostage/)
assert.match(route, /ONE_OFF_LIVE_POSTAGE_CONFIRMATION/)
assert.match(route, /idempotencyKey\(req\)/)

const groupPrepare = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION validate_operations_one_off_group_prepare'),
  migration.indexOf('CREATE OR REPLACE FUNCTION validate_operations_one_off_group_shipment'),
)
const groupShipment = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION validate_operations_one_off_group_shipment'),
)
assert.doesNotMatch(groupPrepare, /operations_activation_scopes|activation\.state/)
assert.doesNotMatch(groupShipment, /operations_activation_scopes|activation\.state/)
for (const fragment of [
  'operations_shipping_scopes',
  'operations_one_off_ad_hoc_order_lines',
  'operations_one_off_ad_hoc_package_contents',
  'protect_operations_one_off_ad_hoc_evidence',
  'validate_operations_one_off_direct_recipient_deferred',
  'operations_one_off_lines_are_pure_ad_hoc',
  'IS NOT DISTINCT FROM planning_quote.inventory_pool_id',
]) {
  assert.ok(migration.includes(fragment), `0301 is missing ${fragment}`)
}
assert.doesNotMatch(
  migration,
  /ALTER TABLE operations_order_lines[\s\S]*ALTER COLUMN product_id/,
  'Ad-hoc support must not weaken canonical product-line invariants',
)

const adHocWrite = persistence.slice(
  persistence.indexOf("if (shipmentLine.kind === 'ad_hoc')"),
  persistence.indexOf("const existing = existingProducts.get", persistence.indexOf("if (shipmentLine.kind === 'ad_hoc')")),
)
assert.match(adHocWrite, /INSERT INTO operations_one_off_ad_hoc_order_lines/)
assert.doesNotMatch(
  adHocWrite,
  /crm_products|operations_receipts|operations_inventory_positions|operations_inventory_reservations/,
  'The ad-hoc branch must not write product, receipt, inventory, or reservation rows',
)
assert.match(persistence, /const newLines = input\.lines\.filter\(\(line\) => line\.kind === 'new'\)/)
assert.match(persistence, /await acquireTransactionAdvisoryLock/)
assert.match(persistence, /organization_id = \$1::uuid/)
assert.match(migration, /FOREIGN KEY \(organization_id, order_id, ad_hoc_order_line_id\)/)

for (const key of ['viewShipping', 'createShipments', 'purchaseLivePostage']) {
  assert.ok(accessUi.includes(`key: '${key}'`), `User Access UI is missing ${key}`)
}
assert.match(
  accessUi,
  /key === 'purchaseLivePostage' && enabled[\s\S]*next\.viewShipping = true[\s\S]*next\.createShipments = true/,
)
assert.match(
  accessUi,
  /key === 'createShipments' && !enabled\) next\.purchaseLivePostage = false/,
)
assert.match(
  accessUi,
  /key === 'viewShipping' && !enabled[\s\S]*next\.purchaseLivePostage = false/,
)
for (const fragment of [
  'One-time ad-hoc item · do not add to Products',
  'No CRM customer · direct recipient',
  'no CRM customer is created',
  'will not create a Product, receipt, inventory position, or reservation',
]) {
  assert.ok(ui.includes(fragment), `One-off UI is missing ${fragment}`)
}
assert.match(health, /SHIPPING_INDEPENDENCE_HEALTH_SQL/)
assert.match(health, /shipping_independence_applied/)
for (const fragment of [
  '0301_shipping_independent_one_off_items.sql',
  '091801b8f75f4638519e03d352f8aee8d746b9e0fabe98b1d43ae1ae321b2d5a',
  "installed_namespace.nspname = 'public'",
  'installed_function.prosrc',
  'installed_trigger.tgfoid',
  'installed_trigger.tgenabled',
  'installed_trigger.tgqual',
  'pg_get_constraintdef',
  'pg_get_indexdef',
]) {
  assert.ok(healthContract.includes(fragment), `Exact Shipping health is missing ${fragment}`)
}

console.log('Shipping independence, authorization, and ad-hoc drift checks passed.')
