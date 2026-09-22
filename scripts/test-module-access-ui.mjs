// Real shell, navigation, session guard and dashboard with isolated API fixtures.
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
const output = await mkdtemp(join(tmpdir(), 'clawpilot-module-access-ui-'))
const moduleIds = ['dashboard', 'docs', 'projects', 'pipeline', 'crm', 'accounting', 'pos', 'operations', 'shipping', 'links', 'agents', 'versions']
const capabilities = (...allowed) => Object.fromEntries(moduleIds.map((id) => [id, id === 'dashboard' || allowed.includes(id)]))
let browser, server
try {
  const sectionStub = join(root, 'scripts/fixtures/module-access-section.tsx')
  const aliases = Object.fromEntries([
    'docs/DocsSection', 'projects/KanbanBoard', 'versions/VersionsSection', 'dashboard/DashboardSection',
    'pipeline/PipelineSection', 'agents/AgentsSection', 'links/ShortLinksSection', 'crm/CrmSection',
    'accounting/AccountingSection', 'pos/PosSection', 'operations/OperationsSection', 'shipping/ShippingSection',
  ].map((name) => [`@/components/${name}$`, sectionStub]))
  await new Promise((done, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/module-access-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: {
        ...aliases, '@/components/AppHeader$': join(root, 'scripts/fixtures/module-access-header.tsx'),
        '@/components/auth/ImpersonationBanner$': join(root, 'scripts/fixtures/module-access-provider.tsx'),
        '@/components/timezone/UserDateTimeProvider$': join(root, 'scripts/fixtures/module-access-provider.tsx'), '@': join(root, 'app_src'),
      } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : done()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = [], reads = []
  page.on('pageerror', (error) => errors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  let current = capabilities('docs', 'operations'), workspace = 'org-a', pendingSession = null, holdSession = false
  let sessionUnavailable = false, malformedSession = false
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    reads.push(pathname)
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === '/api/auth/session') {
      if (sessionUnavailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false }) })
      if (malformedSession) return json({ ok: true, activeWorkspace: { organizationId: workspace } })
      const body = { ok: true, moduleCapabilities: current, activeWorkspace: { organizationId: workspace } }
      if (holdSession) { pendingSession = () => json(body); holdSession = false; return }
      return json(body)
    }
    if (pathname === '/api/users') return json({ currentUser: { displayName: 'Member', email: 'member@example.test' } })
    if (pathname === '/api/workspaces') return json({ boards: [], pipelines: [], selectedBoardId: null, selectedPipelineId: null })
    if (pathname === '/api/pipeline') return json({ summary: { opportunities: 1 } })
    if (pathname === '/api/docs' || pathname === '/api/tasks') return json([])
    return json({ ok: true })
  })
  await page.goto(`${origin}/#projects`)
  await expect(page.getByText('You do not have access to this module', { exact: false })).toBeVisible()
  await expect(page.getByTestId('module-content')).toHaveCount(0)
  await expect(page.getByTestId('nav-desktop-projects')).toHaveCount(0)
  await expect(page.getByTestId('nav-desktop-docs')).toBeVisible()
  await page.keyboard.press('3')
  await expect(page.getByTestId('module-content')).toHaveCount(0)
  await page.getByTestId('nav-desktop-docs').click()
  await expect(page.getByTestId('module-content')).toHaveText('#docs')
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await page.getByTestId('nav-desktop-operations').click()
  await expect(page.getByRole('menu', { name: 'Operations submodules' })).toBeVisible()
  current = capabilities('docs')
  await page.evaluate(() => dispatchEvent(new Event('clawpilot:session-refresh')))
  await expect(page.getByRole('menu', { name: 'Operations submodules' })).toHaveCount(0)
  await expect(page.getByTestId('nav-desktop-operations')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('nav-bottom-projects')).toHaveCount(0)
  await page.getByTestId('nav-bottom-more').click()
  await expect(page.getByTestId('nav-mobile-docs')).toBeVisible()
  await expect(page.getByTestId('nav-mobile-projects')).toHaveCount(0)
  await page.getByTestId('mobile-navigation-close').click()
  // An old workspace session response cannot restore revoked/new-workspace menus.
  holdSession = true
  await page.evaluate(() => dispatchEvent(new Event('clawpilot:session-refresh')))
  await expect.poll(() => Boolean(pendingSession)).toBe(true)
  workspace = 'org-b'; current = capabilities('projects')
  await page.evaluate(() => dispatchEvent(new CustomEvent('clawpilot:workspace-changed', { detail: { organizationId: 'org-b', organizationName: 'Org B' } })))
  await expect(page.getByTestId('nav-bottom-projects')).toBeVisible()
  await pendingSession(); pendingSession = null
  await expect(page.getByTestId('nav-mobile-docs')).toHaveCount(0)
  await expect(page.getByTestId('nav-bottom-projects')).toBeVisible()
  // Failed initial verification does not expose modules or sign the user out;
  // Retry can recover once authority is available. Malformed success is denied.
  sessionUnavailable = true
  await page.goto(`${origin}/?session-check=unavailable#projects`)
  await expect(page.getByText('Workspace access could not be verified.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('module-content')).toHaveCount(0)
  assert.equal(new URL(page.url()).pathname, '/')
  sessionUnavailable = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByTestId('module-content')).toHaveText('#projects')
  malformedSession = true
  await page.goto(`${origin}/?session-check=malformed#projects`)
  await expect(page.getByText('Workspace access could not be verified.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('module-content')).toHaveCount(0)
  await expect(page.getByTestId('nav-bottom-projects')).toHaveCount(0)
  malformedSession = false
  // Real dashboard omits forbidden widgets and never requests their data.
  reads.length = 0
  await page.goto(`${origin}/?dashboard=1&allow=docs`)
  await expect(page.getByText('Documents', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View docs', exact: true })).toBeVisible()
  await expect(page.getByText('Project Board', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Pipeline', { exact: true })).toHaveCount(0)
  await expect.poll(() => reads.includes('/api/docs')).toBe(true)
  assert.equal(reads.includes('/api/tasks'), false)
  assert.equal(reads.includes('/api/pipeline'), false)
  reads.length = 0
  await page.goto(`${origin}/?dashboard=1`)
  await expect(page.getByText('Your account is active.', { exact: false })).toBeVisible()
  assert.equal(reads.includes('/api/docs'), false)
  assert.equal(reads.includes('/api/tasks'), false)
  assert.equal(reads.includes('/api/pipeline'), false)
  assert.deepEqual(errors, [])
  console.log('PASS module access real shell: denied deep links/shortcuts, desktop/mobile/flyout filtering, workspace response race, failed/malformed authority and Retry, dashboard read isolation')
} finally {
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  await rm(output, { recursive: true, force: true })
}
