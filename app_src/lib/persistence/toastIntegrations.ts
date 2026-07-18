import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/persistence/postgres'
import type { EncryptedToastClientSecret, ToastAccessType } from '@/lib/integrations/toastCredentialCrypto'

type TimestampValue = string | Date

type CredentialRow = {
  organization_id: string
  access_type: ToastAccessType
  api_base_url: string
  client_id: string
  client_secret_ciphertext: Buffer
  client_secret_iv: Buffer
  client_secret_tag: Buffer
  client_secret_last_four: string
  credential_version: number
  sync_enabled: boolean
  verified_at: TimestampValue | null
  last_error_code: string | null
  updated_at: TimestampValue
}

type LocationRow = {
  organization_id: string
  restaurant_guid: string
  restaurant_name: string
  location_name: string | null
  location_code: string | null
  timezone: string | null
  active: boolean
  test_mode: boolean
  archived: boolean
  analytics_access: boolean
  standard_access: boolean
  selected: boolean
  last_verified_at: TimestampValue | null
  updated_at: TimestampValue
}

export type ToastCredentialState = {
  accessType: ToastAccessType
  configured: boolean
  apiBaseUrl: string | null
  clientIdLastFour: string | null
  clientSecretLastFour: string | null
  credentialVersion: number
  syncEnabled: boolean
  verifiedAt: string | null
  lastErrorCode: string | null
  updatedAt: string | null
}

export type ToastLocationState = {
  restaurantGuid: string
  restaurantName: string
  locationName: string | null
  locationCode: string | null
  timezone: string | null
  active: boolean
  testMode: boolean
  archived: boolean
  analyticsAccess: boolean
  standardAccess: boolean
  selected: boolean
  lastVerifiedAt: string | null
  updatedAt: string
}

export type ToastIntegrationState = {
  organizationId: string
  credentials: Record<ToastAccessType, ToastCredentialState>
  locations: ToastLocationState[]
  jobs: { pending: number; processing: number; failed: number; dead: number; succeeded: number }
  accountingDrafts: { needsMapping: number; needsReview: number; approved: number; posted: number; failed: number }
  latestSyncAt: string | null
}

export type ToastRuntimeCredentialRecord = {
  organizationId: string
  accessType: ToastAccessType
  apiBaseUrl: string
  clientId: string
  secret: EncryptedToastClientSecret
}

export type ToastLocationWrite = {
  restaurantGuid: string
  restaurantName: string
  locationName?: string | null
  locationCode?: string | null
  timezone?: string | null
  active?: boolean
  testMode?: boolean
  archived?: boolean
}

