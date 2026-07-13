import crypto from 'crypto'
import { withTransaction } from '@/lib/persistence/postgres'

export type PersistedThreadMessage = {
  id: string
  role: 'user' | 'agent' | 'system' | 'tool'
  text: string
  createdAt: string
  taskId?: string
  status: 'committed' | 'pending' | 'failed'
  meta?: Record<string, unknown>
}

export type PersistedAgentThread = {
  threadId: string
  operatorId: string
  agentId: string
  createdAt: string
  updatedAt: string
  lastMessageAt: string
  taskId?: string
  status: 'active' | 'resolving' | 'blocked' | 'closed'
  tags: string[]
  routing: {
    responder: string
    channel: string
    priority: string
  }
  context: {
    summary: string | null
    lastUserMessageId: string | null
    messageCount: number
    tokenEstimate: number
  }
  contextSnapshot?: Record<string, unknown> | null
  contextSnapshotUpdatedAt?: string | null
  messages: PersistedThreadMessage[]
}

type UpsertThreadMessageInput = {
  operatorId: string
  agentId: string
  text: string
  role?: string
  taskId?: string
  status?: string
  tags?: string[]
  routing?: Partial<PersistedAgentThread['routing']>
  meta?: Record<string, unknown>
}

function nowIso() {
  return new Date().toISOString()
}

function rand() {
  return Math.random().toString(36).slice(2, 8)
}

