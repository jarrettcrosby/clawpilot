import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'

export type ExecutionLogRecord = Record<string, unknown>

type PayloadRow = {
  payload: ExecutionLogRecord
}

type CountRow = {
  count: string
}

type IntegritySummary = {
  status: 'ok'
  lines: number
  malformed: 0
}

export function isPostgresExecutionStoreEnabled(): boolean {
  return isPostgresStorageEnabled()
}

function cleanString(value: unknown): string | null {
  const out = String(value || '').trim()
  return out || null
}

function safeIso(value: unknown): string | null {
  const raw = cleanString(value)
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function createdAtFor(entry: ExecutionLogRecord): string {
  return safeIso(entry.timestamp)
    || safeIso(entry.completedAt)
    || safeIso(entry.finishedAt)
    || safeIso(entry.startedAt)
    || safeIso(entry.createdAt)
    || new Date().toISOString()
}

function statusFor(entry: ExecutionLogRecord): string {
  return cleanString(entry.status) || cleanString(entry.executionStatus) || 'unknown'
}

function resultTypeFor(entry: ExecutionLogRecord): string {
  return cleanString(entry.resultType) || cleanString(entry.type) || 'execution-result'
}

function limitFor(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 5
  return Math.max(1, Math.min(Math.trunc(parsed), 20))
}

export async function appendExecutionRunToPostgres(entry: ExecutionLogRecord): Promise<void> {
  await query(
    `
      INSERT INTO execution_runs (
        task_id,
        agent_id,
        status,
        started_at,
        finished_at,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::timestamptz)
    `,
    [
      cleanString(entry.taskId),
      cleanString(entry.agentId),
      statusFor(entry),
      safeIso(entry.startedAt),
      safeIso(entry.completedAt) || safeIso(entry.finishedAt),
      JSON.stringify(entry),
      createdAtFor(entry),
    ],
  )
}

export async function appendExecutionResultToPostgres(entry: ExecutionLogRecord): Promise<void> {
  await query(
    `
      INSERT INTO execution_results (
        task_id,
        agent_id,
        result_type,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
    `,
    [
      cleanString(entry.taskId),
      cleanString(entry.agentId),
      resultTypeFor(entry),
      JSON.stringify(entry),
      createdAtFor(entry),
    ],
  )
}

export async function listExecutionRunsFromPostgres(input: {
  taskId?: string | null
  runId?: string | null
  limit?: number
}): Promise<ExecutionLogRecord[]> {
  const clauses: string[] = []
  const values: unknown[] = []

  if (cleanString(input.runId)) {
    values.push(cleanString(input.runId))
    clauses.push(`payload->>'runId' = $${values.length}`)
  }

  if (cleanString(input.taskId)) {
    values.push(cleanString(input.taskId))
    clauses.push(`task_id = $${values.length}`)
  }

  if (clauses.length === 0) return []

  values.push(limitFor(input.limit))
  const result = await query<PayloadRow>(
    `
      SELECT payload
      FROM execution_runs
      WHERE ${clauses.join(' OR ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `,
    values,
  )

  return result.rows.map((row) => row.payload)
}

export async function listExecutionResultsFromPostgres(input: {
  taskId: string
  limit?: number
}): Promise<ExecutionLogRecord[]> {
  const result = await query<PayloadRow>(
    `
      SELECT payload
      FROM execution_results
      WHERE task_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [input.taskId, limitFor(input.limit)],
  )

  return result.rows.map((row) => row.payload)
}

async function summarize(tableName: 'execution_runs' | 'execution_results') {
  const countResult = await query<CountRow>(`SELECT COUNT(*)::text AS count FROM ${tableName}`)
  const lastResult = await query<PayloadRow>(
    `
      SELECT payload
      FROM ${tableName}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
  )

  return {
    count: Number(countResult.rows[0]?.count || 0),
    last: lastResult.rows[0]?.payload || null,
  }
}

export async function summarizeExecutionRunsFromPostgres() {
  return summarize('execution_runs')
}

export async function summarizeExecutionResultsFromPostgres() {
  return summarize('execution_results')
}

export async function inspectExecutionTablesFromPostgres(): Promise<{
  runs: IntegritySummary
  results: IntegritySummary
}> {
  const [runs, results] = await Promise.all([
    summarizeExecutionRunsFromPostgres(),
    summarizeExecutionResultsFromPostgres(),
  ])

  return {
    runs: { status: 'ok', lines: runs.count, malformed: 0 },
    results: { status: 'ok', lines: results.count, malformed: 0 },
  }
}
