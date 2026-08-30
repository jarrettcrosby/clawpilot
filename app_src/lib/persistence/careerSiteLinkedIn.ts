import crypto from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CareerSiteLinkedInRequestError,
  type CareerSiteLinkedInAuthPrompt,
  type CareerSiteLinkedInAuthStatus,
  type CareerSiteLinkedInConfiguration,
  type CareerSiteLinkedInConnectRequest,
  type CareerSiteLinkedInConnectionStatus,
  type CareerSiteLinkedInJob,
  type CareerSiteLinkedInScanRequest,
  type CareerSiteLinkedInScanStatus,
  type CareerSiteLinkedInWorkerClaimRequest,
  type CareerSiteLinkedInWorkerReportRequest,
} from '@/lib/careerSiteLinkedInContract'
import {
  careerSiteLinkedInTransientSessionDataKey,
  decryptCareerSiteLinkedInSession,
  decryptCareerSiteLinkedInWorkerEnvelope,
  encryptCareerSiteLinkedInSession,
  encryptCareerSiteLinkedInWorkerEnvelope,
  type StoredCareerSiteLinkedInSession,
} from '@/lib/careerSiteLinkedInCrypto'
import {
  careerSiteLinkedInRedemptionLeaseDigest,
  classifyCareerSiteLinkedInRedemption,
} from '@/lib/careerSiteLinkedInRedemption'
import {
  careerSiteLinkedInReportLeaseDigest,
  exactCareerSiteLinkedInReportReceipt,
  type CareerSiteLinkedInReportReceipt,
} from '@/lib/careerSiteLinkedInReportReceipt'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { acquireTransactionAdvisoryLock, query, withTransaction } from '@/lib/persistence/postgres'

export const CAREER_SITE_LINKEDIN_MIGRATION_FILENAME = '0339_career_site_linkedin_connector.sql'
export const CAREER_SITE_LINKEDIN_MIGRATION_CHECKSUM =
  '76169b61b55e55e7380ef44a8c79910f2e159a3b63bb97947f2fb9d1db16440c'
const AUTH_ATTEMPT_TTL_SECONDS = 15 * 60
const WORK_LEASE_SECONDS = 5 * 60
const WORKER_CONNECTED_SECONDS = 30
const MAX_ATTEMPTS = 5

type CareerSiteLinkedInActor = {
  ownerEmail: string
  organizationId: string
  sourceApp: string
}

type ConnectionRow = QueryResultRow & {
  id: string
  source_app: string
  owner_email: string
  workspace_organization_id: string
  status: CareerSiteLinkedInConnectionStatus
  linkedin_member_name: string | null
  linkedin_profile_url: string | null
  session_ciphertext: Buffer | null
  session_iv: Buffer | null
  session_tag: Buffer | null
  session_key_id: string | null
  session_encryption_version: number | null
  session_fingerprint: string | null
  session_generation: number
  session_expires_at: string | null
  last_authenticated_at: string | null
  last_scanned_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  created_at: string
  updated_at: string
}

type AuthAttemptRow = QueryResultRow & {
  id: string
  request_id: string
  connection_id: string
  source_app: string
  owner_email: string
  workspace_organization_id: string
  return_url: string
  auth_token_digest: string
  auth_token_redeemed_at: string | null
  auth_token_redeemed_lease_digest: string | null
  auth_token_redeemed_worker_id: string | null
  status: CareerSiteLinkedInAuthStatus
  prompt_kind: CareerSiteLinkedInAuthPrompt['kind']
  prompt_message: string | null
  attempts: number
  locked_at: string | null
  lease_expires_at: string | null
  lock_token: string | null
  worker_id: string | null
  expires_at: string
  processed_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  last_report_body_digest: string | null
  last_report_lease_digest: string | null
  last_report_worker_id: string | null
  last_report_status: string | null
  last_report_at: string | null
  created_at: string
  updated_at: string
}

type ScanRow = QueryResultRow & {
  id: string
  request_id: string
  connection_id: string
  auth_attempt_id: string | null
  source_app: string
  owner_email: string
  workspace_organization_id: string
  scope: 'jobs'
  maximum: number
  filters: CareerSiteLinkedInScanRequest['filters']
  filters_hash: string
  status: CareerSiteLinkedInScanStatus
  attempts: number
  results: CareerSiteLinkedInJob[]
  result_count: number
  locked_at: string | null
  lease_expires_at: string | null
  lock_token: string | null
  worker_id: string | null
  completed_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  last_report_body_digest: string | null
  last_report_lease_digest: string | null
  last_report_worker_id: string | null
  last_report_status: string | null
  last_report_at: string | null
  created_at: string
  updated_at: string
}

const CONNECTION_FIELDS = `
  id::text, source_app, owner_email, workspace_organization_id::text,
  status, linkedin_member_name, linkedin_profile_url,
  session_ciphertext, session_iv, session_tag, session_key_id,
  session_encryption_version, session_fingerprint, session_generation,
  session_expires_at::text, last_authenticated_at::text, last_scanned_at::text,
  last_error_code, last_error_message, created_at::text, updated_at::text
`

const AUTH_FIELDS = `
  id::text, request_id::text, connection_id::text, source_app, owner_email,
  workspace_organization_id::text, return_url, auth_token_digest,
  auth_token_redeemed_at::text, auth_token_redeemed_lease_digest,
  auth_token_redeemed_worker_id, status, prompt_kind, prompt_message, attempts,
  locked_at::text, lease_expires_at::text, lock_token, worker_id,
  expires_at::text, processed_at::text, last_error_code, last_error_message,
  last_report_body_digest, last_report_lease_digest, last_report_worker_id,
  last_report_status, last_report_at::text,
  created_at::text, updated_at::text
`

const SCAN_FIELDS = `
  id::text, request_id::text, connection_id::text, auth_attempt_id::text,
  source_app, owner_email, workspace_organization_id::text, scope, maximum,
  filters, filters_hash, status, attempts, results, result_count,
  locked_at::text, lease_expires_at::text, lock_token, worker_id,
  completed_at::text, last_error_code, last_error_message,
  last_report_body_digest, last_report_lease_digest, last_report_worker_id,
  last_report_status, last_report_at::text,
  created_at::text, updated_at::text
`

export class CareerSiteLinkedInPersistenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CareerSiteLinkedInPersistenceError'
  }
}

function reportReceipt(input: {
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
  reportBodyDigest: string
}): CareerSiteLinkedInReportReceipt {
  if (!/^[0-9a-f]{64}$/.test(input.reportBodyDigest)) {
    throw new Error('LinkedIn worker report digest is invalid')
  }
  return {
    bodyDigest: input.reportBodyDigest,
    leaseDigest: careerSiteLinkedInReportLeaseDigest(input.report.leaseToken),
    workerId: input.workerId,
    status: input.report.status,
  }
}

function hasExactReportReceipt(
  row: AuthAttemptRow | ScanRow,
  receipt: CareerSiteLinkedInReportReceipt,
) {
  return exactCareerSiteLinkedInReportReceipt(row, receipt)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CareerSiteLinkedInRequestError(
      'Career Desk LinkedIn requires Postgres storage',
      503,
      'CAREER_SITE_LINKEDIN_POSTGRES_REQUIRED',
    )
  }
}

