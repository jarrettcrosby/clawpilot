import type { Task } from '@/lib/types'
import { ASSIGNABLE_PRODUCT_AGENT_IDS } from '@/lib/types'
import { deriveTaskRealityState } from '@/lib/taskRealityState'

export type NowWorkingState = 'now_working' | 'waiting_on' | 'no_recent_run'

export type NowWorkingSummary = {
  state: NowWorkingState
  label: 'Now working' | 'Waiting on' | 'No recent run'
  taskId: string
  taskTitle: string
  agentId: string
  latestTimestamp: string | null
  latestSource: 'execution' | 'reply' | 'activity' | 'none'
}

const ACTIVE_WINDOW_MS = 90 * 60 * 1000
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function parseTs(value?: string | null): number | null {
  if (!value) return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

function latestAgentReplyTs(task: Task): number | null {
  const agentIds = new Set(['clawpilot', ...ASSIGNABLE_PRODUCT_AGENT_IDS])
  let latest: number | null = null
  for (const c of task.comments || []) {
    if (c.deletedAt) continue
    const author = String(c.author || '').toLowerCase()
    if (!agentIds.has(author)) continue
    const ts = parseTs(c.createdAt || c.timestamp)
    if (ts && (!latest || ts > latest)) latest = ts
  }
  return latest
}

function latestActivityTs(task: Task): number | null {
  let latest: number | null = null
  for (const a of task.activity || []) {
    const ts = parseTs(a.timestamp)
    if (ts && (!latest || ts > latest)) latest = ts
  }
  return latest
}

function latestExecutionTs(task: Task): number | null {
  const lastResultRecordedAt = parseTs(String((task.execution?.lastResult as { recordedAt?: string } | undefined)?.recordedAt || ''))
  return [
    parseTs(task.execution?.lastUpdatedAt),
    parseTs(task.execution?.startedAt),
    lastResultRecordedAt,
  ].filter((v): v is number => typeof v === 'number').sort((a, b) => b - a)[0] || null
}

export function deriveLatestEvidence(task: Task): { ts: number | null; source: NowWorkingSummary['latestSource'] } {
  const executionTs = latestExecutionTs(task)
  const replyTs = latestAgentReplyTs(task)
  const activityTs = latestActivityTs(task)

  const candidates: { ts: number; source: NowWorkingSummary['latestSource'] }[] = []
  if (executionTs) candidates.push({ ts: executionTs, source: 'execution' })
  if (replyTs) candidates.push({ ts: replyTs, source: 'reply' })
  if (activityTs) candidates.push({ ts: activityTs, source: 'activity' })

  if (candidates.length === 0) return { ts: null, source: 'none' }
  candidates.sort((a, b) => b.ts - a.ts)
  return candidates[0]
}

function resolveState(task: Task, nowMs: number, latestTs: number | null): NowWorkingSummary['state'] {
  const executionStatus = String(task.execution?.executionStatus || '').toLowerCase()
  const reality = deriveTaskRealityState(task, nowMs)
  const ageMs = latestTs ? nowMs - latestTs : Number.POSITIVE_INFINITY

  const hasRecentEvidence = ageMs <= RECENT_WINDOW_MS
  const hasActiveEvidence = ageMs <= ACTIVE_WINDOW_MS

  if (hasActiveEvidence && (executionStatus === 'running' || executionStatus === 'queued' || reality === 'IN_PROGRESS')) {
    return 'now_working'
  }

  if (hasRecentEvidence && (executionStatus === 'awaiting_input' || executionStatus === 'blocked' || reality === 'BLOCKED')) {
    return 'waiting_on'
  }

  return 'no_recent_run'
}

function rankState(state: NowWorkingSummary['state']) {
  if (state === 'now_working') return 3
  if (state === 'waiting_on') return 2
  return 1
}

export function deriveNowWorking(tasks: Task[], nowMs = Date.now()): NowWorkingSummary | null {
  const candidates = tasks
    .filter((task) => !task.archived)
    .filter((task) => ['todo', 'in-progress', 'review', 'backlog'].includes(task.status))
    .filter((task) => {
      const agentId = (task.execution?.assignedAgent || task.assignedAgent || '').toLowerCase()
      return ASSIGNABLE_PRODUCT_AGENT_IDS.includes(agentId as typeof ASSIGNABLE_PRODUCT_AGENT_IDS[number])
    })
    .map((task) => {
      const latest = deriveLatestEvidence(task)
      const state = resolveState(task, nowMs, latest.ts)
      return { task, latest, state }
    })

  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    const stateDiff = rankState(b.state) - rankState(a.state)
    if (stateDiff !== 0) return stateDiff
    const aTs = a.latest.ts || 0
    const bTs = b.latest.ts || 0
    return bTs - aTs
  })

  const best = candidates[0]
  const agentId = String(best.task.execution?.assignedAgent || best.task.assignedAgent || '').toLowerCase()

  return {
    state: best.state,
    label: best.state === 'now_working' ? 'Now working' : best.state === 'waiting_on' ? 'Waiting on' : 'No recent run',
    taskId: best.task.id,
    taskTitle: best.task.title,
    agentId,
    latestTimestamp: best.latest.ts ? new Date(best.latest.ts).toISOString() : null,
    latestSource: best.latest.source,
  }
}
