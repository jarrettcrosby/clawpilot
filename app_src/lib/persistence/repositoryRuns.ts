import crypto from 'crypto'
import type { PoolClient } from 'pg'
import type { RepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'
import { applyCanonicalWorkItem } from '@/lib/workItemModel'
import type { Comment, Task } from '@/lib/types'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { upsertTaskWithClient } from '@/lib/persistence/tasks'

const TARGET_SYSTEM = 'repository_runner'
const AGGREGATE_TYPE = 'repository_run'
const OPERATION = 'dispatch_workflow'
const ACTIVE_STATUSES = ['queued', 'dispatching', 'dispatched', 'running'] as const
const TERMINAL_STATUSES = ['patch_ready', 'policy_rejected', 'failed', 'cancelled'] as const

export type RepositoryRunStatus = typeof ACTIVE_STATUSES[number] | typeof TERMINAL_STATUSES[number]

export type RepositoryRun = {
  id: string
  boardId: string
  taskId: string
  operatorEmail: string
  agentId: string
  repositoryFullName: string
  baseRef: string
  baseSha: string | null
  status: RepositoryRunStatus
  workflowRunId: string | null
  workflowUrl: string | null
  artifactUrl: string | null
  patchDigest: string | null
  changedPaths: string[]
  validationResult: Record<string, unknown>
  summary: string | null
  error: string | null
  attempts: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type RepositoryRunDispatch = RepositoryRun & {
  instruction: string
  bindingId: string
  githubRepositoryId: string
  githubInstallationId: string
  workflowFile: string
  outboxId: string
  lockToken: string
}

type RepositoryRunRow = {
  id: string
  binding_id: string
  board_id: string
  task_id: string
  operator_email: string
  agent_id: string
  instruction: string
  repository_full_name: string
  github_repository_id: string
  github_installation_id: string
  workflow_file: string
  base_ref: string
  base_sha: string | null
  status: RepositoryRunStatus
  workflow_run_id: string | null
  workflow_url: string | null
  artifact_url: string | null
  patch_digest: string | null
  changed_paths: unknown
  validation_result: unknown
  summary: string | null
  error: string | null
  attempts: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
  outbox_id?: string
  lock_token?: string
}

export class RepositoryRunConflictError extends Error {
  constructor(message = 'This task already has active work.') {
    super(message)
    this.name = 'RepositoryRunConflictError'
  }
}

function clean(value: unknown, limit = 12_000): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, limit)
}

