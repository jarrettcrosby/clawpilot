import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

type TestTask = {
  id: string | number
  title: string
}

async function getTask(request: APIRequestContext, id: string): Promise<TestTask> {
  const res = await request.get('/api/tasks?includeArchived=true&includeQuarantined=true')
  expect(res.ok()).toBeTruthy()
  const tasks = await res.json() as TestTask[]
  const task = tasks.find(candidate => String(candidate.id) === String(id))
  expect(task).toBeTruthy()
  return task as TestTask
}

async function removeTestTask(request: APIRequestContext, id: string) {
  const archiveRes = await request.patch('/api/tasks', {
    data: { id, _archive: true, _actor: 'UITest' },
  })
  expect(archiveRes.status()).toBe(200)
  const deleteRes = await request.patch('/api/tasks', {
    data: { id, _deletePermanent: true, _deleteReason: 'UI acceptance cleanup', _actor: 'UITest' },
  })
  expect(deleteRes.status()).toBe(200)
}

test('ui acceptance: projects core card and drawer workflow', async ({ page, request }) => {
  const initialTitle = `UI Acceptance Project ${Date.now()}`
  const nextAction = 'Confirm the simplified Projects workflow'
  let task: TestTask | null = null

  try {
    await page.route((url) => url.pathname === '/api/workspaces', (route) => route.fulfill({
      json: {
        ok: true,
        boards: [{
          id: 'ui-acceptance-board',
          name: 'ClawPilot board',
          ownerEmail: 'test@example.com',
          accessRole: 'owner',
        }],
        pipelines: [],
        selectedBoardId: 'ui-acceptance-board',
        selectedPipelineId: null,
      },
    }))
    await page.goto('/#projects')
    await expect(page.getByPlaceholder('Search cards...')).toBeVisible()
    await page.getByRole('button', { name: 'New task' }).click()
    await page.getByLabel('Title').fill(initialTitle)
    await page.getByLabel('Description').fill('Validate the compact Projects card and canonical drawer controls.')
    await page.getByLabel('Priority').click()
    await page.getByRole('option', { name: 'High' }).click()
    await page.getByLabel('Assigned agent').click()
    await page.getByRole('option', { name: 'Projects' }).click()
    await page.getByLabel('Due date').fill('2026-12-31')
    await page.getByLabel('Next action').fill(nextAction)
    await page.getByLabel('Checklist').fill('Core card and drawer remain usable')

    const createResponse = page.waitForResponse(response => (
      response.url().includes('/api/tasks')
      && response.request().method() === 'POST'
    ))
    await page.getByRole('button', { name: 'Create task' }).click()
    const createdResponse = await createResponse
    expect(createdResponse.status()).toBe(201)
    task = await createdResponse.json() as TestTask

    const drawer = page.locator('.MuiDrawer-paper')
    await expect(drawer.getByText('DETAILS', { exact: true })).toBeVisible()
    await expect(drawer.getByText('DESCRIPTION', { exact: true })).toBeVisible()
    await expect(drawer.getByText('CHECKLIST', { exact: true })).toBeVisible()
    await expect(drawer.getByText('Next action', { exact: true }).last()).toBeVisible()
    await expect(page.getByText('Governance flag: needs-quality')).toHaveCount(0)
    await expect(page.getByText('ROUTING', { exact: true })).toHaveCount(0)

    const updatedTitle = `${initialTitle} Updated`
    await drawer.getByText(initialTitle, { exact: true }).click()
    const titleInput = drawer.locator('textarea').first()
    await titleInput.fill(updatedTitle)
    const updateResponse = page.waitForResponse(response => (
      response.url().includes('/api/tasks')
      && response.request().method() === 'PATCH'
      && response.status() === 200
    ))
    await titleInput.press('Enter')
    await updateResponse

    const updated = await getTask(request, String(task.id))
    expect(updated.title).toBe(updatedTitle)
    await expect(page.getByText(updatedTitle, { exact: true }).last()).toBeVisible()

    await drawer.getByRole('button', { name: 'Close drawer' }).click()
    await page.getByPlaceholder('Search cards...').fill(updatedTitle)
    const card = page.locator(`#kanban-card-${task.id}`)
    await expect(card).toBeVisible()
    await expect(card.getByText('High', { exact: true })).toBeVisible()
    await expect(card.getByText(nextAction, { exact: false })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Open chat' })).toBeVisible()

    await expect(page.getByText('Governance Issues', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Propose Consolidation', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Show legends', { exact: true })).toHaveCount(0)
    await expect(page.getByText('NOW WORKING', { exact: true })).toHaveCount(0)
    await expect(page.getByText('AGENT-READY', { exact: true })).toHaveCount(0)
  } finally {
    if (task) await removeTestTask(request, String(task.id))
  }
})
