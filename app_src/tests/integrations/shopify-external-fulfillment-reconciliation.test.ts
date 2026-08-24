import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeShopifyExternalFulfillmentEvidence,
  ShopifyExternalFulfillmentEvidenceError,
} from '../../lib/integrations/shopifyExternalFulfillmentEvidence.ts'
import { availableOperationsOrderActions } from '../../lib/operations/domain.ts'

const target = {
  externalOrderId: 'gid://shopify/Order/100',
  orderName: '#6603',
  releasedAt: '2026-08-11T13:00:00.000Z',
  providerLocationId: 'gid://shopify/Location/300',
  lines: [{
    externalLineId: 'gid://shopify/LineItem/200',
    quantity: 1,
  }],
}

function providerOrder() {
  return {
    id: target.externalOrderId,
    name: target.orderName,
    updatedAt: '2026-08-11T13:31:25.000Z',
    cancelledAt: null,
    closedAt: '2026-08-11T13:31:26.000Z',
    displayFulfillmentStatus: 'FULFILLED',
    fulfillable: false,
    lineItems: {
      nodes: [{
        id: target.lines[0].externalLineId,
        currentQuantity: 1,
        unfulfilledQuantity: 0,
        requiresShipping: true,
      }],
      pageInfo: { hasNextPage: false },
    },
    fulfillmentOrders: {
      nodes: [{
        id: 'gid://shopify/FulfillmentOrder/400',
        status: 'CLOSED',
        requestStatus: 'UNSUBMITTED',
        updatedAt: '2026-08-11T13:31:25.000Z',
        assignedLocation: {
          location: { id: target.providerLocationId },
        },
        lineItems: {
          nodes: [{
            lineItem: { id: target.lines[0].externalLineId },
            totalQuantity: 1,
            remainingQuantity: 0,
          }],
          pageInfo: { hasNextPage: false },
        },
      }],
      pageInfo: { hasNextPage: false },
    },
    fulfillments: [{
      id: 'gid://shopify/Fulfillment/500',
      name: '#6603-F1',
      status: 'SUCCESS',
      displayStatus: 'FULFILLED',
      createdAt: '2026-08-11T13:31:25.000Z',
      updatedAt: '2026-08-11T13:31:25.000Z',
      trackingInfo: [{
        company: 'UPS',
        number: '1ZTESTEXTERNAL500',
        url: 'https://www.ups.com/track?tracknum=1ZTESTEXTERNAL500',
      }],
      fulfillmentOrders: {
        nodes: [{
          id: 'gid://shopify/FulfillmentOrder/400',
          assignedLocation: {
            location: { id: target.providerLocationId },
          },
        }],
        pageInfo: { hasNextPage: false },
      },
      fulfillmentLineItems: {
        nodes: [{
          quantity: 1,
          lineItem: { id: target.lines[0].externalLineId },
        }],
        pageInfo: { hasNextPage: false },
      },
    }],
  }
}

function evidenceError(action: () => unknown) {
  assert.throws(action, (error) => (
    error instanceof ShopifyExternalFulfillmentEvidenceError
  ))
}

function fullyRemovedOrderLine() {
  return {
    id: 'gid://shopify/LineItem/201',
    currentQuantity: 0,
    unfulfilledQuantity: 0,
    requiresShipping: false,
  }
}

test('accepts one exact successful Shopify fulfillment after warehouse release', () => {
  const evidence = normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: providerOrder(),
    observedAt: '2026-08-11T13:35:00.000Z',
  })
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/)
  assert.equal(evidence.snapshot.fulfillment.name, '#6603-F1')
  assert.equal(evidence.snapshot.version, 'shopify-external-fulfillment-reconciliation-v2')
  assert.equal(evidence.snapshot.fulfillment.hasTracking, true)
  assert.deepEqual(evidence.snapshot.fulfillment.tracking, [{
    company: 'UPS',
    number: '1ZTESTEXTERNAL500',
    url: 'https://www.ups.com/track?tracknum=1ZTESTEXTERNAL500',
  }])
  assert.deepEqual(
    evidence.snapshot.fulfillmentOrders.map((item) => item.id),
    ['gid://shopify/FulfillmentOrder/400'],
  )
})

