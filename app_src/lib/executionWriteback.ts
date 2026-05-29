import type { Task } from '@/lib/types'

export type ExecutionCommentInput = {
  agentId: string
  executionStatus: string
  summary?: string
  directAnswer?: string
  whatWasDone?: string
  currentState?: string
  nextStep?: string
  taskAgeDays?: number
  blockedReason?: string
  blockerClarification?: string
  suggestedNextAction?: string
  improvementRecommendation?: string
}

const DISALLOWED_PHRASES = [
  'summarized context',
  'extracted assumptions',
  'made progress',
  'prepared next step',
  'looked into',
  'reviewed',
  'investigated',
]

function sanitizeFluff(text: string): string {
  let out = String(text || '').trim()
  for (const phrase of DISALLOWED_PHRASES) {
    const re = new RegExp(phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'ig')
    out = out.replace(re, 'executed concrete work')
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function buildExecutionCommentText(input: ExecutionCommentInput) {
  const lines: string[] = []
  const changed = sanitizeFluff(input.whatWasDone || input.summary || 'Executed one concrete task step and captured the output.')
  const remaining = sanitizeFluff(input.currentState || `Task status is ${input.executionStatus}.`)
  const waitingOn = sanitizeFluff(input.blockedReason || input.blockerClarification || input.nextStep || input.suggestedNextAction || 'none')

  lines.push(`Agent: ${input.agentId}`)
  lines.push(`Status: ${input.executionStatus}`)
  lines.push('')
  lines.push(`Changed: ${changed}`)
  lines.push(`Remaining: ${remaining}`)
  lines.push(`Waiting on: ${waitingOn}`)

  if ((input.taskAgeDays ?? 0) >= 3) {
    lines.push(`Remaining: Task has been in progress for ${input.taskAgeDays} days; prioritize closure or re-scope explicitly.`)
  }

  if (input.improvementRecommendation) lines.push(`Changed: Improvement applied: ${sanitizeFluff(input.improvementRecommendation)}`)
  return lines.join('\n')
}

export function buildExecutionCommentActivity(task: Task, agentId: string, commentId: string, timestamp: string): Task['activity'][number] {
  return {
    type: 'comment',
    message: `Agent ${agentId} posted execution summary.`,
    timestamp,
    actor: agentId,
    taskId: task.id,
    taskTitle: task.title,
    commentId,
  }
}

export function buildAssignmentCommentText(agentId: string, assignedAt: string, executionStatus: string) {
  return [
    `Agent: ${agentId}`,
    `Assigned: ${assignedAt}`,
    `Execution status: ${executionStatus}`,
  ].join('\n')
}

export function buildAssignmentActivity(task: Task, agentId: string, commentId: string, timestamp: string): Task['activity'][number] {
  return {
    type: 'comment',
    message: `Agent ${agentId} claimed this task.`,
    timestamp,
    actor: agentId,
    taskId: task.id,
    taskTitle: task.title,
    commentId,
  }
}
