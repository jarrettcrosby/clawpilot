import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'

const WORKER_HEARTBEAT_KEY =
  'commerce.fulfillment_recovery.worker.heartbeat'

export const COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT = 8
export const COMMERCE_FULFILLMENT_QUEUED_GRACE_SECONDS = 30
export const COMMERCE_FULFILLMENT_PROCESSING_LEASE_SECONDS = 5 * 60
export const COMMERCE_FULFILLMENT_RECOVERY_EXHAUSTED_CODE =
  'OPERATIONS_COMMERCE_EXPORT_AUTOMATIC_RECOVERY_EXHAUSTED'

export type CommerceFulfillmentRecoveryClaim = {
  organizationId: string
  commerceExportGlobalId: string
  actorEmail: string | null
  provider: 'shopify' | 'faire'
  /** Monotonic claim fence. This value must never be rewound. */
  attempt: number
  automaticRecoveryAttempt: number
  priorAutomaticRecoveryAttempts: number
  priorState: 'queued' | 'processing' | 'failed'
  priorProviderReference: string | null
  priorErrorCode: string | null
  priorErrorMessage: string | null
  priorCompletedAt: string | null
}

type ClaimRow = {
  organization_id: string
  global_id: string
  actor_email: string | null
  provider: 'shopify' | 'faire'
  attempts: number
  automatic_recovery_attempts: number
  prior_automatic_recovery_attempts: number
  prior_state: CommerceFulfillmentRecoveryClaim['priorState']
  prior_provider_reference: string | null
  prior_error_code: string | null
  prior_error_message: string | null
  prior_completed_at: Date | string | null
}

type ExhaustedRow = {
  organization_id: string
  global_id: string
  provider: 'shopify' | 'faire'
  attempts: number
  automatic_recovery_attempts: number
  prior_state: 'queued' | 'processing' | 'failed'
  prior_error_code: string | null
  original_confirmer: string | null
}

function workerId(value: unknown) {
  const normalized = String(value || '').trim().slice(0, 200)
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Commerce fulfillment recovery worker ID is invalid')
  }
  return normalized
}

function boundedBatchSize(value: unknown) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, 5))
    : 5
}

/**
 * Claims one exact export by changing its existing state projection to
 * `processing`. No separate lease table is needed: `attempts` is the monotonic
 * fencing token and `updated_at` is the five-minute crash-recovery lease.
 * `automatic_recovery_attempts` is a separate bounded budget so credential
 * maintenance can park work without rewinding the fence or exhausting work.
 * Provider attempts remain the sole proof that network I/O may have occurred.
 */