test('rejects unfulfilled, wrong-location, and extra-line authority', () => {
  const unfulfilled = providerOrder()
  unfulfilled.displayFulfillmentStatus = 'UNFULFILLED'
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: unfulfilled,
  }))

  const wrongLocation = providerOrder()
  wrongLocation.fulfillmentOrders.nodes[0].assignedLocation.location.id =
    'gid://shopify/Location/301'
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: wrongLocation,
  }))

  const wrongFulfillmentLocation = providerOrder()
  wrongFulfillmentLocation.fulfillments[0]
    .fulfillmentOrders.nodes[0].assignedLocation.location.id =
      'gid://shopify/Location/301'
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: wrongFulfillmentLocation,
  }))

  const extraLine = providerOrder()
  extraLine.lineItems.nodes.push({
    id: 'gid://shopify/LineItem/201',
    currentQuantity: 1,
    unfulfilledQuantity: 0,
    requiresShipping: true,
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: extraLine,
  }))
})

test('ignores only a fully removed unfulfilled non-shipping historical line', () => {
  const replacedLineOrder = providerOrder()
  replacedLineOrder.lineItems.nodes.unshift(fullyRemovedOrderLine())
  replacedLineOrder.fulfillmentOrders.nodes.unshift({
    id: 'gid://shopify/FulfillmentOrder/401',
    status: 'CLOSED',
    requestStatus: 'UNSUBMITTED',
    updatedAt: '2026-08-11T13:31:25.000Z',
    assignedLocation: {
      location: { id: target.providerLocationId },
    },
    lineItems: {
      nodes: [{
        lineItem: { id: fullyRemovedOrderLine().id },
        totalQuantity: 0,
        remainingQuantity: 0,
      }],
      pageInfo: { hasNextPage: false },
    },
  })
  const evidence = normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: replacedLineOrder,
    observedAt: '2026-08-11T13:35:00.000Z',
  })
  assert.deepEqual(evidence.snapshot.fulfillment.lines, target.lines)
  assert.equal(evidence.snapshot.fulfillment.name, '#6603-F1')
})

test('rejects active, shipping, fulfilled, and ambiguous historical lines', () => {
  const activeLineOrder = providerOrder()
  activeLineOrder.lineItems.nodes.unshift({
    ...fullyRemovedOrderLine(),
    currentQuantity: 1,
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: activeLineOrder,
  }))

  const unfulfilledLineOrder = providerOrder()
  unfulfilledLineOrder.lineItems.nodes.unshift({
    ...fullyRemovedOrderLine(),
    unfulfilledQuantity: 1,
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: unfulfilledLineOrder,
  }))

  const shippingLineOrder = providerOrder()
  shippingLineOrder.lineItems.nodes.unshift({
    ...fullyRemovedOrderLine(),
    requiresShipping: true,
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: shippingLineOrder,
  }))

  const fulfilledLineOrder = providerOrder()
  fulfilledLineOrder.lineItems.nodes.unshift(fullyRemovedOrderLine())
  fulfilledLineOrder.fulfillments.push({
    id: 'gid://shopify/Fulfillment/501',
    name: '#6603-F2',
    status: 'CANCELLED',
    displayStatus: 'CANCELLED',
    createdAt: '2026-08-11T13:31:25.000Z',
    updatedAt: '2026-08-11T13:31:25.000Z',
    trackingInfo: [],
    fulfillmentOrders: {
      nodes: [],
      pageInfo: { hasNextPage: false },
    },
    fulfillmentLineItems: {
      nodes: [{
        quantity: 1,
        lineItem: { id: fullyRemovedOrderLine().id },
      }],
      pageInfo: { hasNextPage: false },
    },
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: fulfilledLineOrder,
  }))

  const ambiguousLineOrder = providerOrder()
  ambiguousLineOrder.lineItems.nodes.unshift({
    ...fullyRemovedOrderLine(),
    requiresShipping: 'false' as unknown as boolean,
  })
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: ambiguousLineOrder,
  }))

  const changedTargetLineOrder = providerOrder()
  changedTargetLineOrder.lineItems.nodes[0] = fullyRemovedOrderLine()
  changedTargetLineOrder.lineItems.nodes[0].id = target.lines[0].externalLineId
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: changedTargetLineOrder,
  }))
})

test('rejects non-numeric zero-like historical line quantities', () => {
  for (const ambiguousValue of [null, false, '', '0']) {
    const ambiguousCurrent = providerOrder()
    ambiguousCurrent.lineItems.nodes.unshift({
      ...fullyRemovedOrderLine(),
      currentQuantity: ambiguousValue as unknown as number,
    })
    evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
      target,
      providerOrder: ambiguousCurrent,
    }))

    const ambiguousUnfulfilled = providerOrder()
    ambiguousUnfulfilled.lineItems.nodes.unshift({
      ...fullyRemovedOrderLine(),
      unfulfilledQuantity: ambiguousValue as unknown as number,
    })
    evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
      target,
      providerOrder: ambiguousUnfulfilled,
    }))
  }
})

