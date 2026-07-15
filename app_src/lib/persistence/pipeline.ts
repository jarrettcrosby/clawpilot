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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHEET_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

export type PipelineSheetContext = {
  pipelineId: string
  sheetId: string
}

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
  pipelineId: string | null
  sheetId: string | null
  attempts: number
  lockToken: string
}

export type ResolvedPipelineOutboxSheetContext = {
  pipelineId: string | null
  sheetId: string
  ownerEmail: string | null
  googleServiceAccountEmail: string | null
  googleSharedDriveId: string | null
  legacyOwnerFallback: boolean
}

export type ResolvedPipelineSheetBinding = {
  pipelineId: string
  sheetId: string
  ownerEmail: string
  googleServiceAccountEmail: string | null
  googleSharedDriveId: string | null
  legacyOwnerFallback: boolean
}

export type PipelineProvisioningStatus = 'not_requested' | 'queued' | 'provisioning' | 'ready' | 'failed'

export type PipelineProvisioningRecord = {
  id: string
  name: string
  ownerEmail: string
  provisioningStatus: PipelineProvisioningStatus
  provisioningError: string | null
  provisioningRequestedAt: string | null
  provisioningStartedAt: string | null
  provisioningLastAttemptedAt: string | null
  provisioningCompletedAt: string | null
  driveFolderId: string | null
  provisioningSheetId: string | null
  googleServiceAccountEmail: string | null
  googleSharedDriveId: string | null
  sheetId: string | null
  shortLinkId: string | null
  syncEnabled: boolean
}

export type PipelineGooglePermissionMember = {
  email: string
  accessRole: 'editor' | 'viewer'
}

export type PipelineGooglePermissionTracking = {
  resourceId: string
  permissionId: string
  userEmail: string
  googleRole: 'reader' | 'writer'
}

export type PipelineGooglePermissionContext = {
  pipeline: PipelineProvisioningRecord
  members: PipelineGooglePermissionMember[]
  trackedPermissions: PipelineGooglePermissionTracking[]
}

export class InvalidPipelineOutboxContextError extends Error {}

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

type OutboxOperationInput = {
  aggregateType: string
  aggregateId: string
  operation: string
  payload: Record<string, unknown>
  actor?: string
  idempotencyKey?: string
}

export type PipelineOutboxEnqueueInput = PipelineSheetContext & OutboxOperationInput

type PipelineSpaceSheetRow = {
  id: string
  sheet_id: string
  projection: PipelineProjection
}

type PipelineProvisioningRow = {
  id: string
  name: string
  owner_email: string
  provisioning_status: PipelineProvisioningStatus
  provisioning_error: string | null
  provisioning_requested_at: string | null
  provisioning_started_at: string | null
  provisioning_last_attempted_at: string | null
  provisioning_completed_at: string | null
  drive_folder_id: string | null
  provisioning_sheet_id: string | null
  google_service_account_email: string | null
  google_shared_drive_id: string | null
  sheet_id: string | null
  short_link_id: string | null
  sync_enabled: boolean
}

type PipelinePermissionMemberRow = {
  email: string
  access_role: 'editor' | 'viewer'
}

type PipelinePermissionTrackingRow = {
  resource_id: string
  permission_id: string
  user_email: string
  google_role: 'reader' | 'writer'
}

