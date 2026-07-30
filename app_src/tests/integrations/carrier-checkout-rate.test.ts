import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CheckoutShipmentRateError,
  rateCheckoutShipment,
  rateOptimizedCheckoutPlans,
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
  const calls: Array<{
    provider: string
    parcels: Array<Record<string, unknown>>
  }> = []
  const response = await rateCheckoutShipment({
    destination,
    parcels,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    invoke: async (selection, request) => {
      calls.push({
        provider: selection.provider,
        parcels: request.parcels,
      })
      return result(
        selection,
        selection.provider === 'ups_rest' ? '42.85' : '39.62',
      )
    },
  })

  assert.deepEqual(calls.sort((left, right) =>
    left.provider.localeCompare(right.provider)), [
    {
      provider: 'fedex_rest',
      parcels: [
        {
          description: 'AG12V2',
          exteriorInches: { length: 11, width: 9, height: 7 },
          grossPounds: 5.25,
        },
        {
          description: '20lb Box',
          exteriorInches: { length: 17, width: 11, height: 7 },
          grossPounds: 20.5,
        },
      ],
    },
    {
      provider: 'ups_rest',
      parcels: [
        {
          description: 'AG12V2',
          exteriorInches: { length: 11, width: 9, height: 7 },
          grossPounds: 5.25,
        },
        {
          description: '20lb Box',
          exteriorInches: { length: 17, width: 11, height: 7 },
          grossPounds: 20.5,
        },
      ],
    },
  ])
  assert.equal(
    calls.some(({ parcels: sent }) => (
      sent.some((parcel) => 'packageKey' in parcel)
    )),
    false,
    'internal package keys must not cross the strict carrier parcel boundary',
  )
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

function optimizedResult(
  selection: CheckoutRateCarrierSelection,
  packageCount: number,
  amount: string,
): CheckoutRateProviderResult {
  return {
    ...result(selection, amount),
    packageCount,
  }
}

const priceFirstPolicy = {
  version: 'tenant-policy-v1',
  maxCandidates: 4,
  objectivePriority: [
    'landed_price',
    'package_count',
    'unused_cube',
  ] as const,
  handlingCostMinorPerPackage: 0,
  handlingCostCurrency: 'USD',
}

test('selects the lowest whole-shipment landed price across carton plans', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-dense',
        parcels: [parcels[0]],
        materialCostMinor: 500,
        unusedCubeMm3: 100,
      },
      {
        candidateKey: 'candidate-cheap',
        parcels,
        materialCostMinor: 10,
        unusedCubeMm3: 200,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => optimizedResult(
      selection,
      request.parcels.length,
      request.parcels.length === 1 ? '10.00' : '12.00',
    ),
  })

  assert.equal(response.selectedCandidate.candidateKey, 'candidate-cheap')
  assert.equal(response.selectedEvaluation.landedPriceMinor, 1210)
  assert.equal(response.selectedRateResult.packageCount, 2)
})

test('uses least unused cube when whole-shipment landed price ties', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-loose',
        parcels: [parcels[0]],
        materialCostMinor: 25,
        unusedCubeMm3: 500,
      },
      {
        candidateKey: 'candidate-dense',
        parcels: [parcels[0]],
        materialCostMinor: 25,
        unusedCubeMm3: 100,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => optimizedResult(
      selection,
      request.parcels.length,
      '10.00',
    ),
  })

  assert.equal(response.selectedCandidate.candidateKey, 'candidate-dense')
})

test('uses fewer packages before cube when landed price ties', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-one-package',
        parcels: [parcels[0]],
        materialCostMinor: 25,
        unusedCubeMm3: 500,
      },
      {
        candidateKey: 'candidate-two-packages',
        parcels,
        materialCostMinor: 25,
        unusedCubeMm3: 100,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => optimizedResult(
      selection,
      request.parcels.length,
      '10.00',
    ),
  })

  assert.equal(
    response.selectedCandidate.candidateKey,
    'candidate-one-package',
  )
})

test('stable candidate and service identifiers resolve exact ties', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-z',
        parcels: [parcels[0]],
        materialCostMinor: 25,
        unusedCubeMm3: 100,
      },
      {
        candidateKey: 'candidate-a',
        parcels: [parcels[0]],
        materialCostMinor: 25,
        unusedCubeMm3: 100,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => optimizedResult(
      selection,
      request.parcels.length,
      '10.00',
    ),
  })

  assert.equal(response.selectedCandidate.candidateKey, 'candidate-a')
  assert.equal(response.selectedOffer.carrierCode, 'fedex')
})

