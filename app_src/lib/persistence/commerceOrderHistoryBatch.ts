import { createHash, randomUUID } from 'node:crypto'
import { commerceReadAccountSql } from '@/lib/integrations/commerceReadRuntime'
import { SHOPIFY_EXACT_HISTORY_MAX_PROVIDER_READS } from '@/lib/integrations/commerceOrderHistoryReadLimits'
import {
  acquireTransactionAdvisoryLock,
  query,
  withTransaction,
} from '@/lib/persistence/postgres'

const COMMAND_TYPE = 'operations.commerce_order_history_sync'
const PROCESSING_RECEIPT_STALE_MS = 5 * 60_000
const EXACT_HISTORY_FRESHNESS = '15 minutes'
const UNAVAILABLE_RETRY_COOLDOWN = '30 minutes'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const ORDER_KEY = /^(?:canonical:gor(?:[0-9]{7}|[0-9a-v]{12})|imported:gcoc(?:[0-9]{7}|[0-9a-v]{12}))$/u
const MAX_ORDER_KEYS = 100
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,120}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u
const TERMINAL_UNSUPPORTED_CODES = new Set([
  'FAIRE_ORDER_HISTORY_EXACT_ID_INVALID',
  'FAIRE_RESOURCE_NOT_FOUND',
  'SHOPIFY_ORDER_HISTORY_EXACT_ID_INVALID',
  'SHOPIFY_ORDER_HISTORY_EXACT_ORDER_UNAVAILABLE',
])
const READABLE_ACCOUNT_SQL = commerceReadAccountSql('account', {
  developmentRequiresActive: true,
})

export type CommerceOrderHistoryBatchProvider = 'shopify' | 'faire'

export type CommerceOrderHistoryBatchCandidate = Readonly<{
  candidateGlobalId: string
  accountGlobalId: string
  integrationAccountId: string
  provider: CommerceOrderHistoryBatchProvider
  credentialGeneration: number
  externalOrderId: string
  previousEvidenceSourceHash: string
  terminal: boolean
  totalEligible: number
}>

export type CommerceOrderHistoryBatchProviderIdentity = Readonly<{
  integrationAccountId: string
  provider: CommerceOrderHistoryBatchProvider
  externalOrderId: string
}>

export type CommerceOrderHistoryBatchOutcome = Readonly<{
  candidateGlobalId: string
  accountGlobalId: string
  provider: CommerceOrderHistoryBatchProvider
  outcome: 'captured' | 'unavailable'
  changed: boolean
  code: string | null
  terminalUnsupported: boolean
  providerReads: number
}>

export type CommerceOrderHistoryBatchResult = Readonly<{
  status: 'succeeded' | 'partial' | 'failed'
  batchLimit: number
  totalEligible: number
  remaining: number
  hasMore: boolean
  continuation: Readonly<{
    mode: 'refresh_again'
    remaining: number
  }> | null
  counts: Readonly<{
    selected: number
    attempted: number
    refreshed: number
    changed: number
    unavailable: number
    providerReads: number
  }>
  failedByCode: Readonly<Record<string, number>>
  outcomes: readonly CommerceOrderHistoryBatchOutcome[]
  providerWrites: 0
  canonicalOrderWrites: 0
}>

export type CommerceOrderHistoryBatchPreparation = Readonly<{
  receiptId: string
  attemptToken: string | null
  candidates: readonly CommerceOrderHistoryBatchCandidate[]
  replayedResult: CommerceOrderHistoryBatchResult | null
}>

type ReceiptPayload = Readonly<{
  version: 1
  batchLimit: number
  totalEligible: number
  candidates: readonly CommerceOrderHistoryBatchCandidate[]
  response?: CommerceOrderHistoryBatchResult
}>

type ReceiptRow = {
  id: string
  request_hash: string
  status: 'processing' | 'succeeded' | 'failed'
  correlation_id: string
  result_payload: unknown
  error_code: string | null
  updated_at: Date
}

export class CommerceOrderHistoryBatchError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CommerceOrderHistoryBatchError'
    this.code = code
    this.status = status
  }
}

export function isCommerceOrderHistoryTerminalUnsupportedCode(code: string) {
  return TERMINAL_UNSUPPORTED_CODES.has(code)
}

