import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

test.use({ hasTouch: true })

const authPassword = process.env.UI_AUTH_PASSWORD
const operatorSecret = process.env.UI_OPERATOR_SECRET

async function gotoApp(page: Page, path: string) {
  if (authPassword && operatorSecret) {
    const response = await page.request.post('/api/auth/login', {
      data: { password: authPassword },
      headers: { 'x-clawpilot-operator-secret': operatorSecret },
      failOnStatusCode: false,
    })
    expect(response.ok(), `UI authentication failed with HTTP ${response.status()}`).toBeTruthy()
  }

  await page.goto(path)
  if (new URL(page.url()).pathname === '/login') {
    throw new Error('Target requires authentication; set UI_AUTH_PASSWORD and UI_OPERATOR_SECRET together')
  }
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

async function expectWidth(locator: Locator, width: number) {
  await expect.poll(async () => Math.round((await locator.boundingBox())?.width ?? 0)).toBe(width)
}

async function expectContentBesideNavigation(page: Page, navigationWidth: number) {
  const navigation = page.getByTestId('desktop-navigation')
  const content = page.getByTestId('app-content')

  await expect.poll(async () => {
    const navigationBox = await navigation.boundingBox()
    const contentBox = await content.boundingBox()
    if (!navigationBox || !contentBox) return false
    return Math.round(contentBox.x) === Math.round(navigationBox.x + navigationWidth)
  }).toBe(true)
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    document.documentElement.scrollWidth - window.innerWidth
  ))).toBeLessThanOrEqual(1)
}

async function expectVisibleAboveBottomNavigation(page: Page, locator: Locator, minimumHeight: number) {
  await expect(locator).toBeVisible()
  await expect.poll(async () => {
    const [box, navigationBox] = await Promise.all([
      locator.boundingBox(),
      page.getByTestId('mobile-bottom-navigation').boundingBox(),
    ])
    if (!box) return 0
    const viewportHeight = page.viewportSize()?.height ?? 0
    const visibleBottom = Math.min(box.y + box.height, navigationBox?.y ?? viewportHeight, viewportHeight)
    return Math.max(0, visibleBottom - Math.max(0, box.y))
  }).toBeGreaterThanOrEqual(minimumHeight)
}

test('responsive shell: 1366x768 touch input keeps a real desktop drawer sibling', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await gotoApp(page, '/#dashboard')

  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)

  const desktopNavigation = page.getByTestId('desktop-navigation')
  const desktopPaper = page.getByTestId('desktop-navigation-paper')
  const desktopToggle = page.getByTestId('desktop-navigation-toggle')

  await expect(desktopNavigation).toBeVisible()
  await expect(page.getByTestId('mobile-navigation-toggle')).toBeHidden()
  await expect(page.getByTestId('mobile-bottom-navigation')).toBeHidden()
  await expectWidth(desktopNavigation, 220)
  await expectContentBesideNavigation(page, 220)
  expect(await desktopPaper.evaluate((element) => getComputedStyle(element).position)).toBe('relative')
  await expect(desktopToggle).toHaveAttribute('aria-expanded', 'true')

  await desktopToggle.click()

  await expectWidth(desktopNavigation, 76)
  await expectContentBesideNavigation(page, 76)
  await expect(desktopToggle).toHaveAttribute('aria-label', 'Expand sidebar')
  await expect(desktopNavigation.getByRole('button', { name: /sidebar/i })).toHaveCount(0)

  await page.reload()

  await expectWidth(desktopNavigation, 76)
  await expectContentBesideNavigation(page, 76)
  await expectNoHorizontalOverflow(page)
})

test('responsive shell: 900x599 is desktop regardless of height or touch input', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 599 })
  await gotoApp(page, '/#dashboard')

  const desktopNavigation = page.getByTestId('desktop-navigation')

  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
  await expect(desktopNavigation).toBeVisible()
  await expectWidth(desktopNavigation, 220)
  await expectContentBesideNavigation(page, 220)
  await expect(page.getByTestId('desktop-navigation-toggle')).toBeVisible()
  await expect(page.getByTestId('mobile-navigation-toggle')).toBeHidden()
  await expect(page.getByTestId('mobile-bottom-navigation')).toBeHidden()
  await expectNoHorizontalOverflow(page)
})

