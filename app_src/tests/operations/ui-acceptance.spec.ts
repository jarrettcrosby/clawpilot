import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { OperationsExceptionStatus } from '@/lib/operations/types'
import type {
  OperationsRegressionPackRateStage,
  OperationsRegressionRun,
  OperationsRegressionWalkthrough,
} from '@/lib/operations/regressionReplay'

test.use({ hasTouch: true })

const authPassword = process.env.UI_AUTH_PASSWORD
const operatorSecret = process.env.UI_OPERATOR_SECRET

async function gotoApp(page: Page, path: string) {
  if (authPassword && operatorSecret) {
    const response = await page.request.post('/api/auth/login', {
      data: { password: authPassword },
      headers: { 'x-clawpilot-operator-secret': operatorSecret },
      failOnStatusCode: false,
    })
    expect(response.ok()).toBeTruthy()
  }
  await page.goto(path)
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function isFullyVisibleWithin(inner: Locator, outer: Locator) {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()])
  if (!innerBox || !outerBox) return false
  return (
    innerBox.x >= outerBox.x - 1
    && innerBox.x + innerBox.width <= outerBox.x + outerBox.width + 1
    && innerBox.y >= outerBox.y - 1
    && innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1
  )
}

const selectedOrder = {
  id: 'order-id',
  globalId: 'gor1234567',
  orderNumber: 'PROOF-1042',
  customerName: 'Northstar Outfitters',
  customerGlobalId: 'ga1234567',
  sourceProvider: 'mock-commerce',
  status: 'planned',
  rowVersion: 0,
  planStatus: 'planned',
  waveStatus: null,
  pickTaskCount: 0,
  readyPickTaskCount: 0,
  pickedPickTaskCount: 0,
  packageCount: 1,
  plannedPackageCount: 1,
  packedPackageCount: 0,
  availableActions: [
    {
      action: 'release_to_warehouse',
      label: 'Release to warehouse',
      enabled: true,
      blockedReason: null,
    },
    {
      action: 'confirm_picks',
      label: 'Confirm all picks',
      enabled: false,
      blockedReason: 'Release the order to warehouse execution before confirming picks.',
    },
  ],
  warehouseName: 'Primary Warehouse',
  promisedDeliveryAt: '2026-08-04T21:00:00.000Z',
  lineCount: 2,
  exceptionCount: 1,
  expectedCostMinor: '1066',
  expectedRevenueMinor: '1335',
  expectedMarginMinor: '269',
  trackingNumber: null,
  updatedAt: '2026-07-22T18:00:00.000Z',
  externalOrderId: 'mock-1042',
  currency: 'USD',
  shipTo: {
    name: 'Northstar Receiving',
    line1: '200 Customer Lane',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    country: 'US',
  },
  lines: [{
    globalId: 'gol1234567',
    productGlobalId: 'gp1234567',
    productName: 'Trail Pack',
    channelSku: 'TRAIL-001',
    quantity: 2,
    reservedQuantity: 2,
    pickStatus: null,
  }, {
    globalId: 'gol7654321',
    productGlobalId: 'gp7654321',
    productName: 'Camp Lantern',
    channelSku: 'LANTERN-002',
    quantity: 1,
    reservedQuantity: 1,
    pickStatus: null,
  }],
  packages: [{
    globalId: 'gpk1234567',
    packageNumber: 1,
    weightGrams: 1400,
    dimensionsMm: { length: 300, width: 220, height: 160 },
    status: 'planned',
  }],
  rates: [{
    globalId: 'grt1234567',
    carrier: 'UPS',
    serviceName: 'UPS Ground',
    internalCostMinor: '1038',
    customerChargeMinor: '1194',
    estimatedDeliveryAt: '2026-08-03T21:00:00.000Z',
    meetsPromise: true,
    selected: true,
  }],
  billableEvents: [{ globalId: 'gbe1234567', type: 'fixed_order_fee', amountMinor: '350', status: 'unbilled' }],
  events: [{ globalId: 'gev1234567', type: 'order.planned', occurredAt: '2026-07-22T18:00:00.000Z', payload: {} }],
}

