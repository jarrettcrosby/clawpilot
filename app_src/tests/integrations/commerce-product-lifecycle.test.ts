import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeCommerceProductChannelStatus,
} from '../../lib/integrations/commerceProductLifecycle.ts'

test('preserves every supported provider product lifecycle distinctly', () => {
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: true,
      lifecycleState: 'ACTIVE',
    }),
    { raw: 'ACTIVE', normalized: 'active', providerActive: true },
  )
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: false,
      lifecycleState: 'DRAFT',
    }),
    { raw: 'DRAFT', normalized: 'draft', providerActive: false },
  )
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: false,
      lifecycleState: 'ARCHIVED',
    }),
    { raw: 'ARCHIVED', normalized: 'archived', providerActive: false },
  )
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: false,
      lifecycleState: 'UNLISTED',
    }),
    { raw: 'UNLISTED', normalized: 'unlisted', providerActive: false },
  )
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: false,
      lifecycleState: null,
    }),
    { raw: 'UNKNOWN', normalized: 'unavailable', providerActive: false },
  )
  assert.deepEqual(
    normalizeCommerceProductChannelStatus({
      active: null,
      lifecycleState: null,
    }),
    { raw: 'UNKNOWN', normalized: 'unknown', providerActive: null },
  )
})

test('never relabels Shopify UNLISTED as active or published', () => {
  assert.equal(
    normalizeCommerceProductChannelStatus({
      active: true,
      lifecycleState: 'UNLISTED',
    }).normalized,
    'unlisted',
  )
})