export async function claimCommerceFulfillmentRecoveryInPostgres(input: {
  workerId: unknown
}): Promise<CommerceFulfillmentRecoveryClaim | null> {
  workerId(input.workerId)
  const result = await query<ClaimRow>(
    `WITH candidate AS (
       SELECT fulfillment_export.id, fulfillment_export.organization_id,
              fulfillment_export.global_id, fulfillment_export.provider,
              fulfillment_export.attempts,
              fulfillment_export.automatic_recovery_attempts,
              fulfillment_export.state AS prior_state,
              fulfillment_export.provider_reference
                AS prior_provider_reference,
              fulfillment_export.error_code AS prior_error_code,
              fulfillment_export.error_message AS prior_error_message,
              fulfillment_export.completed_at AS prior_completed_at,
              shipment.confirmed_by AS actor_email
       FROM operations_commerce_fulfillment_exports fulfillment_export
       JOIN operations_shipments shipment
         ON shipment.organization_id = fulfillment_export.organization_id
        AND shipment.id = fulfillment_export.shipment_id
       WHERE fulfillment_export.provider IN ('shopify', 'faire')
         AND fulfillment_export.automatic_recovery_attempts < $1
         AND (
           (
             fulfillment_export.state = 'queued'
             AND fulfillment_export.requested_at <=
               now() - make_interval(secs => $2)
           )
           OR (
             fulfillment_export.state = 'processing'
             AND fulfillment_export.updated_at <=
               now() - make_interval(secs => $3)
           )
           OR (
             fulfillment_export.state = 'failed'
             AND fulfillment_export.error_code =
               'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
             AND fulfillment_export.updated_at <= now() - CASE
               WHEN fulfillment_export.automatic_recovery_attempts <= 1
                 THEN interval '30 seconds'
               WHEN fulfillment_export.automatic_recovery_attempts = 2
                 THEN interval '1 minute'
               WHEN fulfillment_export.automatic_recovery_attempts = 3
                 THEN interval '2 minutes'
               WHEN fulfillment_export.automatic_recovery_attempts = 4
                 THEN interval '5 minutes'
               ELSE interval '15 minutes'
             END
           )
         )
       ORDER BY
         CASE fulfillment_export.state
           WHEN 'queued' THEN 0
           WHEN 'processing' THEN 1
           ELSE 2
         END,
         fulfillment_export.updated_at,
         fulfillment_export.id
       FOR UPDATE OF fulfillment_export SKIP LOCKED
       LIMIT 1
     ), claimed AS (
       UPDATE operations_commerce_fulfillment_exports fulfillment_export
       SET state = 'processing',
           attempts = fulfillment_export.attempts + 1,
           automatic_recovery_attempts =
             fulfillment_export.automatic_recovery_attempts + 1,
           provider_reference = NULL,
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           updated_at = now()
       FROM candidate
       WHERE fulfillment_export.id = candidate.id
         AND fulfillment_export.organization_id = candidate.organization_id
         AND fulfillment_export.attempts = candidate.attempts
         AND fulfillment_export.automatic_recovery_attempts =
           candidate.automatic_recovery_attempts
         AND fulfillment_export.state = candidate.prior_state
       RETURNING fulfillment_export.organization_id::text,
                 fulfillment_export.global_id,
                 fulfillment_export.provider, fulfillment_export.attempts,
                 fulfillment_export.automatic_recovery_attempts,
                 candidate.automatic_recovery_attempts
                   AS prior_automatic_recovery_attempts,
                 candidate.prior_state,
                 candidate.prior_provider_reference,
                 candidate.prior_error_code,
                 candidate.prior_error_message,
                 candidate.prior_completed_at,
                 candidate.actor_email
     )
     SELECT * FROM claimed`,
    [
      COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
      COMMERCE_FULFILLMENT_QUEUED_GRACE_SECONDS,
      COMMERCE_FULFILLMENT_PROCESSING_LEASE_SECONDS,
    ],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    organizationId: row.organization_id,
    commerceExportGlobalId: row.global_id,
    actorEmail: row.actor_email,
    provider: row.provider,
    attempt: Number(row.attempts),
    automaticRecoveryAttempt: Number(row.automatic_recovery_attempts),
    priorAutomaticRecoveryAttempts:
      Number(row.prior_automatic_recovery_attempts),
    priorState: row.prior_state,
    priorProviderReference: row.prior_provider_reference,
    priorErrorCode: row.prior_error_code,
    priorErrorMessage: row.prior_error_message,
    priorCompletedAt: row.prior_completed_at == null
      ? null
      : new Date(row.prior_completed_at).toISOString(),
  }
}

function invalidRecoveryClaim(message: string): never {
  const error = new Error(message) as Error & { code: string }
  error.code = 'OPERATIONS_COMMERCE_EXPORT_RECOVERY_CLAIM_INVALID'
  throw error
}

/**
 * Restores the exact pre-claim business outcome after credential runtime
 * maintenance prevents provider I/O. The monotonic `attempts` fence is left at
 * the claimed value; only the independent automatic recovery budget is
 * restored. This avoids both terminal exhaustion and an ABA claim-fence bug.
 */
