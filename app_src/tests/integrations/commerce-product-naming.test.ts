import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import {
  commerceProductDisplayName,
  commerceVariantLabel,
} from '../../lib/integrations/commerceProductNaming.ts'

test('uses meaningful Shopify option values without repeating the product title', () => {
  const input = {
    productTitle: 'Ag-Alchemy Animal Nutrition Short Sleeve T-Shirt - Kids - Green Paw',
    variantTitle:
      'Ag-Alchemy Animal Nutrition Short Sleeve T-Shirt - Kids - Green Paw - Medium',
    selectedOptions: [
      { name: 'Size', value: 'Medium' },
    ],
  }
  assert.equal(commerceVariantLabel(input), 'Medium')
  assert.equal(
    commerceProductDisplayName(input),
    'Ag-Alchemy Animal Nutrition Short Sleeve T-Shirt - Kids - Green Paw · Medium',
  )
})

test('drops Shopify Default Title from the canonical product name', () => {
  const input = {
    productTitle: 'Apple Crisp a la mode 10lb',
    variantTitle: 'Apple Crisp a la mode 10lb - Default Title',
    selectedOptions: [{ name: 'Title', value: 'Default Title' }],
  }
  assert.equal(commerceVariantLabel(input), null)
  assert.equal(
    commerceProductDisplayName(input),
    'Apple Crisp a la mode 10lb',
  )
})

test('strips a repeated title prefix when selected options are unavailable', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Apple Crisp Kringle 6oz',
      variantTitle: 'Apple Crisp Kringle 6oz - Gift Box',
    }),
    'Apple Crisp Kringle 6oz · Gift Box',
  )
})

test('does not strip a product-title substring without a variant separator', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Tea',
      variantTitle: 'Team Size',
    }),
    'Tea · Team Size',
  )
})

test('keeps multiple distinct option values in stable provider order', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Team Shirt',
      variantTitle: 'Team Shirt - Green / Small',
      selectedOptions: [
        { name: 'Color', value: 'Green' },
        { name: 'Size', value: 'Small' },
        { name: 'Duplicate size', value: 'small' },
      ],
    }),
    'Team Shirt · Green / Small',
  )
})
