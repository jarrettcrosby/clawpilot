import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as canonicalPlanning from '../../lib/operations/canonicalFulfillmentPlanning.ts'
import type {
  CanonicalFulfillmentPlanningInput,
  CanonicalWholeShipmentRateOffer,
} from '../../lib/operations/canonicalFulfillmentPlanning.ts'

const {
  CANONICAL_CUSTOMER_PAID_VARIANCE_FORMULA,
  CANONICAL_FULFILLMENT_RATE_OBJECTIVE_SEQUENCE,
  CANONICAL_FULFILLMENT_RATE_POLICY_VERSION,
  CanonicalFulfillmentPlanningError,
  authorizedCheckoutShippingChargeMinor,
  selectCanonicalFulfillmentRate,
} = canonicalPlanning

const packagePlanHash = 'a'.repeat(64)
const packageKeys = ['pkg-001', 'pkg-002']

function offer(
  provider: 'ups_rest' | 'fedex_rest',
  serviceCode: string,
  overrides: Partial<CanonicalWholeShipmentRateOffer> = {},
): CanonicalWholeShipmentRateOffer {
  return {
    evidenceState: 'sealed',
    rateScope: 'multi_package_shipment',
    rateEvidenceGlobalId:
      provider === 'ups_rest' ? 'grq0000001' : 'grq0000002',
    packagePlanHash,
    packageCount: 2,
    packageKeys,
    provider,
    serviceCode,
    serviceName: serviceCode,
    carrierCostMinor: 1_000,
    currency: 'USD',
    transitDays: 2,
    estimatedDeliveryAt: '2026-08-02T16:00:00Z',
    ...overrides,
  }
}

function planningInput(
  offers: readonly CanonicalWholeShipmentRateOffer[],
  overrides: Partial<CanonicalFulfillmentPlanningInput> = {},
): CanonicalFulfillmentPlanningInput {
  return {
    packagePlanHash,
    packageCount: 2,
    packageKeys,
    expectedCurrency: 'USD',
    requestedDeliveryAt: '2026-08-03T16:00:00Z',
    actualCheckoutShippingChargeMinor: 1_250,
    offers,
    ...overrides,
  }
}

