#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

function loadTypeScript(path, mocks = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (output.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    Array, Boolean, Buffer, Date, Error, JSON, Map, Math, Number, Object,
    Promise, RegExp, Set, String, URL, console, crypto: globalThis.crypto,
    exports: module.exports, module, process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

class TestPersistenceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const routeSource = read('app_src/app/api/operations/one-off-shipments/route.ts')
const persistenceSource = read('app_src/lib/persistence/shippingOneOffPack.ts')
const migration = read('db/migrations/0304_shipping_one_off_pack_confirmation.sql')
const section = read('app_src/components/shipping/ShippingSection.tsx')
const panel = read('app_src/components/shipping/ShippingOneOffExecutionPanel.tsx')
const projection = read('app_src/lib/persistence/shipping.ts')
const healthRoute = read('app_src/app/api/health/route.ts')
const healthContract = read(
  'app_src/lib/persistence/shippingOneOffPackHealth.ts',
)
const recovery = loadTypeScript(
  'app_src/lib/operations/shippingOneOffRecovery.ts',
)

loadTypeScript('app_src/components/shipping/ShippingOneOffExecutionPanel.tsx', {
  react: requireFromApp('react'),
  '@mui/material': requireFromApp('@mui/material'),
  '@mui/icons-material/RefreshRounded': requireFromApp('@mui/icons-material/RefreshRounded'),
  '@/lib/operations/oneOffShipmentConstants': {
    ONE_OFF_LIVE_POSTAGE_CONFIRMATION: 'AUTHORIZE THIS LIVE POSTAGE PURCHASE',
    ONE_OFF_PACK_CONFIRMATION:
      'I CONFIRM THESE EXACT ITEMS ARE PHYSICALLY IN THESE PACKAGES',
  },
  '@/lib/operations/shippingOneOffRecovery': recovery,
  'react/jsx-runtime': requireFromApp('react/jsx-runtime'),
})

for (const fragment of [
  "action === 'confirm-pack'",
  'packShippingOneOffShipmentInPostgres({',
  'expectedReviewSnapshotHash',
  'idempotencyKey: idempotencyKey(req)',
]) {
  assert.ok(routeSource.includes(fragment), `Pack route is missing ${fragment}`)
}
assert.doesNotMatch(
  routeSource.slice(
    routeSource.indexOf("if (action === 'confirm-pack')"),
    routeSource.indexOf("if (action === 'refresh-packed-rates')"),
  ),
  /operationsCapabilities|canExecute|canManage|canActivate|purchaseLivePostage/,
  'Shipping pack must require only the enclosing createShipments gate',
)

for (const fragment of [
  "source_order.source_provider = 'clawpilot_native'",
  "source_order.order_type = 'one_off'",
  "source_order.status AS order_status",
  "context.order_status !== 'planned'",
  "context.plan_status !== 'planned'",
  "item.status !== 'planned'",
  'reservation.status !== \'active\'',
  'expectedReviewSnapshotHash',
  'operations_shipping_one_off_pack_receipts',
  "'shipping.one_off.pack_confirmed'",
  'providerWrites: 0',
  'labelWrites: 0',
  'shipmentWrites: 0',
  'inventoryWrites: 0',
  'FOR SHARE OF line, product',
  'FOR UPDATE OF allocation, reservation, position',
  'shipping:one-off-pack:',
]) {
  assert.ok(
    persistenceSource.includes(fragment),
    `Pack persistence is missing ${fragment}`,
  )
}
assert.doesNotMatch(
  persistenceSource,
  /resolveCarrier|executeCarrier|carrierIntegrations|INSERT INTO operations_labels|INSERT INTO operations_shipments|UPDATE operations_inventory_positions|UPDATE operations_reservations/,
  'Physical pack must contain no carrier/provider, label, shipment, or inventory mutation path',
)

for (const fragment of [
  'operations_shipping_one_off_pack_receipts',
  'provider_write_count integer NOT NULL DEFAULT 0',
  'label_write_count integer NOT NULL DEFAULT 0',
  'shipment_write_count integer NOT NULL DEFAULT 0',
  'operations_shipping_one_off_pack_receipts_order_unique',
  'validate_operations_shipping_one_off_pack_receipt',
  'protect_operations_shipping_one_off_pack_receipt',
  'operations_shipping_one_off_pack_review_snapshot',
  'operations_transport_json_sha256(NEW.review_snapshot)',
  'protect_operations_shipping_one_off_pack_evidence',
  "TG_TABLE_NAME = 'operations_reservations'",
  "NEW.status IN ('consumed', 'released')",
  'protect_shipping_pack_order_line_evidence',
  'protect_shipping_pack_allocation_evidence',
  'protect_shipping_pack_reservation_evidence',
  'protect_shipping_pack_package_content_evidence',
  "source_order.source_provider = 'clawpilot_native'",
  "source_order.order_type = 'one_off'",
  "source_order.status = 'packed'",
  "reservation.status = 'active'",
]) {
  assert.ok(migration.includes(fragment), `0304 is missing ${fragment}`)
}
assert.match(healthContract, /0304_shipping_one_off_pack_confirmation\.sql/)
assert.match(healthContract, /artifact_count/)
assert.match(healthContract, /pg_get_functiondef/)
assert.match(healthContract, /pg_get_triggerdef/)
assert.match(healthRoute, /SHIPPING_ONE_OFF_PACK_HEALTH_SQL/)
assert.match(healthRoute, /shipping_one_off_pack_applied/)
assert.match(healthRoute, /shippingOneOffPack/)

for (const fragment of [
  'standaloneOneOffPackEligible',
  'One-off pack and postage',
  'confirm physical pack',
  'entirely in Shipping without Operations activation',
  '<ShippingOneOffExecutionPanel',
]) {
  assert.ok(section.includes(fragment), `Shipping UI is missing ${fragment}`)
}
for (const fragment of [
  'shipping-one-off-pack-review',
  "action: 'confirm-pack'",
  'ONE_OFF_PACK_CONFIRMATION',
  'expectedReviewSnapshotHash',
  'I physically verified every exact item is in its assigned parcel.',
  'Confirm physical pack',
  'zero carrier, postage, label, shipment, or inventory writes',
  "retainCommand('pack'",
  'packIsDurable',
]) {
  assert.ok(panel.includes(fragment), `Pack review UI is missing ${fragment}`)
}
assert.doesNotMatch(
  panel,
  /canManage|canExecute|canActivate|operations_activation_scopes/,
  'Shipping-only pack UI must not depend on Operations permissions or mode',
)
assert.match(projection, /standalone_one_off_pack_eligible/)
assert.match(projection, /source_order\.status = 'planned'/)
assert.match(projection, /plan\.status = 'planned'/)
assert.match(projection, /package_state\.status <> 'planned'/)

const storageValues = new Map()
const storage = {
  getItem(key) { return storageValues.get(key) || null },
  setItem(key, value) { storageValues.set(key, value) },
  removeItem(key) { storageValues.delete(key) },
}
const retainedPack = {
  key: 'shipping-one-off-pack:gor0000001:stable-request',
  body: JSON.stringify({
    action: 'confirm-pack',
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 1,
    expectedReviewSnapshotHash: 'a'.repeat(64),
  }),
}
assert.equal(
  recovery.writeShippingOneOffRetainedCommand(
    storage,
    'pack-storage',
    retainedPack,
  ),
  true,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(recovery.readShippingOneOffRetainedCommand(
    storage,
    'pack',
    'gor0000001',
    'pack-storage',
  ))),
  retainedPack,
)

let canCreate = true
let packCalls = 0
let packInput = null
const route = loadTypeScript(
  'app_src/app/api/operations/one-off-shipments/route.ts',
  {
    'next/server': {
      NextRequest: class {},
      NextResponse: {
        json: (payload, init) => ({
          payload,
          status: init?.status || 200,
        }),
      },
    },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId: () =>
        '11111111-1111-4111-8111-111111111111',
      shippingCapabilities: () => ({
        canView: true,
        canCreate,
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
    '@/lib/persistence/operationOneOffShipping': {},
    '@/lib/persistence/shippingOneOffPack': {
      packShippingOneOffShipmentInPostgres: async (input) => {
        packCalls += 1
        packInput = input
        return {
          orderGlobalId: input.orderGlobalId,
          orderStatus: 'packed',
          rowVersion: 2,
          fulfillmentPlanGlobalId: 'gfp0000001',
          reviewSnapshotHash: input.expectedReviewSnapshotHash,
          packageCount: 1,
          reservationCount: 1,
          packedAt: new Date(0).toISOString(),
          effects: {
            providerWrites: 0,
            labelWrites: 0,
            shipmentWrites: 0,
            inventoryWrites: 0,
          },
          replayed: false,
        }
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => ({
        email: 'shipping-only@example.test',
        role: 'member',
        permissions: {
          viewShipping: true,
          createShipments: true,
          viewOperations: false,
          executeWarehouse: false,
        },
      }),
    },
  },
)
const request = {
  headers: {
    get: (name) => name === 'idempotency-key'
      ? 'shipping-pack-stable-key'
      : null,
  },
  text: async () => JSON.stringify({
    action: 'confirm-pack',
    orderGlobalId: 'gor0000001',
    expectedRowVersion: 1,
    expectedReviewSnapshotHash: 'a'.repeat(64),
    confirmation:
      'I CONFIRM THESE EXACT ITEMS ARE PHYSICALLY IN THESE PACKAGES',
    reason: 'Physically reviewed the exact package contents',
  }),
}
const allowed = await route.POST(request)
assert.equal(allowed.status, 201)
assert.equal(packCalls, 1)
assert.equal(packInput.actorEmail, 'shipping-only@example.test')
assert.equal(packInput.idempotencyKey, 'shipping-pack-stable-key')
canCreate = false
const forbidden = await route.POST(request)
assert.equal(forbidden.status, 403)
assert.equal(forbidden.payload.code, 'SHIPPING_CREATE_REQUIRED')
assert.equal(packCalls, 1, 'Denied Shipping actor must cause zero pack work')

console.log('Shipping-only one-off pack API and UI contracts passed.')