const exception = {
  id: 'exception-id',
  globalId: 'gex1234567',
  exceptionType: 'inventory_shortage',
  severity: 'medium',
  status: 'open' as OperationsExceptionStatus,
  title: 'Inventory reservation is short',
  orderId: selectedOrder.id,
  orderGlobalId: selectedOrder.globalId,
  orderNumber: selectedOrder.orderNumber,
  customerGlobalId: selectedOrder.customerGlobalId,
  customerName: selectedOrder.customerName,
  assignedTo: null,
  createdAt: '2026-07-22T18:05:00.000Z',
  updatedAt: '2026-07-22T18:05:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  details: {
    recommendedAction: 'Replenish or move the line to another warehouse.',
    evidence: { requested: 2, available: 1 },
  },
}

type OrderLifecycle = 'planned' | 'released' | 'picking'

function workspace(exceptionStatus: OperationsExceptionStatus = 'open', lifecycle: OrderLifecycle = 'planned') {
  const currentException = {
    ...exception,
    status: exceptionStatus,
    updatedAt: exceptionStatus === 'open' ? exception.updatedAt : '2026-07-22T18:10:00.000Z',
  }
  const releasedOrder = {
    ...selectedOrder,
    status: 'released',
    rowVersion: 1,
    planStatus: 'released',
    waveStatus: 'released',
    pickTaskCount: 2,
    readyPickTaskCount: 2,
    availableActions: [
      {
        action: 'release_to_warehouse',
        label: 'Release to warehouse',
        enabled: false,
        blockedReason: 'This order is already released to warehouse execution.',
      },
      {
        action: 'confirm_picks',
        label: 'Confirm all picks',
        enabled: true,
        blockedReason: null,
      },
    ],
    lines: selectedOrder.lines.map((line) => ({ ...line, pickStatus: 'ready' })),
    events: [
      ...selectedOrder.events,
      { globalId: 'gev7654321', type: 'wave.released', occurredAt: '2026-07-22T18:10:00.000Z', payload: {} },
    ],
  }
  const currentOrder = lifecycle === 'picking' ? {
    ...releasedOrder,
    status: 'picking',
    rowVersion: 2,
    waveStatus: 'completed',
    readyPickTaskCount: 0,
    pickedPickTaskCount: 2,
    availableActions: [
      ...releasedOrder.availableActions.slice(0, 1),
      {
        action: 'confirm_picks',
        label: 'Confirm all picks',
        enabled: false,
        blockedReason: 'Every pick on this wave is already confirmed.',
      },
      {
        action: 'verify_pack',
        label: 'Verify packages',
        enabled: true,
        blockedReason: null,
      },
    ],
    lines: selectedOrder.lines.map((line) => ({ ...line, pickStatus: 'picked' })),
    events: [
      ...releasedOrder.events,
      { globalId: 'gev2345678', type: 'pick.completed', occurredAt: '2026-07-22T18:15:00.000Z', payload: {} },
    ],
  } : lifecycle === 'released' ? releasedOrder : selectedOrder
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    configured: true,
    capabilities: { canView: true, canManage: true, canExecute: true, canActivate: true },
    dataPipeline: { id: 'pipeline-id', name: 'CRM pipeline' },
    activation: {
      state: 'shadow',
      revision: 1,
      reason: 'Acceptance validation',
      updatedAt: '2026-07-22T18:00:00.000Z',
    },
    summary: {
      openOrders: 1,
      exceptions: exceptionStatus === 'open' || exceptionStatus === 'acknowledged' ? 1 : 0,
      dueSoon: 0,
      shippedToday: 0,
      reservedUnits: 3,
      availableUnits: 10,
      unbilledMinor: '1335',
    },
    orders: [currentOrder],
    selectedOrder: currentOrder,
    exceptions: [currentException],
    warehouses: [{ id: 'warehouse-id', globalId: 'gwh1234567', name: 'Primary Warehouse' }],
    catalog: {
      customers: [{ id: 'customer-id', globalId: 'ga1234567', name: 'Northstar Outfitters' }],
      products: [
        { id: 'product-id', globalId: 'gp1234567', name: 'Trail Pack', sku: 'TRAIL-001' },
        { id: 'product-id-2', globalId: 'gp7654321', name: 'Camp Lantern', sku: 'LANTERN-002' },
      ],
    },
    generatedAt: '2026-07-22T18:00:00.000Z',
  }
}

