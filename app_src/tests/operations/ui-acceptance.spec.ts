import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import type { OperationsExceptionStatus } from '@/lib/operations/types'

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
