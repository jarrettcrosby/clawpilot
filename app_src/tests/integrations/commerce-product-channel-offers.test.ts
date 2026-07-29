import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectCommerceProductChannelOffers,
} from '../../lib/integrations/commerceProductChannelOffers.ts'

const money = (amountMinor: bigint) => ({
  amountMinor,
  currency: 'USD',
})

test('projects Shopify selling and compare-at prices without inventing wholesale', () => {
  assert.deepEqual(
    selectCommerceProductChannelOffers({
      provider: 'shopify',
      normalizedWholesalePrice: money(BigInt(799)),
      normalizedRetailPrice: money(BigInt(999)),
    }),
    {
      wholesale: null,
      retail: money(BigInt(799)),
      compareAt: money(BigInt(999)),
    },
  )
})

test('preserves Faire wholesale and retail prices without inventing compare-at', () => {
  assert.deepEqual(
    selectCommerceProductChannelOffers({
      provider: 'faire',
      normalizedWholesalePrice: money(BigInt(600)),
      normalizedRetailPrice: money(BigInt(799)),
    }),
    {
      wholesale: money(BigInt(600)),
      retail: money(BigInt(799)),
      compareAt: null,
    },
  )
})
