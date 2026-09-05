#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, dependencies = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    BigInt,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Response,
    Set,
    String,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    require(specifier) {
      if (dependencies[specifier]) return dependencies[specifier]
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      return nodeRequire(specifier)
    },
    setTimeout,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function recorded(path) {
  return JSON.parse(read(`scripts/fixtures/carrier-rates/${path}`))
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function clone(value) {
  return plain(value)
}

const foundationPath =
  'app_src/lib/integrations/carrierWholeShipmentRateFoundation.ts'
const credentialPath = 'app_src/lib/integrations/carrierCredentialClient.ts'
const clientPath = 'app_src/lib/integrations/carrierWholeShipmentRateClient.ts'
const foundation = loadTypeScriptModule(foundationPath)
const credentials = loadTypeScriptModule(credentialPath)
const clientSource = read(clientPath)
const client = loadTypeScriptModule(clientPath, {
  '@/lib/integrations/carrierCredentialClient': credentials,
  '@/lib/integrations/carrierWholeShipmentRateFoundation': foundation,
})

assert.deepEqual(
  Object.keys(client).sort(),
  [
    'CarrierWholeShipmentRateClientError',
    'executeCarrierWholeShipmentRateRequest',
  ],
  'The HTTP boundary exposes only the bounded rate executor and its safe error',
)
assert.match(clientSource, /requestCarrierAccessToken/)
assert.match(clientSource, /sealPreparedCarrierWholeShipmentRateRequest/)
assert.match(clientSource, /parseCarrierWholeShipmentRateResponse/)
assert.doesNotMatch(
  clientSource,
  /\/ship\/v1|\/shipments|carrierSandboxLabel|createLabel|voidLabel/,
  'The read-only rate client must not acquire a provider mutation surface',
)

const {
  prepareCarrierWholeShipmentRateRequest,
} = foundation
const {
  CarrierWholeShipmentRateClientError,
  executeCarrierWholeShipmentRateRequest,
} = client

const accountNumber = 'ACCOUNT-9012'
const base = {
  binding: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    carrierAccountId: '22222222-2222-4222-8222-222222222222',
    integrationAccountId: '33333333-3333-4333-8333-333333333333',
    credentialRevision: 7,
    credentialFingerprint: 'a'.repeat(64),
    accountNumber,
    accountNumberFingerprint: 'b'.repeat(64),
    provider: 'ups_rest',
    environment: 'production',
  },
  origin: {
    name: 'AG Alchemy, LLC',
    phone: '(402) 555-0100',
    line1: '7009 S 108th St',
    line2: null,
    city: 'La Vista',
    region: 'NE',
    postalCode: '68128',
    countryCode: 'US',
    residential: false,
  },
  destination: {
    name: 'Warehouse Test',
    line1: '35 Saxony Drive',
    line2: null,
    city: 'Trumbull',
    region: 'CT',
    postalCode: '06611',
    countryCode: 'US',
    residential: true,
  },
  parcels: [
    {
      description: 'AG12V2 case pack',
      length: 11,
      width: 9,
      height: 7,
      dimensionUnit: 'IN',
      weight: 10.5,
      weightUnit: 'LB',
    },
    {
      description: '20lb bulk case',
      length: 17,
      width: 11,
      height: 7,
      dimensionUnit: 'IN',
      weight: 20.5,
      weightUnit: 'LB',
    },
  ],
  billing: {
    relationship: 'sender',
    payerAccountNumber: accountNumber,
    payerAccountNumberFingerprint: 'b'.repeat(64),
    payerPostalCode: '68128',
    payerCountryCode: 'US',
  },
  expectedCurrency: 'USD',
  fedexPickupType: null,
}

function prepared(provider = 'ups_rest', environment = 'production') {
  const input = clone(base)
  input.binding.provider = provider
  input.binding.environment = environment
  input.fedexPickupType = provider === 'fedex_rest'
    ? 'USE_SCHEDULED_PICKUP'
    : null
  return prepareCarrierWholeShipmentRateRequest(input)
}