test('dashboard links open their target section and selected document', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({
    json: [{
      id: 'dashboard-task',
      title: 'Dashboard task',
      desc: 'Opened from dashboard navigation acceptance.',
      status: 'todo',
      priority: 'high',
      category: 'clawpilot',
      tags: [],
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
      activity: [{
        type: 'comment',
        message: 'Dashboard activity',
        timestamp: '2026-07-15T12:00:00.000Z',
        actor: 'Test User',
      }],
      comments: [],
      checklist: [],
    }],
  }))
  await page.route('**/api/pipeline/activity', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/activity**', (route) => route.fulfill({
    json: {
      ok: true,
      events: [{
        id: 'dashboard-activity',
        module: 'projects',
        type: 'comment',
        eventType: 'project.task.comment',
        message: 'Dashboard activity',
        timestamp: '2026-07-15T12:00:00.000Z',
        actor: 'test@example.com',
        actorName: 'Test User',
        target: { section: 'projects', id: 'dashboard-task', label: 'Dashboard task' },
        details: {},
      }],
      nextCursor: null,
      scope: 'self',
      capabilities: { canViewOrganization: false, canViewGlobal: false, defaultScope: 'self' },
    },
  }))
  await page.route('**/api/docs**', (route) => route.fulfill({
    json: [{
      id: 'dashboard-document',
      title: 'Dashboard document',
      category: 'Build',
      date: '2026-07-15',
      slug: 'dashboard-document',
      tags: [],
      content: '# Dashboard document\n\nSelected from the dashboard.',
    }],
  }))
  await page.route('**/api/execution-results/summary', (route) => route.fulfill({ json: { count: 0 } }))
  await page.route('**/api/users', (route) => route.fulfill({ json: { currentUser: { displayName: 'Test User' } } }))
  await gotoApp(page, '/#dashboard')

  await page.getByRole('button', { name: 'Open task', exact: true }).click()
  const closeTaskDrawer = page.getByRole('button', { name: 'Close drawer' })
  await expect(closeTaskDrawer).toBeVisible()
  await closeTaskDrawer.click()
  await page.waitForTimeout(250)
  await expect(closeTaskDrawer).toBeHidden()

  await page.evaluate(() => { window.location.hash = 'dashboard' })
  await page.getByRole('button', { name: 'Activity log' }).click()
  const activityDrawer = page.getByRole('heading', { name: 'Activity', exact: true })
    .locator('xpath=ancestor::*[contains(@class,"MuiDrawer-paper")][1]')
  await activityDrawer.getByText('Projects', { exact: true }).click()
  await expect(activityDrawer.getByText('Dashboard activity', { exact: true })).toBeVisible()
  await activityDrawer.getByRole('button', { name: 'Open activity target' }).click()
  await expect(closeTaskDrawer).toBeVisible()
  await closeTaskDrawer.click()
  await page.waitForTimeout(250)
  await expect(closeTaskDrawer).toBeHidden()

  await page.evaluate(() => { window.location.hash = 'dashboard' })
  await page.getByText('Dashboard document', { exact: true }).click()
  await expect(page).toHaveURL(/\?doc=dashboard-document#docs$/)
  await expect(page.getByText('Selected from the dashboard.')).toBeVisible()

  await page.evaluate(() => { window.location.hash = 'dashboard' })
  await expect(page.getByRole('button', { name: 'View board' })).toBeVisible()
  await page.getByRole('button', { name: 'View board' }).click()
  await expect(page).toHaveURL(/#projects$/)
  await expect(page.getByPlaceholder('Search cards...')).toBeVisible()

  await page.evaluate(() => { window.location.hash = 'dashboard' })
  await expect(page.getByRole('button', { name: /Agent attention/ })).toBeVisible()
  await page.getByRole('button', { name: /Agent attention/ }).click()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('heading', { name: 'Agents', exact: true, level: 5 })).toBeVisible()
})

