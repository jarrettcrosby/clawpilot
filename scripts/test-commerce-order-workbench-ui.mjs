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
  'orderPageRows',
  'visibleOrderRows.map',
  'label={importedOrderDisplayStatus(order)}',
  'importedOrderMoney(order)',
  'operationsOrderRowNeedsAttention(row)',
  'Filter orders by status',
  'Filter orders by sales channel',
  'Filter orders by last activity',
  'Filter orders by tracking state',
  'Sort operations orders',
  'Orders per page',
  'showPreviousOrderPage',
  'showNextOrderPage',
  'orderPageNavigationRollback.current',
  "params.set('includeOrderSummaries', 'false')",
  'synchronizeImportedOrder(',
  'candidate: detailed?.candidateGlobalId',
  '|| originalCandidateGlobalId',
  'orderPageStart}–${orderPageEnd} of ${orderPage?.total || 0} orders',
  '`/api/operations/orders/unified?${params.toString()}`',
  'pageSize: String(orderPageSize)',
  'if (status) params.set(\'status\', status)',
  'Order pagination returned a duplicate order',
  'Order, customer, SKU, or tracking',
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
  'candidateGlobalId: selected.candidateGlobalId',
  'importedDrawerHistoryIdempotencyKey(selected, now)',
  'workspace?.capabilities.canManage === true',
  'resolution: draft.resolution',
  'resolutionDetailsLoaded',
  "action: 'accept'",
  'pendingImportedOrderAccept.current',
  'await openAcceptedImportedOrder(',
  'lineResolutions: conflictResolution.lineResolutions',
  'Array.isArray(payload.lineConflicts)',
  'saved item matches were preserved',
  'validImportedOrderPage',
  'validCanonicalOrderPage',
  'Latest sales-channel items',
  'canonical-provider-history',
  'Latest sales-channel total',
  'canonical-provider-total',
  'const itemName = line.titleSnapshot',
  'canonical-provider-line-title-',
  'canonical-provider-line-metadata-',
  'Variant ${line.variantTitleSnapshot}',
  'Vendor ${line.vendorSnapshot}',
  'canonical-provider-line-financials-',
  'line.unitPriceMinor !== null && line.unitPriceCurrency',
  'Unit price ${money(line.unitPriceMinor, line.unitPriceCurrency)}',
  'line.subtotalMinor !== null && line.subtotalCurrency',
  'Subtotal ${money(line.subtotalMinor, line.subtotalCurrency)}',
  'line.discountMinor !== null && line.discountCurrency',
  'Discount ${money(line.discountMinor, line.discountCurrency)}',
  'line.taxMinor !== null && line.taxCurrency',
  'Tax ${money(line.taxMinor, line.taxCurrency)}',
  'Ordered {line.orderedQuantity}',
  "' · Current '",
  "' · Fulfilled '",
  "' · Unfulfilled '",
  "' · Returned '",
  "' · Removed '",
  'ClawPilot fulfillment lines',
  'canonical-provider-line-count-',
  'canonical-provider-event-details-',
  'Provider reference ${event.externalSubjectId}',
  'Quantity ${event.quantity}',
  'Amount ${money(String(event.amountMinor), event.currency)}',
  'Sales channel',
  'Current location mapping',
  'validOrderReconciliationScheduleResult',
  'providerHistory.providerWrites === 0',
  'providerHistory.totalEligibleAccounts',
  'providerHistory.scheduledAccounts',
  'providerHistory.alreadyScheduledAccounts',
  'providerHistory.deferredAccounts',
  'providerHistory.newSessions',
  'providerHistory.resumedSessions',
  'providerHistory.newDeferredRefreshes',
  'providerHistory.alreadyDeferredRefreshes',
  'automatically after the current provider poll finishes',
  'successfullyCheckedVisibleCanonicalOrderGlobalIds',
  'Connected-store provider history:',
  'Visible provider history:',
  'Visible canonical status:',
  'Background canonical status:',
  'Order pagination did not advance',
]) {
  assert.ok(operations.includes(fragment), `Operations UI is missing ${fragment}`)
}
assert.match(
  operations,
  /const itemName = line\.titleSnapshot\s*\|\| line\.sku\s*\|\| line\.externalVariantId\s*\|\| line\.externalProductId\s*\|\| line\.externalLineId/u,
  'Canonical provider lines must prefer the sales-channel title and fall back through stable provider identifiers',
)

