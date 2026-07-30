import {
  planHybridCartonization,
  type HybridCartonizationInput,
  type HybridCartonizationResult,
} from '@/lib/operations/hybridCartonization'
import type { CheckoutRateParcel } from '@/lib/integrations/carrierCheckoutRate'

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/

export class ShopifyCheckoutRatingError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyCheckoutRatingError'
    this.code = code
  }
}

function checkoutError(code: string, message: string): never {
  throw new ShopifyCheckoutRatingError(code, message)
}

function decimalId(value: unknown, label: string) {
  if (typeof value !== 'string' || !DECIMAL_ID.test(value)) {
    checkoutError(
      'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID',
      `${label} is not an exact Shopify decimal identifier`,
    )
  }
  return value
}

export function shopifyProductGid(value: unknown) {
  return `gid://shopify/Product/${decimalId(value, 'Product ID')}`
}

export function shopifyVariantGid(value: unknown) {
  return `gid://shopify/ProductVariant/${decimalId(value, 'Variant ID')}`
}

function packageParcel(
  recipePackage: HybridCartonizationResult['recipePackages'][number],
): CheckoutRateParcel {
  if (
    recipePackage.rateReadiness.status !== 'ready'
    || recipePackage.rateReadiness.blockers.length
    || !recipePackage.rateReadiness.ratedOuterDimensionsMm
    || !recipePackage.rateReadiness.ratedWeightGrams
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_MISSING',
      `Package ${recipePackage.packageKey} lacks verified rating dimensions or weight`,
    )
  }
  const dimensions = recipePackage.rateReadiness.ratedOuterDimensionsMm
  const grossWeightGrams = recipePackage.rateReadiness.ratedWeightGrams
  if (
    !Number.isSafeInteger(dimensions.length)
    || !Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.length < 1
    || dimensions.width < 1
    || dimensions.height < 1
    || !Number.isSafeInteger(grossWeightGrams)
    || grossWeightGrams < 1
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_INVALID',
      `Package ${recipePackage.packageKey} has invalid rating evidence`,
    )
  }
  const inches = (millimeters: number) => Math.ceil(
    millimeters / 25.4,
  )
  const pounds = Math.ceil(
    (grossWeightGrams / 453.59237) * 10,
  ) / 10
  return {
    packageKey: recipePackage.packageKey,
    description: `ClawPilot carton ${recipePackage.sequence}`,
    exteriorInches: {
      length: inches(dimensions.length),
      width: inches(dimensions.width),
      height: inches(dimensions.height),
    },
    grossPounds: Math.max(0.1, pounds),
  }
}

function assertAllocationConservation(
  input: HybridCartonizationInput,
  plan: HybridCartonizationResult,
) {
  const required = new Map(
    input.lines.map((line) => [line.lineGlobalId, line.quantity]),
  )
  const allocated = new Map<string, number>()
  for (const recipePackage of plan.recipePackages) {
    for (const allocation of recipePackage.lineAllocations) {
      allocated.set(
        allocation.lineGlobalId,
        (allocated.get(allocation.lineGlobalId) || 0) + allocation.quantity,
      )
    }
  }
  if (
    allocated.size !== required.size
    || [...required].some(
      ([lineGlobalId, quantity]) => allocated.get(lineGlobalId) !== quantity,
    )
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_ALLOCATION_CONSERVATION_FAILED',
      'Cartonization did not allocate every requested unit exactly once',
    )
  }
}

/**
 * Converts only a fully evidenced, approved-recipe production plan into the
 * one package array used for both UPS and FedEx. Geometry fallback is never
 * treated as a shippable checkout quote.
 */
export function planShopifyCheckoutPackages(
  input: HybridCartonizationInput,
): {
  plan: HybridCartonizationResult
  parcels: CheckoutRateParcel[]
} {
  if (input.mode !== 'production') {
    checkoutError(
      'SHOPIFY_CHECKOUT_PRODUCTION_EVIDENCE_REQUIRED',
      'Shopify checkout rating requires production evidence mode',
    )
  }
  const plan = planHybridCartonization(input)
  if (plan.status !== 'ready' || plan.blockers.length) {
    checkoutError(
      'SHOPIFY_CHECKOUT_CARTONIZATION_BLOCKED',
      'Approved cartonization evidence is incomplete or stale',
    )
  }
  if (plan.geometryFallbackLines.length) {
    checkoutError(
      'SHOPIFY_CHECKOUT_GEOMETRY_FALLBACK_UNSUPPORTED',
      'Every Shopify checkout line requires a fully approved pack recipe',
    )
  }
  if (plan.recipePackages.length < 1 || plan.recipePackages.length > 50) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_COUNT_INVALID',
      'Shopify checkout requires between 1 and 50 complete packages',
    )
  }
  assertAllocationConservation(input, plan)
  return {
    plan,
    parcels: plan.recipePackages.map(packageParcel),
  }
}
