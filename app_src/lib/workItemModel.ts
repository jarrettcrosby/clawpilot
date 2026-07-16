import type { Task, ActivityEntry, ChecklistItem } from '@/lib/types'
import { isCrmBoardCard, normalizeCrmBoardCard } from '@/lib/crm/boardCard.mjs'

export type CanonicalWorkItem = {
  status: Task['status']
  assignedAgent?: string
  nextAction?: string
  blocker?: string
  lastConcreteAction?: string
  waitingOn?: string
  activity: ActivityEntry[]
}

export type StateTruthLabel = 'Moving' | 'Waiting' | 'Blocked' | 'Ready to close'

export type StateTruthInput = {
  workItem?: Pick<CanonicalWorkItem, 'nextAction' | 'blocker' | 'lastConcreteAction' | 'waitingOn'>
  checklist?: ChecklistItem[]
  executionStatus?: string
  executionUpdatedAt?: string
  updatedAt?: string
  createdAt?: string
  nowMs?: number
}

export type StateTruth = {
  stateLabel: StateTruthLabel
  reason: string
}

export type NextActionGuidanceInput = StateTruthInput & {
  stateTruth?: StateTruth
}

export type ClosureAuthority = {
  closable: boolean
  reason: string
}

function extractLineValue(text: string, prefixes: string[]): string | undefined {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    for (const prefix of prefixes) {
      const re = new RegExp(`^${prefix}\\s*:`, 'i')
      if (re.test(line)) {
        const value = line.replace(re, '').trim()
        if (value && !/^(?:none|n\/?a|not applicable)$/i.test(value)) return value
      }
    }
  }
  return undefined
}

function firstMeaningfulLine(text: string): string | undefined {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const noisyPrefixes = [/^next\s*:?/i, /^next action\s*:?/i, /^blocker\s*:?/i, /^blocked reason\s*:?/i, /^waiting on\s*:?/i, /^status\s*:?/i]
  const line = lines.find((l) => !noisyPrefixes.some((re) => re.test(l)))
  return line || undefined
}

