#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [operations, drawer] = await Promise.all([
  read('app_src/components/operations/OperationsSection.tsx'),
  read('app_src/components/operations/ImportedOrderWorkingCopyDrawer.tsx'),
])

for (const fragment of [
  'workspace?.importedOrders',
  'visibleImportedOrders.map',
  "label={order.needsInfo ? 'Needs info' : 'Imported'}",
  'chooseImportedOrder(order)',
  "!status || status === 'imported'",
  '<ImportedOrderWorkingCopyDrawer',
  "fetch('/api/operations/order-workbench'",
  "'Idempotency-Key': pending.idempotencyKey",
  'expectedRowVersion: pending.expectedRowVersion',
  'crypto.randomUUID()',
  'payload.result.canonicalOrderGlobalId',
  'await loadWorkspace(canonicalOrderGlobalId)',
  'setImportedDrawerOpen(false)',
  'setDrawerOpen(true)',
]) {
  assert.ok(operations.includes(fragment), `Operations UI is missing ${fragment}`)
}

assert.ok(
  operations.indexOf('visibleImportedOrders.map')
    < operations.indexOf('workspace?.orders.map'),
  'Imported working copies must appear in the ordinary Orders list',
)

for (const fragment of [
  'Recipient name',
  'Apartment, suite, etc.',
  'State / province',
  'Postal code',
  'Country code',
  'ClawPilot shipment address',
  'Ship-to needed for rates',
  'Ship-to incomplete for rates',
  'Ready for rates',
]) {
  assert.ok(drawer.includes(fragment), `Imported order drawer is missing ${fragment}`)
}
assert.match(drawer, />\s*Save\s*<\/Button>/u)

assert.equal(
  /confirmationStatement|reasonValue|canActivate|canExecute/u.test(drawer),
  false,
  'Ordinary order editing must not expose execution ceremony',
)
assert.equal(
  /disabled=\{[^}]*draftReadiness/u.test(drawer),
  false,
  'Incomplete addresses must remain saveable',
)
assert.ok(
  drawer.includes("order?.shipTo.syncStatus === 'local_only' ? 'Saved locally'"),
  'The drawer must report local-save state plainly',
)

console.log('Commerce order workbench UI contract passed')
