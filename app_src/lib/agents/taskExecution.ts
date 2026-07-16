import type { ChecklistItem, Task } from '@/lib/types'
import { applyCanonicalWorkItem } from '@/lib/workItemModel'

export type AgentTaskExecutionStatus = 'running' | 'completed' | 'triaged' | 'awaiting_input' | 'blocked'

export type AgentTaskExecutionPlan = {
  status: AgentTaskExecutionStatus
  summary: string
  deliverable: string
  nextAction: string
  waitingOn: string
  blocker: string
  descriptionUpdate: string
  checklistAdd: string[]
  checklistComplete: string[]
  learned: string
}

export type AgentTaskExecutionEvidence = {
  status: AgentTaskExecutionStatus
  summary: string
  deliverable: string
  nextAction: string
  waitingOn: string
  blocker: string
  changes: string[]
  completedChecklistIds: string[]
  learned: string
}

export type AgentTaskExecutionApplication = {
  task: Task
  evidence: AgentTaskExecutionEvidence
  applied: boolean
}

const GENERIC_DESCRIPTION = 'Task created from directive. See checklist/comments for execution details.'
const VALID_STATUS = new Set<AgentTaskExecutionStatus>(['running', 'completed', 'triaged', 'awaiting_input', 'blocked'])
const CHECKLIST_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'before',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'through',
  'to',
  'vs',
  'with',
  'add',
  'choose',
  'create',
  'define',
  'design',
  'document',
  'ensure',
  'implement',
  'require',
  'sequence',
  'specify',
  'validate',
  'verify',
])

function cleanText(value: unknown, limit: number) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, limit)
}

function normalizeChecklistToken(token: string) {
  if (token === 'phased') return 'phase'
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
  if (token.endsWith('s') && token.length > 4 && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function checklistConceptTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map(normalizeChecklistToken)
      .filter((token) => token.length > 1 && !CHECKLIST_STOP_WORDS.has(token)),
  )
}

function overlapsExistingChecklist(candidate: string, existing: string[]) {
  const candidateTokens = checklistConceptTokens(candidate)
  if (candidateTokens.size === 0) return false

  return existing.some((text) => {
    if (candidate.trim().toLowerCase() === text.trim().toLowerCase()) return true
    const existingTokens = checklistConceptTokens(text)
    if (existingTokens.size === 0) return false
    let intersection = 0
    for (const token of candidateTokens) {
      if (existingTokens.has(token)) intersection += 1
    }
    const containment = intersection / Math.min(candidateTokens.size, existingTokens.size)
    return (intersection >= 4 && containment >= 0.5)
      || (intersection >= 3 && containment >= 0.75)
  })
}

function extractJsonObject(value: unknown) {
  const raw = String(value || '').trim()
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Agent execution did not return a JSON object')
  return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>
}

export function parseAgentTaskExecutionPlan(value: unknown): AgentTaskExecutionPlan {
  const input = extractJsonObject(value)
  const status = cleanText(input.status, 40).toLowerCase() as AgentTaskExecutionStatus
  if (!VALID_STATUS.has(status)) throw new Error('Agent execution returned an invalid status')

  const summary = cleanText(input.summary, 1200)
  const deliverable = cleanText(input.deliverable, 10_000)
  const nextAction = cleanText(input.nextAction, 500)
  const waitingOn = cleanText(input.waitingOn, 500)
  const blocker = cleanText(input.blocker, 500)
  const descriptionUpdate = cleanText(input.descriptionUpdate, 10_000)
  const checklistAdd = Array.from(new Set(
    (Array.isArray(input.checklistAdd) ? input.checklistAdd : [])
      .map((item) => cleanText(item, 240))
      .filter(Boolean),
  )).slice(0, 12)
  const checklistComplete = Array.from(new Set(
    (Array.isArray(input.checklistComplete) ? input.checklistComplete : [])
      .map((item) => cleanText(item, 240))
      .filter(Boolean),
  )).slice(0, 1)
  const learned = cleanText(input.learned, 280)

  if (!summary) throw new Error('Agent execution summary is required')
  if (!nextAction) throw new Error('Agent execution nextAction is required')
  if ((status === 'running' || status === 'completed') && !deliverable) {
    throw new Error('Agent execution deliverable is required for substantive progress')
  }
  if (status === 'blocked' && !blocker) throw new Error('Blocked agent execution requires a specific blocker')
  if (status === 'awaiting_input' && !waitingOn) throw new Error('Awaiting-input execution requires a specific request')

  return {
    status,
    summary,
    deliverable,
    nextAction,
    waitingOn,
    blocker,
    descriptionUpdate,
    checklistAdd,
    checklistComplete,
    learned,
  }
}

