import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

type ShortLinkRecord = {
  id: string
  publicDomain?: 'eigenracing' | 'bpo'
  shortUrl: string
  slug: string
  destinationUrl: string
  title: string
  tags: string[]
  status: string
  expiresAt: string | null
  maxClicks: number | null
  clickCount: number
  remainingClicks: number | null
  createdAt: string
  updatedAt: string
}

type ApiState = {
  records: ShortLinkRecord[]
  posts: Array<Record<string, unknown>>
  patches: Array<Record<string, unknown>>
  deletes: string[]
  defaultDomain: 'eigenracing' | 'bpo'
  preferences: Array<Record<string, unknown>>
}

async function installShortLinksApi(page: Page, bpoAvailable = true, defaultDomain: 'eigenracing' | 'bpo' = 'eigenracing'): Promise<ApiState> {
  const now = Date.now()
  const state: ApiState = {
    records: [
      {
        id: 'link-1',
        shortUrl: 'https://go.clawpilot.test/launch-brief',
        slug: 'launch-brief',
        destinationUrl: 'https://example.com/operations/launch',
        title: 'Launch brief',
        tags: ['campaign', 'internal'],
        status: 'active',
        expiresAt: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
        maxClicks: 100,
        clickCount: 35,
        remainingClicks: 65,
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      },
      {
        id: 'link-2',
        shortUrl: 'https://go.clawpilot.test/archive',
        slug: 'archive',
        destinationUrl: 'https://example.com/archive',
        title: 'Archived campaign',
        tags: ['campaign'],
        status: 'disabled',
        expiresAt: null,
        maxClicks: null,
        clickCount: 7,
        remainingClicks: null,
        createdAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    posts: [],
    patches: [],
    deletes: [],
    defaultDomain,
    preferences: [],
  }

  await page.route('**/api/shortlinks**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (url.pathname === '/api/shortlinks/preferences' && method === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.preferences.push(body)
      state.defaultDomain = body.defaultDomain === 'bpo' ? 'bpo' : 'eigenracing'
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, defaultDomain: state.defaultDomain }) })
      return
    }

    if (method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase()
      const tag = (url.searchParams.get('tag') || '').toLowerCase()
      const status = (url.searchParams.get('status') || '').toLowerCase()
      const records = state.records.filter((record) => {
        const searchable = [record.title, record.slug, record.shortUrl, record.destinationUrl].join(' ').toLowerCase()
        return (!query || searchable.includes(query))
          && (!tag || record.tags.includes(tag))
          && (!status || record.status === status)
      })
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        records,
        currentOwnerEmail: 'operator@example.test',
        canManageOrganization: true,
        defaultDomain: bpoAvailable ? state.defaultDomain : 'eigenracing',
        availableDomains: [
          { key: 'eigenracing', label: 'eigenracing.com' },
          ...(bpoAvailable ? [{ key: 'bpo', label: 'bposupplychain.com' }] : []),
        ],
      }) })
      return
    }

    if (method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      const durationHours = typeof body.durationHours === 'number' ? body.durationHours : null
      const maxClicks = typeof body.maxClicks === 'number' ? body.maxClicks : null
      const slug = String(body.slug || `generated-${state.records.length + 1}`)
      const publicDomain = body.publicDomain === 'bpo' ? 'bpo' : 'eigenracing'
      const record: ShortLinkRecord = {
        id: `link-${state.records.length + 1}`,
        publicDomain,
        shortUrl: publicDomain === 'bpo' ? `https://bposupplychain.com/s/${slug}` : `https://go.clawpilot.test/${slug}`,
        slug,
        destinationUrl: String(body.destinationUrl),
        title: String(body.title),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        status: 'active',
        expiresAt: durationHours ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString() : null,
        maxClicks,
        clickCount: 0,
        remainingClicks: maxClicks,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      state.records.unshift(record)
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, record }) })
      return
    }

    if (method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.patches.push(body)
      const record = state.records.find((candidate) => candidate.id === body.id)
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Short link not found' }) })
        return
      }
      if (body.action === 'enable' || body.action === 'disable') {
        record.status = body.action === 'enable' ? 'active' : 'disabled'
      } else {
        if (typeof body.destinationUrl === 'string') record.destinationUrl = body.destinationUrl
        if (typeof body.title === 'string') record.title = body.title
        if (typeof body.slug === 'string') {
          record.slug = body.slug
          record.shortUrl = `https://go.clawpilot.test/${body.slug}`
        }
        if (Array.isArray(body.tags)) record.tags = body.tags.map(String)
        if (body.durationHours === null) record.expiresAt = null
        if (typeof body.durationHours === 'number') record.expiresAt = new Date(Date.now() + body.durationHours * 60 * 60 * 1000).toISOString()
        if (body.maxClicks === null || typeof body.maxClicks === 'number') {
          record.maxClicks = body.maxClicks as number | null
          record.remainingClicks = record.maxClicks == null ? null : Math.max(0, record.maxClicks - record.clickCount)
        }
      }
      record.updatedAt = new Date().toISOString()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, record }) })
      return
    }

    if (method === 'DELETE') {
      const id = url.searchParams.get('id') || ''
      state.deletes.push(id)
      state.records = state.records.filter((record) => record.id !== id)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }

    await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ ok: false }) })
  })

  return state
}

