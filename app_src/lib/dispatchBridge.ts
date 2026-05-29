import type { Task } from '@/lib/types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { withFileLock } from '@/lib/fileLock'
import { getErrorMessage } from '@/lib/errorUtils'

const execFileAsync = promisify(execFile)

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const EXECUTION_RUNS_FILE = process.env.EXECUTION_RUNS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'execution-runs.jsonl')
const DISPATCH_QUEUE_FILE = process.env.DISPATCH_QUEUE_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'dispatch-queue.json')

async function appendJsonlAtomic(filePath: string, entry: Record<string, unknown>) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}.jsonl`)
  fs.writeFileSync(tempPath, `${JSON.stringify(entry)}\n`)
  try {
    fs.appendFileSync(filePath, fs.readFileSync(tempPath))
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

export type DispatchPayload = {
  taskId: string
  title: string
  description: string
  checklist: { id: string; text: string; done: boolean }[]
  category: string
  tags: string[]
  assignee?: string
  execution?: Task['execution']
  taskAgeDays?: number
  recentContext?: {
    latestComment?: string
    latestActivity?: string
  }
}

export type DispatchResultStatus = 'completed' | 'blocked' | 'awaiting_input' | 'running' | 'failed'

type QueueRunStatus = 'queued' | 'running' | 'failed' | 'timed_out' | 'completed' | 'deduped'

export type DispatchSuggestion = {
  title: string
  summary: string
  reason: string
  suggestedAgent: string
  timestamp?: string
}

export type DispatchResult = {
  runId: string
  status: DispatchResultStatus
  summary: string
  model?: string
  startedAt: string
  completedAt?: string
  directAnswer?: string
  whatWasDone?: string
  currentState?: string
  nextStep?: string
  blockedReason?: string
  blockerClarification?: string
  suggestedNextAction?: string
  improvementRecommendation?: string
  suggestions?: DispatchSuggestion[]
  raw?: unknown
}

export function buildDispatchPayload(task: Task): DispatchPayload {
  const latestComment = task.comments?.length ? task.comments[task.comments.length - 1]?.text : undefined
  const latestActivity = task.activity?.length ? task.activity[task.activity.length - 1]?.message : undefined
  const updatedAtRaw = task.updatedAt || task.execution?.lastUpdatedAt || null
  let taskAgeDays: number | undefined
  if (updatedAtRaw) {
    const parsed = new Date(updatedAtRaw)
    if (!Number.isNaN(parsed.getTime())) {
      taskAgeDays = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)))
    }
  }

  return {
    taskId: task.id,
    title: task.title,
    description: task.desc,
    checklist: (task.checklist || []).map(item => ({ id: item.id, text: item.text, done: item.done })),
    category: task.category,
    tags: task.tags || [],
    assignee: task.assignee,
    execution: task.execution,
    taskAgeDays,
    recentContext: {
      latestComment,
      latestActivity,
    },
  }
}

function buildAgentPrompt(payload: DispatchPayload): string {
  return [
    'You are executing a ClawApp task as a responsible owner/operator.',
    'Respond ONLY with JSON matching this shape:',
    '{"status":"completed|blocked|awaiting_input|running","directAnswer":"...","whatWasDone":"...","currentState":"...","nextStep":"...","summary":"...","blockedReason?":"...","blockerClarification?":"...","suggestedNextAction?":"...","improvementRecommendation?":"...","suggestions?":[{"title":"...","summary":"...","reason":"...","suggestedAgent":"...","timestamp":"..."}]}',
    'Requirements for your response quality:',
    '- Fully answer in one response when possible (no partial handoff).',
    '- Use ownership language (e.g., "I\'ve updated...", "I\'ve confirmed...", "This is now...", "Next, I will...").',
    '- Include directAnswer, whatWasDone, currentState, and nextStep.',
    '- If taskAgeDays >= 3, explicitly acknowledge staleness/urgency in currentState or nextStep.',
    '- Use recentContext to continue thread context; do not reset to generic wording.',
    '- Keep summary concise and factual; align status with reality.',
    'Use status=blocked when blocked, awaiting_input when you need input, completed when done.',
    `Task payload: ${JSON.stringify(payload)}`,
  ].join('\n')
}

function normalizeResult(result: Partial<DispatchResult> | null, fallbackSummary: string, meta: { runId: string; model?: string; startedAt: string; completedAt?: string }, raw?: unknown): DispatchResult {
  const status = (result?.status || 'running') as DispatchResultStatus
  const summary = result?.summary || fallbackSummary
  const suggestions = Array.isArray(result?.suggestions) ? result?.suggestions : undefined
  return {
    runId: meta.runId,
    status,
    summary,
    model: meta.model,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    directAnswer: result?.directAnswer,
    whatWasDone: result?.whatWasDone,
    currentState: result?.currentState,
    nextStep: result?.nextStep,
    blockedReason: result?.blockedReason,
    blockerClarification: result?.blockerClarification,
    suggestedNextAction: result?.suggestedNextAction,
    improvementRecommendation: result?.improvementRecommendation,
    suggestions,
    raw,
  }
}

async function appendExecutionRun(entry: Record<string, unknown>) {
  const lockPath = `${EXECUTION_RUNS_FILE}.lock`
  await withFileLock(lockPath, () => appendJsonlAtomic(EXECUTION_RUNS_FILE, entry))
}

type QueueItem = {
  task: Task
  agentId: string
  payload: DispatchPayload
  prompt: string
  runId: string
  idempotencyKey: string
  attempt: number
  maxRetries: number
  resolve: (value: DispatchResult | PromiseLike<DispatchResult>) => void
  reject: (reason?: unknown) => void
}

type PersistedQueueItem = {
  task: Task
  agentId: string
  payload: DispatchPayload
  prompt: string
  runId: string
  idempotencyKey: string
  attempt: number
  maxRetries: number
  status: QueueRunStatus
  updatedAt: string
}

type QueueAttemptResult = {
  result: DispatchResult
  queueStatus: QueueRunStatus
}

const dispatchQueue: QueueItem[] = []
const inflightByKey = new Map<string, { runId: string; promise: Promise<DispatchResult> }>()
const pendingByKey = new Map<string, { resolve: (value: DispatchResult | PromiseLike<DispatchResult>) => void; reject: (reason?: unknown) => void }>()
let processingQueue = false
let queueLoaded = false

function computeIdempotencyKey(task: Task, agentId: string, payload: DispatchPayload): string {
  const hash = crypto.createHash('sha256')
  hash.update(JSON.stringify({ taskId: task.id, agentId, payload }))
  return hash.digest('hex')
}

function readQueueFile(): PersistedQueueItem[] {
  try {
    if (!fs.existsSync(DISPATCH_QUEUE_FILE)) return []
    const raw = fs.readFileSync(DISPATCH_QUEUE_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueueFile(entries: PersistedQueueItem[]) {
  const dir = path.dirname(DISPATCH_QUEUE_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}.json`)
  fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2))
  fs.renameSync(tempPath, DISPATCH_QUEUE_FILE)
}

