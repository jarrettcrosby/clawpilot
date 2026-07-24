import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { projectToastOrders } from '@/lib/integrations/toastOrderProjection'
import { PosAccountingRequestError } from '@/lib/persistence/posAccounting'
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

export type ToastDatasetCoverage = {
  available: boolean
  successfulJobs: number
  failedJobs: number
  businessDates: number
  records: number
  latestBusinessDate: string | null
}

export type ToastReportingState = {
  businessDays: number
  firstBusinessDate: string | null
  latestBusinessDate: string | null
  locationsWithData: number
  totals: {
    grossSales: number
    netSales: number
    discounts: number
    voids: number
    refunds: number
    orders: number
    guests: number
    standardOrders: number
    analyticsRows: number
  }
  datasets: {
    restaurantProfiles: { available: boolean; locations: number }
    standardOrders: ToastDatasetCoverage
    analyticsSales: ToastDatasetCoverage
    analyticsPayouts: ToastDatasetCoverage
  }
  noDataReason: 'credentials_required' | 'locations_required' | 'sync_required' | 'no_records' | null
}

export type ToastIntegrationState = {
  organizationId: string
  credentials: Record<ToastAccessType, ToastCredentialState>
  locations: ToastLocationState[]
  jobs: { pending: number; processing: number; failed: number; dead: number; succeeded: number }
  accountingDrafts: { needsMapping: number; needsReview: number; approved: number; posted: number; failed: number }
  reporting: ToastReportingState
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
  timezone: string | null
  syncKind: 'analytics_sales' | 'analytics_payouts' | 'standard_orders' | 'standard_order_updates'
  businessDate: string
  attemptCount: number
  maxAttempts: number
  requestState: Record<string, unknown>
  requestedBy: string | null
  lockToken: string
}

function iso(value: TimestampValue | null | undefined) {
  return value ? new Date(value).toISOString() : null
}

function dateOnly(value: TimestampValue | null | undefined) {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  return value.toISOString().slice(0, 10)
}

