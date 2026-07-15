import { expect, test } from '@playwright/test'
import type { Locator, Page, TestInfo } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true })

const authPassword = process.env.UI_AUTH_PASSWORD
const operatorSecret = process.env.UI_OPERATOR_SECRET
const MINIMUM_WORKSPACE_HEIGHT = 96

const MOBILE_VIEWPORTS = [
  { name: 'portrait', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const

async function authenticateIfConfigured(page: Page) {
  if (!authPassword || !operatorSecret) return

  const response = await page.request.post('/api/auth/login', {
    data: { password: authPassword },
    headers: { 'x-clawpilot-operator-secret': operatorSecret },
    failOnStatusCode: false,
  })
  expect(response.ok(), `UI authentication failed with HTTP ${response.status()}`).toBeTruthy()
}

async function gotoApp(page: Page, path: string) {
  await authenticateIfConfigured(page)
  await page.goto(path)
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

function activeSection(page: Page) {
  const sectionHost = page.getByTestId('app-header').locator('xpath=following-sibling::*[1]')
  return sectionHost.locator(':scope > div').first()
}

async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth - window.innerWidth
  ))).toBeLessThanOrEqual(1)
}

async function visibleGeometry(locator: Locator) {
  return locator.evaluate((element) => {
    const target = element as HTMLElement
    const rect = target.getBoundingClientRect()
    let top = Math.max(0, rect.top)
    let right = Math.min(window.innerWidth, rect.right)
    let bottom = Math.min(window.innerHeight, rect.bottom)
    let left = Math.max(0, rect.left)

    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const ancestorRect = ancestor.getBoundingClientRect()
      if (/(auto|hidden|scroll|clip)/.test(`${style.overflowX} ${style.overflow}`)) {
        left = Math.max(left, ancestorRect.left)
        right = Math.min(right, ancestorRect.right)
      }
      if (/(auto|hidden|scroll|clip)/.test(`${style.overflowY} ${style.overflow}`)) {
        top = Math.max(top, ancestorRect.top)
        bottom = Math.min(bottom, ancestorRect.bottom)
      }
    }

    const mobileNavigation = document.querySelector<HTMLElement>('[data-testid="mobile-bottom-navigation"]')
    if (mobileNavigation && getComputedStyle(mobileNavigation).display !== 'none') {
      bottom = Math.min(bottom, mobileNavigation.getBoundingClientRect().top)
    }

    return {
      height: Math.max(0, bottom - top),
      width: Math.max(0, right - left),
    }
  })
}

async function expectUsableGeometry(
  locator: Locator,
  label: string,
  minimumHeight = 44,
  minimumWidth = 44,
) {
  await expect(locator, `${label} should be visible`).toBeVisible()
  await expect.poll(async () => (await visibleGeometry(locator)).height, {
    message: `${label} should retain at least ${minimumHeight}px of visible height above mobile navigation`,
  }).toBeGreaterThanOrEqual(minimumHeight)
  await expect.poll(async () => (await visibleGeometry(locator)).width, {
    message: `${label} should retain at least ${minimumWidth}px of visible width`,
  }).toBeGreaterThanOrEqual(minimumWidth)
}

