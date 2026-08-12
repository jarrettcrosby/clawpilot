#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReadableStream } from 'node:stream/web'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
process.env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY =
  'brokered-client-test-key-that-is-at-least-thirty-two-bytes'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function load(path, dependencies = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
    return nodeRequire(specifier)
  }
  const sandbox = {
    AbortController,
    AbortSignal,
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
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    require: localRequire,
    setTimeout,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const credentialCrypto = load(
  'app_src/lib/integrations/brokeredTransportCredentialCrypto.ts',
)
const wwexFoundation = load(
  'app_src/lib/integrations/wwexSpeedshipFoundation.ts',
)
const rlFoundation = load(
  'app_src/lib/integrations/rlCarriersFreightFoundation.ts',
)
const wwexClient = load(
  'app_src/lib/integrations/wwexSpeedshipClient.ts',
  {
    '@/lib/integrations/brokeredTransportCredentialCrypto': credentialCrypto,
    '@/lib/integrations/wwexSpeedshipFoundation': wwexFoundation,
  },
)
const rlClient = load(
  'app_src/lib/integrations/rlCarriersFreightClient.ts',
  {
    '@/lib/integrations/brokeredTransportCredentialCrypto': credentialCrypto,
    '@/lib/integrations/rlCarriersFreightFoundation': rlFoundation,
  },
)

for (const sourcePath of [
  'app_src/lib/integrations/wwexSpeedshipClient.ts',
  'app_src/lib/integrations/rlCarriersFreightClient.ts',
]) {
  const source = read(sourcePath)
  assert.doesNotMatch(source, /console\.(?:log|warn|error)/)
  assert.doesNotMatch(source, /retry|setInterval/i)
}

const origin = {
  line1: '7009 S 108th St',
  line2: null,
  locality: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
  companyName: 'Foundation Warehouse',
  phone: '4025550100',
  contact: {
    firstName: 'Alex',
    lastName: 'Warehouse',
    phone: '4025550100',
    email: 'warehouse@example.test',
  },
  residential: false,
  locationType: 'OTHER',
}
const destination = {
  line1: '35 Saxony Drive',
  line2: null,
  locality: 'Trumbull',
  region: 'CT',
  postalCode: '06611',
  countryCode: 'US',
  companyName: 'One-Off Customer',
  phone: '2035550101',
  contact: {
    firstName: 'Jamie',
    lastName: 'Receiver',
    phone: '2035550101',
    email: 'receiver@example.test',
  },
  residential: true,
  locationType: 'RESIDENTIAL',
}
const wwexCredentialVersion = 3
const wwexCredentialFingerprint = 'a'.repeat(64)
const wwexPrepared = wwexFoundation.prepareWwexSmallpackShopRequest({
  credentialVersion: wwexCredentialVersion,
  credentialFingerprint: wwexCredentialFingerprint,
  planId: 'shipment-plan:SP-CLIENT-1',
  correlationId: 'clawpilot:shop:SP-CLIENT-1:r1',
  shipmentDate: '2026-08-18 14:30:00',
  shipmentDescription: 'One loose customer carton',
  origin,
  destination,
  packages: [{
    packageKey: 'carton-1',
    packagingType: '02',
    length: 18,
    width: 13,
    height: 9,
    weight: 22,
    references: [{
      type: 'Shipment Reference 1',
      value: '1001001',
      isPrintAsBarCode: true,
    }],
    insuredValueUsd: '250.00',
  }],
  deliveryConfirmation: true,
  carbonNeutral: false,
  adultSignatureRequired: false,
  signatureRequired: true,
  shipperRelease: false,
  selfScheduled: false,
  returnLabel: false,
  returnServiceType: null,
})
const wwexResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Success' },
  correlationId: 'wwex:shop:SP-CLIENT-1',
  response: {
    productTransactionId: '9c27819f-ffca-417f-a1f0-b2929e8f3f5c',
    offerList: [{
      primaryVendor: {
        vendorId: 'UPS',
        preferredName: 'United Parcel Service',
        scac: 'UPSN',
      },
      offerId: '55f42c03-95e4-4d9d-953c-c711568d9312',
      expirationDate: '2026-08-18 15:00:00',
      offeredProductList: [{
        offeredProductId: 'ups-ground-product-1',
        offerPrice: { value: '48.25', unit: 'USD' },
        chargeItemList: [],
        shopRQShipment: {
          timeInTransit: {
            upsServiceCode: 'GND',
            serviceDescription: 'UPS Ground',
            transitDays: 3,
            estimatedDeliveryDate: '2026-08-21',
          },
        },
      }],
    }],
  },
}
const wwexCredential = {
  authKind: 'oauth_client_credentials',
  clientId: 'replacement-client-1234',
  clientSecret: 'replacement-client-secret',
  audience: 'staging-wwex-apig',
}
const wwexRuntimeCredential = {
  provider: 'wwex_speedship',
  environment: 'sandbox',
  credentialVersion: wwexCredentialVersion,
  credentialFingerprint: wwexCredentialFingerprint,
  credential: wwexCredential,
}

