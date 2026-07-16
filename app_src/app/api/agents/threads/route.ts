import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { getAgentRuntimeForOperator, runChatGPTAgent, runOpenAIAgent } from '@/lib/agents/provider'
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
import { withFileLock } from '@/lib/fileLock'
import type { Comment, Task } from '@/lib/types'
import { buildCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { isOpenClawExecutionEnabled, shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { getThreadFromPostgres, listThreadsFromPostgres, upsertThreadMessageInPostgres } from '@/lib/persistence/agentThreads'
import { appendExecutionResultToPostgres, appendExecutionRunToPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import { requireRequestUser } from '@/lib/requestUser'
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

async function writeTasks(tasks: Task[], boardId?: string) {
  const canonical = canonicalizeTasks(tasks)
  if (isPostgresTaskStoreEnabled()) {
    if (!boardId) throw new Error('Project board context is required')
    try {
      await replaceTasksInPostgres(canonical, { boardId })
      return
    } catch (error) {
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
  worker: AgentDispatchWorkerContext | null
} | null> {
  try {
    const worker = allowWorker ? await resolveAgentDispatchWorker(req) : null
    if (worker) return { operatorId: worker.operatorId, worker }
    return { operatorId: (await requireRequestUser(req)).email, worker: null }
  } catch {
    return null
  }
}

async function resolveAgentBoard(
  req: NextRequest,
  operatorId: string,
  requireEdit = false,
  worker?: AgentDispatchWorkerContext | null,
): Promise<ProjectBoard | null> {
  if (!isPostgresTaskStoreEnabled()) return null
  const selected = worker?.boardId || req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  let board: ProjectBoard
  try {
    board = await resolveProjectBoardAccess({ actorEmail: operatorId, boardId: selected })
  } catch (error) {
    if (worker?.boardId) throw error
    board = await resolveProjectBoardAccess({ actorEmail: operatorId })
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
  summary: string
  boardId?: string
  dispatchId?: string
  plan?: AgentTaskExecutionPlan
}): Promise<{ evidence: AgentTaskExecutionEvidence | null; summary: string; applied: boolean }> {
  const { taskId, agentId, summary, boardId, dispatchId, plan } = input
  const tasks = await readTasks(boardId)
  const index = tasks.findIndex((task) => String(task.id) === taskId)
  if (index === -1) return { evidence: null, summary, applied: false }

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
    if (!planApplied) return { evidence, summary: resultSummary, applied: false }
  }
  const nextAction = evidence?.nextAction || deriveNextAction(resultSummary)
  const commentId = dispatchId ? `agent-dispatch-${dispatchId}` : Date.now().toString()
  const comment: Comment = {
    id: commentId,
    text: /^Agent\s*:/i.test(resultSummary) ? resultSummary : `Agent: ${agentId}\n\n${resultSummary}`,
    createdAt: now,
    timestamp: now,
    author: agentId,
  }
  const existingCommentIndex = (task.comments || []).findIndex((entry) => entry.id === commentId)
  const comments = existingCommentIndex >= 0
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
    activity: activityAlreadyRecorded ? task.activity : [
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
  await writeTasks(tasks, boardId)
  return { evidence, summary: resultSummary, applied: planApplied }
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

function buildTaskContext(task: Task, agentId: string, durableContext?: string | null): string {
  const checklist = (task.checklist || []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')
  const nextAction = String(task.workItem?.nextAction || '').trim()
  const recentComments = (task.comments || [])
    .filter((comment) => !comment.deletedAt)
    .slice(-12)
    .map((comment) => `- ${comment.author}: ${comment.text}`)
    .join('\n')
  const recentActivity = (task.activity || [])
    .slice(-12)
    .map((entry) => `- ${entry.timestamp} | ${entry.actor} | ${entry.message}`)
    .join('\n')
  return [
    `Task: ${task.title}`,
    task.desc ? `Description:\n${task.desc}` : null,
    task.outcomeStatement ? `Outcome:\n${task.outcomeStatement}` : null,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Category: ${task.category || 'none'}`,
    task.tags?.length ? `Tags: ${task.tags.join(', ')}` : null,
    task.dueDate ? `Due date: ${task.dueDate}` : null,
    `Assigned agent: ${agentId}`,
    nextAction ? `Next action: ${nextAction}` : null,
    checklist ? `Checklist:\n${checklist}` : null,
    recentComments ? `Recent card comments:\n${recentComments}` : null,
    recentActivity ? `Recent card activity:\n${recentActivity}` : null,
    durableContext ? `Durable agent context:\n${durableContext}` : null,
  ].filter(Boolean).join('\n')
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
  const { operatorId } = resolved
  let board: ProjectBoard | null
  try {
    board = await resolveAgentBoard(req, operatorId)
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
  const { operatorId, worker } = resolved
  let board: ProjectBoard | null
  try {
    board = await resolveAgentBoard(req, operatorId, true, worker)
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Board edit access denied' }, { status: 403 })
  }
  const body = await req.json()
  const agentId = normalizeProductAgentId(String(body?.agentId || ''))
  const text = String(body?.text || '').trim()
  const taskId = String(body?.taskId || '').trim()
  const tags = Array.isArray(body?.tags) ? body.tags.map(String) : undefined
  const requestedDispatchId = String(body?.dispatchId || '').trim()
  if (requestedDispatchId && !worker) {
    return NextResponse.json({ ok: false, error: 'Agent dispatch metadata requires worker authorization' }, { status: 403 })
  }
  const dispatchId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDispatchId)
    ? requestedDispatchId.toLowerCase()
    : undefined
  const dispatchAttempt = Math.max(0, Math.trunc(Number(body?.dispatchAttempt) || 0))
  const messageSource = dispatchId ? 'dispatch' : 'api'
  if (!agentId || !text || !taskId) {
    return NextResponse.json({ ok: false, error: 'valid agentId, taskId and text required' }, { status: 400 })
  }

  const task = (await readTasks(board?.id)).find((entry) => String(entry.id) === taskId)
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
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
  const requestMessageId = dispatchId ? `agent-dispatch-${dispatchId}-request` : undefined
  const resultMessageId = dispatchId ? `agent-dispatch-${dispatchId}-result` : undefined
  const beforeMessages = (Array.isArray(beforeThread?.messages) ? beforeThread.messages : []) as Array<{
    id: string
    role: string
    text: string
    meta?: Record<string, unknown>
  }>
  const existingResponse = dispatchId
    ? beforeMessages.find((message) => message.role === 'agent' && message.meta?.dispatchId === dispatchId)
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

  const runId = dispatchId || crypto.randomUUID()
  const startedAt = new Date().toISOString()

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
    meta: { source: messageSource, phase: 'request', dispatchId, dispatchAttempt, executionAgentId, provider: runtime.provider },
  })

  const afterUser = await getPersistedThread({ operatorId, agentId, taskId })
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
  if (isPostgresTaskStoreEnabled()) {
    try {
      durableAgentContext = formatAgentContextMemories(await readAgentContextMemories({
        operatorId,
        agentId,
      }))
    } catch (error) {
      console.error('[agent-threads] durable context read failed', error)
    }
  }
  const taskContext = buildTaskContext(task, agentId, durableAgentContext)

  let responseText = ''
  let executionPlan: AgentTaskExecutionPlan | undefined
  try {
    const mode = worker && dispatchId ? 'task-execution' as const : 'conversation' as const
    if (runtime.provider === 'openai') {
      responseText = await runOpenAIAgent({
        agentId,
        taskContext,
        userText: text,
        conversation,
        mode,
      })
    } else if (runtime.provider === 'openai-codex') {
      responseText = await runChatGPTAgent({
        operatorId,
        taskId,
        agentId,
        taskContext,
        userText: text,
        conversation,
        mode,
      })
    } else {
      const executionContract = mode === 'task-execution'
        ? '\n\nReturn one JSON object with status, summary, nextAction, waitingOn, blocker, descriptionUpdate, checklistAdd, and learned. Status must be triaged, awaiting_input, or blocked. Do not claim unavailable external work.'
        : ''
      responseText = await runOpenClawAgent(executionAgentId, `${taskContext}\n\nOperator request:\n${text}${executionContract}`)
    }
    if (mode === 'task-execution') {
      executionPlan = parseAgentTaskExecutionPlan(responseText)
      responseText = formatAgentTaskExecutionResult(agentId, {
        status: executionPlan.status,
        summary: executionPlan.summary,
        nextAction: executionPlan.nextAction,
        waitingOn: executionPlan.waitingOn,
        blocker: executionPlan.blocker,
        changes: [],
        learned: executionPlan.learned,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent execution failed'
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
    })
    await upsertPersistedThreadMessage({
      messageId: resultMessageId,
      operatorId,
      agentId,
      text: `Execution failed: ${message}`,
      role: 'system',
      taskId,
      status: 'blocked',
      tags,
      routing,
      meta: { source: messageSource, phase: 'failure', dispatchId, dispatchAttempt, executionAgentId, provider: runtime.provider },
    })
    return NextResponse.json({ ok: false, error: message, runtime, thread: await getPersistedThread({ operatorId, agentId, taskId }) }, { status: 502 })
  }

  const completedAt = new Date().toISOString()
  const recorded = await recordAgentResult({
    taskId,
    agentId,
    summary: responseText,
    boardId: board?.id,
    dispatchId,
    plan: executionPlan,
  })
  responseText = recorded.summary
  if (isPostgresTaskStoreEnabled()) {
    try {
      await captureAgentLearning({ operatorId, agentId, responseText })
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
    status: recorded.applied ? recorded.evidence?.status || 'responded' : 'stale',
    startedAt,
    completedAt,
    summary: responseText,
    evidence: recorded.evidence?.changes || [],
    dispatchId,
    dispatchAttempt,
  }, true)
  await writeDocsLog(agentId, responseText)
  await upsertPersistedThreadMessage({
    messageId: resultMessageId,
    operatorId,
    agentId,
    text: responseText,
    role: 'agent',
    taskId,
    status: recorded.applied && (recorded.evidence?.status === 'blocked' || recorded.evidence?.status === 'awaiting_input')
      ? 'blocked'
      : 'active',
    tags,
    routing,
    meta: {
      source: messageSource,
      phase: 'response',
      dispatchId,
      dispatchAttempt,
      responder: responderId,
      executionAgentId,
      provider: runtime.provider,
      executionStatus: recorded.applied ? recorded.evidence?.status || 'responded' : 'stale',
      executionApplied: recorded.applied,
      evidence: recorded.evidence?.changes || [],
    },
  })

  const thread = await getPersistedThread({ operatorId, agentId, taskId })
  const threadMessages = (Array.isArray(thread?.messages) ? thread.messages : []) as Array<{ id: string }>
  const updatedTask = (await readTasks(board?.id)).find((entry) => String(entry.id) === taskId)
  return NextResponse.json({
    ok: true,
    thread,
    userMessage,
    agentMessage: resultMessageId
      ? threadMessages.find((message) => message.id === resultMessageId) || null
      : threadMessages[threadMessages.length - 1] || null,
    runtime,
    canonicalWorkItem: updatedTask ? buildCanonicalWorkItem(updatedTask) : null,
  })
}