async function installOperationsRoutes(page: Page) {
  let exceptionStatus: OperationsExceptionStatus = 'open'
  let lifecycle: OrderLifecycle = 'planned'
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as {
        action?: string
        proof?: {
          customerGlobalId?: string
          lines?: Array<{ productGlobalId: string; quantity: number; openingQuantity: number }>
          executionMode?: string
        }
        orderGlobalId?: string
        expectedRowVersion?: number
        reason?: string
        exceptionGlobalId?: string
        status?: OperationsExceptionStatus
      }
      if (request.action === 'update-exception') {
        expect(request.exceptionGlobalId).toBe(exception.globalId)
        expect(request.status).toBe('acknowledged')
        exceptionStatus = request.status || exceptionStatus
        return route.fulfill({
          status: 200,
          json: { ok: true, result: { exception: workspace(exceptionStatus).exceptions[0] } },
        })
      }
      if (request.action === 'release-order') {
        expect(route.request().headers()['idempotency-key']).toMatch(/^operations-release:gor1234567:/)
        expect(request.orderGlobalId).toBe(selectedOrder.globalId)
        expect(request.expectedRowVersion).toBe(0)
        expect(request.reason).toBe('Release the reviewed plan to warehouse execution')
        lifecycle = 'released'
        return route.fulfill({
          status: 200,
          json: {
            ok: true,
            result: {
              orderGlobalId: selectedOrder.globalId,
              orderStatus: 'released',
              rowVersion: 1,
              replayed: false,
            },
          },
        })
      }
      if (request.action === 'confirm-picks') {
        expect(route.request().headers()['idempotency-key']).toMatch(/^operations-picks:gor1234567:/)
        expect(request.orderGlobalId).toBe(selectedOrder.globalId)
        expect(request.expectedRowVersion).toBe(1)
        expect(request.reason).toBe('Confirm all ready pick tasks for the released wave')
        lifecycle = 'picking'
        return route.fulfill({
          status: 200,
          json: {
            ok: true,
            result: {
              orderGlobalId: selectedOrder.globalId,
              orderStatus: 'picking',
              rowVersion: 2,
              replayed: false,
            },
          },
        })
      }
      throw new Error(`Unexpected hosted operations action: ${request.action || 'missing'}`)
    }
    return route.fulfill({ json: { ok: true, operations: workspace(exceptionStatus, lifecycle) } })
  })
}

async function installOperationsNavigationRoute(page: Page) {
  await page.route((url) => url.pathname.startsWith('/api/operations/'), async (route) => {
    await route.fulfill({
      status: 503,
      json: { ok: false, error: 'Not required for Operations tab navigation acceptance' },
    })
  })
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        operations: {
          ...workspace(),
          selectedOrder: null,
          shipping: { sandboxCarrierAccounts: [] },
        },
      },
    })
  })
}

const replayPackages: OperationsRegressionPackRateStage['packages'] = [
  {
    packageKey: 'historical-order:package:1',
    sequence: 1,
    materialCode: 'AG12V2',
    materialName: 'AG12V2 carton',
    dimensionsMm: { length: 279, width: 229, height: 178 },
    contentWeightGrams: 4536,
    tareWeightGrams: 340,
    grossWeightGrams: 4876,
    allocations: [{
      lineKey: 'line-apple-crisp',
      productKey: 'gp1234567',
      title: 'Apple Crisp 6 oz bag',
      quantity: 12,
    }],
  },
  {
    packageKey: 'historical-order:package:2',
    sequence: 2,
    materialCode: 'CARTON-2OZ',
    materialName: 'Carton 2 oz box',
    dimensionsMm: { length: 356, width: 279, height: 203 },
    contentWeightGrams: 3062,
    tareWeightGrams: 410,
    grossWeightGrams: 3472,
    allocations: [{
      lineKey: 'line-kringle',
      productKey: 'gp7654321',
      title: 'Apple Crisp Kringle 2 oz bag',
      quantity: 36,
    }],
  },
]