test('rejects historical lines with fulfillment-order demand', () => {
  for (const quantities of [
    { totalQuantity: 1, remainingQuantity: 0 },
    { totalQuantity: 0, remainingQuantity: 1 },
  ]) {
    const order = providerOrder()
    order.lineItems.nodes.unshift(fullyRemovedOrderLine())
    order.fulfillmentOrders.nodes.unshift({
      id: 'gid://shopify/FulfillmentOrder/401',
      status: 'CLOSED',
      requestStatus: 'UNSUBMITTED',
      updatedAt: '2026-08-11T13:31:25.000Z',
      assignedLocation: {
        location: { id: target.providerLocationId },
      },
      lineItems: {
        nodes: [{
          lineItem: { id: fullyRemovedOrderLine().id },
          ...quantities,
        }],
        pageInfo: { hasNextPage: false },
      },
    })
    evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
      target,
      providerOrder: order,
    }))
  }
})

test('rejects a fulfillment that predates the released warehouse work', () => {
  const stale = providerOrder()
  stale.fulfillments[0].createdAt = '2026-08-11T12:59:59.000Z'
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: stale,
  }))
})

test('rejects malformed and unbounded external tracking evidence', () => {
  const malformed = providerOrder()
  malformed.fulfillments[0].trackingInfo = [{
    company: 'UPS',
    number: '1ZTEST',
    url: 'javascript:alert(1)',
  }]
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: malformed,
  }))

  const unbounded = providerOrder()
  unbounded.fulfillments[0].trackingInfo = Array.from({ length: 11 }, (_, index) => ({
    company: 'UPS',
    number: `1ZTEST${index}`,
    url: `https://www.ups.com/track?tracknum=1ZTEST${index}`,
  }))
  evidenceError(() => normalizeShopifyExternalFulfillmentEvidence({
    target,
    providerOrder: unbounded,
  }))
})

function releasedActions(reconciliationRequired: boolean) {
  return availableOperationsOrderActions({
    status: 'released',
    sourceProvider: 'shopify',
    activationState: 'shadow',
    canExecute: true,
    canManage: true,
    planStatus: 'released',
    waveStatus: 'released',
    lineCount: 1,
    fullyReservedLineCount: 1,
    allocatedLineCount: 1,
    pickTaskCount: 1,
    readyPickTaskCount: 1,
    pickedPickTaskCount: 0,
    packageCount: 1,
    plannedPackageCount: 1,
    packedPackageCount: 0,
    blockingExceptionCount: 0,
    shopifyExternalFulfillmentReconciliationRequired:
      reconciliationRequired,
  })
}

test('provider-commitment conflict replaces pick confirmation with reconciliation', () => {
  const actions = releasedActions(true)
  const picks = actions.find((item) => item.action === 'confirm_picks')
  const reconciliation = actions.find(
    (item) => item.action === 'reconcile_external_fulfillment',
  )
  assert.equal(picks?.enabled, false)
  assert.match(picks?.blockedReason || '', /Reconcile the external fulfillment/)
  assert.equal(reconciliation?.enabled, true)
})

test('normal released Shopify order keeps pick confirmation enabled', () => {
  const actions = releasedActions(false)
  assert.equal(
    actions.find((item) => item.action === 'confirm_picks')?.enabled,
    true,
  )
  assert.equal(
    actions.find(
      (item) => item.action === 'reconcile_external_fulfillment',
    )?.enabled,
    false,
  )
})

test('external fulfillment reconciliation requires manage permission', () => {
  const actions = availableOperationsOrderActions({
    status: 'released',
    sourceProvider: 'shopify',
    activationState: 'shadow',
    canExecute: true,
    canManage: false,
    planStatus: 'released',
    waveStatus: 'released',
    lineCount: 1,
    fullyReservedLineCount: 1,
    allocatedLineCount: 1,
    pickTaskCount: 1,
    readyPickTaskCount: 1,
    pickedPickTaskCount: 0,
    packageCount: 1,
    plannedPackageCount: 1,
    packedPackageCount: 0,
    blockingExceptionCount: 0,
    shopifyExternalFulfillmentReconciliationRequired: true,
  })
  const reconciliation = actions.find(
    (item) => item.action === 'reconcile_external_fulfillment',
  )
  assert.equal(reconciliation?.enabled, false)
  assert.match(reconciliation?.blockedReason || '', /manage permission/)
})
