import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { getAgentRuntimeForOperator, runChatGPTAgent, runOpenAIAgent } from '@/lib/agents/provider'
import { resolveResponderId } from '@/lib/agents/responder.mjs'
import { getThread as getFileThread, listThreads as listFileThreads, upsertThreadMessage as upsertFileThreadMessage } from '@/lib/agents/threadStore.mjs'
import { normalizeProductAgentId, resolveExecutionAgentForControlAgent } from '@/lib/agents/routing'
import { isCrmBoardCard } from '@/lib/crm/boardCard.mjs'
import { withFileLock } from '@/lib/fileLock'
import type { Comment, Task } from '@/lib/types'
import { buildCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { isOpenClawExecutionEnabled, shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { getThreadFromPostgres, listThreadsFromPostgres, upsertThreadMessageInPostgres } from '@/lib/persistence/agentThreads'
import { appendExecutionResultToPostgres, appendExecutionRunToPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import { requireActiveAppUser } from '@/lib/users'
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

async function resolveOperator(req: NextRequest): Promise<string | null> {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  if (!session.ok) return null
  try {
    return (await requireActiveAppUser(session.user)).email
  } catch {
    return null
  }
}

function authorizedWorkerDispatch(req: NextRequest): boolean {
  if (req.headers.get('x-clawpilot-worker') !== 'agent-dispatch') return false
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!expected || !provided) return false
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer)
}

async function resolveAgentBoard(req: NextRequest, operatorId: string, requireEdit = false): Promise<ProjectBoard | null> {
  if (!isPostgresTaskStoreEnabled()) return null
  const selected = req.cookies.get(BOARD_SELECTION_COOKIE)?.value || undefined
  let board: ProjectBoard
  try {
    board = await resolveProjectBoardAccess({ actorEmail: operatorId, boardId: selected })
  } catch {
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

async function recordAgentResult(taskId: string, agentId: string, summary: string, boardId?: string, dispatchId?: string) {
  const tasks = await readTasks(boardId)
  const index = tasks.findIndex((task) => String(task.id) === taskId)
  if (index === -1) return

  const task = tasks[index]
  const now = new Date().toISOString()
  const nextAction = deriveNextAction(summary)
  const commentId = dispatchId ? `agent-dispatch-${dispatchId}` : Date.now().toString()
  const comment: Comment = {
    id: commentId,
    text: `Agent: ${agentId}\n\n${summary}`,
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
        executionStatus: 'completed',
        lastUpdatedAt: now,
        latestExecutionNote: summary,
        lastResult: { type: 'agent-thread-result', agentId, summary, nextAction, recordedAt: now },
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
        message: `Agent ${agentId} posted a task result.`,
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

function buildTaskContext(task: Task, agentId: string): string {
  const checklist = (task.checklist || []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')
  const nextAction = String(task.workItem?.nextAction || '').trim()
  return [
    `Task: ${task.title}`,
    task.desc ? `Description: ${task.desc}` : null,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Assigned agent: ${agentId}`,
    nextAction ? `Next action: ${nextAction}` : null,
    checklist ? `Checklist:\n${checklist}` : null,
  ].filter(Boolean).join('\n')
}

function assignmentError(task: Task, agentId: string): string | null {
  const assignedAgent = normalizeProductAgentId(task.assignedAgent)
  if (!assignedAgent) return 'Assign this task to an agent before opening its thread.'
  if (assignedAgent !== agentId) return `This task is assigned to ${assignedAgent}. Reassign it before using ${agentId}.`
  return null
}

export async function GET(req: NextRequest) {
  const operatorId = await resolveOperator(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
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
  const operatorId = await resolveOperator(req)
  if (!operatorId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  let board: ProjectBoard | null
  try {
    board = await resolveAgentBoard(req, operatorId, true)
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Board edit access denied' }, { status: 403 })
  }
  const body = await req.json()
  const agentId = normalizeProductAgentId(String(body?.agentId || ''))
  const text = String(body?.text || '').trim()
  const taskId = String(body?.taskId || '').trim()
  const tags = Array.isArray(body?.tags) ? body.tags.map(String) : undefined
  const requestedDispatchId = String(body?.dispatchId || '').trim()
  if (requestedDispatchId && !authorizedWorkerDispatch(req)) {
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
    return NextResponse.json({
      ok: true,
      deduplicated: true,
      thread: beforeThread,
      userMessage: beforeMessages.find((message) => message.id === requestMessageId) || null,
      agentMessage: existingResponse,
      runtime,
      canonicalWorkItem: buildCanonicalWorkItem(task),
    })
  }

  const resultCommentId = dispatchId ? `agent-dispatch-${dispatchId}` : ''
  const existingResultComment = resultCommentId
    ? (task.comments || []).find((comment) => comment.id === resultCommentId)
    : null
  if (existingResultComment) {
    const recoveredText = existingResultComment.text.replace(/^Agent:\s*[^\n]+\n\n/i, '').trim()
    await upsertPersistedThreadMessage({
      messageId: resultMessageId,
      operatorId,
      agentId,
      text: recoveredText || existingResultComment.text,
      role: 'agent',
      taskId,
      status: 'active',
      tags,
      routing,
      meta: { source: messageSource, phase: 'response', dispatchId, recovered: true, responder: responderId, executionAgentId, provider: runtime.provider },
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
      canonicalWorkItem: buildCanonicalWorkItem(task),
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
  const taskContext = buildTaskContext(task, agentId)

  let responseText = ''
  try {
    if (runtime.provider === 'openai') {
      responseText = await runOpenAIAgent({
        agentId,
        taskContext,
        userText: text,
        conversation,
      })
    } else if (runtime.provider === 'openai-codex') {
      responseText = await runChatGPTAgent({
        operatorId,
        taskId,
        agentId,
        taskContext,
        userText: text,
        conversation,
      })
    } else {
      responseText = await runOpenClawAgent(executionAgentId, `${taskContext}\n\nOperator request:\n${text}`)
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
  await recordAgentResult(taskId, agentId, responseText, board?.id, dispatchId)
  await recordExecutionTelemetry({
    runId,
    operatorId,
    taskId,
    agentId,
    provider: runtime.provider,
    model: runtime.model,
    status: 'completed',
    startedAt,
    completedAt,
    summary: responseText,
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
    status: 'active',
    tags,
    routing,
    meta: { source: messageSource, phase: 'response', dispatchId, dispatchAttempt, responder: responderId, executionAgentId, provider: runtime.provider },
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
