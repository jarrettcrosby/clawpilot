import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type {
  OperationsExceptionStatus,
  OperationsImportedOrderWorkingCopy,
} from '@/lib/operations/types'
import type {
  OperationsRegressionPackRateStage,
  OperationsRegressionRun,
  OperationsRegressionWalkthrough,
} from '@/lib/operations/regressionReplay'
import { SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION } from '@/lib/operations/shopifyTestStoreCanonicalE2e'

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
  shipmentShipTo: {
    orderGlobalId: 'gor1234567',
    orderRowVersion: 0,
    rowVersion: 0,
    value: {
      name: 'Northstar Receiving',
      line1: '200 Customer Lane',
      line2: null,
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    },
    sourceValue: {
      name: 'Northstar Receiving',
      line1: '200 Customer Lane',
      line2: null,
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    },
    readiness: 'carrier_ready',
    issues: [],
    provenance: 'source',
    sourceVersionChanged: false,
    rerateRequired: false,
    editable: false,
    editBlockedReason: 'Address is sealed after planning.',
    providerWrites: 0,
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
    capabilities: {
      canView: true,
      canManage: true,
      canExecute: true,
      canActivate: true,
      canVerifyPhysicalOutput: true,
    },
    dataPipeline: { id: 'pipeline-id', name: 'CRM pipeline' },
    activation: {
      state: 'shadow',
      revision: 1,
      reason: 'Acceptance validation',
      updatedAt: '2026-07-22T18:00:00.000Z',
    },
    storeSync: [{
      accountGlobalId: 'gia9286799',
      provider: 'shopify',
      environment: 'sandbox',
      displayName: 'Pro Bakery Bites',
      accountStatus: 'active',
      desiredState: 'running',
      effectiveState: 'running',
      effectiveReason: 'STORE_SYNC_EXPLICIT_RUNNING',
      effectiveReasonLabel: 'Running by an explicit Store sync choice.',
      explicitChoice: true,
      revision: 2,
      reason: 'Acceptance validation',
      updatedAt: '2026-07-22T18:00:00.000Z',
    }],
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
    importedOrders: [],
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

async function installOrderLabelPrintRoutes(
  page: Page,
  options: {
    initialFailedJob?: boolean
    canVerifyPhysicalOutput?: boolean
  } = {},
) {
  const requests: Array<{
    body: Record<string, unknown>
    idempotencyKey: string
  }> = []
  let labelPrintJobs: Array<{
    globalId: string
    sourceLabelGlobalId: string
    sourceArtifactGlobalId: string
    status: 'queued' | 'delivered' | 'failed'
    reprintOfJobGlobalId: string | null
    createdAt: string
    deliveredAt: string | null
    deliveredAttemptId: string | null
    deliveredAttemptSequenceNumber: number | null
    physicalOutputAttestation: {
      deliveredAt: string
      verifiedAt: string
      verifiedBy: string
      reason: string
    } | null
    lastError: string | null
  }> = options.initialFailedJob ? [{
    globalId: 'gpj7654321',
    sourceLabelGlobalId: 'glb7654321',
    sourceArtifactGlobalId: 'gpf7654321',
    status: 'failed',
    reprintOfJobGlobalId: null,
    createdAt: '2026-08-22T16:14:00.000Z',
    deliveredAt: null,
    deliveredAttemptId: null,
    deliveredAttemptSequenceNumber: null,
    physicalOutputAttestation: null,
    lastError: 'PRINTER_UNAVAILABLE',
  }] : []
  const sourceLabelGlobalId = 'glb7654321'
  const originalPrintJobGlobalId = 'gpj7654321'
  const reprintJobGlobalId = 'gpj7654322'
  const shippedOrder = () => ({
    ...selectedOrder,
    id: 'shipped-order-id',
    globalId: 'gor7654322',
    orderNumber: '#1004',
    sourceProvider: 'mock-commerce',
    externalOrderId: 'mock-1004',
    status: 'shipped',
    rowVersion: 6,
    planStatus: 'fulfilled',
    waveStatus: 'completed',
    warehouseId: 'warehouse-id',
    warehouseName: 'Primary Warehouse',
    packageCount: 1,
    plannedPackageCount: 0,
    packedPackageCount: 1,
    availableActions: [],
    trackingNumber: '1ZXXXXXXXXXXXXXXXX',
    sandboxCommerceE2eAuthorization: null,
    fulfillmentPreparation: null,
    planningPreparation: null,
    labelAttempts: [],
    trackingObservations: [],
    printArtifacts: [],
    commerceExports: [],
    labelPrintJobs,
    packages: [{
      ...selectedOrder.packages[0],
      status: 'shipped',
      contents: [],
      latestLabel: {
        globalId: sourceLabelGlobalId,
        status: 'created',
        carrier: 'UPS',
        serviceCode: '03',
        trackingNumber: '1ZXXXXXXXXXXXXXXXX',
        environment: 'sandbox',
        createAttemptGlobalId: null,
        voidAttemptGlobalId: null,
        createdAt: '2026-08-22T16:12:00.000Z',
        voidedAt: null,
      },
    }],
    shipments: [{
      globalId: 'gsh7654321',
      status: 'confirmed',
      carrier: 'UPS',
      serviceCode: '03',
      trackingNumber: '1ZXXXXXXXXXXXXXXXX',
      quotedCarrierCostMinor: '0',
      oneOffCarrierGroupGlobalId: null,
      shippedAt: '2026-08-22T16:13:00.000Z',
    }],
  })
  const response = () => {
    const base = workspace('resolved')
    const order = shippedOrder()
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        canVerifyPhysicalOutput:
          options.canVerifyPhysicalOutput !== false,
      },
      orders: [order],
      selectedOrder: order,
      exceptions: [],
      summary: {
        ...base.summary,
        openOrders: 0,
        exceptions: 0,
        shippedToday: 1,
      },
    }
  }

  await page.route(
    (url) => url.pathname === '/api/operations/print-jobs',
    async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      const idempotencyKey = route.request().headers()['idempotency-key'] || ''
      requests.push({ body, idempotencyKey })
      if (body.action === 'enqueue-label') {
        labelPrintJobs = [{
          globalId: originalPrintJobGlobalId,
          sourceLabelGlobalId,
          sourceArtifactGlobalId: 'gpf7654321',
          status: 'delivered',
          reprintOfJobGlobalId: null,
          createdAt: '2026-08-22T16:14:00.000Z',
          deliveredAt: '2026-08-22T16:14:01.000Z',
          deliveredAttemptId: '99fdcbe7-a2bf-489c-b82b-93499c171304',
          deliveredAttemptSequenceNumber: 3,
          physicalOutputAttestation: null,
          lastError: null,
        }]
        return route.fulfill({
          json: { ok: true, job: { globalId: originalPrintJobGlobalId } },
        })
      }
      if (body.action === 'retry-job') {
        labelPrintJobs = labelPrintJobs.map((job) => (
          job.globalId === originalPrintJobGlobalId
            ? { ...job, status: 'queued' as const, lastError: null }
            : job
        ))
        return route.fulfill({
          json: { ok: true, job: { globalId: originalPrintJobGlobalId } },
        })
      }
      if (body.action === 'attest-physical-output') {
        labelPrintJobs = labelPrintJobs.map((job) => (
          job.globalId === body.jobGlobalId
            ? {
                ...job,
                physicalOutputAttestation: {
                  deliveredAt: job.deliveredAt!,
                  verifiedAt: '2026-08-22T16:16:00.000Z',
                  verifiedBy: 'owner@example.com',
                  reason: String(body.reason),
                },
              }
            : job
        ))
        return route.fulfill({
          json: { ok: true, job: { globalId: body.jobGlobalId } },
        })
      }
      expect(body.action).toBe('reprint-job')
      labelPrintJobs = [{
        globalId: reprintJobGlobalId,
        sourceLabelGlobalId,
        sourceArtifactGlobalId: 'gpf7654321',
        status: 'delivered',
        reprintOfJobGlobalId: originalPrintJobGlobalId,
        createdAt: '2026-08-22T16:15:00.000Z',
        deliveredAt: '2026-08-22T16:15:01.000Z',
        deliveredAttemptId: 'dfe72f16-0605-43b8-9ea7-a573335f6a55',
        deliveredAttemptSequenceNumber: 1,
        physicalOutputAttestation: null,
        lastError: null,
      }, ...labelPrintJobs]
      return route.fulfill({
        json: { ok: true, job: { globalId: reprintJobGlobalId } },
      })
    },
  )
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    await route.fulfill({ json: { ok: true, operations: response() } })
  })
  return {
    requests,
    sourceLabelGlobalId,
    originalPrintJobGlobalId,
    reprintJobGlobalId,
  }
}

