import crypto from 'crypto'
import { query, withTransaction } from '@/lib/persistence/postgres'

const TARGET_SYSTEM = 'agent_research'
const AGGREGATE_TYPE = 'agent_research'
const OPERATION = 'web_search'
const WORKER_HEARTBEAT_KEY = 'agent.research.worker.heartbeat'

export type AgentResearchCitation = {
  url: string
  title?: string
}

export type AgentResearchEnqueueInput = {
  jobId: string
  continuationDispatchId: string
  originDispatchId: string
  operatorId: string
  boardId: string
  taskId: string
  agentId: 'projects'
  query: string
  continuationDepth: number
  queuedAt: string
}

export type AgentResearchOutboxItem = AgentResearchEnqueueInput & {
  attempts: number
  lockToken: string
}

export type AgentResearchEvidence = {
  jobId: string
  operatorId: string
  boardId: string
  taskId: string
  agentId: 'projects'
  query: string
  resultText: string
  citations: AgentResearchCitation[]
  provider: string
  model?: string
  createdAt: string
}

export type AgentResearchWorkerHeartbeat = {
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
  payload: Partial<AgentResearchEnqueueInput>
  attempts: number
  lock_token: string
}

type EvidenceRow = {
  job_id: string
  operator_id: string
  board_id: string
  task_id: string
  agent_id: string
  query: string
  result_text: string
  citations: unknown
  provider: string
  model: string | null
  created_at: string
}

type SettingRow<T> = { value: T }

function clean(value: unknown, limit = 4000): string {
  return String(value || '').trim().slice(0, limit)
}

function requireUuid(value: unknown, label: string): string {
  const normalized = clean(value, 100)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`${label} must be a UUID`)
  }
  return normalized
}

function normalizeCitations(value: unknown): AgentResearchCitation[] {
  if (!Array.isArray(value)) return []
  const citations = new Map<string, AgentResearchCitation>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const url = clean(record.url, 2000)
    if (!/^https:\/\//i.test(url)) continue
    citations.set(url, { url, title: clean(record.title, 300) || undefined })
  }
  return [...citations.values()].slice(0, 30)
}

function normalizeInput(input: AgentResearchEnqueueInput): AgentResearchEnqueueInput {
  const operatorId = clean(input.operatorId, 320).toLowerCase()
  const boardId = requireUuid(input.boardId, 'Research board')
  const taskId = clean(input.taskId, 200)
  const queryText = clean(input.query, 2000)
  if (!operatorId || !taskId || !queryText) {
    throw new Error('Agent research requires operator, task, and query values')
  }
  if (input.agentId !== 'projects') throw new Error('Public research is restricted to the Projects agent')
  return {
    jobId: requireUuid(input.jobId, 'Research job'),
    continuationDispatchId: requireUuid(input.continuationDispatchId, 'Research continuation dispatch'),
    originDispatchId: requireUuid(input.originDispatchId, 'Research origin dispatch'),
    operatorId,
    boardId,
    taskId,
    agentId: 'projects',
    query: queryText,
    continuationDepth: Math.max(0, Math.min(Math.trunc(Number(input.continuationDepth) || 0), 8)),
    queuedAt: clean(input.queuedAt, 100) || new Date().toISOString(),
  }
}

function payloadFor(input: AgentResearchEnqueueInput) {
  return { ...input }
}

