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

async function activatePos(page: Page) {
  await page.evaluate(() => {
    const oldURL = window.location.href
    const nextURL = new URL(oldURL)
    nextURL.hash = 'pos'
    window.history.replaceState({}, '', nextURL)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: nextURL.toString() }))
  })
}

async function gotoPos(page: Page) {
  await authenticateIfConfigured(page)
  await mockPos(page)
  await page.goto('/#pos')
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const closeGuide = page.getByRole('button', { name: 'Close POS guide' })
  await closeGuide.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {})
  if (await closeGuide.isVisible()) await closeGuide.click()
  await activatePos(page)
  await expect(page.getByRole('tablist', { name: 'POS views' })).toBeVisible()
  if (await closeGuide.isVisible()) await closeGuide.click()
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

async function mockAccountingParity(page: Page) {
  await page.route((url) => url.pathname === '/api/accounting/quickbooks', (route) => {
    if (route.request().url().includes('view=pos-parity-evidence')) {
      return route.fulfill({
        json: {
          ok: true,
          capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
          view: 'pos-parity-evidence',
          detail: {
            evidence: {
              evidenceId: 'SalesReceipt:1534', entityType: 'SalesReceipt', providerTransactionId: '1534',
              businessDate: '2026-07-18', documentNumber: '260718POS', memo: 'Toast 2026-07-18',
              postingOrigin: 'shogo', partyName: 'Toast clearing customer', accountName: 'Clearing account',
              currencyCode: 'USD', syncedAt: '2026-07-21T20:30:56.605Z', subtotalCents: 55174,
              subtotalSource: 'line_sum', totalCents: 59232, taxCents: 4058,
              lineGroups: [{ itemId: 'item-breakfast', itemName: 'Breakfast Sandwich', amountCents: 8000, quantityMillis: 8000 }],
              unidentifiedLineCount: 0, unsupportedLineCount: 0,
            },
            integrity: { status: 'match', subtotalCents: 55174, taxCents: 4058, totalCents: 59232, deltaCents: 0 },
          },
        },
      })
    }
    if (route.request().url().includes('view=pos-parity')) {
      return route.fulfill({
        json: {
          ok: true,
          capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
          view: 'pos-parity',
          report: {
            historicalBaseline: {
              summary: {
                cachedTransactions: 97,
                pairCount: 44,
                exactMarkerPairs: 44,
                dateFallbackPairs: 0,
                unmatchedGroups: 9,
                unmatchedEvidence: 9,
                ambiguousGroups: 0,
                ambiguousEvidence: 0,
                receiptArithmetic: { match: 49, variance: 0, insufficientEvidence: 0 },
                journalBalance: { match: 48, variance: 0, insufficientEvidence: 0 },
              },
              pairs: [{
                basis: 'business_date_and_marker',
                businessDate: '2026-07-18',
                salesReceipt: {
                  evidenceId: 'receipt-1534', entityType: 'SalesReceipt', providerTransactionId: '1534',
                  businessDate: '2026-07-18', documentNumber: '260718POS', memo: 'Toast 2026-07-18',
                  postingOrigin: 'shogo',
                },
                journalEntry: {
                  evidenceId: 'journal-1531', entityType: 'JournalEntry', providerTransactionId: '1531',
                  businessDate: '2026-07-18', documentNumber: '260718POS', memo: 'Toast 2026-07-18',
                  postingOrigin: 'shogo',
                },
                receiptArithmetic: { status: 'match', deltaCents: 0 },
                journalBalance: { status: 'match', deltaCents: 0 },
              }],
              unmatchedGroups: [{
                businessDate: '2026-06-22', documentNumber: '260622POS', entityType: 'JournalEntry',
                evidence: [{
                  evidenceId: 'journal-unmatched', entityType: 'JournalEntry', providerTransactionId: '1490',
                  businessDate: '2026-06-22', documentNumber: '260622POS', memo: 'Toast 2026-06-22',
                  postingOrigin: 'shogo',
                }],
              }],
              ambiguousGroups: [],
            },
            rows: [{
              expected: {
                expectedId: 'draft-receipt', entityType: 'SalesReceipt', businessDate: '2026-07-18',
                providerTransactionId: '1534', documentNumber: '260718POS', memo: 'POS 2026-07-18',
                totalCents: 59232, taxCents: 4058,
                lineGroups: [{ itemId: 'item-breakfast', itemName: 'Breakfast Sandwich', amountCents: 8000, quantityMillis: 8000 }],
                lineEvidenceAvailable: true, unmappedLineCount: 0,
                draft: {
                  id: 'draft-1', restaurantName: 'Acceptance Restaurant', locationName: 'Downtown',
                  status: 'needs_review', reconciliationStatus: 'ready', revision: 3, sourceRevision: 7,
                  updatedAt: '2026-07-21T20:30:56.605Z',
                },
              },
              actual: {
                evidenceId: 'SalesReceipt:1534', entityType: 'SalesReceipt', providerTransactionId: '1534',
                businessDate: '2026-07-18', documentNumber: '260718POS', memo: 'POS 2026-07-18',
                postingOrigin: 'clawpilot', partyName: 'Toast clearing customer', accountName: 'Clearing account',
                currencyCode: 'USD', syncedAt: '2026-07-21T20:30:56.605Z', subtotalCents: 55174,
                subtotalSource: 'line_sum', totalCents: 59232, taxCents: 4058,
                lineGroups: [{ itemId: 'item-breakfast', itemName: 'Breakfast Sandwich', amountCents: 8000, quantityMillis: 8000 }],
                unidentifiedLineCount: 0, unsupportedLineCount: 0,
              },
              match: { status: 'matched', basis: 'provider_id', candidateTransactionIds: [] },
              comparison: {
                status: 'match',
                total: { status: 'match', expectedCents: 59232, actualCents: 59232, deltaCents: 0 },
                tax: { status: 'match', expectedCents: 4058, actualCents: 4058, deltaCents: 0 },
                lines: [{
                  itemId: 'item-breakfast', itemName: 'Breakfast Sandwich', expectedAmountCents: 8000,
                  actualAmountCents: 8000, deltaAmountCents: 0, expectedQuantityMillis: 8000,
                  actualQuantityMillis: 8000, deltaQuantityMillis: 0, status: 'match',
                }],
                coverageIncomplete: false,
              },
            }],
            summary: {
              drafts: 1, expectedDocuments: 2, cachedTransactions: 2, matched: 2, ambiguous: 0,
              missingQuickBooks: 0, unmatchedQuickBooks: 0, comparisonsMatched: 2,
              comparisonsWithVariance: 0, comparisonsWithInsufficientEvidence: 0,
            },
            pagination: { page: 1, pageSize: 60, totalDates: 76, totalPages: 2, dates: ['2026-07-18'] },
            historicalPagination: {
              page: 1, pageSize: 20, totalPages: 3, pairPages: 3, unmatchedPages: 2, ambiguousPages: 1,
            },
            cache: {
              configured: true, connectionStatus: 'active', lastCatalogSyncedAt: '2026-07-21T20:30:56.605Z',
              syncStatus: 'succeeded', syncCompletedAt: '2026-07-21T20:30:56.605Z',
              salesReceiptCount: 49, journalEntryCount: 48,
            },
            warnings: [],
          },
        },
      })
    }
    return route.fulfill({
      json: {
        ok: true,
        capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
        overview: {
          connection: { configured: true, companyName: 'Acceptance Books', status: 'active', lastSyncedAt: '2026-07-21T20:30:56.605Z' },
          currencyCode: 'USD',
          counts: { accounts: 12, products: 20, customers: 10, vendors: 4, transactions: 125, attachments: 0, reports: 5, reportErrors: 0 },
          metrics: { invoiced: 0, receivedSales: 0, expenses: 0, openInvoices: 0, overdueInvoices: 0, openInvoiceCount: 0, overdueInvoiceCount: 0 },
          trend: [], transactionTypes: [], recent: [],
        },
      },
    })
  })
}

