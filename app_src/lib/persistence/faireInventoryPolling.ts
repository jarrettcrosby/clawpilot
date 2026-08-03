import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recordAuditEvent } from '@/lib/auditWriter'
import { CommerceIntegrationRequestError } from '@/lib/integrations/commerceIntegrations'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const POLL_INTERVAL = '30 minutes'
const POLL_LEASE = '10 minutes'
const WORKER_HEARTBEAT_KEY = 'faire_inventory_poll_worker_heartbeat'
const SELECTOR_LIMIT = 50

// This is only a scheduler/configuration hint. Faire's inventory endpoint is
// the authority for whether the current credential can actually read inventory.
const REQUESTED_READ_ACCOUNT_SQL = `(
  credential.auth_mode = 'faire_brand_token'
  OR (
    credential.auth_mode = 'faire_oauth'
    AND COALESCE(account.configuration->'requestedScopes', '[]'::jsonb)
      ? 'READ_INVENTORIES'
  )
)`

export type FaireInventoryQuantityState = 'quantity' | 'untracked' | 'missing'

export type FaireInventoryPollTarget = {
  id: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  externalAccountId: string
  credentialVersion: number
  activationRevision: number
  selectorAfter: string | null
  lockToken: string
  leaseExpiresAt: string
  attemptCount: number
  maxAttempts: number
  recoveredLease: boolean
}

export type FaireInventoryPollSelector = {
  channelStateId: string
  channelStateRowVersion: string
  channelStateSourceHash: string
  productMappingId: string
  externalVariantId: string
}

export type FaireInventoryObservation = FaireInventoryPollSelector & {
  providerRecordState: 'present' | 'missing'
  onHandState: FaireInventoryQuantityState
  onHandQuantity: number | null
  committedState: FaireInventoryQuantityState
  committedQuantity: number | null
  availableState: FaireInventoryQuantityState
  availableQuantity: number | null
  sourceHash: string
}

type PollJobRow = {
  id: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  external_account_id: string
  credential_version: number
  activation_revision: number
  selector_after: string | null
  lock_token: string
  lease_expires_at: Date | string
  attempt_count: number
  max_attempts: number
  recovered_lease: boolean
}

function iso(value: Date | string) {
  return new Date(value).toISOString()
}

function mappedTarget(row: PollJobRow): FaireInventoryPollTarget {
  return {
    id: row.id,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    externalAccountId: row.external_account_id,
    credentialVersion: row.credential_version,
    activationRevision: row.activation_revision,
    selectorAfter: row.selector_after,
    lockToken: row.lock_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    recoveredLease: row.recovered_lease,
  }
}

function safeCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code)
    ? code
    : 'FAIRE_INVENTORY_POLL_FAILED'
}

function retryable(error: unknown) {
  if (
    error
    && typeof error === 'object'
    && 'retryable' in error
    && (error as { retryable?: unknown }).retryable === true
  ) return true
  const code = safeCode(error)
  return new Set([
    'FAIRE_TIMEOUT',
    'FAIRE_NETWORK_ERROR',
    'FAIRE_RATE_LIMITED',
    'FAIRE_UPSTREAM_FAILED',
  ]).has(code)
}

function recoveryError(code: string, message: string, status = 409): never {
  throw new CommerceIntegrationRequestError(message, status, code)
}

function validUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || '').trim())
}

async function audit(
  client: PoolClient,
  input: {
    organizationId: string
    actorEmail: string | null
    eventType: string
    jobId: string
    accountGlobalId: string
    payload: Record<string, unknown>
  },
) {
  await recordAuditEvent({
    actor: input.actorEmail || 'system',
    isSystem: !input.actorEmail,
    organizationId: input.organizationId,
    eventType: input.eventType,
    aggregateType: 'operations.faire_inventory_poll',
    aggregateId: input.jobId,
    eventKey: `${input.eventType}:${input.jobId}`,
    payload: {
      accountGlobalId: input.accountGlobalId,
      provider: 'faire',
      authority: 'faire_channel_listing_observation',
      wmsProjectionApplied: false,
      providerWrites: 0,
      ...input.payload,
    },
  }, client)
}

