import { createHash } from 'node:crypto'

export type ShopifyDeletedProductEvidence = Readonly<{
  externalProductId: string
  productSourceHash: string
  providerUpdatedAt: string | null
}>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function productDecimalId(value: unknown): string | null {
  if (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
  ) {
    return String(value)
  }
  if (
    typeof value === 'string'
    && value === value.trim()
    && /^[1-9][0-9]{0,19}$/.test(value)
  ) {
    return value
  }
  return null
}

function optionalSignedTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value !== value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

/**
 * Derive the exact product tombstone only from a body whose Shopify HMAC has
 * already been verified. The raw body remains encrypted in its immutable
 * receipt; this safe projection contains no title, URL, or customer data.
 */
export function shopifyDeletedProductEvidence(input: {
  topic: string
  verifiedPayload: unknown
  verifiedPayloadHash: string
}): ShopifyDeletedProductEvidence | null {
  if (input.topic !== 'products/delete') return null
  const payload = record(input.verifiedPayload)
  const decimalId = productDecimalId(payload?.id)
  const payloadHash = String(input.verifiedPayloadHash || '').toLowerCase()
  if (
    !payload
    || !decimalId
    || !/^[a-f0-9]{64}$/.test(payloadHash)
  ) {
    throw new Error('Shopify product-delete payload is invalid')
  }
  const externalProductId = `gid://shopify/Product/${decimalId}`
  const adminGraphqlApiId = payload.admin_graphql_api_id
  if (
    adminGraphqlApiId !== undefined
    && adminGraphqlApiId !== null
    && adminGraphqlApiId !== externalProductId
  ) {
    throw new Error('Shopify product-delete identity is inconsistent')
  }
  return Object.freeze({
    externalProductId,
    productSourceHash: createHash('sha256').update([
      'shopify-product-delete-v1',
      payloadHash,
      externalProductId,
    ].join('\0')).digest('hex'),
    providerUpdatedAt: optionalSignedTimestamp(
      payload.updated_at ?? payload.updatedAt,
    ),
  })
}
