import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY,
  normalizeShopifyCheckoutRateWarmPolicy,
  readShopifyCheckoutRateWarmPolicy,
  SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION,
  ShopifyCheckoutRateWarmPolicyError,
} from '../../lib/operations/shopifyCheckoutRateWarmPolicy.ts'

test('creation defaults rate warming to disabled and customer neutral', () => {
  const policy = normalizeShopifyCheckoutRateWarmPolicy(undefined)

  assert.deepEqual(policy, DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY)
  assert.equal(policy.enabled, false)
  assert.equal(JSON.stringify(policy).includes('customer'), false)
  assert.equal(JSON.stringify(policy).includes('address'), false)
})

test('reads a strict hosted United States policy from a tenant snapshot', () => {
  const hosted = readShopifyCheckoutRateWarmPolicy({
    checkoutRateWarm: {
      version: SHOPIFY_CHECKOUT_RATE_WARM_POLICY_VERSION,
      enabled: false,
      mode: 'hosted_ajax',
      zoneScope: 'all_saved_rate_zones',
      concurrency: 2,
      debounceMs: 350,
      minIntervalMs: 1_000,
      supportedCountries: ['US'],
      staleCartAbort: true,
    },
  })

  assert.equal(hosted.mode, 'hosted_ajax')
  assert.deepEqual(hosted.supportedCountries, ['US'])
  assert.equal(hosted.concurrency, 2)
})

test('requires all saved rate zones instead of accepting a truncating cap', () => {
  assert.throws(
    () => normalizeShopifyCheckoutRateWarmPolicy({
      ...DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY,
      zoneScope: 'first_10_zones',
    }),
    ShopifyCheckoutRateWarmPolicyError,
  )
})

test('rejects unsupported customer identifiers and addresses', () => {
  for (const extra of [
    { customerIds: ['gid://shopify/Customer/1'] },
    { destinationAddresses: ['1 Main St'] },
  ]) {
    assert.throws(
      () => normalizeShopifyCheckoutRateWarmPolicy({
        ...DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY,
        ...extra,
      }),
      ShopifyCheckoutRateWarmPolicyError,
    )
  }
})

test('enforces hosted mode, United States, concurrency, timing, and booleans', () => {
  const invalidPolicies = [
    { mode: 'headless_storefront' },
    { concurrency: 0 },
    { concurrency: 9 },
    { debounceMs: 5_001 },
    { minIntervalMs: 249 },
    { minIntervalMs: 60_001 },
    { supportedCountries: [] },
    { supportedCountries: ['us'] },
    { supportedCountries: ['US', 'US'] },
    { supportedCountries: ['CA'] },
    { supportedCountries: ['US', 'CA'] },
    { staleCartAbort: false },
    { staleCartAbort: 'true' },
  ]
  for (const patch of invalidPolicies) {
    assert.throws(
      () => normalizeShopifyCheckoutRateWarmPolicy({
        ...DEFAULT_SHOPIFY_CHECKOUT_RATE_WARM_POLICY,
        ...patch,
      }),
      ShopifyCheckoutRateWarmPolicyError,
    )
  }
})

test('persisted reads fail closed when policy is absent or malformed', () => {
  assert.throws(
    () => readShopifyCheckoutRateWarmPolicy({}),
    ShopifyCheckoutRateWarmPolicyError,
  )
  assert.throws(
    () => readShopifyCheckoutRateWarmPolicy({
      checkoutRateWarm: null,
    }),
    ShopifyCheckoutRateWarmPolicyError,
  )
})
