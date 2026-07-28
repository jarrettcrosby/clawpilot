import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import {
  cubicMetersToDisplayVolume,
  displayLengthToMillimeters,
  displayVolumeToCubicMeters,
  displayWeightToGrams,
  displayWeightToKilograms,
  formatCubicMeters,
  formatDimensionsMm,
  formatGrams,
  formatKilograms,
  formatMillimeters,
  gramsToDisplayWeight,
  kilogramsToDisplayWeight,
  measurementUnits,
  millimetersToDisplayLength,
} from '../../lib/measurements.ts'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import {
  DEFAULT_WORKSPACE_CURRENCY_CODE,
  isIso4217CurrencyCode,
  normalizeCurrencyCode,
} from '../../lib/currency.ts'

function approximately(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  )
}

test('measurement unit labels follow the selected presentation system', () => {
  assert.deepEqual(measurementUnits('imperial'), {
    length: 'in',
    weight: 'lb',
    volume: 'ft³',
  })
  assert.deepEqual(measurementUnits('metric'), {
    length: 'cm',
    weight: 'kg',
    volume: 'm³',
  })
})

test('length and product-weight conversions preserve canonical integer mm and g', () => {
  assert.equal(displayLengthToMillimeters(10, 'imperial'), 254)
  assert.equal(displayLengthToMillimeters(12.5, 'metric'), 125)
  assert.equal(millimetersToDisplayLength(254, 'imperial'), 10)
  assert.equal(millimetersToDisplayLength(125, 'metric'), 12.5)

  assert.equal(displayWeightToGrams(1, 'imperial'), 454)
  assert.equal(displayWeightToGrams(1.25, 'metric'), 1_250)
  approximately(gramsToDisplayWeight(453.59237, 'imperial'), 1)
  assert.equal(gramsToDisplayWeight(1_250, 'metric'), 1.25)
})

test('warehouse capacity conversions preserve canonical m3 and kg', () => {
  approximately(cubicMetersToDisplayVolume(1, 'imperial'), 35.31466672148859)
  approximately(displayVolumeToCubicMeters(35.31466672148859, 'imperial'), 1)
  assert.equal(cubicMetersToDisplayVolume(1.5, 'metric'), 1.5)
  assert.equal(displayVolumeToCubicMeters(1.5, 'metric'), 1.5)

  approximately(kilogramsToDisplayWeight(1, 'imperial'), 2.2046226218487757)
  approximately(displayWeightToKilograms(2.2046226218487757, 'imperial'), 1)
  assert.equal(kilogramsToDisplayWeight(2.5, 'metric'), 2.5)
  assert.equal(displayWeightToKilograms(2.5, 'metric'), 2.5)
})

test('formatters append presentation units without changing canonical inputs', () => {
  assert.equal(formatMillimeters(254, 'imperial'), '10 in')
  assert.equal(formatGrams(453.59237, 'imperial'), '1 lb')
  assert.equal(
    formatDimensionsMm({ lengthMm: 254, widthMm: 127, heightMm: 51 }, 'imperial'),
    '10 × 5 × 2.01 in',
  )
  assert.equal(formatCubicMeters(1, 'metric'), '1 m³')
  assert.equal(formatKilograms(2.5, 'metric'), '2.5 kg')
})

test('conversion helpers reject negative and non-finite values', () => {
  assert.throws(() => displayLengthToMillimeters(-1, 'metric'), RangeError)
  assert.throws(() => displayWeightToGrams(Number.NaN, 'imperial'), RangeError)
  assert.throws(() => displayVolumeToCubicMeters(Number.POSITIVE_INFINITY, 'metric'), RangeError)
})

test('workspace currency helpers accept supported ISO codes without inventing codes', () => {
  assert.equal(DEFAULT_WORKSPACE_CURRENCY_CODE, 'USD')
  assert.equal(isIso4217CurrencyCode('USD'), true)
  assert.equal(isIso4217CurrencyCode('eur'), true)
  assert.equal(isIso4217CurrencyCode('AAA'), false)
  assert.equal(normalizeCurrencyCode(' eur '), 'EUR')
  assert.equal(normalizeCurrencyCode('not-a-currency'), 'USD')
})