type ExistingOutboxRow = OutboxInsertRow & {
  attempts: number
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

function requirePipelineId(value: unknown): string {
  const pipelineId = cleanString(value)
  if (!pipelineId || !UUID_PATTERN.test(pipelineId)) throw new Error('A valid pipeline ID is required')
  return pipelineId
}

function requireGoogleResourceId(value: unknown, label: string): string {
  const resourceId = cleanString(value)
  if (!resourceId || !SHEET_ID_PATTERN.test(resourceId)) throw new Error(`${label} is invalid`)
  return resourceId
}

function requireGoogleServiceAccountEmail(value: unknown): string {
  const email = cleanString(value)?.toLowerCase()
  if (!email || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.iam\.gserviceaccount\.com$/i.test(email)) {
    throw new Error('A valid Google service-account binding is required')
  }
  return email
}

function toPipelineProvisioningRecord(row: PipelineProvisioningRow): PipelineProvisioningRecord {
  return {
    id: row.id,
    name: row.name,
    ownerEmail: row.owner_email,
    provisioningStatus: row.provisioning_status,
    provisioningError: row.provisioning_error,
    provisioningRequestedAt: row.provisioning_requested_at,
    provisioningStartedAt: row.provisioning_started_at,
    provisioningLastAttemptedAt: row.provisioning_last_attempted_at,
    provisioningCompletedAt: row.provisioning_completed_at,
    driveFolderId: row.drive_folder_id,
    provisioningSheetId: row.provisioning_sheet_id,
    googleServiceAccountEmail: row.google_service_account_email,
    googleSharedDriveId: row.google_shared_drive_id,
    sheetId: row.sheet_id,
    shortLinkId: row.short_link_id,
    syncEnabled: row.sync_enabled,
  }
}

function requirePipelineSheetContext(input: PipelineSheetContext): PipelineSheetContext {
  const pipelineId = cleanString(input.pipelineId)
  const sheetId = cleanString(input.sheetId)
  if (!pipelineId || !sheetId) throw new Error('Pipeline and Sheet context are required')
  if (!UUID_PATTERN.test(pipelineId) || !SHEET_ID_PATTERN.test(sheetId)) {
    throw new Error('Pipeline Sheet context is invalid')
  }
  return { pipelineId, sheetId }
}

function dropdownSettingKey(pipelineId: string) {
  return `${DROPDOWN_SETTING_KEY}:${pipelineId}`
}

async function assertPipelineSheetContext(client: PoolClient, input: PipelineSheetContext): Promise<PipelineSheetContext> {
  const context = requirePipelineSheetContext(input)
  const result = await client.query<{ id: string }>(
    `
      SELECT id::text
      FROM pipeline_spaces
      WHERE id = $1::uuid
        AND sheet_id = $2
        AND sync_enabled = true
      LIMIT 1
    `,
    [context.pipelineId, context.sheetId],
  )
  if (!result.rows[0]) throw new Error('Pipeline Sheet context is invalid')
  return context
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

async function upsertPipelineProjection(
  client: PoolClient,
  input: PipelineSheetContext,
  projection: PipelineProjection,
) {
  const context = await assertPipelineSheetContext(client, input)
  const syncedAt = projection.syncedAt || nowIso()

  await client.query(
    `
      UPDATE pipeline_spaces
      SET projection = $3::jsonb,
          updated_at = now()
      WHERE id = $1::uuid
        AND sheet_id = $2
        AND sync_enabled = true
    `,
    [context.pipelineId, context.sheetId, JSON.stringify(projection)],
  )

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
      VALUES ($1, $2, $3, 'pipeline_projection', 'google_sheets', now())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        role = EXCLUDED.role,
        owning_system = EXCLUDED.owning_system,
        updated_at = EXCLUDED.updated_at
    `,
    [`pipeline:${context.pipelineId}`, context.sheetId, OPPORTUNITIES_TAB],
  )

  if (context.sheetId === DEFAULT_PIPELINE_SHEET_ID) {
    await upsertSetting(client, PIPELINE_SETTING_KEY, projection)
  }

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
        context.sheetId,
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
      [context.sheetId, OPPORTUNITIES_TAB, retainedRows],
    )
  } else {
    await client.query(
      `
        DELETE FROM pipeline_sheet_rows
        WHERE sheet_id = $1
          AND tab_name = $2
          AND object_type = 'opportunity'
      `,
      [context.sheetId, OPPORTUNITIES_TAB],
    )
  }
}

async function insertPipelineOutbox(client: PoolClient, input: PipelineOutboxEnqueueInput): Promise<OutboxInsertRow> {
  const context = await assertPipelineSheetContext(client, input)
  const rawIdempotencyKey = cleanString(input.idempotencyKey)
  const idempotencyKey = rawIdempotencyKey
    ? `pipeline:${context.pipelineId}:${rawIdempotencyKey}`
    : null
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

  let payload: Record<string, unknown> = {
    ...input.payload,
    pipelineId: context.pipelineId,
    sheetId: context.sheetId,
  }
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
          AND payload->>'pipelineId' = $5
          AND payload->>'sheetId' = $6
        ORDER BY created_at ASC
        FOR UPDATE
      `,
      [input.aggregateType, input.aggregateId, input.operation, targetRange, context.pipelineId, context.sheetId],
    )

    if (pending.rows.length > 0) {
      const earliestPayload = pending.rows[0].payload || {}
      payload = {
        ...payload,
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
        pipelineId: context.pipelineId,
        sheetId: context.sheetId,
      }),
    ],
  )

  return row
}

export async function upsertPipelineProjectionInPostgres(
  input: PipelineSheetContext & { projection: unknown },
): Promise<PipelineProjection> {
  const context = requirePipelineSheetContext(input)
  const projection = normalizeProjection(input.projection)
  await withTransaction((client) => upsertPipelineProjection(client, context, projection))
  return projection
}

export async function upsertPipelineProjectionAndEnqueueInPostgres(input: PipelineSheetContext & {
  projection: unknown
  outbox: OutboxOperationInput
}): Promise<{ projection: PipelineProjection; outboxId: string; outboxStatus: string }> {
  const context = requirePipelineSheetContext(input)
  const projection = normalizeProjection(input.projection)
  const outbox = await withTransaction(async (client) => {
    await upsertPipelineProjection(client, context, projection)
    return insertPipelineOutbox(client, { ...input.outbox, ...context })
  })

  return { projection, outboxId: outbox.id, outboxStatus: outbox.status }
}