export type ToastSyncJob = {
  id: string
  organizationId: string
  restaurantGuid: string
  syncKind: 'analytics_sales' | 'analytics_payouts' | 'standard_orders'
  businessDate: string
  attemptCount: number
  maxAttempts: number
  requestState: Record<string, unknown>
  requestedBy: string | null
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function emptyCredential(accessType: ToastAccessType): ToastCredentialState {
  return {
    accessType,
    configured: false,
    apiBaseUrl: null,
    clientIdLastFour: null,
    clientSecretLastFour: null,
    credentialVersion: 0,
    syncEnabled: false,
    verifiedAt: null,
    lastErrorCode: null,
    updatedAt: null,
  }
}

function credentialState(row: CredentialRow): ToastCredentialState {
  return {
    accessType: row.access_type,
    configured: true,
    apiBaseUrl: row.api_base_url,
    clientIdLastFour: row.client_id.slice(-4),
    clientSecretLastFour: row.client_secret_last_four,
    credentialVersion: row.credential_version,
    syncEnabled: row.sync_enabled,
    verifiedAt: iso(row.verified_at),
    lastErrorCode: row.last_error_code,
    updatedAt: iso(row.updated_at),
  }
}

function locationState(row: LocationRow): ToastLocationState {
  return {
    restaurantGuid: row.restaurant_guid,
    restaurantName: row.restaurant_name,
    locationName: row.location_name,
    locationCode: row.location_code,
    timezone: row.timezone,
    active: row.active,
    testMode: row.test_mode,
    archived: row.archived,
    analyticsAccess: row.analytics_access,
    standardAccess: row.standard_access,
    selected: row.selected,
    lastVerifiedAt: iso(row.last_verified_at),
    updatedAt: iso(row.updated_at) as string,
  }
}

async function audit(
  client: PoolClient,
  actorEmail: string,
  organizationId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO audit_events (actor, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, 'toast_integration', $3, $4::jsonb)`,
    [actorEmail, eventType, organizationId, JSON.stringify(payload)],
  )
}

export async function readToastIntegrationStateFromPostgres(organizationId: string): Promise<ToastIntegrationState> {
  const [credentialResult, locationResult, jobResult, draftResult, latestResult] = await Promise.all([
    query<CredentialRow>(
      `SELECT * FROM organization_toast_credentials WHERE organization_id = $1::uuid ORDER BY access_type`,
      [organizationId],
    ),
    query<LocationRow>(
      `SELECT * FROM toast_locations WHERE organization_id = $1::uuid ORDER BY restaurant_name, restaurant_guid`,
      [organizationId],
    ),
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM toast_sync_outbox WHERE organization_id = $1::uuid GROUP BY status`,
      [organizationId],
    ),
    query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM toast_accounting_export_drafts WHERE organization_id = $1::uuid GROUP BY status`,
      [organizationId],
    ),
    query<{ latest: TimestampValue | null }>(
      `SELECT max(completed_at) AS latest
       FROM toast_sync_outbox WHERE organization_id = $1::uuid AND status = 'succeeded'`,
      [organizationId],
    ),
  ])
  const credentials = {
    analytics: emptyCredential('analytics'),
    standard: emptyCredential('standard'),
  }
  for (const row of credentialResult.rows) credentials[row.access_type] = credentialState(row)
  const jobs = { pending: 0, processing: 0, failed: 0, dead: 0, succeeded: 0 }
  for (const row of jobResult.rows) {
    if (row.status in jobs) jobs[row.status as keyof typeof jobs] = Number(row.count) || 0
  }
  const accountingDrafts = { needsMapping: 0, needsReview: 0, approved: 0, posted: 0, failed: 0 }
  for (const row of draftResult.rows) {
    const key = row.status === 'needs_mapping' ? 'needsMapping' : row.status === 'needs_review' ? 'needsReview' : row.status
    if (key in accountingDrafts) accountingDrafts[key as keyof typeof accountingDrafts] = Number(row.count) || 0
  }
  return {
    organizationId,
    credentials,
    locations: locationResult.rows.map(locationState),
    jobs,
    accountingDrafts,
    latestSyncAt: iso(latestResult.rows[0]?.latest),
  }
}

export async function readToastRuntimeCredentialFromPostgres(
  organizationId: string,
  accessType: ToastAccessType,
): Promise<ToastRuntimeCredentialRecord | null> {
  const result = await query<CredentialRow>(
    `SELECT * FROM organization_toast_credentials
     WHERE organization_id = $1::uuid AND access_type = $2`,
    [organizationId, accessType],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    organizationId: row.organization_id,
    accessType: row.access_type,
    apiBaseUrl: row.api_base_url,
    clientId: row.client_id,
    secret: {
      ciphertext: row.client_secret_ciphertext,
      iv: row.client_secret_iv,
      tag: row.client_secret_tag,
    },
  }
}

export async function writeToastCredentialInPostgres(input: {
  organizationId: string
  accessType: ToastAccessType
  apiBaseUrl: string
  clientId: string
  clientSecret: EncryptedToastClientSecret & { lastFour: string }
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    const previous = await client.query<{ credential_version: number }>(
      `SELECT credential_version FROM organization_toast_credentials
       WHERE organization_id = $1::uuid AND access_type = $2 FOR UPDATE`,
      [input.organizationId, input.accessType],
    )
    const version = (previous.rows[0]?.credential_version || 0) + 1
    await client.query(
      `INSERT INTO organization_toast_credentials (
         organization_id, access_type, api_base_url, client_id,
         client_secret_ciphertext, client_secret_iv, client_secret_tag, client_secret_last_four,
         credential_version, verified_at, last_error_code, created_by, updated_by, created_at, updated_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, $10, $10, now(), now())
       ON CONFLICT (organization_id, access_type) DO UPDATE SET
         api_base_url = EXCLUDED.api_base_url,
         client_id = EXCLUDED.client_id,
         client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
         client_secret_iv = EXCLUDED.client_secret_iv,
         client_secret_tag = EXCLUDED.client_secret_tag,
         client_secret_last_four = EXCLUDED.client_secret_last_four,
         credential_version = EXCLUDED.credential_version,
         verified_at = now(),
         last_error_code = NULL,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        input.organizationId, input.accessType, input.apiBaseUrl, input.clientId,
        input.clientSecret.ciphertext, input.clientSecret.iv, input.clientSecret.tag,
        input.clientSecret.lastFour, version, input.actorEmail,
      ],
    )
    await audit(client, input.actorEmail, input.organizationId, 'toast.credential.updated', {
      accessType: input.accessType,
      credentialVersion: version,
      clientIdLastFour: input.clientId.slice(-4),
      clientSecretLastFour: input.clientSecret.lastFour,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

export async function markToastCredentialVerifiedInPostgres(input: {
  organizationId: string
  accessType: ToastAccessType
  errorCode?: string | null
}) {
  await query(
    `UPDATE organization_toast_credentials
     SET verified_at = CASE WHEN $3::text IS NULL THEN now() ELSE verified_at END,
         last_error_code = $3,
         updated_at = now()
     WHERE organization_id = $1::uuid AND access_type = $2`,
    [input.organizationId, input.accessType, input.errorCode || null],
  )
}

export async function deleteToastCredentialInPostgres(input: {
  organizationId: string
  accessType: ToastAccessType
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM organization_toast_credentials
       WHERE organization_id = $1::uuid AND access_type = $2`,
      [input.organizationId, input.accessType],
    )
    await audit(client, input.actorEmail, input.organizationId, 'toast.credential.disconnected', {
      accessType: input.accessType,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

export async function setToastSyncEnabledInPostgres(input: {
  organizationId: string
  enabled: boolean
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE organization_toast_credentials
       SET sync_enabled = $2, updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.organizationId, input.enabled, input.actorEmail],
    )
    await audit(client, input.actorEmail, input.organizationId, 'toast.sync.configuration.updated', {
      enabled: input.enabled,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

export async function replaceToastAnalyticsLocationsInPostgres(input: {
  organizationId: string
  locations: ToastLocationWrite[]
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE toast_locations SET analytics_access = false, updated_at = now()
       WHERE organization_id = $1::uuid`,
      [input.organizationId],
    )
    for (const location of input.locations) {
      await upsertLocation(client, input.organizationId, location, 'analytics')
    }
    await audit(client, input.actorEmail, input.organizationId, 'toast.locations.refreshed', {
      accessType: 'analytics', count: input.locations.length,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

async function upsertLocation(
  client: PoolClient,
  organizationId: string,
  location: ToastLocationWrite,
  accessType: ToastAccessType,
) {
  await client.query(
    `INSERT INTO toast_locations (
       organization_id, restaurant_guid, restaurant_name, location_name, location_code, timezone,
       active, test_mode, archived, analytics_access, standard_access, selected,
       last_verified_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
       $10 = 'analytics', $10 = 'standard', false, now(), now(), now()
     )
     ON CONFLICT (organization_id, restaurant_guid) DO UPDATE SET
       restaurant_name = EXCLUDED.restaurant_name,
       location_name = COALESCE(EXCLUDED.location_name, toast_locations.location_name),
       location_code = COALESCE(EXCLUDED.location_code, toast_locations.location_code),
       timezone = COALESCE(EXCLUDED.timezone, toast_locations.timezone),
       active = EXCLUDED.active,
       test_mode = CASE WHEN $10 = 'analytics' THEN EXCLUDED.test_mode ELSE toast_locations.test_mode END,
       archived = EXCLUDED.archived,
       analytics_access = toast_locations.analytics_access OR EXCLUDED.analytics_access,
       standard_access = toast_locations.standard_access OR EXCLUDED.standard_access,
       last_verified_at = now(),
       updated_at = now()`,
    [
      organizationId, location.restaurantGuid, location.restaurantName,
      location.locationName || null, location.locationCode || null, location.timezone || null,
      location.active !== false, location.testMode === true, location.archived === true, accessType,
    ],
  )
}

export async function upsertToastStandardLocationInPostgres(input: {
  organizationId: string
  location: ToastLocationWrite
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    await upsertLocation(client, input.organizationId, input.location, 'standard')
    await audit(client, input.actorEmail, input.organizationId, 'toast.location.verified', {
      accessType: 'standard', restaurantGuid: input.location.restaurantGuid,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

export async function setToastLocationSelectedInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  selected: boolean
  actorEmail: string
}) {
  await withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE toast_locations SET selected = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
       RETURNING restaurant_guid`,
      [input.organizationId, input.restaurantGuid, input.selected],
    )
    if (!result.rowCount) throw new Error('Toast location was not found')
    await audit(client, input.actorEmail, input.organizationId, 'toast.location.selection.updated', {
      restaurantGuid: input.restaurantGuid, selected: input.selected,
    })
  })
  return readToastIntegrationStateFromPostgres(input.organizationId)
}

async function queueToastJobWithClient(client: PoolClient, input: {
  organizationId: string
  restaurantGuid: string
  syncKind: ToastSyncJob['syncKind']
  businessDate: string
  requestedBy?: string | null
}) {
  await client.query(
    `INSERT INTO toast_sync_outbox (
       organization_id, restaurant_guid, sync_kind, business_date, status, requested_by, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'pending', $5, now(), now())
     ON CONFLICT (organization_id, restaurant_guid, sync_kind, business_date) DO UPDATE SET
       status = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN 'pending' ELSE toast_sync_outbox.status END,
       attempt_count = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN 0 ELSE toast_sync_outbox.attempt_count END,
       available_at = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN now() ELSE toast_sync_outbox.available_at END,
       locked_at = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN NULL ELSE toast_sync_outbox.locked_at END,
       locked_by = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN NULL ELSE toast_sync_outbox.locked_by END,
       last_error = CASE WHEN toast_sync_outbox.status IN ('failed', 'dead') THEN NULL ELSE toast_sync_outbox.last_error END,
       requested_by = COALESCE(EXCLUDED.requested_by, toast_sync_outbox.requested_by),
       updated_at = now()`,
    [input.organizationId, input.restaurantGuid, input.syncKind, input.businessDate, input.requestedBy || null],
  )
}

export async function queueToastSyncForDateInPostgres(input: {
  organizationId: string
  businessDate: string
  actorEmail: string
}) {
  const queued = await withTransaction(async (client) => {
    const [credentials, locations] = await Promise.all([
      client.query<{ access_type: ToastAccessType }>(
        `SELECT access_type FROM organization_toast_credentials WHERE organization_id = $1::uuid`,
        [input.organizationId],
      ),
      client.query<{ restaurant_guid: string; analytics_access: boolean; standard_access: boolean }>(
        `SELECT restaurant_guid::text, analytics_access, standard_access
         FROM toast_locations WHERE organization_id = $1::uuid AND selected AND active AND NOT archived`,
        [input.organizationId],
      ),
    ])
    const access = new Set(credentials.rows.map((row) => row.access_type))
    let count = 0
    for (const location of locations.rows) {
      if (access.has('analytics') && location.analytics_access) {
        for (const syncKind of ['analytics_sales', 'analytics_payouts'] as const) {
          await queueToastJobWithClient(client, { ...input, restaurantGuid: location.restaurant_guid, syncKind, requestedBy: input.actorEmail })
          count += 1
        }
      }
      if (access.has('standard') && location.standard_access) {
        await queueToastJobWithClient(client, {
          ...input, restaurantGuid: location.restaurant_guid, syncKind: 'standard_orders', requestedBy: input.actorEmail,
        })
        count += 1
      }
    }
    await audit(client, input.actorEmail, input.organizationId, 'toast.sync.queued', {
      businessDate: input.businessDate, jobs: count,
    })
    return count
  })
  return { queued, state: await readToastIntegrationStateFromPostgres(input.organizationId) }
}

export async function listToastAutomaticSyncTargetsInPostgres() {
  const result = await query<{
    organization_id: string
    restaurant_guid: string
    timezone: string | null
    analytics_enabled: boolean
    standard_enabled: boolean
  }>(
    `SELECT location.organization_id::text, location.restaurant_guid::text, location.timezone,
       bool_or(credential.access_type = 'analytics' AND credential.sync_enabled AND location.analytics_access) AS analytics_enabled,
       bool_or(credential.access_type = 'standard' AND credential.sync_enabled AND location.standard_access) AS standard_enabled
     FROM toast_locations location
     JOIN organization_toast_credentials credential ON credential.organization_id = location.organization_id
     WHERE location.selected AND location.active AND NOT location.archived
     GROUP BY location.organization_id, location.restaurant_guid, location.timezone`,
  )
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    restaurantGuid: row.restaurant_guid,
    timezone: row.timezone,
    analyticsEnabled: row.analytics_enabled,
    standardEnabled: row.standard_enabled,
  }))
}

export async function queueAutomaticToastSyncInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
  analyticsEnabled: boolean
  standardEnabled: boolean
}) {
  await withTransaction(async (client) => {
    if (input.analyticsEnabled) {
      await queueToastJobWithClient(client, { ...input, syncKind: 'analytics_sales' })
      await queueToastJobWithClient(client, { ...input, syncKind: 'analytics_payouts' })
    }
    if (input.standardEnabled) {
      await queueToastJobWithClient(client, { ...input, syncKind: 'standard_orders' })
    }
  })
}

export async function claimToastSyncJobsInPostgres(input: { limit: number; workerId: string }) {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string
      organization_id: string
      restaurant_guid: string
      sync_kind: ToastSyncJob['syncKind']
      business_date: string
      attempt_count: number
      max_attempts: number
      request_state: Record<string, unknown>
      requested_by: string | null
    }>(
      `WITH due AS (
         SELECT id FROM toast_sync_outbox
         WHERE status IN ('pending', 'failed') AND available_at <= now()
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE toast_sync_outbox job
       SET status = 'processing', attempt_count = attempt_count + 1,
           locked_at = now(), locked_by = $2, updated_at = now()
       FROM due WHERE job.id = due.id
       RETURNING job.id::text, job.organization_id::text, job.restaurant_guid::text,
         job.sync_kind, job.business_date::text, job.attempt_count, job.max_attempts,
         job.request_state, job.requested_by`,
      [Math.max(1, Math.min(input.limit, 20)), input.workerId],
    )
    return result.rows.map((row): ToastSyncJob => ({
      id: row.id,
      organizationId: row.organization_id,
      restaurantGuid: row.restaurant_guid,
      syncKind: row.sync_kind,
      businessDate: row.business_date,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      requestState: row.request_state || {},
      requestedBy: row.requested_by,
    }))
  })
}

export async function deferToastSyncJobInPostgres(input: {
  id: string
  requestState: Record<string, unknown>
  delaySeconds?: number
}) {
  await query(
    `UPDATE toast_sync_outbox
     SET status = 'pending', request_state = $2::jsonb,
         attempt_count = greatest(0, attempt_count - 1),
         available_at = now() + ($3::text || ' seconds')::interval,
         locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1::uuid`,
    [input.id, JSON.stringify(input.requestState), Math.max(5, Math.min(input.delaySeconds || 15, 300))],
  )
}

export async function failToastSyncJobInPostgres(input: {
  job: ToastSyncJob
  error: string
}) {
  const dead = input.job.attemptCount >= input.job.maxAttempts
  await query(
    `UPDATE toast_sync_outbox
     SET status = $2, last_error = $3,
         available_at = CASE WHEN $2 = 'failed' THEN now() + (least(300, power(2, attempt_count))::text || ' seconds')::interval ELSE available_at END,
         locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1::uuid`,
    [input.job.id, dead ? 'dead' : 'failed', input.error.slice(0, 1000)],
  )
  return dead
}

export async function completeToastSyncJobInPostgres(input: {
  job: ToastSyncJob
  resultSummary: Record<string, unknown>
}) {
  await query(
    `UPDATE toast_sync_outbox
     SET status = 'succeeded', result_summary = $2::jsonb, last_error = NULL,
         locked_at = NULL, locked_by = NULL, completed_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [input.job.id, JSON.stringify(input.resultSummary)],
  )
}

export async function storeToastSnapshotsInPostgres(input: {
  job: ToastSyncJob
  sourceKind: 'analytics_sales' | 'analytics_payout' | 'standard_order'
  records: Array<{ sourceId: string; payload: unknown }>
}) {
  await withTransaction(async (client) => {
    for (const record of input.records) {
      const serialized = JSON.stringify(record.payload)
      const payloadHash = crypto.createHash('sha256').update(serialized).digest('hex')
      await client.query(
        `INSERT INTO toast_source_snapshots (
           organization_id, restaurant_guid, source_kind, source_id, business_date,
           payload_hash, payload, observed_at, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7::jsonb, now(), now(), now())
         ON CONFLICT (organization_id, source_kind, source_id, payload_hash) DO UPDATE SET
           observed_at = now(), updated_at = now()`,
        [
          input.job.organizationId, input.job.restaurantGuid, input.sourceKind,
          record.sourceId.slice(0, 512), input.job.businessDate, payloadHash, serialized,
        ],
      )
    }
  })
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export async function upsertToastAnalyticsSalesInPostgres(input: {
  job: ToastSyncJob
  records: unknown[]
}) {
  type SalesTotals = {
    grossSales: number
    netSales: number
    discounts: number
    voids: number
    refunds: number
    orders: number
    guests: number
  }
  const totals = input.records.reduce<SalesTotals>((sum, value) => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    sum.grossSales += numberValue(record.grossSalesAmount)
    sum.netSales += numberValue(record.netSalesAmount)
    sum.discounts += numberValue(record.discountAmount)
    sum.voids += numberValue(record.voidOrdersAmount)
    sum.refunds += numberValue(record.refundAmount)
    sum.orders += numberValue(record.ordersCount)
    sum.guests += numberValue(record.guestCount)
    return sum
  }, { grossSales: 0, netSales: 0, discounts: 0, voids: 0, refunds: 0, orders: 0, guests: 0 })
  await query(
    `INSERT INTO toast_daily_sales (
       organization_id, restaurant_guid, business_date, gross_sales, net_sales,
       discounts, voids, refunds, orders_count, guest_count, analytics_rows, source_revision, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())
     ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
       gross_sales = EXCLUDED.gross_sales, net_sales = EXCLUDED.net_sales,
       discounts = EXCLUDED.discounts, voids = EXCLUDED.voids, refunds = EXCLUDED.refunds,
       orders_count = EXCLUDED.orders_count, guest_count = EXCLUDED.guest_count,
       analytics_rows = EXCLUDED.analytics_rows,
       source_revision = toast_daily_sales.source_revision + 1, updated_at = now()`,
    [
      input.job.organizationId, input.job.restaurantGuid, input.job.businessDate,
      totals.grossSales, totals.netSales, totals.discounts, totals.voids, totals.refunds,
      Math.round(totals.orders), Math.round(totals.guests), input.records.length,
    ],
  )
  return totals
}

export async function updateToastStandardOrdersCountInPostgres(input: {
  job: ToastSyncJob
  count: number
}) {
  await query(
    `INSERT INTO toast_daily_sales (
       organization_id, restaurant_guid, business_date, standard_orders_count, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::date, $4, now())
     ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
       standard_orders_count = EXCLUDED.standard_orders_count,
       source_revision = toast_daily_sales.source_revision + 1, updated_at = now()`,
    [input.job.organizationId, input.job.restaurantGuid, input.job.businessDate, input.count],
  )
}

export async function refreshToastAccountingDraftInPostgres(job: ToastSyncJob) {
  const [salesResult, jobsResult, mappingsResult] = await Promise.all([
    query<{
      gross_sales: string; net_sales: string; discounts: string; voids: string; refunds: string
      orders_count: number; standard_orders_count: number
    }>(
      `SELECT gross_sales::text, net_sales::text, discounts::text, voids::text, refunds::text,
         orders_count, standard_orders_count
       FROM toast_daily_sales
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [job.organizationId, job.restaurantGuid, job.businessDate],
    ),
    query<{ sync_kind: ToastSyncJob['syncKind']; status: string }>(
      `SELECT sync_kind, status FROM toast_sync_outbox
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date`,
      [job.organizationId, job.restaurantGuid, job.businessDate],
    ),
    query<{ mapping_key: string; quickbooks_account_id: string | null; quickbooks_account_name: string | null }>(
      `SELECT mapping_key, quickbooks_account_id, quickbooks_account_name
       FROM toast_accounting_mappings
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid`,
      [job.organizationId, job.restaurantGuid],
    ),
  ])
  const sales = salesResult.rows[0]
  if (!sales) return
  const succeeded = new Set(jobsResult.rows.filter((row) => row.status === 'succeeded').map((row) => row.sync_kind))
  const analyticsReady = succeeded.has('analytics_sales')
  const ordersReady = succeeded.has('standard_orders')
  const reconciliationStatus = analyticsReady && ordersReady
    ? 'ready'
    : analyticsReady ? 'analytics_only' : ordersReady ? 'orders_only' : 'pending'
  const mappings = new Map(mappingsResult.rows.map((row) => [row.mapping_key, row]))
  const lines = [
    ['gross_sales', Number(sales.gross_sales), 'credit'],
    ['discounts', Number(sales.discounts), 'debit'],
    ['voids', Number(sales.voids), 'debit'],
    ['refunds', Number(sales.refunds), 'debit'],
  ].filter(([, amount]) => Number(amount) !== 0).map(([key, amount, direction]) => ({
    key,
    amount,
    direction,
    quickbooksAccountId: mappings.get(String(key))?.quickbooks_account_id || null,
    quickbooksAccountName: mappings.get(String(key))?.quickbooks_account_name || null,
  }))
  const allMapped = lines.length > 0 && lines.every((line) => line.quickbooksAccountId)
  const status = allMapped && reconciliationStatus === 'ready' ? 'needs_review' : 'needs_mapping'
  const idempotencyKey = crypto.createHash('sha256')
    .update(`clawpilot:toast-accounting:v1:${job.organizationId}:${job.restaurantGuid}:${job.businessDate}`)
    .digest('hex')
  await query(
    `INSERT INTO toast_accounting_export_drafts (
       organization_id, restaurant_guid, business_date, idempotency_key, status,
       reconciliation_status, source_summary, proposed_lines, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::jsonb, $8::jsonb, now(), now())
     ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
       status = CASE
         WHEN toast_accounting_export_drafts.status IN ('approved', 'posting', 'posted') THEN toast_accounting_export_drafts.status
         ELSE EXCLUDED.status
       END,
       reconciliation_status = EXCLUDED.reconciliation_status,
       source_summary = EXCLUDED.source_summary,
       proposed_lines = EXCLUDED.proposed_lines,
       updated_at = now()`,
    [
      job.organizationId, job.restaurantGuid, job.businessDate, idempotencyKey, status, reconciliationStatus,
      JSON.stringify({
        grossSales: Number(sales.gross_sales), netSales: Number(sales.net_sales),
        discounts: Number(sales.discounts), voids: Number(sales.voids), refunds: Number(sales.refunds),
        analyticsOrders: sales.orders_count, standardOrders: sales.standard_orders_count,
        analyticsReady, standardOrdersReady: ordersReady,
      }),
      JSON.stringify(lines),
    ],
  )
}

const TOAST_WORKER_HEARTBEAT_KEY = 'toast.sync.worker.heartbeat'

export async function recordToastWorkerHeartbeatInPostgres(details: Record<string, unknown>) {
  const payload = { checkedAt: new Date().toISOString(), ...details }
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TOAST_WORKER_HEARTBEAT_KEY, JSON.stringify(payload)],
  )
  return payload
}

export async function readToastWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    `SELECT value FROM app_settings WHERE key = $1 LIMIT 1`,
    [TOAST_WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}
