import {
  SHOPIFY_CARRIER_SERVICE_MAX_RATES,
  stableShopifyCarrierServiceCode,
} from '@/lib/integrations/shopifyCarrierServiceProtocol'
import type {
  ShopifyCheckoutChargedOffer,
} from '@/lib/integrations/shopifyShadowTestCharge'

function nullableDateOrder(left: string | null, right: string | null) {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left.localeCompare(right)
}

function nullableIntegerOrder(left: number | null, right: number | null) {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}

function comparePublicOfferWinner(
  left: ShopifyCheckoutChargedOffer,
  right: ShopifyCheckoutChargedOffer,
) {
  return (
    left.customerChargeMinor - right.customerChargeMinor
    || left.amountMinor - right.amountMinor
    || nullableDateOrder(left.deliveryDate, right.deliveryDate)
    || nullableIntegerOrder(left.transitDays, right.transitDays)
    || left.carrierAccountGlobalId.localeCompare(
      right.carrierAccountGlobalId,
    )
    || left.evidenceGlobalId.localeCompare(right.evidenceGlobalId)
  )
}

/**
 * Shopify service codes identify provider + service, not a billing account.
 * Keep every account attempt as evidence, but publish and persist exactly one
 * deterministic winner for each public service code.
 */
export function collapseShopifyCheckoutRateSourceOffers(
  offers: readonly ShopifyCheckoutChargedOffer[],
): ShopifyCheckoutChargedOffer[] {
  const winnerByServiceCode = new Map<
    string,
    ShopifyCheckoutChargedOffer
  >()
  for (const offer of offers) {
    const publicServiceCode = stableShopifyCarrierServiceCode(
      offer.carrierCode,
      offer.serviceLevelCode,
    )
    const current = winnerByServiceCode.get(publicServiceCode)
    if (!current || comparePublicOfferWinner(offer, current) < 0) {
      winnerByServiceCode.set(publicServiceCode, offer)
    }
  }
  const winners = [...winnerByServiceCode.entries()]
    .sort(([leftCode], [rightCode]) => leftCode.localeCompare(rightCode))
    .map(([, offer]) => ({ ...offer }))
  if (winners.length > SHOPIFY_CARRIER_SERVICE_MAX_RATES) {
    throw new Error(
      'Collapsed Shopify checkout offers exceed the public rate limit',
    )
  }
  return winners
}