function replayRateStage(
  purpose: OperationsRegressionPackRateStage['purpose'],
): OperationsRegressionPackRateStage {
  const checkout = purpose === 'checkout_quote'
  const rates: OperationsRegressionPackRateStage['rateChoices'] = [
    {
      provider: 'ups_rest',
      serviceCode: '03',
      serviceName: 'UPS Ground',
      carrierCostMinor: checkout ? 1840 : 1995,
      currency: 'USD',
      selected: true,
      recordedFactVersion: `recorded-${purpose}-ups`,
    },
    {
      provider: 'fedex_rest',
      serviceCode: 'FEDEX_GROUND',
      serviceName: 'FedEx Ground',
      carrierCostMinor: checkout ? 1925 : 2070,
      currency: 'USD',
      selected: false,
      recordedFactVersion: `recorded-${purpose}-fedex`,
    },
  ]
  return {
    kind: 'pack_rate',
    status: 'passed',
    runGlobalId: checkout ? 'grr-checkout-001' : 'grr-fulfillment-001',
    purpose,
    packageCount: 2,
    packages: replayPackages,
    rateChoices: rates,
    selectedRate: rates[0],
    selectedCarrierCostMinor: rates[0].carrierCostMinor,
    checkoutShippingChargeMinor: 2350,
    estimatedShippingVarianceMinor: checkout ? 510 : 355,
    pricingSemanticsVersion: 2,
    billingReconciliationStatus: 'pending_carrier_invoice',
    currency: 'USD',
    inputHash: `input-${purpose}`,
    resultHash: `result-${purpose}`,
    expiresAt: checkout ? '2026-07-28T18:15:00.000Z' : null,
  }
}

const blockedReplayRun: OperationsRegressionRun = {
  globalId: 'grr-blocked-001',
  checkoutRunGlobalId: 'grr-checkout-001',
  fulfillmentRunGlobalId: 'grr-fulfillment-001',
  replayGroupKey: 'shopify-historical-order-1042',
  scenarioId: 'shopify-two-pass',
  scenarioTitle: 'Shopify two-pass multi-package order',
  status: 'succeeded',
  replayed: false,
  createdAt: '2026-07-28T18:00:00.000Z',
  noProviderWrites: true,
  noPostagePurchases: true,
  stages: {
    checkoutQuote: replayRateStage('checkout_quote'),
    orderIntake: {
      status: 'passed',
      provider: 'shopify',
      sourceReference: 'Shopify order #1042',
      intakeEvidenceHash: 'intake-shopify-1042',
      customerNeutral: true,
      detail: 'Recorded order facts were retained before CRM customer resolution.',
    },
    customerResolution: {
      status: 'passed',
      requestedMode: 'reuse',
      outcome: 'reused',
      customerGlobalId: 'ga1234567',
      identityKey: 'shopify:customer:123',
      candidateCount: 1,
      detail: 'Reused the existing CRM customer through its Shopify identity.',
    },
    fulfillmentExecution: replayRateStage('fulfillment_execution'),
    variance: {
      status: 'warning',
      changed: true,
      packageCountDelta: 0,
      checkoutCarrierCostMinor: 1840,
      checkoutShippingChargeMinor: 2350,
      fulfillmentCarrierCostMinor: 1995,
      preLabelRateVarianceMinor: 155,
      estimatedShippingVarianceMinor: 355,
      billingReconciliationStatus: 'pending_carrier_invoice',
      currency: 'USD',
      allocationChanged: false,
      materialChanged: false,
      serviceChanged: false,
      causes: ['recorded_rate_changed'],
    },
    labelFinalization: {
      status: 'warning',
      responseSource: null,
      noProviderWrites: true,
      noPostagePurchases: true,
      packages: replayPackages.map((item) => ({
        packageKey: item.packageKey,
        sequence: item.sequence,
        status: 'not_finalized',
        carrier: null,
        serviceCode: null,
        recordedLabelReference: null,
        trackingNumber: null,
      })),
      detail: 'The pre-label state intentionally has no tracking facts.',
    },
    packageDocuments: {
      status: 'warning',
      finalPackingSlipEligible: false,
      preLabelDocumentType: 'pack_work_instruction',
      packages: replayPackages.map((item) => ({
        packageKey: item.packageKey,
        sequence: item.sequence,
        trackingRequired: true,
        trackingNumber: null,
        finalPackingSlipStatus: 'blocked_until_label',
        finalPackingSlipGlobalId: null,
      })),
      detail: 'Final package packing slips are blocked until recorded label finalization.',
    },
  },
}

