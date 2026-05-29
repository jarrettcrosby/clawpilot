import { test, expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'

type TestTask = {
  id: string | number
  workstream?: string
  outcomeStatement?: string
  governance?: { healthReasons?: unknown }
  tags?: string[]
}

async function createTask(request: APIRequestContext, payload: Record<string, unknown>): Promise<TestTask> {
  const res = await request.post('/api/tasks', { data: payload })
  expect(res.status()).toBe(201)
  return res.json()
}

async function getTask(request: APIRequestContext, id: string): Promise<TestTask> {
  const res = await request.get('/api/tasks?includeArchived=true&includeQuarantined=true')
  expect(res.ok()).toBeTruthy()
  const arr = await res.json() as TestTask[]
  const task = arr.find((t) => String(t.id) === String(id))
  expect(task).toBeTruthy()
  return task as TestTask
}

test('ui acceptance: improve + dismiss governance flow with visible UI checks', async ({ page, request }) => {
  const actor = 'UITest'
  const task = await createTask(request, {
    title: `UI Acceptance Governance ${Date.now()}`,
    desc: 'Initial description for governance UI flow',
    acceptanceCriteria: ['initial criteria'],
    tags: ['needs-quality', 'governance-flag'],
    _actor: actor,
    _createSource: 'manual-ui',
  })

  await page.goto('/#projects')
  await page.getByPlaceholder('Search cards...').fill(task.title)
  await page.locator(`#kanban-card-${task.id} button`).first().click()

  // Layer 4: visible governance banner
  await expect(page.getByText('Governance flag: needs-quality')).toBeVisible()

  // Improve card action (UI)
  await page.getByRole('button', { name: 'Improve card' }).click()
  await page.getByPlaceholder('Workstream (e.g., product, infra)').fill('platform')
  await page.getByPlaceholder('Outcome statement').fill('UI remediation outcome statement with enough detail')
  await page.getByPlaceholder('Acceptance criteria (one per line)').fill('criteria one\ncriteria two')

  // Layer 1: request success
  const improveReq = page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'PATCH' && r.status() === 200)
  await page.getByRole('button', { name: 'Save' }).last().click()
  await improveReq

  // Layer 2: persistence success
  const improved = await getTask(request, String(task.id))
  expect(improved.workstream).toBe('platform')
  expect(String(improved.outcomeStatement || '')).toContain('UI remediation outcome statement')

  // Layer 3: business/governance rerun occurred
  expect(improved.governance).toBeTruthy()
  expect(Array.isArray(improved.governance?.healthReasons)).toBeTruthy()

  // Dismiss governance flag path
  const dismissReq = page.waitForResponse((r) => r.url().includes('/api/tasks') && r.request().method() === 'PATCH' && r.status() === 200)
  await page.getByRole('button', { name: 'Dismiss flag' }).click()
  await dismissReq

  const dismissed = await getTask(request, String(task.id))
  expect((dismissed.tags || []).includes('needs-quality')).toBeFalsy()

  // Layer 4: visible UI reflects change without manual refresh
  await expect(page.getByText('Governance flag: needs-quality')).toHaveCount(0)

  // Cleanup generated UI acceptance task so board stays promotion-clean
  const archiveRes = await request.patch('/api/tasks', { data: { id: String(task.id), _archive: true, _actor: actor } })
  expect(archiveRes.status()).toBe(200)
})
