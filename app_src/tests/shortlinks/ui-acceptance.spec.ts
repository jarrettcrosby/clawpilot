import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

type ShortLinkRecord = {
  id: string
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
}

async function installShortLinksApi(page: Page): Promise<ApiState> {
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
  }

  await page.route('**/api/shortlinks**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, records }) })
      return
    }

    if (method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.posts.push(body)
      const durationHours = typeof body.durationHours === 'number' ? body.durationHours : null
      const maxClicks = typeof body.maxClicks === 'number' ? body.maxClicks : null
      const slug = String(body.slug || `generated-${state.records.length + 1}`)
      const record: ShortLinkRecord = {
        id: `link-${state.records.length + 1}`,
        shortUrl: `https://go.clawpilot.test/${slug}`,
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
