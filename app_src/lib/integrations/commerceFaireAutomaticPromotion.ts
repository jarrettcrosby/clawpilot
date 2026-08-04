import { createHash } from 'node:crypto'

export const AUTOMATIC_FAIRE_ORDER_MAX_SOURCE_AGE_MS =
  48 * 60 * 60 * 1_000

export const AUTOMATIC_FAIRE_ORDER_MAX_FUTURE_SKEW_MS =
  5 * 60 * 1_000

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_POLICY_VERSION =
  'commerce-faire-order-auto-promotion-v1'

export const AUTOMATIC_FAIRE_ORDER_PROMOTION_ATTENTION_MARKER =
  'COMMERCE_FAIRE_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'

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
