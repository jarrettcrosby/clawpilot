import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commercePackEvidenceHash,
} from '../../lib/operations/commercePackEvidence.ts'

const baseline = {
  integrationAccountId: '11111111-1111-4111-8111-111111111111',
  provider: 'shopify' as const,
  externalProductId: 'gid://shopify/Product/1',
  externalVariantId: 'gid://shopify/ProductVariant/2',
  externalInventoryItemId: 'gid://shopify/InventoryItem/3',
  normalizedStatus: 'active' as const,
  providerActive: true,
  requiresShipping: true,
  weightGrams: 170,
}

test('stock and merchandising drift preserves physical pack readiness', () => {
  const expected = commercePackEvidenceHash(baseline)
  const stockOnly = {
    ...baseline,
    inventoryQuantity: 72,
    providerUpdatedAt: '2026-07-31T10:00:00.000Z',
    imageUrl: 'https://example.test/new.png',
    productTitle: 'Renamed product',
    variantTitle: 'Renamed variant',
    priceMinor: 999,
    categoryId: 'gid://shopify/TaxonomyCategory/aa',
    sku: 'RENAMED-SKU',
    barcode: '0123456789012',
  }
  assert.equal(commercePackEvidenceHash(stockOnly), expected)
})

test('every physical pack authority field invalidates readiness', () => {
  const expected = commercePackEvidenceHash(baseline)
  for (const changed of [
    { ...baseline, weightGrams: 171 },
    { ...baseline, requiresShipping: false },
    {
      ...baseline,
      externalInventoryItemId: 'gid://shopify/InventoryItem/4',
    },
    { ...baseline, normalizedStatus: 'archived' as const },
    { ...baseline, providerActive: false },
    {
      ...baseline,
      externalVariantId: 'gid://shopify/ProductVariant/9',
    },
    {
      ...baseline,
      externalProductId: 'gid://shopify/Product/9',
    },
    {
      ...baseline,
      integrationAccountId: '22222222-2222-4222-8222-222222222222',
    },
    { ...baseline, provider: 'faire' as const },
  ]) {
    assert.notEqual(commercePackEvidenceHash(changed), expected)
  }
})

test('nullable evidence and length-prefixed Unicode segments are unambiguous', () => {
  assert.notEqual(
    commercePackEvidenceHash({ ...baseline, providerActive: null }),
    commercePackEvidenceHash({ ...baseline, providerActive: false }),
  )
  assert.notEqual(
    commercePackEvidenceHash({
      ...baseline,
      externalProductId: 'café:variant',
      externalVariantId: 'one',
    }),
    commercePackEvidenceHash({
      ...baseline,
      externalProductId: 'café',
      externalVariantId: 'variant:one',
    }),
  )
})