function syncQueueSnapshot(updateFn: (entries: PersistedQueueItem[]) => PersistedQueueItem[]) {
  const entries = readQueueFile()
  const next = updateFn(entries)
  writeQueueFile(next)
}

function markQueueItemStatus(idempotencyKey: string, status: QueueRunStatus, attempt?: number) {
  syncQueueSnapshot(entries => entries.map(entry =>
    entry.idempotencyKey === idempotencyKey
      ? { ...entry, status, attempt: attempt ?? entry.attempt, updatedAt: new Date().toISOString() }
      : entry
  ))
}

function upsertQueueItem(item: PersistedQueueItem) {
  syncQueueSnapshot(entries => {
    const idx = entries.findIndex(entry => entry.idempotencyKey === item.idempotencyKey)
    if (idx >= 0) {
      const next = [...entries]
      next[idx] = item
      return next
    }
    return [...entries, item]
  })
}

function removeQueueItem(idempotencyKey: string) {
  syncQueueSnapshot(entries => entries.filter(entry => entry.idempotencyKey !== idempotencyKey))
}

function findQueueItem(idempotencyKey: string) {
  return readQueueFile().find(entry => entry.idempotencyKey === idempotencyKey)
}

function attachPromiseToQueue(idempotencyKey: string, resolve: (value: DispatchResult | PromiseLike<DispatchResult>) => void, reject: (reason?: unknown) => void) {
  pendingByKey.set(idempotencyKey, { resolve, reject })
  dispatchQueue.forEach(item => {
    if (item.idempotencyKey === idempotencyKey) {
      item.resolve = resolve
      item.reject = reject
    }
  })
}

