import type { Task } from '@/lib/types'

export type TaskState = 'draft' | 'needs_input' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'archived' | 'deleted'
export type TaskStateModel = {
  states: TaskState[]
  transitions: Record<TaskState, TaskState[]>
}

export const TASK_STATE_MODEL: TaskStateModel = {
  states: ['draft', 'needs_input', 'ready', 'in_progress', 'blocked', 'done', 'archived', 'deleted'],
  transitions: {
    draft: ['needs_input', 'ready', 'archived', 'deleted'],
    needs_input: ['ready', 'blocked', 'archived', 'deleted'],
    ready: ['in_progress', 'blocked', 'done', 'archived', 'deleted'],
    in_progress: ['blocked', 'ready', 'done', 'archived', 'deleted'],
    blocked: ['ready', 'in_progress', 'archived', 'deleted'],
    done: ['archived', 'deleted'],
    archived: ['ready', 'deleted'],
    deleted: [],
  },
}

export type TaskReadiness = 'READY' | 'NEEDS_INPUT' | 'BLOCKED' | 'IN_PROGRESS'
export type TaskReadinessResult = {
  status: TaskReadiness
  state: TaskState
  missing: string[]
  reasons: string[]
}

export type TaskStartability = 'STARTABLE' | 'ALREADY_ACTIVE' | 'NOT_STARTABLE'
export type TaskStartabilityResult = {
  status: TaskStartability
  state: TaskState
  reason: string
}

function hasBlockedTag(tags: string[] | undefined): boolean {
  return (tags || []).some((tag) => tag.trim().toLowerCase() === 'blocked')
}

export function getTaskState(task: Task): { state: TaskState; missing: string[]; reasons: string[] } {
  const missing: string[] = []
  const reasons: string[] = []

  if (task.deletedAt) return { state: 'deleted', missing, reasons }
  if (task.archived) return { state: 'archived', missing, reasons }
  if (task.status === 'done') return { state: 'done', missing, reasons }

  if (hasBlockedTag(task.tags)) {
    reasons.push('blocked-tag')
    return { state: 'blocked', missing, reasons }
  }

  if (task.status === 'in-progress') return { state: 'in_progress', missing, reasons }

  if (!task.assignedAgent) missing.push('owner')
  if (!task.dueDate) missing.push('dueDate')
  if (!task.priority) missing.push('priority')
  if (!task.desc || !task.desc.trim()) missing.push('description')
  if (!task.checklist || task.checklist.length === 0) missing.push('acceptanceCriteria')

  if (missing.length > 0) {
    return { state: task.status === 'backlog' ? 'draft' : 'needs_input', missing, reasons }
  }

  return { state: 'ready', missing, reasons }
}

export function getTaskReadiness(task: Task): TaskReadinessResult {
  const { state, missing, reasons } = getTaskState(task)
  if (state === 'blocked') return { status: 'BLOCKED', state, missing, reasons }
  if (state === 'in_progress') return { status: 'IN_PROGRESS', state, missing, reasons }
  if (state === 'needs_input' || state === 'draft') return { status: 'NEEDS_INPUT', state, missing, reasons }
  return { status: 'READY', state, missing, reasons }
}

export function getTaskStartability(task: Task): TaskStartabilityResult {
  const { state } = getTaskState(task)
  if (state === 'ready') return { status: 'STARTABLE', state, reason: 'ready' }
  if (state === 'in_progress') return { status: 'ALREADY_ACTIVE', state, reason: 'in_progress' }
  return { status: 'NOT_STARTABLE', state, reason: state }
}

export type ExecutionStatus = 'queued' | 'running' | 'blocked' | 'awaiting_input' | 'completed'
export const EXECUTION_LIFECYCLE = {
  statuses: ['queued', 'running', 'blocked', 'awaiting_input', 'completed'] as ExecutionStatus[],
  transitions: {
    queued: ['running', 'blocked', 'awaiting_input', 'completed'],
    running: ['blocked', 'awaiting_input', 'completed'],
    blocked: ['running', 'awaiting_input', 'completed'],
    awaiting_input: ['running', 'blocked', 'completed'],
    completed: [],
  } as Record<ExecutionStatus, ExecutionStatus[]>,
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_LIFECYCLE.transitions[from]?.includes(to)
}

export function normalizeExecutionStatus(prev: ExecutionStatus | undefined, next: ExecutionStatus): ExecutionStatus {
  if (!prev) return next
  return canTransitionExecution(prev, next) ? next : prev
}

export type AutoPickupEligibility = {
  eligible: boolean
  reasons: string[]
}

export function getAutoPickupEligibility(task: Task): AutoPickupEligibility {
  const reasons: string[] = []
  const startability = getTaskStartability(task)
  if (startability.status !== 'STARTABLE') reasons.push(`not-startable:${startability.reason}`)

  const executionStatus = task.execution?.executionStatus
  if (executionStatus && executionStatus !== 'queued') reasons.push(`execution-status:${executionStatus}`)

  if (!task.assignedAgent) reasons.push('no-assigned-agent')
  if (hasBlockedTag(task.tags)) reasons.push('blocked-tag')
  if (task.archived) reasons.push('archived')

  return { eligible: reasons.length === 0, reasons }
}
