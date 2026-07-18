import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { PoolClient, QueryResultRow } from 'pg'
import { query, withTransaction } from '@/lib/persistence/postgres'
import { effectiveUserPermissions, type AppUser } from '@/lib/users'

export const MEMBER_RELEASE_HISTORY_DAYS = 30
export const MAX_CHECKPOINT_ROWS = 100_000
export const MAX_CHECKPOINT_BYTES = 50 * 1024 * 1024
export const MAX_RETAINED_CHECKPOINTS = 20
export const CHECKPOINT_COOLDOWN_MINUTES = 5

export class ReleaseRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseRequestError'
  }
}

export class ReleasePermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleasePermissionError'
  }
}

export type ReleaseAccess = {
  historyScope: 'full' | 'last-30-days'
  historyDays: number | null
  manageBackups: boolean
}

export type ReleaseEntry = {
  id: string
  commitHash: string
  shortCommit: string
  environment: string
  branch: string | null
  deploymentId: string | null
  title: string
  summary: string
  features: string[]
  fixes: string[]
  source: 'deployment' | 'historical' | 'manual'
  deployedAt: string
  createdAt: string
  updatedAt: string
}

export type DataCheckpoint = {
  id: string
  releaseId: string | null
  createdBy: string | null
  label: string
  reason: string
  objectCounts: Record<string, number>
  checksum: string
  sizeBytes: number
  providerBackupStatus: 'not_verified' | 'verified' | 'failed'
  createdAt: string
}

export type ReleaseOverview = {
  access: ReleaseAccess
  releases: ReleaseEntry[]
  checkpoints?: DataCheckpoint[]
}

type ReleaseRow = QueryResultRow & {
  id: string
  commit_hash: string
  environment: string
  branch: string | null
  deployment_id: string | null
  title: string
  summary: string
  features: unknown
  fixes: unknown
  source: ReleaseEntry['source']
  deployed_at: string | Date
  created_at: string | Date
  updated_at: string | Date
}

type CheckpointRow = QueryResultRow & {
  id: string
  release_id: string | null
  created_by: string | null
  label: string
  reason: string
  object_counts: unknown
  checksum: string
  size_bytes: number
  provider_backup_status: DataCheckpoint['providerBackupStatus']
  created_at: string | Date
}

type SnapshotDataset = {
  key: string
  table: string
  optional?: boolean
  sql: string
}

