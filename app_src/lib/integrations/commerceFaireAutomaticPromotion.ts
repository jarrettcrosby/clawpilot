import { createHash } from 'node:crypto'

export const AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS =
  48 * 60 * 60 * 1_000

export const AUTOMATIC_FAIRE_ORDER_MAX_FUTURE_SKEW_MS =
  5 * 60 * 1_000

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_POLICY_VERSION =
  'commerce-faire-order-auto-promotion-v1'

export const AUTOMATIC_FAIRE_LEGACY_UNATTRIBUTED_ATTENTION_MARKER =
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_ATTENTION_MARKER =
  'COMMERCE_FAIRE_PROMOTION_ATTENTION_REQUIRED'

export const AUTOMATIC_FAIRE_EXACT_REFRESH_ATTENTION_MARKER =
  'COMMERCE_FAIRE_EXACT_REFRESH_ATTENTION_REQUIRED'

export const AUTOMATIC_FAIRE_MIXED_ATTENTION_MARKER =
  'COMMERCE_FAIRE_PROMOTION_AND_EXACT_REFRESH_ATTENTION_REQUIRED'

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_COHORT_ENV =
  'CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS'

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_NOT_BEFORE_ENV =
  'CLAWPILOT_FAIRE_ORDER_AUTO_PROMOTION_NOT_BEFORE'

const ACCOUNT_GLOBAL_ID_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const DEVELOPMENT_LANES = new Set([
  'dev',
  'development',
  'local',
  'preview',
])
const MAX_COHORT_SIZE = 25
const PRODUCTION_HOSTS = new Set([
  'aiapp.eigenracing.com',
])

type FaireAutomaticPromotionEnvironment = Partial<Record<
  | 'CLAWPILOT_ENV'
  | 'CLAWPILOT_PUBLIC_URL'
  | 'RAILWAY_ENVIRONMENT_NAME'
  | 'RAILWAY_PUBLIC_DOMAIN'
  | 'RAILWAY_STATIC_URL'
  | 'VERCEL_ENV'
  | 'VERCEL_URL'
  | 'VERCEL_BRANCH_URL'
  | 'VERCEL_PROJECT_PRODUCTION_URL'
  | 'NODE_ENV'
  | typeof AUTOMATIC_FAIRE_ORDER_PROMOTION_COHORT_ENV
  | typeof AUTOMATIC_FAIRE_ORDER_PROMOTION_NOT_BEFORE_ENV,
  string | undefined
>>

function lane(environment: FaireAutomaticPromotionEnvironment) {
  return String(
    environment.CLAWPILOT_ENV
    || environment.RAILWAY_ENVIRONMENT_NAME
    || environment.VERCEL_ENV
    || environment.NODE_ENV
    || '',
  ).trim().toLowerCase()
}

