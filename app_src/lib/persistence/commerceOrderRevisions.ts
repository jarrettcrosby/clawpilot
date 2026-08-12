import type { PoolClient, QueryResultRow } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  commerceOrderRevisionHash,
} from '@/lib/integrations/commerceOrderRevisionEvidence'
export { commerceOrderRevisionHash } from '@/lib/integrations/commerceOrderRevisionEvidence'
import {
  commerceReadAccountSql,
  commerceReadRuntimeAvailable,
} from '@/lib/integrations/commerceReadRuntime'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const REVISION_INTERVAL = '30 minutes'
const REVISION_FRESHNESS = '35 minutes'
const REVISION_OVERDUE_GRACE = '5 minutes'
const REVISION_LEASE = '5 minutes'
const REVISION_EXCEPTION_TYPE = 'commerce_order_revision_required'
const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const GLOBAL_ORDER_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_ACCOUNT_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_OBSERVATION_ID = /^gcor(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_DISPOSITION_ID = /^gcod(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u
const READABLE_ACCOUNT_SQL = commerceReadAccountSql('account')

export type CommerceOrderRevisionProvider = 'shopify' | 'faire'
export type CommerceOrderRevisionMaterialState =
  | 'current'
  | 'review_required'
  | 'provider_cancelled'
  | 'provider_fulfilled'

export type CommerceOrderRevisionClaim = Readonly<{
  targetId: string
  workerId: string
  leaseToken: string
  organizationId: string
  integrationAccountId: string
  accountGlobalId: string
  externalAccountId: string
  credentialVersion: number
  provider: CommerceOrderRevisionProvider
  canonicalOrderId: string
  canonicalOrderGlobalId: string
  canonicalOrderRowVersion: number
  externalOrderId: string
  acceptedSourceHash: string | null
}>

export type CommerceOrderRevisionObservationInput = Readonly<{
  claim: CommerceOrderRevisionClaim
  sourceRevision: string
  sourceHash: string
  revisionHash: string
  normalizedSnapshot: Record<string, unknown>
  providerReads: number
  providerWrites: 0
  observedAt: string
}>

export type CommerceOrderRevisionCaptureResult = Readonly<{
  observationGlobalId: string
  sourceHash: string
  changed: boolean
  materialState: CommerceOrderRevisionMaterialState
  managerDispositionRequired: boolean
  providerReads: number
  providerWrites: 0
}>

export type CommerceOrderRevisionCancellationResult = Readonly<{
  dispositionGlobalId: string
  orderGlobalId: string
  observationGlobalId: string
  sourceHash: string
  revisionHash: string
  previousStatus: 'imported'
  status: 'cancelled'
  previousRowVersion: number
  newRowVersion: number
  replayed: boolean
  providerReads: number
  providerWrites: 0
}>

export class CommerceOrderRevisionDispositionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CommerceOrderRevisionDispositionError'
    this.code = code
    this.status = status
  }
}

type ClaimRow = QueryResultRow & {
  target_id: string
  worker_id: string
  lease_token: string
  organization_id: string
  integration_account_id: string
  account_global_id: string
  external_account_id: string
  credential_version: number
  provider: CommerceOrderRevisionProvider
  order_id: string
  order_global_id: string
  order_row_version: string
  external_order_id: string
  accepted_source_hash: string | null
}

type LockedTargetRow = QueryResultRow & {
  id: string
  organization_id: string
  integration_account_id: string
  order_id: string
  provider: CommerceOrderRevisionProvider
  accepted_source_hash: string | null
  account_global_id: string
  external_account_id: string
  credential_version: number
  order_global_id: string
  order_row_version: string
  external_order_id: string
}

