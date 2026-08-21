export const ShopifyShadowCheckoutGuardDenialReason = {
  AudienceOff: 'SHOPIFY_SHADOW_GUARD_AUDIENCE_OFF',
  ActivationDisabled:
    'SHOPIFY_CHECKOUT_RATES_EMERGENCY_DISABLED',
  ActivationFrozen:
    'SHOPIFY_CHECKOUT_RATES_EMERGENCY_FROZEN',
  AllEligibleSandboxRequired:
    'SHOPIFY_SHADOW_GUARD_ALL_ELIGIBLE_SANDBOX_REQUIRED',
  MissingCustomer: 'SHOPIFY_SHADOW_GUARD_MISSING_CUSTOMER',
  MissingVariantConfiguration:
    'SHOPIFY_SHADOW_GUARD_MISSING_VARIANT_CONFIGURATION',
  NoShippableItems: 'SHOPIFY_SHADOW_GUARD_NO_SHIPPABLE_ITEMS',
  UnallowlistedVariant: 'SHOPIFY_SHADOW_GUARD_UNALLOWLISTED_VARIANT',
  PolicyAbsentOrIneligible:
    'SHOPIFY_SHADOW_GUARD_POLICY_ABSENT_OR_INELIGIBLE',
  HideAll: 'SHOPIFY_SHADOW_GUARD_HIDE_ALL',
} as const

export type ShopifyShadowCheckoutGuardDenialReason =
  typeof ShopifyShadowCheckoutGuardDenialReason[
    keyof typeof ShopifyShadowCheckoutGuardDenialReason
  ]

export type ShopifyShadowCheckoutGuardDecision =
  | { allowed: true }
  | {
      allowed: false
      reasonCode: ShopifyShadowCheckoutGuardDenialReason
    }

export type ShopifyShadowCheckoutPrePolicyDecision =
  | {
      ready: true
      customerId: string | null
    }
  | {
      ready: false
      reasonCode: ShopifyShadowCheckoutGuardDenialReason
    }

export function shopifyShadowCheckoutGuardDenialTelemetry(input: {
  accountGlobalId: string
  reasonCode: ShopifyShadowCheckoutGuardDenialReason
  checkpoint?: 'account_authenticated' | 'request_parsed'
}) {
  return {
    accountGlobalId: input.accountGlobalId,
    stage: 'shadow_guard' as const,
    checkpoint: input.checkpoint || 'request_parsed',
    reasonCode: input.reasonCode,
  }
}

export function evaluateShopifyShadowCheckoutPrePolicy(input: {
  customerId: string | null | undefined
  customerRequired?: boolean
  variantAllowlistRequired?: boolean
  configuredVariantIds: ReadonlySet<string> | null
  items: ReadonlyArray<{
    requiresShipping: boolean
    variantId: string
  }>
}): ShopifyShadowCheckoutPrePolicyDecision {
  if (input.customerRequired !== false && !input.customerId) {
    return {
      ready: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
    }
  }
  if (
    input.variantAllowlistRequired !== false
    && !input.configuredVariantIds
  ) {
    return {
      ready: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.MissingVariantConfiguration,
    }
  }
  const shippableItems = input.items.filter((item) => item.requiresShipping)
  if (shippableItems.length < 1) {
    return {
      ready: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.NoShippableItems,
    }
  }
  if (
    input.variantAllowlistRequired !== false
    && shippableItems.some(
      (item) => !input.configuredVariantIds?.has(item.variantId),
    )
  ) {
    return {
      ready: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.UnallowlistedVariant,
    }
  }
  return {
    ready: true,
    customerId: input.customerId || null,
  }
}

export function evaluateShopifyShadowCheckoutPolicy(
  policy: { mode: string } | null,
): ShopifyShadowCheckoutGuardDecision {
  if (!policy) {
    return {
      allowed: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.PolicyAbsentOrIneligible,
    }
  }
  if (policy.mode === 'hide_all') {
    return {
      allowed: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.HideAll,
    }
  }
  return { allowed: true }
}
