export const COMMERCE_PRODUCT_CHANNEL_STATUSES = [
  'active',
  'draft',
  'archived',
  'unlisted',
  'unavailable',
  'unknown',
] as const

export type CommerceProductChannelStatus =
  (typeof COMMERCE_PRODUCT_CHANNEL_STATUSES)[number]

export type CommerceProductLifecycleInput = {
  active: boolean | null
  lifecycleState: string | null
}

export function normalizeCommerceProductChannelStatus(
  product: CommerceProductLifecycleInput,
): {
  raw: string
  normalized: CommerceProductChannelStatus
  providerActive: boolean | null
} {
  const raw = String(product.lifecycleState || 'UNKNOWN').trim() || 'UNKNOWN'
  const lifecycle = raw.toLowerCase()

  if (lifecycle.includes('unlist')) {
    return { raw, normalized: 'unlisted', providerActive: product.active }
  }
  if (lifecycle.includes('archiv')) {
    return { raw, normalized: 'archived', providerActive: product.active }
  }
  if (lifecycle.includes('draft')) {
    return { raw, normalized: 'draft', providerActive: product.active }
  }
  if (product.active === true) {
    return { raw, normalized: 'active', providerActive: true }
  }
  if (product.active === false) {
    return { raw, normalized: 'unavailable', providerActive: false }
  }
  return { raw, normalized: 'unknown', providerActive: null }
}