function count(value: string | number | null | undefined) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function emptyDatasetCoverage(): ToastDatasetCoverage {
  return {
    available: false,
    successfulJobs: 0,
    failedJobs: 0,
    businessDates: 0,
    records: 0,
    latestBusinessDate: null,
  }
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
  const [credentialResult, locationResult, jobResult, draftResult, latestResult, reportingResult, datasetResult] = await Promise.all([
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
       FROM toast_accounting_export_drafts
       WHERE organization_id = $1::uuid AND is_current
       GROUP BY status`,
      [organizationId],
    ),
    query<{ latest: TimestampValue | null }>(
      `SELECT max(completed_at) AS latest
       FROM toast_sync_outbox WHERE organization_id = $1::uuid AND status = 'succeeded'`,
      [organizationId],
    ),
    query<{
      business_days: string
      first_business_date: TimestampValue | null
      latest_business_date: TimestampValue | null
      locations_with_data: string
      gross_sales: string
      net_sales: string
      discounts: string
      voids: string
      refunds: string
      orders_count: string
      guest_count: string
      standard_orders_count: string
      analytics_rows: string
    }>(
      `SELECT
         count(DISTINCT business_date)::text AS business_days,
         min(business_date) AS first_business_date,
         max(business_date) AS latest_business_date,
         count(DISTINCT restaurant_guid)::text AS locations_with_data,
         coalesce(sum(gross_sales), 0)::text AS gross_sales,
         coalesce(sum(net_sales), 0)::text AS net_sales,
         coalesce(sum(discounts), 0)::text AS discounts,
         coalesce(sum(voids), 0)::text AS voids,
         coalesce(sum(refunds), 0)::text AS refunds,
         coalesce(sum(orders_count), 0)::text AS orders_count,
         coalesce(sum(guest_count), 0)::text AS guest_count,
         coalesce(sum(standard_orders_count), 0)::text AS standard_orders_count,
         coalesce(sum(analytics_rows), 0)::text AS analytics_rows
       FROM toast_daily_sales
       WHERE organization_id = $1::uuid`,
      [organizationId],
    ),
    query<{
      sync_kind: ToastSyncJob['syncKind']
      successful_jobs: string
      failed_jobs: string
      business_dates: string
      records: string
      latest_business_date: TimestampValue | null
    }>(
      `SELECT
         CASE WHEN sync_kind = 'standard_order_updates' THEN 'standard_orders' ELSE sync_kind END AS sync_kind,
         count(*) FILTER (WHERE status = 'succeeded')::text AS successful_jobs,
         count(*) FILTER (WHERE status IN ('failed', 'dead'))::text AS failed_jobs,
         count(DISTINCT business_date) FILTER (WHERE status = 'succeeded')::text AS business_dates,
         coalesce(sum(
           CASE
             WHEN status = 'succeeded' AND jsonb_typeof(result_summary -> 'records') = 'number'
               THEN (result_summary ->> 'records')::bigint
             ELSE 0
           END
         ), 0)::text AS records,
         max(business_date) FILTER (WHERE status = 'succeeded') AS latest_business_date
       FROM toast_sync_outbox
       WHERE organization_id = $1::uuid
       GROUP BY CASE WHEN sync_kind = 'standard_order_updates' THEN 'standard_orders' ELSE sync_kind END`,
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
  const locations = locationResult.rows.map(locationState)
  const reportingRow = reportingResult.rows[0]
  const datasets = {
    restaurantProfiles: {
      available: locations.some((location) => location.standardAccess),
      locations: locations.filter((location) => location.standardAccess).length,
    },
    standardOrders: emptyDatasetCoverage(),
    analyticsSales: emptyDatasetCoverage(),
    analyticsPayouts: emptyDatasetCoverage(),
  }
  datasets.standardOrders.available = credentials.standard.configured
    && locations.some((location) => location.selected && location.standardAccess)
  datasets.analyticsSales.available = credentials.analytics.configured
    && locations.some((location) => location.selected && location.analyticsAccess)
  datasets.analyticsPayouts.available = datasets.analyticsSales.available
  const datasetKeys: Record<ToastSyncJob['syncKind'], keyof Omit<typeof datasets, 'restaurantProfiles'>> = {
    standard_orders: 'standardOrders',
    standard_order_updates: 'standardOrders',
    analytics_sales: 'analyticsSales',
    analytics_payouts: 'analyticsPayouts',
  }
  for (const row of datasetResult.rows) {
    const dataset = datasets[datasetKeys[row.sync_kind]]
    dataset.successfulJobs = count(row.successful_jobs)
    dataset.failedJobs = count(row.failed_jobs)
    dataset.businessDates = count(row.business_dates)
    dataset.records = count(row.records)
    dataset.latestBusinessDate = dateOnly(row.latest_business_date)
  }
  const selectedLocations = locations.filter((location) => location.selected).length
  const successfulJobs = datasets.standardOrders.successfulJobs
    + datasets.analyticsSales.successfulJobs
    + datasets.analyticsPayouts.successfulJobs
  const sourceRecords = datasets.standardOrders.records + datasets.analyticsSales.records + datasets.analyticsPayouts.records
  const configuredCredentials = credentials.standard.configured || credentials.analytics.configured
  const noDataReason = !configuredCredentials
    ? 'credentials_required'
    : selectedLocations === 0
      ? 'locations_required'
      : successfulJobs === 0
        ? 'sync_required'
        : sourceRecords === 0
          ? 'no_records'
          : null
  const reporting: ToastReportingState = {
    businessDays: count(reportingRow?.business_days),
    firstBusinessDate: dateOnly(reportingRow?.first_business_date),
    latestBusinessDate: dateOnly(reportingRow?.latest_business_date),
    locationsWithData: count(reportingRow?.locations_with_data),
    totals: {
      grossSales: count(reportingRow?.gross_sales),
      netSales: count(reportingRow?.net_sales),
      discounts: count(reportingRow?.discounts),
      voids: count(reportingRow?.voids),
      refunds: count(reportingRow?.refunds),
      orders: count(reportingRow?.orders_count),
      guests: count(reportingRow?.guest_count),
      standardOrders: count(reportingRow?.standard_orders_count),
      analyticsRows: count(reportingRow?.analytics_rows),
    },
    datasets,
    noDataReason,
  }
  return {
    organizationId,
    credentials,
    locations,
    jobs,
    accountingDrafts,
    reporting,
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
  rerunAfterSeconds?: number | null
}) {
  const rerunAfterSeconds = input.rerunAfterSeconds === null || input.rerunAfterSeconds === undefined
    ? null
    : Math.max(0, Math.min(Math.round(input.rerunAfterSeconds), 86400))
  await client.query(
    `INSERT INTO toast_sync_outbox (
       organization_id, restaurant_guid, sync_kind, business_date, status, requested_by, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4::date, 'pending', $5, now(), now())
     ON CONFLICT (organization_id, restaurant_guid, sync_kind, business_date) DO UPDATE SET
       requested_by = COALESCE(EXCLUDED.requested_by, toast_sync_outbox.requested_by),
       rerun_requested_at = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status = 'processing' THEN now()
         WHEN $6::integer = 0 THEN NULL
         ELSE toast_sync_outbox.rerun_requested_at
       END,
       status = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN 'pending'
         WHEN $6::integer IS NOT NULL
           AND toast_sync_outbox.status = 'succeeded'
           AND COALESCE(toast_sync_outbox.completed_at, toast_sync_outbox.updated_at) <= now() - make_interval(secs => $6::integer)
           THEN 'pending'
         ELSE toast_sync_outbox.status
       END,
       attempt_count = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN 0
         WHEN $6::integer IS NOT NULL
           AND toast_sync_outbox.status = 'succeeded'
           AND COALESCE(toast_sync_outbox.completed_at, toast_sync_outbox.updated_at) <= now() - make_interval(secs => $6::integer)
           THEN 0
         ELSE toast_sync_outbox.attempt_count
       END,
       available_at = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN now()
         WHEN $6::integer IS NOT NULL
           AND toast_sync_outbox.status = 'succeeded'
           AND COALESCE(toast_sync_outbox.completed_at, toast_sync_outbox.updated_at) <= now() - make_interval(secs => $6::integer)
           THEN now()
         ELSE toast_sync_outbox.available_at
       END,
       completed_at = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN NULL
         WHEN $6::integer IS NOT NULL
           AND toast_sync_outbox.status = 'succeeded'
           AND COALESCE(toast_sync_outbox.completed_at, toast_sync_outbox.updated_at) <= now() - make_interval(secs => $6::integer)
           THEN NULL
         ELSE toast_sync_outbox.completed_at
       END,
       request_state = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN '{}'::jsonb
         WHEN $6::integer IS NOT NULL
           AND toast_sync_outbox.status = 'succeeded'
           AND COALESCE(toast_sync_outbox.completed_at, toast_sync_outbox.updated_at) <= now() - make_interval(secs => $6::integer)
           THEN '{}'::jsonb
         ELSE toast_sync_outbox.request_state
       END,
       last_error = CASE
         WHEN $6::integer = 0 AND toast_sync_outbox.status <> 'processing' THEN NULL
         ELSE toast_sync_outbox.last_error
       END,
       updated_at = now()`,
    [
      input.organizationId,
      input.restaurantGuid,
      input.syncKind,
      input.businessDate,
      input.requestedBy || null,
      rerunAfterSeconds,
    ],
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
          await queueToastJobWithClient(client, {
            ...input,
            restaurantGuid: location.restaurant_guid,
            syncKind,
            requestedBy: input.actorEmail,
            rerunAfterSeconds: 0,
          })
          count += 1
        }
      }
      if (access.has('standard') && location.standard_access) {
        await queueToastJobWithClient(client, {
          ...input, restaurantGuid: location.restaurant_guid, syncKind: 'standard_orders', requestedBy: input.actorEmail,
          rerunAfterSeconds: 0,
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

export async function queuePosAccountingSalesReloadInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
  actorEmail: string
}) {
  return withTransaction(async (client) => {
    const [locationResult, credentialResult] = await Promise.all([
      client.query<{
        restaurant_guid: string
        restaurant_name: string
        location_name: string | null
        analytics_access: boolean
        standard_access: boolean
      }>(
        `SELECT restaurant_guid::text, restaurant_name, location_name,
           analytics_access, standard_access
         FROM toast_locations
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
           AND active = true AND archived = false
         FOR SHARE`,
        [input.organizationId, input.restaurantGuid],
      ),
      client.query<{ access_type: ToastAccessType }>(
        `SELECT access_type
         FROM organization_toast_credentials
         WHERE organization_id = $1::uuid`,
        [input.organizationId],
      ),
    ])
    const location = locationResult.rows[0]
    if (!location) {
      throw new PosAccountingRequestError('POS_LOCATION_NOT_FOUND', 'The selected Toast location was not found', 404)
    }
    const access = new Set(credentialResult.rows.map((row) => row.access_type))
    const expectedSyncKinds: ToastSyncJob['syncKind'][] = []
    if (access.has('analytics') && location.analytics_access) expectedSyncKinds.push('analytics_sales')
    if (access.has('standard') && location.standard_access) expectedSyncKinds.push('standard_orders')
    if (!expectedSyncKinds.length) {
      throw new PosAccountingRequestError(
        'POS_ACCOUNTING_SALES_SOURCE_REQUIRED',
        'Configure Analytics or Standard Orders access for this Toast location before reloading sales',
        409,
      )
    }

    await client.query(
      `UPDATE pos_accounting_commands
       SET status = 'failed', last_error = 'Accounting command was interrupted before completion',
         completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid
         AND business_date = $3::date AND status = 'running'
         AND updated_at < now() - interval '15 minutes'`,
      [input.organizationId, input.restaurantGuid, input.businessDate],
    )

    const commandResult = await client.query<{
      id: string
      status: string
      created_at: TimestampValue
      updated_at: TimestampValue
    }>(
      `INSERT INTO pos_accounting_commands (
         organization_id, restaurant_guid, business_date, command_type,
         status, requested_by, expected_sync_kinds, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::date, 'reload_sales', 'queued', $4, $5::text[], now(), now())
       ON CONFLICT DO NOTHING
       RETURNING id::text, status, created_at, updated_at`,
      [input.organizationId, input.restaurantGuid, input.businessDate, input.actorEmail, expectedSyncKinds],
    )
    const command = commandResult.rows[0]
    if (!command) {
      throw new PosAccountingRequestError(
        'POS_ACCOUNTING_RELOAD_IN_PROGRESS',
        'An accounting command is already running for this location and business date',
        409,
      )
    }
    for (const syncKind of expectedSyncKinds) {
      await queueToastJobWithClient(client, {
        ...input,
        syncKind,
        requestedBy: input.actorEmail,
        rerunAfterSeconds: 0,
      })
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      subject: input.actorEmail,
      organizationId: input.organizationId,
      eventType: 'pos.accounting.sales_reload.queued',
      aggregateType: 'pos_accounting_command',
      aggregateId: command.id,
      payload: {
        message: 'Toast sales reload queued for POS accounting',
        commandType: 'reload_sales',
        commandId: command.id,
        restaurantGuid: input.restaurantGuid,
        restaurantName: location.location_name || location.restaurant_name,
        businessDate: input.businessDate,
        expectedSyncKinds,
      },
    }, client)
    return {
      id: command.id,
      commandType: 'reload_sales' as const,
      status: 'queued' as const,
      requestedBy: input.actorEmail,
      expectedSyncKinds,
      resultDraftId: null,
      resultDraftRevision: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(command.created_at).toISOString(),
      updatedAt: new Date(command.updated_at).toISOString(),
    }
  })
}

export async function listToastAutomaticSyncTargetsInPostgres() {
  const result = await query<{
    organization_id: string
    restaurant_guid: string
    timezone: string | null
    analytics_enabled: boolean
    standard_enabled: boolean
    latest_standard_update_date: string | null
  }>(
    `SELECT location.organization_id::text, location.restaurant_guid::text, location.timezone,
       bool_or(credential.access_type = 'analytics' AND credential.sync_enabled AND location.analytics_access) AS analytics_enabled,
       bool_or(credential.access_type = 'standard' AND credential.sync_enabled AND location.standard_access) AS standard_enabled,
       (max(job.business_date) FILTER (
         WHERE job.sync_kind = 'standard_order_updates' AND job.status = 'succeeded'
       ))::text AS latest_standard_update_date
     FROM toast_locations location
     JOIN organization_toast_credentials credential ON credential.organization_id = location.organization_id
     LEFT JOIN toast_sync_outbox job
       ON job.organization_id = location.organization_id
      AND job.restaurant_guid = location.restaurant_guid
     WHERE location.selected AND location.active AND NOT location.archived
     GROUP BY location.organization_id, location.restaurant_guid, location.timezone`,
  )
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    restaurantGuid: row.restaurant_guid,
    timezone: row.timezone,
    analyticsEnabled: row.analytics_enabled,
    standardEnabled: row.standard_enabled,
    latestStandardUpdateDate: row.latest_standard_update_date,
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
      await queueToastJobWithClient(client, { ...input, syncKind: 'standard_order_updates', rerunAfterSeconds: 900 })
    }
  })
}

export async function queueAutomaticToastOrderUpdateInPostgres(input: {
  organizationId: string
  restaurantGuid: string
  businessDate: string
}) {
  await withTransaction(async (client) => {
    await queueToastJobWithClient(client, { ...input, syncKind: 'standard_order_updates', rerunAfterSeconds: 900 })
  })
}

export async function claimToastSyncJobsInPostgres(input: { limit: number; workerId: string }) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE toast_sync_outbox
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'failed' END,
           available_at = CASE WHEN attempt_count >= max_attempts THEN available_at ELSE now() END,
           locked_at = NULL, locked_by = NULL, lock_token = NULL,
           postprocess_token = NULL, postprocess_started_at = NULL,
           last_error = 'Worker lease expired before completion.', updated_at = now()
       WHERE status = 'processing'
         AND COALESCE(locked_at, updated_at) < now() - interval '15 minutes'`,
    )
    await client.query(
      `UPDATE toast_sync_outbox
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'failed' END,
           available_at = CASE WHEN attempt_count >= max_attempts THEN available_at ELSE now() END,
           completed_at = NULL,
           postprocess_token = NULL, postprocess_started_at = NULL,
           last_error = 'Worker post-processing lease expired before accounting refresh completed.',
           updated_at = now()
       WHERE status IN ('succeeded', 'pending')
         AND postprocess_token IS NOT NULL
         AND COALESCE(postprocess_started_at, updated_at) < now() - interval '15 minutes'`,
    )
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
      lock_token: string
      timezone: string | null
    }>(
       `WITH due AS (
         SELECT id FROM toast_sync_outbox
         WHERE status IN ('pending', 'failed')
           AND postprocess_token IS NULL
           AND attempt_count < max_attempts
           AND available_at <= now()
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ), claimed AS (
         UPDATE toast_sync_outbox job
         SET status = 'processing', attempt_count = attempt_count + 1,
             locked_at = now(), locked_by = $2, lock_token = gen_random_uuid(),
             postprocess_token = NULL, postprocess_started_at = NULL, updated_at = now()
         FROM due WHERE job.id = due.id
         RETURNING job.id::text, job.organization_id, job.restaurant_guid,
           job.sync_kind, job.business_date::text, job.attempt_count, job.max_attempts,
           job.request_state, job.requested_by, job.lock_token::text
       )
       SELECT claimed.id, claimed.organization_id::text, claimed.restaurant_guid::text,
         claimed.sync_kind, claimed.business_date, claimed.attempt_count, claimed.max_attempts,
         claimed.request_state, claimed.requested_by, claimed.lock_token, location.timezone
       FROM claimed
       LEFT JOIN toast_locations location
         ON location.organization_id = claimed.organization_id
        AND location.restaurant_guid = claimed.restaurant_guid`,
      [Math.max(1, Math.min(input.limit, 20)), input.workerId],
    )
    return result.rows.map((row): ToastSyncJob => ({
      id: row.id,
      organizationId: row.organization_id,
      restaurantGuid: row.restaurant_guid,
      timezone: row.timezone,
      syncKind: row.sync_kind,
      businessDate: row.business_date,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      requestState: row.request_state || {},
      requestedBy: row.requested_by,
      lockToken: row.lock_token,
    }))
  })
}

