import type { Task } from '@/lib/types'
import { STALE_TASK_HOURS, getTaskStaleAgeHours } from '@/lib/staleTasks'

export type LiveActivitySource = 'execution' | 'reply' | 'activity' | 'task'
export type LiveFreshnessState = 'active' | 'aging' | 'stale'

export type LiveState = {
  owner: string
  lastActivityAt: string
  activitySource: LiveActivitySource
  freshnessState: LiveFreshnessState
  staleAgain: boolean
}

const STALE_AGAIN_HOURS = 72

function toMs(value?: string): number {
  if (!value) return Number.NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.NaN
}

function latestTimestamp(task: Task): { at: string; source: LiveActivitySource } {
  const commentTs = (task.comments || [])
    .map((c) => String(c?.createdAt || c?.timestamp || ''))
    .filter(Boolean)
  const activityTs = (task.activity || [])
    .map((a) => String(a?.timestamp || ''))
    .filter(Boolean)

  const candidates: Array<{ at?: string; source: LiveActivitySource }> = [
    { at: task.execution?.lastUpdatedAt, source: 'execution' },
    ...commentTs.map((at) => ({ at, source: 'reply' as const })),
    ...activityTs.map((at) => ({ at, source: 'activity' as const })),
    { at: task.updatedAt, source: 'task' },
    { at: task.createdAt, source: 'task' },
  ]

  const ranked = candidates
    .filter((c) => Number.isFinite(toMs(c.at)))
    .sort((a, b) => toMs(b.at) - toMs(a.at))

  return {
    at: ranked[0]?.at || task.updatedAt || task.createdAt || new Date(0).toISOString(),
    source: ranked[0]?.source || 'task',
  }
}

export function deriveLiveState(task: Task, nowMs = Date.now()): LiveState {
  const latest = latestTimestamp(task)
  const staleAgeHours = getTaskStaleAgeHours(task, nowMs)

  const freshnessState: LiveFreshnessState = staleAgeHours < 8
    ? 'active'
    : staleAgeHours < STALE_TASK_HOURS
      ? 'aging'
      : 'stale'

  const isInProgress = task.status === 'in-progress' && !task.archived && !(task.tags || []).includes('blocked')

  return {
    owner: task.assignedAgent || 'Unassigned',
    lastActivityAt: latest.at,
    activitySource: latest.source,
    freshnessState,
    staleAgain: isInProgress && staleAgeHours >= STALE_AGAIN_HOURS,
  }
}

export function formatLiveActivityAge(lastActivityAt: string, nowMs = Date.now()): string {
  const ms = toMs(lastActivityAt)
  if (!Number.isFinite(ms)) return 'unknown'
  const delta = Math.max(0, nowMs - ms)
  const mins = Math.floor(delta / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
