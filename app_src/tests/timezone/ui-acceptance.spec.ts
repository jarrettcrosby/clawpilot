import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const UTC_TIMESTAMP = '2026-07-15T01:30:00.000Z'

test.use({ timezoneId: 'UTC' })

async function mockTimezoneWorkspace(page: Page, onCrmSave: (occurredAt: string) => void) {
  await page.route((url) => url.pathname === '/api/users', (route) => route.fulfill({
    json: {
      ok: true,
      currentUser: {
        displayName: 'Timezone Tester',
        email: 'timezone@example.test',
        timezone: 'America/Los_Angeles',
        locale: 'en-US',
      },
    },
  }))
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({
    json: [{
      id: 'timezone-task',
      title: 'Timezone boundary task',
      desc: 'UTC source data rendered in the signed-in user timezone.',
      status: 'todo',
      priority: 'high',
      category: 'clawpilot',
      tags: [],
      createdAt: UTC_TIMESTAMP,
      updatedAt: UTC_TIMESTAMP,
      activity: [{
        type: 'comment',
        message: 'Timezone boundary activity',
        timestamp: UTC_TIMESTAMP,
        actor: 'Timezone Tester',
      }],
      comments: [],
      checklist: [],
    }],
  }))
  await page.route((url) => url.pathname === '/api/docs', (route) => route.fulfill({ json: [] }))
  await page.route((url) => url.pathname === '/api/execution-results/summary', (route) => route.fulfill({ json: { count: 0 } }))
  await page.route((url) => url.pathname === '/api/pipeline/activity', (route) => route.fulfill({ json: [] }))
  await page.route((url) => url.pathname === '/api/activity', (route) => route.fulfill({ json: { ok: true, events: [], nextCursor: null, scope: 'self', capabilities: { canViewOrganization: false, canViewGlobal: false, defaultScope: 'self' } } }))
  await page.route((url) => url.pathname === '/api/pipeline', (route) => route.fulfill({
    json: {
      pipeline: {
        id: 'timezone-pipeline',
        accessRole: 'owner',
        syncEnabled: true,
        provisioningStatus: 'ready',
      },
      opportunities: [],
    },
  }))
  await page.route((url) => url.pathname === '/api/pipeline/dropdowns', (route) => route.fulfill({
    json: { catalog: { dropdowns: {} } },
  }))
  await page.route((url) => url.pathname === '/api/pipeline/sync-status', (route) => route.fulfill({
    json: { ok: true, syncedAt: UTC_TIMESTAMP, summary: {} },
  }))
  await page.route((url) => url.pathname === '/api/versions', (route) => route.fulfill({
    json: {
      ok: true,
      access: { historyScope: 'full', historyDays: null, manageBackups: false },
      releases: [{
        id: 'timezone-release',
        commitHash: '1234567890abcdef',
        shortCommit: '1234567',
        environment: 'production',
        branch: 'main',
        title: 'Timezone release',
        summary: 'Exercises profile-aware timestamp rendering.',
        features: [],
        fixes: [],
        deployedAt: UTC_TIMESTAMP,
      }],
      checkpoints: [],
    },
  }))
  await page.route((url) => url.pathname === '/api/crm', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { fields?: { occurredAt?: string } }
      onCrmSave(String(body.fields?.occurredAt || ''))
      await route.fulfill({ json: { ok: true, record: { id: 'timezone-interaction' } } })
      return
    }

    const entity = new URL(route.request().url()).searchParams.get('entity') || 'organizations'
    await route.fulfill({
      json: {
        ok: true,
        entity,
        records: entity === 'interactions' ? [{
          id: 'timezone-interaction',
          referenceCode: 'gi1234567',
          subject: 'Timezone interaction',
          interactionType: 'call',
          occurredAt: UTC_TIMESTAMP,
          agentName: 'Timezone Tester',
          syncStatus: 'synced',
        }] : [],
        summary: {
          organizations: 0,
          contacts: 0,
          leads: 0,
          opportunities: 0,
          meetings: 0,
          interactions: 1,
          campaigns: 0,
          openPipelineValue: 0,
          weightedPipelineValue: 0,
          pendingSync: 0,
          failedSync: 0,
        },
        pipeline: {
          id: 'timezone-pipeline',
          name: 'Timezone Pipeline',
          ownerEmail: 'timezone@example.test',
          workspaceOrganizationId: null,
          accessRole: 'owner',
          shortLinkUrl: null,
        },
        workspaceHierarchy: [],
        canManageHierarchy: false,
      },
    })
  })
  await page.route((url) => url.pathname === '/api/health', (route) => route.fulfill({ json: { status: 'ok', errors: [] } }))
  await page.route((url) => url.pathname === '/api/version', (route) => route.fulfill({
    json: { hash: '1234567890abcdef', short: '1234567', subject: 'Timezone build', date: UTC_TIMESTAMP, dirty: false, dirtyCount: 0 },
  }))
  await page.route((url) => url.pathname === '/api/runtime', (route) => route.fulfill({
    json: { lane: 'test', port: '4002', commit: '1234567890abcdef' },
  }))
  await page.route((url) => url.pathname === '/api/freeze', (route) => route.fulfill({ json: { frozen: false } }))
}

test('signed-in profile timezone controls visible timestamps while UTC source values remain unchanged', async ({ page }) => {
  let savedCrmTimestamp = ''
  await page.clock.setFixedTime(new Date(UTC_TIMESTAMP))
  await mockTimezoneWorkspace(page, (occurredAt) => { savedCrmTimestamp = occurredAt })
  await page.goto('/#dashboard')

  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByText('Good evening, Timezone Tester', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Activity log' }).click()
  const activityDrawer = page.locator('.MuiDrawer-paper').filter({ hasText: 'Activity Log' })
  await activityDrawer.getByText('Projects', { exact: true }).click()
  await expect(activityDrawer.getByText('Tuesday, July 14', { exact: true })).toBeVisible()
  await expect(activityDrawer.getByText('Jul 14, 6:30 PM', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(() => { window.location.hash = 'versions' })
  const release = page.getByTestId('release-entry')
  await expect(release.getByText('Jul 14, 2026, 6:30 PM', { exact: true })).toBeVisible()

  await page.evaluate(() => { window.location.hash = 'crm' })
  await page.getByRole('tab', { name: 'Interactions', exact: true }).click()
  const crmRecords = page.getByTestId('crm-records')
  await expect(crmRecords.getByText('Jul 14, 2026, 6:30 PM', { exact: true })).toBeVisible()
  await crmRecords.getByRole('row').filter({ hasText: 'Timezone interaction' }).click()
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-07-14T18:30')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => savedCrmTimestamp).toBe(UTC_TIMESTAMP)

  await page.evaluate(() => { window.location.hash = 'pipeline' })
  await expect(page.getByText('Last synced: Jul 14, 2026, 6:30 PM', { exact: true })).toBeVisible()

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('clawpilot:user-date-time-settings', {
      detail: { timezone: 'Asia/Tokyo', locale: 'en-US' },
    }))
  })
  await expect(page.getByText('Last synced: Jul 15, 2026, 10:30 AM', { exact: true })).toBeVisible()

  await page.evaluate(() => { window.location.hash = 'versions' })
  await expect(page.getByTestId('release-entry').getByText('Jul 15, 2026, 10:30 AM', { exact: true })).toBeVisible()
})
