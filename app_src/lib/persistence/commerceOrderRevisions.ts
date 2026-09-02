import type { PoolClient, QueryResultRow } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import {
  commerceOrderRevisionEvidenceKeyAvailable,
  commerceOrderRevisionProtectedContentFingerprint,
  commerceOrderRevisionProtectedSnapshotDigest,
  decryptCommerceOrderRevisionProtectedSnapshot,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  resolveCommerceOrderRevisionEvidenceKeyConfig,
  summarizeCommerceOrderRevisionEvidenceKeyReadiness,
} from '@/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'
import {
  commerceOrderRevisionHash,
} from '@/lib/integrations/commerceOrderRevisionEvidence'
export { commerceOrderRevisionHash } from '@/lib/integrations/commerceOrderRevisionEvidence'
import {
  commerceReadAccountSql,
  commerceReadRuntimeAvailable,
} from '@/lib/integrations/commerceReadRuntime'
import { commerceStoreSyncRunningSql } from '@/lib/operations/commerceStoreSync'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'
import {
  assertCommerceStoreSyncProviderReadLeaseCurrentWithClient,
  type CommerceStoreSyncProviderReadLease,
} from '@/lib/persistence/commerceStoreSync'
import { isHostedRuntime } from '@/lib/persistence/config'

const REVISION_INTERVAL = '30 minutes'
const REVISION_FRESHNESS = '35 minutes'
const REVISION_OVERDUE_GRACE = '5 minutes'
const REVISION_LEASE = '5 minutes'
const REVISION_EXCEPTION_TYPE = 'commerce_order_revision_required'
const REVISION_APPLY_MIGRATION =
  '0274_operations_commerce_order_revision_apply.sql'
const PROTECTED_SNAPSHOT_PURGE_DEFAULT_LIMIT = 250
const PROTECTED_SNAPSHOT_PURGE_MAX_LIMIT = 500
const PROTECTED_SNAPSHOT_BACKLOG_LIMIT = 5_000
const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const GLOBAL_ORDER_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_ACCOUNT_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_OBSERVATION_ID = /^gcor(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_READ_ID = /^gcrr(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_DISPOSITION_ID = /^gcod(?:[0-9]{7}|[0-9a-v]{12})$/u
const GLOBAL_APPLICATION_ID = /^gcoa(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u
const READABLE_ACCOUNT_SQL = commerceReadAccountSql('account')
const STORE_SYNC_RUNNING_SQL = commerceStoreSyncRunningSql('account')

export type CommerceOrderRevisionProvider = 'shopify' | 'faire'

export class CommerceOrderRevisionStoreSyncPausedError extends Error {
  readonly code = 'COMMERCE_ORDER_REVISION_STORE_SYNC_PAUSED'
}
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
  providerReadLease: CommerceStoreSyncProviderReadLease
  sourceRevision: string
  sourceHash: string
  revisionHash: string
  normalizedSnapshot: Record<string, unknown>
  protectedParty?: CommerceOrderRevisionProtectedSnapshot | null
  protectedShipTo?: CommerceOrderRevisionProtectedSnapshot | null
  trigger?: Readonly<{
    kind: 'scheduled'
  }> | Readonly<{
    kind: 'manager'
    commandReceiptId: string
    actorEmail: string
  }>
  providerReads: number
  providerWrites: 0
  observedAt: string
}>

export type CommerceOrderRevisionCaptureResult = Readonly<{
  observationGlobalId: string
  readGlobalId: string
  sourceHash: string
  changed: boolean
  materialState: CommerceOrderRevisionMaterialState
  managerDispositionRequired: boolean
  providerReads: number
  providerWrites: 0
}>

export type CommerceOrderRevisionProtectedSnapshot = Readonly<{
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  hash: string
  contentFingerprint: string
  keyId: string
  encryptionVersion: 1
}>

export type CommerceOrderRevisionCancellationResult = Readonly<{
  dispositionGlobalId: string
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string | null
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

export type CommerceOrderRevisionManagerRefreshPreparation = Readonly<{
  replayed: boolean
  readGlobalId: string | null
  replayedCapture: CommerceOrderRevisionCaptureResult | null
  claim: CommerceOrderRevisionClaim | null
  commandReceiptId: string
}>

export type ManagerCommerceOrderRevisionState = Readonly<{
  eligible: boolean
  provider: CommerceOrderRevisionProvider | null
  orderGlobalId: string
  orderRowVersion: number
  orderStatus: string
  state: null | Readonly<{
    observationGlobalId: string
    readGlobalId: string
    sourceHash: string
    revisionHash: string
    materialState: CommerceOrderRevisionMaterialState
    capturedAt: string
    fresh: boolean
    changed: boolean
    applyEligible: boolean
    applyBlockedCode: string | null
    cancellationEligible: boolean
    providerReads: number
    providerWrites: 0
    applicationGlobalId: string | null
    exceptionGlobalId: string | null
  }>
}>

export type CommerceOrderRevisionApplicationResult = Readonly<{
  applicationGlobalId: string
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string
  sourceHash: string
  revisionHash: string
  previousRowVersion: number
  newRowVersion: number
  replayed: boolean
  providerReads: number
  providerWrites: 0
  changeSummary: Record<string, unknown>
}>

export class CommerceOrderRevisionDispositionError extends Error {
  readonly code: string
  readonly status: number
  readonly retryWithNewIdempotencyKey: boolean

  constructor(
    code: string,
    message: string,
    status = 409,
    retryWithNewIdempotencyKey = false,
  ) {
    super(message)
    this.name = 'CommerceOrderRevisionDispositionError'
    this.code = code
    this.status = status
    this.retryWithNewIdempotencyKey = retryWithNewIdempotencyKey
  }
}

export type CommerceOrderRevisionRefreshCandidate = Readonly<{
  orderGlobalId: string
  orderRowVersion: number
  provider: CommerceOrderRevisionProvider
  totalEligible: number
}>

export type CommerceOrderRevisionScheduleAllResult = Readonly<{
  totalEligible: number
  scheduled: number
  alreadyScheduled: number
  providerWrites: 0
}>

export type CommerceOrderStatusSyncBatchPreparation = Readonly<{
  receiptId: string
  attemptToken: string | null
  candidates: readonly CommerceOrderRevisionRefreshCandidate[]
  replayedResult: Record<string, unknown> | null
}>

type CommerceOrderStatusSyncBatchPayload = Readonly<{
  batchLimit: number
  totalEligible: number
  candidates: readonly CommerceOrderRevisionRefreshCandidate[]
  response?: Record<string, unknown>
}>

const ORDER_STATUS_SYNC_RESULT_KEYS = Object.freeze([
  'batchLimit',
  'canonicalOrderWrites',
  'counts',
  'failedByCode',
  'outcomes',
  'providerWrites',
  'status',
  'totalEligible',
])
const ORDER_STATUS_SYNC_COUNT_KEYS = Object.freeze([
  'attempted',
  'changed',
  'current',
  'failed',
  'providerCancelled',
  'providerFulfilled',
  'providerReads',
  'refreshed',
  'reviewRequired',
  'selected',
])
const ORDER_STATUS_SYNC_OUTCOME_KEYS = Object.freeze([
  'code',
  'orderGlobalId',
  'outcome',
  'provider',
])
const ORDER_STATUS_SYNC_OUTCOMES = new Set([
  'current',
  'review_required',
  'provider_cancelled',
  'provider_fulfilled',
  'failed',
])

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validatedOrderStatusSyncBatchResult(
  value: unknown,
  expected: CommerceOrderStatusSyncBatchPayload,
): Record<string, unknown> {
  const invalid = () => new CommerceOrderRevisionDispositionError(
    'COMMERCE_ORDER_STATUS_SYNC_RESULT_INVALID',
    'The retained order status sync result is invalid',
    500,
  )
  if (!plainRecord(value) || !exactKeys(value, ORDER_STATUS_SYNC_RESULT_KEYS)) {
    throw invalid()
  }
  const counts = value.counts
  const failedByCode = value.failedByCode
  const outcomes = value.outcomes
  if (
    !plainRecord(counts)
    || !exactKeys(counts, ORDER_STATUS_SYNC_COUNT_KEYS)
    || !plainRecord(failedByCode)
    || !Array.isArray(outcomes)
    || !nonnegativeSafeInteger(value.batchLimit)
    || Number(value.batchLimit) < 1
    || Number(value.batchLimit) > 10
    || value.batchLimit !== expected.batchLimit
    || !nonnegativeSafeInteger(value.totalEligible)
    || value.totalEligible !== expected.totalEligible
    || value.providerWrites !== 0
    || value.canonicalOrderWrites !== 0
  ) throw invalid()

  for (const key of ORDER_STATUS_SYNC_COUNT_KEYS) {
    if (!nonnegativeSafeInteger(counts[key])) throw invalid()
  }
  const selected = Number(counts.selected)
  const attempted = Number(counts.attempted)
  const refreshed = Number(counts.refreshed)
  const changed = Number(counts.changed)
  const failed = Number(counts.failed)
  if (
    selected !== expected.candidates.length
    || selected > Number(value.batchLimit)
    || selected > Number(value.totalEligible)
    || attempted !== selected
    || refreshed + failed !== attempted
    || changed > refreshed
    || outcomes.length !== selected
    || Number(counts.current)
      + Number(counts.providerFulfilled)
      + Number(counts.providerCancelled)
      + Number(counts.reviewRequired) !== refreshed
  ) throw invalid()

  const outcomeCounts: Record<string, number> = {
    current: 0,
    review_required: 0,
    provider_cancelled: 0,
    provider_fulfilled: 0,
    failed: 0,
  }
  const outcomeFailures: Record<string, number> = {}
  const expectedOutcomeKeys = new Set(expected.candidates.map((candidate) => (
    `${candidate.provider}:${candidate.orderGlobalId}`
  )))
  const observedOutcomeKeys = new Set<string>()
  for (const outcome of outcomes) {
    if (
      !plainRecord(outcome)
      || !exactKeys(outcome, ORDER_STATUS_SYNC_OUTCOME_KEYS)
      || !GLOBAL_ORDER_ID.test(String(outcome.orderGlobalId || ''))
      || !['shopify', 'faire'].includes(String(outcome.provider || ''))
      || !ORDER_STATUS_SYNC_OUTCOMES.has(String(outcome.outcome || ''))
    ) throw invalid()
    const outcomeKey = `${String(outcome.provider)}:${String(outcome.orderGlobalId)}`
    if (
      !expectedOutcomeKeys.has(outcomeKey)
      || observedOutcomeKeys.has(outcomeKey)
    ) throw invalid()
    observedOutcomeKeys.add(outcomeKey)
    const outcomeName = String(outcome.outcome)
    outcomeCounts[outcomeName] += 1
    if (outcomeName === 'failed') {
      const code = String(outcome.code || '')
      if (!ERROR_CODE.test(code)) throw invalid()
      outcomeFailures[code] = (outcomeFailures[code] || 0) + 1
    } else if (outcome.code !== null) {
      throw invalid()
    }
  }
  if (observedOutcomeKeys.size !== expectedOutcomeKeys.size) throw invalid()
  if (
    outcomeCounts.current !== Number(counts.current)
    || outcomeCounts.provider_fulfilled !== Number(counts.providerFulfilled)
    || outcomeCounts.provider_cancelled !== Number(counts.providerCancelled)
    || outcomeCounts.review_required !== Number(counts.reviewRequired)
    || outcomeCounts.failed !== failed
  ) throw invalid()

  const failedEntries = Object.entries(failedByCode)
  if (
    failedEntries.some(([code, count]) => (
      !ERROR_CODE.test(code)
      || !Number.isSafeInteger(count)
      || Number(count) < 1
      || outcomeFailures[code] !== count
    ))
    || failedEntries.length !== Object.keys(outcomeFailures).length
    || failedEntries.reduce((sum, [, count]) => sum + Number(count), 0) !== failed
  ) throw invalid()

  const expectedStatus = failed === 0
    ? 'succeeded'
    : refreshed > 0
      ? 'partial'
      : 'failed'
  if (value.status !== expectedStatus) throw invalid()
  return value
}

function validatedOrderStatusSyncCandidates(
  values: unknown,
  batchLimit: number,
  expectedTotalEligible?: number,
): readonly CommerceOrderRevisionRefreshCandidate[] {
  if (!Array.isArray(values) || values.length > batchLimit) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
      'The retained order status sync candidate set is invalid',
      500,
    )
  }
  const candidates = values.map((value) => {
    if (
      !plainRecord(value)
      || !exactKeys(value, [
        'orderGlobalId',
        'orderRowVersion',
        'provider',
        'totalEligible',
      ])
    ) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
        'The retained order status sync candidate set is invalid',
        500,
      )
    }
    return validatedRefreshCandidate(
      value as CommerceOrderRevisionRefreshCandidate,
    )
  })
  const totalEligible = candidates[0]?.totalEligible || 0
  const candidateKeys = new Set<string>()
  const candidateOrderGlobalIds = new Set<string>()
  for (const candidate of candidates) {
    const candidateKey = `${candidate.provider}:${candidate.orderGlobalId}`
    if (
      candidate.totalEligible !== totalEligible
      || candidate.totalEligible < candidates.length
      || candidateKeys.has(candidateKey)
      || candidateOrderGlobalIds.has(candidate.orderGlobalId)
    ) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
        'The retained order status sync candidate set is invalid',
        500,
      )
    }
    candidateKeys.add(candidateKey)
    candidateOrderGlobalIds.add(candidate.orderGlobalId)
  }
  if (
    expectedTotalEligible !== undefined
    && totalEligible !== expectedTotalEligible
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
      'The retained order status sync candidate set is invalid',
      500,
    )
  }
  return Object.freeze(candidates)
}

function validatedOrderStatusSyncBatchPayload(
  value: unknown,
  expectedResponse: boolean,
): CommerceOrderStatusSyncBatchPayload {
  const expectedKeys = expectedResponse
    ? ['batchLimit', 'candidates', 'response', 'totalEligible']
    : ['batchLimit', 'candidates', 'totalEligible']
  if (
    !plainRecord(value)
    || !exactKeys(value, expectedKeys)
    || !nonnegativeSafeInteger(value.batchLimit)
    || Number(value.batchLimit) < 1
    || Number(value.batchLimit) > 10
    || !nonnegativeSafeInteger(value.totalEligible)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
      'The retained order status sync candidate set is invalid',
      500,
    )
  }
  const batchLimit = Number(value.batchLimit)
  const totalEligible = Number(value.totalEligible)
  const candidates = validatedOrderStatusSyncCandidates(
    value.candidates,
    batchLimit,
    totalEligible,
  )
  const payload: CommerceOrderStatusSyncBatchPayload = {
    batchLimit,
    totalEligible,
    candidates,
  }
  if (!expectedResponse) return Object.freeze(payload)
  return Object.freeze({
    ...payload,
    response: validatedOrderStatusSyncBatchResult(value.response, payload),
  })
}

function validatedRefreshCandidate(
  value: CommerceOrderRevisionRefreshCandidate,
): CommerceOrderRevisionRefreshCandidate {
  if (
    !GLOBAL_ORDER_ID.test(value.orderGlobalId)
    || !Number.isSafeInteger(value.orderRowVersion)
    || value.orderRowVersion < 0
    || !Number.isSafeInteger(value.totalEligible)
    || value.totalEligible < 1
    || !['shopify', 'faire'].includes(value.provider)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_CANDIDATE_INVALID',
      'A provider refresh candidate is invalid',
      500,
    )
  }
  return Object.freeze({
    orderGlobalId: value.orderGlobalId,
    orderRowVersion: value.orderRowVersion,
    provider: value.provider,
    totalEligible: value.totalEligible,
  })
}

function validatedScheduleAllResult(
  value: unknown,
): CommerceOrderRevisionScheduleAllResult {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      'alreadyScheduled',
      'providerWrites',
      'scheduled',
      'totalEligible',
    ])
    || !nonnegativeSafeInteger(value.totalEligible)
    || !nonnegativeSafeInteger(value.scheduled)
    || !nonnegativeSafeInteger(value.alreadyScheduled)
    || value.totalEligible !== Number(value.scheduled) + Number(value.alreadyScheduled)
    || value.providerWrites !== 0
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_RESULT_INVALID',
      'The retained all-order reconciliation schedule result is invalid',
      500,
    )
  }
  return Object.freeze({
    totalEligible: Number(value.totalEligible),
    scheduled: Number(value.scheduled),
    alreadyScheduled: Number(value.alreadyScheduled),
    providerWrites: 0,
  })
}

