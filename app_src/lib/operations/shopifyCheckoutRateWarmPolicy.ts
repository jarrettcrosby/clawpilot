export const SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION =
  'shopify-checkout-rate-warm-v1'

export type ShopifyCheckoutRateWarmMode = 'hosted_ajax'

export type ShopifyCheckoutRateWarmPolicy = {
  version: typeof SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION
  enabled: boolean
  mode: ShopifyCheckoutRateWarmMode
  zoneScope: 'all_saved_rate_zones'
  concurrency: number
  debounceMs: number
  minIntervalMs: number
  supportedCountries: ['US']
  staleCartAbort: true
}

export class ShopifyCheckoutRateWarmPolicyError extends Error {
  readonly code = 'SHOPIFY_CHECKOUT_RATE_WARM_POLICY_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ShopifyCheckoutRateWarmPolicyError'
  }
}

export const DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY:
  Readonly<ShopifyCheckoutRateWarmPolicy> = {
    version: SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION,
    enabled: false,
    mode: 'hosted_ajax',
    zoneScope: 'all_saved_rate_zones',
    concurrency: 2,
    debounceMs: 350,
    minIntervalMs: 1_000,
    supportedCountries: ['US'],
    staleCartAbort: true,
  }

function fail(message: string): never {
  throw new ShopifyCheckoutRateWarmPolicyError(message)
}

function defaultPolicy(): ShopifyCheckoutRateWarmPolicy {
  return {
    ...DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY,
    supportedCountries: ['US'],
  }
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

/**
 * Normalizes the customer-neutral, tenant-owned rate-warming policy stored
 * in the existing Shopify CarrierService policy snapshot. Creation may use
 * the conservative disabled default. Persisted reads fail closed if the
 * versioned policy is absent or malformed.
 */
export function normalizeShopifyCheckoutRateWarmPolicy(
  value: unknown,
): ShopifyCheckoutRateWarmPolicy {
  if (value === undefined) return defaultPolicy()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Checkout rate-warming policy must be an object')
  }
  const candidate = value as Record<string, unknown>
  const expectedKeys = new Set([
    'version',
    'enabled',
    'mode',
    'zoneScope',
    'concurrency',
    'debounceMs',
    'minIntervalMs',
    'supportedCountries',
    'staleCartAbort',
  ])
  if (
    Object.keys(candidate).length !== expectedKeys.size
    || Object.keys(candidate).some((key) => !expectedKeys.has(key))
  ) {
    fail('Checkout rate-warming policy has unsupported fields')
  }
  if (candidate.version !== SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION) {
    fail('Checkout rate-warming policy version is unsupported')
  }
  if (typeof candidate.enabled !== 'boolean') {
    fail('Checkout rate-warming enabled must be boolean')
  }
  if (candidate.mode !== 'hosted_ajax') {
    fail('Checkout rate-warming v1 requires Shopify hosted AJAX mode')
  }
  if (candidate.zoneScope !== 'all_saved_rate_zones') {
    fail('Checkout rate warming must cover all saved rate zones')
  }
  const concurrency = boundedInteger(
    candidate.concurrency,
    'Checkout rate-warming concurrency',
    1,
    8,
  )
  const debounceMs = boundedInteger(
    candidate.debounceMs,
    'Checkout rate-warming debounce',
    0,
    5_000,
  )
  const minIntervalMs = boundedInteger(
    candidate.minIntervalMs,
    'Checkout rate-warming minimum interval',
    250,
    60_000,
  )
  if (
    !Array.isArray(candidate.supportedCountries)
    || candidate.supportedCountries.length !== 1
    || candidate.supportedCountries[0] !== 'US'
  ) {
    fail('Checkout rate-warming v1 supports United States rate zones only')
  }
  if (candidate.staleCartAbort !== true) {
    fail('Checkout rate-warming stale-cart abort is required')
  }
  return {
    version: SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION,
    enabled: candidate.enabled,
    mode: 'hosted_ajax',
    zoneScope: 'all_saved_rate_zones',
    concurrency,
    debounceMs,
    minIntervalMs,
    supportedCountries: ['US'],
    staleCartAbort: true,
  }
}

export function readShopifyCheckoutRateWarmPolicy(
  policySnapshot: Record<string, unknown>,
): ShopifyCheckoutRateWarmPolicy {
  if (
    !Object.prototype.hasOwnProperty.call(
      policySnapshot,
      'checkoutRateWarm',
    )
  ) {
    fail('Checkout rate-warming policy is not persisted')
  }
  return normalizeShopifyCheckoutRateWarmPolicy(
    policySnapshot.checkoutRateWarm,
  )
}
