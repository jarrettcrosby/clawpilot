import type {
  CommerceMoney,
} from '@/lib/operations/commerceNormalization'

export type CommerceProductChannelOffers = Readonly<{
  wholesale: CommerceMoney | null
  retail: CommerceMoney | null
  compareAt: CommerceMoney | null
}>

/**
 * The shared normalized variant predates the durable sales-channel offer
 * projection. Shopify's current selling price occupies `wholesalePrice` in
 * that legacy shape while its compare-at price occupies `retailPrice`.
 * Preserve those source semantics at the channel boundary instead of
 * presenting a Shopify selling price as wholesale.
 */
export function selectCommerceProductChannelOffers(input: {
  provider: 'shopify' | 'faire'
  normalizedWholesalePrice: CommerceMoney | null
  normalizedRetailPrice: CommerceMoney | null
}): CommerceProductChannelOffers {
  if (input.provider === 'shopify') {
    return Object.freeze({
      wholesale: null,
      retail: input.normalizedWholesalePrice,
      compareAt: input.normalizedRetailPrice,
    })
  }
  return Object.freeze({
    wholesale: input.normalizedWholesalePrice,
    retail: input.normalizedRetailPrice,
    compareAt: null,
  })
}
