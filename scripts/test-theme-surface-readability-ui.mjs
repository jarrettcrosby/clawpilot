// Render the real Docs reader and Pipeline setup dialog under both color schemes.
// Every text-bearing surface must retain WCAG AA contrast when device mode changes.
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
const output = await mkdtemp(join(tmpdir(), 'clawpilot-theme-surface-'))
let browser, server

async function contrastRatio(locator) {
  return locator.evaluate((element) => {
    const parse = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/)
      if (!match) throw new Error(`Unsupported computed color: ${value}`)
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number)
      return { red: parts[0], green: parts[1], blue: parts[2], alpha: parts[3] ?? 1 }
    }
    const composite = (foreground, background) => {
      const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
      if (alpha === 0) return { red: 255, green: 255, blue: 255, alpha: 1 }
      return {
        red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / alpha,
        green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / alpha,
        blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / alpha,
        alpha,
      }
    }
    const effectiveBackground = (start) => {
      const layers = []
      for (let current = start; current; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor)
        if (color.alpha > 0) layers.push(color)
      }
      let result = { red: 255, green: 255, blue: 255, alpha: 1 }
      for (const layer of layers.reverse()) result = composite(layer, result)
      return result
    }
    const luminance = (color) => {
      const channel = (value) => {
        const normalized = value / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
    }
    const background = effectiveBackground(element)
    const foreground = composite(parse(getComputedStyle(element).color), background)
    const lighter = Math.max(luminance(foreground), luminance(background))
    const darker = Math.min(luminance(foreground), luminance(background))
    return (lighter + 0.05) / (darker + 0.05)
  })
}

async function assertReadable(locator, label, minimum = 4.5) {
  await expect(locator, `${label} should be visible`).toBeVisible()
  const ratio = await contrastRatio(locator)
  assert.ok(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} must be at least ${minimum}`)
}

try {
  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: 'development',
      devtool: false,
      cache: false,
      entry: join(root, 'scripts/fixtures/theme-surface-readability-ui.tsx'),
      output: { path: output, filename: 'fixture.js' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'],
        modules: [join(root, 'app_src/node_modules'), 'node_modules'],
        alias: { '@': join(root, 'app_src') },
      },
      module: {
        rules: [{
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs'),
        }],
      },
    })
    compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true })))
      : resolve()))
  })

  const bundle = await readFile(join(output, 'fixture.js'))
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    response.end(request.url === '/fixture.js'
      ? bundle
      : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(() => { window.process = { env: { NODE_ENV: 'development' } } })
  await page.route('**/api/pipeline/catalog', route => route.fulfill({
    json: { ok: true, pipelineId: 'pipeline-theme-test', canEdit: true, people: [], products: [] },
  }))
  await page.route('**/api/pipeline/dropdowns', route => route.fulfill({
    json: { ok: true, catalog: { dropdowns: {} } },
  }))
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`

  for (const mode of ['light', 'dark']) {
    await page.goto(`${origin}/?mode=${mode}&view=docs`)
    await expect(page.locator('html')).toHaveClass(new RegExp(mode))
    await assertReadable(page.getByRole('heading', { name: 'Readable document', exact: true }), `${mode} document title`)
    await assertReadable(page.getByRole('heading', { name: 'Section heading', exact: true }), `${mode} section heading`)
    await assertReadable(page.getByText('Body copy remains readable in both appearances.', { exact: false }), `${mode} document body`)
    await assertReadable(page.getByText('Readable list item', { exact: true }), `${mode} list item`)
    await assertReadable(page.getByRole('columnheader', { name: 'Column', exact: true }), `${mode} table heading`)
    await assertReadable(page.getByRole('cell', { name: 'Readable table value', exact: true }), `${mode} table cell`)
    await assertReadable(page.getByRole('link', { name: 'Documentation link', exact: true }), `${mode} document link`)

    const headerBackground = await page.getByTestId('docs-reader-header').evaluate(element => getComputedStyle(element).backgroundColor)
    const readerBackground = await page.getByTestId('docs-reader').evaluate(element => getComputedStyle(element).backgroundColor)
    assert.notEqual(headerBackground, 'rgba(0, 0, 0, 0)', `${mode} document header surface is opaque`)
    assert.equal(readerBackground, 'rgba(0, 0, 0, 0)', `${mode} reader content inherits its themed opaque shell`)

    await page.goto(`${origin}/?mode=${mode}&view=pipeline`)
    await expect(page.locator('html')).toHaveClass(new RegExp(mode))
    const dialog = page.getByRole('dialog')
    await assertReadable(dialog.getByRole('heading', { name: 'Pipeline setup', exact: true }), `${mode} pipeline dialog title`)
    await assertReadable(dialog.getByText('People, products, and workflow for this organization', { exact: true }), `${mode} pipeline dialog body`)
    const dialogBackground = await dialog.evaluate(element => getComputedStyle(element).backgroundColor)
    assert.notEqual(dialogBackground, 'rgba(0, 0, 0, 0)', `${mode} pipeline dialog surface is opaque`)
    const backdropBackground = await page.locator('.MuiBackdrop-root').evaluate(element => getComputedStyle(element).backgroundColor)
    assert.match(backdropBackground, /^rgba\(0, 0, 0, 0\.[1-9]/, `${mode} pipeline backdrop remains visible`)
  }

  assert.deepEqual(pageErrors, [])
  console.log('PASS theme surfaces: Docs and Pipeline setup retain readable light/dark contrast')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(output, { recursive: true, force: true })
}