function connectionView(row: ConnectionRow | null | undefined) {
  return {
    status: row?.status || 'disconnected' as CareerSiteLinkedInConnectionStatus,
    linkedInMemberName: row?.linkedin_member_name || null,
    linkedInProfileUrl: row?.linkedin_profile_url || null,
    lastAuthenticatedAt: row?.last_authenticated_at
      ? new Date(row.last_authenticated_at).toISOString()
      : null,
    lastScannedAt: row?.last_scanned_at ? new Date(row.last_scanned_at).toISOString() : null,
    sessionExpiresAt: row?.session_expires_at ? new Date(row.session_expires_at).toISOString() : null,
    lastErrorCode: row?.last_error_code || null,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

function authView(row: AuthAttemptRow, authUrl: string | null = null) {
  return {
    id: row.id,
    status: row.status,
    prompt: {
      kind: row.prompt_kind,
      message: row.prompt_message,
    },
    authUrl,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function scanView(row: ScanRow, includeResults = true) {
  return {
    id: row.id,
    status: row.status,
    scope: row.scope,
    maximum: row.maximum,
    filters: row.filters,
    authAttemptId: row.auth_attempt_id,
    resultCount: row.result_count,
    results: includeResults && row.status === 'succeeded' ? row.results : [],
    errorCode: row.last_error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  }
}

function scanSummary(row: ScanRow) {
  return {
    id: row.id,
    status: row.status,
    scope: row.scope,
    resultCount: row.result_count,
    errorCode: row.last_error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  }
}

function storedSession(row: ConnectionRow): StoredCareerSiteLinkedInSession | null {
  if (
    !row.session_ciphertext
    || !row.session_iv
    || !row.session_tag
    || !row.session_key_id
    || row.session_encryption_version !== 1
    || !row.session_fingerprint
  ) return null
  return {
    ciphertext: row.session_ciphertext,
    iv: row.session_iv,
    tag: row.session_tag,
    keyId: row.session_key_id,
    encryptionVersion: 1,
    fingerprint: row.session_fingerprint,
  }
}

function sessionIdentity(row: ConnectionRow, generation = row.session_generation) {
  return {
    sourceApp: row.source_app,
    ownerEmail: row.owner_email,
    organizationId: row.workspace_organization_id,
    generation,
  }
}

async function connectionForActor(client: PoolClient, actor: CareerSiteLinkedInActor) {
  const result = await client.query<ConnectionRow>(
    `SELECT ${CONNECTION_FIELDS}
     FROM career_site_linkedin_connections
     WHERE source_app = $1 AND owner_email = $2
       AND workspace_organization_id = $3::uuid
     FOR UPDATE`,
    [actor.sourceApp, actor.ownerEmail, actor.organizationId],
  )
  return result.rows[0] || null
}

async function ensureConnection(client: PoolClient, actor: CareerSiteLinkedInActor) {
  await client.query(
    `INSERT INTO career_site_linkedin_connections (
       source_app, owner_email, workspace_organization_id, status, created_at, updated_at
     ) VALUES ($1, $2, $3::uuid, 'disconnected', now(), now())
     ON CONFLICT (source_app, owner_email, workspace_organization_id) DO NOTHING`,
    [actor.sourceApp, actor.ownerEmail, actor.organizationId],
  )
  const connection = await connectionForActor(client, actor)
  if (!connection) throw new Error('LinkedIn connection could not be prepared')
  return connection
}

async function recoverExpiredWork(client: PoolClient) {
  await client.query(
    `UPDATE career_site_linkedin_auth_attempts
     SET status = 'expired', processed_at = now(), prompt_kind = 'none',
         prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
         lock_token = NULL, worker_id = NULL,
         last_report_body_digest = NULL, last_report_lease_digest = NULL,
         last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
         last_error_code = COALESCE(last_error_code, 'LINKEDIN_AUTH_EXPIRED'),
         updated_at = now()
     WHERE status IN ('queued', 'claimed', 'awaiting_user') AND expires_at <= now()`,
  )
  await client.query(
    `UPDATE career_site_linkedin_auth_attempts
     SET status = 'queued', available_at = now(), prompt_kind = 'none',
         prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
         lock_token = NULL, worker_id = NULL,
         last_report_body_digest = NULL, last_report_lease_digest = NULL,
         last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
         updated_at = now()
     WHERE status IN ('claimed', 'awaiting_user')
       AND expires_at > now() AND lease_expires_at <= now() AND attempts < $1`,
    [MAX_ATTEMPTS],
  )
  await client.query(
    `UPDATE career_site_linkedin_auth_attempts
     SET status = 'failed', processed_at = now(), locked_at = NULL,
         lease_expires_at = NULL, lock_token = NULL, worker_id = NULL,
         last_report_body_digest = NULL, last_report_lease_digest = NULL,
         last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
         last_error_code = 'LINKEDIN_AUTH_WORKER_RETRIES_EXHAUSTED', updated_at = now()
     WHERE status IN ('claimed', 'awaiting_user')
       AND lease_expires_at <= now() AND attempts >= $1`,
    [MAX_ATTEMPTS],
  )
  await client.query(
    `UPDATE career_site_linkedin_scan_runs scan
     SET available_at = now(), locked_at = NULL, lease_expires_at = NULL,
         lock_token = NULL, worker_id = NULL,
         last_report_body_digest = NULL, last_report_lease_digest = NULL,
         last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
         last_error_code = CASE WHEN scan.attempts >= $1
                           THEN 'LINKEDIN_SCAN_WORKER_RETRIES_EXHAUSTED'
                           ELSE scan.last_error_code END,
         completed_at = CASE WHEN scan.attempts >= $1 THEN now() ELSE NULL END,
         status = CASE WHEN scan.attempts >= $1 THEN 'failed'
                       WHEN connection.status = 'connected'
                       AND connection.session_ciphertext IS NOT NULL
                       THEN 'queued' ELSE 'awaiting_auth' END,
         updated_at = now()
     FROM career_site_linkedin_connections connection
     WHERE scan.connection_id = connection.id
       AND scan.status = 'claimed' AND scan.lease_expires_at <= now()`,
    [MAX_ATTEMPTS],
  )
  await client.query(
    `UPDATE career_site_linkedin_connections connection
     SET status = CASE WHEN connection.session_ciphertext IS NULL
                       THEN 'disconnected' ELSE 'reauth_required' END,
         updated_at = now()
     WHERE connection.status = 'authenticating'
       AND NOT EXISTS (
         SELECT 1 FROM career_site_linkedin_auth_attempts attempt
         WHERE attempt.connection_id = connection.id
           AND attempt.status IN ('queued', 'claimed', 'awaiting_user')
       )`,
  )
}

export async function getCareerSiteLinkedInOverview(actor: CareerSiteLinkedInActor) {
  requirePostgres()
  return withTransaction(async (client) => {
    await recoverExpiredWork(client)
    const connection = await connectionForActor(client, actor)
    if (!connection) {
      return { connection: connectionView(null), activeAuthAttempt: null, latestScan: null }
    }
    const auth = await client.query<AuthAttemptRow>(
      `SELECT ${AUTH_FIELDS} FROM career_site_linkedin_auth_attempts
       WHERE connection_id = $1::uuid AND status IN ('queued', 'claimed', 'awaiting_user')
       ORDER BY created_at DESC LIMIT 1`,
      [connection.id],
    )
    const scan = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE connection_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [connection.id],
    )
    return {
      connection: connectionView(connection),
      activeAuthAttempt: auth.rows[0] ? authView(auth.rows[0]) : null,
      latestScan: scan.rows[0] ? scanSummary(scan.rows[0]) : null,
    }
  })
}

function transientAuthUrl(configuration: CareerSiteLinkedInConfiguration, token: string): string {
  const live = new URL('live', configuration.workerPublicUrl)
  live.search = ''
  live.hash = `token=${encodeURIComponent(token)}`
  return live.toString()
}

export async function createCareerSiteLinkedInAuthAttempt(input: {
  actor: CareerSiteLinkedInActor
  configuration: CareerSiteLinkedInConfiguration
  request: CareerSiteLinkedInConnectRequest
}) {
  requirePostgres()
  const token = crypto.randomBytes(32).toString('base64url')
  const tokenDigest = crypto.createHash('sha256').update(token, 'utf8').digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `career-linkedin-auth:${input.actor.ownerEmail}`)
    await recoverExpiredWork(client)
    const existing = await client.query<AuthAttemptRow>(
      `SELECT ${AUTH_FIELDS} FROM career_site_linkedin_auth_attempts
       WHERE source_app = $1 AND owner_email = $2 AND request_id = $3::uuid
       FOR UPDATE`,
      [input.actor.sourceApp, input.actor.ownerEmail, input.request.requestId],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].return_url !== input.request.returnUrl) {
        throw new CareerSiteLinkedInPersistenceError(
          'requestId was already used for a different LinkedIn connection request',
          409,
          'CAREER_SITE_LINKEDIN_IDEMPOTENCY_CONFLICT',
        )
      }
      return authView(existing.rows[0], null)
    }
    const connection = await ensureConnection(client, input.actor)
    await client.query(
      `UPDATE career_site_linkedin_auth_attempts
       SET status = 'cancelled', processed_at = now(), prompt_kind = 'none',
           prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL,
           last_report_body_digest = NULL, last_report_lease_digest = NULL,
           last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
           updated_at = now()
       WHERE connection_id = $1::uuid AND status IN ('queued', 'claimed', 'awaiting_user')`,
      [connection.id],
    )
    const inserted = await client.query<AuthAttemptRow>(
      `INSERT INTO career_site_linkedin_auth_attempts (
         id, request_id, connection_id, source_app, owner_email, workspace_organization_id,
         return_url, auth_token_digest, status, expires_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, 'queued',
         now() + ($8::text || ' seconds')::interval, now(), now()
       ) RETURNING ${AUTH_FIELDS}`,
      [
        input.request.requestId,
        connection.id,
        input.actor.sourceApp,
        input.actor.ownerEmail,
        input.actor.organizationId,
        input.request.returnUrl,
        tokenDigest,
        AUTH_ATTEMPT_TTL_SECONDS,
      ],
    )
    await client.query(
      `UPDATE career_site_linkedin_connections
       SET status = 'authenticating', last_error_code = NULL,
           last_error_message = NULL, updated_at = now()
       WHERE id = $1::uuid`,
      [connection.id],
    )
    const attempt = inserted.rows[0]
    await recordAuditEvent({
      actor: input.actor.ownerEmail,
      eventType: 'career_site.linkedin.auth_requested',
      aggregateType: 'career_site_linkedin_auth_attempt',
      aggregateId: attempt.id,
      organizationId: input.actor.organizationId,
      payload: { requestId: input.request.requestId },
    }, client)
    return authView(attempt, transientAuthUrl(input.configuration, token))
  })
}