const workbenchCandidateGlobalId = 'gcoc7654321'
const workbenchLatestCandidateGlobalId = 'gcoc7654322'
const workbenchCanonicalOrderGlobalId = 'gor8765432'
const workbenchCustomerGlobalId = 'ga1234567'
const workbenchProductGlobalId = 'gp1234567'
const workbenchLineGlobalId = 'gcol7654321'

const workbenchPartialShipTo = {
  name: 'Northstar Receiving',
  line1: '200 Customer Lane',
  line2: null,
  city: 'New York',
  region: null,
  postalCode: null,
  country: 'US',
}

const workbenchCompleteShipTo = {
  ...workbenchPartialShipTo,
  region: 'NY',
  postalCode: '10001',
}

function importedWorkbenchOrder(
  details: boolean,
): OperationsImportedOrderWorkingCopy {
  return {
    kind: 'imported_working_copy',
    globalId: workbenchCandidateGlobalId,
    candidateGlobalId: workbenchCandidateGlobalId,
    canonicalOrderGlobalId: null,
    integrationAccountGlobalId: 'gia9286799',
    integrationAccountName: 'Pro Bakery Bites',
    provider: 'shopify',
    externalOrderId: 'gid://shopify/Order/7710',
    orderNumber: '#7710',
    status: 'imported',
    needsInfo: true,
    blockerCodes: [
      'customer_resolution_required',
      'delivery_decision_required',
      'product_mapping_required',
      'line_price_required',
      'ship_to_region_required',
      'ship_to_postal_code_required',
    ],
    customerName: 'Northstar Receiving',
    lineCount: 1,
    sourceUpdatedAt: '2026-08-21T18:00:00.000Z',
    candidateRowVersion: 4,
    rowVersion: 0,
    providerVersionChanged: false,
    resolutionDetailsLoaded: details,
    customer: {
      status: 'unresolved',
      resolvedCustomerGlobalId: null,
      selectedCustomerGlobalId: null,
      options: details ? [{
        globalId: workbenchCustomerGlobalId,
        name: 'Northstar Outfitters',
        email: 'buyer@northstar.example',
      }] : [],
    },
    delivery: {
      status: 'not_supplied',
      providerRequestedDeliveryAt: null,
      selectedDeliveryAt: null,
      draftDeliveryAt: null,
    },
    lines: details ? [{
      globalId: workbenchLineGlobalId,
      title: 'Trail Pack retail unit',
      sku: 'TRAIL-PROVIDER-001',
      quantity: 2,
      unitMultiplier: 1,
      requiresShipping: true,
      mappingStatus: 'unresolved',
      priceStatus: 'unresolved',
      packageStatus: 'unresolved',
      productGlobalId: null,
      unitPriceMinor: null,
      currency: 'USD',
      packageProfileGlobalId: null,
      blockerCodes: [
        'product_mapping_required',
        'line_price_required',
      ],
    }] : [],
    productOptions: details ? [{
      globalId: workbenchProductGlobalId,
      name: 'Trail Pack',
      sku: 'TRAIL-001',
      packageProfiles: [],
    }] : [],
    shipTo: {
      value: workbenchPartialShipTo,
      readiness: 'incomplete',
      provenance: 'provider',
      syncStatus: 'provider_snapshot',
      issues: [
        { field: 'region', code: 'required' },
        { field: 'postalCode', code: 'required' },
      ],
    },
    providerWrites: 0,
  }
}

function promotedWorkbenchOrder() {
  return {
    ...selectedOrder,
    id: 'canonical-workbench-order-id',
    globalId: workbenchCanonicalOrderGlobalId,
    orderNumber: '#7710',
    externalOrderId: 'gid://shopify/Order/7710',
    customerName: 'Northstar Outfitters',
    customerGlobalId: workbenchCustomerGlobalId,
    sourceProvider: 'shopify',
    status: 'imported',
    rowVersion: 0,
    planStatus: null,
    waveStatus: null,
    pickTaskCount: 0,
    readyPickTaskCount: 0,
    pickedPickTaskCount: 0,
    packageCount: 0,
    plannedPackageCount: 0,
    packedPackageCount: 0,
    availableActions: [],
    warehouseName: null,
    promisedDeliveryAt: '2026-08-30T15:30:00.000Z',
    lineCount: 1,
    expectedCostMinor: '0',
    expectedRevenueMinor: '2500',
    expectedMarginMinor: '2500',
    shipTo: workbenchCompleteShipTo,
    shipmentShipTo: {
      ...selectedOrder.shipmentShipTo,
      orderGlobalId: workbenchCanonicalOrderGlobalId,
      value: workbenchCompleteShipTo,
      sourceValue: workbenchCompleteShipTo,
      readiness: 'carrier_ready',
      issues: [],
      editable: true,
      editBlockedReason: null,
      providerWrites: 0,
    },
    lines: [{
      globalId: 'gol8765432',
      productGlobalId: workbenchProductGlobalId,
      productName: 'Trail Pack',
      channelSku: 'TRAIL-PROVIDER-001',
      quantity: 2,
      reservedQuantity: 0,
      pickStatus: null,
    }],
    packages: [],
    rates: [],
    billableEvents: [],
    events: [],
    planningPreparation: {
      accountGlobalId: 'gia9286799',
      candidateGlobalId: workbenchCandidateGlobalId,
      candidateRowVersion: 4,
    },
    sandboxCommerceE2eAuthorization: null,
    fulfillmentNotificationPolicy: {
      mode: 'clawpilot_explicit',
      notifyCustomerDefault: false,
      revision: 1,
    },
  }
}

type ImportedWorkbenchRouteRequest = {
  body: Record<string, unknown>
  idempotencyKey: string
}