function normalizeOperatorId(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function requireOperatorId(value: unknown): string {
  const operatorId = normalizeOperatorId(value)
  if (!operatorId) throw new Error('operatorId required')
  return operatorId
}

function toThreadId(operatorId: string, agentId: string, taskId?: string) {
  const operatorHash = crypto.createHash('sha256').update(operatorId).digest('hex').slice(0, 12)
  return `thread_op_${operatorHash}_${agentId}_${taskId || 'general'}`
}

function normalizeThreadStatus(status: unknown, fallback: PersistedAgentThread['status'] = 'active'): PersistedAgentThread['status'] {
  const safe = String(status || '').trim().toLowerCase()
  if (safe === 'active' || safe === 'resolving' || safe === 'blocked' || safe === 'closed') return safe
  return fallback
}

function normalizeMessageRole(role: unknown): PersistedThreadMessage['role'] {
  const safe = String(role || '').trim().toLowerCase()
  if (safe === 'agent' || safe === 'system' || safe === 'tool') return safe
  return 'user'
}

function normalizeMessageStatus(status: unknown): PersistedThreadMessage['status'] {
  const safe = String(status || '').trim().toLowerCase()
  if (safe === 'pending' || safe === 'failed') return safe
  return 'committed'
}

function normalizeRouting(routing?: Partial<PersistedAgentThread['routing']>): PersistedAgentThread['routing'] {
  return {
    responder: String(routing?.responder || 'stub'),
    channel: String(routing?.channel || 'internal'),
    priority: String(routing?.priority || 'normal'),
  }
}

function normalizeTags(tags: unknown): string[] {
  return Array.from(new Set((Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function deriveContext(messages: PersistedThreadMessage[]): PersistedAgentThread['context'] {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const tokenEstimate = messages.reduce((total, message) => (
    total + Math.max(1, Math.ceil(String(message.text || '').length / 4))
  ), 0)

  return {
    summary: null,
    lastUserMessageId: lastUser?.id || null,
    messageCount: messages.length,
    tokenEstimate,
  }
}

function normalizeThreadPayload(payload: unknown, storedOperatorId?: unknown): PersistedAgentThread | null {
  if (!payload || typeof payload !== 'object') return null
  const thread = payload as Partial<PersistedAgentThread>
  const operatorId = normalizeOperatorId(storedOperatorId ?? thread.operatorId)
  const agentId = String(thread.agentId || '')
  if (!operatorId || !agentId) return null

  const taskId = thread.taskId ? String(thread.taskId) : undefined
  const messages = Array.isArray(thread.messages)
    ? thread.messages.map((message) => {
      const m = (message && typeof message === 'object' ? message : {}) as Partial<PersistedThreadMessage>
      return {
        id: String(m.id || `${Date.now()}-${rand()}`),
        role: normalizeMessageRole(m.role),
        text: String(m.text || ''),
        createdAt: String(m.createdAt || nowIso()),
        taskId: m.taskId ? String(m.taskId) : taskId,
        status: normalizeMessageStatus(m.status),
        meta: m.meta && typeof m.meta === 'object' ? m.meta as Record<string, unknown> : undefined,
      }
    })
    : []
  const createdAt = String(thread.createdAt || thread.updatedAt || nowIso())
  const updatedAt = String(thread.updatedAt || createdAt)
  const lastMessageAt = String(thread.lastMessageAt || messages[messages.length - 1]?.createdAt || updatedAt)

  return {
    threadId: String(thread.threadId || toThreadId(operatorId, agentId, taskId)),
    operatorId,
    agentId,
    createdAt,
    updatedAt,
    lastMessageAt,
    taskId,
    status: normalizeThreadStatus(thread.status),
    tags: normalizeTags(thread.tags),
    routing: normalizeRouting(thread.routing),
    context: thread.context && typeof thread.context === 'object'
      ? {
        summary: typeof thread.context.summary === 'string' ? thread.context.summary : null,
        lastUserMessageId: typeof thread.context.lastUserMessageId === 'string' ? thread.context.lastUserMessageId : null,
        messageCount: Number.isFinite(thread.context.messageCount) ? Number(thread.context.messageCount) : messages.length,
        tokenEstimate: Number.isFinite(thread.context.tokenEstimate) ? Number(thread.context.tokenEstimate) : deriveContext(messages).tokenEstimate,
      }
      : deriveContext(messages),
    contextSnapshot: thread.contextSnapshot && typeof thread.contextSnapshot === 'object'
      ? thread.contextSnapshot as Record<string, unknown>
      : null,
    contextSnapshotUpdatedAt: thread.contextSnapshotUpdatedAt ? String(thread.contextSnapshotUpdatedAt) : null,
    messages,
  }
}

export async function listThreadsFromPostgres(input: { operatorId: string }): Promise<{ threads: PersistedAgentThread[] }> {
  const operatorId = requireOperatorId(input.operatorId)
  return withTransaction(async (client) => {
    const result = await client.query<{ operator_id: string; payload: PersistedAgentThread }>(
      'SELECT operator_id, payload FROM agent_threads WHERE operator_id = $1 ORDER BY updated_at DESC, thread_id ASC',
      [operatorId],
    )
    return {
      threads: result.rows
        .map((row) => normalizeThreadPayload(row.payload, row.operator_id))
        .filter(Boolean) as PersistedAgentThread[],
    }
  })
}

export async function getThreadFromPostgres(input: { operatorId: string; agentId: string; taskId?: string }): Promise<PersistedAgentThread | null> {
  const operatorId = requireOperatorId(input.operatorId)
  const threadId = toThreadId(operatorId, String(input.agentId || ''), input.taskId ? String(input.taskId) : undefined)
  return withTransaction(async (client) => {
    const result = await client.query<{ operator_id: string; payload: PersistedAgentThread }>(
      'SELECT operator_id, payload FROM agent_threads WHERE thread_id = $1 AND operator_id = $2',
      [threadId, operatorId],
    )
    return normalizeThreadPayload(result.rows[0]?.payload, result.rows[0]?.operator_id)
  })
}

export async function upsertThreadMessageInPostgres(input: UpsertThreadMessageInput): Promise<PersistedAgentThread> {
  const operatorId = requireOperatorId(input.operatorId)
  const agentId = String(input.agentId || '').trim()
  const text = String(input.text || '').trim()
  if (!agentId || !text) throw new Error('agentId and text required')

  const taskId = input.taskId ? String(input.taskId) : undefined
  const threadId = toThreadId(operatorId, agentId, taskId)
  const createdAt = nowIso()
  const message: PersistedThreadMessage = {
    id: `${Date.now()}-${rand()}`,
    role: normalizeMessageRole(input.role),
    text,
    createdAt,
    taskId,
    status: normalizeMessageStatus(input.status),
    meta: input.meta && typeof input.meta === 'object' ? input.meta : undefined,
  }

  return withTransaction(async (client) => {
    const existing = await client.query<{ operator_id: string; payload: PersistedAgentThread }>(
      'SELECT operator_id, payload FROM agent_threads WHERE thread_id = $1 AND operator_id = $2 FOR UPDATE',
      [threadId, operatorId],
    )

    const current = normalizeThreadPayload(existing.rows[0]?.payload, existing.rows[0]?.operator_id)
    const messages = [...(current?.messages || []), message]
    const contextSnapshot = message.meta?.taskContext && typeof message.meta.taskContext === 'object'
      ? message.meta.taskContext as Record<string, unknown>
      : current?.contextSnapshot || null
    const contextSnapshotUpdatedAt = message.meta?.taskContext && typeof message.meta.taskContext === 'object'
      ? message.createdAt
      : current?.contextSnapshotUpdatedAt || null

    const nextThread: PersistedAgentThread = {
      threadId,
      operatorId,
      agentId,
      createdAt: current?.createdAt || createdAt,
      updatedAt: createdAt,
      lastMessageAt: createdAt,
      taskId,
      status: normalizeThreadStatus(input.status, current?.status || 'active'),
      tags: Array.isArray(input.tags) ? normalizeTags(input.tags) : (current?.tags || []),
      routing: normalizeRouting({ ...(current?.routing || {}), ...(input.routing || {}) }),
      context: deriveContext(messages),
      contextSnapshot,
      contextSnapshotUpdatedAt,
      messages,
    }

    const threadWrite = await client.query<{ thread_id: string }>(
      `
        INSERT INTO agent_threads (
          thread_id,
          operator_id,
          agent_id,
          task_id,
          status,
          tags,
          routing,
          context,
          context_snapshot,
          created_at,
          updated_at,
          last_message_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz, $11::timestamptz, $12::timestamptz, $13::jsonb)
        ON CONFLICT (thread_id) DO UPDATE SET
          operator_id = EXCLUDED.operator_id,
          agent_id = EXCLUDED.agent_id,
          task_id = EXCLUDED.task_id,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          routing = EXCLUDED.routing,
          context = EXCLUDED.context,
          context_snapshot = EXCLUDED.context_snapshot,
          updated_at = EXCLUDED.updated_at,
          last_message_at = EXCLUDED.last_message_at,
          payload = EXCLUDED.payload
        WHERE agent_threads.operator_id = EXCLUDED.operator_id
        RETURNING thread_id
      `,
      [
        nextThread.threadId,
        nextThread.operatorId,
        nextThread.agentId,
        nextThread.taskId || null,
        nextThread.status,
        nextThread.tags,
        JSON.stringify(nextThread.routing),
        JSON.stringify(nextThread.context),
        nextThread.contextSnapshot ? JSON.stringify(nextThread.contextSnapshot) : null,
        nextThread.createdAt,
        nextThread.updatedAt,
        nextThread.lastMessageAt,
        JSON.stringify(nextThread),
      ],
    )
    if (threadWrite.rowCount !== 1) throw new Error('Thread ownership conflict')

    await client.query(
      `
        INSERT INTO agent_thread_messages (
          id,
          thread_id,
          actor_operator_id,
          role,
          body,
          status,
          created_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
        ON CONFLICT (thread_id, id) DO UPDATE SET
          actor_operator_id = EXCLUDED.actor_operator_id,
          role = EXCLUDED.role,
          body = EXCLUDED.body,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          payload = EXCLUDED.payload
      `,
      [
        message.id,
        nextThread.threadId,
        operatorId,
        message.role,
        message.text,
        message.status,
        message.createdAt,
        JSON.stringify(message),
      ],
    )

    return nextThread
  })
}
