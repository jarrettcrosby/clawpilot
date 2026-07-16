import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/persistence/postgres'

const TARGET_SYSTEM = 'agent_runtime'
const AGGREGATE_TYPE = 'agent_task'
const WORKER_HEARTBEAT_KEY = 'agent.dispatch.worker.heartbeat'

export type AgentDispatchTrigger = 'assignment' | 'comment' | 'continuation'
export type AgentDispatchStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'dead'

export type AgentDispatchEnqueueInput = {
  dispatchId: string
  idempotencyKey: string
  operatorId: string
  boardId: string
  taskId: string
  agentId: string
  text: string
  trigger: AgentDispatchTrigger
  continuationDepth?: number
  queuedAt: string
}

export type AgentDispatchOutboxItem = AgentDispatchEnqueueInput & {
  attempts: number
  lockToken: string
}

export type AgentDispatchWorkerHeartbeat = {
  checkedAt: string
  phase: 'started' | 'completed'
  workerId: string
  claimed: number
  succeeded: number
  failed: number
  dead: number
}

type OutboxRow = {
  id: string
  idempotency_key: string
  payload: Partial<AgentDispatchEnqueueInput>
  attempts: number
  lock_token: string
}

type SettingRow<T> = { value: T }

function clean(value: unknown): string {
  return String(value || '').trim()
}

function requireDispatchInput(input: AgentDispatchEnqueueInput): AgentDispatchEnqueueInput {
  const dispatchId = clean(input.dispatchId)
  const idempotencyKey = clean(input.idempotencyKey)
  const operatorId = clean(input.operatorId).toLowerCase()
  const boardId = clean(input.boardId)
  const taskId = clean(input.taskId)
  const agentId = clean(input.agentId)
  const text = clean(input.text)
  const continuationDepth = Math.max(0, Math.min(Math.trunc(Number(input.continuationDepth) || 0), 8))
  const queuedAt = clean(input.queuedAt) || new Date().toISOString()
  if (!dispatchId || !idempotencyKey || !operatorId || !boardId || !taskId || !agentId || !text) {
    throw new Error('Agent dispatch requires dispatch, operator, board, task, agent, and text values')
  }
  if (!['assignment', 'comment', 'continuation'].includes(input.trigger)) {
    throw new Error('Agent dispatch trigger is invalid')
  }
  return {
    dispatchId,
    idempotencyKey,
    operatorId,
    boardId,
    taskId,
    agentId,
    text,
    trigger: input.trigger,
    continuationDepth,
    queuedAt,
  }
}

function payloadFor(input: AgentDispatchEnqueueInput) {
  return {
    dispatchId: input.dispatchId,
    idempotencyKey: input.idempotencyKey,
    operatorId: input.operatorId,
    boardId: input.boardId,
    taskId: input.taskId,
    agentId: input.agentId,
    text: input.text,
    trigger: input.trigger,
    continuationDepth: input.continuationDepth || 0,
    queuedAt: input.queuedAt,
  }
}

export async function insertAgentDispatchOutbox(
  client: PoolClient,
  rawInput: AgentDispatchEnqueueInput,
): Promise<{ id: string; status: AgentDispatchStatus }> {
  const input = requireDispatchInput(rawInput)
  const result = await client.query<{ id: string; status: AgentDispatchStatus }>(
    `
      INSERT INTO sync_outbox (
        id,
        aggregate_type,
        aggregate_id,
        operation,
        target_system,
        payload,
        status,
        idempotency_key,
        created_at,
        available_at,
        updated_at
      )
      VALUES ($1::uuid, $2, $3, 'run_agent', $4, $5::jsonb, 'queued', $6, $7::timestamptz, $7::timestamptz, $7::timestamptz)
      ON CONFLICT (target_system, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = sync_outbox.updated_at
      RETURNING id::text, status
    `,
    [
      input.dispatchId,
      AGGREGATE_TYPE,
      input.taskId,
      TARGET_SYSTEM,
      JSON.stringify(payloadFor(input)),
      input.idempotencyKey,
      input.queuedAt,
    ],
  )

  await client.query(
    `
      INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
      VALUES ($1, 'agent.dispatch.queued', $2, $3, $4::jsonb)
    `,
    [
      input.operatorId,
      AGGREGATE_TYPE,
      input.taskId,
      JSON.stringify({ dispatchId: result.rows[0].id, agentId: input.agentId, boardId: input.boardId, trigger: input.trigger }),
    ],
  )
  return result.rows[0]
}

export async function enqueueAgentDispatchInPostgres(input: AgentDispatchEnqueueInput) {
  return withTransaction((client) => insertAgentDispatchOutbox(client, input))
}

