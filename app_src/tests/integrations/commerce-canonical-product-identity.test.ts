import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectCanonicalCommerceProductIdentity,
} from '../../lib/integrations/commerceCanonicalProductIdentity.ts'

const product = (input: {
  id: string
  sku?: string | null
  barcode?: string | null
}) => ({
  productId: input.id,
  productGlobalId: `gp-${input.id}`,
  sku: input.sku ?? null,
  barcode: input.barcode ?? null,
})

test('reuses one canonical product on an exact stable SKU', () => {
  const selected = selectCanonicalCommerceProductIdentity({
    providerSku: 'AG-6OZ-APPLE',
    barcode: null,
    candidates: [
      product({ id: '1', sku: 'ag-6oz-apple' }),
    ],
  })
  assert.equal(selected.kind, 'match')
  if (selected.kind === 'match') {
    assert.equal(selected.candidate.productId, '1')
    assert.equal(selected.matchedBy, 'stable_sku')
  }
})

test('reuses one canonical product on an exact GTIN or barcode', () => {
  const selected = selectCanonicalCommerceProductIdentity({
    providerSku: 'FAIRE-SKU',
    barcode: '00012345678905',
    candidates: [
      product({
        id: '1',
        sku: 'SHOPIFY-SKU',
        barcode: '00012345678905',
      }),
    ],
  })
  assert.equal(selected.kind, 'match')
  if (selected.kind === 'match') {
    assert.equal(selected.matchedBy, 'stable_barcode')
  }
})

test('holds multiple candidate products for review', () => {
  assert.deepEqual(
    selectCanonicalCommerceProductIdentity({
      providerSku: 'DUPLICATE',
      barcode: null,
      candidates: [
        product({ id: '1', sku: 'DUPLICATE' }),
        product({ id: '2', sku: 'duplicate' }),
      ],
    }),
    {
      kind: 'ambiguous',
      productGlobalIds: ['gp-1', 'gp-2'],
      reason: 'multiple_products',
    },
  )
})

test('never merges the same SKU when known barcodes conflict', () => {
  assert.deepEqual(
    selectCanonicalCommerceProductIdentity({
      providerSku: 'CASE-12',
      barcode: 'CASE-GTIN',
      candidates: [
        product({
          id: 'each',
          sku: 'CASE-12',
          barcode: 'EACH-GTIN',
        }),
      ],
    }),
    {
      kind: 'ambiguous',
      productGlobalIds: ['gp-each'],
      reason: 'conflicting_barcode',
    },
  )
})

test('does not use names or pack levels as identity', () => {
  assert.deepEqual(
    selectCanonicalCommerceProductIdentity({
      providerSku: null,
      barcode: null,
      candidates: [
        product({ id: 'same-name' }),
      ],
    }),
    { kind: 'none' },
  )
})