export async function parkCommerceFulfillmentRecoveryForRuntimeMaintenanceInPostgres(
  input: {
    workerId: unknown
    claim: CommerceFulfillmentRecoveryClaim
  },
) {
  const normalizedWorkerId = workerId(input.workerId)
  const claim = input.claim
  if (!claim || typeof claim !== 'object') {
    invalidRecoveryClaim('Commerce fulfillment recovery claim is missing')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(claim.organizationId || ''))) {
    invalidRecoveryClaim('Commerce fulfillment recovery organization is invalid')
  }
  if (!/^gfe(?:[0-9]{7}|[0-9a-v]{12})$/
    .test(String(claim.commerceExportGlobalId || ''))) {
    invalidRecoveryClaim('Commerce fulfillment recovery export is invalid')
  }
  if (!['shopify', 'faire'].includes(claim.provider)) {
    invalidRecoveryClaim('Commerce fulfillment recovery provider is invalid')
  }
  if (!['queued', 'processing', 'failed'].includes(claim.priorState)) {
    invalidRecoveryClaim('Commerce fulfillment recovery prior state is invalid')
  }
  if (
    !Number.isSafeInteger(claim.attempt)
    || claim.attempt < 1
    || !Number.isSafeInteger(claim.automaticRecoveryAttempt)
    || claim.automaticRecoveryAttempt < 1
    || !Number.isSafeInteger(claim.priorAutomaticRecoveryAttempts)
    || claim.priorAutomaticRecoveryAttempts < 0
    || claim.automaticRecoveryAttempt
      !== claim.priorAutomaticRecoveryAttempts + 1
    || claim.automaticRecoveryAttempt > claim.attempt
  ) {
    invalidRecoveryClaim('Commerce fulfillment recovery fence is invalid')
  }
  if (
    (claim.priorState === 'failed') !== (claim.priorCompletedAt !== null)
  ) {
    invalidRecoveryClaim(
      'Commerce fulfillment recovery completion evidence is invalid',
    )
  }
  if (
    claim.priorCompletedAt !== null
    && Number.isNaN(new Date(claim.priorCompletedAt).getTime())
  ) {
    invalidRecoveryClaim(
      'Commerce fulfillment recovery completion timestamp is invalid',
    )
  }

  return withTransaction(async (client) => {
    const parked = await client.query<{ global_id: string }>(
      `UPDATE operations_commerce_fulfillment_exports
       SET state = $4,
           automatic_recovery_attempts = $5,
           provider_reference = $6,
           error_code = $7,
           error_message = $8,
           completed_at = $9::timestamptz,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND global_id = $2
         AND state = 'processing'
         AND attempts = $3
         AND automatic_recovery_attempts = $10
         AND provider_reference IS NULL
         AND error_code IS NULL
         AND error_message IS NULL
         AND completed_at IS NULL
       RETURNING global_id`,
      [
        claim.organizationId,
        claim.commerceExportGlobalId,
        claim.attempt,
        claim.priorState,
        claim.priorAutomaticRecoveryAttempts,
        claim.priorProviderReference,
        claim.priorErrorCode,
        claim.priorErrorMessage,
        claim.priorCompletedAt,
        claim.automaticRecoveryAttempt,
      ],
    )
    if (parked.rowCount !== 1) {
      const error = new Error(
        'Commerce fulfillment recovery changed before runtime maintenance could park it',
      ) as Error & { code: string }
      error.code = 'OPERATIONS_COMMERCE_EXPORT_CHANGED'
      throw error
    }
    await recordAuditEvent({
      actor: 'system',
      isSystem: true,
      eventType:
        'operations.commerce_fulfillment.runtime_maintenance_parked',
      aggregateType: 'operations.commerce_fulfillment_export',
      aggregateId: claim.commerceExportGlobalId,
      subject:
        `Commerce fulfillment export ${claim.commerceExportGlobalId}`,
      organizationId: claim.organizationId,
      eventKey: (
        `operations:commerce-fulfillment:${claim.commerceExportGlobalId}:`
        + `runtime-maintenance-parked:${claim.attempt}`
      ),
      payload: {
        provider: claim.provider,
        fenceAttempt: claim.attempt,
        automaticRecoveryAttempt: claim.automaticRecoveryAttempt,
        restoredAutomaticRecoveryAttempts:
          claim.priorAutomaticRecoveryAttempts,
        priorState: claim.priorState,
        priorErrorCode: claim.priorErrorCode,
        recoveryWorkerId: normalizedWorkerId,
        automaticAttemptConsumed: false,
        providerIo: false,
      },
    }, client)
    return true
  })
}