async function expectScrollableWorkspace(
  page: Page,
  root: Locator,
  axis: 'x' | 'y',
  label: string,
  minimumHeight = MINIMUM_WORKSPACE_HEIGHT,
) {
  await expect(root).toBeVisible()
  await expect.poll(async () => root.evaluate((rootElement, scrollAxis) => {
    const rootNode = rootElement as HTMLElement
    const candidates = [rootNode, ...Array.from(rootNode.querySelectorAll<HTMLElement>('*'))]
    const mobileNavigation = document.querySelector<HTMLElement>('[data-testid="mobile-bottom-navigation"]')
    const navigationTop = mobileNavigation && getComputedStyle(mobileNavigation).display !== 'none'
      ? mobileNavigation.getBoundingClientRect().top
      : window.innerHeight

    function visibleHeight(node: HTMLElement) {
      const rect = node.getBoundingClientRect()
      let top = Math.max(0, rect.top)
      let bottom = Math.min(window.innerHeight, navigationTop, rect.bottom)
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (!/(auto|hidden|scroll|clip)/.test(`${style.overflowY} ${style.overflow}`)) continue
        const ancestorRect = ancestor.getBoundingClientRect()
        top = Math.max(top, ancestorRect.top)
        bottom = Math.min(bottom, ancestorRect.bottom)
      }
      return Math.max(0, bottom - top)
    }

    return candidates.reduce((maximum, node) => {
      const style = getComputedStyle(node)
      const overflow = scrollAxis === 'x' ? style.overflowX : style.overflowY
      if (!/(auto|scroll)/.test(overflow)) return maximum
      if (scrollAxis === 'x' && node.scrollWidth <= node.clientWidth + 1) return maximum
      if (node.clientWidth < 120) return maximum
      return Math.max(maximum, visibleHeight(node))
    }, 0)
  }, axis), {
    message: `${label} should retain a ${minimumHeight}px usable scroll viewport`,
  }).toBeGreaterThanOrEqual(minimumHeight)

  await expectNoDocumentOverflow(page)
}

function note(testInfo: TestInfo, description: string) {
  testInfo.annotations.push({ type: 'limitation', description })
}

