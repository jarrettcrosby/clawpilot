import { createHash, randomUUID } from 'node:crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import { CommerceIntegrationRequestError } from '@/lib/integrations/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const ORDER_RECONCILIATION_INTERVAL = '30 minutes'
const ORDER_RECONCILIATION_LEASE = '10 minutes'
const WORKER_HEARTBEAT_KEY = 'commerce_order_reconciliation_worker_heartbeat'
export const FAIRE_AUTO_PROMOTION_ATTENTION_CODE =
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'

const ORDER_RECONCILIATION_TERMINAL_FAILURE_CODES = [
  'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
  'COMMERCE_ORDER_RECONCILIATION_SESSION_PAGE_BUDGET_EXCEEDED',
  'COMMERCE_ORDER_RECONCILIATION_PAGE_RECORD_LIMIT_EXCEEDED',
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_MISSING',
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
  'COMMERCE_ORDER_RECONCILIATION_WRITE_FENCE',
  'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED',
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_INVALID',
] as const

const ORDER_RECONCILIATION_INVALID_CONTINUATION_CODES = new Set<string>([
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_MISSING',
  'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
  'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_INVALID',
])

const ORDER_RECONCILIATION_TERMINAL_FAILURE_SET = new Set<string>(
  ORDER_RECONCILIATION_TERMINAL_FAILURE_CODES,
)

const ORDER_RECONCILIATION_TERMINAL_FAILURE_SQL = `(
  ${ORDER_RECONCILIATION_TERMINAL_FAILURE_CODES
    .map((code) => `'${code}'`)
    .join(',\n  ')}
)`

function configuredInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback
}

const ORDER_RECONCILIATION_MAX_SESSION_FAILURES = configuredInteger(
  'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_FAILURES',
  8,
  2,
  20,
)

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
  recordsSeen: number
  recordsHeld: number
  continuationBatchNumber: number | null
  continuationRunGlobalId: string | null
  continuationIdempotencyKey: string | null
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

export async function recordCommerceOrderReconciliationWorkerHeartbeatInPostgres(
  details: Record<string, unknown>,
) {
  const payload = {
    checkedAt: new Date().toISOString(),
    workerId: String(
      process.env.RAILWAY_REPLICA_ID
      || process.env.HOSTNAME
      || randomUUID(),
    ).slice(0, 200),
    resource: 'orders',
    ...details,
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(payload)],
  )
  return payload
}

export async function readCommerceOrderReconciliationWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}

export async function readCommerceOrderReconciliationHealthFromPostgres() {
  const result = await query<{
    eligible_accounts: string
    shopify_accounts: string
    faire_accounts: string
    never_run: string
    running: string
    failed: string
    stale_processing: string
    promotion_attention_required: string
    overdue: string
    resumable: string
    last_success_at: Date | string | null
  }>(
    `WITH eligible AS (
       SELECT account.organization_id, account.id AS integration_account_id,
              account.provider
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
         AND account.status <> 'error'
         AND account.commerce_credential_generation > 0
         AND credential.credential_version =
             account.commerce_credential_generation
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
         AND ${ORDER_READABLE_CONNECTION_SQL}
     ),
     state AS (
       SELECT eligible.*, cursor.reconciliation_status,
              cursor.last_error_code,
              cursor.last_started_at, cursor.last_completed_at
       FROM eligible
       LEFT JOIN operations_commerce_sync_cursors cursor
         ON cursor.organization_id = eligible.organization_id
        AND cursor.integration_account_id = eligible.integration_account_id
        AND cursor.resource = 'orders'
     )
     SELECT
       count(*)::text AS eligible_accounts,
       count(*) FILTER (WHERE provider = 'shopify')::text AS shopify_accounts,
       count(*) FILTER (WHERE provider = 'faire')::text AS faire_accounts,
       count(*) FILTER (WHERE last_started_at IS NULL)::text AS never_run,
       count(*) FILTER (WHERE reconciliation_status = 'running')::text AS running,
       count(*) FILTER (WHERE reconciliation_status = 'failed')::text AS failed,
       count(*) FILTER (
         WHERE last_error_code = '${FAIRE_AUTO_PROMOTION_ATTENTION_CODE}'
       )::text AS promotion_attention_required,
       count(*) FILTER (
         WHERE reconciliation_status = 'running'
           AND last_started_at < now() - interval '${ORDER_RECONCILIATION_LEASE}'
       )::text AS stale_processing,
       count(*) FILTER (
         WHERE last_started_at IS NULL
            OR last_started_at < now() - interval '${ORDER_RECONCILIATION_INTERVAL}'
       )::text AS overdue,
       (
         SELECT count(*)
         FROM operations_commerce_intake_continuations continuation
         JOIN eligible target
           ON target.organization_id = continuation.organization_id
          AND target.integration_account_id = continuation.integration_account_id
         WHERE continuation.resource = 'orders'
           AND continuation.cursor_state = 'available'
       )::text AS resumable,
       max(last_completed_at) AS last_success_at
     FROM state`,
  )
  const row = result.rows[0]
  return {
    eligibleAccounts: Number(row?.eligible_accounts || 0),
    providerAccounts: {
      shopify: Number(row?.shopify_accounts || 0),
      faire: Number(row?.faire_accounts || 0),
    },
    neverRun: Number(row?.never_run || 0),
    running: Number(row?.running || 0),
    failed: Number(row?.failed || 0),
    promotionAttentionRequired: Number(
      row?.promotion_attention_required || 0,
    ),
    staleProcessing: Number(row?.stale_processing || 0),
    overdue: Number(row?.overdue || 0),
    resumable: Number(row?.resumable || 0),
    lastSuccessAt: row?.last_success_at
      ? new Date(row.last_success_at).toISOString()
      : null,
    resource: 'orders',
  }
}