const SNAPSHOT_DATASETS: SnapshotDataset[] = [
  {
    key: 'users',
    table: 'app_users',
    sql: `
      SELECT
        email, role, status, display_name, job_title, timezone, locale, permissions,
        invited_by, invited_at, activated_at, last_login_at, created_at, updated_at
      FROM app_users
      ORDER BY email
    `,
  },
  {
    key: 'projectBoards',
    table: 'project_boards',
    sql: `
      SELECT id, name, owner_email, is_default, created_at, updated_at
      FROM project_boards
      ORDER BY id
    `,
  },
  {
    key: 'projectBoardShares',
    table: 'project_board_members',
    sql: `
      SELECT board_id, user_email, access_role, shared_by, created_at, updated_at
      FROM project_board_members
      ORDER BY board_id, user_email
    `,
  },
  {
    key: 'tasks',
    table: 'tasks',
    sql: `
      SELECT
        id, title, status, priority, category, assigned_agent, due_date, created_at,
        updated_at, archived, archived_at, deleted_at, payload, payload_hash, source,
        inserted_at, board_id
      FROM tasks
      ORDER BY id
    `,
  },
  {
    key: 'taskActivity',
    table: 'task_activity',
    sql: `
      SELECT id, task_id, activity_type, actor, message, occurred_at, payload
      FROM task_activity
      ORDER BY task_id NULLS FIRST, occurred_at, id
    `,
  },
  {
    key: 'taskComments',
    table: 'task_comments',
    sql: `
      SELECT id, task_id, author, body, created_at, deleted_at, payload
      FROM task_comments
      ORDER BY task_id, id
    `,
  },
  {
    key: 'taskChecklistItems',
    table: 'task_checklist_items',
    sql: `
      SELECT id, task_id, text, done, assignee, agent_id, due_date, payload
      FROM task_checklist_items
      ORDER BY task_id, id
    `,
  },
  {
    key: 'pipelineSpaces',
    table: 'pipeline_spaces',
    sql: `
      SELECT
        id, name, owner_email, is_default, sheet_id, sync_enabled, projection,
        created_at, updated_at
      FROM pipeline_spaces
      ORDER BY id
    `,
  },
  {
    key: 'pipelineSpaceShares',
    table: 'pipeline_space_members',
    sql: `
      SELECT pipeline_id, user_email, access_role, shared_by, created_at, updated_at
      FROM pipeline_space_members
      ORDER BY pipeline_id, user_email
    `,
  },
  {
    key: 'documents',
    table: 'app_documents',
    sql: `
      SELECT
        id, owner_email, source_key, source, kind, status, title, slug, category,
        content, excerpt, tags, source_path, content_hash, board_id, pipeline_id,
        generated_at, created_at, updated_at
      FROM app_documents
      ORDER BY id
    `,
  },
  {
    key: 'shortLinks',
    table: 'short_links',
    optional: true,
    sql: `
      SELECT
        id, owner_email, source_app, slug, destination_url, title, tags,
        max_clicks, click_count, expires_at, disabled_at, last_clicked_at,
        created_at, updated_at, deleted_at
      FROM short_links
      ORDER BY id
    `,
  },
  {
    key: 'aiRadarItems',
    table: 'ai_radar_items',
    optional: true,
    sql: `
      SELECT
        id, source_key, source_name, source_url, item_url, title, summary,
        category, tags, published_at, discovered_at, updated_at
      FROM ai_radar_items
      ORDER BY id
    `,
  },
  {
    key: 'executionRuns',
    table: 'execution_runs',
    sql: `
      SELECT
        id, task_id, agent_id, operator_id, status, started_at, finished_at,
        payload, created_at
      FROM execution_runs
      ORDER BY id
    `,
  },
  {
    key: 'executionResults',
    table: 'execution_results',
    sql: `
      SELECT id, task_id, agent_id, operator_id, result_type, payload, created_at
      FROM execution_results
      ORDER BY id
    `,
  },
  {
    key: 'pipelineSheetSources',
    table: 'pipeline_sheet_sources',
    sql: `
      SELECT
        id, source_name, sheet_id, tab_name, role, owning_system, created_at, updated_at
      FROM pipeline_sheet_sources
      ORDER BY id
    `,
  },
  {
    key: 'pipelineSheetRows',
    table: 'pipeline_sheet_rows',
    sql: `
      SELECT
        id, sheet_id, tab_name, row_number, external_id, object_type, title,
        payload, sheet_values, sheet_hash, last_synced_at, last_sheet_updated_at,
        created_at, updated_at
      FROM pipeline_sheet_rows
      ORDER BY id
    `,
  },
  {
    key: 'syncOutbox',
    table: 'sync_outbox',
    sql: `
      SELECT
        id, aggregate_type, aggregate_id, operation, target_system, payload, status,
        attempts, last_error, idempotency_key, locked_at, lock_token, created_at,
        available_at, processed_at, updated_at
      FROM sync_outbox
      ORDER BY id
    `,
  },
  {
    key: 'auditEvents',
    table: 'audit_events',
    sql: `
      SELECT id, actor, event_type, aggregate_type, aggregate_id, payload, created_at
      FROM audit_events
      ORDER BY id
    `,
  },
  {
    key: 'agentThreads',
    table: 'agent_threads',
    optional: true,
    sql: `
      SELECT
        thread_id, agent_id, task_id, status, tags, routing, context, context_snapshot,
        created_at, updated_at, last_message_at, payload, operator_id
      FROM agent_threads
      ORDER BY thread_id
    `,
  },
  {
    key: 'agentThreadMessages',
    table: 'agent_thread_messages',
    optional: true,
    sql: `
      SELECT id, thread_id, role, body, status, created_at, payload, actor_operator_id
      FROM agent_thread_messages
      ORDER BY thread_id, created_at, id
    `,
  },
  {
    key: 'agentAssignments',
    table: 'agent_assignments',
    optional: true,
    sql: `
      SELECT task_id, agent_id, updated_at
      FROM agent_assignments
      ORDER BY task_id
    `,
  },
]

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function objectCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => Number.isInteger(entry[1]) && Number(entry[1]) >= 0)
      .map(([key, count]) => [key, Number(count)]),
  )
}

