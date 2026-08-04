import { createHash } from 'node:crypto'

export const SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION =
  'commerce-shopify-order-auto-promotion-v1'

export const SHOPIFY_AUTOMATIC_ORDER_PROMOTION_COHORT_ENV =
  'CLAWPILOT_SHOPIFY_ORDER_AUTO_PROMOTION_ACCOUNT_GLOBAL_IDS'

export const AUTOMATIC_SHOPIFY_ORDER_MAX_SOURCE_AGE_MS =
  48 * 60 * 60 * 1_000

const ACCOUNT_GLOBAL_ID_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const DEVELOPMENT_LANES = new Set([
  'dev',
  'development',
  'local',
  'preview',
])
const MAX_COHORT_SIZE = 25

const BENIGN_AUTOMATIC_SHOPIFY_PROMOTION_HOLDS = new Set([
  'canonical_order_exists',
])

type ShopifyAutomaticPromotionEnvironment = Partial<Record<
  | 'CLAWPILOT_ENV'
  | 'RAILWAY_ENVIRONMENT_NAME'
  | 'VERCEL_ENV'
  | 'NODE_ENV'
  | typeof SHOPIFY_AUTOMATIC_ORDER_PROMOTION_COHORT_ENV,
  string | undefined
>>

function lane(environment: ShopifyAutomaticPromotionEnvironment) {
  return String(
    environment.CLAWPILOT_ENV
    || environment.RAILWAY_ENVIRONMENT_NAME
    || environment.VERCEL_ENV
    || environment.NODE_ENV
    || '',
  ).trim().toLowerCase()
}

function hostedProductionLane(
  environment: ShopifyAutomaticPromotionEnvironment,
) {
  return (
    String(environment.RAILWAY_ENVIRONMENT_NAME || '')
      .trim().toLowerCase() === 'production'
    || String(environment.VERCEL_ENV || '')
      .trim().toLowerCase() === 'production'
  )
}

function cohortHash(accountGlobalIds: readonly string[]) {
  return createHash('sha256')
    .update(SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION)
    .update('\0')
    .update(accountGlobalIds.join('\n'))
    .digest('hex')
}

/**
 * Shopify automatic order promotion has no broad enable switch. It is on only
 * for the exact, valid integration-account Global IDs named by the development
 * environment. Missing, malformed, duplicate, or oversized configuration
 * fails closed for the whole cohort instead of partially enabling accounts.
 */
export function shopifyAutomaticOrderPromotionCohort(
  environment: ShopifyAutomaticPromotionEnvironment = process.env,
) {
  const productionVeto = hostedProductionLane(environment)
  const runtimeEligible = (
    !productionVeto
    && DEVELOPMENT_LANES.has(lane(environment))
  )
  const raw = String(
    environment[SHOPIFY_AUTOMATIC_ORDER_PROMOTION_COHORT_ENV] || '',
  ).trim()
  const configured = raw.length > 0
  const entries = configured
    ? raw.split(',').map((value) => value.trim())
    : []
  const uniqueEntries = [...new Set(entries)]
  const valid = (
    configured
    && entries.length <= MAX_COHORT_SIZE
    && entries.length === uniqueEntries.length
    && entries.every((value) => ACCOUNT_GLOBAL_ID_PATTERN.test(value))
  )
  const accountGlobalIds = valid ? [...uniqueEntries].sort() : []
  return {
    policyVersion: SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION,
    runtimeEligible,
    configured,
    valid,
    accountGlobalIds,
    cohortSize: accountGlobalIds.length,
    cohortHash: valid ? cohortHash(accountGlobalIds) : null,
    enabled: runtimeEligible && valid,
    disabledReason: !runtimeEligible
      ? productionVeto
        ? 'hosted_production_runtime'
        : 'development_runtime_required'
      : !configured
        ? 'account_cohort_not_configured'
        : !valid
          ? 'account_cohort_invalid'
          : null,
  } as const
}

export function shopifyAutomaticOrderPromotionGate(input: {
  accountGlobalId: string
  environment?: ShopifyAutomaticPromotionEnvironment
}) {
  const cohort = shopifyAutomaticOrderPromotionCohort(
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

function timestamp(value: Date | string | null) {
  if (value === null) return Number.NaN
  const parsed = value instanceof Date
    ? value.getTime()
    : new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/**
 * Retained or replayed Shopify evidence may not silently become a new order.
 * The source creation and observation must be ordered and no more than 48
 * hours old at the moment the automatic path evaluates them.
 */
export function automaticShopifyOrderSourceIsFresh(input: {
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
      <= AUTOMATIC_SHOPIFY_ORDER_MAX_SOURCE_AGE_MS
    && now - providerCreatedAt
      <= AUTOMATIC_SHOPIFY_ORDER_MAX_SOURCE_AGE_MS
    && now - observedAt
      <= AUTOMATIC_SHOPIFY_ORDER_MAX_SOURCE_AGE_MS
  )
}

/**
 * A canonical-order dedupe is a successful no-op. Every other selector hold
 * means the newly observed order did not cross the clean path and must remain
 * visible as actionable reconciliation attention.
 */
export function automaticShopifyPromotionHoldRequiresAttention(
  reason: string,
) {
  return !BENIGN_AUTOMATIC_SHOPIFY_PROMOTION_HOLDS.has(reason)
}