export async function queueAutomaticFaireInventoryPollsInPostgres() {
  return withTransaction(async (client) => {
    const cancelled = await client.query(
      `UPDATE operations_faire_inventory_poll_jobs job
       SET status = 'cancelled',
           completed_at = clock_timestamp(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'FAIRE_INVENTORY_POLL_FENCE_CHANGED',
           updated_at = clock_timestamp()
       WHERE job.status IN ('pending', 'processing', 'failed')
         AND NOT EXISTS (
           SELECT 1
           FROM operations_integration_accounts account
           JOIN operations_commerce_credentials credential
             ON credential.organization_id = account.organization_id
            AND credential.integration_account_id = account.id
           JOIN operations_activation_scopes activation
             ON activation.organization_id = account.organization_id
           WHERE account.organization_id = job.organization_id
             AND account.id = job.integration_account_id
             AND account.integration_type = 'commerce'
             AND account.provider = 'faire'
             AND account.status = 'active'
             AND account.commerce_credential_generation =
                 job.credential_version
             AND credential.credential_version = job.credential_version
             AND credential.verification_status = 'verified'
             AND activation.state IN ('shadow', 'active')
             AND activation.revision = job.activation_revision
             AND ${REQUESTED_READ_ACCOUNT_SQL}
         )`,
    )
    const queued = await client.query<{ id: string }>(
      `WITH eligible AS (
         SELECT account.organization_id,
                account.id AS integration_account_id,
                account.commerce_credential_generation AS credential_version,
                activation.revision AS activation_revision
         FROM operations_integration_accounts account
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         WHERE account.integration_type = 'commerce'
           AND account.provider = 'faire'
           AND account.status = 'active'
           AND account.commerce_credential_generation > 0
           AND credential.credential_version =
               account.commerce_credential_generation
           AND credential.verification_status = 'verified'
           AND activation.state IN ('shadow', 'active')
           AND ${REQUESTED_READ_ACCOUNT_SQL}
           AND EXISTS (
             SELECT 1
             FROM operations_product_channel_states channel_state
             JOIN operations_product_mappings mapping
               ON mapping.organization_id = channel_state.organization_id
              AND mapping.integration_account_id =
                  channel_state.integration_account_id
              AND mapping.pipeline_id = channel_state.pipeline_id
              AND mapping.id = channel_state.product_mapping_id
              AND mapping.product_id = channel_state.product_id
              AND mapping.external_variant_id =
                  channel_state.external_variant_id
              AND mapping.active = true
             WHERE channel_state.organization_id = account.organization_id
               AND channel_state.integration_account_id = account.id
               AND channel_state.provider = 'faire'
               AND channel_state.product_id IS NOT NULL
               AND channel_state.normalized_status <> 'archived'
           )
       ), latest AS (
         SELECT eligible.*,
                latest_job.status AS latest_status,
                latest_job.completed_at AS latest_completed_at
         FROM eligible
         LEFT JOIN LATERAL (
           SELECT job.status, job.completed_at
           FROM operations_faire_inventory_poll_jobs job
           WHERE job.organization_id = eligible.organization_id
             AND job.integration_account_id = eligible.integration_account_id
             AND job.credential_version = eligible.credential_version
             AND job.activation_revision = eligible.activation_revision
           ORDER BY job.created_at DESC, job.id DESC
           LIMIT 1
         ) latest_job ON true
       )
       INSERT INTO operations_faire_inventory_poll_jobs (
         organization_id, integration_account_id, credential_version,
         activation_revision
       )
       SELECT organization_id, integration_account_id, credential_version,
              activation_revision
       FROM latest
       WHERE latest_status IS DISTINCT FROM 'dead'
         AND (
           latest_status = 'cancelled'
           OR
           latest_completed_at IS NULL
           OR latest_completed_at <=
              clock_timestamp() - interval '${POLL_INTERVAL}'
         )
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
    return {
      queued: queued.rowCount || 0,
      cancelled: cancelled.rowCount || 0,
    }
  })
}

export async function claimFaireInventoryPollJobsInPostgres(input: {
  limit: number
  workerId: string
}) {
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 10))
  const workerId = String(input.workerId || '').trim().slice(0, 200)
    || 'faire-inventory-worker'
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE operations_faire_inventory_poll_jobs
       SET status = 'dead',
           completed_at = clock_timestamp(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = 'FAIRE_INVENTORY_POLL_RETRY_LIMIT_EXCEEDED',
           updated_at = clock_timestamp()
       WHERE status = 'processing'
         AND lease_expires_at <= clock_timestamp()
         AND attempt_count >= max_attempts`,
    )
    const result = await client.query<PollJobRow>(
      `WITH candidates AS (
         SELECT job.id,
                job.status = 'processing' AS recovered_lease
         FROM operations_faire_inventory_poll_jobs job
         JOIN operations_integration_accounts account
           ON account.organization_id = job.organization_id
          AND account.id = job.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         WHERE job.status IN ('pending', 'processing', 'failed')
           AND job.attempt_count < job.max_attempts
           AND (
             (job.status IN ('pending', 'failed')
              AND job.available_at <= clock_timestamp())
             OR (job.status = 'processing'
                 AND job.lease_expires_at <= clock_timestamp())
           )
           AND account.integration_type = 'commerce'
           AND account.provider = 'faire'
           AND account.status = 'active'
           AND account.commerce_credential_generation =
               job.credential_version
           AND credential.credential_version = job.credential_version
           AND credential.verification_status = 'verified'
           AND activation.state IN ('shadow', 'active')
           AND activation.revision = job.activation_revision
           AND ${REQUESTED_READ_ACCOUNT_SQL}
         ORDER BY job.available_at, job.created_at, job.id
         FOR UPDATE OF job SKIP LOCKED
         LIMIT $1
       )
       UPDATE operations_faire_inventory_poll_jobs job
       SET status = 'processing',
           attempt_count = job.attempt_count + 1,
           locked_at = clock_timestamp(),
           locked_by = $2,
           lock_token = gen_random_uuid(),
           lease_expires_at =
             clock_timestamp() + interval '${POLL_LEASE}',
           started_at = COALESCE(job.started_at, clock_timestamp()),
           last_error_code = NULL,
           updated_at = clock_timestamp()
       FROM candidates, operations_integration_accounts account
       WHERE job.id = candidates.id
         AND account.organization_id = job.organization_id
         AND account.id = job.integration_account_id
       RETURNING job.id::text, job.organization_id::text,
                 job.integration_account_id::text,
                 account.global_id AS account_global_id,
                 account.external_account_id,
                 job.credential_version, job.activation_revision,
                 job.selector_after,
                 job.lock_token::text,
                 job.lease_expires_at,
                 job.attempt_count, job.max_attempts,
                 candidates.recovered_lease`,
      [limit, workerId],
    )
    for (const row of result.rows) {
      await client.query(
        `INSERT INTO operations_commerce_sync_cursors (
           organization_id, integration_account_id, resource,
           reconciliation_status, records_seen, records_applied,
           records_held, consecutive_failures, last_error_code,
           last_started_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, 'inventory', 'running', 0, 0, 0, 0,
           NULL, clock_timestamp(), clock_timestamp()
         )
         ON CONFLICT (organization_id, integration_account_id, resource)
         DO UPDATE SET
           reconciliation_status = 'running',
           records_seen = CASE
             WHEN operations_commerce_sync_cursors.reconciliation_status =
                  'succeeded' THEN 0
             ELSE operations_commerce_sync_cursors.records_seen
           END,
           records_applied = CASE
             WHEN operations_commerce_sync_cursors.reconciliation_status =
                  'succeeded' THEN 0
             ELSE operations_commerce_sync_cursors.records_applied
           END,
           records_held = CASE
             WHEN operations_commerce_sync_cursors.reconciliation_status =
                  'succeeded' THEN 0
             ELSE operations_commerce_sync_cursors.records_held
           END,
           last_error_code = NULL,
           last_started_at = clock_timestamp(),
           updated_at = clock_timestamp()`,
        [row.organization_id, row.integration_account_id],
      )
    }
    return result.rows.map(mappedTarget)
  })
}

