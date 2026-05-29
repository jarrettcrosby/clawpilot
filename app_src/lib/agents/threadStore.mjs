import fs from 'fs'
import path from 'path'

const DEV_TASKS_FILE = path.join(process.cwd(), '..', 'data-dev', 'tasks.json')
const PROD_TASKS_FILE = path.join(process.cwd(), '..', 'data', 'tasks.json')
const TASKS_FILE = process.env.TASKS_PATH || ((process.env.NODE_ENV === 'development' && fs.existsSync(DEV_TASKS_FILE)) ? DEV_TASKS_FILE : PROD_TASKS_FILE)
const DEFAULT_FILE = process.env.AGENT_THREADS_PATH || path.join(path.dirname(TASKS_FILE), 'agents', 'threads.json')
const LOCK_TIMEOUT_MS = 4000
const LOCK_RETRY_MS = 25
const STALE_LOCK_MS = 15000

let writeQueue = Promise.resolve()

function nowIso() { return new Date().toISOString() }

function rand() { return Math.random().toString(36).slice(2, 8) }

function normalizeTagValue(tag) {
  const safe = String(tag ?? '').trim()
  return safe || null
}

function normalizeTags(tags = []) {
  return Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map(normalizeTagValue)
    .filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
}

function toThreadId(agentId, taskId) {
  return `thread_${agentId}_${taskId || 'general'}`
}

function normalizeRouting(routing) {
  return {
    responder: String(routing?.responder || 'stub'),
    channel: String(routing?.channel || 'internal'),
    priority: String(routing?.priority || 'normal'),
  }
}

function normalizeThreadStatus(status, fallback = 'active') {
  const safe = String(status || '').trim().toLowerCase()
  if (safe === 'active' || safe === 'resolving' || safe === 'blocked' || safe === 'closed') return safe
  return fallback
}

function deriveContext(messages = []) {
  const committed = Array.isArray(messages) ? messages : []
  const lastUser = [...committed].reverse().find(m => m.role === 'user')
  const tokenEstimate = committed.reduce((n, m) => n + Math.max(1, Math.ceil(String(m.text || '').length / 4)), 0)
  return {
    summary: null,
    lastUserMessageId: lastUser?.id || null,
    messageCount: committed.length,
    tokenEstimate,
  }
}

function migrateMessage(m = {}) {
  return {
    id: String(m.id || `${Date.now()}-${rand()}`),
    role: (m.role === 'agent' || m.role === 'system' || m.role === 'tool') ? m.role : 'user',
    text: String(m.text || ''),
    createdAt: String(m.createdAt || m.timestamp || nowIso()),
    taskId: m.taskId ? String(m.taskId) : undefined,
    status: (m.status === 'pending' || m.status === 'failed') ? m.status : 'committed',
    meta: m.meta && typeof m.meta === 'object' ? m.meta : undefined,
  }
}

function migrateThread(t = {}) {
  const agentId = String(t.agentId || 'unknown-agent')
  const taskId = t.taskId ? String(t.taskId) : undefined
  const createdAt = String(t.createdAt || t.updatedAt || nowIso())
  const updatedAt = String(t.updatedAt || createdAt)
  const status = normalizeThreadStatus(t.status, 'active')
  const tags = normalizeTags(t.tags)
  const messages = Array.isArray(t.messages) ? t.messages.map(migrateMessage) : []
  const threadId = String(t.threadId || toThreadId(agentId, taskId))
  const lastMessageAt = String(t.lastMessageAt || messages[messages.length - 1]?.createdAt || updatedAt)
  const routing = normalizeRouting(t.routing)
  const context = t.context && typeof t.context === 'object' ? {
    summary: t.context.summary || null,
    lastUserMessageId: t.context.lastUserMessageId || null,
    messageCount: Number.isFinite(t.context.messageCount) ? Number(t.context.messageCount) : messages.length,
    tokenEstimate: Number.isFinite(t.context.tokenEstimate) ? Number(t.context.tokenEstimate) : deriveContext(messages).tokenEstimate,
  } : deriveContext(messages)
  const contextSnapshot = t.contextSnapshot && typeof t.contextSnapshot === 'object' ? t.contextSnapshot : null
  const contextSnapshotUpdatedAt = t.contextSnapshotUpdatedAt ? String(t.contextSnapshotUpdatedAt) : null
  return { threadId, agentId, createdAt, updatedAt, lastMessageAt, taskId, status, tags, routing, context, contextSnapshot, contextSnapshotUpdatedAt, messages }
}

export function readStore(file = DEFAULT_FILE) {
  try {
    if (!fs.existsSync(file)) return { threads: [] }
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const arr = Array.isArray(raw?.threads) ? raw.threads : []
    return { threads: arr.map(migrateThread) }
  } catch {
    return { threads: [] }
  }
}

function acquireLock(lockFile) {
  const start = Date.now()
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx')
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }))
      } catch {}
      return fd
    } catch {
      try {
        const stat = fs.statSync(lockFile)
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockFile)
          continue
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error('thread store lock timeout')
      }
      const until = Date.now() + LOCK_RETRY_MS
      while (Date.now() < until) {}
    }
  }
}

