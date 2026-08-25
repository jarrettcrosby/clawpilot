import crypto from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  CareerSiteSubmissionRequestError,
  careerSiteSubmissionPayloadHash,
  type CareerSiteSubmissionSheetRecord,
  type NormalizedCareerSiteSubmission,
} from '@/lib/careerSiteSubmissionContract'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query, withTransaction } from '@/lib/persistence/postgres'

const OUTBOX_WORKER_HEARTBEAT_KEY = 'career_site.submissions.outbox.worker.heartbeat'

type CareerSiteSubmissionActor = {
  ownerEmail: string
  organizationId: string
  sourceApp: string
}

type CareerSiteSubmissionRow = QueryResultRow & {
  id: string
  external_submission_id: string
  source_app: string
  owner_email: string
  workspace_organization_id: string
  form_type: CareerSiteSubmissionSheetRecord['formType']
  requester_name: string | null
  requester_email: string
  requester_organization: string | null
  interest: CareerSiteSubmissionSheetRecord['interest']
  message: string | null
  network_interest: boolean
  role_fit: boolean
  newsletter_consent: boolean
  resume_variant: CareerSiteSubmissionSheetRecord['resumeVariant']
  source_url: string | null
  payload_hash: string
  created_at: string
  updated_at: string
}

type CareerSiteSubmissionOutboxStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'dead'

type CareerSiteSubmissionClaimRow = CareerSiteSubmissionRow & {
  outbox_id: string
  submission_id: string
  attempts: number
  lock_token: string
}

export type CareerSiteSubmissionOutboxItem = CareerSiteSubmissionSheetRecord & {
  id: string
  submissionId: string
  attempts: number
  lockToken: string
}

export class CareerSiteSubmissionPersistenceConflictError extends Error {
  readonly status = 409
  readonly code = 'CAREER_SITE_SUBMISSION_IDEMPOTENCY_CONFLICT'

  constructor() {
    super('submissionId was already used for different submission data')
    this.name = 'CareerSiteSubmissionPersistenceConflictError'
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CareerSiteSubmissionRequestError(
      'Career-site submissions require Postgres storage',
      503,
      'CAREER_SITE_SUBMISSIONS_POSTGRES_REQUIRED',
    )
  }
}