function fail(code: string, message: string, status = 409): never {
  throw new CommerceOrderHistoryBatchError(code, message, status)
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
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

function validatedOrderKeys(value: readonly string[] | undefined) {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || value.length > MAX_ORDER_KEYS
    || value.some((orderKey) => (
      typeof orderKey !== 'string' || !ORDER_KEY.test(orderKey)
    ))
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history batch input is invalid',
      400,
    )
  }
  return Object.freeze([...new Set(value)].sort())
}

function validatedCandidate(
  value: CommerceOrderHistoryBatchCandidate,
): CommerceOrderHistoryBatchCandidate {
  if (
    !CANDIDATE_GLOBAL_ID.test(value.candidateGlobalId)
    || !ACCOUNT_GLOBAL_ID.test(value.accountGlobalId)
    || !UUID.test(value.integrationAccountId)
    || !['shopify', 'faire'].includes(value.provider)
    || !Number.isSafeInteger(value.credentialGeneration)
    || value.credentialGeneration < 1
    || typeof value.externalOrderId !== 'string'
    || value.externalOrderId.length < 1
    || value.externalOrderId.length > 512
    || /[\p{C}]/u.test(value.externalOrderId)
    || !SHA256.test(value.previousEvidenceSourceHash)
    || typeof value.terminal !== 'boolean'
    || !Number.isSafeInteger(value.totalEligible)
    || value.totalEligible < 1
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_CANDIDATE_INVALID',
      'The retained exact-history candidate is invalid',
      500,
    )
  }
  return Object.freeze({ ...value })
}

function validatedCandidates(
  value: unknown,
  batchLimit: number,
  expectedTotalEligible?: number,
) {
  if (!Array.isArray(value) || value.length > batchLimit) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_CANDIDATES_INVALID',
      'The retained exact-history candidate set is invalid',
      500,
    )
  }
  const candidates = value.map((candidate) => validatedCandidate(
    candidate as CommerceOrderHistoryBatchCandidate,
  ))
  const identities = new Set<string>()
  const globalIds = new Set<string>()
  const totalEligible = candidates[0]?.totalEligible || 0
  for (const candidate of candidates) {
    const identity = [
      candidate.integrationAccountId,
      candidate.provider,
      candidate.externalOrderId,
    ].join(':')
    if (
      candidate.totalEligible !== totalEligible
      || candidate.totalEligible < candidates.length
      || identities.has(identity)
      || globalIds.has(candidate.candidateGlobalId)
    ) {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_CANDIDATES_INVALID',
        'The retained exact-history candidate set is invalid',
        500,
      )
    }
    identities.add(identity)
    globalIds.add(candidate.candidateGlobalId)
  }
  if (
    expectedTotalEligible !== undefined
    && totalEligible !== expectedTotalEligible
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_CANDIDATES_INVALID',
      'The retained exact-history candidate set is invalid',
      500,
    )
  }
  return Object.freeze(candidates)
}

function validatedOutcome(
  value: unknown,
  expected: CommerceOrderHistoryBatchCandidate,
): CommerceOrderHistoryBatchOutcome {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      'accountGlobalId',
      'candidateGlobalId',
      'changed',
      'code',
      'outcome',
      'provider',
      'providerReads',
      'terminalUnsupported',
    ])
    || value.candidateGlobalId !== expected.candidateGlobalId
    || value.accountGlobalId !== expected.accountGlobalId
    || value.provider !== expected.provider
    || !['captured', 'unavailable'].includes(String(value.outcome || ''))
    || typeof value.changed !== 'boolean'
    || typeof value.terminalUnsupported !== 'boolean'
    || !nonnegativeSafeInteger(value.providerReads)
    || Number(value.providerReads) > (expected.provider === 'shopify'
      ? SHOPIFY_EXACT_HISTORY_MAX_PROVIDER_READS : 2)
    || (
      value.outcome === 'captured'
      && (value.code !== null || value.terminalUnsupported)
    )
    || (
      value.outcome === 'unavailable'
      && (
        value.changed !== false
        || !ERROR_CODE.test(String(value.code || ''))
        || (
          value.terminalUnsupported
          && (
            !expected.terminal
            || !isCommerceOrderHistoryTerminalUnsupportedCode(
              String(value.code || ''),
            )
          )
        )
      )
    )
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_RESULT_INVALID',
      'The retained exact-history batch result is invalid',
      500,
    )
  }
  return Object.freeze({
    candidateGlobalId: String(value.candidateGlobalId),
    accountGlobalId: String(value.accountGlobalId),
    provider: value.provider as CommerceOrderHistoryBatchProvider,
    outcome: value.outcome as 'captured' | 'unavailable',
    changed: Boolean(value.changed),
    code: value.code === null ? null : String(value.code),
    terminalUnsupported: Boolean(value.terminalUnsupported),
    providerReads: Number(value.providerReads),
  })
}

