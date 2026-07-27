import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { query, withTransaction } from '@/lib/persistence/postgres'

const CATALOG_SYNC_POLICY_VERSION = 'commerce-product-intake-policy-v1'
const CATALOG_RECONCILIATION_INTERVAL = '6 hours'
const CATALOG_SYNC_LEASE = '10 minutes'
const WORKER_HEARTBEAT_KEY = 'commerce.catalog.worker.heartbeat'

export type CommerceCatalogSyncJob = {
  id: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  provider: 'shopify' | 'faire'
  credentialVersion: number
  policyRevision: number
  requestedBy: string
  continuationRunGlobalId: string | null
  readGeneration: number
  pageCount: number
  attemptCount: number
  maxAttempts: number
  lockToken: string
}

type CatalogSyncTotals = {
  providerRecordsSeen: number
  productsCreated: number
  productsMapped: number
  productsUnchanged: number
  productsSkipped: number
  productsFailed: number
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
  return 'COMMERCE_CATALOG_SYNC_FAILED'
}

const PERMANENT_ERROR_CODES = new Set([
  'COMMERCE_INTAKE_SCOPE_REQUIRED',
  'COMMERCE_INTAKE_VERIFICATION_REQUIRED',
  'COMMERCE_INTAKE_CONNECTION_ERROR',
  'COMMERCE_INTAKE_ACTIVATION_REQUIRED',
  'SHOPIFY_STORE_IDENTITY_CHANGED',
])

const RESTART_ERROR_CODES = new Set([
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_INVALID',
  'COMMERCE_INTAKE_CONTINUATION_CONSUMED',
  'COMMERCE_INTAKE_CONTINUATION_NOT_FOUND',
])

export async function applyCommerceCatalogSyncPolicyWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    provider: 'shopify' | 'faire'
    credentialVersion: number
    policyRevision: number
    unmatchedAction: 'review' | 'auto_create'
    actorEmail: string
  },
) {
  if (input.unmatchedAction === 'review') {
    const cancelled = await client.query(
      `UPDATE operations_commerce_catalog_sync_jobs
       SET status = CASE
             WHEN status = 'processing' THEN status
             ELSE 'cancelled'
           END,
           cancel_requested = true,
           completed_at = CASE
             WHEN status = 'processing' THEN completed_at
             ELSE now()
           END,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND status IN ('pending', 'processing', 'failed')`,
      [input.organizationId, input.integrationAccountId],
    )
    return { queued: 0, cancelled: cancelled.rowCount || 0 }
  }

  const queued = await client.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by
     )
     SELECT $1::uuid, $2::uuid, $3, $4, $5, $6
     WHERE NOT EXISTS (
       SELECT 1
       FROM operations_commerce_catalog_sync_jobs active
       WHERE active.organization_id = $1::uuid
         AND active.integration_account_id = $2::uuid
         AND active.status IN ('pending', 'processing', 'failed')
     )
     ON CONFLICT (
       organization_id, integration_account_id
     ) WHERE status IN ('pending', 'processing', 'failed')
     DO NOTHING`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.provider,
      input.credentialVersion,
      input.policyRevision,
      input.actorEmail,
    ],
  )
  return { queued: queued.rowCount || 0, cancelled: 0 }
}

export async function queueAutomaticCommerceCatalogSyncsInPostgres() {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE operations_commerce_catalog_sync_jobs job
       SET status = CASE
             WHEN job.status = 'processing' THEN job.status
             ELSE 'cancelled'
           END,
           cancel_requested = true,
           completed_at = CASE
             WHEN job.status = 'processing' THEN job.completed_at
             ELSE now()
           END,
           last_error_code = 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
           updated_at = now()
       WHERE job.status IN ('pending', 'processing', 'failed')
         AND (
           job.cancel_requested = true
           OR NOT EXISTS (
             SELECT 1
             FROM operations_commerce_product_intake_policies policy
             JOIN operations_integration_accounts account
               ON account.organization_id = policy.organization_id
              AND account.id = policy.integration_account_id
             JOIN operations_commerce_credentials credential
               ON credential.organization_id = account.organization_id
              AND credential.integration_account_id = account.id
             JOIN operations_activation_scopes activation
               ON activation.organization_id = account.organization_id
             WHERE policy.organization_id = job.organization_id
               AND policy.integration_account_id = job.integration_account_id
               AND policy.policy_version = $1
               AND policy.unmatched_action = 'auto_create'
               AND policy.revision = job.policy_revision
               AND account.integration_type = 'commerce'
               AND account.provider = job.provider
               AND account.status <> 'error'
               AND account.commerce_credential_generation
                 = job.credential_version
               AND credential.credential_version = job.credential_version
               AND credential.verification_status = 'verified'
               AND activation.state IN ('shadow', 'active')
           )
         )`,
      [CATALOG_SYNC_POLICY_VERSION],
    )

    const queued = await client.query(
      `INSERT INTO operations_commerce_catalog_sync_jobs (
         organization_id, integration_account_id, provider,
         credential_version, policy_revision, requested_by
       )
       SELECT
         account.organization_id,
         account.id,
         account.provider,
         account.commerce_credential_generation,
         policy.revision,
         COALESCE(policy.updated_by, policy.created_by)
       FROM operations_commerce_product_intake_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE policy.policy_version = $1
         AND policy.unmatched_action = 'auto_create'
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
         AND account.status <> 'error'
         AND account.commerce_credential_generation > 0
         AND credential.credential_version
           = account.commerce_credential_generation
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
         AND COALESCE(policy.updated_by, policy.created_by) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_catalog_sync_jobs active
           WHERE active.organization_id = account.organization_id
             AND active.integration_account_id = account.id
             AND active.status IN ('pending', 'processing', 'failed')
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_catalog_sync_jobs recent
           WHERE recent.organization_id = account.organization_id
             AND recent.integration_account_id = account.id
             AND recent.provider = account.provider
             AND recent.credential_version
               = account.commerce_credential_generation
             AND recent.policy_revision = policy.revision
             AND recent.status IN ('succeeded', 'dead')
             AND recent.updated_at >= now() - interval '${CATALOG_RECONCILIATION_INTERVAL}'
         )
       ON CONFLICT (
         organization_id, integration_account_id
       ) WHERE status IN ('pending', 'processing', 'failed')
       DO NOTHING`,
      [CATALOG_SYNC_POLICY_VERSION],
    )
    return queued.rowCount || 0
  })
}

