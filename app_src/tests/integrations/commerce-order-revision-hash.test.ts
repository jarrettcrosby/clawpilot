import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commerceOrderRevisionHash,
} from '../../lib/integrations/commerceOrderRevisionEvidence.ts'

const providerOrder = {
  externalOrderId: 'gid://shopify/Order/123',
  sourceHash: 'a'.repeat(64),
  sourceRevision: '2026-08-12T12:00:00.000Z',
  canonicalStates: {
    lifecycle: 'open',
    payment: 'paid',
    fulfillment: 'unfulfilled',
    returns: 'none',
  },
  lines: [{ externalLineId: 'line-1', orderedQuantity: 2 }],
}

test('same provider content is stable across observation and local fence changes', () => {
  const first = {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    accountGlobalId: 'gia0000001',
    integrationAccountId: '11111111-1111-4111-8111-111111111111',
    externalAccountId: 'gid://shopify/Shop/9',
    credentialVersion: 1,
    canonicalOrderGlobalId: 'gor0000001',
    canonicalOrderRowVersion: 0,
    observedAt: '2026-08-12T12:00:01.000Z',
    order: providerOrder,
  }
  const later = {
    ...first,
    credentialVersion: 2,
    canonicalOrderRowVersion: 7,
    observedAt: '2026-08-12T13:00:01.000Z',
  }
  assert.equal(
    commerceOrderRevisionHash(first),
    commerceOrderRevisionHash(later),
  )
})

test('provider content changes produce a different revision hash', () => {
  const first = {
    version: 'shopify-canonical-order-revision-v1',
    provider: 'shopify',
    externalAccountId: 'gid://shopify/Shop/9',
    observedAt: '2026-08-12T12:00:01.000Z',
    order: providerOrder,
  }
  const changed = {
    ...first,
    observedAt: '2026-08-12T13:00:01.000Z',
    order: {
      ...providerOrder,
      lines: [{ externalLineId: 'line-1', orderedQuantity: 3 }],
    },
  }
  assert.notEqual(
    commerceOrderRevisionHash(first),
    commerceOrderRevisionHash(changed),
  )
})
