import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

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
