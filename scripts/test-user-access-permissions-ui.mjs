#!/usr/bin/env node
// Real React/MUI permission editing with isolated API mocks; no user or provider mutations.
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
const output = await mkdtemp(join(tmpdir(), 'clawpilot-user-access-ui-'))
let browser, server
try {
  await new Promise((done, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/user-access-permissions-ui.tsx'),
      output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : done()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = []
  const mutations = []
  let failAccess = false
  let rootAdmin = true
  const owner = { email: 'owner@example.test', role: 'owner', status: 'active', displayName: 'Owner', organizationId: 'org-a', organizationName: 'Org A', permissions: {}, timezone: 'America/New_York', locale: 'en-US' }
  let member = { ...owner, email: 'member@example.test', role: 'member', displayName: 'Member', permissions: {
    createBoards: true, createPipelines: true, viewOperations: true, executeWarehouse: true,
    viewShipping: true, createShipments: true, purchaseLivePostage: true,
    viewAccounting: true, prepareAccounting: true,
  } }
  page.on('pageerror', (error) => { errors.push(error.message) })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/session') return json({ ok: true, isRootAdmin: rootAdmin,
      authenticatedUser: { email: owner.email }, effectiveUser: { email: owner.email }, impersonation: { active: false } })
    if (url.pathname === '/api/users') {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON()
        mutations.push(body)
        if (failAccess) return json({ ok: false, error: 'Access update was rejected' }, 409)
        member = { ...member, role: body.role, permissions: body.permissions }
        return json({ ok: true, user: member })
      }
      return json({ ok: true, currentUser: owner, isAdmin: true, canInvite: false,
        canManageUserAccess: true, currentOrganization: { id: 'org-a', name: 'Org A' },
        workspaceOrganizations: [], users: [owner, member] })
    }
    return json({ ok: true, boards: [], pipelines: [] })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.goto(origin)
  await expect(page.getByRole('region', { name: 'Projects permissions for member@example.test' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Pipeline and CRM permissions for member@example.test' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Accounting and POS permissions for member@example.test' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Architecture' })).toBeVisible()
  await page.evaluate(() => {
    document.body.dataset.sessionRefreshes = '0'
    window.addEventListener('clawpilot:session-refresh', () => {
      document.body.dataset.sessionRefreshes = String(Number(document.body.dataset.sessionRefreshes) + 1)
    })
  })
  const memberSwitch = (label) => page.getByLabel(`${label} for member@example.test`, { exact: true })
  await expect(memberSwitch('View projects in Projects')).toBeChecked()
  await memberSwitch('View projects in Projects').click()
  await expect(memberSwitch('View projects in Projects')).not.toBeChecked()
  await expect(memberSwitch('Create boards in Projects')).not.toBeChecked()
  assert.equal(mutations.at(-1).permissions.viewProjects, false)
  assert.equal(mutations.at(-1).permissions.createBoards, false)
  await memberSwitch('Create boards in Projects').click()
  await expect(memberSwitch('View projects in Projects')).toBeChecked()
  assert.equal(mutations.at(-1).permissions.viewProjects, true)
  assert.equal(mutations.at(-1).permissions.createBoards, true)
  await memberSwitch('View pipeline and CRM in Pipeline and CRM').click()
  assert.equal(mutations.at(-1).permissions.createPipelines, false)
  await memberSwitch('View accounting data in Accounting and POS').click()
  assert.equal(mutations.at(-1).permissions.prepareAccounting, false)
  await memberSwitch('View shipping in Shipping').click()
  assert.equal(mutations.at(-1).permissions.createShipments, false)
  assert.equal(mutations.at(-1).permissions.purchaseLivePostage, false)
  await expect(memberSwitch('Manage operations in Operations')).toBeDisabled()
  const refreshesBeforeFailure = Number(await page.locator('body').getAttribute('data-session-refreshes'))
  failAccess = true
  await memberSwitch('View docs in Docs').click()
  await expect(page.getByText('Access update was rejected')).toBeVisible()
  await expect(memberSwitch('View docs in Docs')).toBeChecked()
  assert.equal(Number(await page.locator('body').getAttribute('data-session-refreshes')), refreshesBeforeFailure)
  rootAdmin = false
  await page.reload()
  await expect(page.getByRole('tab', { name: 'Architecture' })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile permission editor has no horizontal overflow')
  assert.deepEqual(errors, [])
  console.log('PASS: grouped module permissions, dependency autosave, role controls, failed-save rollback, root-only architecture tab, and mobile width')
} finally {
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  await rm(output, { recursive: true, force: true })
}
