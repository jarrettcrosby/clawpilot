#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import * as integrationCredentialRuntimeGate from './lib/integration-credential-runtime-test-double.mjs'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function evidenceHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

class MockCarrierCredentialClientError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

class MockCarrierSandboxLabelError extends Error {
  constructor(message, status, code, uncertain, redactedResponse = {}) {
    super(message)
    this.status = status
    this.code = code
    this.uncertain = uncertain
    this.redactedResponse = redactedResponse
  }
}

let tokenCalls = 0

const output = {
  format: 'ZPL',
  mediaSize: 'label_4x6',
  sourceKind: 'provider_native',
  providerImageType: 'ZPL',
  providerStockType: 'HEIGHT_6_WIDTH_4',
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function parsedLabel(trackingNumber) {
  return {
    trackingNumber,
    providerLabelId: trackingNumber,
    labelPayload: `^XA^FD${trackingNumber}^FS^XZ`,
    payloadEncoding: 'utf8',
    ...output,
    labelByteLength: 40,
    labelContentSha256: 'a'.repeat(64),
  }
}

const sandboxLabelModule = {
  CarrierSandboxLabelError: MockCarrierSandboxLabelError,
  carrierLabelAdapterInternals: {
    labelOutputOption() {
      return output
    },
    serviceCode(_provider, value) {
      return value.trim()
    },
    normalizeShipmentFixture(value) {
      return value
    },
    upsCreateRequest() {
      return {
        ShipmentRequest: {
          Request: {},
          Shipment: {
            Shipper: {},
            ShipFrom: {},
            ShipTo: {},
          },
        },
      }
    },
    fedexCreateRequest() {
      return {
        accountNumber: { value: 'account-secret' },
        requestedShipment: {
          shipper: { contact: {} },
          recipients: [{ contact: {} }],
        },
      }
    },
    parseUpsCreate(payload) {
      const shipment = record(record(payload.ShipmentResponse).ShipmentResults)
      const packageResult = record(list(shipment.PackageResults)[0])
      return parsedLabel(String(packageResult.TrackingNumber || ''))
    },
    parseFedexCreate(payload) {
      const shipment = record(list(record(payload.output).transactionShipments)[0])
      const piece = record(list(shipment.pieceResponses)[0])
      return parsedLabel(String(piece.trackingNumber || ''))
    },
    async readProviderPayload(response) {
      return await response.json()
    },
  },
}

function loadGroupModule() {
  const path = 'app_src/lib/integrations/carrierOneOffGroupShipment.ts'
  const source = ts.transpileModule(read(path), {
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
      if (
        specifier
        === '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
      ) {
        return integrationCredentialRuntimeGate
      }
      if (specifier === '@/lib/integrations/carrierCredentialClient') {
        return {
          CarrierCredentialClientError: MockCarrierCredentialClientError,
          async requestCarrierAccessToken() {
            tokenCalls += 1
            return { accessToken: 'unit-test-token' }
          },
        }
      }
      if (specifier === '@/lib/integrations/carrierSandboxLabel') {
        return sandboxLabelModule
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(source, sandbox, { filename: path })
  return module.exports
}

const {
  CarrierOneOffGroupError,
  carrierOneOffGroupLifecycleMode,
  executeCarrierOneOffGroupShipment,
  executeCarrierOneOffGroupVoid,
  prepareCarrierOneOffGroupRequest,
  prepareCarrierOneOffGroupVoidRequest,
} = loadGroupModule()

function runtime(provider, environment = 'sandbox') {
  return {
    provider,
    environment,
    credential: {
      accountNumber: 'account-secret',
      clientId: 'client-secret-id',
      clientSecret: 'client-secret-value',
    },
    integrationAccountGlobalId: 'gia000000001',
    carrierAccountGlobalId: 'gca000000001',
    credentialVersion: 7,
    credentialFingerprint: 'credential-fingerprint-v7',
    accountNumberFingerprint: 'account-number-fingerprint',
    billingRelationship: 'sender',
    billingSelectionSnapshot: { senderName: 'ClawPilot Warehouse' },
  }
}

const origin = {
  name: 'ClawPilot Warehouse',
  line1: '100 Warehouse Way',
  line2: null,
  city: 'Omaha',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
}

const destination = {
  name: 'Test Receiver',
  line1: '200 Receiving Road',
  line2: null,
  city: 'Lincoln',
  region: 'NE',
  postalCode: '68508',
  countryCode: 'US',
  residential: false,
}

const parcels = [
  {
    packageKey: 'package-1',
    packageNumber: 1,
    description: 'Package 1',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  },
  {
    packageKey: 'package-2',
    packageNumber: 2,
    description: 'Package 2',
    length: 8,
    width: 7,
    height: 4,
    dimensionUnit: 'IN',
    weight: 3,
    weightUnit: 'LB',
  },
]

function prepared(provider, environment = 'sandbox') {
  return prepareCarrierOneOffGroupRequest({
    runtime: runtime(provider, environment),
    serviceCode: provider === 'ups_rest' ? '03' : 'FEDEX_GROUND',
    shipmentFixture: { origin, destination, parcels },
    shipFromPhone: '4025550100',
    shipToPhone: '4025550101',
    shipDate: '2026-08-11',
    attemptCorrelationKey: `group-create:${provider}:${environment}`,
  })
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorWith(code, uncertain) {
  return (error) => {
    assert.ok(error instanceof CarrierOneOffGroupError)
    assert.equal(error.code, code)
    assert.equal(error.uncertain, uncertain)
    return true
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function run() {
  {
    const request = prepared('ups_rest', 'production')
    const shipment = record(record(request.providerBody.ShipmentRequest).Shipment)
    const ratingOptions = record(shipment.ShipmentRatingOptions)
    assert.equal(request.providerMethod, 'POST')
    assert.equal(
      request.providerEndpoint,
      'https://onlinetools.ups.com/api/shipments/v2409/ship',
    )
    assert.equal(list(shipment.Package).length, 2)
    assert.equal(ratingOptions.NegotiatedRatesIndicator, '')
    assert.match(request.providerBodyHash, /^[a-f0-9]{64}$/)
    assert.match(request.requestHash, /^[a-f0-9]{64}$/)
    assert.equal(request.requestHash, evidenceHash(request.redactedRequest))
    assert.equal(JSON.stringify(request.redactedRequest).includes('account-secret'), false)
  }

  {
    const request = prepared('fedex_rest')
    const shipment = record(request.providerBody.requestedShipment)
    const lineItems = list(shipment.requestedPackageLineItems).map(record)
    assert.equal(shipment.oneLabelAtATime, false)
    assert.equal(shipment.totalPackageCount, 2)
    assert.deepEqual(lineItems.map((item) => item.sequenceNumber), [1, 2])
    assert.deepEqual(lineItems.map((item) => item.groupPackageCount), [2, 2])
  }

  {
    tokenCalls = 0
    const request = prepared('ups_rest')
    let carrierCalls = 0
    await assert.rejects(
      executeCarrierOneOffGroupShipment({
        runtime: {
          ...runtime('ups_rest'),
          credentialFingerprint: 'different-credential',
        },
        prepared: request,
      }, {
        fetchImpl: async () => {
          carrierCalls += 1
          return jsonResponse({})
        },
      }),
      errorWith('CARRIER_ONE_OFF_GROUP_PREPARED_EVIDENCE_INVALID', false),
    )
    assert.equal(tokenCalls, 0)
    assert.equal(carrierCalls, 0)
  }

  {
    tokenCalls = 0
    const request = prepared('fedex_rest')
    await assert.rejects(
      executeCarrierOneOffGroupShipment({
        runtime: runtime('fedex_rest'),
        prepared: request,
      }, {
        fetchImpl: async () => jsonResponse({
          output: {
            transactionShipments: [{
              masterTrackingNumber: 'MASTER-1',
              pieceResponses: [
                { trackingNumber: 'CHILD-1' },
                { packageSequenceNumber: 2, trackingNumber: 'CHILD-2' },
              ],
            }],
          },
        }),
      }),
      errorWith('CARRIER_PROVIDER_RESPONSE_INVALID', true),
    )
    assert.equal(tokenCalls, 1)
  }

  {
    const request = prepared('fedex_rest')
    const result = await executeCarrierOneOffGroupShipment({
      runtime: runtime('fedex_rest'),
      prepared: request,
    }, {
      fetchImpl: async () => jsonResponse({
        output: {
          transactionShipments: [{
            masterTrackingNumber: 'MASTER-1',
            pieceResponses: [
              { packageSequenceNumber: 2, trackingNumber: 'CHILD-2' },
              { packageSequenceNumber: 1, trackingNumber: 'MASTER-1' },
            ],
          }],
        },
      }),
    })
    assert.deepEqual(
      plain(result.labels.map((label) => [label.packageKey, label.trackingNumber])),
      [['package-1', 'MASTER-1'], ['package-2', 'CHILD-2']],
    )
  }

  {
    const request = prepared('ups_rest')
    await assert.rejects(
      executeCarrierOneOffGroupShipment({
        runtime: runtime('ups_rest'),
        prepared: request,
      }, {
        fetchImpl: async () => jsonResponse({
          ShipmentResponse: {
            ShipmentResults: {
              ShipmentIdentificationNumber: '1ZMASTER0000000001',
              PackageResults: [
                { TrackingNumber: '1ZWRONG00000000001' },
                { TrackingNumber: '1ZCHILD00000000001' },
              ],
            },
          },
        }),
      }),
      errorWith('CARRIER_PROVIDER_RESPONSE_INVALID', true),
    )
  }

  {
    const request = prepared('ups_rest', 'production')
    const result = await executeCarrierOneOffGroupShipment({
      runtime: runtime('ups_rest', 'production'),
      prepared: request,
    }, {
      fetchImpl: async () => jsonResponse({
        ShipmentResponse: {
          ShipmentResults: {
            ShipmentIdentificationNumber: '1ZMASTER0000000001',
            NegotiatedRateCharges: {
              TotalCharge: { CurrencyCode: 'USD', MonetaryValue: '12.34' },
            },
            ShipmentCharges: {
              TotalCharges: { CurrencyCode: 'USD', MonetaryValue: '19.99' },
            },
            PackageResults: [
              { TrackingNumber: '1ZMASTER0000000001' },
              { TrackingNumber: '1ZCHILD00000000001' },
            ],
          },
        },
      }),
    })
    assert.deepEqual(plain(result.quotedCharge), {
      amountMinor: 1_234,
      currency: 'USD',
      rateType: 'negotiated',
    })
  }

  {
    const request = prepared('ups_rest')
    const sample = '1ZXXXXXXXXXXXXXXXX'
    const result = await executeCarrierOneOffGroupShipment({
      runtime: runtime('ups_rest'),
      prepared: request,
    }, {
      fetchImpl: async () => jsonResponse({
        ShipmentResponse: {
          ShipmentResults: {
            ShipmentIdentificationNumber: sample,
            PackageResults: [
              { TrackingNumber: sample },
              { TrackingNumber: sample },
            ],
          },
        },
      }),
    })
    assert.equal(result.lifecycleMode, 'close_sample')
    assert.equal(new Set(result.labels.map((label) => label.trackingNumber)).size, 1)
    assert.equal(carrierOneOffGroupLifecycleMode({
      provider: 'ups_rest',
      environment: 'sandbox',
      masterTrackingNumber: sample,
      providerShipmentId: sample,
      packageTrackingNumbers: [sample, sample],
    }), 'close_sample')
    assert.throws(
      () => prepareCarrierOneOffGroupVoidRequest({
        runtime: runtime('ups_rest'),
        masterTrackingNumber: sample,
        providerShipmentId: sample,
        packageTrackingNumbers: [sample, sample],
        attemptCorrelationKey: 'group-void:sample',
      }),
      errorWith('CARRIER_ONE_OFF_GROUP_SAMPLE_CLOSE_REQUIRED', false),
    )
  }

  {
    const request = prepared('ups_rest')
    await assert.rejects(
      executeCarrierOneOffGroupShipment({
        runtime: runtime('ups_rest'),
        prepared: request,
      }, {
        fetchImpl: async () => jsonResponse({
          ShipmentResponse: {
            ShipmentResults: {
              ShipmentIdentificationNumber: '1ZDUPLICATE0000001',
              PackageResults: [
                { TrackingNumber: '1ZDUPLICATE0000001' },
                { TrackingNumber: '1ZDUPLICATE0000001' },
              ],
            },
          },
        }),
      }),
      errorWith('CARRIER_PROVIDER_RESPONSE_INVALID', true),
    )
  }

  {
    const fedexRuntime = runtime('fedex_rest', 'production')
    const request = prepareCarrierOneOffGroupVoidRequest({
      runtime: fedexRuntime,
      masterTrackingNumber: 'MASTER-1',
      providerShipmentId: 'MASTER-1',
      packageTrackingNumbers: ['MASTER-1', 'CHILD-2'],
      attemptCorrelationKey: 'group-void:fedex:production',
    })
    let providerBody = ''
    const result = await executeCarrierOneOffGroupVoid({
      runtime: fedexRuntime,
      prepared: request,
    }, {
      fetchImpl: async (_url, init) => {
        providerBody = String(init?.body || '')
        return jsonResponse({ output: { cancelledShipment: true } })
      },
    })
    assert.equal(request.providerMethod, 'PUT')
    assert.equal(
      request.providerEndpoint,
      'https://apis.fedex.com/ship/v1/shipments/cancel',
    )
    assert.equal(request.requestHash, evidenceHash(request.redactedRequest))
    assert.equal(providerBody, JSON.stringify(request.providerBody))
    assert.equal(result.voided, true)
  }

  {
    tokenCalls = 0
    const fedexRuntime = runtime('fedex_rest')
    const request = prepareCarrierOneOffGroupVoidRequest({
      runtime: fedexRuntime,
      masterTrackingNumber: 'MASTER-1',
      providerShipmentId: 'MASTER-1',
      packageTrackingNumbers: ['MASTER-1', 'CHILD-2'],
      attemptCorrelationKey: 'group-void:fedex:sandbox',
    })
    request.providerBody = {
      ...request.providerBody,
      trackingNumber: 'MUTATED',
    }
    let carrierCalls = 0
    await assert.rejects(
      executeCarrierOneOffGroupVoid({ runtime: fedexRuntime, prepared: request }, {
        fetchImpl: async () => {
          carrierCalls += 1
          return jsonResponse({})
        },
      }),
      errorWith('CARRIER_ONE_OFF_GROUP_PREPARED_EVIDENCE_INVALID', false),
    )
    assert.equal(tokenCalls, 0)
    assert.equal(carrierCalls, 0)
  }

  {
    const upsRuntime = runtime('ups_rest', 'production')
    const request = prepareCarrierOneOffGroupVoidRequest({
      runtime: upsRuntime,
      masterTrackingNumber: '1ZMASTER0000000001',
      providerShipmentId: '1ZMASTER0000000001',
      packageTrackingNumbers: ['1ZMASTER0000000001', '1ZCHILD00000000001'],
      attemptCorrelationKey: 'group-void:ups:production',
    })
    for (const packageLevelResults of [
      [],
      [{ TrackingNumber: '1ZMASTER0000000001', Status: { Code: '1' } }],
      [
        { TrackingNumber: '1ZMASTER0000000001', Status: { Code: '1' } },
        { TrackingNumber: '1ZWRONG00000000001', Status: { Code: '1' } },
      ],
    ]) {
      tokenCalls = 0
      await assert.rejects(
        executeCarrierOneOffGroupVoid({ runtime: upsRuntime, prepared: request }, {
          fetchImpl: async () => jsonResponse({
            VoidShipmentResponse: {
              SummaryResult: { Status: { Code: '1' } },
              PackageLevelResults: packageLevelResults,
            },
          }),
        }),
        errorWith('CARRIER_PROVIDER_RESPONSE_INVALID', true),
      )
      assert.equal(tokenCalls, 1)
    }
    const succeeded = await executeCarrierOneOffGroupVoid({
      runtime: upsRuntime,
      prepared: request,
    }, {
      fetchImpl: async () => jsonResponse({
        VoidShipmentResponse: {
          SummaryResult: { Status: { Code: '1' } },
          PackageLevelResults: [
            { TrackingNumber: '1ZCHILD00000000001', Status: { Code: '1' } },
            { TrackingNumber: '1ZMASTER0000000001', Status: { Code: '1' } },
          ],
        },
      }),
    })
    assert.equal(succeeded.voided, true)
  }

  console.log('carrier one-off group shipment adapter tests passed')
}

await run()