/**
 * Claims only connections whose existing integration authorization already
 * covers an order read. The claim is a local lease; provider cursors are never
 * persisted here. Fresh, unambiguous Faire candidates may be promoted locally,
 * while all provider/customer ambiguity remains held. The existing encrypted
 * continuation is referenced by run ID, never read or copied here.
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
      continuation_idempotency_key: string | null
      continuation_batch_number: number | null
      last_started_at: Date
      records_seen: string | number
      records_held: string | number
    }>(
      `WITH candidates AS (
         SELECT
           account.organization_id,
           account.id AS integration_account_id,
           account.global_id AS account_global_id,
           account.provider,
           account.commerce_credential_generation AS credential_version,
           continuation.run_global_id AS continuation_run_global_id,
           continuation.idempotency_key AS continuation_idempotency_key,
           continuation.batch_number AS continuation_batch_number,
           COALESCE(continuation.records_seen, 0)::bigint
             AS durable_records_seen,
           COALESCE(continuation.records_held, 0)::bigint
             AS durable_records_held
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
           SELECT run.global_id AS run_global_id,
                  active_intent.idempotency_key,
                  continuation.batch_number,
                  (
                    SELECT COALESCE(sum(session.provider_rows_seen), 0)
                    FROM operations_commerce_intake_continuations session
                    WHERE session.organization_id
                          = continuation.organization_id
                      AND session.integration_account_id
                          = continuation.integration_account_id
                      AND session.resource = 'orders'
                      AND session.session_id = continuation.session_id
                  ) AS records_seen,
                  (
                    SELECT count(*)
                    FROM operations_commerce_order_candidates candidate
                    JOIN operations_commerce_intake_continuations session
                      ON session.organization_id = candidate.organization_id
                     AND session.integration_account_id
                         = candidate.integration_account_id
                     AND session.run_id = candidate.run_id
                     AND session.resource = 'orders'
                    WHERE session.organization_id
                          = continuation.organization_id
                      AND session.integration_account_id
                          = continuation.integration_account_id
                      AND session.session_id = continuation.session_id
                  ) + (
                    SELECT count(*)
                    FROM operations_commerce_intake_rejections rejection
                    JOIN operations_commerce_intake_continuations session
                      ON session.organization_id = rejection.organization_id
                     AND session.integration_account_id
                         = rejection.integration_account_id
                     AND session.run_id = rejection.run_id
                     AND session.resource = 'orders'
                    WHERE session.organization_id
                          = continuation.organization_id
                      AND session.integration_account_id
                          = continuation.integration_account_id
                      AND session.session_id = continuation.session_id
                      AND rejection.resource_type = 'order'
                  ) AS records_held
           FROM operations_commerce_intake_continuations continuation
           JOIN operations_commerce_intake_runs run
             ON run.organization_id = continuation.organization_id
            AND run.integration_account_id = continuation.integration_account_id
            AND run.id = continuation.run_id
           LEFT JOIN operations_commerce_intake_read_intents active_intent
             ON active_intent.organization_id = continuation.organization_id
            AND active_intent.integration_account_id
                = continuation.integration_account_id
            AND active_intent.continuation_id = continuation.id
            AND active_intent.intent_state
                IN ('prepared', 'reading', 'captured')
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
           AND NOT COALESCE((
             cursor.reconciliation_status = 'failed'
             AND cursor.last_error_code IN
               ${ORDER_RECONCILIATION_TERMINAL_FAILURE_SQL}
           ), false)
           AND (
             cursor.integration_account_id IS NULL
             OR cursor.reconciliation_status <> 'running'
             OR cursor.last_started_at < now()
               - interval '${ORDER_RECONCILIATION_LEASE}'
           )
           AND (
             cursor.reconciliation_status IS DISTINCT FROM 'failed'
             OR cursor.last_started_at < now()
               - interval '${ORDER_RECONCILIATION_INTERVAL}'
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
         durable_records_seen, 0, durable_records_held, 0, NULL,
         date_trunc('milliseconds', clock_timestamp()), now()
       FROM candidates
       ON CONFLICT (organization_id, integration_account_id, resource)
       DO UPDATE SET
         reconciliation_status = 'running',
         records_seen = (
           SELECT candidate.durable_records_seen
           FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1
         ),
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
         records_held = (
           SELECT candidate.durable_records_held
           FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1
         ),
         last_error_code = CASE
           WHEN (
             SELECT candidate.continuation_run_global_id
             FROM candidates candidate
             WHERE candidate.organization_id
                   = operations_commerce_sync_cursors.organization_id
               AND candidate.integration_account_id
                   = operations_commerce_sync_cursors.integration_account_id
             LIMIT 1
           ) IS NULL THEN NULL
           ELSE operations_commerce_sync_cursors.last_error_code
         END,
         last_started_at = date_trunc('milliseconds', clock_timestamp()),
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
         (SELECT candidate.continuation_idempotency_key
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS continuation_idempotency_key,
         (SELECT candidate.continuation_batch_number
            FROM candidates candidate
           WHERE candidate.organization_id
                 = operations_commerce_sync_cursors.organization_id
             AND candidate.integration_account_id
                 = operations_commerce_sync_cursors.integration_account_id
           LIMIT 1) AS continuation_batch_number,
         last_started_at,
         records_seen,
         records_held`,
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
        recordsSeen: boundedCount(row.records_seen),
        recordsHeld: boundedCount(row.records_held),
        continuationBatchNumber: row.continuation_batch_number === null
          ? null
          : boundedCount(row.continuation_batch_number),
        continuationRunGlobalId: row.continuation_run_global_id || null,
        continuationIdempotencyKey:
          row.continuation_idempotency_key || null,
      }))
  })
}

/**
 * Projects the immutable staged-page lineage onto the worker cursor while
 * extending only the exact live lease. This is intentionally an absolute
 * projection, not an increment: if a process dies after staging a page, the
 * next claim reconstructs the same totals from continuation/run evidence.
 */
