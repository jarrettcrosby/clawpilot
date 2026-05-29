import type { Task } from '@/lib/types'
import { getAutoPickupEligibility } from '@/lib/taskState'
import { normalizeProductAgentId, resolveExecutionAgentForCategory, resolveExecutionAgentForControlAgent } from '@/lib/agents/routing'

export type AutoPickupDispatch = {
  taskId: string
  agentId: string
  reason: string
}

export type AutoPickupPlan = {
  eligible: Task[]
  dispatches: AutoPickupDispatch[]
  skipped: { taskId: string; reasons: string[] }[]
  queues: Record<string, { taskId: string; reason: string }[]>
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }
const STATUS_ORDER: Record<string, number> = { 'in-progress': 0, review: 1, todo: 2, backlog: 3 }

export function resolveAgentForTask(task: Task): string | null {
  const assignedProduct = normalizeProductAgentId(task.assignedAgent, { category: task.category, tags: task.tags })
  if (assignedProduct) return resolveExecutionAgentForControlAgent(assignedProduct)
  const routed = resolveExecutionAgentForCategory(task.category)
  if (routed) return routed
  const tagAgent = (task.tags || [])
    .map((tag) => normalizeProductAgentId(tag, { category: task.category, tags: task.tags }))
    .find(Boolean)
  return tagAgent ? resolveExecutionAgentForControlAgent(tagAgent) : null
}

function taskAgeMs(task: Task): number {
  const stamp = task.updatedAt || task.createdAt
  const t = stamp ? new Date(stamp).getTime() : 0
  return Date.now() - t
}

function fitScore(task: Task, agentId: string): number {
  const routed = resolveExecutionAgentForCategory(task.category)
  if (routed && routed === agentId) return 0
  if (resolveAgentForTask(task) === agentId) return 1
  return 2
}

function sortQueue(tasks: Task[], agentId: string): Task[] {
  return [...tasks].sort((a, b) => {
    const fr = fitScore(a, agentId) - fitScore(b, agentId)
    if (fr !== 0) return fr
    const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
    if (pr !== 0) return pr
    const aDue = a.dueDate ? new Date(a.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER
    const bDue = b.dueDate ? new Date(b.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER
    if (aDue !== bDue) return aDue - bDue
    const sr = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    if (sr !== 0) return sr
    const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return aCreated - bCreated
  })
}

export function reconcileAssignments(tasks: Task[]): { tasks: Task[]; changed: boolean } {
  let changed = false
  const now = new Date().toISOString()

  const updated = tasks.map(task => {
    if (task.archived || task.status === 'done') return task

    const agentId = resolveAgentForTask(task)
    let next = task

    if (!task.assignedAgent && agentId) {
      const productAgentId = normalizeProductAgentId(agentId, { category: task.category, tags: task.tags }) || 'clawpilot'
      const activity = [...(task.activity || []), {
        type: 'updated' as const,
        message: `Assigned to ${productAgentId} (auto)`,
        timestamp: now,
        actor: 'ClawPilot',
        taskId: task.id,
        taskTitle: task.title,
      }]
      next = { ...task, assignedAgent: productAgentId, activity, updatedAt: now }
      changed = true
    }

    const eligibility = getAutoPickupEligibility(next)
    if (eligibility.eligible) {
      const executionStatus = next.execution?.executionStatus
      if (!executionStatus || executionStatus === 'queued') {
        const execution = { ...(next.execution || {}), executionStatus: 'queued' }
        if (executionStatus !== 'queued') {
          changed = true
          next = { ...next, execution, updatedAt: now }
        }
      }
    }

    return next
  })

  return { tasks: updated, changed }
}

export function buildAutoPickupPlan(tasks: Task[]): AutoPickupPlan {
  const eligible: Task[] = []
  const dispatches: AutoPickupDispatch[] = []
  const skipped: { taskId: string; reasons: string[] }[] = []
  const queues: Record<string, { taskId: string; reason: string }[]> = {}

  const byAgent: Record<string, Task[]> = {}

  tasks.forEach(task => {
    const eligibility = getAutoPickupEligibility(task)
    if (!eligibility.eligible) {
      skipped.push({ taskId: task.id, reasons: eligibility.reasons })
      return
    }
    eligible.push(task)
    const agentId = task.execution?.assignedAgent || resolveAgentForTask(task) || 'unassigned'
    if (!byAgent[agentId]) byAgent[agentId] = []
    byAgent[agentId].push(task)
  })

  Object.entries(byAgent).forEach(([agentId, tasksForAgent]) => {
    const sorted = sortQueue(tasksForAgent, agentId)
    queues[agentId] = sorted.map(t => ({ taskId: t.id, reason: 'eligible' }))
    const next = sorted[0]
    if (next && agentId !== 'unassigned') {
      dispatches.push({ taskId: next.id, agentId, reason: 'priority-eligible' })
    }
  })

  return { eligible, dispatches, skipped, queues }
}

export const AUTO_PICKUP_SERVICE_FOUNDATION = {
  mode: 'background',
  description: 'Foundation only. No scheduling or execution wired here.',
  sessionOnly: 'Current UI timer remains session-based only.',
  responsibilities: [
    'Read eligible tasks',
    'Dispatch only canonically eligible tasks',
    'Record execution evidence via existing task updates',
  ],
}
