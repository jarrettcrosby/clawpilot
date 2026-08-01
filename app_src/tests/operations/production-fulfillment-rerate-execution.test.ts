import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { mock } from 'node:test'

const appSourceUrl = new URL('../../', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const appPath = specifier.slice(2)
      return nextResolve(
        new URL(appPath.endsWith('.mjs') ? appPath : `${appPath}.ts`, appSourceUrl).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

const events: string[] = []
const runInputs: Array<Record<string, unknown>> = []
const attemptInputs: Array<Record<string, unknown>> = []
const networkInputs: Array<Record<string, unknown>> = []
const finalizerInputs: Array<{
  organizationId: unknown
  attemptGlobalId: unknown
  outcome: Record<string, unknown>
}> = []

const origin = {
  contactName: 'AG Alchemy Warehouse',
  companyName: 'AG Alchemy, LLC',
  phone: '4025550100',
  email: 'warehouse@example.test',
  line1: '7009 S 108th Street',
  line2: null,
  line3: null,
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
  residential: false,
} as const

const destination = {
  contactName: 'Test Customer',
  companyName: null,
  phone: '2035550100',
  email: 'customer@example.test',
  line1: '1 Test Street',
  line2: null,
  line3: null,
  city: 'Hartford',
  region: 'CT',
  postalCode: '06103',
  countryCode: 'US',
  residential: true,
} as const

const run = {
  id: '11111111-1111-4111-8111-111111111111',
  globalId: 'gprr0000001',
  destination,
  packages: [
    {
      packageId: '22222222-2222-4222-8222-222222222222',
      packageGlobalId: 'gpa0000001',
      packageNumber: 1,
      dimensionsMm: { length: 279, width: 229, height: 178 },
      weightGrams: 2_500,
    },
    {
      packageId: '33333333-3333-4333-8333-333333333333',
      packageGlobalId: 'gpa0000002',
      packageNumber: 2,
      dimensionsMm: { length: 432, width: 279, height: 178 },
      weightGrams: 5_000,
    },
  ],
  packageCount: 2,
}

const baseAttempt = {
  id: '44444444-4444-4444-8444-444444444444',
  globalId: 'gpre0000001',
  persistedAt: '2026-07-31T17:00:00.000Z',
  replayed: false,
}

const runtime = {
  organizationId: '55555555-5555-4555-8555-555555555555',
  integrationAccountId: '66666666-6666-4666-8666-666666666666',
  carrierAccountId: '77777777-7777-4777-8777-777777777777',
  credentialVersion: 7,
  credentialFingerprint: 'credential-fingerprint',
  accountNumberFingerprint: 'account-number-fingerprint',
  provider: 'ups_rest',
  environment: 'production',
  credential: {
    accountNumber: 'account-number-used-only-by-mocked-request-preparation',
  },
}

const preparedRequest = {
  adapterVersion: 'carrier-whole-shipment-rate-v1',
  accessMode: 'rate_read_only',
  providerMutationCount: 0,
  provider: 'ups_rest',
  environment: 'production',
  endpoint: 'https://carrier.invalid/rate',
  endpointVersion: 'v1',
  method: 'POST',
  headers: {},
  body: {},
  requestHash: 'request-hash',
  redactedRequest: {},
} as const

const parsedResponse = {
  provider: 'ups_rest',
  environment: 'production',
  purpose: 'fulfillment_execution',
  rateScope: 'multi_package_shipment',
  expectedCurrency: 'USD',
  packageCount: 2,
  rates: [],
  evidence: {},
} as const

const succeededResult = {
  id: '88888888-8888-4888-8888-888888888888',
  globalId: 'gprs0000001',
  state: 'succeeded',
} as const

const failedResult = {
  id: '99999999-9999-4999-8999-999999999999',
  globalId: 'gprs0000002',
  state: 'failed',
} as const

let attempt = { ...baseAttempt }
let networkError: Error | null = null
let successFinalizerError: Error | null = null

class MockCarrierWholeShipmentRateClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'CarrierWholeShipmentRateClientError'
    this.status = status
    this.code = code
  }
}

mock.module('@/lib/integrations/carrierIntegrations', {
  namedExports: {
    async resolveCarrierProductionRatingRuntime() {
      events.push('resolve-runtime')
      return runtime
    },
  },
})