async function installImportedWorkbenchRoutes(
  page: Page,
  options: { refreshConflict?: boolean } = {},
) {
  const capture = {
    patchRequests: [] as ImportedWorkbenchRouteRequest[],
    patchResults: [] as Array<Record<string, unknown>>,
    acceptRequests: [] as ImportedWorkbenchRouteRequest[],
    acceptResults: [] as Array<Record<string, unknown>>,
    refreshRequests: [] as ImportedWorkbenchRouteRequest[],
    providerMutationRequests: [] as string[],
    canonicalWorkspaceReads: 0,
  }
  let promoted = false
  let detailedOrder = importedWorkbenchOrder(true)

  if (options.refreshConflict) {
    detailedOrder = {
      ...detailedOrder,
      providerVersionChanged: true,
      shipTo: {
        value: workbenchCompleteShipTo,
        readiness: 'carrier_ready',
        provenance: 'local',
        syncStatus: 'local_only',
        issues: [],
      },
    }
  }

  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      url.pathname.startsWith('/api/integrations/commerce/')
      && !['GET', 'HEAD'].includes(request.method())
    ) {
      capture.providerMutationRequests.push(
        `${request.method()} ${url.pathname}`,
      )
    }
  })

  await page.route(
    (url) => url.pathname === '/api/operations/training',
    async (route) => route.fulfill({
      json: {
        ok: true,
        training: {
          eligible: false,
          eligibilityCode: 'canonical_order_promoted',
          run: null,
        },
      },
    }),
  )
  await page.route(
    (url) => url.pathname === '/api/operations/order-revisions',
    async (route) => route.fulfill({
      json: {
        ok: true,
        revision: {
          eligible: true,
          provider: 'shopify',
          orderGlobalId: workbenchCanonicalOrderGlobalId,
          orderRowVersion: 0,
          orderStatus: 'imported',
          state: null,
        },
      },
    }),
  )
  await page.route(
    (url) => url.pathname === '/api/operations/shopify-order-management',
    async (route) => route.fulfill({
      status: 503,
      json: {
        ok: false,
        code: 'NOT_REQUIRED_FOR_WORKBENCH_ACCEPTANCE',
        error: 'Provider editor is outside this local handoff test',
      },
    }),
  )
  await page.route(
    (url) => url.pathname === '/api/operations/order-workbench',
    async (route) => {
      const request = route.request()
      if (request.method() === 'GET') {
        expect(new URL(request.url()).searchParams.get('candidate'))
          .toBe(detailedOrder.candidateGlobalId)
        return route.fulfill({ json: { ok: true, orders: [detailedOrder] } })
      }
      const captured = {
        body: request.postDataJSON() as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      }
      if (request.method() === 'PATCH') {
        capture.patchRequests.push(captured)
        const draft = captured.body as {
          shipTo: typeof workbenchCompleteShipTo
          resolution: {
            customerGlobalId: string | null
            requestedDeliveryAt: string | null
            lines: Array<{
              lineGlobalId: string
              productGlobalId: string
              unitPriceMinor: number | null
              currency: string
              packageProfileGlobalId: string | null
            }>
          }
        }
        const lineDraft = draft.resolution.lines[0]
        detailedOrder = {
          ...detailedOrder,
          rowVersion: 1,
          customer: {
            ...detailedOrder.customer,
            selectedCustomerGlobalId: draft.resolution.customerGlobalId,
          },
          delivery: {
            ...detailedOrder.delivery,
            draftDeliveryAt: draft.resolution.requestedDeliveryAt,
          },
          lines: detailedOrder.lines.map((line) => (
            line.globalId === lineDraft?.lineGlobalId
              ? {
                  ...line,
                  productGlobalId: lineDraft.productGlobalId,
                  unitPriceMinor: lineDraft.unitPriceMinor,
                  currency: lineDraft.currency,
                  packageProfileGlobalId: lineDraft.packageProfileGlobalId,
                }
              : line
          )),
          shipTo: {
            value: draft.shipTo,
            readiness: 'carrier_ready',
            provenance: 'local',
            syncStatus: 'local_only',
            issues: [],
          },
        }
        const result = {
          candidateGlobalId: workbenchCandidateGlobalId,
          canonicalOrderGlobalId: null,
          rowVersion: 1,
          readiness: 'carrier_ready',
          issues: [],
          changedFields: ['region', 'postalCode'],
          syncStatus: 'local_only',
          promotionStatus: 'needs_info',
          remainingBlockerCodes: detailedOrder.blockerCodes.filter((code) => (
            !code.startsWith('ship_to_')
          )),
          providerVersionChanged: false,
          providerWrites: 0,
          providerWriteIntentCreated: false,
          replayed: false,
        }
        capture.patchResults.push(result)
        return route.fulfill({
          json: {
            ok: true,
            result,
            order: detailedOrder,
          },
        })
      }
      if (
        request.method() === 'POST'
        && captured.body.action === 'accept'
        && !options.refreshConflict
      ) {
        capture.acceptRequests.push(captured)
        promoted = true
        const result = {
          candidateGlobalId: workbenchCandidateGlobalId,
          canonicalOrderGlobalId: workbenchCanonicalOrderGlobalId,
          rowVersion: 2,
          readiness: 'carrier_ready',
          issues: [],
          changedFields: [],
          syncStatus: 'local_only',
          promotionStatus: 'promoted',
          remainingBlockerCodes: [],
          providerVersionChanged: false,
          providerWrites: 0,
          providerWriteIntentCreated: false,
          replayed: false,
        }
        capture.acceptResults.push(result)
        return route.fulfill({
          json: {
            ok: true,
            result,
            order: null,
          },
        })
      }
      if (request.method() !== 'POST' || !options.refreshConflict) {
        throw new Error(`Unexpected order-workbench request: ${request.method()}`)
      }
      capture.refreshRequests.push(captured)
      if (capture.refreshRequests.length === 1) {
        return route.fulfill({
          status: 409,
          json: {
            ok: false,
            code: 'OPERATIONS_IMPORTED_ORDER_REFRESH_CONFLICT',
            error: 'Choose which changed address values to retain',
            latestCandidateGlobalId: workbenchLatestCandidateGlobalId,
            conflicts: [{
              field: 'line1',
              localValue: '200 Customer Lane',
              providerValue: '303 Provider Avenue',
            }, {
              field: 'postalCode',
              localValue: '10001',
              providerValue: '11201',
            }],
            lineConflicts: [],
          },
        })
      }
      detailedOrder = {
        ...detailedOrder,
        globalId: workbenchLatestCandidateGlobalId,
        candidateGlobalId: workbenchLatestCandidateGlobalId,
        candidateRowVersion: 5,
        rowVersion: 1,
        providerVersionChanged: false,
        shipTo: {
          value: {
            ...workbenchCompleteShipTo,
            line1: '200 Customer Lane',
            postalCode: '11201',
          },
          readiness: 'carrier_ready',
          provenance: 'local',
          syncStatus: 'local_only',
          issues: [],
        },
      }
      return route.fulfill({
        json: {
          ok: true,
          refreshResult: {
            previousCandidateGlobalId: workbenchCandidateGlobalId,
            candidateGlobalId: workbenchLatestCandidateGlobalId,
            rowVersion: 1,
            status: 'rebased',
            providerChangedFields: ['line1', 'postalCode'],
            preservedLocalFields: ['line1'],
            preservedLineDrafts: [],
            providerWrites: 0,
            providerWriteIntentCreated: false,
            replayed: false,
          },
          order: detailedOrder,
        },
      })
    },
  )
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    const requestedOrder = new URL(route.request().url()).searchParams
      .get('order')
    if (requestedOrder === workbenchCanonicalOrderGlobalId) {
      capture.canonicalWorkspaceReads += 1
    }
    const canonical = promoted ? promotedWorkbenchOrder() : null
    return route.fulfill({
      json: {
        ok: true,
        operations: {
          ...workspace(),
          activation: { ...workspace().activation, state: 'read_only' },
          summary: {
            ...workspace().summary,
            openOrders: 1,
            exceptions: 0,
          },
          importedOrders: promoted ? [] : [{
            ...detailedOrder,
            resolutionDetailsLoaded: false,
            customer: { ...detailedOrder.customer, options: [] },
            lines: [],
            productOptions: [],
          }],
          orders: canonical ? [canonical] : [],
          selectedOrder: canonical,
          exceptions: [],
          shipping: { sandboxCarrierAccounts: [] },
        },
      },
    })
  })

  return capture
}