async function mockCrmRecords(page: Page) {
  const recordsByEntity: Record<string, Array<Record<string, unknown>>> = {
    organizations: [{
      id: '00000000-0000-4000-8000-000000000101',
      referenceCode: 'ga7654321',
      shortUrl: null,
      name: 'Acceptance Organization',
      parentOrganizationName: 'Acceptance Workspace',
      relationshipType: 'customer',
      workspaceOrganizationId: null,
      accountManager: 'Mobile Operator',
      phone: '+1 555 0101',
      email: 'organization@example.test',
      emailOptOut: false,
      syncStatus: 'synced',
    }],
    contacts: [{
      id: '00000000-0000-4000-8000-000000000102',
      referenceCode: 'gc7654321',
      shortUrl: null,
      fullName: 'Acceptance Contact',
      organizationId: '00000000-0000-4000-8000-000000000101',
      organizationName: 'Acceptance Organization',
      jobTitle: 'Mobile Lead',
      email: 'contact@example.test',
      emailOptOut: true,
      syncStatus: 'synced',
    }],
    meetings: [{
      id: '00000000-0000-4000-8000-000000000103',
      referenceCode: 'gm7654321',
      shortUrl: null,
      subject: 'Acceptance Meeting',
      organizationId: '00000000-0000-4000-8000-000000000101',
      organizationName: 'Acceptance Organization',
      contactId: '00000000-0000-4000-8000-000000000102',
      contactName: 'Acceptance Contact',
      leadId: null,
      leadName: '',
      opportunityId: null,
      opportunityName: '',
      startsAt: '2026-07-15T13:00:00.000Z',
      endsAt: '2026-07-15T13:30:00.000Z',
      timezone: 'America/New_York',
      location: 'Mobile Room',
      attendeeEmails: ['contact@example.test'],
      status: 'scheduled',
      provider: 'maton',
      syncStatus: 'synced',
    }],
    leads: [],
    opportunities: [],
    interactions: [],
    campaigns: [],
  }

  await page.route((url) => url.pathname === '/api/crm', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }

    const requestUrl = new URL(route.request().url())
    const entity = requestUrl.searchParams.get('entity') || 'organizations'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        entity,
        records: recordsByEntity[entity] || [],
        summary: {
          organizations: 1,
          contacts: 1,
          leads: 0,
          opportunities: 0,
          meetings: 1,
          interactions: 0,
          campaigns: 0,
          openPipelineValue: 0,
          weightedPipelineValue: 0,
          pendingSync: 0,
          failedSync: 0,
        },
        pipeline: {
          id: '00000000-0000-4000-8000-000000000100',
          name: 'Mobile Acceptance Pipeline',
          ownerEmail: 'operator@example.test',
          workspaceOrganizationId: null,
          accessRole: 'owner',
          shortLinkUrl: null,
        },
        workspaceHierarchy: [],
        canManageHierarchy: false,
        suiteCrmPunchoutUrl: null,
        suiteCrmUsername: null,
        suiteCrmAdminPortalUrl: null,
      }),
    })
  })
}

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`mobile workflows: ${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
    })

    test('Dashboard and Versions remain contained and vertically reachable', async ({ page }) => {
      await gotoApp(page, '/#dashboard')
      await expect(page.getByTestId('app-header')).toContainText('Dashboard')
      await expectUsableGeometry(page.getByLabel('Workspace pulse'), 'Dashboard workspace pulse', 88, 280)
      await expectNoDocumentOverflow(page)

      await page.goto('/#versions')
      await expect(activeSection(page).getByRole('heading', { name: 'Versions', exact: true })).toBeVisible()
      await expectUsableGeometry(activeSection(page), 'Versions page', MINIMUM_WORKSPACE_HEIGHT, 280)
      await expectNoDocumentOverflow(page)
    })

    test('Docs drawer and reading pane retain usable space', async ({ page }) => {
      await gotoApp(page, '/#docs')
      const toolbar = page.getByTestId('docs-mobile-toolbar')
      await expect(toolbar).toBeVisible()

      await page.getByTestId('docs-navigation-toggle').click()
      await expect(page.getByTestId('docs-navigation-drawer')).toBeVisible()
      await page.getByTestId('docs-navigation-close').click()
      await expect(page.getByTestId('docs-navigation-drawer')).toBeHidden()

      const viewerHost = toolbar.locator('xpath=following-sibling::*[1]')
      await expectScrollableWorkspace(page, viewerHost, 'y', 'Docs reading pane')
    })

    test('Projects filters, board, and card drawer remain operable', async ({ page }, testInfo) => {
      await gotoApp(page, '/#projects')
      const search = page.getByPlaceholder('Search cards...')
      await expect(search).toBeVisible()
      await search.fill('mobile-geometry-probe')
      await search.clear()

      const filtersButton = page.getByRole('button', { name: /^Filters/ })
      if (await filtersButton.isVisible().catch(() => false)) {
        await filtersButton.click()
        await expect(page.getByText('Filters', { exact: true }).last()).toBeVisible()
        await page.keyboard.press('Escape')
      } else {
        await expect(activeSection(page).getByRole('combobox').first()).toBeVisible()
      }

      const firstCard = page.locator('[id^="kanban-card-"]').first()
      if (await firstCard.count()) {
        await firstCard.click()
        const closeDrawer = page.getByRole('button', { name: 'Close drawer' })
        await expect(closeDrawer).toBeVisible()
        const drawer = closeDrawer.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
        await expectUsableGeometry(drawer, 'Project card drawer', 160, 280)
        await closeDrawer.click()
      } else {
        note(testInfo, 'No project cards were available for the read-only drawer check')
      }

      await expectScrollableWorkspace(page, activeSection(page), 'x', 'Projects board')
    })

    test('Managed CRM card links and write-through description remain usable', async ({ page }) => {
      const initialHash = 'a'.repeat(64)
      let patchBody: Record<string, unknown> | null = null
      const task = {
        id: 'crm-acceptance-card',
        title: 'gc7654321 - Acceptance Contact',
        desc: 'Initial CRM description',
        status: 'backlog',
        priority: 'medium',
        category: 'pipeline',
        tags: ['crm', 'contact'],
        createdAt: '2026-07-15T13:00:00.000Z',
        updatedAt: '2026-07-15T13:00:00.000Z',
        activity: [],
        comments: [],
        checklist: [],
        crm: {
          projectionVersion: 1,
          entity: 'contacts',
          entityId: '00000000-0000-4000-8000-000000000102',
          pipelineId: '00000000-0000-4000-8000-000000000100',
          referenceCode: 'gc7654321',
          recordName: 'Acceptance Contact',
          recordUrl: 'https://eigenracing.com/s/gc7654321',
          accountName: 'Acceptance Organization',
          accountReferenceCode: 'ga7654321',
          accountUrl: 'https://eigenracing.com/s/ga7654321',
          email: 'contact@example.test',
          emailUrl: 'https://eigenracing.com/s/mail-gc7654321',
          description: 'Initial CRM description',
          descriptionHash: initialHash,
          syncStatus: 'synced',
        },
      }
      await page.route((url) => url.pathname === '/api/tasks', async (route) => {
        if (route.request().method() === 'PATCH') {
          patchBody = route.request().postDataJSON() as Record<string, unknown>
          const description = String(patchBody.crmDescription || task.desc)
          await route.fulfill({ json: {
            ...task,
            desc: description,
            crm: { ...task.crm, description, descriptionHash: 'b'.repeat(64) },
          } })
          return
        }
        await route.fulfill({ json: [task] })
      })

      await gotoApp(page, '/#projects')
      await page.getByText(task.title, { exact: true }).click()
      const closeDrawer = page.getByRole('button', { name: 'Close drawer' })
      const drawer = closeDrawer.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Managed CRM card drawer', 160, 280)
      await expect(drawer.getByRole('link', { name: /gc7654321/ })).toHaveAttribute('href', task.crm.recordUrl)
      await expect(drawer.getByRole('link', { name: 'Acceptance Organization' })).toHaveAttribute('href', task.crm.accountUrl)
      await expect(drawer.getByRole('link', { name: 'contact@example.test' })).toHaveAttribute('href', task.crm.emailUrl)

      await drawer.getByText('Initial CRM description', { exact: true }).click()
      await drawer.getByPlaceholder('Add a description...').fill('Updated from the CRM card')
      await drawer.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => patchBody?.crmDescription).toBe('Updated from the CRM card')
      expect(patchBody?.crmDescriptionHash).toBe(initialHash)
      await closeDrawer.click()
      await expectNoDocumentOverflow(page)
    })

    test('Pipeline board and view selector retain a working viewport', async ({ page }) => {
      await gotoApp(page, '/#pipeline')
      await expect(page.getByText('Pipeline Value', { exact: true })).toBeVisible()

      const viewButtons = activeSection(page).locator('.MuiToggleButtonGroup-root').last().getByRole('button')
      await expect(viewButtons).toHaveCount(2)
      await viewButtons.nth(1).click()
      await expect(viewButtons.nth(1)).toHaveAttribute('aria-pressed', 'true')
      await viewButtons.nth(0).click()
      await expect(viewButtons.nth(0)).toHaveAttribute('aria-pressed', 'true')

      await expectScrollableWorkspace(page, activeSection(page), 'y', 'Pipeline workspace')
    })

    test('CRM tabs, records, and optional editor remain usable', async ({ page }, testInfo) => {
      await gotoApp(page, '/#crm')
      await expect(activeSection(page).getByRole('heading', { name: 'CRM', exact: true })).toBeVisible()
      await page.getByRole('tab', { name: 'Contacts' }).click()
      await expect(page.getByPlaceholder('Search contacts')).toBeVisible()

      const records = page.getByTestId('crm-records')
      await expectUsableGeometry(records, 'CRM records', MINIMUM_WORKSPACE_HEIGHT, 280)

      const addButton = activeSection(page).getByRole('button', { name: 'Add', exact: true })
      if (await addButton.isVisible().catch(() => false)) {
        await addButton.click()
        const closeEditor = page.getByRole('button', { name: 'Close editor' })
        await expect(closeEditor).toBeVisible()
        const drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
        await expectUsableGeometry(drawer, 'CRM editor drawer', 160, 280)
        await closeEditor.click()
      } else {
        note(testInfo, 'CRM is view-only, so the editor drawer was not opened')
      }

      await expectNoDocumentOverflow(page)
    })

    test('CRM reference redirect opens the CRM section without losing the reference', async ({ page }) => {
      const reference = 'ga7654321'
      await mockCrmRecords(page)
      await gotoApp(page, `/crm/${reference}`)

      await expect.poll(() => {
        const current = new URL(page.url())
        return `${current.pathname}|${current.searchParams.get('crm')}|${current.hash}`
      }).toBe(`/|${reference}|#crm`)
      const closeEditor = page.getByRole('button', { name: 'Close editor' })
      const drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'CRM reference drawer', 160, 280)
      await expect(drawer.getByText(reference, { exact: true })).toBeVisible()
      await closeEditor.click()
      await expect(activeSection(page).getByRole('heading', { name: 'CRM', exact: true })).toBeVisible()
      await expectNoDocumentOverflow(page)
    })

    test('CRM email controls and meeting scheduler remain usable without submitting actions', async ({ page }) => {
      await mockCrmRecords(page)
      await gotoApp(page, '/#crm')

      await page.getByRole('cell', { name: 'Acceptance Organization', exact: true }).click()
      let closeEditor = page.getByRole('button', { name: 'Close editor' })
      let drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Organization editor drawer', 160, 280)
      await expect(drawer.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('organization@example.test')
      await expect(drawer.getByRole('checkbox', { name: 'Do not email' })).not.toBeChecked()

      await drawer.getByRole('button', { name: 'Email', exact: true }).click()
      const emailDialog = page.getByRole('dialog', { name: 'Send email' })
      await expectUsableGeometry(emailDialog, 'Organization email composer', 160, 280)
      await expect(emailDialog.getByLabel('Subject')).toHaveValue('Follow-up: Acceptance Organization')
      await expect(emailDialog.getByLabel('Message')).toBeVisible()
      await emailDialog.getByRole('button', { name: 'Cancel' }).click()

      await drawer.getByRole('button', { name: 'Schedule', exact: true }).click()
      const organizationScheduleDialog = page.getByRole('dialog', { name: 'Schedule meeting' })
      await expectUsableGeometry(organizationScheduleDialog, 'Organization meeting scheduler', 160, 280)
      await expect(organizationScheduleDialog.getByLabel('Meeting')).toHaveValue('Meeting with Acceptance Organization')
      await expect(organizationScheduleDialog.getByLabel('Timezone')).toHaveValue('America/New_York')
      await organizationScheduleDialog.getByRole('button', { name: 'Cancel' }).click()
      await closeEditor.click()

      await page.getByRole('tab', { name: 'Contacts' }).click()
      await page.getByRole('cell', { name: 'Acceptance Contact', exact: true }).click()
      closeEditor = page.getByRole('button', { name: 'Close editor' })
      drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Contact editor drawer', 160, 280)
      await expect(drawer.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('contact@example.test')
      await expect(drawer.getByRole('checkbox', { name: 'Do not email' })).toBeChecked()
      await expect(drawer.getByRole('button', { name: 'Email', exact: true })).toBeDisabled()
      await closeEditor.click()

      await page.getByRole('tab', { name: 'Meetings' }).click()
      await page.getByRole('cell', { name: 'Acceptance Meeting', exact: true }).click()
      closeEditor = page.getByRole('button', { name: 'Close editor' })
      drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Meeting editor drawer', 160, 280)
      await expect(drawer.getByLabel('Starts')).toHaveValue('2026-07-15T09:00')
      await expect(drawer.getByLabel('Ends')).toHaveValue('2026-07-15T09:30')
      await expect(drawer.getByLabel('Timezone')).toHaveValue('America/New_York')
      await expect(drawer.getByLabel('Attendee emails')).toHaveValue('contact@example.test')

      await drawer.getByRole('button', { name: 'Schedule', exact: true }).click()
      const meetingScheduleDialog = page.getByRole('dialog', { name: 'Schedule meeting' })
      await expectUsableGeometry(meetingScheduleDialog, 'Meeting scheduling dialog', 160, 280)
      await expect(meetingScheduleDialog.getByLabel('Meeting')).toHaveValue('Acceptance Meeting')
      await expect(meetingScheduleDialog.getByLabel('Starts')).toHaveValue('2026-07-15T09:00')
      await expect(meetingScheduleDialog.getByLabel('Ends')).toHaveValue('2026-07-15T09:30')
      await expect(meetingScheduleDialog.getByLabel('Timezone')).toHaveValue('America/New_York')
      await expect(meetingScheduleDialog.getByLabel('Attendee emails')).toHaveValue('contact@example.test')
      await meetingScheduleDialog.getByRole('button', { name: 'Cancel' }).click()
      await closeEditor.click()
      await expectNoDocumentOverflow(page)
    })

    test('Agents task selector and chat composer remain reachable', async ({ page }) => {
      await gotoApp(page, '/#agents')
      await expect(activeSection(page).getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()

      const taskSelector = activeSection(page).getByRole('combobox').first()
      await taskSelector.scrollIntoViewIfNeeded()
      await expectUsableGeometry(taskSelector, 'Agent task selector', 38, 220)

      const composer = page.getByPlaceholder(/Message .* about this task|Assign a task to start a thread/)
      await composer.scrollIntoViewIfNeeded()
      const composerControl = composer.locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]')
      await expectUsableGeometry(composerControl, 'Agent chat composer', 38, 220)
      await expect(page.getByRole('button', { name: 'Send to assigned agent' })).toBeVisible()
      await expectNoDocumentOverflow(page)
    })

    test('Settings tabs and activity drawer remain contained', async ({ page }) => {
      await gotoApp(page, '/#dashboard')
      await page.getByRole('button', { name: 'Settings' }).click()
      await page.getByRole('menuitem', { name: /Workspace settings/ }).click()

      const settings = page.getByRole('dialog', { name: 'Settings' })
      await expectUsableGeometry(settings, 'Settings dialog', 160, 280)
      for (const tabName of ['Profile', 'People', 'Sharing', 'Integrations']) {
        const tab = settings.getByRole('tab', { name: tabName })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
      }
      await settings.getByRole('button', { name: 'Close settings' }).click()

      await page.getByRole('button', { name: 'Activity log' }).click()
      const activityDrawer = page.locator('.MuiDrawer-paper').filter({ hasText: 'Activity Log' })
      await expectUsableGeometry(activityDrawer, 'Activity drawer', 160, 280)
      await page.keyboard.press('Escape')
      await expect(activityDrawer).toBeHidden()
      await expectNoDocumentOverflow(page)
    })

    test('Links is covered when enabled and explicitly limited for local file storage', async ({ page }, testInfo) => {
      await gotoApp(page, '/#links')

      const linksHeading = page
        .getByTestId('short-links-section')
        .getByRole('heading', { name: 'Short Links', exact: true })
      const outcome = await Promise.race([
        linksHeading.waitFor({ state: 'visible', timeout: 5000 }).then(() => 'links' as const),
        page.waitForURL(/#dashboard$/, { timeout: 5000 }).then(() => 'dashboard' as const),
      ])

      if (outcome === 'dashboard') {
        const hostname = new URL(page.url()).hostname
        expect(['localhost', '127.0.0.1'].includes(hostname), 'Hosted runs must expose the Postgres-backed Links surface').toBeTruthy()
        note(testInfo, 'Local file-backed mode intentionally redirects Links to Dashboard')
        return
      }

      await expectUsableGeometry(page.getByTestId('short-links-section'), 'Links page', MINIMUM_WORKSPACE_HEIGHT, 280)
      await page.getByTestId('create-short-link').click()
      const form = page.getByRole('dialog', { name: 'Create short link' })
      await expectUsableGeometry(form, 'Short Link form', 160, 280)
      await form.getByRole('button', { name: 'Close short link form' }).click()
      await expectNoDocumentOverflow(page)
    })

    test('Login and invitation surfaces remain contained without an authenticated session', async ({ page }) => {
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: 'ClawPilot' })).toBeVisible()
      await expectUsableGeometry(page.locator('main'), 'Login page', 160, 280)
      await expect(page.getByLabel('Email')).toBeVisible()
      await expectNoDocumentOverflow(page)

      await page.goto('/welcome?token=mobile-acceptance-invalid-token')
      await expect(page.getByRole('heading', { name: 'Welcome to ClawPilot' })).toBeVisible()
      await expectUsableGeometry(page.locator('main'), 'Invitation page', 160, 280)
      await expectNoDocumentOverflow(page)
    })
  })
}