mock.module('@/lib/integrations/carrierWholeShipmentRateClient', {
  namedExports: {
    CarrierWholeShipmentRateClientError:
      MockCarrierWholeShipmentRateClientError,
    async executeCarrierWholeShipmentRateRequest(
      input: Record<string, unknown>,
    ) {
      events.push('network')
      networkInputs.push(input)
      if (networkError) throw networkError
      return parsedResponse
    },
  },
})

mock.module('@/lib/integrations/carrierWholeShipmentRateFoundation', {
  namedExports: {
    prepareCarrierWholeShipmentRateRequest() {
      events.push('prepare-request')
      return preparedRequest
    },
  },
})

mock.module('@/lib/operations/productionFulfillmentRerates', {
  namedExports: {
    carrierRateDestinationFromActive() {
      return {
        name: destination.contactName,
        line1: destination.line1,
        line2: destination.line2,
        city: destination.city,
        region: destination.region,
        postalCode: destination.postalCode,
        countryCode: 'US',
        residential: destination.residential,
      }
    },
    carrierRatePartyFromActiveOrigin() {
      return {
        name: origin.contactName,
        phone: origin.phone,
        line1: origin.line1,
        line2: origin.line2,
        city: origin.city,
        region: origin.region,
        postalCode: origin.postalCode,
        countryCode: 'US',
        residential: origin.residential,
      }
    },
    carrierWholeShipmentRateParcelsFromRunPackages() {
      return [
        {
          description: 'Fulfillment package 1',
          length: 11,
          width: 9,
          height: 7,
          dimensionUnit: 'IN',
          weight: 5.5116,
          weightUnit: 'LB',
        },
        {
          description: 'Fulfillment package 2',
          length: 17,
          width: 11,
          height: 7,
          dimensionUnit: 'IN',
          weight: 11.0231,
          weightUnit: 'LB',
        },
      ]
    },
    async prepareProductionFulfillmentRerateInPostgres(
      input: Record<string, unknown>,
    ) {
      events.push('prepare-run')
      runInputs.push(input)
      return run
    },
    async prepareProductionFulfillmentRerateAttemptInPostgres(
      input: Record<string, unknown>,
    ) {
      events.push('prepare-attempt')
      attemptInputs.push(input)
      return attempt
    },
    async finalizeProductionFulfillmentRerateAttemptInPostgres(input: {
      organizationId: unknown
      attemptGlobalId: unknown
      outcome: Record<string, unknown>
    }) {
      const state = String(input.outcome.state)
      events.push(`finalize-${state}`)
      finalizerInputs.push(input)
      if (state === 'succeeded' && successFinalizerError) {
        throw successFinalizerError
      }
      return state === 'succeeded' ? succeededResult : failedResult
    },
  },
})

const {
  executeProductionFulfillmentRerate,
  ProductionFulfillmentRerateExecutionError,
} = await import(
  '../../lib/operations/productionFulfillmentRerateExecution.ts'
)

const baseInput = {
  organizationId: runtime.organizationId,
  activeExecutionGlobalId: 'gafe0000001',
  activeShipmentGroupGlobalId: 'gasg0000001',
  expectedActivationRevision: 3,
  destination,
  currency: 'USD',
  provider: 'ups_rest' as const,
  integrationAccountGlobalId: 'gia0000001',
  carrierAccountGlobalId: 'gac0000001',
  origin,
  idempotencyKey: 'rerate-test-key',
  actorEmail: 'operator@example.test',
}

function resetMocks() {
  events.length = 0
  runInputs.length = 0
  attemptInputs.length = 0
  networkInputs.length = 0
  finalizerInputs.length = 0
  attempt = { ...baseAttempt }
  networkError = null
  successFinalizerError = null
}

test.beforeEach(resetMocks)

test('persists the immutable run and attempt before carrier network I/O', async () => {
  await executeProductionFulfillmentRerate(baseInput)

  assert.ok(events.indexOf('prepare-run') >= 0)
  assert.ok(events.indexOf('prepare-attempt') > events.indexOf('prepare-run'))
  assert.ok(events.indexOf('network') > events.indexOf('prepare-attempt'))
  assert.equal(runInputs.length, 1)
  assert.equal(attemptInputs.length, 1)
  assert.equal(networkInputs.length, 1)
  assert.equal(
    attemptInputs[0].rerateRunGlobalId,
    run.globalId,
    'the durable attempt must bind to the durable run',
  )
})