export async function enqueueAgentResearchInPostgres(rawInput: AgentResearchEnqueueInput) {
  const input = normalizeInput(rawInput)
  const idempotencyKey = `agent-research:${input.originDispatchId}`
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string; status: string }>(
      `
        INSERT INTO sync_outbox (
          id, aggregate_type, aggregate_id, operation, target_system, payload,
          status, idempotency_key, created_at, available_at, updated_at
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'queued', $7, $8::timestamptz, $8::timestamptz, $8::timestamptz)
        ON CONFLICT (target_system, idempotency_key)
        WHERE idempotency_key IS NOT NULL
        DO UPDATE SET updated_at = sync_outbox.updated_at
        RETURNING id::text, status
      `,
      [
        input.jobId,
        AGGREGATE_TYPE,
        input.taskId,
        OPERATION,
        TARGET_SYSTEM,
        JSON.stringify(payloadFor(input)),
        idempotencyKey,
        input.queuedAt,
      ],
    )
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       SELECT $1, 'agent.research.queued', $2, $3, $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_events
         WHERE event_type = 'agent.research.queued'
           AND aggregate_type = $2
           AND aggregate_id = $3
           AND payload->>'jobId' = $5
       )`,
      [
        input.operatorId,
        AGGREGATE_TYPE,
        input.taskId,
        JSON.stringify({ jobId: result.rows[0].id, agentId: input.agentId, boardId: input.boardId }),
        result.rows[0].id,
      ],
    )
    return result.rows[0]
  })
}

export async function claimAgentResearchOutboxInPostgres(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
} = {}): Promise<AgentResearchOutboxItem[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 1), 3))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 4), 8))
  const leaseSeconds = Math.max(120, Math.min(Math.trunc(Number(input.leaseSeconds) || 600), 1800))
  const lockToken = crypto.randomUUID()
  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE sync_outbox
        SET status = 'failed',
            attempts = LEAST(attempts, GREATEST($1 - 1, 0)),
            last_error = COALESCE(last_error, 'research worker lease expired'),
            available_at = now(), processed_at = NULL, locked_at = NULL, lock_token = NULL, updated_at = now()
        WHERE target_system = $2 AND aggregate_type = $3 AND operation = $4
          AND status = 'processing'
          AND (locked_at IS NULL OR locked_at < now() - ($5::text || ' seconds')::interval)
      `,
      [maxAttempts, TARGET_SYSTEM, AGGREGATE_TYPE, OPERATION, leaseSeconds],
    )
    const result = await client.query<OutboxRow>(
      `
        WITH candidates AS (
          SELECT id FROM sync_outbox
          WHERE target_system = $2 AND aggregate_type = $3 AND operation = $4
            AND status IN ('queued', 'failed') AND attempts < $5 AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE sync_outbox AS outbox
        SET status = 'processing', attempts = outbox.attempts + 1,
            locked_at = now(), lock_token = $6, updated_at = now()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id::text, outbox.idempotency_key, outbox.payload, outbox.attempts, outbox.lock_token
      `,
      [limit, TARGET_SYSTEM, AGGREGATE_TYPE, OPERATION, maxAttempts, lockToken],
    )
    return result.rows.map((row) => ({
      ...normalizeInput({
        jobId: row.id,
        continuationDispatchId: String(row.payload.continuationDispatchId || ''),
        originDispatchId: String(row.payload.originDispatchId || ''),
        operatorId: String(row.payload.operatorId || ''),
        boardId: String(row.payload.boardId || ''),
        taskId: String(row.payload.taskId || ''),
        agentId: 'projects',
        query: String(row.payload.query || ''),
        continuationDepth: Number(row.payload.continuationDepth || 0),
        queuedAt: String(row.payload.queuedAt || ''),
      }),
      attempts: row.attempts,
      lockToken: row.lock_token,
    }))
  })
}

export async function saveAgentResearchEvidenceInPostgres(input: {
  item: AgentResearchOutboxItem
  resultText: string
  citations: AgentResearchCitation[]
  provider: string
  model?: string
}) {
  const resultText = clean(input.resultText, 50_000)
  if (!resultText) throw new Error('Agent research returned no evidence')
  await query(
    `
      INSERT INTO agent_research_evidence (
        job_id, operator_id, board_id, task_id, agent_id, query,
        result_text, citations, provider, model, created_at
      )
      VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9, $10, now())
      ON CONFLICT (job_id) DO UPDATE SET
        result_text = EXCLUDED.result_text,
        citations = EXCLUDED.citations,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model
    `,
    [
      input.item.jobId,
      input.item.operatorId,
      input.item.boardId,
      input.item.taskId,
      input.item.agentId,
      input.item.query,
      resultText,
      JSON.stringify(normalizeCitations(input.citations)),
      clean(input.provider, 80),
      clean(input.model, 120) || null,
    ],
  )
}

