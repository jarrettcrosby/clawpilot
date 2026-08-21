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
    Array, Boolean, Buffer, Date, Error, JSON, Map, Math, Number, Object,
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

class TestPersistenceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

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
assert.equal(users.permissionsForRole('owner', {}).purchaseLivePostage, true)
assert.deepEqual(
  Array.from(Object.entries(users.permissionsForRole('admin', {}))
    .filter(([key]) => ['viewShipping', 'createShipments', 'purchaseLivePostage'].includes(key))
    .map(([, value]) => value)),
  [false, false, false],
  'A legacy admin with no prior Operations authority must gain no Shipping authority',
)
assert.deepEqual(
  Array.from(Object.entries(users.permissionsForRole('admin', {
    viewOperations: true,
  }))
    .filter(([key]) => ['viewShipping', 'createShipments', 'purchaseLivePostage'].includes(key))
    .map(([, value]) => value)),
  [true, false, false],
  'A legacy Operations viewer may view Shipping but gains no execution authority',
)
assert.deepEqual(
  Array.from(Object.entries(users.permissionsForRole('admin', {
    viewOperations: true,
    manageOperations: true,
    executeWarehouse: true,
  }))
    .filter(([key]) => ['viewShipping', 'createShipments', 'purchaseLivePostage'].includes(key))
    .map(([, value]) => value)),
  [true, true, true],
  'Only an admin with both prior management and execution gates retains live authority',
)
assert.equal(users.permissionsForRole('admin', { purchaseLivePostage: false }).purchaseLivePostage, false)
assert.equal(users.permissionsForRole('member', { viewOperations: true }).viewShipping, true)
assert.equal(users.permissionsForRole('member', {
  manageOperations: true,
  executeWarehouse: true,
}).createShipments, false)
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

let routeExecutionMode = 'test'
let routeVoidCalls = 0
let routeVoidInput = null
const oneOffRouteModule = runTypeScript(
  'app_src/app/api/operations/one-off-shipments/route.ts',
  {
    'next/server': {
      NextRequest: class {},
      NextResponse: {
        json: (payload, init) => ({ payload, status: init?.status || 200 }),
      },
    },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId: () => '11111111-1111-4111-8111-111111111111',
      shippingCapabilities: () => ({
        canView: true,
        canCreate: true,
        canPurchaseLivePostage: false,
      }),
    },
    '@/lib/persistence/config': { isPostgresStorageEnabled: () => true },
    '@/lib/persistence/oneOffShipments': {
      OneOffShipmentPersistenceError: TestPersistenceError,
    },
    '@/lib/persistence/operationOneOffShipping': {
      readOneOffCarrierGroupExecutionModeInPostgres: async () => routeExecutionMode,
      voidOperationsOneOffCarrierGroupInPostgres: async (input) => {
        routeVoidCalls += 1
        routeVoidInput = input
        return {
          action: 'close_sample',
          state: 'succeeded',
          replayed: false,
          labels: [],
        }
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => ({
        email: 'shipping-create-only@example.test',
      }),
    },
    '@/lib/operations/oneOffShipments': {
      ONE_OFF_LIVE_POSTAGE_CONFIRMATION: 'AUTHORIZE THIS LIVE POSTAGE PURCHASE',
    },
  },
)
const routeRequest = () => ({
  headers: { get: (name) => name === 'idempotency-key' ? 'shipping-test-void-key' : null },
  text: async () => JSON.stringify({
    action: 'void-group',
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 3,
    reason: 'Close this complete sandbox sample shipment group',
  }),
})
const testVoidResponse = await oneOffRouteModule.POST(routeRequest())
assert.equal(testVoidResponse.status, 200)
assert.equal(routeVoidCalls, 1, 'Create-only Shipping may close a TEST sample group')
assert.equal(routeVoidInput.canPurchaseLivePostage, false)
routeExecutionMode = 'live'
const liveVoidResponse = await oneOffRouteModule.POST(routeRequest())
assert.equal(liveVoidResponse.status, 403)
assert.equal(routeVoidCalls, 1, 'Create-only Shipping must make zero production void calls')
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
const shippingUi = read('app_src/components/shipping/ShippingSection.tsx')
const shippingExecutionUi = read('app_src/components/shipping/ShippingOneOffExecutionPanel.tsx')
const accessUi = read('app_src/components/settings/UserAccessDialog.tsx')

