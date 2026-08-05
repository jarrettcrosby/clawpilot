export type ShopifyCheckoutChannelEligibilityInput = {
  provider: unknown
  accountEnvironment: unknown
  providerStatusRaw: unknown
  normalizedStatus: unknown
  providerActive: unknown
  requiresShipping: unknown
  weightGrams: unknown
}

function normalizedText(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Defines the provider lifecycle evidence that can back an exact Shopify
 * checkout mapping. Shopify UNLISTED remains truthfully unlisted and
 * provider-inactive in ClawPilot; it is eligible only because Shopify exposes
 * it for direct-link Online Store purchases. Every caller must retain the
 * sandbox, exact-mapping, pack, CarrierService, allowlist, and inventory
 * fences around this predicate.
 */
export function isShopifySandboxCheckoutChannelEligible(
  input: ShopifyCheckoutChannelEligibilityInput,
) {
  const normalizedStatus = normalizedText(input.normalizedStatus)
  const providerStatusRaw = normalizedText(input.providerStatusRaw)
  const lifecycleEligible = (
    normalizedStatus === 'active'
    && providerStatusRaw === 'active'
    && input.providerActive === true
  ) || (
    normalizedStatus === 'unlisted'
    && providerStatusRaw === 'unlisted'
    && input.providerActive === false
  )
  return (
    normalizedText(input.provider) === 'shopify'
    && normalizedText(input.accountEnvironment) === 'sandbox'
    && lifecycleEligible
    && input.requiresShipping === true
    && Number.isSafeInteger(input.weightGrams)
    && Number(input.weightGrams) > 0
  )
}
