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
const executionPersistenceSource = read(
  'app_src/lib/persistence/operationOneOffShipping.ts',
)
const printPersistenceSource = read(
  'app_src/lib/persistence/operationPrintDelivery.ts',
)
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
const printGatewayWorkflow = read('.github/workflows/print-gateway-ci.yml')
const shippingPostgresHarnesses = [
  read('scripts/test-shipping-independence-postgres.mjs'),
  read('scripts/test-shipping-one-off-pack-postgres.mjs'),
]
const recovery = loadTypeScript(
  'app_src/lib/operations/shippingOneOffRecovery.ts',
)
const postgresModule = loadTypeScript(
  'app_src/lib/persistence/postgres.ts',
  { pg: { Pool: class {} } },
)

for (const watchedPath of [
  'app_src/app/api/operations/one-off-shipments/route.ts',
  'app_src/components/shipping/**',
  'app_src/lib/operations/shippingOneOffRecovery.ts',
  'app_src/lib/persistence/operationOneOffShipping.ts',
  'db/migrations/*shipping*.sql',
  'scripts/test-shipping-one-off-pack*.mjs',
]) {
  assert.equal(
    printGatewayWorkflow.split(`- "${watchedPath}"`).length - 1,
    2,
    `Print Gateway pull-request and push filters must both watch ${watchedPath}`,
  )
}

for (const harness of shippingPostgresHarnesses) {
  assert.ok(
    harness.includes('SELECT pg_postmaster_start_time()::text AS postmaster_start'),
    'Shipping PostgreSQL readiness must probe the mapped TCP database',
  )
  assert.ok(
    harness.includes('consecutiveMatches >= 2'),
    'Shipping PostgreSQL readiness must survive the temporary init postmaster transition',
  )
  assert.doesNotMatch(
    harness,
    /pg_isready/,
    'In-container pg_isready can accept the temporary Unix-socket init postmaster',
  )
}

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

