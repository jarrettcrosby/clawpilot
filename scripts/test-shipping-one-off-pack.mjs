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
const postgresSource = read('app_src/lib/persistence/postgres.ts')
const operationsRouteSource = read('app_src/app/api/operations/route.ts')
const recovery = loadTypeScript(
  'app_src/lib/operations/shippingOneOffRecovery.ts',
)
const postgresModule = loadTypeScript(
  'app_src/lib/persistence/postgres.ts',
  { pg: { Pool: class {} } },
)

const panelModule = loadTypeScript(
  'app_src/components/shipping/ShippingOneOffExecutionPanel.tsx',
  {
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
  },
)

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
assert.match(
  healthContract,
  /operations_one_off_plan_execution_is_exact/,
  'Health must fingerprint the exact TEST/LIVE plan authority function',
)
assert.match(
  operationsRouteSource,
  /OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY/,
  'Operations writers must expose the pack evidence conflict as a route conflict',
)
assert.equal(
  postgresSource.match(/throw normalizePostgresPersistenceError\(error\)/gu)?.length,
  2,
  'Direct query and transactional app writers must normalize the DB lock conflict',
)
const rawEvidenceBusy = Object.assign(new Error(
  postgresModule.SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY_CODE,
), { code: '55P03' })
const normalizedEvidenceBusy = postgresModule.normalizePostgresPersistenceError(
  rawEvidenceBusy,
)
assert.equal(normalizedEvidenceBusy.code, 'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY')
assert.equal(normalizedEvidenceBusy.status, 409)
assert.notEqual(normalizedEvidenceBusy, rawEvidenceBusy)
assert.equal(
  postgresModule.normalizePostgresPersistenceError(
    Object.assign(new Error('unrelated lock'), { code: '55P03' }),
  ).message,
  'unrelated lock',
)

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
  'packConfirmedEvidenceHash',
  'reconcilePackEvidenceAcknowledgment',
  'retainedPackReceiptDisposition',
]) {
  assert.ok(panel.includes(fragment), `Pack review UI is missing ${fragment}`)
}
assert.doesNotMatch(
  panel,
  /canManage|canExecute|canActivate|operations_activation_scopes/,
  'Shipping-only pack UI must not depend on Operations permissions or mode',
)
assert.match(
  panel,
  /if \(state\?\.orderGlobalId !== orderGlobalId\) return[\s\S]*?const packDisposition = retainedPackReceiptDisposition\([\s\S]*?state,[\s\S]*?packCommand,[\s\S]*?orderGlobalId,[\s\S]*?\)[\s\S]*?if \(packDisposition !== 'pending'\) \{[\s\S]*?clearPackCommand\(\)/,
  'Mount/status reconciliation must bind state and command to the current prop before retiring K1',
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
const evidenceHashA = 'a'.repeat(64)
const evidenceHashB = 'b'.repeat(64)
assert.equal(
  panelModule.reconcilePackEvidenceAcknowledgment(
    evidenceHashA,
    evidenceHashA,
    evidenceHashA,
  ),
  evidenceHashA,
  'A same-evidence manual status refresh may retain its exact acknowledgment',
)
assert.equal(
  panelModule.reconcilePackEvidenceAcknowledgment(
    evidenceHashA,
    evidenceHashA,
    evidenceHashB,
  ),
  null,
  'Manual Check status must clear acknowledgment when evidence drifts',
)
assert.equal(
  panelModule.reconcilePackEvidenceAcknowledgment(
    evidenceHashA,
    evidenceHashA,
    evidenceHashB,
  ),
  null,
  'Stale 409 reconciliation GET must require acknowledgment of new evidence',
)
assert.equal(
  panelModule.packEvidenceIsAcknowledged(evidenceHashA, evidenceHashB),
  false,
)
assert.equal(
  panelModule.reconcilePackEvidenceAcknowledgment(
    evidenceHashA,
    null,
    evidenceHashA,
  ),
  null,
  'An acknowledgment cannot cross an order/loading boundary even if hashes match',
)
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
const retainedPackBeforeDrift = JSON.stringify(retainedPack)
assert.equal(
  panelModule.reconcilePackEvidenceAcknowledgment(
    evidenceHashA,
    evidenceHashA,
    evidenceHashB,
  ),
  null,
)
assert.equal(
  JSON.stringify(recovery.readShippingOneOffRetainedCommand(
    storage,
    'pack',
    'gor0000001',
    'pack-storage',
  )),
  retainedPackBeforeDrift,
  'Evidence drift must not rewrite a byte-identical retained pending command',
)
assert.match(
  panel,
  /const command = packCommand \|\| newCommand/,
  'Pending retries must keep the exact retained command despite new acknowledgment state',
)

const plannedPackState = {
  orderGlobalId: 'gor0000001',
  orderStatus: 'planned',
  packageCount: 1,
  packReview: {
    state: 'review_required',
    required: true,
    evidenceHash: evidenceHashA,
    receipt: null,
  },
}
const terminalCompetingPackState = {
  orderGlobalId: 'gor0000001',
  orderStatus: 'packed',
  packageCount: 1,
  packReview: {
    state: 'packed',
    required: false,
    evidenceHash: null,
    receipt: {
      requestIdempotencyKey:
        'shipping-one-off-pack:gor0000001:competing-terminal-k2',
      reviewSnapshotHash: evidenceHashB,
      packageCount: 1,
      reservationCount: 1,
      packedAt: new Date(0).toISOString(),
    },
  },
}
const exactK1PackState = {
  ...terminalCompetingPackState,
  packReview: {
    ...terminalCompetingPackState.packReview,
    receipt: {
      ...terminalCompetingPackState.packReview.receipt,
      requestIdempotencyKey: retainedPack.key,
      reviewSnapshotHash: evidenceHashA,
    },
  },
}
const retainedStorageBytes = storageValues.get('pack-storage')
const firstMountK1 = recovery.readShippingOneOffRetainedCommand(
  storage,
  'pack',
  'gor0000001',
  'pack-storage',
)
assert.deepEqual(JSON.parse(JSON.stringify(firstMountK1)), retainedPack)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    null,
    firstMountK1,
    'gor0000001',
  ),
  'pending',
  'Mount before an authoritative GET must preserve ambiguous K1',
)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    plannedPackState,
    firstMountK1,
    'gor0000001',
  ),
  'pending',
  'A nonterminal same-order state must preserve ambiguous K1',
)
assert.equal(storageValues.get('pack-storage'), retainedStorageBytes)
const remountedK1 = recovery.readShippingOneOffRetainedCommand(
  storage,
  'pack',
  'gor0000001',
  'pack-storage',
)
assert.deepEqual(JSON.parse(JSON.stringify(remountedK1)), retainedPack)
assert.equal(remountedK1.body, retainedPack.body)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    exactK1PackState,
    remountedK1,
    'gor0000001',
  ),
  'exact',
  'The original immutable K1 receipt remains an exact durable success',
)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    {
      ...exactK1PackState,
      packReview: {
        ...exactK1PackState.packReview,
        receipt: {
          ...exactK1PackState.packReview.receipt,
          reviewSnapshotHash: evidenceHashB,
        },
      },
    },
    remountedK1,
    'gor0000001',
  ),
  'pending',
  'A same-key receipt with mismatched evidence cannot retire K1',
)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    { ...terminalCompetingPackState, orderGlobalId: 'gor0000002' },
    remountedK1,
    'gor0000001',
  ),
  'pending',
  'A different-order terminal receipt cannot retire K1',
)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    terminalCompetingPackState,
    remountedK1,
    'gor0000001',
  ),
  'superseded',
  'An immutable same-order terminal K2 receipt may retire ambiguous K1',
)
assert.equal(
  recovery.writeShippingOneOffRetainedCommand(
    storage,
    'pack-storage',
    null,
  ),
  true,
)
assert.equal(
  recovery.readShippingOneOffRetainedCommand(
    storage,
    'pack',
    'gor0000001',
    'pack-storage',
  ),
  null,
  'Remount after exact terminal K2 proof must not restore retired K1',
)