function loadQueueFromDisk() {
  if (queueLoaded) return
  queueLoaded = true
  const entries = readQueueFile()
  const toEnqueue = entries.filter(entry => entry.status === 'queued' || entry.status === 'running')
  toEnqueue.forEach(entry => {
    dispatchQueue.push({
      task: entry.task,
      agentId: entry.agentId,
      payload: entry.payload,
      prompt: entry.prompt,
      runId: entry.runId,
      idempotencyKey: entry.idempotencyKey,
      attempt: entry.status === 'running' ? entry.attempt : Math.max(entry.attempt, 1),
      maxRetries: entry.maxRetries,
      resolve: () => {},
      reject: () => {},
    })
  })
  if (dispatchQueue.length > 0) {
    processQueue().catch(() => {})
  }
}

async function runDispatchAttempt(item: QueueItem): Promise<QueueAttemptResult> {
  const startedAt = new Date().toISOString()
  await appendExecutionRun({
    runId: item.runId,
    idempotencyKey: item.idempotencyKey,
    taskId: item.task.id,
    taskTitle: item.task.title,
    agentId: item.agentId,
    model: undefined,
    startedAt,
    status: 'running' as QueueRunStatus,
    attempt: item.attempt,
    maxRetries: item.maxRetries,
    payload: item.payload,
    prompt: item.prompt,
  })

  try {
    const { stdout } = await execFileAsync('openclaw', [
      'agent',
      '--agent',
      item.agentId,
      '--message',
      item.prompt,
      '--json',
    ], { timeout: 600000 })

    const completedAt = new Date().toISOString()
    const parsed = stdout ? JSON.parse(stdout) : null
    const replyText = parsed?.reply?.text || parsed?.message?.text || parsed?.output || ''
    const model = parsed?.model || parsed?.reply?.model || parsed?.message?.model || undefined

    let result: DispatchResult
    if (replyText) {
      try {
        const replyJson = typeof replyText === 'string' ? JSON.parse(replyText) : replyText
        result = normalizeResult(replyJson, 'Agent reply received.', { runId: item.runId, model, startedAt, completedAt }, parsed)
      } catch {
        result = normalizeResult(null, String(replyText).slice(0, 180) || 'Agent reply received.', { runId: item.runId, model, startedAt, completedAt }, parsed)
      }
    } else {
      result = normalizeResult(null, 'Agent run completed without reply text.', { runId: item.runId, model, startedAt, completedAt }, parsed)
    }

    await appendExecutionRun({
      runId: item.runId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.task.id,
      taskTitle: item.task.title,
      agentId: item.agentId,
      model,
      startedAt,
      completedAt,
      status: 'completed' as QueueRunStatus,
      attempt: item.attempt,
      maxRetries: item.maxRetries,
      payload: item.payload,
      prompt: item.prompt,
      response: replyText,
      raw: parsed,
      resultStatus: result.status,
    })

    return { result, queueStatus: 'completed' }
  } catch (error: unknown) {
    const completedAt = new Date().toISOString()
    const message = getErrorMessage(error)
    const errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    const isTimeout = message.toLowerCase().includes('timeout') || errorCode === 'ETIMEDOUT'
    const status: QueueRunStatus = isTimeout ? 'timed_out' : 'failed'

    await appendExecutionRun({
      runId: item.runId,
      idempotencyKey: item.idempotencyKey,
      taskId: item.task.id,
      taskTitle: item.task.title,
      agentId: item.agentId,
      model: undefined,
      startedAt,
      completedAt,
      status,
      attempt: item.attempt,
      maxRetries: item.maxRetries,
      payload: item.payload,
      prompt: item.prompt,
      response: null,
      error: message || 'Unknown error',
    })

    return {
      result: {
        runId: item.runId,
        status: 'failed',
        summary: 'OpenClaw dispatch failed.',
        blockedReason: message || 'Unknown error',
        startedAt,
        completedAt,
      },
      queueStatus: status,
    }
  }
}

