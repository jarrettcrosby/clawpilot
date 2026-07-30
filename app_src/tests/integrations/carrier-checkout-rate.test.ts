import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CheckoutShipmentRateError,
  rateCheckoutShipment,
  type CheckoutRateCarrierSelection,
  type CheckoutRateProviderResult,
} from '../../lib/integrations/carrierCheckoutRate.ts'

const destination = {
  name: 'Jarrett Warehouse',
  line1: '1 Test Street',
  line2: null,
  city: 'Hartford',
  region: 'CT',
  postalCode: '06103',
  countryCode: 'US' as const,
}

const parcels = [
  {
    packageKey: 'package-1',
    description: 'AG12V2',
    exteriorInches: { length: 11, width: 9, height: 7 },
    grossPounds: 5.25,
  },
  {
    packageKey: 'package-2',
    description: '20lb Box',
    exteriorInches: { length: 17, width: 11, height: 7 },
    grossPounds: 20.5,
  },
]

const carriers: CheckoutRateCarrierSelection[] = [
  { provider: 'ups_rest', carrierAccountGlobalId: 'gac0000001' },
  { provider: 'fedex_rest', carrierAccountGlobalId: 'gac0000002' },
]

function result(
  selection: CheckoutRateCarrierSelection,
  amount: string,
): CheckoutRateProviderResult {
  return {
    provider: selection.provider,
    carrierAccountGlobalId: selection.carrierAccountGlobalId,
    packageCount: 2,
    rateScope: 'multi_package_shipment',
    rates: [{
      serviceCode: selection.provider === 'ups_rest' ? '03' : 'FEDEX_GROUND',
      serviceName: selection.provider === 'ups_rest'
        ? 'UPS Ground'
        : 'FedEx Ground',
      amount,
      currency: 'USD',
      transitDays: 3,
      deliveryDate: '2026-08-03',
      evidenceGlobalId: selection.provider === 'ups_rest'
        ? 'grq0000001'
        : 'grq0000002',
    }],
  }
}

test('rates the complete package set exactly once per required carrier', async () => {
  const calls: Array<{ provider: string; packageKeys: string[] }> = []
  const response = await rateCheckoutShipment({
    destination,
    parcels,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    invoke: async (selection, request) => {
      calls.push({
        provider: selection.provider,
        packageKeys: request.parcels.map(({ packageKey }) => packageKey),
      })
      return result(
        selection,
        selection.provider === 'ups_rest' ? '42.85' : '39.62',
      )
    },
  })

  assert.deepEqual(calls.sort((left, right) =>
    left.provider.localeCompare(right.provider)), [
    { provider: 'fedex_rest', packageKeys: ['package-1', 'package-2'] },
    { provider: 'ups_rest', packageKeys: ['package-1', 'package-2'] },
  ])
  assert.equal(response.packageCount, 2)
  assert.equal(response.offers.length, 2)
  assert.deepEqual(
    response.offers.map(({ carrierCode, amountMinor }) => ({
      carrierCode,
      amountMinor,
    })),
    [
      { carrierCode: 'fedex', amountMinor: 3962 },
      { carrierCode: 'ups', amountMinor: 4285 },
    ],
  )
})

test('fails the entire quote when a required carrier fails', async () => {
  await assert.rejects(
    rateCheckoutShipment({
      destination,
      parcels,
      carriers,
      currency: 'USD',
      deadlineAt: Date.now() + 5_000,
      invoke: async (selection) => {
        if (selection.provider === 'fedex_rest') throw new Error('timeout')
        return result(selection, '42.85')
      },
    }),
    (error: unknown) =>
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_REQUIRED_CARRIER_FAILED'
      && error.provider === 'fedex_rest',
  )
})

test('aborts all provider work when the checkout deadline expires', async () => {
  let aborted = 0
  await assert.rejects(
    rateCheckoutShipment({
      destination,
      parcels,
      carriers,
      currency: 'USD',
      deadlineAt: Date.now() + 25,
      invoke: async (selection, request) => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted += 1
          reject(new Error('aborted'))
        }, { once: true })
        setTimeout(() => resolve(result(selection, '42.85')), 2_000)
      }),
    }),
    (error: unknown) =>
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_DEADLINE_EXCEEDED',
  )
  assert.equal(aborted, 2)
})

test('shares callback cancellation with every in-flight provider', async () => {
  const callback = new AbortController()
  let aborted = 0
  const pending = rateCheckoutShipment({
    destination,
    parcels,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    signal: callback.signal,
    invoke: async (selection, request) => new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        aborted += 1
        reject(new Error('callback aborted'))
      }, { once: true })
      setTimeout(() => resolve(result(selection, '42.85')), 2_000)
    }),
  })

  callback.abort()

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_DEADLINE_EXCEEDED',
  )
  assert.equal(aborted, 2)
})

test('does not invoke carriers after callback cancellation', async () => {
  const callback = new AbortController()
  callback.abort()
  let calls = 0

  await assert.rejects(
    rateCheckoutShipment({
      destination,
      parcels,
      carriers,
      currency: 'USD',
      deadlineAt: Date.now() + 5_000,
      signal: callback.signal,
      invoke: async (selection) => {
        calls += 1
        return result(selection, '42.85')
      },
    }),
    (error: unknown) =>
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_DEADLINE_EXCEEDED',
  )
  assert.equal(calls, 0)
})

test('rejects provider package drift, currency mismatch, and duplicate services', async () => {
  const invalid = (mutate: (value: CheckoutRateProviderResult) => void) =>
    assert.rejects(
      rateCheckoutShipment({
        destination,
        parcels,
        carriers: [carriers[0]!],
        currency: 'USD',
        deadlineAt: Date.now() + 5_000,
        invoke: async (selection) => {
          const response = result(selection, '42.85')
          mutate(response)
          return response
        },
      }),
      (error: unknown) =>
        error instanceof CheckoutShipmentRateError
        && error.code === 'CHECKOUT_RATE_PROVIDER_RESPONSE_INVALID',
    )

  await invalid((response) => {
    response.packageCount = 1
  })
  await invalid((response) => {
    response.rates[0]!.currency = 'CAD'
  })
  await invalid((response) => {
    response.rates.push({ ...response.rates[0]! })
  })
})

test('accepts only canonical carrier-account Global IDs', async () => {
  await assert.rejects(
    rateCheckoutShipment({
      destination,
      parcels,
      carriers: [{
        provider: 'ups_rest',
        carrierAccountGlobalId: 'gca0000001',
      }],
      currency: 'USD',
      deadlineAt: Date.now() + 5_000,
      invoke: async () => {
        throw new Error('must not invoke carrier')
      },
    }),
    (error: unknown) =>
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_CARRIERS_INVALID',
  )
})