export async function deferToastSyncJobInPostgres(input: {
  job: ToastSyncJob
  requestState: Record<string, unknown>
  delaySeconds?: number
}) {
  const result = await query(
    `UPDATE toast_sync_outbox
     SET status = 'pending', request_state = $2::jsonb,
         attempt_count = greatest(0, attempt_count - 1),
         available_at = now() + ($3::text || ' seconds')::interval,
         locked_at = NULL, locked_by = NULL, updated_at = now(),
         lock_token = NULL, postprocess_token = NULL, postprocess_started_at = NULL
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $4::uuid`,
    [input.job.id, JSON.stringify(input.requestState), Math.max(5, Math.min(input.delaySeconds || 15, 300)), input.job.lockToken],
  )
  return result.rowCount === 1
}

export async function failToastSyncJobInPostgres(input: {
  job: ToastSyncJob
  error: string
}) {
  const dead = input.job.attemptCount >= input.job.maxAttempts
  const result = await query<{ status: string }>(
    `UPDATE toast_sync_outbox
     SET status = $2, last_error = $3,
         available_at = CASE WHEN $2 = 'failed' THEN now() + (least(300, power(2, attempt_count))::text || ' seconds')::interval ELSE available_at END,
         attempt_count = greatest(attempt_count, $5::integer),
         completed_at = NULL,
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         postprocess_token = NULL, postprocess_started_at = NULL, updated_at = now()
     WHERE id = $1::uuid
       AND (
         (status = 'processing' AND lock_token = $4::uuid)
         OR (status IN ('succeeded', 'pending') AND postprocess_token = $4::uuid)
       )
     RETURNING status`,
    [
      input.job.id,
      dead ? 'dead' : 'failed',
      input.error.slice(0, 1000),
      input.job.lockToken,
      input.job.attemptCount,
    ],
  )
  return { accepted: result.rowCount === 1, dead: result.rows[0]?.status === 'dead' }
}