export async function readPipelineProjectionFromPostgres(
  input: PipelineSheetContext,
): Promise<PipelineProjection | null> {
  const context = requirePipelineSheetContext(input)
  const space = await query<PipelineSpaceSheetRow>(
    `
      SELECT id::text, sheet_id, projection
      FROM pipeline_spaces
      WHERE id = $1::uuid
        AND sheet_id = $2
        AND sync_enabled = true
      LIMIT 1
    `,
    [context.pipelineId, context.sheetId],
  )
  if (!space.rows[0]) throw new Error('Pipeline Sheet context is invalid')

  const rows = await query<PipelineRow>(
    `
      SELECT payload, last_synced_at::text
      FROM pipeline_sheet_rows
      WHERE sheet_id = $1
        AND tab_name = $2
        AND object_type = 'opportunity'
      ORDER BY row_number ASC
    `,
    [context.sheetId, OPPORTUNITIES_TAB],
  )

  let legacyProjection: PipelineProjection | null = null
  if (context.sheetId === DEFAULT_PIPELINE_SHEET_ID) {
    const setting = await query<SettingRow<PipelineProjection>>(
      'SELECT value FROM app_settings WHERE key = $1',
      [PIPELINE_SETTING_KEY],
    )
    legacyProjection = setting.rows[0]?.value || null
  }

  const spaceProjection = space.rows[0].projection || null
  const hasSpaceProjection = Boolean(
    spaceProjection?.syncedAt
    || (Array.isArray(spaceProjection?.opportunities) && spaceProjection.opportunities.length > 0),
  )
  const settingProjection = hasSpaceProjection ? spaceProjection : (legacyProjection || spaceProjection)
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

export async function upsertPipelineDropdownCatalogInPostgres(
  input: PipelineSheetContext & { catalog: unknown },
): Promise<PipelineDropdownCatalog> {
  const context = requirePipelineSheetContext(input)
  const catalog = normalizeDropdownCatalog(input.catalog)
  await withTransaction((client) => upsertPipelineDropdownCatalog(client, context, catalog))
  return catalog
}

async function upsertPipelineDropdownCatalog(
  client: PoolClient,
  input: PipelineSheetContext,
  catalog: PipelineDropdownCatalog,
) {
  const context = await assertPipelineSheetContext(client, input)
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
      VALUES ($1, $2, $3, 'dropdown_catalog', 'google_sheets', now())
      ON CONFLICT (sheet_id, tab_name) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        role = EXCLUDED.role,
        owning_system = EXCLUDED.owning_system,
        updated_at = EXCLUDED.updated_at
    `,
    [`pipeline:${context.pipelineId}:dropdowns`, context.sheetId, DROPDOWNS_TAB],
  )
  await upsertSetting(client, dropdownSettingKey(context.pipelineId), catalog)
  if (context.sheetId === DEFAULT_PIPELINE_SHEET_ID) {
    await upsertSetting(client, DROPDOWN_SETTING_KEY, catalog)
  }
}

export async function upsertPipelineDropdownCatalogAndEnqueueInPostgres(input: PipelineSheetContext & {
  catalog: unknown
  outbox: OutboxOperationInput
}): Promise<{ catalog: PipelineDropdownCatalog; outboxId: string; outboxStatus: string }> {
  const context = requirePipelineSheetContext(input)
  const catalog = normalizeDropdownCatalog(input.catalog)
  const outbox = await withTransaction(async (client) => {
    await upsertPipelineDropdownCatalog(client, context, catalog)
    return insertPipelineOutbox(client, {
      ...input.outbox,
      ...context,
      payload: { ...input.outbox.payload, catalog },
    })
  })
  return { catalog, outboxId: outbox.id, outboxStatus: outbox.status }
}

export async function readPipelineDropdownCatalogFromPostgres(
  input: PipelineSheetContext,
): Promise<PipelineDropdownCatalog | null> {
  const context = requirePipelineSheetContext(input)
  return withTransaction(async (client) => {
    await assertPipelineSheetContext(client, context)
    const result = await client.query<SettingRow<PipelineDropdownCatalog>>(
      'SELECT value FROM app_settings WHERE key = $1',
      [dropdownSettingKey(context.pipelineId)],
    )
    if (result.rows[0]?.value) return result.rows[0].value
    if (context.sheetId !== DEFAULT_PIPELINE_SHEET_ID) return null

    const legacy = await client.query<SettingRow<PipelineDropdownCatalog>>(
      'SELECT value FROM app_settings WHERE key = $1',
      [DROPDOWN_SETTING_KEY],
    )
    return legacy.rows[0]?.value || null
  })
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

async function readPipelineProvisioningWithClient(
  client: PoolClient,
  pipelineId: string,
  lock = false,
): Promise<PipelineProvisioningRecord | null> {
  const result = await client.query<PipelineProvisioningRow>(
    `
      SELECT
        id::text,
        name,
        owner_email,
        provisioning_status,
        provisioning_error,
        provisioning_requested_at::text,
        provisioning_started_at::text,
        provisioning_last_attempted_at::text,
        provisioning_completed_at::text,
        drive_folder_id,
        provisioning_sheet_id,
        google_service_account_email,
        google_shared_drive_id,
        sheet_id,
        short_link_id::text,
        sync_enabled
      FROM pipeline_spaces
      WHERE id = $1::uuid
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [pipelineId],
  )
  return result.rows[0] ? toPipelineProvisioningRecord(result.rows[0]) : null
}

