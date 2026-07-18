import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { prepareAgentDispatch } from '@/lib/agents/dispatch'
import { agentInstructions, getAgentRuntimeForOperator, runChatGPTAgent, runOpenAIAgent } from '@/lib/agents/provider'
import { detectPromptInjectionIndicators, serializePromptSection } from '@/lib/agents/promptSecurity'
import {
  captureAgentLearning,
  formatAgentContextMemories,
  readAgentContextMemories,
} from '@/lib/agents/contextMemory'
import { resolveResponderId } from '@/lib/agents/responder.mjs'
import { getThread as getFileThread, listThreads as listFileThreads, upsertThreadMessage as upsertFileThreadMessage } from '@/lib/agents/threadStore.mjs'
import { normalizeProductAgentId, resolveExecutionAgentForControlAgent } from '@/lib/agents/routing'
import {
  applyAgentTaskExecutionPlanForDispatch,
  formatAgentTaskExecutionResult,
  parseAgentTaskExecutionPlan,
  restorePersistedAgentTaskExecutionOutcome,
  type AgentTaskExecutionEvidence,
  type AgentTaskExecutionPlan,
} from '@/lib/agents/taskExecution'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import {
  appendAgentTaskDocument,
  readAgentTaskDocumentContext,
  type AgentTaskDocumentReference,
} from '@/lib/documents'
import { withFileLock } from '@/lib/fileLock'
import type { Comment, Task } from '@/lib/types'
import { buildCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { isOpenClawExecutionEnabled, shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { getThreadFromPostgres, listThreadsFromPostgres, upsertThreadMessageInPostgres } from '@/lib/persistence/agentThreads'
import { appendExecutionResultToPostgres, appendExecutionRunToPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'
import { isAgentDispatchConflictError, type AgentDispatchEnqueueInput } from '@/lib/persistence/agentDispatch'
import {
  enqueueAgentResearchInPostgres,
  readAgentResearchEvidenceFromPostgres,
} from '@/lib/persistence/agentResearch'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'
import { resolveAgentDispatchWorker, type AgentDispatchWorkerContext } from '@/lib/workerAuth'
import {
  BOARD_SELECTION_COOKIE,
  requireResourceEditor,
  resolveProjectBoardAccess,
  type ProjectBoard,
} from '@/lib/tenancy'

const SECOND_BRAIN = process.env.SECOND_BRAIN_PATH || '/Users/agentsuburbiasandwich/.openclaw/workspace/second-brain'
const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)

function readTasksFromFile(): Task[] {
  try {
    const value = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

async function readTasks(boardId?: string): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      return (await readTasksFromPostgres({ boardId })).filter((task) => !isCrmBoardCard(task))
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres task read failed; falling back to file store', error)
    }
  }
  return readTasksFromFile().filter((task) => !isCrmBoardCard(task))
}

async function writeTasks(tasks: Task[], boardId?: string, agentDispatches: AgentDispatchEnqueueInput[] = []) {
  const canonical = canonicalizeTasks(tasks)
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      await replaceTasksInPostgres(canonical, { boardId, agentDispatches })
      return
    } catch (error) {
      if (agentDispatches.length > 0 || isAgentDispatchConflictError(error)) throw error
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres task write failed; falling back to file store', error)
    }
  }

  await withFileLock(`${TASKS_FILE}.lock`, () => {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(canonical, null, 2))
  })
}

async function listPersistedThreads(operatorId: string) {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await listThreadsFromPostgres({ operatorId })
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres thread list failed; falling back to file store', error)
    }
  }
  return listFileThreads()
}

async function getPersistedThread(input: { operatorId: string; agentId: string; taskId: string }) {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await getThreadFromPostgres(input)
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres thread read failed; falling back to file store', error)
    }
  }
  return getFileThread(input)
}

async function upsertPersistedThreadMessage(input: Parameters<typeof upsertThreadMessageInPostgres>[0]) {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await upsertThreadMessageInPostgres(input)
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres thread write failed; falling back to file store', error)
    }
  }
  return upsertFileThreadMessage({
    messageId: input.messageId,
    agentId: input.agentId,
    text: input.text,
    role: input.role,
    taskId: input.taskId || '',
    status: input.status || '',
    tags: input.tags || [],
    routing: input.routing || {},
    meta: input.meta || {},
  })
}

async function resolveOperator(req: NextRequest, allowWorker = false): Promise<{
  operatorId: string
  actor: AppUser
  worker: AgentDispatchWorkerContext | null
} | null> {
  try {
    const worker = allowWorker ? await resolveAgentDispatchWorker(req) : null
    if (worker) return { operatorId: worker.operatorId, actor: worker.actor, worker }
    const actor = await requireRequestUser(req)
    return { operatorId: actor.email, actor, worker: null }
  } catch {
    return null
  }
}

async function resolveAgentBoard(
  req: NextRequest,
  actor: AppUser,
  requireEdit = false,
  worker?: AgentDispatchWorkerContext | null,
): Promise<ProjectBoard | null> {
  if (!isPostgresTaskStoreEnabled()) return null
  const selected = worker?.boardId || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  let board: ProjectBoard
  try {
    board = await resolveProjectBoardAccess({ actorEmail: actor, boardId: selected })
  } catch (error) {
    if (worker?.boardId) throw error
    board = await resolveProjectBoardAccess({ actorEmail: actor })
  }
  if (requireEdit) requireResourceEditor(board)
  return board
}