test('agent card comments open the linked task working document', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const documentTitle = 'QuickBooks Integration - Projects Research'
  const documentSlug = 'agent-quickbooks-integration-test-projects'
  await page.route((url) => url.pathname === '/api/workspaces', (route) => route.fulfill({
    json: {
      ok: true,
      boards: [{ id: 'board-1', name: 'ClawPilot board', ownerEmail: 'test@example.com', accessRole: 'owner' }],
      pipelines: [],
      selectedBoardId: 'board-1',
      selectedPipelineId: null,
    },
  }))
  await page.route((url) => url.pathname === '/api/tasks', (route) => route.fulfill({
    json: [{
      id: 'agent-document-task',
      title: 'QuickBooks Integration',
      desc: 'Research the accounting integration.',
      status: 'backlog',
      priority: 'high',
      category: 'clawpilot',
      tags: ['research'],
      assignedAgent: 'projects',
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:05:00.000Z',
      activity: [],
      comments: [{
        id: 'agent-dispatch-test',
        author: 'projects',
        createdAt: '2026-07-16T12:05:00.000Z',
        text: `Agent: projects\nStatus: running\n\nUpdated document: [${documentTitle}](/?doc=${documentSlug}#docs)\nSummary: Defined the accounting system of record.\nRemaining: Design synchronization.\nWaiting on: none`,
      }],
      checklist: [],
    }],
  }))
  await page.route((url) => url.pathname === '/api/docs', (route) => route.fulfill({
    json: [{
      id: 'agent-document',
      title: documentTitle,
      category: 'projects',
      date: '2026-07-16',
      slug: documentSlug,
      tags: ['agent', 'task-linked', 'projects'],
      status: 'active',
      source: 'agent',
      content: '# QuickBooks Integration - Projects Research\n\n## Current status\n\nThe task-linked working document is open.',
    }],
  }))

  await gotoApp(page, '/#projects')
  await page.locator('#kanban-card-agent-document-task').click()
  const documentLink = page.getByRole('link', { name: documentTitle })
  await expect(documentLink).toBeVisible()
  await documentLink.click()

  await expect(page).toHaveURL(new RegExp(`\\?doc=${documentSlug}#docs$`))
  await expect(page.getByText('The task-linked working document is open.')).toBeVisible()
})

