import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'

export const DEFAULT_PIPELINE_SHEET_ID = process.env.PIPELINE_SHEET_ID || '1sp-eLYEEGera1acBoze_GvR4263dunlmaOUyBej-iqY'
const OPPORTUNITIES_TAB = 'Opportunities'
const DROPDOWNS_TAB = process.env.PIPELINE_DROPDOWN_TAB || 'Dropdowns'
const PIPELINE_SETTING_KEY = 'pipeline.normalized.current'
const DROPDOWN_SETTING_KEY = 'pipeline.dropdowns.current'
const OUTBOX_WORKER_HEARTBEAT_KEY = 'pipeline.outbox.worker.heartbeat'

export type PipelineOpportunityRecord = Record<string, unknown>
export type PipelineProjection = {
  syncedAt: string | null
  source?: unknown
  summary: Record<string, unknown>
  opportunities: PipelineOpportunityRecord[]
}

export type PipelineDropdownOption = {
  value: string
  label: string
  active: boolean
  sort_order: number
}

export type PipelineDropdownCatalog = {
  syncedAt: string
  source: 'app' | 'sheet'
  dropdowns: Record<string, PipelineDropdownOption[]>
}

export type PipelineOutboxItem = {
  id: string
  aggregateType: string
  aggregateId: string
  operation: string
  payload: Record<string, unknown>
  attempts: number
  lockToken: string
}

export type PipelineOutboxWorkerHeartbeat = {
  checkedAt: string
  phase: 'started' | 'completed'
  workerId: string
  claimed: number
  succeeded: number
  failed: number
  dead: number
}

type SettingRow<T> = {
  value: T
}

type PipelineRow = {
  payload: PipelineOpportunityRecord
  last_synced_at: string | null
}

type CountByStatusRow = {
  status: string
  count: string
}

type OutboxInsertRow = {
  id: string
  status: string
}

type PendingOutboxRow = OutboxInsertRow & {
  payload: Record<string, unknown>
}

type OutboxClaimRow = {
  id: string
  aggregate_type: string
  aggregate_id: string
  operation: string
  payload: Record<string, unknown>
  attempts: number
  lock_token: string
}

type OutboxAgeRow = {
  oldest_pending_at: string | null
}

type EnqueueInput = {
  aggregateType: string
  aggregateId: string
  operation: string
  payload: Record<string, unknown>
  actor?: string
  idempotencyKey?: string
}

export function isPostgresPipelineStoreEnabled(): boolean {
  return isPostgresStorageEnabled()
}