export async function readFaireInventoryPollSelectorsInPostgres(input: {
  target: FaireInventoryPollTarget
  limit?: number
}) {
  const limit = Math.max(
    1,
    Math.min(Number(input.limit || SELECTOR_LIMIT), SELECTOR_LIMIT),
  )
  const result = await query<{
    channel_state_id: string
    channel_state_row_version: string
    channel_state_source_hash: string
    product_mapping_id: string
    external_variant_id: string
  }>(
    `SELECT channel_state.id::text AS channel_state_id,
            channel_state.row_version::text AS channel_state_row_version,
            channel_state.source_hash AS channel_state_source_hash,
            mapping.id::text AS product_mapping_id,
            channel_state.external_variant_id
     FROM operations_faire_inventory_poll_jobs job
     JOIN operations_integration_accounts account
       ON account.organization_id = job.organization_id
      AND account.id = job.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     JOIN operations_product_channel_states channel_state
       ON channel_state.organization_id = job.organization_id
      AND channel_state.integration_account_id = job.integration_account_id
      AND channel_state.provider = 'faire'
     JOIN operations_product_mappings mapping
       ON mapping.organization_id = channel_state.organization_id
      AND mapping.integration_account_id = channel_state.integration_account_id
      AND mapping.pipeline_id = channel_state.pipeline_id
      AND mapping.id = channel_state.product_mapping_id
      AND mapping.product_id = channel_state.product_id
      AND mapping.external_variant_id = channel_state.external_variant_id
      AND mapping.active = true
     WHERE job.id = $1::uuid
       AND job.organization_id = $2::uuid
       AND job.integration_account_id = $3::uuid
       AND job.status = 'processing'
       AND job.lock_token = $4::uuid
       AND job.lease_expires_at > clock_timestamp()
       AND job.credential_version = $6
       AND job.activation_revision = $7
       AND account.integration_type = 'commerce'
       AND account.provider = 'faire'
       AND account.status = 'active'
       AND account.commerce_credential_generation = job.credential_version
       AND credential.credential_version = job.credential_version
       AND credential.verification_status = 'verified'
       AND activation.state IN ('shadow', 'active')
       AND activation.revision = job.activation_revision
       AND ${REQUESTED_READ_ACCOUNT_SQL}
       AND channel_state.product_id IS NOT NULL
       AND channel_state.normalized_status <> 'archived'
       AND (
         job.selector_after IS NULL
         OR channel_state.external_variant_id COLLATE "C"
            > job.selector_after COLLATE "C"
       )
     ORDER BY channel_state.external_variant_id COLLATE "C",
              channel_state.id
     LIMIT $5`,
    [
      input.target.id,
      input.target.organizationId,
      input.target.integrationAccountId,
      input.target.lockToken,
      limit + 1,
      input.target.credentialVersion,
      input.target.activationRevision,
    ],
  )
  const rows = result.rows.slice(0, limit).map((row) => ({
    channelStateId: row.channel_state_id,
    channelStateRowVersion: row.channel_state_row_version,
    channelStateSourceHash: row.channel_state_source_hash,
    productMappingId: row.product_mapping_id,
    externalVariantId: row.external_variant_id,
  }))
  return {
    selectors: rows,
    hasMore: result.rows.length > limit,
    nextSelectorAfter: result.rows.length > limit
      ? rows.at(-1)?.externalVariantId || null
      : null,
  }
}

function assertObservation(
  selector: FaireInventoryPollSelector,
  observation: FaireInventoryObservation,
) {
  if (
    observation.channelStateId !== selector.channelStateId
    || observation.channelStateRowVersion !== selector.channelStateRowVersion
    || observation.channelStateSourceHash !== selector.channelStateSourceHash
    || observation.productMappingId !== selector.productMappingId
    || observation.externalVariantId !== selector.externalVariantId
    || !/^[a-f0-9]{64}$/.test(observation.sourceHash)
  ) {
    throw new Error('Faire inventory observation does not match its selector')
  }
}

async function lockCurrentJob(
  client: PoolClient,
  target: FaireInventoryPollTarget,
) {
  return (
    await client.query<{
      id: string
      account_global_id: string
      attempt_count: number
      max_attempts: number
    }>(
      `SELECT job.id::text, account.global_id AS account_global_id,
              job.attempt_count, job.max_attempts
       FROM operations_faire_inventory_poll_jobs job
       JOIN operations_integration_accounts account
         ON account.organization_id = job.organization_id
        AND account.id = job.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE job.id = $1::uuid
         AND job.organization_id = $2::uuid
         AND job.integration_account_id = $3::uuid
         AND job.status = 'processing'
         AND job.lock_token = $4::uuid
         AND job.lease_expires_at > clock_timestamp()
         AND job.credential_version = $5
         AND job.activation_revision = $6
         AND account.status = 'active'
         AND account.commerce_credential_generation = job.credential_version
         AND credential.credential_version = job.credential_version
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
         AND activation.revision = job.activation_revision
         AND ${REQUESTED_READ_ACCOUNT_SQL}
       FOR UPDATE OF job`,
      [
        target.id,
        target.organizationId,
        target.integrationAccountId,
        target.lockToken,
        target.credentialVersion,
        target.activationRevision,
      ],
    )
  ).rows[0] || null
}

