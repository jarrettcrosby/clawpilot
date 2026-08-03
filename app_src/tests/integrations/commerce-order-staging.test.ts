import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import {
  exactWholeCommerceQuantityFromNumeric,
  resolveCommerceOrderLineProviderPrice,
  storableCommerceOrderLineProviderMoney,
} from '../../lib/integrations/commerceOrderStaging.ts'

test('accepts PostgreSQL scale-formatted whole commerce quantities', () => {
  assert.equal(exactWholeCommerceQuantityFromNumeric('50.000000'), 50n)
  assert.equal(exactWholeCommerceQuantityFromNumeric('1'), 1n)
  assert.equal(exactWholeCommerceQuantityFromNumeric('0.000000'), 0n)

  for (const value of [
    '1.500000',
    '1.000001',
    '1.0000000',
    '01.000000',
    '1.',
    '.000000',
    '-1.000000',
    '+1',
    '1e2',
    ' 50.000000 ',
    'NaN',
    'Infinity',
    '   ',
    '',
  ]) {
    assert.equal(exactWholeCommerceQuantityFromNumeric(value), null)
  }
})

test('stores one coherent nonnegative provider-money set', () => {
  assert.deepEqual(
    storableCommerceOrderLineProviderMoney({
      unitPrice: null,
      subtotal: { amountMinor: 900n, currency: 'USD' },
      discount: { amountMinor: 100n, currency: 'USD' },
      tax: { amountMinor: 80n, currency: 'USD' },
    }),
    {
      currencyCode: 'USD',
      unitPriceMinor: null,
      subtotalMinor: 900n,
      discountMinor: 100n,
      taxMinor: 80n,
    },
  )
  assert.deepEqual(
    storableCommerceOrderLineProviderMoney({
      unitPrice: { amountMinor: -1n, currency: 'USD' },
      subtotal: { amountMinor: -1n, currency: 'USD' },
      discount: { amountMinor: 0n, currency: 'USD' },
      tax: { amountMinor: 50n, currency: 'CAD' },
    }),
    {
      currencyCode: 'USD',
      unitPriceMinor: null,
      subtotalMinor: null,
      discountMinor: 0n,
      taxMinor: null,
    },
  )
})

test('accepts an exact provider order-time price including zero', () => {
  assert.deepEqual(
    resolveCommerceOrderLineProviderPrice({
      orderCurrency: 'USD',
      unitPrice: { amountMinor: 0n, currency: 'USD' },
      unfulfilledQuantity: 1,
    }),
    {
      state: 'provider',
      resolvedCurrencyCode: 'USD',
      resolvedUnitPriceMinor: 0n,
      requiresOperatorResolution: false,
    },
  )
  assert.deepEqual(
    resolveCommerceOrderLineProviderPrice({
      orderCurrency: 'USD',
      unitPrice: { amountMinor: 799n, currency: 'USD' },
      unfulfilledQuantity: 2,
    }),
    {
      state: 'provider',
      resolvedCurrencyCode: 'USD',
      resolvedUnitPriceMinor: 799n,
      requiresOperatorResolution: false,
    },
  )
})

test('requires explicit resolution for missing, negative, or mismatched money', () => {
  for (const unitPrice of [
    null,
    { amountMinor: -1n, currency: 'USD' },
    { amountMinor: 799n, currency: 'CAD' },
  ]) {
    assert.deepEqual(
      resolveCommerceOrderLineProviderPrice({
        orderCurrency: 'USD',
        unitPrice,
        unfulfilledQuantity: 1,
      }),
      {
        state: 'unresolved',
        resolvedCurrencyCode: null,
        resolvedUnitPriceMinor: null,
        requiresOperatorResolution: true,
      },
    )
  }
})

test('does not block a fulfilled line that has no remaining demand', () => {
  assert.deepEqual(
    resolveCommerceOrderLineProviderPrice({
      orderCurrency: 'USD',
      unitPrice: null,
      unfulfilledQuantity: 0,
    }),
    {
      state: 'unresolved',
      resolvedCurrencyCode: null,
      resolvedUnitPriceMinor: null,
      requiresOperatorResolution: false,
    },
  )
})