function deriveNextAction(summary: string): string {
  const lines = String(summary || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
  const explicit = lines.find((line) => /^remaining\s*:/i.test(line) || /^next (action|step)\s*:/i.test(line))
  const explicitValue = explicit?.replace(/^[^:]+:/, '').trim()
  if (explicitValue) return explicitValue

  const remainingIndex = lines.findIndex((line) => /^remaining\s*:?$/i.test(line))
  const firstRemaining = remainingIndex >= 0
    ? lines.slice(remainingIndex + 1).find((line) => /^[-*]\s+\S/.test(line))
    : undefined
  return firstRemaining?.replace(/^[-*]\s+/, '').trim() || 'Review the agent result and choose the next concrete step.'
}

function publicAgentProviderError(error: unknown, taskExecution: boolean): {
  message: string
  connectionRejected: boolean
} {
  const record = error && typeof error === 'object' ? error as { name?: unknown; status?: unknown } : {}
  const raw = error instanceof Error ? error.message : String(error || '')
  const status = Number(record.status || 0)
  if (String(record.name || '') === 'AbortError' || /aborted|timed?\s*out/i.test(raw)) {
    return { message: 'The agent provider timed out. Try the request again.', connectionRejected: false }
  }
  if (status === 401 || status === 403 || /api\s*key|access\s*token|bearer|credential|authorization|sk-[a-z0-9_-]+/i.test(raw)) {
    return {
      message: 'The agent connection was rejected. Reconnect ChatGPT or update the provider credential in Settings.',
      connectionRejected: true,
    }
  }
  if (status === 429 || /rate\s*limit|too many requests/i.test(raw)) {
    return { message: 'The agent provider is temporarily rate limited. Try again shortly.', connectionRejected: false }
  }
  return {
    message: taskExecution
      ? 'Agent execution failed before evidence could be recorded. Try again or review the provider connection.'
      : 'The agent could not respond. Try again or review the provider connection.',
    connectionRejected: false,
  }
}

function conciseAgentSummary(value: string) {
  const firstContentLine = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:summary|changed)\s*:\s*/i, '').trim())
    .find(Boolean)
  return String(firstContentLine || 'Agent work was recorded.').replace(/\s+/g, ' ').slice(0, 320)
}

function formatAgentDocumentComment(input: {
  agentId: string
  status: string
  summary: string
  changes: string[]
  nextAction: string
  waitingOn: string
  document: AgentTaskDocumentReference
}) {
  return [
    `Agent: ${input.agentId}`,
    `Status: ${input.status}`,
    '',
    `${input.document.created ? 'Created' : 'Updated'} document: [${input.document.title}](${input.document.url})`,
    `Summary: ${conciseAgentSummary(input.summary)}`,
    `Changed: ${input.changes.length > 0 ? input.changes.join('; ') : 'Working document updated'}`,
    `Remaining: ${input.nextAction}`,
    `Waiting on: ${input.waitingOn || 'none'}`,
  ].join('\n')
}

async function restorePersistedDispatchOutcome(input: {
  taskId: string
  agentId: string
  dispatchId: string
  boardId?: string
}) {
  const tasks = await readTasks(input.boardId)
  const index = tasks.findIndex((task) => String(task.id) === input.taskId)
  if (index === -1) return null

  const restored = restorePersistedAgentTaskExecutionOutcome({
    task: tasks[index],
    agentId: input.agentId,
    dispatchId: input.dispatchId,
    timestamp: new Date().toISOString(),
  })
  if (!restored) return null

  tasks[index] = restored.task
  await writeTasks(tasks, input.boardId)
  return restored
}

