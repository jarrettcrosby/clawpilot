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
}).createShipments, true)
assert.equal(users.permissionsForRole('member', {
  manageOperations: true,
  executeWarehouse: true,
  createShipments: false,
}).createShipments, false)
assert.equal(users.permissionsForRole('member', {}).purchaseLivePostage, false)
assert.equal(users.permissionsForRole('member', {
  manageOperations: true,
  executeWarehouse: true,
}).purchaseLivePostage, false)
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
    '@/lib/operations/oneOffShipments': {
      ONE_OFF_LIVE_POSTAGE_CONFIRMATION:
        'AUTHORIZE THIS LIVE POSTAGE PURCHASE',
    },
    '@/lib/persistence/shippingOneOffPack': {
      packShippingOneOffShipmentInPostgres: async () => {
        throw new Error('Unexpected pack call in void permission contract')
      },
    },
    '@/lib/integrations/integrationCredentialRuntimeHttp': {
      integrationCredentialRuntimeMaintenanceResponse: () => null,
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
const documentsMigration = read('db/migrations/0313_shipping_one_off_documents_minimal_fields.sql')
const health = read('app_src/app/api/health/route.ts')
const healthContract = read('app_src/lib/persistence/shippingIndependenceHealth.ts')
const ui = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const measurements = runTypeScript('app_src/lib/measurements.ts', {})
const oneOffMeasurements = runTypeScript(
  'app_src/lib/operations/oneOffShipmentMeasurements.ts',
  { '@/lib/measurements': measurements },
)
const shippingUi = read('app_src/components/shipping/ShippingSection.tsx')
const shippingExecutionUi = read('app_src/components/shipping/ShippingOneOffExecutionPanel.tsx')
const shippingProjection = read('app_src/lib/persistence/shipping.ts')
const accessUi = read('app_src/components/settings/UserAccessDialog.tsx')
const recovery = runTypeScript('app_src/lib/operations/shippingOneOffRecovery.ts', {})

assert.equal(oneOffMeasurements.canonicalLengthFromDisplay('10', 'imperial'), 254)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('1', 'imperial'), 454)
assert.equal(oneOffMeasurements.canonicalLengthFromDisplay('10', 'metric'), 100)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('0.45', 'metric'), 450)
assert.equal(oneOffMeasurements.positiveDisplayMeasurement('0.5'), 0.5)
assert.equal(oneOffMeasurements.canonicalLengthFromDisplay('0.001', 'imperial'), null)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('0.001', 'metric'), 1)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('0.0001', 'metric'), null)
assert.equal(oneOffMeasurements.canonicalLengthFromDisplay('', 'imperial'), null)
assert.equal(oneOffMeasurements.canonicalLengthFromDisplay('0', 'imperial'), null)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('-1', 'imperial'), null)
assert.equal(oneOffMeasurements.canonicalWeightFromDisplay('Infinity', 'imperial'), null)
assert.equal(
  oneOffMeasurements.canonicalLengthFromDisplay(
    String(Number.MAX_SAFE_INTEGER),
    'imperial',
  ),
  null,
)
assert.equal(
  oneOffMeasurements.canonicalWeightFromDisplay(
    String(Number.MAX_SAFE_INTEGER),
    'metric',
  ),
  null,
)
assert.equal(oneOffMeasurements.displayLengthFromMillimeters(254, 'imperial'), '10')
assert.equal(oneOffMeasurements.displayLengthFromMillimeters(315, 'imperial'), '12.402')
assert.equal(oneOffMeasurements.displayLengthFromMillimeters(315, 'metric'), '31.5')
assert.equal(oneOffMeasurements.rebaseDisplayLength('10', 'imperial', 'metric'), '25.4')
assert.equal(oneOffMeasurements.rebaseDisplayWeight('1', 'imperial', 'metric'), '0.454')
assert.equal(
  oneOffMeasurements.canonicalLengthFromDisplay(
    oneOffMeasurements.rebaseDisplayLength('10', 'imperial', 'metric'),
    'metric',
  ),
  254,
)
assert.equal(
  oneOffMeasurements.canonicalWeightFromDisplay(
    oneOffMeasurements.rebaseDisplayWeight('1', 'imperial', 'metric'),
    'metric',
  ),
  454,
)

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
  'What are you shipping?',
  'Existing inventory',
  'New product',
  'Documents or other contents',
  'one-off-contents-mode',
  'No CRM customer · direct recipient',
  'no CRM customer is created',
  'stay outside Products and inventory',
  'without creating or reserving inventory',
  'useMeasurementSystem()',
  'canonicalWeightFromDisplay(',
  'canonicalLengthFromDisplay(',
  'displayLengthFromMillimeters(',
  'rebaseDisplayWeight(',
  'rebaseDisplayLength(',
  'measurementUnits(draftMeasurementSystem)',
  'step: \'any\'',
  "lines.every((line) => line.kind === 'ad_hoc')",
  'inventoryPoolGlobalId: pureAdHoc ? null : inventoryPoolGlobalId',
  'receivingLocationGlobalId: pureAdHoc ? null : receivingLocationGlobalId',
  "if (!pureAdHoc && !customerGlobalId)",
]) {
  assert.ok(ui.includes(fragment), `One-off UI is missing ${fragment}`)
}
assert.doesNotMatch(ui, /label="(?:Unit |Gross )?weight \(g\)"/)
assert.doesNotMatch(ui, /label="(?:Length|Width|Height) \(mm\)"/)
const packageOptionMeasurementBlock = ui.slice(
  ui.indexOf('const selectPackageOption ='),
  ui.indexOf('const addPackage ='),
)
assert.match(
  packageOptionMeasurementBlock,
  /length: displayLengthFromMillimeters\([\s\S]*width: displayLengthFromMillimeters\([\s\S]*height: displayLengthFromMillimeters\(/,
)
const quoteMeasurementBlock = ui.slice(
  ui.indexOf('const buildQuoteInput ='),
  ui.indexOf('const continueToParcels ='),
)
const adHocQuoteInput = quoteMeasurementBlock.slice(
  quoteMeasurementBlock.indexOf("if (line.kind === 'ad_hoc')"),
  quoteMeasurementBlock.indexOf("kind: 'new' as const"),
)
assert.match(adHocQuoteInput, /unitWeightGrams: null/)
assert.match(adHocQuoteInput, /unitDimensionsMm: null/)
assert.doesNotMatch(adHocQuoteInput, /canonicalWeightFromDisplay|canonicalLengthFromDisplay/)
assert.match(
  ui,
  /!pureAdHoc && \([\s\S]*label="Planning reason"/,
  'Documents-only creation must not show a planning-reason essay',
)
assert.match(
  ui,
  /\.\.\.\(pureAdHoc \? \{\} : \{ reason: reason\.trim\(\) \}\)/,
  'Documents-only creation must not send a fabricated operator reason',
)
assert.match(
  persistence,
  /operations_one_off_lines_are_pure_ad_hoc\(quote\.lines_snapshot\)[\s\S]*Created from the selected one-off parcel rate/,
  'Persistence must derive a stable audit description for documents-only creation',
)
assert.match(
  quoteMeasurementBlock,
  /unitWeightGrams: canonicalWeightFromDisplay\([\s\S]*unitDimensionsMm:[\s\S]*dimensionsMm:[\s\S]*grossWeightGrams: canonicalWeightFromDisplay\(/,
)
const measurementRebaseBlock = ui.slice(
  ui.indexOf('if (measurementSystem === draftMeasurementSystem) return'),
  ui.indexOf('const updateCarrierSelection ='),
)
for (const fragment of ['setLines(', 'setPackages(', 'setDraftMeasurementSystem(']) {
  assert.ok(measurementRebaseBlock.includes(fragment), `Measurement rebase is missing ${fragment}`)
}
for (const fragment of [
  'setStep(',
  'setQuote(',
  'setSelectedOfferGlobalId(',
  'setQuoteIdempotencyKey(',
  'setCreateAttempt(',
]) {
  assert.ok(
    !measurementRebaseBlock.includes(fragment),
    `Presentation-only measurement rebasing must preserve workflow and idempotency state: ${fragment}`,
  )
}
assert.match(
  ui,
  /directRecipientSelected\.current && !current[\s\S]*\? ''[\s\S]*selectContentsMode[\s\S]*directRecipientSelected\.current = mode === 'ad_hoc'[\s\S]*\? ''/,
  'Documents-only drafts must preserve the explicit direct-recipient selection across reopen',
)
for (const fragment of [
  'ALTER COLUMN unit_weight_grams DROP NOT NULL',
  'ALTER COLUMN unit_dimensions_mm DROP NOT NULL',
  'operations_one_off_ad_hoc_lines_physical_facts_valid',
  "NULLIF(snapshot->'unitDimensionsMm', 'null'::jsonb)",
  'IS NOT DISTINCT FROM NEW.unit_weight_grams',
]) {
  assert.ok(
    documentsMigration.includes(fragment),
    `0313 minimal paperwork evidence is missing ${fragment}`,
  )
}
assert.doesNotMatch(
  documentsMigration,
  /ALTER TABLE operations_order_lines|ALTER TABLE crm_products|DROP COLUMN/,
  'Minimal paperwork fields must not weaken product or canonical order lines',
)
for (const fragment of [
  '<ShippingOneOffExecutionPanel',
  'standaloneOneOffPackEligible',
  'standaloneOneOffExecutionEligible',
  'canCreateShipments={Boolean(workspace?.capabilities.canCreate)}',
  'Create shipments permission is required to confirm physical pack, refresh rates, create labels, or cancel',
  'one-time ad-hoc item can be rated, labeled, and cancelled here',
  'physically reviewed, packed, rerated, labeled, and cancelled entirely in Shipping without Operations activation',
]) {
  assert.ok(shippingUi.includes(fragment), `Standalone Shipping UI is missing ${fragment}`)
}
const standalonePackStart = shippingProjection.indexOf(
  'source_order.source_provider =',
)
const standalonePackEnd = shippingProjection.indexOf(
  ') AS standalone_one_off_pack_eligible',
  standalonePackStart,
)
const standalonePackEligibility = shippingProjection.slice(
  standalonePackStart,
  standalonePackEnd,
)
assert.match(standalonePackEligibility, /source_order\.status = 'planned'/)
assert.match(standalonePackEligibility, /plan\.status = 'planned'/)
assert.match(standalonePackEligibility, /package_state\.status <> 'planned'/)
assert.match(standalonePackEligibility, /operations_one_off_plan_execution_is_exact/)
const standaloneEligibility = shippingProjection.slice(
  shippingProjection.indexOf(
    'source_order.source_provider =',
    standalonePackEnd,
  ),
  shippingProjection.indexOf(
    ') AS standalone_one_off_execution_eligible',
    standalonePackEnd,
  ),
)
assert.match(standaloneEligibility, /source_order\.status = 'packed'/)
assert.match(standaloneEligibility, /quote\.execution_mode IS NOT NULL/)
assert.match(standaloneEligibility, /operations_one_off_plan_execution_is_exact/)
assert.match(standaloneEligibility, /package_state\.status <> 'packed'/)
assert.match(standaloneEligibility, /package_state\.status <> 'labeled'/)
assert.doesNotMatch(
  standaloneEligibility,
  /operations_one_off_lines_are_pure_ad_hoc/,
  'Every exactly sealed and physically packed native one-off must finish in Shipping',
)
assert.match(
  persistence.slice(
    persistence.indexOf('const pureAdHoc = quote.lines_snapshot.length'),
    persistence.indexOf(
      'const result: OneOffShipmentCreateResult',
      persistence.indexOf('const pureAdHoc = quote.lines_snapshot.length'),
    ),
  ),
  /CASE WHEN \$8::boolean THEN 'packed' ELSE 'planned'[\s\S]*pureAdHoc[\s\S]*SET status = CASE WHEN \$5::boolean THEN 'packed' ELSE 'planned'[\s\S]*pureAdHoc/,
  'Only pure ad-hoc creation may auto-pack; inventory and new-product lines retain physical pack confirmation',
)
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
assert.match(rejectionClassifier, /shippingOneOffResponseIsDefinitiveClientRejection/)
for (const [status, malformed, expected] of [
  [400, false, true],
  [409, false, true],
  [408, false, false],
  [425, false, false],
  [429, false, false],
  [500, false, false],
  [409, true, false],
]) {
  assert.equal(
    recovery.shippingOneOffResponseIsDefinitiveClientRejection(status, malformed),
    expected,
    `HTTP ${status}${malformed ? ' malformed' : ''} recovery classification drifted`,
  )
}
const throwingStorage = {
  getItem() { throw new Error('storage unavailable') },
  setItem() { throw new Error('storage unavailable') },
  removeItem() { throw new Error('storage unavailable') },
}
assert.equal(
  recovery.readShippingOneOffRetainedCommand(
    throwingStorage,
    'purchase',
    'order-1',
    'storage-key',
  ),
  null,
)
const storageValues = new Map()
const workingStorage = {
  getItem(key) { return storageValues.get(key) || null },
  setItem(key, value) { storageValues.set(key, value) },
  removeItem(key) { storageValues.delete(key) },
}
const exactRetained = {
  key: 'shipping-one-off-purchase:order-1:request-1',
  body: JSON.stringify({
    action: 'purchase-group',
    orderGlobalId: 'order-1',
  }),
}
assert.equal(
  recovery.writeShippingOneOffRetainedCommand(
    workingStorage,
    'storage-key',
    exactRetained,
  ),
  true,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(recovery.readShippingOneOffRetainedCommand(
    workingStorage,
    'purchase',
    'order-1',
    'storage-key',
  ))),
  exactRetained,
)
storageValues.set('storage-key', JSON.stringify({
  ...exactRetained,
  body: JSON.stringify({ action: 'purchase-group', orderGlobalId: 'other-order' }),
}))
assert.equal(
  recovery.readShippingOneOffRetainedCommand(
    workingStorage,
    'purchase',
    'order-1',
    'storage-key',
  ),
  null,
  'Cross-order retained evidence must be discarded before any request',
)
let simulatedProviderCalls = 0
if (recovery.writeShippingOneOffRetainedCommand(
  throwingStorage,
  'storage-key',
  { key: 'shipping-one-off-purchase:order-1:request-1', body: '{}' },
)) simulatedProviderCalls += 1
assert.equal(simulatedProviderCalls, 0, 'Storage exceptions must cause zero provider work')
const purchaseUi = shippingExecutionUi.slice(
  shippingExecutionUi.indexOf('const purchaseLabels = async'),
  shippingExecutionUi.indexOf('const voidLabels = async'),
)
assert.match(
  purchaseUi,
  /definitiveClientRejection\(response, malformed\)[\s\S]*const durable = await loadState\(\)[\s\S]*purchaseIsDurable\(durable, command\)[\s\S]*clearPurchaseCommand\(command\)[\s\S]*The rejected request was not retained/,
  'Deterministic purchase conflicts must reconcile durable state before clearing',
)
assert.match(
  purchaseUi,
  /catch \(caught\)[\s\S]*purchaseIsDurable\(durable, command\)[\s\S]*retained byte-identical request/,
  'Lost or malformed purchase responses must reconcile exact lineage or retain the exact command',
)
for (const [start, end, retainedCall] of [
  ['const refreshRates = async', 'const purchaseLabels = async', "retainCommand('packed-rate'"],
  ['const purchaseLabels = async', 'const recoverLabelPrint = async', "retainCommand('purchase'"],
  ['const voidLabels = async', 'if (!currentState)', "retainCommand('void'"],
]) {
  const action = shippingExecutionUi.slice(
    shippingExecutionUi.indexOf(start),
    shippingExecutionUi.indexOf(end),
  )
  assert.ok(action.indexOf(retainedCall) < action.indexOf("fetch('/api/operations/one-off-shipments'"))
  assert.match(action, /if \(!retainCommand\([\s\S]*No carrier[\s\S]*return/)
}
assert.match(shippingExecutionUi, /Carrier outcome is unresolved[\s\S]*a new provider request is fenced/)
assert.match(shippingExecutionUi, /\|\| unresolved/)
assert.match(shippingExecutionUi, /unresolved && !retryingUnresolvedPurchase/)
assert.match(shippingExecutionUi, /purchaseIsBoundToGroup\(state, purchaseCommand\)/)
assert.match(shippingExecutionUi, /voidIsBoundToGroup\(state, voidCommand\)/)
assert.match(
  shippingExecutionUi,
  /payload\.state\.orderGlobalId !== orderGlobalId/,
  'Durable GET reconciliation must reject cross-order response state',
)
assert.match(health, /SHIPPING_INDEPENDENCE_HEALTH_SQL/)
assert.match(health, /shipping_independence_applied/)
for (const fragment of [
  '0301_shipping_independent_one_off_items.sql',
  '21d58421f998e503f16c1f4ebc4c95dee9c986c0e5049a2dedb18df686058f53',
  '0313_shipping_one_off_documents_minimal_fields.sql',
  'b3b801e2469fc4bf596256a12514ac910173154b97c48d04103cfee4b8170df2',
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