export async function getCareerSiteLinkedInAuthAttempt(input: {
  actor: CareerSiteLinkedInActor
  attemptId: string
}) {
  requirePostgres()
  return withTransaction(async (client) => {
    await recoverExpiredWork(client)
    const result = await client.query<AuthAttemptRow>(
      `SELECT ${AUTH_FIELDS} FROM career_site_linkedin_auth_attempts
       WHERE id = $1::uuid AND source_app = $2 AND owner_email = $3
         AND workspace_organization_id = $4::uuid`,
      [input.attemptId, input.actor.sourceApp, input.actor.ownerEmail, input.actor.organizationId],
    )
    if (!result.rows[0]) {
      throw new CareerSiteLinkedInPersistenceError(
        'LinkedIn authentication attempt was not found',
        404,
        'CAREER_SITE_LINKEDIN_AUTH_ATTEMPT_NOT_FOUND',
      )
    }
    return authView(result.rows[0])
  })
}

export async function cancelCareerSiteLinkedInAuthAttempt(input: {
  actor: CareerSiteLinkedInActor
  attemptId: string
}) {
  requirePostgres()
  return withTransaction(async (client) => {
    const result = await client.query<AuthAttemptRow>(
      `UPDATE career_site_linkedin_auth_attempts
       SET status = 'cancelled', processed_at = now(), prompt_kind = 'none',
           prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL,
           last_report_body_digest = NULL, last_report_lease_digest = NULL,
           last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
           updated_at = now()
       WHERE id = $1::uuid AND source_app = $2 AND owner_email = $3
         AND workspace_organization_id = $4::uuid
         AND status IN ('queued', 'claimed', 'awaiting_user')
       RETURNING ${AUTH_FIELDS}`,
      [input.attemptId, input.actor.sourceApp, input.actor.ownerEmail, input.actor.organizationId],
    )
    if (!result.rows[0]) {
      const found = await client.query<{ status: CareerSiteLinkedInAuthStatus }>(
        `SELECT status FROM career_site_linkedin_auth_attempts
         WHERE id = $1::uuid AND source_app = $2 AND owner_email = $3
           AND workspace_organization_id = $4::uuid`,
        [input.attemptId, input.actor.sourceApp, input.actor.ownerEmail, input.actor.organizationId],
      )
      throw new CareerSiteLinkedInPersistenceError(
        found.rows[0]
          ? 'LinkedIn authentication attempt is already terminal'
          : 'LinkedIn authentication attempt was not found',
        found.rows[0] ? 409 : 404,
        found.rows[0]
          ? 'CAREER_SITE_LINKEDIN_AUTH_ATTEMPT_TERMINAL'
          : 'CAREER_SITE_LINKEDIN_AUTH_ATTEMPT_NOT_FOUND',
      )
    }
    const attempt = result.rows[0]
    await client.query(
      `UPDATE career_site_linkedin_connections connection
       SET status = CASE WHEN connection.session_ciphertext IS NULL
                         THEN 'disconnected' ELSE 'connected' END,
           updated_at = now()
       WHERE connection.id = $1::uuid`,
      [attempt.connection_id],
    )
    await recordAuditEvent({
      actor: input.actor.ownerEmail,
      eventType: 'career_site.linkedin.auth_cancelled',
      aggregateType: 'career_site_linkedin_auth_attempt',
      aggregateId: attempt.id,
      organizationId: input.actor.organizationId,
    }, client)
    return authView(attempt)
  })
}