export async function completeToastSyncJobInPostgres(input: {
  job: ToastSyncJob
  resultSummary: Record<string, unknown>
}) {
  const result = await query(
    `UPDATE toast_sync_outbox
     SET status = CASE WHEN rerun_requested_at IS NULL THEN 'succeeded' ELSE 'pending' END,
         result_summary = $2::jsonb, last_error = NULL,
         attempt_count = CASE WHEN rerun_requested_at IS NULL THEN attempt_count ELSE 0 END,
         available_at = CASE WHEN rerun_requested_at IS NULL THEN available_at ELSE now() END,
         request_state = CASE WHEN rerun_requested_at IS NULL THEN request_state ELSE '{}'::jsonb END,
         locked_at = NULL, locked_by = NULL, lock_token = NULL,
         postprocess_token = $3::uuid, postprocess_started_at = now(),
         completed_at = CASE WHEN rerun_requested_at IS NULL THEN now() ELSE NULL END,
         rerun_requested_at = NULL, updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $3::uuid`,
    [input.job.id, JSON.stringify(input.resultSummary), input.job.lockToken],
  )
  return result.rowCount === 1
}

export async function finishToastSyncPostProcessingInPostgres(input: { job: ToastSyncJob }) {
  const result = await query(
    `UPDATE toast_sync_outbox
     SET postprocess_token = NULL, postprocess_started_at = NULL, updated_at = now()
     WHERE id = $1::uuid
       AND status IN ('succeeded', 'pending')
       AND postprocess_token = $2::uuid`,
    [input.job.id, input.job.lockToken],
  )
  return result.rowCount === 1
}