export async function claimAgentDispatchOutboxInPostgres(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
} = {}): Promise<AgentDispatchOutboxItem[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 1), 5))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 10))
  const leaseSeconds = Math.max(60, Math.min(Math.trunc(Number(input.leaseSeconds) || 300), 900))
  const lockToken = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE sync_outbox
        SET status = 'failed',
            attempts = LEAST(attempts, GREATEST($1 - 1, 0)),
            last_error = COALESCE(last_error, 'agent worker lease expired'),
            available_at = now(),
            processed_at = NULL,
            locked_at = NULL,
            lock_token = NULL,
            updated_at = now()
        WHERE target_system = $2
          AND aggregate_type = $3
          AND status = 'processing'
          AND (locked_at IS NULL OR locked_at < now() - ($4::text || ' seconds')::interval)
      `,
      [maxAttempts, TARGET_SYSTEM, AGGREGATE_TYPE, leaseSeconds],
    )

    const result = await client.query<OutboxRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM sync_outbox
          WHERE target_system = $2
            AND aggregate_type = $3
            AND operation = 'run_agent'
            AND status IN ('queued', 'failed')
            AND attempts < $4
            AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE sync_outbox AS outbox
        SET status = 'processing',
            attempts = outbox.attempts + 1,
            locked_at = now(),
            lock_token = $5,
            updated_at = now()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id::text, outbox.idempotency_key, outbox.payload, outbox.attempts, outbox.lock_token
      `,
      [limit, TARGET_SYSTEM, AGGREGATE_TYPE, maxAttempts, lockToken],
    )

    return result.rows.map((row) => {
      const normalized = requireDispatchInput({
        dispatchId: row.id,
        idempotencyKey: row.idempotency_key,
        operatorId: String(row.payload.operatorId || ''),
        boardId: String(row.payload.boardId || ''),
        taskId: String(row.payload.taskId || ''),
        agentId: String(row.payload.agentId || ''),
        text: String(row.payload.text || ''),
        trigger: row.payload.trigger as AgentDispatchTrigger,
        continuationDepth: Number(row.payload.continuationDepth || 0),
        queuedAt: String(row.payload.queuedAt || ''),
      })
      return { ...normalized, attempts: row.attempts, lockToken: row.lock_token }
    })
  })
}

export async function completeAgentDispatchOutboxInPostgres(item: AgentDispatchOutboxItem): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      `
        UPDATE sync_outbox
        SET status = 'succeeded',
            last_error = NULL,
            processed_at = now(),
            locked_at = NULL,
            lock_token = NULL,
            updated_at = now()
        WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2
      `,
      [item.dispatchId, item.lockToken],
    )
    if (result.rowCount !== 1) throw new Error(`Agent dispatch lease lost for ${item.dispatchId}`)
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'agent.dispatch.succeeded', $2, $3, $4::jsonb)`,
      [item.operatorId, AGGREGATE_TYPE, item.taskId, JSON.stringify({ dispatchId: item.dispatchId, attempts: item.attempts })],
    )
  })
}

export async function failAgentDispatchOutboxInPostgres(input: {
  item: AgentDispatchOutboxItem
  error: string
  maxAttempts?: number
  retryBaseSeconds?: number
}): Promise<'failed' | 'dead'> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 10))
  const retryBaseSeconds = Math.max(5, Math.min(Math.trunc(Number(input.retryBaseSeconds) || 30), 1800))
  const status = input.item.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.item.attempts - 1)), 1800)
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  const error = clean(input.error).slice(0, 4000) || 'Agent execution failed'

  await withTransaction(async (client) => {
    const result = await client.query(
      `
        UPDATE sync_outbox
        SET status = $3,
            last_error = $4,
            available_at = $5::timestamptz,
            processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
            locked_at = NULL,
            lock_token = NULL,
            updated_at = now()
        WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2
      `,
      [input.item.dispatchId, input.item.lockToken, status, error, availableAt],
    )
    if (result.rowCount !== 1) throw new Error(`Agent dispatch lease lost for ${input.item.dispatchId}`)
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.item.operatorId,
        `agent.dispatch.${status}`,
        AGGREGATE_TYPE,
        input.item.taskId,
        JSON.stringify({ dispatchId: input.item.dispatchId, attempts: input.item.attempts, error, availableAt: status === 'failed' ? availableAt : null }),
      ],
    )
  })
  return status
}

export async function recordAgentDispatchWorkerHeartbeatInPostgres(
  input: Omit<AgentDispatchWorkerHeartbeat, 'checkedAt'>,
): Promise<AgentDispatchWorkerHeartbeat> {
  const heartbeat = { ...input, checkedAt: new Date().toISOString() }
  await query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat)],
  )
  return heartbeat
}

export async function readAgentDispatchWorkerHeartbeatFromPostgres(): Promise<AgentDispatchWorkerHeartbeat | null> {
  const result = await query<SettingRow<AgentDispatchWorkerHeartbeat>>('SELECT value FROM app_settings WHERE key = $1', [WORKER_HEARTBEAT_KEY])
  return result.rows[0]?.value || null
}