export async function disconnectCareerSiteLinkedIn(actor: CareerSiteLinkedInActor) {
  requirePostgres()
  return withTransaction(async (client) => {
    const connection = await connectionForActor(client, actor)
    if (!connection) return connectionView(null)
    await client.query(
      `UPDATE career_site_linkedin_auth_attempts
       SET status = 'cancelled', processed_at = now(), prompt_kind = 'none',
           prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL,
           last_report_body_digest = NULL, last_report_lease_digest = NULL,
           last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
           updated_at = now()
       WHERE connection_id = $1::uuid AND status IN ('queued', 'claimed', 'awaiting_user')`,
      [connection.id],
    )
    await client.query(
      `UPDATE career_site_linkedin_scan_runs
       SET status = 'cancelled', completed_at = now(), locked_at = NULL,
           lease_expires_at = NULL, lock_token = NULL, worker_id = NULL,
           last_report_body_digest = NULL, last_report_lease_digest = NULL,
           last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
           updated_at = now()
       WHERE connection_id = $1::uuid AND status IN ('queued', 'claimed', 'awaiting_auth')`,
      [connection.id],
    )
    const updated = await client.query<ConnectionRow>(
      `UPDATE career_site_linkedin_connections
       SET status = 'disconnected', linkedin_member_name = NULL,
           linkedin_profile_url = NULL, session_ciphertext = NULL,
           session_iv = NULL, session_tag = NULL, session_key_id = NULL,
           session_encryption_version = NULL, session_fingerprint = NULL,
           session_expires_at = NULL, last_error_code = NULL,
           last_error_message = NULL, updated_at = now()
       WHERE id = $1::uuid RETURNING ${CONNECTION_FIELDS}`,
      [connection.id],
    )
    await recordAuditEvent({
      actor: actor.ownerEmail,
      eventType: 'career_site.linkedin.disconnected',
      aggregateType: 'career_site_linkedin_connection',
      aggregateId: connection.id,
      organizationId: actor.organizationId,
    }, client)
    return connectionView(updated.rows[0])
  })
}

function filtersHash(request: CareerSiteLinkedInScanRequest) {
  return crypto.createHash('sha256').update(JSON.stringify({
    scope: request.scope,
    maximum: request.maximum,
    filters: request.filters,
  })).digest('hex')
}

export async function createCareerSiteLinkedInScan(input: {
  actor: CareerSiteLinkedInActor
  request: CareerSiteLinkedInScanRequest
}) {
  requirePostgres()
  const hash = filtersHash(input.request)
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(client, `career-linkedin-scan:${input.actor.ownerEmail}`)
    await recoverExpiredWork(client)
    const existing = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE source_app = $1 AND owner_email = $2 AND request_id = $3::uuid
       FOR UPDATE`,
      [input.actor.sourceApp, input.actor.ownerEmail, input.request.requestId],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].filters_hash !== hash) {
        throw new CareerSiteLinkedInPersistenceError(
          'requestId was already used for a different LinkedIn scan',
          409,
          'CAREER_SITE_LINKEDIN_IDEMPOTENCY_CONFLICT',
        )
      }
      return scanView(existing.rows[0])
    }
    const connection = await ensureConnection(client, input.actor)
    const active = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE connection_id = $1::uuid AND status IN ('queued', 'claimed', 'awaiting_auth')
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [connection.id],
    )
    if (active.rows[0]) {
      if (active.rows[0].filters_hash === hash) return scanView(active.rows[0])
      throw new CareerSiteLinkedInPersistenceError(
        'A different LinkedIn scan is already queued or running',
        409,
        'CAREER_SITE_LINKEDIN_SCAN_ALREADY_ACTIVE',
      )
    }
    const ready = connection.status === 'connected' && Boolean(storedSession(connection))
    const inserted = await client.query<ScanRow>(
      `INSERT INTO career_site_linkedin_scan_runs (
         request_id, connection_id, source_app, owner_email, workspace_organization_id,
         scope, maximum, filters, filters_hash, status, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5::uuid, 'jobs', $6, $7::jsonb, $8, $9, now(), now()
       ) RETURNING ${SCAN_FIELDS}`,
      [
        input.request.requestId,
        connection.id,
        input.actor.sourceApp,
        input.actor.ownerEmail,
        input.actor.organizationId,
        input.request.maximum,
        JSON.stringify(input.request.filters),
        hash,
        ready ? 'queued' : 'awaiting_auth',
      ],
    )
    const scan = inserted.rows[0]
    await recordAuditEvent({
      actor: input.actor.ownerEmail,
      eventType: ready
        ? 'career_site.linkedin.scan_queued'
        : 'career_site.linkedin.scan_awaiting_auth',
      aggregateType: 'career_site_linkedin_scan',
      aggregateId: scan.id,
      organizationId: input.actor.organizationId,
      payload: { requestId: input.request.requestId, maximum: input.request.maximum },
    }, client)
    return scanView(scan)
  })
}

export async function getCareerSiteLinkedInScan(input: {
  actor: CareerSiteLinkedInActor
  scanId: string
}) {
  requirePostgres()
  return withTransaction(async (client) => {
    await recoverExpiredWork(client)
    const result = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE id = $1::uuid AND source_app = $2 AND owner_email = $3
         AND workspace_organization_id = $4::uuid`,
      [input.scanId, input.actor.sourceApp, input.actor.ownerEmail, input.actor.organizationId],
    )
    if (!result.rows[0]) {
      throw new CareerSiteLinkedInPersistenceError(
        'LinkedIn scan was not found',
        404,
        'CAREER_SITE_LINKEDIN_SCAN_NOT_FOUND',
      )
    }
    return scanView(result.rows[0])
  })
}

export async function registerCareerSiteLinkedInWorkerNonce(input: {
  workerId: string
  nonce: string
  requestTimestamp: string
  expiresAt: string
}) {
  requirePostgres()
  await withTransaction(async (client) => {
    await client.query('DELETE FROM career_site_linkedin_worker_nonces WHERE expires_at <= now()')
    try {
      await client.query(
        `INSERT INTO career_site_linkedin_worker_nonces (
           worker_id, nonce, request_timestamp, expires_at, created_at
         ) VALUES ($1, $2::uuid, $3::timestamptz, $4::timestamptz, now())`,
        [input.workerId, input.nonce, input.requestTimestamp, input.expiresAt],
      )
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new CareerSiteLinkedInPersistenceError(
          'LinkedIn worker request was already used',
          409,
          'CAREER_SITE_LINKEDIN_WORKER_REPLAYED',
        )
      }
      throw error
    }
  })
}

export type CareerSiteLinkedInWorkerClaim = {
  leaseId: string
  leaseToken: string
  expiresAt: string
  authExpiresAt: string | null
  authTokenAdoptionRequired: boolean
  command: 'connect' | 'reauthenticate' | 'scan' | 'disconnect'
  ownerId: string
  attemptId: string | null
  scanId: string | null
  authTokenDigest: string | null
  authTokenRedeemedAt: string | null
  returnUrl: string | null
  encryptedSessionEnvelope: ReturnType<typeof encryptCareerSiteLinkedInWorkerEnvelope> | null
  transientSessionDataKey: string
  scan: {
    scope: 'jobs'
    maximum: number
    filters: CareerSiteLinkedInScanRequest['filters']
  } | null
}

async function claimedConnection(client: PoolClient, connectionId: string) {
  const result = await client.query<ConnectionRow>(
    `SELECT ${CONNECTION_FIELDS} FROM career_site_linkedin_connections
     WHERE id = $1::uuid FOR UPDATE`,
    [connectionId],
  )
  if (!result.rows[0]) throw new Error('LinkedIn work connection is missing')
  return result.rows[0]
}

function sessionEnvelopeForClaim(input: {
  connection: ConnectionRow
  leaseId: string
  leaseToken: string
}) {
  const stored = storedSession(input.connection)
  if (!stored) return null
  const session = decryptCareerSiteLinkedInSession(stored, sessionIdentity(input.connection))
  return encryptCareerSiteLinkedInWorkerEnvelope({
    session,
    leaseId: input.leaseId,
    leaseToken: input.leaseToken,
    ownerId: input.connection.owner_email,
  })
}

