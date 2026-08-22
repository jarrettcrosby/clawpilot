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
  "candidate: selected.candidateGlobalId",
  'resolution: draft.resolution',
  'resolutionDetailsLoaded',
  "action: 'accept'",
  'pendingImportedOrderAccept.current',
  'await openAcceptedImportedOrder(',
  'lineResolutions: conflictResolution.lineResolutions',
  'Array.isArray(payload.lineConflicts)',
  'saved item matches were preserved',
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
  'Customer and delivery',
  'Requested delivery',
  'ClawPilot product',
  'Unit price',
  'Package profile',
  'Provider SKU and quantity stay visible',
  'SKU ${line.sku || \'not supplied\'}',
  'Quantity ${line.quantity}',
  'Accept &amp; import',
  'order.providerVersionChanged',
  'Use refreshed provider item',
  'lineRefreshChoices[conflict.lineGlobalId]',
  "field === 'requestedDeliveryAt'",
  'savedDraftComplete',
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
  /Create customer|Create product|placeholder customer|placeholder product/iu.test(drawer),
  false,
  'The ordinary workbench must only bind real existing catalog identities',
)
const saveActionStart = drawer.indexOf(': <SaveRounded />}')
const saveActionEnd = drawer.indexOf('</Button>', saveActionStart)
assert.ok(saveActionStart >= 0 && saveActionEnd > saveActionStart)
assert.equal(
  drawer.slice(saveActionStart, saveActionEnd).includes('draftReadiness'),
  false,
  'Incomplete addresses must remain saveable',
)
assert.ok(
  drawer.includes("order?.shipTo.syncStatus === 'local_only' ? 'Saved locally'"),
  'The drawer must report local-save state plainly',
)
const acceptActionStart = drawer.indexOf(': <MoveToInboxRounded />}')
const acceptActionEnd = drawer.indexOf('</Button>', acceptActionStart)
assert.ok(acceptActionStart >= 0 && acceptActionEnd > acceptActionStart)
const acceptAction = drawer.slice(acceptActionStart, acceptActionEnd)
assert.ok(
  acceptAction.includes('!savedDraftComplete'),
  'Accept must use the actual saved draft completeness',
)
assert.equal(
  acceptAction.includes('order.needsInfo'),
  false,
  'Stale provider blockers must not disable an otherwise complete saved draft',
)
assert.ok(
  drawer.includes("shippingRequired && draftReadiness !== 'carrier_ready'"),
  'Only orders with an actual shippable line may require a carrier-ready address before Accept',
)
assert.ok(
  drawer.includes("!line.requiresShipping || draft.packageProfileGlobalId"),
  'A non-shipping line must not require a fabricated package profile',
)

console.log('Commerce order workbench UI contract passed')
