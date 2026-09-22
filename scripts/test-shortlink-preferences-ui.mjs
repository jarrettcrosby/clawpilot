#!/usr/bin/env node

// Isolated real React/MUI component acceptance. This deliberately does not claim
// authentication, deployment, or full-app navigation acceptance.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRequire = createRequire(join(root, 'app_src/package.json'))
const { chromium, expect } = appRequire('@playwright/test')
const webpackRuntime = appRequire('next/dist/compiled/webpack/webpack')
const output = await mkdtemp(join(tmpdir(), 'clawpilot-shortlink-ui-'))
let browser
let server
try {
  await new Promise((resolvePromise, reject) => {
    const compiler = webpackRuntime.webpack({
      mode: 'development', devtool: false, cache: false,
      entry: {
        shortlinks: join(root, 'scripts/fixtures/shortlink-ui.tsx'),
        organization: join(root, 'scripts/fixtures/organization-web-ui.tsx'),
      },
      output: { path: output, filename: '[name].js' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js', '.mjs', '.json'],
        modules: [join(root, 'app_src/node_modules'), 'node_modules'],
        alias: { '@': join(root, 'app_src') },
      },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/lib/shortlink-ui-ts-loader.cjs') }] },
    })
    compiler.run((error, stats) => compiler.close(() => {
      if (error || stats?.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })))
      else resolvePromise()
    }))
  })
  const bundles = new Map(await Promise.all(['shortlinks', 'organization'].map(async (name) => [
    `/${name}.js`, await readFile(join(output, `${name}.js`)),
  ])))
  server = createServer((req, res) => {
    const bundle = bundles.get(req.url)
    res.setHeader('Content-Type', bundle ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
    const fixture = req.url === '/organization' ? 'organization' : 'shortlinks'
    res.end(bundle || `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/${fixture}.js"></script>`)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let userDefaultDomain = 'bpo'
  let organizationDomain = 'bpo'
  let canOverrideDefault = true
  let bpoAvailable = true
  let failPreference = false
  const preferences = []
  const posts = []
  const now = new Date().toISOString()
  const records = [{
    id: 'existing-bpo', ownerEmail: 'operator@example.test', publicDomain: 'bpo', shortUrl: 'https://bposupplychain.com/s/existing',
    slug: 'existing', destinationUrl: 'https://example.test', title: 'Existing BPO', tags: [], status: 'active',
    expiresAt: null, maxClicks: null, clickCount: 0, remainingClicks: null, createdAt: now, updatedAt: now,
  }]
  function domainState() {
    const allDomains = [{ key: 'eigenracing', label: 'eigenracing.com' }, ...(bpoAvailable ? [{ key: 'bpo', label: 'bposupplychain.com' }] : [])]
    const organizationDefaultDomain = organizationDomain === 'bpo' && !bpoAvailable ? 'eigenracing' : organizationDomain
    const defaultDomain = canOverrideDefault && allDomains.some((entry) => entry.key === userDefaultDomain) ? userDefaultDomain : organizationDefaultDomain
    return { defaultDomain, userDefaultDomain, organizationDefaultDomain, canOverrideDefault,
      availableDomains: canOverrideDefault ? allDomains : allDomains.filter((entry) => entry.key === organizationDefaultDomain) }
  }
  await page.route('**/api/shortlinks**', async (route) => {
    const request = route.request()
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    if (request.method() === 'GET') return json({
      ok: true, links: records, currentOwnerEmail: 'operator@example.test', canManageOrganization: true,
      ...domainState(),
    })
    const body = request.postDataJSON()
    if (request.method() === 'PUT') {
      if (failPreference) return json({ ok: false, error: 'Preference save rejected' }, 403)
      preferences.push(body)
      userDefaultDomain = body.defaultDomain
      return json({ ok: true, ...domainState() })
    }
    if (request.method() === 'POST') { posts.push(body); return json({ ok: true, link: { id: 'new' } }, 201) }
    return json({ ok: true })
  })
  await page.goto(origin)
  await expect(page.getByLabel('Default short-link domain')).toContainText('bposupplychain.com')
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByLabel('Short URL domain', { exact: true }).click()
  await page.getByRole('option', { name: 'eigenracing.com', exact: true }).click()
  await page.getByLabel('Destination URL').fill('https://example.test/manual-choice')
  await page.getByRole('button', { name: 'Create link', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.equal(posts.at(-1).publicDomain, 'eigenracing')
  assert.equal(preferences.length, 0)
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByLabel('Default short-link domain').click()
  await page.getByRole('option', { name: 'eigenracing.com', exact: true }).click()
  failPreference = true
  await page.getByRole('button', { name: 'Save default', exact: true }).click()
  await expect(page.getByText('Preference save rejected')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeEnabled()
  assert.equal(userDefaultDomain, 'bpo')
  failPreference = false
  await page.getByRole('button', { name: 'Save default', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()
  assert.deepEqual(preferences, [{ defaultDomain: 'eigenracing' }])
  await page.reload()
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('eigenracing.com')
  await page.getByLabel('Destination URL').fill('https://example.test/old-workspace')
  userDefaultDomain = null
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('clawpilot:workspace-changed')))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Destination URL')).toHaveValue('')
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByLabel('Default short-link domain')).toContainText('Organization default (bposupplychain.com)')
  userDefaultDomain = 'bpo'
  bpoAvailable = false
  await page.reload()
  await expect(page.getByLabel('Default short-link domain')).toContainText('bposupplychain.com')
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('eigenracing.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(userDefaultDomain, 'bpo', 'An unavailable preference is preserved while new links use the effective fallback')
  await page.getByRole('button', { name: 'Edit Existing BPO' }).click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toBeDisabled()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  bpoAvailable = true
  organizationDomain = 'eigenracing'
  canOverrideDefault = false
  await page.reload()
  await expect(page.getByLabel('Default short-link domain')).toContainText('Organization default (eigenracing.com)')
  await expect(page.getByLabel('Default short-link domain')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('eigenracing.com')
  await expect(page.getByLabel('Short URL domain', { exact: true })).toBeDisabled()
  await page.getByLabel('Destination URL').fill('https://example.test/organization-policy')
  await page.getByRole('button', { name: 'Create link', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  assert.equal(posts.at(-1).publicDomain, 'eigenracing')
  assert.equal(userDefaultDomain, 'bpo', 'Locking the organization policy does not erase a prior personal default')

  canOverrideDefault = true
  await page.reload()
  await expect(page.getByLabel('Default short-link domain')).toContainText('bposupplychain.com')
  await page.getByLabel('Default short-link domain').click()
  await page.getByRole('option', { name: 'Organization default (eigenracing.com)', exact: true }).click()
  await page.getByRole('button', { name: 'Save default', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()
  assert.deepEqual(preferences.at(-1), { defaultDomain: null })
  assert.equal(userDefaultDomain, null)
  organizationDomain = 'bpo'
  await page.reload()
  await expect(page.getByLabel('Default short-link domain')).toContainText('Organization default (bposupplychain.com)')
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }))
  assert.ok(dimensions.content <= dimensions.width, 'Mobile controls remain within the viewport')
  assert.deepEqual(errors, [], 'No browser runtime exceptions')
  console.log('Short-link real React/MUI component acceptance passed: personal override, inheritance/reset, organization lock/unlock, save failure/retry, reload, workspace reset, unavailable preference fallback, immutable edit, mobile width')

  // Organization settings use the actual component with only HTTP responses mocked.
  const organizationPage = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  organizationPage.on('pageerror', (error) => errors.push(error.message))
  const organizationPuts = []
  let organizationReads = 0
  let completedOrganizationReads = 0
  let rejectOrganizationSave = false
  let organizationReadGate = null
  let organizationCanEdit = true
  let organizationBpoAvailable = true
  let organizationName = 'First Organization'
  let organizationPreferences = {
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appDomain: 'bpo', shortLinkDomain: 'bpo',
    allowUserShortLinkOverride: true, revision: 4,
  }
  function organizationPayload() {
    const appDomains = [
      { key: 'eigenracing', label: 'aiapp.eigenracing.com', url: 'https://aiapp.eigenracing.com' },
      ...(organizationBpoAvailable ? [{ key: 'bpo', label: 'aiapp.bposupplychain.com', url: 'https://aiapp.bposupplychain.com' }] : []),
    ]
    const shortDomains = [{ key: 'eigenracing', label: 'eigenracing.com' }, ...(organizationBpoAvailable ? [{ key: 'bpo', label: 'bposupplychain.com' }] : [])]
    return { ok: true, preferences: { ...organizationPreferences }, canEdit: organizationCanEdit, organizationName,
      availableAppDomains: appDomains, availableShortLinkDomains: shortDomains,
      effectiveApp: appDomains.find((item) => item.key === organizationPreferences.appDomain) || appDomains[0],
      effectiveShortLink: shortDomains.find((item) => item.key === organizationPreferences.shortLinkDomain) || shortDomains[0] }
  }
  await organizationPage.route('**/api/settings/organization-web', async (route) => {
    if (route.request().method() === 'GET') {
      organizationReads += 1
      const payload = organizationPayload()
      if (organizationReadGate) await organizationReadGate
      await route.fulfill({ json: payload })
      completedOrganizationReads += 1
      return
    }
    const body = route.request().postDataJSON()
    organizationPuts.push(body)
    if (rejectOrganizationSave) return route.fulfill({ status: 409, json: { ok: false, error: 'Organization settings changed. Reload before saving.' } })
    organizationPreferences = { ...organizationPreferences, ...body, revision: organizationPreferences.revision + 1 }
    return route.fulfill({ json: organizationPayload() })
  })
  const appChoice = organizationPage.getByLabel('Default organization app address')
  const shortChoice = organizationPage.getByLabel('Organization short-link default')
  const overrideSwitch = organizationPage.getByLabel('Allow users to choose their own short-link default and per-link domain')
  const organizationSave = organizationPage.getByRole('button', { name: 'Save organization web defaults', exact: true })
  await organizationPage.goto(`${origin}/organization`)
  await expect(appChoice).toContainText('aiapp.bposupplychain.com')
  await expect(organizationSave).toBeDisabled()
  await expect(organizationPage.getByRole('link', { name: 'Open organization app' })).toHaveAttribute('href', 'https://aiapp.bposupplychain.com')
  await appChoice.click()
  await organizationPage.getByRole('option', { name: 'aiapp.eigenracing.com', exact: true }).click()
  await shortChoice.click()
  await organizationPage.getByRole('option', { name: 'eigenracing.com', exact: true }).click()
  await overrideSwitch.uncheck()
  rejectOrganizationSave = true
  await organizationSave.click()
  await expect(organizationPage.getByText('Organization settings changed. Reload before saving.')).toBeVisible()
  await expect(organizationSave).toBeEnabled()
  assert.equal(organizationPreferences.revision, 4, 'Failed writes cannot optimistically update organization settings')
  rejectOrganizationSave = false
  await organizationSave.click()
  await expect(organizationSave).toBeDisabled()
  assert.deepEqual(organizationPuts.at(-1), { expectedOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appDomain: 'eigenracing', shortLinkDomain: 'eigenracing', allowUserShortLinkOverride: false, revision: 4 })
  await expect(organizationPage.getByRole('link', { name: 'Open organization app' })).toHaveAttribute('href', 'https://aiapp.eigenracing.com')
  assert.equal(organizationPage.url(), `${origin}/organization`, 'Saving does not navigate or redirect the current session')
  await organizationPage.reload()
  await expect(appChoice).toContainText('aiapp.eigenracing.com')
  await expect(shortChoice).toContainText('eigenracing.com')
  await expect(overrideSwitch).not.toBeChecked()

  organizationCanEdit = false
  await organizationPage.reload()
  await expect(appChoice).toBeDisabled()
  await expect(shortChoice).toBeDisabled()
  await expect(overrideSwitch).toBeDisabled()
  await expect(organizationSave).toHaveCount(0)

  organizationCanEdit = true
  organizationBpoAvailable = false
  organizationPreferences = { ...organizationPreferences, appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: true }
  await organizationPage.reload()
  await expect(organizationPage.getByText(/A preferred address is not enabled yet/)).toBeVisible()
  await expect(appChoice).toContainText('BPO Supply Chain — not enabled')
  await expect(shortChoice).toContainText('BPO Supply Chain — not enabled')
  await expect(organizationPage.getByRole('link', { name: 'Open organization app' })).toHaveAttribute('href', 'https://aiapp.eigenracing.com')
  await overrideSwitch.uncheck()
  await organizationSave.click()
  await expect(organizationSave).toBeDisabled()
  assert.deepEqual(organizationPuts.at(-1), { expectedOrganizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appDomain: 'bpo', shortLinkDomain: 'bpo', allowUserShortLinkOverride: false, revision: 5 })

  // Switching workspaces discards unsaved settings and ignores the old late GET.
  organizationBpoAvailable = true
  await organizationPage.reload()
  await appChoice.click()
  await organizationPage.getByRole('option', { name: 'aiapp.eigenracing.com', exact: true }).click()
  await expect(organizationSave).toBeEnabled()
  const previousReads = organizationReads
  let releaseOldLoad
  organizationReadGate = new Promise((resolvePromise) => { releaseOldLoad = resolvePromise })
  await organizationPage.evaluate(() => window.dispatchEvent(new CustomEvent('clawpilot:workspace-changed')))
  await expect.poll(() => organizationReads).toBeGreaterThan(previousReads)
  organizationReadGate = null
  organizationName = 'Second Organization'
  organizationPreferences = { organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', appDomain: 'eigenracing', shortLinkDomain: 'eigenracing', allowUserShortLinkOverride: true, revision: 0 }
  await organizationPage.evaluate(() => window.dispatchEvent(new CustomEvent('clawpilot:workspace-changed')))
  await expect(organizationPage.getByText(/Defaults for Second Organization/)).toBeVisible()
  const completedBeforeLateResponse = completedOrganizationReads
  releaseOldLoad()
  await expect.poll(() => completedOrganizationReads).toBeGreaterThan(completedBeforeLateResponse)
  await organizationPage.evaluate(() => new Promise((resolvePromise) => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))))
  await expect(organizationPage.getByText(/Defaults for Second Organization/)).toBeVisible()
  await expect(appChoice).toContainText('aiapp.eigenracing.com')
  await expect(organizationSave).toBeDisabled()
  await organizationPage.setViewportSize({ width: 390, height: 844 })
  const organizationDimensions = await organizationPage.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }))
  assert.ok(organizationDimensions.content <= organizationDimensions.width, 'Organization settings fit the mobile viewport')
  assert.deepEqual(errors, [], 'No browser runtime exceptions across domain controls')
  console.log('Organization web settings real React/MUI acceptance passed: admin/viewer, optimistic-lock failure/retry, saved defaults, no navigation, unavailable-domain fallback, preserved settings, workspace reset/late response, mobile width')
} finally {
  await browser?.close()
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise))
  await rm(output, { recursive: true, force: true })
}