export async function claimCareerSiteLinkedInWork(
  request: CareerSiteLinkedInWorkerClaimRequest,
): Promise<CareerSiteLinkedInWorkerClaim | null> {
  requirePostgres()
  return withTransaction(async (client) => {
    await recoverExpiredWork(client)
    const leaseToken = crypto.randomUUID()
    if (request.capabilities.includes('interactive_auth')) {
      const auth = await client.query<AuthAttemptRow>(
        `WITH candidate AS (
           SELECT id AS candidate_id FROM career_site_linkedin_auth_attempts
           WHERE status = 'queued' AND available_at <= now() AND expires_at > now()
             AND attempts < $1
           ORDER BY available_at, created_at, id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE career_site_linkedin_auth_attempts attempt
         SET status = 'claimed', attempts = attempt.attempts + 1,
             locked_at = now(), lease_expires_at = LEAST(
               attempt.expires_at, now() + ($2::text || ' seconds')::interval
             ),
             lock_token = $3, worker_id = $4,
             last_report_body_digest = NULL, last_report_lease_digest = NULL,
             last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
             updated_at = now()
         FROM candidate WHERE attempt.id = candidate.candidate_id
         RETURNING ${AUTH_FIELDS}`,
        [MAX_ATTEMPTS, WORK_LEASE_SECONDS, leaseToken, request.workerId],
      )
      if (auth.rows[0]) {
        const attempt = auth.rows[0]
        const connection = await claimedConnection(client, attempt.connection_id)
        const envelope = sessionEnvelopeForClaim({ connection, leaseId: attempt.id, leaseToken })
        const currentLeaseDigest = careerSiteLinkedInRedemptionLeaseDigest(leaseToken)
        const authTokenAdoptionRequired = Boolean(
          attempt.auth_token_redeemed_at
          && attempt.attempts > 1
          && (
            attempt.auth_token_redeemed_lease_digest !== currentLeaseDigest
            || attempt.auth_token_redeemed_worker_id !== request.workerId
          )
        )
        return {
          leaseId: attempt.id,
          leaseToken,
          expiresAt: new Date(attempt.lease_expires_at as string).toISOString(),
          authExpiresAt: new Date(attempt.expires_at).toISOString(),
          authTokenAdoptionRequired,
          command: envelope ? 'reauthenticate' : 'connect',
          ownerId: attempt.owner_email,
          attemptId: attempt.id,
          scanId: null,
          authTokenDigest: attempt.auth_token_digest,
          authTokenRedeemedAt: attempt.auth_token_redeemed_at
            ? new Date(attempt.auth_token_redeemed_at).toISOString()
            : null,
          returnUrl: attempt.return_url,
          encryptedSessionEnvelope: envelope,
          transientSessionDataKey: careerSiteLinkedInTransientSessionDataKey(leaseToken),
          scan: null,
        }
      }
    }
    if (request.capabilities.includes('jobs_read')) {
      const scan = await client.query<ScanRow>(
        `WITH candidate AS (
           SELECT scan.id AS candidate_id
           FROM career_site_linkedin_scan_runs scan
           JOIN career_site_linkedin_connections connection ON connection.id = scan.connection_id
           WHERE scan.status = 'queued' AND scan.available_at <= now() AND scan.attempts < $1
             AND connection.status = 'connected' AND connection.session_ciphertext IS NOT NULL
           ORDER BY scan.available_at, scan.created_at, scan.id
           FOR UPDATE OF scan SKIP LOCKED LIMIT 1
         )
         UPDATE career_site_linkedin_scan_runs scan
         SET status = 'claimed', attempts = scan.attempts + 1,
             locked_at = now(), lease_expires_at = now() + ($2::text || ' seconds')::interval,
             lock_token = $3, worker_id = $4,
             last_report_body_digest = NULL, last_report_lease_digest = NULL,
             last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
             updated_at = now()
         FROM candidate WHERE scan.id = candidate.candidate_id
         RETURNING ${SCAN_FIELDS}`,
        [MAX_ATTEMPTS, WORK_LEASE_SECONDS, leaseToken, request.workerId],
      )
      if (scan.rows[0]) {
        const run = scan.rows[0]
        const connection = await claimedConnection(client, run.connection_id)
        const envelope = sessionEnvelopeForClaim({ connection, leaseId: run.id, leaseToken })
        if (!envelope) throw new Error('LinkedIn scan session is missing')
        return {
          leaseId: run.id,
          leaseToken,
          expiresAt: new Date(run.lease_expires_at as string).toISOString(),
          authExpiresAt: null,
          authTokenAdoptionRequired: false,
          command: 'scan',
          ownerId: run.owner_email,
          attemptId: null,
          scanId: run.id,
          authTokenDigest: null,
          authTokenRedeemedAt: null,
          returnUrl: null,
          encryptedSessionEnvelope: envelope,
          transientSessionDataKey: careerSiteLinkedInTransientSessionDataKey(leaseToken),
          scan: { scope: run.scope, maximum: run.maximum, filters: run.filters },
        }
      }
    }
    return null
  })
}

async function persistReportedSession(input: {
  client: PoolClient
  connection: ConnectionRow
  leaseId: string
  leaseToken: string
  envelope: NonNullable<CareerSiteLinkedInWorkerReportRequest['encryptedSessionEnvelope']>
  evidence: CareerSiteLinkedInWorkerReportRequest['evidence']
}) {
  const plaintext = decryptCareerSiteLinkedInWorkerEnvelope({
    envelope: input.envelope,
    leaseId: input.leaseId,
    leaseToken: input.leaseToken,
    ownerId: input.connection.owner_email,
  })
  const generation = input.connection.session_generation + 1
  const encrypted = encryptCareerSiteLinkedInSession(
    plaintext,
    sessionIdentity(input.connection, generation),
  )
  await input.client.query(
    `UPDATE career_site_linkedin_connections
     SET session_ciphertext = $2, session_iv = $3, session_tag = $4,
         session_key_id = $5, session_encryption_version = $6,
         session_fingerprint = $7, session_generation = $8,
         session_expires_at = $9::timestamptz,
         linkedin_member_name = COALESCE($10, linkedin_member_name),
         linkedin_profile_url = COALESCE($11, linkedin_profile_url), updated_at = now()
     WHERE id = $1::uuid`,
    [
      input.connection.id,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      encrypted.keyId,
      encrypted.encryptionVersion,
      encrypted.fingerprint,
      generation,
      input.evidence?.sessionExpiresAt || null,
      input.evidence?.memberName || null,
      input.evidence?.profileUrl || null,
    ],
  )
}

