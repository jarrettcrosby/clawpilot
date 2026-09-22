#!/usr/bin/env node
// Real React/MUI UI with isolated API mocks; no messages, user mutations, or deployment.
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
const output = await mkdtemp(join(tmpdir(), 'clawpilot-user-lifecycle-ui-'))
let browser, server
try {
  await new Promise((done, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/user-lifecycle-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : done()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>') })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = []
  const mutations = []
  page.on('pageerror', (error) => { errors.push(error.message); console.error('UI runtime:', error.message) })
  const origin = `http://127.0.0.1:${server.address().port}`
  let failVerification = false, trashed = false, changeEnabled = false
  const owner = { email: 'owner@example.test', role: 'owner', status: 'active', displayName: 'Owner', organizationId: 'org-a', organizationName: 'Org A', permissions: {}, timezone: 'America/New_York', locale: 'en-US' }
  const member = { ...owner, email: 'member@example.test', role: 'member', displayName: 'Member' }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/login-email') {
      if (request.method() === 'GET') return json({ ok: true, loginEmail: owner.email, changeEnabled,
        changeUnavailableReason: changeEnabled ? null : 'Login email changes are temporarily unavailable while the authentication rollout is being verified. Your current sign-in address still works.' })
      const body = request.postDataJSON(); mutations.push(body)
      if (failVerification) return json({ ok: false, error: 'Verification was rejected' }, 400)
      return json(request.method() === 'POST' ? { ok: true, pendingEmail: body.email } : { ok: true, loginEmail: body.email, signInRequired: true })
    }
    if (url.pathname === '/api/users') {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); mutations.push(body); trashed = body.action === 'trash-user'
        return json({ ok: true, user: { ...member, trashedAt: trashed ? new Date().toISOString() : null } })
      }
      return json({ ok: true, currentUser: owner, currentOrganization: { id: 'org-a', name: 'Org A' }, isAdmin: true, canInvite: true, canManageUserAccess: true, workspaceOrganizations: [],
        users: url.searchParams.get('view') === 'trash' ? (trashed ? [{ ...member, status: 'disabled', trashedAt: new Date().toISOString() }] : []) : [owner, ...(trashed ? [] : [member])] })
    }
    return json({ ok: true, boards: [], pipelines: [] })
  })
  await page.goto(origin)
  await expect(page.getByText('Current sign-in address: owner@example.test')).toBeVisible()
  await expect(page.getByText('Login email changes are temporarily unavailable', { exact: false })).toBeVisible()
  await expect(page.getByLabel('New login email', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send verification code', exact: true })).toBeDisabled()
  assert.equal(mutations.length, 0, 'Default-off UI does not issue a verification request')
  changeEnabled = true
  await page.reload()
  await expect(page.getByLabel('New login email', { exact: true })).toBeEnabled()
  await page.getByLabel('New login email', { exact: true }).fill('new@example.test')
  await page.getByRole('button', { name: 'Send verification code', exact: true }).click()
  await expect(page.getByText('Enter the six-digit code sent to new@example.test.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Verify and change login email' })).toBeDisabled()
  await page.getByLabel('Login email verification code').fill('123456')
  failVerification = true
  await page.getByRole('button', { name: 'Verify and change login email' }).click()
  await expect(page.getByText('Verification was rejected')).toBeVisible()
  failVerification = false
  await page.getByRole('button', { name: 'Verify and change login email' }).click()
  await expect(page.locator('body')).toHaveAttribute('data-navigation', '/login?email=new%40example.test')
  await page.goto(`${origin}/?people=1`)
  await page.getByRole('button', { name: 'Trashed users', exact: true }).click()
  await expect(page.getByText('No trashed users.')).toBeVisible()
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Trashed users', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore user', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore user', exact: true }).click()
  await expect(page.getByText('No trashed users.')).toBeVisible()
  await page.getByRole('button', { name: 'Users', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Move member@example.test to Trash', exact: true })).toBeVisible()
  assert.deepEqual(mutations.slice(-2).map((body) => [body.action, body.email, body.organizationId]), [['trash-user', 'member@example.test', 'org-a'], ['restore-user', 'member@example.test', 'org-a']])
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile viewport has no horizontal overflow')
  assert.deepEqual(errors, [])
  console.log('PASS: real React default-off login-change state, enabled verification/retry/navigation, organization Trash/Restore, empty states and mobile width')
} finally {
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  await rm(output, { recursive: true, force: true })
}