test('responsive shell: 390x844 exposes compact navigation and dismissible drawers', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoApp(page, '/#dashboard')

  const desktopNavigation = page.getByTestId('desktop-navigation')
  const mobileToggle = page.getByTestId('mobile-navigation-toggle')
  const mobileDrawer = page.getByTestId('mobile-navigation-drawer')
  const bottomNavigation = page.getByTestId('mobile-bottom-navigation')
  const moreAction = page.getByTestId('nav-bottom-more')

  await expect(desktopNavigation).toBeHidden()
  await expect(page.getByTestId('desktop-navigation-toggle')).toBeHidden()
  await expect(mobileToggle).toBeVisible()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(bottomNavigation).toBeVisible()
  await expect(bottomNavigation.getByRole('button')).toHaveCount(5)
  await expect(page.getByTestId('nav-bottom-dashboard')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-projects')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-pipeline')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-agents')).toBeVisible()
  await expect(page.getByTestId('runtime-chip')).toHaveCount(1)
  await expect(page.getByTestId('runtime-chip')).toBeHidden()

  await moreAction.click()
  await expect(mobileDrawer).toBeVisible()
  await expect(moreAction).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(mobileDrawer).toBeHidden()
  await expect(moreAction).toHaveAttribute('aria-expanded', 'false')

  await mobileToggle.click()
  await expect(mobileDrawer).toBeVisible()
  const backdrop = page.getByTestId('mobile-navigation').locator('.MuiBackdrop-root')
  const backdropBox = await backdrop.boundingBox()
  expect(backdropBox).not.toBeNull()
  await page.mouse.click((backdropBox?.x ?? 0) + (backdropBox?.width ?? 390) - 8, 400)
  await expect(mobileDrawer).toBeHidden()

  await mobileToggle.click()
  await page.getByTestId('nav-mobile-versions').click()
  await expect(page).toHaveURL(/#versions$/)
  await expect(mobileDrawer).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Versions', exact: true, level: 5 })).toBeVisible()

  await mobileToggle.click()
  await page.getByTestId('nav-mobile-docs').click()
  await expect(page).toHaveURL(/#docs$/)
  await expect(mobileDrawer).toBeHidden()

  const appHeader = page.getByTestId('app-header')
  const docsToolbar = page.getByTestId('docs-mobile-toolbar')
  const docsToggle = page.getByTestId('docs-navigation-toggle')
  const headerBox = await appHeader.boundingBox()
  const docsToolbarBox = await docsToolbar.boundingBox()

  await expect(docsToggle).toBeVisible()
  await expect(docsToggle).toHaveAttribute('aria-expanded', 'false')
  expect(await docsToggle.evaluate((element) => getComputedStyle(element).position)).not.toBe('fixed')
  expect(headerBox).not.toBeNull()
  expect(docsToolbarBox).not.toBeNull()
  expect(Math.round(docsToolbarBox?.y ?? 0)).toBeGreaterThanOrEqual(
    Math.round((headerBox?.y ?? 0) + (headerBox?.height ?? 0)),
  )
  await expectNoHorizontalOverflow(page)
})

test('docs generate a user-scoped pipeline snapshot from the mobile toolbar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const generatedDocument = {
    id: 'generated-pipeline-document',
    title: 'Pipeline Brief - Jul 15, 2026, 10:15 PM',
    category: 'pipeline',
    date: '2026-07-15',
    slug: 'pipeline-brief-2026-07-15-test',
    tags: ['pipeline', 'generated-on-demand'],
    status: 'generated',
    source: 'user',
    content: '# Pipeline Brief\n\nGenerated from My pipeline.',
  }
  let documents = [{
    id: 'canonical-pipeline-document',
    title: 'Pipeline Brief',
    category: 'pipeline',
    date: '2026-07-15',
    slug: 'pipeline-brief',
    tags: ['pipeline'],
    status: 'generated',
    source: 'system',
    content: '# Pipeline Brief\n\nCurrent pipeline.',
  }]
  let generatedPayload: Record<string, unknown> | null = null

  await page.route((url) => url.pathname === '/api/docs', (route) => route.fulfill({ json: documents }))
  await page.route((url) => url.pathname === '/api/workspaces', (route) => route.fulfill({
    json: {
      ok: true,
      boards: [{ id: 'board-1', name: 'ClawPilot board' }],
      pipelines: [{ id: 'pipeline-1', name: 'My pipeline' }],
      selectedBoardId: 'board-1',
      selectedPipelineId: 'pipeline-1',
    },
  }))
  await page.route((url) => url.pathname === '/api/docs/generate', async (route) => {
    generatedPayload = route.request().postDataJSON() as Record<string, unknown>
    documents = [generatedDocument, ...documents]
    await route.fulfill({ status: 201, json: { ok: true, document: generatedDocument } })
  })

  await gotoApp(page, '/#docs')
  await page.getByRole('button', { name: 'New document' }).click()
  await expect(page.getByRole('heading', { name: 'New document' })).toBeVisible()
  await page.getByLabel('Document type').click()
  await page.getByRole('option', { name: 'Pipeline report' }).click()
  await expect(page.getByRole('combobox', { name: 'Pipeline' })).toHaveText(/My pipeline/)
  await page.getByRole('button', { name: 'Generate' }).click()

  await expect.poll(() => generatedPayload).toEqual({
    kind: 'pipeline-report',
    boardId: 'board-1',
    pipelineId: 'pipeline-1',
  })
  await expect(page.getByRole('heading', { name: generatedDocument.title })).toBeVisible()
  await expect(page.getByText('Generated from My pipeline.')).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test('projects workspace actions stay fully visible on narrow portrait screens', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({
    json: {
      ok: true,
      boards: [{
        id: 'clawpilot-board',
        name: 'ClawPilot board',
        ownerEmail: 'test@example.com',
        accessRole: 'owner',
      }],
      pipelines: [],
      selectedBoardId: 'clawpilot-board',
      selectedPipelineId: null,
    },
  }))

  for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport)
    await gotoApp(page, '/#projects')
    const workspaceActions = page.getByTestId('projects-workspace-actions')
    const boardLabel = workspaceActions.locator('label', { hasText: 'Board' })
    const newTask = workspaceActions.getByRole('button', { name: 'New task' })
    await expect(boardLabel).toBeVisible()
    await expect(newTask).toBeVisible()
    await expect.poll(async () => workspaceActions.evaluate((element) => (
      element.scrollWidth - element.clientWidth
    ))).toBeLessThanOrEqual(1)
    await expectNoHorizontalOverflow(page)
  }
})