export async function completeAgentResearchOutboxInPostgres(item: AgentResearchOutboxItem): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sync_outbox
       SET status = 'succeeded', last_error = NULL, processed_at = now(),
           locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [item.jobId, item.lockToken],
    )
    if (result.rowCount !== 1) throw new Error(`Agent research lease lost for ${item.jobId}`)
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'agent.research.succeeded', $2, $3, $4::jsonb)`,
      [item.operatorId, AGGREGATE_TYPE, item.taskId, JSON.stringify({ jobId: item.jobId, attempts: item.attempts })],
    )
  })
}

export async function failAgentResearchOutboxInPostgres(input: {
  item: AgentResearchOutboxItem
  error: string
  maxAttempts?: number
  retryBaseSeconds?: number
}): Promise<'failed' | 'dead'> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 4), 8))
  const retryBaseSeconds = Math.max(15, Math.min(Math.trunc(Number(input.retryBaseSeconds) || 60), 1800))
  const status = input.item.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.item.attempts - 1)), 1800)
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  const error = clean(input.error, 4000) || 'Agent research failed'
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE sync_outbox
       SET status = $3, last_error = $4, available_at = $5::timestamptz,
           processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
           locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [input.item.jobId, input.item.lockToken, status, error, availableAt],
    )
    if (result.rowCount !== 1) throw new Error(`Agent research lease lost for ${input.item.jobId}`)
    await client.query(
      `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.item.operatorId,
        `agent.research.${status}`,
        AGGREGATE_TYPE,
        input.item.taskId,
        JSON.stringify({ jobId: input.item.jobId, attempts: input.item.attempts, error, availableAt: status === 'failed' ? availableAt : null }),
      ],
    )
  })
  return status
}

function toEvidence(row: EvidenceRow): AgentResearchEvidence {
  return {
    jobId: row.job_id,
    operatorId: row.operator_id,
    boardId: row.board_id,
    taskId: row.task_id,
    agentId: 'projects',
    query: row.query,
    resultText: row.result_text,
    citations: normalizeCitations(row.citations),
    provider: row.provider,
    model: row.model || undefined,
    createdAt: row.created_at,
  }
}

export async function readAgentResearchEvidenceFromPostgres(input: {
  operatorId: string
  boardId: string
  taskId: string
  agentId: string
  limit?: number
}): Promise<AgentResearchEvidence[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 3), 5))
  const result = await query<EvidenceRow>(
    `SELECT job_id::text, operator_id, board_id::text, task_id, agent_id, query,
            result_text, citations, provider, model, created_at::text
     FROM agent_research_evidence
     WHERE operator_id = $1 AND board_id = $2::uuid AND task_id = $3 AND agent_id = $4
     ORDER BY created_at DESC, id DESC
     LIMIT $5`,
    [clean(input.operatorId, 320).toLowerCase(), input.boardId, clean(input.taskId, 200), clean(input.agentId, 80), limit],
  )
  return result.rows.map(toEvidence)
}

export async function recordAgentResearchWorkerHeartbeatInPostgres(
  input: Omit<AgentResearchWorkerHeartbeat, 'checkedAt'>,
): Promise<AgentResearchWorkerHeartbeat> {
  const heartbeat = { ...input, checkedAt: new Date().toISOString() }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat)],
  )
  return heartbeat
}

export async function readAgentResearchWorkerHeartbeatFromPostgres(): Promise<AgentResearchWorkerHeartbeat | null> {
  const result = await query<SettingRow<AgentResearchWorkerHeartbeat>>(
    'SELECT value FROM app_settings WHERE key = $1',
    [WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}