async function installImportedOrderPreparationRoutes(
  page: Page,
  options: { missingUnitWeight?: boolean } = {},
) {
  const authorizationIssuedAt = Date.now()
  const canonicalAuthorization = {
    authorizationGlobalId: 'gsea7654321',
    authorizedAt: new Date(authorizationIssuedAt).toISOString(),
    expiresAt: new Date(authorizationIssuedAt + 120 * 60 * 1000).toISOString(),
    authorityKind: 'shopify_test_store_canonical' as const,
    fulfillmentConfirmedAt: null,
  }
  const importedOrder = {
    ...selectedOrder,
    globalId: 'gor7654321',
    orderNumber: '#6600',
    externalOrderId: 'gid://shopify/Order/6600',
    customerName: 'Warehouse Warehouse',
    sourceProvider: 'shopify',
    status: 'imported',
    rowVersion: 0,
    warehouseId: null,
    warehouseName: null,
    planStatus: null,
    waveStatus: null,
    promisedDeliveryAt: null,
    packageCount: 0,
    plannedPackageCount: 0,
    packedPackageCount: 0,
    packages: [],
    rates: [],
    billableEvents: [],
    events: [],
    availableActions: [],
    sandboxCommerceE2eAuthorization: null,
    fulfillmentPreparation: null,
    shipmentShipTo: {
      ...selectedOrder.shipmentShipTo,
      orderGlobalId: 'gor7654321',
      editable: true,
      editBlockedReason: null,
    },
    fulfillmentNotificationPolicy: {
      mode: 'clawpilot_explicit',
      notifyCustomerDefault: false,
      revision: 1,
    },
    planningPreparation: {
      accountGlobalId: 'gia9286799',
      candidateGlobalId: 'gcoc35vrs9qjtmee',
      candidateRowVersion: 10,
      testOrder: true,
    },
    lines: [{
      globalId: 'gol7654321',
      productGlobalId: 'gp4513844',
      productName: 'Test Product',
      channelSku: 'AG-Test-Test',
      quantity: 1,
      reservedQuantity: 0,
      pickStatus: null,
    }],
  }
  const evidence = {
    globalId: 'gcte7654321',
    accountGlobalId: 'gia9286799',
    candidateGlobalId: 'gcoc35vrs9qjtmee',
    candidateOrderNumber: '#6600',
    candidateRowVersion: 10,
    candidateSourceHash: 'a'.repeat(64),
    destinationFingerprint: 'b'.repeat(64),
    requestHash: 'c'.repeat(64),
    warehouse: { globalId: 'gwh5366613', name: 'Ag-Alchemy' },
    inventorySyncRunGlobalId: 'gisr7654321',
    evidenceMode: 'operational',
    policyVersion: 'warehouse-planning-v1',
    algorithmVersion: 'approved-recipe-v1',
    planInputHash: 'd'.repeat(64),
    planResultHash: 'e'.repeat(64),
    planSnapshot: {},
    assumptionSnapshot: {},
    status: 'succeeded',
    idempotencyKey: 'operations-rate-plan:test',
    actorEmail: 'manager@example.com',
    createdAt: '2026-08-10T12:00:00.000Z',
    packages: [{
      packageKey: 'package-1',
      packageSequence: 1,
      planningMethod: 'approved_recipe',
      packagingMaterialGlobalId: 'gmat9435485',
      packagingMaterialName: 'Test shipping carton',
      approvedPackRecipeGlobalId: 'gpre7187900',
      approvedPackRecipeName: 'Test Product loose-item recipe',
      materialRowVersion: 2,
      recipeRowVersion: 1,
      recipes: [],
      innerDimensionsMm: { length: 280, width: 220, height: 190 },
      ratedOuterDimensionsMm: { length: 292, width: 229, height: 203 },
      contentWeightGrams: 170,
      tareWeightGrams: 91,
      ratedGrossWeightGrams: 261,
      maxWeightGrams: 5000,
      allocations: [{
        lineGlobalId: 'gcol7654321',
        productGlobalId: 'gp4513844',
        title: 'Test Product',
        quantity: 1,
      }],
      carrierParcel: {
        description: 'Test shipping carton',
        length: 11.5,
        width: 9,
        height: 8,
        dimensionUnit: 'IN',
        weight: 0.576,
        weightUnit: 'LB',
      },
      packageHash: 'f'.repeat(64),
      quotes: [
        {
          provider: 'ups_rest',
          rateEvidenceGlobalId: 'gcre7654321',
          status: 'succeeded',
          errorCode: null,
          carrierRequestHash: '1'.repeat(64),
          packageRateContextHash: '2'.repeat(64),
          shipmentRateContextHash: '3'.repeat(64),
          rateScope: 'multi_package_shipment',
          rates: [{
            serviceCode: '03',
            serviceName: 'UPS Ground',
            amount: '12.34',
            currency: 'USD',
            rateType: null,
            transitDays: 4,
            deliveryDate: '2026-08-14',
          }],
          requestedAt: '2026-08-10T12:00:00.000Z',
          completedAt: '2026-08-10T12:00:01.000Z',
        },
        {
          provider: 'fedex_rest',
          rateEvidenceGlobalId: 'gcre1234567',
          status: 'succeeded',
          errorCode: null,
          carrierRequestHash: '4'.repeat(64),
          packageRateContextHash: '5'.repeat(64),
          shipmentRateContextHash: '6'.repeat(64),
          rateScope: 'multi_package_shipment',
          rates: [{
            serviceCode: 'FEDEX_GROUND',
            serviceName: 'FedEx Ground',
            amount: '11.25',
            currency: 'USD',
            rateType: null,
            transitDays: 5,
            deliveryDate: '2026-08-15',
          }],
          requestedAt: '2026-08-10T12:00:00.000Z',
          completedAt: '2026-08-10T12:00:01.000Z',
        },
      ],
    }],
  }
  let planned = false
  let authorized = false
  let orderUnitWeightGrams = options.missingUnitWeight ? null : 170
  let orderUnitDimensionsMm = options.missingUnitWeight
    ? null
    : { length: 100, width: 80, height: 40 }
  let orderUnitWeightFactVersion: number | null = null
  const unitWeightRequests: Array<Record<string, unknown>> = []
  const orderUnitWeightWorkspace = () => {
    const line = {
      lineGlobalId: 'gcol7654321',
      productTitle: 'Test Product',
      variantTitle: 'Vanilla',
      quantity: 1,
      unitWeightGrams: orderUnitWeightGrams,
      weightSource: orderUnitWeightFactVersion === null
        ? (orderUnitWeightGrams === null ? null : 'provider_catalog')
        : 'order_specific',
      unitDimensionsMm: orderUnitDimensionsMm,
      dimensionSource: orderUnitDimensionsMm ? 'order_specific' : null,
      factGlobalId: orderUnitWeightFactVersion === null
        ? null
        : 'gouw7654321',
      factVersion: orderUnitWeightFactVersion,
    }
    return {
      accountGlobalId: 'gia9286799',
      candidateGlobalId: 'gcoc35vrs9qjtmee',
      candidateRowVersion: 10,
      orderGlobalId: 'gor7654321',
      missingLines: orderUnitWeightGrams === null ? [line] : [],
      dimensionMissingLines:
        orderUnitWeightGrams !== null && orderUnitDimensionsMm === null
          ? [line]
          : [],
      effectiveLines: orderUnitWeightGrams !== null ? [line] : [],
    }
  }

  await page.route((url) => url.pathname === '/api/operations/training', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        training: {
          eligible: true,
          eligibilityCode: null,
          run: null,
        },
      },
    })
  })
  await page.route((url) => url.pathname === '/api/operations/order-revisions', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        revision: {
          eligible: true,
          provider: 'shopify',
          orderGlobalId: 'gor7654321',
          orderRowVersion: planned ? 1 : 0,
          orderStatus: planned ? 'planned' : 'imported',
          state: null,
        },
      },
    })
  })
  await page.route(
    (url) => url.pathname === '/api/integrations/commerce/intake/planning-assignment',
    async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        action: 'inspect',
        accountGlobalId: 'gia9286799',
        candidateGlobalId: 'gcoc35vrs9qjtmee',
        expectedCandidateRowVersion: 10,
      })
      await route.fulfill({
        json: {
          ok: true,
          assignment: {
            version: 'shopify-order-planning-assignment-v1',
            status: 'ready',
            accountGlobalId: 'gia9286799',
            candidateGlobalId: 'gcoc35vrs9qjtmee',
            candidateRowVersion: 10,
            assignments: [],
            selectedWarehouse: {
              globalId: 'gwh5366613',
              name: 'Ag-Alchemy',
              mappingGlobalId: 'gwlm7654321',
              mappingRowVersion: 1,
              shopifyLocationId: 'gid://shopify/Location/123456789',
              shopifyLocationName: 'Ag-Alchemy',
            },
            providerReads: 1,
            providerWrites: 0,
          },
        },
      })
    },
  )

  await page.route(
    (url) => url.pathname === '/api/operations/order-unit-weights',
    async (route) => {
      if (route.request().method() === 'POST') {
        const request = route.request().postDataJSON() as Record<string, unknown>
        unitWeightRequests.push(request)
        const lines = request.lines as Array<{
          expectedFactVersion: number | null
          lineGlobalId: string
          unitWeightGrams: number
          unitDimensionsMm: {
            length: number
            width: number
            height: number
          } | null
        }>
        expect(route.request().headers()['idempotency-key'])
          .toMatch(/^operations-unit-weight:/)
        expect(request).toMatchObject({
          accountGlobalId: 'gia9286799',
          candidateGlobalId: 'gcoc35vrs9qjtmee',
          candidateRowVersion: 10,
        })
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          expectedFactVersion: orderUnitWeightFactVersion,
          lineGlobalId: 'gcol7654321',
        })
        orderUnitWeightGrams = lines[0].unitWeightGrams
        orderUnitDimensionsMm = lines[0].unitDimensionsMm
        orderUnitWeightFactVersion = (orderUnitWeightFactVersion || 0) + 1
        return route.fulfill({
          json: {
            ok: true,
            result: {
              replayed: false,
              candidateGlobalId: 'gcoc35vrs9qjtmee',
              orderGlobalId: 'gor7654321',
              providerWriteCount: 0,
              factGlobalIds: ['gouw7654321'],
              workspace: orderUnitWeightWorkspace(),
            },
          },
        })
      }
      expect(route.request().url()).toContain('candidateRowVersion=10')
      return route.fulfill({
        json: { ok: true, workspace: orderUnitWeightWorkspace() },
      })
    },
  )

  await page.route((url) => url.pathname === '/api/operations/packaging-materials', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        packagingMaterials: {
          capabilities: { canView: true, canManage: true },
          warehouses: [{
            id: 'warehouse-id',
            globalId: 'gwh5366613',
            name: 'Ag-Alchemy',
            status: 'active',
          }],
          materials: [{
            id: 'material-id',
            globalId: 'gmat9435485',
            code: 'TEST-CARTON',
            name: 'Test shipping carton',
            materialType: 'carton',
            innerDimensionsMm: { length: 280, width: 220, height: 190 },
            ratedOuterDimensionsMm: { length: 292, width: 229, height: 203 },
            ratedOuterDimensionEvidenceType: 'measured',
            ratedOuterDimensionEvidenceReference: null,
            ratedOuterDimensionConfirmedAt: '2026-08-01T12:00:00.000Z',
            ratedOuterDimensionConfirmedBy: 'manager@example.com',
            dimensionBasis: 'inner',
            dimensionEvidenceType: 'measured',
            dimensionEvidenceReference: 'warehouse measurement',
            dimensionConfirmedAt: '2026-08-01T12:00:00.000Z',
            dimensionConfirmedBy: 'manager@example.com',
            tareWeightGrams: 91,
            maxWeightGrams: 5000,
            unitCostMinor: 50,
            currency: 'USD',
            status: 'active',
            source: 'customer_supplied',
            rowVersion: 2,
            updatedAt: '2026-08-01T12:00:00.000Z',
            stock: [{
              id: 'stock-id',
              globalId: 'gmst7654321',
              warehouseId: 'warehouse-id',
              warehouseGlobalId: 'gwh5366613',
              warehouseName: 'Ag-Alchemy',
              warehouseStatus: 'active',
              isAvailable: true,
              onHandQuantity: 10,
              reorderPointQuantity: 2,
              reorderToQuantity: 10,
              reorderRecommendedQuantity: 0,
              rowVersion: 1,
              updatedAt: '2026-08-01T12:00:00.000Z',
            }],
            readiness: { eligibleForCartonization: true, missing: [] },
          }],
          optimizerReadiness: {
            historyWindowDays: 365,
            shippedDemandSampleCount: 1,
            eligibleShippedDemandSampleCount: 1,
            missingProductDimensionCount: 0,
            missingMaterialCostCount: 0,
            missingWarehouseStockCount: 0,
            outOfStockAvailabilityCount: 0,
            eligibleMaterialCount: 1,
            reorderDueCount: 0,
          },
        },
      },
    })
  })
  await page.route(
    (url) => url.pathname === '/api/integrations/commerce/intake/cartonization-rate-evidence',
    async (route) => {
      if (route.request().method() === 'POST') {
        const request = route.request().postDataJSON()
        expect(request).toMatchObject({
          evidenceMode: 'operational',
          accountGlobalId: 'gia9286799',
          candidateGlobalId: 'gcoc35vrs9qjtmee',
          expectedCandidateRowVersion: 10,
          warehouseGlobalId: 'gwh5366613',
          selectedMaterials: [{
            materialGlobalId: 'gmat9435485',
            expectedRowVersion: 2,
          }],
        })
      }
      await route.fulfill({ json: { ok: true, evidence } })
    },
  )
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON()
      if (request.action === 'authorize-shopify-test-store-canonical-e2e') {
        expect(route.request().headers()['idempotency-key'])
          .toMatch(/^shopify-test-store-authorize:/)
        expect(request).toEqual({
          action: 'authorize-shopify-test-store-canonical-e2e',
          orderGlobalId: 'gor7654321',
          expectedRowVersion: 0,
          confirmationStatement:
            SHOPIFY_TEST_STORE_CANONICAL_E2E_CONFIRMATION,
          reason: 'Enable test fulfillment for Shopify order #6600',
          lifetimeMinutes: 120,
        })
        authorized = true
        return route.fulfill({
          status: 201,
          json: {
            ok: true,
            result: {
              ...canonicalAuthorization,
              orderGlobalId: 'gor7654321',
              externalOrderId: 'gid://shopify/Order/6600',
              state: 'active',
              reason: request.reason,
              authorizedBy: 'manager@example.com',
              consumedAt: null,
              consumedBy: null,
            },
          },
        })
      }
      expect(request).toMatchObject({
        action: 'plan-order',
        orderGlobalId: 'gor7654321',
        cartonizationEvidenceGlobalId: 'gcte7654321',
        expectedRowVersion: 0,
      })
      planned = true
      return route.fulfill({
        json: {
          ok: true,
          result: {
            orderGlobalId: 'gor7654321',
            orderStatus: 'planned',
            rowVersion: 1,
            fulfillmentPlanGlobalId: 'gfp7654321',
            cartonizationEvidenceGlobalId: 'gcte7654321',
            packageCount: 1,
            carrier: 'FedEx',
            serviceCode: 'fedex_ground',
            serviceName: 'FedEx Ground',
            carrierCostMinor: '1125',
            currency: 'USD',
            checkoutShippingChargeMinor: null,
            checkoutVarianceMinor: null,
            replayed: false,
          },
        },
      })
    }
    const current = planned
      ? {
          ...importedOrder,
          status: 'planned',
          rowVersion: 1,
          planStatus: 'planned',
          warehouseName: 'Ag-Alchemy',
          availableActions: [{
            action: 'release_to_warehouse',
            label: 'Release to warehouse',
            enabled: true,
            blockedReason: null,
          }],
          planningPreparation: null,
          sandboxCommerceE2eAuthorization: authorized
            ? canonicalAuthorization
            : null,
        }
      : {
          ...importedOrder,
          sandboxCommerceE2eAuthorization: authorized
            ? canonicalAuthorization
            : null,
        }
    return route.fulfill({
      json: {
        ok: true,
        operations: {
          ...workspace(),
          activation: {
            ...workspace().activation,
            state: 'read_only',
          },
          summary: { ...workspace().summary, openOrders: 1 },
          orders: [current],
          selectedOrder: current,
          exceptions: [],
          shipping: { sandboxCarrierAccounts: [] },
        },
      },
    })
  })
  return { unitWeightRequests }
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