async function reportAuthWork(input: {
  client: PoolClient
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
  receipt: CareerSiteLinkedInReportReceipt
  attempt: AuthAttemptRow
}) {
  const { client, report, receipt, attempt } = input
  const connection = await claimedConnection(client, attempt.connection_id)
  if (report.status === 'running' || report.status === 'awaiting_auth') {
    if (report.evidence?.event === 'live_token_redeemed') {
      const redemption = classifyCareerSiteLinkedInRedemption({
        redeemedAt: attempt.auth_token_redeemed_at,
        redeemedLeaseDigest: attempt.auth_token_redeemed_lease_digest,
        redeemedWorkerId: attempt.auth_token_redeemed_worker_id,
        currentLeaseToken: report.leaseToken,
        currentWorkerId: input.workerId,
        attempts: attempt.attempts,
      })
      if (redemption === 'replay') {
        throw new CareerSiteLinkedInPersistenceError(
          'LinkedIn live authentication token was already redeemed',
          409,
          'CAREER_SITE_LINKEDIN_AUTH_TOKEN_REPLAYED',
        )
      }
      if (redemption === 'first') {
        const leaseDigest = careerSiteLinkedInRedemptionLeaseDigest(report.leaseToken)
        const redeemed = await client.query(
          `UPDATE career_site_linkedin_auth_attempts
           SET auth_token_redeemed_at = now(),
               auth_token_redeemed_lease_digest = $4,
               auth_token_redeemed_worker_id = $3, updated_at = now()
           WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
             AND status IN ('claimed', 'awaiting_user')
             AND auth_token_redeemed_at IS NULL AND expires_at > now()`,
          [attempt.id, report.leaseToken, input.workerId, leaseDigest],
        )
        if (redeemed.rowCount !== 1) {
          throw new CareerSiteLinkedInPersistenceError(
            'LinkedIn live authentication token was already redeemed',
            409,
            'CAREER_SITE_LINKEDIN_AUTH_TOKEN_REPLAYED',
          )
        }
        await recordAuditEvent({
          actor: attempt.owner_email,
          eventType: 'career_site.linkedin.live_token_redeemed',
          aggregateType: 'career_site_linkedin_auth_attempt',
          aggregateId: attempt.id,
          organizationId: attempt.workspace_organization_id,
        }, client)
      }
      if (redemption === 'adopt') {
        const leaseDigest = careerSiteLinkedInRedemptionLeaseDigest(report.leaseToken)
        const adopted = await client.query(
          `UPDATE career_site_linkedin_auth_attempts
           SET auth_token_redeemed_lease_digest = $4,
               auth_token_redeemed_worker_id = $3, updated_at = now()
           WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
             AND status IN ('claimed', 'awaiting_user')
             AND attempts > 1 AND auth_token_redeemed_at IS NOT NULL
             AND (
               auth_token_redeemed_lease_digest <> $4
               OR auth_token_redeemed_worker_id <> $3
             )
             AND expires_at > now()`,
          [attempt.id, report.leaseToken, input.workerId, leaseDigest],
        )
        if (adopted.rowCount !== 1) {
          throw new CareerSiteLinkedInPersistenceError(
            'LinkedIn live authentication token adoption was rejected',
            409,
            'CAREER_SITE_LINKEDIN_AUTH_TOKEN_REPLAYED',
          )
        }
        await recordAuditEvent({
          actor: attempt.owner_email,
          eventType: 'career_site.linkedin.live_token_redemption_adopted',
          aggregateType: 'career_site_linkedin_auth_attempt',
          aggregateId: attempt.id,
          organizationId: attempt.workspace_organization_id,
        }, client)
      }
    }
    const prompt = report.authState || { kind: 'none' as const, message: null }
    const updated = await client.query<AuthAttemptRow>(
      `UPDATE career_site_linkedin_auth_attempts
       SET status = 'awaiting_user', prompt_kind = $4, prompt_message = $5,
           locked_at = now(), lease_expires_at = LEAST(
             expires_at, now() + ($6::text || ' seconds')::interval
           ), last_report_body_digest = $7, last_report_lease_digest = $8,
           last_report_worker_id = $3, last_report_status = $9,
           last_report_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
         AND status IN ('claimed', 'awaiting_user') AND expires_at > now()
       RETURNING ${AUTH_FIELDS}`,
      [
        attempt.id,
        report.leaseToken,
        input.workerId,
        prompt.kind,
        prompt.message,
        WORK_LEASE_SECONDS,
        receipt.bodyDigest,
        receipt.leaseDigest,
        receipt.status,
      ],
    )
    if (!updated.rows[0]) throw new Error('LinkedIn authentication lease was lost')
    return { kind: 'auth' as const, authAttempt: authView(updated.rows[0]) }
  }
  if (report.status === 'succeeded') {
    const currentLeaseDigest = careerSiteLinkedInRedemptionLeaseDigest(report.leaseToken)
    if (
      report.jobs.length > 0
      || !report.encryptedSessionEnvelope
      || !attempt.auth_token_redeemed_at
      || attempt.auth_token_redeemed_lease_digest !== currentLeaseDigest
      || attempt.auth_token_redeemed_worker_id !== input.workerId
    ) {
      throw new CareerSiteLinkedInPersistenceError(
        'Successful LinkedIn authentication requires a redeemed live token and browser session',
        409,
        'CAREER_SITE_LINKEDIN_AUTH_EVIDENCE_REQUIRED',
      )
    }
    await persistReportedSession({
      client,
      connection,
      leaseId: attempt.id,
      leaseToken: report.leaseToken,
      envelope: report.encryptedSessionEnvelope,
      evidence: report.evidence,
    })
    const updated = await client.query<AuthAttemptRow>(
      `UPDATE career_site_linkedin_auth_attempts
       SET status = 'succeeded', prompt_kind = 'none', prompt_message = NULL,
           processed_at = now(), locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL, last_error_code = NULL,
           last_error_message = NULL, last_report_body_digest = $4,
           last_report_lease_digest = $5, last_report_worker_id = $3,
           last_report_status = $6, last_report_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
         AND status IN ('claimed', 'awaiting_user')
       RETURNING ${AUTH_FIELDS}`,
      [
        attempt.id,
        report.leaseToken,
        input.workerId,
        receipt.bodyDigest,
        receipt.leaseDigest,
        receipt.status,
      ],
    )
    if (!updated.rows[0]) throw new Error('LinkedIn authentication lease was lost')
    await client.query(
      `UPDATE career_site_linkedin_connections
       SET status = 'connected', last_authenticated_at = now(),
           last_error_code = NULL, last_error_message = NULL, updated_at = now()
       WHERE id = $1::uuid`,
      [connection.id],
    )
    await client.query(
      `UPDATE career_site_linkedin_scan_runs
       SET status = 'queued', auth_attempt_id = $2::uuid, available_at = now(),
           last_error_code = NULL, last_error_message = NULL,
           last_report_body_digest = NULL, last_report_lease_digest = NULL,
           last_report_worker_id = NULL, last_report_status = NULL, last_report_at = NULL,
           updated_at = now()
       WHERE connection_id = $1::uuid AND status = 'awaiting_auth'`,
      [connection.id, attempt.id],
    )
    await recordAuditEvent({
      actor: attempt.owner_email,
      eventType: 'career_site.linkedin.auth_succeeded',
      aggregateType: 'career_site_linkedin_auth_attempt',
      aggregateId: attempt.id,
      organizationId: attempt.workspace_organization_id,
    }, client)
    return { kind: 'auth' as const, authAttempt: authView(updated.rows[0]) }
  }
  const restricted = report.status === 'restricted'
  const updated = await client.query<AuthAttemptRow>(
    `UPDATE career_site_linkedin_auth_attempts
     SET status = 'failed', processed_at = now(), prompt_kind = 'none',
         prompt_message = NULL, locked_at = NULL, lease_expires_at = NULL,
         lock_token = NULL, worker_id = NULL, last_error_code = $4,
         last_error_message = $5, last_report_body_digest = $6,
         last_report_lease_digest = $7, last_report_worker_id = $3,
         last_report_status = $8, last_report_at = now(), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
       AND status IN ('claimed', 'awaiting_user')
     RETURNING ${AUTH_FIELDS}`,
    [
      attempt.id,
      report.leaseToken,
      input.workerId,
      report.errorCode,
      report.errorMessage,
      receipt.bodyDigest,
      receipt.leaseDigest,
      receipt.status,
    ],
  )
  if (!updated.rows[0]) throw new Error('LinkedIn authentication lease was lost')
  await client.query(
    `UPDATE career_site_linkedin_connections
     SET status = $2, last_error_code = $3, last_error_message = $4, updated_at = now()
     WHERE id = $1::uuid`,
    [connection.id, restricted ? 'restricted' : 'error', report.errorCode, report.errorMessage],
  )
  await recordAuditEvent({
    actor: attempt.owner_email,
    eventType: restricted
      ? 'career_site.linkedin.auth_restricted'
      : 'career_site.linkedin.auth_failed',
    aggregateType: 'career_site_linkedin_auth_attempt',
    aggregateId: attempt.id,
    organizationId: attempt.workspace_organization_id,
    payload: { errorCode: report.errorCode },
  }, client)
  return { kind: 'auth' as const, authAttempt: authView(updated.rows[0]) }
}

