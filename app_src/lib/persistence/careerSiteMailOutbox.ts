import crypto from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CareerSiteMailRequestError,
  careerSiteMailPayloadHash,
  type NormalizedCareerSiteMailRequest,
} from '@/lib/careerSiteMailContract'
import { careerSiteRfcMessageId } from '@/lib/careerSiteMailDelivery'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'

const MAIL_WORKER_HEARTBEAT_KEY = 'career_site.mail.outbox.worker.heartbeat'
export const CAREER_SITE_MAIL_MIGRATION_FILENAME = '0330_career_site_mail_outbox.sql'
export const CAREER_SITE_MAIL_MIGRATION_CHECKSUM = 'd2ed980456eb4e0da6e58d1c8bc2fcff6dfe7430cc8a78ef22257f471a1cd350'

type CareerSiteMailActor = {
  ownerEmail: string
  organizationId: string
  sourceApp: string
}

type CareerSiteMailStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'dead'

type CareerSiteMailRow = QueryResultRow & {
  id: string
  idempotency_key: string
  source_app: string
  owner_email: string
  workspace_organization_id: string
  message_type: NormalizedCareerSiteMailRequest['messageType']
  payload: NormalizedCareerSiteMailRequest
  payload_hash: string
  rfc_message_id: string
  status: CareerSiteMailStatus
  attempts: number
  draft_id: string | null
  provider_message_id: string | null
  lock_token: string | null
  created_at: string
  updated_at: string
}

export type CareerSiteMailOutboxItem = {
  id: string
  actor: CareerSiteMailActor
  request: NormalizedCareerSiteMailRequest
  rfcMessageId: string
  status: CareerSiteMailStatus
  attempts: number
  draftId: string | null
  providerMessageId: string | null
  lockToken: string
}

export type CareerSiteMailOperationalHealth = {
  enabled: true
  healthy: boolean
  status: 'healthy' | 'degraded' | 'unhealthy'
  migration: {
    filename: typeof CAREER_SITE_MAIL_MIGRATION_FILENAME
    applied: boolean
    checksumMatches: boolean
    tablePresent: boolean
  }
  queue: {
    queued: number
    processing: number
    succeeded: number
    failed: number
    dead: number
    staleProcessing: number
    outOfScopePending: number
    oldestPendingAt: string | null
  }
  worker: {
    phase: 'started' | 'completed' | 'degraded' | 'failed' | 'missing' | 'invalid'
    checkedAt: string | null
    ageSeconds: number | null
    stale: boolean
  }
  checkedAt: string
}

export class CareerSiteMailPersistenceConflictError extends Error {
  readonly status = 409
  readonly code = 'CAREER_SITE_MAIL_IDEMPOTENCY_CONFLICT'

  constructor() {
    super('idempotencyKey was already used for different email data')
    this.name = 'CareerSiteMailPersistenceConflictError'
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CareerSiteMailRequestError(
      'Career-site mail requires Postgres storage',
      503,
      'CAREER_SITE_MAIL_POSTGRES_REQUIRED',
    )
  }
}

const RETURNING = `
  id::text,
  idempotency_key,
  source_app,
  owner_email,
  workspace_organization_id::text,
  message_type,
  payload,
  payload_hash,
  rfc_message_id,
  status,
  attempts,
  draft_id,
  provider_message_id,
  lock_token,
  created_at::text,
  updated_at::text
`

function deliveryStatus(status: CareerSiteMailStatus): 'queued' | 'sent' {
  return status === 'succeeded' ? 'sent' : 'queued'
}

