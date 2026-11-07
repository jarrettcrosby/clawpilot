import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

test.beforeEach(async ({ page, baseURL }) => {
  const fixtureOrigin = new URL(baseURL || 'http://localhost:4002').origin
  await page.route((url) => url.origin !== fixtureOrigin, (route) => route.abort())
})

const reportPayload = {
  ok: true,
  period: {
    preset: 'last_3_calendar_months',
    label: 'Jun 1 – Aug 28, 2026',
    startDate: '2026-06-01',
    endDate: '2026-08-28',
    snapshotDate: '2026-08-28',
    timeZone: 'America/New_York',
  },
  snapshot: {
    totalContacts: 12,
    totalOpportunities: 6,
    activeOpportunities: 4,
    openOpportunities: 3,
    onHoldOpportunities: 1,
    highPriorityActiveOpportunities: 2,
    wonOpportunities: 1,
    lostOpportunities: 1,
    activePipelineValue: 300,
    weightedPipelineValue: 125.5,
    lifetimeWinRate: 50,
    opportunitiesByStage: [
      { stage: 'Proposal', count: 3 },
      { stage: 'Closed', count: 1 },
      { stage: 'Loss', count: 1 },
    ],
    activeByStage: [{ label: 'Proposal', count: 3, value: 300, weighted: 125.5 }],
    activeByCloseQuarter: [{ label: 'Q3 2026', count: 3, value: 300, weighted: 125.5 }],
    attention: {
      total: 0,
      lifecycleConflicts: 0,
      overdue: 0,
      missingCloseDate: 0,
      invalidProbability: 0,
    },
    forecast: {
      months: [
        {
          month: '2026-08',
          potential: 300,
          weighted: 125.5,
          stages: [{ stage: 'Proposal', value: 300 }],
        },
        { month: '2026-09', potential: 0, weighted: 0, stages: [] },
        { month: '2026-10', potential: 0, weighted: 0, stages: [] },
        { month: '2026-11', potential: 0, weighted: 0, stages: [] },
        { month: '2026-12', potential: 0, weighted: 0, stages: [] },
        { month: '2027-01', potential: 0, weighted: 0, stages: [] },
      ],
      outsideOrUnscheduledPotential: 0,
      outsideOrUnscheduledWeighted: 0,
    },
  },
  activity: {
    interactionScope: 'sales',
    contactsAdded: 2,
    interactions: 3,
    opportunitiesCreated: 1,
    interactionsByMonth: [
      {
        month: '2026-08',
        label: 'Aug 2026',
        total: 3,
        types: {
          directMail: 0,
          linkedIn: 0,
          email: 2,
          call: 1,
          inPerson: 0,
          note: 0,
          campaign: 0,
          other: 0,
        },
      },
    ],
  },
}

async function mockReport(page: Page, failFirst = false) {
  let requests = 0
  await page.route((url) => url.pathname === '/api/pipeline/report', async (route) => {
    requests += 1
    if (failFirst && requests === 1) {
      await route.fulfill({ status: 503, json: { ok: false, error: 'Reporting is temporarily unavailable' } })
      return
    }
    await route.fulfill({ json: reportPayload })
  })
  return () => requests
}

test('report fetch can recover and chart marks disclose values on hover and keyboard focus', async ({ page }) => {
  const requestCount = await mockReport(page, true)
  await page.goto('/dev/pipeline-reporting')

  await expect(page.getByText('Reporting is temporarily unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByText('$125.50', { exact: true })).toBeVisible()
  expect(requestCount()).toBe(2)

  const proposalMark = page.getByRole('img', { name: 'Proposal: 3 opportunities' })
  await proposalMark.hover()
  await expect(page.getByRole('tooltip')).toContainText('Proposal · 3 opportunities')
  await page.mouse.move(0, 0)
  await proposalMark.focus()
  await expect(page.getByRole('tooltip')).toContainText('Proposal · 3 opportunities')
  await page.keyboard.press('Tab')
})

test('report defaults to sales interactions and restores them after viewing all activity', async ({ page }) => {
  const scopes: (string | null)[] = []
  const allActivity = {
    ...reportPayload.activity,
    interactionScope: 'all',
    interactions: 11,
    interactionsByMonth: reportPayload.activity.interactionsByMonth.map((month) => ({
      ...month, total: 11, types: { ...month.types, note: 8 },
    })),
  }
  await page.route((url) => url.pathname === '/api/pipeline/report', async (route) => {
    const scope = new URL(route.request().url()).searchParams.get('interactionScope')
    scopes.push(scope)
    await route.fulfill({ json: { ...reportPayload, activity: scope === 'all' ? allActivity : reportPayload.activity } })
  })
  const total = (label: string, value: string) => page.getByText(`${label} · selected period`, { exact: true })
    .locator('..').getByText(value, { exact: true })
  const scope = page.getByRole('combobox', { name: 'Interaction scope' })
  const extraActivity = page.getByRole('img', { name: 'Aug 2026 · Note: 8 interactions' })

  await page.goto('/dev/pipeline-reporting')
  await expect(scope).toHaveText('Customers and prospects')
  await expect(total('Sales interactions', '3')).toBeVisible()
  await expect(extraActivity).toHaveCount(0)
  expect(scopes).toEqual(['sales'])

  await scope.click()
  await page.getByRole('option', { name: 'All activity' }).click()
  await expect(scope).toHaveText('All activity')
  await expect(total('All interactions', '11')).toBeVisible()
  await expect(extraActivity).toBeVisible()
  expect(scopes).toEqual(['sales', 'all'])

  await scope.click()
  await page.getByRole('option', { name: 'Customers and prospects' }).click()
  await expect(scope).toHaveText('Customers and prospects')
  await expect(total('Sales interactions', '3')).toBeVisible()
  await expect(extraActivity).toHaveCount(0)
  expect(scopes).toEqual(['sales', 'all', 'sales'])
})

test.describe('touch chart details', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })

  test('chart marks disclose exact values on phone touch', async ({ page }) => {
    await mockReport(page)
    await page.goto('/dev/pipeline-reporting')
    const emailMark = page.getByRole('img', { name: 'Aug 2026 · Email: 2 interactions' })
    await emailMark.dispatchEvent('touchstart')
    await expect(page.getByRole('tooltip')).toContainText('Aug 2026 · Email: 2 interactions')
    await emailMark.dispatchEvent('touchend')
  })
})