function toSheetRecord(row: CareerSiteSubmissionRow): CareerSiteSubmissionSheetRecord {
  return {
    externalSubmissionId: row.external_submission_id,
    sourceApp: row.source_app,
    formType: row.form_type,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    requesterOrganization: row.requester_organization,
    interest: row.interest,
    message: row.message,
    networkInterest: row.network_interest,
    roleFit: row.role_fit,
    newsletterConsent: row.newsletter_consent,
    resumeVariant: row.resume_variant,
    sourceUrl: row.source_url,
    ownerEmail: row.owner_email,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const SUBMISSION_RETURNING = `
  id::text,
  external_submission_id::text,
  source_app,
  owner_email,
  workspace_organization_id::text,
  form_type,
  requester_name,
  requester_email,
  requester_organization,
  interest,
  message,
  network_interest,
  role_fit,
  newsletter_consent,
  resume_variant,
  source_url,
  payload_hash,
  created_at::text,
  updated_at::text
`

const SUBMISSION_SELECT = `
  submission.id::text AS id,
  submission.external_submission_id::text,
  submission.source_app,
  submission.owner_email,
  submission.workspace_organization_id::text,
  submission.form_type,
  submission.requester_name,
  submission.requester_email,
  submission.requester_organization,
  submission.interest,
  submission.message,
  submission.network_interest,
  submission.role_fit,
  submission.newsletter_consent,
  submission.resume_variant,
  submission.source_url,
  submission.payload_hash,
  submission.created_at::text,
  submission.updated_at::text
`

async function ensureSubmissionOutbox(client: PoolClient, submissionId: string) {
  const result = await client.query<{ id: string; status: CareerSiteSubmissionOutboxStatus }>(
    `INSERT INTO career_site_submission_outbox (
       submission_id, status, attempts, available_at, created_at, updated_at
     ) VALUES ($1::uuid, 'queued', 0, now(), now(), now())
     ON CONFLICT (submission_id) DO UPDATE
     SET updated_at = career_site_submission_outbox.updated_at
     RETURNING id::text, status`,
    [submissionId],
  )
  const outbox = result.rows[0]
  if (!outbox) throw new Error('Career-site submission outbox could not be prepared')
  return outbox
}

export async function createCareerSiteSubmissionInPostgres(input: {
  actor: CareerSiteSubmissionActor
  submission: NormalizedCareerSiteSubmission
}) {
  requirePostgres()
  const payloadHash = careerSiteSubmissionPayloadHash(input.submission)
  return withTransaction(async (client) => {
    const inserted = await client.query<CareerSiteSubmissionRow>(
      `INSERT INTO career_site_submissions (
         external_submission_id,
         source_app,
         owner_email,
         workspace_organization_id,
         form_type,
         requester_name,
         requester_email,
         requester_organization,
         interest,
         message,
         network_interest,
         role_fit,
         newsletter_consent,
         resume_variant,
         source_url,
         payload_hash,
         created_at,
         updated_at
       ) VALUES (
         $1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, now(), now()
       )
       ON CONFLICT (source_app, external_submission_id) DO NOTHING
       RETURNING ${SUBMISSION_RETURNING}`,
      [
        input.submission.externalSubmissionId,
        input.actor.sourceApp,
        input.actor.ownerEmail,
        input.actor.organizationId,
        input.submission.formType,
        input.submission.requesterName,
        input.submission.requesterEmail,
        input.submission.requesterOrganization,
        input.submission.interest,
        input.submission.message,
        input.submission.networkInterest,
        input.submission.roleFit,
        input.submission.newsletterConsent,
        input.submission.resumeVariant,
        input.submission.sourceUrl,
        payloadHash,
      ],
    )
    const duplicate = !inserted.rows[0]
    const submission = inserted.rows[0] || (await client.query<CareerSiteSubmissionRow>(
      `SELECT ${SUBMISSION_RETURNING}
       FROM career_site_submissions
       WHERE source_app = $1
         AND external_submission_id = $2::uuid
       LIMIT 1
       FOR SHARE`,
      [input.actor.sourceApp, input.submission.externalSubmissionId],
    )).rows[0]

    if (
      !submission
      || submission.payload_hash !== payloadHash
      || submission.owner_email !== input.actor.ownerEmail
      || submission.workspace_organization_id !== input.actor.organizationId
    ) {
      throw new CareerSiteSubmissionPersistenceConflictError()
    }

    const outbox = await ensureSubmissionOutbox(client, submission.id)
    if (!duplicate) {
      await recordAuditEvent({
        actor: input.actor.ownerEmail,
        subject: input.actor.ownerEmail,
        eventType: 'career_site.submission.received',
        aggregateType: 'career_site_submission',
        aggregateId: submission.id,
        eventKey: `career-site-submission:${input.actor.sourceApp}:${input.submission.externalSubmissionId}`,
        organizationId: input.actor.organizationId,
        isSystem: true,
        payload: {
          formType: input.submission.formType,
          sourceApp: input.actor.sourceApp,
          outboxId: outbox.id,
        },
      }, client)
    }

    return {
      id: submission.id,
      externalSubmissionId: submission.external_submission_id,
      createdAt: new Date(submission.created_at).toISOString(),
      sheetSyncStatus: outbox.status,
      duplicate,
    }
  })
}

export async function claimCareerSiteSubmissionOutboxInPostgres(input: {
  limit?: number
  maxAttempts?: number
  leaseSeconds?: number
} = {}): Promise<CareerSiteSubmissionOutboxItem[]> {
  requirePostgres()
  const limit = Math.max(1, Math.min(Math.trunc(Number(input.limit) || 10), 50))
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const leaseSeconds = Math.max(30, Math.min(Math.trunc(Number(input.leaseSeconds) || 300), 3600))
  const lockToken = crypto.randomUUID()

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE career_site_submission_outbox
       SET status = CASE WHEN attempts >= $1 THEN 'dead' ELSE 'failed' END,
           last_error = COALESCE(last_error, 'worker lease expired'),
           available_at = now(),
           processed_at = CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
           locked_at = NULL,
           lock_token = NULL,
           updated_at = now()
       WHERE status = 'processing'
         AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' seconds')::interval)`,
      [maxAttempts, leaseSeconds],
    )

    const result = await client.query<CareerSiteSubmissionClaimRow>(
      `WITH candidates AS (
         SELECT id
         FROM career_site_submission_outbox
         WHERE status IN ('queued', 'failed')
           AND attempts < $2
           AND available_at <= now()
         ORDER BY available_at ASC, created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       ), claimed AS (
         UPDATE career_site_submission_outbox outbox
         SET status = 'processing',
             attempts = outbox.attempts + 1,
             locked_at = now(),
             lock_token = $3,
             updated_at = now()
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.id, outbox.submission_id, outbox.attempts, outbox.lock_token
       )
       SELECT
         claimed.id::text AS outbox_id,
         claimed.submission_id::text,
         claimed.attempts,
         claimed.lock_token,
         ${SUBMISSION_SELECT}
       FROM claimed
       JOIN career_site_submissions submission ON submission.id = claimed.submission_id
       ORDER BY submission.created_at ASC, submission.id ASC`,
      [limit, maxAttempts, lockToken],
    )

    return result.rows.map((row) => ({
      id: row.outbox_id,
      submissionId: row.submission_id,
      attempts: row.attempts,
      lockToken: row.lock_token,
      ...toSheetRecord(row),
    }))
  })
}

export async function completeCareerSiteSubmissionOutboxInPostgres(
  item: Pick<CareerSiteSubmissionOutboxItem, 'id' | 'lockToken'>,
) {
  const result = await query(
    `UPDATE career_site_submission_outbox
     SET status = 'succeeded',
         last_error = NULL,
         processed_at = now(),
         locked_at = NULL,
         lock_token = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND status = 'processing'
       AND lock_token = $2`,
    [item.id, item.lockToken],
  )
  if (result.rowCount !== 1) throw new Error(`Career-site outbox lease lost for ${item.id}`)
}

export async function failCareerSiteSubmissionOutboxInPostgres(input: {
  item: Pick<CareerSiteSubmissionOutboxItem, 'id' | 'lockToken' | 'attempts'>
  error: string
  maxAttempts?: number
  retryBaseSeconds?: number
}) {
  const maxAttempts = Math.max(1, Math.min(Math.trunc(Number(input.maxAttempts) || 8), 20))
  const retryBaseSeconds = Math.max(5, Math.min(Math.trunc(Number(input.retryBaseSeconds) || 30), 3600))
  const status: 'failed' | 'dead' = input.item.attempts >= maxAttempts ? 'dead' : 'failed'
  const delaySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(0, input.item.attempts - 1)), 3600)
  const result = await query(
    `UPDATE career_site_submission_outbox
     SET status = $3,
         last_error = $4,
         available_at = now() + ($5::text || ' seconds')::interval,
         processed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
         locked_at = NULL,
         lock_token = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND status = 'processing'
       AND lock_token = $2`,
    [input.item.id, input.item.lockToken, status, input.error.slice(0, 1000), delaySeconds],
  )
  if (result.rowCount !== 1) throw new Error(`Career-site outbox lease lost for ${input.item.id}`)
  return status
}

export async function recordCareerSiteSubmissionWorkerHeartbeatInPostgres(input: {
  phase: 'started' | 'completed'
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
    [OUTBOX_WORKER_HEARTBEAT_KEY, JSON.stringify({ ...input, checkedAt })],
  )
  return { checkedAt }
}
