import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const CATALOG_SYNC_POLICY_VERSION = 'commerce-product-intake-policy-v1'
const CATALOG_RECONCILIATION_INTERVAL = '6 hours'
const CATALOG_SYNC_LEASE = '10 minutes'
const WORKER_HEARTBEAT_KEY = 'commerce.catalog.worker.heartbeat'
const PRODUCT_READABLE_CONNECTION_SQL = `(
  (
    account.provider = 'shopify'
    AND COALESCE(
      account.configuration->'grantedScopes',
      '[]'::jsonb
    ) ?| ARRAY['read_products', 'write_products']
  )
  OR (
    account.provider = 'faire'
    AND (
      credential.auth_mode = 'faire_brand_token'
      OR COALESCE(
        account.configuration->'requestedScopes',
        '[]'::jsonb
      ) ? 'READ_PRODUCTS'
    )
  )
)`

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
  targetDirtyVersion: number
  readGeneration: number
  pageCount: number
  providerRecordsSeen: number
  attemptCount: number
  sweepFailureCount: number
  maxAttempts: number
  startedAt: string
  lockToken: string
}

type AutomaticCatalogIntakeState = {
  eligible: boolean
  initialized: boolean
  paused: boolean
  waitingForProductTarget: boolean
  policyRevision: number | null
  queued: number
  cancelled: number
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
  'COMMERCE_CATALOG_SYNC_CONTINUATION_REPEATED',
  'COMMERCE_CATALOG_SYNC_DURATION_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_RECORD_LIMIT_EXCEEDED',
  'COMMERCE_CATALOG_SYNC_STATE_INVALID',
  'SHOPIFY_STORE_IDENTITY_CHANGED',
])

const RESTART_ERROR_CODES = new Set([
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_RESTART_REQUIRED',
  'COMMERCE_INTAKE_CONTINUATION_INVALID',
  'COMMERCE_INTAKE_CONTINUATION_CONSUMED',
  'COMMERCE_INTAKE_CONTINUATION_NOT_FOUND',
])

export function commerceCatalogSweepFailureState(input: {
  code: string
  attemptCount: number
  sweepFailureCount: number
  maxAttempts: number
}) {
  // attempt_count predates the sweep budget and counts claims since the last
  // successful page. Seed from it so an in-flight legacy retry does not gain a
  // fresh budget when this protection is deployed.
  const priorFailures = Math.max(
    boundedCount(input.sweepFailureCount),
    Math.max(0, boundedCount(input.attemptCount) - 1),
  )
  const sweepFailureCount = priorFailures + 1
  const maxAttempts = Math.max(1, Math.min(
    boundedCount(input.maxAttempts) || 1,
    20,
  ))
  const permanent = PERMANENT_ERROR_CODES.has(input.code)
  return {
    sweepFailureCount,
    permanent,
    dead: permanent || sweepFailureCount >= maxAttempts,
  }
}

async function cancelCommerceCatalogSyncJobsWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    errorCode: string
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `shopify-catalog-watermark:${input.organizationId}:${input.integrationAccountId}`,
  )
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
         last_error_code = $3,
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND status IN ('pending', 'processing', 'failed')`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.errorCode,
    ],
  )
  return cancelled.rowCount || 0
}

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

  const stale = await client.query(
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
         last_error_code = 'COMMERCE_CATALOG_SYNC_FENCE_CHANGED',
         updated_at = now()
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND status IN ('pending', 'processing', 'failed')
       AND (
         credential_version <> $3::integer
         OR policy_revision <> $4::integer
       )`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialVersion,
      input.policyRevision,
    ],
  )
  const queued = await client.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by,
       target_dirty_version
     )
     SELECT
       account.organization_id,
       account.id,
       account.provider,
       account.commerce_credential_generation,
       $5,
       $6,
       COALESCE(refresh.dirty_version, 0)
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     LEFT JOIN operations_shopify_catalog_refresh_states refresh
       ON refresh.organization_id = account.organization_id
      AND refresh.integration_account_id = account.id
      AND refresh.credential_generation = account.commerce_credential_generation
     WHERE account.organization_id = $1::uuid
       AND account.id = $2::uuid
       AND account.integration_type = 'commerce'
       AND account.provider = $3
       AND account.status <> 'error'
       AND account.commerce_credential_generation = $4
       AND credential.credential_version = $4
       AND credential.verification_status = 'verified'
       AND activation.state IN ('shadow', 'active')
       AND ${PRODUCT_READABLE_CONNECTION_SQL}
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_catalog_sync_jobs active
         WHERE active.organization_id = $1::uuid
           AND active.integration_account_id = $2::uuid
           AND active.status IN ('pending', 'processing', 'failed')
       )
       AND NOT EXISTS (
         SELECT 1
         FROM operations_commerce_catalog_sync_jobs terminal
         WHERE terminal.organization_id = $1::uuid
           AND terminal.integration_account_id = $2::uuid
           AND terminal.provider = $3
           AND terminal.credential_version = $4
           AND terminal.policy_revision = $5
           AND terminal.status = 'dead'
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
  return {
    queued: queued.rowCount || 0,
    cancelled: stale.rowCount || 0,
  }
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function automaticCommerceCatalogRuntimeAvailable() {
  if (process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED !== '1') return false
  const lane = String(
    process.env.CLAWPILOT_ENV
    || process.env.RAILWAY_ENVIRONMENT_NAME
    || process.env.VERCEL_ENV
    || process.env.NODE_ENV
    || '',
  ).trim().toLowerCase()
  return ['dev', 'development', 'local', 'preview'].includes(lane)
}

export async function signalShopifyCatalogRefreshWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    credentialGeneration: number
    receiptGlobalId: string
    providerTriggeredAt: string | null
  },
) {
  await acquireTransactionAdvisoryLock(
    client,
    `shopify-catalog-watermark:${input.organizationId}:${input.integrationAccountId}`,
  )
  const signaled = await client.query<{
    dirty_version: string
    reconciled_version: string
  }>(
    `INSERT INTO operations_shopify_catalog_refresh_states (
       organization_id, integration_account_id, credential_generation,
       dirty_version, reconciled_version, last_receipt_global_id,
       last_provider_triggered_at, last_signaled_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, 1, 0, $4, $5::timestamptz, now()
     )
     ON CONFLICT (organization_id, integration_account_id)
     DO UPDATE SET
       credential_generation = EXCLUDED.credential_generation,
       dirty_version =
         operations_shopify_catalog_refresh_states.dirty_version + 1,
       last_receipt_global_id = EXCLUDED.last_receipt_global_id,
       last_provider_triggered_at = EXCLUDED.last_provider_triggered_at,
       last_signaled_at = now(),
       updated_at = now()
     RETURNING dirty_version::text, reconciled_version::text`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.credentialGeneration,
      input.receiptGlobalId,
      input.providerTriggeredAt,
    ],
  )
  return {
    dirtyVersion: Number(signaled.rows[0].dirty_version),
    reconciledVersion: Number(signaled.rows[0].reconciled_version),
  }
}

export function commerceCatalogCredentialSupportsProducts(input: {
  provider: 'shopify' | 'faire'
  authMode:
    | 'shopify_client_credentials'
    | 'faire_brand_token'
    | 'faire_oauth'
  configuration: Record<string, unknown>
}) {
  if (input.provider === 'shopify') {
    const grantedScopes = new Set(
      stringArray(input.configuration.grantedScopes),
    )
    return (
      grantedScopes.has('read_products')
      || grantedScopes.has('write_products')
    )
  }
  return (
    input.authMode === 'faire_brand_token'
    || new Set(
      stringArray(input.configuration.requestedScopes),
    ).has('READ_PRODUCTS')
  )
}