function boundedText(value: unknown, label: string, maximum = 512) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function boundedPositiveInteger(
  value: unknown,
  label: string,
  maximum = 100,
) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return Number(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedClaim(row: ClaimRow): CommerceOrderRevisionClaim {
  return Object.freeze({
    targetId: row.target_id,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    organizationId: row.organization_id,
    integrationAccountId: row.integration_account_id,
    accountGlobalId: row.account_global_id,
    externalAccountId: row.external_account_id,
    credentialVersion: Number(row.credential_version),
    provider: row.provider,
    canonicalOrderId: row.order_id,
    canonicalOrderGlobalId: row.order_global_id,
    canonicalOrderRowVersion: Number(row.order_row_version),
    externalOrderId: row.external_order_id,
    acceptedSourceHash: row.accepted_source_hash,
  })
}

function validateClaim(claim: CommerceOrderRevisionClaim) {
  if (
    !UUID.test(claim.targetId)
    || !UUID.test(claim.leaseToken)
    || !UUID.test(claim.organizationId)
    || !UUID.test(claim.integrationAccountId)
    || !UUID.test(claim.canonicalOrderId)
    || !GLOBAL_ACCOUNT_ID.test(claim.accountGlobalId)
    || !GLOBAL_ORDER_ID.test(claim.canonicalOrderGlobalId)
    || !['shopify', 'faire'].includes(claim.provider)
    || !Number.isSafeInteger(claim.credentialVersion)
    || claim.credentialVersion < 1
    || !Number.isSafeInteger(claim.canonicalOrderRowVersion)
    || claim.canonicalOrderRowVersion < 0
    || (claim.acceptedSourceHash !== null && !SHA256.test(claim.acceptedSourceHash))
  ) throw new Error('Commerce order revision claim is invalid')
  boundedText(claim.workerId, 'Commerce order revision worker ID', 200)
  boundedText(claim.externalAccountId, 'Commerce external account ID', 255)
  boundedText(claim.externalOrderId, 'Commerce external order ID')
}

export async function claimCommerceOrderRevisionTargetsInPostgres(input: {
  provider: CommerceOrderRevisionProvider
  workerId: string
  limit?: number
}): Promise<CommerceOrderRevisionClaim[]> {
  if (!commerceReadRuntimeAvailable()) return []
  const provider = input.provider
  if (!['shopify', 'faire'].includes(provider)) {
    throw new Error('Commerce order revision provider is invalid')
  }
  const workerId = boundedText(
    input.workerId,
    'Commerce order revision worker ID',
    200,
  )
  const limit = boundedPositiveInteger(input.limit ?? 5, 'Claim limit', 25)
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET claim_state = CASE WHEN attempt_count >= 8 THEN 'dead_letter' ELSE 'failed' END,
           locked_by = NULL,
           lock_token = NULL,
           locked_until = NULL,
           next_check_at = now(),
           last_error_code = 'COMMERCE_ORDER_REVISION_LEASE_EXPIRED',
           row_version = row_version + 1,
           updated_at = now()
       WHERE provider = $1
         AND claim_state = 'processing'
         AND locked_until <= now()`,
      [provider],
    )
    const claimed = await client.query<ClaimRow>(
      `WITH candidates AS (
         SELECT target.id
         FROM operations_commerce_order_revision_targets target
         JOIN operations_orders order_row
           ON order_row.organization_id = target.organization_id
          AND order_row.id = target.order_id
         JOIN operations_integration_accounts account
           ON account.organization_id = target.organization_id
          AND account.id = target.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         WHERE target.provider = $1
           AND target.claim_state IN ('pending', 'ready', 'failed')
           AND target.attempt_count < 8
           AND target.next_check_at <= now()
           AND order_row.source_provider = target.provider
           AND order_row.status NOT IN ('shipped', 'cancelled')
           AND order_row.integration_account_id = target.integration_account_id
           AND account.provider = target.provider
           AND account.integration_type = 'commerce'
           AND account.external_account_id IS NOT NULL
           AND ${READABLE_ACCOUNT_SQL}
           AND credential.verification_status = 'verified'
           AND credential.credential_version = account.commerce_credential_generation
           AND credential.external_account_id = account.external_account_id
         ORDER BY target.next_check_at, target.id
         FOR UPDATE OF target SKIP LOCKED
         LIMIT $2
       ), updated AS (
         UPDATE operations_commerce_order_revision_targets target
         SET claim_state = 'processing',
             attempt_count = target.attempt_count + 1,
             locked_by = $3,
             lock_token = gen_random_uuid(),
             locked_until = now() + interval '${REVISION_LEASE}',
             last_error_code = NULL,
             row_version = target.row_version + 1,
             updated_at = now()
         FROM candidates
         WHERE target.id = candidates.id
         RETURNING target.*
       )
       SELECT
         updated.id::text AS target_id,
         $3::text AS worker_id,
         updated.lock_token::text AS lease_token,
         updated.organization_id::text,
         updated.integration_account_id::text,
         account.global_id AS account_global_id,
         account.external_account_id,
         account.commerce_credential_generation AS credential_version,
         updated.provider,
         order_row.id::text AS order_id,
         order_row.global_id AS order_global_id,
         order_row.row_version::text AS order_row_version,
         order_row.external_order_id,
         updated.accepted_source_hash
       FROM updated
       JOIN operations_orders order_row
         ON order_row.organization_id = updated.organization_id
        AND order_row.id = updated.order_id
       JOIN operations_integration_accounts account
         ON account.organization_id = updated.organization_id
        AND account.id = updated.integration_account_id
       ORDER BY updated.next_check_at, updated.id`,
      [provider, limit, workerId],
    )
    return claimed.rows.map(normalizedClaim)
  })
}

function validatedObservation(input: CommerceOrderRevisionObservationInput) {
  validateClaim(input.claim)
  const sourceRevision = boundedText(input.sourceRevision, 'Source revision')
  if (!SHA256.test(input.sourceHash) || !SHA256.test(input.revisionHash)) {
    throw new Error('Commerce order revision hashes are invalid')
  }
  if (input.providerWrites !== 0) {
    throw new Error('Commerce order revision capture crossed its provider-write fence')
  }
  const providerReads = boundedPositiveInteger(
    input.providerReads,
    'Provider read count',
    4,
  )
  const observedAt = new Date(input.observedAt)
  if (Number.isNaN(observedAt.getTime())) {
    throw new Error('Commerce order revision observation time is invalid')
  }
  const snapshot = jsonRecord(input.normalizedSnapshot)
  if (!snapshot) throw new Error('Commerce order revision snapshot is invalid')
  const serialized = canonicalJson(snapshot)
  if (Buffer.byteLength(serialized, 'utf8') > 262_144) {
    throw new Error('Commerce order revision snapshot exceeds its retention bound')
  }
  const order = jsonRecord(snapshot.order)
  const canonicalStates = jsonRecord(order?.canonicalStates)
  if (
    snapshot.provider !== input.claim.provider
    || snapshot.accountGlobalId !== input.claim.accountGlobalId
    || snapshot.integrationAccountId !== input.claim.integrationAccountId
    || snapshot.credentialVersion !== input.claim.credentialVersion
    || snapshot.canonicalOrderGlobalId !== input.claim.canonicalOrderGlobalId
    || snapshot.canonicalOrderRowVersion !== input.claim.canonicalOrderRowVersion
    || order?.externalOrderId !== input.claim.externalOrderId
    || order.sourceHash !== input.sourceHash
    || !canonicalStates
  ) throw new Error('Commerce order revision snapshot does not match its claim')
  if (commerceOrderRevisionHash(snapshot) !== input.revisionHash) {
    throw new Error('Commerce order revision evidence hash is invalid')
  }
  return {
    sourceRevision,
    providerReads,
    observedAt: observedAt.toISOString(),
    snapshot,
    lifecycle: String(canonicalStates.lifecycle || ''),
    fulfillment: String(canonicalStates.fulfillment || ''),
  }
}

function materialState(input: {
  changed: boolean
  lifecycle: string
  fulfillment: string
}): CommerceOrderRevisionMaterialState {
  if (!input.changed) return 'current'
  if (input.lifecycle === 'cancelled') return 'provider_cancelled'
  if (input.fulfillment === 'fulfilled') return 'provider_fulfilled'
  return 'review_required'
}

async function upsertRevisionException(
  client: PoolClient,
  input: {
    target: LockedTargetRow
    observationGlobalId: string
    sourceHash: string
    revisionHash: string
    canonicalRowVersion: number
    state: CommerceOrderRevisionMaterialState
    providerReads: number
  },
) {
  const active = await client.query<{ id: string }>(
    `SELECT id::text
     FROM operations_exceptions
     WHERE organization_id = $1::uuid
       AND order_id = $2::uuid
       AND exception_type = $3
       AND status IN ('open', 'acknowledged')
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [input.target.organization_id, input.target.order_id, REVISION_EXCEPTION_TYPE],
  )
  if (input.state === 'current') {
    if (active.rows[0]) {
      await client.query(
        `UPDATE operations_exceptions
         SET status = 'resolved', resolved_at = now(), updated_at = now(),
             details = details || $2::jsonb
         WHERE id = $1::uuid`,
        [active.rows[0].id, JSON.stringify({
          resolution: 'provider_revision_current',
          observationGlobalId: input.observationGlobalId,
        })],
      )
    }
    return
  }
  const details = {
    provider: input.target.provider,
    orderGlobalId: input.target.order_global_id,
    observationGlobalId: input.observationGlobalId,
    sourceHash: input.sourceHash,
    revisionHash: input.revisionHash,
    canonicalRowVersion: input.canonicalRowVersion,
    materialState: input.state,
    managerDispositionRequired: true,
    cancellationDispositionAvailable: input.state === 'provider_cancelled',
    recommendedAction: input.state === 'provider_cancelled'
      ? 'Accept the provider cancellation only if this imported order has no warehouse or shipping work.'
      : 'Review this provider change. Header and line edits are not automatically applied.',
    providerReads: input.providerReads,
    providerWrites: 0,
  }
  const title = input.state === 'provider_cancelled'
    ? 'Provider cancelled this order'
    : input.state === 'provider_fulfilled'
      ? 'Provider fulfilled this order outside ClawPilot'
      : 'Provider order changed after import'
  if (active.rows[0]) {
    await client.query(
      `UPDATE operations_exceptions
       SET severity = 'critical', status = 'open', title = $2,
           details = $3::jsonb, resolved_by = NULL, resolved_at = NULL,
           updated_at = now()
       WHERE id = $1::uuid`,
      [active.rows[0].id, title, JSON.stringify(details)],
    )
    return
  }
  await client.query(
    `INSERT INTO operations_exceptions (
       organization_id, order_id, exception_type, severity, status,
       title, details
     ) VALUES ($1::uuid, $2::uuid, $3, 'critical', 'open', $4, $5::jsonb)`,
    [
      input.target.organization_id,
      input.target.order_id,
      REVISION_EXCEPTION_TYPE,
      title,
      JSON.stringify(details),
    ],
  )
}