export async function createCareerSiteMailInPostgres(input: {
  actor: CareerSiteMailActor
  request: NormalizedCareerSiteMailRequest
}) {
  requirePostgres()
  const payloadHash = careerSiteMailPayloadHash(input.request)
  const rfcMessageId = careerSiteRfcMessageId(input.request.idempotencyKey)
  return withTransaction(async (client) => {
    const inserted = await client.query<CareerSiteMailRow>(
      `INSERT INTO career_site_mail_outbox (
         idempotency_key, source_app, owner_email, workspace_organization_id,
         message_type, payload, payload_hash, rfc_message_id, status,
         attempts, available_at, created_at, updated_at
       ) VALUES (
         $1::text, $2::text, $3::text, $4::uuid, $5::text, $6::jsonb,
         $7::text, $8::text, 'queued', 0, now(), now(), now()
       )
       ON CONFLICT (source_app, idempotency_key) DO NOTHING
       RETURNING ${RETURNING}`,
      [
        input.request.idempotencyKey,
        input.actor.sourceApp,
        input.actor.ownerEmail,
        input.actor.organizationId,
        input.request.messageType,
        JSON.stringify(input.request),
        payloadHash,
        rfcMessageId,
      ],
    )
    const duplicate = !inserted.rows[0]
    const row = inserted.rows[0] || (await client.query<CareerSiteMailRow>(
      `SELECT ${RETURNING}
       FROM career_site_mail_outbox
       WHERE source_app = $1::text AND idempotency_key = $2::text
       LIMIT 1
       FOR SHARE`,
      [input.actor.sourceApp, input.request.idempotencyKey],
    )).rows[0]
    if (
      !row
      || row.payload_hash !== payloadHash
      || row.message_type !== input.request.messageType
      || row.rfc_message_id !== rfcMessageId
      || row.owner_email !== input.actor.ownerEmail
      || row.workspace_organization_id !== input.actor.organizationId
    ) {
      throw new CareerSiteMailPersistenceConflictError()
    }
    if (!duplicate) {
      await recordAuditEvent({
        actor: input.actor.ownerEmail,
        subject: input.actor.ownerEmail,
        eventType: 'career_site.mail.queued',
        aggregateType: 'career_site_mail',
        aggregateId: row.id,
        eventKey: `career-site-mail:${input.actor.sourceApp}:${input.request.idempotencyKey}`,
        organizationId: input.actor.organizationId,
        isSystem: true,
        payload: {
          messageType: input.request.messageType,
          sourceApp: input.actor.sourceApp,
        },
      }, client)
    }
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      status: deliveryStatus(row.status),
      duplicate,
    }
  })
}

export async function claimCareerSiteMailOutboxInPostgres(input: {
  sourceApp: string
  ownerEmail: string
  maxAttempts?: number
  leaseSeconds?: number
}): Promise<CareerSiteMailOutboxItem[]> {
  requirePostgres()
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const leaseSeconds = Math.max(300, Math.min(Math.trunc(Number(input.leaseSeconds) || 900), 3600))
  const lockToken = crypto.randomUUID()
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE career_site_mail_outbox
       SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'failed' END,
           last_error = COALESCE(last_error, 'worker lease expired'),
           available_at = now(),
           locked_at = NULL,
           lock_token = NULL,
           updated_at = now()
       WHERE source_app = $3
         AND owner_email = $4
         AND status = 'processing'
         AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' seconds')::interval)`,
      [maxAttempts, leaseSeconds, input.sourceApp, input.ownerEmail],
    )
    const result = await client.query<CareerSiteMailRow>(
       `WITH candidate AS (
         SELECT id AS candidate_id
         FROM career_site_mail_outbox
         WHERE source_app = $3
           AND owner_email = $4
           AND status IN ('queued', 'failed')
           AND attempts < $1
           AND available_at <= now()
         ORDER BY available_at ASC, created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE career_site_mail_outbox outbox
       SET status = 'processing',
           attempts = outbox.attempts + 1,
           locked_at = now(),
           lock_token = $2,
           updated_at = now()
       FROM candidate
       WHERE outbox.id = candidate.candidate_id
       RETURNING ${RETURNING}`,
      [maxAttempts, lockToken, input.sourceApp, input.ownerEmail],
    )
    return result.rows.map((row) => ({
      id: row.id,
      actor: {
        ownerEmail: row.owner_email,
        organizationId: row.workspace_organization_id,
        sourceApp: row.source_app,
      },
      request: row.payload,
      rfcMessageId: row.rfc_message_id,
      status: row.status,
      attempts: row.attempts,
      draftId: row.draft_id,
      providerMessageId: row.provider_message_id,
      lockToken: row.lock_token || '',
    }))
  })
}

export async function renewCareerSiteMailOutboxLeaseInPostgres(
  item: Pick<CareerSiteMailOutboxItem, 'id' | 'lockToken'>,
) {
  const result = await query(
    `UPDATE career_site_mail_outbox
     SET locked_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
    [item.id, item.lockToken],
  )
  if (result.rowCount !== 1) throw new Error(`Career-site mail outbox lease lost for ${item.id}`)
}