const inFlightFenceA = { orderGlobalId: 'gor0000001', generation: 4 }
const retainedFenceB = { orderGlobalId: 'gor0000002', generation: 5 }
const remountedFenceA = { orderGlobalId: 'gor0000001', generation: 6 }
assert.equal(
  panelModule.executionOrderFenceIsCurrent(inFlightFenceA, retainedFenceB),
  false,
  'An order-A request must become stale as soon as the prop switches to B',
)
assert.equal(
  panelModule.executionOrderFenceIsCurrent(inFlightFenceA, remountedFenceA),
  false,
  'An A-to-B-to-A transition must still invalidate the first A generation',
)
assert.equal(
  panelModule.executionStateLoadIsCurrent(
    true,
    inFlightFenceA,
    inFlightFenceA,
    7,
    8,
  ),
  false,
  'An older same-order GET epoch must not publish after a newer GET starts',
)
assert.equal(
  panelModule.mountedExecutionOrderFenceIsCurrent(
    false,
    inFlightFenceA,
    inFlightFenceA,
  ),
  false,
  'Unmount must invalidate a delayed completion even when order and generation still match',
)
const retainedBBytes = JSON.stringify({
  key: 'shipping-print-order-b-retained-key',
  body: '{"action":"recover-label-print","orderGlobalId":"gor0000002"}',
})
const switchedOrderB = {
  commandBytes: retainedBBytes,
  storageBytes: retainedBBytes,
  busy: '',
  notice: '',
  stateOrderGlobalId: 'gor0000002',
}
if (panelModule.executionOrderFenceIsCurrent(
  inFlightFenceA,
  retainedFenceB,
)) {
  switchedOrderB.commandBytes = null
  switchedOrderB.storageBytes = null
  switchedOrderB.busy = 'print'
  switchedOrderB.notice = 'Order A completed'
  switchedOrderB.stateOrderGlobalId = 'gor0000001'
}
assert.deepEqual(
  switchedOrderB,
  {
    commandBytes: retainedBBytes,
    storageBytes: retainedBBytes,
    busy: '',
    notice: '',
    stateOrderGlobalId: 'gor0000002',
  },
  'A deferred completion must produce zero B command, storage, busy, notice, or state mutation',
)
assert.equal(
  switchedOrderB.busy === '' && switchedOrderB.commandBytes === null,
  false,
  'Preserving B retained bytes must keep a fresh K-C command disabled',
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
  "action === 'recover-label-print'",
  'recoverOperationsOneOffLabelPrintInPostgres({',
  'expectedPrintJobGlobalId',
  'expectedPrintArtifactGlobalId',
  'expectedRecoveryAction',
  'expectedLatestAttemptSequenceNumber',
]) {
  assert.ok(routeSource.includes(fragment), `Print recovery route is missing ${fragment}`)
}
const printRouteBranch = routeSource.slice(
  routeSource.indexOf("if (action === 'recover-label-print')"),
  routeSource.indexOf("if (action === 'void-group')"),
)
assert.doesNotMatch(
  printRouteBranch,
  /operationsCapabilities|canExecute|canManage|canActivate|purchaseLivePostage/,
  'Shipping print recovery must require only the enclosing createShipments gate',
)
const printRecoveryPersistence = executionPersistenceSource.slice(
  executionPersistenceSource.indexOf(
    'export async function recoverOperationsOneOffLabelPrintInPostgres',
  ),
  executionPersistenceSource.indexOf(
    'export async function refreshOperationsOneOffPackedRatesInPostgres',
  ),
)
for (const fragment of [
  "source_order.source_provider = 'clawpilot_native'",
  "source_order.order_type = 'one_off'",
  "source_order.status = 'packed'",
  "label.status = 'created'",
  'package.status = \'labeled\'',
  'expectedPrintArtifactGlobalId',
  'enqueueOperationsPrintJobInPostgres({',
  'retryOperationsPrintJobInPostgres({',
  "client, 'certain_exhausted_only'",
  'carrierWrites: 0',
  'providerWrites: 0',
  'labelWrites: 0',
  'operations:one-off-label-print-recovery:',
  'operations:print-label:',
  'operations_print_delivery_attempts attempt',
]) {
  assert.ok(
    printRecoveryPersistence.includes(fragment),
    `Shipping print persistence is missing ${fragment}`,
  )
}
assert.doesNotMatch(
  printRecoveryPersistence,
  /executeCarrier|resolveCarrier|INSERT INTO operations_labels|UPDATE operations_labels|label_payload\s*=/,
  'Shipping print recovery must never call a carrier/provider or mutate label evidence',
)
assert.match(
  printPersistenceSource,
  /authorization === 'certain_exhausted_only'[\s\S]*?certainExhaustedFailureRecovery/,
  'Exhausted Shipping recovery must use the narrow certain-zero-output authority',
)
for (const errorCode of [
  'LOCAL_PRINTER_BUSY',
  'PRINTER_UNAVAILABLE',
  'PRINT_ARTIFACT_INVALID',
  'PRINT_CLAIM_LEASE_TOO_SHORT',
  'PRINT_DELIVERY_STOPPED',
]) {
  assert.ok(
    printPersistenceSource.includes(`'${errorCode}'`),
    `Zero-byte print evidence set is missing ${errorCode}`,
  )
  assert.ok(
    executionPersistenceSource.includes(`'${errorCode}'`),
    `Shipping recovery projection is missing ${errorCode}`,
  )
}
assert.match(
  printPersistenceSource,
  /certainExhaustedFailureRecovery[\s\S]*?operationsPrintFailureProvesZeroBytes\(latestOutcome\.error_code\)/,
)
assert.match(
  printRecoveryPersistence,
  /operationsPrintFailureProvesZeroBytes\([\s\S]*?currentJob\.latest_attempt_error_code/,
  'Shipping retry and new-print commands must both require exact zero-byte evidence',
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
for (const fragment of [
  'shipping-one-off-label-print-status',
  'Print not queued',
  'Print ${label.printStatus}',
  'Queue existing label',
  'Retry exact failed print job',
  'Authorize new print after exhausted failure',
  'responseBindingRequired',
  'printRecoveryResponseMatchesDurableState',
]) {
  assert.ok(panel.includes(fragment), `Shipping print UI is missing ${fragment}`)
}
assert.match(
  panel,
  /if \(state\?\.orderGlobalId !== orderGlobalId\) return[\s\S]*?const packDisposition = retainedPackReceiptDisposition\([\s\S]*?state,[\s\S]*?packCommand,[\s\S]*?orderGlobalId,[\s\S]*?\)[\s\S]*?if \(packDisposition !== 'pending'\) \{[\s\S]*?clearPackCommand\(packCommand\)/,
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
const retainedActionBodies = new Map([
  ['pack', 'confirm-pack'],
  ['packed-rate', 'refresh-packed-rates'],
  ['purchase', 'purchase-group'],
  ['void', 'void-group'],
  ['print', 'recover-label-print'],
])
for (const [retainedAction, bodyAction] of retainedActionBodies) {
  const storageKey = `unmount-cas-${retainedAction}`
  const staleK1 = {
    key: `shipping-one-off-${retainedAction}:same-order:K1`,
    body: JSON.stringify({
      action: bodyAction,
      orderGlobalId: 'gor-unmount-reopen',
      expectedRowVersion: 1,
    }),
  }
  const reopenedK2 = {
    key: `shipping-one-off-${retainedAction}:same-order:K2`,
    body: JSON.stringify({
      action: bodyAction,
      orderGlobalId: 'gor-unmount-reopen',
      expectedRowVersion: 2,
    }),
  }
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      null,
      staleK1,
    ),
    true,
  )
  // The reopened component first reconciles K1 authoritatively, then creates
  // K2. The old, unmounted request still holds K1 in its async closure.
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      staleK1,
      null,
    ),
    true,
  )
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      null,
      reopenedK2,
    ),
    true,
  )
  const reopenedK2Bytes = storageValues.get(storageKey)
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      staleK1,
      null,
    ),
    false,
    `Late ${retainedAction} K1 completion must not remove reopened K2`,
  )
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      staleK1,
      { ...staleK1, responseBindingRequired: true },
    ),
    false,
    `Late ${retainedAction} K1 completion must not overwrite reopened K2`,
  )
  assert.equal(
    storageValues.get(storageKey),
    reopenedK2Bytes,
    `Reopened ${retainedAction} K2 bytes must remain byte exact`,
  )
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      null,
      {
        key: `shipping-one-off-${retainedAction}:same-order:K3`,
        body: reopenedK2.body,
      },
    ),
    false,
    `Retained ${retainedAction} K2 must keep K3 disabled`,
  )
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      reopenedK2,
      null,
    ),
    true,
  )
}
for (const retainedAction of ['purchase', 'print']) {
  const storageKey = `late-unmount-${retainedAction}`
  const staleK1 = {
    key: `shipping-one-off-${retainedAction}:reopened-order:K1`,
    body: JSON.stringify({
      action: retainedAction === 'print'
        ? 'recover-label-print'
        : 'purchase-group',
      orderGlobalId: 'gor-reopened-same-order',
    }),
  }
  const reopenedK2 = {
    key: `shipping-one-off-${retainedAction}:reopened-order:K2`,
    body: JSON.stringify({
      action: retainedAction === 'print'
        ? 'recover-label-print'
        : 'purchase-group',
      orderGlobalId: 'gor-reopened-same-order',
      expectedRowVersion: 2,
    }),
  }
  assert.equal(
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      null,
      reopenedK2,
    ),
    true,
  )
  const reopenedBytes = storageValues.get(storageKey)
  const reopenedUi = {
    command: reopenedK2,
    busy: retainedAction,
    notice: '',
  }
  if (panelModule.mountedExecutionOrderFenceIsCurrent(
    false,
    inFlightFenceA,
    inFlightFenceA,
  )) {
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      storageKey,
      staleK1,
      null,
    )
    reopenedUi.command = null
    reopenedUi.busy = ''
    reopenedUi.notice = 'Stale K1 completed'
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(reopenedUi)),
    {
      command: reopenedK2,
      busy: retainedAction,
      notice: '',
    },
    `Late unmounted ${retainedAction} K1 must not mutate reopened K2 UI`,
  )
  assert.equal(
    storageValues.get(storageKey),
    reopenedBytes,
    `Late unmounted ${retainedAction} K1 must preserve reopened K2 bytes`,
  )
}
assert.equal(
  recovery.shippingOneOffRetainedCommandsMatch(null, {}),
  false,
  'Malformed retained evidence must never compare equal to empty storage',
)
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