function validatedManagerRefreshReplayCapture(
  value: unknown,
  expected: {
    orderGlobalId: string
    orderRowVersion: number
  },
): CommerceOrderRevisionCaptureResult {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      'canonicalRowVersion',
      'changed',
      'managerDispositionRequired',
      'materialState',
      'observationGlobalId',
      'orderGlobalId',
      'provider',
      'providerReads',
      'providerWrites',
      'readGlobalId',
      'revisionHash',
      'sourceHash',
    ])
    || value.orderGlobalId !== expected.orderGlobalId
    || value.canonicalRowVersion !== expected.orderRowVersion
    || !GLOBAL_OBSERVATION_ID.test(String(value.observationGlobalId || ''))
    || !GLOBAL_READ_ID.test(String(value.readGlobalId || ''))
    || !SHA256.test(String(value.sourceHash || ''))
    || !SHA256.test(String(value.revisionHash || ''))
    || !['shopify', 'faire'].includes(String(value.provider || ''))
    || !['current', 'review_required', 'provider_cancelled', 'provider_fulfilled']
      .includes(String(value.materialState || ''))
    || typeof value.changed !== 'boolean'
    || typeof value.managerDispositionRequired !== 'boolean'
    || value.managerDispositionRequired !== (value.materialState !== 'current')
    || !Number.isSafeInteger(value.providerReads)
    || Number(value.providerReads) < 1
    || Number(value.providerReads) > 4
    || value.providerWrites !== 0
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_RESULT_INVALID',
      'The retained provider refresh result is invalid',
      500,
    )
  }
  return Object.freeze({
    observationGlobalId: String(value.observationGlobalId),
    readGlobalId: String(value.readGlobalId),
    sourceHash: String(value.sourceHash),
    changed: value.changed,
    materialState: value.materialState as CommerceOrderRevisionMaterialState,
    managerDispositionRequired: value.managerDispositionRequired,
    providerReads: Number(value.providerReads),
    providerWrites: 0,
  })
}

/**
 * Returns the oldest-attempted canonical provider orders for one organization.
 *
 * The caller supplies no provider identity or account authority. Those are
 * resolved from the organization-bound order and its current readable,
 * verified integration. The exact manager refresh command revalidates every
 * candidate under lock immediately before issuing provider I/O.
 */
export async function listCommerceOrderRevisionRefreshCandidatesInPostgres(
  input: {
    organizationId: string
    limit?: number
    excludeOrderGlobalIds?: readonly string[]
    orderGlobalIds?: readonly string[]
  },
): Promise<CommerceOrderRevisionRefreshCandidate[]> {
  if (!UUID.test(input.organizationId)) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_INVALID',
      'Provider refresh input is invalid',
      400,
    )
  }
  const limit = boundedPositiveInteger(
    input.limit ?? 5,
    'Provider refresh limit',
    10,
  )
  const excludeOrderGlobalIds = input.excludeOrderGlobalIds || []
  const orderGlobalIds = input.orderGlobalIds
  if (
    !Array.isArray(excludeOrderGlobalIds)
    || excludeOrderGlobalIds.length > 500
    || new Set(excludeOrderGlobalIds).size !== excludeOrderGlobalIds.length
    || excludeOrderGlobalIds.some((globalId) => !GLOBAL_ORDER_ID.test(globalId))
    || (
      orderGlobalIds !== undefined
      && (
        !Array.isArray(orderGlobalIds)
        || orderGlobalIds.length > 100
        || new Set(orderGlobalIds).size !== orderGlobalIds.length
        || orderGlobalIds.some((globalId) => !GLOBAL_ORDER_ID.test(globalId))
      )
    )
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_INVALID',
      'Provider refresh input is invalid',
      400,
    )
  }
  const result = await query<{
    order_global_id: string
    order_row_version: string
    provider: CommerceOrderRevisionProvider
    total_eligible: string
  }>(
    `SELECT order_row.global_id AS order_global_id,
            order_row.row_version::text AS order_row_version,
            order_row.source_provider AS provider,
            count(*) OVER ()::text AS total_eligible
     FROM operations_orders order_row
     JOIN operations_integration_accounts account
       ON account.organization_id = order_row.organization_id
      AND account.id = order_row.integration_account_id
     JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
     LEFT JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     WHERE order_row.organization_id = $1::uuid
       AND NOT (order_row.global_id = ANY($3::text[]))
       AND ($4::text[] IS NULL OR order_row.global_id = ANY($4::text[]))
       AND order_row.archived_at IS NULL
       AND order_row.status NOT IN ('shipped', 'cancelled')
       AND order_row.source_provider IN ('shopify', 'faire')
       AND account.integration_type = 'commerce'
       AND account.provider = order_row.source_provider
       AND account.external_account_id IS NOT NULL
       AND ${READABLE_ACCOUNT_SQL}
       AND credential.verification_status = 'verified'
       AND credential.credential_version = account.commerce_credential_generation
       AND (
         target.id IS NULL
         OR (
           (
             target.claim_state <> 'processing'
             OR target.locked_until <= now()
           )
           AND (
             target.claim_state NOT IN ('failed', 'dead_letter')
             OR target.next_check_at <= now()
           )
         )
       )
     ORDER BY GREATEST(
                COALESCE(target.checked_at, '-infinity'::timestamptz),
                COALESCE(target.updated_at, '-infinity'::timestamptz)
              ) ASC,
              order_row.updated_at ASC,
              order_row.id ASC
     LIMIT $2`,
    [input.organizationId, limit, excludeOrderGlobalIds, orderGlobalIds ?? null],
  )
  return result.rows.map((row) => validatedRefreshCandidate({
      orderGlobalId: row.order_global_id,
      orderRowVersion: Number(row.order_row_version),
      provider: row.provider,
      totalEligible: Number(row.total_eligible),
    }))
}

/**
 * Makes every safely claimable canonical commerce order in one organization
 * due for the existing revision worker. This command performs no provider I/O.
 *
 * Caller-supplied visible orders are excluded after their immediate exact
 * refresh so this bulk command cannot duplicate those provider reads.
 * Processing targets remain in flight and count as already scheduled.
 * Dead-letter, exhausted, corrupt, terminal, archived, paused, unreadable, or
 * stale-credential orders are excluded from totalEligible and never revived.
 */
export async function scheduleAllCommerceOrderRevisionRefreshesInPostgres(
  input: {
    organizationId: string
    actorEmail: string
    idempotencyKey: string
    excludeOrderGlobalIds?: readonly string[]
  },
): Promise<CommerceOrderRevisionScheduleAllResult> {
  let actorEmail = ''
  try {
    actorEmail = boundedText(input.actorEmail, 'Actor email', 320)
  } catch {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_INVALID',
      'All-order reconciliation schedule input is invalid',
      400,
    )
  }
  const excludeOrderGlobalIds = input.excludeOrderGlobalIds || []
  if (
    !UUID.test(input.organizationId)
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || !Array.isArray(excludeOrderGlobalIds)
    || excludeOrderGlobalIds.length > 100
    || new Set(excludeOrderGlobalIds).size !== excludeOrderGlobalIds.length
    || excludeOrderGlobalIds.some((globalId) => !GLOBAL_ORDER_ID.test(globalId))
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_INVALID',
      'All-order reconciliation schedule input is invalid',
      400,
    )
  }
  const normalizedExcludedOrderGlobalIds = [...excludeOrderGlobalIds].sort()
  const requestHash = createHash('sha256').update(canonicalJson({
    action: 'schedule_all_commerce_order_revision_refreshes',
    organizationId: input.organizationId,
    actorEmail,
    excludeOrderGlobalIds: normalizedExcludedOrderGlobalIds,
    providerWrites: 0,
  })).digest('hex')

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-revision-schedule-all:${input.organizationId}`,
    )
    const existing = await client.query<RevisionCommandReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_payload, error_code, error_message, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'operations.commerce_order_revision.schedule_all'
         AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, input.idempotencyKey],
    )
    const receipt = existing.rows[0] || null
    if (receipt && receipt.request_hash !== requestHash) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different all-order reconciliation schedule',
      )
    }
    if (receipt?.status === 'succeeded') {
      return validatedScheduleAllResult(receipt.result_payload)
    }
    if (receipt?.status === 'processing') {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_IN_PROGRESS',
        'This exact all-order reconciliation schedule is already in progress',
      )
    }
    if (receipt?.status === 'failed') {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_PREVIOUSLY_FAILED',
        'This all-order reconciliation schedule previously failed. Retry with a new Idempotency-Key.',
        409,
        true,
      )
    }

    const counts = await client.query<{
      total_eligible: string
      scheduled: string
      already_scheduled: string
    }>(
      `WITH eligible_orders AS MATERIALIZED (
         SELECT order_row.id AS order_id,
                order_row.organization_id,
                order_row.integration_account_id,
                order_row.source_provider AS provider,
                CASE
                  WHEN COALESCE(order_row.source_payload->>'sourceHash', '')
                       ~ '^[a-f0-9]{64}$'
                  THEN order_row.source_payload->>'sourceHash'
                  ELSE encode(
                    digest(convert_to(order_row.source_payload::text, 'UTF8'), 'sha256'),
                    'hex'
                  )
                END AS accepted_source_hash
         FROM operations_orders order_row
         JOIN operations_integration_accounts account
           ON account.organization_id = order_row.organization_id
          AND account.id = order_row.integration_account_id
         JOIN operations_commerce_credentials credential
           ON credential.organization_id = account.organization_id
          AND credential.integration_account_id = account.id
         WHERE order_row.organization_id = $1::uuid
           AND NOT (order_row.global_id = ANY($2::text[]))
           AND order_row.archived_at IS NULL
           AND order_row.status NOT IN ('shipped', 'cancelled')
           AND order_row.source_provider IN ('shopify', 'faire')
           AND account.integration_type = 'commerce'
           AND account.provider = order_row.source_provider
           AND account.external_account_id IS NOT NULL
           AND ${READABLE_ACCOUNT_SQL}
           AND ${STORE_SYNC_RUNNING_SQL}
           AND credential.verification_status = 'verified'
           AND credential.credential_version = account.commerce_credential_generation
           AND credential.external_account_id = account.external_account_id
       ), target_states AS MATERIALIZED (
         SELECT eligible.*,
                target.id AS target_id,
                target.integration_account_id AS target_integration_account_id,
                target.provider AS target_provider,
                target.claim_state,
                target.attempt_count,
                target.next_check_at
         FROM eligible_orders eligible
         LEFT JOIN operations_commerce_order_revision_targets target
           ON target.organization_id = eligible.organization_id
          AND target.order_id = eligible.order_id
       ), inserted AS (
         INSERT INTO operations_commerce_order_revision_targets (
           organization_id, integration_account_id, order_id, provider,
           accepted_source_hash, claim_state, attempt_count, next_check_at
         )
         SELECT organization_id, integration_account_id, order_id, provider,
                accepted_source_hash, 'pending', 0, now()
         FROM target_states
         WHERE target_id IS NULL
         ON CONFLICT (organization_id, order_id) DO NOTHING
         RETURNING order_id
       ), rescheduled AS (
         UPDATE operations_commerce_order_revision_targets target
         SET next_check_at = now(),
             row_version = target.row_version + 1,
             updated_at = now()
         FROM target_states state
         WHERE target.organization_id = state.organization_id
           AND target.id = state.target_id
           AND state.target_integration_account_id = state.integration_account_id
           AND state.target_provider = state.provider
           AND state.claim_state IN ('pending', 'ready', 'failed')
           AND state.attempt_count < 8
           AND state.next_check_at > now()
         RETURNING target.order_id
       ), already_scheduled AS (
         SELECT count(*)::bigint AS value
         FROM target_states state
         WHERE state.target_id IS NOT NULL
           AND state.target_integration_account_id = state.integration_account_id
           AND state.target_provider = state.provider
           AND (
             state.claim_state = 'processing'
             OR (
               state.claim_state IN ('pending', 'ready', 'failed')
               AND state.attempt_count < 8
               AND state.next_check_at <= now()
             )
           )
       ), scheduled AS (
         SELECT
           (SELECT count(*) FROM inserted)
           + (SELECT count(*) FROM rescheduled) AS value
       )
       SELECT
         (scheduled.value + already_scheduled.value)::text AS total_eligible,
         scheduled.value::text AS scheduled,
         already_scheduled.value::text AS already_scheduled
       FROM scheduled, already_scheduled`,
      [input.organizationId, normalizedExcludedOrderGlobalIds],
    )
    const row = counts.rows[0]
    const result = validatedScheduleAllResult({
      totalEligible: Number(row?.total_eligible),
      scheduled: Number(row?.scheduled),
      alreadyScheduled: Number(row?.already_scheduled),
      providerWrites: 0,
    })
    const created = await client.query<{ id: string }>(
      `INSERT INTO operations_command_receipts (
         organization_id, command_type, idempotency_key, request_hash,
         actor_email, status, correlation_id, result_payload, completed_at
       ) VALUES (
         $1::uuid, 'operations.commerce_order_revision.schedule_all', $2, $3,
         $4, 'succeeded', $5::uuid, $6::jsonb, now()
       )
       RETURNING id::text`,
      [
        input.organizationId,
        input.idempotencyKey,
        requestHash,
        actorEmail,
        randomUUID(),
        JSON.stringify(result),
      ],
    )
    if (created.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_SCHEDULE_ALL_NOT_RETAINED',
        'The all-order reconciliation schedule was not retained',
        500,
      )
    }
    return result
  })
}

/**
 * Retains the exact bounded candidate set before provider I/O. Replaying the
 * batch key returns the retained response, and a stale interrupted attempt
 * resumes the original candidates instead of silently selecting new orders.
 */
export async function prepareCommerceOrderStatusSyncBatchInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  batchLimit: number
  candidates: readonly CommerceOrderRevisionRefreshCandidate[]
  excludeOrderGlobalIds?: readonly string[]
  orderGlobalIds?: readonly string[]
}): Promise<CommerceOrderStatusSyncBatchPreparation> {
  let actorEmail = ''
  try {
    actorEmail = boundedText(input.actorEmail, 'Actor email', 320)
  } catch {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_INVALID',
      'Sales-channel order status sync input is invalid',
      400,
    )
  }
  if (
    !UUID.test(input.organizationId)
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || !Number.isSafeInteger(input.batchLimit)
    || input.batchLimit < 1
    || input.batchLimit > 10
    || input.candidates.length > input.batchLimit
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_INVALID',
      'Sales-channel order status sync input is invalid',
      400,
    )
  }
  const candidates = validatedOrderStatusSyncCandidates(
    input.candidates,
    input.batchLimit,
  )
  const excludeOrderGlobalIds = input.excludeOrderGlobalIds || []
  const orderGlobalIds = input.orderGlobalIds
  if (
    !Array.isArray(excludeOrderGlobalIds)
    || excludeOrderGlobalIds.length > 500
    || new Set(excludeOrderGlobalIds).size !== excludeOrderGlobalIds.length
    || excludeOrderGlobalIds.some((globalId) => !GLOBAL_ORDER_ID.test(globalId))
    || (
      orderGlobalIds !== undefined
      && (
        !Array.isArray(orderGlobalIds)
        || orderGlobalIds.length > 100
        || new Set(orderGlobalIds).size !== orderGlobalIds.length
        || orderGlobalIds.some((globalId) => !GLOBAL_ORDER_ID.test(globalId))
      )
    )
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_INVALID',
      'Sales-channel order status sync input is invalid',
      400,
    )
  }
  const normalizedExcludedOrderGlobalIds = [...excludeOrderGlobalIds].sort()
  const normalizedOrderGlobalIds = orderGlobalIds === undefined
    ? undefined
    : [...orderGlobalIds].sort()
  const totalEligible = candidates[0]?.totalEligible || 0
  const requestHash = createHash('sha256').update(canonicalJson({
    action: 'sync_order_status_from_provider',
    organizationId: input.organizationId,
    actorEmail,
    batchLimit: input.batchLimit,
    excludeOrderGlobalIds: normalizedExcludedOrderGlobalIds,
    ...(normalizedOrderGlobalIds === undefined
      ? {}
      : { orderGlobalIds: normalizedOrderGlobalIds }),
    providerWrites: 0,
    canonicalOrderWrites: 0,
  })).digest('hex')

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-status-sync:${input.organizationId}:${input.idempotencyKey}`,
    )
    const existing = await client.query<RevisionCommandReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_payload,
              error_code, error_message, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'operations.commerce_order_status_sync'
         AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, input.idempotencyKey],
    )
    let receipt = existing.rows[0] || null
    if (receipt && receipt.request_hash !== requestHash) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different order status sync',
      )
    }
    if (receipt?.status === 'succeeded') {
      const retained = validatedOrderStatusSyncBatchPayload(
        receipt.result_payload,
        true,
      )
      if (retained.batchLimit !== input.batchLimit) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
          'The retained order status sync candidate set is invalid',
          500,
        )
      }
      return Object.freeze({
        receiptId: receipt.id,
        attemptToken: null,
        candidates: Object.freeze([]),
        replayedResult: retained.response as Record<string, unknown>,
      })
    }
    if (receipt?.status === 'failed') {
      throw new CommerceOrderRevisionDispositionError(
        ERROR_CODE.test(receipt.error_code || '')
          ? String(receipt.error_code)
          : 'COMMERCE_ORDER_STATUS_SYNC_PREVIOUSLY_FAILED',
        'This order status sync previously failed. Retry with a new Idempotency-Key.',
        409,
        true,
      )
    }
    if (
      receipt?.status === 'processing'
      && Date.now() - receipt.updated_at.getTime() < 5 * 60_000
    ) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_IN_PROGRESS',
        'This exact order status sync is already in progress',
      )
    }

    let retainedCandidates = candidates
    let retainedBatchLimit = input.batchLimit
    let retainedTotalEligible = totalEligible
    const attemptToken = randomUUID()
    if (receipt) {
      const retained = validatedOrderStatusSyncBatchPayload(
        receipt.result_payload,
        false,
      )
      if (retained.batchLimit !== input.batchLimit) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_STATUS_SYNC_CANDIDATES_INVALID',
          'The retained order status sync candidate set is invalid',
          500,
        )
      }
      retainedCandidates = retained.candidates
      retainedBatchLimit = retained.batchLimit
      retainedTotalEligible = retained.totalEligible
      const retried = await client.query<RevisionCommandReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             correlation_id = $3::uuid,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, status, correlation_id::text,
                   result_payload,
                   error_code, error_message, updated_at`,
        [receipt.id, actorEmail, attemptToken],
      )
      receipt = retried.rows[0]
    } else {
      const created = await client.query<RevisionCommandReceiptRow>(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id, result_payload
         ) VALUES (
           $1::uuid, 'operations.commerce_order_status_sync', $2, $3,
           $4, 'processing', $5::uuid, $6::jsonb
         )
         RETURNING id::text, request_hash, status, correlation_id::text,
                   result_payload,
                   error_code, error_message, updated_at`,
        [
          input.organizationId,
          input.idempotencyKey,
          requestHash,
          actorEmail,
          attemptToken,
          JSON.stringify({
            batchLimit: retainedBatchLimit,
            candidates: retainedCandidates,
            totalEligible: retainedTotalEligible,
          }),
        ],
      )
      receipt = created.rows[0]
    }
    if (
      !receipt
      || !UUID.test(receipt.id)
      || !UUID.test(receipt.correlation_id)
      || receipt.correlation_id !== attemptToken
    ) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_NOT_RETAINED',
        'The order status sync command was not retained',
        500,
      )
    }
    return Object.freeze({
      receiptId: receipt.id,
      attemptToken,
      candidates: Object.freeze([...retainedCandidates]),
      replayedResult: null,
    })
  })
}

