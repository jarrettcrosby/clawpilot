import { createHash } from 'node:crypto'

export const SHOPIFY_AUTOMATIC_ORDER_PROMOTION_POLICY_VERSION =
  'commerce-shopify-order-auto-promotion-v1'

export const SHOPIFY_AUTOMATIC_ORDER_PROMOTION_ATTENTION_MARKER =
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_ATTENTION_REQUIRED'

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

/**
 * Operator-safe cohort state for worker heartbeats and health responses.
 * Exact account IDs and the cohort fingerprint remain server-only authority;
 * a one-account legacy `gia` cohort can otherwise be recovered by hashing the
 * small identifier space and comparing it with the published fingerprint.
 */
export function shopifyAutomaticOrderPromotionGateHealth(
  environment: ShopifyAutomaticPromotionEnvironment = process.env,
) {
  const cohort = shopifyAutomaticOrderPromotionCohort(environment)
  return {
    policyVersion: cohort.policyVersion,
    enabled: cohort.enabled,
    runtimeEligible: cohort.runtimeEligible,
    cohortConfigured: cohort.configured,
    cohortValid: cohort.valid,
    cohortSize: cohort.cohortSize,
    disabledReason: cohort.disabledReason,
  } as const
}

function healthRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const MAX_PUBLIC_HEALTH_COUNTER = 1_000_000
const MAX_PUBLIC_HEALTH_MAP_ENTRIES = 16

const AUTOMATIC_SHOPIFY_PROMOTION_PUBLIC_HOLD_REASONS = [
  'canonical_order_exists',
  'prior_candidate_requires_review',
  'source_age_requires_review',
  'order_state_requires_review',
  'order_money_requires_review',
  'customer_resolution_required',
  'line_items_empty',
  'physical_shipping_required',
  'line_quantity_requires_review',
  'product_sku_or_pack_mapping_requires_review',
  'candidate_blockers_require_review',
  'ship_to_requires_review',
  'delivery_date_requires_review',
  'checkout_rate_lineage_not_applicable',
  'checkout_rate_lineage_ambiguous',
  'checkout_rate_lineage_expired',
  'checkout_rate_lineage_missing',
  'validation_blocked',
  'candidate_promoted',
  'candidate_terminal',
  'candidate_expired',
] as const

const AUTOMATIC_SHOPIFY_PROMOTION_PUBLIC_FAILURE_CODES = [
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_FAILED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_SELECTION_FAILED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_PROVENANCE_FAILED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_GATE_CLOSED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_INVARIANT_STALE',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_MATCH_REQUIRED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_PHYSICAL_SHIPPING_REQUIRED',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_PRIOR_CANDIDATE',
  'COMMERCE_SHOPIFY_ORDER_AUTO_PROMOTION_PRODUCT_MAPPING_STALE',
  'COMMERCE_INTAKE_ADDRESS_INCOMPLETE',
  'COMMERCE_INTAKE_ADDRESS_NOT_REQUIRED',
  'COMMERCE_INTAKE_DEFAULT_SLA_UNAVAILABLE',
  'COMMERCE_INTAKE_DELIVERY_NOT_REQUIRED',
  'COMMERCE_INTAKE_MANUAL_DELIVERY_REQUIRED',
  'COMMERCE_INTAKE_PROVIDER_DELIVERY_UNAVAILABLE',
  'COMMERCE_INTAKE_ALREADY_PROMOTED',
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

function healthCount(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_PUBLIC_HEALTH_COUNTER)
    : 0
}

function healthCounterMap(
  value: unknown,
  allowedKeys: readonly string[],
  total: number,
) {
  if (total === 0) return {}
  const source = healthRecord(value)
  const counters: Record<string, number> = {}
  let remaining = total
  const namedEntryLimit = MAX_PUBLIC_HEALTH_MAP_ENTRIES - 1
  for (const key of allowedKeys) {
    if (Object.keys(counters).length >= namedEntryLimit) break
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const count = Math.min(healthCount(source[key]), remaining)
    if (count > 0) counters[key] = count
    remaining -= count
    if (remaining === 0) break
  }
  if (remaining > 0) counters.OTHER = remaining
  return counters
}

/**
 * Sanitizes the durable Shopify worker summary for worker returns and health.
 * Current deployment gate metadata is recalculated rather than trusted from a
 * stale heartbeat, while bounded allowlisted maps preserve aggregate totals
 * without echoing arbitrary keys that may contain account or provider data.
 */
export function shopifyAutomaticOrderPromotionHealthSnapshot(input: {
  heartbeat?: unknown
  environment?: ShopifyAutomaticPromotionEnvironment
} = {}) {
  const heartbeat = healthRecord(input.heartbeat)
  const held = healthCount(heartbeat.held)
  const actionableHeld = Math.min(
    healthCount(heartbeat.actionableHeld),
    held,
  )
  const failed = healthCount(heartbeat.failed)
  const attentionRequiredAccounts = healthCount(
    heartbeat.attentionRequiredAccounts,
  )
  const minimumOperatorReviewRequired = Math.max(
    Math.min(
      actionableHeld + failed,
      MAX_PUBLIC_HEALTH_COUNTER,
    ),
    attentionRequiredAccounts,
  )
  return {
    ...shopifyAutomaticOrderPromotionGateHealth(
      input.environment || process.env,
    ),
    promoted: healthCount(heartbeat.promoted),
    held,
    actionableHeld,
    heldByReason: healthCounterMap(
      heartbeat.heldByReason,
      AUTOMATIC_SHOPIFY_PROMOTION_PUBLIC_HOLD_REASONS,
      held,
    ),
    failed,
    failedByCode: healthCounterMap(
      heartbeat.failedByCode,
      AUTOMATIC_SHOPIFY_PROMOTION_PUBLIC_FAILURE_CODES,
      failed,
    ),
    rollbackFenced: Math.min(
      healthCount(heartbeat.rollbackFenced),
      failed,
    ),
    attentionRequiredAccounts,
    operatorReviewRequired: Math.max(
      healthCount(heartbeat.operatorReviewRequired),
      minimumOperatorReviewRequired,
    ),
    providerWrites: healthCount(heartbeat.providerWrites),
    canonicalOrderWrites: healthCount(heartbeat.canonicalOrderWrites),
    inventoryWrites: healthCount(heartbeat.inventoryWrites),
    syncCursorAdvanced: heartbeat.syncCursorAdvanced === true,
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
