import type { Task } from '@/lib/types'

export type TaskRealityState =
  | 'ACTION_REQUIRED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'DONE_CONFIRMED'
  | 'DONE_UNCONFIRMED'

export type CompletionReconciliationState =
  | 'READY_TO_CLOSE'
  | 'LIKELY_COMPLETE'
  | 'STILL_ACTIVE'

function extractField(text: string | undefined, label: string) {
  if (!text) return ''
  const m = text.match(new RegExp(`^${label}\\s*:\\s*(.+)$`, 'im'))
  return m?.[1]?.trim() || ''
}

function hasRecentExecution(task: Task, nowMs: number) {
  const recordedAt = String((task.execution?.lastResult as { recordedAt?: string } | undefined)?.recordedAt || '')
  if (!recordedAt) return false
  const ts = Date.parse(recordedAt)
  if (!Number.isFinite(ts)) return false
  const ageMs = nowMs - ts
  return ageMs <= 14 * 24 * 60 * 60 * 1000
}

function hasExecutionEvidence(task: Task, nowMs: number) {
  if (hasRecentExecution(task, nowMs)) return true
  const recentActivity = (task.activity || []).some((entry) => {
    const ts = Date.parse(String(entry.timestamp || ''))
    if (!Number.isFinite(ts)) return false
    const ageMs = nowMs - ts
    if (ageMs > 14 * 24 * 60 * 60 * 1000) return false
    return entry.type === 'comment' && /execution summary|agent .*posted execution/i.test(String(entry.message || ''))
  })
  return recentActivity
}

export function deriveTaskRealityState(task: Task, nowMs = Date.now()): TaskRealityState {
  const executionStatus = String(task.execution?.executionStatus || '').toLowerCase()
  const latestNote = String(task.execution?.latestExecutionNote || '')
  const lastResult = (task.execution?.lastResult || {}) as { blockedReason?: string }
  const blocker = extractField(latestNote, 'Blocker') || extractField(latestNote, 'Blocked reason') || String(lastResult.blockedReason || '')

  if (blocker.trim()) return 'BLOCKED'
  if (executionStatus === 'running') return 'IN_PROGRESS'

  const completed = executionStatus === 'completed'
  const recentEvidence = hasExecutionEvidence(task, nowMs)

  if (completed && recentEvidence && task.status === 'done') return 'DONE_CONFIRMED'
  if (completed && recentEvidence && task.status !== 'done') return 'DONE_UNCONFIRMED'

  return 'ACTION_REQUIRED'
}

export function deriveCompletionReconciliation(task: Task, nowMs = Date.now()): { state: CompletionReconciliationState; reason: string } {
  const reality = deriveTaskRealityState(task, nowMs)
  const checklist = task.checklist || []
  const checklistAllDone = checklist.length > 0 && checklist.every((item) => item.done)
  const latestNote = String(task.execution?.latestExecutionNote || '')
  const nextAction = String((task.execution?.lastResult as { nextAction?: string } | undefined)?.nextAction || '').trim()

  if (reality === 'BLOCKED' || reality === 'IN_PROGRESS') {
    return { state: 'STILL_ACTIVE', reason: reality === 'BLOCKED' ? 'Blocked work still needs input.' : 'Execution is currently running.' }
  }

  if (reality === 'DONE_CONFIRMED') {
    return { state: 'READY_TO_CLOSE', reason: 'Completion evidence is verified and task is already marked done.' }
  }

  if (reality === 'DONE_UNCONFIRMED') {
    if (!nextAction || /close|mark done|complete|ship|approved?/i.test(nextAction)) {
      return { state: 'READY_TO_CLOSE', reason: 'Execution indicates completion and no remaining action is required.' }
    }
    if (checklistAllDone) {
      return { state: 'LIKELY_COMPLETE', reason: 'Execution completed and all checklist items are done; closure review is recommended.' }
    }
    return { state: 'LIKELY_COMPLETE', reason: 'Execution appears complete but task is not explicitly closed yet.' }
  }

  if (checklistAllDone && /completed|done|finished|shipped/i.test(latestNote)) {
    return { state: 'LIKELY_COMPLETE', reason: 'Checklist is complete and execution notes indicate completion.' }
  }

  return { state: 'STILL_ACTIVE', reason: 'Task still has open execution work.' }
}
