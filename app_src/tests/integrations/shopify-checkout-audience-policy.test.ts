import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SHOPIFY_CHECKOUT_AUDIENCE_POLICY,
  normalizeShopifyCheckoutAudiencePolicy,
  readShopifyCheckoutAudiencePolicy,
  ShopifyCheckoutAudiencePolicyError,
} from '../../lib/operations/shopifyCheckoutAudiencePolicy.ts'

test('missing checkout audience preserves the restricted Shadow default', () => {
  assert.deepEqual(
    normalizeShopifyCheckoutAudiencePolicy(undefined),
    DEFAULT_SHOPIFY_CHECKOUT_AUDIENCE_POLICY,
  )
  assert.deepEqual(
    readShopifyCheckoutAudiencePolicy({}),
    DEFAULT_SHOPIFY_CHECKOUT_AUDIENCE_POLICY,
  )
})

test('accepts each explicit checkout audience mode', () => {
  for (const mode of [
    'off',
    'restricted_customers',
    'all_eligible',
  ] as const) {
    assert.deepEqual(
      normalizeShopifyCheckoutAudiencePolicy({
        version: 'shopify-checkout-audience-v1',
        mode,
      }),
      {
        version: 'shopify-checkout-audience-v1',
        mode,
      },
    )
  }
})

test('rejects malformed or forward-incompatible checkout audience policies', () => {
  for (const value of [
    null,
    [],
    {},
    { version: 'shopify-checkout-audience-v1' },
    {
      version: 'shopify-checkout-audience-v2',
      mode: 'restricted_customers',
    },
    {
      version: 'shopify-checkout-audience-v1',
      mode: 'everyone',
    },
    {
      version: 'shopify-checkout-audience-v1',
      mode: 'off',
      extra: true,
    },
  ]) {
    assert.throws(
      () => normalizeShopifyCheckoutAudiencePolicy(value),
      (error: unknown) => (
        error instanceof ShopifyCheckoutAudiencePolicyError
        && error.code === 'SHOPIFY_CHECKOUT_AUDIENCE_POLICY_INVALID'
      ),
    )
  }
})