test('incomplete imported order saves locally before explicit acceptance into canonical Orders', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const capture = await installImportedWorkbenchRoutes(page)
  await gotoApp(page, '/#operations')

  const importedRow = page.getByTestId(
    `imported-order-${workbenchCandidateGlobalId}`,
  )
  await expect(importedRow).toBeVisible()
  await expect(importedRow).toContainText('#7710')
  await expect(importedRow).toContainText('Needs info')
  await importedRow.click()

  await expect(page.getByRole('heading', { name: 'Order #7710' }))
    .toBeVisible()
  await expect(page.getByText('Ship-to incomplete for rates')).toBeVisible()
  await expect(page.getByText('SKU TRAIL-PROVIDER-001')).toBeVisible()
  await expect(page.getByText('Quantity 2')).toBeVisible()

  const customer = page.getByRole('combobox', { name: 'Customer' })
  await expect(customer).toBeEnabled()
  await customer.click()
  await page.getByRole('option', { name: /Northstar Outfitters/ }).click()

  const product = page.getByRole('combobox', { name: 'ClawPilot product' })
  await product.click()
  await page.getByRole('option', { name: /Trail Pack · TRAIL-001/ }).click()
  await page.getByLabel('Unit price (USD)').fill('12.50')

  await expect(page.getByText(
    'Unit item — cartonization chooses outbound packaging. No Product package assignment is required.',
  )).toBeVisible()
  await expect(page.getByRole('combobox', {
    name: 'Approved pack constraint (optional)',
  })).toHaveCount(0)

  const requestedDelivery = page.getByLabel('Requested delivery')
  await requestedDelivery.fill('2026-08-30T15:30')
  const requestedDeliveryAt = await requestedDelivery.evaluate((element) => (
    new Date((element as HTMLInputElement).value).toISOString()
  ))
  await page.getByLabel('State / province').fill('NY')
  await page.getByLabel('Postal code').fill('10001')
  await expect(page.getByText('Ready for rates')).toBeVisible()

  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toHaveCount(1)
  await expect(save).toBeEnabled()
  await save.click()

  await expect(page.getByText('Order #7710 saved locally')).toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Order #7710' }))
    .toBeVisible()
  expect(capture.canonicalWorkspaceReads).toBe(0)

  const accept = page.getByRole('button', {
    name: 'Accept & import',
    exact: true,
  })
  await expect(accept).toBeEnabled()
  await expect(save).toBeDisabled()
  await accept.click()

  await expect(page.getByText('Order #7710 imported')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Order #7710' }))
    .toBeVisible()
  await expect.poll(() => capture.canonicalWorkspaceReads)
    .toBeGreaterThanOrEqual(1)

  expect(capture.patchRequests).toHaveLength(1)
  expect(capture.patchRequests[0].idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(capture.patchRequests[0].body).toEqual({
    candidateGlobalId: workbenchCandidateGlobalId,
    expectedRowVersion: 0,
    shipTo: workbenchCompleteShipTo,
    resolution: {
      customerGlobalId: workbenchCustomerGlobalId,
      requestedDeliveryAt,
      lines: [{
        lineGlobalId: workbenchLineGlobalId,
        productGlobalId: workbenchProductGlobalId,
        unitPriceMinor: 1250,
        currency: 'USD',
        packageProfileGlobalId: null,
      }],
    },
  })
  expect(capture.patchResults).toEqual([expect.objectContaining({
    canonicalOrderGlobalId: null,
    promotionStatus: 'needs_info',
    providerWrites: 0,
    providerWriteIntentCreated: false,
  })])
  expect(capture.acceptRequests).toHaveLength(1)
  expect(capture.acceptRequests[0].idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(capture.acceptRequests[0].body).toEqual({
    action: 'accept',
    candidateGlobalId: workbenchCandidateGlobalId,
    expectedRowVersion: 1,
  })
  expect(capture.acceptResults).toEqual([expect.objectContaining({
    canonicalOrderGlobalId: workbenchCanonicalOrderGlobalId,
    promotionStatus: 'promoted',
    providerWrites: 0,
    providerWriteIntentCreated: false,
  })])
  expect(capture.providerMutationRequests).toEqual([])
})

test('imported order provider refresh resolves each address conflict explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const capture = await installImportedWorkbenchRoutes(page, {
    refreshConflict: true,
  })
  await gotoApp(page, '/#operations')

  await page.getByTestId(`imported-order-${workbenchCandidateGlobalId}`).click()
  const refresh = page.getByRole('button', { name: 'Refresh from Shopify' })
  await expect(refresh).toBeEnabled()
  await refresh.click()

  const keepLocalAddress = page.getByRole('button', {
    name: 'Keep mine: 200 Customer Lane',
  })
  const useProviderAddress = page.getByRole('button', {
    name: 'Use Shopify: 303 Provider Avenue',
  })
  const keepLocalPostalCode = page.getByRole('button', {
    name: 'Keep mine: 10001',
  })
  const useProviderPostalCode = page.getByRole('button', {
    name: 'Use Shopify: 11201',
  })
  await expect(keepLocalAddress).toBeVisible()
  await expect(useProviderAddress).toBeVisible()
  await expect(keepLocalPostalCode).toBeVisible()
  await expect(useProviderPostalCode).toBeVisible()

  await keepLocalAddress.click()
  await useProviderPostalCode.click()
  await page.getByRole('button', { name: 'Apply choices' }).click()

  await expect(page.getByText(
    'Order #7710 refreshed; review provider item changes',
  )).toBeVisible()
  await expect(page.getByLabel('Address')).toHaveValue('200 Customer Lane')
  await expect(page.getByLabel('Postal code')).toHaveValue('11201')

  expect(capture.refreshRequests).toHaveLength(2)
  expect(capture.refreshRequests[0].body).toEqual({
    action: 'refresh',
    candidateGlobalId: workbenchCandidateGlobalId,
    expectedRowVersion: 0,
  })
  expect(capture.refreshRequests[1].body).toEqual({
    action: 'refresh',
    candidateGlobalId: workbenchCandidateGlobalId,
    expectedRowVersion: 0,
    latestCandidateGlobalId: workbenchLatestCandidateGlobalId,
    resolutions: {
      line1: 'local',
      postalCode: 'provider',
    },
    lineResolutions: {},
  })
  for (const request of capture.refreshRequests) {
    expect(request.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  }
  expect(capture.refreshRequests[0].idempotencyKey)
    .not.toBe(capture.refreshRequests[1].idempotencyKey)
  expect(capture.providerMutationRequests).toEqual([])
})

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

