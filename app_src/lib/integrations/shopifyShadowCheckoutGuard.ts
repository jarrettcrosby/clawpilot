export const ShopifyShadowCheckoutGuardDenialReason = {
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
      customerId: string
    }
  | {
      ready: false
      reasonCode: ShopifyShadowCheckoutGuardDenialReason
    }

export function shopifyShadowCheckoutGuardDenialTelemetry(input: {
  accountGlobalId: string
  reasonCode: ShopifyShadowCheckoutGuardDenialReason
}) {
  return {
    accountGlobalId: input.accountGlobalId,
    stage: 'shadow_guard' as const,
    checkpoint: 'request_parsed' as const,
    reasonCode: input.reasonCode,
  }
}

export function evaluateShopifyShadowCheckoutPrePolicy(input: {
  customerId: string | null | undefined
  configuredVariantIds: ReadonlySet<string> | null
  items: ReadonlyArray<{
    requiresShipping: boolean
    variantId: string
  }>
}): ShopifyShadowCheckoutPrePolicyDecision {
  if (!input.customerId) {
    return {
      ready: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
    }
  }
  if (!input.configuredVariantIds) {
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
  if (shippableItems.some(
    (item) => !input.configuredVariantIds?.has(item.variantId),
  )) {
    return {
      ready: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.UnallowlistedVariant,
    }
  }
  return {
    ready: true,
    customerId: input.customerId,
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
