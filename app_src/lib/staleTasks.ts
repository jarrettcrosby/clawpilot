import type { Task } from '@/lib/types'

export const STALE_TASK_HOURS = 24

function asTask(task: unknown): Task | null {
  if (!task || typeof task !== 'object') return null
  return task as Task
}

export function getTaskLastTouchedAt(taskInput: unknown): string {
  const task = asTask(taskInput)
  if (!task) return new Date(0).toISOString()

  const activityTimestamps = Array.isArray(task.activity)
    ? task.activity.map((entry) => String(entry?.timestamp || '')).filter(Boolean)
    : []

  const candidates = [
    task.execution?.lastUpdatedAt,
    task.updatedAt,
    ...activityTimestamps,
  ].filter(Boolean) as string[]

  return candidates
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || task.updatedAt || task.createdAt || new Date(0).toISOString()
}

export function getTaskStaleAgeHours(taskInput: unknown, nowMs = Date.now()): number {
  const touchedAt = getTaskLastTouchedAt(taskInput)
  const touchedMs = Date.parse(touchedAt)
  if (!Number.isFinite(touchedMs)) return 0
  return Math.max(0, (nowMs - touchedMs) / (1000 * 60 * 60))
}

export function isTaskStale(taskInput: unknown, nowMs = Date.now(), thresholdHours = STALE_TASK_HOURS): boolean {
  const task = asTask(taskInput)
  if (!task) return false
  if (task.archived) return false
  if (task.status !== 'in-progress') return false
  if ((task.tags || []).includes('blocked')) return false
  return getTaskStaleAgeHours(task, nowMs) >= thresholdHours
}