export async function readPipelineProvisioningRecordInPostgres(
  pipelineIdValue: unknown,
): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(pipelineIdValue)
  return withTransaction(async (client) => {
    const pipeline = await readPipelineProvisioningWithClient(client, pipelineId)
    if (!pipeline) throw new Error('Pipeline was not found')
    return pipeline
  })
}

export async function enqueuePipelineProvisioningInPostgres(input: {
  pipelineId: unknown
  ownerEmail: unknown
  actor: unknown
  serviceAccountEmail: unknown
  sharedDriveId: unknown
}): Promise<{
  outboxId: string | null
  outboxStatus: string
  provisioningStatus: PipelineProvisioningStatus
  alreadyReady: boolean
}> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const ownerEmail = cleanString(input.ownerEmail)?.toLowerCase()
  const actor = cleanString(input.actor)?.toLowerCase()
  const serviceAccountEmail = requireGoogleServiceAccountEmail(input.serviceAccountEmail)
  const sharedDriveId = requireGoogleResourceId(input.sharedDriveId, 'Google Shared Drive ID')
  if (!ownerEmail || !actor || ownerEmail !== actor) throw new Error('Only the pipeline owner can provision it')

  return withTransaction(async (client) => {
    const integration = await client.query<{
      service_account_email: string | null
      selected_shared_drive_id: string | null
    }>(
      `
        SELECT service_account_email, selected_shared_drive_id
        FROM google_workspace_integration
        WHERE singleton_id = 1
        FOR SHARE
      `,
    )
    const currentIntegration = integration.rows[0]
    if (!currentIntegration || currentIntegration.service_account_email !== serviceAccountEmail) {
      throw new Error('Google Workspace integration changed; retry pipeline provisioning')
    }
    const pipeline = await readPipelineProvisioningWithClient(client, pipelineId, true)
    if (!pipeline || pipeline.ownerEmail !== ownerEmail) throw new Error('Only the pipeline owner can provision it')
    if (
      (pipeline.googleServiceAccountEmail && pipeline.googleServiceAccountEmail !== serviceAccountEmail)
      || (pipeline.googleSharedDriveId && pipeline.googleSharedDriveId !== sharedDriveId)
    ) {
      throw new Error('Pipeline Google Workspace binding cannot be changed')
    }
    if (
      !pipeline.googleSharedDriveId
      && currentIntegration.selected_shared_drive_id !== sharedDriveId
    ) {
      throw new Error('Selected Google Shared Drive changed; retry pipeline provisioning')
    }
    if (pipeline.provisioningStatus === 'ready' && pipeline.sheetId && pipeline.syncEnabled) {
      return {
        outboxId: null,
        outboxStatus: 'succeeded',
        provisioningStatus: 'ready' as const,
        alreadyReady: true,
      }
    }

    const idempotencyKey = `pipeline:${pipelineId}:provision`
    const existing = await client.query<ExistingOutboxRow>(
      `
        SELECT id::text, status, attempts
        FROM sync_outbox
        WHERE target_system = 'google_workspace'
          AND idempotency_key = $1
        LIMIT 1
        FOR UPDATE
      `,
      [idempotencyKey],
    )

    let outbox = existing.rows[0]
    if (!outbox) {
      const inserted = await client.query<ExistingOutboxRow>(
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
          VALUES ('pipeline_space', $1, 'provision_pipeline', 'google_workspace', $2::jsonb, 'queued', 0, $3, now())
          RETURNING id::text, status, attempts
        `,
        [pipelineId, JSON.stringify({ pipelineId }), idempotencyKey],
      )
      outbox = inserted.rows[0]
    } else if (!['queued', 'processing'].includes(outbox.status)) {
      const requeued = await client.query<ExistingOutboxRow>(
        `
          UPDATE sync_outbox
          SET status = 'queued',
              attempts = 0,
              last_error = NULL,
              available_at = now(),
              processed_at = NULL,
              locked_at = NULL,
              lock_token = NULL,
              updated_at = now()
          WHERE id = $1::uuid
          RETURNING id::text, status, attempts
        `,
        [outbox.id],
      )
      outbox = requeued.rows[0]
    }
    if (!outbox) throw new Error('Unable to enqueue pipeline provisioning')

    const provisioningStatus: PipelineProvisioningStatus = outbox.status === 'processing' ? 'provisioning' : 'queued'
    await client.query(
      `
        UPDATE pipeline_spaces
        SET provisioning_status = $2,
            provisioning_error = NULL,
            provisioning_requested_at = now(),
            provisioning_completed_at = NULL,
            google_service_account_email = COALESCE(google_service_account_email, $3),
            google_shared_drive_id = COALESCE(google_shared_drive_id, $4),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [pipelineId, provisioningStatus, serviceAccountEmail, sharedDriveId],
    )
    await client.query(
      `
        INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'pipeline.provisioning.queued', 'pipeline_space', $2, $3::jsonb)
      `,
      [actor, pipelineId, JSON.stringify({ outboxId: outbox.id, provisioningStatus })],
    )

    return {
      outboxId: outbox.id,
      outboxStatus: outbox.status,
      provisioningStatus,
      alreadyReady: false,
    }
  })
}

