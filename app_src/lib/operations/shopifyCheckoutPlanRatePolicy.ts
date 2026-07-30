// Node's focused strip-types tests need the explicit extension.
// @ts-expect-error TypeScript extension imports are intentionally used for Node tests.
import { DEFAULT_WORKSPACE_CURRENCY_CODE, isIso4217CurrencyCode } from '../currency.ts'

export const SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION =
  'shopify-checkout-plan-rate-objective-v2'

export type ShopifyCheckoutPlanRateObjective =
  | 'landed_price'
  | 'package_count'
  | 'unused_cube'

export type ShopifyCheckoutPlanRatePolicy = {
  version: typeof SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION
  maxCandidates: number
  objectivePriority: ShopifyCheckoutPlanRateObjective[]
  handlingCostMinorPerPackage: number
  handlingCostCurrency: string
}

export class ShopifyCheckoutPlanRatePolicyError extends Error {
  readonly code = 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ShopifyCheckoutPlanRatePolicyError'
  }
}

const OBJECTIVES: ShopifyCheckoutPlanRateObjective[] = [
  'landed_price',
  'package_count',
  'unused_cube',
]

export const DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY:
  Readonly<ShopifyCheckoutPlanRatePolicy> = {
    version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
    maxCandidates: 4,
    objectivePriority: [
      'landed_price',
      'package_count',
      'unused_cube',
    ],
    handlingCostMinorPerPackage: 0,
    handlingCostCurrency: DEFAULT_WORKSPACE_CURRENCY_CODE,
  }

function fail(message: string): never {
  throw new ShopifyCheckoutPlanRatePolicyError(message)
}

function defaultPolicy(): ShopifyCheckoutPlanRatePolicy {
  return {
    version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
    maxCandidates: DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY.maxCandidates,
    objectivePriority: [
      ...DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY.objectivePriority,
    ],
    handlingCostMinorPerPackage:
      DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY
        .handlingCostMinorPerPackage,
    handlingCostCurrency:
      DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY.handlingCostCurrency,
  }
}

/**
 * Normalizes the business-owned objective saved in the existing
 * organization/account/warehouse-bound Shopify CarrierService policy
 * snapshot. Creation may request the conservative deterministic default;
 * persisted configuration reads fail closed when the policy is absent or
 * malformed.
 */
export function normalizeShopifyCheckoutPlanRatePolicy(
  value: unknown,
): ShopifyCheckoutPlanRatePolicy {
  if (value === undefined) return defaultPolicy()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Checkout plan-rate policy must be an object')
  }
  const candidate = value as Record<string, unknown>
  const expectedKeys = new Set([
    'version',
    'maxCandidates',
    'objectivePriority',
    'handlingCostMinorPerPackage',
    'handlingCostCurrency',
  ])
  if (
    Object.keys(candidate).length !== expectedKeys.size
    || Object.keys(candidate).some((key) => !expectedKeys.has(key))
  ) {
    fail('Checkout plan-rate policy has unsupported fields')
  }
  if (candidate.version !== SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION) {
    fail('Checkout plan-rate policy version is unsupported')
  }
  if (
    !Number.isSafeInteger(candidate.maxCandidates)
    || Number(candidate.maxCandidates) < 1
    || Number(candidate.maxCandidates) > 4
  ) {
    fail('Checkout plan-rate policy allows between 1 and 4 candidates')
  }
  if (
    !Array.isArray(candidate.objectivePriority)
    || candidate.objectivePriority.length !== OBJECTIVES.length
  ) {
    fail('Checkout plan-rate policy requires every objective exactly once')
  }
  const objectivePriority =
    candidate.objectivePriority.map((objective) => {
      if (
        typeof objective !== 'string'
        || !OBJECTIVES.includes(
          objective as ShopifyCheckoutPlanRateObjective,
        )
      ) {
        fail('Checkout plan-rate policy has an unsupported objective')
      }
      return objective as ShopifyCheckoutPlanRateObjective
    })
  if (new Set(objectivePriority).size !== OBJECTIVES.length) {
    fail('Checkout plan-rate policy cannot repeat an objective')
  }
  if (
    !Number.isSafeInteger(candidate.handlingCostMinorPerPackage)
    || Number(candidate.handlingCostMinorPerPackage) < 0
    || Number(candidate.handlingCostMinorPerPackage) > 1_000_000
  ) {
    fail(
      'Checkout plan-rate handling cost must be exact nonnegative minor units',
    )
  }
  const handlingCostCurrency = String(
    candidate.handlingCostCurrency ?? '',
  ).trim().toUpperCase()
  if (!isIso4217CurrencyCode(handlingCostCurrency)) {
    fail('Checkout plan-rate handling cost requires an ISO 4217 currency')
  }
  return {
    version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
    maxCandidates: Number(candidate.maxCandidates),
    objectivePriority,
    handlingCostMinorPerPackage:
      Number(candidate.handlingCostMinorPerPackage),
    handlingCostCurrency,
  }
}

export function readShopifyCheckoutPlanRatePolicy(
  policySnapshot: Record<string, unknown>,
): ShopifyCheckoutPlanRatePolicy {
  if (
    !Object.prototype.hasOwnProperty.call(
      policySnapshot,
      'planRateOptimization',
    )
  ) {
    fail('Checkout plan-rate policy is not persisted')
  }
  return normalizeShopifyCheckoutPlanRatePolicy(
    policySnapshot.planRateOptimization,
  )
}