test('finalizes a successful provider response exactly once', async () => {
  const execution = await executeProductionFulfillmentRerate(baseInput)

  assert.equal(execution.run, run)
  assert.equal(execution.attempt, attempt)
  assert.equal(execution.result, succeededResult)
  assert.equal(finalizerInputs.length, 1)
  assert.equal(finalizerInputs[0].attemptGlobalId, attempt.globalId)
  assert.deepEqual(finalizerInputs[0].outcome, {
    state: 'succeeded',
    parsedResponse,
  })
  assert.deepEqual(events.slice(-2), ['network', 'finalize-succeeded'])
})

test('terminalizes a provider failure before returning the safe execution error', async () => {
  networkError = new MockCarrierWholeShipmentRateClientError(
    'The carrier request timed out',
    504,
    'CARRIER_PRODUCTION_RATE_TIMEOUT',
  )

  await assert.rejects(
    executeProductionFulfillmentRerate(baseInput),
    (error: unknown) => {
      assert.ok(error instanceof ProductionFulfillmentRerateExecutionError)
      assert.equal(error.code, 'CARRIER_PRODUCTION_RATE_TIMEOUT')
      assert.equal(error.status, 504)
      assert.equal(error.attemptGlobalId, attempt.globalId)
      return true
    },
  )

  assert.equal(networkInputs.length, 1)
  assert.equal(finalizerInputs.length, 1)
  assert.equal(finalizerInputs[0].attemptGlobalId, attempt.globalId)
  assert.equal(finalizerInputs[0].outcome.state, 'failed')
  assert.equal(
    finalizerInputs[0].outcome.errorCode,
    'CARRIER_PRODUCTION_RATE_TIMEOUT',
  )
  assert.deepEqual(
    finalizerInputs[0].outcome.redactedResponse,
    {
      adapterVersion: preparedRequest.adapterVersion,
      accessMode: 'rate_read_only',
      providerMutationCount: 0,
      provider: preparedRequest.provider,
      environment: preparedRequest.environment,
      endpoint: preparedRequest.endpoint,
      endpointVersion: preparedRequest.endpointVersion,
      purpose: 'fulfillment_execution',
      rateScope: 'multi_package_shipment',
      packageCount: run.packageCount,
      errorCode: 'CARRIER_PRODUCTION_RATE_TIMEOUT',
    },
  )
  assert.equal(
    Object.hasOwn(finalizerInputs[0].outcome, 'completedAt'),
    false,
    'terminal result time must come from the database transaction clock',
  )
  assert.deepEqual(events.slice(-2), ['network', 'finalize-failed'])
})

test('refuses a replayed durable attempt without carrier or finalizer calls', async () => {
  attempt = { ...baseAttempt, replayed: true }

  await assert.rejects(
    executeProductionFulfillmentRerate(baseInput),
    (error: unknown) => {
      assert.ok(error instanceof ProductionFulfillmentRerateExecutionError)
      assert.equal(
        error.code,
        'OPERATIONS_PRODUCTION_RERATE_RECONCILIATION_REQUIRED',
      )
      assert.equal(error.status, 409)
      assert.equal(error.attemptGlobalId, attempt.globalId)
      return true
    },
  )

  assert.equal(attemptInputs.length, 1)
  assert.equal(networkInputs.length, 0)
  assert.equal(finalizerInputs.length, 0)
  assert.equal(events.at(-1), 'prepare-attempt')
})

test('does not recast a success-finalizer failure as a provider failure', async () => {
  const finalizerError = new Error('success result persistence failed')
  successFinalizerError = finalizerError

  await assert.rejects(
    executeProductionFulfillmentRerate(baseInput),
    (error: unknown) => error === finalizerError,
  )

  assert.equal(networkInputs.length, 1)
  assert.equal(finalizerInputs.length, 1)
  assert.equal(finalizerInputs[0].outcome.state, 'succeeded')
  assert.deepEqual(events.slice(-2), ['network', 'finalize-succeeded'])
  assert.equal(
    events.includes('finalize-failed'),
    false,
    'a persistence failure after provider success must not create false provider-failure evidence',
  )
})