function nowIso() {
  return new Date().toISOString()
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

function toFiniteNumber(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function opportunityRowNumber(opportunity: PipelineOpportunityRecord, index: number): number {
  const explicit = Number(opportunity.rowNumber || opportunity.sheetRowNumber || opportunity._rowNumber)
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit)

  const idMatch = String(opportunity.id || '').match(/^opp_(\d+)$/)
  if (idMatch) return 4 + Number(idMatch[1])

  return 5 + index
}

function opportunityExternalId(opportunity: PipelineOpportunityRecord, index: number): string {
  return cleanString(opportunity.id) || `opp_${index + 1}`
}

function sheetValuesForOpportunity(opportunity: PipelineOpportunityRecord): unknown[] {
  return [
    opportunity.priority || '',
    opportunity.name || '',
    opportunity.owner || '',
    opportunity.organization || opportunity.org || '',
    opportunity.status || '',
    opportunity.stage || '',
    opportunity.lossReason || '',
    opportunity.source || '',
    opportunity.valueRaw || opportunity.value || '',
    opportunity.probability || '',
    opportunity.closeDate || opportunity.expectedClose || '',
    opportunity.notes || '',
  ]
}

function hashPayload(payload: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function summarizeOpportunities(opportunities: PipelineOpportunityRecord[]) {
  const closed = new Set(['abandoned', 'loss', 'closed', 'closed-lost'])
  return {
    opportunities: opportunities.length,
    organizations: new Set(opportunities.map((opp) => cleanString(opp.organization) || cleanString(opp.org)).filter(Boolean)).size,
    contacts: 0,
    totalOpenValue: Math.round(opportunities
      .filter((opp) => !closed.has(String(opp.status || '').toLowerCase()))
      .reduce((total, opp) => total + toFiniteNumber(opp.value, 0), 0) * 100) / 100,
  }
}

function normalizeProjection(input: unknown): PipelineProjection {
  const data = input && typeof input === 'object' ? input as Partial<PipelineProjection> : {}
  const opportunities = Array.isArray(data.opportunities)
    ? data.opportunities.map((opportunity, index) => ({
        ...(opportunity && typeof opportunity === 'object' ? opportunity : {}),
        id: opportunityExternalId(opportunity && typeof opportunity === 'object' ? opportunity : {}, index),
      } as PipelineOpportunityRecord))
    : []

  return {
    syncedAt: safeIso(data.syncedAt) || nowIso(),
    source: data.source || null,
    summary: data.summary && typeof data.summary === 'object'
      ? data.summary as Record<string, unknown>
      : summarizeOpportunities(opportunities),
    opportunities,
  }
}

function normalizeDropdownCatalog(input: unknown): PipelineDropdownCatalog {
  const data = input && typeof input === 'object' ? input as Partial<PipelineDropdownCatalog> : {}
  const rawDropdowns = data.dropdowns && typeof data.dropdowns === 'object' ? data.dropdowns : {}
  const dropdowns = Object.fromEntries(Object.entries(rawDropdowns).map(([key, options]) => {
    const normalized = Array.isArray(options)
      ? options.map((option, index) => {
          const value = cleanString(option?.value) || cleanString(option?.label) || ''
          return {
            value,
            label: cleanString(option?.label) || value,
            active: option?.active !== false,
            sort_order: toFiniteNumber(option?.sort_order, index),
          }
        }).filter((option) => option.value)
      : []
    return [key, normalized]
  }))

  return {
    syncedAt: safeIso(data.syncedAt) || nowIso(),
    source: data.source === 'app' ? 'app' : 'sheet',
    dropdowns,
  }
}

async function upsertSetting(client: PoolClient, key: string, value: unknown) {
  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
    `,
    [key, JSON.stringify(value)],
  )
}

async function upsertPipelineProjection(client: PoolClient, projection: PipelineProjection) {
  const syncedAt = projection.syncedAt || nowIso()

  await client.query(
    `
      INSERT INTO pipeline_sheet_sources (
        source_name,
        sheet_id,
        tab_name,
        role,
        owning_system,
        updated_at
      )
      VALUES ('default-pipeline', $1, $2, 'pipeline_projection', 'google_sheets', now())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        role = EXCLUDED.role,
        owning_system = EXCLUDED.owning_system,
        updated_at = EXCLUDED.updated_at
    `,
    [DEFAULT_PIPELINE_SHEET_ID, OPPORTUNITIES_TAB],
  )

  await upsertSetting(client, PIPELINE_SETTING_KEY, projection)

  const retainedRows: number[] = []
  for (let index = 0; index < projection.opportunities.length; index++) {
    const opportunity = projection.opportunities[index]
    const rowNumber = opportunityRowNumber(opportunity, index)
    const externalId = opportunityExternalId(opportunity, index)
    const sheetValues = sheetValuesForOpportunity(opportunity)
    retainedRows.push(rowNumber)

    await client.query(
      `
        INSERT INTO pipeline_sheet_rows (
          sheet_id,
          tab_name,
          row_number,
          external_id,
          object_type,
          title,
          payload,
          sheet_values,
          sheet_hash,
          last_synced_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'opportunity', $5, $6::jsonb, $7::jsonb, $8, $9::timestamptz, now())
        ON CONFLICT (sheet_id, tab_name, row_number) DO UPDATE SET
          external_id = EXCLUDED.external_id,
          object_type = EXCLUDED.object_type,
          title = EXCLUDED.title,
          payload = EXCLUDED.payload,
          sheet_values = EXCLUDED.sheet_values,
          sheet_hash = EXCLUDED.sheet_hash,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        DEFAULT_PIPELINE_SHEET_ID,
        OPPORTUNITIES_TAB,
        rowNumber,
        externalId,
        cleanString(opportunity.name),
        JSON.stringify(opportunity),
        JSON.stringify(sheetValues),
        hashPayload({ opportunity, sheetValues }),
        syncedAt,
      ],
    )
  }

  if (retainedRows.length > 0) {
    await client.query(
      `
        DELETE FROM pipeline_sheet_rows
        WHERE sheet_id = $1
          AND tab_name = $2
          AND object_type = 'opportunity'
          AND NOT (row_number = ANY($3::integer[]))
      `,
      [DEFAULT_PIPELINE_SHEET_ID, OPPORTUNITIES_TAB, retainedRows],
    )
  } else {
    await client.query(
      `
        DELETE FROM pipeline_sheet_rows
        WHERE sheet_id = $1
          AND tab_name = $2
          AND object_type = 'opportunity'
      `,
      [DEFAULT_PIPELINE_SHEET_ID, OPPORTUNITIES_TAB],
    )
  }
}

