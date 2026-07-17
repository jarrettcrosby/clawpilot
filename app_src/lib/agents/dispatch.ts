import crypto from 'crypto'
import type { Task } from '@/lib/types'
import type { AgentDispatchEnqueueInput, AgentDispatchTrigger } from '@/lib/persistence/agentDispatch'

const AGENT_NAMES: Record<string, string> = {
  clawpilot: 'ClawPilot',
  projects: 'Projects',
  pipeline: 'Pipeline',
  docs: 'Docs',
  calendar: 'Calendar',
}

const DISPATCH_TRIGGER_LABELS: Record<AgentDispatchTrigger, string> = {
  assignment: 'assignment',
  comment: 'comment',
  continuation: 'continued work',
  manual: 'manual work request',
}

export function assignmentKickoffText() {
  return 'This task was assigned to you for autonomous execution. Use the available task-scoped tools now, persist concrete changes, and record evidence. If the requested deliverable requires a capability that is not available in this run, record that exact blocker instead of reporting the work as complete.'
}

export function commentTargetsAssignedAgent(text: string, agentId: string): boolean {
  const normalized = String(text || '').toLowerCase()
  const aliases = [agentId, AGENT_NAMES[agentId]].filter(Boolean).map((value) => String(value).toLowerCase())
  return aliases.some((alias) => normalized.includes(`@${alias}`))
}

export function prepareAgentDispatch(input: {
  operatorId: string
  boardId: string
  task: Task
  agentId: string
  text: string
  trigger: AgentDispatchTrigger
  continuationDepth?: number
  eventId?: string
  queuedAt?: string
}): { task: Task; dispatch: AgentDispatchEnqueueInput } {
  const dispatchId = crypto.randomUUID()
  const queuedAt = input.queuedAt || new Date().toISOString()
  const eventId = String(input.eventId || dispatchId)
  const dispatch: AgentDispatchEnqueueInput = {
    dispatchId,
    idempotencyKey: `agent:${input.boardId}:${input.task.id}:${input.trigger}:${eventId}`,
    operatorId: input.operatorId,
    boardId: input.boardId,
    taskId: String(input.task.id),
    agentId: input.agentId,
    text: input.text,
    trigger: input.trigger,
    continuationDepth: input.continuationDepth || 0,
    queuedAt,
  }
  const label = DISPATCH_TRIGGER_LABELS[input.trigger]
  const nextTask: Task = {
    ...input.task,
    execution: {
      ...(input.task.execution || {}),
      assignedAgent: input.agentId,
      assignedAt: input.trigger === 'assignment' ? queuedAt : input.task.execution?.assignedAt,
      executionStatus: 'queued',
      lastUpdatedAt: queuedAt,
      latestExecutionNote: `Agent run queued from ${label}.`,
      agentDispatch: {
        id: dispatchId,
        trigger: input.trigger,
        status: 'queued',
        attempts: 0,
        continuationDepth: input.continuationDepth || 0,
        queuedAt,
        updatedAt: queuedAt,
      },
    },
    activity: [
      ...(input.task.activity || []),
      {
        type: 'updated',
        message: `Agent ${input.agentId} run queued from ${label}.`,
        timestamp: queuedAt,
        actor: input.operatorId,
        taskId: input.task.id,
        taskTitle: input.task.title,
      },
    ],
    updatedAt: queuedAt,
  }
  return { task: nextTask, dispatch }
}