test('stored objective priority changes selection without changing code', async () => {
  const candidates = [
    {
      candidateKey: 'candidate-low-price',
      parcels,
      materialCostMinor: 0,
      unusedCubeMm3: 500,
    },
    {
      candidateKey: 'candidate-dense',
      parcels: [parcels[0]],
      materialCostMinor: 0,
      unusedCubeMm3: 100,
    },
  ]
  const invoke = async (
    selection: CheckoutRateCarrierSelection,
    request: { parcels: Array<unknown> },
  ) => optimizedResult(
    selection,
    request.parcels.length,
    request.parcels.length === 2 ? '8.00' : '10.00',
  )
  const priceFirst = await rateOptimizedCheckoutPlans({
    destination,
    candidates,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke,
  })
  const cubeFirst = await rateOptimizedCheckoutPlans({
    destination,
    candidates,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [
        'unused_cube',
        'landed_price',
        'package_count',
      ],
    },
    invoke,
  })

  assert.equal(
    priceFirst.selectedCandidate.candidateKey,
    'candidate-low-price',
  )
  assert.equal(cubeFirst.selectedCandidate.candidateKey, 'candidate-dense')
})

test('rates every candidate with one service covering its full package set', async () => {
  const calls: Array<{ candidate: string; provider: string; count: number }> = []
  const candidates = [
    {
      candidateKey: 'candidate-two',
      parcels,
      materialCostMinor: 0,
      unusedCubeMm3: 200,
    },
    {
      candidateKey: 'candidate-one',
      parcels: [parcels[0]],
      materialCostMinor: 0,
      unusedCubeMm3: 100,
    },
  ]
  await rateOptimizedCheckoutPlans({
    destination,
    candidates,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => {
      calls.push({
        candidate: request.parcels.length === 2
          ? 'candidate-two'
          : 'candidate-one',
        provider: selection.provider,
        count: request.parcels.length,
      })
      return optimizedResult(
        selection,
        request.parcels.length,
        '10.00',
      )
    },
  })

  assert.deepEqual(calls.sort((left, right) => (
    left.candidate.localeCompare(right.candidate)
    || left.provider.localeCompare(right.provider)
  )), [
    { candidate: 'candidate-one', provider: 'fedex_rest', count: 1 },
    { candidate: 'candidate-one', provider: 'ups_rest', count: 1 },
    { candidate: 'candidate-two', provider: 'fedex_rest', count: 2 },
    { candidate: 'candidate-two', provider: 'ups_rest', count: 2 },
  ])
})

test('fails closed when the authoritative baseline loses a required carrier', async () => {
  let alternativeCalls = 0
  await assert.rejects(
    rateOptimizedCheckoutPlans({
      destination,
      candidates: [
        {
          candidateKey: 'candidate-baseline',
          parcels: [parcels[0]],
          materialCostMinor: 0,
          unusedCubeMm3: 100,
        },
        {
          candidateKey: 'candidate-alternative',
          parcels,
          materialCostMinor: 0,
          unusedCubeMm3: 50,
        },
      ],
      carriers,
      currency: 'USD',
      deadlineAt: Date.now() + 5_000,
      policy: {
        ...priceFirstPolicy,
        objectivePriority: [...priceFirstPolicy.objectivePriority],
      },
      invoke: async (selection, request) => {
        if (request.parcels.length > 1) alternativeCalls += 1
        if (selection.provider === 'fedex_rest') {
          throw new Error('baseline provider unavailable')
        }
        return optimizedResult(
          selection,
          request.parcels.length,
          '10.00',
        )
      },
    }),
    (error: unknown) => (
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_REQUIRED_CARRIER_FAILED'
      && error.provider === 'fedex_rest'
    ),
  )
  assert.equal(alternativeCalls, 0)
})

test('retains a complete baseline when an optional candidate loses a carrier', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-baseline',
        parcels: [parcels[0]],
        materialCostMinor: 0,
        unusedCubeMm3: 100,
      },
      {
        candidateKey: 'candidate-alternative',
        parcels,
        materialCostMinor: 0,
        unusedCubeMm3: 50,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => {
      if (
        request.parcels.length === 2
        && selection.provider === 'fedex_rest'
      ) {
        throw new Error('alternative provider unavailable')
      }
      return optimizedResult(
        selection,
        request.parcels.length,
        '10.00',
      )
    },
  })

  assert.equal(response.selectedCandidate.candidateKey, 'candidate-baseline')
  assert.deepEqual(
    response.candidateAttempts.map((attempt) => ({
      key: attempt.candidate.candidateKey,
      status: attempt.status,
      failureCode: attempt.failureCode,
      offers: attempt.result?.offers.length ?? 0,
    })),
    [
      {
        key: 'candidate-baseline',
        status: 'succeeded',
        failureCode: null,
        offers: 2,
      },
      {
        key: 'candidate-alternative',
        status: 'degraded',
        failureCode: 'CHECKOUT_RATE_REQUIRED_CARRIER_FAILED',
        offers: 0,
      },
    ],
  )
})