async function processQueue() {
  if (processingQueue) return
  processingQueue = true
  try {
    while (dispatchQueue.length > 0) {
      const item = dispatchQueue.shift()!
      markQueueItemStatus(item.idempotencyKey, 'running', item.attempt)
      const { result, queueStatus } = await runDispatchAttempt(item)
      const needsRetry = (queueStatus === 'failed' || queueStatus === 'timed_out') && item.attempt < item.maxRetries

      if (needsRetry) {
        const nextAttempt = item.attempt + 1
        await appendExecutionRun({
          runId: item.runId,
          idempotencyKey: item.idempotencyKey,
          taskId: item.task.id,
          taskTitle: item.task.title,
          agentId: item.agentId,
          model: result.model,
          startedAt: new Date().toISOString(),
          status: 'queued' as QueueRunStatus,
          attempt: nextAttempt,
          maxRetries: item.maxRetries,
          payload: item.payload,
          prompt: item.prompt,
          reason: 'retry',
        })
        upsertQueueItem({
          task: item.task,
          agentId: item.agentId,
          payload: item.payload,
          prompt: item.prompt,
          runId: item.runId,
          idempotencyKey: item.idempotencyKey,
          attempt: nextAttempt,
          maxRetries: item.maxRetries,
          status: 'queued',
          updatedAt: new Date().toISOString(),
        })
        dispatchQueue.push({ ...item, attempt: nextAttempt })
        continue
      }

      removeQueueItem(item.idempotencyKey)
      inflightByKey.delete(item.idempotencyKey)
      item.resolve(result)
      const pending = pendingByKey.get(item.idempotencyKey)
      if (pending) {
        pending.resolve(result)
        pendingByKey.delete(item.idempotencyKey)
      }
    }
  } finally {
    processingQueue = false
  }
}

export async function dispatchToOpenClaw(task: Task, agentId: string): Promise<DispatchResult> {
  const payload = buildDispatchPayload(task)
  const prompt = buildAgentPrompt(payload)
  const idempotencyKey = computeIdempotencyKey(task, agentId, payload)

  loadQueueFromDisk()

  const inflight = inflightByKey.get(idempotencyKey)
  if (inflight) {
    await appendExecutionRun({
      runId: inflight.runId,
      idempotencyKey,
      taskId: task.id,
      taskTitle: task.title,
      agentId,
      model: undefined,
      startedAt: new Date().toISOString(),
      status: 'deduped' as QueueRunStatus,
      attempt: undefined,
      maxRetries: undefined,
      payload,
      prompt,
      response: null,
    })
    return inflight.promise
  }

  const existing = findQueueItem(idempotencyKey)
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    await appendExecutionRun({
      runId: existing.runId,
      idempotencyKey,
      taskId: task.id,
      taskTitle: task.title,
      agentId,
      model: undefined,
      startedAt: new Date().toISOString(),
      status: 'deduped' as QueueRunStatus,
      attempt: existing.attempt,
      maxRetries: existing.maxRetries,
      payload,
      prompt,
      response: null,
    })
    const promise = new Promise<DispatchResult>((resolve, reject) => {
      attachPromiseToQueue(idempotencyKey, resolve, reject)
    })
    inflightByKey.set(idempotencyKey, { runId: existing.runId, promise })
    return promise
  }

  const runId = idempotencyKey
  const maxRetries = 2

  const queuedEntry: PersistedQueueItem = {
    task,
    agentId,
    payload,
    prompt,
    runId,
    idempotencyKey,
    attempt: 0,
    maxRetries,
    status: 'queued',
    updatedAt: new Date().toISOString(),
  }

  upsertQueueItem(queuedEntry)

  await appendExecutionRun({
    runId,
    idempotencyKey,
    taskId: task.id,
    taskTitle: task.title,
    agentId,
    model: undefined,
    startedAt: new Date().toISOString(),
    status: 'queued' as QueueRunStatus,
    attempt: 0,
    maxRetries,
    payload,
    prompt,
  })

  const promise = new Promise<DispatchResult>((resolve, reject) => {
    dispatchQueue.push({
      task,
      agentId,
      payload,
      prompt,
      runId,
      idempotencyKey,
      attempt: 1,
      maxRetries,
      resolve,
      reject,
    })
    processQueue().catch(reject)
  })

  inflightByKey.set(idempotencyKey, { runId, promise })
  return promise
}