function validatedResult(
  value: unknown,
  expected: ReceiptPayload,
): CommerceOrderHistoryBatchResult {
  const invalid = () => fail(
    'COMMERCE_ORDER_HISTORY_BATCH_RESULT_INVALID',
    'The retained exact-history batch result is invalid',
    500,
  )
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      'batchLimit',
      'canonicalOrderWrites',
      'continuation',
      'counts',
      'failedByCode',
      'hasMore',
      'outcomes',
      'providerWrites',
      'remaining',
      'status',
      'totalEligible',
    ])
    || value.batchLimit !== expected.batchLimit
    || value.totalEligible !== expected.totalEligible
    || !nonnegativeSafeInteger(value.remaining)
    || typeof value.hasMore !== 'boolean'
    || value.hasMore !== (Number(value.remaining) > 0)
    || value.providerWrites !== 0
    || value.canonicalOrderWrites !== 0
    || !plainRecord(value.counts)
    || !exactKeys(value.counts, [
      'attempted',
      'changed',
      'providerReads',
      'refreshed',
      'selected',
      'unavailable',
    ])
    || !plainRecord(value.failedByCode)
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== expected.candidates.length
  ) invalid()
  const resultRecord = value as Record<string, unknown>
  const counts = resultRecord.counts as Record<string, unknown>
  for (const key of Object.keys(counts)) {
    if (!nonnegativeSafeInteger(counts[key])) invalid()
  }
  const selected = Number(counts.selected)
  const attempted = Number(counts.attempted)
  const refreshed = Number(counts.refreshed)
  const unavailable = Number(counts.unavailable)
  const changed = Number(counts.changed)
  if (
    selected !== expected.candidates.length
    || selected > expected.batchLimit
    || attempted !== selected
    || refreshed + unavailable !== attempted
    || changed > refreshed
  ) invalid()
  const outcomes = expected.candidates.map((candidate, index) => (
    validatedOutcome((resultRecord.outcomes as unknown[])[index], candidate)
  ))
  if (
    outcomes.filter((outcome) => outcome.outcome === 'captured').length
      !== refreshed
    || outcomes.filter((outcome) => outcome.outcome === 'unavailable').length
      !== unavailable
    || outcomes.filter((outcome) => outcome.changed).length !== changed
    || outcomes.reduce((sum, outcome) => sum + outcome.providerReads, 0)
      !== Number(counts.providerReads)
  ) invalid()
  const failedByCode = resultRecord.failedByCode as Record<string, unknown>
  const actualFailures: Record<string, number> = {}
  for (const outcome of outcomes) {
    if (!outcome.code) continue
    actualFailures[outcome.code] = (actualFailures[outcome.code] || 0) + 1
  }
  if (
    Object.entries(failedByCode).some(([code, count]) => (
      !ERROR_CODE.test(code)
      || !Number.isSafeInteger(count)
      || Number(count) < 1
      || actualFailures[code] !== count
    ))
    || Object.keys(failedByCode).length !== Object.keys(actualFailures).length
  ) invalid()
  const expectedStatus = unavailable === 0
    ? 'succeeded'
    : refreshed > 0
      ? 'partial'
      : 'failed'
  if (resultRecord.status !== expectedStatus) invalid()
  if (resultRecord.hasMore) {
    if (
      !plainRecord(resultRecord.continuation)
      || !exactKeys(resultRecord.continuation, ['mode', 'remaining'])
      || resultRecord.continuation.mode !== 'refresh_again'
      || resultRecord.continuation.remaining !== resultRecord.remaining
    ) invalid()
  } else if (resultRecord.continuation !== null) invalid()
  return Object.freeze({
    ...(resultRecord as unknown as CommerceOrderHistoryBatchResult),
    counts: Object.freeze({ ...(resultRecord.counts as object) }) as CommerceOrderHistoryBatchResult['counts'],
    failedByCode: Object.freeze({ ...failedByCode }) as Readonly<Record<string, number>>,
    outcomes: Object.freeze(outcomes),
  })
}