async function insertPipelineOutbox(client: PoolClient, input: EnqueueInput): Promise<OutboxInsertRow> {
  const idempotencyKey = cleanString(input.idempotencyKey)
  if (idempotencyKey) {
    const existing = await client.query<OutboxInsertRow>(
      `
        SELECT id::text, status
        FROM sync_outbox
        WHERE target_system = 'google_sheets'
          AND idempotency_key = $1
        LIMIT 1
      `,
      [idempotencyKey],
    )
    if (existing.rows[0]) return existing.rows[0]
  }

  let payload = input.payload
  let supersededIds: string[] = []
  const targetRange = cleanString(input.payload.range)
  if (input.operation === 'update_opportunity' && targetRange) {
    const pending = await client.query<PendingOutboxRow>(
      `
        SELECT id::text, status, payload
        FROM sync_outbox
        WHERE target_system = 'google_sheets'
          AND aggregate_type = $1
          AND aggregate_id = $2
          AND operation = $3
          AND status IN ('queued', 'failed')
          AND payload->>'range' = $4
        ORDER BY created_at ASC
        FOR UPDATE
      `,
      [input.aggregateType, input.aggregateId, input.operation, targetRange],
    )

    if (pending.rows.length > 0) {
      const earliestPayload = pending.rows[0].payload || {}
      payload = {
        ...input.payload,
        before: earliestPayload.before ?? input.payload.before,
        beforeValues: earliestPayload.beforeValues ?? input.payload.beforeValues,
      }
      supersededIds = pending.rows.map((row) => row.id)
    }
  }

  const result = await client.query<OutboxInsertRow>(
    `
      INSERT INTO sync_outbox (
        aggregate_type,
        aggregate_id,
        operation,
        target_system,
        payload,
        status,
        attempts,
        idempotency_key,
        updated_at
      )
      VALUES ($1, $2, $3, 'google_sheets', $4::jsonb, 'queued', 0, $5, now())
      ON CONFLICT (target_system, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET updated_at = sync_outbox.updated_at
      RETURNING id::text, status
    `,
    [
      input.aggregateType,
      input.aggregateId,
      input.operation,
      JSON.stringify(payload),
      idempotencyKey,
    ],
  )

  const row = result.rows[0]
  if (!row) throw new Error('Unable to enqueue pipeline sync operation')

  if (supersededIds.length > 0) {
    await client.query(
      `
        UPDATE sync_outbox
        SET status = 'dead',
            last_error = $2,
            processed_at = now(),
            updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND status IN ('queued', 'failed')
      `,
      [supersededIds, `superseded by newer outbox item ${row.id}`],
    )
  }

  await client.query(
    `
      INSERT INTO audit_events (
        actor,
        event_type,
        aggregate_type,
        aggregate_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [
      cleanString(input.actor),
      `pipeline.sync.${input.operation}.${row.status}`,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify({
        outboxId: row.id,
        targetSystem: 'google_sheets',
        idempotencyKey,
      }),
    ],
  )

  return row
}

export async function upsertPipelineProjectionInPostgres(input: unknown): Promise<PipelineProjection> {
  const projection = normalizeProjection(input)
  await withTransaction((client) => upsertPipelineProjection(client, projection))
  return projection
}

export async function upsertPipelineProjectionAndEnqueueInPostgres(input: {
  projection: unknown
  outbox: EnqueueInput
}): Promise<{ projection: PipelineProjection; outboxId: string; outboxStatus: string }> {
  const projection = normalizeProjection(input.projection)
  const outbox = await withTransaction(async (client) => {
    await upsertPipelineProjection(client, projection)
    return insertPipelineOutbox(client, input.outbox)
  })

  return { projection, outboxId: outbox.id, outboxStatus: outbox.status }
}

export async function readPipelineProjectionFromPostgres(): Promise<PipelineProjection | null> {
  const setting = await query<SettingRow<PipelineProjection>>(
    'SELECT value FROM app_settings WHERE key = $1',
    [PIPELINE_SETTING_KEY],
  )
  const rows = await query<PipelineRow>(
    `
      SELECT payload, last_synced_at::text
      FROM pipeline_sheet_rows
      WHERE sheet_id = $1
        AND tab_name = $2
        AND object_type = 'opportunity'
      ORDER BY row_number ASC
    `,
    [DEFAULT_PIPELINE_SHEET_ID, OPPORTUNITIES_TAB],
  )

  if (setting.rows.length === 0 && rows.rows.length === 0) return null

  const settingProjection = setting.rows[0]?.value || null
  const rowOpportunities = rows.rows.map((row) => row.payload)
  const opportunities = rowOpportunities.length > 0
    ? rowOpportunities
    : (Array.isArray(settingProjection?.opportunities) ? settingProjection.opportunities : [])
  const fallbackSyncedAt = rows.rows
    .map((row) => safeIso(row.last_synced_at))
    .filter(Boolean)
    .sort()
    .at(-1) || null

  return {
    syncedAt: settingProjection?.syncedAt || fallbackSyncedAt,
    source: settingProjection?.source || null,
    summary: settingProjection?.summary || summarizeOpportunities(opportunities),
    opportunities,
  }
}

export async function upsertPipelineDropdownCatalogInPostgres(input: unknown): Promise<PipelineDropdownCatalog> {
  const catalog = normalizeDropdownCatalog(input)
  await withTransaction((client) => upsertPipelineDropdownCatalog(client, catalog))
  return catalog
}

async function upsertPipelineDropdownCatalog(client: PoolClient, catalog: PipelineDropdownCatalog) {
  await client.query(
    `
      INSERT INTO pipeline_sheet_sources (
        source_name,
        sheet_id,
        tab_name,
        role,
        owning_system,
        updated_at
      )
      VALUES ('default-pipeline-dropdowns', $1, $2, 'dropdown_catalog', 'google_sheets', now())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        role = EXCLUDED.role,
        owning_system = EXCLUDED.owning_system,
        updated_at = EXCLUDED.updated_at
    `,
    [DEFAULT_PIPELINE_SHEET_ID, DROPDOWNS_TAB],
  )
  await upsertSetting(client, DROPDOWN_SETTING_KEY, catalog)
}

export async function upsertPipelineDropdownCatalogAndEnqueueInPostgres(input: {
  catalog: unknown
  outbox: EnqueueInput
}): Promise<{ catalog: PipelineDropdownCatalog; outboxId: string; outboxStatus: string }> {
  const catalog = normalizeDropdownCatalog(input.catalog)
  const outbox = await withTransaction(async (client) => {
    await upsertPipelineDropdownCatalog(client, catalog)
    return insertPipelineOutbox(client, {
      ...input.outbox,
      payload: { ...input.outbox.payload, catalog },
    })
  })
  return { catalog, outboxId: outbox.id, outboxStatus: outbox.status }
}

export async function readPipelineDropdownCatalogFromPostgres(): Promise<PipelineDropdownCatalog | null> {
  const result = await query<SettingRow<PipelineDropdownCatalog>>(
    'SELECT value FROM app_settings WHERE key = $1',
    [DROPDOWN_SETTING_KEY],
  )
  return result.rows[0]?.value || null
}

export async function recordPipelineOutboxWorkerHeartbeatInPostgres(
  input: Omit<PipelineOutboxWorkerHeartbeat, 'checkedAt'>,
): Promise<PipelineOutboxWorkerHeartbeat> {
  const heartbeat: PipelineOutboxWorkerHeartbeat = {
    ...input,
    checkedAt: nowIso(),
  }
  await withTransaction((client) => upsertSetting(client, OUTBOX_WORKER_HEARTBEAT_KEY, heartbeat))
  return heartbeat
}

export async function readPipelineOutboxWorkerHeartbeatFromPostgres(): Promise<PipelineOutboxWorkerHeartbeat | null> {
  const result = await query<SettingRow<PipelineOutboxWorkerHeartbeat>>(
    'SELECT value FROM app_settings WHERE key = $1',
    [OUTBOX_WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}

export async function enqueuePipelineSyncOutboxInPostgres(input: EnqueueInput): Promise<{ id: string; status: string }> {
  return withTransaction((client) => insertPipelineOutbox(client, input))
}

export async function claimPipelineSyncOutboxInPostgres(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
} = {}): Promise<PipelineOutboxItem[]> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 10), 50))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 20))
  const leaseSeconds = Math.max(30, Math.min(Math.trunc(Number(input.leaseSeconds) || 300), 3600))
  const lockToken = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      `
        UPDATE sync_outbox
        SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'failed' END,
            last_error = COALESCE(last_error, 'worker lease expired'),
            available_at = now(),
            processed_at = CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
            locked_at = NULL,
            lock_token = NULL,
            updated_at = now()
        WHERE target_system = 'google_sheets'
          AND aggregate_type LIKE 'pipeline%'
          AND status = 'processing'
          AND (
            locked_at IS NULL
            OR locked_at < now() - ($2::text || ' seconds')::interval
          )
      `,
      [maxAttempts, leaseSeconds],
    )

    const result = await client.query<OutboxClaimRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM sync_outbox
          WHERE target_system = 'google_sheets'
            AND aggregate_type LIKE 'pipeline%'
            AND status IN ('queued', 'failed')
            AND attempts < $2
            AND available_at <= now()
          ORDER BY available_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE sync_outbox AS outbox
        SET status = 'processing',
            attempts = outbox.attempts + 1,
            locked_at = now(),
            lock_token = $3,
            updated_at = now()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING
          outbox.id::text,
          outbox.aggregate_type,
          outbox.aggregate_id,
          outbox.operation,
          outbox.payload,
          outbox.attempts,
          outbox.lock_token
      `,
      [limit, maxAttempts, lockToken],
    )

    return result.rows.map((row) => ({
      id: row.id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      operation: row.operation,
      payload: row.payload,
      attempts: row.attempts,
      lockToken: row.lock_token,
    }))
  })
}