export async function completeCommerceOrderStatusSyncBatchInPostgres(input: {
  organizationId: string
  receiptId: string
  attemptToken: string
  result: Record<string, unknown>
}) {
  if (
    !UUID.test(input.organizationId)
    || !UUID.test(input.receiptId)
    || !UUID.test(input.attemptToken)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_INVALID',
      'Order status sync completion is invalid',
      500,
    )
  }
  return withTransaction(async (client) => {
    const receiptResult = await client.query<RevisionCommandReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_payload, error_code, error_message, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = 'operations.commerce_order_status_sync'
       FOR UPDATE`,
      [input.organizationId, input.receiptId],
    )
    const receipt = receiptResult.rows[0]
    if (!receipt) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_NOT_RETAINED',
        'Order status sync completion was not retained',
        500,
      )
    }
    if (receipt.correlation_id !== input.attemptToken) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_STALE_ATTEMPT',
        'This order status sync attempt lease is no longer current',
        409,
      )
    }
    if (receipt.status !== 'processing') {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_NOT_RETAINED',
        'Order status sync completion was not retained',
        500,
      )
    }
    const retained = validatedOrderStatusSyncBatchPayload(
      receipt.result_payload,
      false,
    )
    const result = validatedOrderStatusSyncBatchResult(input.result, retained)
    const completed = await client.query<{ id: string }>(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_payload = $4::jsonb,
           error_code = NULL, error_message = NULL,
           completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = 'operations.commerce_order_status_sync'
         AND status = 'processing'
         AND correlation_id = $3::uuid
       RETURNING id::text`,
      [
        input.organizationId,
        input.receiptId,
        input.attemptToken,
        JSON.stringify({
          batchLimit: retained.batchLimit,
          candidates: retained.candidates,
          response: result,
          totalEligible: retained.totalEligible,
        }),
      ],
    )
    if (completed.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_COMPLETION_NOT_RETAINED',
        'Order status sync completion was not retained',
        500,
      )
    }
  })
}

export function commerceOrderRevisionApplyConfigured() {
  return process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_APPLY_ENABLED === '1'
}

export type CommerceOrderRevisionProtectedSnapshotPurgeResult = Readonly<{
  schemaAvailable: boolean
  skipped: boolean
  limit: number
  purged: number
  expiredProtectedReadBacklog: number | null
  backlogTruncated: boolean
}>

export async function purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres(input: {
  limit?: number
} = {}): Promise<CommerceOrderRevisionProtectedSnapshotPurgeResult> {
  const requestedLimit = Number(input.limit ?? PROTECTED_SNAPSHOT_PURGE_DEFAULT_LIMIT)
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, PROTECTED_SNAPSHOT_PURGE_MAX_LIMIT))
    : PROTECTED_SNAPSHOT_PURGE_DEFAULT_LIMIT
  const readiness = await query<{ migration_applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename = $1
     ) AS migration_applied`,
    [REVISION_APPLY_MIGRATION],
  )
  if (readiness.rows[0]?.migration_applied !== true) {
    return Object.freeze({
      schemaAvailable: false,
      skipped: true,
      limit,
      purged: 0,
      expiredProtectedReadBacklog: null,
      backlogTruncated: false,
    })
  }
  const purged = await query<{ purged: number }>(
    `SELECT purge_expired_ocr_protected_snapshots($1)::integer AS purged`,
    [limit],
  )
  const backlog = await query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM (
       SELECT 1
       FROM operations_commerce_order_revision_reads
       WHERE protected_snapshot_purged_at IS NULL
         AND protected_snapshot_expires_at <= now()
       LIMIT $1
     ) bounded_backlog`,
    [PROTECTED_SNAPSHOT_BACKLOG_LIMIT + 1],
  )
  const observedBacklog = Number(backlog.rows[0]?.count || 0)
  return Object.freeze({
    schemaAvailable: true,
    skipped: false,
    limit,
    purged: Number(purged.rows[0]?.purged || 0),
    expiredProtectedReadBacklog: Math.min(
      observedBacklog,
      PROTECTED_SNAPSHOT_BACKLOG_LIMIT,
    ),
    backlogTruncated: observedBacklog > PROTECTED_SNAPSHOT_BACKLOG_LIMIT,
  })
}