function validatedPayload(value: unknown, requireResponse: boolean): ReceiptPayload {
  const expectedKeys = requireResponse
    ? ['batchLimit', 'candidates', 'response', 'totalEligible', 'version']
    : ['batchLimit', 'candidates', 'totalEligible', 'version']
  if (
    !plainRecord(value)
    || !exactKeys(value, expectedKeys)
    || value.version !== 1
    || !Number.isSafeInteger(value.batchLimit)
    || Number(value.batchLimit) < 1
    || Number(value.batchLimit) > 10
    || !nonnegativeSafeInteger(value.totalEligible)
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_RECEIPT_INVALID',
      'The retained exact-history batch receipt is invalid',
      500,
    )
  }
  const batchLimit = Number(value.batchLimit)
  const totalEligible = Number(value.totalEligible)
  const candidates = validatedCandidates(
    value.candidates,
    batchLimit,
    totalEligible,
  )
  const payload: ReceiptPayload = {
    version: 1,
    batchLimit,
    totalEligible,
    candidates,
  }
  if (!requireResponse) return Object.freeze(payload)
  return Object.freeze({
    ...payload,
    response: validatedResult(value.response, payload),
  })
}

export async function listCommerceOrderHistoryBatchCandidatesInPostgres(input: {
  organizationId: string
  limit?: number
  orderKeys?: readonly string[]
  excludeProviderIdentities?: readonly CommerceOrderHistoryBatchProviderIdentity[]
}): Promise<CommerceOrderHistoryBatchCandidate[]> {
  if (!UUID.test(input.organizationId)) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history batch input is invalid',
      400,
    )
  }
  const limit = input.limit ?? 10
  const orderKeys = validatedOrderKeys(input.orderKeys)
  const excluded = [...new Map(
    (input.excludeProviderIdentities || []).map((identity) => [
      [
        identity.integrationAccountId,
        identity.provider,
        identity.externalOrderId,
      ].join(':'),
      identity,
    ]),
  ).values()]
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history batch input is invalid',
      400,
    )
  }
  if (
    excluded.length > 10
    || excluded.some((identity) => (
      !UUID.test(identity.integrationAccountId)
      || !['shopify', 'faire'].includes(identity.provider)
      || typeof identity.externalOrderId !== 'string'
      || identity.externalOrderId.length < 1
      || identity.externalOrderId.length > 512
      || /[\p{C}]/u.test(identity.externalOrderId)
    ))
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history batch input is invalid',
      400,
    )
  }
  const result = await query<{
    candidate_global_id: string
    account_global_id: string
    integration_account_id: string
    provider: CommerceOrderHistoryBatchProvider
    credential_generation: string | number
    external_order_id: string
    previous_evidence_source_hash: string
    terminal: boolean
    total_eligible: string
  }>(
    `WITH requested_order_keys AS (
       SELECT requested.order_key
       FROM jsonb_array_elements_text(
         COALESCE($4::jsonb, '[]'::jsonb)
       ) requested(order_key)
     ), requested_provider_identities AS (
       SELECT canonical.integration_account_id,
              lower(canonical.source_provider) AS provider,
              canonical.external_order_id
       FROM requested_order_keys requested
       JOIN operations_orders canonical
         ON canonical.organization_id = $1::uuid
        AND requested.order_key = 'canonical:' || canonical.global_id
       WHERE lower(canonical.source_provider) IN ('shopify', 'faire')
       UNION
       SELECT imported.integration_account_id,
              imported.provider,
              imported.external_order_id
       FROM requested_order_keys requested
       JOIN operations_commerce_order_candidates imported
         ON imported.organization_id = $1::uuid
        AND requested.order_key = 'imported:' || imported.global_id
       WHERE imported.canonical_order_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM operations_orders canonical
           WHERE canonical.organization_id = imported.organization_id
             AND canonical.integration_account_id
                   = imported.integration_account_id
             AND canonical.external_order_id = imported.external_order_id
         )
     ), history_attempts AS (
       SELECT retained_candidate->>'integrationAccountId'
                AS integration_account_id,
              retained_candidate->>'provider' AS provider,
              retained_candidate->>'externalOrderId' AS external_order_id,
              receipt.completed_at AS last_attempt_at,
              receipt.id AS receipt_id,
              outcome->>'outcome' AS last_outcome,
              outcome->>'terminalUnsupported' = 'true'
                AS terminal_unsupported
       FROM operations_command_receipts receipt
       CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE(receipt.result_payload->'candidates', '[]'::jsonb)
       ) WITH ORDINALITY retained(retained_candidate, candidate_ordinal)
       CROSS JOIN LATERAL jsonb_array_elements(
         COALESCE(
           receipt.result_payload->'response'->'outcomes',
           '[]'::jsonb
         )
       ) WITH ORDINALITY completed(outcome, outcome_ordinal)
       WHERE receipt.organization_id = $1::uuid
         AND receipt.command_type = '${COMMAND_TYPE}'
         AND receipt.status = 'succeeded'
         AND completed.outcome_ordinal = retained.candidate_ordinal
     ), last_history_attempts AS (
       SELECT DISTINCT ON (
                attempt.integration_account_id,
                attempt.provider,
                attempt.external_order_id
              )
              attempt.integration_account_id,
              attempt.provider,
              attempt.external_order_id,
              attempt.last_attempt_at,
              attempt.receipt_id,
              attempt.last_outcome,
              bool_or(attempt.terminal_unsupported) OVER (
                PARTITION BY attempt.integration_account_id,
                             attempt.provider,
                             attempt.external_order_id
              ) AS terminal_unsupported
       FROM history_attempts attempt
       ORDER BY attempt.integration_account_id,
                attempt.provider,
                attempt.external_order_id,
                attempt.last_attempt_at DESC,
                attempt.receipt_id DESC
     ), latest_candidates AS (
       SELECT DISTINCT ON (
                candidate.integration_account_id,
                candidate.provider,
                candidate.external_order_id
              )
              candidate.id,
              candidate.global_id,
              candidate.organization_id,
              candidate.integration_account_id,
              candidate.pipeline_id,
              candidate.run_id,
              candidate.canonical_order_id,
              candidate.provider,
              candidate.external_order_id,
              candidate.source_hash,
              candidate.normalized_order_status,
              candidate.normalized_fulfillment_status,
              candidate.provider_updated_at,
              candidate.observed_at,
              candidate.workflow_state,
              candidate.expires_at
       FROM operations_commerce_order_candidates candidate
       WHERE candidate.organization_id = $1::uuid
         AND candidate.workflow_state <> 'failed'
       ORDER BY candidate.integration_account_id,
                candidate.provider,
                candidate.external_order_id,
                COALESCE(
                  candidate.provider_updated_at,
                  candidate.observed_at
                ) DESC,
                candidate.observed_at DESC,
                candidate.created_at DESC,
                candidate.id DESC
     ), visible_candidates AS (
       SELECT candidate.*,
              account.global_id AS account_global_id,
              account.commerce_credential_generation,
              latest_observation.source_hash AS observation_source_hash,
              latest_observation.provider_updated_at
                AS observation_provider_updated_at,
              latest_observation.observed_at AS observation_observed_at,
              latest_observation.canonical_lifecycle_state,
              latest_observation.canonical_fulfillment_state,
              exact_history.observed_at AS exact_history_observed_at,
              exact_history.provider_updated_at
                AS exact_history_provider_updated_at,
              last_attempt.last_attempt_at,
              last_attempt.last_outcome,
              last_attempt.terminal_unsupported
       FROM latest_candidates candidate
       JOIN operations_integration_accounts account
         ON account.organization_id = candidate.organization_id
        AND account.id = candidate.integration_account_id
        AND account.integration_type = 'commerce'
        AND account.provider = candidate.provider
        AND account.status = 'active'
        AND account.external_account_id IS NOT NULL
        AND ${READABLE_ACCOUNT_SQL}
       JOIN operations_commerce_credentials credential
         ON credential.organization_id = account.organization_id
        AND credential.integration_account_id = account.id
        AND credential.credential_version
              = account.commerce_credential_generation
        AND credential.external_account_id = account.external_account_id
        AND credential.verification_status = 'verified'
        AND (
          (account.provider = 'shopify'
            AND credential.auth_mode = 'shopify_client_credentials')
          OR (account.provider = 'faire'
            AND credential.auth_mode IN ('faire_brand_token', 'faire_oauth'))
        )
       LEFT JOIN operations_commerce_order_workbench workbench
         ON workbench.organization_id = candidate.organization_id
        AND workbench.integration_account_id
              = candidate.integration_account_id
        AND workbench.external_order_id = candidate.external_order_id
       LEFT JOIN operations_commerce_intake_runs run
         ON run.organization_id = candidate.organization_id
        AND run.integration_account_id = candidate.integration_account_id
        AND run.pipeline_id = candidate.pipeline_id
        AND run.id = candidate.run_id
       LEFT JOIN LATERAL (
         SELECT observation.source_hash,
                observation.provider_updated_at,
                observation.observed_at,
                observation.canonical_lifecycle_state,
                observation.canonical_fulfillment_state
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = candidate.organization_id
           AND observation.integration_account_id
                 = candidate.integration_account_id
           AND observation.provider = candidate.provider
           AND observation.external_order_id = candidate.external_order_id
         ORDER BY COALESCE(
                    observation.provider_updated_at,
                    observation.observed_at
                  ) DESC,
                  observation.observed_at DESC,
                  observation.id DESC
         LIMIT 1
       ) latest_observation ON true
       LEFT JOIN LATERAL (
         SELECT observation.provider_updated_at, observation.observed_at
         FROM operations_commerce_order_observations observation
         WHERE observation.organization_id = candidate.organization_id
           AND observation.integration_account_id
                 = candidate.integration_account_id
           AND observation.provider = candidate.provider
           AND observation.external_order_id = candidate.external_order_id
           AND observation.observation_kind IN (
             'manual_exact_read', 'webhook_exact_read'
           )
         ORDER BY COALESCE(
                    observation.provider_updated_at,
                    observation.observed_at
                  ) DESC,
                  observation.observed_at DESC,
                  observation.id DESC
         LIMIT 1
       ) exact_history ON true
       LEFT JOIN last_history_attempts last_attempt
         ON last_attempt.integration_account_id
              = candidate.integration_account_id::text
        AND last_attempt.provider = candidate.provider
        AND last_attempt.external_order_id = candidate.external_order_id
       WHERE (
           candidate.canonical_order_id IS NOT NULL
           OR workbench.id IS NOT NULL
           OR (
             candidate.workflow_state IN ('held', 'resolving', 'ready')
             AND candidate.expires_at > now()
             AND run.expires_at > now()
             AND run.workflow_state <> 'expired'
           )
         )
     ), eligible AS (
       SELECT candidate.*,
              COALESCE(
                candidate.observation_source_hash,
                candidate.source_hash
              ) AS previous_evidence_source_hash,
              COALESCE(
                candidate.canonical_lifecycle_state,
                candidate.normalized_order_status
              ) IN ('cancelled', 'canceled', 'closed')
              OR COALESCE(
                candidate.canonical_fulfillment_state,
                candidate.normalized_fulfillment_status
              ) IN ('fulfilled', 'cancelled', 'canceled') AS terminal,
              GREATEST(
                COALESCE(
                  candidate.observation_provider_updated_at,
                  candidate.observation_observed_at
                ),
                COALESCE(
                  candidate.provider_updated_at,
                  candidate.observed_at
                )
              ) AS provider_activity_at
       FROM visible_candidates candidate
       WHERE (
           candidate.exact_history_observed_at IS NULL
           OR COALESCE(
                candidate.exact_history_provider_updated_at,
                candidate.exact_history_observed_at
              ) < GREATEST(
                COALESCE(
                  candidate.observation_provider_updated_at,
                  candidate.observation_observed_at
                ),
                COALESCE(
                  candidate.provider_updated_at,
                  candidate.observed_at
                )
              )
           OR candidate.exact_history_observed_at
                <= now() - interval '${EXACT_HISTORY_FRESHNESS}'
         )
         AND NOT COALESCE(candidate.terminal_unsupported, false)
         AND NOT COALESCE(
           candidate.last_outcome = 'unavailable'
           AND candidate.last_attempt_at
                 > now() - interval '${UNAVAILABLE_RETRY_COOLDOWN}',
           false
         )
         AND (
           $4::jsonb IS NULL
           OR EXISTS (
             SELECT 1
             FROM requested_provider_identities requested
             WHERE requested.integration_account_id
                     = candidate.integration_account_id
               AND requested.provider = candidate.provider
               AND requested.external_order_id = candidate.external_order_id
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements($3::jsonb) excluded(identity)
           WHERE excluded.identity->>'integrationAccountId'
                  = candidate.integration_account_id::text
             AND excluded.identity->>'provider' = candidate.provider
             AND excluded.identity->>'externalOrderId'
                  = candidate.external_order_id
         )
     )
     SELECT candidate.global_id AS candidate_global_id,
            candidate.account_global_id,
            candidate.integration_account_id::text,
            candidate.provider,
            candidate.commerce_credential_generation
              AS credential_generation,
            candidate.external_order_id,
            candidate.previous_evidence_source_hash,
            candidate.terminal,
            count(*) OVER ()::text AS total_eligible
     FROM eligible candidate
     ORDER BY candidate.last_attempt_at ASC NULLS FIRST,
              candidate.terminal DESC,
              candidate.exact_history_observed_at ASC NULLS FIRST,
              candidate.provider_activity_at DESC,
              candidate.integration_account_id,
              candidate.external_order_id,
              candidate.id
     LIMIT $2::integer`,
    [
      input.organizationId,
      limit,
      JSON.stringify(excluded),
      orderKeys === undefined ? null : JSON.stringify(orderKeys),
    ],
  )
  return result.rows.map((row) => validatedCandidate({
    candidateGlobalId: row.candidate_global_id,
    accountGlobalId: row.account_global_id,
    integrationAccountId: row.integration_account_id,
    provider: row.provider,
    credentialGeneration: Number(row.credential_generation),
    externalOrderId: row.external_order_id,
    previousEvidenceSourceHash: row.previous_evidence_source_hash,
    terminal: row.terminal,
    totalEligible: Number(row.total_eligible),
  }))
}