test('bounds optional candidate latency and records timeout evidence', async () => {
  let alternativeAborts = 0
  const startedAt = Date.now()
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-baseline',
        parcels: [parcels[0]],
        materialCostMinor: 0,
        unusedCubeMm3: 100,
      },
      {
        candidateKey: 'candidate-slow',
        parcels,
        materialCostMinor: 0,
        unusedCubeMm3: 50,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    alternativeBudgetMs: 25,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => {
      if (request.parcels.length === 1) {
        return optimizedResult(selection, 1, '10.00')
      }
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          alternativeAborts += 1
          reject(new Error('alternative aborted'))
        }, { once: true })
      })
    },
  })

  assert.ok(Date.now() - startedAt < 500)
  assert.equal(alternativeAborts, 2)
  assert.equal(response.selectedCandidate.candidateKey, 'candidate-baseline')
  assert.deepEqual(
    response.candidateAttempts.map((attempt) => (
      attempt.failureCode
    )),
    [null, 'CHECKOUT_RATE_DEADLINE_EXCEEDED'],
  )
})

test('rejects a handling cost whose currency differs from checkout', async () => {
  await assert.rejects(
    rateOptimizedCheckoutPlans({
      destination,
      candidates: [{
        candidateKey: 'candidate-baseline',
        parcels: [parcels[0]],
        materialCostMinor: 0,
        unusedCubeMm3: 100,
      }],
      carriers,
      currency: 'USD',
      deadlineAt: Date.now() + 5_000,
      policy: {
        ...priceFirstPolicy,
        handlingCostCurrency: 'CAD',
        objectivePriority: [...priceFirstPolicy.objectivePriority],
      },
      invoke: async (selection) => optimizedResult(
        selection,
        1,
        '10.00',
      ),
    }),
    (error: unknown) => (
      error instanceof CheckoutShipmentRateError
      && error.code === 'CHECKOUT_RATE_OPTIMIZER_CURRENCY_MISMATCH'
    ),
  )
})

test('degrades an alternative evaluation error without losing baseline', async () => {
  const response = await rateOptimizedCheckoutPlans({
    destination,
    candidates: [
      {
        candidateKey: 'candidate-baseline',
        parcels: [parcels[0]],
        materialCostMinor: 0,
        unusedCubeMm3: 100,
      },
      {
        candidateKey: 'candidate-overflow',
        parcels,
        materialCostMinor: Number.MAX_SAFE_INTEGER,
        unusedCubeMm3: 50,
      },
    ],
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    policy: {
      ...priceFirstPolicy,
      objectivePriority: [...priceFirstPolicy.objectivePriority],
    },
    invoke: async (selection, request) => optimizedResult(
      selection,
      request.parcels.length,
      '10.00',
    ),
  })

  assert.equal(response.selectedCandidate.candidateKey, 'candidate-baseline')
  assert.deepEqual(
    response.candidateAttempts.map((attempt) => ({
      key: attempt.candidate.candidateKey,
      status: attempt.status,
      failureCode: attempt.failureCode,
      offers: attempt.result?.offers.length ?? 0,
    })),
    [
      {
        key: 'candidate-baseline',
        status: 'succeeded',
        failureCode: null,
        offers: 2,
      },
      {
        key: 'candidate-overflow',
        status: 'degraded',
        failureCode: 'CHECKOUT_RATE_OPTIMIZER_INPUT_INVALID',
        offers: 2,
      },
    ],
  )
})

test('passes a ZIP-only rate destination to each carrier adapter', async () => {
  const rateOnlyDestination = {
    name: null,
    line1: null,
    line2: null,
    city: null,
    region: null,
    postalCode: '06103',
    countryCode: 'US' as const,
  }
  const seen: unknown[] = []
  await rateCheckoutShipment({
    destination: rateOnlyDestination,
    parcels,
    carriers,
    currency: 'USD',
    deadlineAt: Date.now() + 5_000,
    invoke: async (selection, request) => {
      seen.push(request.destination)
      return result(selection, '42.85')
    },
  })
  assert.deepEqual(seen, [
    rateOnlyDestination,
    rateOnlyDestination,
  ])
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
