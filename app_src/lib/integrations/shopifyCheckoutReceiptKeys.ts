export const SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS = 30_000
export const SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH = 200

const STABLE_CACHE_KEY = /^shopify-rate:[a-f0-9]{64}$/

export class ShopifyCheckoutReceiptKeyError extends Error {
  readonly code = 'SHOPIFY_CHECKOUT_RECEIPT_KEY_INVALID'
}

export type ShopifyCheckoutReceiptKeys = {
  stableCacheKey: string
  attemptKeyPrefix: string
  attemptBucket: number
  idempotencyKey: string
}

function fail(message: string): never {
  throw new ShopifyCheckoutReceiptKeyError(message)
}

function normalizeStableCacheKey(value: unknown) {
  if (
    typeof value !== 'string'
    || value.length > SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH
    || !STABLE_CACHE_KEY.test(value)
  ) {
    fail(
      'Stable Shopify checkout cache key must be shopify-rate followed by a lowercase SHA-256 digest',
    )
  }
  return value
}

function normalizeAttemptedAtMs(value: unknown) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    fail('Shopify checkout receipt attempt time must be a non-negative integer')
  }
  return value
}

export function createShopifyCheckoutReceiptKeys(input: {
  stableCacheKey: unknown
  attemptedAtMs: unknown
}): ShopifyCheckoutReceiptKeys {
  const stableCacheKey = normalizeStableCacheKey(input.stableCacheKey)
  const attemptedAtMs = normalizeAttemptedAtMs(input.attemptedAtMs)
  const attemptBucket = Math.floor(
    attemptedAtMs / SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS,
  )
  const attemptKeyPrefix = `${stableCacheKey}:attempt:`
  const idempotencyKey = `${attemptKeyPrefix}${attemptBucket}`

  if (
    attemptKeyPrefix.length >= SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH
    || idempotencyKey.length > SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH
    || !/^(0|[1-9][0-9]*)$/.test(String(attemptBucket))
  ) {
    fail('Shopify checkout receipt attempt key exceeds its safe boundary')
  }

  return {
    stableCacheKey,
    attemptKeyPrefix,
    attemptBucket,
    idempotencyKey,
  }
}
