import assert from 'node:assert/strict'
import test from 'node:test'

import {
  waitForShopifyCheckoutReceiptCompletion,
} from '../../lib/integrations/shopifyCheckoutReceiptWait.ts'

test('returns an already completed checkout receipt without polling delay', async () => {
  const controller = new AbortController()
  let reads = 0
  const receipt = await waitForShopifyCheckoutReceiptCompletion({
    signal: controller.signal,
    deadlineAt: Date.now() + 1_000,
    read: async () => {
      reads += 1
      return { status: 'succeeded', globalId: 'gsqr1234567' }
    },
  })

  assert.equal(reads, 1)
  assert.deepEqual(receipt, {
    status: 'succeeded',
    globalId: 'gsqr1234567',
  })
})

test('coalesces an in-flight duplicate onto the durable terminal receipt', async () => {
  const controller = new AbortController()
  let reads = 0
  const receipt = await waitForShopifyCheckoutReceiptCompletion({
    signal: controller.signal,
    deadlineAt: Date.now() + 1_000,
    initialPollMs: 1,
    maximumPollMs: 2,
    read: async () => {
      reads += 1
      if (reads < 3) return null
      return { status: 'succeeded', globalId: 'gsqr7654321' }
    },
  })

  assert.equal(reads, 3)
  assert.equal(receipt.globalId, 'gsqr7654321')
})

test('fails closed when the waiting callback is aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    waitForShopifyCheckoutReceiptCompletion({
      signal: controller.signal,
      deadlineAt: Date.now() + 1_000,
      read: async () => null,
    }),
    (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code
        === 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED'
    ),
  )
})

test('fails closed when the duplicate cannot finish before the deadline', async () => {
  const controller = new AbortController()

  await assert.rejects(
    waitForShopifyCheckoutReceiptCompletion({
      signal: controller.signal,
      deadlineAt: Date.now(),
      read: async () => null,
    }),
    (error: unknown) => (
      error instanceof Error
      && (error as Error & { code?: string }).code
        === 'SHOPIFY_CHECKOUT_CALLBACK_DEADLINE_EXCEEDED'
    ),
  )
})
