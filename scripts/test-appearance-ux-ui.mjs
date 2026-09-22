// Render real customer controls: theme persistence, device preference, responsive
// navigation/login and an honest retry state when project data cannot load.
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
const output = await mkdtemp(join(tmpdir(), 'clawpilot-appearance-ux-'))
let browser, server
try {
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: 'development', devtool: false, cache: false,
      entry: join(root, 'scripts/fixtures/appearance-ux-ui.tsx'), output: { path: output, filename: 'fixture.js' },
      resolve: { extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'], modules: [join(root, 'app_src/node_modules'), 'node_modules'], alias: { '@': join(root, 'app_src') } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()))
  })
  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let tasksUnavailable = true
  let tasksForbidden = false
  const taskBackedRequests = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/tasks') return route.fulfill({ status: tasksForbidden ? 403 : tasksUnavailable ? 503 : 200, contentType: 'application/json', body: tasksForbidden ? '{"error":"Projects access required"}' : tasksUnavailable ? '{"error":"temporarily unavailable"}' : '[]' })
    if (path === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'assistant', name: 'Workspace assistant', summary: 'Authorized agent roster', status: 'not connected', owner: 'operator' }], runtime: { provider: 'openai-codex', ready: false, status: 'not-configured', label: 'Connect ChatGPT to continue', auth: { connected: false } } } })
    if (/^\/api\/agents\/(threads|assignments|repository-runs)/.test(path)) taskBackedRequests.push(path)
    if (path === '/api/workspaces') return route.fulfill({ json: { ok: true, boards: [{ id: 'board-1', name: 'Project board', ownerEmail: 'owner@example.test', accessRole: 'owner' }], pipelines: [], selectedBoardId: 'board-1', selectedPipelineId: null } })
    return route.fulfill({ json: {} })
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.goto(origin)
  await expect(page.getByText('We could not load this project board.', { exact: false })).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/light/)
  tasksUnavailable = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('0 tasks', { exact: true })).toBeVisible()
  const choose = async label => {
    await page.getByRole('combobox', { name: 'Appearance' }).click()
    await page.getByRole('option', { name: label, exact: true }).click()
  }
  await choose('Dark')
  await expect(page.locator('html')).toHaveClass(/dark/)
  assert.equal(await page.evaluate(() => localStorage.getItem('clawpilot-color-mode')), 'dark')
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(15, 15, 19)')
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await choose('Light')
  await expect(page.locator('html')).toHaveClass(/light/)
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(246, 247, 251)')
  assert.equal(await page.getByTestId('desktop-navigation-paper').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)')
  const newTaskButton = page.getByRole('button', { name: 'New task', exact: true })
  assert.equal(await newTaskButton.evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'Primary task action has contrasting light-mode text')
  await newTaskButton.click()
  assert.equal(await page.getByRole('button', { name: 'Create task', exact: true }).evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'Create task action has contrasting light-mode text')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await choose('Use device setting')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass(/light/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('nav-bottom-more').click()
  await expect(page.getByTestId('nav-mobile-crm')).toBeVisible()
  await page.getByTestId('mobile-navigation-close').click()
  await page.goto(`${origin}/?screen=login`)
  await expect(page.getByRole('button', { name: 'Email sign-in code' })).toBeVisible()
  for (const mode of ['Dark', 'Light']) {
    await choose(mode)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} mobile login should not scroll horizontally`)
    const colors = await page.locator('main').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    assert.notEqual(colors.background, colors.color)
  }
  tasksForbidden = true
  await page.goto(`${origin}/?screen=agents`)
  await expect(page.getByText('Agent and provider settings are available.', { exact: false })).toBeVisible()
  await expect(page.getByText('1 agents', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  assert.deepEqual(taskBackedRequests, [], 'Projects-denied Agents view does not request task-backed endpoints')
  tasksForbidden = false
  tasksUnavailable = true
  await page.reload()
  await expect(page.getByText('Unable to load project tasks. Please try again.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeEnabled()
  tasksUnavailable = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('Unable to load project tasks. Please try again.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('No open tasks assigned to this agent.', { exact: true })).toBeVisible()
  assert.deepEqual(errors, [])
  console.log('PASS appearance UX: persistent light/dark/system modes, OS changes, themed sidebar, mobile login/navigation and project-load Retry')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(output, { recursive: true, force: true })
}
