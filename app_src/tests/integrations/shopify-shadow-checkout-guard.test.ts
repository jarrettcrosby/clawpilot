import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateShopifyShadowCheckoutPolicy,
  evaluateShopifyShadowCheckoutPrePolicy,
  shopifyShadowCheckoutGuardDenialTelemetry,
  ShopifyShadowCheckoutGuardDenialReason,
} from '../../lib/integrations/shopifyShadowCheckoutGuard.ts'

const allowedVariantIds = new Set(['1001'])
const shippableItems = [{
  requiresShipping: true,
  variantId: '1001',
}]

test('classifies each pre-policy Shadow denial with a stable reason code', () => {
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPrePolicy({
      customerId: null,
      configuredVariantIds: allowedVariantIds,
      items: shippableItems,
    }),
    {
      ready: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
    },
  )
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPrePolicy({
      customerId: '2001',
      configuredVariantIds: null,
      items: shippableItems,
    }),
    {
      ready: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.MissingVariantConfiguration,
    },
  )
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPrePolicy({
      customerId: '2001',
      configuredVariantIds: allowedVariantIds,
      items: [{ requiresShipping: false, variantId: '1001' }],
    }),
    {
      ready: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.NoShippableItems,
    },
  )
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPrePolicy({
      customerId: '2001',
      configuredVariantIds: allowedVariantIds,
      items: [{ requiresShipping: true, variantId: '1002' }],
    }),
    {
      ready: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.UnallowlistedVariant,
    },
  )
})

test('passes only the normalized customer identity to policy lookup', () => {
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPrePolicy({
      customerId: '2001',
      configuredVariantIds: allowedVariantIds,
      items: shippableItems,
    }),
    { ready: true, customerId: '2001' },
  )
})

test('distinguishes absent or ineligible policy from hide-all policy', () => {
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPolicy(null),
    {
      allowed: false,
      reasonCode:
        ShopifyShadowCheckoutGuardDenialReason.PolicyAbsentOrIneligible,
    },
  )
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPolicy({ mode: 'hide_all' }),
    {
      allowed: false,
      reasonCode: ShopifyShadowCheckoutGuardDenialReason.HideAll,
    },
  )
  assert.deepEqual(
    evaluateShopifyShadowCheckoutPolicy({ mode: 'show_all' }),
    { allowed: true },
  )
})

test('builds privacy-safe denial telemetry with only static diagnostic fields', () => {
  const telemetry = shopifyShadowCheckoutGuardDenialTelemetry({
    accountGlobalId: 'gia0000001',
    reasonCode: ShopifyShadowCheckoutGuardDenialReason.MissingCustomer,
  })

  assert.deepEqual(telemetry, {
    accountGlobalId: 'gia0000001',
    stage: 'shadow_guard',
    checkpoint: 'request_parsed',
    reasonCode: 'SHOPIFY_SHADOW_GUARD_MISSING_CUSTOMER',
  })
  assert.deepEqual(Object.keys(telemetry).sort(), [
    'accountGlobalId',
    'checkpoint',
    'reasonCode',
    'stage',
  ])
})
