import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isShopifySandboxCheckoutChannelEligible,
  type ShopifyCheckoutChannelEligibilityInput,
} from '../../lib/integrations/shopifyCheckoutChannelEligibility.ts'

const activeEvidence: ShopifyCheckoutChannelEligibilityInput = {
  provider: 'shopify',
  accountEnvironment: 'sandbox',
  providerStatusRaw: 'ACTIVE',
  normalizedStatus: 'active',
  providerActive: true,
  requiresShipping: true,
  weightGrams: 170,
}

const unlistedEvidence: ShopifyCheckoutChannelEligibilityInput = {
  ...activeEvidence,
  providerStatusRaw: 'UNLISTED',
  normalizedStatus: 'unlisted',
  providerActive: false,
}

test('accepts active and direct-link UNLISTED Shopify sandbox evidence', () => {
  assert.equal(
    isShopifySandboxCheckoutChannelEligible(activeEvidence),
    true,
  )
  assert.equal(
    isShopifySandboxCheckoutChannelEligible(unlistedEvidence),
    true,
  )
  assert.equal(
    isShopifySandboxCheckoutChannelEligible({
      ...unlistedEvidence,
      providerStatusRaw: ' unlisted ',
    }),
    true,
  )
})

test('keeps UNLISTED truthful and fails inconsistent lifecycle evidence', () => {
  for (const evidence of [
    { ...unlistedEvidence, providerActive: true },
    { ...unlistedEvidence, providerActive: null },
    { ...unlistedEvidence, providerStatusRaw: 'ACTIVE' },
    { ...unlistedEvidence, providerStatusRaw: null },
    { ...activeEvidence, providerActive: false },
    { ...activeEvidence, providerStatusRaw: 'UNLISTED' },
    { ...activeEvidence, providerStatusRaw: null },
  ]) {
    assert.equal(
      isShopifySandboxCheckoutChannelEligible(evidence),
      false,
    )
  }
})

test('fails production, other providers, and non-sellable lifecycle states', () => {
  for (const evidence of [
    { ...unlistedEvidence, accountEnvironment: 'production' },
    { ...unlistedEvidence, accountEnvironment: 'mock' },
    { ...unlistedEvidence, provider: 'faire' },
    { ...unlistedEvidence, normalizedStatus: 'draft' },
    { ...unlistedEvidence, normalizedStatus: 'archived' },
    { ...unlistedEvidence, normalizedStatus: 'unavailable' },
    { ...unlistedEvidence, normalizedStatus: 'unknown' },
  ]) {
    assert.equal(
      isShopifySandboxCheckoutChannelEligible(evidence),
      false,
    )
  }
})

test('requires shipping and a positive integer provider weight', () => {
  for (const evidence of [
    { ...unlistedEvidence, requiresShipping: false },
    { ...unlistedEvidence, requiresShipping: null },
    { ...unlistedEvidence, weightGrams: 0 },
    { ...unlistedEvidence, weightGrams: -1 },
    { ...unlistedEvidence, weightGrams: 1.5 },
    { ...unlistedEvidence, weightGrams: null },
  ]) {
    assert.equal(
      isShopifySandboxCheckoutChannelEligible(evidence),
      false,
    )
  }
})
