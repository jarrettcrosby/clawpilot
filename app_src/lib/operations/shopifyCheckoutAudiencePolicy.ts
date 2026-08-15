export const SHOPIFY_CHECKOUT_AUDIENCE_POLICY_VERSION =
  'shopify-checkout-audience-v1'

export const SHOPIFY_CHECKOUT_AUDIENCE_MODES = [
  'off',
  'restricted_customers',
  'all_eligible',
] as const

export type ShopifyCheckoutAudienceMode =
  typeof SHOPIFY_CHECKOUT_AUDIENCE_MODES[number]

export type ShopifyCheckoutAudiencePolicy = {
  version: typeof SHOPIFY_CHECKOUT_AUDIENCE_POLICY_VERSION
  mode: ShopifyCheckoutAudienceMode
}

export const DEFAULT_SHOPIFY_CHECKOUT_AUDIENCE_POLICY:
  Readonly<ShopifyCheckoutAudiencePolicy> = {
    version: SHOPIFY_CHECKOUT_AUDIENCE_POLICY_VERSION,
    mode: 'restricted_customers',
  }

export class ShopifyCheckoutAudiencePolicyError extends Error {
  readonly code = 'SHOPIFY_CHECKOUT_AUDIENCE_POLICY_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ShopifyCheckoutAudiencePolicyError'
  }
}

function defaultPolicy(): ShopifyCheckoutAudiencePolicy {
  return { ...DEFAULT_SHOPIFY_CHECKOUT_AUDIENCE_POLICY }
}

/**
 * Normalizes the explicit account-level audience for Shopify checkout rates.
 * Missing policy retains the historical fail-closed Shadow behavior so an
 * older writer cannot accidentally broaden a checkout audience.
 */
export function normalizeShopifyCheckoutAudiencePolicy(
  value: unknown,
): ShopifyCheckoutAudiencePolicy {
  if (value === undefined) return defaultPolicy()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShopifyCheckoutAudiencePolicyError(
      'Checkout audience policy must be an object',
    )
  }
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (
    keys.length !== 2
    || !keys.includes('version')
    || !keys.includes('mode')
  ) {
    throw new ShopifyCheckoutAudiencePolicyError(
      'Checkout audience policy has unsupported fields',
    )
  }
  if (candidate.version !== SHOPIFY_CHECKOUT_AUDIENCE_POLICY_VERSION) {
    throw new ShopifyCheckoutAudiencePolicyError(
      'Checkout audience policy version is unsupported',
    )
  }
  if (!SHOPIFY_CHECKOUT_AUDIENCE_MODES.includes(
    candidate.mode as ShopifyCheckoutAudienceMode,
  )) {
    throw new ShopifyCheckoutAudiencePolicyError(
      'Checkout audience mode is unsupported',
    )
  }
  return {
    version: SHOPIFY_CHECKOUT_AUDIENCE_POLICY_VERSION,
    mode: candidate.mode as ShopifyCheckoutAudienceMode,
  }
}

export function readShopifyCheckoutAudiencePolicy(
  snapshot: Record<string, unknown>,
) {
  return normalizeShopifyCheckoutAudiencePolicy(
    snapshot.shadowCheckoutAudience,
  )
}