async function assertCommerceOrderRevisionApplyRuntimeReady() {
  if (!commerceOrderRevisionApplyConfigured()) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_APPLY_DISABLED',
      'Applying provider revisions to ClawPilot is not enabled',
      409,
    )
  }
  const readiness = await query<{ migration_applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM schema_migrations
       WHERE filename = '${REVISION_APPLY_MIGRATION}'
     ) AS migration_applied`,
  )
  if (readiness.rows[0]?.migration_applied !== true) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_APPLY_SCHEMA_UNAVAILABLE',
      'Applying provider revisions requires the current database schema',
      503,
    )
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

type RevisionCommandReceiptRow = QueryResultRow & {
  id: string
  request_hash: string
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: Record<string, unknown> | null
  error_code: string | null
  error_message: string | null
  updated_at: Date
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

function validatedProtectedSnapshot(
  value: CommerceOrderRevisionProtectedSnapshot | null | undefined,
  expectedFingerprint: unknown,
) {
  if (value === null || value === undefined) return null
  if (
    !Buffer.isBuffer(value.ciphertext)
    || value.ciphertext.length < 1
    || value.ciphertext.length > 65_536
    || !Buffer.isBuffer(value.iv)
    || value.iv.length !== 12
    || !Buffer.isBuffer(value.tag)
    || value.tag.length !== 16
    || !SHA256.test(value.hash)
    || !SHA256.test(value.contentFingerprint)
    || !commerceOrderRevisionEvidenceKeyAvailable(value.keyId)
    || value.contentFingerprint !== expectedFingerprint
    || value.encryptionVersion !== 1
  ) throw new Error('Commerce order revision protected snapshot is invalid')
  return value
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
           AND ${STORE_SYNC_RUNNING_SQL}
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

/**
 * Revalidates the exact lease and account-scoped Store sync fence immediately
 * before a revision adapter is allowed to issue its first provider read.
 */
export async function assertCommerceOrderRevisionStoreSyncRunningInPostgres(
  claim: CommerceOrderRevisionClaim,
) {
  validateClaim(claim)
  const current = await query<{ permitted: boolean }>(
    `SELECT COALESCE(
       target.claim_state = 'processing'
       AND target.locked_by = $3
       AND target.lock_token = $4::uuid
       AND target.locked_until > now()
       AND account.global_id = $5
       AND account.provider = $6
       AND account.integration_type = 'commerce'
       AND account.commerce_credential_generation = $7
       AND ${STORE_SYNC_RUNNING_SQL},
       false
     ) AS permitted
     FROM operations_commerce_order_revision_targets target
     JOIN operations_integration_accounts account
       ON account.organization_id = target.organization_id
      AND account.id = target.integration_account_id
     WHERE target.id = $1::uuid
       AND target.organization_id = $2::uuid
       AND target.integration_account_id = $8::uuid
     LIMIT 1`,
    [
      claim.targetId,
      claim.organizationId,
      claim.workerId,
      claim.leaseToken,
      claim.accountGlobalId,
      claim.provider,
      claim.credentialVersion,
      claim.integrationAccountId,
    ],
  )
  if (current.rows[0]?.permitted !== true) {
    throw new CommerceOrderRevisionStoreSyncPausedError(
      'Store sync paused or the exact revision-read lease changed before provider I/O',
    )
  }
}

export async function prepareManagerCommerceOrderRevisionRefreshInPostgres(
  input: {
    organizationId: string
    actorEmail: string
    orderGlobalId: string
    expectedRowVersion: number
    idempotencyKey: string
  },
): Promise<CommerceOrderRevisionManagerRefreshPreparation> {
  let actorEmail = ''
  try {
    actorEmail = boundedText(input.actorEmail, 'Actor email', 320)
  } catch {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_INVALID',
      'Provider refresh input is invalid',
      400,
    )
  }
  if (
    !UUID.test(input.organizationId)
    || !GLOBAL_ORDER_ID.test(input.orderGlobalId)
    || !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_REFRESH_INVALID',
      'Provider refresh input is invalid',
      400,
    )
  }
  const requestHash = createHash('sha256').update(canonicalJson({
    action: 'refresh_from_provider',
    organizationId: input.organizationId,
    actorEmail,
    orderGlobalId: input.orderGlobalId,
    expectedRowVersion: input.expectedRowVersion,
    providerWrites: 0,
  })).digest('hex')

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-revision-refresh:${input.organizationId}:${input.idempotencyKey}`,
    )
    const existing = await client.query<RevisionCommandReceiptRow>(
      `SELECT id::text, request_hash, status, result_payload,
              error_code, error_message, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = 'operations.commerce_order_revision.refresh'
         AND idempotency_key = $2
       FOR UPDATE`,
      [input.organizationId, input.idempotencyKey],
    )
    let receipt = existing.rows[0] || null
    if (receipt && receipt.request_hash !== requestHash) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different provider refresh',
      )
    }
    if (receipt?.status === 'succeeded') {
      const replayedCapture = validatedManagerRefreshReplayCapture(
        receipt.result_payload,
        {
          orderGlobalId: input.orderGlobalId,
          orderRowVersion: input.expectedRowVersion,
        },
      )
      return Object.freeze({
        replayed: true,
        readGlobalId: replayedCapture.readGlobalId,
        replayedCapture,
        claim: null,
        commandReceiptId: receipt.id,
      })
    }
    if (receipt?.status === 'failed') {
      throw new CommerceOrderRevisionDispositionError(
        ERROR_CODE.test(receipt.error_code || '')
          ? String(receipt.error_code)
          : 'COMMERCE_ORDER_REVISION_REFRESH_PREVIOUSLY_FAILED',
        'This exact provider refresh previously failed. Retry with a new Idempotency-Key.',
        409,
        true,
      )
    }
    if (
      receipt?.status === 'processing'
      && Date.now() - receipt.updated_at.getTime() < 5 * 60_000
    ) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_IN_PROGRESS',
        'This exact provider refresh is already in progress',
      )
    }

    await acquireTransactionAdvisoryLock(
      client,
      `operations:order:${input.organizationId}:${input.orderGlobalId}`,
    )
    const orderResult = await client.query<{
      id: string
      global_id: string
      integration_account_id: string
      source_provider: CommerceOrderRevisionProvider
      external_order_id: string
      row_version: string
      accepted_source_hash: string
      account_global_id: string
      external_account_id: string
      credential_version: number
    }>(
      `SELECT order_row.id::text, order_row.global_id,
              order_row.integration_account_id::text,
              order_row.source_provider, order_row.external_order_id,
              order_row.row_version::text,
              CASE
                WHEN COALESCE(order_row.source_payload->>'sourceHash', '')
                     ~ '^[a-f0-9]{64}$'
                THEN order_row.source_payload->>'sourceHash'
                ELSE encode(digest(convert_to(order_row.source_payload::text, 'UTF8'), 'sha256'), 'hex')
              END AS accepted_source_hash,
              account.global_id AS account_global_id,
              account.external_account_id,
              account.commerce_credential_generation AS credential_version
       FROM operations_orders order_row
       JOIN operations_integration_accounts account
         ON account.organization_id = order_row.organization_id
        AND account.id = order_row.integration_account_id
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
       WHERE order_row.organization_id = $1::uuid
         AND order_row.global_id = $2
         AND order_row.source_provider IN ('shopify', 'faire')
         AND account.integration_type = 'commerce'
         AND account.provider = order_row.source_provider
         AND account.external_account_id IS NOT NULL
         AND ${READABLE_ACCOUNT_SQL}
         AND credential.verification_status = 'verified'
         AND credential.credential_version = account.commerce_credential_generation
       FOR UPDATE OF order_row, account, credential`,
      [input.organizationId, input.orderGlobalId],
    )
    const order = orderResult.rows[0]
    if (!order) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_UNAVAILABLE',
        'This canonical Shopify or Faire order is not available to refresh',
        404,
      )
    }
    if (Number(order.row_version) !== input.expectedRowVersion) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_STALE',
        'The order changed after it was opened. Reload before refreshing from the sales channel.',
      )
    }

    if (receipt) {
      const retried = await client.query<RevisionCommandReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, status, result_payload,
                   error_code, error_message, updated_at`,
        [receipt.id, actorEmail],
      )
      receipt = retried.rows[0]
    } else {
      const created = await client.query<RevisionCommandReceiptRow>(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id, target_global_id
         ) VALUES (
           $1::uuid, 'operations.commerce_order_revision.refresh', $2, $3,
           $4, 'processing', $5::uuid, $6
         )
         RETURNING id::text, request_hash, status, result_payload,
                   error_code, error_message, updated_at`,
        [
          input.organizationId,
          input.idempotencyKey,
          requestHash,
          actorEmail,
          randomUUID(),
          order.global_id,
        ],
      )
      receipt = created.rows[0]
    }
    if (!receipt) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_NOT_RETAINED',
        'The provider refresh command was not retained',
        500,
      )
    }

    const targetResult = await client.query<{ id: string; locked_by: string }>(
      `INSERT INTO operations_commerce_order_revision_targets (
         organization_id, integration_account_id, order_id, provider,
         accepted_source_hash, claim_state, attempt_count, next_check_at,
         checked_at, locked_by, lock_token, locked_until
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5,
         'processing', 1, now(), NULL, $6, gen_random_uuid(),
         now() + interval '${REVISION_LEASE}'
       )
       ON CONFLICT (organization_id, order_id) DO UPDATE
       SET claim_state = 'processing',
           attempt_count = LEAST(8, operations_commerce_order_revision_targets.attempt_count + 1),
           next_check_at = now(), locked_by = EXCLUDED.locked_by,
           lock_token = gen_random_uuid(),
           locked_until = now() + interval '${REVISION_LEASE}',
           last_error_code = NULL,
           row_version = operations_commerce_order_revision_targets.row_version + 1,
           updated_at = now()
       WHERE operations_commerce_order_revision_targets.claim_state <> 'processing'
          OR operations_commerce_order_revision_targets.locked_until <= now()
       RETURNING id::text, locked_by`,
      [
        input.organizationId,
        order.integration_account_id,
        order.id,
        order.source_provider,
        order.accepted_source_hash,
        `manager:${receipt.id}`,
      ],
    )
    const target = targetResult.rows[0]
    if (!target) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_IN_PROGRESS',
        'Another exact provider refresh is already in progress',
      )
    }
    const leased = await client.query<{ lock_token: string }>(
      `SELECT lock_token::text
       FROM operations_commerce_order_revision_targets
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [input.organizationId, target.id],
    )
    if (!leased.rows[0]?.lock_token) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REFRESH_LEASE_NOT_RETAINED',
        'The exact provider refresh lease was not retained',
        500,
      )
    }
    const claim = normalizedClaim({
      target_id: target.id,
      worker_id: target.locked_by,
      lease_token: leased.rows[0].lock_token,
      organization_id: input.organizationId,
      integration_account_id: order.integration_account_id,
      account_global_id: order.account_global_id,
      external_account_id: order.external_account_id,
      credential_version: order.credential_version,
      provider: order.source_provider,
      order_id: order.id,
      order_global_id: order.global_id,
      order_row_version: order.row_version,
      external_order_id: order.external_order_id,
      accepted_source_hash: order.accepted_source_hash,
    } as ClaimRow)
    return Object.freeze({
      replayed: false,
      readGlobalId: null,
      replayedCapture: null,
      claim,
      commandReceiptId: receipt.id,
    })
  })
}

export async function failManagerCommerceOrderRevisionRefreshInPostgres(input: {
  claim: CommerceOrderRevisionClaim
  commandReceiptId: string
  errorCode: string
}) {
  validateClaim(input.claim)
  if (!UUID.test(input.commandReceiptId) || !ERROR_CODE.test(input.errorCode)) {
    throw new Error('Commerce order revision manager refresh failure is invalid')
  }
  return withTransaction(async (client) => {
    const released = await client.query<{ id: string }>(
      `UPDATE operations_commerce_order_revision_targets
       SET claim_state = CASE WHEN attempt_count >= 8 THEN 'dead_letter' ELSE 'failed' END,
           next_check_at = now() + make_interval(mins => LEAST(30, GREATEST(1, attempt_count * 2))),
           locked_by = NULL, lock_token = NULL, locked_until = NULL,
           last_error_code = $5, row_version = row_version + 1,
           updated_at = now()
       WHERE id = $1::uuid AND organization_id = $2::uuid
         AND claim_state = 'processing' AND locked_by = $3
         AND lock_token = $4::uuid
       RETURNING id::text`,
      [
        input.claim.targetId,
        input.claim.organizationId,
        input.claim.workerId,
        input.claim.leaseToken,
        input.errorCode,
      ],
    )
    if (released.rowCount !== 1) return false
    const failed = await client.query(
      `UPDATE operations_command_receipts
       SET status = 'failed', error_code = $3,
           error_message = 'Exact provider refresh failed',
           completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND status = 'processing'`,
      [input.claim.organizationId, input.commandReceiptId, input.errorCode],
    )
    if (failed.rowCount !== 1) {
      throw new Error('Commerce order revision manager refresh receipt was not retained')
    }
    return true
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
  const trigger = input.trigger || { kind: 'scheduled' as const }
  if (
    !['scheduled', 'manager'].includes(trigger.kind)
    || (
      trigger.kind === 'manager'
      && (
        !UUID.test(trigger.commandReceiptId)
        || !boundedText(trigger.actorEmail, 'Commerce order revision actor', 320)
      )
    )
  ) throw new Error('Commerce order revision trigger is invalid')
  const protectedParty = validatedProtectedSnapshot(
    input.protectedParty,
    order?.partyFingerprint,
  )
  const protectedShipTo = validatedProtectedSnapshot(
    input.protectedShipTo,
    order?.shipToFingerprint,
  )
  return {
    sourceRevision,
    providerReads,
    observedAt: observedAt.toISOString(),
    snapshot,
    lifecycle: String(canonicalStates.lifecycle || ''),
    fulfillment: String(canonicalStates.fulfillment || ''),
    returns: String(canonicalStates.returns || ''),
    protectedParty,
    protectedShipTo,
    trigger,
  }
}

function materialState(input: {
  changed: boolean
  lifecycle: string
  fulfillment: string
  returns: string
}): CommerceOrderRevisionMaterialState {
  if (!input.changed) return 'current'
  if (
    ['partial', 'fulfilled'].includes(input.fulfillment)
    || ['in_progress', 'requested', 'returned'].includes(input.returns)
  ) return 'provider_fulfilled'
  if (
    input.lifecycle === 'cancelled'
    && input.fulfillment === 'unfulfilled'
    && input.returns === 'none'
  ) return 'provider_cancelled'
  return 'review_required'
}

async function upsertRevisionException(
  client: PoolClient,
  input: {
    target: LockedTargetRow
    observationGlobalId: string
    readGlobalId: string
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
          readGlobalId: input.readGlobalId,
          sourceHash: input.sourceHash,
          revisionHash: input.revisionHash,
          providerWrites: 0,
        })],
      )
    }
    return
  }
  const details = {
    provider: input.target.provider,
    orderGlobalId: input.target.order_global_id,
    observationGlobalId: input.observationGlobalId,
    readGlobalId: input.readGlobalId,
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
    await assertCommerceStoreSyncProviderReadLeaseCurrentWithClient(client, {
      organizationId: input.claim.organizationId,
      integrationAccountId: input.claim.integrationAccountId,
      lease: input.providerReadLease,
      authorityKind: observation.trigger.kind === 'manager'
        ? 'manual_read_only'
        : 'automatic',
      readKind: 'order_revision',
    })
    if (observation.trigger.kind === 'manager') {
      const command = await client.query<{ id: string }>(
        `SELECT id::text
         FROM operations_command_receipts
         WHERE id = $1::uuid
           AND organization_id = $2::uuid
           AND command_type = 'operations.commerce_order_revision.refresh'
           AND actor_email = $3
           AND target_global_id = $4
           AND status = 'processing'
         FOR UPDATE`,
        [
          observation.trigger.commandReceiptId,
          input.claim.organizationId,
          observation.trigger.actorEmail,
          input.claim.canonicalOrderGlobalId,
        ],
      )
      if (!command.rows[0]) {
        throw new Error('Manager order revision command authority is stale')
      }
    }
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
         AND ${observation.trigger.kind === 'manager'
           ? 'TRUE'
           : STORE_SYNC_RUNNING_SQL}
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

    const exactRead = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_order_revision_reads (
         organization_id, integration_account_id, target_id, observation_id,
         order_id, provider, credential_generation, source_hash,
         revision_hash, canonical_row_version, trigger_kind,
         command_receipt_id, actor_email,
         party_snapshot_ciphertext, party_snapshot_iv, party_snapshot_tag,
         party_snapshot_hash, party_content_fingerprint,
         party_snapshot_key_id,
         party_snapshot_encryption_version,
         ship_to_snapshot_ciphertext, ship_to_snapshot_iv,
         ship_to_snapshot_tag, ship_to_snapshot_hash,
         ship_to_content_fingerprint,
         ship_to_snapshot_key_id,
         ship_to_snapshot_encryption_version,
         provider_read_count, provider_write_count, observed_at,
         protected_snapshot_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6, $7, $8,
         $9, $10, $11,
         $12::uuid, $13,
         $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26, $27,
         $28, 0, $29::timestamptz,
         now() + interval '30 days'
       )
       RETURNING id::text, global_id`,
      [
        target.organization_id,
        target.integration_account_id,
        target.id,
        retained.id,
        target.order_id,
        target.provider,
        input.claim.credentialVersion,
        input.sourceHash,
        input.revisionHash,
        input.claim.canonicalOrderRowVersion,
        observation.trigger.kind,
        observation.trigger.kind === 'manager'
          ? observation.trigger.commandReceiptId
          : null,
        observation.trigger.kind === 'manager'
          ? observation.trigger.actorEmail
          : null,
        observation.protectedParty?.ciphertext || null,
        observation.protectedParty?.iv || null,
        observation.protectedParty?.tag || null,
        observation.protectedParty?.hash || null,
        observation.protectedParty?.contentFingerprint || null,
        observation.protectedParty?.keyId || null,
        observation.protectedParty?.encryptionVersion || null,
        observation.protectedShipTo?.ciphertext || null,
        observation.protectedShipTo?.iv || null,
        observation.protectedShipTo?.tag || null,
        observation.protectedShipTo?.hash || null,
        observation.protectedShipTo?.contentFingerprint || null,
        observation.protectedShipTo?.keyId || null,
        observation.protectedShipTo?.encryptionVersion || null,
        observation.providerReads,
        observation.observedAt,
      ],
    )
    const retainedRead = exactRead.rows[0]
    if (!retainedRead || !GLOBAL_READ_ID.test(retainedRead.global_id)) {
      throw new Error('Commerce order revision exact-read evidence was not retained')
    }

    const changed = target.accepted_source_hash !== input.sourceHash
    const state = materialState({
      changed,
      lifecycle: observation.lifecycle,
      fulfillment: observation.fulfillment,
      returns: observation.returns,
    })
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET latest_source_hash = $2,
           latest_observation_id = $3::uuid,
           latest_read_id = $5::uuid,
           accepted_observation_id = CASE
             WHEN $4 = 'current' THEN $3::uuid
             ELSE accepted_observation_id
           END,
           accepted_read_id = CASE
             WHEN $4 = 'current' THEN $5::uuid
             ELSE accepted_read_id
           END,
           accepted_revision_hash = CASE
             WHEN $4 = 'current' THEN $6
             ELSE accepted_revision_hash
           END,
           material_state = $4,
           claim_state = 'ready',
           attempt_count = 0,
           next_check_at = now() + interval '${REVISION_INTERVAL}',
           checked_at = now(),
           locked_by = NULL,
           lock_token = NULL,
           locked_until = NULL,
           last_error_code = NULL,
           row_version = row_version + 1,
           updated_at = now()
       WHERE id = $1::uuid`,
      [
        target.id,
        input.sourceHash,
        retained.id,
        state,
        retainedRead.id,
        input.revisionHash,
      ],
    )
    await upsertRevisionException(client, {
      target,
      observationGlobalId: retained.global_id,
      readGlobalId: retainedRead.global_id,
      sourceHash: input.sourceHash,
      revisionHash: input.revisionHash,
      canonicalRowVersion: input.claim.canonicalOrderRowVersion,
      state,
      providerReads: observation.providerReads,
    })
    if (observation.trigger.kind === 'manager') {
      const completed = await client.query(
        `UPDATE operations_command_receipts
         SET status = 'succeeded', result_global_id = $3,
             result_payload = $4::jsonb, error_code = NULL,
             error_message = NULL, completed_at = now(), updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2::uuid
           AND status = 'processing'`,
        [
          target.organization_id,
          observation.trigger.commandReceiptId,
          retainedRead.global_id,
          JSON.stringify({
            readGlobalId: retainedRead.global_id,
            observationGlobalId: retained.global_id,
            orderGlobalId: target.order_global_id,
            provider: target.provider,
            sourceHash: input.sourceHash,
            revisionHash: input.revisionHash,
            canonicalRowVersion: input.claim.canonicalOrderRowVersion,
            changed,
            materialState: state,
            managerDispositionRequired: state !== 'current',
            providerReads: observation.providerReads,
            providerWrites: 0,
          }),
        ],
      )
      if (completed.rowCount !== 1) {
        throw new Error('Commerce order revision refresh receipt was not completed')
      }
    }
    return Object.freeze({
      observationGlobalId: retained.global_id,
      readGlobalId: retainedRead.global_id,
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

export async function parkCommerceOrderRevisionTargetForStoreSyncPauseInPostgres(
  input: {
    claim: CommerceOrderRevisionClaim
    workerId: string
  },
) {
  validateClaim(input.claim)
  const workerId = boundedText(
    input.workerId,
    'Commerce order revision worker ID',
    200,
  )
  if (workerId !== input.claim.workerId) {
    throw new Error('Commerce order revision pause disposition is invalid')
  }
  const result = await query(
    `UPDATE operations_commerce_order_revision_targets
     SET claim_state = 'ready',
         attempt_count = GREATEST(0, attempt_count - 1),
         next_check_at = now(),
         locked_by = NULL,
         lock_token = NULL,
         locked_until = NULL,
         last_error_code = 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
         row_version = row_version + 1,
         updated_at = now()
     WHERE id = $1::uuid
       AND organization_id = $2::uuid
       AND claim_state = 'processing'
       AND locked_by = $3
       AND lock_token = $4::uuid
     RETURNING id`,
    [
      input.claim.targetId,
      input.claim.organizationId,
      workerId,
      input.claim.leaseToken,
    ],
  )
  return result.rowCount === 1
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
  const authoritySchema = await client.query<{ applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM schema_migrations
       WHERE filename = '0274_operations_commerce_order_revision_apply.sql'
     ) AS applied`,
  )
  const authoritySchemaApplied = authoritySchema.rows[0]?.applied === true
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
  // Before the authority schema is promoted, Phase 1 still blocks known
  // material changes without creating a migration-time outage. Once 0274 is
  // present, missing, failed, or stale provider authority is fail-closed for
  // execution even if the legacy rollout override is absent. The override is
  // retained only so pre-0274 environments can opt into the same strictness.
  const strictCoverage = isHostedRuntime()
    || authoritySchemaApplied
    || process.env.CLAWPILOT_COMMERCE_ORDER_REVISION_STRICT === '1'
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
  read_global_id: string | null
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
    || (row.read_global_id !== null && !GLOBAL_READ_ID.test(row.read_global_id))
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
    readGlobalId: row.read_global_id,
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
  readGlobalId: string
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
    || !GLOBAL_READ_ID.test(input.readGlobalId)
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
    readGlobalId: input.readGlobalId,
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
         read_evidence.global_id AS read_global_id,
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
       JOIN operations_commerce_order_revision_reads read_evidence
         ON read_evidence.organization_id = disposition.organization_id
        AND read_evidence.id = disposition.read_id
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
      read_id: string
      read_global_id: string
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
         read_evidence.id::text AS read_id,
         read_evidence.global_id AS read_global_id,
         read_evidence.source_hash,
         read_evidence.revision_hash,
         read_evidence.canonical_row_version::text,
         read_evidence.provider_read_count
       FROM operations_commerce_order_revision_targets target
       JOIN operations_commerce_order_revision_observations observation
         ON observation.organization_id = target.organization_id
        AND observation.id = target.latest_observation_id
       JOIN operations_commerce_order_revision_reads read_evidence
         ON read_evidence.organization_id = target.organization_id
        AND read_evidence.id = target.latest_read_id
        AND read_evidence.observation_id = observation.id
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
         AND read_evidence.global_id = $7
         AND read_evidence.source_hash = $5
         AND read_evidence.revision_hash = $8
         AND read_evidence.canonical_row_version = $9
         AND read_evidence.trigger_kind IN ('scheduled', 'manager')
         AND read_evidence.provider_read_count BETWEEN 1 AND 4
         AND read_evidence.provider_write_count = 0
         AND read_evidence.created_at >= now() - interval '${REVISION_FRESHNESS}'
         AND observation.source_hash = read_evidence.source_hash
         AND observation.revision_hash = read_evidence.revision_hash
         AND observation.provider_write_count = 0
         AND observation.normalized_snapshot #>> '{order,canonicalStates,lifecycle}' = 'cancelled'
         AND observation.normalized_snapshot #>> '{order,canonicalStates,fulfillment}' = 'unfulfilled'
         AND observation.normalized_snapshot #>> '{order,canonicalStates,returns}' = 'none'
         AND jsonb_typeof(observation.normalized_snapshot #> '{order,lines}') = 'array'
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             observation.normalized_snapshot #> '{order,lines}'
           ) line
           WHERE COALESCE((line->>'fulfilledQuantity')::numeric, 0) <> 0
              OR COALESCE((line->>'returnedQuantity')::numeric, 0) <> 0
         )
       FOR UPDATE OF target`,
      [
        input.organizationId,
        order.id,
        order.integration_account_id,
        order.source_provider,
        input.expectedSourceHash,
        input.observationGlobalId,
        input.readGlobalId,
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
      label_attempts: boolean
      shipment_groups: boolean
      billable_events: boolean
      sandbox_authorizations: boolean
      external_fulfillment_reconciliations: boolean
      production_rerates: boolean
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
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS active_executions,
         EXISTS (SELECT 1 FROM operations_label_attempts row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS label_attempts,
         EXISTS (SELECT 1 FROM operations_shipment_groups row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS shipment_groups,
         EXISTS (SELECT 1 FROM operations_billable_events row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS billable_events,
         EXISTS (SELECT 1 FROM operations_sandbox_commerce_e2e_authorizations row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS sandbox_authorizations,
         EXISTS (SELECT 1 FROM operations_shopify_external_fulfillment_reconciliations row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS external_fulfillment_reconciliations,
         EXISTS (SELECT 1 FROM operations_production_fulfillment_rerate_runs row
                 WHERE row.organization_id = $1::uuid AND row.order_id = $2::uuid) AS production_rerates`,
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
         read_id,
         order_id, provider, action, idempotency_key, request_hash,
         expected_order_row_version, previous_status, resulting_status,
         source_hash, revision_hash, reason, provider_read_count,
         provider_write_count, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid,
         $6::uuid, $7, 'cancel_unstarted_order', $8, $9,
         $10, 'imported', 'cancelled',
         $11, $12, $13, $14,
         0, $15
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        exactRevision.integration_account_id,
        exactRevision.target_id,
        exactRevision.observation_id,
        exactRevision.read_id,
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

    const cancelledOrder = await client.query(
      `UPDATE operations_orders
       SET status = 'cancelled', row_version = row_version + 1,
           updated_by = $3, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND status = 'imported' AND row_version = $4`,
      [input.organizationId, order.id, actorEmail, input.expectedRowVersion],
    )
    if (cancelledOrder.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANCELLATION_ROW_VERSION_STALE',
        'The canonical order changed before cancellation could be applied',
      )
    }
    await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET accepted_source_hash = $3,
           accepted_observation_id = $4::uuid,
           accepted_read_id = $5::uuid,
           accepted_revision_hash = $6,
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
      [
        input.organizationId,
        exactRevision.target_id,
        input.expectedSourceHash,
        exactRevision.observation_id,
        exactRevision.read_id,
        input.expectedRevisionHash,
      ],
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
          readGlobalId: exactRevision.read_global_id,
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
        readGlobalId: exactRevision.read_global_id,
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
      read_global_id: exactRevision.read_global_id,
      source_hash: input.expectedSourceHash,
      revision_hash: input.expectedRevisionHash,
      expected_order_row_version: String(input.expectedRowVersion),
      provider_read_count: exactRevision.provider_read_count,
      request_hash: requestHash,
    }, false)
  })
}

