import { recordAuditEvent } from '@/lib/auditWriter'
import { withTransaction } from '@/lib/persistence/postgres'

const ORDER_RECONCILIATION_INTERVAL = '30 minutes'
const ORDER_RECONCILIATION_LEASE = '10 minutes'

const ORDER_READABLE_CONNECTION_SQL = `(
  (
    account.provider = 'shopify'
    AND COALESCE(account.configuration->'grantedScopes', '[]'::jsonb)
      ? 'read_orders'
  )
  OR (
    account.provider = 'faire'
    AND (
      credential.auth_mode = 'faire_brand_token'
      OR COALESCE(account.configuration->'requestedScopes', '[]'::jsonb)
        ? 'READ_ORDERS'
    )
  )
)`

export type CommerceOrderReconciliationTarget = {
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  credentialVersion: number
  startedAt: string
  continuationRunGlobalId: string | null
}

function boundedCount(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function safeErrorCode(error: unknown) {
  const candidate = (
    error
    && typeof error === 'object'
    && 'code' in error
  )
    ? String((error as { code?: unknown }).code || '')
    : ''
  if (/^[A-Z][A-Z0-9_]{2,127}$/.test(candidate)) return candidate
  const constraint = (
    error
    && typeof error === 'object'
    && 'constraint' in error
  )
    ? String((error as { constraint?: unknown }).constraint || '')
    : ''
  // PostgreSQL SQLSTATE values are deliberately collapsed to stable,
  // operator-safe categories. Only an allowlisted constraint gets a specific
  // code; raw constraint names, values, and provider/customer data must not
  // leak into the cursor or worker response.
  if (candidate === '23514') {
    if (
      constraint
      === 'operations_commerce_order_candidates_checkout_service_valid'
    ) {
      return 'COMMERCE_ORDER_CHECKOUT_SERVICE_CODE_INVALID'
    }
    return 'COMMERCE_ORDER_RECONCILIATION_CHECK_CONSTRAINT_FAILED'
  }
  if (candidate === '23505') {
    return 'COMMERCE_ORDER_RECONCILIATION_UNIQUE_CONSTRAINT_FAILED'
  }
  if (candidate === '23503') {
    return 'COMMERCE_ORDER_RECONCILIATION_REFERENCE_CONSTRAINT_FAILED'
  }
  return 'COMMERCE_ORDER_RECONCILIATION_FAILED'
}

/**
 * Claims only connections whose existing integration authorization already
 * covers an order read. The claim is a local lease; provider cursors are never
 * persisted here, and the worker stages held candidates only. The existing
 * encrypted continuation is referenced by run ID, never read or copied here.
 */
export async function claimCommerceOrderReconciliationTargetsInPostgres(input: {
  limit: number
}) {
  return withTransaction(async (client) => {
    const claimed = await client.query<{
      organization_id: string
      integration_account_id: string
      account_global_id: string
      provider: 'shopify' | 'faire'
      credential_version: number
      continuation_run_global_id: string | null
      last_started_at: Date
    }>(
      `WITH candidates AS (
         SELECT
           account.organization_id,
           account.id AS integration_account_id,
           account.global_id AS account_global_id,
           account.provider,
           account.commerce_credential_generation AS credential_version,
           continuation.run_global_id AS continuation_run_global_id
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         LEFT JOIN operations_commerce_sync_cursors cursor
           ON cursor.organization_id = account.organization_id
          AND cursor.integration_account_id = account.id
          AND cursor.resource = 'orders'
         LEFT JOIN LATERAL (
           SELECT run.global_id AS run_global_id
           FROM operations_commerce_intake_continuations continuation
           JOIN operations_commerce_intake_runs run
             ON run.organization_id = continuation.organization_id
            AND run.integration_account_id = continuation.integration_account_id
            AND run.id = continuation.run_id
           WHERE continuation.organization_id = account.organization_id
             AND continuation.integration_account_id = account.id
             AND continuation.provider = account.provider
             AND continuation.resource = 'orders'
             AND continuation.credential_version
               = account.commerce_credential_generation
             AND continuation.cursor_state = 'available'
             AND run.created_by = 'system:commerce-order-reconciliation'
           ORDER BY continuation.batch_number DESC, continuation.created_at DESC
           LIMIT 1
         ) continuation ON true
         WHERE account.integration_type = 'commerce'
           AND account.provider IN ('shopify', 'faire')
           -- Commerce API polling is authorized by the verified organization
           -- credential and readable scope. Active is reserved for the
           -- separate signed-receipt path, so a verified polling-only
           -- connection may remain disabled without suppressing order reads.
           AND account.status <> 'error'
           AND account.commerce_credential_generation > 0
           AND credential.credential_version
             = account.commerce_credential_generation
           AND credential.verification_status = 'verified'
           AND activation.state IN ('shadow', 'active')
           AND ${ORDER_READABLE_CONNECTION_SQL}
           AND (
             cursor.integration_account_id IS NULL
             OR cursor.reconciliation_status <> 'running'
             OR cursor.last_started_at < now()
               - interval '${ORDER_RECONCILIATION_LEASE}'
           )
           AND (
             continuation.run_global_id IS NOT NULL
             OR cursor.integration_account_id IS NULL
             OR cursor.last_started_at IS NULL
             OR cursor.last_started_at < now()
               - interval '${ORDER_RECONCILIATION_INTERVAL}'
           )
         ORDER BY COALESCE(cursor.last_started_at, to_timestamp(0)),
                  account.updated_at, account.id
         FOR UPDATE OF account SKIP LOCKED
         LIMIT $1
       )
       INSERT INTO operations_commerce_sync_cursors (
         organization_id, integration_account_id, resource,
         reconciliation_status, records_seen, records_applied, records_held,
         consecutive_failures, last_error_code, last_started_at, updated_at
       )
       SELECT
         organization_id, integration_account_id, 'orders', 'running',
         0, 0, 0, 0, NULL, now(), now()
       FROM candidates
       ON CONFLICT (organization_id, integration_account_id, resource)
       DO UPDATE SET
         reconciliation_status = 'running',
         records_seen = CASE
           WHEN (
             SELECT candidate.continuation_run_global_id
             FROM candidates candidate
             WHERE candidate.organization_id
                   = operations_commerce_sync_cursors.organization_id
               AND candidate.integration_account_id
                   = operations_commerce_sync_cursors.integration_account_id
             LIMIT 1
           ) IS NULL THEN 0
           ELSE operations_commerce_sync_cursors.records_seen
         END,
         records_applied = CASE
           WHEN (
             SELECT candidate.continuation_run_global_id
             FROM candidates candidate
             WHERE candidate.organization_id
                   = operations_commerce_sync_cursors.organization_id
               AND candidate.integration_account_id
                   = operations_commerce_sync_cursors.integration_account_id
             LIMIT 1
           ) IS NULL THEN 0
           ELSE operations_commerce_sync_cursors.records_applied
         END,
         records_held = CASE
           WHEN (
             SELECT candidate.continuation_run_global_id
             FROM candidates candidate
             WHERE candidate.organization_id
                   = operations_commerce_sync_cursors.organization_id
               AND candidate.integration_account_id
                   = operations_commerce_sync_cursors.integration_account_id
             LIMIT 1
           ) IS NULL THEN 0
           ELSE operations_commerce_sync_cursors.records_held
         END,
         last_error_code = NULL,
         last_started_at = now(),
         updated_at = now()
       WHERE operations_commerce_sync_cursors.reconciliation_status <> 'running'
          OR operations_commerce_sync_cursors.last_started_at
            < now() - interval '${ORDER_RECONCILIATION_LEASE}'
       RETURNING
         organization_id::text,
         integration_account_id::text,
         (SELECT candidate.account_global_id
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS account_global_id,
         (SELECT candidate.provider
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS provider,
         (SELECT candidate.credential_version
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS credential_version,
         (SELECT candidate.continuation_run_global_id
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS continuation_run_global_id,
         last_started_at`,
      [Math.max(1, Math.min(Number(input.limit || 1), 5))],
    )
    return claimed.rows
      .filter((row) => (
        row.account_global_id
        && row.provider
      ))
      .map((row): CommerceOrderReconciliationTarget => ({
        organizationId: row.organization_id,
        integrationAccountId: row.integration_account_id,
        accountGlobalId: row.account_global_id,
        provider: row.provider,
        credentialVersion: Number(row.credential_version),
        startedAt: row.last_started_at.toISOString(),
        continuationRunGlobalId: row.continuation_run_global_id || null,
      }))
  })
}

export async function completeCommerceOrderReconciliationInPostgres(input: {
  target: CommerceOrderReconciliationTarget
  providerRecordsSeen: unknown
  ordersHeld: unknown
  recordsRejected: unknown
  pagesRead: unknown
  hasNextBatch: boolean
}) {
  return withTransaction(async (client) => {
    const providerRecordsSeen = boundedCount(input.providerRecordsSeen)
    const ordersHeld = boundedCount(input.ordersHeld)
    const recordsRejected = boundedCount(input.recordsRejected)
    const pagesRead = boundedCount(input.pagesRead)
    const completed = await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'succeeded',
           records_seen = records_seen + $4::bigint,
           records_applied = records_applied,
           records_held = records_held + $5::bigint,
           consecutive_failures = 0,
           last_error_code = NULL,
           last_completed_at = now(),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
         AND reconciliation_status = 'running'
         -- JavaScript Date values retain milliseconds while Postgres now()
         -- retains microseconds. The active-running lease and narrow time
         -- window together identify this claim without persisting a cursor.
         AND last_started_at >= $3::timestamptz - interval '1 second'
         AND last_started_at <= $3::timestamptz + interval '1 second'
       RETURNING organization_id::text`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        input.target.startedAt,
        providerRecordsSeen,
        ordersHeld + recordsRejected,
      ],
    )
    if (completed.rowCount !== 1) return { leaseLost: true as const }
    await recordAuditEvent({
      actor: 'system',
      eventType: 'commerce.orders.reconciliation.staged',
      aggregateType: 'operations.integration_account',
      aggregateId: input.target.accountGlobalId,
      organizationId: input.target.organizationId,
      isSystem: true,
      eventKey: `commerce-order-reconciliation:${input.target.accountGlobalId}:${input.target.startedAt}`,
      payload: {
        provider: input.target.provider,
        credentialVersion: input.target.credentialVersion,
        providerRecordsSeen,
        ordersHeld,
        recordsRejected,
        pagesRead,
        hasNextBatch: input.hasNextBatch,
        resumed: Boolean(input.target.continuationRunGlobalId),
        readOnly: true,
        providerWrites: 0,
        canonicalOrderWrites: 0,
        inventoryWrites: 0,
      },
    }, client)
    return { leaseLost: false as const }
  })
}

/**
 * UI-safe state only: no provider cursor, credential, candidate payload, or
 * customer data is returned. A continuation is reported as resumable without
 * exposing its encrypted cursor or run identity.
 */
export async function readCommerceOrderReconciliationStateInPostgres(input: {
  organizationId: string
  accountGlobalId: string
}) {
  return withTransaction(async (client) => {
    const result = await client.query<{
      status: 'idle' | 'running' | 'succeeded' | 'failed' | null
      records_seen: string | number | null
      records_held: string | number | null
      consecutive_failures: number | null
      last_error_code: string | null
      last_started_at: Date | null
      last_completed_at: Date | null
      resumable: boolean
    }>(
      `SELECT
         cursor.reconciliation_status AS status,
         cursor.records_seen,
         cursor.records_held,
         cursor.consecutive_failures,
         cursor.last_error_code,
         cursor.last_started_at,
         cursor.last_completed_at,
         EXISTS (
           SELECT 1
           FROM operations_commerce_intake_continuations continuation
           WHERE continuation.organization_id = account.organization_id
             AND continuation.integration_account_id = account.id
             AND continuation.provider = account.provider
             AND continuation.resource = 'orders'
             AND continuation.credential_version
               = account.commerce_credential_generation
             AND continuation.cursor_state = 'available'
             AND EXISTS (
               SELECT 1
               FROM operations_commerce_intake_runs run
               WHERE run.organization_id = continuation.organization_id
                 AND run.integration_account_id = continuation.integration_account_id
                 AND run.id = continuation.run_id
                 AND run.created_by = 'system:commerce-order-reconciliation'
             )
         ) AS resumable
       FROM operations_integration_accounts account
       LEFT JOIN operations_commerce_sync_cursors cursor
         ON cursor.organization_id = account.organization_id
        AND cursor.integration_account_id = account.id
        AND cursor.resource = 'orders'
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND account.integration_type = 'commerce'
       LIMIT 1`,
      [input.organizationId, input.accountGlobalId],
    )
    const row = result.rows[0]
    if (!row) return null
    return {
      status: row.status || 'idle',
      recordsSeen: boundedCount(row.records_seen),
      recordsHeld: boundedCount(row.records_held),
      consecutiveFailures: boundedCount(row.consecutive_failures),
      lastErrorCode: row.last_error_code,
      lastStartedAt: row.last_started_at?.toISOString() || null,
      lastCompletedAt: row.last_completed_at?.toISOString() || null,
      resumable: row.resumable,
      providerWrites: 0,
      canonicalOrderWrites: 0,
      inventoryWrites: 0,
    }
  })
}

export async function failCommerceOrderReconciliationInPostgres(input: {
  target: CommerceOrderReconciliationTarget
  error: unknown
}) {
  const errorCode = safeErrorCode(input.error)
  return withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'failed',
           consecutive_failures = consecutive_failures + 1,
           last_error_code = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
         AND reconciliation_status = 'running'
         AND last_started_at >= $3::timestamptz - interval '1 second'
         AND last_started_at <= $3::timestamptz + interval '1 second'
       RETURNING organization_id::text`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        input.target.startedAt,
        errorCode,
      ],
    )
    return { leaseLost: failed.rowCount !== 1, errorCode }
  })
}
