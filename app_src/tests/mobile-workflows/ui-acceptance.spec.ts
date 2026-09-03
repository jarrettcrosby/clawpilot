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

async function openWorkspaceSettings(page: Page) {
  const settingsButton = page.getByRole('button', { name: 'Settings' })
  const workspaceSettings = page.getByRole('menuitem', { name: /Workspace settings/ })

  await expect(async () => {
    if (!await workspaceSettings.isVisible()) await settingsButton.click()
    await expect(workspaceSettings).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await workspaceSettings.click()
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

type MockCrmOptions = {
  failFirstCalendarAction?: boolean
  failFirstMeetingCreate?: boolean
  failFirstMeetingUpdate?: boolean
  googleMailSource?: 'organization' | 'user-default'
}

type CapturedCrmWrite = {
  body: Record<string, unknown>
  idempotencyHeader: string
}

async function mockCrmRecords(page: Page, options: MockCrmOptions = {}) {
  const crmWrites: Array<Record<string, unknown>> = []
  const crmWriteRequests: CapturedCrmWrite[] = []
  let failedCalendarAction = false
  let failedMeetingCreate = false
  let failedMeetingUpdate = false
  await page.route((url) => url.pathname === '/api/workspaces', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        boards: [],
        pipelines: [{
          id: '00000000-0000-4000-8000-000000000100',
          name: 'Mobile Acceptance Pipeline',
          ownerEmail: 'operator@example.test',
          accessRole: 'owner',
        }],
        selectedBoardId: null,
        selectedPipelineId: '00000000-0000-4000-8000-000000000100',
      },
    })
  })

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
    }, {
      id: '00000000-0000-4000-8000-000000000201',
      referenceCode: 'ga9753102',
      shortUrl: null,
      name: 'Other Organization',
      parentOrganizationName: 'Acceptance Workspace',
      relationshipType: 'customer',
      workspaceOrganizationId: null,
      accountManager: 'Support Operator',
      phone: '+1 555 0202',
      email: 'other-organization@example.test',
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
      accountManager: 'Mobile Operator',
      ownerUserReferenceCode: 'gu2468135',
      ownerEmail: 'operator@example.test',
      ownerDisplayName: 'Mobile Operator',
      jobTitle: 'Mobile Lead',
      email: 'contact@example.test',
      emailOptOut: true,
      syncStatus: 'synced',
    }, {
      id: '00000000-0000-4000-8000-000000000202',
      referenceCode: 'gc9753102',
      shortUrl: null,
      fullName: 'Other Contact',
      organizationId: '00000000-0000-4000-8000-000000000201',
      organizationName: 'Other Organization',
      accountManager: 'Support Operator',
      ownerUserReferenceCode: 'gu9753102',
      ownerEmail: 'support@example.test',
      ownerDisplayName: 'Support Operator',
      jobTitle: 'Other Lead',
      email: 'other-contact@example.test',
      emailOptOut: false,
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
      calendarDeliveryStatus: 'sent',
      calendarOrganizerEmail: 'operator@example.test',
      calendarConnectionId: 'calendar-personal-connection',
      calendarId: 'operator@example.test',
      meetingMode: 'google_meet',
      provider: 'maton',
      syncStatus: 'synced',
    }, {
      id: '00000000-0000-4000-8000-000000000203',
      referenceCode: 'gm9753102',
      shortUrl: null,
      subject: 'Legacy Meeting Without Delivery Evidence',
      organizationId: '00000000-0000-4000-8000-000000000201',
      organizationName: 'Other Organization',
      contactId: '00000000-0000-4000-8000-000000000202',
      contactName: 'Other Contact',
      startsAt: '2026-07-16T13:00:00.000Z',
      endsAt: '2026-07-16T13:30:00.000Z',
      timezone: 'America/New_York',
      attendeeEmails: ['other-contact@example.test'],
      status: 'scheduled',
      syncStatus: 'synced',
    }, {
      id: '00000000-0000-4000-8000-000000000303',
      referenceCode: 'gm8642097',
      shortUrl: null,
      subject: 'Existing Custom Meeting',
      organizationId: '00000000-0000-4000-8000-000000000101',
      organizationName: 'Acceptance Organization',
      contactId: '00000000-0000-4000-8000-000000000102',
      contactName: 'Acceptance Contact',
      startsAt: '2026-07-18T15:00:00.000Z',
      endsAt: '2026-07-18T15:45:00.000Z',
      timezone: 'America/New_York',
      location: '',
      attendeeEmails: ['contact@example.test'],
      status: 'scheduled',
      calendarDeliveryStatus: 'sent',
      calendarOrganizerEmail: 'operator@example.test',
      calendarOwnerEmail: 'operator@example.test',
      calendarConnectionId: 'calendar-personal-connection',
      calendarId: 'operator@example.test',
      meetingMode: 'custom_link',
      customJoinUrl: 'https://meet.example.test/existing-custom',
      joinUrl: 'https://meet.example.test/existing-custom',
      externalEventId: 'existing-custom-event',
      externalEventUrl: 'https://calendar.google.com/calendar/event?eid=existing-custom-event',
      provider: 'maton',
      syncStatus: 'synced',
    }],
    leads: [],
    opportunities: [{
      id: '00000000-0000-4000-8000-000000000108',
      referenceCode: 'go7654321',
      shortUrl: null,
      name: 'Acceptance opportunity',
      organizationId: '00000000-0000-4000-8000-000000000101',
      organization: 'Acceptance Organization',
      stage: 'Qualified Lead',
      status: 'Open',
      products: [{
        id: '00000000-0000-4000-8000-000000000106',
        referenceCode: 'gp7654321',
        name: 'Acceptance Product',
      }],
      syncStatus: 'synced',
    }, {
      id: '00000000-0000-4000-8000-000000000208',
      referenceCode: 'go9753102',
      shortUrl: null,
      name: 'Other opportunity',
      organizationId: '00000000-0000-4000-8000-000000000201',
      organization: 'Other Organization',
      stage: 'Proposal',
      status: 'Open',
      products: [{
        id: '00000000-0000-4000-8000-000000000206',
        referenceCode: 'gp9753102',
        name: 'Other Product',
      }],
      syncStatus: 'synced',
    }],
    products: [{
      id: '00000000-0000-4000-8000-000000000106',
      referenceCode: 'gp7654321',
      shortUrl: null,
      name: 'Acceptance Product',
      sku: 'ACCEPT-01',
      productType: 'Service',
      category: 'Acceptance',
      status: 'Active',
      price: 250,
      cost: 50,
      currency: 'USD',
      url: 'https://example.test/product',
      active: true,
      syncStatus: 'synced',
    }],
    interactions: [{
      id: '00000000-0000-4000-8000-000000000104',
      referenceCode: 'gi7654321',
      shortUrl: null,
      subject: 'Acceptance Interaction',
      organizationId: '00000000-0000-4000-8000-000000000101',
      organizationName: 'Acceptance Organization',
      contactId: '00000000-0000-4000-8000-000000000102',
      opportunityId: null,
      leadId: null,
      meetingId: null,
      campaignId: null,
      interactionType: 'Call',
      occurredAt: '2026-07-15T14:00:00.000Z',
      agentEmail: 'operator@example.test',
      agentName: 'Mobile Operator',
      description: 'Acceptance interaction notes',
      syncStatus: 'synced',
    }],
    campaigns: [],
  }

  await page.route((url) => url.pathname === '/api/crm', async (route) => {
    if (route.request().method() !== 'GET') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      crmWrites.push(body)
      crmWriteRequests.push({
        body,
        idempotencyHeader: route.request().headers()['idempotency-key'] || '',
      })
      const newMeetingCreate = route.request().method() === 'POST'
        && body.entity === 'meetings'
        && !body.id
      const existingMeetingUpdate = route.request().method() === 'POST'
        && body.entity === 'meetings'
        && Boolean(body.id)
      if (options.failFirstMeetingCreate && newMeetingCreate && !failedMeetingCreate) {
        failedMeetingCreate = true
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Simulated lost meeting response' }),
        })
        return
      }
      if (options.failFirstMeetingUpdate && existingMeetingUpdate && !failedMeetingUpdate) {
        failedMeetingUpdate = true
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Simulated lost meeting update response' }),
        })
        return
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, queued: true, record: { id: '00000000-0000-4000-8000-000000000107' } }),
      })
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
          organizations: 2,
          contacts: 2,
          leads: 0,
          opportunities: 2,
          products: 1,
          meetings: 3,
          interactions: 1,
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
          shortLinkUrl: 'https://eigenracing.com/s/mobile-workbook',
        },
        workspaceHierarchy: [{
          id: '00000000-0000-4000-8000-000000000105',
          parentId: null,
          parentName: null,
          name: 'Acceptance Workspace',
          organizationType: 'root',
          depth: 0,
          members: [],
        }],
        canManageHierarchy: false,
        pipelineUsers: [{
          referenceCode: 'gu2468135',
          email: 'operator@example.test',
          displayName: 'Mobile Operator',
          suiteCrmMapped: true,
          suiteCrmUsername: 'operator',
        }, {
          referenceCode: 'gu9753102',
          email: 'support@example.test',
          displayName: 'Support Operator',
          suiteCrmMapped: false,
          suiteCrmUsername: null,
        }],
        providerIdentities: {
          googleMail: 'sender@example.test',
          googleMailSendAsEmail: 'sender@example.test',
          googleMailConnectionId: 'gmail-connection',
          googleMailAccountEmail: 'operator@example.test',
          googleMailSource: options.googleMailSource || 'organization',
          googleCalendar: 'calendar@example.test',
          googleCalendarOrganizer: 'calendar@example.test',
          googleCalendarConnectionId: 'calendar-org-connection',
          googleCalendarId: 'calendar@example.test',
          googleCalendarSource: 'organization',
        },
        suiteCrmPunchoutUrl: 'https://crm.eigenracing.com',
        suiteCrmUsername: 'admin',
        suiteCrmAdminPortalUrl: 'https://railway.com/project/clawpilot',
      }),
    })
  })

  await page.route((url) => url.pathname === '/api/crm/actions', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    crmWrites.push(body)
    crmWriteRequests.push({
      body,
      idempotencyHeader: route.request().headers()['idempotency-key'] || '',
    })
    if (
      options.failFirstCalendarAction
      && body.actionType === 'create_calendar_event'
      && !failedCalendarAction
    ) {
      failedCalendarAction = true
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'Simulated lost Calendar response' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        action: {
          status: 'succeeded',
          lastError: null,
          responseSummary: {},
        },
      }),
    })
  })
  return { crmWrites, crmWriteRequests }
}

