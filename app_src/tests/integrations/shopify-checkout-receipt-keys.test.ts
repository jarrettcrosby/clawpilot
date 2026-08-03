import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createShopifyCheckoutReceiptKeys,
  SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS,
  SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH,
  ShopifyCheckoutReceiptKeyError,
} from '../../lib/integrations/shopifyCheckoutReceiptKeys.ts'

const CACHE_KEY_A = `shopify-rate:${'a'.repeat(64)}`
const CACHE_KEY_B = `shopify-rate:${'b'.repeat(64)}`

test('creates deterministic attempt keys within a bounded 30-second window', () => {
  const first = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: 1,
  })
  const last = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS - 1,
  })

  assert.deepEqual(first, last)
  assert.equal(first.attemptBucket, 0)
  assert.equal(
    first.idempotencyKey,
    `${CACHE_KEY_A}:attempt:0`,
  )
})

test('changes only the attempt suffix at the next 30-second boundary', () => {
  const prior = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS - 1,
  })
  const next = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS,
  })

  assert.equal(prior.stableCacheKey, next.stableCacheKey)
  assert.equal(prior.attemptKeyPrefix, next.attemptKeyPrefix)
  assert.notEqual(prior.idempotencyKey, next.idempotencyKey)
  assert.equal(next.attemptBucket, 1)
})

test('preserves an exact stable prefix query boundary between cache fences', () => {
  const attemptA = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: 90_000,
  })
  const attemptB = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_B,
    attemptedAtMs: 90_000,
  })

  assert.equal(
    attemptA.attemptKeyPrefix,
    `${CACHE_KEY_A}:attempt:`,
  )
  assert.ok(attemptA.idempotencyKey.startsWith(attemptA.attemptKeyPrefix))
  assert.ok(!attemptB.idempotencyKey.startsWith(attemptA.attemptKeyPrefix))
  assert.match(
    attemptA.idempotencyKey.slice(attemptA.attemptKeyPrefix.length),
    /^(0|[1-9][0-9]*)$/,
  )
})

test('keeps the maximum safe timestamp within the persistence key limit', () => {
  const keys = createShopifyCheckoutReceiptKeys({
    stableCacheKey: CACHE_KEY_A,
    attemptedAtMs: Number.MAX_SAFE_INTEGER,
  })

  assert.ok(
    keys.idempotencyKey.length <= SHOPIFY_CHECKOUT_RECEIPT_KEY_MAX_LENGTH,
  )
  assert.equal(
    keys.attemptBucket,
    Math.floor(
      Number.MAX_SAFE_INTEGER
        / SHOPIFY_CHECKOUT_RECEIPT_ATTEMPT_BUCKET_MS,
    ),
  )
})

test('rejects malformed stable cache keys and unsafe attempt times', () => {
  const invalidInputs = [
    {
      stableCacheKey: 'shopify-rate:not-a-sha',
      attemptedAtMs: 0,
    },
    {
      stableCacheKey: `shopify-rate:${'A'.repeat(64)}`,
      attemptedAtMs: 0,
    },
    {
      stableCacheKey: `${CACHE_KEY_A}:attempt:0`,
      attemptedAtMs: 0,
    },
    {
      stableCacheKey: CACHE_KEY_A,
      attemptedAtMs: -1,
    },
    {
      stableCacheKey: CACHE_KEY_A,
      attemptedAtMs: 0.5,
    },
    {
      stableCacheKey: CACHE_KEY_A,
      attemptedAtMs: Number.POSITIVE_INFINITY,
    },
  ]

  for (const input of invalidInputs) {
    assert.throws(
      () => createShopifyCheckoutReceiptKeys(input),
      (error: unknown) => (
        error instanceof ShopifyCheckoutReceiptKeyError
        && error.code === 'SHOPIFY_CHECKOUT_RECEIPT_KEY_INVALID'
      ),
    )
  }
})