/**
 * Converts capped unresolved work into an explicit, audited manual-review
 * failure. This path performs no provider I/O and fences a late executor with
 * the same state-and-attempt comparison used by the normal claim path.
 */
export async function finalizeExhaustedCommerceFulfillmentRecoveriesInPostgres(
  input: { workerId: unknown; limit?: number },
) {
  const normalizedWorkerId = workerId(input.workerId)
  const limit = boundedBatchSize(input.limit)
  return withTransaction(async (client) => {
    const result = await client.query<ExhaustedRow>(
      `WITH candidate AS (
         SELECT fulfillment_export.id,
                fulfillment_export.organization_id,
                fulfillment_export.global_id,
                fulfillment_export.provider,
                fulfillment_export.attempts,
                fulfillment_export.automatic_recovery_attempts,
                fulfillment_export.state AS prior_state,
                fulfillment_export.error_code AS prior_error_code,
                shipment.confirmed_by AS original_confirmer
         FROM operations_commerce_fulfillment_exports fulfillment_export
         LEFT JOIN operations_shipments shipment
           ON shipment.organization_id = fulfillment_export.organization_id
          AND shipment.id = fulfillment_export.shipment_id
         WHERE fulfillment_export.provider IN ('shopify', 'faire')
           AND fulfillment_export.automatic_recovery_attempts >= $1
           AND (
             (
               fulfillment_export.state = 'queued'
               AND fulfillment_export.requested_at <=
                 now() - make_interval(secs => $2)
             )
             OR (
               fulfillment_export.state = 'processing'
               AND fulfillment_export.updated_at <=
                 now() - make_interval(secs => $3)
             )
             OR (
               fulfillment_export.state = 'failed'
               AND fulfillment_export.error_code =
                 'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
             )
           )
         ORDER BY fulfillment_export.updated_at, fulfillment_export.id
         FOR UPDATE OF fulfillment_export SKIP LOCKED
         LIMIT $4
       ), finalized AS (
         UPDATE operations_commerce_fulfillment_exports fulfillment_export
         SET state = 'failed',
             error_code = $5,
             error_message = concat(
               'Automatic fulfillment recovery stopped after ',
               fulfillment_export.automatic_recovery_attempts,
               ' attempts; operator reconciliation is required'
             ),
             completed_at = now(),
             updated_at = now()
         FROM candidate
         WHERE fulfillment_export.id = candidate.id
           AND fulfillment_export.organization_id = candidate.organization_id
           AND fulfillment_export.attempts = candidate.attempts
           AND fulfillment_export.automatic_recovery_attempts =
             candidate.automatic_recovery_attempts
           AND fulfillment_export.state = candidate.prior_state
           AND fulfillment_export.error_code IS NOT DISTINCT FROM
             candidate.prior_error_code
         RETURNING fulfillment_export.organization_id::text,
                   fulfillment_export.global_id,
                   fulfillment_export.provider,
                   fulfillment_export.attempts,
                   fulfillment_export.automatic_recovery_attempts,
                   candidate.prior_state,
                   candidate.prior_error_code,
                   candidate.original_confirmer
       )
       SELECT * FROM finalized`,
      [
        COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
        COMMERCE_FULFILLMENT_QUEUED_GRACE_SECONDS,
        COMMERCE_FULFILLMENT_PROCESSING_LEASE_SECONDS,
        limit,
        COMMERCE_FULFILLMENT_RECOVERY_EXHAUSTED_CODE,
      ],
    )
    for (const row of result.rows) {
      await recordAuditEvent({
        actor: 'system',
        isSystem: true,
        eventType: 'operations.commerce_fulfillment.recovery_exhausted',
        aggregateType: 'operations.commerce_fulfillment_export',
        aggregateId: row.global_id,
        subject: `Commerce fulfillment export ${row.global_id}`,
        organizationId: row.organization_id,
        eventKey: (
          `operations:commerce-fulfillment:${row.global_id}:`
          + `automatic-recovery-exhausted:${row.attempts}`
        ),
        payload: {
          provider: row.provider,
          attempt: Number(row.attempts),
          automaticRecoveryAttempts:
            Number(row.automatic_recovery_attempts),
          priorState: row.prior_state,
          priorErrorCode: row.prior_error_code,
          originalConfirmer: row.original_confirmer,
          recoveryWorkerId: normalizedWorkerId,
          automaticAttemptLimit:
            COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
          managerRecoveryRequired: true,
          providerIo: false,
        },
      }, client)
    }
    return result.rowCount || 0
  })
}