function hostname(value: string | undefined) {
  const candidate = String(value || '').trim().toLowerCase()
  if (!candidate) return null
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`)
      .hostname.toLowerCase()
  } catch {
    return null
  }
}

function hostedProductionRuntime(
  environment: FaireAutomaticPromotionEnvironment,
) {
  if (
    String(environment.RAILWAY_ENVIRONMENT_NAME || '')
      .trim().toLowerCase() === 'production'
    || String(environment.VERCEL_ENV || '')
      .trim().toLowerCase() === 'production'
  ) return true
  const productionHosts = new Set(PRODUCTION_HOSTS)
  const vercelProductionHost = hostname(
    environment.VERCEL_PROJECT_PRODUCTION_URL,
  )
  if (vercelProductionHost) productionHosts.add(vercelProductionHost)
  return [
    environment.CLAWPILOT_PUBLIC_URL,
    environment.RAILWAY_PUBLIC_DOMAIN,
    environment.RAILWAY_STATIC_URL,
    environment.VERCEL_URL,
    environment.VERCEL_BRANCH_URL,
  ].some((value) => {
    const host = hostname(value)
    return host !== null && productionHosts.has(host)
  })
}

function canonicalUtcIso(value: string) {
  if (!value) return null
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return null
  const canonical = parsed.toISOString()
  return canonical === value ? canonical : null
}

function cohortHash(
  accountGlobalIds: readonly string[],
  notBefore: string,
) {
  return createHash('sha256')
    .update(AUTOMATIC_FAIRE_ORDER_PROMOTION_POLICY_VERSION)
    .update('\0')
    .update(accountGlobalIds.join('\n'))
    .update('\0')
    .update(notBefore)
    .digest('hex')
}

/**
 * Faire automatic order promotion is an explicitly configured development
 * cohort, never a broad runtime switch. Both the exact account list and a
 * canonical UTC rollout boundary are required. The boundary permanently
 * excludes provider orders created before this feature was authorized, even
 * if a later poll observes them again.
 */
export function faireAutomaticOrderPromotionCohort(
  environment: FaireAutomaticPromotionEnvironment = process.env,
) {
  const productionVeto = hostedProductionRuntime(environment)
  const runtimeEligible = (
    !productionVeto
    && DEVELOPMENT_LANES.has(lane(environment))
  )
  const rawAccounts = String(
    environment[AUTOMATIC_FAIRE_ORDER_PROMOTION_COHORT_ENV] || '',
  ).trim()
  const rawNotBefore = String(
    environment[AUTOMATIC_FAIRE_ORDER_PROMOTION_NOT_BEFORE_ENV] || '',
  ).trim()
  const configured = rawAccounts.length > 0 && rawNotBefore.length > 0
  const entries = rawAccounts
    ? rawAccounts.split(',').map((value) => value.trim())
    : []
  const uniqueEntries = [...new Set(entries)]
  const notBefore = canonicalUtcIso(rawNotBefore)
  const valid = (
    configured
    && entries.length <= MAX_COHORT_SIZE
    && entries.length === uniqueEntries.length
    && entries.every((value) => ACCOUNT_GLOBAL_ID_PATTERN.test(value))
    && notBefore !== null
  )
  const accountGlobalIds = valid ? [...uniqueEntries].sort() : []
  return {
    policyVersion: AUTOMATIC_FAIRE_ORDER_PROMOTION_POLICY_VERSION,
    runtimeEligible,
    configured,
    valid,
    accountGlobalIds,
    cohortSize: accountGlobalIds.length,
    notBefore: valid ? notBefore : null,
    notBeforeMs: valid ? new Date(notBefore!).getTime() : null,
    cohortHash: valid ? cohortHash(accountGlobalIds, notBefore!) : null,
    enabled: runtimeEligible && valid,
    disabledReason: !runtimeEligible
      ? productionVeto
        ? 'hosted_production_runtime'
        : 'development_runtime_required'
      : !configured
        ? 'cohort_and_not_before_required'
        : !valid
          ? 'cohort_or_not_before_invalid'
          : null,
  } as const
}

/**
 * Operator-safe cohort state for worker heartbeats and health responses.
 * Deliberately omit configured account Global IDs, the reversible cohort
 * fingerprint, and raw environment values. Size and rollout state are enough
 * for public diagnostics; exact account authority remains server-only.
 */
export function faireAutomaticOrderPromotionGateHealth(
  environment: FaireAutomaticPromotionEnvironment = process.env,
) {
  const cohort = faireAutomaticOrderPromotionCohort(environment)
  return {
    policyVersion: cohort.policyVersion,
    runtimeEligible: cohort.runtimeEligible,
    configured: cohort.configured,
    valid: cohort.valid,
    enabled: cohort.enabled,
    disabledReason: cohort.disabledReason,
    cohortSize: cohort.cohortSize,
    notBefore: cohort.notBefore,
  } as const
}

function healthRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const MAX_PUBLIC_HEALTH_COUNTER = 1_000_000
const MAX_PUBLIC_FAILURE_CODES = 16

const AUTOMATIC_FAIRE_PROMOTION_PUBLIC_FAILURE_CODES = [
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_FAILED',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_SELECTION_FAILED',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_AUTHORITY_STALE',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_GATE_CLOSED',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_INVARIANT_STALE',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_PRODUCT_MAPPING_STALE',
  'COMMERCE_INTAKE_ADDRESS_INCOMPLETE',
  'COMMERCE_INTAKE_ADDRESS_NOT_REQUIRED',
  'COMMERCE_INTAKE_DEFAULT_SLA_UNAVAILABLE',
  'COMMERCE_INTAKE_DELIVERY_NOT_REQUIRED',
  'COMMERCE_INTAKE_MANUAL_DELIVERY_REQUIRED',
  'COMMERCE_INTAKE_PROVIDER_DELIVERY_UNAVAILABLE',
  'COMMERCE_INTAKE_CANDIDATE_NOT_FOUND',
  'COMMERCE_INTAKE_CANDIDATE_EXPIRED',
  'COMMERCE_INTAKE_CANDIDATE_TERMINAL',
  'COMMERCE_INTAKE_ROW_VERSION_CONFLICT',
  'COMMERCE_INTAKE_CREDENTIAL_GENERATION_STALE',
  'COMMERCE_INTAKE_CUSTOMER_REQUIRED',
  'COMMERCE_INTAKE_CUSTOMER_STALE',
  'COMMERCE_INTAKE_NOT_READY',
  'COMMERCE_INTAKE_PACKAGE_PROFILE_STALE',
  'COMMERCE_INTAKE_PACK_MAPPING_STALE',
  'COMMERCE_INTAKE_PRODUCT_MAPPING_STALE',
  'COMMERCE_INTAKE_PRODUCT_STALE',
  'COMMERCE_INTAKE_SOURCE_REVISION_STALE',
] as const

const AUTOMATIC_FAIRE_EXACT_REFRESH_PUBLIC_FAILURE_CODES = [
  'COMMERCE_FAIRE_EXACT_REFRESH_FAILED',
  'COMMERCE_FAIRE_EXACT_REFRESH_CREDENTIAL_STALE',
  'COMMERCE_FAIRE_EXACT_REFRESH_TARGET_INVALID',
  'COMMERCE_INTAKE_ACCOUNT_CHANGED',
  'COMMERCE_INTAKE_CONNECTION_ERROR',
  'COMMERCE_INTAKE_CREDENTIAL_GENERATION_STALE',
  'COMMERCE_INTAKE_DISABLED',
  'COMMERCE_INTAKE_EXACT_ORDER_TARGET_MISMATCH',
  'COMMERCE_INTAKE_INTENT_TARGET_CHANGED',
  'COMMERCE_INTAKE_READ_PREPARATION_FAILED',
  'COMMERCE_INTAKE_READ_RESTART_REQUIRED',
  'COMMERCE_INTAKE_REFRESH_TARGET_CHANGED',
  'COMMERCE_INTAKE_REFRESH_TARGET_MISSING',
  'COMMERCE_INTAKE_REFRESH_TARGET_NOT_FOUND',
  'COMMERCE_INTAKE_SCOPE_REQUIRED',
  'COMMERCE_INTAKE_VERIFICATION_REQUIRED',
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_GATE_CLOSED',
] as const

function healthCount(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_PUBLIC_HEALTH_COUNTER)
    : 0
}

function healthFailureMap(
  value: unknown,
  allowedCodes: readonly string[],
  failureCount: number,
) {
  if (failureCount === 0) return {}
  const source = healthRecord(value)
  const counters: Record<string, number> = {}
  let remaining = failureCount
  const namedEntryLimit = MAX_PUBLIC_FAILURE_CODES - 1
  for (const code of allowedCodes) {
    if (Object.keys(counters).length >= namedEntryLimit) break
    if (!Object.prototype.hasOwnProperty.call(source, code)) continue
    const count = Math.min(healthCount(source[code]), remaining)
    if (count > 0) counters[code] = count
    remaining -= count
    if (remaining === 0) break
  }
  if (remaining > 0) counters.OTHER = remaining
  return counters
}

/**
 * Sanitizes the durable worker summary before it reaches /api/health. Gate
 * metadata is always recalculated from the running deployment so a stale or
 * older heartbeat cannot misstate the current rollout configuration.
 */
export function faireAutomaticOrderPromotionHealthSnapshot(input: {
  heartbeat?: unknown
  environment?: FaireAutomaticPromotionEnvironment
} = {}) {
  const heartbeat = healthRecord(input.heartbeat)
  const failed = healthCount(heartbeat.failed)
  return {
    ...faireAutomaticOrderPromotionGateHealth(
      input.environment || process.env,
    ),
    promoted: healthCount(heartbeat.promoted),
    held: healthCount(heartbeat.held),
    failed,
    failedByCode: healthFailureMap(
      heartbeat.failedByCode,
      AUTOMATIC_FAIRE_PROMOTION_PUBLIC_FAILURE_CODES,
      failed,
    ),
    attentionRequiredAccounts: healthCount(
      heartbeat.attentionRequiredAccounts,
    ),
    operatorReviewRequired: healthCount(heartbeat.operatorReviewRequired),
    providerWrites: healthCount(heartbeat.providerWrites),
    canonicalOrderWrites: healthCount(heartbeat.canonicalOrderWrites),
    inventoryWrites: healthCount(heartbeat.inventoryWrites),
    syncCursorAdvanced: heartbeat.syncCursorAdvanced === true,
  } as const
}

/** Operator-safe exact-refresh counters retained alongside the Faire gate. */
export function faireAutomaticExactRefreshHealthSnapshot(
  heartbeatValue?: unknown,
) {
  const heartbeat = healthRecord(heartbeatValue)
  const failed = healthCount(heartbeat.failed)
  return {
    attempted: healthCount(heartbeat.attempted),
    succeeded: healthCount(heartbeat.succeeded),
    rejected: healthCount(heartbeat.rejected),
    failed,
    failedByCode: healthFailureMap(
      heartbeat.failedByCode,
      AUTOMATIC_FAIRE_EXACT_REFRESH_PUBLIC_FAILURE_CODES,
      failed,
    ),
    operatorReviewRequired: healthCount(heartbeat.operatorReviewRequired),
    providerWrites: healthCount(heartbeat.providerWrites),
    inventoryWrites: healthCount(heartbeat.inventoryWrites),
    syncCursorAdvanced: heartbeat.syncCursorAdvanced === true,
  } as const
}

/**
 * Legacy Faire attention predates durable subtype provenance. It is actionable
 * only in the aggregate and must never be inferred as promotion or exact refresh.
 */
export function faireUnattributedAttentionHealthSnapshot(
  heartbeatValue?: unknown,
) {
  const heartbeat = healthRecord(heartbeatValue)
  const attentionRequiredAccounts = healthCount(
    heartbeat.attentionRequiredAccounts,
  )
  return {
    attentionRequiredAccounts,
    operatorReviewRequired: Math.max(
      attentionRequiredAccounts,
      healthCount(heartbeat.operatorReviewRequired),
    ),
    providerWrites: 0,
    inventoryWrites: 0,
    syncCursorAdvanced: false,
  } as const
}

export function faireAutomaticOrderPromotionGate(input: {
  accountGlobalId: string
  environment?: FaireAutomaticPromotionEnvironment
}) {
  const cohort = faireAutomaticOrderPromotionCohort(
    input.environment || process.env,
  )
  const accountEnabled = (
    cohort.enabled
    && cohort.accountGlobalIds.includes(input.accountGlobalId)
  )
  return {
    ...cohort,
    accountEnabled,
    disabledReason: cohort.disabledReason || (
      accountEnabled ? null : 'account_not_in_cohort'
    ),
  } as const
}

export function automaticFaireOrderIsAfterRolloutBoundary(input: {
  providerCreatedAt: Date | string | null
  observedAt: Date | string | null
  originatingRunCreatedAt: Date | string | null
  originatingIntentCreatedAt: Date | string | null
  notBefore: string
}) {
  const cutoff = timestamp(input.notBefore)
  const values = [
    input.providerCreatedAt,
    input.observedAt,
    input.originatingRunCreatedAt,
    input.originatingIntentCreatedAt,
  ].map(timestamp)
  return Number.isFinite(cutoff)
    && values.every((value) => Number.isFinite(value) && value >= cutoff)
}

const BENIGN_AUTOMATIC_FAIRE_PROMOTION_HOLDS = new Set([
  'exact_refresh_required',
  'canonical_order_exists',
  'order_terminal_no_demand',
  'operator_owned_history',
])

export function automaticFairePromotionHoldRequiresAttention(
  reason: string,
) {
  return !BENIGN_AUTOMATIC_FAIRE_PROMOTION_HOLDS.has(reason)
}

function timestamp(value: Date | string | null) {
  if (value === null) return Number.NaN
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * A staged Faire order is eligible for automatic local promotion only while
 * both the provider source and the captured observation remain current. The
 * current-time checks are essential on an idempotent stage replay: intake
 * evidence is retained for 30 days, but automatic promotion is limited to the
 * first 48 hours.
 */
export function automaticFaireOrderSourceIsFresh(input: {
  providerCreatedAt: Date | string | null
  observedAt: Date | string | null
  nowMs?: number
}) {
  const providerCreatedAt = timestamp(input.providerCreatedAt)
  const observedAt = timestamp(input.observedAt)
  const now = input.nowMs ?? Date.now()
  if (
    !Number.isFinite(providerCreatedAt)
    || !Number.isFinite(observedAt)
    || !Number.isFinite(now)
  ) return false
  return (
    providerCreatedAt <= observedAt
    && observedAt <= now
    && observedAt - providerCreatedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
    && providerCreatedAt - observedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_FUTURE_SKEW_MS
    && now - providerCreatedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
    && now - observedAt
      <= AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS
  )
}