export async function projectCommerceOrderReconciliationPageInPostgres(input: {
  target: CommerceOrderReconciliationTarget
  runGlobalId: string
}) {
  const projected = await query<{
    last_started_at: Date
    records_seen: string | number
    records_held: string | number
    batch_number: number
    provider_cursor_repeated: boolean
  }>(
    `WITH staged AS (
       SELECT continuation.session_id, continuation.batch_number,
              continuation.cursor_hash
       FROM operations_commerce_intake_continuations continuation
       JOIN operations_commerce_intake_runs run
         ON run.organization_id = continuation.organization_id
        AND run.integration_account_id = continuation.integration_account_id
        AND run.pipeline_id = continuation.pipeline_id
        AND run.id = continuation.run_id
       WHERE continuation.organization_id = $1::uuid
         AND continuation.integration_account_id = $2::uuid
         AND continuation.resource = 'orders'
         AND continuation.provider = $5
         AND continuation.credential_version = $6::integer
         AND run.global_id = $4
         AND run.created_by = 'system:commerce-order-reconciliation'
       LIMIT 1
     ), totals AS (
       SELECT
         staged.batch_number,
         (
           SELECT COALESCE(sum(session.provider_rows_seen), 0)
           FROM operations_commerce_intake_continuations session
           WHERE session.organization_id = $1::uuid
             AND session.integration_account_id = $2::uuid
             AND session.resource = 'orders'
             AND session.session_id = staged.session_id
         )::bigint AS records_seen,
         (
           SELECT count(*)
           FROM operations_commerce_order_candidates candidate
           JOIN operations_commerce_intake_continuations session
             ON session.organization_id = candidate.organization_id
            AND session.integration_account_id
                = candidate.integration_account_id
            AND session.run_id = candidate.run_id
            AND session.resource = 'orders'
           WHERE session.organization_id = $1::uuid
             AND session.integration_account_id = $2::uuid
             AND session.session_id = staged.session_id
         ) + (
           SELECT count(*)
           FROM operations_commerce_intake_rejections rejection
           JOIN operations_commerce_intake_continuations session
             ON session.organization_id = rejection.organization_id
            AND session.integration_account_id
                = rejection.integration_account_id
            AND session.run_id = rejection.run_id
            AND session.resource = 'orders'
           WHERE session.organization_id = $1::uuid
             AND session.integration_account_id = $2::uuid
             AND session.session_id = staged.session_id
             AND rejection.resource_type = 'order'
         ) AS records_held,
         (
           staged.cursor_hash IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM operations_commerce_intake_read_intents prior_intent
             WHERE prior_intent.organization_id = $1::uuid
               AND prior_intent.integration_account_id = $2::uuid
               AND prior_intent.resource = 'orders'
               AND prior_intent.session_id = staged.session_id
               AND prior_intent.target_kind = 'continuation'
               AND prior_intent.continuation_cursor_hash
                   = staged.cursor_hash
           )
         ) AS provider_cursor_repeated
       FROM staged
     )
     UPDATE operations_commerce_sync_cursors cursor
     SET last_started_at = GREATEST(
           date_trunc('milliseconds', clock_timestamp()),
           cursor.last_started_at + interval '1 millisecond'
         ),
         records_seen = totals.records_seen,
         records_held = totals.records_held,
         updated_at = now()
     FROM totals
     WHERE cursor.organization_id = $1::uuid
       AND cursor.integration_account_id = $2::uuid
       AND cursor.resource = 'orders'
       AND cursor.reconciliation_status = 'running'
       AND cursor.last_started_at = $3::timestamptz
       AND cursor.last_started_at > clock_timestamp()
         - interval '${ORDER_RECONCILIATION_LEASE}'
     RETURNING cursor.last_started_at, cursor.records_seen,
               cursor.records_held, totals.batch_number,
               totals.provider_cursor_repeated`,
    [
      input.target.organizationId,
      input.target.integrationAccountId,
      input.target.startedAt,
      input.runGlobalId,
      input.target.provider,
      input.target.credentialVersion,
    ],
  )
  const row = projected.rows[0]
  return row
    ? {
        leaseLost: false as const,
        startedAt: row.last_started_at.toISOString(),
        recordsSeen: boundedCount(row.records_seen),
        recordsHeld: boundedCount(row.records_held),
        continuationBatchNumber: boundedCount(row.batch_number),
        providerCursorRepeated: row.provider_cursor_repeated,
      }
    : {
        leaseLost: true as const,
        startedAt: null,
        recordsSeen: null,
        recordsHeld: null,
        continuationBatchNumber: null,
        providerCursorRepeated: false,
      }
}