for (const viewport of [
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
]) {
  test(`Accounting POS parity remains usable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await authenticateIfConfigured(page)
    await mockAccountingParity(page)
    await page.goto('/#accounting')
    if (new URL(page.url()).pathname === '/login') {
      throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
    }
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByRole('tab', { name: 'POS posting parity', exact: true }).click()
    await expect(page.getByText('Toast posting history', { exact: true })).toBeVisible()
    await expect(page.getByText('97', { exact: true })).toBeVisible()
    await expect(page.getByText('Posting history exceptions', { exact: true })).toBeVisible()
    await expect(page.getByText('Current ClawPilot drafts', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Open Sales receipt 260718POS' }).click()
    await expect(page.getByText('QuickBooks evidence', { exact: true })).toBeVisible()
    await expect(page.getByText('Breakfast Sandwich', { exact: true })).toBeVisible()
    await expect(page.getByText('Receipt arithmetic delta $0.00', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close posting details' }).click()
    await expectNoDocumentOverflow(page)
  })
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

test('POS accounting saves only one exact changed mapping from a catalog larger than 250 rows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await authenticateIfConfigured(page)
  await mockPos(page)
  await page.addInitScript((organizationId) => {
    window.localStorage.setItem(`clawpilot.pos.guide.seen:${organizationId}`, '1')
  }, posSnapshot.organizationId)

  const sourceId = '14351ea1-ad68-4f2c-85e6-da00661bab4e'
  const sourceName = 'Saratoga Springs - Sparkling Water'
  const targetId = '35'
  const targetName = 'Saratoga Sparkling 12 oz'
  const sourceCatalog = Array.from({ length: 251 }, (_, index) => ({
    sourceKind: 'sales_item',
    sourceId: index === 0 ? sourceId : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    sourceName: index === 0 ? sourceName : `Menu item ${index}`,
    catalogOrigin: 'menu',
    suggestedTarget: null,
    productCreationSuggestion: null,
  }))
  let savedMapping: Record<string, unknown> | null = null
  const submittedBodies: Array<Record<string, unknown>> = []

  await page.route((url) => url.pathname === '/api/pos/accounting', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      submittedBodies.push(body)
      const mappings = body.mappings as Array<Record<string, unknown>>
      savedMapping = {
        ...mappings[0],
        scope: body.scope,
        mappingRevision: submittedBodies.length,
        validationStatus: mappings[0].active === false ? 'unvalidated' : 'valid',
        validationReason: mappings[0].active === false ? 'Inactive mapping' : null,
      }
      await route.fulfill({ json: { ok: true, mappings: [savedMapping], changedCount: 1 } })
      return
    }
    await route.fulfill({
      json: {
        ok: true,
        capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
        accounting: {
          location: { restaurantGuid: locationId, restaurantName: 'Acceptance Restaurant', locationName: 'Downtown' },
          profile: {
            scope: 'organization_default', profileRevision: 1, postingMethod: 'itemized_sales_receipt',
            breakoutDimensions: [], trackSalesTax: true, memoMode: 'standard', customMemo: null,
            customTransactionNumber: false, transactionNumberSuffix: null, suppressZeroOverShort: true,
            autoPayoutTips: false, depositChecksWithCash: false, openCheckPolicy: 'hold',
            batchHoldPolicy: 'hold', emailNotificationsEnabled: false,
          },
          quickBooks: {
            configured: true, bound: true, companyName: 'Acceptance Books', status: 'active',
            catalog: { accounts: 0, items: 1, taxCodes: 0, classes: 0, departments: 0 },
          },
          sourceCatalog,
          mappings: savedMapping ? [savedMapping] : [],
          targets: {
            accounts: [], customers: [], vendors: [], taxCodes: [], classes: [], departments: [], locations: [],
            items: [{ id: targetId, name: targetName, fullyQualifiedName: targetName, itemType: 'NonInventory' }],
          },
          preview: { readiness: { missingMappings: [] }, salesReceipt: {}, journal: {}, evidence: {} },
          draft: null,
          draftHistory: [],
          latestCommand: null,
        },
      },
    })
  })

  await page.goto('/#pos')
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
  const closeGuide = page.getByRole('button', { name: 'Close POS guide' })
  if (await closeGuide.isVisible()) await closeGuide.click()
  await activatePos(page)
  await page.getByRole('tab', { name: 'Accounting', exact: true }).click()
  await page.getByPlaceholder('Search mappings').fill(sourceName)

  const target = page.getByRole('combobox', { name: 'QuickBooks target' })
  await target.fill(targetName)
  await target.press('Escape')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(`Select a QuickBooks target from the list for "${sourceName}" before saving.`)).toBeVisible()
  expect(submittedBodies).toHaveLength(0)

  await target.fill(targetName)
  await page.getByRole('option', { name: targetName, exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => submittedBodies.length).toBe(1)
  const submittedMappings = submittedBodies[0].mappings as Array<Record<string, unknown>>
  expect(submittedMappings).toHaveLength(1)
  expect(submittedMappings[0]).toMatchObject({
    sourceKind: 'sales_item', sourceId, sourceName,
    targetType: 'item', targetId, targetName, active: true,
  })
  await expect(target).toHaveValue(targetName)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

  const autocomplete = target.locator('xpath=ancestor::div[contains(@class,"MuiAutocomplete-root")]')
  await autocomplete.hover()
  await autocomplete.getByTitle('Clear').click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => submittedBodies.length).toBe(2)
  const clearedMappings = submittedBodies[1].mappings as Array<Record<string, unknown>>
  expect(clearedMappings).toHaveLength(1)
  expect(clearedMappings[0]).toMatchObject({ targetId, targetName, active: false })
})
