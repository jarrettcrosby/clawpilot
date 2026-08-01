import type { CheckoutRateOffer } from '@/lib/integrations/carrierCheckoutRate'
import {
  stableShopifyCarrierServiceCode,
} from '@/lib/integrations/shopifyCarrierServiceProtocol'
import {
  SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MAX_LENGTH,
  SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MIN_LENGTH,
  type ShopifyShadowTestChargeMode,
} from '@/lib/integrations/shopifyCustomerRatePolicy'

export type ShopifyShadowTestChargePolicy = {
  policyHash?: string
  rowVersion?: number
  shadowTestChargeMode?: ShopifyShadowTestChargeMode
  shadowTestServiceCode?: string | null
  shadowTestSubsidyReason?: string | null
}

export type ShopifyCheckoutChargedOffer = CheckoutRateOffer & {
  customerChargeMinor: number
  subsidyReason: string | null
}

export class ShopifyShadowTestChargeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyShadowTestChargeError'
    this.code = code
  }
}

function carrierRateOffers(
  offers: CheckoutRateOffer[],
): ShopifyCheckoutChargedOffer[] {
  return offers.map((offer) => ({
    ...offer,
    customerChargeMinor: offer.amountMinor,
    subsidyReason: null,
  }))
}

export function shopifyShadowTestChargePolicyFence(input: {
  activationState: string
  policy: ShopifyShadowTestChargePolicy | null
}) {
  if (input.activationState !== 'shadow' || !input.policy) return null
  return {
    policyHash: input.policy.policyHash ?? null,
    rowVersion: input.policy.rowVersion ?? null,
    chargeMode: input.policy.shadowTestChargeMode ?? 'carrier_rate',
    serviceCode: input.policy.shadowTestServiceCode ?? null,
    subsidyReason: input.policy.shadowTestSubsidyReason ?? null,
  }
}

/**
 * Applies the operator-configured Shadow checkout subsidy to exactly one
 * stable Shopify service code. Carrier costs remain immutable evidence; only
 * the customer-facing charge may be reduced. Active and default paths are
 * deliberately unchanged.
 */
export function applyShopifyShadowTestCharge(input: {
  activationState: string
  policy: ShopifyShadowTestChargePolicy | null
  offers: CheckoutRateOffer[]
}): ShopifyCheckoutChargedOffer[] {
  if (
    input.activationState !== 'shadow'
    || input.policy?.shadowTestChargeMode !== 'zero_single_service'
  ) {
    return carrierRateOffers(input.offers)
  }

  const selectedServiceCode = input.policy.shadowTestServiceCode
  const subsidyReason = input.policy.shadowTestSubsidyReason?.trim() || null
  if (
    !selectedServiceCode
    || !subsidyReason
    || subsidyReason.length < SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MIN_LENGTH
    || subsidyReason.length > SHOPIFY_SHADOW_TEST_SUBSIDY_REASON_MAX_LENGTH
  ) {
    throw new ShopifyShadowTestChargeError(
      'SHOPIFY_SHADOW_TEST_SUBSIDY_INVALID',
      'Shadow test subsidy configuration is incomplete',
    )
  }

  const selectedOffers = input.offers.filter((offer) => (
    stableShopifyCarrierServiceCode(
      offer.carrierCode,
      offer.serviceLevelCode,
    ) === selectedServiceCode
  ))
  if (selectedOffers.length !== 1) {
    throw new ShopifyShadowTestChargeError(
      'SHOPIFY_SHADOW_TEST_SERVICE_UNAVAILABLE',
      'Configured Shadow test service is not uniquely available',
    )
  }

  return input.offers.map((offer) => {
    const stableServiceCode = stableShopifyCarrierServiceCode(
      offer.carrierCode,
      offer.serviceLevelCode,
    )
    return {
      ...offer,
      customerChargeMinor:
        stableServiceCode === selectedServiceCode ? 0 : offer.amountMinor,
      subsidyReason:
        stableServiceCode === selectedServiceCode ? subsidyReason : null,
    }
  })
}
