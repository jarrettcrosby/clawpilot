#!/usr/bin/env node
// Real compiled LikeC4 viewer with real response CSP; mocked owner session only.
// This is not evidence of deployed authentication or full Settings navigation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { architectureHarness, root } from './lib/architecture-test-harness.mjs'

const require = createRequire(`${root}/app_src/package.json`)
const { chromium, expect } = require('@playwright/test')
const { viewer, metadata } = architectureHarness()
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><iframe title="Architecture" sandbox="allow-scripts" style="width:1200px;height:850px" src="/api/settings/architecture/viewer"></iframe>')
    return
  }
  const route = url.pathname === '/api/settings/architecture/viewer' ? viewer : url.pathname === '/api/settings/architecture' ? metadata : null
  if (!route) { response.writeHead(404); response.end('Not found'); return }
  const result = await route.GET(new Request(url, { headers: request.headers }))
  response.writeHead(result.status, Object.fromEntries(result.headers))
  response.end(Buffer.from(await result.arrayBuffer()))
})
let browser
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1300, height: 950 } })
  const requests = []; const errors = []; const policyViolations = []
  page.on('request', (request) => requests.push(request.url()))
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|Refused to|blocked/i.test(message.text())) policyViolations.push(message.text()) })
  await page.goto(origin)
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#likec4-root')).not.toBeEmpty({ timeout: 15000 })
  await expect(frame.getByText('ClawPilot system context', { exact: true }).first()).toBeVisible({ timeout: 15000 })
  for (const view of ['index', 'runtimeData', 'commerceAccounting', 'domainsAndEnvironments']) {
    await frame.locator(`a[href$="#/view/${view}/"]`).first().click()
    await expect(frame.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 })
    console.log(`Rendered ${view}: ${await frame.locator('.react-flow__node').count()} diagram nodes`)
    await page.goto(origin)
    await expect(frame.getByText('ClawPilot system context', { exact: true }).first()).toBeVisible({ timeout: 15000 })
  }
  assert.deepEqual(errors, [], 'Viewer must render without runtime errors')
  assert.deepEqual(policyViolations, [], 'Viewer must work with the delivered CSP')
  assert(requests.every((url) => url === `${origin}/` || url.startsWith(`${origin}/api/settings/architecture/viewer`)), `No network or static assets: ${requests.join(', ')}`)
  for (const path of ['/server-assets/architecture/viewer.html', '/_next/static/architecture/viewer.html', '/api/settings/architecture/viewer/assets/index.js', '/api/settings/architecture/viewer/../../model.c4']) {
    assert.equal((await page.request.get(`${origin}${path}`)).status(), 404, `No extra model/asset path: ${path}`)
  }
  console.log('Real LikeC4 private iframe: renders with offline CSP and no asset/network requests; no public/model paths')
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