function formatRelativeAge(msDiff: number): string {
  const mins = Math.max(1, Math.round(msDiff / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export function deriveCanonicalNextAction(task: Task): string | undefined {
  const result = (task.execution?.lastResult || {}) as { nextAction?: unknown; suggestedNextAction?: unknown }
  const fromResult = result.nextAction ?? result.suggestedNextAction
  if (typeof fromResult === 'string' && fromResult.trim()) return fromResult.trim()

  const fromNote = extractLineValue(task.execution?.latestExecutionNote || '', ['next action', 'next'])
  if (fromNote) return fromNote

  return undefined
}

export function deriveCanonicalBlocker(task: Task): string | undefined {
  const result = (task.execution?.lastResult || {}) as { blockedReason?: unknown }
  if (typeof result.blockedReason === 'string' && result.blockedReason.trim()) return result.blockedReason.trim()

  const fromNote = extractLineValue(task.execution?.latestExecutionNote || '', ['blocker', 'blocked reason'])
  if (fromNote) return fromNote
  return undefined
}

export function deriveCanonicalLastConcreteAction(task: Task): string | undefined {
  const result = (task.execution?.lastResult || {}) as {
    type?: unknown
    evidence?: unknown
    whatWasDone?: unknown
    summary?: unknown
    currentState?: unknown
  }
  if (result.type === 'agent-task-execution' && Array.isArray(result.evidence) && result.evidence.length === 0) {
    return undefined
  }
  const fromResult = result.whatWasDone ?? result.summary ?? result.currentState
  if (typeof fromResult === 'string' && fromResult.trim()) return fromResult.trim()

  const fromNote = firstMeaningfulLine(task.execution?.latestExecutionNote || '')
  if (fromNote) return fromNote

  const latestActivity = [...(task.activity || [])].reverse().find((entry) => !!String(entry?.message || '').trim())
  if (latestActivity?.message) return String(latestActivity.message).trim()

  return undefined
}

export function deriveCanonicalWaitingOn(task: Task): string | undefined {
  const fromBlocker = deriveCanonicalBlocker(task)
  if (fromBlocker) return fromBlocker

  const fromNote = extractLineValue(task.execution?.latestExecutionNote || '', ['waiting on'])
  if (fromNote) return fromNote

  if ((task.execution?.executionStatus || '').toLowerCase() === 'awaiting_input') {
    return deriveCanonicalNextAction(task) || 'Owner input required'
  }

  return undefined
}

export function deriveStateTruth(input: StateTruthInput): StateTruth {
  const nowMs = input.nowMs || Date.now()
  const blocker = String(input.workItem?.blocker || '').trim()
  const waitingOn = String(input.workItem?.waitingOn || '').trim()
  const lastAction = String(input.workItem?.lastConcreteAction || '').trim()
  const executionStatus = String(input.executionStatus || '').toLowerCase()

  const closure = deriveClosureAuthority(input)

  // strict precedence: Blocked > Ready to close > Waiting > Moving
  if (blocker) {
    return { stateLabel: 'Blocked', reason: blocker }
  }

  if (closure.closable) {
    return { stateLabel: 'Ready to close', reason: closure.reason }
  }

  if (waitingOn) {
    return { stateLabel: 'Waiting', reason: waitingOn }
  }

  if (executionStatus === 'awaiting_input') {
    return { stateLabel: 'Waiting', reason: 'Owner input required' }
  }

  const referenceTs = input.executionUpdatedAt || input.updatedAt || input.createdAt
  const referenceMs = referenceTs ? new Date(referenceTs).getTime() : NaN
  const isRecent = Number.isFinite(referenceMs) ? (nowMs - referenceMs) <= 24 * 60 * 60 * 1000 : false

  if (lastAction && isRecent) {
    return { stateLabel: 'Moving', reason: `Last action ${formatRelativeAge(nowMs - referenceMs)}` }
  }

  return { stateLabel: 'Waiting', reason: lastAction ? 'No recent action recorded' : 'Awaiting next action' }
}

export function deriveClosureAuthority(input: StateTruthInput): ClosureAuthority {
  const nextAction = String(input.workItem?.nextAction || '').trim()
  const executionStatus = String(input.executionStatus || '').toLowerCase()
  const checklist = Array.isArray(input.checklist) ? input.checklist : []
  const checklistComplete = checklist.length > 0 && checklist.every((item) => !!item.done)

  if (checklistComplete) {
    return { closable: true, reason: 'Checklist complete' }
  }

  if (executionStatus === 'completed' && !nextAction) {
    return { closable: true, reason: 'Execution complete, no next action' }
  }

  return { closable: false, reason: 'Triage required' }
}

export function deriveNextActionGuidance(input: NextActionGuidanceInput): string {
  const stateTruth = input.stateTruth || deriveStateTruth(input)
  const closure = deriveClosureAuthority(input)
  const blocker = String(input.workItem?.blocker || '').trim()
  const waitingOn = String(input.workItem?.waitingOn || '').trim()
  const checklist = Array.isArray(input.checklist) ? input.checklist : []
  const nextOpenChecklist = checklist.find((item) => !item.done && String(item.text || '').trim())

  if (closure.closable || stateTruth.stateLabel === 'Ready to close') {
    return 'Review and close task'
  }

  if (stateTruth.stateLabel === 'Blocked' || blocker) {
    return blocker ? `Resolve blocker: ${blocker}` : 'Resolve blocker to continue'
  }

  if (stateTruth.stateLabel === 'Waiting' || waitingOn) {
    return waitingOn ? `Provide ${waitingOn} to unblock` : 'Provide required input to unblock'
  }

  if (nextOpenChecklist?.text) {
    return `Complete checklist item: ${nextOpenChecklist.text}`
  }

  return 'Provide required input to unblock'
}

export function buildCanonicalWorkItem(task: Task): CanonicalWorkItem {
  return {
    status: task.status,
    assignedAgent: task.assignedAgent,
    nextAction: deriveCanonicalNextAction(task),
    blocker: deriveCanonicalBlocker(task),
    lastConcreteAction: deriveCanonicalLastConcreteAction(task),
    waitingOn: deriveCanonicalWaitingOn(task),
    activity: Array.isArray(task.activity) ? task.activity : [],
  }
}

export function applyCanonicalWorkItem(task: Task): Task {
  if (isCrmBoardCard(task)) return normalizeCrmBoardCard(task) as Task
  const canonical = buildCanonicalWorkItem(task)
  return {
    ...task,
    status: canonical.status,
    assignedAgent: canonical.assignedAgent,
    workItem: canonical,
  }
}

export function canonicalizeTasks(tasks: Task[]): Task[] {
  return (Array.isArray(tasks) ? tasks : []).map((task) => applyCanonicalWorkItem(task))
}