function stringArray(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => clean(item, 500))
    .filter(Boolean)
    .slice(0, 200)
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toRepositoryRun(row: RepositoryRunRow): RepositoryRun {
  return {
    id: row.id,
    boardId: row.board_id,
    taskId: row.task_id,
    operatorEmail: row.operator_email,
    agentId: row.agent_id,
    repositoryFullName: row.repository_full_name,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    status: row.status,
    workflowRunId: row.workflow_run_id,
    workflowUrl: row.workflow_url,
    artifactUrl: row.artifact_url,
    patchDigest: row.patch_digest,
    changedPaths: stringArray(row.changed_paths),
    validationResult: objectValue(row.validation_result),
    summary: row.summary,
    error: row.error,
    attempts: Number(row.attempts || 0),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const RUN_SELECT = `
  SELECT
    run.*,
    binding.repository_full_name,
    binding.github_repository_id::text,
    binding.github_installation_id::text,
    binding.workflow_file
  FROM repository_runs run
  JOIN repository_bindings binding ON binding.id = run.binding_id
`

export async function latestRepositoryRunForTask(input: {
  boardId: string
  taskId: string
}): Promise<RepositoryRun | null> {
  const result = await query<RepositoryRunRow>(
    `${RUN_SELECT}
     WHERE run.board_id = $1::uuid AND run.task_id = $2
     ORDER BY run.created_at DESC, run.id DESC
     LIMIT 1`,
    [input.boardId, input.taskId],
  )
  return result.rows[0] ? toRepositoryRun(result.rows[0]) : null
}

async function ensureBinding(
  client: PoolClient,
  input: {
    boardId: string
    actorEmail: string
    configuration: RepositoryRunnerConfiguration
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO repository_bindings (
       board_id, github_repository_id, github_installation_id,
       repository_full_name, base_branch, workflow_file, enabled,
       created_by, created_at, updated_at
     )
     VALUES ($1::uuid, $2::bigint, $3::bigint, $4, $5, $6, true, $7, now(), now())
     ON CONFLICT (board_id) DO UPDATE SET
       github_repository_id = EXCLUDED.github_repository_id,
       github_installation_id = EXCLUDED.github_installation_id,
       repository_full_name = EXCLUDED.repository_full_name,
       base_branch = EXCLUDED.base_branch,
       workflow_file = EXCLUDED.workflow_file,
       enabled = true,
       updated_at = now()
     RETURNING id::text`,
    [
      input.boardId,
      input.configuration.repositoryId,
      input.configuration.installationId,
      input.configuration.repositoryFullName,
      input.configuration.baseBranch,
      input.configuration.workflowFile,
      input.actorEmail,
    ],
  )
  return result.rows[0].id
}

export async function createRepositoryRunInPostgres(input: {
  boardId: string
  actorEmail: string
  taskId: string
  instruction: string
  configuration: RepositoryRunnerConfiguration
}): Promise<RepositoryRun> {
  const instruction = clean(input.instruction)
  if (!instruction) throw new Error('A repository instruction is required')
  const runId = crypto.randomUUID()
  const outboxId = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`agent-dispatch:${input.boardId}:${input.taskId}`],
    )
    const taskResult = await client.query<{ payload: Task; assigned_agent: string | null }>(
      `SELECT payload, assigned_agent
       FROM tasks
       WHERE id = $1 AND board_id = $2::uuid AND archived = false AND deleted_at IS NULL
       FOR UPDATE`,
      [input.taskId, input.boardId],
    )
    const task = taskResult.rows[0]
    if (!task) throw new Error('Task was not found on this project board')
    const agentId = clean(task.assigned_agent, 80)
    if (!agentId) throw new Error('Assign the task to an agent before generating a repository patch')

    const activeAgent = await client.query<{ id: string }>(
      `SELECT id::text
       FROM sync_outbox
       WHERE target_system = 'agent_runtime'
         AND aggregate_type = 'agent_task'
         AND aggregate_id = $1
         AND payload->>'boardId' = $2
         AND status IN ('queued', 'processing', 'failed')
       LIMIT 1`,
      [input.taskId, input.boardId],
    )
    if (activeAgent.rows[0]) throw new RepositoryRunConflictError()

    const activeRun = await client.query<{ id: string }>(
      `SELECT id::text
       FROM repository_runs
       WHERE board_id = $1::uuid AND task_id = $2
         AND status = ANY($3::text[])
       LIMIT 1`,
      [input.boardId, input.taskId, [...ACTIVE_STATUSES]],
    )
    if (activeRun.rows[0]) throw new RepositoryRunConflictError('A repository patch is already running for this task.')

    const bindingId = await ensureBinding(client, input)
    const inserted = await client.query<RepositoryRunRow>(
      `INSERT INTO repository_runs (
         id, binding_id, board_id, task_id, operator_email, agent_id,
         instruction, base_ref, status, created_at, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'queued', now(), now())
       RETURNING *,
         $9::text AS repository_full_name,
         $10::text AS github_repository_id,
         $11::text AS github_installation_id,
         $12::text AS workflow_file`,
      [
        runId,
        bindingId,
        input.boardId,
        input.taskId,
        input.actorEmail,
        agentId,
        instruction,
        input.configuration.baseBranch,
        input.configuration.repositoryFullName,
        input.configuration.repositoryId,
        input.configuration.installationId,
        input.configuration.workflowFile,
      ],
    )

    await client.query(
      `INSERT INTO sync_outbox (
         id, aggregate_type, aggregate_id, operation, target_system,
         payload, status, idempotency_key, created_at, available_at, updated_at
       )
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'queued', $7, now(), now(), now())`,
      [
        outboxId,
        AGGREGATE_TYPE,
        runId,
        OPERATION,
        TARGET_SYSTEM,
        JSON.stringify({ runId, boardId: input.boardId, taskId: input.taskId }),
        `repository-run:${runId}`,
      ],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'agent.repository_run.queued',
      aggregateType: AGGREGATE_TYPE,
      aggregateId: runId,
      eventKey: `repository-run:${runId}:queued`,
      payload: {
        boardId: input.boardId,
        taskId: input.taskId,
        agentId,
        repository: input.configuration.repositoryFullName,
        baseRef: input.configuration.baseBranch,
      },
    }, client)
    return toRepositoryRun(inserted.rows[0])
  })
}

export async function claimRepositoryRunOutbox(input: {
  maxAttempts?: number
  leaseSeconds?: number
} = {}): Promise<RepositoryRunDispatch | null> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 10))
  const leaseSeconds = Math.max(60, Math.min(Math.trunc(Number(input.leaseSeconds) || 300), 900))
  const lockToken = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE sync_outbox
       SET status = 'failed',
           attempts = LEAST(attempts, GREATEST($1 - 1, 0)),
           last_error = COALESCE(last_error, 'repository runner lease expired'),
           available_at = now(), processed_at = NULL,
           locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE target_system = $2 AND aggregate_type = $3 AND operation = $4
         AND status = 'processing'
         AND (locked_at IS NULL OR locked_at < now() - ($5::text || ' seconds')::interval)`,
      [maxAttempts, TARGET_SYSTEM, AGGREGATE_TYPE, OPERATION, leaseSeconds],
    )
    const claimed = await client.query<{ id: string; aggregate_id: string; attempts: number; lock_token: string }>(
      `WITH candidate AS (
         SELECT id
         FROM sync_outbox
         WHERE target_system = $1 AND aggregate_type = $2 AND operation = $3
           AND status IN ('queued', 'failed') AND attempts < $4 AND available_at <= now()
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE sync_outbox outbox
       SET status = 'processing', attempts = outbox.attempts + 1,
           locked_at = now(), lock_token = $5, updated_at = now()
       FROM candidate
       WHERE outbox.id = candidate.id
       RETURNING outbox.id::text, outbox.aggregate_id, outbox.attempts, outbox.lock_token`,
      [TARGET_SYSTEM, AGGREGATE_TYPE, OPERATION, maxAttempts, lockToken],
    )
    const item = claimed.rows[0]
    if (!item) return null
    const runResult = await client.query<RepositoryRunRow>(
      `${RUN_SELECT}
       WHERE run.id = $1::uuid AND binding.enabled = true
       FOR UPDATE OF run`,
      [item.aggregate_id],
    )
    const row = runResult.rows[0]
    if (!row) throw new Error('Repository run binding is unavailable')
    await client.query(
      `UPDATE repository_runs
       SET status = 'dispatching', attempts = $2, updated_at = now()
       WHERE id = $1::uuid`,
      [row.id, item.attempts],
    )
    return {
      ...toRepositoryRun({ ...row, status: 'dispatching', attempts: item.attempts }),
      instruction: row.instruction,
      bindingId: row.binding_id,
      githubRepositoryId: row.github_repository_id,
      githubInstallationId: row.github_installation_id,
      workflowFile: row.workflow_file,
      outboxId: item.id,
      lockToken: item.lock_token,
    }
  })
}