export async function saveCareerSiteMailDraftInPostgres(input: {
  item: Pick<CareerSiteMailOutboxItem, 'id' | 'lockToken'>
  draftId: string
}) {
  const result = await query<{ draft_id: string }>(
    `UPDATE career_site_mail_outbox
     SET draft_id = COALESCE(draft_id, $3), locked_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2
     RETURNING draft_id`,
    [input.item.id, input.item.lockToken, input.draftId],
  )
  const draftId = result.rows[0]?.draft_id
  if (!draftId) throw new Error(`Career-site mail outbox lease lost for ${input.item.id}`)
  return draftId
}

export async function completeCareerSiteMailOutboxInPostgres(input: {
  item: Pick<CareerSiteMailOutboxItem, 'id' | 'lockToken'>
  providerMessageId: string
}) {
  const result = await query(
    `UPDATE career_site_mail_outbox
     SET status = 'succeeded',
         provider_message_id = $3,
         last_error = NULL,
         delivered_at = now(),
         locked_at = NULL,
         lock_token = NULL,
         updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
    [input.item.id, input.item.lockToken, input.providerMessageId],
  )
  if (result.rowCount !== 1) throw new Error(`Career-site mail outbox lease lost for ${input.item.id}`)
}

export async function failCareerSiteMailOutboxInPostgres(input: {
  item: Pick<CareerSiteMailOutboxItem, 'id' | 'lockToken' | 'attempts'>
  error: string
  maxAttempts?: number
  retryBaseSeconds?: number
}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const retryBaseSeconds = Math.max(30, Math.min(Math.trunc(Number(input.retryBaseSeconds) || 60), 3600))
  const status: 'failed' | 'dead' = input.item.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.item.attempts - 1)), 3600)
  const result = await query(
    `UPDATE career_site_mail_outbox
     SET status = $3,
         last_error = $4,
         available_at = now() + ($5::text || ' seconds')::interval,
         locked_at = NULL,
         lock_token = NULL,
         updated_at = now()
     WHERE id = $1::uuid AND status = 'processing' AND lock_token = $2`,
    [input.item.id, input.item.lockToken, status, input.error.slice(0, 1000), delaySeconds],
  )
  if (result.rowCount !== 1) throw new Error(`Career-site mail outbox lease lost for ${input.item.id}`)
  return status
}

export async function recordCareerSiteMailWorkerHeartbeatInPostgres(input: {
  phase: 'started' | 'completed' | 'degraded' | 'failed'
  workerId: string
  claimed: number
  succeeded: number
  failed: number
  dead: number
}) {
  const checkedAt = new Date().toISOString()
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [MAIL_WORKER_HEARTBEAT_KEY, JSON.stringify({ ...input, checkedAt })],
  )
  return { checkedAt }
}

export async function readCareerSiteMailOperationalHealthFromPostgres(input: {
  sourceApp: string
  ownerEmail: string
  pollMs?: number
  leaseSeconds?: number
}): Promise<CareerSiteMailOperationalHealth> {
  requirePostgres()
  const checkedAtMs = Date.now()
  const checkedAt = new Date(checkedAtMs).toISOString()
  const pollMs = Math.max(5_000, Math.min(Math.trunc(Number(input.pollMs) || 10_000), 300_000))
  const leaseSeconds = Math.max(300, Math.min(Math.trunc(Number(input.leaseSeconds) || 900), 3_600))
  const migration = await query<{ applied: boolean; checksum_matches: boolean; table_present: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS applied,
       EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1 AND checksum = $2) AS checksum_matches,
       to_regclass('public.career_site_mail_outbox') IS NOT NULL AS table_present`,
    [CAREER_SITE_MAIL_MIGRATION_FILENAME, CAREER_SITE_MAIL_MIGRATION_CHECKSUM],
  )
  const migrationRow = migration.rows[0]
  const migrationState = {
    filename: CAREER_SITE_MAIL_MIGRATION_FILENAME,
    applied: migrationRow?.applied === true,
    checksumMatches: migrationRow?.checksum_matches === true,
    tablePresent: migrationRow?.table_present === true,
  } as const
  const emptyQueue = {
    queued: 0,
    processing: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    staleProcessing: 0,
    outOfScopePending: 0,
    oldestPendingAt: null,
  }
  const missingWorker = {
    phase: 'missing' as const,
    checkedAt: null,
    ageSeconds: null,
    stale: true,
  }
  if (!migrationState.applied || !migrationState.checksumMatches || !migrationState.tablePresent) {
    return {
      enabled: true,
      healthy: false,
      status: 'unhealthy',
      migration: migrationState,
      queue: emptyQueue,
      worker: missingWorker,
      checkedAt,
    }
  }
  const result = await query<{
    queued: string
    processing: string
    succeeded: string
    failed: string
    dead: string
    stale_processing: string
    out_of_scope_pending: string
    oldest_pending_at: string | null
    worker_heartbeat: unknown
  }>(
    `SELECT
       count(*) FILTER (WHERE source_app = $1 AND owner_email = $2 AND status = 'queued')::text AS queued,
       count(*) FILTER (WHERE source_app = $1 AND owner_email = $2 AND status = 'processing')::text AS processing,
       count(*) FILTER (WHERE source_app = $1 AND owner_email = $2 AND status = 'succeeded')::text AS succeeded,
       count(*) FILTER (WHERE source_app = $1 AND owner_email = $2 AND status = 'failed')::text AS failed,
       count(*) FILTER (WHERE source_app = $1 AND owner_email = $2 AND status = 'dead')::text AS dead,
       count(*) FILTER (
         WHERE source_app = $1 AND owner_email = $2 AND status = 'processing'
           AND (locked_at IS NULL OR locked_at < now() - ($3::text || ' seconds')::interval)
       )::text AS stale_processing,
       count(*) FILTER (
         WHERE status IN ('queued', 'failed', 'processing')
           AND NOT (source_app = $1 AND owner_email = $2)
       )::text AS out_of_scope_pending,
       min(created_at) FILTER (
         WHERE source_app = $1 AND owner_email = $2 AND status IN ('queued', 'failed', 'processing')
       )::text AS oldest_pending_at,
       (SELECT value FROM app_settings WHERE key = $4) AS worker_heartbeat
     FROM career_site_mail_outbox`,
    [input.sourceApp, input.ownerEmail, leaseSeconds, MAIL_WORKER_HEARTBEAT_KEY],
  )
  const row = result.rows[0]
  const count = (value: string | undefined) => {
    const parsed = Number(value || 0)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  const queue = {
    queued: count(row?.queued),
    processing: count(row?.processing),
    succeeded: count(row?.succeeded),
    failed: count(row?.failed),
    dead: count(row?.dead),
    staleProcessing: count(row?.stale_processing),
    outOfScopePending: count(row?.out_of_scope_pending),
    oldestPendingAt: row?.oldest_pending_at ? new Date(row.oldest_pending_at).toISOString() : null,
  }
  const heartbeat = row?.worker_heartbeat && typeof row.worker_heartbeat === 'object'
    ? row.worker_heartbeat as Record<string, unknown>
    : null
  const phaseValue = String(heartbeat?.phase || '')
  const checkedAtValue = typeof heartbeat?.checkedAt === 'string' ? heartbeat.checkedAt : ''
  const heartbeatMs = Date.parse(checkedAtValue)
  const heartbeatValid = ['started', 'completed', 'degraded', 'failed'].includes(phaseValue)
    && Number.isFinite(heartbeatMs)
    && heartbeatMs <= checkedAtMs + 30_000
  const ageSeconds = heartbeatValid ? Math.max(0, Math.floor((checkedAtMs - heartbeatMs) / 1000)) : null
  const stale = ageSeconds === null || ageSeconds * 1000 > Math.max(60_000, pollMs * 3)
  const worker = {
    phase: heartbeatValid
      ? phaseValue as 'started' | 'completed' | 'degraded' | 'failed'
      : heartbeat ? 'invalid' as const : 'missing' as const,
    checkedAt: heartbeatValid ? new Date(heartbeatMs).toISOString() : null,
    ageSeconds,
    stale,
  }
  const unhealthy = queue.dead > 0
    || queue.staleProcessing > 0
    || queue.outOfScopePending > 0
    || worker.phase === 'missing'
    || worker.phase === 'invalid'
    || worker.phase === 'failed'
    || worker.stale
  const degraded = !unhealthy && (queue.failed > 0 || worker.phase === 'degraded')
  const status = unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy'
  return {
    enabled: true,
    healthy: status === 'healthy',
    status,
    migration: migrationState,
    queue,
    worker,
    checkedAt,
  }
}