const propSwitchOrderGlobalId = 'gor0000002'
const propSwitchStorageKey = 'pack-storage-b'
const retainedPackB = {
  key: 'shipping-one-off-pack:gor0000002:stable-request-b',
  body: JSON.stringify({
    action: 'confirm-pack',
    orderGlobalId: propSwitchOrderGlobalId,
    expectedRowVersion: 3,
    expectedReviewSnapshotHash: evidenceHashB,
  }),
}
assert.equal(
  recovery.writeShippingOneOffRetainedCommand(
    storage,
    propSwitchStorageKey,
    retainedPackB,
  ),
  true,
)
const propSwitchBBytes = storageValues.get(propSwitchStorageKey)
let propSwitchNotice = ''
const staleADispositionForB = panelModule.retainedPackReceiptDisposition(
  terminalCompetingPackState,
  remountedK1,
  propSwitchOrderGlobalId,
)
if (staleADispositionForB !== 'pending') {
  recovery.writeShippingOneOffRetainedCommand(
    storage,
    propSwitchStorageKey,
    null,
  )
  if (staleADispositionForB === 'superseded') {
    propSwitchNotice = 'Another immutable physical pack receipt completed this order.'
  }
}
assert.equal(staleADispositionForB, 'pending')
assert.equal(
  storageValues.get(propSwitchStorageKey),
  propSwitchBBytes,
  'An A terminal-state effect flush must preserve the exact retained B K1 bytes',
)
assert.equal(
  propSwitchNotice,
  '',
  'An A terminal-state effect flush must not show an A receipt notice on B',
)
const terminalCompetingPackStateB = {
  ...terminalCompetingPackState,
  orderGlobalId: propSwitchOrderGlobalId,
  packReview: {
    ...terminalCompetingPackState.packReview,
    receipt: {
      ...terminalCompetingPackState.packReview.receipt,
      requestIdempotencyKey:
        'shipping-one-off-pack:gor0000002:competing-terminal-k2',
    },
  },
}
const remountedK1B = recovery.readShippingOneOffRetainedCommand(
  storage,
  'pack',
  propSwitchOrderGlobalId,
  propSwitchStorageKey,
)
assert.equal(
  panelModule.retainedPackReceiptDisposition(
    terminalCompetingPackStateB,
    remountedK1B,
    propSwitchOrderGlobalId,
  ),
  'superseded',
  'A same-order terminal K2 must still retire B K1 after the prop transition',
)
recovery.writeShippingOneOffRetainedCommand(
  storage,
  propSwitchStorageKey,
  null,
)
assert.equal(storageValues.has(propSwitchStorageKey), false)

let canCreate = true
let packCalls = 0
let packInput = null
let packFailure = null
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
        if (packFailure) throw packFailure
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
canCreate = true
packFailure = new TestPersistenceError(
  'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
  'This key belongs to different pack evidence',
  409,
)
const idempotencyConflict = await route.POST(request)
assert.equal(idempotencyConflict.status, 409)
assert.equal(
  idempotencyConflict.payload.code,
  'OPERATIONS_IDEMPOTENCY_KEY_REUSED',
)
packFailure = normalizedEvidenceBusy
const evidenceConflict = await route.POST(request)
assert.equal(evidenceConflict.status, 409)
assert.equal(
  evidenceConflict.payload.code,
  'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY',
)

console.log('Shipping-only one-off pack API and UI contracts passed.')
