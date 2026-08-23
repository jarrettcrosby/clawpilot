import type {
  ShopifyCheckoutAudienceMode,
} from './shopifyCheckoutAudiencePolicy'

export const SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION =
  'shopify-checkout-rate-control-v1' as const

export const SHOPIFY_CHECKOUT_RATE_SOURCES = [
  'sandbox',
  'production',
] as const

export type ShopifyCheckoutRateSource =
  typeof SHOPIFY_CHECKOUT_RATE_SOURCES[number]

export type ShopifyCheckoutRateControl = {
  version: typeof SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION
  audience: ShopifyCheckoutAudienceMode
  rateSource: ShopifyCheckoutRateSource
}

export const SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON = {
  EmergencyDisabled: 'SHOPIFY_CHECKOUT_RATES_EMERGENCY_DISABLED',
  EmergencyFrozen: 'SHOPIFY_CHECKOUT_RATES_EMERGENCY_FROZEN',
  ConfiguredOff: 'SHOPIFY_SHADOW_GUARD_AUDIENCE_OFF',
  ProductionSourceRequired:
    'SHOPIFY_CHECKOUT_PRODUCTION_RATE_SOURCE_REQUIRED',
  RestrictedLiveEnforcementRequired:
    'SHOPIFY_CHECKOUT_RESTRICTED_LIVE_ENFORCEMENT_REQUIRED',
  RuntimeNotReady: 'SHOPIFY_CHECKOUT_RATING_RUNTIME_NOT_READY',
  Serving: 'SHOPIFY_CHECKOUT_RATES_SERVING',
} as const

export type ShopifyCheckoutRateEffectiveReason =
  typeof SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON[
    keyof typeof SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON
  ]

export type ShopifyCheckoutRateControlLegacyContext = {
  activationState: 'disabled' | 'shadow' | 'read_only' | 'active' | 'frozen'
  accountEnvironment: 'mock' | 'sandbox' | 'production'
}

export class ShopifyCheckoutRateControlError extends Error {
  readonly code = 'SHOPIFY_CHECKOUT_RATE_CONTROL_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'ShopifyCheckoutRateControlError'
  }
}

export function normalizeShopifyCheckoutRateControl(
  value: unknown,
): ShopifyCheckoutRateControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShopifyCheckoutRateControlError(
      'Checkout rate control must be an object',
    )
  }
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).sort().join('\n')
      !== ['audience', 'rateSource', 'version'].join('\n')
  ) {
    throw new ShopifyCheckoutRateControlError(
      'Checkout rate control has unsupported fields',
    )
  }
  if (candidate.version !== SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION) {
    throw new ShopifyCheckoutRateControlError(
      'Checkout rate control version is unsupported',
    )
  }
  if (typeof candidate.audience !== 'string' || ![
    'off',
    'restricted_customers',
    'all_eligible',
  ].includes(candidate.audience)) {
    throw new ShopifyCheckoutRateControlError(
      'Checkout rate audience is unsupported',
    )
  }
  if (!SHOPIFY_CHECKOUT_RATE_SOURCES.includes(
    candidate.rateSource as ShopifyCheckoutRateSource,
  )) {
    throw new ShopifyCheckoutRateControlError(
      'Checkout carrier rate source is unsupported',
    )
  }
  return {
    version: SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION,
    audience: candidate.audience as ShopifyCheckoutAudienceMode,
    rateSource: candidate.rateSource as ShopifyCheckoutRateSource,
  }
}

/**
 * Rolling compatibility for configs last written before migration 0299.
 * A production Shopify connection never derives a sandbox serving source.
 * Other legacy rows retain the former Active=>LIVE, otherwise TEST choice.
 */
export function legacyShopifyCheckoutRateControl(
  snapshot: Record<string, unknown>,
  context: ShopifyCheckoutRateControlLegacyContext,
): ShopifyCheckoutRateControl {
  const rawAudience = snapshot.shadowCheckoutAudience
  const audience = rawAudience === undefined
    ? 'restricted_customers'
    : rawAudience
      && typeof rawAudience === 'object'
      && !Array.isArray(rawAudience)
      && Object.keys(rawAudience).sort().join('\n') === 'mode\nversion'
      && (rawAudience as { version?: unknown }).version
        === 'shopify-checkout-audience-v1'
      && typeof (rawAudience as { mode?: unknown }).mode === 'string'
      && ['off', 'restricted_customers', 'all_eligible'].includes(
        (rawAudience as { mode: string }).mode,
      )
      ? (rawAudience as { mode: ShopifyCheckoutAudienceMode }).mode
      : null
  if (!audience) {
    throw new ShopifyCheckoutRateControlError(
      'Legacy checkout audience policy is invalid',
    )
  }
  return {
    version: SHOPIFY_CHECKOUT_RATE_CONTROL_VERSION,
    audience,
    rateSource: context.accountEnvironment === 'production'
      || context.activationState === 'active'
      ? 'production'
      : 'sandbox',
  }
}

export function readShopifyCheckoutRateControl(
  snapshot: Record<string, unknown>,
  context: ShopifyCheckoutRateControlLegacyContext,
): ShopifyCheckoutRateControl {
  if (snapshot.checkoutRateControl === undefined) {
    return legacyShopifyCheckoutRateControl(snapshot, context)
  }
  return normalizeShopifyCheckoutRateControl(
    snapshot.checkoutRateControl,
  )
}

export function shopifyCheckoutRateControlCanServe(input: {
  control: ShopifyCheckoutRateControl
  accountEnvironment: ShopifyCheckoutRateControlLegacyContext['accountEnvironment']
  activationState: ShopifyCheckoutRateControlLegacyContext['activationState']
}): boolean {
  if (
    input.activationState === 'disabled'
    || input.activationState === 'frozen'
    || input.control.audience === 'off'
  ) {
    return false
  }
  if (
    input.control.audience === 'restricted_customers'
    && input.control.rateSource === 'production'
  ) {
    return false
  }
  return !(
    input.accountEnvironment === 'production'
    && input.control.rateSource !== 'production'
  )
}

export function shopifyCheckoutRateControlEmptyReason(input: {
  control: ShopifyCheckoutRateControl
  accountEnvironment: ShopifyCheckoutRateControlLegacyContext['accountEnvironment']
  activationState: ShopifyCheckoutRateControlLegacyContext['activationState']
}): ShopifyCheckoutRateEffectiveReason | null {
  if (input.activationState === 'disabled') {
    return SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.EmergencyDisabled
  }
  if (input.activationState === 'frozen') {
    return SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.EmergencyFrozen
  }
  if (input.control.audience === 'off') {
    return SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.ConfiguredOff
  }
  if (
    input.accountEnvironment === 'production'
    && input.control.rateSource === 'sandbox'
  ) {
    return SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON.ProductionSourceRequired
  }
  if (
    input.control.audience === 'restricted_customers'
    && input.control.rateSource === 'production'
  ) {
    return SHOPIFY_CHECKOUT_RATE_EFFECTIVE_REASON
      .RestrictedLiveEnforcementRequired
  }
  return null
}