const finalizedReplayRun: OperationsRegressionRun = {
  ...blockedReplayRun,
  globalId: 'grr-finalized-001',
  replayed: false,
  createdAt: '2026-07-28T18:05:00.000Z',
  stages: {
    ...blockedReplayRun.stages,
    labelFinalization: {
      status: 'passed',
      responseSource: 'recorded_label_response',
      noProviderWrites: true,
      noPostagePurchases: true,
      packages: replayPackages.map((item) => ({
        packageKey: item.packageKey,
        sequence: item.sequence,
        status: 'finalized',
        carrier: 'UPS',
        serviceCode: '03',
        recordedLabelReference: `recorded-label-${item.sequence}`,
        trackingNumber: `1ZRECORDED000000${item.sequence}`,
      })),
      detail: 'Recorded label responses finalized one tracking number per package.',
    },
    packageDocuments: {
      ...blockedReplayRun.stages.packageDocuments,
      status: 'passed',
      finalPackingSlipEligible: true,
      packages: replayPackages.map((item) => ({
        packageKey: item.packageKey,
        sequence: item.sequence,
        trackingRequired: true,
        trackingNumber: `1ZRECORDED000000${item.sequence}`,
        finalPackingSlipStatus: 'ready',
        finalPackingSlipGlobalId: `gpf000000${item.sequence}`,
      })),
      detail: 'Each final packing slip is bound to its exact tracked package.',
    },
  },
}

const faireFulfillmentStage: OperationsRegressionPackRateStage = {
  ...replayRateStage('fulfillment_execution'),
  packageCount: 1,
  packages: [replayPackages[0]],
  checkoutShippingChargeMinor: 1895,
  estimatedShippingVarianceMinor: -100,
  pricingSemanticsVersion: 2,
  billingReconciliationStatus: 'pending_carrier_invoice',
}

const faireReplayRun: OperationsRegressionRun = {
  globalId: 'grr-faire-fulfillment-001',
  checkoutRunGlobalId: 'grr-faire-estimate-001',
  fulfillmentRunGlobalId: 'grr-faire-fulfillment-001',
  replayGroupKey: 'faire-captured-estimate-v1',
  scenarioId: 'faire-captured-estimate',
  scenarioTitle: 'Faire captured checkout estimate',
  status: 'succeeded',
  replayed: false,
  createdAt: '2026-07-28T18:02:00.000Z',
  noProviderWrites: true,
  noPostagePurchases: true,
  stages: {
    checkoutQuote: {
      kind: 'marketplace_estimate',
      status: 'warning',
      runGlobalId: 'grr-faire-estimate-001',
      purpose: 'checkout_quote',
      source: 'faire_checkout_estimate_captured',
      capturedCheckoutShippingChargeMinor: 1895,
      currency: 'USD',
      inputHash: 'input-faire-estimate',
      resultHash: 'result-faire-estimate',
      capturedAt: '2026-07-28T18:02:00.000Z',
      detail: 'Faire supplied no ClawPilot checkout callback. This is the captured marketplace estimate only.',
    },
    orderIntake: {
      status: 'passed',
      provider: 'faire',
      sourceReference: 'Faire order fa-102',
      intakeEvidenceHash: 'intake-faire-102',
      customerNeutral: true,
      detail: 'Recorded Faire order facts were retained before CRM customer resolution.',
    },
    customerResolution: {
      status: 'passed',
      requestedMode: 'new',
      outcome: 'created',
      customerGlobalId: 'ga7654321',
      identityKey: 'faire:customer:102',
      candidateCount: 1,
      detail: 'Created one CRM customer after Faire order intake.',
    },
    fulfillmentExecution: faireFulfillmentStage,
    variance: null,
    labelFinalization: {
      status: 'warning',
      responseSource: null,
      noProviderWrites: true,
      noPostagePurchases: true,
      packages: [{
        packageKey: replayPackages[0].packageKey,
        sequence: replayPackages[0].sequence,
        status: 'not_finalized',
        carrier: null,
        serviceCode: null,
        recordedLabelReference: null,
        trackingNumber: null,
      }],
      detail: 'The successful post-intake state has no recorded label response yet.',
    },
    packageDocuments: {
      status: 'warning',
      finalPackingSlipEligible: false,
      preLabelDocumentType: 'pack_work_instruction',
      packages: [{
        packageKey: replayPackages[0].packageKey,
        sequence: replayPackages[0].sequence,
        trackingRequired: true,
        trackingNumber: null,
        finalPackingSlipStatus: 'blocked_until_label',
        finalPackingSlipGlobalId: null,
      }],
      detail: 'Final packing slip is blocked until package tracking exists.',
    },
  },
}