test('short links: desktop operator workflow', async ({ page, context }) => {
  const api = await installShortLinksApi(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4002' })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/#links')
  test.skip(
    await page.getByTestId('nav-desktop-links').count() === 0,
    'Short-link UI requires the PostgreSQL storage driver',
  )

  await expect(page.getByRole('heading', { name: 'Short Links', level: 1 })).toBeVisible()
  await expect(page.getByTestId('nav-desktop-links')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('short-link-link-1')).toContainText('35 / 100')
  await expect(page.getByTestId('short-link-link-2')).toContainText('Disabled')

  await page.getByLabel('Search short links').fill('operations/launch')
  await expect(page.getByTestId('short-link-link-1')).toBeVisible()
  await expect(page.getByTestId('short-link-link-2')).toHaveCount(0)
  await page.getByLabel('Search short links').clear()
  await expect(page.getByTestId('short-link-link-2')).toBeVisible()

  await page.getByTestId('create-short-link').click()
  await page.getByLabel('Title').fill('Campaign landing')
  await page.getByLabel('Destination URL').fill('https://example.com/campaign/landing')
  await page.getByLabel('Custom slug').fill('campaign-landing')
  await page.getByLabel('Tags').fill('Campaign, External')
  await page.getByLabel('Click cap').fill('50')
  await page.getByRole('button', { name: 'Create link' }).click()

  await expect(page.getByTestId('short-link-link-3')).toContainText('Campaign landing')
  expect(api.posts).toHaveLength(1)
  expect(api.posts[0]).toMatchObject({
    destinationUrl: 'https://example.com/campaign/landing',
    title: 'Campaign landing',
    slug: 'campaign-landing',
    tags: ['campaign', 'external'],
    durationHours: 24,
    maxClicks: 50,
  })

  await page.getByRole('button', { name: 'Copy Campaign landing' }).click()
  await expect(page.getByText('Short URL copied')).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('https://go.clawpilot.test/campaign-landing')

  await page.getByRole('button', { name: 'Edit Campaign landing' }).click()
  await page.getByLabel('Title').fill('Campaign landing updated')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByTestId('short-link-link-3')).toContainText('Campaign landing updated')
  expect(api.patches.at(-1)).toMatchObject({ id: 'link-3', title: 'Campaign landing updated' })

  await page.getByRole('button', { name: 'Disable Campaign landing updated' }).click()
  await expect(page.getByTestId('short-link-link-3')).toContainText('Disabled')
  expect(api.patches.at(-1)).toEqual({ id: 'link-3', action: 'disable' })

  await page.getByRole('button', { name: 'Delete Campaign landing updated' }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete short link?' })
  await deleteDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('short-link-link-3')).toHaveCount(0)
  expect(api.deletes).toEqual(['link-3'])
})