export async function withFaireInventoryPollProviderReadFenceInPostgres<T>(
  input: {
    target: FaireInventoryPollTarget
    read: () => Promise<T>
  },
) {
  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT job.id
       FROM operations_faire_inventory_poll_jobs job
       JOIN operations_integration_accounts account
         ON account.organization_id = job.organization_id
        AND account.id = job.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE job.id = $1::uuid
         AND job.organization_id = $2::uuid
         AND job.integration_account_id = $3::uuid
         AND job.status = 'processing'
         AND job.lock_token = $4::uuid
         AND job.lease_expires_at > clock_timestamp()
         AND job.credential_version = $5
         AND job.activation_revision = $6
         AND account.integration_type = 'commerce'
         AND account.provider = 'faire'
         AND account.status = 'active'
         AND account.commerce_credential_generation = job.credential_version
         AND credential.credential_version = job.credential_version
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
         AND activation.revision = job.activation_revision
         AND ${REQUESTED_READ_ACCOUNT_SQL}
       FOR SHARE OF job, account, credential, activation`,
      [
        input.target.id,
        input.target.organizationId,
        input.target.integrationAccountId,
        input.target.lockToken,
        input.target.credentialVersion,
        input.target.activationRevision,
      ],
    )
    if (!current.rows[0]) {
      throw Object.assign(
        new Error('Faire inventory polling authority changed'),
        { code: 'FAIRE_INVENTORY_POLL_FENCE_CHANGED' },
      )
    }
    // Keep shared locks only around the bounded provider GETs. Activation,
    // account, or credential mutation must wait, so no read starts after its
    // authorization fence changes.
    return input.read()
  })
}

export async function completeFaireInventoryPollPageInPostgres(input: {
  target: FaireInventoryPollTarget
  selectors: FaireInventoryPollSelector[]
  observations: FaireInventoryObservation[]
  hasMore: boolean
  nextSelectorAfter: string | null
  observedAt: string
}) {
  if (input.selectors.length !== input.observations.length) {
    throw new Error('Faire inventory response did not cover every selector')
  }
  const observedAt = new Date(input.observedAt)
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error('Faire inventory observation time is invalid')
  }
  input.selectors.forEach((selector, index) => (
    assertObservation(selector, input.observations[index])
  ))
  if (
    input.hasMore
    && input.nextSelectorAfter !== input.selectors.at(-1)?.externalVariantId
  ) {
    throw new Error('Faire inventory continuation selector is invalid')
  }
  return withTransaction(async (client) => {
    const job = await lockCurrentJob(client, input.target)
    if (!job) {
      return { leaseLost: true, completed: false, continued: false }
    }
    for (const observation of input.observations) {
      const inserted = await client.query(
        `INSERT INTO operations_faire_inventory_observations (
           organization_id, integration_account_id, poll_job_id,
           channel_state_id, credential_version, external_variant_id,
           provider_record_state, on_hand_state, on_hand_quantity,
           committed_state, committed_quantity,
           available_state, available_quantity,
           source_hash, observed_at
         )
         SELECT $1::uuid, $2::uuid, $3::uuid, state.id,
                $4, state.external_variant_id,
                $5, $6, $7::bigint, $8, $9::bigint, $10, $11::bigint,
                $12, $13::timestamptz
         FROM operations_product_channel_states state
         JOIN operations_product_mappings mapping
           ON mapping.organization_id = state.organization_id
          AND mapping.integration_account_id = state.integration_account_id
          AND mapping.pipeline_id = state.pipeline_id
          AND mapping.id = state.product_mapping_id
          AND mapping.product_id = state.product_id
          AND mapping.external_variant_id = state.external_variant_id
          AND mapping.active = true
         WHERE state.organization_id = $1::uuid
           AND state.integration_account_id = $2::uuid
           AND state.id = $14::uuid
           AND state.row_version = $15::bigint
           AND state.source_hash = $16
           AND state.product_mapping_id = $17::uuid
           AND state.external_variant_id = $18
           AND state.provider = 'faire'
           AND state.product_id IS NOT NULL
           AND state.normalized_status <> 'archived'
         ON CONFLICT (poll_job_id, channel_state_id) DO NOTHING`,
        [
          input.target.organizationId,
          input.target.integrationAccountId,
          input.target.id,
          input.target.credentialVersion,
          observation.providerRecordState,
          observation.onHandState,
          observation.onHandQuantity,
          observation.committedState,
          observation.committedQuantity,
          observation.availableState,
          observation.availableQuantity,
          observation.sourceHash,
          observedAt.toISOString(),
          observation.channelStateId,
          observation.channelStateRowVersion,
          observation.channelStateSourceHash,
          observation.productMappingId,
          observation.externalVariantId,
        ],
      )
      if ((inserted.rowCount || 0) !== 1) {
        const replay = await client.query<{ source_hash: string }>(
          `SELECT source_hash
           FROM operations_faire_inventory_observations
           WHERE poll_job_id = $1::uuid
             AND channel_state_id = $2::uuid
           LIMIT 1`,
          [input.target.id, observation.channelStateId],
        )
        if (replay.rows[0]?.source_hash !== observation.sourceHash) {
          throw Object.assign(
            new Error('Faire inventory selector changed during provider read'),
            { code: 'FAIRE_INVENTORY_POLL_FENCE_CHANGED' },
          )
        }
      }
    }
    const quantityCount = input.observations.reduce((total, observation) => (
      total
      + Number(observation.onHandState === 'quantity')
      + Number(observation.committedState === 'quantity')
      + Number(observation.availableState === 'quantity')
    ), 0)
    const untrackedCount = input.observations.reduce((total, observation) => (
      total
      + Number(observation.onHandState === 'untracked')
      + Number(observation.committedState === 'untracked')
      + Number(observation.availableState === 'untracked')
    ), 0)
    const missingCount = input.observations.filter(
      (observation) => observation.providerRecordState === 'missing',
    ).length
    const presentCount = input.observations.filter(
      (observation) => observation.providerRecordState === 'present',
    ).length
    const heldVariantCount = input.observations.filter((observation) => (
      observation.providerRecordState === 'missing'
      || observation.onHandState === 'untracked'
      || observation.committedState === 'untracked'
      || observation.availableState === 'untracked'
    )).length
    const nextStatus = input.hasMore ? 'pending' : 'succeeded'
    await client.query(
      `UPDATE operations_faire_inventory_poll_jobs
       SET status = $2,
           selector_after = $3,
           attempt_count = CASE WHEN $2 = 'pending' THEN 0
                                ELSE attempt_count END,
           variants_seen = variants_seen + $4,
           quantities_observed = quantities_observed + $5,
           untracked_observations = untracked_observations + $6,
           missing_observations = missing_observations + $7,
           available_at = clock_timestamp(),
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL,
           result_summary = jsonb_build_object(
             'authority', 'faire_channel_listing_observation',
             'wmsProjectionApplied', false,
             'providerWrites', 0,
             'webhookSupported', false,
             'selectorReadMode', 'product_variant_ids'
           ),
           completed_at = CASE
             WHEN $2 = 'succeeded' THEN clock_timestamp()
             ELSE NULL
           END,
           updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [
        input.target.id,
        nextStatus,
        input.hasMore ? input.nextSelectorAfter : null,
        input.observations.length,
        quantityCount,
        untrackedCount,
        missingCount,
      ],
    )
    await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = $3,
           provider_cursor = NULL,
           records_seen = records_seen + $4,
           records_applied = records_applied + $5,
           records_held = records_held + $6,
           consecutive_failures = CASE WHEN $7 THEN 0
                                       ELSE consecutive_failures END,
           last_error_code = NULL,
           last_completed_at = CASE WHEN $7 THEN clock_timestamp()
                                    ELSE last_completed_at END,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'inventory'`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        input.hasMore ? 'idle' : 'succeeded',
        input.observations.length,
        presentCount,
        heldVariantCount,
        !input.hasMore,
      ],
    )
    if (!input.hasMore) {
      await audit(client, {
        organizationId: input.target.organizationId,
        actorEmail: null,
        eventType: 'commerce.faire.inventory_poll.completed',
        jobId: input.target.id,
        accountGlobalId: job.account_global_id,
        payload: {
          credentialVersion: input.target.credentialVersion,
        },
      })
    }
    return {
      leaseLost: false,
      completed: !input.hasMore,
      continued: input.hasMore,
      variantsObserved: input.observations.length,
      quantityCount,
      untrackedCount,
      missingCount,
    }
  })
}

export async function failFaireInventoryPollJobInPostgres(input: {
  target: FaireInventoryPollTarget
  error: unknown
}) {
  const errorCode = safeCode(input.error)
  const mayRetry = retryable(input.error)
  return withTransaction(async (client) => {
    const job = await lockCurrentJob(client, input.target)
    if (!job) return { leaseLost: true, dead: false, retrying: false }
    const dead = !mayRetry || job.attempt_count >= job.max_attempts
    const delaySeconds = Math.min(
      900,
      15 * (2 ** Math.max(0, job.attempt_count - 1)),
    )
    await client.query(
      `UPDATE operations_faire_inventory_poll_jobs
       SET status = $2,
           available_at = CASE
             WHEN $2 = 'failed'
             THEN clock_timestamp() + ($3::text || ' seconds')::interval
             ELSE available_at
           END,
           locked_at = NULL,
           locked_by = NULL,
           lock_token = NULL,
           lease_expires_at = NULL,
           last_error_code = $4,
           completed_at = CASE WHEN $2 = 'dead' THEN clock_timestamp()
                               ELSE NULL END,
           updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [input.target.id, dead ? 'dead' : 'failed', delaySeconds, errorCode],
    )
    await client.query(
      `UPDATE operations_commerce_sync_cursors
       SET reconciliation_status = 'failed',
           consecutive_failures = consecutive_failures + 1,
           last_error_code = $3,
           updated_at = clock_timestamp()
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND resource = 'inventory'`,
      [
        input.target.organizationId,
        input.target.integrationAccountId,
        errorCode,
      ],
    )
    if (dead) {
      await audit(client, {
        organizationId: input.target.organizationId,
        actorEmail: null,
        eventType: 'commerce.faire.inventory_poll.dead',
        jobId: input.target.id,
        accountGlobalId: job.account_global_id,
        payload: {
          errorCode,
          credentialVersion: input.target.credentialVersion,
          managerRecoveryRequired: true,
        },
      })
    }
    return { leaseLost: false, dead, retrying: !dead, errorCode }
  })
}