async function reportScanWork(input: {
  client: PoolClient
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
  receipt: CareerSiteLinkedInReportReceipt
  scan: ScanRow
}) {
  const { client, report, receipt, scan } = input
  const connection = await claimedConnection(client, scan.connection_id)
  if (report.status === 'running') {
    const updated = await client.query<ScanRow>(
      `UPDATE career_site_linkedin_scan_runs
       SET locked_at = now(), lease_expires_at = now() + ($4::text || ' seconds')::interval,
           last_report_body_digest = $5, last_report_lease_digest = $6,
           last_report_worker_id = $3, last_report_status = $7,
           last_report_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3 AND status = 'claimed'
       RETURNING ${SCAN_FIELDS}`,
      [
        scan.id,
        report.leaseToken,
        input.workerId,
        WORK_LEASE_SECONDS,
        receipt.bodyDigest,
        receipt.leaseDigest,
        receipt.status,
      ],
    )
    if (!updated.rows[0]) throw new Error('LinkedIn scan lease was lost')
    return { kind: 'scan' as const, scan: scanView(updated.rows[0]) }
  }
  if (report.status === 'awaiting_auth') {
    const updated = await client.query<ScanRow>(
      `UPDATE career_site_linkedin_scan_runs
       SET status = 'awaiting_auth', locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL,
           last_error_code = COALESCE($4, 'LINKEDIN_REAUTH_REQUIRED'),
           last_error_message = $5, last_report_body_digest = $6,
           last_report_lease_digest = $7, last_report_worker_id = $3,
           last_report_status = $8, last_report_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3 AND status = 'claimed'
       RETURNING ${SCAN_FIELDS}`,
      [
        scan.id,
        report.leaseToken,
        input.workerId,
        report.errorCode,
        report.errorMessage,
        receipt.bodyDigest,
        receipt.leaseDigest,
        receipt.status,
      ],
    )
    if (!updated.rows[0]) throw new Error('LinkedIn scan lease was lost')
    await client.query(
      `UPDATE career_site_linkedin_connections
       SET status = 'reauth_required', last_error_code = 'LINKEDIN_REAUTH_REQUIRED',
           last_error_message = $2, updated_at = now() WHERE id = $1::uuid`,
      [connection.id, report.errorMessage],
    )
    await recordAuditEvent({
      actor: scan.owner_email,
      eventType: 'career_site.linkedin.scan_awaiting_auth',
      aggregateType: 'career_site_linkedin_scan',
      aggregateId: scan.id,
      organizationId: scan.workspace_organization_id,
      payload: { attempts: scan.attempts },
    }, client)
    return { kind: 'scan' as const, scan: scanView(updated.rows[0]) }
  }
  if (report.status === 'succeeded') {
    if (report.jobs.length > scan.maximum) {
      throw new CareerSiteLinkedInPersistenceError(
        'LinkedIn worker returned more jobs than the requested maximum',
        409,
        'CAREER_SITE_LINKEDIN_SCAN_RESULT_LIMIT_EXCEEDED',
      )
    }
    if (report.encryptedSessionEnvelope) {
      await persistReportedSession({
        client,
        connection,
        leaseId: scan.id,
        leaseToken: report.leaseToken,
        envelope: report.encryptedSessionEnvelope,
        evidence: report.evidence,
      })
    }
    const updated = await client.query<ScanRow>(
      `UPDATE career_site_linkedin_scan_runs
       SET status = 'succeeded', results = $4::jsonb, result_count = $5,
           completed_at = now(), locked_at = NULL, lease_expires_at = NULL,
           lock_token = NULL, worker_id = NULL, last_error_code = NULL,
           last_error_message = NULL, last_report_body_digest = $6,
           last_report_lease_digest = $7, last_report_worker_id = $3,
           last_report_status = $8, last_report_at = now(), updated_at = now()
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3 AND status = 'claimed'
       RETURNING ${SCAN_FIELDS}`,
      [
        scan.id,
        report.leaseToken,
        input.workerId,
        JSON.stringify(report.jobs),
        report.jobs.length,
        receipt.bodyDigest,
        receipt.leaseDigest,
        receipt.status,
      ],
    )
    if (!updated.rows[0]) throw new Error('LinkedIn scan lease was lost')
    await client.query(
      `UPDATE career_site_linkedin_connections
       SET status = 'connected', last_scanned_at = now(), last_error_code = NULL,
           last_error_message = NULL, updated_at = now() WHERE id = $1::uuid`,
      [connection.id],
    )
    await recordAuditEvent({
      actor: scan.owner_email,
      eventType: 'career_site.linkedin.scan_succeeded',
      aggregateType: 'career_site_linkedin_scan',
      aggregateId: scan.id,
      organizationId: scan.workspace_organization_id,
      payload: { resultCount: report.jobs.length, attempts: scan.attempts },
    }, client)
    return { kind: 'scan' as const, scan: scanView(updated.rows[0]) }
  }
  const restricted = report.status === 'restricted'
  const retry = !restricted && scan.attempts < MAX_ATTEMPTS
  const retryDelaySeconds = Math.min(30 * (2 ** Math.max(0, scan.attempts - 1)), 300)
  const updated = await client.query<ScanRow>(
    `UPDATE career_site_linkedin_scan_runs
     SET status = $4, completed_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END,
         available_at = CASE WHEN $4 = 'queued'
           THEN now() + ($7::text || ' seconds')::interval ELSE available_at END,
         locked_at = NULL,
         lease_expires_at = NULL, lock_token = NULL, worker_id = NULL,
         last_error_code = $5, last_error_message = $6,
         last_report_body_digest = $8, last_report_lease_digest = $9,
         last_report_worker_id = $3, last_report_status = $10,
         last_report_at = now(), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3 AND status = 'claimed'
     RETURNING ${SCAN_FIELDS}`,
    [
      scan.id,
      report.leaseToken,
      input.workerId,
      retry ? 'queued' : 'failed',
      report.errorCode,
      report.errorMessage,
      retryDelaySeconds,
      receipt.bodyDigest,
      receipt.leaseDigest,
      receipt.status,
    ],
  )
  if (!updated.rows[0]) throw new Error('LinkedIn scan lease was lost')
  if (restricted || !retry) {
    await client.query(
      `UPDATE career_site_linkedin_connections
       SET status = $2, last_error_code = $3, last_error_message = $4, updated_at = now()
       WHERE id = $1::uuid`,
      [connection.id, restricted ? 'restricted' : 'error', report.errorCode, report.errorMessage],
    )
  }
  await recordAuditEvent({
    actor: scan.owner_email,
    eventType: restricted
      ? 'career_site.linkedin.scan_restricted'
      : retry
        ? 'career_site.linkedin.scan_retrying'
        : 'career_site.linkedin.scan_failed',
    aggregateType: 'career_site_linkedin_scan',
    aggregateId: scan.id,
    organizationId: scan.workspace_organization_id,
    payload: { attempts: scan.attempts, errorCode: report.errorCode },
  }, client)
  return { kind: 'scan' as const, scan: scanView(updated.rows[0]) }
}

