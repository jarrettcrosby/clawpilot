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

function toThreadId(agentId: string, taskId?: string) {
  return `thread_${agentId}_${taskId || 'general'}`
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

function normalizeThreadPayload(payload: unknown): PersistedAgentThread | null {
  if (!payload || typeof payload !== 'object') return null
  const thread = payload as Partial<PersistedAgentThread>
  const agentId = String(thread.agentId || '')
  if (!agentId) return null

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
    threadId: String(thread.threadId || toThreadId(agentId, taskId)),
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

export async function listThreadsFromPostgres(): Promise<{ threads: PersistedAgentThread[] }> {
  return withTransaction(async (client) => {
    const result = await client.query<{ payload: PersistedAgentThread }>(
      'SELECT payload FROM agent_threads ORDER BY updated_at DESC, thread_id ASC',
    )
    return {
      threads: result.rows
        .map((row) => normalizeThreadPayload(row.payload))
        .filter(Boolean) as PersistedAgentThread[],
    }
  })
}

export async function getThreadFromPostgres(input: { agentId: string; taskId?: string }): Promise<PersistedAgentThread | null> {
  const threadId = toThreadId(String(input.agentId || ''), input.taskId ? String(input.taskId) : undefined)
  return withTransaction(async (client) => {
    const result = await client.query<{ payload: PersistedAgentThread }>(
      'SELECT payload FROM agent_threads WHERE thread_id = $1',
      [threadId],
    )
    return normalizeThreadPayload(result.rows[0]?.payload)
  })
}

export async function upsertThreadMessageInPostgres(input: UpsertThreadMessageInput): Promise<PersistedAgentThread> {
  const agentId = String(input.agentId || '').trim()
  const text = String(input.text || '').trim()
  if (!agentId || !text) throw new Error('agentId and text required')

  const taskId = input.taskId ? String(input.taskId) : undefined
  const threadId = toThreadId(agentId, taskId)
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
    const existing = await client.query<{ payload: PersistedAgentThread }>(
      'SELECT payload FROM agent_threads WHERE thread_id = $1 FOR UPDATE',
      [threadId],
    )

    const current = normalizeThreadPayload(existing.rows[0]?.payload)
    const messages = [...(current?.messages || []), message]
    const contextSnapshot = message.meta?.taskContext && typeof message.meta.taskContext === 'object'
      ? message.meta.taskContext as Record<string, unknown>
      : current?.contextSnapshot || null
    const contextSnapshotUpdatedAt = message.meta?.taskContext && typeof message.meta.taskContext === 'object'
      ? message.createdAt
      : current?.contextSnapshotUpdatedAt || null

    const nextThread: PersistedAgentThread = {
      threadId,
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

    await client.query(
      `
        INSERT INTO agent_threads (
          thread_id,
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
        VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::jsonb)
        ON CONFLICT (thread_id) DO UPDATE SET
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
      `,
      [
        nextThread.threadId,
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

    await client.query(
      `
        INSERT INTO agent_thread_messages (
          id,
          thread_id,
          role,
          body,
          status,
          created_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb)
        ON CONFLICT (thread_id, id) DO UPDATE SET
          role = EXCLUDED.role,
          body = EXCLUDED.body,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          payload = EXCLUDED.payload
      `,
      [
        message.id,
        nextThread.threadId,
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

