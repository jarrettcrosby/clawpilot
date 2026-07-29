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

test('does not repeat a complete option phrase already represented in the title', () => {
  const productTitle =
    'Ag-Alchemy Animal Nutrition Short Sleeve T-Shirt - Kids - Black Ag-Alchemy'
  assert.equal(
    commerceProductDisplayName({
      productTitle,
      variantTitle: 'Black Ag-Alchemy / Large',
      selectedOptions: [
        { name: 'Color', value: 'Black Ag-Alchemy' },
        { name: 'Size', value: 'Large' },
      ],
    }),
    `${productTitle} · Large`,
  )
})

test('does not fall back to a variant title when every selected option is in the title', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Black Team Shirt',
      variantTitle: 'Black',
      selectedOptions: [{ name: 'Color', value: 'Black' }],
    }),
    'Black Team Shirt',
  )
})

test('keeps an option that appears only inside a larger alphanumeric token', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Redwood Team Shirt',
      variantTitle: 'Red / Small',
      selectedOptions: [
        { name: 'Color', value: 'Red' },
        { name: 'Size', value: 'Small' },
      ],
    }),
    'Redwood Team Shirt · Red / Small',
  )
})

test('normalizes Unicode while enforcing alphanumeric option boundaries', () => {
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Café Team Shirt',
      variantTitle: 'fé / Large',
      selectedOptions: [
        { name: 'Style', value: 'fé' },
        { name: 'Size', value: 'Large' },
      ],
    }),
    'Café Team Shirt · fé / Large',
    'A phrase embedded in the larger Unicode alphanumeric token Café must remain',
  )
  assert.equal(
    commerceProductDisplayName({
      productTitle: 'Team Shirt - Café',
      variantTitle: 'Café / Large',
      selectedOptions: [
        { name: 'Style', value: 'Café' },
        { name: 'Size', value: 'Large' },
      ],
    }),
    'Team Shirt - Café · Large',
    'The canonically equivalent complete Unicode phrase must be suppressed',
  )
})