export async function recordCommerceFulfillmentRecoveryHeartbeatInPostgres(
  input: Record<string, unknown>,
) {
  const heartbeat = {
    ...input,
    checkedAt: new Date().toISOString(),
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = now()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat)],
  )
  return heartbeat
}

export async function readCommerceFulfillmentRecoveryHealthInPostgres() {
  const [queue, heartbeat] = await Promise.all([
    query<{
      queued: number
      stale_processing: number
      reconciliation_due: number
      automatic_ceiling_reached: number
      manual_review_failures: number
      missing_actor: number
    }>(
      `SELECT
         count(*) FILTER (WHERE state = 'queued')::integer AS queued,
         count(*) FILTER (
           WHERE state = 'processing'
             AND updated_at <= now() - make_interval(secs => $2)
         )::integer AS stale_processing,
         count(*) FILTER (
           WHERE state = 'failed'
             AND error_code =
               'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
             AND automatic_recovery_attempts < $1
         )::integer AS reconciliation_due,
         count(*) FILTER (
           WHERE state IN ('queued', 'processing', 'failed')
             AND automatic_recovery_attempts >= $1
         )::integer AS automatic_ceiling_reached,
         count(*) FILTER (
           WHERE state = 'failed'
             AND error_code IS DISTINCT FROM
               'OPERATIONS_COMMERCE_EXPORT_RECONCILIATION_REQUIRED'
         )::integer AS manual_review_failures,
         count(*) FILTER (
           WHERE state IN ('queued', 'processing', 'failed')
             AND shipment.confirmed_by IS NULL
         )::integer AS missing_actor
       FROM operations_commerce_fulfillment_exports fulfillment_export
       JOIN operations_shipments shipment
         ON shipment.organization_id = fulfillment_export.organization_id
        AND shipment.id = fulfillment_export.shipment_id
       WHERE fulfillment_export.provider IN ('shopify', 'faire')`,
      [
        COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
        COMMERCE_FULFILLMENT_PROCESSING_LEASE_SECONDS,
      ],
    ),
    query<{ value: Record<string, unknown> }>(
      `SELECT value
       FROM app_settings
       WHERE key = $1
       LIMIT 1`,
      [WORKER_HEARTBEAT_KEY],
    ),
  ])
  const counts = queue.rows[0] || {
    queued: 0,
    stale_processing: 0,
    reconciliation_due: 0,
    automatic_ceiling_reached: 0,
    manual_review_failures: 0,
    missing_actor: 0,
  }
  return {
    queued: Number(counts.queued || 0),
    staleProcessing: Number(counts.stale_processing || 0),
    reconciliationDue: Number(counts.reconciliation_due || 0),
    automaticCeilingReached: Number(counts.automatic_ceiling_reached || 0),
    manualReviewFailures: Number(counts.manual_review_failures || 0),
    missingActor: Number(counts.missing_actor || 0),
    automaticAttemptLimit: COMMERCE_FULFILLMENT_AUTOMATIC_ATTEMPT_LIMIT,
    heartbeat: heartbeat.rows[0]?.value || null,
  }
}