export async function ensureAutomaticCommerceCatalogIntakeWithClient(
  client: PoolClient,
  input: {
    organizationId: string
    integrationAccountId: string
    actorEmail: string | null
  },
): Promise<AutomaticCatalogIntakeState> {
  if (!automaticCommerceCatalogRuntimeAvailable()) {
    return {
      eligible: false,
      initialized: false,
      paused: false,
      waitingForProductTarget: false,
      policyRevision: null,
      queued: 0,
      cancelled: 0,
    }
  }
  const account = (
    await client.query<{
      global_id: string
      provider: 'shopify' | 'faire'
      status: 'active' | 'disabled' | 'error'
      configuration: Record<string, unknown>
      commerce_credential_generation: number
      credential_version: number
      verification_status: 'unverified' | 'verified' | 'failed'
      auth_mode:
        | 'shopify_client_credentials'
        | 'faire_brand_token'
        | 'faire_oauth'
      product_target_ready: boolean
    }>(
      `SELECT
         account.global_id,
         account.provider,
         account.status,
         account.configuration,
         account.commerce_credential_generation,
         credential.credential_version,
         credential.verification_status,
         credential.auth_mode,
         EXISTS (
           SELECT 1
           FROM operations_activation_scopes activation
           WHERE activation.organization_id = account.organization_id
             AND activation.state IN ('shadow', 'active')
         ) AS product_target_ready
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.organization_id = $1::uuid
         AND account.id = $2::uuid
         AND account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
       LIMIT 1
       FOR UPDATE OF account, credential`,
      [input.organizationId, input.integrationAccountId],
    )
  ).rows[0]
  if (
    !account
    || account.status === 'error'
    || account.verification_status !== 'verified'
    || account.credential_version
      !== account.commerce_credential_generation
  ) {
    const cancelled = account
      ? await cancelCommerceCatalogSyncJobsWithClient(client, {
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          errorCode: 'COMMERCE_CATALOG_SYNC_CONNECTION_INELIGIBLE',
        })
      : 0
    return {
      eligible: false,
      initialized: false,
      paused: false,
      waitingForProductTarget: false,
      policyRevision: null,
      queued: 0,
      cancelled,
    }
  }

  const productReadable = commerceCatalogCredentialSupportsProducts({
    provider: account.provider,
    authMode: account.auth_mode,
    configuration: account.configuration,
  })
  if (!productReadable) {
    const cancelled = await cancelCommerceCatalogSyncJobsWithClient(client, {
      organizationId: input.organizationId,
      integrationAccountId: input.integrationAccountId,
      errorCode: 'COMMERCE_CATALOG_SYNC_SCOPE_INELIGIBLE',
    })
    return {
      eligible: false,
      initialized: false,
      paused: false,
      waitingForProductTarget: false,
      policyRevision: null,
      queued: 0,
      cancelled,
    }
  }

  const existing = (
    await client.query<{
      unmatched_action: 'review' | 'auto_create'
      revision: number
    }>(
      `SELECT unmatched_action, revision
       FROM operations_commerce_product_intake_policies
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, input.integrationAccountId],
    )
  ).rows[0] || null
  if (existing?.unmatched_action === 'review') {
    return {
      eligible: true,
      initialized: false,
      paused: true,
      waitingForProductTarget: false,
      policyRevision: Number(existing.revision),
      queued: 0,
      cancelled: 0,
    }
  }

  let initialized = false
  let policyRevision = Number(existing?.revision || 0)
  if (!existing) {
    policyRevision = 1
    await client.query(
      `INSERT INTO operations_commerce_product_intake_policies (
         organization_id, integration_account_id, policy_version,
         unmatched_action, revision, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'auto_create', 1, $4, $4
       )`,
      [
        input.organizationId,
        input.integrationAccountId,
        CATALOG_SYNC_POLICY_VERSION,
        input.actorEmail,
      ],
    )
    initialized = true
  }

  const catalogSync = account.product_target_ready
    ? await applyCommerceCatalogSyncPolicyWithClient(
        client,
        {
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          provider: account.provider,
          credentialVersion: account.commerce_credential_generation,
          policyRevision,
          unmatchedAction: 'auto_create',
          actorEmail: input.actorEmail || 'system:commerce-catalog',
        },
      )
    : {
        queued: 0,
        cancelled: await cancelCommerceCatalogSyncJobsWithClient(client, {
          organizationId: input.organizationId,
          integrationAccountId: input.integrationAccountId,
          errorCode: 'COMMERCE_CATALOG_SYNC_PRODUCT_TARGET_WAITING',
        }),
      }
  if (initialized) {
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'commerce.intake.product_policy.connected_default',
      aggregateType: 'operations.integration_account',
      aggregateId: account.global_id,
      organizationId: input.organizationId,
      isSystem: !input.actorEmail,
      eventKey:
        `commerce-product-policy:${account.global_id}:connected-default:v${account.commerce_credential_generation}`,
      payload: {
        provider: account.provider,
        policyVersion: CATALOG_SYNC_POLICY_VERSION,
        unmatchedAction: 'auto_create',
        revision: policyRevision,
        connectionIsAuthorization: true,
        productTargetReady: account.product_target_ready,
        catalogSyncQueued: catalogSync.queued,
        providerWrites: 0,
        ordersTouched: 0,
        inventoryTouched: 0,
      },
    }, client)
  }
  return {
    eligible: true,
    initialized,
    paused: false,
    waitingForProductTarget: !account.product_target_ready,
    policyRevision,
    queued: catalogSync.queued,
    cancelled: catalogSync.cancelled,
  }
}

export async function queueAutomaticCommerceCatalogSyncsInPostgres() {
  if (!automaticCommerceCatalogRuntimeAvailable()) return 0
  return withTransaction(async (client) => {
    const missingPolicies = await client.query<{
      organization_id: string
      integration_account_id: string
      actor_email: string | null
    }>(
      `SELECT
         account.organization_id::text,
         account.id::text AS integration_account_id,
         COALESCE(
           account.updated_by,
           account.created_by,
           credential.updated_by,
           credential.created_by
         ) AS actor_email
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE account.integration_type = 'commerce'
         AND account.provider IN ('shopify', 'faire')
         AND account.status <> 'error'
         AND account.commerce_credential_generation > 0
         AND credential.credential_version
           = account.commerce_credential_generation
         AND credential.verification_status = 'verified'
         AND ${PRODUCT_READABLE_CONNECTION_SQL}
         AND NOT EXISTS (
           SELECT 1
           FROM operations_commerce_product_intake_policies policy
           WHERE policy.organization_id = account.organization_id
             AND policy.integration_account_id = account.id
         )
       FOR UPDATE OF account, credential`,
    )
    let connectedDefaultQueued = 0
    for (const missing of missingPolicies.rows) {
      const ensured = await ensureAutomaticCommerceCatalogIntakeWithClient(
        client,
        {
          organizationId: missing.organization_id,
          integrationAccountId: missing.integration_account_id,
          actorEmail: missing.actor_email,
        },
      )
      connectedDefaultQueued += ensured.queued
    }

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
               AND ${PRODUCT_READABLE_CONNECTION_SQL}
           )
         )`,
      [CATALOG_SYNC_POLICY_VERSION],
    )

    const queued = await client.query(
      `INSERT INTO operations_commerce_catalog_sync_jobs (
         organization_id, integration_account_id, provider,
         credential_version, policy_revision, requested_by,
         target_dirty_version
       )
       SELECT
         account.organization_id,
         account.id,
         account.provider,
         account.commerce_credential_generation,
         policy.revision,
         COALESCE(policy.updated_by, policy.created_by),
         COALESCE(refresh.dirty_version, 0)
       FROM operations_commerce_product_intake_policies policy
       JOIN operations_integration_accounts account
         ON account.organization_id = policy.organization_id
        AND account.id = policy.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       LEFT JOIN operations_shopify_catalog_refresh_states refresh
         ON refresh.organization_id = account.organization_id
        AND refresh.integration_account_id = account.id
        AND refresh.credential_generation = account.commerce_credential_generation
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
         AND ${PRODUCT_READABLE_CONNECTION_SQL}
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
           FROM operations_commerce_catalog_sync_jobs terminal
           WHERE terminal.organization_id = account.organization_id
             AND terminal.integration_account_id = account.id
             AND terminal.provider = account.provider
             AND terminal.credential_version
               = account.commerce_credential_generation
             AND terminal.policy_revision = policy.revision
             AND terminal.status = 'dead'
         )
         AND (
           COALESCE(refresh.dirty_version, 0)
             > COALESCE(refresh.reconciled_version, 0)
           OR NOT EXISTS (
           SELECT 1
           FROM operations_commerce_catalog_sync_jobs recent
           WHERE recent.organization_id = account.organization_id
             AND recent.integration_account_id = account.id
             AND recent.provider = account.provider
             AND recent.credential_version
               = account.commerce_credential_generation
             AND recent.policy_revision = policy.revision
             AND recent.status = 'succeeded'
             AND recent.updated_at >= now() - interval '${CATALOG_RECONCILIATION_INTERVAL}'
           )
         )
       ON CONFLICT (
         organization_id, integration_account_id
       ) WHERE status IN ('pending', 'processing', 'failed')
       DO NOTHING`,
      [CATALOG_SYNC_POLICY_VERSION],
    )
    return connectedDefaultQueued + (queued.rowCount || 0)
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
      target_dirty_version: string
      read_generation: number
      page_count: number
      provider_records_seen: string
      attempt_count: number
      sweep_failure_count: number
      max_attempts: number
      started_at: string | Date
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
           AND ${PRODUCT_READABLE_CONNECTION_SQL}
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
         job.target_dirty_version::text,
         job.read_generation,
         job.page_count,
         job.provider_records_seen::text,
         job.attempt_count,
         CASE
           WHEN COALESCE(
             job.result_summary->>'sweepFailureCount',
             ''
           ) ~ '^[0-9]{1,9}$'
             THEN (job.result_summary->>'sweepFailureCount')::integer
           ELSE 0
         END AS sweep_failure_count,
         job.max_attempts,
         job.started_at,
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
      targetDirtyVersion: Number(row.target_dirty_version),
      readGeneration: row.read_generation,
      pageCount: row.page_count,
      providerRecordsSeen: Number(row.provider_records_seen),
      attemptCount: row.attempt_count,
      sweepFailureCount: row.sweep_failure_count,
      maxAttempts: row.max_attempts,
      startedAt: new Date(row.started_at).toISOString(),
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
       AND ${PRODUCT_READABLE_CONNECTION_SQL}
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
           result_summary = result_summary || jsonb_build_object(
             'resource', 'products',
             'readOnly', true,
             'providerWrites', 0,
             'ordersTouched', 0,
             'inventoryTouched', 0,
             'hasNextBatch', $12::boolean,
             'sweepFailureCount', $13::integer
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
        boundedCount(input.job.sweepFailureCount),
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
      if (input.job.provider === 'shopify' && input.job.targetDirtyVersion > 0) {
        await client.query(
          `UPDATE operations_shopify_catalog_refresh_states
           SET reconciled_version = GREATEST(
                 reconciled_version,
                 LEAST(dirty_version, $4::bigint)
               ),
               last_reconciled_at = now(),
               updated_at = now()
           WHERE organization_id = $1::uuid
             AND integration_account_id = $2::uuid
             AND credential_generation = $3`,
          [
            input.job.organizationId,
            input.job.integrationAccountId,
            input.job.credentialVersion,
            input.job.targetDirtyVersion,
          ],
        )
      }
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
          targetDirtyVersion: input.job.targetDirtyVersion,
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
  const failureState = commerceCatalogSweepFailureState({
    code,
    attemptCount: input.job.attemptCount,
    sweepFailureCount: input.job.sweepFailureCount,
    maxAttempts: input.job.maxAttempts,
  })
  const dead = failureState.dead
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
           result_summary = result_summary || jsonb_build_object(
             'resource', 'products',
             'readOnly', true,
             'providerWrites', 0,
             'ordersTouched', 0,
             'inventoryTouched', 0,
             'sweepFailureCount', $6::integer
           ),
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
        failureState.sweepFailureCount,
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
          sweepFailureCount: failureState.sweepFailureCount,
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
    result_summary: Record<string, unknown>
    max_attempts: number
    available_at: string | Date
    last_error_code: string | null
    started_at: string | Date | null
    completed_at: string | Date | null
    updated_at: string | Date
    active_backlog: string
    unmatched_action: 'review' | 'auto_create'
    current_credential_version: number
    current_policy_revision: number
    current_policy_version: string
    current_provider: 'shopify' | 'faire'
    last_success_at: string | Date | null
  }>(
    `SELECT job.status, job.provider, job.credential_version,
            job.policy_revision, job.continuation_run_global_id,
            job.page_count, job.provider_records_seen::text,
            job.products_created::text, job.products_mapped::text,
            job.products_unchanged::text,
            job.products_skipped::text, job.products_failed::text,
            job.attempt_count, job.result_summary,
            job.max_attempts, job.available_at,
            job.last_error_code, job.started_at, job.completed_at,
            job.updated_at,
            policy.unmatched_action,
            account.commerce_credential_generation
              AS current_credential_version,
            policy.revision AS current_policy_revision,
            policy.policy_version AS current_policy_version,
            account.provider AS current_provider,
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
     JOIN operations_integration_accounts account
       ON account.organization_id = job.organization_id
      AND account.id = job.integration_account_id
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
      terminalRecoveryRequired: false,
      historicalTerminalEvidence: false,
    }
  }
  const iso = (value: string | Date | null) => (
    value ? new Date(value).toISOString() : null
  )
  const authoritativeFence = (
    row.provider === row.current_provider
    && row.credential_version === row.current_credential_version
    && row.policy_revision === row.current_policy_revision
    && row.current_policy_version === CATALOG_SYNC_POLICY_VERSION
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
              ? authoritativeFence
                ? 'dead'
                : 'idle'
              : row.status === 'cancelled'
                ? 'idle'
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
    sweepFailureCount: boundedCount(row.result_summary?.sweepFailureCount),
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
    terminalRecoveryRequired: (
      status === 'dead'
      && row.unmatched_action === 'auto_create'
      && authoritativeFence
    ),
    recoveryMode: status === 'dead'
      ? 'operator_policy_revision'
      : null,
    deadEvidencePreserved: row.status === 'dead',
    historicalTerminalEvidence: (
      row.status === 'dead'
      && !authoritativeFence
    ),
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
