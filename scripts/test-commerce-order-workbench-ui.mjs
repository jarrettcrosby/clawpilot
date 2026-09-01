#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [operations, drawer, imports, intake] = await Promise.all([
  read('app_src/components/operations/OperationsSection.tsx'),
  read('app_src/components/operations/ImportedOrderWorkingCopyDrawer.tsx'),
  read('app_src/components/operations/CommerceImportsPanel.tsx'),
  read('app_src/components/settings/CommerceIntakeWorkflow.tsx'),
])

for (const fragment of [
  'workspace?.importedOrders',
  'visibleImportedOrders.map',
  'label={importedOrderDisplayStatus(order)}',
  'importedOrderFilterStatus(order) === status',
  'chooseImportedOrder(order)',
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
  'validImportedOrderPage',
  'MAX_IMPORTED_ORDER_PAGES',
  '`/api/operations/order-workbench?${workbenchParams.toString()}`',
  'Imported-order pagination did not advance',
  'Loaded ${importedOrders.length} of ${Math.max(',
  'validCanonicalOrderPage',
  'MAX_CANONICAL_ORDER_PAGES',
  '`/api/operations/orders?${orderParams.toString()}`',
  'Order pagination did not advance',
  'Order pagination returned a duplicate order',
  'Loaded ${canonicalOrders.length} of ${Math.max(',
]) {
  assert.ok(operations.includes(fragment), `Operations UI is missing ${fragment}`)
}

assert.ok(
  operations.indexOf('visibleImportedOrders.map')
    < operations.indexOf('workspace?.orders.map'),
  'Imported working copies must appear in the ordinary Orders list',
)

for (const fragment of [
  'const reviewImportedOrders = () => {',
  "setView('orders')",
  "nextUrl.hash = 'operations'",
  "new HashChangeEvent('hashchange'",
  'onReviewOrders={reviewImportedOrders}',
]) {
  assert.ok(
    operations.includes(fragment),
    `Operations UI is missing the single order-review workflow ${fragment}`,
  )
}

for (const fragment of [
  'onReviewOrders: () => void',
  'Review orders',
  'Staged orders are',
  'managed in the Orders workbench.',
  'onReviewOrders={onReviewOrders}',
]) {
  assert.ok(
    imports.includes(fragment),
    `Commerce imports is missing the Orders handoff ${fragment}`,
  )
}

assert.match(
  intake,
  /!onReviewOrders \? \([\s\S]{0,500}Order candidates/u,
  'The legacy candidate tab must be hidden when Operations owns order review',
)
assert.match(
  intake,
  /const reviewOrders = \(\) => \{[\s\S]{0,180}onReviewOrders\(\)/u,
  'Order-review actions must hand off to the Operations Orders workbench',
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
  'Approved pack constraint (optional)',
  'No pack constraint — use cartonization',
  'Unit item — cartonization chooses outbound packaging.',
  'Provider SKU and quantity stay visible',
  'SKU ${line.sku || \'not supplied\'}',
  'Quantity ${line.quantity}',
  'Accept &amp; import',
  'order.providerVersionChanged',
  'Use refreshed provider item',
  'lineRefreshChoices[conflict.lineGlobalId]',
  "field === 'requestedDeliveryAt'",
  'savedDraftComplete',
  'providerOrderStatus(order)',
  'Fulfilled externally',
  'providerTerminal',
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
assert.equal(
  drawer.includes("!line.requiresShipping || draft.packageProfileGlobalId"),
  false,
  'A manual legacy package profile must not be required before cartonization can resolve the mapped product pack',
)

console.log('Commerce order workbench UI contract passed')
