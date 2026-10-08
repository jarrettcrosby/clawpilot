#!/usr/bin/env node
// Real built Diagram Design viewer with real response CSP; mocked owner session only.
// This is not evidence of deployed authentication or full Settings navigation.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { architectureHarness, root } from './lib/architecture-test-harness.mjs'

const require = createRequire(`${root}/app_src/package.json`)
const { chromium, expect } = require('@playwright/test')
const { viewer, metadata } = architectureHarness()
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html')
    const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}iframe{display:block;width:100%;height:min(72vh,900px);min-height:460px;border:0}</style></head><body><iframe title="Architecture" sandbox="allow-scripts" src="/api/settings/architecture/viewer?theme=${theme}"></iframe></body></html>`)
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
  await expect(frame.locator('#diagram-design-root')).not.toBeEmpty()
  const views = ['index', 'orders', 'accounting', 'email', 'meetings', 'access', 'domains']
  const screenshots = `${root}/output/architecture-preview`
  await mkdir(screenshots, { recursive: true })
  for (const theme of ['light', 'dark']) {
    await frame.locator('#theme-select').selectOption(theme)
    await expect(frame.locator('html')).toHaveAttribute('data-theme', theme)
    for (const view of views) {
      await frame.locator('#diagram-select').selectOption(view)
      const section = frame.locator(`[data-view="${view}"]`)
      await expect(section).toBeVisible()
      await expect(section.locator('svg')).toBeVisible()
      assert.equal(await frame.locator('[data-view]:visible').count(), 1)
      const geometry = await section.evaluate((element) => {
        const svg = element.querySelector('svg')
        const scroller = element.querySelector('.diagram-container')
        const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
        const clipped = [...svg.querySelectorAll('.node text')].filter((text) => {
          const bounds = text.getBBox(); const shape = text.parentElement.querySelector('rect,path').getBBox()
          return bounds.x < shape.x || bounds.x + bounds.width > shape.x + shape.width || bounds.y < shape.y || bounds.y + bounds.height > shape.y + shape.height
        }).map((text) => text.textContent)
        return { canvas: svg.viewBox.baseVal.width, minWidth: Number.parseFloat(getComputedStyle(svg).minWidth),
          localScroller: getComputedStyle(scroller).overflowX, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          duplicateIds: ids.length !== new Set(ids).size, clipped,
          titleFirst: svg.firstElementChild.tagName === 'title', accessible: svg.getAttribute('aria-labelledby').split(' ').every((id) => document.getElementById(id)),
          relationshipDescription: svg.querySelector('desc').textContent.includes('Relationships:') }
      })
      assert.equal(geometry.minWidth, geometry.canvas, `${view}: preserve readable width`)
      assert.equal(geometry.localScroller, 'auto')
      assert.equal(geometry.pageOverflow, false, `${view}: no document overflow`)
      assert.equal(geometry.duplicateIds, false)
      assert.equal(geometry.titleFirst, true)
      assert.equal(geometry.accessible, true)
      assert.equal(geometry.relationshipDescription, true, `${view}: text alternative explains relationships`)
      assert.deepEqual(geometry.clipped, [], `${view}: node labels fit`)
      await section.locator('.diagram-container').screenshot({ path: `${screenshots}/${view}-${theme}.png` })
    }
  }
  await frame.locator('#theme-select').selectOption('app')
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.goto(`${origin}/?theme=light`)
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.setViewportSize({ width: 390, height: 844 })
  for (const view of views) {
    await frame.locator('#diagram-select').selectOption(view)
    const section = frame.locator(`[data-view="${view}"]`)
    const scroll = section.locator('.diagram-container')
    const dimensions = await scroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      return { moved: element.scrollLeft > 0, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        toolbarVisible: document.getElementById('diagram-select').getBoundingClientRect().right <= document.documentElement.clientWidth }
    })
    assert.equal(dimensions.moved, true, `${view}: right-hand content reachable on phone`)
    assert.equal(dimensions.pageOverflow, false)
    assert.equal(dimensions.toolbarVisible, true)
  }
  await page.screenshot({ path: `${screenshots}/mobile-light.png` })
  assert.deepEqual(errors, [], 'Viewer must render without runtime errors')
  assert.deepEqual(policyViolations, [], 'Viewer must work with the delivered CSP')
  assert(requests.every((url) => {
    const parsed = new URL(url)
    return parsed.origin === origin && ['/', '/api/settings/architecture/viewer'].includes(parsed.pathname)
  }), `No network or static assets: ${requests.join(', ')}`)
  for (const path of ['/server-assets/architecture/viewer.html', '/_next/static/architecture/viewer.html', '/api/settings/architecture/viewer/assets/index.js', '/api/settings/architecture/viewer/../../model.c4']) {
    assert.equal((await page.request.get(`${origin}${path}`)).status(), 404, `No extra model/asset path: ${path}`)
  }
  console.log('Diagram Design: seven views render in light/dark; accessible labels fit; mobile local scrolling; offline CSP, zero asset/network requests and no public model paths')
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
}