assert.doesNotMatch(route, /operationsCapabilities|operations_activation_scopes/)
assert.doesNotMatch(persistence, /operations_activation_scopes/)
assert.doesNotMatch(execution, /operations_activation_scopes|activation_state/)
assert.match(route, /!capabilities\.canCreate/)
assert.match(route, /!capabilities\.canPurchaseLivePostage/)
assert.match(route, /ONE_OFF_LIVE_POSTAGE_CONFIRMATION/)
assert.match(route, /idempotencyKey\(req\)/)
const voidRoute = route.slice(
  route.indexOf("if (action === 'void-group')"),
  route.indexOf("throw new OneOffShipmentPersistenceError(\n      'OPERATIONS_ONE_OFF_ACTION_INVALID'"),
)
assert.match(voidRoute, /readOneOffCarrierGroupExecutionModeInPostgres/)
assert.match(voidRoute, /executionMode === 'live' && !capabilities\.canPurchaseLivePostage/)
assert.match(voidRoute, /canPurchaseLivePostage: capabilities\.canPurchaseLivePostage/)
const voidPersistence = execution.slice(
  execution.indexOf('export async function voidOperationsOneOffCarrierGroupInPostgres'),
)
assert.match(voidPersistence, /canPurchaseLivePostage: boolean/)
assert.match(
  voidPersistence,
  /readGroupContext\([\s\S]*client,[\s\S]*true,[\s\S]*context\.execution_mode === 'live' && !input\.canPurchaseLivePostage[\s\S]*resolveCarrierOneOffVoidRuntime/,
  'Live void permission must be rechecked from the locked exact group before provider runtime resolution',
)
assert.match(
  voidPersistence,
  /const runtimeSource = lifecycleMode === 'close_sample'\s*\? null/,
  'TEST sample cancellation must make zero provider void calls',
)

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
assert.match(
  persistence,
  /acquireTransactionAdvisoryLock\([\s\S]*`shipping:scope:\$\{organizationId\}`[\s\S]*const lockedExisting = await read\(\)[\s\S]*if \(lockedExisting\.rows\[0\]\) return/,
  'First-use Shipping scope provisioning must re-read after the organization advisory lock',
)
assert.match(persistence, /INSERT INTO pipeline_spaces/)
assert.match(persistence, /purpose: 'one_off_shipping_internal_scope'/)
assert.doesNotMatch(persistence, /SHIPPING_PIPELINE_REQUIRED/)
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
for (const fragment of [
  '<ShippingOneOffExecutionPanel',
  'standaloneOneOffExecutionEligible',
  'canCreateShipments={Boolean(workspace?.capabilities.canCreate)}',
  'Create shipments permission is required to refresh rates',
  'one-time ad-hoc item can be rated, labeled, and cancelled here',
  'Existing inventory and deliberately created products keep the physical pick-and-pack boundary in Operations',
]) {
  assert.ok(shippingUi.includes(fragment), `Standalone Shipping UI is missing ${fragment}`)
}
for (const fragment of [
  "action: 'refresh-packed-rates'",
  "action: 'purchase-group'",
  "action: 'void-group'",
  'Purchase LIVE postage',
  'Create TEST labels',
  'canPurchaseLivePostage',
  'sessionStorage',
  'command.body',
  'definitiveClientRejection',
  'response.status !== 429',
  'The rejected request was not retained',
  'retained byte-identical request',
  'createRequestIdempotencyKey',
  'purchaseQuoteGlobalId',
  'purchaseOfferGlobalId',
  'voidRequestIdempotencyKey',
]) {
  assert.ok(shippingExecutionUi.includes(fragment), `Standalone execution UI is missing ${fragment}`)
}
assert.doesNotMatch(
  shippingExecutionUi,
  /operationsCapabilities|canManage|canExecute|canActivate|operations_activation_scopes/,
  'Standalone Shipping execution must not depend on Operations permissions or activation',
)
const rejectionClassifier = shippingExecutionUi.slice(
  shippingExecutionUi.indexOf('function definitiveClientRejection'),
  shippingExecutionUi.indexOf('function payloadMessage'),
)
assert.match(rejectionClassifier, /response\.status >= 400/)
assert.match(rejectionClassifier, /response\.status < 500/)
assert.match(rejectionClassifier, /response\.status !== 408/)
assert.match(rejectionClassifier, /response\.status !== 429/)
const purchaseUi = shippingExecutionUi.slice(
  shippingExecutionUi.indexOf('const purchaseLabels = async'),
  shippingExecutionUi.indexOf('const voidLabels = async'),
)
assert.match(
  purchaseUi,
  /definitiveClientRejection\(response, malformed\)[\s\S]*clearPurchaseCommand\(\)[\s\S]*The rejected request was not retained/,
  'Deterministic purchase conflicts must clear the command and require review',
)
assert.match(
  purchaseUi,
  /catch \(caught\)[\s\S]*purchaseIsDurable\(durable, command\)[\s\S]*retained byte-identical request/,
  'Lost or malformed purchase responses must reconcile exact lineage or retain the exact command',
)
assert.match(health, /SHIPPING_INDEPENDENCE_HEALTH_SQL/)
assert.match(health, /shipping_independence_applied/)
for (const fragment of [
  '0301_shipping_independent_one_off_items.sql',
  'd799807b84f614633a4898c5f05c801512b80ebdfb05871361d1201bb6c5975a',
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
