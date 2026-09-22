#!/usr/bin/env node
// Real React/MUI components, isolated API fixtures. No provider, database, or financial writes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const require = createRequire(join(root, 'app_src/package.json'))
const { chromium, expect } = require('@playwright/test')
const webpack = require('next/dist/compiled/webpack/webpack').webpack
const output = await mkdtemp(join(tmpdir(), 'clawpilot-accounting-ux-ui-'))
let browser, server
try {
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/accounting-ux-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
    res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1080, height: 960 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = [], writes = []
  page.on('pageerror', (error) => errors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  let failWorkspace = true, failTax = true, holdSubmit = false, releaseSubmit
  let holdTaxLeaf = false, releaseTaxLeaf
  let savedProfile = { exists: true, scope: 'organization_default', profileRevision: 1, trackSalesTax: true }
  let mappings = []
  await page.route('**/api/**', async (route) => {
    const req = route.request(), url = new URL(req.url())
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/tax-classifications')) {
      const parent = url.searchParams.get('parentId')
      if (parent === 'fruit' && holdTaxLeaf) await new Promise((resolve) => { releaseTaxLeaf = resolve })
      if (parent === 'food' && failTax) { failTax = false; return json({ ok: false, error: 'Temporary category failure' }, 503) }
      const rows = !parent ? [{ id: 'food', name: 'Food', parentId: null }] : parent === 'food' ? [{ id: 'fruit', name: 'Fruit', parentId: 'food' }] : []
      return json({ ok: true, categories: rows.map((row) => ({ ...row, applicableTo: ['NonInventory'], level: 1 })) })
    }
    if (url.pathname === '/api/accounting/quickbooks/actions') {
      if (req.method() === 'POST') {
        const body = req.postDataJSON(); writes.push(body)
        if (holdSubmit) await new Promise((resolve) => { releaseSubmit = resolve })
        return body.operationKind === 'item.update' ? json({ ok: true, request: { id: 'review-fixture' } })
          : json({ ok: false, error: 'A matching customer already exists. Review the customer before retrying.' }, 409)
      }
      if (failWorkspace) { failWorkspace = false; return json({ ok: false, error: 'Temporary actions failure' }, 503) }
      return json({ ok: true, capabilities: { canView: true, canPrepare: true, canManage: true, canApprove: true },
        connection: { companyName: 'Fixture', writeMode: 'disabled', postingEnabled: false, postingOperations: [], currencyCode: 'USD' }, requests: [],
        referenceData: { customers: [], items: [], accounts: [{ id: 'income-fixture', name: 'Product income', classification: 'Revenue', accountType: 'Income' }], categories: [], vendors: [] }, total: 0 })
    }
    if (url.pathname === '/api/pos/accounting') {
      if (req.method() === 'PATCH') {
        const body = req.postDataJSON(); writes.push(body)
        if (body.action === 'save-profile') { savedProfile = { ...savedProfile, ...body.profile }; return json({ ok: true, profile: savedProfile }) }
        mappings = body.mappings.map((mapping) => ({ ...mapping, scope: 'organization_default', validationStatus: 'valid' }))
        return json({ ok: true, mappings, changedCount: mappings.length })
      }
      return json({ ok: true, capabilities: { canManage: true, canPrepare: true }, accounting: {
        organizationId: 'org-fixture', location: { restaurantGuid: 'location-fixture', locationName: 'Fixture' }, profile: savedProfile,
        quickBooks: { bound: true, companyName: 'Fixture', catalog: {} }, mappings,
        targets: { accounts: [], items: [{ id: 'banana-target', name: 'Banana target', itemType: 'NonInventory' }] },
        sourceCatalog: [{ sourceKind: 'sales_item', sourceId: 'source-fixture', sourceName: 'Banana source', suggestedTarget: { id: 'banana-target', name: 'Banana target' } }],
      } })
    }
    return json({ ok: false, error: 'Unexpected fixture request' }, 404)
  })

  // Initial load errors have a recovery action; form errors stay in the visible drawer.
  await page.goto(origin)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByRole('button', { name: 'Customer', exact: true }).click()
  const drawer = page.locator('form')
  await drawer.getByRole('button', { name: 'Create draft', exact: true }).click()
  assert.equal(writes.length, 0, 'Native required-field validation prevents an empty draft request')
  await drawer.getByRole('textbox', { name: 'Display name' }).fill('Fixture customer')
  holdSubmit = true
  await drawer.getByRole('button', { name: 'Create draft', exact: true }).click()
  await expect(drawer.getByRole('button', { name: 'Preparing draft…' })).toBeDisabled()
  await expect(drawer.getByRole('textbox', { name: 'Display name' })).toBeDisabled()
  await expect.poll(() => typeof releaseSubmit).toBe('function')
  releaseSubmit(); holdSubmit = false
  await expect(drawer.getByRole('alert').filter({ hasText: 'A matching customer already exists' })).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'Display name' })).toHaveValue('Fixture customer')

  // Product edits have clear validation, no unchanged draft, nested category retry, and pending guards.
  for (const mode of ['light', 'dark']) {
    await page.goto(`${origin}/?panel=edit&mode=${mode}`)
    const dialog = page.getByRole('dialog', { name: 'Edit QuickBooks product' })
    await expect(dialog.getByRole('button', { name: 'Prepare for review' })).toBeDisabled()
    await expect(dialog.getByText('No changes yet.', { exact: false })).toBeVisible()
    await dialog.getByRole('spinbutton', { name: 'Sales price or rate' }).fill('-1')
    await expect(dialog.getByText('Enter zero or a positive price.')).toBeVisible()
    await dialog.getByRole('spinbutton', { name: 'Sales price or rate' }).fill('2')
    await dialog.getByRole('button', { name: 'Change sales tax category' }).click()
    await dialog.getByRole('combobox', { name: 'Category', exact: true }).click()
    await page.getByRole('option', { name: 'Food', exact: true }).click()
    if (mode === 'light') {
      await expect(dialog.getByText('Selected: Original category')).toBeVisible()
      await dialog.getByRole('button', { name: 'Retry categories' }).click()
    }
    await dialog.getByRole('combobox', { name: 'Subcategory 1' }).click()
    await page.getByRole('option', { name: 'Fruit', exact: true }).click()
    await expect(dialog.getByText('Selected: Food:Fruit')).toBeVisible()
    holdSubmit = true; releaseSubmit = undefined
    await dialog.getByRole('button', { name: 'Prepare for review' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Product name' })).toBeDisabled()
    await expect.poll(() => typeof releaseSubmit).toBe('function')
    releaseSubmit(); holdSubmit = false
    await expect(page.locator('body')).toHaveAttribute('data-prepared', 'review-fixture')
    assert.equal(writes.at(-1).payload.taxClassificationId, 'fruit')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${mode} edit has no mobile page overflow`)
    await page.setViewportSize({ width: 1080, height: 960 })
  }

  // Late category responses must not overwrite text entered while that selection loads.
  await page.goto(origin)
  await page.getByRole('button', { name: 'Product', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Name', exact: true }).fill('Fresh product')
  await drawer.getByRole('combobox', { name: /^Type\b/ }).click()
  await page.getByRole('option', { name: 'Non-inventory', exact: true }).click()
  await drawer.getByRole('combobox', { name: 'Income account' }).click()
  await page.getByRole('option', { name: 'Product income', exact: true }).click()
  await drawer.getByRole('button', { name: 'Choose sales tax category' }).click()
  // The product-category select already exists while the async tax roots load.
  // Wait for both controls before choosing the tax-category select.
  await expect(drawer.getByRole('combobox', { name: 'Category', exact: true })).toHaveCount(2)
  await drawer.getByRole('combobox', { name: 'Category', exact: true }).last().click()
  await page.getByRole('option', { name: 'Food', exact: true }).click()
  holdTaxLeaf = true
  await drawer.getByRole('combobox', { name: 'Subcategory 1' }).click()
  await page.getByRole('option', { name: 'Fruit', exact: true }).click()
  await expect.poll(() => typeof releaseTaxLeaf).toBe('function')
  await drawer.getByRole('textbox', { name: 'SKU', exact: true }).fill('LATE-EDIT')
  releaseTaxLeaf(); holdTaxLeaf = false
  await expect(drawer.getByText('Selected: Food:Fruit')).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'SKU', exact: true })).toHaveValue('LATE-EDIT')
  await drawer.getByRole('button', { name: 'Create draft', exact: true }).click()
  await expect(drawer.getByRole('alert').filter({ hasText: 'A matching customer already exists' })).toBeVisible()
  assert.equal(writes.at(-1).operationKind, 'item.create')
  assert.equal(writes.at(-1).payload.sku, 'LATE-EDIT')
  assert.equal(writes.at(-1).payload.taxClassificationId, 'fruit')

  // POS profile changes and mappings remain separate, with visible persistence guidance.
  for (const mode of ['light', 'dark']) {
    await page.goto(`${origin}/?panel=pos&mode=${mode}`)
    await expect(page.getByText('Showing saved posting configuration.', { exact: false })).toBeVisible()
    const panel = page.getByText('Posting configuration', { exact: true }).locator('xpath=../../../..')
    const color = await panel.evaluate((element) => getComputedStyle(element).backgroundColor)
    assert.equal(color, mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(18, 18, 18)', 'Posting surface resolves theme palette')
    await page.getByLabel('Track sales tax', { exact: true }).click()
    await expect(page.getByText('Unsaved profile changes', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByText('Unsaved profile changes', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Showing saved posting configuration.', { exact: false })).toBeVisible()
    await page.getByRole('textbox', { name: 'Search catalog mappings' }).fill('no matching product')
    await page.getByRole('button', { name: 'Clear mapping search' }).click()
    await expect(page.getByText('Banana source', { exact: true })).toBeVisible()
    if (mode === 'light') {
      await page.getByRole('button', { name: 'Save 1 suggestion', exact: true }).click()
      await expect(page.getByText('1/1 saved mappings', { exact: true })).toBeVisible()
    }
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${mode} POS has no mobile page overflow`)
    await page.setViewportSize({ width: 1080, height: 960 })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: real Accounting/POS UI load retry, visible draft errors, required fields, pending freeze, product edit validation, tax-category retry/late-edit preservation, profile/mapping persistence guidance, light/dark surfaces and mobile width')
} finally {
  await browser?.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(output, { recursive: true, force: true })
}