export async function readLatestCommerceOrderExactHistorySourceHashInPostgres(
  input: {
    organizationId: string
    integrationAccountId: string
    provider: CommerceOrderHistoryBatchProvider
    externalOrderId: string
  },
) {
  if (
    !UUID.test(input.organizationId)
    || !UUID.test(input.integrationAccountId)
    || !['shopify', 'faire'].includes(input.provider)
    || !input.externalOrderId
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history evidence input is invalid',
      400,
    )
  }
  const result = await query<{ source_hash: string }>(
    `SELECT observation.source_hash
     FROM operations_commerce_order_observations observation
     WHERE observation.organization_id = $1::uuid
       AND observation.integration_account_id = $2::uuid
       AND observation.provider = $3
       AND observation.external_order_id = $4
       AND observation.observation_kind IN (
         'manual_exact_read', 'webhook_exact_read'
       )
     ORDER BY COALESCE(
                observation.provider_updated_at,
                observation.observed_at
              ) DESC,
              observation.observed_at DESC,
              observation.id DESC
     LIMIT 1`,
    [
      input.organizationId,
      input.integrationAccountId,
      input.provider,
      input.externalOrderId,
    ],
  )
  const sourceHash = result.rows[0]?.source_hash || null
  if (sourceHash !== null && !SHA256.test(sourceHash)) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_EVIDENCE_INVALID',
      'Exact-history evidence is invalid',
      500,
    )
  }
  return sourceHash
}