export async function claimCommerceCatalogSyncJobsInPostgres(input: {
  limit: number
  workerId: string
}) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE operations_commerce_catalog_sync_jobs
       SET status = 'failed',
           last_error_code = 'COMMERCE_CATALOG_SYNC_LEASE_EXPIRED',
           available_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           updated_at = now()
       WHERE status = 'processing'
         AND locked_at < now() - interval '${CATALOG_SYNC_LEASE}'`,
    )
    const claimed = await client.query<{
      id: string
      organization_id: string
      integration_account_id: string
      account_global_id: string
      provider: 'shopify' | 'faire'
      credential_version: number
      policy_revision: number
      requested_by: string
      continuation_run_global_id: string | null
      read_generation: number
      page_count: number
      attempt_count: number
      max_attempts: number
      lock_token: string
    }>(
      `WITH candidates AS (
         SELECT job.id
         FROM operations_commerce_catalog_sync_jobs job
         JOIN operations_commerce_product_intake_policies policy
           ON policy.organization_id = job.organization_id
          AND policy.integration_account_id = job.integration_account_id
         JOIN operations_integration_accounts account
           ON account.organization_id = job.organization_id
          AND account.id = job.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = job.organization_id
          AND credential.integration_account_id = job.integration_account_id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = job.organization_id
         WHERE job.status IN ('pending', 'failed')
           AND job.available_at <= now()
           AND job.cancel_requested = false
           AND policy.policy_version = $1
           AND policy.unmatched_action = 'auto_create'
           AND policy.revision = job.policy_revision
           AND account.integration_type = 'commerce'
           AND account.provider = job.provider
           AND account.status <> 'error'
           AND account.commerce_credential_generation
             = job.credential_version
           AND credential.credential_version = job.credential_version
           AND credential.verification_status = 'verified'
           AND activation.state IN ('shadow', 'active')
         ORDER BY job.available_at, job.created_at, job.id
         FOR UPDATE OF job SKIP LOCKED
         LIMIT $2
       )
       UPDATE operations_commerce_catalog_sync_jobs job
       SET status = 'processing',
           attempt_count = job.attempt_count + 1,
           locked_at = now(),
           locked_by = $3,
           lock_token = gen_random_uuid(),
           started_at = COALESCE(job.started_at, now()),
           last_error_code = NULL,
           updated_at = now()
       FROM candidates, operations_integration_accounts account
       WHERE job.id = candidates.id
         AND account.organization_id = job.organization_id
         AND account.id = job.integration_account_id
       RETURNING
         job.id::text,
         job.organization_id::text,
         job.integration_account_id::text,
         account.global_id AS account_global_id,
         job.provider,
         job.credential_version,
         job.policy_revision,
         job.requested_by,
         job.continuation_run_global_id,
         job.read_generation,
         job.page_count,
         job.attempt_count,
         job.max_attempts,
         job.lock_token::text`,
      [
        CATALOG_SYNC_POLICY_VERSION,
        Math.max(1, Math.min(Number(input.limit || 2), 10)),
        input.workerId.slice(0, 200),
      ],
    )
    return claimed.rows.map((row): CommerceCatalogSyncJob => ({
      id: row.id,
      organizationId: row.organization_id,
      integrationAccountId: row.integration_account_id,
      accountGlobalId: row.account_global_id,
      provider: row.provider,
      credentialVersion: row.credential_version,
      policyRevision: row.policy_revision,
      requestedBy: row.requested_by,
      continuationRunGlobalId: row.continuation_run_global_id,
      readGeneration: row.read_generation,
      pageCount: row.page_count,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      lockToken: row.lock_token,
    }))
  })
}

async function currentJobFence(
  client: PoolClient,
  job: CommerceCatalogSyncJob,
) {
  const current = await client.query(
    `SELECT 1
     FROM operations_commerce_catalog_sync_jobs queued
     JOIN operations_commerce_product_intake_policies policy
       ON policy.organization_id = queued.organization_id
      AND policy.integration_account_id = queued.integration_account_id
     JOIN operations_integration_accounts account
       ON account.organization_id = queued.organization_id
      AND account.id = queued.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = queued.organization_id
      AND credential.integration_account_id = queued.integration_account_id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = queued.organization_id
     WHERE queued.id = $1::uuid
       AND queued.organization_id = $2::uuid
       AND queued.integration_account_id = $3::uuid
       AND queued.status = 'processing'
       AND queued.lock_token = $4::uuid
       AND queued.cancel_requested = false
       AND queued.provider = $5
       AND queued.credential_version = $6
       AND queued.policy_revision = $7
       AND policy.policy_version = $8
       AND policy.unmatched_action = 'auto_create'
       AND policy.revision = queued.policy_revision
       AND account.provider = queued.provider
       AND account.status <> 'error'
       AND account.commerce_credential_generation = queued.credential_version
       AND credential.credential_version = queued.credential_version
       AND credential.verification_status = 'verified'
       AND activation.state IN ('shadow', 'active')
     FOR UPDATE OF queued`,
    [
      job.id,
      job.organizationId,
      job.integrationAccountId,
      job.lockToken,
      job.provider,
      job.credentialVersion,
      job.policyRevision,
      CATALOG_SYNC_POLICY_VERSION,
    ],
  )
  return current.rowCount === 1
}

export async function completeCommerceCatalogSyncPageInPostgres(input: {
  job: CommerceCatalogSyncJob
  continuationRunGlobalId: string | null
  hasNextBatch: boolean
  totals: CatalogSyncTotals
}) {
  return withTransaction(async (client) => {
    const fenced = await currentJobFence(client, input.job)
    if (!fenced) {
      await client.query(
        `UPDATE operations_commerce_catalog_sync_jobs
         SET status = 'cancelled',
             cancel_requested = true,
             completed_at = now(),
             locked_at = NULL,
             locked_by = NULL,
             lock_token = NULL,
             last_error_code = 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
             updated_at = now()
         WHERE id = $1::uuid
           AND status = 'processing'
           AND lock_token = $2::uuid`,
        [input.job.id, input.job.lockToken],
      )
      return { status: 'cancelled' as const }
    }
    const nextPageCount = input.job.pageCount + 1
    const hasNext = (
      input.hasNextBatch
      && Boolean(input.continuationRunGlobalId)
    )
    const status = hasNext ? 'pending' : 'succeeded'
    const completed = await client.query<{
      provider_records_seen: string
      products_created: string
      products_mapped: string
      products_unchanged: string
      products_skipped: string
      products_failed: string
    }>(
      `UPDATE operations_commerce_catalog_sync_jobs
       SET status = $3,
           continuation_run_global_id = $4,
           page_count = $5,
           provider_records_seen =
             provider_records_seen + $6::bigint,
           products_created = products_created + $7::bigint,
           products_mapped = products_mapped + $8::bigint,
           products_unchanged = products_unchanged + $9::bigint,
           products_skipped = products_skipped + $10::bigint,
           products_failed = products_failed + $11::bigint,
           attempt_count = 0,
           available_at = now(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           completed_at = CASE WHEN $3 = 'succeeded' THEN now() ELSE NULL END,
           last_error_code = NULL,
           result_summary = jsonb_build_object(
             'resource', 'products',
             'readOnly', true,
             'providerWrites', 0,
             'ordersTouched', 0,
             'inventoryTouched', 0,
             'hasNextBatch', $12::boolean
           ),
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'
         AND lock_token = $2::uuid
       RETURNING provider_records_seen::text, products_created::text,
                 products_mapped::text, products_unchanged::text,
                 products_skipped::text,
                 products_failed::text`,
      [
        input.job.id,
        input.job.lockToken,
        status,
        hasNext ? input.continuationRunGlobalId : null,
        nextPageCount,
        boundedCount(input.totals.providerRecordsSeen),
        boundedCount(input.totals.productsCreated),
        boundedCount(input.totals.productsMapped),
        boundedCount(input.totals.productsUnchanged),
        boundedCount(input.totals.productsSkipped),
        boundedCount(input.totals.productsFailed),
        hasNext,
      ],
    )
    if (completed.rowCount !== 1) {
      throw new Error('Commerce catalog sync lease was lost')
    }
    const totals = completed.rows[0]
    await client.query(
      `INSERT INTO operations_commerce_sync_cursors (
         organization_id, integration_account_id, resource,
         reconciliation_status, records_seen, records_applied, records_held,
         consecutive_failures, last_error_code, last_started_at,
         last_completed_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'products', $3,
         $4::bigint, $5::bigint, $6::bigint, 0, NULL,
         COALESCE($7::timestamptz, now()),
         CASE WHEN $3 = 'succeeded' THEN now() ELSE NULL END,
         now()
       )
       ON CONFLICT (organization_id, integration_account_id, resource)
       DO UPDATE SET
         reconciliation_status = EXCLUDED.reconciliation_status,
         records_seen = EXCLUDED.records_seen,
         records_applied = EXCLUDED.records_applied,
         records_held = EXCLUDED.records_held,
         consecutive_failures = 0,
         last_error_code = NULL,
         last_started_at = COALESCE(
           operations_commerce_sync_cursors.last_started_at,
           EXCLUDED.last_started_at
         ),
         last_completed_at = CASE
           WHEN EXCLUDED.reconciliation_status = 'succeeded'
             THEN EXCLUDED.last_completed_at
           ELSE operations_commerce_sync_cursors.last_completed_at
         END,
         updated_at = now()`,
      [
        input.job.organizationId,
        input.job.integrationAccountId,
        hasNext ? 'running' : 'succeeded',
        totals.provider_records_seen,
        Number(totals.products_created) + Number(totals.products_mapped),
        Number(totals.products_skipped) + Number(totals.products_failed),
        null,
      ],
    )
    if (!hasNext) {
      await recordAuditEvent({
        actor: 'system',
        eventType: 'commerce.catalog.sync.succeeded',
        aggregateType: 'operations.integration_account',
        aggregateId: input.job.accountGlobalId,
        organizationId: input.job.organizationId,
        isSystem: true,
        eventKey: `commerce-catalog-sync:${input.job.id}:succeeded`,
        payload: {
          provider: input.job.provider,
          credentialVersion: input.job.credentialVersion,
          policyRevision: input.job.policyRevision,
          pageCount: nextPageCount,
          providerRecordsSeen: Number(totals.provider_records_seen),
          productsCreated: Number(totals.products_created),
          productsMapped: Number(totals.products_mapped),
          productsUnchanged: Number(totals.products_unchanged),
          productsSkipped: Number(totals.products_skipped),
          productsFailed: Number(totals.products_failed),
          providerWrites: 0,
          ordersTouched: 0,
          inventoryTouched: 0,
        },
      }, client)
    }
    return {
      status,
      pageCount: nextPageCount,
      hasNextBatch: hasNext,
    }
  })
}

export async function failCommerceCatalogSyncJobInPostgres(input: {
  job: CommerceCatalogSyncJob
  error: unknown
}) {
  const code = safeErrorCode(input.error)
  const permanent = PERMANENT_ERROR_CODES.has(code)
  const dead = permanent || input.job.attemptCount >= input.job.maxAttempts
  const restart = RESTART_ERROR_CODES.has(code)
  return withTransaction(async (client) => {
    const failed = await client.query(
      `UPDATE operations_commerce_catalog_sync_jobs
       SET status = $3,
           continuation_run_global_id = CASE
             WHEN $4::boolean THEN NULL
             ELSE continuation_run_global_id
           END,
           read_generation = read_generation
             + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
           available_at = now() + make_interval(
             secs => LEAST(
               3600,
               15 * power(2, LEAST(attempt_count, 8))
             )::integer
           ),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           last_error_code = $5,
           completed_at = CASE WHEN $3 = 'dead' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'processing'
         AND lock_token = $2::uuid`,
      [
        input.job.id,
        input.job.lockToken,
        dead ? 'dead' : 'failed',
        restart,
        code,
      ],
    )
    if (failed.rowCount !== 1) return { dead: false, leaseLost: true, code }
    await client.query(
      `INSERT INTO operations_commerce_sync_cursors (
         organization_id, integration_account_id, resource,
         reconciliation_status, consecutive_failures, last_error_code,
         last_started_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, 'products', 'failed', 1, $3, now(), now()
       )
       ON CONFLICT (organization_id, integration_account_id, resource)
       DO UPDATE SET
         reconciliation_status = 'failed',
         consecutive_failures =
           operations_commerce_sync_cursors.consecutive_failures + 1,
         last_error_code = EXCLUDED.last_error_code,
         last_started_at = COALESCE(
           operations_commerce_sync_cursors.last_started_at,
           EXCLUDED.last_started_at
         ),
         updated_at = now()`,
      [input.job.organizationId, input.job.integrationAccountId, code],
    )
    if (dead) {
      await recordAuditEvent({
        actor: 'system',
        eventType: 'commerce.catalog.sync.dead',
        aggregateType: 'operations.integration_account',
        aggregateId: input.job.accountGlobalId,
        organizationId: input.job.organizationId,
        isSystem: true,
        eventKey: `commerce-catalog-sync:${input.job.id}:dead`,
        payload: {
          provider: input.job.provider,
          credentialVersion: input.job.credentialVersion,
          policyRevision: input.job.policyRevision,
          attemptCount: input.job.attemptCount,
          errorCode: code,
          providerWrites: 0,
          ordersTouched: 0,
          inventoryTouched: 0,
        },
      }, client)
    }
    return { dead, leaseLost: false, code }
  })
}

export async function readCommerceCatalogSyncStateWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
  },
) {
  const result = await client.query<{
    status: string
    provider: 'shopify' | 'faire'
    credential_version: number
    policy_revision: number
    continuation_run_global_id: string | null
    page_count: number
    provider_records_seen: string
    products_created: string
    products_mapped: string
    products_unchanged: string
    products_skipped: string
    products_failed: string
    attempt_count: number
    max_attempts: number
    available_at: string | Date
    last_error_code: string | null
    started_at: string | Date | null
    completed_at: string | Date | null
    updated_at: string | Date
    active_backlog: string
    unmatched_action: 'review' | 'auto_create'
    last_success_at: string | Date | null
  }>(
    `SELECT job.status, job.provider, job.credential_version,
            job.policy_revision, job.continuation_run_global_id,
            job.page_count, job.provider_records_seen::text,
            job.products_created::text, job.products_mapped::text,
            job.products_unchanged::text,
            job.products_skipped::text, job.products_failed::text,
            job.attempt_count, job.max_attempts, job.available_at,
            job.last_error_code, job.started_at, job.completed_at,
            job.updated_at,
            policy.unmatched_action,
            (
              SELECT max(succeeded.completed_at)
              FROM operations_commerce_catalog_sync_jobs succeeded
              WHERE succeeded.organization_id = job.organization_id
                AND succeeded.integration_account_id
                  = job.integration_account_id
                AND succeeded.status = 'succeeded'
            ) AS last_success_at,
            (
              SELECT count(*)::text
              FROM operations_commerce_catalog_sync_jobs active
              WHERE active.organization_id = job.organization_id
                AND active.integration_account_id
                  = job.integration_account_id
                AND active.status IN ('pending', 'processing', 'failed')
            ) AS active_backlog
     FROM operations_commerce_catalog_sync_jobs job
     JOIN operations_commerce_product_intake_policies policy
       ON policy.organization_id = job.organization_id
      AND policy.integration_account_id = job.integration_account_id
     WHERE job.organization_id = $1::uuid
       AND job.integration_account_id = $2::uuid
     ORDER BY job.created_at DESC, job.id DESC
     LIMIT 1`,
    [input.organizationId, input.integrationAccountId],
  )
  const row = result.rows[0]
  if (!row) {
    return {
      status: 'idle',
      rawStatus: null,
      activeBacklog: 0,
      resource: 'products',
      readOnly: true,
      providerWrites: 0,
      ordersTouched: 0,
      inventoryTouched: 0,
    }
  }
  const iso = (value: string | Date | null) => (
    value ? new Date(value).toISOString() : null
  )
  const status = row.unmatched_action === 'review'
    ? 'paused'
    : row.status === 'pending'
      ? 'queued'
      : row.status === 'processing'
        ? 'running'
        : row.status === 'failed'
          ? 'retrying'
          : row.status === 'succeeded'
            ? 'completed'
            : row.status === 'dead'
              ? 'dead'
              : row.status === 'cancelled'
                ? 'paused'
                : 'idle'
  const nextRunAt = row.unmatched_action === 'review'
    ? null
    : ['pending', 'failed'].includes(row.status)
      ? iso(row.available_at)
      : row.status === 'succeeded' && row.completed_at
        ? new Date(
            new Date(row.completed_at).getTime() + 6 * 60 * 60 * 1_000,
          ).toISOString()
        : null
  return {
    status,
    rawStatus: row.status,
    provider: row.provider,
    credentialVersion: row.credential_version,
    policyRevision: row.policy_revision,
    continuationRunGlobalId: row.continuation_run_global_id,
    pageCount: row.page_count,
    providerRecordsSeen: Number(row.provider_records_seen),
    productsCreated: Number(row.products_created),
    productsMapped: Number(row.products_mapped),
    productsUnchanged: Number(row.products_unchanged),
    productsSkipped: Number(row.products_skipped),
    productsFailed: Number(row.products_failed),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    activeBacklog: Number(row.active_backlog),
    availableAt: iso(row.available_at),
    lastErrorCode: row.last_error_code,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    lastSuccessAt: iso(row.last_success_at),
    nextRunAt,
    updatedAt: iso(row.updated_at),
    resource: 'products',
    readOnly: true,
    providerWrites: 0,
    ordersTouched: 0,
    inventoryTouched: 0,
  }
}

export async function recordCommerceCatalogWorkerHeartbeatInPostgres(
  details: Record<string, unknown>,
) {
  const payload = {
    checkedAt: new Date().toISOString(),
    workerId: String(
      process.env.RAILWAY_REPLICA_ID
      || process.env.HOSTNAME
      || randomUUID(),
    ).slice(0, 200),
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

export async function readCommerceCatalogWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}
