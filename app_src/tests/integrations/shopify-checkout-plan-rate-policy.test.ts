import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY,
  normalizeShopifyCheckoutPlanRatePolicy,
  readShopifyCheckoutPlanRatePolicy,
  SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
  ShopifyCheckoutPlanRatePolicyError,
} from '../../lib/operations/shopifyCheckoutPlanRatePolicy.ts'

test('reads independent tenant policies from separate durable snapshots', () => {
  const organizationA = {
    version: 'shopify-checkout-rating-policy-v1',
    planRateOptimization: {
      version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
      maxCandidates: 4,
      objectivePriority: [
        'landed_price',
        'package_count',
        'unused_cube',
      ],
      handlingCostMinorPerPackage: 25,
      handlingCostCurrency: 'USD',
    },
  }
  const organizationB = {
    version: 'shopify-checkout-rating-policy-v1',
    planRateOptimization: {
      version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
      maxCandidates: 2,
      objectivePriority: [
        'unused_cube',
        'landed_price',
        'package_count',
      ],
      handlingCostMinorPerPackage: 100,
      handlingCostCurrency: 'CAD',
    },
  }

  const policyA = readShopifyCheckoutPlanRatePolicy(organizationA)
  const policyB = readShopifyCheckoutPlanRatePolicy(organizationB)

  assert.notDeepEqual(policyA, policyB)
  assert.equal(policyA.maxCandidates, 4)
  assert.equal(policyA.handlingCostMinorPerPackage, 25)
  assert.equal(policyA.handlingCostCurrency, 'USD')
  assert.equal(policyB.maxCandidates, 2)
  assert.equal(policyB.handlingCostCurrency, 'CAD')
  assert.deepEqual(policyB.objectivePriority, [
    'unused_cube',
    'landed_price',
    'package_count',
  ])
  assert.deepEqual(
    organizationA.planRateOptimization.objectivePriority,
    ['landed_price', 'package_count', 'unused_cube'],
    'reading one tenant policy must not mutate another policy snapshot',
  )
})

test('creation normalizer provides the deterministic policy to persist', () => {
  const policy = normalizeShopifyCheckoutPlanRatePolicy(undefined)

  assert.deepEqual(policy, DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY)
})

test('explicit null is rejected instead of resetting an existing policy', () => {
  assert.throws(
    () => normalizeShopifyCheckoutPlanRatePolicy(null),
    (error: unknown) => (
      error instanceof ShopifyCheckoutPlanRatePolicyError
      && error.code === 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'
    ),
  )
})

test('handling cost requires a supported ISO 4217 currency', () => {
  assert.throws(
    () => normalizeShopifyCheckoutPlanRatePolicy({
      ...DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY,
      handlingCostCurrency: 'ZZZ',
    }),
    (error: unknown) => (
      error instanceof ShopifyCheckoutPlanRatePolicyError
      && error.code === 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'
    ),
  )
})

test('persisted configuration reads fail closed when policy is absent', () => {
  assert.throws(
    () => readShopifyCheckoutPlanRatePolicy({
      version: 'shopify-checkout-rating-policy-v1',
    }),
    (error: unknown) => (
      error instanceof ShopifyCheckoutPlanRatePolicyError
      && error.code === 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'
    ),
  )
})

test('fails closed for malformed stored priority', () => {
  assert.throws(
    () => readShopifyCheckoutPlanRatePolicy({
      planRateOptimization: {
        version: SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_VERSION,
        maxCandidates: 4,
        objectivePriority: [
          'landed_price',
          'landed_price',
          'unused_cube',
        ],
        handlingCostMinorPerPackage: 0,
        handlingCostCurrency: 'USD',
      },
    }),
    (error: unknown) => (
      error instanceof ShopifyCheckoutPlanRatePolicyError
      && error.code === 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'
    ),
  )
})

test('fails closed for unsupported persisted policy fields', () => {
  assert.throws(
    () => readShopifyCheckoutPlanRatePolicy({
      planRateOptimization: {
        ...DEFAULT_SHOPIFY_CHECKOUT_PLAN_RATE_POLICY,
        unversionedWeight: 0.5,
      },
    }),
    (error: unknown) => (
      error instanceof ShopifyCheckoutPlanRatePolicyError
      && error.code === 'SHOPIFY_CHECKOUT_PLAN_RATE_POLICY_INVALID'
    ),
  )
})
