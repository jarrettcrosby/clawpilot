import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

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
  lineCount: 1,
  exceptionCount: 0,
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

function workspace() {
  return {
    organizationId: '11111111-1111-4111-8111-111111111111',
    configured: true,
    capabilities: { canView: true, canManage: true, canExecute: true },
    summary: {
      openOrders: 0,
      exceptions: 0,
      dueSoon: 0,
      shippedToday: 1,
      reservedUnits: 0,
      availableUnits: 10,
      unbilledMinor: '1335',
    },
    orders: [selectedOrder],
    selectedOrder,
    warehouses: [{ id: 'warehouse-id', globalId: 'gwh1234567', name: 'Primary Warehouse' }],
    catalog: {
      customers: [{ id: 'customer-id', globalId: 'ga1234567', name: 'Northstar Outfitters' }],
      products: [{ id: 'product-id', globalId: 'gp1234567', name: 'Trail Pack', sku: 'TRAIL-001' }],
    },
    generatedAt: '2026-07-22T18:00:00.000Z',
  }
}

async function installOperationsRoutes(page: Page) {
  await page.route((url) => url.pathname === '/api/operations', async (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as { action?: string; proof?: Record<string, unknown> }
      expect(request.action).toBe('run-proof-order')
      expect(request.proof?.customerGlobalId).toBe('ga1234567')
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
    return route.fulfill({ json: { ok: true, operations: workspace() } })
  })
}

test('operations workbench renders dense desktop evidence and order drill-in', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await installOperationsRoutes(page)
  await gotoApp(page, '/#operations')

  await expect(page.getByRole('heading', { name: 'Order Workbench' })).toBeVisible()
  await expect(page.getByText('Mock adapters')).toBeVisible()
  await expect(page.getByRole('table', { name: 'Operations orders' })).toBeVisible()
  await expect(page.getByText('Northstar Outfitters').first()).toBeVisible()
  await expect(page.getByText('$13.35').first()).toBeVisible()

  await page.getByRole('row', { name: /PROOF-1042/ }).click()
  await expect(page.getByRole('heading', { name: 'Order PROOF-1042' })).toBeVisible()
  await expect(page.getByText('Trail Pack')).toBeVisible()
  await expect(page.getByText('UPS · UPS Ground')).toBeVisible()
  await expect(page.getByText('Order Shipped')).toBeVisible()
})

test('operations mobile workflow has no page overflow and executes a proof order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installOperationsRoutes(page)
  await gotoApp(page, '/#operations')

  await expect(page.getByTestId('mobile-bottom-navigation')).toBeVisible()
  await expect(page.getByText('Order PROOF-1042')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Proof order' }).click()
  await expect(page.getByRole('heading', { name: 'Run proof order', exact: true })).toBeVisible()
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