function assertPlanningError(
  invoke: () => unknown,
  expectedCode: string,
) {
  assert.throws(invoke, (error: unknown) => {
    assert.ok(error instanceof CanonicalFulfillmentPlanningError)
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('only exposes checkout shipping when commerce intake explicitly authorizes customer-charge use', () => {
  const eligiblePayload = {
    amountsMinor: { shipping: '1250' },
    headerMoney: { customerChargeUse: 'eligible' },
  }
  assert.equal(
    authorizedCheckoutShippingChargeMinor(eligiblePayload),
    1_250,
  )
  assert.equal(
    authorizedCheckoutShippingChargeMinor({
      ...eligiblePayload,
      headerMoney: { customerChargeUse: 'blocked' },
    }),
    null,
  )
  assert.equal(
    authorizedCheckoutShippingChargeMinor({
      amountsMinor: { shipping: 0 },
    }),
    null,
  )
  assert.equal(
    authorizedCheckoutShippingChargeMinor({
      amountsMinor: { shipping: 'not-money' },
      headerMoney: { customerChargeUse: 'eligible' },
    }),
    null,
  )
  assert.equal(
    authorizedCheckoutShippingChargeMinor({
      amountsMinor: { shipping: 0 },
      headerMoney: { customerChargeUse: 'eligible' },
    }),
    0,
  )
})

test('selects the lowest-cost feasible service for the complete package set', () => {
  const selection = selectCanonicalFulfillmentRate(planningInput([
    offer('ups_rest', 'GROUND', {
      carrierCostMinor: 1_000,
      transitDays: 2,
    }),
    offer('fedex_rest', 'FEDEX_GROUND', {
      carrierCostMinor: 900,
      transitDays: 3,
    }),
  ]))

  assert.equal(selection.carrierProvider, 'fedex_rest')
  assert.equal(selection.carrierName, 'FedEx')
  assert.equal(selection.serviceCode, 'fedex_ground')
  assert.equal(selection.carrierCostMinor, 900)
  assert.equal(selection.actualCheckoutShippingChargeMinor, 1_250)
  assert.equal(selection.customerPaidVarianceMinor, 350)
  assert.equal(selection.packageCount, 2)
  assert.deepEqual(selection.packageKeys, packageKeys)
  assert.equal(selection.meetsRequestedDelivery, true)
  assert.deepEqual(
    selection.policy.objectiveSequence,
    CANONICAL_FULFILLMENT_RATE_OBJECTIVE_SEQUENCE,
  )
  assert.equal(
    selection.policy.version,
    CANONICAL_FULFILLMENT_RATE_POLICY_VERSION,
  )
  assert.equal(selection.policy.selectionUnit, 'whole_shipment')
  assert.equal(selection.policy.packageServiceSplitAllowed, false)
  assert.equal(
    selection.policy.customerPaidVarianceFormula,
    CANONICAL_CUSTOMER_PAID_VARIANCE_FORMULA,
  )
  assert.equal(selection.policy.evaluatedOfferCount, 2)
  assert.equal(selection.policy.feasibleOfferCount, 2)
})

test('selects across all services when no delivery promise or checkout charge exists', () => {
  const selection = selectCanonicalFulfillmentRate(planningInput([
    offer('ups_rest', 'GROUND', {
      carrierCostMinor: 1_000,
      transitDays: 2,
    }),
    offer('fedex_rest', 'FEDEX_GROUND', {
      carrierCostMinor: 900,
      transitDays: 3,
    }),
  ], {
    requestedDeliveryAt: null,
    actualCheckoutShippingChargeMinor: null,
  }))

  assert.equal(selection.carrierProvider, 'fedex_rest')
  assert.equal(selection.requestedDeliveryAt, null)
  assert.equal(selection.actualCheckoutShippingChargeMinor, null)
  assert.equal(selection.customerPaidVarianceMinor, null)
  assert.equal(selection.policy.rejectedForPromiseCount, 0)
})

test('filters services that miss the promise before comparing cost', () => {
  const selection = selectCanonicalFulfillmentRate(planningInput([
    offer('fedex_rest', 'LATE_BUT_CHEAP', {
      carrierCostMinor: 100,
      transitDays: 5,
      estimatedDeliveryAt: '2026-08-04T16:00:00Z',
    }),
    offer('ups_rest', 'GROUND', {
      carrierCostMinor: 1_000,
      transitDays: 2,
    }),
  ]))

  assert.equal(selection.carrierProvider, 'ups_rest')
  assert.equal(selection.serviceCode, 'ground')
  assert.equal(selection.policy.feasibleOfferCount, 1)
  assert.equal(selection.policy.rejectedForPromiseCount, 1)
})

test('breaks equal-cost ties by transit days then stable provider and service IDs', () => {
  const transitSelection = selectCanonicalFulfillmentRate(planningInput([
    offer('ups_rest', 'GROUND', { transitDays: 3 }),
    offer('fedex_rest', 'EXPRESS_SAVER', { transitDays: 2 }),
  ]))
  assert.equal(transitSelection.serviceCode, 'express_saver')

  const providerSelection = selectCanonicalFulfillmentRate(planningInput([
    offer('ups_rest', 'GROUND', { transitDays: 2 }),
    offer('fedex_rest', 'GROUND', { transitDays: 2 }),
  ]))
  assert.equal(providerSelection.carrierProvider, 'fedex_rest')

  const serviceSelection = selectCanonicalFulfillmentRate(planningInput([
    offer('ups_rest', 'Z_SERVICE', {
      rateEvidenceGlobalId: 'grq0000003',
      transitDays: 2,
    }),
    offer('ups_rest', 'A_SERVICE', {
      rateEvidenceGlobalId: 'grq0000003',
      transitDays: 2,
    }),
  ]))
  assert.equal(serviceSelection.serviceCode, 'a_service')
})

test('rejects package-level fragments instead of combining services', () => {
  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('ups_rest', 'GROUND', {
        packageCount: 1,
        packageKeys: ['pkg-001'],
      }),
      offer('fedex_rest', 'GROUND', {
        packageCount: 1,
        packageKeys: ['pkg-002'],
      }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
  )

  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('ups_rest', 'GROUND', {
        packageKeys: ['pkg-002', 'pkg-001'],
      }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_PACKAGE_COVERAGE_INVALID',
  )
})

test('fails closed on currency drift, duplicate services, and invalid money', () => {
  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('ups_rest', 'GROUND', { currency: 'CAD' }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_CURRENCY_MISMATCH',
  )

  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('ups_rest', 'GROUND'),
      offer('ups_rest', 'ground', {
        rateEvidenceGlobalId: 'grq0000003',
      }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_SERVICE_DUPLICATE',
  )

  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('fedex_rest', 'GROUND', { carrierCostMinor: 10.5 }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_MONEY_INVALID',
  )
})

test('fails closed when no whole-shipment service meets the promise', () => {
  assertPlanningError(
    () => selectCanonicalFulfillmentRate(planningInput([
      offer('ups_rest', 'GROUND', {
        estimatedDeliveryAt: '2026-08-04T16:00:00Z',
      }),
      offer('fedex_rest', 'GROUND', {
        estimatedDeliveryAt: '2026-08-05T16:00:00Z',
      }),
    ])),
    'CANONICAL_FULFILLMENT_RATE_PROMISE_UNAVAILABLE',
  )
})