export async function recoverFaireInventoryPollInPostgres(input: {
  organizationId: string
  accountGlobalId: string
  failedJobId: string
  expectedCredentialVersion: number
  expectedErrorCode: string
  reason: string
  actorEmail: string
}) {
  const reason = String(input.reason || '').trim()
  if (!validUuid(input.failedJobId)) {
    recoveryError(
      'FAIRE_INVENTORY_RECOVERY_STATE_INVALID',
      'Reload the Faire inventory recovery state before continuing',
      400,
    )
  }
  if (
    !Number.isSafeInteger(input.expectedCredentialVersion)
    || input.expectedCredentialVersion < 1
    || !/^[A-Z][A-Z0-9_]{2,127}$/.test(input.expectedErrorCode)
  ) {
    recoveryError(
      'FAIRE_INVENTORY_RECOVERY_STATE_INVALID',
      'Reload the Faire inventory recovery state before continuing',
      400,
    )
  }
  if (
    reason.length < 10
    || reason.length > 500
    || /[\u0000-\u001f\u007f]/u.test(reason)
  ) {
    recoveryError(
      'FAIRE_INVENTORY_RECOVERY_REASON_REQUIRED',
      'A Faire inventory recovery reason of at least 10 characters is required',
      400,
    )
  }
  const reasonHash = createHash('sha256').update(reason).digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `faire-inventory-recovery:${input.organizationId}:${input.accountGlobalId}`,
    )
    const dead = (
      await client.query<{
        organization_id: string
        integration_account_id: string
        account_global_id: string
        credential_version: number
        activation_revision: number
        last_error_code: string | null
      }>(
        `SELECT job.organization_id::text,
                job.integration_account_id::text,
                account.global_id AS account_global_id,
                job.credential_version,
                job.activation_revision,
                job.last_error_code
         FROM operations_faire_inventory_poll_jobs job
         JOIN operations_integration_accounts account
           ON account.organization_id = job.organization_id
          AND account.id = job.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         JOIN operations_activation_scopes activation
           ON activation.organization_id = account.organization_id
         WHERE job.organization_id = $1::uuid
           AND account.global_id = $2
           AND job.id = $3::uuid
           AND job.status = 'dead'
           AND job.credential_version = $4
           AND job.last_error_code = $5
           AND account.provider = 'faire'
           AND account.status = 'active'
           AND account.commerce_credential_generation = job.credential_version
           AND credential.credential_version = job.credential_version
           AND credential.verification_status = 'verified'
           AND activation.state IN ('shadow', 'active')
           AND activation.revision = job.activation_revision
           AND ${REQUESTED_READ_ACCOUNT_SQL}
         FOR UPDATE OF job`,
        [
          input.organizationId,
          input.accountGlobalId,
          input.failedJobId,
          input.expectedCredentialVersion,
          input.expectedErrorCode,
        ],
      )
    ).rows[0]
    if (!dead) {
      recoveryError(
        'FAIRE_INVENTORY_RECOVERY_FENCE_CHANGED',
        'Faire inventory recovery evidence changed; reload before continuing',
      )
    }
    const existing = (
      await client.query<{ id: string; recovery_reason_hash: string }>(
        `SELECT id::text, recovery_reason_hash
         FROM operations_faire_inventory_poll_jobs
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND recovered_from_job_id = $3::uuid
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [
          dead.organization_id,
          dead.integration_account_id,
          input.failedJobId,
        ],
      )
    ).rows[0]
    if (existing) {
      if (existing.recovery_reason_hash !== reasonHash) {
        recoveryError(
          'FAIRE_INVENTORY_RECOVERY_IDEMPOTENCY_CONFLICT',
          'Faire inventory recovery was already recorded with a different reason',
        )
      }
      return {
        replayed: true,
        jobId: existing.id,
        providerWrites: 0,
        wmsProjectionApplied: false,
      }
    }
    const latest = (
      await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_faire_inventory_poll_jobs
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND credential_version = $3
           AND activation_revision = $4
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [
          dead.organization_id,
          dead.integration_account_id,
          dead.credential_version,
          dead.activation_revision,
        ],
      )
    ).rows[0]
    if (latest?.id !== input.failedJobId) {
      recoveryError(
        'FAIRE_INVENTORY_RECOVERY_FENCE_CHANGED',
        'Faire inventory recovery evidence changed; reload before continuing',
      )
    }
    const created = (
      await client.query<{ id: string }>(
        `INSERT INTO operations_faire_inventory_poll_jobs (
           organization_id, integration_account_id, credential_version,
           activation_revision, recovered_from_job_id,
           recovery_reason_hash, result_summary
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::uuid, $6,
           jsonb_build_object(
             'recoveredFromJobId', $5::text,
             'recoveryReasonHash', $6::text,
             'providerWrites', 0,
             'wmsProjectionApplied', false
           )
         )
         RETURNING id::text`,
        [
          dead.organization_id,
          dead.integration_account_id,
          dead.credential_version,
          dead.activation_revision,
          input.failedJobId,
          reasonHash,
        ],
      )
    ).rows[0]
    await audit(client, {
      organizationId: dead.organization_id,
      actorEmail: input.actorEmail,
      eventType: 'commerce.faire.inventory_poll.recovered',
      jobId: created.id,
      accountGlobalId: dead.account_global_id,
      payload: {
        failedJobId: input.failedJobId,
        priorErrorCode: input.expectedErrorCode,
        credentialVersion: dead.credential_version,
        reasonHash,
      },
    })
    return {
      replayed: false,
      jobId: created.id,
      providerWrites: 0,
      wmsProjectionApplied: false,
    }
  })
}

export async function readFaireInventoryPollStateFromPostgres(input: {
  organizationId: string
  accountGlobalId: string
}) {
  const result = await query<{
    provider: string
    auth_mode: string
    requested_inventory_scope_hint: boolean
    job_id: string | null
    job_status: string | null
    credential_version: number
    activation_revision: number
    attempt_count: number | null
    max_attempts: number | null
    last_error_code: string | null
    started_at: Date | string | null
    completed_at: Date | string | null
    variants_seen: string | number | null
    quantities_observed: string | number | null
    untracked_observations: string | number | null
    missing_observations: string | number | null
    latest_observed_at: Date | string | null
  }>(
    `SELECT account.provider, credential.auth_mode,
            (${REQUESTED_READ_ACCOUNT_SQL})
              AS requested_inventory_scope_hint,
            latest_job.id::text AS job_id,
            latest_job.status AS job_status,
            account.commerce_credential_generation AS credential_version,
            activation.revision AS activation_revision,
            latest_job.attempt_count, latest_job.max_attempts,
            latest_job.last_error_code,
            latest_job.started_at, latest_job.completed_at,
            latest_job.variants_seen,
            latest_job.quantities_observed,
            latest_job.untracked_observations,
            latest_job.missing_observations,
            observation.latest_observed_at
     FROM operations_integration_accounts account
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     JOIN operations_activation_scopes activation
       ON activation.organization_id = account.organization_id
     LEFT JOIN LATERAL (
       SELECT job.*
       FROM operations_faire_inventory_poll_jobs job
       WHERE job.organization_id = account.organization_id
         AND job.integration_account_id = account.id
         AND job.credential_version = account.commerce_credential_generation
         AND job.activation_revision = activation.revision
       ORDER BY job.created_at DESC, job.id DESC
       LIMIT 1
     ) latest_job ON true
     LEFT JOIN LATERAL (
       SELECT max(observed_at) AS latest_observed_at
       FROM operations_faire_inventory_observations current_observation
       JOIN operations_faire_inventory_poll_jobs observation_job
         ON observation_job.organization_id =
            current_observation.organization_id
        AND observation_job.integration_account_id =
            current_observation.integration_account_id
        AND observation_job.id = current_observation.poll_job_id
       WHERE current_observation.organization_id = account.organization_id
         AND current_observation.integration_account_id = account.id
         AND current_observation.credential_version =
             account.commerce_credential_generation
         AND observation_job.activation_revision = activation.revision
     ) observation ON true
     WHERE account.organization_id = $1::uuid
       AND account.global_id = $2
       AND account.integration_type = 'commerce'
       AND account.provider = 'faire'
     LIMIT 1`,
    [input.organizationId, input.accountGlobalId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    provider: 'faire' as const,
    selectorReadMode: 'product_variant_ids' as const,
    eventTransport: 'scheduled_poll' as const,
    webhookSupported: false,
    authority: 'faire_channel_listing_observation' as const,
    wmsInventoryAuthoritySupported: false,
    wmsProjectionApplied: false,
    providerWrites: 0,
    credentialVersion: row.credential_version,
    activationRevision: row.activation_revision,
    requestedInventoryScopeHint: row.requested_inventory_scope_hint,
    schedulingEligible: row.requested_inventory_scope_hint,
    providerGrantVerified: false,
    blocker: row.requested_inventory_scope_hint
      ? null
      : 'FAIRE_READ_INVENTORIES_SCOPE_REQUIRED',
    latestJob: row.job_id ? {
      id: row.job_id,
      status: row.job_status,
      attemptCount: Number(row.attempt_count || 0),
      maxAttempts: Number(row.max_attempts || 0),
      lastErrorCode: row.last_error_code,
      startedAt: row.started_at ? iso(row.started_at) : null,
      completedAt: row.completed_at ? iso(row.completed_at) : null,
      variantsSeen: Number(row.variants_seen || 0),
      quantitiesObserved: Number(row.quantities_observed || 0),
      untrackedObservations: Number(row.untracked_observations || 0),
      missingObservations: Number(row.missing_observations || 0),
      managerRecoveryRequired: row.job_status === 'dead',
    } : null,
    latestObservedAt: row.latest_observed_at
      ? iso(row.latest_observed_at)
      : null,
  }
}

export async function recordFaireInventoryPollWorkerHeartbeatInPostgres(
  details: Record<string, unknown>,
) {
  const payload = {
    checkedAt: new Date().toISOString(),
    workerId: String(
      process.env.RAILWAY_REPLICA_ID
      || process.env.HOSTNAME
      || randomUUID(),
    ).slice(0, 200),
    provider: 'faire',
    resource: 'inventory',
    eventTransport: 'scheduled_poll',
    webhookSupported: false,
    authority: 'faire_channel_listing_observation',
    wmsProjectionApplied: false,
    providerWrites: 0,
    ...details,
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, clock_timestamp())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value,
                   updated_at = clock_timestamp()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(payload)],
  )
  return payload
}

export async function readFaireInventoryPollWorkerHeartbeatFromPostgres() {
  const result = await query<{ value: Record<string, unknown> }>(
    'SELECT value FROM app_settings WHERE key = $1 LIMIT 1',
    [WORKER_HEARTBEAT_KEY],
  )
  return result.rows[0]?.value || null
}

export async function readFaireInventoryPollHealthFromPostgres() {
  const result = await query<{
    configured_accounts: string
    scheduling_eligible_accounts: string
    oauth_scope_hint_missing_accounts: string
    eligible_variants: string
    pending: string
    processing: string
    retrying: string
    dead: string
    stale_leases: string
    overdue_accounts: string
    latest_success_at: Date | string | null
    latest_observation_at: Date | string | null
    untracked_latest: string
    missing_latest: string
  }>(
    `WITH accounts AS (
       SELECT account.organization_id, account.id,
              account.commerce_credential_generation AS credential_version,
              activation.revision AS activation_revision,
              (${REQUESTED_READ_ACCOUNT_SQL}) AS scheduling_eligible,
              EXISTS (
                SELECT 1
                FROM operations_product_channel_states eligible_state
                JOIN operations_product_mappings eligible_mapping
                  ON eligible_mapping.organization_id =
                     eligible_state.organization_id
                 AND eligible_mapping.integration_account_id =
                     eligible_state.integration_account_id
                 AND eligible_mapping.pipeline_id = eligible_state.pipeline_id
                 AND eligible_mapping.id = eligible_state.product_mapping_id
                 AND eligible_mapping.product_id = eligible_state.product_id
                 AND eligible_mapping.external_variant_id =
                     eligible_state.external_variant_id
                 AND eligible_mapping.active = true
                WHERE eligible_state.organization_id = account.organization_id
                  AND eligible_state.integration_account_id = account.id
                  AND eligible_state.provider = 'faire'
                  AND eligible_state.product_id IS NOT NULL
                  AND eligible_state.normalized_status <> 'archived'
              ) AS has_eligible_variants
       FROM operations_integration_accounts account
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       JOIN operations_activation_scopes activation
         ON activation.organization_id = account.organization_id
       WHERE account.integration_type = 'commerce'
         AND account.provider = 'faire'
         AND account.status = 'active'
         AND account.commerce_credential_generation > 0
         AND credential.credential_version =
             account.commerce_credential_generation
         AND credential.verification_status = 'verified'
         AND activation.state IN ('shadow', 'active')
     ), variants AS (
       SELECT count(*)::text AS eligible_variants
       FROM operations_product_channel_states state
       JOIN accounts ON accounts.organization_id = state.organization_id
                    AND accounts.id = state.integration_account_id
                    AND accounts.scheduling_eligible
       JOIN operations_product_mappings mapping
         ON mapping.organization_id = state.organization_id
        AND mapping.integration_account_id = state.integration_account_id
        AND mapping.pipeline_id = state.pipeline_id
        AND mapping.id = state.product_mapping_id
        AND mapping.product_id = state.product_id
        AND mapping.external_variant_id = state.external_variant_id
        AND mapping.active = true
       WHERE state.provider = 'faire'
         AND state.product_id IS NOT NULL
         AND state.normalized_status <> 'archived'
     ), latest_jobs AS (
       SELECT DISTINCT ON (job.organization_id, job.integration_account_id)
              job.*
       FROM operations_faire_inventory_poll_jobs job
       JOIN accounts account
         ON account.organization_id = job.organization_id
        AND account.id = job.integration_account_id
        AND account.credential_version = job.credential_version
        AND account.activation_revision = job.activation_revision
       ORDER BY job.organization_id, job.integration_account_id,
                job.created_at DESC, job.id DESC
     ), latest_observations AS (
       SELECT DISTINCT ON (
         observation.organization_id,
         observation.integration_account_id,
         observation.external_variant_id
       ) observation.*
       FROM operations_faire_inventory_observations observation
       JOIN operations_faire_inventory_poll_jobs observation_job
         ON observation_job.organization_id = observation.organization_id
        AND observation_job.integration_account_id =
            observation.integration_account_id
        AND observation_job.id = observation.poll_job_id
       JOIN accounts account
         ON account.organization_id = observation.organization_id
        AND account.id = observation.integration_account_id
        AND account.credential_version = observation.credential_version
        AND account.activation_revision = observation_job.activation_revision
       ORDER BY observation.organization_id,
                observation.integration_account_id,
                observation.external_variant_id,
                observation.observed_at DESC,
                observation.id DESC
     )
     SELECT
       (SELECT count(*) FROM accounts)::text AS configured_accounts,
       (SELECT count(*) FROM accounts WHERE scheduling_eligible)::text
         AS scheduling_eligible_accounts,
       (SELECT count(*) FROM accounts WHERE NOT scheduling_eligible)::text
         AS oauth_scope_hint_missing_accounts,
       (SELECT eligible_variants FROM variants) AS eligible_variants,
       count(*) FILTER (WHERE job.status = 'pending')::text AS pending,
       count(*) FILTER (WHERE job.status = 'processing')::text AS processing,
       count(*) FILTER (WHERE job.status = 'failed')::text AS retrying,
       count(*) FILTER (WHERE job.status = 'dead')::text AS dead,
       count(*) FILTER (
         WHERE job.status = 'processing'
           AND job.lease_expires_at <= clock_timestamp()
       )::text AS stale_leases,
       (
         SELECT count(*)
         FROM accounts account
         WHERE account.scheduling_eligible
           AND account.has_eligible_variants
           AND NOT EXISTS (
             SELECT 1
             FROM operations_faire_inventory_poll_jobs recent
             WHERE recent.organization_id = account.organization_id
               AND recent.integration_account_id = account.id
               AND recent.credential_version = account.credential_version
               AND recent.activation_revision = account.activation_revision
               AND recent.status = 'succeeded'
               AND recent.completed_at >
                   clock_timestamp() - interval '${POLL_INTERVAL}'
           )
       )::text AS overdue_accounts,
       (SELECT max(current_job.completed_at)
        FROM operations_faire_inventory_poll_jobs current_job
        JOIN accounts current_account
          ON current_account.organization_id = current_job.organization_id
         AND current_account.id = current_job.integration_account_id
         AND current_account.credential_version =
             current_job.credential_version
         AND current_account.activation_revision =
             current_job.activation_revision
        WHERE current_job.status = 'succeeded') AS latest_success_at,
       (SELECT max(observed_at) FROM latest_observations)
         AS latest_observation_at,
       (SELECT count(*) FROM latest_observations
        WHERE on_hand_state = 'untracked'
           OR committed_state = 'untracked'
           OR available_state = 'untracked')::text AS untracked_latest,
       (SELECT count(*) FROM latest_observations
        WHERE provider_record_state = 'missing')::text AS missing_latest
     FROM latest_jobs job`,
  )
  const row = result.rows[0]
  return {
    configuredAccounts: Number(row?.configured_accounts || 0),
    schedulingEligibleAccounts: Number(
      row?.scheduling_eligible_accounts || 0,
    ),
    oauthScopeHintMissingAccounts: Number(
      row?.oauth_scope_hint_missing_accounts || 0,
    ),
    eligibleVariants: Number(row?.eligible_variants || 0),
    pending: Number(row?.pending || 0),
    processing: Number(row?.processing || 0),
    retrying: Number(row?.retrying || 0),
    dead: Number(row?.dead || 0),
    staleLeases: Number(row?.stale_leases || 0),
    overdueAccounts: Number(row?.overdue_accounts || 0),
    latestSuccessAt: row?.latest_success_at
      ? iso(row.latest_success_at)
      : null,
    latestObservationAt: row?.latest_observation_at
      ? iso(row.latest_observation_at)
      : null,
    untrackedLatest: Number(row?.untracked_latest || 0),
    missingLatest: Number(row?.missing_latest || 0),
    provider: 'faire' as const,
    resource: 'inventory' as const,
    selectorReadMode: 'product_variant_ids' as const,
    eventTransport: 'scheduled_poll' as const,
    webhookSupported: false,
    authority: 'faire_channel_listing_observation' as const,
    wmsInventoryAuthoritySupported: false,
    wmsProjectionApplied: false,
    providerWrites: 0,
  }
}