export async function completeCommerceOrderReconciliationInPostgres(input: {
  target: CommerceOrderReconciliationTarget
  providerRecordsSeen: unknown
  ordersHeld: unknown
  recordsRejected: unknown
  pagesRead: unknown
  hasNextBatch: boolean
  customersMatched: unknown
  customersCreated: unknown
  customersAmbiguous: unknown
  customersSkipped: unknown
  customerResolutionFailed: unknown
  customerResolutionFailureCodes: Record<string, number>
  faireOrdersPromoted: unknown
  faireOrdersHeld: unknown
  fairePromotionFailed: unknown
  fairePromotionFailureCodes: Record<string, number>
}) {
  return withTransaction(async (client) => {
    const providerRecordsSeen = boundedCount(input.providerRecordsSeen)
    const ordersHeld = boundedCount(input.ordersHeld)
    const recordsRejected = boundedCount(input.recordsRejected)
    const pagesRead = boundedCount(input.pagesRead)
    const customersMatched = boundedCount(input.customersMatched)
    const customersCreated = boundedCount(input.customersCreated)
    const customersAmbiguous = boundedCount(input.customersAmbiguous)
    const customersSkipped = boundedCount(input.customersSkipped)
    const customerResolutionFailed = boundedCount(
      input.customerResolutionFailed,
    )
    const faireOrdersPromoted = boundedCount(input.faireOrdersPromoted)
    const faireOrdersHeld = boundedCount(input.faireOrdersHeld)
    const fairePromotionFailed = boundedCount(input.fairePromotionFailed)
    const customerResolutionFailureCodes = Object.fromEntries(
      Object.entries(input.customerResolutionFailureCodes)
        .filter(([code]) => /^[A-Z][A-Z0-9_]{2,127}$/u.test(code))
        .map(([code, value]) => [code, boundedCount(value)]),
    )
    const fairePromotionFailureCodes = Object.fromEntries(
      Object.entries(input.fairePromotionFailureCodes)
        .filter(([code]) => /^[A-Z][A-Z0-9_]{2,127}$/u.test(code))
        .map(([code, value]) => [code, boundedCount(value)]),
    )
    const completed = await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'succeeded',
           records_applied = records_applied + $5::bigint,
           consecutive_failures = CASE
             WHEN $4::boolean THEN consecutive_failures
             ELSE 0
           END,
           last_error_code = CASE
             WHEN $6::bigint > 0
               THEN '${FAIRE_AUTO_PROMOTION_ATTENTION_CODE}'
             WHEN $7::boolean
               AND last_error_code = '${FAIRE_AUTO_PROMOTION_ATTENTION_CODE}'
               THEN last_error_code
             ELSE NULL
           END,
           last_completed_at = now(),
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
         AND reconciliation_status = 'running'
         AND last_started_at = $3::timestamptz
       RETURNING organization_id::text`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        input.target.startedAt,
        input.hasNextBatch,
        faireOrdersPromoted,
        fairePromotionFailed,
        Boolean(input.target.continuationRunGlobalId),
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
        automaticCustomerResolution: {
          matched: customersMatched,
          created: customersCreated,
          ambiguous: customersAmbiguous,
          skipped: customersSkipped,
          failed: customerResolutionFailed,
          failedByCode: customerResolutionFailureCodes,
          operatorReviewRequired:
            customersAmbiguous + customersSkipped + customerResolutionFailed,
        },
        automaticFaireOrderPromotion: {
          promoted: faireOrdersPromoted,
          held: faireOrdersHeld,
          failed: fairePromotionFailed,
          failedByCode: fairePromotionFailureCodes,
          operatorReviewRequired: faireOrdersHeld + fairePromotionFailed,
        },
        resumed: Boolean(input.target.continuationRunGlobalId),
        providerReadOnly: true,
        providerWrites: 0,
        canonicalOrderWrites: faireOrdersPromoted,
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
      records_applied: string | number | null
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
         cursor.records_applied,
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
      recordsHeld: Math.max(
        boundedCount(row.records_held) - boundedCount(row.records_applied),
        0,
      ),
      consecutiveFailures: boundedCount(row.consecutive_failures),
      lastErrorCode: row.last_error_code,
      automaticPromotionAttentionRequired:
        row.last_error_code === FAIRE_AUTO_PROMOTION_ATTENTION_CODE,
      lastStartedAt: row.last_started_at?.toISOString() || null,
      lastCompletedAt: row.last_completed_at?.toISOString() || null,
      resumable: row.resumable,
      resetRequired: (
        row.status === 'failed'
        && Boolean(row.last_error_code)
        && ORDER_RECONCILIATION_TERMINAL_FAILURE_SET.has(
          row.last_error_code as string,
        )
      ),
      providerWrites: 0,
      canonicalOrderWrites: boundedCount(row.records_applied),
      inventoryWrites: 0,
    }
  })
}

function orderResetError(code: string, message: string, status = 409): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function orderResetRequestHash(value: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function resetCommerceOrderReconciliationInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  actorEmail: string
  idempotencyKey: string
  expectedLastErrorCode: string
  expectedLastStartedAt: string
  reason: string
  confirmReset: boolean
}) {
  const reason = String(input.reason || '').trim()
  if (input.confirmReset !== true) {
    orderResetError(
      'COMMERCE_ORDER_RECONCILIATION_RESET_CONFIRMATION_REQUIRED',
      'Confirm that the terminal order session will be retired before restarting',
      400,
    )
  }
  if (
    reason.length < 10
    || reason.length > 500
    || /[\u0000-\u001f\u007f]/u.test(reason)
  ) {
    orderResetError(
      'COMMERCE_ORDER_RECONCILIATION_RESET_REASON_REQUIRED',
      'An order reconciliation reset reason of at least 10 characters is required',
      400,
    )
  }
  if (
    !/^[A-Z][A-Z0-9_]{2,127}$/u.test(input.expectedLastErrorCode)
    || !ORDER_RECONCILIATION_TERMINAL_FAILURE_SET.has(
      input.expectedLastErrorCode,
    )
  ) {
    orderResetError(
      'COMMERCE_ORDER_RECONCILIATION_RESET_NOT_REQUIRED',
      'The selected order reconciliation failure does not require a manual restart',
    )
  }
  const expectedStartedAt = new Date(input.expectedLastStartedAt)
  if (Number.isNaN(expectedStartedAt.getTime())) {
    orderResetError(
      'COMMERCE_ORDER_RECONCILIATION_RESET_STATE_INVALID',
      'Reload the order reconciliation state before restarting it',
      400,
    )
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(input.idempotencyKey)
  ) {
    orderResetError(
      'COMMERCE_INTAKE_IDEMPOTENCY_REQUIRED',
      'A UUID idempotency key is required',
      400,
    )
  }
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-reset:${input.organizationId}:${input.idempotencyKey}`,
    )
    const account = (
      await client.query<{
        id: string
        global_id: string
        provider: 'shopify' | 'faire'
        credential_version: number
      }>(
        `SELECT account.id::text, account.global_id, account.provider,
                account.commerce_credential_generation
                  AS credential_version
         FROM operations_integration_accounts account
         WHERE account.organization_id = $1::uuid
           AND account.global_id = $2
           AND account.integration_type = 'commerce'
           AND account.provider IN ('shopify', 'faire')
         LIMIT 1
         FOR UPDATE OF account`,
        [input.organizationId, input.accountGlobalId],
      )
    ).rows[0]
    if (!account) {
      orderResetError(
        'COMMERCE_INTAKE_ACCOUNT_REQUIRED',
        'The selected commerce connection is unavailable',
        404,
      )
    }

    const requestHash = orderResetRequestHash({
      action: 'reset-order-reconciliation',
      accountGlobalId: account.global_id,
      expectedLastErrorCode: input.expectedLastErrorCode,
      expectedLastStartedAt: expectedStartedAt.toISOString(),
      reason,
      confirmReset: true,
    })
    const receipt = (
      await client.query<{
        id: string
        request_hash: string
        status: 'processing' | 'succeeded' | 'failed'
        result_payload: Record<string, unknown> | null
      }>(
        `SELECT id::text, request_hash, status, result_payload
         FROM operations_command_receipts
         WHERE organization_id = $1::uuid
           AND command_type = 'commerce.orders.reconciliation.reset'
           AND idempotency_key = $2
         FOR UPDATE`,
        [input.organizationId, input.idempotencyKey],
      )
    ).rows[0]
    if (receipt && receipt.request_hash !== requestHash) {
      orderResetError(
        'COMMERCE_INTAKE_IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different command',
      )
    }
    if (receipt?.status === 'succeeded' && receipt.result_payload) {
      return { ...receipt.result_payload, replayed: true }
    }
    let receiptId: string
    if (receipt) {
      receiptId = receipt.id
      await client.query(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [receipt.id, input.actorEmail],
      )
    } else {
      receiptId = (
        await client.query<{ id: string }>(
          `INSERT INTO operations_command_receipts (
             organization_id, command_type, idempotency_key, request_hash,
             actor_email, status, correlation_id
           ) VALUES (
             $1::uuid, 'commerce.orders.reconciliation.reset', $2, $3,
             $4, 'processing', $5::uuid
           )
           RETURNING id::text`,
          [
            input.organizationId,
            input.idempotencyKey,
            requestHash,
            input.actorEmail,
            randomUUID(),
          ],
        )
      ).rows[0].id
    }

    const cursor = (
      await client.query<{
        reconciliation_status: 'idle' | 'running' | 'succeeded' | 'failed'
        last_error_code: string | null
        last_started_at: Date | null
        consecutive_failures: number
        records_seen: string | number
        records_held: string | number
      }>(
        `SELECT reconciliation_status, last_error_code, last_started_at,
                consecutive_failures, records_seen, records_held
         FROM operations_commerce_sync_cursors
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND resource = 'orders'
         FOR UPDATE`,
        [input.organizationId, account.id],
      )
    ).rows[0]
    if (
      !cursor
      || cursor.reconciliation_status !== 'failed'
      || cursor.last_error_code !== input.expectedLastErrorCode
      || !cursor.last_started_at
      || cursor.last_started_at.toISOString()
        !== expectedStartedAt.toISOString()
    ) {
      orderResetError(
        'COMMERCE_ORDER_RECONCILIATION_RESET_STATE_CONFLICT',
        'The order reconciliation state changed. Reload before restarting it.',
      )
    }

    const superseded = await client.query(
      `UPDATE operations_commerce_intake_continuations continuation
       SET cursor_state = 'superseded',
           cursor_ciphertext = NULL,
           cursor_iv = NULL,
           cursor_tag = NULL,
           cursor_hash = NULL,
           encryption_version = NULL,
           row_version = continuation.row_version + 1,
           updated_by = $5,
           updated_at = now()
       FROM operations_commerce_intake_runs run
       WHERE continuation.organization_id = $1::uuid
         AND continuation.integration_account_id = $2::uuid
         AND continuation.provider = $3
         AND continuation.resource = 'orders'
         AND continuation.credential_version = $4::integer
         AND continuation.cursor_state = 'available'
         AND run.organization_id = continuation.organization_id
         AND run.integration_account_id
             = continuation.integration_account_id
         AND run.pipeline_id = continuation.pipeline_id
         AND run.id = continuation.run_id
         AND run.created_by = 'system:commerce-order-reconciliation'`,
      [
        input.organizationId,
        account.id,
        account.provider,
        account.credential_version,
        input.actorEmail,
      ],
    )
    const reset = await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'idle',
           records_seen = 0,
           records_applied = 0,
           records_held = 0,
           consecutive_failures = 0,
           last_error_code = NULL,
           last_started_at = NULL,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
         AND reconciliation_status = 'failed'
         AND last_error_code = $3
         AND last_started_at = $4::timestamptz`,
      [
        input.organizationId,
        account.id,
        input.expectedLastErrorCode,
        expectedStartedAt.toISOString(),
      ],
    )
    if (reset.rowCount !== 1) {
      orderResetError(
        'COMMERCE_ORDER_RECONCILIATION_RESET_STATE_CONFLICT',
        'The order reconciliation state changed. Reload before restarting it.',
      )
    }
    const result = {
      action: 'reset-order-reconciliation',
      accountGlobalId: account.global_id,
      previousErrorCode: input.expectedLastErrorCode,
      previousConsecutiveFailures: boundedCount(cursor.consecutive_failures),
      previousRecordsSeen: boundedCount(cursor.records_seen),
      previousRecordsHeld: boundedCount(cursor.records_held),
      continuationsSuperseded: superseded.rowCount || 0,
      status: 'idle',
      freshRootSession: true,
      providerWrites: 0,
      canonicalOrderWrites: 0,
      inventoryWrites: 0,
      replayed: false,
    }
    await client.query(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_global_id = $2,
           result_payload = $3::jsonb, error_code = NULL,
           error_message = NULL, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [receiptId, account.global_id, JSON.stringify(result)],
    )
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.orders.reconciliation.reset',
      aggregateType: 'operations.integration_account',
      aggregateId: account.global_id,
      organizationId: input.organizationId,
      eventKey:
        `commerce-order-reconciliation-reset:${account.global_id}:${input.idempotencyKey}`,
      payload: {
        provider: account.provider,
        credentialVersion: account.credential_version,
        previousErrorCode: input.expectedLastErrorCode,
        previousConsecutiveFailures: boundedCount(
          cursor.consecutive_failures,
        ),
        previousRecordsSeen: boundedCount(cursor.records_seen),
        previousRecordsHeld: boundedCount(cursor.records_held),
        reason,
        continuationsSuperseded: superseded.rowCount || 0,
        freshRootSession: true,
        providerWrites: 0,
        canonicalOrderWrites: 0,
        inventoryWrites: 0,
      },
    }, client)
    return result
  })
}

export async function failCommerceOrderReconciliationInPostgres(input: {
  target: CommerceOrderReconciliationTarget
  error: unknown
}) {
  const requestedErrorCode = safeErrorCode(input.error)
  return withTransaction(async (client) => {
    const failed = await client.query<{
      consecutive_failures: number
      last_error_code: string
    }>(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'failed',
           consecutive_failures = consecutive_failures + 1,
           last_error_code = CASE
             WHEN $4 IN ${ORDER_RECONCILIATION_TERMINAL_FAILURE_SQL}
               THEN $4
             WHEN consecutive_failures + 1 >= $5::integer
               THEN 'COMMERCE_ORDER_RECONCILIATION_RETRY_LIMIT_EXCEEDED'
             ELSE $4
           END,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'orders'
         AND reconciliation_status = 'running'
         AND last_started_at = $3::timestamptz
       RETURNING consecutive_failures, last_error_code`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        input.target.startedAt,
        requestedErrorCode,
        ORDER_RECONCILIATION_MAX_SESSION_FAILURES,
      ],
    )
    const row = failed.rows[0]
    if (!row) {
      return {
        leaseLost: true as const,
        errorCode: requestedErrorCode,
        consecutiveFailures: null,
        terminal: false,
      }
    }
    const errorCode = row.last_error_code
    const terminal = ORDER_RECONCILIATION_TERMINAL_FAILURE_SET.has(errorCode)
    let continuationTransition: 'invalid' | 'superseded' | null = null
    let continuationsRetired = 0
    if (terminal) {
      continuationTransition = (
        ORDER_RECONCILIATION_INVALID_CONTINUATION_CODES.has(
          requestedErrorCode,
        )
          ? 'invalid'
          : 'superseded'
      )
      const retired = await client.query<{
        id: string
        session_id: string
        batch_number: number
      }>(
        `UPDATE operations_commerce_intake_continuations continuation
         SET cursor_state = $5,
             cursor_ciphertext = NULL,
             cursor_iv = NULL,
             cursor_tag = NULL,
             cursor_hash = NULL,
             encryption_version = NULL,
             row_version = continuation.row_version + 1,
             updated_by = 'system:commerce-order-reconciliation',
             updated_at = now()
         FROM operations_commerce_intake_runs run
         WHERE continuation.organization_id = $1::uuid
           AND continuation.integration_account_id = $2::uuid
           AND continuation.provider = $4
           AND continuation.resource = 'orders'
           AND continuation.credential_version = $3::integer
           AND continuation.cursor_state = 'available'
           AND run.organization_id = continuation.organization_id
           AND run.integration_account_id
               = continuation.integration_account_id
           AND run.pipeline_id = continuation.pipeline_id
           AND run.id = continuation.run_id
           AND run.created_by = 'system:commerce-order-reconciliation'
         RETURNING continuation.id::text,
                   continuation.session_id::text,
                   continuation.batch_number`,
        [
          input.target.organizationId,
          input.target.integrationAccountId,
          input.target.credentialVersion,
          input.target.provider,
          continuationTransition,
        ],
      )
      continuationsRetired = retired.rowCount || 0
      await recordAuditEvent({
        actor: 'system',
        eventType: 'commerce.orders.reconciliation.terminal',
        aggregateType: 'operations.integration_account',
        aggregateId: input.target.accountGlobalId,
        organizationId: input.target.organizationId,
        isSystem: true,
        eventKey:
          `commerce-order-reconciliation-terminal:${input.target.accountGlobalId}:${input.target.startedAt}`,
        payload: {
          provider: input.target.provider,
          credentialVersion: input.target.credentialVersion,
          requestedErrorCode,
          errorCode,
          consecutiveFailures: Number(row.consecutive_failures),
          maxSessionFailures: ORDER_RECONCILIATION_MAX_SESSION_FAILURES,
          continuationTransition,
          continuationsRetired,
          operatorResetRequired: true,
          readOnly: true,
          providerWrites: 0,
          canonicalOrderWrites: 0,
          inventoryWrites: 0,
        },
      }, client)
    }
    return {
      leaseLost: false as const,
      errorCode,
      consecutiveFailures: Number(row.consecutive_failures),
      terminal,
      continuationTransition,
      continuationsRetired,
    }
  })
}