export async function readManagerCommerceOrderRevisionStateFromPostgres(input: {
  organizationId: string
  orderGlobalId: string
}): Promise<ManagerCommerceOrderRevisionState> {
  if (!UUID.test(input.organizationId) || !GLOBAL_ORDER_ID.test(input.orderGlobalId)) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_READ_INVALID',
      'Provider revision state input is invalid',
      400,
    )
  }
  const result = await query<{
    provider: CommerceOrderRevisionProvider
    order_row_version: string
    order_status: string
    eligible: boolean
    observation_global_id: string | null
    read_global_id: string | null
    source_hash: string | null
    revision_hash: string | null
    material_state: CommerceOrderRevisionMaterialState | null
    captured_at: Date | null
    fresh: boolean | null
    changed: boolean | null
    zero_downstream: boolean
    protected_complete: boolean | null
    complete_shopify_revision: boolean | null
    complete_faire_revision: boolean | null
    provider_read_count: number | null
    application_global_id: string | null
    exception_global_id: string | null
  }>(
    `SELECT order_row.source_provider AS provider,
            order_row.row_version::text AS order_row_version,
            order_row.status AS order_status,
            (
              account.id IS NOT NULL
              AND credential.integration_account_id IS NOT NULL
            ) AS eligible,
            observation.global_id AS observation_global_id,
            read_evidence.global_id AS read_global_id,
            read_evidence.source_hash,
            read_evidence.revision_hash,
            target.material_state,
            read_evidence.created_at AS captured_at,
            COALESCE(
              read_evidence.created_at >= now() - interval '${REVISION_FRESHNESS}',
              false
            ) AS fresh,
            target.accepted_source_hash IS DISTINCT FROM
              target.latest_source_hash AS changed,
            ocr_order_has_zero_downstream(
              order_row.organization_id,
              order_row.id
            ) AS zero_downstream,
            (
              read_evidence.protected_snapshot_purged_at IS NULL
              AND read_evidence.protected_snapshot_expires_at > now()
              AND read_evidence.party_snapshot_ciphertext IS NOT NULL
              AND read_evidence.ship_to_snapshot_ciphertext IS NOT NULL
            ) AS protected_complete,
            ocr_shopify_revision_snapshot_complete(
              observation.normalized_snapshot
            ) AS complete_shopify_revision,
            ocr_faire_revision_snapshot_complete(
              observation.normalized_snapshot
            ) AS complete_faire_revision,
            read_evidence.provider_read_count,
            application.global_id AS application_global_id,
            revision_exception.global_id AS exception_global_id
     FROM operations_orders order_row
     LEFT JOIN operations_integration_accounts account
       ON account.organization_id = order_row.organization_id
      AND account.id = order_row.integration_account_id
      AND account.provider = order_row.source_provider
      AND account.integration_type = 'commerce'
      AND account.external_account_id IS NOT NULL
      AND ${READABLE_ACCOUNT_SQL}
     LEFT JOIN operations_commerce_credentials credential
       ON credential.organization_id = account.organization_id
      AND credential.integration_account_id = account.id
      AND credential.verification_status = 'verified'
      AND credential.credential_version = account.commerce_credential_generation
     LEFT JOIN operations_commerce_order_revision_targets target
       ON target.organization_id = order_row.organization_id
      AND target.order_id = order_row.id
     LEFT JOIN operations_commerce_order_revision_reads read_evidence
       ON read_evidence.organization_id = target.organization_id
      AND read_evidence.id = target.latest_read_id
     LEFT JOIN operations_commerce_order_revision_observations observation
       ON observation.organization_id = read_evidence.organization_id
      AND observation.id = read_evidence.observation_id
     LEFT JOIN operations_commerce_order_revision_applications application
       ON application.organization_id = target.organization_id
      AND application.id = target.applied_application_id
     LEFT JOIN LATERAL (
       SELECT exception.global_id
       FROM operations_exceptions exception
       WHERE exception.organization_id = order_row.organization_id
         AND exception.order_id = order_row.id
         AND exception.exception_type = '${REVISION_EXCEPTION_TYPE}'
         AND exception.status IN ('open', 'acknowledged')
       ORDER BY exception.created_at DESC, exception.id DESC
       LIMIT 1
     ) revision_exception ON true
     WHERE order_row.organization_id = $1::uuid
       AND order_row.global_id = $2
       AND order_row.source_provider IN ('shopify', 'faire')`,
    [input.organizationId, input.orderGlobalId],
  )
  const row = result.rows[0]
  if (!row) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_ORDER_NOT_FOUND',
      'The canonical Shopify or Faire order is unavailable',
      404,
    )
  }
  const base = {
    eligible: row.eligible,
    provider: row.provider,
    orderGlobalId: input.orderGlobalId,
    orderRowVersion: Number(row.order_row_version),
    orderStatus: row.order_status,
  }
  if (
    !row.observation_global_id
    || !row.read_global_id
    || !row.source_hash
    || !row.revision_hash
    || !row.material_state
    || !row.captured_at
  ) return Object.freeze({ ...base, state: null })
  const applyBlockedCode = !commerceOrderRevisionApplyConfigured()
    ? 'COMMERCE_ORDER_REVISION_APPLY_DISABLED'
    : row.order_status !== 'imported'
    ? 'COMMERCE_ORDER_REVISION_ORDER_STARTED'
    : row.fresh !== true
      ? 'COMMERCE_ORDER_REVISION_READ_STALE'
      : row.zero_downstream !== true
        ? 'COMMERCE_ORDER_REVISION_DOWNSTREAM_EXISTS'
        : row.material_state !== 'review_required'
          ? 'COMMERCE_ORDER_REVISION_NOT_APPLICABLE'
          : row.protected_complete !== true
            ? 'COMMERCE_ORDER_REVISION_PROTECTED_HEADER_UNAVAILABLE'
            : (
              row.provider === 'shopify'
                ? row.complete_shopify_revision
                : row.complete_faire_revision
            ) !== true
              ? 'COMMERCE_ORDER_REVISION_PROVIDER_FACTS_INCOMPLETE'
              : null
  return Object.freeze({
    ...base,
    state: Object.freeze({
      observationGlobalId: row.observation_global_id,
      readGlobalId: row.read_global_id,
      sourceHash: row.source_hash,
      revisionHash: row.revision_hash,
      materialState: row.material_state,
      capturedAt: row.captured_at.toISOString(),
      fresh: row.fresh === true,
      changed: row.changed === true,
      applyEligible: applyBlockedCode === null,
      applyBlockedCode,
      cancellationEligible: row.order_status === 'imported'
        && row.fresh === true
        && row.zero_downstream === true
        && row.material_state === 'provider_cancelled',
      providerReads: Number(row.provider_read_count),
      providerWrites: 0 as const,
      applicationGlobalId: row.application_global_id,
      exceptionGlobalId: row.exception_global_id,
    }),
  })
}

type ApplicationReplayRow = QueryResultRow & {
  global_id: string
  order_global_id: string
  observation_global_id: string
  read_global_id: string
  source_hash: string
  revision_hash: string
  expected_order_row_version: string
  provider_read_count: number
  request_hash: string
  change_summary: Record<string, unknown>
}

function applicationResult(
  row: ApplicationReplayRow,
  replayed: boolean,
): CommerceOrderRevisionApplicationResult {
  if (
    !GLOBAL_APPLICATION_ID.test(row.global_id)
    || !GLOBAL_ORDER_ID.test(row.order_global_id)
    || !GLOBAL_OBSERVATION_ID.test(row.observation_global_id)
    || !GLOBAL_READ_ID.test(row.read_global_id)
    || !SHA256.test(row.source_hash)
    || !SHA256.test(row.revision_hash)
  ) throw new CommerceOrderRevisionDispositionError(
    'COMMERCE_ORDER_REVISION_APPLY_RESULT_INVALID',
    'The retained provider revision application is invalid',
    500,
  )
  const previousRowVersion = Number(row.expected_order_row_version)
  return Object.freeze({
    applicationGlobalId: row.global_id,
    orderGlobalId: row.order_global_id,
    observationGlobalId: row.observation_global_id,
    readGlobalId: row.read_global_id,
    sourceHash: row.source_hash,
    revisionHash: row.revision_hash,
    previousRowVersion,
    newRowVersion: previousRowVersion + 1,
    replayed,
    providerReads: Number(row.provider_read_count),
    providerWrites: 0 as const,
    changeSummary: row.change_summary,
  })
}

function exactRevisionAddress(value: Record<string, unknown>) {
  const required = ['name', 'line1', 'city', 'postalCode'] as const
  if (required.some((key) => typeof value[key] !== 'string' || !String(value[key]).trim())) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_ADDRESS_INCOMPLETE',
      'The exact provider destination is incomplete',
    )
  }
  const region = String(value.regionCode || value.region || '').trim()
  const country = String(value.countryCode || value.country || '').trim().toUpperCase()
  if (!region || !country) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_ADDRESS_INCOMPLETE',
      'The exact provider destination is incomplete',
    )
  }
  return {
    name: String(value.name).trim(),
    line1: String(value.line1).trim(),
    line2: String(value.line2 || '').trim() || null,
    city: String(value.city).trim(),
    region,
    postalCode: String(value.postalCode).trim(),
    country,
  }
}

function revisionMinor(value: unknown, label: string) {
  const normalized = String(value ?? '')
  if (!/^\d+$/u.test(normalized)) {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_MONEY_INCOMPLETE',
      `Exact provider ${label} is unavailable`,
    )
  }
  return BigInt(normalized)
}

/**
 * Applies a complete exact Shopify or Faire revision to a wholly unstarted
 * local order. Provider reads are immutable evidence; no provider write occurs.
 */