async function acknowledgeActiveAuthReportReplay(input: {
  client: PoolClient
  attempt: AuthAttemptRow
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
}) {
  const updated = await input.client.query<AuthAttemptRow>(
    `UPDATE career_site_linkedin_auth_attempts
     SET locked_at = now(), lease_expires_at = LEAST(
           expires_at, now() + ($4::text || ' seconds')::interval
         ), updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
       AND status IN ('claimed', 'awaiting_user') AND lease_expires_at > now()
     RETURNING ${AUTH_FIELDS}`,
    [input.attempt.id, input.report.leaseToken, input.workerId, WORK_LEASE_SECONDS],
  )
  if (!updated.rows[0]) throw new Error('LinkedIn authentication lease was lost')
  return { kind: 'auth' as const, authAttempt: authView(updated.rows[0]) }
}

async function acknowledgeActiveScanReportReplay(input: {
  client: PoolClient
  scan: ScanRow
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
}) {
  const updated = await input.client.query<ScanRow>(
    `UPDATE career_site_linkedin_scan_runs
     SET locked_at = now(),
         lease_expires_at = now() + ($4::text || ' seconds')::interval,
         updated_at = now()
     WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
       AND status = 'claimed' AND lease_expires_at > now()
     RETURNING ${SCAN_FIELDS}`,
    [input.scan.id, input.report.leaseToken, input.workerId, WORK_LEASE_SECONDS],
  )
  if (!updated.rows[0]) throw new Error('LinkedIn scan lease was lost')
  return { kind: 'scan' as const, scan: scanView(updated.rows[0]) }
}

export async function reportCareerSiteLinkedInWork(input: {
  workerId: string
  report: CareerSiteLinkedInWorkerReportRequest
  reportBodyDigest: string
}) {
  requirePostgres()
  return withTransaction(async (client) => {
    const receipt = reportReceipt(input)
    const auth = await client.query<AuthAttemptRow>(
      `SELECT ${AUTH_FIELDS} FROM career_site_linkedin_auth_attempts
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
         AND status IN ('claimed', 'awaiting_user') AND lease_expires_at > now()
       FOR UPDATE`,
      [input.report.leaseId, input.report.leaseToken, input.workerId],
    )
    if (auth.rows[0]) {
      if (hasExactReportReceipt(auth.rows[0], receipt)) {
        return acknowledgeActiveAuthReportReplay({
          client,
          workerId: input.workerId,
          report: input.report,
          attempt: auth.rows[0],
        })
      }
      return reportAuthWork({
        client,
        workerId: input.workerId,
        report: input.report,
        receipt,
        attempt: auth.rows[0],
      })
    }
    const scan = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE id = $1::uuid AND lock_token = $2 AND worker_id = $3
         AND status = 'claimed' AND lease_expires_at > now() FOR UPDATE`,
      [input.report.leaseId, input.report.leaseToken, input.workerId],
    )
    if (scan.rows[0]) {
      if (hasExactReportReceipt(scan.rows[0], receipt)) {
        return acknowledgeActiveScanReportReplay({
          client,
          workerId: input.workerId,
          report: input.report,
          scan: scan.rows[0],
        })
      }
      return reportScanWork({
        client,
        workerId: input.workerId,
        report: input.report,
        receipt,
        scan: scan.rows[0],
      })
    }
    const completedAuth = await client.query<AuthAttemptRow>(
      `SELECT ${AUTH_FIELDS} FROM career_site_linkedin_auth_attempts
       WHERE id = $1::uuid AND status IN ('succeeded', 'failed') FOR UPDATE`,
      [input.report.leaseId],
    )
    if (completedAuth.rows[0]) {
      if (hasExactReportReceipt(completedAuth.rows[0], receipt)) {
        return { kind: 'auth' as const, authAttempt: authView(completedAuth.rows[0]) }
      }
      throw new CareerSiteLinkedInPersistenceError(
        'LinkedIn worker report does not match the completed authentication receipt',
        409,
        'CAREER_SITE_LINKEDIN_REPORT_REPLAY_CONFLICT',
      )
    }
    const completedScan = await client.query<ScanRow>(
      `SELECT ${SCAN_FIELDS} FROM career_site_linkedin_scan_runs
       WHERE id = $1::uuid
         AND status IN ('queued', 'awaiting_auth', 'succeeded', 'failed')
       FOR UPDATE`,
      [input.report.leaseId],
    )
    if (completedScan.rows[0]) {
      if (hasExactReportReceipt(completedScan.rows[0], receipt)) {
        return { kind: 'scan' as const, scan: scanView(completedScan.rows[0]) }
      }
      throw new CareerSiteLinkedInPersistenceError(
        'LinkedIn worker report does not match the completed scan receipt',
        409,
        'CAREER_SITE_LINKEDIN_REPORT_REPLAY_CONFLICT',
      )
    }
    throw new CareerSiteLinkedInPersistenceError(
      'LinkedIn worker lease was not found or is no longer current',
      409,
      'CAREER_SITE_LINKEDIN_WORKER_LEASE_LOST',
    )
  })
}

export async function getCareerSiteLinkedInDatabaseReadiness() {
  requirePostgres()
  const result = await query<{
    migration_current: boolean
    connection_table: boolean
    auth_table: boolean
    scan_table: boolean
    nonce_table: boolean
  }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM schema_migrations WHERE filename = $1 AND checksum = $2
       ) AS migration_current,
       to_regclass('public.career_site_linkedin_connections') IS NOT NULL AS connection_table,
       to_regclass('public.career_site_linkedin_auth_attempts') IS NOT NULL AS auth_table,
       to_regclass('public.career_site_linkedin_scan_runs') IS NOT NULL AS scan_table,
       to_regclass('public.career_site_linkedin_worker_nonces') IS NOT NULL AS nonce_table`,
    [CAREER_SITE_LINKEDIN_MIGRATION_FILENAME, CAREER_SITE_LINKEDIN_MIGRATION_CHECKSUM],
  )
  const row = result.rows[0]
  const schemaReady = Boolean(
    row?.migration_current
    && row.connection_table
    && row.auth_table
    && row.scan_table
    && row.nonce_table
  )
  let lastWorkerSeenAt: string | null = null
  let workerConnected = false
  if (schemaReady) {
    const worker = await query<{
      last_worker_seen_at: string | null
      worker_connected: boolean
    }>(
      `SELECT max(created_at)::text AS last_worker_seen_at,
              COALESCE(
                max(created_at) >= now() - ($1::text || ' seconds')::interval,
                false
              ) AS worker_connected
       FROM career_site_linkedin_worker_nonces`,
      [WORKER_CONNECTED_SECONDS],
    )
    const workerRow = worker.rows[0]
    lastWorkerSeenAt = workerRow?.last_worker_seen_at
      ? new Date(workerRow.last_worker_seen_at).toISOString()
      : null
    workerConnected = workerRow?.worker_connected === true
  }
  return {
    schemaReady,
    migrationCurrent: row?.migration_current === true,
    lastWorkerSeenAt,
    workerConnected,
  }
}