const printOrderGlobalId = 'gor9400201'
const printPackageGlobalId = 'gpa9400201'
const printLabelGlobalId = 'glb9400201'
const printJobGlobalId = 'gpj9400201'
const printArtifactGlobalId = 'gpf9400201'
const retainedPrint = {
  key: `shipping-one-off-print:${printOrderGlobalId}:stable-print-request`,
  body: JSON.stringify({
    action: 'recover-label-print',
    expectedRecoveryAction: 'enqueue',
    orderGlobalId: printOrderGlobalId,
    expectedRowVersion: 7,
    packageGlobalId: printPackageGlobalId,
    labelGlobalId: printLabelGlobalId,
    expectedPrintJobGlobalId: null,
    expectedPrintJobStatus: null,
    expectedPrintArtifactGlobalId: null,
    expectedPrintAttempts: null,
    expectedPrintMaxAttempts: null,
    expectedLatestAttemptSequenceNumber: null,
    expectedLatestErrorCode: null,
    reason: 'Queue the existing immutable label after printer setup',
  }),
  responseBindingRequired: true,
}
const printStorageKey = 'print-storage'
assert.equal(
  recovery.writeShippingOneOffRetainedCommand(
    storage,
    printStorageKey,
    retainedPrint,
  ),
  true,
)
const retainedPrintBytes = storageValues.get(printStorageKey)
const remountedPrint = recovery.readShippingOneOffRetainedCommand(
  storage,
  'print',
  printOrderGlobalId,
  printStorageKey,
)
assert.deepEqual(
  JSON.parse(JSON.stringify(remountedPrint)),
  retainedPrint,
  'Malformed/mismatched 2xx response-binding state must survive remount',
)
assert.equal(storageValues.get(printStorageKey), retainedPrintBytes)
const exactPrintState = {
  orderGlobalId: printOrderGlobalId,
  carrierGroup: {
    active: true,
    labels: [{
      packageGlobalId: printPackageGlobalId,
      labelGlobalId: printLabelGlobalId,
      status: 'created',
      printJobGlobalId,
      printJobStatus: 'queued',
      printArtifactGlobalId,
      printContentSha256: 'c'.repeat(64),
      printByteLength: 812,
      printMaxAttempts: 3,
      printLatestAttemptSequenceNumber: 1,
      printLatestErrorCode: null,
      printJobRequestIdempotencyKey: retainedPrint.key,
      printLastOperatorRetryIdempotencyKey: null,
      printOperatorRetryIdempotencyKeys: [],
      printReprintOfJobGlobalId: null,
    }],
  },
}
const exactPrintResult = {
  orderGlobalId: printOrderGlobalId,
  packageGlobalId: printPackageGlobalId,
  labelGlobalId: printLabelGlobalId,
  action: 'enqueue',
  printJobGlobalId,
  sourcePrintJobGlobalId: null,
  printJobStatus: 'queued',
  printStatus: 'queued',
  printArtifactGlobalId,
  printContentSha256: 'c'.repeat(64),
  printByteLength: 812,
  printAttempts: 1,
  printMaxAttempts: 3,
  effects: { carrierWrites: 0, providerWrites: 0, labelWrites: 0 },
  replayed: false,
}
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    exactPrintState,
    remountedPrint,
    printOrderGlobalId,
  ),
  'exact',
)
assert.equal(
  panelModule.printRecoveryResponseMatchesDurableState(
    exactPrintResult,
    exactPrintState,
    remountedPrint,
    printOrderGlobalId,
  ),
  true,
  'Exact response must bind to durable job, label, artifact, action, and effects',
)
const immutableResponseDriftCases = [
  ['printJobGlobalId', 'gpj9400202'],
  ['printArtifactGlobalId', 'gpf9400202'],
  ['printContentSha256', 'd'.repeat(64)],
  ['printByteLength', 813],
  ['printMaxAttempts', 4],
  ['action', 'retry'],
  ['sourcePrintJobGlobalId', printJobGlobalId],
]
for (const [field, value] of immutableResponseDriftCases) {
  assert.equal(
    panelModule.printRecoveryResponseMatchesDurableState(
      { ...exactPrintResult, [field]: value },
      exactPrintState,
      remountedPrint,
      printOrderGlobalId,
    ),
    false,
    `A mismatched successful response ${field} must retain exact command bytes`,
  )
  assert.equal(storageValues.get(printStorageKey), retainedPrintBytes)
}
for (const effect of ['carrierWrites', 'providerWrites', 'labelWrites']) {
  assert.equal(
    panelModule.printRecoveryResponseMatchesDurableState(
      {
        ...exactPrintResult,
        effects: { ...exactPrintResult.effects, [effect]: 1 },
      },
      exactPrintState,
      remountedPrint,
      printOrderGlobalId,
    ),
    false,
    `A nonzero ${effect} response must retain exact command bytes`,
  )
  assert.equal(storageValues.get(printStorageKey), retainedPrintBytes)
}
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    null,
    remountedPrint,
    printOrderGlobalId,
  ),
  'pending',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    exactPrintState,
    remountedPrint,
    'gor9400202',
  ),
  'pending',
  'A stale order effect must never reconcile another order print command',
)
assert.equal(storageValues.get(printStorageKey), retainedPrintBytes)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...exactPrintState,
      carrierGroup: {
        ...exactPrintState.carrierGroup,
        labels: [{
          ...exactPrintState.carrierGroup.labels[0],
          printJobGlobalId: 'gpj9400202',
          printJobRequestIdempotencyKey: 'competing-print-key',
        }],
      },
    },
    remountedPrint,
    printOrderGlobalId,
  ),
  'superseded',
  'A competing authoritative original job supersedes a retained enqueue',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...exactPrintState,
      carrierGroup: { ...exactPrintState.carrierGroup, active: false },
    },
    remountedPrint,
    printOrderGlobalId,
  ),
  'superseded',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...exactPrintState,
      carrierGroup: {
        ...exactPrintState.carrierGroup,
        labels: [{ ...exactPrintState.carrierGroup.labels[0], status: 'voided' }],
      },
    },
    remountedPrint,
    printOrderGlobalId,
  ),
  'superseded',
)
const retainedRetryPrint = {
  key: `shipping-one-off-print:${printOrderGlobalId}:stable-retry-request`,
  body: JSON.stringify({
    action: 'recover-label-print',
    expectedRecoveryAction: 'retry',
    orderGlobalId: printOrderGlobalId,
    expectedRowVersion: 7,
    packageGlobalId: printPackageGlobalId,
    labelGlobalId: printLabelGlobalId,
    expectedPrintJobGlobalId: printJobGlobalId,
    expectedPrintJobStatus: 'failed',
    expectedPrintArtifactGlobalId: printArtifactGlobalId,
    expectedPrintAttempts: 1,
    expectedPrintMaxAttempts: 3,
    expectedLatestAttemptSequenceNumber: 2,
    expectedLatestErrorCode: 'PRINTER_UNAVAILABLE',
    reason: 'Retry the exact certain zero-output failed job',
  }),
}
const failedRetryState = {
  ...exactPrintState,
  carrierGroup: {
    ...exactPrintState.carrierGroup,
    labels: [{
      ...exactPrintState.carrierGroup.labels[0],
      printJobStatus: 'failed',
      printLastOperatorRetryIdempotencyKey: null,
      printOperatorRetryIdempotencyKeys: [],
    }],
  },
}
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    failedRetryState,
    retainedRetryPrint,
    printOrderGlobalId,
  ),
  'pending',
)
const exactRetryState = {
  ...failedRetryState,
  carrierGroup: {
    ...failedRetryState.carrierGroup,
    labels: [{
      ...failedRetryState.carrierGroup.labels[0],
      printLastOperatorRetryIdempotencyKey:
        `print-user:retry:${retainedRetryPrint.key}`,
      printOperatorRetryIdempotencyKeys: [
        `print-user:retry:${retainedRetryPrint.key}`,
      ],
    }],
  },
}
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    exactRetryState,
    retainedRetryPrint,
    printOrderGlobalId,
  ),
  'exact',
)
const epochRetainedRetry = {
  ...retainedRetryPrint,
  responseBindingRequired: true,
}
const epochStorageKey = 'same-order-load-epoch-print-k2'
assert.equal(
  recovery.replaceShippingOneOffRetainedCommandIfExact(
    storage,
    epochStorageKey,
    null,
    epochRetainedRetry,
  ),
  true,
)
const epochRetainedBytes = storageValues.get(epochStorageKey)
const sameOrderLoadFence = {
  orderGlobalId: printOrderGlobalId,
  generation: 14,
}
const newerLoadEpoch = 2
let publishedPrintState = failedRetryState
let sameOrderLoadNotice = ''
if (panelModule.executionStateLoadIsCurrent(
  true,
  sameOrderLoadFence,
  sameOrderLoadFence,
  newerLoadEpoch,
  newerLoadEpoch,
)) {
  publishedPrintState = exactRetryState
}
const newerDisposition = panelModule.retainedPrintRecoveryDisposition(
  publishedPrintState,
  epochRetainedRetry,
  printOrderGlobalId,
)
if (
  newerDisposition !== 'pending'
  && !(newerDisposition === 'exact'
    && epochRetainedRetry.responseBindingRequired)
) {
  recovery.replaceShippingOneOffRetainedCommandIfExact(
    storage,
    epochStorageKey,
    epochRetainedRetry,
    null,
  )
}
const olderQueuedPrintState = {
  ...failedRetryState,
  carrierGroup: {
    ...failedRetryState.carrierGroup,
    labels: [{
      ...failedRetryState.carrierGroup.labels[0],
      printJobStatus: 'queued',
    }],
  },
}
if (panelModule.executionStateLoadIsCurrent(
  true,
  sameOrderLoadFence,
  sameOrderLoadFence,
  1,
  newerLoadEpoch,
)) {
  publishedPrintState = olderQueuedPrintState
  const staleDisposition = panelModule.retainedPrintRecoveryDisposition(
    publishedPrintState,
    epochRetainedRetry,
    printOrderGlobalId,
  )
  if (staleDisposition !== 'pending') {
    recovery.replaceShippingOneOffRetainedCommandIfExact(
      storage,
      epochStorageKey,
      epochRetainedRetry,
      null,
    )
    sameOrderLoadNotice = 'Older queued snapshot superseded K2'
  }
}
assert.equal(
  publishedPrintState,
  exactRetryState,
  'Newer exact retry state must survive a later-resolving older same-order GET',
)
assert.equal(
  storageValues.get(epochStorageKey),
  epochRetainedBytes,
  'Later-resolving older GET must not clear response-bound K2 bytes',
)
assert.equal(
  sameOrderLoadNotice,
  '',
  'Later-resolving older GET must not publish a false superseded notice',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...exactRetryState,
      carrierGroup: {
        ...exactRetryState.carrierGroup,
        labels: [{
          ...exactRetryState.carrierGroup.labels[0],
          printLastOperatorRetryIdempotencyKey:
            'print-user:retry:shipping-newer-k2',
          printOperatorRetryIdempotencyKeys: [
            `print-user:retry:${retainedRetryPrint.key}`,
            'print-user:retry:shipping-newer-k2',
          ],
        }],
      },
    },
    retainedRetryPrint,
    printOrderGlobalId,
  ),
  'exact',
  'Retry K1 remains durably exact after a later K2 retry changes current state',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...failedRetryState,
      carrierGroup: {
        ...failedRetryState.carrierGroup,
        labels: [{
          ...failedRetryState.carrierGroup.labels[0],
          printJobStatus: 'queued',
        }],
      },
    },
    retainedRetryPrint,
    printOrderGlobalId,
  ),
  'superseded',
)
const retainedNewPrint = {
  key: `shipping-one-off-print:${printOrderGlobalId}:stable-new-print`,
  body: JSON.stringify({
    ...JSON.parse(retainedRetryPrint.body),
    expectedRecoveryAction: 'new_print',
    expectedPrintAttempts: 3,
    expectedLatestAttemptSequenceNumber: 4,
  }),
}
const exactNewPrintState = {
  ...failedRetryState,
  carrierGroup: {
    ...failedRetryState.carrierGroup,
    labels: [{
      ...failedRetryState.carrierGroup.labels[0],
      printJobGlobalId: 'gpj9400202',
      printJobRequestIdempotencyKey:
        `print-user:reprint:${retainedNewPrint.key}`,
      printReprintOfJobGlobalId: printJobGlobalId,
    }],
  },
}
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    exactNewPrintState,
    retainedNewPrint,
    printOrderGlobalId,
  ),
  'exact',
)
assert.equal(
  panelModule.retainedPrintRecoveryDisposition(
    {
      ...exactNewPrintState,
      carrierGroup: {
        ...exactNewPrintState.carrierGroup,
        labels: [{
          ...exactNewPrintState.carrierGroup.labels[0],
          printJobRequestIdempotencyKey: 'wrong-new-print-key',
        }],
      },
    },
    retainedNewPrint,
    printOrderGlobalId,
  ),
  'superseded',
)
assert.equal(
  panelModule.printRecoveryResponseMatchesDurableState(
    null,
    exactPrintState,
    remountedPrint,
    printOrderGlobalId,
  ),
  false,
  'A malformed 2xx result must not clear the retained command',
)
assert.match(
  panel,
  /if \(response\.ok\) \{[\s\S]*?retainUntilResponseIsBound\(\)[\s\S]*?retained byte-identical request was preserved/,
  'Malformed successful response must persist the exact command for replay',
)
assert.match(
  panel,
  /!printRecoveryResponseMatchesDurableState\([\s\S]*?retained byte-identical request was preserved/,
  'Mismatched successful response must report that the exact command remains retained',
)
assert.match(
  panel,
  /const result = payload\.result[\s\S]*?retainUntilResponseIsBound\(\)[\s\S]*?const durable = await loadState\(\)[\s\S]*?!printRecoveryResponseMatchesDurableState\(/,
  'Successful response bytes must be guarded before durable state can trigger reconciliation',
)
assert.match(
  panel,
  /printDisposition === 'exact'[\s\S]*?printCommand\?\.responseBindingRequired/,
  'Automatic status reconciliation must not clear response-binding-required bytes',
)
assert.match(
  panel,
  /const executionOrderFenceRef = useRef<ExecutionOrderFence>[\s\S]*?generation: executionOrderFenceRef\.current\.generation \+ 1/,
  'Prop transitions must advance an immutable execution generation',
)
assert.match(
  panel,
  /useEffect\(\(\) => \{[\s\S]*?componentMountedRef\.current = true[\s\S]*?return \(\) => \{[\s\S]*?componentMountedRef\.current = false/,
  'Unmount must invalidate every delayed Shipping command continuation',
)
for (const action of ['pack', 'packed-rate', 'purchase', 'void', 'print']) {
  assert.ok(
    panel.includes(
      `if (!retainCommand('${action}', orderGlobalId, expected, null)) return`,
    ),
    `${action} retained-command clear must be compare-and-set against exact K/body bytes`,
  )
}
const loadStateSource = panel.slice(
  panel.indexOf('const loadState = useCallback'),
  panel.indexOf('useEffect(() => {', panel.indexOf('const loadState = useCallback')),
)
assert.match(
  loadStateSource,
  /await fetch\([\s\S]*?if \(!requestIsCurrent\(\)\) return null[\s\S]*?await readPayload\(response\)[\s\S]*?if \(!requestIsCurrent\(\)\) return null/,
  'Deferred status GET and payload parsing must be fenced before state publication',
)
assert.match(
  loadStateSource,
  /const requestEpoch = loadStateEpochRef\.current \+ 1[\s\S]*?executionStateLoadIsCurrent\([\s\S]*?requestEpoch,[\s\S]*?loadStateEpochRef\.current/,
  'Every status GET must publish only under its exact latest monotonic epoch',
)
assert.match(
  panel,
  /disabled=\{Boolean\(busy\) \|\| loading\}[\s\S]*?>\s*Check status/,
  'Manual status refresh must be disabled while a GET is already in flight',
)
const printFlowSource = panel.slice(
  panel.indexOf('const recoverLabelPrint = async'),
  panel.indexOf('\n  const voidLabels = async'),
)
assert.match(
  printFlowSource,
  /await fetch\([\s\S]*?if \(!requestIsCurrent\(\)\) return[\s\S]*?await readPayload\(response\)[\s\S]*?if \(!requestIsCurrent\(\)\) return/,
  'Deferred print POST and response parsing must be fenced before UI mutation',
)
assert.match(
  printFlowSource,
  /state\.orderGlobalId !== orderGlobalId[\s\S]*?printCommand && retainedBody\?\.orderGlobalId !== orderGlobalId/,
  'Synchronous prop transition must reject stale state and retained body before storing or POSTing',
)
assert.match(
  panel,
  /const action = retainedForLabel[\s\S]*?retainedPrintBody\?\.expectedRecoveryAction/,
  'Retained print button copy must come from immutable request action bytes',
)
assert.match(
  printFlowSource,
  /finally \{[\s\S]*?if \(requestIsCurrent\(\)\) setBusy\(''\)/,
  'A stale print completion must not clear the current order busy state',
)

const commandFlowBoundaries = [
  ['pack', 'const confirmPack = async', '\n  const refreshRates = async'],
  ['packed-rate', 'const refreshRates = async', '\n  const purchaseLabels = async'],
  ['purchase', 'const purchaseLabels = async', '\n  const recoverLabelPrint = async'],
  ['print', 'const recoverLabelPrint = async', '\n  const voidLabels = async'],
  ['void', 'const voidLabels = async', '\n\n  if (!currentState)'],
]
for (const [action, startMarker, endMarker] of commandFlowBoundaries) {
  const start = panel.indexOf(startMarker)
  const end = panel.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `${action} handler boundaries must exist`)
  const flow = panel.slice(start, end)
  assert.match(
    flow,
    /const requestIsCurrent[\s\S]*?if \(\s*!requestIsCurrent\(\)/,
    `${action} must reject a stale/unmounted request before retaining or sending bytes`,
  )
  const entryFenceIndex = flow.indexOf('!requestIsCurrent()')
  const retainIndex = flow.indexOf('retainCommand(')
  const fetchIndex = flow.indexOf("fetch('/api/operations/one-off-shipments'")
  assert.ok(
    entryFenceIndex >= 0
      && retainIndex > entryFenceIndex
      && fetchIndex > entryFenceIndex,
    `${action} old-prop handler fence must precede storage and POST effects`,
  )
  assert.match(
    flow,
    /await fetch\([\s\S]*?if \(!requestIsCurrent\(\)\) return[\s\S]*?await readPayload\(response\)[\s\S]*?if \(!requestIsCurrent\(\)\) return/,
    `${action} must fence both POST and payload continuations`,
  )
  const loadCount = (flow.match(/await loadState\(\)/g) || []).length
  const fencedLoadCount = (
    flow.match(/await loadState\(\)\s*\n\s*if \(!requestIsCurrent\(\)\) return/g)
    || []
  ).length
  assert.equal(
    fencedLoadCount,
    loadCount,
    `${action} must fence every durable reconciliation continuation`,
  )
  assert.doesNotMatch(
    flow,
    /catch \(caught\) \{\s*const durable = await loadState\(\)/,
    `${action} stale catch must not start a newer same-component GET epoch`,
  )
  const updateCount = (flow.match(/await onUpdated\(\)/g) || []).length
  const fencedUpdateCount = (
    flow.match(/if \(!requestIsCurrent\(\)\) return\s*\n\s*await onUpdated\(\)/g)
    || []
  ).length
  assert.equal(
    fencedUpdateCount,
    updateCount,
    `${action} must fence every external UI refresh continuation`,
  )
  assert.match(
    flow,
    /finally \{[\s\S]*?if \(requestIsCurrent\(\)\) setBusy\(''\)/,
    `${action} stale completion must not clear reopened UI busy state`,
  )
}

let canCreate = true
let packCalls = 0
let packInput = null
let packFailure = null
let printRecoveryCalls = 0
let printRecoveryInput = null
let printRecoveryFailure = null
let printRecoveryReplayed = false
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
    '@/lib/persistence/operationOneOffShipping': {
      recoverOperationsOneOffLabelPrintInPostgres: async (input) => {
        printRecoveryCalls += 1
        if (printRecoveryFailure) throw printRecoveryFailure
        printRecoveryInput = input
        return { ...exactPrintResult, replayed: printRecoveryReplayed }
      },
    },
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

packFailure = null
const printRequestBody = {
  action: 'recover-label-print',
  expectedRecoveryAction: 'enqueue',
  orderGlobalId: printOrderGlobalId,
  expectedRowVersion: 7,
  packageGlobalId: printPackageGlobalId,
  labelGlobalId: printLabelGlobalId,
  expectedPrintJobGlobalId: null,
  expectedPrintJobStatus: null,
  expectedPrintArtifactGlobalId: null,
  expectedPrintAttempts: null,
  expectedPrintMaxAttempts: null,
  expectedLatestAttemptSequenceNumber: null,
  expectedLatestErrorCode: null,
  reason: 'Queue the exact immutable label after printer setup',
}
const printRequest = {
  headers: {
    get: (name) => name === 'idempotency-key'
      ? retainedPrint.key
      : null,
  },
  text: async () => JSON.stringify(printRequestBody),
}
const allowedPrint = await route.POST(printRequest)
assert.equal(allowedPrint.status, 201)
assert.equal(printRecoveryCalls, 1)
assert.equal(printRecoveryInput.organizationId, '11111111-1111-4111-8111-111111111111')
assert.equal(printRecoveryInput.actorEmail, 'shipping-only@example.test')
assert.equal(printRecoveryInput.idempotencyKey, retainedPrint.key)
assert.equal(printRecoveryInput.expectedPrintJobGlobalId, null)
assert.equal(printRecoveryInput.expectedRecoveryAction, 'enqueue')
assert.equal(printRecoveryInput.packageGlobalId, printPackageGlobalId)
assert.equal(printRecoveryInput.labelGlobalId, printLabelGlobalId)
assert.equal(printRecoveryInput.expectedPrintJobStatus, null)
assert.equal(printRecoveryInput.expectedPrintArtifactGlobalId, null)
assert.equal(printRecoveryInput.expectedPrintAttempts, null)
assert.equal(printRecoveryInput.expectedPrintMaxAttempts, null)
assert.equal(printRecoveryInput.expectedLatestAttemptSequenceNumber, null)
assert.equal(printRecoveryInput.expectedLatestErrorCode, null)
assert.equal(printRecoveryInput.reason, printRequestBody.reason)
printRecoveryReplayed = true
const replayedPrint = await route.POST(printRequest)
assert.equal(replayedPrint.status, 200)
assert.equal(printRecoveryCalls, 2)
printRecoveryReplayed = false
printRecoveryFailure = new TestPersistenceError(
  'OPERATIONS_PRINT_ROUTE_UNAVAILABLE',
  'No online local-agent printer supports this label',
  409,
)
const noPrinterPrint = await route.POST(printRequest)
assert.equal(noPrinterPrint.status, 409)
assert.equal(noPrinterPrint.payload.code, 'OPERATIONS_PRINT_ROUTE_UNAVAILABLE')
assert.equal(printRecoveryCalls, 3)
printRecoveryFailure = null
canCreate = false
const forbiddenPrint = await route.POST(printRequest)
assert.equal(forbiddenPrint.status, 403)
assert.equal(forbiddenPrint.payload.code, 'SHIPPING_CREATE_REQUIRED')
assert.equal(
  printRecoveryCalls,
  3,
  'Shipping actor without createShipments must cause zero print recovery work',
)
canCreate = true
const invalidPrint = await route.POST({
  ...printRequest,
  text: async () => JSON.stringify({
    ...printRequestBody,
    expectedPrintJobStatus: 'not-a-print-status',
  }),
})
assert.equal(invalidPrint.status, 400)
assert.equal(invalidPrint.payload.code, 'OPERATIONS_ONE_OFF_REQUEST_INVALID')
assert.equal(printRecoveryCalls, 3)
const unsupportedPrint = await route.POST({
  ...printRequest,
  text: async () => JSON.stringify({
    ...printRequestBody,
    preferredPrinterGlobalId: 'gpr9400201',
  }),
})
assert.equal(unsupportedPrint.status, 400)
assert.equal(unsupportedPrint.payload.code, 'OPERATIONS_ONE_OFF_REQUEST_INVALID')
assert.equal(printRecoveryCalls, 3)

console.log('Shipping-only one-off pack API and UI contracts passed.')