test('shipped order independently confirms original and reprint paper output', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  const capture = await installOrderLabelPrintRoutes(page)
  await gotoApp(page, '/#operations')

  await page.getByRole('row', { name: /#1004/ }).click()
  await expect(page.getByRole('heading', { name: 'Order #1004' })).toBeVisible()
  await expect(page.getByText('Reprints reuse this stored label document and never purchase new postage.'))
    .toBeVisible()

  await page.getByRole('button', { name: 'Print label' }).click()
  await expect(page.getByText(/was queued as print job gpj7654321/)).toBeVisible()
  expect(capture.requests[0]).toEqual({
    body: {
      action: 'enqueue-label',
      warehouseId: 'warehouse-id',
      sourceLabelGlobalId: capture.sourceLabelGlobalId,
      media: 'label_4x6',
    },
    idempotencyKey: `operations-shipping-label-print:${capture.sourceLabelGlobalId}`,
  })

  const originalPrintJob = page.getByTestId(
    `order-print-job-${capture.originalPrintJobGlobalId}`,
  )
  await expect(originalPrintJob.getByText('Original gpj7654321')).toBeVisible()
  await expect(originalPrintJob.getByText('Paper not verified')).toBeVisible()
  await originalPrintJob.getByRole('button', { name: 'Confirm paper output' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm physical paper output' })).toBeVisible()
  await expect(page.getByText(
    'Delivery event 3 · 99fdcbe7-a2bf-489c-b82b-93499c171304',
  )).toBeVisible()
  const originalReason = [
    'Observed one complete, legible 4 x 6 shipping label exit the printer.',
    '\tNo tears, clipping, or blank stock were visible.',
  ].join('\n')
  await page.getByLabel('What physical output did you observe?').fill(originalReason)
  await page.getByRole('button', { name: 'Confirm paper output' }).click()
  await expect(page.getByText(
    /Physical paper output was confirmed for print job gpj7654321/,
  )).toBeVisible()
  await expect(originalPrintJob.getByText('Paper verified')).toBeVisible()
  expect(capture.requests[1].body).toEqual({
    action: 'attest-physical-output',
    jobGlobalId: capture.originalPrintJobGlobalId,
    expectedDeliveryAttemptId: '99fdcbe7-a2bf-489c-b82b-93499c171304',
    expectedDeliveryAttemptSequenceNumber: 3,
    reason: originalReason,
  })
  expect(capture.requests[1].idempotencyKey)
    .toMatch(/^operations-print-physical-output:gpj7654321:/)

  await page.getByRole('button', { name: 'Reprint label' }).click()
  await expect(page.getByRole('heading', { name: 'Reprint shipping label' })).toBeVisible()
  await expect(page.getByText(/does not call the carrier, buy postage/)).toBeVisible()
  await page.getByRole('button', { name: 'Queue reprint' }).click()
  await expect(page.getByText(/was queued for reprint as gpj7654322/)).toBeVisible()
  expect(capture.requests[2].body).toEqual({
    action: 'reprint-job',
    jobGlobalId: capture.originalPrintJobGlobalId,
    reason: 'Reprint shipping label for order #1004',
  })
  expect(capture.requests[2].idempotencyKey)
    .toMatch(/^operations-shipping-label-reprint:gpj7654321:/)

  const reprintJob = page.getByTestId(`order-print-job-${capture.reprintJobGlobalId}`)
  await expect(reprintJob.getByText('Reprint gpj7654322')).toBeVisible()
  await expect(reprintJob.getByText('Paper not verified')).toBeVisible()
  await reprintJob.getByRole('button', { name: 'Confirm paper output' }).click()
  await expect(page.getByText(
    'Delivery event 1 · dfe72f16-0605-43b8-9ea7-a573335f6a55',
  )).toBeVisible()
  const reprintReason = 'Observed the replacement label exit the printer cleanly'
  await page.getByLabel('What physical output did you observe?').fill(reprintReason)
  await page.getByRole('button', { name: 'Confirm paper output' }).click()
  await expect(page.getByText(
    /Physical paper output was confirmed for print job gpj7654322/,
  )).toBeVisible()
  await expect(reprintJob.getByText('Paper verified')).toBeVisible()
  expect(capture.requests[3].body).toEqual({
    action: 'attest-physical-output',
    jobGlobalId: capture.reprintJobGlobalId,
    expectedDeliveryAttemptId: 'dfe72f16-0605-43b8-9ea7-a573335f6a55',
    expectedDeliveryAttemptSequenceNumber: 1,
    reason: reprintReason,
  })
  expect(capture.requests[3].idempotencyKey)
    .toMatch(/^operations-print-physical-output:gpj7654322:/)
})

test('order workflow hides physical confirmation when browser session is ineligible', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  const capture = await installOrderLabelPrintRoutes(page, {
    canVerifyPhysicalOutput: false,
  })
  await gotoApp(page, '/#operations')

  await page.getByRole('row', { name: /#1004/ }).click()
  await page.getByRole('button', { name: 'Print label' }).click()
  const originalPrintJob = page.getByTestId(
    `order-print-job-${capture.originalPrintJobGlobalId}`,
  )
  await expect(originalPrintJob.getByText('Paper not verified')).toBeVisible()
  await expect(
    originalPrintJob.getByRole('button', { name: 'Confirm paper output' }),
  ).toHaveCount(0)
})

test('failed shipping-label print retries from the order without purchasing postage', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  const capture = await installOrderLabelPrintRoutes(page, { initialFailedJob: true })
  await gotoApp(page, '/#operations')

  await page.getByRole('row', { name: /#1004/ }).click()
  await expect(page.getByRole('button', { name: 'Retry label' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry label' }).click()
  await expect(page.getByText(/was queued for another bounded attempt/)).toBeVisible()
  expect(capture.requests[0].body).toEqual({
    action: 'retry-job',
    jobGlobalId: capture.originalPrintJobGlobalId,
    reason: 'Retry failed shipping label for order #1004',
  })
  expect(capture.requests[0].idempotencyKey)
    .toMatch(/^operations-shipping-label-retry:gpj7654321:/)
  await expect(page.getByRole('button', { name: 'Print queued' })).toBeVisible()
})

test('measured outer dimensions save without a redundant evidence note', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  await installOperationsRoutes(page)
  const requests: Array<Record<string, unknown>> = []
  const packagingMaterials = {
    capabilities: { canView: true, canManage: true },
    warehouses: [{
      id: 'warehouse-id',
      globalId: 'gwh5366613',
      name: 'Ag-Alchemy',
      status: 'active',
    }],
    materials: [],
    shopifyPackageImport: {
      providerListApiAvailable: false,
      importMethod: 'csv',
      accounts: [],
    },
    optimizerReadiness: {
      historyWindowDays: 365,
      shippedDemandSampleCount: 0,
      eligibleShippedDemandSampleCount: 0,
      missingProductDimensionCount: 0,
      missingMaterialCostCount: 0,
      missingWarehouseStockCount: 0,
      outOfStockAvailabilityCount: 0,
      eligibleMaterialCount: 0,
      reorderDueCount: 0,
    },
  }
  await page.route(
    (url) => url.pathname === '/api/operations/packaging-materials',
    async (route) => {
      if (route.request().method() === 'POST') {
        requests.push(route.request().postDataJSON())
        return route.fulfill({
          json: {
            ok: true,
            result: {
              globalId: 'gmat0309001',
              rowVersion: 0,
              status: 'draft',
            },
          },
        })
      }
      return route.fulfill({
        json: { ok: true, packagingMaterials },
      })
    },
  )
  await gotoApp(page, '/#operations')
  await page.getByRole('tab', { name: 'Packaging materials' }).click()
  await page.getByRole('button', { name: 'Add material' }).click()

  await page.getByLabel('Code').fill('MEASURED-OUTER')
  await page.getByLabel('Name').fill('Measured outer carton')
  await page.getByLabel(/^Outer length/).fill('12')
  await page.getByLabel(/^Outer width/).fill('8')
  await page.getByLabel(/^Outer height/).fill('6')
  await page.getByRole('combobox', {
    name: 'Outer-dimension evidence',
  }).click()
  await page.getByRole('option', { name: 'Measured' }).click()
  const reference = page.getByLabel('Outer-dimension evidence reference')
  await expect(reference).not.toHaveAttribute('required')
  await expect(page.getByText(
    'Optional note; exact outer measurements retain the confirming actor and time automatically',
  )).toBeVisible()
  await page.getByRole('button', { name: 'Create draft' }).click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({
    action: 'save-material',
    code: 'MEASURED-OUTER',
    name: 'Measured outer carton',
    ratedOuterDimensionEvidenceType: 'measured',
    ratedOuterDimensionEvidenceReference: null,
    status: 'draft',
  })
  expect(Number(requests[0].ratedOuterLengthMm)).toBeGreaterThan(0)
  expect(Number(requests[0].ratedOuterWidthMm)).toBeGreaterThan(0)
  expect(Number(requests[0].ratedOuterHeightMm)).toBeGreaterThan(0)
  await expect(page.getByText('Measured outer carton was created as a draft.'))
    .toBeVisible()
})

test('imported order preparation cartonizes, compares rates, and plans without releasing', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  await installImportedOrderPreparationRoutes(page)
  await gotoApp(page, '/#operations')

  await page.getByRole('row', { name: /#6600/ }).click()
  const prepareOrder = page.getByRole('button', { name: 'Prepare order' })
  const authorizeOrder = page.getByTestId(
    'authorize-shopify-test-store-canonical-e2e',
  )
  await expect(authorizeOrder).toBeVisible()
  await expect(prepareOrder).toHaveCount(0)
  await authorizeOrder.click()
  await expect(
    page.getByRole('heading', { name: 'Enable test fulfillment' }),
  ).toBeVisible()
  await page.getByTestId('sandbox-commerce-e2e-confirmation').check()
  await page.getByTestId('confirm-sandbox-commerce-e2e-authorization').click()
  await expect(page.getByTestId('sandbox-commerce-e2e-authorization-active'))
    .toContainText('Enabled')
  await prepareOrder.click()
  await expect(
    page.getByRole('heading', { name: 'Prepare and plan imported order' }),
  ).toBeVisible()
  await expect(page.getByRole('combobox', { name: /^Warehouse/ }))
    .toContainText('Ag-Alchemy')
  await expect(page.getByRole('combobox', { name: /^Packaging materials/ }))
    .toContainText('TEST-CARTON')

  await page.getByRole('button', {
    name: 'Run cartonization and compare rates',
  }).click()
  await expect(page.getByText('UPS · UPS Ground')).toBeVisible()
  await expect(page.getByText('FedEx · FedEx Ground')).toBeVisible()
  await expect(page.getByText(/lowest-cost whole-shipment service/)).toBeVisible()

  await page.getByRole('button', { name: 'Confirm warehouse plan' }).click()
  await expect(page.getByText(/was planned from gcte7654321/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Release to warehouse' })).toBeVisible()
  await expect(page.getByText('Not Released')).toBeVisible()
})

test('ordinary-unit facts save and invalidate stale cartonization before planning', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 })
  const capture = await installImportedOrderPreparationRoutes(page, {
    missingUnitWeight: true,
  })
  await gotoApp(page, '/#operations')

  await page.getByRole('row', { name: /#6600/ }).click()
  await page.getByTestId('authorize-shopify-test-store-canonical-e2e').click()
  await page.getByTestId('sandbox-commerce-e2e-confirmation').check()
  await page.getByTestId('confirm-sandbox-commerce-e2e-authorization').click()
  await page.getByRole('button', { name: 'Prepare order' }).click()

  await expect(page.getByText('Missing unit weights')).toBeVisible()
  await expect(page.getByText('Vanilla · Quantity 1')).toBeVisible()
  const unitWeight = page.getByLabel(/^Unit weight/)
  const runCartonization = page.getByRole('button', {
    name: 'Run cartonization and compare rates',
  })
  const saveUnitWeights = page.getByRole('button', { name: 'Save unit facts' })
  await expect(runCartonization).toBeDisabled()
  await expect(saveUnitWeights).toBeDisabled()
  await unitWeight.fill('1')
  await page.getByLabel('Audit reason').fill('Measured on the receiving scale')
  await saveUnitWeights.click()
  await expect.poll(() => capture.unitWeightRequests.length).toBe(1)
  await expect(page.getByText('Item dimensions for cartonization')).toBeVisible()
  await expect(runCartonization).toBeEnabled()

  await page.getByLabel(/^Length/).fill('10')
  await page.getByLabel(/^Width/).fill('8')
  await page.getByLabel(/^Height/).fill('4')
  await page.getByLabel('Audit reason').fill('Added exact item dimensions')
  await saveUnitWeights.click()
  await expect.poll(() => capture.unitWeightRequests.length).toBe(2)
  await expect(page.getByText('Order unit facts')).toBeVisible()
  await expect(runCartonization).toBeEnabled()

  await runCartonization.click()
  await expect(page.getByText('UPS · UPS Ground')).toBeVisible()
  await unitWeight.fill('1.25')
  await expect(page.getByText('UPS · UPS Ground')).toHaveCount(0)
  await expect(runCartonization).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Confirm warehouse plan' }))
    .toBeDisabled()
  await page.getByLabel('Audit reason').fill('Corrected after scale verification')
  await saveUnitWeights.click()
  await expect.poll(() => capture.unitWeightRequests.length).toBe(3)
  await expect(runCartonization).toBeEnabled()
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
  await right.tap()
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(initialScrollLeft)
  await expect(left).toBeEnabled()
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)

  const rightwardScrollLeft = await scroller.evaluate((element) => element.scrollLeft)
  await left.tap()
  await expect.poll(async () => scroller.evaluate((element) => element.scrollLeft)).toBeLessThan(rightwardScrollLeft)

  await right.tap()
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)

  await printing.tap()
  await expect(printing).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => isFullyVisibleWithin(printing, scroller)).toBe(true)
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

  await page.setViewportSize({ width: 844, height: 390 })
  await expect(page.getByRole('button', { name: /Scroll operations tabs (left|right)/ })).toHaveCount(2)
  await expect(left).toBeEnabled()
  await expect(right).toBeDisabled()
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
  await expect(page.getByText(/Hosted orders enter through connected commerce accounts/)).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: /PROOF-1042/ }).click()
  await expect(page.getByRole('heading', { name: 'Order PROOF-1042' })).toBeVisible()
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})

test('operations mobile workbench scrolls the header and orders as one touch surface', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installOperationsRoutes(page)
  await gotoApp(page, '/#operations')

  const workbench = page.getByTestId('operations-workbench')
  const firstOrder = page.getByRole('button', { name: /PROOF-1042/ })
  await expect.poll(async () => workbench.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
  await expect.poll(async () => workbench.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await workbench.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(async () => workbench.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(async () => isFullyVisibleWithin(firstOrder, workbench)).toBe(true)
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
  await expect(
    page.getByText('Pre-label carrier estimate', { exact: true }).first(),
  ).toBeVisible()
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
    page.getByText('Captured checkout shipping charge', { exact: true }),
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
  await expect(page.getByText(/no checkout carrier-estimate or package-plan baseline/)).toBeVisible()
})