function runtimeCredential(provider = 'ups_rest', environment = 'production') {
  return {
    provider,
    environment,
    credential: {
      clientId: `${provider}-client-id`,
      clientSecret: `${provider}-client-secret`,
      accountNumber,
    },
  }
}

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: 'production-access-token',
    expires_in: 3_600,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function successfulFetch(provider, calls) {
  const ratePayload = provider === 'ups_rest'
    ? recorded('ups-whole-shipment-recorded.json')
    : recorded('fedex-whole-shipment-recorded.json')
  return async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (calls.length === 1) return tokenResponse()
    return new Response(JSON.stringify(ratePayload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [provider === 'ups_rest'
          ? 'transaction-id'
          : 'x-customer-transaction-id']:
          `recorded-${provider}-rate-001`,
      },
    })
  }
}

for (const provider of ['ups_rest', 'fedex_rest']) {
  const request = prepared(provider)
  const requestBeforeExecution = JSON.stringify(request)
  const calls = []
  const result = await executeCarrierWholeShipmentRateRequest({
    preparedRequest: request,
    runtimeCredential: runtimeCredential(provider),
    fetchImpl: successfulFetch(provider, calls),
  })

  assert.equal(calls.length, 2, 'one OAuth request and one rate request are made')
  assert.match(calls[0].url, provider === 'ups_rest'
    ? /^https:\/\/onlinetools\.ups\.com\/security\/v1\/oauth\/token$/
    : /^https:\/\/apis\.fedex\.com\/oauth\/token$/)
  assert.equal(calls[1].url, request.endpoint)
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.redirect, 'error')
  assert.equal(
    new Headers(calls[1].init.headers).get('authorization'),
    'Bearer production-access-token',
  )
  assert.deepEqual(JSON.parse(calls[1].init.body), plain(request.body))
  assert.equal(result.provider, provider)
  assert.equal(result.environment, 'production')
  assert.equal(result.packageCount, 2)
  assert.ok(result.rates.length > 0)
  assert.equal(result.evidence.redactedResponse.providerMutationCount, 0)
  assert.equal(result.evidence.providerReference, `recorded-${provider}-rate-001`)
  assert.equal(JSON.stringify(request), requestBeforeExecution)
  assert.equal(request.headers.Authorization, undefined)
}

{
  const request = clone(prepared('ups_rest'))
  const expectedEndpoint = request.endpoint
  const expectedBody = clone(request.body)
  const ratePayload = recorded('ups-whole-shipment-recorded.json')
  const calls = []
  const result = await executeCarrierWholeShipmentRateRequest({
    preparedRequest: request,
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1) {
        request.endpoint = 'https://attacker.invalid/collect-production-token'
        request.headers = { 'x-attacker-controlled': 'true' }
        request.body = { attackerControlled: true }
        return tokenResponse()
      }
      return new Response(JSON.stringify(ratePayload), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'transaction-id': 'immutable-snapshot-rate-001',
        },
      })
    },
  })

  assert.equal(calls.length, 2, 'one OAuth request and one rate request are made')
  assert.equal(
    calls[1].url,
    expectedEndpoint,
    'caller mutation during OAuth must not redirect the rate request',
  )
  assert.equal(
    new Headers(calls[1].init.headers).get('x-attacker-controlled'),
    null,
    'caller mutation during OAuth must not alter transmitted headers',
  )
  assert.deepEqual(
    JSON.parse(calls[1].init.body),
    expectedBody,
    'caller mutation during OAuth must not alter the transmitted body',
  )
  assert.equal(result.evidence.providerReference, 'immutable-snapshot-rate-001')
}

async function expectClientError(options, expectedCode) {
  await assert.rejects(
    executeCarrierWholeShipmentRateRequest(options),
    (error) => {
      assert.ok(error instanceof CarrierWholeShipmentRateClientError)
      assert.equal(error.code, expectedCode)
      return true
    },
  )
}