export async function prepareCommerceOrderHistoryBatchInPostgres(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  batchLimit: number
  orderKeys?: readonly string[]
  candidates: readonly CommerceOrderHistoryBatchCandidate[]
}): Promise<CommerceOrderHistoryBatchPreparation> {
  const actorEmail = String(input.actorEmail || '').trim().toLowerCase()
  if (
    !UUID.test(input.organizationId)
    || !actorEmail
    || actorEmail.length > 320
    || /[\p{C}]/u.test(actorEmail)
    || !IDEMPOTENCY_KEY.test(input.idempotencyKey)
    || !Number.isSafeInteger(input.batchLimit)
    || input.batchLimit < 1
    || input.batchLimit > 10
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_INPUT_INVALID',
      'Exact-history batch input is invalid',
      400,
    )
  }
  const orderKeys = validatedOrderKeys(input.orderKeys)
  const candidates = validatedCandidates(input.candidates, input.batchLimit)
  const totalEligible = candidates[0]?.totalEligible || 0
  const requestIdentity: Record<string, unknown> = {
    action: 'sync_provider_order_history',
    organizationId: input.organizationId,
    actorEmail,
    batchLimit: input.batchLimit,
    providerWrites: 0,
    canonicalOrderWrites: 0,
    version: 1,
  }
  if (orderKeys !== undefined) requestIdentity.orderKeys = orderKeys
  const requestHash = createHash('sha256').update(
    canonicalJson(requestIdentity),
  ).digest('hex')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `commerce-order-history-sync:${input.organizationId}:${input.idempotencyKey}`,
    )
    const selected = await client.query<ReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_payload, error_code, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND command_type = $2
         AND idempotency_key = $3
       FOR UPDATE`,
      [input.organizationId, COMMAND_TYPE, input.idempotencyKey],
    )
    let receipt = selected.rows[0] || null
    if (receipt && receipt.request_hash !== requestHash) {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used for a different exact-history batch',
      )
    }
    if (receipt?.status === 'succeeded') {
      const retained = validatedPayload(receipt.result_payload, true)
      return Object.freeze({
        receiptId: receipt.id,
        attemptToken: null,
        candidates: Object.freeze([]),
        replayedResult: retained.response || null,
      })
    }
    if (receipt?.status === 'failed') {
      fail(
        ERROR_CODE.test(receipt.error_code || '')
          ? String(receipt.error_code)
          : 'COMMERCE_ORDER_HISTORY_BATCH_PREVIOUSLY_FAILED',
        'This exact-history batch previously failed. Retry with a new Idempotency-Key.',
      )
    }
    if (
      receipt?.status === 'processing'
      && Date.now() - receipt.updated_at.getTime()
        < PROCESSING_RECEIPT_STALE_MS
    ) {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_IN_PROGRESS',
        'This exact-history batch is already in progress',
      )
    }
    let retainedCandidates = candidates
    let retainedTotalEligible = totalEligible
    const attemptToken = randomUUID()
    if (receipt) {
      const retained = validatedPayload(receipt.result_payload, false)
      retainedCandidates = retained.candidates
      retainedTotalEligible = retained.totalEligible
      const updated = await client.query<ReceiptRow>(
        `UPDATE operations_command_receipts
         SET status = 'processing', actor_email = $2,
             attempts = attempts + 1, error_code = NULL,
             error_message = NULL, completed_at = NULL,
             correlation_id = $3::uuid,
             started_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, request_hash, status, correlation_id::text,
                   result_payload, error_code, updated_at`,
        [receipt.id, actorEmail, attemptToken],
      )
      receipt = updated.rows[0]
    } else {
      const created = await client.query<ReceiptRow>(
        `INSERT INTO operations_command_receipts (
           organization_id, command_type, idempotency_key, request_hash,
           actor_email, status, correlation_id, result_payload
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, 'processing', $6::uuid, $7::jsonb
         )
         RETURNING id::text, request_hash, status, correlation_id::text,
                   result_payload, error_code, updated_at`,
        [
          input.organizationId,
          COMMAND_TYPE,
          input.idempotencyKey,
          requestHash,
          actorEmail,
          attemptToken,
          JSON.stringify({
            version: 1,
            batchLimit: input.batchLimit,
            totalEligible: retainedTotalEligible,
            candidates: retainedCandidates,
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
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_NOT_RETAINED',
        'The exact-history batch was not retained',
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

export async function completeCommerceOrderHistoryBatchInPostgres(input: {
  organizationId: string
  receiptId: string
  attemptToken: string
  result: CommerceOrderHistoryBatchResult
}) {
  if (
    !UUID.test(input.organizationId)
    || !UUID.test(input.receiptId)
    || !UUID.test(input.attemptToken)
  ) {
    fail(
      'COMMERCE_ORDER_HISTORY_BATCH_COMPLETION_INVALID',
      'Exact-history batch completion is invalid',
      500,
    )
  }
  return withTransaction(async (client) => {
    const selected = await client.query<ReceiptRow>(
      `SELECT id::text, request_hash, status, correlation_id::text,
              result_payload, error_code, updated_at
       FROM operations_command_receipts
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = $3
       FOR UPDATE`,
      [input.organizationId, input.receiptId, COMMAND_TYPE],
    )
    const receipt = selected.rows[0]
    if (!receipt || receipt.status !== 'processing') {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_COMPLETION_NOT_RETAINED',
        'Exact-history batch completion was not retained',
        500,
      )
    }
    if (receipt.correlation_id !== input.attemptToken) {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_COMPLETION_STALE_ATTEMPT',
        'This exact-history batch attempt was superseded',
      )
    }
    const retained = validatedPayload(receipt.result_payload, false)
    const result = validatedResult(input.result, retained)
    const completed = await client.query<{ id: string }>(
      `UPDATE operations_command_receipts
       SET status = 'succeeded', result_payload = $4::jsonb,
           error_code = NULL, error_message = NULL,
           completed_at = now(), updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND command_type = $3
         AND status = 'processing'
         AND correlation_id = $5::uuid
       RETURNING id::text`,
      [
        input.organizationId,
        input.receiptId,
        COMMAND_TYPE,
        JSON.stringify({
          ...retained,
          response: result,
        }),
        input.attemptToken,
      ],
    )
    if (completed.rowCount !== 1) {
      fail(
        'COMMERCE_ORDER_HISTORY_BATCH_COMPLETION_NOT_RETAINED',
        'Exact-history batch completion was not retained',
        500,
      )
    }
  })
}
