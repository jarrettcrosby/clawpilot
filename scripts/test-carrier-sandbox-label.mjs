#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

class MockCarrierCredentialClientError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'CarrierCredentialClientError'
    this.status = status
    this.code = code
  }
}

const fixture = {
  origin: {
    name: 'John Doe',
    street: '101 Jegs Place',
    city: 'Delaware',
    state: 'OH',
    postalCode: '43015',
    countryCode: 'US',
  },
  destination: {
    name: 'John Doe',
    street: '101 Academy Drive',
    city: 'Buzzards Bay',
    state: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
  parcel: {
    description: 'Test Product',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  },
}

const secrets = {
  accountNumber: 'ACCOUNT-9012',
  clientId: 'sandbox-client-id-must-not-leak',
  clientSecret: 'sandbox-client-secret-must-not-leak',
  accessToken: 'sandbox-access-token-must-not-leak',
}

const successfulTokenRequest = async () => ({
  accessToken: secrets.accessToken,
  expiresInSeconds: 3600,
  scope: 'ship',
})
let tokenRequest = successfulTokenRequest

function loadLabelModule() {
  const path = 'app_src/lib/integrations/carrierSandboxLabel.ts'
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
    AbortSignal,
    Buffer,
    Error,
    Headers,
    Request,
    Response,
    URLSearchParams,
    clearTimeout,
    console,
    exports: module.exports,
    fetch: async () => {
      throw new Error('Live carrier access is forbidden in adapter tests')
    },
    module,
    process,
    setTimeout,
    require(specifier) {
      if (specifier === '@/lib/integrations/carrierCredentialClient') {
        return {
          CarrierCredentialClientError: MockCarrierCredentialClientError,
          requestCarrierAccessToken: (...args) => tokenRequest(...args),
        }
      }
      if (specifier === '@/lib/integrations/carrierSandboxRate') {
        return { CARRIER_SANDBOX_RATE_FIXTURE: fixture }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function runtime(provider, serviceCode) {
  return {
    provider,
    environment: 'sandbox',
    credential: {
      accountNumber: secrets.accountNumber,
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
    },
    serviceCode,
  }
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertError(error, expected) {
  assert.equal(error.code, expected.code)
  assert.equal(error.status, expected.status)
  assert.equal(error.uncertain, expected.uncertain)
  const serialized = `${error.message}\n${JSON.stringify(error)}`
  for (const secret of Object.values(secrets)) {
    assert.ok(!serialized.includes(secret), `Error leaked protected value ${secret}`)
  }
  return true
}

function assertEvidenceRedacted(result) {
  const serializedResult = JSON.stringify(result)
  const serializedEvidence = JSON.stringify(result.evidence)
  for (const secret of Object.values(secrets)) {
    assert.ok(!serializedResult.includes(secret), `Result leaked protected value ${secret}`)
    assert.ok(!serializedEvidence.includes(secret), `Evidence leaked protected value ${secret}`)
  }
  assert.ok(
    !serializedEvidence.includes(result.labelPayload || '__no_label_payload__'),
    'Evidence must record label size, not label contents',
  )
  assert.ok(!/accountNumber/i.test(serializedEvidence), 'Evidence must not include account fields')
  assert.match(result.evidence.requestHash, /^[a-f0-9]{64}$/)
}

const {
  createCarrierSandboxLabel,
  voidCarrierSandboxLabel,
} = loadLabelModule()

const upsCreateCalls = []
const upsCreateResult = await createCarrierSandboxLabel(runtime('ups_rest', '03'), {
  fetchImpl: async (url, init) => {
    upsCreateCalls.push({ url: String(url), init })
    return jsonResponse({
      ProviderEcho: { AccountNumber: secrets.accountNumber },
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: '1ZSHIPMENT0001',
          PackageResults: [{
            TrackingNumber: '1ZTRACKING0001',
            ShippingLabel: {
              ImageFormat: { Code: 'ZPL' },
              GraphicImage: 'XlhBXkZPNTAsNTBeRkRTQU5EQk9YXkZT',
            },
          }],
        },
      },
    }, { headers: { 'transaction-id': 'ups-create-transaction' } })
  },
})

assert.equal(upsCreateCalls.length, 1)
assert.equal(upsCreateCalls[0].url, 'https://wwwcie.ups.com/api/shipments/v2409/ship')
assert.equal(upsCreateCalls[0].init.method, 'POST')
assert.equal(upsCreateCalls[0].init.headers.Authorization, `Bearer ${secrets.accessToken}`)
const upsCreateBody = JSON.parse(upsCreateCalls[0].init.body)
assert.equal(
  upsCreateBody.ShipmentRequest.Shipment.Shipper.ShipperNumber,
  secrets.accountNumber,
)
assert.equal(
  upsCreateBody.ShipmentRequest.Shipment.PaymentInformation.ShipmentCharge[0]
    .BillShipper.AccountNumber,
  secrets.accountNumber,
)
assert.equal(upsCreateBody.ShipmentRequest.Shipment.Service.Code, '03')
assert.equal(upsCreateBody.ShipmentRequest.LabelSpecification.LabelImageFormat.Code, 'ZPL')
assert.equal(
  upsCreateBody.ShipmentRequest.LabelSpecification.HTTPUserAgent,
  'Mozilla/4.5',
)
assert.deepEqual(plain({
  provider: upsCreateResult.provider,
  trackingNumber: upsCreateResult.trackingNumber,
  providerLabelId: upsCreateResult.providerLabelId,
  format: upsCreateResult.format,
}), {
  provider: 'ups_rest',
  trackingNumber: '1ZTRACKING0001',
  providerLabelId: '1ZSHIPMENT0001',
  format: 'ZPL',
})
assert.equal(upsCreateResult.evidence.providerReference, 'ups-create-transaction')
assertEvidenceRedacted(upsCreateResult)

const fedexCreateCalls = []
const fedexCreateResult = await createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
  fetchImpl: async (url, init) => {
    fedexCreateCalls.push({ url: String(url), init })
    return jsonResponse({
      accountNumber: secrets.accountNumber,
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'MASTERTRACKING0002',
          pieceResponses: [{
            trackingNumber: 'TRACKING0002',
            packageDocuments: [{
              contentType: 'LABEL',
              docType: 'PDF',
              encodedLabel: 'JVBERi0xLjQKJVRlc3QK',
            }],
          }],
        }],
      },
    }, { headers: { 'x-customer-transaction-id': 'fedex-create-transaction' } })
  },
})

