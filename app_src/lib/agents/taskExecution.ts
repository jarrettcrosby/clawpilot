import type { ChecklistItem, Task } from '@/lib/types'
import { applyCanonicalWorkItem } from '@/lib/workItemModel'

export type AgentTaskExecutionStatus = 'triaged' | 'awaiting_input' | 'blocked'

export type AgentTaskExecutionPlan = {
  status: AgentTaskExecutionStatus
  summary: string
  nextAction: string
  waitingOn: string
  blocker: string
  descriptionUpdate: string
  checklistAdd: string[]
  learned: string
}

export type AgentTaskExecutionEvidence = {
  status: AgentTaskExecutionStatus
  summary: string
  nextAction: string
  waitingOn: string
  blocker: string
  changes: string[]
  learned: string
}

const GENERIC_DESCRIPTION = 'Task created from directive. See checklist/comments for execution details.'
const VALID_STATUS = new Set<AgentTaskExecutionStatus>(['triaged', 'awaiting_input', 'blocked'])

function cleanText(value: unknown, limit: number) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, limit)
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
  const nextAction = cleanText(input.nextAction, 500)
  const waitingOn = cleanText(input.waitingOn, 500)
  const blocker = cleanText(input.blocker, 500)
  const descriptionUpdate = cleanText(input.descriptionUpdate, 10_000)
  const checklistAdd = Array.from(new Set(
    (Array.isArray(input.checklistAdd) ? input.checklistAdd : [])
      .map((item) => cleanText(item, 240))
      .filter(Boolean),
  )).slice(0, 12)
  const learned = cleanText(input.learned, 280)

  if (!summary) throw new Error('Agent execution summary is required')
  if (!nextAction) throw new Error('Agent execution nextAction is required')
  if (status === 'blocked' && !blocker) throw new Error('Blocked agent execution requires a specific blocker')
  if (status === 'awaiting_input' && !waitingOn) throw new Error('Awaiting-input execution requires a specific request')

  return {
    status,
    summary,
    nextAction,
    waitingOn,
    blocker,
    descriptionUpdate,
    checklistAdd,
    learned,
  }
}

function canRepairDescription(task: Task) {
  const description = String(task.desc || '').trim()
  return !description || description === GENERIC_DESCRIPTION
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
  const existingChecklistText = new Set(existingChecklist.map((item) => item.text.trim().toLowerCase()))
  const addedChecklist: ChecklistItem[] = []
  for (const item of plan.checklistAdd) {
    if (existingChecklistText.has(item.toLowerCase())) continue
    existingChecklistText.add(item.toLowerCase())
    addedChecklist.push({
      id: `agent-${dispatchId}-ck-${addedChecklist.length + 1}`,
      text: item,
      done: false,
      agentId,
    })
  }
  if (addedChecklist.length > 0) changes.push(`${addedChecklist.length} checklist item${addedChecklist.length === 1 ? '' : 's'} added`)

  const previousNextAction = String(task.workItem?.nextAction || '').trim()
  if (plan.nextAction !== previousNextAction) changes.push('next action updated')
  if (plan.blocker) changes.push('specific blocker recorded')
  else if (plan.waitingOn) changes.push('required input recorded')

  const note = [
    `Status: ${plan.status}`,
    `Summary: ${plan.summary}`,
    `Next action: ${plan.nextAction}`,
    `Waiting on: ${plan.waitingOn || 'none'}`,
    `Blocker: ${plan.blocker || 'none'}`,
    `Evidence: ${changes.length > 0 ? changes.join('; ') : 'No task artifact changed'}`,
  ].join('\n')
  const lastResult = {
    type: 'agent-task-execution',
    status: plan.status,
    summary: plan.summary,
    whatWasDone: changes.length > 0 ? changes.join('; ') : 'No task artifact changed',
    nextAction: plan.nextAction,
    waitingOn: plan.waitingOn || undefined,
    blockedReason: plan.blocker || undefined,
    evidence: changes,
    dispatchId,
    recordedAt: timestamp,
  }
  const activity = [
    ...(task.activity || []),
    {
      type: 'updated' as const,
      message: changes.length > 0
        ? `Agent ${agentId} applied task-scoped changes: ${changes.join(', ')}.`
        : `Agent ${agentId} reported ${plan.status} without changing a task artifact.`,
      timestamp,
      actor: agentId,
      taskId: task.id,
      taskTitle: task.title,
    },
  ]
  const nextTask = applyCanonicalWorkItem({
    ...task,
    desc: description,
    checklist: [...existingChecklist, ...addedChecklist],
    activity,
    execution: {
      ...(task.execution || {}),
      executionStatus: plan.status,
      lastUpdatedAt: timestamp,
      latestExecutionNote: note,
      lastResult,
    },
    updatedAt: timestamp,
  })
  return {
    task: nextTask,
    evidence: {
      status: plan.status,
      summary: plan.summary,
      nextAction: plan.nextAction,
      waitingOn: plan.waitingOn,
      blocker: plan.blocker,
      changes,
      learned: plan.learned,
    },
  }
}

export function formatAgentTaskExecutionResult(agentId: string, evidence: AgentTaskExecutionEvidence) {
  return [
    `Agent: ${agentId}`,
    `Status: ${evidence.status}`,
    '',
    `Summary: ${evidence.summary}`,
    `Changed: ${evidence.changes.length > 0 ? evidence.changes.join('; ') : 'No deliverable changed.'}`,
    `Evidence: ${evidence.changes.length > 0 ? evidence.changes.join('; ') : 'No persisted task mutation.'}`,
    `Remaining: ${evidence.nextAction}`,
    `Waiting on: ${evidence.blocker || evidence.waitingOn || 'none'}`,
    `Learned: ${evidence.learned || 'none'}`,
  ].join('\n')
}

export function isGenericTaskDescription(value: unknown) {
  return cleanText(value, 10_000) === GENERIC_DESCRIPTION
}