const wwexVerificationToken = 'verification-token-must-not-be-retained'
let wwexVerificationFetches = 0
const wwexVerification = await wwexClient.verifyWwexSpeedshipRuntimeCredential({
  runtimeCredential: wwexRuntimeCredential,
  fetchImpl: async (url, init) => {
    wwexVerificationFetches += 1
    assert.equal(String(url), 'https://auth.staging-wwex.com/oauth/token')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded')
    assert.equal(new URLSearchParams(init.body).get('grant_type'), 'client_credentials')
    return new Response(JSON.stringify({
      access_token: wwexVerificationToken,
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
assert.equal(wwexVerificationFetches, 1)
assert.equal(wwexVerification.provider, 'wwex_speedship')
assert.equal(wwexVerification.environment, 'sandbox')
assert.equal(wwexVerification.verificationType, 'oauth_client_credentials')
assert.equal(wwexVerification.providerHttpStatus, 200)
assert.equal(wwexVerification.credentialVersion, wwexCredentialVersion)
assert.equal(wwexVerification.credentialFingerprint, wwexCredentialFingerprint)
assert.ok(Object.isFrozen(wwexVerification))
assert.deepEqual(
  Object.keys(JSON.parse(JSON.stringify(wwexVerification))).sort(),
  [
    'completedAt',
    'credentialFingerprint',
    'credentialVersion',
    'environment',
    'provider',
    'providerHttpStatus',
    'requestedAt',
    'verificationType',
  ].sort(),
)
const serializedWwexVerification = JSON.stringify(wwexVerification)
for (const sensitiveValue of [
  wwexCredential.clientId,
  wwexCredential.clientSecret,
  wwexCredential.audience,
  wwexVerificationToken,
]) {
  assert.ok(!serializedWwexVerification.includes(sensitiveValue))
}

let invalidWwexVerificationFetches = 0
for (const invalidCase of [{
  runtimeCredential: {
    ...wwexRuntimeCredential,
    environment: 'production',
  },
  code: 'WWEX_PRODUCTION_CONFIGURATION_REQUIRED',
}, {
  runtimeCredential: {
    ...wwexRuntimeCredential,
    credentialFingerprint: 'not-a-fingerprint',
  },
  code: 'WWEX_CREDENTIAL_BINDING_MISMATCH',
}, {
  runtimeCredential: {
    ...wwexRuntimeCredential,
    credential: {
      ...wwexCredential,
      clientSecret: 'short',
    },
  },
  code: 'WWEX_CREDENTIAL_INVALID',
}]) {
  await assert.rejects(
    wwexClient.verifyWwexSpeedshipRuntimeCredential({
      runtimeCredential: invalidCase.runtimeCredential,
      fetchImpl: async () => {
        invalidWwexVerificationFetches += 1
        throw new Error('must not execute')
      },
    }),
    (error) => error instanceof wwexClient.WwexSpeedshipClientError
      && error.code === invalidCase.code
      && error.providerOutcome === 'failed'
      && error.reconciliation === null,
  )
}
assert.equal(invalidWwexVerificationFetches, 0)

const wwexVerificationFailureMarker = 'wwex-sensitive-network-detail'
for (const failureFetch of [
  async () => { throw new Error(wwexVerificationFailureMarker) },
  async () => new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error(wwexVerificationFailureMarker))
    },
  }), { status: 200 }),
]) {
  await assert.rejects(
    wwexClient.verifyWwexSpeedshipRuntimeCredential({
      runtimeCredential: wwexRuntimeCredential,
      fetchImpl: failureFetch,
    }),
    (error) => error instanceof wwexClient.WwexSpeedshipClientError
      && error.code === 'WWEX_AUTH_UNAVAILABLE'
      && error.providerOutcome === 'failed'
      && error.reconciliation === null
      && !error.message.includes(wwexVerificationFailureMarker)
      && !error.message.includes(wwexCredential.clientSecret),
  )
}

const wwexCalls = []
const wwexFetch = async (url, init) => {
  wwexCalls.push({ url: String(url), init })
  if (wwexCalls.length === 1) {
    return new Response(JSON.stringify({
      access_token: 'sandbox-access-token-value',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response(JSON.stringify(wwexResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
const wwexExecution = await wwexClient.executeWwexSpeedshipShopRequest({
  preparedRequest: wwexPrepared,
  runtimeCredential: wwexRuntimeCredential,
  fetchImpl: wwexFetch,
})
assert.equal(wwexCalls.length, 2)
assert.equal(wwexCalls[0].url, 'https://auth.staging-wwex.com/oauth/token')
assert.equal(wwexCalls[1].url, 'https://speedship.staging-wwex.com/svc/shopFlow')
assert.equal(wwexCalls[1].init.headers.Authorization, 'Bearer sandbox-access-token-value')
assert.equal(wwexExecution.result.provider, 'wwex_speedship')
assert.equal(wwexExecution.credentialVersion, wwexCredentialVersion)
assert.equal(wwexExecution.credentialFingerprint, wwexCredentialFingerprint)
assert.deepEqual(JSON.parse(JSON.stringify(
  wwexExecution.result.offers[0].executingCarrier,
)), { vendorId: 'UPS', name: 'UPS', scac: 'UPSN' })

let productionFetches = 0
assert.throws(
  () => wwexClient.executeWwexSpeedshipShopRequest({
    preparedRequest: wwexPrepared,
    runtimeCredential: {
      ...wwexRuntimeCredential,
      environment: 'production',
    },
    fetchImpl: async () => {
      productionFetches += 1
      throw new Error('must not execute')
    },
  }),
  (error) => error.code === 'WWEX_PRODUCTION_CONFIGURATION_REQUIRED'
    && error.providerOutcome === 'failed',
)
assert.equal(productionFetches, 0)

let rotatedShopFetches = 0
assert.throws(
  () => wwexClient.executeWwexSpeedshipShopRequest({
    preparedRequest: wwexPrepared,
    runtimeCredential: {
      ...wwexRuntimeCredential,
      credentialVersion: wwexCredentialVersion + 1,
    },
    fetchImpl: async () => {
      rotatedShopFetches += 1
      throw new Error('must not execute')
    },
  }),
  (error) => error.code === 'WWEX_CREDENTIAL_BINDING_MISMATCH'
    && error.providerOutcome === 'failed',
)
assert.equal(rotatedShopFetches, 0)

const wwexShop = wwexFoundation.parseWwexSmallpackShopResponse(
  wwexPrepared,
  wwexResponse,
)
const wwexPickupPrepared = wwexFoundation.prepareWwexSmallpackSchedulePickupRequest({
  pickupPlanId: 'pickup-plan:SP-CLIENT-1:r1',
  shop: wwexShop,
  pickupDate: '2026-08-18 10:10:00',
  pickupAddress: origin,
  timeZone: 'America/Chicago',
  readyTime: '10:35:00',
  closeTime: '16:50:00',
  alternateAddress: false,
  saturdayAvailable: false,
  selfScheduled: false,
  correlationId: 'clawpilot:pickup:SP-CLIENT-1:r1',
})
const wwexPickupResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Pickup offered' },
  correlationId: 'wwex:pickup:SP-CLIENT-1',
  response: {
    pickupOfferList: [{
      primaryVendor: {
        vendorId: 'UPS',
        preferredName: 'United Parcel Service',
        scac: 'UPSN',
      },
      offerId: 'fc85a46e-ccaa-4228-a3b4-2fbdda06e389',
      productTransactionId: 'f6dcc8de-726e-40cf-af23-21f9bab64bac',
      expirationDate: '2026-08-18 15:30:00',
      matchedRequestedPickupTime: true,
      offeredProductList: [{
        offeredProductId: 'ups-on-demand-pickup-product-1',
        offerPrice: { value: '8.50', unit: 'USD' },
        pickup: {
          shipmentProductTransactionIdList: [wwexShop.productTransactionId],
        },
      }],
    }],
  },
}
let rotatedPickupFetches = 0
assert.throws(
  () => wwexClient.executeWwexSmallpackSchedulePickupRequest({
    preparedRequest: wwexPickupPrepared,
    runtimeCredential: {
      ...wwexRuntimeCredential,
      credentialVersion: wwexCredentialVersion + 1,
    },
    fetchImpl: async () => {
      rotatedPickupFetches += 1
      throw new Error('must not execute')
    },
  }),
  (error) => error.code === 'WWEX_CREDENTIAL_BINDING_MISMATCH'
    && error.providerOutcome === 'failed',
)
assert.equal(rotatedPickupFetches, 0)
let pickupCalls = 0
const wwexPickupExecution = await wwexClient.executeWwexSmallpackSchedulePickupRequest({
  preparedRequest: wwexPickupPrepared,
  runtimeCredential: wwexRuntimeCredential,
  fetchImpl: async (url) => {
    pickupCalls += 1
    if (pickupCalls === 1) {
      return new Response(JSON.stringify({
        access_token: 'sandbox-access-token-value',
        token_type: 'Bearer',
      }), { status: 200 })
    }
    assert.equal(String(url), 'https://speedship.staging-wwex.com/svc/schedulePickupFlow')
    return new Response(JSON.stringify(wwexPickupResponse), { status: 200 })
  },
})
assert.equal(pickupCalls, 2)
assert.equal(wwexPickupExecution.result.offers[0].pickupOfferId,
  'fc85a46e-ccaa-4228-a3b4-2fbdda06e389')
const wwexPickup = wwexPickupExecution.result
let ambiguousPickupCalls = 0
await assert.rejects(
  wwexClient.executeWwexSmallpackSchedulePickupRequest({
    preparedRequest: wwexPickupPrepared,
    runtimeCredential: wwexRuntimeCredential,
    fetchImpl: async () => {
      ambiguousPickupCalls += 1
      if (ambiguousPickupCalls === 1) {
        return new Response(JSON.stringify({
          access_token: 'sandbox-access-token-value',
          token_type: 'Bearer',
        }), { status: 200 })
      }
      throw new Error('ambiguous pickup outcome')
    },
  }),
  (error) => error.code === 'WWEX_PROVIDER_UNAVAILABLE'
    && error.providerOutcome === 'unknown',
)
assert.equal(ambiguousPickupCalls, 2)
const wwexTender = wwexFoundation.prepareWwexSmallpackTenderRequest({
  tenderPlanId: 'tender-plan:SP-CLIENT-1:r1',
  shop: wwexShop,
  selectedOfferId: wwexShop.offers[0].offerId,
  selectedOfferedProductId: wwexShop.offers[0].offeredProductId,
  pickup: wwexPickup,
  selectedPickupOfferId: wwexPickup.offers[0].pickupOfferId,
  selectedPickupOfferedProductId: wwexPickup.offers[0].pickupOfferedProductId,
  billToType: 'SENDER',
  billToAccountNumber: 'REPLACEMENT-ACCOUNT-7788',
  billToAccountFingerprint: credentialCrypto.wwexSpeedshipBillingAccountFingerprint(
    '11111111-1111-4111-8111-111111111111',
    'sandbox',
    'REPLACEMENT-ACCOUNT-7788',
  ),
  billToPostalCode: origin.postalCode,
  billToCountryCode: origin.countryCode,
  sendersReceipt: false,
  internationalFormsPrepared: false,
  tenderedAtLocal: '2026-08-18 14:45:00',
  correlationId: 'clawpilot:tender:SP-CLIENT-1:r1',
})
const wwexTenderResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Ordered' },
  correlationId: 'wwex:tender:SP-CLIENT-1',
  response: {
    pickupOrderResponse: {
      order: {
        orderId: 'pickup-order-sp-client-1',
        orderedItemList: [{ pickupTxnId: 'pickup-txn-sp-client-1' }],
      },
    },
    shipmentOrderResponse: {
      order: {
        orderId: 'shipment-order-sp-client-1',
        orderedItemList: [{
          secondaryTxnIdList: [{
            type: 'TRACKING_ID',
            value: '1Z999AA10123456784',
          }],
          documentList: [{
            s3FileName: 'sp-client-1-label.pdf',
            docType: 'UPS_LABEL_ONLY',
            docFormat: 'PDF',
            name: 'UPS shipping label',
          }],
        }],
      },
    },
  },
}
let successfulTenderCalls = 0
const successfulWwexTender = await wwexClient.executeWwexSpeedshipTenderRequest({
  preparedRequest: wwexTender,
  runtimeCredential: wwexRuntimeCredential,
  fetchImpl: async () => {
    successfulTenderCalls += 1
    return successfulTenderCalls === 1
      ? new Response(JSON.stringify({
          access_token: 'sandbox-access-token-value',
          token_type: 'Bearer',
        }), { status: 200 })
      : new Response(JSON.stringify(wwexTenderResponse), { status: 200 })
  },
})
assert.equal(successfulWwexTender.result.shipmentOrderId, 'shipment-order-sp-client-1')
assert.equal(successfulWwexTender.result.pickupOrderId, 'pickup-order-sp-client-1')

const partialWwexTenderResponse = JSON.parse(JSON.stringify(wwexTenderResponse))
partialWwexTenderResponse.response.shipmentOrderResponse
  .order.orderedItemList[0].documentList = []
let partialTenderCalls = 0
await assert.rejects(
  wwexClient.executeWwexSpeedshipTenderRequest({
    preparedRequest: wwexTender,
    runtimeCredential: wwexRuntimeCredential,
    fetchImpl: async () => {
      partialTenderCalls += 1
      return partialTenderCalls === 1
        ? new Response(JSON.stringify({
            access_token: 'sandbox-access-token-value',
            token_type: 'Bearer',
          }), { status: 200 })
        : new Response(JSON.stringify(partialWwexTenderResponse), { status: 200 })
    },
  }),
  (error) => {
    assert.equal(error.code, 'WWEX_PARTIAL_OUTCOME_RECONCILIATION_REQUIRED')
    assert.equal(error.providerOutcome, 'unknown')
    assert.deepEqual(JSON.parse(JSON.stringify(error.reconciliation.providerIds)), {
      pickupOrderId: 'pickup-order-sp-client-1',
      pickupTransactionId: 'pickup-txn-sp-client-1',
      shipmentOrderId: 'shipment-order-sp-client-1',
      quoteNumber: null,
    })
    assert.deepEqual(
      JSON.parse(JSON.stringify(error.reconciliation.missingRequiredEvidence)),
      ['shipment_documents'],
    )
    return true
  },
)
let credentialMismatchFetches = 0
for (const runtimeCredential of [{
  ...wwexRuntimeCredential,
  credentialVersion: 4,
}, {
  ...wwexRuntimeCredential,
  credentialFingerprint: 'b'.repeat(64),
}]) {
  assert.throws(
    () => wwexClient.executeWwexSpeedshipTenderRequest({
      preparedRequest: wwexTender,
      runtimeCredential,
      fetchImpl: async () => {
        credentialMismatchFetches += 1
        throw new Error('must not execute')
      },
    }),
    (error) => error.code === 'WWEX_CREDENTIAL_BINDING_MISMATCH'
      && error.providerOutcome === 'failed',
  )
}
assert.equal(credentialMismatchFetches, 0)
let tenderCalls = 0
await assert.rejects(
  wwexClient.executeWwexSpeedshipTenderRequest({
    preparedRequest: wwexTender,
    runtimeCredential: wwexRuntimeCredential,
    fetchImpl: async () => {
      tenderCalls += 1
      if (tenderCalls === 1) {
        return new Response(JSON.stringify({
          access_token: 'sandbox-access-token-value',
          token_type: 'Bearer',
        }), { status: 200 })
      }
      throw new Error('ambiguous network outcome')
    },
  }),
  (error) => error.code === 'WWEX_PROVIDER_UNAVAILABLE'
    && error.providerOutcome === 'unknown'
    && !error.message.includes(wwexCredential.clientSecret),
)
assert.equal(tenderCalls, 2)

const rlOrigin = {
  city: 'Delaware',
  stateOrProvince: 'OH',
  zipOrPostalCode: '43015',
  countryCode: 'USA',
}
const rlDestination = {
  city: 'Boston',
  stateOrProvince: 'MA',
  zipOrPostalCode: '02215',
  countryCode: 'USA',
}
const rlCredentialVersion = 5
const rlCredentialFingerprint = 'c'.repeat(64)
const rlPreparedRate = rlFoundation.prepareRlCarriersRateQuoteRequest({
  credentialVersion: rlCredentialVersion,
  credentialFingerprint: rlCredentialFingerprint,
  pickupDate: '2026-08-14',
  origin: rlOrigin,
  destination: rlDestination,
  items: [{
    freightClass: '60',
    weightLb: 500,
    lengthIn: 48,
    widthIn: 40,
    heightIn: 45,
  }],
  accessorials: ['DestinationLiftgate'],
})
const rlRatePayload = {
  RateQuote: {
    Origin: { City: 'DELAWARE', StateOrProvince: 'OH' },
    Destination: { City: 'BOSTON', StateOrProvince: 'MA' },
    CustomerDiscounts: '$431.62',
    Charges: [{
      Type: 'NET',
      Title: 'Net Charge',
      Weight: '',
      Rate: '',
      Amount: '$114.56',
    }],
    ServiceLevels: [{
      QuoteNumber: '88973391',
      ServiceDays: 2,
      Charge: '$523.27',
      NetCharge: '$114.56',
      HourlyWindow: null,
      Name: 'Standard Service',
      Code: 'STD',
    }],
    IsDirect: true,
  },
  Code: 200,
  Errors: [],
  Messages: ['Quote generated'],
}
const rlApiKey = 'replacement-rl-api-key-9876'
const rlRuntimeCredential = {
  provider: 'rl_carriers',
  environment: 'production',
  credentialVersion: rlCredentialVersion,
  credentialFingerprint: rlCredentialFingerprint,
  credential: { authKind: 'api_key', apiKey: rlApiKey },
}

const rlServicePointSensitiveMarker = 'service-point-response-must-not-be-retained'
let rlVerificationFetches = 0
const rlVerification = await rlClient.verifyRlCarriersRuntimeCredential({
  runtimeCredential: rlRuntimeCredential,
  zipOrPostalCode: '43015',
  countryCode: 'USA',
  fetchImpl: async (url, init) => {
    rlVerificationFetches += 1
    const endpoint = new URL(String(url))
    assert.equal(endpoint.origin, 'https://api.rlc.com')
    assert.equal(endpoint.pathname, '/ServicePoint')
    assert.equal(endpoint.searchParams.get('ZipOrPostalCode'), '43015')
    assert.equal(endpoint.searchParams.get('CountryCode'), 'USA')
    assert.equal(init.method, 'GET')
    assert.equal(init.headers.apiKey, rlApiKey)
    return new Response(JSON.stringify({
      ServicePoints: [{
        TerminalCode: 'COL',
        TerminalName: rlServicePointSensitiveMarker,
      }],
      Code: 200,
      Errors: [],
      Messages: ['Service point found'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
assert.equal(rlVerificationFetches, 1)
assert.equal(rlVerification.provider, 'rl_carriers')
assert.equal(rlVerification.environment, 'production')
assert.equal(rlVerification.verificationType, 'service_point')
assert.equal(rlVerification.servicePointCount, 1)
assert.equal(rlVerification.providerHttpStatus, 200)
assert.equal(rlVerification.credentialVersion, rlCredentialVersion)
assert.equal(rlVerification.credentialFingerprint, rlCredentialFingerprint)
assert.ok(Object.isFrozen(rlVerification))
assert.deepEqual(
  Object.keys(JSON.parse(JSON.stringify(rlVerification))).sort(),
  [
    'completedAt',
    'credentialFingerprint',
    'credentialVersion',
    'environment',
    'provider',
    'providerHttpStatus',
    'requestedAt',
    'servicePointCount',
    'verificationType',
  ].sort(),
)
const serializedRlVerification = JSON.stringify(rlVerification)
assert.ok(!serializedRlVerification.includes(rlApiKey))
assert.ok(!serializedRlVerification.includes(rlServicePointSensitiveMarker))

let invalidRlVerificationFetches = 0
for (const invalidCase of [{
  runtimeCredential: rlRuntimeCredential,
  zipOrPostalCode: 'not-a-postal-code',
  countryCode: 'USA',
  code: 'RL_VERIFICATION_POSTAL_CODE_INVALID',
}, {
  runtimeCredential: rlRuntimeCredential,
  zipOrPostalCode: '43015',
  countryCode: 'MEX',
  code: 'RL_VERIFICATION_COUNTRY_INVALID',
}, {
  runtimeCredential: {
    ...rlRuntimeCredential,
    credentialFingerprint: 'not-a-fingerprint',
  },
  zipOrPostalCode: '43015',
  countryCode: 'USA',
  code: 'RL_CREDENTIAL_BINDING_MISMATCH',
}, {
  runtimeCredential: {
    ...rlRuntimeCredential,
    credential: { authKind: 'api_key', apiKey: 'short' },
  },
  zipOrPostalCode: '43015',
  countryCode: 'USA',
  code: 'RL_CREDENTIAL_INVALID',
}]) {
  await assert.rejects(
    rlClient.verifyRlCarriersRuntimeCredential({
      runtimeCredential: invalidCase.runtimeCredential,
      zipOrPostalCode: invalidCase.zipOrPostalCode,
      countryCode: invalidCase.countryCode,
      fetchImpl: async () => {
        invalidRlVerificationFetches += 1
        throw new Error('must not execute')
      },
    }),
    (error) => error instanceof rlClient.RlCarriersFreightClientError
      && error.code === invalidCase.code
      && error.providerOutcome === 'failed'
      && error.reconciliation === null,
  )
}
assert.equal(invalidRlVerificationFetches, 0)

const rlVerificationFailureMarker = 'rl-sensitive-network-detail'
for (const failureFetch of [
  async () => { throw new Error(rlVerificationFailureMarker) },
  async () => new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error(rlVerificationFailureMarker))
    },
  }), { status: 200 }),
]) {
  await assert.rejects(
    rlClient.verifyRlCarriersRuntimeCredential({
      runtimeCredential: rlRuntimeCredential,
      zipOrPostalCode: '43015',
      countryCode: 'USA',
      fetchImpl: failureFetch,
    }),
    (error) => error instanceof rlClient.RlCarriersFreightClientError
      && error.code === 'RL_PROVIDER_UNAVAILABLE'
      && error.providerOutcome === 'failed'
      && error.reconciliation === null
      && !error.message.includes(rlVerificationFailureMarker)
      && !error.message.includes(rlApiKey),
  )
}

let rlRateCall = null
const rlExecution = await rlClient.executeRlCarriersRateQuoteRequest({
  preparedRequest: rlPreparedRate,
  runtimeCredential: rlRuntimeCredential,
  fetchImpl: async (url, init) => {
    rlRateCall = { url: String(url), init }
    return new Response(JSON.stringify(rlRatePayload), { status: 200 })
  },
})
assert.equal(rlRateCall.url, 'https://api.rlc.com/RateQuote')
assert.equal(rlRateCall.init.headers.apiKey, rlApiKey)
assert.equal(rlExecution.result.provider, 'rl_carriers')
assert.equal(rlExecution.result.rates[0].netCharge, '114.56')
assert.equal(rlExecution.result.tariffBasis, 'class_ltl')
assert.equal(rlExecution.credentialVersion, rlCredentialVersion)
assert.equal(rlExecution.credentialFingerprint, rlCredentialFingerprint)

const shipper = {
  companyName: 'Foundation Shipper LLC',
  addressLine1: '1250 Warehouse Avenue',
  addressLine2: 'Dock 4',
  phoneNumber: '(614) 555-0188',
  emailAddress: 'shipping@example.test',
  ...rlOrigin,
}
const consignee = {
  companyName: 'Foundation Consignee Inc',
  attention: 'Receiving Team',
  addressLine1: '90 Distribution Way',
  addressLine2: null,
  phoneNumber: '617-555-0114',
  emailAddress: 'receiving@example.test',
  ...rlDestination,
}
const rlBol = rlFoundation.prepareRlCarriersBillOfLadingRequest({
  bolDate: '2026-08-14',
  rateSelection: {
    parsedRateQuote: rlExecution.result,
    selectedQuoteNumber: '88973391',
  },
  shipper,
  consignee,
  handlingUnits: [{
    unitType: 'PLT',
    quantity: 1,
    lengthIn: 48,
    widthIn: 40,
    heightIn: 45,
    items: [{
      pieces: 10,
      packageType: 'CTN',
      description: 'Boxed radiators',
      freightClass: '60',
      weightLb: 500,
      nmfcItemNumber: '123456',
      nmfcSubNumber: '01',
    }],
  }],
  freightChargePaymentMethod: 'Prepaid',
  pickupRequest: {
    pickupDate: '2026-08-14',
    readyTime: '08:00',
    closeTime: '17:00',
    sendEmailConfirmation: false,
  },
})
let rlCredentialMismatchFetches = 0
for (const runtimeCredential of [{
  ...rlRuntimeCredential,
  credentialVersion: rlCredentialVersion + 1,
}, {
  ...rlRuntimeCredential,
  credentialFingerprint: 'd'.repeat(64),
}]) {
  await assert.rejects(
    rlClient.executeRlCarriersBillOfLadingRequest({
      preparedRequest: rlBol,
      runtimeCredential,
      fetchImpl: async () => {
        rlCredentialMismatchFetches += 1
        throw new Error('must not execute')
      },
    }),
    (error) => error.code === 'RL_CREDENTIAL_BINDING_MISMATCH'
      && error.providerOutcome === 'failed',
  )
}
assert.equal(rlCredentialMismatchFetches, 0)
const rlBolSuccess = await rlClient.executeRlCarriersBillOfLadingRequest({
  preparedRequest: rlBol,
  runtimeCredential: rlRuntimeCredential,
  fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://api.rlc.com/BillOfLading')
    assert.ok(JSON.parse(init.body).PickupRequest)
    return new Response(JSON.stringify({
      ProNumber: '123456789',
      PickupRequestNumber: '7654321',
      Code: 200,
      Messages: ['Created'],
    }), { status: 200 })
  },
})
assert.equal(rlBolSuccess.result.proNumber, '123456789')
assert.equal(rlBolSuccess.result.pickupRequestId, '7654321')

for (const partialPayload of [{
  ProNumber: '123456790',
  Code: 200,
  Messages: [],
}, {
  PickupRequestNumber: '7654322',
  Code: 200,
  Messages: [],
}]) {
  await assert.rejects(
    rlClient.executeRlCarriersBillOfLadingRequest({
      preparedRequest: rlBol,
      runtimeCredential: rlRuntimeCredential,
      fetchImpl: async () => new Response(JSON.stringify(partialPayload), {
        status: 200,
      }),
    }),
    (error) => {
      assert.equal(error.code, 'RL_PARTIAL_OUTCOME_RECONCILIATION_REQUIRED')
      assert.equal(error.providerOutcome, 'unknown')
      assert.equal(
        error.reconciliation.providerIds.proNumber,
        partialPayload.ProNumber || null,
      )
      assert.equal(
        error.reconciliation.providerIds.pickupRequestId,
        partialPayload.PickupRequestNumber || null,
      )
      assert.equal(error.reconciliation.requestHash, rlBol.requestHash)
      assert.ok(!JSON.stringify(error.reconciliation).includes(rlApiKey))
      return true
    },
  )
}
await assert.rejects(
  rlClient.executeRlCarriersBillOfLadingRequest({
    preparedRequest: rlBol,
    runtimeCredential: rlRuntimeCredential,
    fetchImpl: async () => { throw new Error('ambiguous network outcome') },
  }),
  (error) => error.code === 'RL_PROVIDER_UNAVAILABLE'
    && error.providerOutcome === 'unknown'
    && !error.message.includes(rlApiKey),
)

console.log('PASS brokered transport HTTP clients')