const refreshOrdersStart = operations.indexOf(
  'const refreshOrders = useCallback(async () => {',
)
const refreshOrdersEnd = operations.indexOf(
  'useEffect(() => {',
  refreshOrdersStart,
)
assert.ok(
  refreshOrdersStart >= 0 && refreshOrdersEnd > refreshOrdersStart,
  'Connected-store refresh orchestration must remain inspectable',
)
const refreshOrders = operations.slice(refreshOrdersStart, refreshOrdersEnd)
const visibleHistoryRequest = refreshOrders.indexOf(
  "fetch('/api/operations/order-history-sync'",
)
const visibleCanonicalStatusRequest = refreshOrders.indexOf(
  'const result = await runOrderStatusSyncBatch(',
)
const backgroundScheduleRequest = refreshOrders.indexOf(
  "'/api/operations/order-reconciliation-schedule'",
)
assert.ok(
  visibleHistoryRequest >= 0
    && visibleCanonicalStatusRequest > visibleHistoryRequest
    && backgroundScheduleRequest > visibleCanonicalStatusRequest,
  'Refresh must finish visible history, then visible canonical status, before background scheduling',
)
assert.match(
  refreshOrders,
  /body: JSON\.stringify\(\{\s*excludeOrderGlobalIds:\s*successfullyCheckedVisibleCanonicalOrderGlobalIds,?\s*\}\)/u,
  'Background scheduling may exclude only successfully checked visible canonical IDs',
)

assert.equal(
  operations.includes('visibleImportedOrders.map'),
  false,
  'Imported and canonical orders must not render as separate list blocks',
)
assert.equal(
  operations.includes('workspace?.orders.map'),
  false,
  'Canonical orders must use the same globally sorted row projection',
)
for (const fragment of [
  'MAX_IMPORTED_ORDER_PAGES',
  '`/api/operations/order-workbench?${workbenchParams.toString()}`',
  '`/api/operations/orders?${orderParams.toString()}`',
  'OPERATIONS_ORDER_SAVED_VIEWS.map',
  'Filter orders by warehouse',
  'refreshImportedShopifyHistoryBatch',
]) {
  assert.equal(
    operations.includes(fragment),
    false,
    `Operations UI must not retain page-local or bulk-loading behavior ${fragment}`,
  )
}

const acceptedDrawerStart = operations.indexOf(
  'const openAcceptedImportedOrder = async',
)
const acceptedDrawerEnd = operations.indexOf(
  'const saveImportedOrderDraft = async',
  acceptedDrawerStart,
)
assert.ok(
  acceptedDrawerStart >= 0 && acceptedDrawerEnd > acceptedDrawerStart,
  'Imported-order acceptance handoff must remain inspectable',
)
assert.equal(
  operations.slice(acceptedDrawerStart, acceptedDrawerEnd).includes("setSearch('')"),
  false,
  'Opening an accepted order must preserve the current Orders query',
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
  'Ordered ${line.orderedQuantity}',
  'Current ${line.currentQuantity}',
  'Fulfilled ${line.fulfilledQuantity}',
  'Remaining ${line.unfulfilledQuantity}',
  'Removed or refunded ${line.cancelledOrRemovedQuantity}',
  'Returned ${line.returnedQuantity}',
  'External fulfillment',
  'Tracking history has not been captured for this order.',
  'trackingEvents.map',
  'fulfillmentEvents.map',
  'adjustmentEvents.map',
  'Accept &amp; import',
  'order.providerVersionChanged',
  'Use refreshed provider item',
  'lineRefreshChoices[conflict.lineGlobalId]',
  "field === 'requestedDeliveryAt'",
  'savedDraftComplete',
  'providerOrderStatus(order)',
  'Fulfilled externally',
  'providerTerminal',
  'editorUnavailable',
  '!order.actionAvailable',
]) {
  assert.ok(drawer.includes(fragment), `Imported order drawer is missing ${fragment}`)
}
assert.match(drawer, />\s*Save\s*<\/Button>/u)
assert.match(
  drawer,
  /onRefresh && canManage && \(/u,
  'Provider refresh must not be offered to view-only users',
)
assert.match(
  drawer,
  /trackingEvents\.length[\s\S]*: order\?\.providerHistory\.observedAt \? \(/u,
  'An absent exact snapshot must keep tracking unknown instead of claiming none was supplied',
)

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