export async function enqueuePipelinePermissionSyncWithClient(
  client: PoolClient,
  input: { pipelineId: unknown; actor: unknown },
): Promise<{ id: string; status: string; permissionFingerprint: string }> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const actor = cleanString(input.actor)?.toLowerCase()
  const pipeline = await client.query<{ owner_email: string }>(
    'SELECT owner_email FROM pipeline_spaces WHERE id = $1::uuid FOR UPDATE',
    [pipelineId],
  )
  const ownerEmail = pipeline.rows[0]?.owner_email
  if (!ownerEmail || !actor || ownerEmail !== actor) throw new Error('Only the pipeline owner can change sharing')

  const members = await client.query<PipelinePermissionMemberRow>(
    `
      SELECT member.user_email AS email, member.access_role
      FROM pipeline_space_members member
      JOIN app_users app_user
        ON app_user.email = member.user_email
       AND app_user.status <> 'disabled'
      WHERE member.pipeline_id = $1::uuid
      ORDER BY member.user_email ASC
    `,
    [pipelineId],
  )
  const desired = [
    { email: ownerEmail, accessRole: 'owner' },
    ...members.rows.map((member) => ({ email: member.email, accessRole: member.access_role })),
  ]
  const permissionFingerprint = hashPayload(desired).slice(0, 32)
  const idempotencyKey = `pipeline:${pipelineId}:permissions:${permissionFingerprint}`
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
      VALUES ('pipeline_space', $1, 'sync_pipeline_permissions', 'google_workspace', $2::jsonb, 'queued', 0, $3, now())
      ON CONFLICT (target_system, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO UPDATE SET
        status = CASE WHEN sync_outbox.status IN ('queued', 'processing') THEN sync_outbox.status ELSE 'queued' END,
        attempts = CASE WHEN sync_outbox.status IN ('queued', 'processing') THEN sync_outbox.attempts ELSE 0 END,
        last_error = CASE WHEN sync_outbox.status IN ('queued', 'processing') THEN sync_outbox.last_error ELSE NULL END,
        available_at = CASE WHEN sync_outbox.status IN ('queued', 'processing') THEN sync_outbox.available_at ELSE now() END,
        processed_at = CASE WHEN sync_outbox.status IN ('queued', 'processing') THEN sync_outbox.processed_at ELSE NULL END,
        updated_at = now()
      RETURNING id::text, status
    `,
    [pipelineId, JSON.stringify({ pipelineId, permissionFingerprint }), idempotencyKey],
  )
  const outbox = result.rows[0]
  if (!outbox) throw new Error('Unable to enqueue pipeline permission synchronization')
  await client.query(
    `
      INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
      VALUES ($1, 'pipeline.permissions.queued', 'pipeline_space', $2, $3::jsonb)
    `,
    [actor, pipelineId, JSON.stringify({ outboxId: outbox.id, permissionFingerprint })],
  )
  return { ...outbox, permissionFingerprint }
}

export async function markPipelineProvisioningStartedInPostgres(
  pipelineIdValue: unknown,
): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(pipelineIdValue)
  await query(
    `
      UPDATE pipeline_spaces
      SET provisioning_status = CASE WHEN provisioning_status = 'ready' THEN 'ready' ELSE 'provisioning' END,
          provisioning_error = NULL,
          provisioning_started_at = COALESCE(provisioning_started_at, now()),
          provisioning_last_attempted_at = now(),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [pipelineId],
  )
  return readPipelineProvisioningRecordInPostgres(pipelineId)
}

export async function storePipelineDriveFolderIdInPostgres(input: {
  pipelineId: unknown
  expectedFolderId: string | null
  folderId: unknown
}): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const folderId = requireGoogleResourceId(input.folderId, 'Pipeline Drive folder ID')
  const expectedFolderId = input.expectedFolderId === null
    ? null
    : requireGoogleResourceId(input.expectedFolderId, 'Existing pipeline Drive folder ID')
  const result = await query(
    `
      UPDATE pipeline_spaces
      SET drive_folder_id = $3,
          updated_at = now()
      WHERE id = $1::uuid
        AND provisioning_status <> 'ready'
        AND drive_folder_id IS NOT DISTINCT FROM $2
    `,
    [pipelineId, expectedFolderId, folderId],
  )
  if (result.rowCount !== 1) {
    const current = await readPipelineProvisioningRecordInPostgres(pipelineId)
    if (current.driveFolderId !== folderId) throw new Error('Pipeline Drive folder state changed during provisioning')
    return current
  }
  return readPipelineProvisioningRecordInPostgres(pipelineId)
}

export async function storePipelineProvisioningSheetIdInPostgres(input: {
  pipelineId: unknown
  expectedSheetId: string | null
  sheetId: unknown
}): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const sheetId = requireGoogleResourceId(input.sheetId, 'Pipeline Sheet ID')
  const expectedSheetId = input.expectedSheetId === null
    ? null
    : requireGoogleResourceId(input.expectedSheetId, 'Existing pipeline Sheet ID')
  const result = await query(
    `
      UPDATE pipeline_spaces
      SET provisioning_sheet_id = $3,
          updated_at = now()
      WHERE id = $1::uuid
        AND provisioning_status <> 'ready'
        AND provisioning_sheet_id IS NOT DISTINCT FROM $2
    `,
    [pipelineId, expectedSheetId, sheetId],
  )
  if (result.rowCount !== 1) {
    const current = await readPipelineProvisioningRecordInPostgres(pipelineId)
    if (current.provisioningSheetId !== sheetId) throw new Error('Pipeline Sheet state changed during provisioning')
    return current
  }
  return readPipelineProvisioningRecordInPostgres(pipelineId)
}