async function installReplayRoutes(page: Page) {
  let runs = [blockedReplayRun, faireReplayRun]
  const walkthrough = (): OperationsRegressionWalkthrough => ({
    schemaVersion: 'operations-regression-replay-v2',
    generatedAt: '2026-07-28T18:05:00.000Z',
    scenarios: [{
      id: 'shopify-two-pass',
      title: 'Shopify two-pass multi-package order',
      description: 'Replays checkout cartonization, CRM linkage, fulfillment rerating, and package documents.',
      provider: 'shopify',
      checkoutSource: 'live_callback_recorded',
      sourceReference: 'Shopify order #1042',
      customerMode: 'reuse',
      expectedCheckoutPackages: 2,
      expectedFulfillmentPackages: 2,
      lines: [
        {
          productKey: 'gp1234567',
          title: 'Apple Crisp 6 oz bag',
          checkoutQuantity: 12,
          fulfillmentQuantity: 12,
          unitWeightGrams: 170,
        },
        {
          productKey: 'gp7654321',
          title: 'Apple Crisp Kringle 2 oz bag',
          checkoutQuantity: 36,
          fulfillmentQuantity: 36,
          unitWeightGrams: 57,
        },
      ],
      regressionFocus: ['two_pass_variance', 'multi_package', 'tracking_documents'],
    }, {
      id: 'faire-captured-estimate',
      title: 'Faire captured checkout estimate',
      description: 'Preserves Faire checkout evidence without implying a ClawPilot callback.',
      provider: 'faire',
      checkoutSource: 'faire_checkout_estimate_captured',
      sourceReference: 'Faire order fa-102',
      customerMode: 'new',
      expectedCheckoutPackages: 0,
      expectedFulfillmentPackages: 1,
      lines: [{
        productKey: 'gp1234567',
        title: 'Apple Crisp 6 oz bag',
        checkoutQuantity: 12,
        fulfillmentQuantity: 12,
        unitWeightGrams: 170,
      }],
      regressionFocus: ['faire_checkout_semantics'],
    }],
    runs,
  })

  await page.route((url) => url.pathname === '/api/operations/regression-replays', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as {
        action?: string
        scenarioId?: string
        idempotencyKey?: string
      }
      expect(request.action).toBe('run-replay')
      expect(request.scenarioId).toBe('shopify-two-pass')
      expect(request.idempotencyKey).toMatch(/^operations-regression-replay:shopify-two-pass:/)
      expect(route.request().headers()['idempotency-key']).toBe(request.idempotencyKey)
      runs = [finalizedReplayRun, ...runs]
      return route.fulfill({ json: { ok: true, run: finalizedReplayRun } })
    }
    return route.fulfill({ json: { ok: true, walkthrough: walkthrough() } })
  })
}