export async function applyCommerceOrderRevisionToClawPilotInPostgres(input: {
  organizationId: string
  actorEmail: string
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string
  expectedSourceHash: string
  expectedRevisionHash: string
  expectedRowVersion: number
  reason: string
  idempotencyKey: string
}): Promise<CommerceOrderRevisionApplicationResult> {
  await assertCommerceOrderRevisionApplyRuntimeReady()
  let actorEmail = ''
  let reason = ''
  try {
    actorEmail = boundedText(input.actorEmail, 'Actor email', 320)
    reason = boundedText(input.reason, 'Provider revision application reason', 500)
    if (reason.length < 8) throw new Error('reason is too short')
  } catch {
    throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_APPLY_INVALID',
      'Provider revision application input is invalid',
      400,
    )
  }
  if (
    !UUID.test(input.organizationId)
    || !GLOBAL_ORDER_ID.test(input.orderGlobalId)
    || !GLOBAL_OBSERVATION_ID.test(input.observationGlobalId)
    || !GLOBAL_READ_ID.test(input.readGlobalId)
    || !SHA256.test(input.expectedSourceHash)
    || !SHA256.test(input.expectedRevisionHash)
    || !Number.isSafeInteger(input.expectedRowVersion)
    || input.expectedRowVersion < 0
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) throw new CommerceOrderRevisionDispositionError(
    'COMMERCE_ORDER_REVISION_APPLY_INVALID',
    'Provider revision application input is invalid',
    400,
  )
  const requestHash = createHash('sha256').update(canonicalJson({
    action: 'apply_unstarted_revision',
    organizationId: input.organizationId,
    actorEmail,
    orderGlobalId: input.orderGlobalId,
    observationGlobalId: input.observationGlobalId,
    readGlobalId: input.readGlobalId,
    expectedSourceHash: input.expectedSourceHash,
    expectedRevisionHash: input.expectedRevisionHash,
    expectedRowVersion: input.expectedRowVersion,
    reason,
    providerWrites: 0,
  })).digest('hex')

  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-revision-apply:${input.organizationId}:${input.idempotencyKey}`,
    )
    const replay = await client.query<ApplicationReplayRow>(
      `SELECT application.global_id,
              order_row.global_id AS order_global_id,
              observation.global_id AS observation_global_id,
              read_evidence.global_id AS read_global_id,
              application.source_hash, application.revision_hash,
              application.expected_order_row_version::text,
              application.provider_read_count, application.request_hash,
              application.change_summary
       FROM operations_commerce_order_revision_applications application
       JOIN operations_orders order_row
         ON order_row.organization_id = application.organization_id
        AND order_row.id = application.order_id
       JOIN operations_commerce_order_revision_observations observation
         ON observation.organization_id = application.organization_id
        AND observation.id = application.observation_id
       JOIN operations_commerce_order_revision_reads read_evidence
         ON read_evidence.organization_id = application.organization_id
        AND read_evidence.id = application.read_id
       WHERE application.organization_id = $1::uuid
         AND application.idempotency_key = $2
         AND application.lifecycle_state = 'sealed'
       FOR UPDATE OF application`,
      [input.organizationId, input.idempotencyKey],
    )
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_IDEMPOTENCY_CONFLICT',
          'This Idempotency-Key was already used for a different provider revision application',
        )
      }
      return applicationResult(replay.rows[0], true)
    }

    await acquireTransactionAdvisoryLock(
      client,
      `operations:order:${input.organizationId}:${input.orderGlobalId}`,
    )
    const exact = await client.query<{
      order_id: string
      order_global_id: string
      order_row_version: string
      order_status: string
      order_requested_delivery_at: Date | null
      previous_source_hash: string
      pipeline_id: string
      integration_account_id: string
      account_global_id: string
      external_order_id: string
      customer_id: string
      target_id: string
      observation_id: string
      read_id: string
      provider: CommerceOrderRevisionProvider
      source_hash: string
      revision_hash: string
      provider_read_count: number
      normalized_snapshot: Record<string, unknown>
      party_snapshot_ciphertext: Buffer | null
      party_snapshot_iv: Buffer | null
      party_snapshot_tag: Buffer | null
      party_snapshot_hash: string | null
      party_content_fingerprint: string | null
      party_snapshot_key_id: string | null
      ship_to_snapshot_ciphertext: Buffer | null
      ship_to_snapshot_iv: Buffer | null
      ship_to_snapshot_tag: Buffer | null
      ship_to_snapshot_hash: string | null
      ship_to_content_fingerprint: string | null
      ship_to_snapshot_key_id: string | null
      candidate_id: string
      candidate_global_id: string
      candidate_run_id: string
    }>(
      `SELECT order_row.id::text AS order_id,
              order_row.global_id AS order_global_id,
              order_row.row_version::text AS order_row_version,
              order_row.status AS order_status,
              order_row.requested_delivery_at AS order_requested_delivery_at,
              CASE WHEN COALESCE(order_row.source_payload->>'sourceHash', '')
                         ~ '^[a-f0-9]{64}$'
                   THEN order_row.source_payload->>'sourceHash'
                   ELSE encode(digest(convert_to(order_row.source_payload::text, 'UTF8'), 'sha256'), 'hex')
              END AS previous_source_hash,
              order_row.pipeline_id::text, order_row.integration_account_id::text,
              account.global_id AS account_global_id, order_row.external_order_id,
              order_row.customer_id::text, target.id::text AS target_id,
              observation.id::text AS observation_id,
              read_evidence.id::text AS read_id, target.provider,
              read_evidence.source_hash, read_evidence.revision_hash,
              read_evidence.provider_read_count,
              observation.normalized_snapshot,
              read_evidence.party_snapshot_ciphertext,
              read_evidence.party_snapshot_iv, read_evidence.party_snapshot_tag,
              read_evidence.party_snapshot_hash,
              read_evidence.party_content_fingerprint,
              read_evidence.party_snapshot_key_id,
              read_evidence.ship_to_snapshot_ciphertext,
              read_evidence.ship_to_snapshot_iv, read_evidence.ship_to_snapshot_tag,
              read_evidence.ship_to_snapshot_hash,
              read_evidence.ship_to_content_fingerprint,
              read_evidence.ship_to_snapshot_key_id,
              candidate.id::text AS candidate_id,
              candidate.global_id AS candidate_global_id,
              candidate.run_id::text AS candidate_run_id
       FROM operations_orders order_row
       JOIN operations_integration_accounts account
         ON account.organization_id = order_row.organization_id
        AND account.id = order_row.integration_account_id
       JOIN operations_commerce_order_revision_targets target
         ON target.organization_id = order_row.organization_id
        AND target.order_id = order_row.id
       JOIN operations_commerce_order_revision_reads read_evidence
         ON read_evidence.organization_id = target.organization_id
        AND read_evidence.id = target.latest_read_id
       JOIN operations_commerce_order_revision_observations observation
         ON observation.organization_id = read_evidence.organization_id
        AND observation.id = read_evidence.observation_id
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = order_row.organization_id
        AND candidate.canonical_order_id = order_row.id
        AND candidate.workflow_state = 'promoted'
       WHERE order_row.organization_id = $1::uuid
         AND order_row.global_id = $2
         AND order_row.status = 'imported'
         AND order_row.row_version = $3
         AND target.provider IN ('shopify', 'faire')
         AND order_row.source_provider = target.provider
         AND account.provider = target.provider
         AND target.claim_state = 'ready'
         AND target.material_state = 'review_required'
         AND target.latest_source_hash = $4
         AND target.accepted_source_hash IS DISTINCT FROM $4
         AND observation.global_id = $5
         AND read_evidence.global_id = $6
         AND read_evidence.source_hash = $4
         AND read_evidence.revision_hash = $7
         AND read_evidence.canonical_row_version = $3
         AND read_evidence.provider_write_count = 0
         AND read_evidence.created_at >= now() - interval '${REVISION_FRESHNESS}'
         AND read_evidence.protected_snapshot_purged_at IS NULL
         AND read_evidence.protected_snapshot_expires_at > now()
       FOR UPDATE OF order_row, target, candidate`,
      [
        input.organizationId,
        input.orderGlobalId,
        input.expectedRowVersion,
        input.expectedSourceHash,
        input.observationGlobalId,
        input.readGlobalId,
        input.expectedRevisionHash,
      ],
    )
    const row = exact.rows[0]
    if (!row) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_APPLY_EVIDENCE_STALE',
        'Refresh the exact provider order before applying it to ClawPilot',
      )
    }
    const downstream = await client.query<{ zero_downstream: boolean }>(
      `SELECT ocr_order_has_zero_downstream(
                $1::uuid,
                $2::uuid
              ) AS zero_downstream`,
      [input.organizationId, row.order_id],
    )
    if (downstream.rows[0]?.zero_downstream !== true) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_APPLY_STARTED',
        'This order has downstream warehouse or shipping evidence and cannot be rewritten',
      )
    }

    const snapshot = jsonRecord(row.normalized_snapshot)
    const providerOrder = jsonRecord(snapshot?.order)
    const states = jsonRecord(providerOrder?.canonicalStates)
    const money = jsonRecord(providerOrder?.money)
    const faireRevisionState = jsonRecord(providerOrder?.providerRevisionState)
    const rawLines = providerOrder?.lines
    if (
      !providerOrder
      || snapshot?.provider !== row.provider
      || (
        row.provider === 'shopify'
          ? snapshot.version !== 'shopify-canonical-order-revision-v1'
          : snapshot.version !== 'faire-canonical-order-revision-v2'
            || faireRevisionState?.orderState !== 'NEW'
            || faireRevisionState?.shipmentCount !== 0
            || faireRevisionState?.lineStateBasis !== 'all_processing'
            || faireRevisionState?.quantityBasis !== 'exact_order_item_quantity'
      )
      || states?.lifecycle !== 'open'
      || states.fulfillment !== 'unfulfilled'
      || states.returns !== 'none'
      || money?.headerState !== 'complete'
      || !Array.isArray(rawLines)
      || rawLines.length < 1
      || rawLines.length > 500
    ) throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_PROVIDER_FACTS_INCOMPLETE',
      'The exact provider order is not a complete unfulfilled revision',
    )
    if (
      !row.party_snapshot_ciphertext || !row.party_snapshot_iv
      || !row.party_snapshot_tag || !row.party_snapshot_hash
      || !row.party_content_fingerprint
      || !row.party_snapshot_key_id
      || !row.ship_to_snapshot_ciphertext || !row.ship_to_snapshot_iv
      || !row.ship_to_snapshot_tag || !row.ship_to_snapshot_hash
      || !row.ship_to_content_fingerprint
      || !row.ship_to_snapshot_key_id
    ) throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_PROTECTED_HEADER_UNAVAILABLE',
      'Protected provider header evidence is unavailable',
    )
    let party: Record<string, unknown>
    let shipToValue: Record<string, unknown>
    try {
      party = decryptCommerceOrderRevisionProtectedSnapshot(
        {
          ciphertext: row.party_snapshot_ciphertext,
          iv: row.party_snapshot_iv,
          tag: row.party_snapshot_tag,
          keyId: row.party_snapshot_key_id,
        },
        input.organizationId,
        row.account_global_id,
        row.external_order_id,
        row.source_hash,
        'party',
      )
      shipToValue = decryptCommerceOrderRevisionProtectedSnapshot(
        {
          ciphertext: row.ship_to_snapshot_ciphertext,
          iv: row.ship_to_snapshot_iv,
          tag: row.ship_to_snapshot_tag,
          keyId: row.ship_to_snapshot_key_id,
        },
        input.organizationId,
        row.account_global_id,
        row.external_order_id,
        row.source_hash,
        'ship_to',
      )
    } catch {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_PROTECTED_HEADER_INVALID',
        'Protected provider header evidence failed integrity validation',
      )
    }
    const expectedPartyFingerprint = String(providerOrder.partyFingerprint || '')
    const expectedShipToFingerprint = String(providerOrder.shipToFingerprint || '')
    if (
      commerceOrderRevisionProtectedContentFingerprint(
        party, input.organizationId, row.account_global_id,
        row.external_order_id, 'party',
      ) !== expectedPartyFingerprint
      || row.party_content_fingerprint !== expectedPartyFingerprint
      || commerceOrderRevisionProtectedContentFingerprint(
        shipToValue, input.organizationId, row.account_global_id,
        row.external_order_id, 'ship_to',
      ) !== expectedShipToFingerprint
      || row.ship_to_content_fingerprint !== expectedShipToFingerprint
      || commerceOrderRevisionProtectedSnapshotDigest(
        party, row.party_snapshot_key_id, input.organizationId,
        row.account_global_id, row.external_order_id, row.source_hash, 'party',
      ) !== row.party_snapshot_hash
      || commerceOrderRevisionProtectedSnapshotDigest(
        shipToValue, row.ship_to_snapshot_key_id, input.organizationId,
        row.account_global_id, row.external_order_id, row.source_hash,
        'ship_to',
      ) !== row.ship_to_snapshot_hash
    ) throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_PROTECTED_HEADER_INVALID',
      'Protected provider header evidence failed integrity validation',
    )
    const partyExternalIdentity = jsonRecord(party.externalIdentity)
    const externalIdentity = typeof partyExternalIdentity?.value === 'string'
      ? partyExternalIdentity.value.trim()
      : typeof party.externalIdentity === 'string'
        ? party.externalIdentity.trim()
        : ''
    if (!externalIdentity) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_PARTY_IDENTITY_INCOMPLETE',
        'The exact provider customer identity is unavailable',
      )
    }
    const partyMatch = await client.query<{ customer_id: string }>(
      `SELECT customer.id::text AS customer_id
       FROM operations_external_identifiers external
       JOIN crm_organizations customer
         ON customer.pipeline_id = $4::uuid
        AND customer.reference_code = external.entity_global_id
        AND customer.relationship_type = 'customer'
       WHERE external.organization_id = $1::uuid
         AND external.integration_account_id = $2::uuid
         AND external.entity_type = 'crm.organization'
         AND external.external_id = $3
         AND external.status = 'active'
       FOR SHARE OF external, customer`,
      [
        input.organizationId,
        row.integration_account_id,
        externalIdentity,
        row.pipeline_id,
      ],
    )
    if (partyMatch.rowCount !== 1 || partyMatch.rows[0].customer_id !== row.customer_id) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_PARTY_IDENTITY_CHANGED',
        'The provider customer no longer maps unambiguously to this ClawPilot customer',
      )
    }
    const shipTo = exactRevisionAddress(shipToValue)
    const currency = String(providerOrder.currency || '')
    const orderNumber = boundedText(providerOrder.orderNumber, 'Provider order number', 255)
    const requestedDeliveryAt = providerOrder.requestedDeliveryAt === null
      ? null
      : typeof providerOrder.requestedDeliveryAt === 'string'
        && !Number.isNaN(new Date(providerOrder.requestedDeliveryAt).getTime())
        ? new Date(providerOrder.requestedDeliveryAt).toISOString()
        : undefined
    if (requestedDeliveryAt === undefined) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_DELIVERY_INCOMPLETE',
        'Exact provider delivery timing is invalid',
      )
    }
    const deliveryPromise = jsonRecord(providerOrder.deliveryPromise)
    const requestedDeliveryForApply = (
      row.provider === 'shopify'
      && deliveryPromise?.coverage === 'partial'
    )
      ? row.order_requested_delivery_at?.toISOString() || null
      : requestedDeliveryAt
    if (!/^[A-Z]{3}$/u.test(currency)) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_MONEY_INCOMPLETE',
        'Exact provider currency is unavailable',
      )
    }
    const subtotalMinor = revisionMinor(money.subtotalMinor, 'subtotal')
    const shippingMinor = revisionMinor(money.shippingMinor, 'shipping')
    const taxMinor = revisionMinor(money.taxMinor, 'tax')
    const discountMinor = revisionMinor(money.discountMinor, 'discount')
    const totalMinor = revisionMinor(money.totalMinor, 'total')
    const moneyMode = money.reconciliationMode
    if (!(
      (
        moneyMode === 'discount_separate'
        && subtotalMinor - discountMinor + shippingMinor + taxMinor === totalMinor
      )
      || (
        moneyMode === 'discount_in_subtotal'
        && discountMinor > BigInt(0)
        && subtotalMinor + shippingMinor + taxMinor === totalMinor
      )
    )) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_MONEY_CONFLICT',
        'Exact provider header money does not reconcile',
      )
    }

    const existingLines = await client.query<{
      id: string
      global_id: string
      external_line_id: string
      product_id: string
      channel_sku: string
      description: string
      quantity: string
      unit_price_minor: string
      weight_grams: number
      dimensions_mm: Record<string, unknown>
      revision_retired_at: Date | null
      candidate_line_id: string | null
      prior_application_line_id: string | null
      requires_shipping: boolean
      packaging_source: string | null
      variant_pack_mapping_id: string | null
      pack_profile_version_id: string | null
    }>(
      `SELECT line.id::text, line.global_id, line.external_line_id,
              line.product_id::text, line.channel_sku, line.description,
              line.quantity::text, line.unit_price_minor::text,
              line.weight_grams, line.dimensions_mm,
              line.revision_retired_at,
              candidate_line.id::text AS candidate_line_id,
              prior_revision.id::text AS prior_application_line_id,
              planning.requires_shipping,
              planning.packaging_source,
              planning.commerce_variant_pack_mapping_id::text
                AS variant_pack_mapping_id,
              planning.pack_profile_version_id::text
                AS pack_profile_version_id
       FROM operations_order_lines line
       LEFT JOIN operations_commerce_order_candidate_lines candidate_line
         ON candidate_line.organization_id = line.organization_id
        AND candidate_line.canonical_order_line_id = line.id
       LEFT JOIN LATERAL (
         SELECT revision_line.id
         FROM operations_commerce_order_revision_application_lines revision_line
         WHERE revision_line.organization_id = line.organization_id
           AND revision_line.canonical_order_line_id = line.id
         ORDER BY revision_line.created_at DESC, revision_line.id DESC
         LIMIT 1
       ) prior_revision ON true
       LEFT JOIN operations_commerce_current_planning_lines planning
         ON planning.organization_id = line.organization_id
        AND planning.canonical_order_line_id = line.id
       WHERE line.organization_id = $1::uuid AND line.order_id = $2::uuid
       ORDER BY line.external_line_id
       FOR UPDATE OF line`,
      [input.organizationId, row.order_id],
    )
    const byExternal = new Map(existingLines.rows.map((line) => [line.external_line_id, line]))
    if (byExternal.size !== existingLines.rows.length) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_LINE_HISTORY_AMBIGUOUS',
        'Canonical provider-line history contains duplicate identities',
      )
    }
    const providerLineIds = new Set<string>()
    const activeLines: Array<{
      source: Record<string, unknown>
      externalLineId: string
      externalProductId: string
      externalVariantId: string
      sku: string
      title: string
      variantTitle: string | null
      quantity: number
      unitMultiplier: number
      unitPriceMinor: bigint
      requiresShipping: boolean
      lineSourceHash: string
      mapping: {
        product_id: string
        product_mapping_id: string
        variant_pack_mapping_id: string | null
        variant_pack_mapping_row_version: string | null
        pack_profile_version_id: string | null
        pack_profile_version_row_version: string | null
        pack_profile_package_level: string | null
        pack_profile_base_each_quantity: number | null
        packaging_weight_source: string | null
        weight_grams: number | null
        length_mm: number | null
        width_mm: number | null
        height_mm: number | null
      }
    }> = []
    for (const value of rawLines) {
      const line = jsonRecord(value)
      if (!line) throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_LINE_INCOMPLETE',
        'An exact provider line is invalid',
      )
      const externalLineId = boundedText(line.externalLineId, 'Provider line identity')
      if (providerLineIds.has(externalLineId)) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_AMBIGUOUS',
          'The exact provider order repeats a line identity',
        )
      }
      providerLineIds.add(externalLineId)
      const ordered = Number(line.orderedQuantity)
      const cancelled = Number(line.cancelledQuantity)
      const fulfilled = Number(line.fulfilledQuantity)
      const current = Number(line.currentQuantity)
      const unfulfilled = Number(line.unfulfilledQuantity)
      const removedOrRefunded = Number(line.removedOrRefundedQuantity)
      const physicalUnitQuantity = Number(line.physicalUnitQuantity)
      const providerUnitMultiplier = line.unitMultiplier === null
        ? 1
        : Number(line.unitMultiplier)
      const commonQuantityInvalid = (
        !Number.isSafeInteger(ordered) || ordered < 1
        || !Number.isSafeInteger(current) || current < 0 || current > ordered
        || !Number.isSafeInteger(cancelled)
        || !Number.isSafeInteger(fulfilled) || fulfilled !== 0
        || !Number.isSafeInteger(unfulfilled) || unfulfilled < 0
        || !Number.isSafeInteger(removedOrRefunded)
        || !Number.isSafeInteger(physicalUnitQuantity)
        || !Number.isSafeInteger(providerUnitMultiplier)
        || providerUnitMultiplier < 1
        || current !== unfulfilled
        || physicalUnitQuantity !== ordered * providerUnitMultiplier
      )
      const providerQuantityInvalid = row.provider === 'shopify'
        ? cancelled !== ordered - current
          || line.returnedQuantity !== null
          || removedOrRefunded !== ordered - current
          || line.unitMultiplier !== null
        : current !== ordered
          || cancelled !== 0
          || line.returnedQuantity !== 0
          || removedOrRefunded !== 0
      if (commonQuantityInvalid || providerQuantityInvalid) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_QUANTITY_INCOMPLETE',
          'Exact provider-unit quantities are incomplete or started',
        )
      }
      if (current === 0) continue
      const externalProductId = boundedText(line.externalProductId, 'Provider product identity')
      const externalVariantId = boundedText(line.externalVariantId, 'Provider variant identity')
      const sku = boundedText(line.sku, 'Provider SKU', 255)
      const title = boundedText(line.titleSnapshot, 'Provider line title', 500)
      const variantTitle = line.variantTitleSnapshot === null
        ? null
        : boundedText(line.variantTitleSnapshot, 'Provider variant title', 500)
      // Canonical quantity remains provider order-unit demand. Shopify has no
      // provider pack multiplier; Faire preserves its exact normalized pack
      // multiplier while separately locking current pack-profile evidence.
      const unitMultiplier = providerUnitMultiplier
      const unitPriceMinor = revisionMinor(line.unitPriceMinor, 'line price')
      const lineSubtotalMinor = revisionMinor(line.lineSubtotalMinor, 'line subtotal')
      if (lineSubtotalMinor !== BigInt(current) * unitPriceMinor) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_MONEY_CONFLICT',
          `Provider line ${externalLineId} money does not reconcile`,
        )
      }
      const mappingResult = await client.query<{
        product_id: string
        product_mapping_id: string
      }>(
        `SELECT mapping.product_id::text,
                mapping.id::text AS product_mapping_id
         FROM operations_product_mappings mapping
         WHERE mapping.organization_id = $1::uuid
           AND mapping.integration_account_id = $2::uuid
           AND mapping.pipeline_id = $3::uuid
           AND mapping.active = true
           AND mapping.external_product_id = $4
           AND mapping.external_variant_id = $5
           AND COALESCE(mapping.channel_sku, '') = $6
         FOR SHARE OF mapping`,
        [
          input.organizationId,
          row.integration_account_id,
          row.pipeline_id,
          externalProductId,
          externalVariantId,
          sku,
        ],
      )
      if (mappingResult.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_MAPPING_AMBIGUOUS',
          `Provider line ${externalLineId} has no unique active product mapping`,
        )
      }
      const productMapping = mappingResult.rows[0]
      const pack = line.requiresShipping === true
        ? (await client.query<{
            variant_pack_mapping_id: string
            variant_pack_mapping_row_version: string
            pack_profile_version_id: string
            pack_profile_version_row_version: string
            pack_profile_package_level: string
            pack_profile_base_each_quantity: number
            packaging_weight_source: 'profile_version'
            weight_grams: number
            length_mm: number
            width_mm: number
            height_mm: number
          }>(
            `SELECT pack_mapping.id::text AS variant_pack_mapping_id,
                    pack_mapping.row_version::text
                      AS variant_pack_mapping_row_version,
                    profile_version.id::text AS pack_profile_version_id,
                    profile_version.row_version::text
                      AS pack_profile_version_row_version,
                    profile.package_level AS pack_profile_package_level,
                    profile_version.base_each_quantity
                      AS pack_profile_base_each_quantity,
                    'profile_version'::text AS packaging_weight_source,
                    profile_version.gross_weight_grams AS weight_grams,
                    profile_version.length_mm,
                    profile_version.width_mm,
                    profile_version.height_mm
             FROM operations_commerce_variant_pack_mappings pack_mapping
             JOIN operations_product_pack_profile_versions profile_version
               ON profile_version.organization_id = pack_mapping.organization_id
              AND profile_version.pipeline_id = pack_mapping.pipeline_id
              AND profile_version.product_id = pack_mapping.product_id
              AND profile_version.id = pack_mapping.default_pack_profile_version_id
             JOIN operations_product_pack_profiles profile
               ON profile.organization_id = profile_version.organization_id
              AND profile.pipeline_id = profile_version.pipeline_id
              AND profile.product_id = profile_version.product_id
              AND profile.id = profile_version.profile_id
             JOIN operations_product_channel_states channel_state
               ON channel_state.organization_id = pack_mapping.organization_id
              AND channel_state.integration_account_id =
                    pack_mapping.integration_account_id
              AND channel_state.pipeline_id = pack_mapping.pipeline_id
              AND channel_state.provider = pack_mapping.provider
              AND channel_state.external_product_id =
                    pack_mapping.external_product_id
              AND channel_state.external_variant_id =
                    pack_mapping.external_variant_id
              AND channel_state.product_id = pack_mapping.product_id
              AND channel_state.product_mapping_id = $7::uuid
             WHERE pack_mapping.organization_id = $1::uuid
               AND pack_mapping.integration_account_id = $2::uuid
               AND pack_mapping.pipeline_id = $3::uuid
               AND pack_mapping.product_id = $4::uuid
               AND pack_mapping.provider = $8
               AND pack_mapping.external_product_id = $5
               AND pack_mapping.external_variant_id = $6
               AND pack_mapping.is_current = true
               AND pack_mapping.projection_state = 'current'
               AND pack_mapping.pack_evidence_hash =
                    channel_state.pack_evidence_hash
               AND profile_version.is_current = true
               AND profile_version.lifecycle_state IN (
                 'customer_confirmed', 'active'
               )
               AND profile_version.dimension_basis = 'outer'
               AND profile_version.evidence_type IN (
                 'customer_confirmed', 'measured', 'provider'
               )
               AND profile_version.weight_basis <> 'unspecified'
               AND profile_version.gross_weight_grams IS NOT NULL
               AND profile_version.length_mm IS NOT NULL
               AND profile_version.width_mm IS NOT NULL
               AND profile_version.height_mm IS NOT NULL
               AND profile.status <> 'retired'
             FOR SHARE OF pack_mapping, profile_version, profile, channel_state`,
            [
              input.organizationId,
              row.integration_account_id,
              row.pipeline_id,
              productMapping.product_id,
              externalProductId,
              externalVariantId,
              productMapping.product_mapping_id,
              row.provider,
            ],
          )).rows
        : []
      if (line.requiresShipping === true && pack.length !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_PACK_MAPPING_INCOMPLETE',
          `Provider line ${externalLineId} lacks exact current pack evidence`,
        )
      }
      const mapping = {
        ...productMapping,
        variant_pack_mapping_id: pack[0]?.variant_pack_mapping_id || null,
        variant_pack_mapping_row_version:
          pack[0]?.variant_pack_mapping_row_version || null,
        pack_profile_version_id: pack[0]?.pack_profile_version_id || null,
        pack_profile_version_row_version:
          pack[0]?.pack_profile_version_row_version || null,
        pack_profile_package_level: pack[0]?.pack_profile_package_level || null,
        pack_profile_base_each_quantity:
          pack[0]?.pack_profile_base_each_quantity || null,
        packaging_weight_source: pack[0]?.packaging_weight_source || null,
        weight_grams: pack[0]?.weight_grams || null,
        length_mm: pack[0]?.length_mm || null,
        width_mm: pack[0]?.width_mm || null,
        height_mm: pack[0]?.height_mm || null,
      }
      activeLines.push({
        source: line,
        externalLineId,
        externalProductId,
        externalVariantId,
        sku,
        title,
        variantTitle,
        quantity: current,
        unitMultiplier,
        unitPriceMinor,
        requiresShipping: line.requiresShipping === true,
        lineSourceHash: SHA256.test(String(line.sourceHash || ''))
          ? String(line.sourceHash)
          : (() => {
              throw new CommerceOrderRevisionDispositionError(
                'COMMERCE_ORDER_REVISION_LINE_INCOMPLETE',
                `Provider line ${externalLineId} source evidence is invalid`,
              )
            })(),
        mapping,
      })
    }
    if (!activeLines.length) throw new CommerceOrderRevisionDispositionError(
      'COMMERCE_ORDER_REVISION_NO_ACTIVE_LINES',
      'The exact provider revision has no unfulfilled lines to apply',
    )
    const merchandiseTotalMinor = activeLines.reduce(
      (sum, line) => sum + BigInt(line.quantity) * line.unitPriceMinor,
      BigInt(0),
    )
    if (!(
      (moneyMode === 'discount_separate' && merchandiseTotalMinor === subtotalMinor)
      || (
        moneyMode === 'discount_in_subtotal'
        && merchandiseTotalMinor - discountMinor === subtotalMinor
      )
    )) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_LINE_MONEY_CONFLICT',
        'Exact provider line money does not match the selected header discount mode',
      )
    }
    const removed = existingLines.rows.filter((line) => (
      line.revision_retired_at === null
      && !activeLines.some((active) => (
        active.externalLineId === line.external_line_id
      ))
    ))
    const legacyRemovedLine = removed.find((line) => (
      line.requires_shipping === true
      && (
        line.packaging_source !== 'variant_pack_mapping'
        || line.variant_pack_mapping_id === null
        || line.pack_profile_version_id === null
      )
    ))
    if (legacyRemovedLine) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_REMOVED_LINE_PACK_AUTHORITY_INCOMPLETE',
        `Removed provider line ${legacyRemovedLine.external_line_id} lacks exact revision pack authority`,
      )
    }
    const added = activeLines.filter((line) => !byExternal.has(line.externalLineId))
    const changed = activeLines.filter((line) => {
      const prior = byExternal.get(line.externalLineId)
      return prior && (
        prior.product_id !== line.mapping.product_id
        || prior.channel_sku !== line.sku
        || Number(prior.quantity) !== line.quantity
        || BigInt(prior.unit_price_minor) !== line.unitPriceMinor
        || prior.revision_retired_at !== null
      )
    })
    const changeSummary = {
      headerChanged: true,
      retainedLines: activeLines.length - added.length - changed.length,
      changedLines: changed.length,
      addedLines: added.length,
      removedLines: removed.length,
    }
    const application = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_commerce_order_revision_applications (
         organization_id, integration_account_id, target_id, observation_id,
         read_id, order_id, provider, action, idempotency_key, request_hash,
         expected_order_row_version, resulting_order_row_version,
         previous_status, resulting_status, previous_source_hash, source_hash,
         revision_hash, change_summary, reason, provider_read_count,
         provider_write_count, actor_email
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7, 'apply_unstarted_revision', $8, $9,
         $10::bigint, $10::bigint + 1, 'imported', 'imported', $11, $12,
         $13, $14::jsonb, $15, $16, 0, $17
       ) RETURNING id::text, global_id`,
      [
        input.organizationId,
        row.integration_account_id,
        row.target_id,
        row.observation_id,
        row.read_id,
        row.order_id,
        row.provider,
        input.idempotencyKey,
        requestHash,
        input.expectedRowVersion,
        row.previous_source_hash,
        row.source_hash,
        row.revision_hash,
        JSON.stringify(changeSummary),
        reason,
        row.provider_read_count,
        actorEmail,
      ],
    )
    const retainedApplication = application.rows[0]
    if (!retainedApplication || !GLOBAL_APPLICATION_ID.test(retainedApplication.global_id)) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_APPLY_NOT_RETAINED',
        'The provider revision application was not retained',
        500,
      )
    }

    let sequence = 0
    for (const line of activeLines) {
      sequence += 1
      const prior = byExternal.get(line.externalLineId)
      let canonicalId = prior?.id || null
      let canonicalGlobalId = prior?.global_id || null
      if (prior) {
        const updatedLine = await client.query(
          `UPDATE operations_order_lines
           SET product_id = $3::uuid, channel_sku = $4, description = $5,
               quantity = $6, unit_price_minor = $7,
               weight_grams = $8, dimensions_mm = $9::jsonb,
               revision_retired_at = NULL, revision_application_id = NULL
           WHERE organization_id = $1::uuid AND id = $2::uuid`,
          [
            input.organizationId,
            prior.id,
            line.mapping.product_id,
            line.sku,
            line.variantTitle ? `${line.title} - ${line.variantTitle}` : line.title,
            line.quantity,
            line.unitPriceMinor.toString(),
            line.requiresShipping ? line.mapping.weight_grams : 0,
            JSON.stringify(line.requiresShipping ? {
              length: line.mapping.length_mm,
              width: line.mapping.width_mm,
              height: line.mapping.height_mm,
            } : { length: 1, width: 1, height: 1 }),
          ],
        )
        if (updatedLine.rowCount !== 1) {
          throw new CommerceOrderRevisionDispositionError(
            'COMMERCE_ORDER_REVISION_LINE_CONFLICT',
            `Canonical line ${line.externalLineId} changed during application`,
          )
        }
      } else {
        const inserted = await client.query<{ id: string; global_id: string }>(
          `INSERT INTO operations_order_lines (
             organization_id, order_id, pipeline_id, product_id,
             external_line_id, channel_sku, description, quantity,
             unit_price_minor, weight_grams, dimensions_mm
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5, $6, $7, $8, $9, $10, $11::jsonb
           ) RETURNING id::text, global_id`,
          [
            input.organizationId, row.order_id, row.pipeline_id,
            line.mapping.product_id, line.externalLineId, line.sku,
            line.variantTitle ? `${line.title} - ${line.variantTitle}` : line.title,
            line.quantity, line.unitPriceMinor.toString(),
            line.requiresShipping ? line.mapping.weight_grams : 0,
            JSON.stringify(line.requiresShipping ? {
              length: line.mapping.length_mm,
              width: line.mapping.width_mm,
              height: line.mapping.height_mm,
            } : { length: 1, width: 1, height: 1 }),
          ],
        )
        canonicalId = inserted.rows[0]?.id || null
        canonicalGlobalId = inserted.rows[0]?.global_id || null
      }
      if (!canonicalId || !canonicalGlobalId) throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_LINE_NOT_RETAINED',
        'A revised canonical line was not retained',
        500,
      )
      const identityEvidence = JSON.stringify({
        applicationGlobalId: retainedApplication.global_id,
        sourceHash: row.source_hash,
        revisionHash: row.revision_hash,
        readGlobalId: input.readGlobalId,
      })
      const identity = prior
        ? await client.query(
            `UPDATE operations_external_identifiers
             SET status = 'active',
                 match_method = 'commerce_order_revision_application',
                 match_evidence = $5::jsonb,
                 last_verified_at = now()
             WHERE organization_id = $1::uuid
               AND integration_account_id = $2::uuid
               AND entity_type = 'operations.order_line'
               AND entity_global_id = $3
               AND external_id = $4
               AND status IN ('active', 'retired')`,
            [
              input.organizationId, row.integration_account_id,
              canonicalGlobalId, line.externalLineId, identityEvidence,
            ],
          )
        : await client.query(
            `INSERT INTO operations_external_identifiers (
               organization_id, integration_account_id, entity_type,
               entity_global_id, external_id, status, match_method,
               match_evidence, last_verified_at
             ) VALUES (
               $1::uuid, $2::uuid, 'operations.order_line', $3, $4,
               'active', 'commerce_order_revision_application', $5::jsonb,
               now()
             )`,
            [
              input.organizationId, row.integration_account_id,
              canonicalGlobalId, line.externalLineId, identityEvidence,
            ],
          )
      if (identity.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_IDENTITY_CONFLICT',
          `Provider line ${line.externalLineId} identity is not exact`,
        )
      }
      const priorSnapshot = prior ? {
        productId: prior.product_id,
        channelSku: prior.channel_sku,
        description: prior.description,
        quantity: prior.quantity,
        unitPriceMinor: prior.unit_price_minor,
        weightGrams: prior.weight_grams,
        dimensionsMm: prior.dimensions_mm,
        retiredAt: prior.revision_retired_at?.toISOString() || null,
      } : null
      const changeKind = !prior ? 'added'
        : changed.some((item) => item.externalLineId === line.externalLineId)
          ? 'changed'
          : 'retained'
      const applicationLine = await client.query(
        `INSERT INTO operations_commerce_order_revision_application_lines (
           organization_id, integration_account_id, pipeline_id,
           application_id, order_id, canonical_order_line_id,
           candidate_line_id, prior_application_line_id,
           line_sequence,
           external_line_id, external_product_id, external_variant_id, sku,
           title_snapshot, variant_title_snapshot, active, canonical_quantity,
           unit_multiplier, unit_price_minor, requires_shipping,
           product_id, product_mapping_id, variant_pack_mapping_id,
           variant_pack_mapping_row_version, pack_profile_version_id,
           pack_profile_version_row_version, pack_profile_package_level,
           pack_profile_base_each_quantity, packaging_weight_source,
           weight_grams, length_mm, width_mm, height_mm, line_source_hash,
           change_kind, prior_canonical_snapshot, prior_canonical_fingerprint
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9,
           $10, $11, $12, $13, $14, $15, true, $16,
           $17, $18, $19, $20::uuid, $21::uuid, $22::uuid,
           $23, $24::uuid, $25, $26, $27, $28,
           $29, $30, $31, $32, $33, $34,
           $35::jsonb, $36
         )`,
        [
          input.organizationId, row.integration_account_id, row.pipeline_id,
          retainedApplication.id, row.order_id, canonicalId,
          prior?.prior_application_line_id ? null : prior?.candidate_line_id || null,
          prior?.prior_application_line_id || null,
          sequence,
          line.externalLineId, line.externalProductId, line.externalVariantId,
          line.sku, line.title, line.variantTitle, line.quantity,
          line.unitMultiplier, line.unitPriceMinor.toString(), line.requiresShipping,
          line.mapping.product_id, line.mapping.product_mapping_id,
          line.mapping.variant_pack_mapping_id,
          line.mapping.variant_pack_mapping_row_version,
          line.mapping.pack_profile_version_id,
          line.mapping.pack_profile_version_row_version,
          line.mapping.pack_profile_package_level,
          line.mapping.pack_profile_base_each_quantity,
          line.requiresShipping ? line.mapping.packaging_weight_source : null,
          line.requiresShipping ? line.mapping.weight_grams : 0,
          line.requiresShipping ? line.mapping.length_mm : 1,
          line.requiresShipping ? line.mapping.width_mm : 1,
          line.requiresShipping ? line.mapping.height_mm : 1,
          line.lineSourceHash,
          changeKind,
          priorSnapshot ? JSON.stringify(priorSnapshot) : null,
          priorSnapshot ? commerceOrderRevisionHash(priorSnapshot) : null,
        ],
      )
      if (applicationLine.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_NOT_RETAINED',
          `Provider line ${line.externalLineId} application was not retained`,
          500,
        )
      }
    }
    for (const line of removed) {
      sequence += 1
      const priorSnapshot = {
        productId: line.product_id,
        channelSku: line.channel_sku,
        description: line.description,
        quantity: line.quantity,
        unitPriceMinor: line.unit_price_minor,
        weightGrams: line.weight_grams,
        dimensionsMm: line.dimensions_mm,
        retiredAt: line.revision_retired_at?.toISOString() || null,
      }
      const retiredLine = await client.query(
        `UPDATE operations_order_lines
         SET revision_retired_at = now(), revision_application_id = $3::uuid
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [input.organizationId, line.id, retainedApplication.id],
      )
      if (retiredLine.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_CONFLICT',
          `Canonical line ${line.external_line_id} changed during retirement`,
        )
      }
      const retiredIdentity = await client.query(
        `UPDATE operations_external_identifiers
         SET status = 'retired',
             match_method = 'commerce_order_revision_application',
             match_evidence = $5::jsonb,
             last_verified_at = now()
         WHERE organization_id = $1::uuid
           AND integration_account_id = $2::uuid
           AND entity_type = 'operations.order_line'
           AND entity_global_id = $3
           AND external_id = $4
           AND status = 'active'`,
        [
          input.organizationId, row.integration_account_id,
          line.global_id, line.external_line_id,
          JSON.stringify({
            applicationGlobalId: retainedApplication.global_id,
            sourceHash: row.source_hash,
            revisionHash: row.revision_hash,
            readGlobalId: input.readGlobalId,
          }),
        ],
      )
      if (retiredIdentity.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_IDENTITY_CONFLICT',
          `Provider line ${line.external_line_id} identity could not be retired`,
        )
      }
      const removedApplicationLine = await client.query(
        `INSERT INTO operations_commerce_order_revision_application_lines (
           organization_id, integration_account_id, pipeline_id,
           application_id, order_id, canonical_order_line_id,
           candidate_line_id, prior_application_line_id,
           line_sequence,
           external_line_id, external_product_id, external_variant_id, sku,
           title_snapshot, active, canonical_quantity, unit_multiplier,
           unit_price_minor, requires_shipping, product_id, product_mapping_id,
           variant_pack_mapping_id, variant_pack_mapping_row_version,
           pack_profile_version_id, pack_profile_version_row_version,
           pack_profile_package_level, pack_profile_base_each_quantity,
           packaging_weight_source,
           weight_grams, length_mm, width_mm, height_mm, line_source_hash,
           change_kind, prior_canonical_snapshot, prior_canonical_fingerprint
         ) SELECT
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9,
           $10, source.external_product_id, source.external_variant_id,
           $11, $12, false, NULL, source.unit_multiplier,
           $13, source.requires_shipping, $14::uuid, source.product_mapping_id,
           source.commerce_variant_pack_mapping_id,
           source.commerce_variant_pack_mapping_row_version,
           source.pack_profile_version_id,
           source.pack_profile_version_row_version,
           source.pack_profile_package_level,
           source.pack_profile_base_each_quantity,
           source.packaging_weight_source,
           CASE WHEN source.requires_shipping THEN source.weight_grams ELSE 0 END,
           CASE WHEN source.requires_shipping THEN source.length_mm ELSE 1 END,
           CASE WHEN source.requires_shipping THEN source.width_mm ELSE 1 END,
           CASE WHEN source.requires_shipping THEN source.height_mm ELSE 1 END,
           source.source_hash, 'removed', $15::jsonb, $16
         FROM operations_commerce_current_planning_lines source
         WHERE source.organization_id = $1::uuid
           AND source.order_candidate_id = $17::uuid
           AND source.canonical_order_line_id = $6::uuid`,
        [
          input.organizationId, row.integration_account_id, row.pipeline_id,
          retainedApplication.id, row.order_id, line.id,
          line.prior_application_line_id ? null : line.candidate_line_id,
          line.prior_application_line_id,
          sequence, line.external_line_id, line.channel_sku, line.description,
          line.unit_price_minor, line.product_id,
          JSON.stringify(priorSnapshot), commerceOrderRevisionHash(priorSnapshot),
          row.candidate_id,
        ],
      )
      if (removedApplicationLine.rowCount !== 1) {
        throw new CommerceOrderRevisionDispositionError(
          'COMMERCE_ORDER_REVISION_LINE_NOT_RETAINED',
          `Removed provider line ${line.external_line_id} evidence was not retained`,
          500,
        )
      }
    }

    const sourcePayload = {
      source: 'commerce_order_revision_application',
      candidateGlobalId: row.candidate_global_id,
      sourceRevision: String(providerOrder.sourceRevision || ''),
      sourceHash: row.source_hash,
      revisionHash: row.revision_hash,
      applicationGlobalId: retainedApplication.global_id,
      providerStatuses: states,
      amountsMinor: {
        subtotal: subtotalMinor.toString(),
        discount: discountMinor.toString(),
        shipping: shippingMinor.toString(),
        tax: taxMinor.toString(),
        total: totalMinor.toString(),
      },
      headerMoney: {
        state: 'complete',
        unavailableFields: [],
        fulfillmentDemandUse: 'exact_lines_only',
        accountingUse: 'eligible',
        customerChargeUse: row.provider === 'shopify' ? 'eligible' : 'blocked',
        reconciliationMode: moneyMode,
      },
      monetaryReconciliation: {
        policyVersion: 'commerce-money-reconciliation-v1',
        basis: 'remaining_unfulfilled_quantity_x_resolved_unit_price',
        providerSubtotalMinor: subtotalMinor.toString(),
        canonicalMerchandiseTotalMinor: merchandiseTotalMinor.toString(),
        varianceMinor: (
          merchandiseTotalMinor - subtotalMinor
        ).toString(),
      },
      partyFingerprint: expectedPartyFingerprint,
      shipToFingerprint: expectedShipToFingerprint,
      lineQuantityEvidence: rawLines,
      providerDeliveryPromise: deliveryPromise,
      providerWrites: 0,
      syncCursorAdvanced: false,
      inventoryWrites: 0,
      reservationWrites: 0,
      fulfillmentWrites: 0,
      shipmentWrites: 0,
    }
    const canonicalOrder = await client.query(
      `UPDATE operations_orders
       SET order_number = $3, currency = $4,
           merchandise_total_minor = $5,
           requested_delivery_at = $6::timestamptz,
           ship_to = $7::jsonb, source_payload = $8::jsonb,
           row_version = row_version + 1, updated_by = $9, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND status = 'imported' AND row_version = $10`,
      [
        input.organizationId, row.order_id, orderNumber, currency,
        merchandiseTotalMinor.toString(),
        requestedDeliveryForApply,
        JSON.stringify(shipTo), JSON.stringify(sourcePayload), actorEmail,
        input.expectedRowVersion,
      ],
    )
    if (canonicalOrder.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_APPLY_ROW_VERSION_STALE',
        'The canonical order changed before the revision could be applied',
      )
    }
    const sealed = await client.query(
      `UPDATE operations_commerce_order_revision_applications
       SET lifecycle_state = 'sealed', sealed_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND order_id = $3::uuid AND target_id = $4::uuid
         AND observation_id = $5::uuid AND read_id = $6::uuid
         AND source_hash = $7 AND revision_hash = $8
         AND expected_order_row_version = $9
         AND resulting_order_row_version = $9 + 1
         AND lifecycle_state = 'building'`,
      [
        input.organizationId, retainedApplication.id, row.order_id,
        row.target_id, row.observation_id, row.read_id, row.source_hash,
        row.revision_hash, input.expectedRowVersion,
      ],
    )
    if (sealed.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_APPLY_SEAL_FAILED',
        'The exact provider revision application could not be sealed',
        500,
      )
    }
    const candidateProjection = await client.query(
      `UPDATE operations_commerce_order_candidates
       SET accepted_revision_application_id = $3::uuid,
           row_version = row_version + 1, updated_by = $4, updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND canonical_order_id = $5::uuid
         AND workflow_state = 'promoted'`,
      [
        input.organizationId, row.candidate_id, retainedApplication.id,
        actorEmail, row.order_id,
      ],
    )
    if (candidateProjection.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_CANDIDATE_AUTHORITY_STALE',
        'The promoted candidate authority changed before application',
      )
    }
    const acceptedTarget = await client.query(
      `UPDATE operations_commerce_order_revision_targets
       SET accepted_source_hash = $3,
           accepted_observation_id = $4::uuid,
           accepted_read_id = $5::uuid,
           accepted_revision_hash = $6,
           applied_application_id = $7::uuid,
           material_state = 'current', claim_state = 'ready',
           attempt_count = 0,
           next_check_at = now() + interval '${REVISION_INTERVAL}',
           locked_by = NULL, lock_token = NULL, locked_until = NULL,
           last_error_code = NULL, row_version = row_version + 1,
           updated_at = now()
       WHERE organization_id = $1::uuid AND id = $2::uuid
         AND latest_observation_id = $4::uuid
         AND latest_read_id = $5::uuid
         AND latest_source_hash = $3
         AND material_state = 'review_required'
         AND claim_state = 'ready'
         AND accepted_source_hash IS DISTINCT FROM $3`,
      [
        input.organizationId, row.target_id, row.source_hash,
        row.observation_id, row.read_id, row.revision_hash,
        retainedApplication.id,
      ],
    )
    if (acceptedTarget.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_TARGET_AUTHORITY_STALE',
        'The exact provider revision target changed before acceptance',
      )
    }
    const resolvedException = await client.query(
      `UPDATE operations_exceptions
       SET status = 'resolved', resolved_by = $4, resolved_at = now(),
           updated_at = now(), details = details || $5::jsonb
       WHERE id = (
         SELECT id FROM operations_exceptions
         WHERE organization_id = $1::uuid AND order_id = $2::uuid
           AND exception_type = $3
         ORDER BY created_at DESC, id DESC LIMIT 1
       )`,
      [
        input.organizationId, row.order_id, REVISION_EXCEPTION_TYPE, actorEmail,
        JSON.stringify({
          resolution: 'provider_revision_applied',
          applicationGlobalId: retainedApplication.global_id,
          observationGlobalId: input.observationGlobalId,
          readGlobalId: input.readGlobalId,
          sourceHash: row.source_hash,
          revisionHash: row.revision_hash,
          resultingOrderRowVersion: input.expectedRowVersion + 1,
          providerWrites: 0,
        }),
      ],
    )
    if (resolvedException.rowCount !== 1) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_REVISION_EXCEPTION_AUTHORITY_STALE',
        'The manager revision exception could not be resolved exactly',
      )
    }
    await client.query(
      `INSERT INTO operations_domain_events (
         organization_id, aggregate_type, aggregate_id, aggregate_global_id,
         event_type, event_version, payload, actor_email, correlation_id,
         idempotency_key
       ) VALUES (
         $1::uuid, 'operations.order', $2::uuid, $3,
         'operations.order.provider_revision_applied', 1, $4::jsonb,
         $5, $6::uuid, $7
       )`,
      [
        input.organizationId, row.order_id, row.order_global_id,
        JSON.stringify({
          applicationGlobalId: retainedApplication.global_id,
          observationGlobalId: input.observationGlobalId,
          readGlobalId: input.readGlobalId,
          provider: row.provider,
          sourceHash: row.source_hash,
          revisionHash: row.revision_hash,
          previousRowVersion: input.expectedRowVersion,
          newRowVersion: input.expectedRowVersion + 1,
          changeSummary,
          providerReads: row.provider_read_count,
          providerWrites: 0,
        }),
        actorEmail, randomUUID(), `commerce-provider-apply:${requestHash}`,
      ],
    )
    await recordAuditEvent({
      actor: actorEmail,
      eventType: 'operations.order.provider_revision_applied',
      aggregateType: 'operations.order',
      aggregateId: row.order_global_id,
      organizationId: input.organizationId,
      eventKey: `commerce-order-revision-application:${retainedApplication.global_id}`,
      payload: {
        applicationGlobalId: retainedApplication.global_id,
        observationGlobalId: input.observationGlobalId,
        readGlobalId: input.readGlobalId,
        provider: row.provider,
        sourceHash: row.source_hash,
        revisionHash: row.revision_hash,
        changeSummary,
        providerReads: row.provider_read_count,
        providerWrites: 0,
      },
    }, client)

    return applicationResult({
      global_id: retainedApplication.global_id,
      order_global_id: row.order_global_id,
      observation_global_id: input.observationGlobalId,
      read_global_id: input.readGlobalId,
      source_hash: row.source_hash,
      revision_hash: row.revision_hash,
      expected_order_row_version: String(input.expectedRowVersion),
      provider_read_count: row.provider_read_count,
      request_hash: requestHash,
      change_summary: changeSummary,
    }, false)
  })
}

export async function readCommerceOrderRevisionHealthFromPostgres() {
  const [result, protectedReferences] = await Promise.all([query<{
    provider: CommerceOrderRevisionProvider
    claim_state: string
    material_state: CommerceOrderRevisionMaterialState
    count: string
    overdue_count: string
    stale_count: string
    store_sync_running: boolean
  }>(
    `SELECT target.provider, target.claim_state, target.material_state,
            operations_commerce_store_sync_is_running(
              target.organization_id,
              target.integration_account_id
            ) AS store_sync_running,
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
     GROUP BY target.provider, target.claim_state, target.material_state,
              target.organization_id, target.integration_account_id
     ORDER BY target.provider, target.claim_state, target.material_state`,
  ), query<{
    referenced_key_ids: string[]
    unpurged_protected_read_count: number
    expired_protected_read_backlog: number
  }>(
    `WITH unpurged AS MATERIALIZED (
       SELECT id, party_snapshot_key_id, ship_to_snapshot_key_id
       FROM operations_commerce_order_revision_reads
       WHERE protected_snapshot_purged_at IS NULL
         AND (
           party_snapshot_key_id IS NOT NULL
           OR ship_to_snapshot_key_id IS NOT NULL
         )
     ), referenced AS (
       SELECT id, party_snapshot_key_id AS key_id FROM unpurged
       WHERE party_snapshot_key_id IS NOT NULL
       UNION
       SELECT id, ship_to_snapshot_key_id AS key_id FROM unpurged
       WHERE ship_to_snapshot_key_id IS NOT NULL
     )
     SELECT COALESCE(
              (SELECT array_agg(DISTINCT key_id ORDER BY key_id)
               FROM referenced), ARRAY[]::text[]
            ) AS referenced_key_ids,
            (SELECT count(*)::integer FROM unpurged)
              AS unpurged_protected_read_count,
            (SELECT count(*)::integer
             FROM (
               SELECT 1
               FROM operations_commerce_order_revision_reads
               WHERE protected_snapshot_purged_at IS NULL
                 AND protected_snapshot_expires_at <= now()
               LIMIT ${PROTECTED_SNAPSHOT_BACKLOG_LIMIT + 1}
             ) bounded_expired)
              AS expired_protected_read_backlog`,
  )])
  const targets = result.rows.map((row) => ({
    provider: row.provider,
    claimState: row.claim_state,
    materialState: row.material_state,
    count: Number(row.count),
    overdue: Number(row.overdue_count),
    stale: Number(row.stale_count),
    storeSyncRunning: row.store_sync_running,
  }))
  const summary = targets.reduce((current, row) => ({
    active: current.active + (row.storeSyncRunning ? row.count : 0),
    retainedPaused:
      current.retainedPaused + (row.storeSyncRunning ? 0 : row.count),
    failed: current.failed + (
      row.storeSyncRunning && row.claimState === 'failed' ? row.count : 0
    ),
    deadLetter:
      current.deadLetter + (
        row.storeSyncRunning && row.claimState === 'dead_letter' ? row.count : 0
      ),
    materialReviewRequired:
      current.materialReviewRequired
      + (row.storeSyncRunning && row.materialState !== 'current' ? row.count : 0),
    overdue: current.overdue + (row.storeSyncRunning ? row.overdue : 0),
    stale: current.stale + (row.storeSyncRunning ? row.stale : 0),
  }), {
    active: 0,
    retainedPaused: 0,
    failed: 0,
    deadLetter: 0,
    materialReviewRequired: 0,
    overdue: 0,
    stale: 0,
  })
  const observedExpiredProtectedReadBacklog = Number(
    protectedReferences.rows[0]?.expired_protected_read_backlog || 0,
  )
  const expiredProtectedReadBacklog = Math.min(
    observedExpiredProtectedReadBacklog,
    PROTECTED_SNAPSHOT_BACKLOG_LIMIT,
  )
  const expiredProtectedReadBacklogTruncated =
    observedExpiredProtectedReadBacklog > PROTECTED_SNAPSHOT_BACKLOG_LIMIT
  let protectedEvidenceKeys
  try {
    const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: process.env,
      hosted: isHostedRuntime(),
    })
    protectedEvidenceKeys = summarizeCommerceOrderRevisionEvidenceKeyReadiness(
      configuration,
      {
        referencedKeyIds:
          protectedReferences.rows[0]?.referenced_key_ids || [],
        unpurgedProtectedReadCount: Number(
          protectedReferences.rows[0]?.unpurged_protected_read_count || 0,
        ),
      },
    )
  } catch {
    protectedEvidenceKeys = {
      status: 'blocked' as const,
      ready: false,
      activeKeyId: null,
      configuredKeyIds: [] as string[],
      referencedKeyIds:
        protectedReferences.rows[0]?.referenced_key_ids || [],
      missingReferencedKeyIds:
        protectedReferences.rows[0]?.referenced_key_ids || [],
      invalidReferencedKeyIdCount: 0,
      unpurgedProtectedReadCount: Number(
        protectedReferences.rows[0]?.unpurged_protected_read_count || 0,
      ),
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    status: (
      summary.failed > 0
      || summary.deadLetter > 0
      || summary.materialReviewRequired > 0
      || summary.overdue > 0
      || summary.stale > 0
      || expiredProtectedReadBacklog > 0
      || protectedEvidenceKeys.ready !== true
    ) ? 'degraded' as const : 'ready' as const,
    providerWrites: 0 as const,
    summary,
    expiredProtectedReadBacklog,
    expiredProtectedReadBacklogTruncated,
    protectedEvidenceKeys,
    targets,
  }
}