export async function storePipelineShortLinkIdInPostgres(input: {
  pipelineId: unknown
  expectedShortLinkId: string | null
  shortLinkId: unknown
}): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const expectedShortLinkId = input.expectedShortLinkId === null
    ? null
    : requirePipelineId(input.expectedShortLinkId)
  const shortLinkId = requirePipelineId(input.shortLinkId)
  const result = await query(
    `
      UPDATE pipeline_spaces
      SET short_link_id = $3::uuid,
          updated_at = now()
      WHERE id = $1::uuid
        AND short_link_id IS NOT DISTINCT FROM $2::uuid
    `,
    [pipelineId, expectedShortLinkId, shortLinkId],
  )
  if (result.rowCount !== 1) {
    const current = await readPipelineProvisioningRecordInPostgres(pipelineId)
    if (current.shortLinkId !== shortLinkId) throw new Error('Pipeline short-link state changed during provisioning')
    return current
  }
  return readPipelineProvisioningRecordInPostgres(pipelineId)
}

export async function completePipelineProvisioningInPostgres(
  pipelineIdValue: unknown,
): Promise<PipelineProvisioningRecord> {
  const pipelineId = requirePipelineId(pipelineIdValue)
  return withTransaction(async (client) => {
    const pipeline = await readPipelineProvisioningWithClient(client, pipelineId, true)
    if (!pipeline) throw new Error('Pipeline was not found')
    if (pipeline.provisioningStatus === 'ready' && pipeline.sheetId && pipeline.syncEnabled) return pipeline
    if (
      !pipeline.driveFolderId
      || !pipeline.provisioningSheetId
      || !pipeline.shortLinkId
      || !pipeline.googleServiceAccountEmail
      || !pipeline.googleSharedDriveId
    ) {
      throw new Error('Pipeline provisioning is incomplete')
    }
    if (pipeline.sheetId && pipeline.sheetId !== pipeline.provisioningSheetId) {
      throw new Error('Pipeline Sheet state changed during provisioning')
    }
    await client.query(
      `
        UPDATE pipeline_spaces
        SET sheet_id = provisioning_sheet_id,
            sync_enabled = true,
            provisioning_status = 'ready',
            provisioning_error = NULL,
            provisioning_completed_at = now(),
            updated_at = now()
        WHERE id = $1::uuid
      `,
      [pipelineId],
    )
    const completed = await readPipelineProvisioningWithClient(client, pipelineId)
    if (!completed) throw new Error('Pipeline was not found')
    await client.query(
      `
        INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'pipeline.provisioning.ready', 'pipeline_space', $2, $3::jsonb)
      `,
      [completed.ownerEmail, pipelineId, JSON.stringify({ shortLinkId: completed.shortLinkId })],
    )
    return completed
  })
}

