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
import { withFileLock } from '@/lib/fileLock'
import type { Comment, Task } from '@/lib/types'
import { buildCanonicalWorkItem, canonicalizeTasks } from '@/lib/workItemModel'
import { isOpenClawExecutionEnabled, shouldFallbackToFileOnDatabaseError } from '@/lib/persistence/config'
import { getThreadFromPostgres, listThreadsFromPostgres, upsertThreadMessageInPostgres } from '@/lib/persistence/agentThreads'
import { appendExecutionResultToPostgres, appendExecutionRunToPostgres, isPostgresExecutionStoreEnabled } from '@/lib/persistence/execution'
import { isPostgresTaskStoreEnabled, readTasksFromPostgres, replaceTasksInPostgres } from '@/lib/persistence/tasks'
import { requireActiveAppUser } from '@/lib/users'

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

async function readTasks(): Promise<Task[]> {
  if (isPostgresTaskStoreEnabled()) {
    try {
      return await readTasksFromPostgres()
    } catch (error) {
      if (!shouldFallbackToFileOnDatabaseError()) throw error
      console.warn('[agent-threads] Postgres task read failed; falling back to file store', error)
    }
  }
  return readTasksFromFile()
}

async function writeTasks(tasks: Task[]) {
  const canonical = canonicalizeTasks(tasks)
  if (isPostgresTaskStoreEnabled()) {
    try {
      await replaceTasksInPostgres(canonical)
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

async function recordAgentResult(taskId: string, agentId: string, summary: string) {
  const tasks = await readTasks()
  const index = tasks.findIndex((task) => String(task.id) === taskId)
  if (index === -1) return

  const task = tasks[index]
  const now = new Date().toISOString()
  const nextAction = deriveNextAction(summary)
  const comment: Comment = {
    id: Date.now().toString(),
    text: `Agent: ${agentId}\n\n${summary}`,
    createdAt: now,
    timestamp: now,
    author: agentId,
  }
  tasks[index] = {
    ...task,
    comments: [...(task.comments || []), comment],
    activity: [
      ...(task.activity || []),
      {
        type: 'comment',
        message: `Agent ${agentId} posted a task result.`,
        timestamp: now,
        actor: agentId,
        taskId: task.id,
        taskTitle: task.title,
        commentId: comment.id,
      },
    ],
    execution: {
      ...(task.execution || {}),
      lastUpdatedAt: now,
      latestExecutionNote: summary,
      lastResult: { type: 'agent-thread-result', agentId, summary, nextAction, recordedAt: now },
    },
    updatedAt: now,
  }
  await writeTasks(tasks)
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
  const { searchParams } = new URL(req.url)
  const requestedAgentId = String(searchParams.get('agentId') || '')
  if (!requestedAgentId) return NextResponse.json(await listPersistedThreads(operatorId))

  const agentId = normalizeProductAgentId(requestedAgentId)
  const taskId = String(searchParams.get('taskId') || '').trim()
  if (!agentId) return NextResponse.json({ ok: false, error: 'invalid product agent' }, { status: 400 })
  if (!taskId) return NextResponse.json({ ok: false, error: 'taskId required' }, { status: 400 })

  const task = (await readTasks()).find((entry) => String(entry.id) === taskId)
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
  const body = await req.json()
  const agentId = normalizeProductAgentId(String(body?.agentId || ''))
  const text = String(body?.text || '').trim()
  const taskId = String(body?.taskId || '').trim()
  const tags = Array.isArray(body?.tags) ? body.tags.map(String) : undefined
  if (!agentId || !text || !taskId) {
    return NextResponse.json({ ok: false, error: 'valid agentId, taskId and text required' }, { status: 400 })
  }

  const task = (await readTasks()).find((entry) => String(entry.id) === taskId)
  if (!task) return NextResponse.json({ ok: false, error: 'task not found' }, { status: 404 })
  const mismatch = assignmentError(task, agentId)
  if (mismatch) return NextResponse.json({ ok: false, error: mismatch }, { status: 409 })

  const runtime = await getAgentRuntimeForOperator(operatorId)
  if (!runtime.ready) return NextResponse.json({ ok: false, error: runtime.label, runtime }, { status: 503 })

  const executionAgentId = resolveExecutionAgentForControlAgent(agentId)
  if (!executionAgentId) return NextResponse.json({ ok: false, error: 'execution route missing for product agent' }, { status: 400 })
  const responderId = runtime.provider === 'openclaw' ? resolveResponderId(executionAgentId) : agentId
  const routing = { responder: responderId, channel: 'internal', priority: 'normal' }
  const runId = crypto.randomUUID()
  const startedAt = new Date().toISOString()

  await upsertPersistedThreadMessage({
    operatorId,
    agentId,
    text,
    role: 'user',
    taskId,
    status: 'resolving',
    tags,
    routing,
    meta: { source: 'api', phase: 'request', executionAgentId, provider: runtime.provider },
  })

  const afterUser = await getPersistedThread({ operatorId, agentId, taskId })
  const userMessage = afterUser?.messages?.[afterUser.messages.length - 1] || null
  const messages = (Array.isArray(afterUser?.messages) ? afterUser.messages : []) as Array<{ role: string; text: string }>
  const taskContext = buildTaskContext(task, agentId)

  let responseText = ''
  try {
    if (runtime.provider === 'openai') {
      responseText = await runOpenAIAgent({
        agentId,
        taskContext,
        userText: text,
        conversation: messages.slice(0, -1).map((message) => ({ role: message.role, text: message.text })),
      })
    } else if (runtime.provider === 'openai-codex') {
      responseText = await runChatGPTAgent({
        operatorId,
        taskId,
        agentId,
        taskContext,
        userText: text,
        conversation: messages.slice(0, -1).map((message) => ({ role: message.role, text: message.text })),
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
    })
    await upsertPersistedThreadMessage({
      operatorId,
      agentId,
      text: `Execution failed: ${message}`,
      role: 'system',
      taskId,
      status: 'blocked',
      tags,
      routing,
      meta: { source: 'api', phase: 'failure', executionAgentId, provider: runtime.provider },
    })
    return NextResponse.json({ ok: false, error: message, runtime, thread: await getPersistedThread({ operatorId, agentId, taskId }) }, { status: 502 })
  }

  const completedAt = new Date().toISOString()
  await recordAgentResult(taskId, agentId, responseText)
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
  }, true)
  await writeDocsLog(agentId, responseText)
  await upsertPersistedThreadMessage({
    operatorId,
    agentId,
    text: responseText,
    role: 'agent',
    taskId,
    status: 'active',
    tags,
    routing,
    meta: { source: 'api', phase: 'response', responder: responderId, executionAgentId, provider: runtime.provider },
  })

  const thread = await getPersistedThread({ operatorId, agentId, taskId })
  const updatedTask = (await readTasks()).find((entry) => String(entry.id) === taskId)
  return NextResponse.json({
    ok: true,
    thread,
    userMessage,
    agentMessage: thread?.messages?.[thread.messages.length - 1] || null,
    runtime,
    canonicalWorkItem: updatedTask ? buildCanonicalWorkItem(updatedTask) : null,
  })
}
