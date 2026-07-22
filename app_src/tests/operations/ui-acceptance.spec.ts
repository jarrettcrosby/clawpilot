import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
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

const selectedOrder = {
  id: 'order-id',
  globalId: 'gor1234567',
  orderNumber: 'PROOF-1042',
  customerName: 'Northstar Outfitters',
  customerGlobalId: 'ga1234567',
  sourceProvider: 'mock-commerce',
  status: 'shipped',
  warehouseName: 'Primary Warehouse',
  promisedDeliveryAt: '2026-08-04T21:00:00.000Z',
  lineCount: 2,
  exceptionCount: 1,
  expectedCostMinor: '1066',
  expectedRevenueMinor: '1335',
  expectedMarginMinor: '269',
  trackingNumber: 'MOCK3C4B5A6F789012ABCD',
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
    reservedQuantity: 0,
    pickStatus: 'completed',
  }, {
    globalId: 'gol7654321',
    productGlobalId: 'gp7654321',
    productName: 'Camp Lantern',
    channelSku: 'LANTERN-002',
    quantity: 1,
    reservedQuantity: 0,
    pickStatus: 'completed',
  }],
  packages: [{
    globalId: 'gpk1234567',
    packageNumber: 1,
    weightGrams: 1400,
    dimensionsMm: { length: 300, width: 220, height: 160 },
    status: 'shipped',
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
  events: [{ globalId: 'gev1234567', type: 'order.shipped', occurredAt: '2026-07-22T18:00:00.000Z', payload: {} }],
}

const exception = {
  id: 'exception-id',
  globalId: 'gex1234567',
  exceptionType: 'inventory_shortage',
  severity: 'high',
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

function workspace(exceptionStatus: OperationsExceptionStatus = 'open') {
  const currentException = {
    ...exception,
    status: exceptionStatus,
    updatedAt: exceptionStatus === 'open' ? exception.updatedAt : '2026-07-22T18:10:00.000Z',
  }
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
      openOrders: 0,
      exceptions: exceptionStatus === 'open' || exceptionStatus === 'acknowledged' ? 1 : 0,
      dueSoon: 0,
      shippedToday: 1,
      reservedUnits: 0,
      availableUnits: 10,
      unbilledMinor: '1335',
    },
    orders: [selectedOrder],
    selectedOrder,
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
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as {
        action?: string
        proof?: {
          customerGlobalId?: string
          lines?: Array<{ productGlobalId: string; quantity: number; openingQuantity: number }>
        }
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
      expect(request.action).toBe('run-proof-order')
      expect(request.proof?.customerGlobalId).toBe('ga1234567')
      expect(request.proof?.lines).toEqual([
        { productGlobalId: 'gp1234567', quantity: 2, openingQuantity: 12 },
        { productGlobalId: 'gp7654321', quantity: 1, openingQuantity: 12 },
      ])
      return route.fulfill({
        status: 201,
        json: {
          ok: true,
          result: {
            orderGlobalId: selectedOrder.globalId,
            orderStatus: 'shipped',
            duplicate: false,
            trackingNumber: selectedOrder.trackingNumber,
            steps: Array.from({ length: 20 }, (_, index) => `Completed proof step ${index + 1}`),
          },
        },
      })
    }
    return route.fulfill({ json: { ok: true, operations: workspace(exceptionStatus) } })
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
  await expect(page.getByText('Order Shipped')).toBeVisible()
  await page.getByRole('button', { name: 'Close order details' }).click()

  await page.getByRole('tab', { name: 'Exceptions (1)' }).click()
  await expect(page.getByRole('table', { name: 'Operations exceptions' })).toBeVisible()
  await page.getByRole('row', { name: /Inventory reservation is short/ }).click()
  await expect(page.getByRole('heading', { name: 'Inventory reservation is short' })).toBeVisible()
  await expect(page.getByText('Replenish or move the line to another warehouse.')).toBeVisible()
  await page.getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByRole('tab', { name: 'Exceptions (1)' })).toBeVisible()
})

test('operations mobile workflow has no page overflow and executes a proof order', async ({ page }) => {
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

  await page.getByRole('button', { name: 'Proof order' }).click()
  await expect(page.getByRole('heading', { name: 'Run proof order', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Add product' }).click()
  await expect(page.getByRole('combobox', { name: 'Product 1' })).toContainText('Trail Pack')
  await expect(page.getByRole('combobox', { name: 'Product 2' })).toContainText('Camp Lantern')
  await page.getByRole('textbox', { name: 'Address', exact: true }).fill('200 Customer Lane')
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('New York')
  await page.getByRole('textbox', { name: 'State or region', exact: true }).fill('NY')
  await page.getByRole('textbox', { name: 'Postal code', exact: true }).fill('10001')
  await page.getByRole('button', { name: 'Run 20-step proof' }).click()

  await expect(page.getByText(/Proof order shipped/)).toBeVisible()
  await expect(page.getByText('Completed proof step 20')).toBeVisible()
  await page.getByRole('button', { name: 'Open shipped order' }).click()
  await expect(page.getByRole('heading', { name: 'Order PROOF-1042' })).toBeVisible()
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
})