test('operations workbench renders dense desktop evidence and order drill-in', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await installOperationsRoutes(page)
  await gotoApp(page, '/#operations')

  await expect(page.getByRole('heading', { name: 'Order Workbench' })).toBeVisible()
  await expect(page.getByText('Distributed fulfillment · CRM: CRM pipeline')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Operations orders' })).toBeVisible()
  await expect(page.getByText('Northstar Outfitters').first()).toBeVisible()
  await expect(page.getByText('$13.35').first()).toBeVisible()

  await page.getByRole('row', { name: /PROOF-1042/ }).click()
  await expect(page.getByRole('heading', { name: 'Order PROOF-1042' })).toBeVisible()
  await expect(page.getByText('Trail Pack')).toBeVisible()
  await expect(page.getByText('Camp Lantern')).toBeVisible()
  await expect(page.getByText('UPS · UPS Ground')).toBeVisible()
  await expect(page.getByText('Order Planned')).toBeVisible()
  await expect(page.getByText('Financial plan')).toBeVisible()
  await page.getByRole('button', { name: 'Release to warehouse' }).click()
  await expect(page.getByRole('heading', { name: 'Release order to warehouse' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm release' }).click()
  await expect(page.getByText(/was released to warehouse execution/)).toBeVisible()
  await expect(page.getByText('Picks ready').locator('..').getByText('2 / 2')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm all picks' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm warehouse picks' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm picks', exact: true }).click()
  await expect(page.getByText(/All picks for order gor1234567 were confirmed/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Verify packages' })).toBeVisible()
  await expect(page.getByText('Picks ready').locator('..').getByText('0 / 2')).toBeVisible()
  await expect(page.getByText('Picks complete').locator('..').getByText('2 / 2')).toBeVisible()
  await page.getByRole('button', { name: 'Close order details' }).click()

  await page.getByRole('tab', { name: 'Exceptions (1)' }).click()
  await expect(page.getByRole('table', { name: 'Operations exceptions' })).toBeVisible()
  await page.getByRole('row', { name: /Inventory reservation is short/ }).click()
  await expect(page.getByRole('heading', { name: 'Inventory reservation is short' })).toBeVisible()
  await expect(page.getByText('Replenish or move the line to another warehouse.')).toBeVisible()
  await page.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByRole('tab', { name: 'Exceptions (1)' })).toBeVisible()
})

test('operations tabs support touch navigation without portrait or landscape overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installOperationsNavigationRoute(page)
  await gotoApp(page, '/#operations')

  const navigation = page.getByTestId('operations-tab-navigation')
  const scroller = navigation.locator('.MuiTabs-scroller')
  const left = page.getByRole('button', { name: 'Scroll operations tabs left' })
  const right = page.getByRole('button', { name: 'Scroll operations tabs right' })
  const printing = page.getByRole('tab', { name: 'Printing' })

  await expect(navigation).toBeVisible()
  await expect(left).toBeVisible()
  await expect(left).toBeDisabled()
  await expect(right).toBeVisible()
  await expect(right).toBeEnabled()
  await expect.poll(async () => scroller.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto')
  await expect.poll(async () => scroller.evaluate((element) => getComputedStyle(element).touchAction)).toBe('pan-x')

  const initialScrollLeft = await scroller.evaluate((element) => element.scrollLeft)
  const rightBox = await right.boundingBox()
  if (!rightBox) throw new Error('Operations tabs right scroll control has no layout box')
  await page.touchscreen.tap(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(initialScrollLeft)
  await expect(left).toBeEnabled()
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)

  const rightwardScrollLeft = await scroller.evaluate((element) => element.scrollLeft)
  const leftBox = await left.boundingBox()
  if (!leftBox) throw new Error('Operations tabs left scroll control has no layout box')
  await page.touchscreen.tap(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeLessThan(rightwardScrollLeft)

  const nextRightBox = await right.boundingBox()
  if (!nextRightBox) throw new Error('Operations tabs right scroll control has no layout box')
  await page.touchscreen.tap(
    nextRightBox.x + nextRightBox.width / 2,
    nextRightBox.y + nextRightBox.height / 2,
  )
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)

  const printingBox = await printing.boundingBox()
  if (!printingBox) throw new Error('Printing tab has no layout box')
  await page.touchscreen.tap(
    printingBox.x + printingBox.width / 2,
    printingBox.y + printingBox.height / 2,
  )
  await expect(printing).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.getByRole('button', { name: /Scroll operations tabs (left|right)/ })).toHaveCount(0)
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(right).toBeVisible()
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

test('operations mobile workflow has no page overflow and omits hosted proof generation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installOperationsRoutes(page)
  await gotoApp(page, '/#operations')

  await expect(page.getByTestId('mobile-bottom-navigation')).toBeVisible()
  await expect(page.getByText('Order PROOF-1042')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

  await page.getByRole('tab', { name: 'Exceptions (1)' }).click()
  await page.getByRole('button', { name: /Inventory reservation is short/ }).click()
  await expect(page.getByRole('heading', { name: 'Inventory reservation is short' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Acknowledge' })).toBeVisible()
  await page.getByRole('button', { name: 'Close exception details' }).click()
  await page.getByRole('tab', { name: 'Orders (1)' }).click()

  await expect(page.getByRole('button', { name: 'Prepare order' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open operations guide' }).click()
  await expect(page.getByText(/Deterministic mock adapters remain isolated to automated tests/)).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: /PROOF-1042/ }).click()
  await expect(page.getByRole('heading', { name: 'Order PROOF-1042' })).toBeVisible()
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

test('pack and rate replay runs, persists, and reloads two-pass package evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  await installOperationsNavigationRoute(page)
  await installReplayRoutes(page)
  await gotoApp(page, '/#operations/replays')

  await expect(page.getByRole('heading', { name: 'Pack & rate replay' })).toBeVisible()
  await expect(page.getByText('Development-only, non-postage replay')).toBeVisible()
  await expect(page.getByText(/does not call Shopify, Faire, UPS, or FedEx/)).toBeVisible()

  const scenario = page.getByRole('combobox', { name: 'Historical replay scenario' })
  await scenario.click()
  await page.getByRole('option', { name: /Faire captured checkout estimate/ }).click()
  await expect(page.getByText(/Faire does not call ClawPilot during checkout/)).toBeVisible()

  await page.getByRole('row', { name: /grr-blocked-001/ }).click()
  await expect(scenario).toContainText('Shopify two-pass multi-package order')
  await expect(page.getByText(/Faire does not call ClawPilot during checkout/)).toHaveCount(0)
  await expect(page.getByText(/recorded Shopify live-callback input/)).toBeVisible()

  await expect(
    page.getByRole('table', { name: 'Checkout Quote recorded carrier rates' }),
  ).toContainText('UPS Ground')
  await expect(
    page.getByRole('table', { name: 'Checkout Quote recorded carrier rates' }),
  ).toContainText('FedEx Ground')
  await expect(
    page.getByRole('table', { name: 'Fulfillment Execution recorded carrier rates' }),
  ).toContainText('UPS Ground')
  await expect(page.getByText('Blocked Until Label').first()).toBeVisible()
  await expect(
    page.getByText('Customer checkout shipping charge').first(),
  ).toBeVisible()
  await expect(page.getByText('Pre-label carrier estimate')).toBeVisible()
  await expect(page.getByText(
    /selected for 2 packages, but recorded label finalization has not proven every package used it/,
  )).toBeVisible()

  await page.getByRole('button', { name: 'Run replay' }).click()
  await expect(page.getByText(/completed and its evidence was persisted/)).toBeVisible()
  await expect(page.getByText('1ZRECORDED0000001', { exact: true })).toBeVisible()
  await expect(page.getByText('1ZRECORDED0000002', { exact: true })).toBeVisible()
  await expect(page.getByText('Final packing slip ready')).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(2)
  await expect(page.getByRole('row', { name: /grr-finalized-001/ })).toBeVisible()
  await expect(page.getByText(
    'Recorded labels prove UPS Ground was applied to all 2 packages.',
  )).toBeVisible()

  await page.getByRole('button', { name: 'Reload results' }).click()
  await expect(page.getByText('1ZRECORDED0000001', { exact: true })).toBeVisible()
  await expect(page.getByText('Final packing slip ready')).toHaveCount(2)
})

test('Faire replay shows only the marketplace estimate before post-intake rating', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  await installOperationsNavigationRoute(page)
  await installReplayRoutes(page)
  await gotoApp(page, '/#operations/replays')

  await page.getByRole('row', { name: /grr-faire-fulfillment-001/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Marketplace checkout estimate' }),
  ).toBeVisible()
  await expect(
    page.getByText('Captured marketplace estimate', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('$18.95').first()).toBeVisible()
  await expect(page.getByText('ClawPilot checkout packages and rates')).toBeVisible()
  await expect(page.getByText('Not run', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('table', { name: 'Checkout Quote recorded carrier rates' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('table', { name: 'Fulfillment Execution recorded carrier rates' }),
  ).toContainText('UPS Ground')
  await expect(
    page.getByRole('table', { name: 'Fulfillment Execution recorded carrier rates' }),
  ).toContainText('FedEx Ground')
  await expect(
    page.getByRole('heading', {
      name: 'Marketplace estimate vs post-intake fulfillment',
    }),
  ).toBeVisible()
  await expect(page.getByText(/no checkout carrier-cost or package-plan baseline/)).toBeVisible()
})