export async function recordPipelineProvisioningFailureInPostgres(input: {
  pipelineId: unknown
  error: unknown
}): Promise<void> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const error = String(input.error || 'Google Workspace provisioning failed')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 500) || 'Google Workspace provisioning failed'
  await query(
    `
      UPDATE pipeline_spaces
      SET provisioning_status = CASE WHEN provisioning_status = 'ready' THEN 'ready' ELSE 'failed' END,
          provisioning_error = $2,
          provisioning_last_attempted_at = now(),
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [pipelineId, error],
  )
}

export async function readPipelineGooglePermissionContextInPostgres(
  pipelineIdValue: unknown,
): Promise<PipelineGooglePermissionContext> {
  const pipelineId = requirePipelineId(pipelineIdValue)
  const [pipeline, members, tracked] = await Promise.all([
    readPipelineProvisioningRecordInPostgres(pipelineId),
    query<PipelinePermissionMemberRow>(
      `
        SELECT member.user_email AS email, member.access_role
        FROM pipeline_space_members member
        JOIN app_users app_user
          ON app_user.email = member.user_email
         AND app_user.status <> 'disabled'
        WHERE member.pipeline_id = $1::uuid
        ORDER BY member.user_email ASC
      `,
      [pipelineId],
    ),
    query<PipelinePermissionTrackingRow>(
      `
        SELECT resource_id, permission_id, user_email, google_role
        FROM pipeline_google_permissions
        WHERE pipeline_id = $1::uuid
        ORDER BY user_email ASC
      `,
      [pipelineId],
    ),
  ])
  return {
    pipeline,
    members: members.rows.map((member) => ({ email: member.email, accessRole: member.access_role })),
    trackedPermissions: tracked.rows.map((permission) => ({
      resourceId: permission.resource_id,
      permissionId: permission.permission_id,
      userEmail: permission.user_email,
      googleRole: permission.google_role,
    })),
  }
}

export async function upsertPipelineGooglePermissionTrackingInPostgres(input: {
  pipelineId: unknown
  resourceId: unknown
  permissionId: unknown
  userEmail: unknown
  googleRole: 'reader' | 'writer'
}): Promise<void> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const resourceId = requireGoogleResourceId(input.resourceId, 'Google permission resource ID')
  const permissionId = cleanString(input.permissionId)
  const userEmail = cleanString(input.userEmail)?.toLowerCase()
  if (!permissionId || permissionId.length > 512 || !/^[\x21-\x7e]+$/.test(permissionId)) {
    throw new Error('Google permission ID is invalid')
  }
  if (!userEmail || !userEmail.includes('@')) throw new Error('Google permission email is invalid')
  if (input.googleRole !== 'reader' && input.googleRole !== 'writer') throw new Error('Google permission role is invalid')
  const result = await query(
    `
      INSERT INTO pipeline_google_permissions (
        pipeline_id,
        resource_id,
        permission_id,
        user_email,
        google_role,
        updated_at,
        last_reconciled_at
      )
      SELECT id, $2, $3, $4, $5, now(), now()
      FROM pipeline_spaces
      WHERE id = $1::uuid
        AND drive_folder_id = $2
      ON CONFLICT (pipeline_id, resource_id, user_email) DO UPDATE SET
        permission_id = EXCLUDED.permission_id,
        google_role = EXCLUDED.google_role,
        updated_at = now(),
        last_reconciled_at = now()
    `,
    [pipelineId, resourceId, permissionId, userEmail, input.googleRole],
  )
  if (result.rowCount !== 1) throw new Error('Google permission does not match the managed pipeline resource')
}

export async function deletePipelineGooglePermissionTrackingInPostgres(input: {
  pipelineId: unknown
  resourceId: unknown
  permissionId: unknown
  userEmail: unknown
}): Promise<void> {
  const pipelineId = requirePipelineId(input.pipelineId)
  const resourceId = requireGoogleResourceId(input.resourceId, 'Google permission resource ID')
  const permissionId = cleanString(input.permissionId)
  const userEmail = cleanString(input.userEmail)?.toLowerCase()
  if (!permissionId || !userEmail) throw new Error('Tracked Google permission is invalid')
  await query(
    `
      DELETE FROM pipeline_google_permissions
      WHERE pipeline_id = $1::uuid
        AND resource_id = $2
        AND permission_id = $3
        AND user_email = $4
    `,
    [pipelineId, resourceId, permissionId, userEmail],
  )
}

export async function enqueuePipelineSyncOutboxInPostgres(
  input: PipelineOutboxEnqueueInput,
): Promise<{ id: string; status: string }> {
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
        WHERE target_system IN ('google_sheets', 'google_workspace', 'google_workspace_v2')
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
          WHERE target_system IN ('google_sheets', 'google_workspace', 'google_workspace_v2')
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
      pipelineId: cleanString(row.payload?.pipelineId),
      sheetId: cleanString(row.payload?.sheetId),
      attempts: row.attempts,
      lockToken: row.lock_token,
    }))
  })
}

export async function resolvePipelineOutboxSheetContextInPostgres(
  item: Pick<PipelineOutboxItem, 'pipelineId' | 'sheetId' | 'payload'>,
): Promise<ResolvedPipelineOutboxSheetContext> {
  const pipelineId = cleanString(item.pipelineId) || cleanString(item.payload.pipelineId)
  const claimedSheetId = cleanString(item.sheetId) || cleanString(item.payload.sheetId)

  if (!pipelineId) {
    if (claimedSheetId && claimedSheetId !== DEFAULT_PIPELINE_SHEET_ID) {
      throw new InvalidPipelineOutboxContextError('Legacy pipeline outbox item cannot target a non-default Sheet')
    }
    const configuredOwner = cleanString(process.env.APP_LOGIN_EMAIL)?.toLowerCase()
    if (!configuredOwner) {
      throw new InvalidPipelineOutboxContextError('Legacy pipeline owner is not configured')
    }
    const legacy = await query<{ id: string }>(
      `
        SELECT id::text
        FROM pipeline_spaces
        WHERE owner_email = $1
          AND is_default = true
          AND sheet_id = $2
          AND sync_enabled = true
        LIMIT 1
      `,
      [configuredOwner, DEFAULT_PIPELINE_SHEET_ID],
    )
    const legacyPipelineId = legacy.rows[0]?.id
    if (!legacyPipelineId) {
      throw new InvalidPipelineOutboxContextError('Legacy owner pipeline is not available')
    }
    const binding = await resolvePipelineSheetBindingInPostgres({
      pipelineId: legacyPipelineId,
      sheetId: DEFAULT_PIPELINE_SHEET_ID,
    })
    return {
      ...binding,
    }
  }

  if (!UUID_PATTERN.test(pipelineId)) {
    throw new InvalidPipelineOutboxContextError('Pipeline outbox item has an invalid pipeline ID')
  }

  const result = await query<{ id: string; sheet_id: string }>(
    `
      SELECT id::text, sheet_id
      FROM pipeline_spaces
      WHERE id = $1::uuid
        AND sync_enabled = true
        AND sheet_id IS NOT NULL
      LIMIT 1
    `,
    [pipelineId],
  )
  const pipeline = result.rows[0]
  if (!pipeline) {
    throw new InvalidPipelineOutboxContextError('Pipeline outbox item no longer has a sheet-backed pipeline')
  }
  if (claimedSheetId && claimedSheetId !== pipeline.sheet_id) {
    throw new InvalidPipelineOutboxContextError('Pipeline outbox Sheet does not match its pipeline')
  }
  return resolvePipelineSheetBindingInPostgres({ pipelineId: pipeline.id, sheetId: pipeline.sheet_id })
}

export async function resolvePipelineSheetBindingInPostgres(
  input: PipelineSheetContext,
): Promise<ResolvedPipelineSheetBinding> {
  const context = requirePipelineSheetContext(input)
  const result = await query<{
    id: string
    owner_email: string
    is_default: boolean
    sheet_id: string
    google_service_account_email: string | null
    google_shared_drive_id: string | null
  }>(
    `
      SELECT id::text, owner_email, is_default, sheet_id,
             google_service_account_email, google_shared_drive_id
      FROM pipeline_spaces
      WHERE id = $1::uuid
        AND sheet_id = $2
        AND sync_enabled = true
      LIMIT 1
    `,
    [context.pipelineId, context.sheetId],
  )
  const pipeline = result.rows[0]
  if (!pipeline) throw new InvalidPipelineOutboxContextError('Pipeline and Sheet context do not match')
  if (pipeline.google_service_account_email && pipeline.google_shared_drive_id) {
    return {
      pipelineId: pipeline.id,
      sheetId: pipeline.sheet_id,
      ownerEmail: pipeline.owner_email,
      googleServiceAccountEmail: pipeline.google_service_account_email,
      googleSharedDriveId: pipeline.google_shared_drive_id,
      legacyOwnerFallback: false,
    }
  }

  const configuredOwner = cleanString(process.env.APP_LOGIN_EMAIL)?.toLowerCase()
  if (
    !configuredOwner
    || !pipeline.is_default
    || pipeline.owner_email !== configuredOwner
    || pipeline.sheet_id !== DEFAULT_PIPELINE_SHEET_ID
  ) {
    throw new InvalidPipelineOutboxContextError('Managed pipeline is missing its Google connection binding')
  }
  return {
    pipelineId: pipeline.id,
    sheetId: pipeline.sheet_id,
    ownerEmail: pipeline.owner_email,
    googleServiceAccountEmail: null,
    googleSharedDriveId: null,
    legacyOwnerFallback: true,
  }
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
        JSON.stringify({
          outboxId: item.id,
          attempts: item.attempts,
          pipelineId: item.pipelineId,
          sheetId: item.sheetId,
        }),
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
          pipelineId: input.item.pipelineId,
          sheetId: input.item.sheetId,
        }),
      ],
    )
  })

  return status
}

export async function readPipelineSyncDiagnosticsFromPostgres(
  input: PipelineSheetContext & { includeLegacyOwnerItems?: boolean },
): Promise<{
  outbox: Record<string, number>
  oldestPendingAt: string | null
}> {
  const context = requirePipelineSheetContext(input)
  const includeLegacyOwnerItems = input.includeLegacyOwnerItems === true
  const [outbox, age] = await Promise.all([
    query<CountByStatusRow>(
      `
        SELECT status, COUNT(*)::text AS count
        FROM sync_outbox
        WHERE aggregate_type LIKE 'pipeline%'
          AND target_system IN ('google_sheets', 'google_workspace', 'google_workspace_v2')
          AND (
            (
              payload->>'pipelineId' = $1
              AND (payload->>'sheetId' = $2 OR payload->>'sheetId' IS NULL)
            )
            OR (
              $3::boolean = true
              AND payload->>'pipelineId' IS NULL
              AND (payload->>'sheetId' = $2 OR payload->>'sheetId' IS NULL)
            )
          )
        GROUP BY status
      `,
      [context.pipelineId, context.sheetId, includeLegacyOwnerItems],
    ),
    query<OutboxAgeRow>(
      `
        SELECT MIN(created_at)::text AS oldest_pending_at
        FROM sync_outbox
        WHERE aggregate_type LIKE 'pipeline%'
          AND target_system IN ('google_sheets', 'google_workspace', 'google_workspace_v2')
          AND status IN ('queued', 'failed', 'processing')
          AND (
            (
              payload->>'pipelineId' = $1
              AND (payload->>'sheetId' = $2 OR payload->>'sheetId' IS NULL)
            )
            OR (
              $3::boolean = true
              AND payload->>'pipelineId' IS NULL
              AND (payload->>'sheetId' = $2 OR payload->>'sheetId' IS NULL)
            )
          )
      `,
      [context.pipelineId, context.sheetId, includeLegacyOwnerItems],
    ),
  ])

  return {
    outbox: Object.fromEntries(outbox.rows.map((row) => [row.status, Number(row.count || 0)])),
    oldestPendingAt: age.rows[0]?.oldest_pending_at || null,
  }
}