async function recordAgentResult(input: {
  taskId: string
  agentId: string
  operatorId: string
  organizationId: string
  summary: string
  boardId?: string
  dispatchId?: string
  dispatchContinuationDepth?: number
  plan?: AgentTaskExecutionPlan
}): Promise<{ evidence: AgentTaskExecutionEvidence | null; summary: string; applied: boolean; continuationQueued: boolean }> {
  const { taskId, agentId, operatorId, organizationId, summary, boardId, dispatchId, plan } = input
  const tasks = await readTasks(boardId)
  const index = tasks.findIndex((task) => String(task.id) === taskId)
  if (index === -1) return { evidence: null, summary, applied: false, continuationQueued: false }

  const now = new Date().toISOString()
  let task = tasks[index]
  let evidence: AgentTaskExecutionEvidence | null = null
  let resultSummary = summary
  let planApplied = true
  if (plan) {
    if (!dispatchId) throw new Error('Task execution plan requires a dispatch ID')
    const applied = applyAgentTaskExecutionPlanForDispatch({ task, plan, agentId, dispatchId, timestamp: now })
    task = applied.task
    evidence = applied.evidence
    planApplied = applied.applied
    resultSummary = formatAgentTaskExecutionResult(agentId, evidence)
    if (!planApplied) return { evidence, summary: resultSummary, applied: false, continuationQueued: false }
  }
  const nextAction = evidence?.nextAction || deriveNextAction(resultSummary)
  const commentId = dispatchId ? `agent-dispatch-${dispatchId}` : Date.now().toString()
  const continuationDepth = Math.max(0, Math.trunc(Number(input.dispatchContinuationDepth) || 0))
  const progressedChecklist = Boolean(evidence?.completedChecklistIds.length)
    || Boolean(evidence?.changes.some((change) => /checklist item.*added/i.test(change)))
  const correctiveContinuation = continuationDepth === 0
    && !progressedChecklist
    && Boolean(evidence?.deliverable.trim())
  const nextChecklistItem = task.checklist.find((item) => !item.done)
  const shouldQueueContinuation = Boolean(
    boardId
    && dispatchId
    && planApplied
    && evidence?.status === 'running'
    && !evidence?.researchQuery
    && (progressedChecklist || correctiveContinuation)
    && nextChecklistItem
    && continuationDepth < 8
    && isPostgresTaskStoreEnabled(),
  )
  const researchPending = Boolean(evidence?.researchQuery)
  const substantiveDeliverable = evidence?.deliverable
    || (agentId === 'projects' && !researchPending && resultSummary.trim() ? resultSummary : '')
    || (!plan && (resultSummary.length >= 600 || resultSummary.split(/\r?\n/).length >= 10) ? resultSummary : '')
  let document: AgentTaskDocumentReference | null = null
  if (boardId && substantiveDeliverable && isPostgresTaskStoreEnabled()) {
    try {
      document = await appendAgentTaskDocument({
        ownerEmail: operatorId,
        organizationId,
        boardId,
        taskId,
        taskTitle: task.title,
        agentId,
        resultId: dispatchId || commentId,
        status: evidence?.status || 'responded',
        summary: evidence?.summary || conciseAgentSummary(resultSummary),
        deliverable: substantiveDeliverable,
        changes: evidence?.changes || [],
        nextAction,
        waitingOn: evidence?.blocker || evidence?.waitingOn || '',
        recordedAt: now,
      })
      const lastResult = task.execution?.lastResult
      task = {
        ...task,
        execution: {
          ...(task.execution || {}),
          lastResult: lastResult && typeof lastResult === 'object' && !Array.isArray(lastResult)
            ? { ...lastResult, document }
            : lastResult,
        },
      }
    } catch (error) {
      console.error('[agent-threads] task document write failed; preserving full card comment', error)
    }
  }
  const comment: Comment = {
    id: commentId,
    text: document
      ? formatAgentDocumentComment({
          agentId,
          status: evidence?.status || 'responded',
          summary: evidence?.summary || resultSummary,
          changes: evidence?.changes || [],
          nextAction,
          waitingOn: evidence?.blocker || evidence?.waitingOn || '',
          document,
        })
      : /^Agent\s*:/i.test(resultSummary) ? resultSummary : `Agent: ${agentId}\n\n${resultSummary}`,
    createdAt: now,
    timestamp: now,
    author: agentId,
  }
  const existingCommentIndex = (task.comments || []).findIndex((entry) => entry.id === commentId)
  const comments = shouldQueueContinuation || researchPending
    ? task.comments || []
    : existingCommentIndex >= 0
      ? (task.comments || []).map((entry, entryIndex) => entryIndex === existingCommentIndex ? comment : entry)
      : [...(task.comments || []), comment]
  const currentDispatch = task.execution?.agentDispatch
  const updatesCurrentDispatch = !dispatchId || !currentDispatch || currentDispatch.id === dispatchId
  const execution = updatesCurrentDispatch
    ? {
        ...(task.execution || {}),
        executionStatus: evidence?.status || 'responded',
        lastUpdatedAt: now,
        latestExecutionNote: resultSummary,
        lastResult: evidence ? task.execution?.lastResult : {
          type: 'agent-thread-response',
          agentId,
          summary: resultSummary,
          nextAction,
          evidence: [],
          recordedAt: now,
        },
        agentDispatch: dispatchId
          ? {
              id: dispatchId,
              trigger: currentDispatch?.trigger || 'assignment' as const,
              status: 'succeeded' as const,
              attempts: currentDispatch?.attempts || 1,
              queuedAt: currentDispatch?.queuedAt || now,
              updatedAt: now,
            }
          : currentDispatch,
      }
    : task.execution
  const activityAlreadyRecorded = (task.activity || []).some((entry) => entry.commentId === commentId)
  tasks[index] = {
    ...task,
    comments,
    activity: shouldQueueContinuation || researchPending || activityAlreadyRecorded
      ? task.activity
      : [
          ...(task.activity || []),
          {
            type: 'comment',
            message: evidence
              ? `Agent ${agentId} posted an evidence-backed task result.`
              : `Agent ${agentId} posted a task response.`,
            timestamp: now,
            actor: agentId,
            taskId: task.id,
            taskTitle: task.title,
            commentId,
          },
        ],
    execution,
    updatedAt: now,
  }

  const dispatches: AgentDispatchEnqueueInput[] = []
  if (shouldQueueContinuation && boardId && dispatchId && nextChecklistItem) {
    const prepared = prepareAgentDispatch({
      operatorId,
      boardId,
      task: tasks[index],
      agentId,
      trigger: 'continuation',
      continuationDepth: continuationDepth + 1,
      eventId: dispatchId,
      queuedAt: now,
      text: `Continue autonomous execution. Produce the actual deliverable for the next unchecked checklist item, complete only that evidenced item, and stop for one specific operator decision if required. Next checklist item ID: ${nextChecklistItem.id}. Next checklist item text: ${nextChecklistItem.text}. When the deliverable fully supports this item, checklistComplete must be exactly ["${nextChecklistItem.id}"]. Otherwise leave checklistComplete empty and use awaiting_input or blocked with one specific reason.`,
    })
    tasks[index] = prepared.task
    dispatches.push(prepared.dispatch)
  }

  await writeTasks(tasks, boardId, dispatches)
  return {
    evidence,
    summary: resultSummary,
    applied: planApplied,
    continuationQueued: dispatches.length > 0,
  }
}