export async function completeRepositoryRunDispatch(input: {
  item: RepositoryRunDispatch
  baseSha: string
}): Promise<void> {
  await withTransaction(async (client) => {
    const completed = await client.query(
      `UPDATE sync_outbox
       SET status = 'succeeded', processed_at = now(), last_error = NULL,
           locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [input.item.outboxId, input.item.lockToken],
    )
    if (completed.rowCount !== 1) throw new Error('Repository dispatch lease was lost')
    await client.query(
      `UPDATE repository_runs
       SET base_sha = $2, status = CASE WHEN status = 'running' THEN status ELSE 'dispatched' END,
           updated_at = now()
       WHERE id = $1::uuid`,
      [input.item.id, input.baseSha],
    )
    await recordAuditEvent({
      actor: 'repository-runner',
      subject: input.item.operatorEmail,
      isSystem: true,
      eventType: 'agent.repository_run.dispatched',
      aggregateType: AGGREGATE_TYPE,
      aggregateId: input.item.id,
      eventKey: `repository-run:${input.item.id}:dispatched`,
      payload: { boardId: input.item.boardId, taskId: input.item.taskId, baseSha: input.baseSha },
    }, client)
  })
}

export async function failRepositoryRunDispatch(input: {
  item: RepositoryRunDispatch
  error: string
  maxAttempts?: number
}): Promise<'failed' | 'dead'> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 10))
  const terminal = input.item.attempts >= maxAttempts
  const status = terminal ? 'dead' : 'failed'
  const message = clean(input.error, 1000) || 'Repository workflow dispatch failed'
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE sync_outbox
       SET status = $3, last_error = $4,
           available_at = CASE WHEN $3 = 'failed'
             THEN now() + (LEAST(300, 5 * power(2, GREATEST(attempts - 1, 0)))::text || ' seconds')::interval
             ELSE available_at END,
           processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
           locked_at = NULL, lock_token = NULL, updated_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
      [input.item.outboxId, input.item.lockToken, status, message],
    )
    await client.query(
      `UPDATE repository_runs
       SET status = $2, error = $3,
           finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1::uuid`,
      [input.item.id, terminal ? 'failed' : 'queued', message],
    )
    if (terminal) {
      await recordAuditEvent({
        actor: 'repository-runner',
        subject: input.item.operatorEmail,
        isSystem: true,
        eventType: 'agent.repository_run.failed',
        aggregateType: AGGREGATE_TYPE,
        aggregateId: input.item.id,
        eventKey: `repository-run:${input.item.id}:dispatch-failed`,
        payload: { boardId: input.item.boardId, taskId: input.item.taskId, error: message },
      }, client)
    }
  })
  return status
}

export type RepositoryRunReport = {
  status: 'running' | 'patch_ready' | 'policy_rejected' | 'failed'
  workflowRunId?: string
  workflowUrl?: string
  artifactUrl?: string
  patchDigest?: string
  changedPaths?: string[]
  validationResult?: Record<string, unknown>
  summary?: string
  error?: string
}

function transitionAllowed(current: RepositoryRunStatus, next: RepositoryRunReport['status']): boolean {
  if (current === next) return true
  if (TERMINAL_STATUSES.includes(current as typeof TERMINAL_STATUSES[number])) return false
  if (next === 'running') return ACTIVE_STATUSES.includes(current as typeof ACTIVE_STATUSES[number])
  return current === 'running' || current === 'dispatched' || current === 'dispatching'
}

function finalTaskComment(run: RepositoryRun, report: RepositoryRunReport, now: string): Comment {
  const link = report.artifactUrl || report.workflowUrl
  const changed = stringArray(report.changedPaths)
  const lines = [
    `Agent: ${run.agentId}`,
    `Repository patch: ${report.status === 'patch_ready' ? 'ready for review' : report.status.replaceAll('_', ' ')}`,
    report.summary ? `Summary: ${clean(report.summary, 1200)}` : null,
    changed.length > 0 ? `Changed paths: ${changed.join(', ')}` : null,
    link ? `Evidence: ${link}` : null,
    `Base: ${run.baseRef}${run.baseSha ? ` at ${run.baseSha.slice(0, 12)}` : ''}`,
    report.error ? `Error: ${clean(report.error, 1000)}` : null,
    report.status === 'patch_ready'
      ? 'Remaining: Review the validated patch artifact before authorizing any branch or pull request.'
      : 'Remaining: Review the repository-run evidence and decide whether to retry or revise the instruction.',
  ].filter(Boolean)
  return {
    id: `repository-run-${run.id}`,
    text: lines.join('\n'),
    author: run.agentId,
    createdAt: now,
    timestamp: now,
  }
}

async function writeFinalTaskEvidence(
  client: PoolClient,
  run: RepositoryRun,
  report: RepositoryRunReport,
  now: string,
): Promise<void> {
  const result = await client.query<{ payload: Task }>(
    'SELECT payload FROM tasks WHERE id = $1 AND board_id = $2::uuid FOR UPDATE',
    [run.taskId, run.boardId],
  )
  const task = result.rows[0]?.payload
  if (!task) return
  const comment = finalTaskComment(run, report, now)
  const comments = (task.comments || []).some((entry) => entry.id === comment.id)
    ? (task.comments || []).map((entry) => entry.id === comment.id ? comment : entry)
    : [...(task.comments || []), comment]
  const nextAction = report.status === 'patch_ready'
    ? 'Review the validated patch artifact before authorizing publication.'
    : 'Review the repository-run evidence and revise or retry the instruction.'
  const nextTask = applyCanonicalWorkItem({
    ...task,
    status: task.status === 'done' ? 'done' : 'review',
    comments,
    execution: {
      ...(task.execution || {}),
      executionStatus: report.status,
      lastUpdatedAt: now,
      latestExecutionNote: comment.text,
      lastResult: {
        type: 'repository-patch',
        status: report.status,
        summary: clean(report.summary, 1200),
        whatWasDone: report.status === 'patch_ready' ? 'Validated repository patch generated' : undefined,
        nextAction,
        blockedReason: report.status === 'patch_ready' ? undefined : clean(report.error || report.summary, 1000),
        repositoryRunId: run.id,
        repository: run.repositoryFullName,
        baseRef: run.baseRef,
        baseSha: run.baseSha,
        workflowUrl: report.workflowUrl,
        artifactUrl: report.artifactUrl,
        patchDigest: report.patchDigest,
        changedPaths: stringArray(report.changedPaths),
        validationResult: objectValue(report.validationResult),
        recordedAt: now,
      },
    },
    activity: [
      ...(task.activity || []),
      {
        type: 'updated',
        message: `Repository patch run ${report.status.replaceAll('_', ' ')}.`,
        timestamp: now,
        actor: run.agentId,
        taskId: task.id,
        taskTitle: task.title,
      },
    ],
    updatedAt: now,
    workItem: {
      ...(task.workItem || {
        status: task.status,
        activity: task.activity || [],
      }),
      nextAction,
      blocker: report.status === 'patch_ready' ? undefined : clean(report.error || report.summary, 1000),
    },
  })
  await upsertTaskWithClient(client, nextTask, run.boardId)
  await client.query(
    `INSERT INTO execution_results (
       operator_id, task_id, agent_id, result_type, payload, created_at
     )
     VALUES ($1, $2, $3, 'repository-patch', $4::jsonb, $5::timestamptz)`,
    [run.operatorEmail, run.taskId, run.agentId, JSON.stringify(nextTask.execution?.lastResult || {}), now],
  )
}

export async function applyRepositoryRunReportInPostgres(input: {
  runId: string
  report: RepositoryRunReport
}): Promise<RepositoryRun> {
  const now = new Date().toISOString()
  return withTransaction(async (client) => {
    const result = await client.query<RepositoryRunRow>(
      `${RUN_SELECT} WHERE run.id = $1::uuid FOR UPDATE OF run`,
      [input.runId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Repository run was not found')
    const current = toRepositoryRun(row)
    if (!transitionAllowed(current.status, input.report.status)) {
      throw new Error(`Repository run cannot transition from ${current.status} to ${input.report.status}`)
    }
    const terminal = input.report.status !== 'running'
    const workflowRunId = clean(input.report.workflowRunId, 30)
    if (workflowRunId && !/^[1-9][0-9]*$/.test(workflowRunId)) throw new Error('Workflow run ID is invalid')
    const patchDigest = clean(input.report.patchDigest, 64).toLowerCase()
    if (patchDigest && !/^[0-9a-f]{64}$/.test(patchDigest)) throw new Error('Patch digest is invalid')
    const changedPaths = stringArray(input.report.changedPaths)
    const validationResult = objectValue(input.report.validationResult)
    const updated = await client.query<RepositoryRunRow>(
      `UPDATE repository_runs
       SET status = $2,
           workflow_run_id = COALESCE($3::bigint, workflow_run_id),
           workflow_url = COALESCE(NULLIF($4, ''), workflow_url),
           artifact_url = COALESCE(NULLIF($5, ''), artifact_url),
           patch_digest = COALESCE(NULLIF($6, ''), patch_digest),
           changed_paths = CASE WHEN jsonb_array_length($7::jsonb) > 0 THEN $7::jsonb ELSE changed_paths END,
           validation_result = CASE WHEN $8::jsonb <> '{}'::jsonb THEN $8::jsonb ELSE validation_result END,
           summary = COALESCE(NULLIF($9, ''), summary),
           error = COALESCE(NULLIF($10, ''), error),
           started_at = COALESCE(started_at, CASE WHEN $2 = 'running' THEN now() ELSE NULL END),
           finished_at = CASE WHEN $11 THEN now() ELSE finished_at END,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING *,
         $12::text AS repository_full_name,
         $13::text AS github_repository_id,
         $14::text AS github_installation_id,
         $15::text AS workflow_file`,
      [
        input.runId,
        input.report.status,
        workflowRunId || null,
        clean(input.report.workflowUrl, 1000),
        clean(input.report.artifactUrl, 1000),
        patchDigest,
        JSON.stringify(changedPaths),
        JSON.stringify(validationResult),
        clean(input.report.summary, 4000),
        clean(input.report.error, 2000),
        terminal,
        current.repositoryFullName,
        row.github_repository_id,
        row.github_installation_id,
        row.workflow_file,
      ],
    )
    const run = toRepositoryRun(updated.rows[0])
    await recordAuditEvent({
      actor: 'repository-runner',
      subject: run.operatorEmail,
      isSystem: true,
      eventType: `agent.repository_run.${input.report.status}`,
      aggregateType: AGGREGATE_TYPE,
      aggregateId: run.id,
      eventKey: `repository-run:${run.id}:${input.report.status}`,
      payload: {
        boardId: run.boardId,
        taskId: run.taskId,
        workflowRunId: run.workflowRunId,
        changedPaths: run.changedPaths,
        patchDigest: run.patchDigest,
      },
    }, client)
    if (terminal && !TERMINAL_STATUSES.includes(current.status as typeof TERMINAL_STATUSES[number])) {
      await writeFinalTaskEvidence(client, run, input.report, now)
    }
    return run
  })
}