function canRepairDescription(task: Task) {
  const description = String(task.desc || '').trim()
  return !description || description === GENERIC_DESCRIPTION
}

function evidenceFromPlan(
  plan: AgentTaskExecutionPlan,
  changes: string[],
  completedChecklistIds: string[] = [],
): AgentTaskExecutionEvidence {
  return {
    status: plan.status,
    summary: plan.summary,
    deliverable: plan.deliverable,
    nextAction: plan.nextAction,
    waitingOn: plan.waitingOn,
    blocker: plan.blocker,
    changes,
    completedChecklistIds,
    learned: plan.learned,
  }
}

export function applyAgentTaskExecutionPlan(input: {
  task: Task
  plan: AgentTaskExecutionPlan
  agentId: string
  dispatchId: string
  timestamp: string
}): { task: Task; evidence: AgentTaskExecutionEvidence } {
  const { task, plan, agentId, dispatchId, timestamp } = input
  const changes: string[] = []
  let description = task.desc
  if (plan.descriptionUpdate && canRepairDescription(task) && plan.descriptionUpdate !== task.desc) {
    description = plan.descriptionUpdate
    changes.push('description updated')
  }

  const existingChecklist = Array.isArray(task.checklist) ? task.checklist : []
  const acceptedChecklistText = existingChecklist.map((item) => item.text)
  const addedChecklist: ChecklistItem[] = []
  for (const item of plan.checklistAdd) {
    if (overlapsExistingChecklist(item, acceptedChecklistText)) continue
    acceptedChecklistText.push(item)
    addedChecklist.push({
      id: `agent-${dispatchId}-ck-${addedChecklist.length + 1}`,
      text: item,
      done: false,
      agentId,
    })
  }
  if (addedChecklist.length > 0) changes.push(`${addedChecklist.length} checklist item${addedChecklist.length === 1 ? '' : 's'} added`)

  const completedChecklistIds: string[] = []
  const requestedChecklistIds = new Set(plan.checklistComplete)
  const updatedChecklist = existingChecklist.map((item) => {
    if (item.done || !requestedChecklistIds.has(item.id)) return item
    completedChecklistIds.push(item.id)
    changes.push(`checklist completed: "${item.text}"`)
    return { ...item, done: true }
  })
  const checklist = [...updatedChecklist, ...addedChecklist]
  const hasRemainingChecklist = checklist.some((item) => !item.done)
  const effectiveStatus: AgentTaskExecutionStatus = plan.status === 'completed' && hasRemainingChecklist
    ? 'running'
    : plan.status === 'running' && !hasRemainingChecklist
      ? 'completed'
      : plan.status
  const effectivePlan = effectiveStatus === plan.status ? plan : { ...plan, status: effectiveStatus }

  const previousNextAction = String(task.workItem?.nextAction || '').trim()
  if (plan.nextAction !== previousNextAction) changes.push('next action updated')
  if (effectivePlan.blocker) changes.push('specific blocker recorded')
  else if (effectivePlan.waitingOn) changes.push('required input recorded')

  const note = [
    `Status: ${effectivePlan.status}`,
    `Summary: ${effectivePlan.summary}`,
    effectivePlan.deliverable ? `Deliverable: ${effectivePlan.deliverable}` : null,
    `Next action: ${effectivePlan.nextAction}`,
    `Waiting on: ${effectivePlan.waitingOn || 'none'}`,
    `Blocker: ${effectivePlan.blocker || 'none'}`,
    `Evidence: ${changes.length > 0 ? changes.join('; ') : 'No task artifact changed'}`,
  ].filter(Boolean).join('\n')
  const lastResult = {
    type: 'agent-task-execution',
    status: effectivePlan.status,
    summary: effectivePlan.summary,
    deliverable: effectivePlan.deliverable || undefined,
    whatWasDone: changes.length > 0 ? changes.join('; ') : undefined,
    nextAction: effectivePlan.nextAction,
    waitingOn: effectivePlan.waitingOn || undefined,
    blockedReason: effectivePlan.blocker || undefined,
    evidence: changes,
    completedChecklistIds,
    learned: effectivePlan.learned || undefined,
    dispatchId,
    recordedAt: timestamp,
  }
  const activity = [
    ...(task.activity || []),
    {
      type: 'updated' as const,
      message: changes.length > 0
        ? `Agent ${agentId} applied task-scoped changes: ${changes.join(', ')}.`
        : `Agent ${agentId} reported ${effectivePlan.status} without changing a task artifact.`,
      timestamp,
      actor: agentId,
      taskId: task.id,
      taskTitle: task.title,
    },
  ]
  const nextTask = applyCanonicalWorkItem({
    ...task,
    desc: description,
    checklist,
    activity,
    execution: {
      ...(task.execution || {}),
      executionStatus: effectivePlan.status,
      lastUpdatedAt: timestamp,
      latestExecutionNote: note,
      lastResult,
    },
    updatedAt: timestamp,
  })
  return {
    task: nextTask,
    evidence: evidenceFromPlan(effectivePlan, changes, completedChecklistIds),
  }
}