export async function captureCommerceOrderRevisionObservationInPostgres(
  input: CommerceOrderRevisionObservationInput,
): Promise<CommerceOrderRevisionCaptureResult> {
  const observation = validatedObservation(input)
  return withTransaction(async (client) => {
    // Match the Operations command lock order: canonical order first, then
    // revision target. This prevents order->target versus target->order
    // deadlocks while making capture row-version checks atomic.
    const canonicalLock = await client.query<{ id: string }>(
      `SELECT id::text
       FROM operations_orders
       WHERE organization_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [input.claim.organizationId, input.claim.canonicalOrderId],
    )
    if (!canonicalLock.rows[0]) {
      throw new Error('Commerce order revision canonical order is unavailable')
    }
    const locked = await client.query<LockedTargetRow>(
      `SELECT
         target.id::text,
         target.organization_id::text,
         target.integration_account_id::text,
         target.order_id::text,
         target.provider,
         target.accepted_source_hash,
         account.global_id AS account_global_id,
         account.external_account_id,
         account.commerce_credential_generation AS credential_version,
         order_row.global_id AS order_global_id,
         order_row.row_version::text AS order_row_version,
         order_row.external_order_id
       FROM operations_commerce_order_revision_targets target
       JOIN operations_orders order_row
         ON order_row.organization_id = target.organization_id
        AND order_row.id = target.order_id
       JOIN operations_integration_accounts account
         ON account.organization_id = target.organization_id
        AND account.id = target.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE target.id = $1::uuid
         AND target.organization_id = $2::uuid
         AND target.claim_state = 'processing'
         AND target.locked_by = $3
         AND target.lock_token = $4::uuid
         AND target.locked_until > now()
         AND credential.verification_status = 'verified'
         AND credential.credential_version = account.commerce_credential_generation
       FOR UPDATE OF target, account, credential`,
      [
        input.claim.targetId,
        input.claim.organizationId,
        input.claim.workerId,
        input.claim.leaseToken,
      ],
    )
    const target = locked.rows[0]
    if (
      !target
      || target.integration_account_id !== input.claim.integrationAccountId
      || target.order_id !== input.claim.canonicalOrderId
      || target.provider !== input.claim.provider
      || target.account_global_id !== input.claim.accountGlobalId
      || target.external_account_id !== input.claim.externalAccountId
      || Number(target.credential_version) !== input.claim.credentialVersion
      || target.order_global_id !== input.claim.canonicalOrderGlobalId
      || Number(target.order_row_version) !== input.claim.canonicalOrderRowVersion
      || target.external_order_id !== input.claim.externalOrderId
    ) throw new Error('Commerce order revision claim is stale or lost')

    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_order_revision_observations (
         organization_id, integration_account_id, target_id, order_id,
         provider, credential_generation, external_order_id, source_revision,
         source_hash, revision_hash, normalized_snapshot, canonical_row_version,
         provider_read_count, provider_write_count, observed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5, $6, $7, $8,
         $9, $10, $11::jsonb, $12,
         $13, 0, $14::timestamptz
       )
       ON CONFLICT (organization_id, integration_account_id, order_id, source_hash)
       DO NOTHING
       RETURNING id::text, global_id`,
      [
        target.organization_id,
        target.integration_account_id,
        target.id,
        target.order_id,
        target.provider,
        input.claim.credentialVersion,
        target.external_order_id,
        observation.sourceRevision,
        input.sourceHash,
        input.revisionHash,
        JSON.stringify(observation.snapshot),
        input.claim.canonicalOrderRowVersion,
        observation.providerReads,
        observation.observedAt,
      ],
    )
    const retained = inserted.rows[0] || (await client.query<{
      id: string
      global_id: string
      revision_hash: string
    }>(
      `SELECT id::text, global_id, revision_hash
       FROM operations_commerce_order_revision_observations
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND order_id = $3::uuid
         AND source_hash = $4`,
      [
        target.organization_id,
        target.integration_account_id,
        target.order_id,
        input.sourceHash,
      ],
    )).rows[0]
    if (!retained) throw new Error('Commerce order revision evidence was not retained')
    if ('revision_hash' in retained && retained.revision_hash !== input.revisionHash) {
      throw new Error('Retained commerce order revision evidence conflicts with this read')
    }

    const changed = target.accepted_source_hash !== input.sourceHash
    const state = materialState({
      changed,
      lifecycle: observation.lifecycle,
      fulfillment: observation.fulfillment,
    })
    await upsertRevisionException(client, {
      target,
      observationGlobalId: retained.global_id,
      sourceHash: input.sourceHash,
      revisionHash: input.revisionHash,
      canonicalRowVersion: input.claim.canonicalOrderRowVersion,
      state,
      providerReads: observation.providerReads,
    })
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET latest_source_hash = $2,
           latest_observation_id = $3::uuid,
           material_state = $4,
           claim_state = 'ready',
           attempt_count = 0,
           next_check_at = now() + interval '${REVISION_INTERVAL}',
           checked_at = $5::timestamptz,
           locked_by = NULL,
           lock_token = NULL,
           locked_until = NULL,
           last_error_code = NULL,
           row_version = row_version + 1,
           updated_at = now()
       WHERE id = $1::uuid`,
      [target.id, input.sourceHash, retained.id, state, observation.observedAt],
    )
    return Object.freeze({
      observationGlobalId: retained.global_id,
      sourceHash: input.sourceHash,
      changed,
      materialState: state,
      managerDispositionRequired: state !== 'current',
      providerReads: observation.providerReads,
      providerWrites: 0 as const,
    })
  })
}

export async function failCommerceOrderRevisionTargetInPostgres(input: {
  claim: CommerceOrderRevisionClaim
  workerId: string
  errorCode: string
}) {
  validateClaim(input.claim)
  const workerId = boundedText(input.workerId, 'Commerce order revision worker ID', 200)
  if (workerId !== input.claim.workerId || !ERROR_CODE.test(input.errorCode)) {
    throw new Error('Commerce order revision failure is invalid')
  }
  const result = await query<{ claim_state: 'failed' | 'dead_letter' }>(
    `UPDATE operations_commerce_order_revision_targets
     SET claim_state = CASE WHEN attempt_count >= 8 THEN 'dead_letter' ELSE 'failed' END,
         next_check_at = now() + make_interval(mins => LEAST(30, GREATEST(1, attempt_count * 2))),
         locked_by = NULL,
         lock_token = NULL,
         locked_until = NULL,
         last_error_code = $5,
         row_version = row_version + 1,
         updated_at = now()
     WHERE id = $1::uuid
       AND organization_id = $2::uuid
       AND claim_state = 'processing'
       AND locked_by = $3
       AND lock_token = $4::uuid
     RETURNING claim_state`,
    [
      input.claim.targetId,
      input.claim.organizationId,
      workerId,
      input.claim.leaseToken,
      input.errorCode,
    ],
  )
  return result.rows[0]?.claim_state || null
}

export class CommerceOrderRevisionGateError extends Error {
  readonly code: string
  readonly status: number

  constructor(
    code: string,
    message: string,
    status = 409,
  ) {
    super(message)
    this.name = 'CommerceOrderRevisionGateError'
    this.code = code
    this.status = status
  }
}

export async function assertCommerceOrderRevisionExecutionCurrent(
  client: PoolClient,
  input: {
    organizationId: string
    orderId: string
    operation:
      | 'plan'
      | 'release'
      | 'assign'
      | 'pick'
      | 'pack'
      | 'prepare_fulfillment'
      | 'rate'
      | 'select_rate'
      | 'label'
      | 'packing_slip'
      | 'ship'
      | 'export'
  },
) {
  if (!UUID.test(input.organizationId) || !UUID.test(input.orderId)) {
    throw new CommerceOrderRevisionGateError(
      'COMMERCE_ORDER_REVISION_GATE_INVALID',
      'Commerce order revision gate input is invalid',
      400,
    )
  }
  const orderResult = await client.query<{ source_provider: string }>(
    `SELECT source_provider
     FROM operations_orders
     WHERE organization_id = $1::uuid AND id = $2::uuid
     FOR SHARE`,
    [input.organizationId, input.orderId],
  )
  const order = orderResult.rows[0]
  if (!order || !['shopify', 'faire'].includes(order.source_provider)) return
  const result = await client.query<{
    material_state: CommerceOrderRevisionMaterialState | null
    claim_state: string | null
    checked_at: Date | null
    fresh: boolean | null
  }>(
    `SELECT
       target.material_state,
       target.claim_state,
       target.checked_at,
       CASE
         WHEN target.checked_at IS NULL THEN false
         ELSE target.checked_at >= now() - interval '${REVISION_FRESHNESS}'
       END AS fresh
     FROM operations_commerce_order_revision_targets target
     WHERE target.organization_id = $1::uuid
       AND target.order_id = $2::uuid
     FOR SHARE`,
    [input.organizationId, input.orderId],
  )
  const row = result.rows[0]
  const changedProjection = row && row.material_state !== 'current'
  // Phase 1 activates material-change blocking immediately. Missing, due, or
  // failed backstop coverage remains visible in health but does not create a
  // migration-time execution outage. Freshness becomes a hard authority only
  // in the separately promoted strict mode.
  const strictCoverage = process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT === '1'
  if (
    !row
      ? strictCoverage
      : changedProjection
        || (strictCoverage && (
          row.claim_state !== 'ready'
          || row.fresh !== true
        ))
  ) {
    throw new CommerceOrderRevisionGateError(
      'COMMERCE_ORDER_REVISION_REVIEW_REQUIRED',
      `Cannot ${input.operation} this order until its latest provider revision is current or a manager resolves it`,
    )
  }
}

type CancellationDispositionRow = QueryResultRow & {
  global_id: string
  order_global_id: string
  observation_global_id: string
  source_hash: string
  revision_hash: string
  expected_order_row_version: string
  provider_read_count: number
  request_hash: string
}

function cancellationDispositionResult(
  row: CancellationDispositionRow,
  replayed: boolean,
): CommerceOrderRevisionCancellationResult {
  if (
    !GLOBAL_DISPOSITION_ID.test(row.global_id)
    || !GLOBAL_ORDER_ID.test(row.order_global_id)
    || !GLOBAL_OBSERVATION_ID.test(row.observation_global_id)
    || !SHA256.test(row.source_hash)
    || !SHA256.test(row.revision_hash)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_CANCELLATION_RESULT_INVALID',
      'The retained provider cancellation result is invalid',
      500,
    )
  }
  const previousRowVersion = Number(row.expected_order_row_version)
  return Object.freeze({
    dispositionGlobalId: row.global_id,
    orderGlobalId: row.order_global_id,
    observationGlobalId: row.observation_global_id,
    sourceHash: row.source_hash,
    revisionHash: row.revision_hash,
    previousStatus: 'imported' as const,
    status: 'cancelled' as const,
    previousRowVersion,
    newRowVersion: previousRowVersion + 1,
    replayed,
    providerReads: Number(row.provider_read_count),
    providerWrites: 0 as const,
  })
}

/**
 * Accepts only an exact provider cancellation for an imported canonical order
 * that has no downstream execution evidence. This is a local projection: it
 * performs no Shopify or Faire write and does not apply arbitrary order edits.
 */
export async function cancelUnstartedCommerceOrderFromProviderRevisionInPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  observationGlobalId: string
  expectedSourceHash: string
  expectedRevisionHash: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<CommerceOrderRevisionCancellationResult> {
  let actorEmail = ''
  let reason = ''
  try {
    actorEmail = boundedText(input.actorEmail, 'Actor email', 320)
    reason = boundedText(input.reason, 'Provider cancellation reason', 500)
  } catch {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_CANCELLATION_INVALID',
      'Provider cancellation input is invalid',
      400,
    )
  }
  if (
    !UUID.test(input.organizationId)
    || !GLOBAL_ORDER_ID.test(input.orderGlobalId)
    || !GLOBAL_OBSERVATION_ID.test(input.observationGlobalId)
    || !SHA256.test(input.expectedSourceHash)
    || !SHA256.test(input.expectedRevisionHash)
    || !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_CANCELLATION_INVALID',
      'Provider cancellation input is invalid',
      400,
    )
  }
  const requestHash = createHash('sha256').update(canonicalJson({
    action: 'cancel_unstarted_order',
    organizationId: input.organizationId,
    actorEmail,
    orderGlobalId: input.orderGlobalId,
    observationGlobalId: input.observationGlobalId,
    expectedSourceHash: input.expectedSourceHash,
    expectedRevisionHash: input.expectedRevisionHash,
    expectedRowVersion: input.expectedRowVersion,
    reason,
  })).digest('hex')

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-revision-cancellation:${input.organizationId}:${input.idempotencyKey}`,
    )
    const existing = await client.query<CancellationDispositionRow>(
      `SELECT
         disposition.global_id,
         order_row.global_id AS order_global_id,
         observation.global_id AS observation_global_id,
         disposition.source_hash,
         disposition.revision_hash,
         disposition.expected_order_row_version::text,
         disposition.provider_read_count,
         disposition.request_hash
       FROM operations_commerce_order_revision_dispositions disposition
       JOIN operations_orders order_row
         ON order_row.organization_id = disposition.organization_id
        AND order_row.id = disposition.order_id
       JOIN operations_commerce_order_revision_observations observation
         ON observation.organization_id = disposition.organization_id
        AND observation.id = disposition.observation_id
       WHERE disposition.organization_id = $1::uuid
         AND disposition.idempotency_key = $2
       FOR UPDATE OF disposition`,
      [input.organizationId, input.idempotencyKey],
    )
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for a different provider cancellation',
        )
      }
      return cancellationDispositionResult(existing.rows[0], true)
    }

    await acquireTransactionAdvisoryLock(
      client,
      `operations:order:${input.organizationId}:${input.orderGlobalId}`,
    )

    const orderResult = await client.query<{
      id: string
      global_id: string
      integration_account_id: string
      source_provider: string
      status: string
      row_version: string
    }>(
      `SELECT id::text, global_id, integration_account_id::text,
              source_provider, status, row_version::text
       FROM operations_orders
       WHERE organization_id = $1::uuid AND global_id = $2
       FOR UPDATE`,
      [input.organizationId, input.orderGlobalId],
    )
    const order = orderResult.rows[0]
    if (!order || !['shopify', 'faire'].includes(order.source_provider)) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_ORDER_NOT_FOUND',
        'The imported Shopify or Faire order is unavailable',
        404,
      )
    }
    if (Number(order.row_version) !== input.expectedRowVersion) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_STALE',
        'The order changed after this provider cancellation was reviewed',
      )
    }
    if (order.status !== 'imported') {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_NOT_UNSTARTED',
        'Only an imported order with no warehouse work may accept a provider cancellation',
      )
    }

    const revision = await client.query<{
      target_id: string
      integration_account_id: string
      provider: CommerceOrderRevisionProvider
      observation_id: string
      observation_global_id: string
      source_hash: string
      revision_hash: string
      canonical_row_version: string
      provider_read_count: number
    }>(
      `SELECT
         target.id::text AS target_id,
         target.integration_account_id::text,
         target.provider,
         observation.id::text AS observation_id,
         observation.global_id AS observation_global_id,
         observation.source_hash,
         observation.revision_hash,
         observation.canonical_row_version::text,
         observation.provider_read_count
       FROM operations_commerce_order_revision_targets target
       JOIN operations_commerce_order_revision_observations observation
         ON observation.organization_id = target.organization_id
        AND observation.id = target.latest_observation_id
       WHERE target.organization_id = $1::uuid
         AND target.order_id = $2::uuid
         AND target.integration_account_id = $3::uuid
         AND target.provider = $4
         AND target.claim_state = 'ready'
         AND target.material_state = 'provider_cancelled'
         AND target.latest_source_hash = $5
         AND target.accepted_source_hash <> $5
         AND target.checked_at >= now() - interval '${REVISION_FRESHNESS}'
         AND observation.global_id = $6
         AND observation.source_hash = $5
         AND observation.revision_hash = $7
         AND observation.canonical_row_version = $8
         AND observation.provider_write_count = 0
         AND observation.observed_at >= now() - interval '${REVISION_FRESHNESS}'
         AND observation.normalized_snapshot #>> '{order,canonicalStates,lifecycle}' = 'cancelled'
       FOR UPDATE OF target`,
      [
        input.organizationId,
        order.id,
        order.integration_account_id,
        order.source_provider,
        input.expectedSourceHash,
        input.observationGlobalId,
        input.expectedRevisionHash,
        input.expectedRowVersion,
      ],
    )
    const exactRevision = revision.rows[0]
    if (!exactRevision) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_EVIDENCE_STALE',
        'Refresh the provider revision before accepting this cancellation',
      )
    }

    const downstream = await client.query<{
      plans: boolean
      reservations: boolean
      picks: boolean
      packages: boolean
      labels: boolean
      shipments: boolean
      exports: boolean
      shadow_executions: boolean
      active_executions: boolean
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM operations_fulfillment_plans row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS plans,
         EXISTS (SELECT 1 FROM operations_reservations row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS reservations,
         EXISTS (SELECT 1 FROM operations_pick_tasks row
                 JOIN operations_fulfillment_plans plan
                   ON plan.organization_id = row.organization_id AND plan.id = row.plan_id
                 WHERE plan.organization_id = $1::uuid AND plan.order_id = $2::uuid) AS picks,
         EXISTS (SELECT 1 FROM operations_packages row
                 JOIN operations_fulfillment_plans plan
                   ON plan.organization_id = row.organization_id AND plan.id = row.plan_id
                 WHERE plan.organization_id = $1::uuid AND plan.order_id = $2::uuid) AS packages,
         EXISTS (SELECT 1 FROM operations_labels row
                 JOIN operations_packages package
                   ON package.organization_id = row.organization_id AND package.id = row.package_id
                 JOIN operations_fulfillment_plans plan
                   ON plan.organization_id = package.organization_id AND plan.id = package.plan_id
                 WHERE plan.organization_id = $1::uuid AND plan.order_id = $2::uuid) AS labels,
         EXISTS (SELECT 1 FROM operations_shipments row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS shipments,
         EXISTS (SELECT 1 FROM operations_commerce_fulfillment_exports row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS exports,
         EXISTS (SELECT 1 FROM operations_fulfillment_executions row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS shadow_executions,
         EXISTS (SELECT 1 FROM operations_active_fulfillment_executions row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS active_executions`,
      [input.organizationId, order.id],
    )
    if (Object.values(downstream.rows[0] || {}).some(Boolean)) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_STARTED',
        'This order has warehouse, label, shipment, or export evidence and cannot be cancelled automatically',
      )
    }

    const disposition = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_order_revision_dispositions (
         organization_id, integration_account_id, target_id, observation_id,
         order_id, provider, action, idempotency_key, request_hash,
         expected_order_row_version, previous_status, resulting_status,
         source_hash, revision_hash, reason, provider_read_count,
         provider_write_count, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6, 'cancel_unstarted_order', $7, $8,
         $9, 'imported', 'cancelled',
         $10, $11, $12, $13,
         0, $14
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        exactRevision.integration_account_id,
        exactRevision.target_id,
        exactRevision.observation_id,
        order.id,
        exactRevision.provider,
        input.idempotencyKey,
        requestHash,
        input.expectedRowVersion,
        input.expectedSourceHash,
        input.expectedRevisionHash,
        reason,
        exactRevision.provider_read_count,
        actorEmail,
      ],
    )
    const retainedDisposition = disposition.rows[0]
    if (!retainedDisposition || !GLOBAL_DISPOSITION_ID.test(retainedDisposition.global_id)) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_NOT_RETAINED',
        'The provider cancellation disposition was not retained',
        500,
      )
    }

    await client.query(
      `UPDATE operations_orders
       SET status = 'cancelled', row_version = row_version + 1,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, order.id, actorEmail],
    )
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET accepted_source_hash = $3,
           material_state = 'current',
           claim_state = 'ready',
           attempt_count = 0,
           next_check_at = now() + interval '${REVISION_INTERVAL}',
           locked_by = NULL,
           locked_until = NULL,
           last_error_code = NULL,
           row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, exactRevision.target_id, input.expectedSourceHash],
    )
    await client.query(
      `UPDATE operations_exceptions
       SET status = 'resolved', resolved_by = $4, resolved_at = now(),
           updated_at = now(),
           details = details || $5::jsonb
       WHERE id = (
         SELECT id
         FROM operations_exceptions
         WHERE organization_id = $1::uuid
           AND order_id = $2::uuid
           AND exception_type = $3
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )`,
      [
        input.organizationId,
        order.id,
        REVISION_EXCEPTION_TYPE,
        actorEmail,
        JSON.stringify({
          resolution: 'provider_cancellation_accepted',
          dispositionGlobalId: retainedDisposition.global_id,
          acceptedSourceHash: input.expectedSourceHash,
          providerWrites: 0,
        }),
      ],
    )
    await client.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id, aggregate_global_id,
         event_type, event_version, payload, actor_email, correlation_id,
         idempotency_key
       ) VALUES (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.order.cancelled_from_provider_revision', 1, $4::jsonb,
         $5, $6::uuid, $7
       )`,
      [
        input.organizationId,
        order.id,
        order.global_id,
        JSON.stringify({
          dispositionGlobalId: retainedDisposition.global_id,
          observationGlobalId: exactRevision.observation_global_id,
          provider: exactRevision.provider,
          sourceHash: input.expectedSourceHash,
          revisionHash: input.expectedRevisionHash,
          previousStatus: 'imported',
          status: 'cancelled',
          previousRowVersion: input.expectedRowVersion,
          newRowVersion: input.expectedRowVersion + 1,
          providerReads: exactRevision.provider_read_count,
          providerWrites: 0,
        }),
        actorEmail,
        randomUUID(),
        `commerce-provider-cancel:${requestHash}`,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.order.cancelled_from_provider_revision',
      aggregateType: 'operations.order',
      aggregateId: order.global_id,
      organizationId: input.organizationId,
      eventKey: `commerce-order-revision-disposition:${retainedDisposition.global_id}`,
      payload: {
        dispositionGlobalId: retainedDisposition.global_id,
        observationGlobalId: exactRevision.observation_global_id,
        provider: exactRevision.provider,
        sourceHash: input.expectedSourceHash,
        revisionHash: input.expectedRevisionHash,
        providerReads: exactRevision.provider_read_count,
        providerWrites: 0,
      },
    }, client)

    return cancellationDispositionResult({
      global_id: retainedDisposition.global_id,
      order_global_id: order.global_id,
      observation_global_id: exactRevision.observation_global_id,
      source_hash: input.expectedSourceHash,
      revision_hash: input.expectedRevisionHash,
      expected_order_row_version: String(input.expectedRowVersion),
      provider_read_count: exactRevision.provider_read_count,
      request_hash: requestHash,
    }, false)
  })
}

export async function readCommerceOrderRevisionHealthFromPostgres() {
  const result = await query<{
    provider: CommerceOrderRevisionProvider
    claim_state: string
    material_state: CommerceOrderRevisionMaterialState
    count: string
    overdue_count: string
    stale_count: string
  }>(
    `SELECT provider, claim_state, material_state,
            count(*)::text AS count,
            count(*) FILTER (
              WHERE target.next_check_at < now() - interval '${REVISION_OVERDUE_GRACE}'
            )::text
              AS overdue_count,
            count(*) FILTER (
              WHERE target.checked_at IS NULL
                 OR target.checked_at < now() - interval '${REVISION_FRESHNESS}'
            )::text AS stale_count
     FROM operations_commerce_order_revision_targets target
     JOIN operations_orders order_row
       ON order_row.organization_id = target.organization_id
      AND order_row.id = target.order_id
     WHERE order_row.status NOT IN ('shipped', 'cancelled')
     GROUP BY provider, claim_state, material_state
     ORDER BY provider, claim_state, material_state`,
  )
  const targets = result.rows.map((row) => ({
    provider: row.provider,
    claimState: row.claim_state,
    materialState: row.material_state,
    count: Number(row.count),
    overdue: Number(row.overdue_count),
    stale: Number(row.stale_count),
  }))
  const summary = targets.reduce((current, row) => ({
    active: current.active + row.count,
    failed: current.failed + (row.claimState === 'failed' ? row.count : 0),
    deadLetter:
      current.deadLetter + (row.claimState === 'dead_letter' ? row.count : 0),
    materialReviewRequired:
      current.materialReviewRequired
      + (row.materialState !== 'current' ? row.count : 0),
    overdue: current.overdue + row.overdue,
    stale: current.stale + row.stale,
  }), {
    active: 0,
    failed: 0,
    deadLetter: 0,
    materialReviewRequired: 0,
    overdue: 0,
    stale: 0,
  })
  return {
    checkedAt: new Date().toISOString(),
    status: (
      summary.failed > 0
      || summary.deadLetter > 0
      || summary.materialReviewRequired > 0
      || summary.overdue > 0
      || summary.stale > 0
    ) ? 'degraded' as const : 'ready' as const,
    providerWrites: 0 as const,
    summary,
    targets,
  }
}