assert.equal(fedexCreateCalls.length, 1)
assert.equal(fedexCreateCalls[0].url, 'https://apis-sandbox.fedex.com/ship/v1/shipments')
assert.equal(fedexCreateCalls[0].init.method, 'POST')
assert.equal(fedexCreateCalls[0].init.headers.Authorization, `Bearer ${secrets.accessToken}`)
const fedexCreateBody = JSON.parse(fedexCreateCalls[0].init.body)
assert.equal(fedexCreateBody.accountNumber.value, secrets.accountNumber)
assert.equal(fedexCreateBody.requestedShipment.packagingType, 'YOUR_PACKAGING')
assert.equal(fedexCreateBody.requestedShipment.shippingChargesPayment.paymentType, 'SENDER')
assert.equal(fedexCreateBody.requestedShipment.labelSpecification.imageType, 'PDF')
assert.equal(fedexCreateBody.requestedShipment.labelSpecification.labelStockType, 'PAPER_4X6')
assert.equal(fedexCreateBody.requestedShipment.requestedPackageLineItems.length, 1)
assert.deepEqual(plain({
  provider: fedexCreateResult.provider,
  trackingNumber: fedexCreateResult.trackingNumber,
  providerLabelId: fedexCreateResult.providerLabelId,
  format: fedexCreateResult.format,
}), {
  provider: 'fedex_rest',
  trackingNumber: 'TRACKING0002',
  providerLabelId: 'MASTERTRACKING0002',
  format: 'PDF',
})
assert.equal(fedexCreateResult.evidence.providerReference, 'fedex-create-transaction')
assertEvidenceRedacted(fedexCreateResult)

const upsVoidCalls = []
const upsVoidResult = await voidCarrierSandboxLabel({
  ...runtime('ups_rest', '03'),
  trackingNumber: upsCreateResult.trackingNumber,
  providerReference: upsCreateResult.providerLabelId,
}, {
  fetchImpl: async (url, init) => {
    upsVoidCalls.push({ url: String(url), init })
    return jsonResponse({
      ProviderEcho: { AccountNumber: secrets.accountNumber },
      VoidShipmentResponse: {
        Response: { ResponseStatus: { Code: '1', Description: 'Success' } },
        SummaryResult: { Status: { Code: '1', Description: 'Voided' } },
      },
    })
  },
})

assert.equal(
  upsVoidCalls[0].url,
  'https://wwwcie.ups.com/api/shipments/v2409/void/cancel/1ZSHIPMENT0001',
)
assert.equal(upsVoidCalls[0].init.method, 'DELETE')
assert.equal(upsVoidCalls[0].init.body, undefined)
assert.equal(upsVoidResult.voided, true)
assert.equal(upsVoidResult.trackingNumber, upsCreateResult.trackingNumber)
assert.equal(upsVoidResult.providerReference, upsCreateResult.providerLabelId)
assertEvidenceRedacted(upsVoidResult)