async function mockOrganizationCommunications(
  page: Page,
  options: {
    canManage?: boolean
    includeConfiguredGmailConnection?: boolean
    includeOrganizationConnection?: boolean
  } = {},
) {
  const canManage = options.canManage ?? true
  const includeConfiguredGmailConnection = options.includeConfiguredGmailConnection ?? true
  const includeOrganizationConnection = options.includeOrganizationConnection ?? true
  await page.route((url) => url.pathname === '/api/integrations/maton', async (route) => {
    await route.fulfill({ json: {
      ok: true,
      platformCredentialAvailable: false,
      credential: {
        configured: true,
        loginEmail: 'operator@example.test',
        keyLastFour: '1234',
        updatedAt: '2026-07-16T13:00:00.000Z',
        connections: [{
          provider: 'google-mail',
          app: 'google-mail',
          label: 'Personal Gmail',
          connectionId: 'gmail-connection',
          accountEmail: 'operator@example.test',
          status: 'ACTIVE',
          selected: true,
        }, {
          provider: 'google-mail',
          app: 'google-mail',
          label: 'Stewards Gmail',
          connectionId: 'gmail-stewards-connection',
          accountEmail: 'jarrettcrosby@gmail.com',
          status: 'ACTIVE',
          selected: false,
        }, {
          provider: 'google-calendar',
          app: 'google-calendar',
          label: 'Personal Google Calendar',
          connectionId: 'calendar-personal-connection',
          accountEmail: 'operator@example.test',
          status: 'ACTIVE',
          selected: true,
        }, {
          provider: 'google-calendar',
          app: 'google-calendar',
          label: 'Suburbia Google Calendar',
          connectionId: 'calendar-org-connection',
          accountEmail: 'calendar@example.test',
          status: 'ACTIVE',
          selected: false,
        }],
      },
    } })
  })
  await page.route((url) => url.pathname === '/api/integrations/communications', async (route) => {
    await route.fulfill({ json: {
      ok: true,
      canManage,
      communication: {
        organizationId: '00000000-0000-4000-8000-000000000100',
        bindings: canManage ? [{
          app: 'google-mail',
          connectionId: 'gmail-connection',
          accountEmail: 'operator@example.test',
          identityEmail: 'sender@example.test',
          calendarId: null,
          status: 'active',
          verifiedAt: '2026-07-16T13:00:00.000Z',
        }, {
          app: 'google-calendar',
          connectionId: 'calendar-org-connection',
          accountEmail: 'calendar@example.test',
          identityEmail: 'calendar@example.test',
          calendarId: 'calendar@example.test',
          status: 'active',
          verifiedAt: '2026-07-16T13:00:00.000Z',
        }] : [],
        availableConnections: [...(includeConfiguredGmailConnection ? [{
          connectionId: 'gmail-connection',
          name: 'Personal Gmail',
          app: 'google-mail',
          accountEmail: 'operator@example.test',
          selectedForUser: true,
          gmailSendAsIdentities: [{
            email: 'operator@example.test',
            verificationStatus: 'accepted',
            isDefault: true,
          }, {
            email: 'sender@example.test',
            verificationStatus: 'accepted',
            isDefault: false,
          }, {
            email: 'pending@example.test',
            verificationStatus: 'pending',
            isDefault: false,
          }],
        }] : []), {
          connectionId: 'gmail-stewards-connection',
          name: 'Stewards Gmail',
          app: 'google-mail',
          accountEmail: 'jarrettcrosby@gmail.com',
          selectedForUser: false,
          gmailSendAsIdentities: [{
            email: 'jarrettcrosby@gmail.com',
            verificationStatus: 'accepted',
            isDefault: true,
          }, {
            email: 'stewards@eigenracing.com',
            verificationStatus: 'accepted',
            isDefault: false,
          }],
        }, {
          connectionId: 'calendar-personal-connection',
          name: 'Personal Google Calendar',
          app: 'google-calendar',
          accountEmail: 'operator@example.test',
          selectedForUser: true,
          calendars: [{
            id: 'operator@example.test',
            summary: 'Personal calendar',
            primary: true,
            accessRole: 'owner',
          }],
        }, ...(includeOrganizationConnection ? [{
          connectionId: 'calendar-org-connection',
          name: 'Suburbia Google Calendar',
          app: 'google-calendar',
          accountEmail: 'calendar@example.test',
          selectedForUser: false,
          calendars: [{
            id: 'calendar@example.test',
            summary: 'Organization calendar',
            primary: true,
            accessRole: 'owner',
          }],
        }] : [])],
      },
    } })
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
      await page.route((url) => url.pathname === '/api/workspaces', async (route) => {
        await route.fulfill({
          json: {
            ok: true,
            boards: [{
              id: '00000000-0000-4000-8000-000000000106',
              name: 'CRM Acceptance Board',
              ownerEmail: 'operator@example.test',
              accessRole: 'owner',
            }],
            pipelines: [],
            selectedBoardId: '00000000-0000-4000-8000-000000000106',
            selectedPipelineId: null,
          },
        })
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
      await expect.poll(() => patchBody?.crmDescriptionHash).toBe(initialHash)
      await closeDrawer.click()
      await expectNoDocumentOverflow(page)
    })

    test('Pipeline board and view selector retain a working viewport', async ({ page }) => {
      await page.route((url) => url.pathname === '/api/pipeline/catalog', async (route) => {
        await route.fulfill({ json: {
          ok: true,
          pipelineId: '00000000-0000-4000-8000-000000000100',
          canEdit: true,
          people: [{
            id: '00000000-0000-4000-8000-000000000107',
            referenceCode: 'gc1234567',
            displayName: 'Mobile Operator',
            email: 'operator@example.test',
            jobTitle: 'Owner',
            source: 'app_user',
            appAccess: true,
            status: 'active',
            active: true,
          }],
          products: Array.from({ length: 80 }, (_, index) => ({
            id: `00000000-0000-4000-8000-${String(108 + index).padStart(12, '0')}`,
            referenceCode: `gp${String(1234568 + index).padStart(7, '0')}`,
            name: `Acceptance Product ${index + 1}`,
            sku: `ACCEPT-${String(index + 1).padStart(2, '0')}`,
            productType: 'Service',
            category: 'Acceptance',
            status: 'Active',
            price: 125,
            cost: 25,
            currency: 'USD',
            url: 'https://example.test/acceptance',
            description: '',
            active: true,
          })),
        } })
      })
      await gotoApp(page, '/#pipeline')
      await expect(page.getByText('Active Pipeline', { exact: true })).toBeVisible()

      await page.getByRole('button', { name: 'Open pipeline setup' }).click()
      const setupDialog = page.getByRole('dialog', { name: /Pipeline setup/ })
      await expectUsableGeometry(setupDialog, 'Pipeline setup', 160, 280)
      await expect(setupDialog.getByText('Mobile Operator', { exact: true })).toBeVisible()
      await setupDialog.getByRole('tab', { name: /Products/ }).click()
      await expect(setupDialog.getByText('Acceptance Product 1', { exact: true })).toBeVisible()
      await setupDialog.getByRole('button', {
        name: 'Edit Acceptance Product 1',
        exact: true,
      }).click()
      const productEditor = setupDialog.getByRole('region', { name: 'Product editor' })
      await expect(productEditor).toBeInViewport()
      await expect(productEditor.getByRole('textbox', { name: 'Product name' })).toHaveValue('Acceptance Product 1')
      await productEditor.getByRole('button', { name: 'Cancel' }).click()
      await setupDialog.getByRole('tab', { name: 'Workflow', exact: true }).click()
      await expect(setupDialog.getByRole('textbox', { name: 'Stages' })).toBeVisible()
      await setupDialog.getByRole('button', { name: 'Close pipeline setup' }).click()

      const viewSelector = activeSection(page).locator('.MuiToggleButtonGroup-root').last()
      await expect(viewSelector.getByRole('button')).toHaveCount(4)
      const dashboardView = viewSelector.getByRole('button', { name: 'Dashboard view', exact: true })
      const insightsView = viewSelector.getByRole('button', { name: 'Pipeline insights', exact: true })
      const listView = viewSelector.getByRole('button', { name: 'List view', exact: true })
      const boardView = viewSelector.getByRole('button', { name: 'Board view', exact: true })
      await dashboardView.click()
      await expect(dashboardView).toHaveAttribute('aria-pressed', 'true')
      await insightsView.click()
      await expect(insightsView).toHaveAttribute('aria-pressed', 'true')
      await listView.click()
      await expect(listView).toHaveAttribute('aria-pressed', 'true')
      await boardView.click()
      await expect(boardView).toHaveAttribute('aria-pressed', 'true')

      await expectScrollableWorkspace(page, activeSection(page), 'y', 'Pipeline workspace')
    })

    test('CRM tabs, records, and optional editor remain usable', async ({ page }, testInfo) => {
      const { crmWrites } = await mockCrmRecords(page)
      await gotoApp(page, '/#crm')
      await expect(activeSection(page).getByRole('heading', { name: 'CRM', exact: true })).toBeVisible()
      const primaryActions = page.getByTestId('crm-primary-actions')
      const summaryStrip = page.getByTestId('crm-summary-strip')
      const recordTabs = page.getByRole('tablist', { name: 'CRM record types' })
      await expectUsableGeometry(primaryActions, 'CRM primary actions', 40, 280)
      await expectUsableGeometry(summaryStrip, 'CRM summary strip', 32, 280)
      await expectUsableGeometry(recordTabs, 'CRM record tabs', viewport.name === 'landscape' ? 36 : 40, 280)
      if (viewport.name === 'portrait') {
        await expect.poll(async () => primaryActions.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
        await expect(primaryActions.getByRole('button', { name: 'Organization hierarchy' })).toBeVisible()
        await expect(primaryActions.getByRole('link', { name: 'Open workbook' })).toBeVisible()
        await expect(primaryActions.getByRole('button', { name: 'Open SuiteCRM' })).toBeVisible()
      }
      await page.getByRole('tab', { name: 'Products' }).click()
      await expect(page.getByPlaceholder('Search products')).toBeVisible()
      await page.getByRole('cell', { name: 'Acceptance Product', exact: true }).click()
      const productDrawer = page.getByRole('button', { name: 'Close editor' }).locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(productDrawer, 'CRM product editor drawer', 160, 280)
      await expect(productDrawer.getByLabel('Product name')).toHaveValue('Acceptance Product')
      await page.getByRole('button', { name: 'Close editor' }).click()

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
        await drawer.getByLabel('Contact Full Name').fill('Assigned Contact')
        await drawer.getByRole('combobox', { name: 'Organization' }).click()
        await page.getByRole('option', { name: 'Acceptance Organization' }).click()
        await drawer.getByRole('combobox', { name: 'Owner' }).click()
        await page.getByRole('option', { name: 'Support Operator (support@example.test)' }).click()
        await drawer.getByRole('button', { name: 'Save' }).click()
        await expect.poll(() => {
          const fields = crmWrites.at(-1)?.fields as Record<string, unknown> | undefined
          return fields?.ownerUserReferenceCode
        }).toBe('gu9753102')
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

    test('CRM interaction deep link hydrates its organization relationship', async ({ page }) => {
      const warnings: string[] = []
      let organizationRequests = 0
      page.on('console', (message) => {
        if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text())
      })
      page.on('request', (request) => {
        const url = new URL(request.url())
        if (url.pathname === '/api/crm' && url.searchParams.get('entity') === 'organizations') {
          organizationRequests += 1
        }
      })
      await mockCrmRecords(page)
      await gotoApp(page, '/crm/gi7654321')

      const drawer = page.getByRole('button', { name: 'Close editor' })
        .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Interaction editor drawer', 160, 280)
      await expect(drawer.getByRole('combobox', { name: 'Organization' })).toContainText('Acceptance Organization')
      await expect(drawer.getByText('Acceptance Contact', { exact: true })).toBeVisible()
      await expect(drawer.getByRole('combobox', { name: 'Type' })).toContainText('Call')
      await expect(drawer.getByRole('combobox', { name: 'Agent' })).toContainText('Mobile Operator')
      await expect.poll(() => organizationRequests).toBeGreaterThan(0)
      expect(warnings.filter((warning) => /out-of-range value/i.test(warning))).toEqual([])
      await expectNoDocumentOverflow(page)
    })

    test('CRM email controls and meeting scheduler remain usable', async ({ page }) => {
      await mockOrganizationCommunications(page, { includeOrganizationConnection: false })
      const { crmWriteRequests } = await mockCrmRecords(page, { failFirstCalendarAction: true })
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
      const emailSender = emailDialog.getByRole('combobox', { name: 'Send from' })
      await expect(emailSender).toContainText('sender@example.test')
      await expect(emailSender).toContainText('Organization default')
      await emailSender.click()
      await expect(page.getByRole('option', { name: /stewards@eigenracing\.com.*jarrettcrosby@gmail\.com/ }))
        .toBeVisible()
      await expect(page.getByRole('option', { name: /pending@example\.test/ })).toHaveCount(0)
      await page.getByRole('option', { name: /stewards@eigenracing\.com.*jarrettcrosby@gmail\.com/ }).click()
      await expect(emailDialog.getByLabel('Subject')).toHaveValue('Follow-up: Acceptance Organization')
      await emailDialog.getByLabel('Message').fill('Reviewed sender-alias acceptance message')
      await emailDialog.getByRole('button', { name: 'Send' }).click()
      await expect(emailDialog).toBeHidden()
      const explicitEmailRequest = crmWriteRequests.find(
        (request) => request.body.actionType === 'send_email',
      )
      expect(explicitEmailRequest?.body).toMatchObject({
        gmailConnectionId: 'gmail-stewards-connection',
        gmailSendAsEmail: 'stewards@eigenracing.com',
      })
      expect(explicitEmailRequest?.body.payload).not.toMatchObject({
        gmailConnectionId: expect.anything(),
        gmailSendAsEmail: expect.anything(),
      })

      await drawer.getByRole('button', { name: 'Schedule', exact: true }).click()
      const organizationScheduleDialog = page.getByRole('dialog', { name: 'Schedule meeting' })
      await expectUsableGeometry(organizationScheduleDialog, 'Organization meeting scheduler', 160, 280)
      await expect(organizationScheduleDialog.getByRole('combobox', { name: 'Send from calendar' }))
        .toContainText('Organization default')
      await expect(organizationScheduleDialog.getByText(/Invitation organizer: calendar@example\.test/))
        .toBeVisible()
      await organizationScheduleDialog.getByRole('combobox', { name: 'Send from calendar' }).click()
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2)
      await expect(page.getByRole('option', { name: /calendar@example\.test.*Organization default/ })).toBeVisible()
      await expect(page.getByRole('option', { name: /Personal calendar.*operator@example\.test/ })).toBeVisible()
      await page.getByRole('option', { name: /calendar@example\.test.*Organization default/ }).click()
      await expect(organizationScheduleDialog.getByRole('textbox', { name: 'Meeting', exact: true }))
        .toHaveValue('Meeting with Acceptance Organization')
      await expect(organizationScheduleDialog.getByLabel('Timezone')).toHaveValue('America/New_York')
      await organizationScheduleDialog.getByLabel('Start').fill('2026-07-16T10:00')
      const organizationSend = organizationScheduleDialog.getByRole('button', { name: 'Send' })
      await organizationSend.click()
      await expect(organizationScheduleDialog).toBeVisible()
      await expect(organizationSend).toBeEnabled()
      await organizationSend.click()
      await expect(organizationScheduleDialog).toBeHidden()

      const defaultCalendarRequests = crmWriteRequests.filter(
        (request) => request.body.actionType === 'create_calendar_event',
      )
      expect(defaultCalendarRequests).toHaveLength(2)
      const firstDefaultRequest = defaultCalendarRequests[0]
      const retriedDefaultRequest = defaultCalendarRequests[1]
      expect(firstDefaultRequest.body.idempotencyKey).toMatch(/^crm-ui:create_calendar_event:/)
      expect(retriedDefaultRequest.body.idempotencyKey).toBe(firstDefaultRequest.body.idempotencyKey)
      expect(firstDefaultRequest.idempotencyHeader).toBe(firstDefaultRequest.body.idempotencyKey)
      expect(retriedDefaultRequest.idempotencyHeader).toBe(firstDefaultRequest.idempotencyHeader)
      expect(firstDefaultRequest.body).not.toHaveProperty('calendarConnectionId')
      expect(firstDefaultRequest.body).not.toHaveProperty('calendarId')
      expect(firstDefaultRequest.body.payload).not.toMatchObject({
        calendarConnectionId: expect.anything(),
        calendarId: expect.anything(),
      })
      await closeEditor.click()

      await page.getByRole('tab', { name: 'Contacts' }).click()
      await page.getByRole('cell', { name: 'Acceptance Contact', exact: true }).click()
      closeEditor = page.getByRole('button', { name: 'Close editor' })
      drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Contact editor drawer', 160, 280)
      const relatedOrganization = drawer.getByRole('button', { name: 'Open organization Acceptance Organization' })
      await expect(relatedOrganization).toBeVisible()
      await expect(relatedOrganization).toContainText('Acceptance Organization')
      await expect(relatedOrganization).toContainText('ga7654321')
      await expect(drawer.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('contact@example.test')
      await expect(drawer.getByRole('combobox', { name: 'Owner' })).toContainText('Mobile Operator')
      await expect(drawer.getByRole('checkbox', { name: 'Do not email' })).toBeChecked()
      await expect(drawer.getByRole('button', { name: 'Email', exact: true })).toBeDisabled()
      await relatedOrganization.click()
      await expect(drawer.getByRole('heading', { name: 'Edit Organization' })).toBeVisible()
      await expect(drawer.getByRole('textbox', { name: 'Organization', exact: true })).toHaveValue('Acceptance Organization')
      await drawer.getByRole('button', { name: 'Back to contact' }).click()
      await expect(drawer.getByRole('heading', { name: 'Edit Contact' })).toBeVisible()
      await expect(drawer.getByRole('button', { name: 'Open organization Acceptance Organization' })).toBeVisible()
      await closeEditor.click()

      await page.getByRole('tab', { name: 'Meetings' }).click()
      const meetingRow = page.getByRole('row').filter({ hasText: 'Acceptance Meeting' })
      await expect(meetingRow.getByText('Delivered', { exact: true })).toBeVisible()
      await expect(meetingRow.getByText('Synced', { exact: true })).toBeVisible()
      const legacyMeetingRow = page.getByRole('row').filter({ hasText: 'Legacy Meeting Without Delivery Evidence' })
      await expect(legacyMeetingRow.getByText('Unknown', { exact: true })).toBeVisible()
      await expect(legacyMeetingRow.getByText('Delivered', { exact: true })).toHaveCount(0)
      await expect(legacyMeetingRow.getByText('Synced', { exact: true })).toBeVisible()
      await page.getByRole('cell', { name: 'Acceptance Meeting', exact: true }).click()
      closeEditor = page.getByRole('button', { name: 'Close editor' })
      drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Meeting editor drawer', 160, 280)
      const editorSendFromCalendar = drawer.getByRole('combobox', { name: 'Send from calendar' })
      await expect(editorSendFromCalendar).toContainText('Personal calendar')
      await expect(drawer.getByText(/Invitation organizer: operator@example\.test/)).toBeVisible()
      await editorSendFromCalendar.click()
      await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2)
      await expect(page.getByRole('option', { name: /calendar@example\.test.*Organization default/ })).toBeVisible()
      await expect(page.getByRole('option', { name: /Personal calendar.*operator@example\.test/ })).toBeVisible()
      await page.getByRole('option', { name: /Personal calendar.*operator@example\.test/ }).click()
      await expect(drawer.getByRole('combobox', { name: 'Meeting type' })).toContainText('Google Meet')
      await expect(drawer.getByLabel('Start')).toHaveValue('2026-07-15T09:00')
      await expect(drawer.getByRole('combobox', { name: 'Duration' })).toContainText('30 minutes')
      await expect(drawer.getByLabel('Ends')).toHaveValue('2026-07-15T09:30')
      await expect(drawer.getByLabel('Timezone')).toHaveValue('America/New_York')
      await expect(drawer.getByLabel('Attendee emails')).toHaveValue('contact@example.test')
      await expect(drawer.getByText('Organizer: operator@example.test', { exact: true })).toBeVisible()
      await expect(drawer.getByText('Calendar: operator@example.test', { exact: true })).toBeVisible()

      await drawer.getByRole('combobox', { name: 'Contact' }).click()
      await expect(page.getByRole('option', { name: 'Acceptance Contact' })).toBeVisible()
      await expect(page.getByRole('option', { name: 'Other Contact' })).toHaveCount(0)
      await page.keyboard.press('Escape')

      await drawer.getByRole('combobox', { name: 'Pipeline opportunity' }).click()
      await expect(page.getByRole('option', {
        name: 'Acceptance Product - Acceptance Organization · Qualified Lead · go7654321',
      })).toBeVisible()
      await expect(page.getByRole('option', {
        name: 'Other Product - Other Organization · Proposal · go9753102',
      })).toHaveCount(0)
      await page.keyboard.press('Escape')

      await drawer.getByRole('button', { name: 'Schedule', exact: true }).click()
      const meetingScheduleDialog = page.getByRole('dialog', { name: 'Schedule meeting' })
      await expectUsableGeometry(meetingScheduleDialog, 'Meeting scheduling dialog', 160, 280)
      const sendFromCalendar = meetingScheduleDialog.getByRole('combobox', { name: 'Send from calendar' })
      await expect(sendFromCalendar).toContainText('Personal calendar')
      await expect(meetingScheduleDialog.getByText(/Invitation organizer: operator@example\.test/)).toBeVisible()
      await sendFromCalendar.click()
      await page.getByRole('option', { name: /calendar@example.test.*Organization default/ }).click()
      await expect(sendFromCalendar).toContainText('Organization default')
      await expect(meetingScheduleDialog.getByText(/Invitation organizer: calendar@example\.test/)).toBeVisible()
      await sendFromCalendar.click()
      await page.getByRole('option', { name: /Personal calendar.*operator@example.test/ }).click()
      await expect(sendFromCalendar).toContainText('Personal calendar')
      await expect(meetingScheduleDialog.getByText(/Invitation organizer: operator@example\.test/)).toBeVisible()
      await expect(meetingScheduleDialog.getByRole('textbox', { name: 'Meeting', exact: true }))
        .toHaveValue('Acceptance Meeting')
      await expect(meetingScheduleDialog.getByRole('combobox', { name: 'Meeting type' })).toContainText('Google Meet')
      await expect(meetingScheduleDialog.getByLabel('Start')).toHaveValue('2026-07-15T09:00')
      await expect(meetingScheduleDialog.getByRole('combobox', { name: 'Duration' })).toContainText('30 minutes')
      await expect(meetingScheduleDialog.getByLabel('Ends')).toHaveValue('2026-07-15T09:30')
      await expect(meetingScheduleDialog.getByLabel('Timezone')).toHaveValue('America/New_York')
      await expect(meetingScheduleDialog.getByLabel('Attendee emails')).toHaveValue('contact@example.test')

      await meetingScheduleDialog.getByRole('combobox', { name: 'Meeting type' }).click()
      await page.getByRole('option', { name: 'In person' }).click()
      await expect(meetingScheduleDialog.getByLabel('Physical address')).toHaveValue('Mobile Room')

      await meetingScheduleDialog.getByRole('combobox', { name: 'Meeting type' }).click()
      await page.getByRole('option', { name: 'Custom link' }).click()
      await meetingScheduleDialog.getByLabel('Meeting link').fill('https://meet.example.test/acceptance')
      await meetingScheduleDialog.getByRole('combobox', { name: 'Duration' }).click()
      await page.getByRole('option', { name: '45 minutes' }).click()
      await expect(meetingScheduleDialog.getByLabel('Ends')).toHaveValue('2026-07-15T09:45')
      await meetingScheduleDialog.getByRole('button', { name: 'Send' }).click()
      await expect(meetingScheduleDialog).toBeHidden()
      const explicitCalendarRequest = crmWriteRequests.filter(
        (request) => request.body.actionType === 'create_calendar_event',
      ).at(-1)
      expect(explicitCalendarRequest?.body).toMatchObject({
        actionType: 'create_calendar_event',
        calendarConnectionId: 'calendar-personal-connection',
        calendarId: 'operator@example.test',
        payload: {
          startsAt: '2026-07-15T09:00',
          endsAt: '2026-07-15T09:45',
          timezone: 'America/New_York',
          meetingMode: 'custom_link',
          customJoinUrl: 'https://meet.example.test/acceptance',
        },
      })
      expect(explicitCalendarRequest?.idempotencyHeader).toBe(
        explicitCalendarRequest?.body.idempotencyKey,
      )
      expect(explicitCalendarRequest?.body.payload).not.toMatchObject({
        calendarConnectionId: expect.anything(),
        calendarId: expect.anything(),
      })
      await closeEditor.click()

      await page.getByRole('tab', { name: 'Interactions' }).click()
      await page.getByRole('cell', { name: 'Acceptance Interaction', exact: true }).dispatchEvent('click')
      closeEditor = page.getByRole('button', { name: 'Close editor' })
      drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Interaction editor drawer', 160, 280)
      await expect(drawer.getByRole('button', { name: 'Archive interaction' })).toBeVisible()

      await drawer.getByRole('combobox', { name: 'Contact' }).click()
      await expect(page.getByRole('option', { name: 'Acceptance Contact' })).toBeVisible()
      await expect(page.getByRole('option', { name: 'Other Contact' })).toHaveCount(0)
      await page.keyboard.press('Escape')

      await drawer.getByRole('combobox', { name: 'Pipeline opportunity' }).click()
      await expect(page.getByRole('option', {
        name: 'Acceptance Product - Acceptance Organization · Qualified Lead · go7654321',
      })).toBeVisible()
      await expect(page.getByRole('option', {
        name: 'Other Product - Other Organization · Proposal · go9753102',
      })).toHaveCount(0)
      await page.keyboard.press('Escape')
      await closeEditor.click()
      await expectNoDocumentOverflow(page)
    })

    test('CRM email sender requires an explicit choice when the configured Gmail account is unavailable', async ({ page }) => {
      await mockOrganizationCommunications(page, {
        includeConfiguredGmailConnection: false,
        includeOrganizationConnection: false,
      })
      await mockCrmRecords(page, { googleMailSource: 'user-default' })
      await gotoApp(page, '/#crm')

      await page.getByRole('cell', { name: 'Acceptance Organization', exact: true }).click()
      const drawer = page.getByRole('button', { name: 'Close editor' })
        .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await drawer.getByRole('button', { name: 'Email', exact: true }).click()
      const emailDialog = page.getByRole('dialog', { name: 'Send email' })
      const emailSender = emailDialog.getByRole('combobox', { name: 'Send from' })

      await expect(emailSender).toHaveText('')
      await expect(emailDialog.getByRole('button', { name: 'Send' })).toBeDisabled()
      await emailSender.click()
      await page.getByRole('option', { name: /stewards@eigenracing\.com.*jarrettcrosby@gmail\.com/ }).click()
      await emailDialog.getByLabel('Message').fill('Explicit sender selection test')
      await expect(emailDialog.getByRole('button', { name: 'Send' })).toBeEnabled()
      await expectNoDocumentOverflow(page)
    })

    test('New meeting retries reuse one request identity', async ({ page }) => {
      await mockOrganizationCommunications(page, { includeOrganizationConnection: false })
      const { crmWriteRequests } = await mockCrmRecords(page, { failFirstMeetingCreate: true })
      await gotoApp(page, '/#crm')

      await page.getByRole('tab', { name: 'Meetings' }).click()
      await activeSection(page).getByRole('button', { name: 'Add', exact: true }).click()
      const closeEditor = page.getByRole('button', { name: 'Close editor' })
      const drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'New meeting editor drawer', 160, 280)
      await drawer.getByRole('textbox', { name: 'Meeting', exact: true }).fill('Retry-safe meeting')
      await expect(drawer.getByRole('combobox', { name: 'Send from calendar' })).toContainText('Organization default')
      await drawer.getByLabel('Start').fill('2026-07-17T10:00')
      await expect(drawer.getByLabel('Ends')).toHaveValue('2026-07-17T10:30')

      const save = drawer.getByRole('button', { name: 'Save' })
      await save.click()
      await expect(drawer).toBeVisible()
      await expect(save).toBeEnabled()
      await save.click()
      await expect(drawer).toBeHidden()

      const meetingCreateRequests = crmWriteRequests.filter(
        (request) => request.body.entity === 'meetings' && !request.body.id,
      )
      expect(meetingCreateRequests).toHaveLength(2)
      expect(meetingCreateRequests[0].body.idempotencyKey).toMatch(/^crm-ui:meeting:create:/)
      expect(meetingCreateRequests[1].body.idempotencyKey)
        .toBe(meetingCreateRequests[0].body.idempotencyKey)
      expect(meetingCreateRequests[0].idempotencyHeader)
        .toBe(meetingCreateRequests[0].body.idempotencyKey)
      expect(meetingCreateRequests[1].idempotencyHeader)
        .toBe(meetingCreateRequests[0].idempotencyHeader)
      expect(meetingCreateRequests[0].body).not.toHaveProperty('calendarConnectionId')
      expect(meetingCreateRequests[0].body).not.toHaveProperty('calendarId')
      expect(meetingCreateRequests[0].body.fields).not.toMatchObject({
        calendarConnectionId: expect.anything(),
        calendarId: expect.anything(),
      })
      await expectNoDocumentOverflow(page)
    })

    test('Existing custom meeting keeps its calendar and request identity across retry', async ({ page }) => {
      await mockOrganizationCommunications(page, { includeOrganizationConnection: false })
      const { crmWriteRequests } = await mockCrmRecords(page, { failFirstMeetingUpdate: true })
      await gotoApp(page, '/#crm')

      await page.getByRole('tab', { name: 'Meetings' }).click()
      await page.getByRole('cell', { name: 'Existing Custom Meeting', exact: true }).click()
      const closeEditor = page.getByRole('button', { name: 'Close editor' })
      const drawer = closeEditor.locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(drawer, 'Existing meeting editor drawer', 160, 280)
      await expect(drawer.getByRole('combobox', { name: 'Send from calendar' })).toContainText('Personal calendar')
      await expect(drawer.getByRole('combobox', { name: 'Meeting type' })).toContainText('Custom link')
      await expect(drawer.getByLabel('Meeting link')).toHaveValue('https://meet.example.test/existing-custom')
      await expect(drawer.getByRole('combobox', { name: 'Duration' })).toContainText('45 minutes')
      await expect(drawer.getByLabel('Ends')).toHaveValue('2026-07-18T11:45')

      const save = drawer.getByRole('button', { name: 'Save' })
      await expect(save).toBeEnabled()
      await save.click()
      await expect(drawer).toBeVisible()
      await expect(save).toBeEnabled()
      await save.click()
      await expect(drawer).toBeHidden()

      const meetingUpdateRequests = crmWriteRequests.filter(
        (request) => request.body.entity === 'meetings'
          && request.body.id === '00000000-0000-4000-8000-000000000303',
      )
      expect(meetingUpdateRequests).toHaveLength(2)
      expect(meetingUpdateRequests[0].body.idempotencyKey).toMatch(/^crm-ui:meeting:update:/)
      expect(meetingUpdateRequests[1].body.idempotencyKey)
        .toBe(meetingUpdateRequests[0].body.idempotencyKey)
      expect(meetingUpdateRequests[0].idempotencyHeader)
        .toBe(meetingUpdateRequests[0].body.idempotencyKey)
      expect(meetingUpdateRequests[1].idempotencyHeader)
        .toBe(meetingUpdateRequests[0].idempotencyHeader)
      expect(meetingUpdateRequests[0].body.fields).toMatchObject({
        calendarConnectionId: 'calendar-personal-connection',
        calendarId: 'operator@example.test',
        meetingMode: 'custom_link',
        customJoinUrl: 'https://meet.example.test/existing-custom',
        location: '',
        startsAt: '2026-07-18T11:00',
        endsAt: '2026-07-18T11:45',
        externalEventId: 'existing-custom-event',
      })
      await expectNoDocumentOverflow(page)
    })

    test('Meeting calendar chooser lists each linked calendar once', async ({ page }) => {
      await mockOrganizationCommunications(page)
      await mockCrmRecords(page)
      await gotoApp(page, '/#crm')

      await page.getByRole('cell', { name: 'Acceptance Organization', exact: true }).click()
      const drawer = page.getByRole('button', { name: 'Close editor' })
        .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await drawer.getByRole('button', { name: 'Schedule', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Schedule meeting' })
      const sendFromCalendar = dialog.getByRole('combobox', { name: 'Send from calendar' })
      await expect(sendFromCalendar).toContainText('Organization calendar')
      await expect(sendFromCalendar).not.toContainText('Organization default')
      await sendFromCalendar.click()
      const options = page.getByRole('listbox').getByRole('option')
      await expect(options).toHaveCount(2)
      await expect(page.getByRole('option', { name: /Personal calendar.*operator@example\.test/ })).toHaveCount(1)
      await expect(page.getByRole('option', { name: /Organization calendar.*calendar@example\.test/ })).toHaveCount(1)
      await page.keyboard.press('Escape')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expectNoDocumentOverflow(page)
    })

    test('Agents task selector and work controls remain reachable', async ({ page }) => {
      await gotoApp(page, '/#agents')
      await expect(activeSection(page).getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()

      const taskSelector = activeSection(page).getByRole('combobox').first()
      await taskSelector.scrollIntoViewIfNeeded()
      await expectUsableGeometry(taskSelector, 'Agent task selector', 38, 220)

      await expect(page.getByRole('button', { name: 'Work mode' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Discuss mode' })).toBeVisible()

      const composer = page.getByPlaceholder(/Give .* a concrete work instruction|Assign a task to start a thread/)
      await composer.scrollIntoViewIfNeeded()
      const composerControl = composer.locator('xpath=ancestor::*[contains(@class,"MuiInputBase-root")][1]')
      await expectUsableGeometry(composerControl, 'Agent chat composer', 38, 220)
      await expect(page.getByRole('button', { name: 'Queue agent work' })).toBeVisible()

      await page.getByRole('button', { name: 'Discuss mode' }).click()
      const discussionComposer = page.getByPlaceholder(/Discuss this task with|Assign a task to start a thread/)
      await expect(discussionComposer).toBeVisible()
      const discussionButton = page.getByRole('button', { name: 'Send discussion message' })
      await expect(discussionButton).toBeVisible()
      if (await page.getByPlaceholder(/Discuss this task with/).count()) {
        await expect(discussionButton).toBeDisabled()
        await discussionComposer.fill('Acceptance discussion')
        await expect(discussionButton).toBeEnabled()
      } else {
        await expect(discussionComposer).toBeDisabled()
        await expect(discussionButton).toBeDisabled()
      }
      await expectNoDocumentOverflow(page)
    })

    test('Settings tabs and activity drawer remain contained', async ({ page }) => {
      await page.route((url) => url.pathname === '/api/activity', async (route) => {
        await route.fulfill({
          json: {
            ok: true,
            events: [],
            nextCursor: null,
            scope: 'self',
            capabilities: { canViewOrganization: false, canViewGlobal: false, defaultScope: 'self' },
          },
        })
      })
      await page.route((url) => url.pathname === '/api/auth/sessions', async (route) => {
        await route.fulfill({
          json: {
            ok: true,
            currentSessionId: '11111111-1111-4111-8111-111111111111',
            sessions: [{
              id: '11111111-1111-4111-8111-111111111111',
              authenticatedUser: 'security@example.com',
              effectiveUser: 'security@example.com',
              deviceLabel: 'Safari on iPhone',
              initialIpAddress: '198.51.100.8',
              lastIpAddress: '203.0.113.17',
              createdAt: '2026-07-16T12:00:00.000Z',
              lastSeenAt: '2026-07-16T13:00:00.000Z',
              idleExpiresAt: '2026-07-16T14:00:00.000Z',
              absoluteExpiresAt: '2026-07-17T12:00:00.000Z',
              current: true,
              impersonating: false,
            }],
          },
        })
      })
      await page.route((url) => url.pathname === '/api/auth/impersonation', async (route) => {
        await route.fulfill({
          json: {
            isRootAdmin: false,
            impersonation: { active: false },
            targets: [],
          },
        })
      })
      await gotoApp(page, '/#dashboard')
      await openWorkspaceSettings(page)

      const settings = page.getByRole('dialog', { name: 'Settings' })
      await expectUsableGeometry(settings, 'Settings dialog', 160, 280)
      for (const tabName of ['Profile', 'People', 'Sharing', 'Integrations', 'Security']) {
        const tab = settings.getByRole('tab', { name: tabName })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
      }
      await expect(settings.getByText('Signed in as security@example.com')).toBeVisible()
      await expect(settings.getByText('Last observed IP 203.0.113.17')).toBeVisible()
      await expect(settings.getByText('Sign-in IP 198.51.100.8')).toBeVisible()
      await expectNoDocumentOverflow(page)
      await settings.getByRole('button', { name: 'Close settings' }).click()

      await page.getByRole('button', { name: 'Activity log' }).click()
      const activityDrawer = page.getByRole('heading', { name: 'Activity', exact: true })
        .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
      await expectUsableGeometry(activityDrawer, 'Activity drawer', 160, 280)
      await page.keyboard.press('Escape')
      await expect(activityDrawer).toBeHidden()
      await expectNoDocumentOverflow(page)
    })

    test('Organization Gmail sender and organizer calendar remain independently selectable', async ({ page }) => {
      await mockOrganizationCommunications(page)
      await gotoApp(page, '/#dashboard')
      await openWorkspaceSettings(page)

      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('tab', { name: 'Integrations' }).click()
      const matonTab = settings.getByRole('tab', { name: 'Maton', exact: true })
      if (await matonTab.count()) await matonTab.click()
      await expect(settings.getByText('Organization communication identities')).toBeVisible()
      await expect(settings.getByText('Personal Maton connections')).toBeVisible()

      await expect(settings.getByRole('combobox', { name: 'Gmail connection' }))
        .toContainText('Personal Gmail')
      await expect(settings.getByRole('combobox', { name: 'Gmail send-as address' }))
        .toContainText('sender@example.test')
      await expect(settings.getByRole('combobox', { name: 'Google Calendar connection' }))
        .toContainText('Suburbia Google Calendar')
      await expect(settings.getByRole('combobox', { name: 'Organizer calendar' }))
        .toContainText('Organization calendar')
      await expect(settings.getByLabel('Calendar organizer')).toHaveValue('calendar@example.test')
      await expectNoDocumentOverflow(page)
      await settings.getByRole('button', { name: 'Close settings' }).click()
    })

    test('Organization communication defaults are read-only for nonmanagers', async ({ page }) => {
      await mockOrganizationCommunications(page, { canManage: false })
      await gotoApp(page, '/#dashboard')
      await openWorkspaceSettings(page)

      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('tab', { name: 'Integrations' }).click()
      const matonTab = settings.getByRole('tab', { name: 'Maton', exact: true })
      if (await matonTab.count()) await matonTab.click()
      await expect(settings.getByText('Organization communication identities')).toBeVisible()
      await expect(settings.getByText(
        'Organization defaults can only be changed by an organization owner or access administrator.',
      )).toBeVisible()
      await expect(settings.getByRole('combobox', { name: 'Gmail connection' })).toHaveCount(0)
      await expect(settings.getByRole('combobox', { name: 'Google Calendar connection' })).toHaveCount(0)
      await expect(settings.getByText('Personal Maton connections')).toBeVisible()
      await expectNoDocumentOverflow(page)
      await settings.getByRole('button', { name: 'Close settings' }).click()
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

test.describe('agent discussion regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('one user action sends once and keeps the latest response in view', async ({ page }) => {
    const taskId = 'agent-discussion-regression-task'
    const agentId = 'projects'
    const historicalMessages = Array.from({ length: 14 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 === 0 ? 'user' : 'agent',
      text: `Historical message ${index + 1}`,
      createdAt: `2026-07-17T12:${String(index).padStart(2, '0')}:00.000Z`,
      taskId,
    }))
    let discussionPosts = 0

    await page.route((url) => url.pathname === '/api/agents', async (route) => {
      await route.fulfill({
        json: {
          agents: [{
            id: agentId,
            name: 'Projects',
            owner: 'Execution',
            status: 'ready',
            summary: 'Plans and sequences assigned project work.',
            kind: 'product',
          }],
          runtime: { provider: 'openai-codex', ready: true, status: 'ready', label: 'ChatGPT connected' },
        },
      })
    })
    await page.route((url) => url.pathname === '/api/tasks', async (route) => {
      await route.fulfill({
        json: [{
          id: taskId,
          title: 'Agent discussion regression',
          desc: 'Verify one discussion request produces one visible response.',
          status: 'backlog',
          priority: 'medium',
          category: 'projects',
          assignedAgent: agentId,
          checklist: [],
          comments: [],
          activity: [],
          createdAt: '2026-07-17T12:00:00.000Z',
          updatedAt: '2026-07-17T12:00:00.000Z',
        }],
      })
    })
    await page.route((url) => url.pathname === '/api/agents/repository-runs', async (route) => {
      await route.fulfill({
        json: {
          runner: { enabled: false, ready: false, reason: 'Acceptance fixture', repository: '', baseBranch: 'dev', patchOnly: true },
          run: null,
        },
      })
    })
    await page.route((url) => url.pathname === '/api/agents/threads', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { messages: historicalMessages } })
        return
      }
      discussionPosts += 1
      const request = route.request().postDataJSON() as Record<string, unknown>
      expect(request.mode).toBe('discuss')
      expect(String(request.clientMessageId || '')).toMatch(/^[0-9a-f-]{36}$/i)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await route.fulfill({
        json: {
          runtime: { provider: 'openai-codex', ready: true, status: 'ready', label: 'ChatGPT connected' },
          thread: {
            messages: [
              ...historicalMessages,
              {
                id: `agent-discuss-${request.clientMessageId}-request`,
                role: 'user',
                text: String(request.text || ''),
                createdAt: '2026-07-17T13:00:00.000Z',
                taskId,
              },
              {
                id: `agent-discuss-${request.clientMessageId}-result`,
                role: 'agent',
                text: 'Latest agent response',
                createdAt: '2026-07-17T13:00:01.000Z',
                taskId,
              },
            ],
          },
        },
      })
    })

    await gotoApp(page, '/#agents')
    await page.getByRole('button', { name: 'Discuss mode' }).click()
    const composer = page.getByPlaceholder('Discuss this task with Projects')
    await composer.fill('Review the integration decision.')

    await page.evaluate(() => {
      const input = document.querySelector('textarea[placeholder="Discuss this task with Projects"]')
      const button = document.querySelector('button[aria-label="Send discussion message"]') as HTMLButtonElement | null
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      button?.click()
    })

    await expect(page.getByText('Latest agent response')).toBeVisible()
    await expect.poll(() => discussionPosts).toBe(1)
    const messageList = page.getByTestId('agent-thread-messages')
    await expect.poll(() => messageList.evaluate((node) => (
      node.scrollHeight <= node.clientHeight + 1 || node.scrollTop > 0
    ))).toBeTruthy()
    await expect.poll(() => messageList.evaluate((node) => {
      const last = node.lastElementChild as HTMLElement | null
      if (!last) return false
      const container = node.getBoundingClientRect()
      const item = last.getBoundingClientRect()
      return item.bottom <= container.bottom + 1 && item.top >= container.top - 1
    })).toBeTruthy()
  })
})
