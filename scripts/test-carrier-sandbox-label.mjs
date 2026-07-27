#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
        return {
          CARRIER_SANDBOX_RATE_FIXTURE: fixture,
          carrierSandboxPartyFingerprint: (value) => (
            createHash('sha256').update(JSON.stringify(value)).digest('hex')
          ),
          normalizeCarrierSandboxParty: (value) => ({
            name: String(value.name).trim(),
            line1: String(value.line1).trim(),
            line2: value.line2 ? String(value.line2).trim() : null,
            city: String(value.city).trim(),
            region: String(value.region).trim().toUpperCase(),
            postalCode: String(value.postalCode).trim(),
            countryCode: 'US',
          }),
        }
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function runtime(provider, serviceCode, overrides = {}) {
  return {
    provider,
    environment: 'sandbox',
    credential: {
      accountNumber: secrets.accountNumber,
      clientId: secrets.clientId,
      clientSecret: secrets.clientSecret,
    },
    serviceCode,
    ...overrides,
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
  if (expected.uncertain) {
    assert.match(
      error.redactedResponse?.clientTransactionId || '',
      /^[a-f0-9]{32}$/,
      'Unknown carrier mutations must retain a safe client transaction ID',
    )
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
  carrierSandboxLabelOutputOptions,
  carrierSandboxLabelRequestEvidence,
  createCarrierSandboxLabel,
  voidCarrierSandboxLabel,
} = loadLabelModule()

assert.deepEqual(
  plain(carrierSandboxLabelOutputOptions('ups_rest')),
  [{
    format: 'ZPL',
    mediaSize: 'label_4x6',
    sourceKind: 'provider_native',
    providerImageType: 'ZPL',
    providerStockType: 'HEIGHT_6_WIDTH_4',
  }],
)
assert.deepEqual(
  plain(carrierSandboxLabelOutputOptions('fedex_rest').map((entry) => entry.format)),
  ['ZPL', 'PDF', 'PNG'],
)

const normalizedShipmentFixture = {
  origin: {
    name: 'Account Sender',
    line1: '500 Account Way',
    line2: 'Suite 200',
    city: 'Columbus',
    region: 'OH',
    postalCode: '43215',
    countryCode: 'US',
  },
  destination: {
    name: 'Receiving Team',
    line1: '101 Academy Drive',
    line2: 'Warehouse B',
    city: 'Buzzards Bay',
    region: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  },
  parcel: fixture.parcel,
}
const legacyEvidence = carrierSandboxLabelRequestEvidence('ups_rest', '03')
assert.match(
  legacyEvidence.redactedRequest.shipment.originFingerprint,
  /^[a-f0-9]{64}$/,
)
assert.match(
  legacyEvidence.redactedRequest.shipment.destinationFingerprint,
  /^[a-f0-9]{64}$/,
)
assert.equal(legacyEvidence.redactedRequest.shipment.origin.region, 'OH')
assert.equal(legacyEvidence.redactedRequest.shipment.destination.region, 'MA')
assert.ok(
  !JSON.stringify(legacyEvidence.redactedRequest).includes('101 Jegs Place'),
  'Redacted label evidence must omit the sender street',
)
assert.ok(
  !JSON.stringify(legacyEvidence.redactedRequest).includes('101 Academy Drive'),
  'Redacted label evidence must omit the destination street',
)

const upsZpl = '^XA^FO50,50^FDSANDBOX^FS^XZ'
const upsCreateCalls = []
const upsCreateResult = await createCarrierSandboxLabel(runtime('ups_rest', '03', {
  shipmentFixture: normalizedShipmentFixture,
}), {
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
              GraphicImage: Buffer.from(upsZpl, 'utf8').toString('base64'),
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
assert.deepEqual(
  upsCreateBody.ShipmentRequest.Shipment.ShipFrom.Address.AddressLine,
  ['500 Account Way', 'Suite 200'],
)
assert.deepEqual(
  upsCreateBody.ShipmentRequest.Shipment.ShipTo.Address.AddressLine,
  ['101 Academy Drive', 'Warehouse B'],
)
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
  payloadEncoding: upsCreateResult.payloadEncoding,
}), {
  provider: 'ups_rest',
  trackingNumber: '1ZTRACKING0001',
  providerLabelId: '1ZSHIPMENT0001',
  format: 'ZPL',
  payloadEncoding: 'utf8',
})
assert.equal(upsCreateResult.labelPayload, upsZpl)
assert.equal(upsCreateResult.labelByteLength, Buffer.byteLength(upsZpl, 'utf8'))
assert.equal(
  upsCreateResult.labelContentSha256,
  createHash('sha256').update(upsZpl, 'utf8').digest('hex'),
)
assert.equal(upsCreateResult.evidence.redactedResponse.payloadEncoding, 'utf8')
assert.equal(upsCreateResult.evidence.redactedResponse.labelByteLength, Buffer.byteLength(upsZpl))
assert.equal(
  upsCreateResult.evidence.redactedResponse.labelContentSha256,
  upsCreateResult.labelContentSha256,
)
assert.equal(upsCreateResult.evidence.providerReference, 'ups-create-transaction')
assertEvidenceRedacted(upsCreateResult)

await assert.rejects(
  createCarrierSandboxLabel(runtime('ups_rest', '03', {
    outputFormat: 'PDF',
  })),
  (error) => assertError(error, {
    code: 'CARRIER_LABEL_OUTPUT_UNSUPPORTED',
    status: 409,
    uncertain: false,
  }),
  'UPS PDF must remain unavailable until a provider-native standard Ship output is proven',
)

const fedexZpl = '^XA^PW812^LL1218^FO48,48^FDFEDEX SANDBOX^FS^XZ'
const fedexCreateCalls = []
const fedexCreateResult = await createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND', {
  shipmentFixture: normalizedShipmentFixture,
}), {
  fetchImpl: async (url, init) => {
    fedexCreateCalls.push({ url: String(url), init })
    return jsonResponse({
      accountNumber: secrets.accountNumber,
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'MASTERTRACKING0002',
          pieceResponses: [{
            trackingNumber: 'TRACKING0002',
            packageDocuments: [
              {
                contentType: 'COMMERCIAL_INVOICE',
                docType: 'PDF',
                encodedLabel: Buffer.from('not the label').toString('base64'),
              },
              {
                contentType: 'LABEL',
                docType: 'ZPLII',
                encodedLabel: Buffer.from(fedexZpl, 'utf8').toString('base64'),
              },
            ],
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
assert.deepEqual(
  fedexCreateBody.requestedShipment.shipper.address.streetLines,
  ['500 Account Way', 'Suite 200'],
)
assert.deepEqual(
  fedexCreateBody.requestedShipment.recipients[0].address.streetLines,
  ['101 Academy Drive', 'Warehouse B'],
)
assert.equal(fedexCreateBody.requestedShipment.labelSpecification.imageType, 'ZPLII')
assert.equal(fedexCreateBody.requestedShipment.labelSpecification.labelStockType, 'STOCK_4X6')
assert.equal(fedexCreateBody.requestedShipment.requestedPackageLineItems.length, 1)
assert.deepEqual(plain({
  provider: fedexCreateResult.provider,
  trackingNumber: fedexCreateResult.trackingNumber,
  providerLabelId: fedexCreateResult.providerLabelId,
  format: fedexCreateResult.format,
  payloadEncoding: fedexCreateResult.payloadEncoding,
}), {
  provider: 'fedex_rest',
  trackingNumber: 'TRACKING0002',
  providerLabelId: 'MASTERTRACKING0002',
  format: 'ZPL',
  payloadEncoding: 'utf8',
})
assert.equal(fedexCreateResult.labelPayload, fedexZpl)
assert.equal(fedexCreateResult.labelByteLength, Buffer.byteLength(fedexZpl, 'utf8'))
assert.equal(
  fedexCreateResult.labelContentSha256,
  createHash('sha256').update(fedexZpl, 'utf8').digest('hex'),
)
assert.equal(fedexCreateResult.evidence.redactedRequest.label.format, 'ZPL')
assert.equal(fedexCreateResult.evidence.redactedRequest.label.providerImageType, 'ZPLII')
assert.equal(fedexCreateResult.evidence.redactedRequest.label.mediaSize, 'label_4x6')
assert.equal(fedexCreateResult.evidence.redactedResponse.payloadEncoding, 'utf8')
assert.equal(
  fedexCreateResult.evidence.redactedResponse.labelByteLength,
  Buffer.byteLength(fedexZpl, 'utf8'),
)
assert.equal(
  fedexCreateResult.evidence.redactedResponse.labelContentSha256,
  fedexCreateResult.labelContentSha256,
)
assert.equal(fedexCreateResult.evidence.providerReference, 'fedex-create-transaction')
assertEvidenceRedacted(fedexCreateResult)

const fedexPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'ascii',
)
const fedexPdfCalls = []
const fedexPdfResult = await createCarrierSandboxLabel(
  runtime('fedex_rest', 'FEDEX_GROUND', { outputFormat: 'PDF' }),
  {
    fetchImpl: async (url, init) => {
      fedexPdfCalls.push({ url: String(url), init })
      return jsonResponse({
        output: {
          transactionShipments: [{
            masterTrackingNumber: 'MASTERPDF0003',
            pieceResponses: [{
              trackingNumber: 'TRACKINGPDF0003',
              packageDocuments: [{
                contentType: 'LABEL',
                docType: 'PDF',
                encodedLabel: fedexPdf.toString('base64'),
              }],
            }],
          }],
        },
      })
    },
  },
)
const fedexPdfBody = JSON.parse(fedexPdfCalls[0].init.body)
assert.equal(fedexPdfBody.requestedShipment.labelSpecification.imageType, 'PDF')
assert.equal(fedexPdfBody.requestedShipment.labelSpecification.labelStockType, 'PAPER_4X6')
assert.equal(fedexPdfResult.format, 'PDF')
assert.equal(fedexPdfResult.payloadEncoding, 'base64')
assert.equal(fedexPdfResult.providerImageType, 'PDF')
assert.equal(fedexPdfResult.providerStockType, 'PAPER_4X6')
assert.ok(Buffer.from(fedexPdfResult.labelPayload, 'base64').equals(fedexPdf))
assertEvidenceRedacted(fedexPdfResult)

const fedexPng = Buffer.alloc(48)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  .copy(fedexPng, 0)
fedexPng.writeUInt32BE(13, 8)
fedexPng.write('IHDR', 12, 'ascii')
fedexPng.writeUInt32BE(800, 16)
fedexPng.writeUInt32BE(1200, 20)
fedexPng.write('IEND', 40, 'ascii')
const fedexPngCalls = []
const fedexPngResult = await createCarrierSandboxLabel(
  runtime('fedex_rest', 'FEDEX_GROUND', { outputFormat: 'PNG' }),
  {
    fetchImpl: async (url, init) => {
      fedexPngCalls.push({ url: String(url), init })
      return jsonResponse({
        output: {
          transactionShipments: [{
            masterTrackingNumber: 'MASTERPNG0004',
            pieceResponses: [{
              trackingNumber: 'TRACKINGPNG0004',
              packageDocuments: [{
                contentType: 'LABEL',
                imageType: 'PNG',
                encodedLabel: fedexPng.toString('base64'),
              }],
            }],
          }],
        },
      })
    },
  },
)
const fedexPngBody = JSON.parse(fedexPngCalls[0].init.body)
assert.equal(fedexPngBody.requestedShipment.labelSpecification.imageType, 'PNG')
assert.equal(fedexPngBody.requestedShipment.labelSpecification.labelStockType, 'PAPER_4X6')
assert.equal(fedexPngResult.format, 'PNG')
assert.equal(fedexPngResult.payloadEncoding, 'base64')
assert.equal(fedexPngResult.providerImageType, 'PNG')
assert.equal(fedexPngResult.providerStockType, 'PAPER_4X6')
assert.ok(Buffer.from(fedexPngResult.labelPayload, 'base64').equals(fedexPng))
assertEvidenceRedacted(fedexPngResult)

await assert.rejects(
  createCarrierSandboxLabel(runtime('ups_rest', '03'), {
    fetchImpl: async () => jsonResponse({
      ShipmentResponse: {
        ShipmentResults: {
          ShipmentIdentificationNumber: '1ZINVALIDZPL',
          PackageResults: [{
            TrackingNumber: '1ZINVALIDZPL',
            ShippingLabel: {
              ImageFormat: { Code: 'ZPL' },
              GraphicImage: Buffer.from('^XA^FO20,20^FDMISSING END', 'utf8').toString('base64'),
            },
          }],
        },
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'UPS label bytes must contain a complete ZPL ^XA/^XZ envelope',
)

await assert.rejects(
  createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
    fetchImpl: async () => jsonResponse({
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'INVALIDZPL',
          pieceResponses: [{
            trackingNumber: 'INVALIDZPL',
            packageDocuments: [{
              contentType: 'LABEL',
              docType: 'ZPLII',
              encodedLabel: Buffer.from(
                '^XA^FO20,20^FDMISSING END',
                'utf8',
              ).toString('base64'),
            }],
          }],
        }],
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'FedEx label bytes must contain a complete ZPL ^XA/^XZ envelope',
)

await assert.rejects(
  createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
    fetchImpl: async () => jsonResponse({
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'INVALIDBASE64',
          pieceResponses: [{
            trackingNumber: 'INVALIDBASE64',
            packageDocuments: [{
              contentType: 'LABEL',
              docType: 'ZPLII',
              encodedLabel: 'not*base64',
            }],
          }],
        }],
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'Malformed provider base64 must be rejected before persistence',
)

await assert.rejects(
  createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
    fetchImpl: async () => jsonResponse({
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'WRONGFORMAT',
          pieceResponses: [{
            trackingNumber: 'WRONGFORMAT',
            packageDocuments: [{
              contentType: 'LABEL',
              docType: 'PDF',
              encodedLabel: Buffer.from(fedexZpl, 'utf8').toString('base64'),
            }],
          }],
        }],
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'FedEx must return the requested native thermal document format',
)

await assert.rejects(
  createCarrierSandboxLabel(runtime('fedex_rest', 'FEDEX_GROUND'), {
    fetchImpl: async () => jsonResponse({
      output: {
        transactionShipments: [{
          masterTrackingNumber: 'CONTROLBYTE',
          pieceResponses: [{
            trackingNumber: 'CONTROLBYTE',
            packageDocuments: [{
              contentType: 'LABEL',
              imageType: 'ZPL',
              encodedLabel: Buffer.from(
                '^XA^FO20,20^FDINVALID\u0000BYTE^FS^XZ',
                'utf8',
              ).toString('base64'),
            }],
          }],
        }],
      },
    }),
  }),
  (error) => assertError(error, {
    code: 'CARRIER_PROVIDER_RESPONSE_INVALID',
    status: 502,
    uncertain: true,
  }),
  'FedEx ZPL must reject unsafe control bytes',
)

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

await assert.rejects(
  voidCarrierSandboxLabel({
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
  }),
  (error) => assertError(error, {
    code: 'CARRIER_SANDBOX_LABEL_VOID_REJECTED',
    status: 409,
    uncertain: false,
  }),
  'A provider not-found response must not be recorded as a confirmed void',
)

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
      errors: [{
        code: 'INVALID_ACCOUNT',
        message: `Rejected ${secrets.accountNumber} at a protected address`,
      }],
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