async function recordExecutionTelemetry(entry: Record<string, unknown>, includeResult = false) {
  if (!isPostgresExecutionStoreEnabled()) return
  try {
    await appendExecutionRunToPostgres(entry)
    if (includeResult) await appendExecutionResultToPostgres({ ...entry, resultType: 'agent-thread-result' })
  } catch (error) {
    console.error('[agent-threads] execution telemetry write failed', error)
  }
}

async function writeDocsLog(agentId: string, text: string) {
  if (agentId !== 'docs' || !isOpenClawExecutionEnabled()) return
  try {
    const dir = path.join(SECOND_BRAIN, 'clawpilot')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'docs-agent-log.md'), `\n\n## ${new Date().toISOString()}\n${text}\n`)
  } catch {
    // The task comment remains the durable writeback when the local notes path is unavailable.
  }
}

async function runOpenClawAgent(agentId: string, message: string): Promise<string> {
  if (!isOpenClawExecutionEnabled()) throw new Error('OpenClaw execution is disabled')
  const args = ['agent', '--agent', agentId, '--message', message, '--json', '--timeout', '120']
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('openclaw', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    let out = ''
    let err = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('OpenClaw agent timeout'))
    }, 130_000)

    child.stdout.on('data', (chunk) => { out += String(chunk) })
    child.stderr.on('data', (chunk) => { err += String(chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) resolve(out)
      else reject(new Error(`OpenClaw exited with code ${code}${err ? `: ${err.trim()}` : ''}`))
    })
  })

  const trimmed = stdout.trim()
  if (!trimmed) throw new Error('OpenClaw returned an empty response')
  try {
    const parsed = JSON.parse(trimmed)
    const reply = parsed?.reply || parsed?.message || parsed?.result || parsed
    const payloadText = Array.isArray(reply?.payloads) ? reply.payloads[0]?.text : undefined
    return String(typeof reply === 'string' ? reply : (reply?.text || payloadText || '')).trim()
  } catch {
    return trimmed
  }
}