async function assertToastJobLease(client: PoolClient, job: ToastSyncJob) {
  const lease = await client.query(
    `SELECT id FROM toast_sync_outbox
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2::uuid
     FOR UPDATE`,
    [job.id, job.lockToken],
  )
  if (lease.rowCount !== 1) throw new Error('Toast sync worker lease expired')
}

export async function storeToastSnapshotsInPostgres(input: {
  job: ToastSyncJob
  sourceKind: 'analytics_sales' | 'analytics_payout' | 'standard_order'
  records: Array<{ sourceId: string; payload: unknown }>
}) {
  await withTransaction(async (client) => {
    await assertToastJobLease(client, input.job)
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
  await withTransaction(async (client) => {
    await assertToastJobLease(client, input.job)
    await client.query(
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
  })
  return totals
}

function businessDateForInstant(value: string | null, timezoneValue: string | null) {
  if (!value) return null
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneValue || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant)
    const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    const candidate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`
    return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null
  } catch {
    return instant.toISOString().slice(0, 10)
  }
}

function projectedOrderBusinessDates(
  order: ReturnType<typeof projectToastOrders>['orders'][number],
  sourceBusinessDate: string,
  timezone: string | null,
) {
  // Toast's payment-level paidBusinessDate already reflects the restaurant's
  // closeout rules. Only fall back to the restaurant-local paidAt calendar for
  // older payloads that do not expose that field.
  const paymentBusinessDates = new Set<string>()
  const activeChecks = order.details.checks.filter((check) => !check.voided && !check.deleted)
  for (const check of activeChecks) {
    if (check.payments.length === 0) {
      const checkDate = businessDateForInstant(check.paidAt || order.paidAt, timezone)
      if (checkDate) paymentBusinessDates.add(checkDate)
      continue
    }
    for (const payment of check.payments) {
      const paymentDate = payment.paidBusinessDate
        || businessDateForInstant(payment.paidAt || check.paidAt || order.paidAt, timezone)
      if (paymentDate) paymentBusinessDates.add(paymentDate)
    }
  }
  if (activeChecks.length === 0) {
    const orderDate = businessDateForInstant(order.paidAt, timezone)
    if (orderDate) paymentBusinessDates.add(orderDate)
  }
  const fulfillmentBusinessDate = businessDateForInstant(
    order.promisedAt || order.estimatedFulfillmentAt,
    timezone,
  ) || sourceBusinessDate
  return {
    paymentBusinessDates: [...paymentBusinessDates].sort(),
    fulfillmentBusinessDate,
  }
}

export async function projectToastStandardOrdersInPostgres(input: {
  job: ToastSyncJob
  orders: unknown[]
  replaceBusinessDate?: boolean
}) {
  const projection = projectToastOrders(input.orders)
  const accountingBusinessDates = new Set<string>([input.job.businessDate])
  await withTransaction(async (client) => {
    await assertToastJobLease(client, input.job)
    const incomingOrderGuids = projection.orders.map((order) => order.orderGuid)
    const priorDateResult = await client.query<{
      business_date: TimestampValue
      fulfillment_business_date: TimestampValue
      payment_business_dates: TimestampValue[]
    }>(
      `SELECT business_date, fulfillment_business_date, payment_business_dates
       FROM toast_pos_orders
       WHERE organization_id = $1::uuid
         AND restaurant_guid = $2::uuid
         AND (
           business_date = $3::date
           OR order_guid = ANY($4::text[])
         )`,
      [
        input.job.organizationId,
        input.job.restaurantGuid,
        input.job.businessDate,
        incomingOrderGuids,
      ],
    )
    const priorSourceBusinessDates = new Set<string>()
    for (const row of priorDateResult.rows) {
      const sourceDate = dateOnly(row.business_date)
      const fulfillmentDate = dateOnly(row.fulfillment_business_date)
      if (sourceDate) {
        priorSourceBusinessDates.add(sourceDate)
        accountingBusinessDates.add(sourceDate)
      }
      if (fulfillmentDate) accountingBusinessDates.add(fulfillmentDate)
      for (const paymentDateValue of row.payment_business_dates || []) {
        const paymentDate = dateOnly(paymentDateValue)
        if (paymentDate) accountingBusinessDates.add(paymentDate)
      }
    }
    for (const order of projection.orders) {
      const normalizedDates = projectedOrderBusinessDates(
        order,
        input.job.businessDate,
        input.job.timezone,
      )
      normalizedDates.paymentBusinessDates.forEach((date) => accountingBusinessDates.add(date))
      accountingBusinessDates.add(normalizedDates.fulfillmentBusinessDate)
      await client.query(
        `INSERT INTO toast_pos_orders (
           organization_id, restaurant_guid, order_guid, business_date, display_number,
           source, dining_option, approval_status, payment_status, opened_at, closed_at, paid_at,
           created_at_source, modified_at_source, promised_at, estimated_fulfillment_at,
           payment_business_dates, fulfillment_business_date,
           guest_count, check_count, item_count, gross_sales, net_sales, discounts, tax,
           service_charges, tips, refunds, tendered, total, cash_tender, card_tender,
           other_tender, voided, deleted, details, payload_hash, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8, $9, $10::timestamptz,
           $11::timestamptz, $12::timestamptz, $13::timestamptz, $14::timestamptz,
           $15::timestamptz, $16::timestamptz, $17::date[], $18::date,
           $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
           $33, $34, $35, $36::jsonb, $37, now()
         ) ON CONFLICT (organization_id, restaurant_guid, order_guid) DO UPDATE SET
           business_date = EXCLUDED.business_date, display_number = EXCLUDED.display_number,
           source = EXCLUDED.source, dining_option = EXCLUDED.dining_option,
           approval_status = EXCLUDED.approval_status, payment_status = EXCLUDED.payment_status,
           opened_at = EXCLUDED.opened_at, closed_at = EXCLUDED.closed_at, paid_at = EXCLUDED.paid_at,
           created_at_source = EXCLUDED.created_at_source, modified_at_source = EXCLUDED.modified_at_source,
           promised_at = EXCLUDED.promised_at,
           estimated_fulfillment_at = EXCLUDED.estimated_fulfillment_at,
           payment_business_dates = EXCLUDED.payment_business_dates,
           fulfillment_business_date = EXCLUDED.fulfillment_business_date,
           guest_count = EXCLUDED.guest_count, check_count = EXCLUDED.check_count,
           item_count = EXCLUDED.item_count, gross_sales = EXCLUDED.gross_sales,
           net_sales = EXCLUDED.net_sales, discounts = EXCLUDED.discounts, tax = EXCLUDED.tax,
           service_charges = EXCLUDED.service_charges, tips = EXCLUDED.tips,
           refunds = EXCLUDED.refunds, tendered = EXCLUDED.tendered, total = EXCLUDED.total,
           cash_tender = EXCLUDED.cash_tender, card_tender = EXCLUDED.card_tender,
           other_tender = EXCLUDED.other_tender, voided = EXCLUDED.voided,
           deleted = EXCLUDED.deleted, details = EXCLUDED.details,
           payload_hash = EXCLUDED.payload_hash, updated_at = now()`,
        [
          input.job.organizationId, input.job.restaurantGuid, order.orderGuid, input.job.businessDate,
          order.displayNumber, order.source, order.diningOption, order.approvalStatus, order.paymentStatus,
          order.openedAt, order.closedAt, order.paidAt, order.createdAt, order.modifiedAt,
          order.promisedAt, order.estimatedFulfillmentAt, normalizedDates.paymentBusinessDates,
          normalizedDates.fulfillmentBusinessDate, order.guestCount, order.checkCount,
          order.itemCount, order.grossSales, order.netSales, order.discounts, order.tax,
          order.serviceCharges, order.tips, order.refunds, order.tendered, order.total,
          order.cashTender, order.cardTender, order.otherTender, order.voided, order.deleted,
          JSON.stringify(order.details), order.payloadHash,
        ],
      )
    }
    if (input.replaceBusinessDate !== false) {
      await client.query(
        `DELETE FROM toast_pos_orders
         WHERE organization_id = $1::uuid AND restaurant_guid = $2::uuid AND business_date = $3::date
           AND NOT (order_guid = ANY($4::text[]))`,
        [input.job.organizationId, input.job.restaurantGuid, input.job.businessDate, projection.orders.map((order) => order.orderGuid)],
      )
    }
    const totals = projection.totals
    await client.query(
      `INSERT INTO toast_daily_sales (
         organization_id, restaurant_guid, business_date, standard_orders_count,
         standard_gross_sales, standard_net_sales, standard_discounts, standard_voids,
         standard_refunds, standard_tax, standard_tips, standard_service_charges,
         standard_tendered, standard_total, standard_cash, standard_card,
         standard_other_tender, source_revision, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, 1, now()
       ) ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
         standard_orders_count = EXCLUDED.standard_orders_count,
         standard_gross_sales = EXCLUDED.standard_gross_sales,
         standard_net_sales = EXCLUDED.standard_net_sales,
         standard_discounts = EXCLUDED.standard_discounts,
         standard_voids = EXCLUDED.standard_voids,
         standard_refunds = EXCLUDED.standard_refunds,
         standard_tax = EXCLUDED.standard_tax,
         standard_tips = EXCLUDED.standard_tips,
         standard_service_charges = EXCLUDED.standard_service_charges,
         standard_tendered = EXCLUDED.standard_tendered,
         standard_total = EXCLUDED.standard_total,
         standard_cash = EXCLUDED.standard_cash,
         standard_card = EXCLUDED.standard_card,
         standard_other_tender = EXCLUDED.standard_other_tender,
         source_revision = toast_daily_sales.source_revision + 1, updated_at = now()`,
      [
        input.job.organizationId, input.job.restaurantGuid, input.job.businessDate,
        totals.orderCount, totals.grossSales, totals.netSales, totals.discounts, totals.voids,
        totals.refunds, totals.tax, totals.tips, totals.serviceCharges, totals.tendered,
        totals.total, totals.cashTender, totals.cardTender, totals.otherTender,
      ],
    )
    for (const priorSourceDate of priorSourceBusinessDates) {
      if (priorSourceDate === input.job.businessDate) continue
      await client.query(
        `WITH current_totals AS (
           SELECT
             count(*) FILTER (WHERE deleted = false AND voided = false)::integer AS order_count,
             coalesce(sum(gross_sales) FILTER (WHERE deleted = false AND voided = false), 0) AS gross_sales,
             coalesce(sum(net_sales) FILTER (WHERE deleted = false AND voided = false), 0) AS net_sales,
             coalesce(sum(discounts) FILTER (WHERE deleted = false AND voided = false), 0) AS discounts,
             coalesce(sum(net_sales) FILTER (WHERE deleted = false AND voided = true), 0) AS voids,
             coalesce(sum(refunds) FILTER (WHERE deleted = false AND voided = false), 0) AS refunds,
             coalesce(sum(tax) FILTER (WHERE deleted = false AND voided = false), 0) AS tax,
             coalesce(sum(tips) FILTER (WHERE deleted = false AND voided = false), 0) AS tips,
             coalesce(sum(service_charges) FILTER (WHERE deleted = false AND voided = false), 0) AS service_charges,
             coalesce(sum(tendered) FILTER (WHERE deleted = false AND voided = false), 0) AS tendered,
             coalesce(sum(total) FILTER (WHERE deleted = false AND voided = false), 0) AS total,
             coalesce(sum(cash_tender) FILTER (WHERE deleted = false AND voided = false), 0) AS cash,
             coalesce(sum(card_tender) FILTER (WHERE deleted = false AND voided = false), 0) AS card,
             coalesce(sum(other_tender) FILTER (WHERE deleted = false AND voided = false), 0) AS other_tender
           FROM toast_pos_orders
           WHERE organization_id = $1::uuid
             AND restaurant_guid = $2::uuid
             AND business_date = $3::date
         )
         INSERT INTO toast_daily_sales (
           organization_id, restaurant_guid, business_date, standard_orders_count,
           standard_gross_sales, standard_net_sales, standard_discounts, standard_voids,
           standard_refunds, standard_tax, standard_tips, standard_service_charges,
           standard_tendered, standard_total, standard_cash, standard_card,
           standard_other_tender, source_revision, updated_at
         )
         SELECT $1::uuid, $2::uuid, $3::date, order_count,
           gross_sales, net_sales, discounts, voids, refunds, tax, tips, service_charges,
           tendered, total, cash, card, other_tender, 1, now()
         FROM current_totals
         ON CONFLICT (organization_id, restaurant_guid, business_date) DO UPDATE SET
           standard_orders_count = EXCLUDED.standard_orders_count,
           standard_gross_sales = EXCLUDED.standard_gross_sales,
           standard_net_sales = EXCLUDED.standard_net_sales,
           standard_discounts = EXCLUDED.standard_discounts,
           standard_voids = EXCLUDED.standard_voids,
           standard_refunds = EXCLUDED.standard_refunds,
           standard_tax = EXCLUDED.standard_tax,
           standard_tips = EXCLUDED.standard_tips,
           standard_service_charges = EXCLUDED.standard_service_charges,
           standard_tendered = EXCLUDED.standard_tendered,
           standard_total = EXCLUDED.standard_total,
           standard_cash = EXCLUDED.standard_cash,
           standard_card = EXCLUDED.standard_card,
           standard_other_tender = EXCLUDED.standard_other_tender,
           source_revision = toast_daily_sales.source_revision + 1,
           updated_at = now()`,
        [input.job.organizationId, input.job.restaurantGuid, priorSourceDate],
      )
    }
  })
  return {
    ...projection.totals,
    accountingBusinessDates: [...accountingBusinessDates].sort(),
  }
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
