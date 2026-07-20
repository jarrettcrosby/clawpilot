import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const authPassword = process.env.UI_AUTH_PASSWORD
const operatorSecret = process.env.UI_OPERATOR_SECRET

const locationId = '11111111-1111-4111-8111-111111111111'

const posSnapshot = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  range: { from: '2026-07-18', to: '2026-07-18' },
  locations: [{
    restaurantGuid: locationId,
    restaurantName: 'Acceptance Restaurant',
    locationName: 'Downtown',
    timezone: 'America/New_York',
  }],
  summary: {
    currencyCode: 'USD',
    netSales: 551.74,
    grossSales: 551.74,
    orders: 26,
    guests: 26,
    averageCheck: 21.22,
    discounts: 0,
    refunds: 0,
  },
  daily: [{
    businessDate: '2026-07-18',
    orderCount: 26,
    grossSales: 551.74,
    netSales: 551.74,
    tax: 40.58,
    tips: 65.42,
    discounts: 0,
    serviceCharges: 65.42,
    tendered: 592.32,
    total: 657.74,
  }],
  orders: { items: [], total: 0, page: 1, pageSize: 25 },
  selectedOrder: null,
  drafts: [],
  readiness: {
    standardConfigured: true,
    analyticsConfigured: true,
    latestSyncAt: '2026-07-18T21:00:00.000Z',
    datasets: {
      standardOrders: { records: 26, successfulJobs: 1, failedJobs: 0 },
      analyticsSales: { records: 1, successfulJobs: 1, failedJobs: 0 },
    },
  },
}

const operationalReport = {
  receiptTotals: {
    businessDays: 1,
    locationCount: 1,
    orderCount: 26,
    checkCount: 26,
    guestCount: 26,
    grossSales: 551.74,
    netSales: 551.74,
    discounts: 0,
    serviceCharges: 0,
    tax: 40.58,
    tips: 65.42,
    tendered: 592.32,
    total: 657.74,
    averageCheckNetSales: 21.22,
  },
  dailySummaries: [{
    businessDate: '2026-07-18',
    orderCount: 26,
    checkCount: 26,
    guestCount: 26,
    netSales: 551.74,
    tax: 40.58,
    tips: 65.42,
    total: 657.74,
  }],
  checkSummaries: {
    totals: { checkCount: 26 },
    byPaymentStatus: [{ paymentStatus: 'Paid', checkCount: 26, total: 657.74 }],
  },
  productPerformance: [{
    productId: 'toast-item-1',
    name: 'Breakfast Sandwich',
    plu: '1001',
    categoryName: 'Mains',
    quantity: 11,
    selectionCount: 11,
    checkCount: 11,
    netSales: 110,
  }],
  categoryTotals: [{
    categoryId: 'toast-category-1',
    name: 'Mains',
    quantity: 11,
    selectionCount: 11,
    netSales: 110,
  }],
  tenderTotals: {
    byType: [{ type: 'Credit card', amount: 592.32 }],
    byCardType: [
      { cardType: 'Visa', amount: 435.27 },
      { cardType: 'Amex', amount: 139.36 },
    ],
    processingFees: { available: true, value: 28.21 },
    calculatedCardSettlement: { available: true, value: 629.53 },
    actualPayout: { available: false, value: 0, reason: 'No payout evidence' },
  },
  cashOperations: { tendered: 0 },
  comparisons: {
    priorPeriod: {
      available: true,
      range: { from: '2026-07-17', to: '2026-07-17' },
      totals: { netSales: 500, orderCount: 24 },
      change: { netSales: { percent: 10.35 } },
    },
    priorYear: {
      available: true,
      range: { from: '2025-07-18', to: '2025-07-18' },
      totals: { netSales: 410, orderCount: 20 },
      change: { netSales: { percent: 34.57 } },
    },
  },
  coverage: {
    orders: 26,
    ordersWithCheckDetails: 26,
    detailedChecks: 26,
    detailedPayments: 26,
    paymentsWithProcessingFee: 26,
  },
}

async function authenticateIfConfigured(page: Page) {
  if (!authPassword || !operatorSecret) return
  const response = await page.request.post('/api/auth/login', {
    data: { password: authPassword },
    headers: { 'x-clawpilot-operator-secret': operatorSecret },
    failOnStatusCode: false,
  })
  expect(response.ok(), `UI authentication failed with HTTP ${response.status()}`).toBeTruthy()
}

async function mockPos(page: Page) {
  await page.route((url) => url.pathname === '/api/pos', (route) => route.fulfill({
    json: { ok: true, capabilities: { canView: true, canManage: true }, pos: posSnapshot },
  }))
  await page.route((url) => url.pathname === '/api/pos/reports', (route) => route.fulfill({
    json: { ok: true, report: operationalReport },
  }))
}

async function gotoPos(page: Page) {
  await authenticateIfConfigured(page)
  await mockPos(page)
  await page.goto('/#pos')
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'POS views' })).toBeVisible()
  await page.getByRole('tab', { name: 'Reports', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'POS report views' })).toBeVisible()
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth - window.innerWidth
  ))).toBeLessThanOrEqual(1)
}

async function expectOneVisibleExactText(page: Page, value: string) {
  const matches = page.getByText(value, { exact: true })
  await expect.poll(async () => {
    const candidates = await matches.all()
    const visibility = await Promise.all(candidates.map((candidate) => candidate.isVisible()))
    return visibility.filter(Boolean).length
  }).toBe(1)
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
]) {
  test(`POS reports remain usable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await gotoPos(page)

    await expect(page.getByText('Business days', { exact: true })).toBeVisible()
    await expect(page.getByText('Sales receipt', { exact: true })).toBeVisible()
    await expectNoDocumentOverflow(page)

    await page.getByRole('tab', { name: 'Products', exact: true }).click()
    await expect(page.getByText('Product performance', { exact: true })).toBeVisible()
    await expectOneVisibleExactText(page, 'Breakfast Sandwich')

    await page.getByRole('tab', { name: 'Payments', exact: true }).click()
    await expect(page.getByText('Settlement evidence', { exact: true })).toBeVisible()
    await expect(page.getByText('Calculated card settlement', { exact: true })).toBeVisible()
    await expect(page.getByText('Actual payout', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Trends', exact: true }).click()
    await expect(page.getByText('Prior period', { exact: true })).toBeVisible()
    await expect(page.getByText('Sales run rate', { exact: true })).toBeVisible()
    await expectNoDocumentOverflow(page)
  })
}