function boundedContextText(value: unknown, limit: number): string {
  const text = String(value || '').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 14)).trimEnd()}\n[truncated]`
}

function formatPriorTaskExecution(task: Task): string {
  const result = task.execution?.lastResult
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ''
  const record = result as Record<string, unknown>
  const document = record.document && typeof record.document === 'object' && !Array.isArray(record.document)
    ? record.document as Record<string, unknown>
    : null
  const documentTitle = boundedContextText(document?.title, 240).replace(/\s+/g, ' ')
  const documentTarget = boundedContextText(document?.url || document?.id, 700).replace(/\s+/g, ' ')
  const documentReference = documentTitle || documentTarget
    ? `${documentTitle || 'Task deliverable'}${documentTarget ? ` (${documentTarget})` : ''}`
    : ''
  const context = [
    record.status ? `Status: ${boundedContextText(record.status, 80)}` : null,
    record.summary ? `Summary: ${boundedContextText(record.summary, 800)}` : null,
    record.deliverable ? `Deliverable:\n${boundedContextText(record.deliverable, 3_500)}` : null,
    documentReference ? `Document: ${documentReference}` : null,
  ].filter(Boolean).join('\n')
  return boundedContextText(context, 5_000)
}

function buildTaskContext(
  task: Task,
  agentId: string,
  durableContext?: string | null,
  taskDocumentContext?: string | null,
  researchEvidence?: unknown,
): string {
  const nextAction = String(task.workItem?.nextAction || '').trim()
  const recentComments = (task.comments || [])
    .filter((comment) => !comment.deletedAt)
    .slice(-12)
    .map((comment) => ({ author: comment.author, text: comment.text }))
  const recentActivity = (task.activity || [])
    .slice(-12)
    .map((entry) => ({ timestamp: entry.timestamp, actor: entry.actor, message: entry.message }))
  const priorExecution = formatPriorTaskExecution(task)
  const taskScope = {
    title: task.title,
    description: task.desc || null,
    outcome: task.outcomeStatement || null,
    status: task.status,
    priority: task.priority,
    category: task.category || null,
    tags: task.tags || [],
    dueDate: task.dueDate || null,
    assignedAgent: agentId,
    nextAction: nextAction || null,
    checklist: (task.checklist || []).map((item) => ({
      id: item.id,
      text: item.text,
      done: Boolean(item.done),
    })),
  }
  const referenceData = {
    priorExecution: priorExecution || null,
    recentComments,
    recentActivity,
    taskDocument: taskDocumentContext ? boundedContextText(taskDocumentContext, 12_000) : null,
    durableAgentContext: durableContext || null,
    researchEvidence: researchEvidence || null,
  }
  return [
    serializePromptSection('AUTHORIZED_TASK_SCOPE', 'authorized-business-scope', taskScope),
    serializePromptSection('REFERENCE_DATA', 'untrusted-reference-data', referenceData),
  ].join('\n\n')
}

function assignmentError(task: Task, agentId: string): string | null {
  const assignedAgent = normalizeProductAgentId(task.assignedAgent)
  if (!assignedAgent) return 'Assign this task to an agent before opening its thread.'
  if (assignedAgent !== agentId) return `This task is assigned to ${assignedAgent}. Reassign it before using ${agentId}.`
  return null
}

export async function GET(req: NextRequest) {
  const resolved = await resolveOperator(req)
  if (!resolved) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const { operatorId, actor } = resolved
  let board: ProjectBoard | null
  try {
    board = await resolveAgentBoard(req, actor)
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Board access denied' }, { status: 403 })
  }
  const { searchParams } = new URL(req.url)
  const requestedAgentId = String(searchParams.get('agentId') || '')
  if (!requestedAgentId) {
    const taskIds = new Set((await readTasks(board?.id)).map((task) => String(task.id)))
    const collection = await listPersistedThreads(operatorId) as { threads?: Array<{ taskId?: string }> }
    return NextResponse.json({
      ...collection,
      threads: (collection.threads || []).filter((thread) => taskIds.has(String(thread.taskId || ''))),
    })
  }

  const agentId = normalizeProductAgentId(requestedAgentId)
  const taskId = String(searchParams.get('taskId') || '').trim()
  if (!agentId) return NextResponse.json({ ok: false, error: 'invalid product agent' }, { status: 400 })
  if (!taskId) return NextResponse.json({ ok: false, error: 'taskId required' }, { status: 400 })

  const task = (await readTasks(board?.id)).find((entry) => String(entry.id) === taskId)
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  const mismatch = assignmentError(task, agentId)
  if (mismatch) return NextResponse.json({ ok: false, error: mismatch }, { status: 409 })

  const thread = await getPersistedThread({ operatorId, agentId, taskId })
  const runtime = await getAgentRuntimeForOperator(operatorId)
  return NextResponse.json({
    ...(thread || {
      threadId: `thread_${agentId}_${taskId}`,
      agentId,
      createdAt: null,
      updatedAt: null,
      lastMessageAt: null,
      taskId,
      status: 'active',
      tags: [],
      routing: { responder: resolveResponderId(agentId), channel: 'internal', priority: 'normal' },
      context: { summary: null, lastUserMessageId: null, messageCount: 0, tokenEstimate: 0 },
      messages: [],
    }),
    canonicalWorkItem: buildCanonicalWorkItem(task),
    runtime,
  })
}

export async function POST(req: NextRequest) {
  const resolved = await resolveOperator(req, true)
  if (!resolved) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const { operatorId, actor, worker } = resolved
  let board: ProjectBoard | null
  try {
    board = await resolveAgentBoard(req, actor, true, worker)
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Board edit access denied' }, { status: 403 })
  }
  const body = await req.json()
  const agentId = normalizeProductAgentId(String(body?.agentId || ''))
  const text = String(body?.text || '').trim()
  const taskId = String(body?.taskId || '').trim()
  const tags = Array.isArray(body?.tags) ? body.tags.map(String) : undefined
  const requestedMode = String(body?.mode || '').trim().toLowerCase()
  if (!worker && requestedMode && requestedMode !== 'discuss' && requestedMode !== 'work') {
    return NextResponse.json({ ok: false, error: 'mode must be discuss or work' }, { status: 400 })
  }
  const signedUserMode: 'discuss' | 'work' | null = worker
    ? null
    : requestedMode === 'work' ? 'work' : 'discuss'
  const requestedClientMessageId = String(body?.clientMessageId || '').trim()
  const clientMessageId = !worker && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedClientMessageId)
    ? requestedClientMessageId.toLowerCase()
    : undefined
  const requestedDispatchId = String(body?.dispatchId || '').trim()
  if (requestedDispatchId && !worker) {
    return NextResponse.json({ ok: false, error: 'Agent dispatch metadata requires worker authorization' }, { status: 403 })
  }
  const dispatchId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDispatchId)
    ? requestedDispatchId.toLowerCase()
    : undefined
  const dispatchAttempt = Math.max(0, Math.trunc(Number(body?.dispatchAttempt) || 0))
  const dispatchContinuationDepth = Math.max(0, Math.min(Math.trunc(Number(body?.dispatchContinuationDepth) || 0), 8))
  const isTaskExecution = Boolean(worker && dispatchId)
  const messageSource = dispatchId ? 'dispatch' : 'api'
  if (!agentId || !text || !taskId) {
    return NextResponse.json({ ok: false, error: 'valid agentId, taskId and text required' }, { status: 400 })
  }

  const tasks = await readTasks(board?.id)
  const taskIndex = tasks.findIndex((entry) => String(entry.id) === taskId)
  if (taskIndex === -1) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  const task = tasks[taskIndex]
  const mismatch = assignmentError(task, agentId)
  if (mismatch) return NextResponse.json({ ok: false, error: mismatch }, { status: 409 })

  const executionAgentId = resolveExecutionAgentForControlAgent(agentId)
  if (!executionAgentId) return NextResponse.json({ ok: false, error: 'execution route missing for product agent' }, { status: 400 })
  const [runtime, beforeThread] = await Promise.all([
    getAgentRuntimeForOperator(operatorId),
    getPersistedThread({ operatorId, agentId, taskId }),
  ])
  const responderId = runtime.provider === 'openclaw' ? resolveResponderId(executionAgentId) : agentId
  const routing = { responder: responderId, channel: 'internal', priority: 'normal' }
  const requestMessageId = dispatchId
    ? `agent-dispatch-${dispatchId}-request`
    : clientMessageId ? `agent-discuss-${clientMessageId}-request` : undefined
  const resultMessageId = dispatchId
    ? `agent-dispatch-${dispatchId}-result`
    : clientMessageId ? `agent-discuss-${clientMessageId}-result` : undefined
  const beforeMessages = (Array.isArray(beforeThread?.messages) ? beforeThread.messages : []) as Array<{
    id: string
    role: string
    text: string
    meta?: Record<string, unknown>
  }>
  const existingRequest = requestMessageId
    ? beforeMessages.find((message) => message.id === requestMessageId) || null
    : null
  const existingResponse = resultMessageId
    ? beforeMessages.find((message) => message.id === resultMessageId)
    : null
  if (existingResponse) {
    const restored = dispatchId
      ? await restorePersistedDispatchOutcome({ taskId, agentId, dispatchId, boardId: board?.id })
      : null
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      thread: beforeThread,
      userMessage: beforeMessages.find((message) => message.id === requestMessageId) || null,
      agentMessage: existingResponse,
      runtime,
      canonicalWorkItem: buildCanonicalWorkItem(restored?.task || task),
    })
  }
  if (clientMessageId && existingRequest) {
    return NextResponse.json({
      ok: true,
      pending: true,
      deduplicated: true,
      thread: beforeThread,
      userMessage: existingRequest,
      agentMessage: null,
      runtime,
      canonicalWorkItem: buildCanonicalWorkItem(task),
    }, { status: 202 })
  }

  const resultCommentId = dispatchId ? `agent-dispatch-${dispatchId}` : ''
  const existingResultComment = resultCommentId
    ? (task.comments || []).find((comment) => comment.id === resultCommentId)
    : null
  if (existingResultComment) {
    const restored = dispatchId
      ? await restorePersistedDispatchOutcome({ taskId, agentId, dispatchId, boardId: board?.id })
      : null
    const recoveredText = existingResultComment.text.replace(/^Agent:\s*[^\n]+\n\n/i, '').trim()
    const responseText = restored?.summary || recoveredText || existingResultComment.text
    const executionStatus = restored?.evidence.status || 'responded'
    await upsertPersistedThreadMessage({
      messageId: resultMessageId,
      operatorId,
      agentId,
      text: responseText,
      role: 'agent',
      taskId,
      status: executionStatus === 'blocked' || executionStatus === 'awaiting_input' ? 'blocked' : 'active',
      tags,
      routing,
      meta: {
        source: messageSource,
        phase: 'response',
        dispatchId,
        recovered: true,
        responder: responderId,
        executionAgentId,
        provider: runtime.provider,
        executionStatus,
        evidence: restored?.evidence.changes || [],
      },
    })
    const recoveredThread = await getPersistedThread({ operatorId, agentId, taskId })
    const recoveredMessages = (Array.isArray(recoveredThread?.messages) ? recoveredThread.messages : []) as Array<{
      id: string
      role: string
      text: string
    }>
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      recovered: true,
      thread: recoveredThread,
      userMessage: recoveredMessages.find((message) => message.id === requestMessageId) || null,
      agentMessage: recoveredMessages.find((message) => message.id === resultMessageId) || null,
      runtime,
      canonicalWorkItem: buildCanonicalWorkItem(restored?.task || task),
    })
  }

  if (!runtime.ready) return NextResponse.json({ ok: false, error: runtime.label, runtime }, { status: 503 })

  if (signedUserMode === 'work') {
    if (!board?.id || !isPostgresTaskStoreEnabled()) {
      return NextResponse.json({
        ok: false,
        error: 'Durable agent work requires Postgres task storage.',
        runtime,
      }, { status: 503 })
    }
    const activeDispatch = task.execution?.agentDispatch
    if (activeDispatch?.status === 'queued' || activeDispatch?.status === 'running') {
      return NextResponse.json({
        ok: false,
        error: 'An agent work run is already queued or running for this task.',
        runtime,
        canonicalWorkItem: buildCanonicalWorkItem(task),
      }, { status: 409 })
    }

    const queuedAt = new Date().toISOString()
    const prepared = prepareAgentDispatch({
      operatorId,
      boardId: board.id,
      task,
      agentId,
      text,
      trigger: 'manual',
      queuedAt,
    })
    tasks[taskIndex] = prepared.task
    try {
      await writeTasks(tasks, board.id, [prepared.dispatch])
    } catch (error) {
      if (!isAgentDispatchConflictError(error)) throw error
      const currentTask = (await readTasks(board.id)).find((entry) => String(entry.id) === taskId)
      return NextResponse.json({
        ok: false,
        error: error.message,
        runtime,
        canonicalWorkItem: currentTask ? buildCanonicalWorkItem(currentTask) : null,
      }, { status: 409 })
    }

    const manualDispatchId = prepared.dispatch.dispatchId
    const manualRequestMessageId = `agent-dispatch-${manualDispatchId}-request`
    const workTags = Array.from(new Set([...(tags || []), 'agent-dispatch', 'manual']))
    let queuedThread = beforeThread
    try {
      await upsertPersistedThreadMessage({
        messageId: manualRequestMessageId,
        operatorId,
        agentId,
        text,
        role: 'user',
        taskId,
        status: 'resolving',
        tags: workTags,
        routing,
        meta: {
          source: 'dispatch',
          phase: 'request',
          mode: 'work',
          trigger: 'manual',
          dispatchId: manualDispatchId,
          dispatchAttempt: 0,
          executionAgentId,
          provider: runtime.provider,
        },
      })
      queuedThread = await getPersistedThread({ operatorId, agentId, taskId })
    } catch (error) {
      // The worker recreates this deterministic request message before execution.
      console.error('[agent-threads] queued work thread write failed', error)
    }
    let refreshedTask = prepared.task
    try {
      refreshedTask = (await readTasks(board.id)).find((entry) => String(entry.id) === taskId) || prepared.task
    } catch (error) {
      console.error('[agent-threads] queued work task refresh failed', error)
    }
    const queuedMessages = (Array.isArray(queuedThread?.messages) ? queuedThread.messages : []) as Array<{ id: string }>
    return NextResponse.json({
      ok: true,
      queued: true,
      dispatchId: manualDispatchId,
      thread: queuedThread,
      userMessage: queuedMessages.find((message) => message.id === manualRequestMessageId) || null,
      agentMessage: null,
      runtime,
      canonicalWorkItem: buildCanonicalWorkItem(refreshedTask),
    })
  }

  const runId = dispatchId || clientMessageId || crypto.randomUUID()
  const startedAt = new Date().toISOString()

  let afterUser = beforeThread
  if (!existingRequest) {
    await upsertPersistedThreadMessage({
      messageId: requestMessageId,
      operatorId,
      agentId,
      text,
      role: 'user',
      taskId,
      status: 'resolving',
      tags,
      routing,
      meta: {
        source: messageSource,
        phase: 'request',
        mode: isTaskExecution ? 'task-execution' : 'discuss',
        dispatchId,
        dispatchAttempt,
        executionAgentId,
        provider: runtime.provider,
      },
    })
    afterUser = await getPersistedThread({ operatorId, agentId, taskId })
  }
  const messages = (Array.isArray(afterUser?.messages) ? afterUser.messages : []) as Array<{
    id: string
    role: string
    text: string
    meta?: Record<string, unknown>
  }>
  const userMessage = requestMessageId
    ? messages.find((message) => message.id === requestMessageId) || null
    : messages[messages.length - 1] || null
  const conversation = messages
    .filter((message) => dispatchId ? message.meta?.dispatchId !== dispatchId : message.id !== userMessage?.id)
    .map((message) => ({ role: message.role, text: message.text }))
  let durableAgentContext: string | null = null
  let taskDocumentContext: string | null = null
  let researchEvidenceContext: unknown = null
  if (isPostgresTaskStoreEnabled()) {
    try {
      durableAgentContext = formatAgentContextMemories(await readAgentContextMemories({
        operatorId,
        organizationId: board!.workspaceOrganizationId,
        agentId,
      }))
    } catch (error) {
      console.error('[agent-threads] durable context read failed', error)
    }
    try {
      taskDocumentContext = await readAgentTaskDocumentContext({
        ownerEmail: operatorId,
        organizationId: board!.workspaceOrganizationId,
        taskId,
        agentId,
      })
    } catch (error) {
      console.error('[agent-threads] task document context read failed', error)
    }
    try {
      const evidence = await readAgentResearchEvidenceFromPostgres({
        operatorId,
        boardId: board!.id,
        taskId,
        agentId,
        limit: 3,
      })
      researchEvidenceContext = evidence.map((item) => ({
        query: item.query,
        result: boundedContextText(item.resultText, 12_000),
        citations: item.citations,
        retrievedAt: item.createdAt,
      }))
    } catch (error) {
      console.error('[agent-threads] public research evidence read failed', error)
    }
  }
  const taskContext = buildTaskContext(task, agentId, durableAgentContext, taskDocumentContext, researchEvidenceContext)
  const promptSecuritySignals = detectPromptInjectionIndicators({
    taskContext,
    conversation,
  })

  let responseText = ''
  let executionPlan: AgentTaskExecutionPlan | undefined
  let researchQueued = false
  const providerMode = isTaskExecution ? 'task-execution' as const : 'conversation' as const
  const providerUserText = isTaskExecution
    ? text
    : [
        'This is a private discussion, not task execution. Do not state or imply that you changed the task, completed checklist work, created a deliverable, or took an external action. Answer questions, discuss options, and label proposed actions as proposals.',
        `Operator message:\n${text}`,
      ].join('\n\n')
  try {
    if (runtime.provider === 'openai') {
      responseText = await runOpenAIAgent({
        agentId,
        taskContext,
        userText: providerUserText,
        conversation,
        mode: providerMode,
      })
    } else if (runtime.provider === 'openai-codex') {
      responseText = await runChatGPTAgent({
        operatorId,
        taskId,
        agentId,
        taskContext,
        userText: providerUserText,
        conversation,
        mode: providerMode,
      })
    } else {
      const executionContract = providerMode === 'task-execution'
        ? '\n\nReturn one JSON object with status, summary, deliverable, nextAction, waitingOn, blocker, descriptionUpdate, checklistAdd, checklistComplete, and learned. Status must be running, completed, awaiting_input, or blocked. Complete at most one exact checklist item ID and only when the deliverable supports it. Do not claim unavailable external work.'
        : ''
      responseText = await runOpenClawAgent(
        executionAgentId,
        `${agentInstructions(agentId)}\n\n${taskContext}\n\n${serializePromptSection('AUTHENTICATED_OPERATOR_REQUEST', 'authenticated-operator-request', providerUserText)}${executionContract}`,
      )
    }
    if (providerMode === 'task-execution') {
      executionPlan = parseAgentTaskExecutionPlan(responseText)
      if (executionPlan.researchQuery) {
        if (agentId !== 'projects' || !dispatchId || !board?.id) {
          throw new Error('Public research requests require a durable Projects task dispatch')
        }
        await enqueueAgentResearchInPostgres({
          jobId: crypto.randomUUID(),
          continuationDispatchId: crypto.randomUUID(),
          originDispatchId: dispatchId,
          operatorId,
          boardId: board.id,
          taskId,
          agentId: 'projects',
          query: executionPlan.researchQuery,
          continuationDepth: dispatchContinuationDepth,
          queuedAt: new Date().toISOString(),
        })
        researchQueued = true
      }
      responseText = formatAgentTaskExecutionResult(agentId, {
        status: executionPlan.status,
        summary: executionPlan.summary,
        deliverable: executionPlan.deliverable,
        nextAction: executionPlan.nextAction,
        waitingOn: executionPlan.waitingOn,
        blocker: executionPlan.blocker,
        researchQuery: executionPlan.researchQuery,
        changes: [],
        completedChecklistIds: [],
        learned: executionPlan.learned,
      })
    }
  } catch (error) {
    const providerFailure = publicAgentProviderError(error, isTaskExecution)
    const message = providerFailure.message
    const responseRuntime = providerFailure.connectionRejected
      ? {
          ...runtime,
          ready: false as const,
          status: 'not-configured' as const,
          label: runtime.provider === 'openai-codex' ? 'Reconnect ChatGPT' : 'Provider credential rejected',
          auth: runtime.provider === 'openai-codex' ? { ...(runtime.auth || {}), connected: false } : runtime.auth,
        }
      : runtime
    console.error('[agent-threads] provider request failed', {
      provider: runtime.provider,
      model: runtime.model,
      taskId,
      agentId,
      status: error && typeof error === 'object' ? Number((error as { status?: unknown }).status || 0) : 0,
    })
    await recordExecutionTelemetry({
      runId,
      operatorId,
      taskId,
      agentId,
      provider: runtime.provider,
      model: runtime.model,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
      dispatchId,
      dispatchAttempt,
      interactionMode: isTaskExecution ? 'task-execution' : 'discuss',
      securitySignals: promptSecuritySignals,
    })
    await upsertPersistedThreadMessage({
      messageId: resultMessageId,
      operatorId,
      agentId,
      text: `${isTaskExecution ? 'Execution' : 'Response'} failed: ${message}`,
      role: 'system',
      taskId,
      status: 'blocked',
      tags,
      routing,
      meta: {
        source: messageSource,
        phase: 'failure',
        mode: isTaskExecution ? 'task-execution' : 'discuss',
        dispatchId,
        dispatchAttempt,
        executionAgentId,
        provider: runtime.provider,
      },
    })
    return NextResponse.json({ ok: false, error: message, runtime: responseRuntime, thread: await getPersistedThread({ operatorId, agentId, taskId }) }, { status: 502 })
  }

  const completedAt = new Date().toISOString()
  const recorded: Awaited<ReturnType<typeof recordAgentResult>> = isTaskExecution
    ? await recordAgentResult({
      taskId,
      agentId,
      operatorId,
      organizationId: board!.workspaceOrganizationId,
        summary: responseText,
        boardId: board?.id,
        dispatchId,
        dispatchContinuationDepth,
        plan: executionPlan,
      })
    : { evidence: null, summary: responseText, applied: true, continuationQueued: false }
  responseText = recorded.summary
  if (
    isTaskExecution
    && isPostgresTaskStoreEnabled()
    && promptSecuritySignals.length === 0
    && !researchQueued
    && !(Array.isArray(researchEvidenceContext) && researchEvidenceContext.length > 0)
  ) {
    try {
      await captureAgentLearning({
        operatorId,
        organizationId: board!.workspaceOrganizationId,
        agentId,
        responseText,
      })
    } catch (error) {
      console.error('[agent-threads] durable context write failed', error)
    }
  }
  await recordExecutionTelemetry({
    runId,
    operatorId,
    taskId,
    agentId,
    provider: runtime.provider,
    model: runtime.model,
    status: isTaskExecution
      ? recorded.applied ? recorded.evidence?.status || 'responded' : 'stale'
      : 'responded',
    startedAt,
    completedAt,
    summary: responseText,
    evidence: isTaskExecution ? recorded.evidence?.changes || [] : [],
    dispatchId,
    dispatchAttempt,
    interactionMode: isTaskExecution ? 'task-execution' : 'discuss',
    securitySignals: promptSecuritySignals,
    researchQueued,
  }, true)
  if (isTaskExecution) await writeDocsLog(agentId, responseText)
  const responseMeta = isTaskExecution
    ? {
        source: messageSource,
        phase: 'response',
        mode: 'task-execution',
        dispatchId,
        dispatchAttempt,
        responder: responderId,
        executionAgentId,
        provider: runtime.provider,
        executionStatus: recorded.applied ? recorded.evidence?.status || 'responded' : 'stale',
        executionApplied: recorded.applied,
        evidence: recorded.evidence?.changes || [],
        continuationQueued: recorded.continuationQueued,
        researchQueued,
      }
    : {
        source: messageSource,
        phase: 'response',
        mode: 'discuss',
        responder: responderId,
        executionAgentId,
        provider: runtime.provider,
      }
  await upsertPersistedThreadMessage({
    messageId: resultMessageId,
    operatorId,
    agentId,
    text: responseText,
    role: 'agent',
    taskId,
    status: isTaskExecution
      && recorded.applied
      && (recorded.evidence?.status === 'blocked' || recorded.evidence?.status === 'awaiting_input')
      ? 'blocked'
      : 'active',
    tags,
    routing,
    meta: responseMeta,
  })

  const thread = await getPersistedThread({ operatorId, agentId, taskId })
  const threadMessages = (Array.isArray(thread?.messages) ? thread.messages : []) as Array<{ id: string }>
  const updatedTask = isTaskExecution
    ? (await readTasks(board?.id)).find((entry) => String(entry.id) === taskId)
    : task
  return NextResponse.json({
    ok: true,
    thread,
    userMessage,
    agentMessage: resultMessageId
      ? threadMessages.find((message) => message.id === resultMessageId) || null
      : threadMessages[threadMessages.length - 1] || null,
    runtime,
    canonicalWorkItem: updatedTask ? buildCanonicalWorkItem(updatedTask) : null,
    continuationQueued: recorded.continuationQueued,
    researchQueued,
  })
}