const upsMaskedVoidResult = await voidCarrierSandboxLabel({
  ...runtime('ups_rest', '03'),
  trackingNumber: '1ZXXXXXXXXXXXXXXXX',
  providerReference: '1ZXXXXXXXXXXXXXXXX',
}, {
  fetchImpl: async () => jsonResponse({
    response: {
      errors: [{
        code: '190102',
        message: 'No shipment found within the allowed void period',
      }],
    },
  }, { status: 400 }),
})
assert.equal(upsMaskedVoidResult.voided, true)
assert.deepEqual(plain(upsMaskedVoidResult.evidence.redactedResponse), {
  trackingNumber: '1ZXXXXXXXXXXXXXXXX',
  providerReference: '1ZXXXXXXXXXXXXXXXX',
  voided: true,
  providerState: 'not_found',
  providerCode: '190102',
})
assertEvidenceRedacted(upsMaskedVoidResult)

const fedexVoidCalls = []
const fedexVoidResult = await voidCarrierSandboxLabel({
  ...runtime('fedex_rest', 'FEDEX_GROUND'),
  trackingNumber: fedexCreateResult.trackingNumber,
  providerReference: fedexCreateResult.providerLabelId,
}, {
  fetchImpl: async (url, init) => {
    fedexVoidCalls.push({ url: String(url), init })
    return jsonResponse({
      accountNumber: secrets.accountNumber,
      output: {
        cancelledShipment: true,
        cancelledHistory: true,
        message: 'Shipment is successfully cancelled',
      },
    })
  },
})

assert.equal(fedexVoidCalls[0].url, 'https://apis-sandbox.fedex.com/ship/v1/shipments/cancel')
assert.equal(fedexVoidCalls[0].init.method, 'PUT')
assert.deepEqual(JSON.parse(fedexVoidCalls[0].init.body), {
  accountNumber: { value: secrets.accountNumber },
  trackingNumber: fedexCreateResult.trackingNumber,
  deletionControl: 'DELETE_ALL_PACKAGES',
})
assert.equal(fedexVoidResult.voided, true)
assertEvidenceRedacted(fedexVoidResult)

await assert.rejects(
  voidCarrierSandboxLabel({
    ...runtime('ups_rest', '03'),
    trackingNumber: '1ZUNCONFIRMED',
    providerReference: '1ZUNCONFIRMED',
  }, {
    fetchImpl: async () => jsonResponse({
      VoidShipmentResponse: {
        Response: { ResponseStatus: { Code: '0', Description: 'Not voided' } },
        SummaryResult: { Status: { Code: '0', Description: 'Not voided' } },
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'UPS HTTP success must not count as voided without status code 1',
)

await assert.rejects(
  voidCarrierSandboxLabel({
    ...runtime('fedex_rest', 'FEDEX_GROUND'),
    trackingNumber: 'FEDEXUNCONFIRMED',
    providerReference: 'FEDEXUNCONFIRMED',
  }, {
    fetchImpl: async () => jsonResponse({
      output: {
        cancelledShipment: false,
        message: 'Shipment was not cancelled',
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'FedEx HTTP success must not count as voided without cancelledShipment true',
)

let operationFetchCount = 0
tokenRequest = async () => {
  throw new MockCarrierCredentialClientError(
    'The carrier rejected these credentials',
    409,
    'CARRIER_CREDENTIAL_REJECTED',
  )
}
try {
  await assert.rejects(
    createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
      fetchImpl: async () => {
        operationFetchCount += 1
        throw new Error('Operation fetch must not run after credential rejection')
      },
    }),
    (error) => assertError(error, {
      code: 'CARRIER_CREDENTIAL_REJECTED',
      status: 409,
      uncertain: false,
    }),
  )
  assert.equal(operationFetchCount, 0)
} finally {
  tokenRequest = successfulTokenRequest
}

await assert.rejects(
  createCarrierSandboxLabel(runtime('ups_rest', '03'), {
    fetchImpl: async () => {
      const error = new Error('Mock provider request timed out')
      error.name = 'AbortError'
      throw error
    },
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESULT_UNKNOWN',
    status: 504,
    uncertain: true,
  }),
)

await assert.rejects(
  voidCarrierSandboxLabel({
    ...runtime('fedex_rest', 'FEDEX_GROUND'),
    trackingNumber: 'TRACKING-NETWORK-UNKNOWN',
    providerReference: 'REFERENCE-NETWORK-UNKNOWN',
  }, {
    fetchImpl: async () => {
      throw new Error(`Socket closed after sending account ${secrets.accountNumber}`)
    },
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESULT_UNKNOWN',
    status: 503,
    uncertain: true,
  }),
)

await assert.rejects(
  createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
    fetchImpl: async () => jsonResponse({
      accountNumber: secrets.accountNumber,
      clientSecret: secrets.clientSecret,
      message: 'Provider rejected request',
    }, { status: 422 }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_SANDBOX_LABEL_CREATE_REJECTED',
    status: 409,
    uncertain: false,
  }),
  'Provider rejection bodies must not be copied into adapter errors',
)

console.log('carrier sandbox label adapter tests passed')