{
  let calls = 0
  await expectClientError({
    preparedRequest: prepared('ups_rest', 'sandbox'),
    runtimeCredential: runtimeCredential('ups_rest', 'sandbox'),
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
  }, 'CARRIER_PRODUCTION_REQUIRED')
  assert.equal(calls, 0, 'sandbox requests fail before credential acquisition')
}

{
  let calls = 0
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('fedex_rest'),
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
  }, 'CARRIER_RATE_BINDING_MISMATCH')
  assert.equal(calls, 0, 'provider mismatch fails before credential acquisition')
}

{
  const mismatchedAccount = runtimeCredential('ups_rest')
  mismatchedAccount.credential.accountNumber = 'DIFFERENT-ACCOUNT'
  let calls = 0
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: mismatchedAccount,
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
  }, 'CARRIER_RATE_BINDING_MISMATCH')
  assert.equal(calls, 0, 'account mismatch fails before credential acquisition')
}

{
  const tampered = clone(prepared('ups_rest'))
  tampered.endpoint = 'https://wwwcie.ups.com/api/rating/v2409/Shop'
  let calls = 0
  await expectClientError({
    preparedRequest: tampered,
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not fetch')
    },
  }, 'CARRIER_RATE_REQUEST_INVALID')
  assert.equal(calls, 0, 'tampered requests fail before credential acquisition')
}

function responseScenario(rateResponse) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return calls.length === 1 ? tokenResponse() : rateResponse()
  }
  return { calls, fetchImpl }
}

for (const [status, expectedCode] of [
  [400, 'CARRIER_PRODUCTION_RATE_REJECTED'],
  [429, 'CARRIER_PROVIDER_RATE_LIMITED'],
  [503, 'CARRIER_PROVIDER_UNAVAILABLE'],
]) {
  const scenario = responseScenario(
    () => new Response('{}', { status }),
  )
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: scenario.fetchImpl,
  }, expectedCode)
  assert.equal(
    scenario.calls.length,
    2,
    `HTTP ${status} must not trigger an executor retry`,
  )
}

{
  const scenario = responseScenario(() => new Response('{}', {
    status: 200,
    headers: { 'content-length': String(3 * 1024 * 1024) },
  }))
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: scenario.fetchImpl,
  }, 'CARRIER_PROVIDER_RESPONSE_INVALID')
  assert.equal(scenario.calls.length, 2)
}

{
  const scenario = responseScenario(() => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(161 * 1024))
        controller.close()
      },
    }),
    { status: 200 },
  ))
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: scenario.fetchImpl,
  }, 'CARRIER_PROVIDER_RESPONSE_INVALID')
  assert.equal(
    scenario.calls.length,
    2,
    'a chunked oversized response must be cancelled without a retry',
  )
}

{
  const scenario = responseScenario(
    () => new Response('not-json', { status: 200 }),
  )
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: scenario.fetchImpl,
  }, 'CARRIER_PROVIDER_RESPONSE_INVALID')
  assert.equal(scenario.calls.length, 2)
}

{
  const scenario = responseScenario(
    () => new Response('{}', { status: 200 }),
  )
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl: scenario.fetchImpl,
  }, 'CARRIER_PRODUCTION_RATE_EMPTY')
  assert.equal(scenario.calls.length, 2)
}

{
  let calls = 0
  const fetchImpl = async (_url, init = {}) => {
    calls += 1
    if (calls === 1) return tokenResponse()
    return new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort, { once: true })
    })
  }
  await expectClientError({
    preparedRequest: prepared('ups_rest'),
    runtimeCredential: runtimeCredential('ups_rest'),
    fetchImpl,
    timeoutMs: 1_000,
  }, 'CARRIER_PROVIDER_TIMEOUT')
  assert.equal(calls, 2, 'a timeout must not trigger an executor retry')
}

console.log('Carrier whole-shipment production rate client tests passed.')