export async function completePipelineSyncOutboxInPostgres(item: PipelineOutboxItem): Promise<void> {
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
        WHERE id = $1::uuid
          AND status = 'processing'
          AND lock_token = $2
      `,
      [item.id, item.lockToken],
    )
    if (result.rowCount !== 1) throw new Error(`Pipeline outbox lease lost for ${item.id}`)

    await client.query(
      `
        INSERT INTO audit_events (event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        `pipeline.sync.${item.operation}.succeeded`,
        item.aggregateType,
        item.aggregateId,
        JSON.stringify({ outboxId: item.id, attempts: item.attempts }),
      ],
    )
  })
}

export async function failPipelineSyncOutboxInPostgres(input: {
  item: PipelineOutboxItem
  error: string
  maxAttempts?: number
  retryBaseSeconds?: number
}): Promise<'failed' | 'dead'> {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 5), 20))
  const retryBaseSeconds = Math.max(5, Math.min(Math.trunc(Number(input.retryBaseSeconds) || 30), 3600))
  const status = input.item.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.item.attempts - 1)), 3600)
  const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString()

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
        WHERE id = $1::uuid
          AND status = 'processing'
          AND lock_token = $2
      `,
      [input.item.id, input.item.lockToken, status, input.error.slice(0, 4000), availableAt],
    )
    if (result.rowCount !== 1) throw new Error(`Pipeline outbox lease lost for ${input.item.id}`)

    await client.query(
      `
        INSERT INTO audit_events (event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        `pipeline.sync.${input.item.operation}.${status}`,
        input.item.aggregateType,
        input.item.aggregateId,
        JSON.stringify({
          outboxId: input.item.id,
          attempts: input.item.attempts,
          error: input.error.slice(0, 4000),
          availableAt: status === 'failed' ? availableAt : null,
        }),
      ],
    )
  })

  return status
}

export async function readPipelineSyncDiagnosticsFromPostgres(): Promise<{
  outbox: Record<string, number>
  oldestPendingAt: string | null
}> {
  const [outbox, age] = await Promise.all([
    query<CountByStatusRow>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM sync_outbox
        WHERE aggregate_type LIKE 'pipeline%'
        GROUP BY status
      `,
    ),
    query<OutboxAgeRow>(
      `
        SELECT MIN(created_at)::text AS oldest_pending_at
        FROM sync_outbox
        WHERE aggregate_type LIKE 'pipeline%'
          AND status IN ('queued', 'failed', 'processing')
      `,
    ),
  ])

  return {
    outbox: Object.fromEntries(outbox.rows.map((row) => [row.status, Number(row.count || 0)])),
    oldestPendingAt: age.rows[0]?.oldest_pending_at || null,
  }
}