test('responsive shell: 844x390 keeps mobile navigation usable without covering active content', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 })
  await page.route('**/api/workspaces', (route) => route.fulfill({
    json: {
      ok: true,
      boards: [{
        id: 'clawpilot-board',
        name: 'ClawPilot board',
        ownerEmail: 'test@example.com',
        accessRole: 'owner',
      }],
      pipelines: [],
      selectedBoardId: 'clawpilot-board',
      selectedPipelineId: null,
    },
  }))
  await gotoApp(page, '/#dashboard')

  const desktopNavigation = page.getByTestId('desktop-navigation')
  const mobileToggle = page.getByTestId('mobile-navigation-toggle')
  const mobileDrawer = page.getByTestId('mobile-navigation-drawer')
  const bottomNavigation = page.getByTestId('mobile-bottom-navigation')

  await expect(desktopNavigation).toBeHidden()
  await expect(mobileToggle).toBeVisible()
  await expect(bottomNavigation).toBeVisible()
  await expect(bottomNavigation.getByRole('button')).toHaveCount(5)

  const navigationBox = await bottomNavigation.boundingBox()
  expect(navigationBox).not.toBeNull()
  expect(Math.round(navigationBox?.width ?? 0)).toBe(844)
  expect(Math.round((navigationBox?.y ?? 0) + (navigationBox?.height ?? 0))).toBe(390)

  const sectionHost = page.getByTestId('app-header').locator('xpath=following-sibling::*[1]')
  const activeSection = sectionHost.locator(':scope > div').first()
  await expectVisibleAboveBottomNavigation(page, activeSection, 96)

  await page.getByTestId('nav-bottom-more').click()
  await expect(mobileDrawer).toBeVisible()
  await expectWidth(mobileDrawer, Math.round(Math.min(320, 844 * 0.86)))
  await page.getByTestId('mobile-navigation-close').click()
  await expect(mobileDrawer).toBeHidden()

  await page.getByTestId('nav-bottom-projects').click()
  await expect(page).toHaveURL(/#projects$/)
  await expect(page.getByPlaceholder('Search cards...')).toBeVisible()
  const workspaceActions = page.getByTestId('projects-workspace-actions')
  const boardLabel = workspaceActions.locator('label', { hasText: 'Board' })
  await expect(boardLabel).toBeVisible()
  await expect.poll(async () => {
    const [actionsBox, labelBox] = await Promise.all([
      workspaceActions.boundingBox(),
      boardLabel.boundingBox(),
    ])
    if (!actionsBox || !labelBox) return false
    return labelBox.y >= actionsBox.y - 1
  }).toBe(true)
  await expectNoHorizontalOverflow(page)
})