function toRelease(row: ReleaseRow): ReleaseEntry {
  return {
    id: row.id,
    commitHash: row.commit_hash,
    shortCommit: row.commit_hash.slice(0, 7),
    environment: row.environment,
    branch: row.branch,
    deploymentId: row.deployment_id,
    title: row.title,
    summary: row.summary,
    features: stringArray(row.features),
    fixes: stringArray(row.fixes),
    source: row.source,
    deployedAt: toIso(row.deployed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function toCheckpoint(row: CheckpointRow): DataCheckpoint {
  return {
    id: row.id,
    releaseId: row.release_id,
    createdBy: row.created_by,
    label: row.label,
    reason: row.reason,
    objectCounts: objectCounts(row.object_counts),
    checksum: row.checksum,
    sizeBytes: Number(row.size_bytes),
    providerBackupStatus: row.provider_backup_status,
    createdAt: toIso(row.created_at),
  }
}

export function releaseAccessFor(user: Pick<AppUser, 'role' | 'permissions'>): ReleaseAccess {
  const permissions = effectiveUserPermissions(user)
  const elevatedRole = user.role === 'owner' || user.role === 'admin'
  const fullHistory = elevatedRole && permissions.viewFullReleaseHistory
  const manageBackups = elevatedRole && permissions.manageBackups
  return {
    historyScope: fullHistory ? 'full' : 'last-30-days',
    historyDays: fullHistory ? null : MEMBER_RELEASE_HISTORY_DAYS,
    manageBackups,
  }
}

async function listReleases(fullHistory: boolean): Promise<ReleaseEntry[]> {
  const result = await query<ReleaseRow>(
    `
      SELECT
        id, commit_hash, environment, branch, deployment_id, title, summary,
        features, fixes, source, deployed_at, created_at, updated_at
      FROM (
        SELECT DISTINCT ON (environment, commit_hash)
          id, commit_hash, environment, branch, deployment_id, title, summary,
          features, fixes, source, deployed_at, created_at, updated_at
        FROM release_entries
        WHERE $1::boolean
          OR deployed_at >= now() - ($2::integer * interval '1 day')
        ORDER BY environment, commit_hash, deployed_at DESC, id DESC
      ) latest_deployments
      ORDER BY deployed_at DESC, id DESC
    `,
    [fullHistory, MEMBER_RELEASE_HISTORY_DAYS],
  )
  return result.rows.map(toRelease)
}

async function listCheckpoints(): Promise<DataCheckpoint[]> {
  const result = await query<CheckpointRow>(
    `
      SELECT
        id, release_id, created_by, label, reason, object_counts, checksum,
        size_bytes, provider_backup_status, created_at
      FROM data_checkpoints
      ORDER BY created_at DESC, id DESC
    `,
  )
  return result.rows.map(toCheckpoint)
}

export async function getReleaseOverview(user: AppUser): Promise<ReleaseOverview> {
  const access = releaseAccessFor(user)
  const releasesPromise = listReleases(access.historyScope === 'full')

  if (!access.manageBackups) {
    return { access, releases: await releasesPromise }
  }

  const [releases, checkpoints] = await Promise.all([releasesPromise, listCheckpoints()])
  return { access, releases, checkpoints }
}

export function getLocalReleaseOverview(): ReleaseOverview {
  const repositoryRoot = [
    process.env.CLAWPILOT_REPO_ROOT || '',
    process.cwd(),
    path.resolve(process.cwd(), '..'),
  ].find((candidate) => candidate && existsSync(path.join(candidate, '.git')))
    || process.cwd()
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim()
    const log = execFileSync(
      'git',
      ['log', '--max-count=30', '--format=%H%x1f%aI%x1f%s'],
      { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    const releases = log.trim().split('\n').filter(Boolean).map((line): ReleaseEntry => {
      const [commitHash, dateValue, subject] = line.split('\x1f')
      const deployedAt = new Date(dateValue).toISOString()
      return {
        id: `local-${commitHash}`,
        commitHash,
        shortCommit: commitHash.slice(0, 7),
        environment: 'local',
        branch: branch || null,
        deploymentId: null,
        title: subject || `Commit ${commitHash.slice(0, 7)}`,
        summary: `Local ClawPilot commit ${commitHash.slice(0, 7)}.`,
        features: [],
        fixes: [],
        source: 'historical',
        deployedAt,
        createdAt: deployedAt,
        updatedAt: deployedAt,
      }
    })
    return {
      access: { historyScope: 'full', historyDays: null, manageBackups: false },
      releases,
    }
  } catch {
    return {
      access: { historyScope: 'full', historyDays: null, manageBackups: false },
      releases: [],
    }
  }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ReleaseRequestError(`${label} is required`)
  const normalized = value.trim()
  if (!normalized) throw new ReleaseRequestError(`${label} is required`)
  if (normalized.length > maxLength) {
    throw new ReleaseRequestError(`${label} must be ${maxLength} characters or fewer`)
  }
  return normalized
}

function checkpointInput(value: unknown): { label: string; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseRequestError('Checkpoint request body is required')
  }
  const input = value as Record<string, unknown>
  return {
    label: requiredText(input.label, 'Label', 120),
    reason: requiredText(input.reason, 'Reason', 1000),
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return null
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

async function availableTables(client: PoolClient): Promise<Set<string>> {
  const tables = SNAPSHOT_DATASETS.map((dataset) => dataset.table)
  const result = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ANY(current_schemas(false))
        AND table_name = ANY($1::text[])
    `,
    [tables],
  )
  return new Set(result.rows.map((row) => row.table_name))
}

async function buildSnapshot(client: PoolClient) {
  const tables = await availableTables(client)
  const missing = SNAPSHOT_DATASETS
    .filter((dataset) => !dataset.optional && !tables.has(dataset.table))
    .map((dataset) => dataset.table)
  if (missing.length > 0) {
    throw new Error(`Checkpoint schema is incomplete: ${missing.join(', ')}`)
  }

  const objects: Record<string, QueryResultRow[]> = {}
  const counts: Record<string, number> = {}
  let estimatedBytes = 0

  for (const dataset of SNAPSHOT_DATASETS) {
    if (!tables.has(dataset.table)) continue
    const result = await client.query<{ count: string; size_bytes: string }>(
      `
        SELECT
          count(*)::text AS count,
          COALESCE(sum(octet_length(to_jsonb(checkpoint_row)::text)), 0)::text AS size_bytes
        FROM (
          ${dataset.sql}
        ) checkpoint_row
      `,
    )
    const count = Number(result.rows[0]?.count || 0)
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Checkpoint row count is invalid for ${dataset.table}`)
    const sizeBytes = Number(result.rows[0]?.size_bytes || 0)
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`Checkpoint size estimate is invalid for ${dataset.table}`)
    }
    counts[dataset.key] = count
    estimatedBytes += sizeBytes + count
  }
  const totalRows = Object.values(counts).reduce((total, count) => total + count, 0)
  if (totalRows > MAX_CHECKPOINT_ROWS) {
    throw new ReleaseRequestError(`Checkpoint exceeds the ${MAX_CHECKPOINT_ROWS.toLocaleString('en-US')} row limit`)
  }
  if (estimatedBytes > MAX_CHECKPOINT_BYTES) {
    throw new ReleaseRequestError(`Checkpoint exceeds the ${MAX_CHECKPOINT_BYTES / 1024 / 1024} MB size limit`)
  }

  for (const dataset of SNAPSHOT_DATASETS) {
    if (!tables.has(dataset.table)) continue
    const result = await client.query(dataset.sql)
    objects[dataset.key] = result.rows
    if (result.rows.length !== counts[dataset.key]) {
      throw new Error(`Checkpoint row count changed for ${dataset.table}`)
    }
  }

  return {
    snapshot: { schemaVersion: 1, objects },
    counts,
  }
}

function runtimeEnvironment(): string {
  const value = process.env.RELEASE_ENVIRONMENT
    || process.env.CLAWPILOT_RELEASE_ENVIRONMENT
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || 'unknown'
  return value.trim().toLowerCase().slice(0, 120) || 'unknown'
}

function runtimeCommit(): string | null {
  const value = process.env.RAILWAY_GIT_COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.GITHUB_SHA
    || process.env.RELEASE_COMMIT
    || ''
  return value.trim().length >= 7 ? value.trim().toLowerCase() : null
}

async function currentReleaseId(client: PoolClient): Promise<string | null> {
  const commit = runtimeCommit()
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM release_entries
      WHERE environment = $1
        AND ($2::text IS NULL OR commit_hash = $2)
      ORDER BY deployed_at DESC, id DESC
      LIMIT 1
    `,
    [runtimeEnvironment(), commit],
  )
  return result.rows[0]?.id || null
}

export async function createDataCheckpoint(user: AppUser, value: unknown): Promise<DataCheckpoint> {
  const access = releaseAccessFor(user)
  if (!access.manageBackups) {
    throw new ReleasePermissionError('Data checkpoint management requires manageBackups access')
  }
  const input = checkpointInput(value)

  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('clawpilot-data-checkpoint'))`)
    const recent = await client.query(
      `
        SELECT 1
        FROM data_checkpoints
        WHERE created_at > now() - ($1::integer * interval '1 minute')
        LIMIT 1
      `,
      [CHECKPOINT_COOLDOWN_MINUTES],
    )
    if (recent.rows[0]) {
      throw new ReleaseRequestError(`Wait ${CHECKPOINT_COOLDOWN_MINUTES} minutes between data checkpoints`)
    }
    const { snapshot, counts } = await buildSnapshot(client)
    const serialized = canonicalJson(snapshot)
    const checksum = createHash('sha256').update(serialized).digest('hex')
    const sizeBytes = Buffer.byteLength(serialized, 'utf8')
    if (sizeBytes > MAX_CHECKPOINT_BYTES) {
      throw new ReleaseRequestError(`Checkpoint exceeds the ${MAX_CHECKPOINT_BYTES / 1024 / 1024} MB size limit`)
    }

    const releaseId = await currentReleaseId(client)
    const result = await client.query<CheckpointRow>(
      `
        INSERT INTO data_checkpoints (
          release_id, created_by, label, reason, object_counts, snapshot,
          checksum, size_bytes, provider_backup_status, created_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'not_verified', now())
        RETURNING
          id, release_id, created_by, label, reason, object_counts, checksum,
          size_bytes, provider_backup_status, created_at
      `,
      [
        releaseId,
        user.email,
        input.label,
        input.reason,
        canonicalJson(counts),
        serialized,
        checksum,
        sizeBytes,
      ],
    )
    const checkpoint = toCheckpoint(result.rows[0])
    await client.query(
      `
        DELETE FROM data_checkpoints
        WHERE id IN (
          SELECT id
          FROM data_checkpoints
          ORDER BY created_at DESC, id DESC
          OFFSET $1
        )
      `,
      [MAX_RETAINED_CHECKPOINTS],
    )
    return checkpoint
  })
}