function releaseLock(fd, lockFile) {
  try { fs.closeSync(fd) } catch {}
  try { fs.unlinkSync(lockFile) } catch {}
}

export function atomicWriteStore(store, file = DEFAULT_FILE) {
  ensureDir(file)
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`
  const lockFile = `${file}.lock`
  const fd = acquireLock(lockFile)
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf-8')
    fs.renameSync(tmpFile, file)
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile) } catch {}
    releaseLock(fd, lockFile)
  }
}

export function writeStoreQueued(mutator, file = DEFAULT_FILE) {
  // Keep the queue alive even if a previous write failed.
  writeQueue = writeQueue.catch(() => undefined).then(() => {
    const store = readStore(file)
    const next = mutator(store)
    atomicWriteStore(next, file)
    return next
  })
  return writeQueue
}

export function upsertThreadMessage({ agentId, text, role = 'user', taskId, status, tags, routing, meta }, file = DEFAULT_FILE) {
  const safeRole = (role === 'agent' || role === 'system' || role === 'tool') ? role : 'user'
  const now = nowIso()
  const normalizedStatus = (status === 'pending' || status === 'failed') ? status : 'committed'
  const message = {
    id: `${Date.now()}-${rand()}`,
    role: safeRole,
    text: String(text || '').trim(),
    createdAt: now,
    taskId: taskId ? String(taskId) : undefined,
    status: normalizedStatus,
    meta: meta && typeof meta === 'object' ? meta : undefined,
  }

  if (!message.text || !agentId) throw new Error('agentId and text required')

  return writeStoreQueued((store) => {
    const threads = Array.isArray(store?.threads) ? store.threads.map(migrateThread) : []
    const normalizedTaskId = taskId ? String(taskId) : undefined
    const threadId = toThreadId(String(agentId), normalizedTaskId)
    const idx = threads.findIndex(t => t.threadId === threadId)
    if (idx === -1) {
      const messages = [message]
      threads.push({
        threadId,
        agentId: String(agentId),
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        taskId: normalizedTaskId,
        status: normalizeThreadStatus(status, 'active'),
        tags: normalizeTags(tags),
        routing: normalizeRouting(routing),
        context: deriveContext(messages),
        contextSnapshot: message.meta?.taskContext && typeof message.meta.taskContext === 'object' ? message.meta.taskContext : null,
        contextSnapshotUpdatedAt: message.meta?.taskContext && typeof message.meta.taskContext === 'object' ? message.createdAt : null,
        messages,
      })
    } else {
      const t = threads[idx]
      const messages = [...(t.messages || []), message]
      t.messages = messages
      t.updatedAt = now
      t.lastMessageAt = now
      if (status) t.status = normalizeThreadStatus(status, t.status || 'active')
      if (Array.isArray(tags)) t.tags = normalizeTags(tags)
      if (routing) t.routing = normalizeRouting({ ...(t.routing || {}), ...routing })
      if (message.meta?.taskContext && typeof message.meta.taskContext === 'object') {
        t.contextSnapshot = message.meta.taskContext
        t.contextSnapshotUpdatedAt = message.createdAt
      }
      t.context = deriveContext(messages)
      threads[idx] = migrateThread(t)
    }
    return { threads }
  }, file)
}

export function updateThreadMeta({ agentId, taskId, status, tags, appendTag }, file = DEFAULT_FILE) {
  if (!agentId) throw new Error('agentId required')
  const now = nowIso()

  return writeStoreQueued((store) => {
    const threads = Array.isArray(store?.threads) ? store.threads.map(migrateThread) : []
    const normalizedTaskId = taskId ? String(taskId) : undefined
    const threadId = toThreadId(String(agentId), normalizedTaskId)
    const idx = threads.findIndex(t => t.threadId === threadId)

    if (idx === -1) {
      const nextTags = normalizeTags([
        ...(Array.isArray(tags) ? tags : []),
        ...(appendTag ? [appendTag] : []),
      ])
      threads.push({
        threadId,
        agentId: String(agentId),
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        taskId: normalizedTaskId,
        status: normalizeThreadStatus(status, 'active'),
        tags: nextTags,
        routing: normalizeRouting(undefined),
        context: deriveContext([]),
        messages: [],
      })
      return { threads }
    }

    const t = threads[idx]
    if (status) t.status = normalizeThreadStatus(status, t.status || 'active')
    if (Array.isArray(tags)) t.tags = normalizeTags(tags)
    if (appendTag) t.tags = normalizeTags([...(t.tags || []), appendTag])
    t.updatedAt = now
    threads[idx] = migrateThread(t)
    return { threads }
  }, file)
}

export function getThread({ agentId, taskId }, file = DEFAULT_FILE) {
  const store = readStore(file)
  if (!agentId) return null
  const threadId = toThreadId(String(agentId), taskId ? String(taskId) : undefined)
  return store.threads.find(t => t.threadId === threadId) || null
}

export function listThreads(file = DEFAULT_FILE) {
  return readStore(file)
}
