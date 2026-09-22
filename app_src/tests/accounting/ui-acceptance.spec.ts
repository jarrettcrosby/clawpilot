import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const authPassword = process.env.UI_AUTH_PASSWORD
const operatorSecret = process.env.UI_OPERATOR_SECRET

async function authenticateIfConfigured(page: Page) {
  if (!authPassword || !operatorSecret) return
  const response = await page.request.post('/api/auth/login', {
    data: { password: authPassword },
    headers: { 'x-clawpilot-operator-secret': operatorSecret },
    failOnStatusCode: false,
  })
  expect(response.ok(), `UI authentication failed with HTTP ${response.status()}`).toBeTruthy()
}

async function activateAccounting(page: Page) {
  await page.evaluate(() => {
    const oldURL = window.location.href
    const nextURL = new URL(oldURL)
    nextURL.hash = 'accounting'
    window.history.replaceState({}, '', nextURL)
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: nextURL.toString() }))
  })
}

test('QuickBooks tax picker commits only a nested leaf and preserves the choice while browsing', async ({ page }) => {
  const productName = 'Banana tax picker fixture'
  const originalCategory = 'Existing sales tax category'
  const pages: Record<string, Array<Record<string, unknown>>> = {
    root: [
      { id: 'root-food', name: 'Food & beverages', level: 1, parentId: null },
      { id: 'root-other', name: 'Other sales', level: 1, parentId: null },
    ],
    'root-food': [{ id: 'level-2', name: 'Prepared food', level: 2, parentId: 'root-food' }],
    'level-2': [{ id: 'level-3', name: 'Bakery', level: 3, parentId: 'level-2' }],
    'level-3': [{ id: 'level-4', name: 'Bread', level: 4, parentId: 'level-3' }],
    'level-4': [],
    'root-other': [{ id: 'other-leaf', name: 'Miscellaneous', level: 2, parentId: 'root-other' }],
    'other-leaf': [],
  }
  const requestedParents: string[] = []
  const captured: { preparedPayload: Record<string, unknown> | null } = { preparedPayload: null }

  await authenticateIfConfigured(page)
  await page.route((url) => url.pathname === '/api/accounting/quickbooks', (route) => {
    const view = new URL(route.request().url()).searchParams.get('view')
    if (view === 'products') {
      return route.fulfill({ json: {
        ok: true,
        capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
        result: { page: 1, pageSize: 25, total: 1, rows: [{
          id: 'qbo-item-1', syncToken: '4', name: productName, sku: 'BANANA',
          description: 'Original description', unitPrice: 1.25, purchaseCost: 0.5,
          taxable: true, active: true, itemType: 'NonInventory',
          taxClassificationId: 'old-leaf', taxClassificationName: originalCategory,
        }] },
      } })
    }
    return route.fulfill({ json: {
      ok: true,
      capabilities: { canView: true, canManage: true, canPrepare: true, canApprove: true },
      overview: {
        connection: { configured: true, companyName: 'Fixture QuickBooks', status: 'active' },
        currencyCode: 'USD',
        counts: { accounts: 0, products: 1, customers: 0, vendors: 0, transactions: 0, attachments: 0, reports: 0, reportErrors: 0 },
        metrics: { invoiced: 0, receivedSales: 0, expenses: 0, openInvoices: 0, overdueInvoices: 0, openInvoiceCount: 0, overdueInvoiceCount: 0 },
        trend: [], transactionTypes: [], recent: [],
      },
    } })
  })
  await page.route((url) => url.pathname === '/api/accounting/quickbooks/tax-classifications', (route) => {
    const parentId = new URL(route.request().url()).searchParams.get('parentId') || 'root'
    requestedParents.push(parentId)
    const categories = (pages[parentId] || []).map((row) => ({
      code: null, description: null, parentName: null, applicableTo: ['NonInventory'], ...row,
    }))
    return route.fulfill({ json: { ok: true, categories } })
  })
  await page.route((url) => url.pathname === '/api/accounting/quickbooks/actions', (route) => {
    if (route.request().method() === 'POST') {
      captured.preparedPayload = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ json: { ok: true, request: { id: 'prepared-tax-edit' } } })
    }
    return route.fulfill({ json: { ok: true, requests: [] } })
  })

  await page.goto('/#accounting')
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await activateAccounting(page)
  await page.getByRole('tab', { name: 'Products & services' }).click()
  await page.getByRole('table', { name: 'products table' }).getByText(productName).click()
  await page.getByRole('button', { name: 'Edit product · prepare for review' }).click()

  const dialog = page.getByRole('dialog', { name: 'Edit QuickBooks product' })
  await expect(dialog.getByText(`Selected: ${originalCategory}`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Change sales tax category' }).click()

  async function choose(level: string, name: string) {
    await dialog.getByRole('combobox', { name: new RegExp(`^${level}\\b`) }).click()
    await page.getByRole('option', { name, exact: true }).click()
  }

  await choose('Category', 'Food & beverages')
  await expect(dialog.getByRole('combobox', { name: 'Subcategory 1' })).toBeVisible()
  await expect(dialog.getByText(`Selected: ${originalCategory}`)).toBeVisible()
  await choose('Subcategory 1', 'Prepared food')
  await expect(dialog.getByRole('combobox', { name: 'Subcategory 2' })).toBeVisible()
  await expect(dialog.getByText(`Selected: ${originalCategory}`)).toBeVisible()
  await choose('Subcategory 2', 'Bakery')
  await expect(dialog.getByRole('combobox', { name: 'Subcategory 3' })).toBeVisible()
  await expect(dialog.getByText(`Selected: ${originalCategory}`)).toBeVisible()
  await choose('Subcategory 3', 'Bread')

  const fullPath = 'Food & beverages:Prepared food:Bakery:Bread'
  await expect(dialog.getByText(`Selected: ${fullPath}`)).toBeVisible()
  await choose('Category', 'Other sales')
  await expect(dialog.getByRole('combobox', { name: 'Subcategory 1' })).toBeVisible()
  await expect(dialog.getByText(`Selected: ${fullPath}`)).toBeVisible()
  await choose('Category', 'Food & beverages')
  await expect(dialog.getByText(`Selected: ${fullPath}`)).toBeVisible()

  await dialog.getByRole('button', { name: 'Prepare for review' }).click()
  await expect.poll(() => captured.preparedPayload).not.toBeNull()
  expect(captured.preparedPayload?.operationKind).toBe('item.update')
  expect(captured.preparedPayload?.payload).toMatchObject({
    itemId: 'qbo-item-1', expectedSyncToken: '4',
    taxClassificationId: 'level-4', taxClassificationParentId: 'level-3',
  })
  expect(requestedParents).toEqual(['root', 'root-food', 'level-2', 'level-3', 'level-4', 'root-other', 'root-food'])
})