test('short links: mobile navigation and controls stay contained', async ({ page }) => {
  await installShortLinksApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#dashboard')

  await page.getByTestId('mobile-navigation-toggle').click()
  test.skip(
    await page.getByTestId('nav-mobile-links').count() === 0,
    'Short-link UI requires the PostgreSQL storage driver',
  )
  await page.getByTestId('nav-mobile-links').click()
  await expect(page).toHaveURL(/#links$/)
  await expect(page.getByRole('heading', { name: 'Short Links', level: 1 })).toBeVisible()
  await expect(page.getByTestId('short-link-link-1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy Launch brief' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit Launch brief' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Disable Launch brief' })).toBeVisible()

  await page.getByTestId('create-short-link').click()
  const formDialog = page.getByRole('dialog', { name: 'Create short link' })
  await expect(formDialog).toBeVisible()
  await expect.poll(async () => Math.round((await formDialog.boundingBox())?.width || 0)).toBe(390)
  await formDialog.getByRole('button', { name: 'Close short link form' }).click()

  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }))
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport)
})

test('short links: BPO domain selection is per-link and unavailable until enabled', async ({ page }) => {
  const api = await installShortLinksApi(page)
  await page.goto('/#links')
  test.skip(await page.getByTestId('nav-desktop-links').count() === 0, 'Short-link UI requires PostgreSQL')

  await page.getByTestId('create-short-link').click()
  await page.getByLabel('Short URL domain').click()
  await page.getByRole('option', { name: 'bposupplychain.com' }).click()
  await page.getByLabel('Destination URL').fill('https://example.com/bpo-campaign')
  await page.getByLabel('Custom slug').fill('bpo-campaign')
  await page.getByRole('button', { name: 'Create link' }).click()
  await expect(page.getByTestId('short-link-link-3')).toContainText('bposupplychain.com/s/bpo-campaign')
  expect(api.posts.at(-1)?.publicDomain).toBe('bpo')

  await page.getByRole('button', { name: 'Edit bpo-campaign' }).click()
  await expect(page.getByLabel('Short URL domain')).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel' }).click()

  const gatedPage = await page.context().newPage()
  await installShortLinksApi(gatedPage, false)
  await gatedPage.goto('/#links')
  await gatedPage.getByTestId('create-short-link').click()
  await gatedPage.getByLabel('Short URL domain').click()
  await expect(gatedPage.getByRole('option', { name: 'bposupplychain.com' })).toHaveCount(0)
})

test('short links: saved workspace default persists independently of each new link', async ({ page }) => {
  const api = await installShortLinksApi(page, true, 'bpo')
  await page.goto('/#links')
  test.skip(await page.getByTestId('nav-desktop-links').count() === 0, 'Short-link UI requires PostgreSQL')
  await expect(page.getByLabel('Default short-link domain')).toContainText('bposupplychain.com')
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()

  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByLabel('Short URL domain', { exact: true }).click()
  await page.getByRole('option', { name: 'eigenracing.com', exact: true }).click()
  await page.getByLabel('Destination URL').fill('https://example.com/one-off-eigen')
  await page.getByRole('button', { name: 'Create link', exact: true }).click()
  await expect(page.getByTestId('short-link-link-3')).toBeVisible()
  expect(api.posts.at(-1)?.publicDomain).toBe('eigenracing')
  expect(api.preferences).toHaveLength(0)
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('bposupplychain.com')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByLabel('Default short-link domain').click()
  await page.getByRole('option', { name: 'eigenracing.com', exact: true }).click()
  await page.getByRole('button', { name: 'Save default', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save default', exact: true })).toBeDisabled()
  expect(api.preferences).toEqual([{ defaultDomain: 'eigenracing' }])
  await page.reload()
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('eigenracing.com')
})

test('short links: workspace changes discard drafts and reload its default', async ({ page }) => {
  const api = await installShortLinksApi(page, true, 'bpo')
  await page.goto('/#links')
  test.skip(await page.getByTestId('nav-desktop-links').count() === 0, 'Short-link UI requires PostgreSQL')
  await page.getByTestId('create-short-link').click()
  await page.getByLabel('Destination URL').fill('https://example.com/old-workspace-draft')
  api.defaultDomain = 'eigenracing'
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('clawpilot:workspace-changed', {
    detail: { organizationId: '22222222-2222-4222-8222-222222222222', organizationName: 'Another workspace' },
  })))
  await expect(page.getByRole('dialog', { name: 'Create short link' })).toHaveCount(0)
  await page.goto('/#links')
  await page.getByTestId('create-short-link').click()
  await expect(page.getByLabel('Destination URL')).toHaveValue('')
  await expect(page.getByLabel('Short URL domain', { exact: true })).toContainText('eigenracing.com')
})