export function applyAgentTaskExecutionPlanForDispatch(input: {
  task: Task
  plan: AgentTaskExecutionPlan
  agentId: string
  dispatchId: string
  timestamp: string
}): AgentTaskExecutionApplication {
  const currentDispatchId = String(input.task.execution?.agentDispatch?.id || '')
  if (currentDispatchId !== input.dispatchId) {
    return {
      task: input.task,
      evidence: evidenceFromPlan(input.plan, []),
      applied: false,
    }
  }

  const applied = applyAgentTaskExecutionPlan(input)
  return { ...applied, applied: true }
}

export function readPersistedAgentTaskExecutionEvidence(
  task: Task,
  dispatchId: string,
): AgentTaskExecutionEvidence | null {
  const result = task.execution?.lastResult
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  if (cleanText(record.type, 80) !== 'agent-task-execution') return null
  if (cleanText(record.dispatchId, 100) !== dispatchId) return null

  const status = cleanText(record.status, 40).toLowerCase() as AgentTaskExecutionStatus
  const summary = cleanText(record.summary, 1200)
  const nextAction = cleanText(record.nextAction, 500)
  if (!VALID_STATUS.has(status) || !summary || !nextAction) return null

  return {
    status,
    summary,
    deliverable: cleanText(record.deliverable, 10_000),
    nextAction,
    waitingOn: cleanText(record.waitingOn, 500),
    blocker: cleanText(record.blockedReason, 500),
    changes: (Array.isArray(record.evidence) ? record.evidence : [])
      .map((change) => cleanText(change, 240))
      .filter(Boolean)
      .slice(0, 20),
    completedChecklistIds: (Array.isArray(record.completedChecklistIds) ? record.completedChecklistIds : [])
      .map((id) => cleanText(id, 240))
      .filter(Boolean)
      .slice(0, 20),
    learned: cleanText(record.learned, 280),
  }
}

export function restorePersistedAgentTaskExecutionOutcome(input: {
  task: Task
  agentId: string
  dispatchId: string
  timestamp: string
}): { task: Task; evidence: AgentTaskExecutionEvidence; summary: string } | null {
  const currentDispatch = input.task.execution?.agentDispatch
  if (!currentDispatch || currentDispatch.id !== input.dispatchId) return null

  const evidence = readPersistedAgentTaskExecutionEvidence(input.task, input.dispatchId)
  if (!evidence) return null

  const result = input.task.execution?.lastResult as Record<string, unknown>
  const recordedAtValue = cleanText(result.recordedAt, 100)
  const recordedAt = Number.isFinite(Date.parse(recordedAtValue)) ? recordedAtValue : input.timestamp
  const summary = formatAgentTaskExecutionResult(input.agentId, evidence)
  const task = applyCanonicalWorkItem({
    ...input.task,
    execution: {
      ...(input.task.execution || {}),
      executionStatus: evidence.status,
      lastUpdatedAt: recordedAt,
      latestExecutionNote: summary,
      agentDispatch: {
        ...currentDispatch,
        status: 'succeeded',
        updatedAt: input.timestamp,
        error: undefined,
      },
    },
    updatedAt: input.timestamp,
  })
  return { task, evidence, summary }
}

export function formatAgentTaskExecutionResult(agentId: string, evidence: AgentTaskExecutionEvidence) {
  return [
    `Agent: ${agentId}`,
    `Status: ${evidence.status}`,
    '',
    `Summary: ${evidence.summary}`,
    evidence.deliverable ? `Deliverable:\n${evidence.deliverable}` : 'Deliverable: No substantive deliverable was produced.',
    `Changed: ${evidence.changes.length > 0 ? evidence.changes.join('; ') : 'No task artifact changed.'}`,
    `Evidence: ${evidence.changes.length > 0 ? evidence.changes.join('; ') : 'No persisted task mutation.'}`,
    `Remaining: ${evidence.nextAction}`,
    `Waiting on: ${evidence.blocker || evidence.waitingOn || 'none'}`,
    `Learned: ${evidence.learned || 'none'}`,
  ].join('\n')
}

export function isGenericTaskDescription(value: unknown) {
  return cleanText(value, 10_000) === GENERIC_DESCRIPTION
}
