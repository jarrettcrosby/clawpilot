#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function recorded(path) {
  return JSON.parse(read(`scripts/fixtures/carrier-rates/${path}`))
}

function loadFoundation() {
  const path = 'app_src/lib/integrations/carrierWholeShipmentRateFoundation.ts'
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
    BigInt,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    RegExp,
    Set,
    String,
    console,
    exports: module.exports,
    module,
    require: nodeRequire,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

function clone(value) {
  return plain(value)
}

function assertDeepFrozen(value, label = 'value') {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true, `${label} must be frozen`)
  for (const [key, nested] of Object.entries(value)) {
    assertDeepFrozen(nested, `${label}.${key}`)
  }
}

const foundationSource = read(
  'app_src/lib/integrations/carrierWholeShipmentRateFoundation.ts',
)
assert.doesNotMatch(
  foundationSource,
  /\bfetch\s*\(/,
  'The foundation must not make a network call',
)
assert.doesNotMatch(
  foundationSource,
  /requestCarrierAccessToken/,
  'The foundation must not acquire credentials',
)
assert.doesNotMatch(
  foundationSource,
  /carrierSandboxRate/,
  'The production foundation must not alter or depend on sandbox execution',
)
assert.doesNotMatch(
  foundationSource,
  /carrierSandboxLabel|carrierRateTestLabelActions|\/ship\/v1\/shipments/,
  'The rate-only foundation must not acquire a label or shipping surface',
)
assert.doesNotMatch(
  foundationSource,
  /localeCompare/,
  'Evidence ordering must not depend on runtime locale',
)
assert.deepEqual(
  [...foundationSource.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)]
    .map((match) => match[1]),
  ['node:crypto'],
  'The pure foundation may import only deterministic local crypto support',
)

const foundation = loadFoundation()
assert.deepEqual(
  Object.keys(foundation).sort(),
  [
    'CARRIER_WHOLE_SHIPMENT_RATE_ENDPOINTS',
    'FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES',
    'MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES',
    'UPS_WHOLE_SHIPMENT_PACKAGING_TYPES',
    'carrierWholeShipmentRateAddressFingerprints',
    'carrierWholeShipmentRateDestinationFingerprint',
    'carrierWholeShipmentRateEndpoint',
    'parseCarrierWholeShipmentRateResponse',
    'prepareCarrierWholeShipmentRateRequest',
    'sealPreparedCarrierWholeShipmentRateRequest',
  ],
  'The runtime API must expose only pure rate preparation and parsing',
)

const {
  FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES,
  MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES,
  UPS_WHOLE_SHIPMENT_PACKAGING_TYPES,
  carrierWholeShipmentRateAddressFingerprints,
  carrierWholeShipmentRateDestinationFingerprint,
  carrierWholeShipmentRateEndpoint,
  parseCarrierWholeShipmentRateResponse,
  prepareCarrierWholeShipmentRateRequest,
  sealPreparedCarrierWholeShipmentRateRequest,
} = foundation

assert.equal(MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES, 50)
assert.deepEqual(plain(UPS_WHOLE_SHIPMENT_PACKAGING_TYPES), {
  '01': 'Letter',
  '02': 'Customer supplied package',
  '03': 'Tube',
  '04': 'PAK',
  '21': 'Express box',
  '24': '25KG box',
  '25': '10KG box',
  '2a': 'Small express box',
  '2b': 'Medium express box',
  '2c': 'Large express box',
})
assert.deepEqual(plain(FEDEX_WHOLE_SHIPMENT_PACKAGING_TYPES), {
  YOUR_PACKAGING: 'Your packaging',
  FEDEX_ENVELOPE: 'Envelope',
  FEDEX_BOX: 'Box',
  FEDEX_EXTRA_SMALL_BOX: 'Extra small box',
  FEDEX_SMALL_BOX: 'Small box',
  FEDEX_MEDIUM_BOX: 'Medium box',
  FEDEX_LARGE_BOX: 'Large box',
  FEDEX_EXTRA_LARGE_BOX: 'Extra large box',
  FEDEX_10KG_BOX: '10KG box',
  FEDEX_25KG_BOX: '25KG box',
  FEDEX_PAK: 'PAK',
  FEDEX_TUBE: 'Tube',
})
assert.equal(
  carrierWholeShipmentRateEndpoint('ups_rest', 'sandbox'),
  'https://wwwcie.ups.com/api/rating/v2409/Shop',
)
assert.equal(
  carrierWholeShipmentRateEndpoint('ups_rest', 'production'),
  'https://onlinetools.ups.com/api/rating/v2409/Shop',
)
assert.equal(
  carrierWholeShipmentRateEndpoint('fedex_rest', 'sandbox'),
  'https://apis-sandbox.fedex.com/rate/v1/rates/quotes',
)
assert.equal(
  carrierWholeShipmentRateEndpoint('fedex_rest', 'production'),
  'https://apis.fedex.com/rate/v1/rates/quotes',
)

const ids = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  carrierAccountId: '22222222-2222-4222-8222-222222222222',
  integrationAccountId: '33333333-3333-4333-8333-333333333333',
}
const accountNumber = 'ACCOUNT-9012'
const credentialFingerprint = 'a'.repeat(64)
const accountNumberFingerprint = 'b'.repeat(64)
const base = {
  binding: {
    ...ids,
    credentialRevision: 7,
    credentialFingerprint,
    accountNumber,
    accountNumberFingerprint,
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
      packageCode: '02',
      length: 11,
      width: 9,
      height: 7,
      dimensionUnit: 'IN',
      weight: 10.5,
      weightUnit: 'LB',
    },
    {
      description: '20lb bulk case',
      packageCode: '02',
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
    payerAccountNumberFingerprint: accountNumberFingerprint,
    payerPostalCode: '68128',
    payerCountryCode: 'US',
  },
  expectedCurrency: 'USD',
  fedexPickupType: null,
}

assert.equal(
  carrierWholeShipmentRateDestinationFingerprint(base.destination),
  carrierWholeShipmentRateAddressFingerprints({
    origin: base.origin,
    destination: base.destination,
  }).destinationFingerprint,
  'the exported destination helper must match prepared production evidence',
)

const upsProduction = prepareCarrierWholeShipmentRateRequest(base)
const upsProductionAgain = prepareCarrierWholeShipmentRateRequest(clone(base))
const upsSeal = sealPreparedCarrierWholeShipmentRateRequest(upsProduction)
const expectedBinding = {
  origin: base.origin,
  destination: base.destination,
  matchesAccountNumber: (candidate) => candidate === accountNumber,
}
const boundUpsSeal = sealPreparedCarrierWholeShipmentRateRequest(
  upsProduction,
  expectedBinding,
)
assert.equal(upsProduction.accessMode, 'rate_read_only')
assert.equal(upsProduction.providerMutationCount, 0)
assert.equal(upsProduction.environment, 'production')
assert.equal(upsProduction.endpointVersion, 'ups-rating-v2409')
assert.equal(upsProduction.requestHash, upsProductionAgain.requestHash)
assert.equal(upsSeal.requestHash, upsProduction.requestHash)
assert.equal(boundUpsSeal.requestHash, upsProduction.requestHash)
assert.equal(upsSeal.redactedRequest.packageCount, 2)
assert.equal(upsSeal.body, undefined)
assertDeepFrozen(upsSeal, 'sealed UPS request evidence')
assert.deepEqual(
  plain(carrierWholeShipmentRateAddressFingerprints({
    origin: base.origin,
    destination: base.destination,
  })),
  {
    originFingerprint: upsSeal.redactedRequest.shipment.originFingerprint,
    destinationFingerprint:
      upsSeal.redactedRequest.shipment.destinationFingerprint,
  },
)
assert.deepEqual(plain(upsProduction.headers), plain(upsProductionAgain.headers))
assert.match(upsProduction.requestHash, /^[a-f0-9]{64}$/)
assert.match(upsProduction.headers.transId, /^[a-f0-9-]{36}$/)
assert.equal(upsProduction.headers.authorization, undefined)
assertDeepFrozen(upsProduction, 'prepared UPS request')
assert.throws(
  () => { upsProduction.redactedRequest.packageCount = 49 },
  TypeError,
)

const upsBody = upsProduction.body.RateRequest
assert.equal(upsBody.Shipment.NumOfPieces, '2')
assert.equal(upsBody.Shipment.Package.length, 2)
assert.equal(upsBody.Shipment.Package[0].Description, 'AG12V2 case pack')
assert.equal(upsBody.Shipment.Package[1].Description, '20lb bulk case')
assert.equal(upsBody.Shipment.Shipper.ShipperNumber, accountNumber)
assert.equal(
  upsBody.Shipment.PaymentDetails.ShipmentCharge[0]
    .BillShipper.AccountNumber,
  accountNumber,
)
assert.equal(
  upsBody.Shipment.ShipTo.Address.ResidentialAddressIndicator,
  '',
)
assert.equal(
  upsBody.Shipment.ShipFrom.Address.ResidentialAddressIndicator,
  undefined,
)

const evidence = upsProduction.redactedRequest
assert.equal(evidence.environment, 'production')
assert.equal(evidence.endpoint, upsProduction.endpoint)
assert.equal(evidence.packageCount, 2)
assert.equal(evidence.rateScope, 'multi_package_shipment')
assert.equal(evidence.binding.organizationId, ids.organizationId)
assert.equal(evidence.binding.carrierAccountId, ids.carrierAccountId)
assert.equal(evidence.binding.integrationAccountId, ids.integrationAccountId)
assert.equal(evidence.binding.credentialRevision, 7)
assert.equal(evidence.binding.credentialFingerprint, credentialFingerprint)
assert.equal(evidence.binding.accountNumberFingerprint, accountNumberFingerprint)
assert.equal(evidence.billing.relationship, 'sender')
assert.equal(evidence.billing.providerMapping, 'ups_payment_details')
assert.equal(
  evidence.billing.payerAccountNumberFingerprint,
  accountNumberFingerprint,
)
assert.equal(evidence.expectedCurrency, 'USD')
assert.equal(evidence.shipment.destination.residential, true)
assert.equal(evidence.shipment.fedexPickupType, null)
assert.ok(!JSON.stringify(evidence).includes(accountNumber))
assert.ok(!JSON.stringify(evidence).includes('4025550100'))

function variant(mutator) {
  const input = clone(base)
  mutator(input)
  return prepareCarrierWholeShipmentRateRequest(input)
}

const hashVariants = [
  variant((input) => { input.binding.environment = 'sandbox' }),
  variant((input) => { input.binding.credentialRevision = 8 }),
  variant((input) => { input.binding.credentialFingerprint = 'b'.repeat(64) }),
  variant((input) => {
    input.binding.carrierAccountId = '44444444-4444-4444-8444-444444444444'
  }),
  variant((input) => {
    input.binding.accountNumber = 'ACCOUNT-OTHER'
    input.binding.accountNumberFingerprint = 'f'.repeat(64)
    input.billing.payerAccountNumber = 'ACCOUNT-OTHER'
    input.billing.payerAccountNumberFingerprint = 'f'.repeat(64)
  }),
  variant((input) => { input.destination.postalCode = '06103' }),
  variant((input) => { input.parcels.reverse() }),
]
for (const prepared of hashVariants) {
  assert.notEqual(
    prepared.requestHash,
    upsProduction.requestHash,
    'The request hash must bind environment, account, credential, and package order',
  )
}
assert.equal(
  hashVariants[0].endpoint,
  'https://wwwcie.ups.com/api/rating/v2409/Shop',
)
assert.equal(hashVariants[0].redactedRequest.environment, 'sandbox')

const fedexInput = clone(base)
fedexInput.binding.provider = 'fedex_rest'
for (const parcel of fedexInput.parcels) parcel.packageCode = 'YOUR_PACKAGING'
fedexInput.fedexPickupType = 'USE_SCHEDULED_PICKUP'
const fedexProduction = prepareCarrierWholeShipmentRateRequest(fedexInput)
const boundFedexSeal = sealPreparedCarrierWholeShipmentRateRequest(
  fedexProduction,
  expectedBinding,
)
assert.equal(boundFedexSeal.requestHash, fedexProduction.requestHash)
assert.equal(fedexProduction.environment, 'production')
assert.equal(fedexProduction.endpointVersion, 'fedex-rate-v1')
assert.equal(fedexProduction.headers['x-locale'], 'en_US')
assert.equal(fedexProduction.headers.authorization, undefined)
assert.equal(fedexProduction.body.accountNumber.value, accountNumber)
assert.equal(
  fedexProduction.body.requestedShipment.shipper.contact.phoneNumber,
  '4025550100',
)
assert.equal(
  fedexProduction.body.requestedShipment.shipper.address.residential,
  false,
)
assert.equal(
  fedexProduction.body.requestedShipment.recipient.address.residential,
  true,
)
assert.equal(
  fedexProduction.body.requestedShipment.pickupType,
  'USE_SCHEDULED_PICKUP',
)
assert.equal(fedexProduction.body.requestedShipment.totalPackageCount, 2)
assert.deepEqual(
  plain(
    fedexProduction.body.requestedShipment.requestedPackageLineItems
      .map((item) => item.sequenceNumber),
  ),
  [1, 2],
)
assert.equal(
  fedexProduction.body.requestedShipment.requestedPackageLineItems[1]
    .itemDescription,
  '20lb bulk case',
)
assertDeepFrozen(fedexProduction, 'prepared FedEx request')

const unknownAddressInput = clone(base)
unknownAddressInput.origin.phone = null
unknownAddressInput.origin.residential = null
unknownAddressInput.destination.residential = null
const unknownUps = prepareCarrierWholeShipmentRateRequest(
  unknownAddressInput,
)
const unknownBinding = {
  origin: unknownAddressInput.origin,
  destination: unknownAddressInput.destination,
  matchesAccountNumber: (candidate) => candidate === accountNumber,
}
assert.equal(
  unknownUps.body.RateRequest.Shipment.ShipFrom.Address
    .ResidentialAddressIndicator,
  undefined,
)
assert.equal(
  unknownUps.body.RateRequest.Shipment.ShipTo.Address
    .ResidentialAddressIndicator,
  undefined,
)
assert.equal(unknownUps.redactedRequest.shipment.origin.residential, null)
assert.equal(
  unknownUps.redactedRequest.shipment.destination.residential,
  null,
)
assert.equal(
  sealPreparedCarrierWholeShipmentRateRequest(
    unknownUps,
    unknownBinding,
  ).requestHash,
  unknownUps.requestHash,
)

const falseAddressInput = clone(unknownAddressInput)
falseAddressInput.origin.residential = false
falseAddressInput.destination.residential = false
const falseUps = prepareCarrierWholeShipmentRateRequest(falseAddressInput)
assert.deepEqual(
  plain(unknownUps.body),
  plain(falseUps.body),
  'UPS omits the residential indicator for both false and unknown',
)
assert.notEqual(
  unknownUps.requestHash,
  falseUps.requestHash,
  'sealed evidence must preserve unknown separately from false',
)

const unknownFedexInput = clone(unknownAddressInput)
unknownFedexInput.binding.provider = 'fedex_rest'
for (const parcel of unknownFedexInput.parcels) {
  parcel.packageCode = 'YOUR_PACKAGING'
}
unknownFedexInput.fedexPickupType = 'USE_SCHEDULED_PICKUP'
const unknownFedex = prepareCarrierWholeShipmentRateRequest(
  unknownFedexInput,
)
const unknownFedexShipment = unknownFedex.body.requestedShipment
assert.equal(
  unknownFedexShipment.shipper.contact.phoneNumber,
  undefined,
)
assert.equal(
  unknownFedexShipment.shipper.address.residential,
  undefined,
)
assert.equal(
  unknownFedexShipment.recipient.address.residential,
  undefined,
)
assert.equal(unknownFedex.redactedRequest.shipment.origin.residential, null)
assert.equal(
  unknownFedex.redactedRequest.shipment.destination.residential,
  null,
)
assert.equal(
  sealPreparedCarrierWholeShipmentRateRequest(
    unknownFedex,
    {
      origin: unknownFedexInput.origin,
      destination: unknownFedexInput.destination,
      matchesAccountNumber: (candidate) => candidate === accountNumber,
    },
  ).requestHash,
  unknownFedex.requestHash,
)

const inventedUpsResidential = clone(unknownUps)
inventedUpsResidential.body.RateRequest.Shipment.ShipTo.Address
  .ResidentialAddressIndicator = ''
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(
    inventedUpsResidential,
  ),
  /integrity check failed/,
)
const inventedFedexResidential = clone(unknownFedex)
inventedFedexResidential.body.requestedShipment.recipient.address.residential =
  false
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(
    inventedFedexResidential,
  ),
  /integrity check failed/,
)

const upsRecipientInput = clone(base)
upsRecipientInput.billing = {
  relationship: 'recipient',
  payerAccountNumber: 'RECIPIENT-44',
  payerAccountNumberFingerprint: 'c'.repeat(64),
  payerPostalCode: base.destination.postalCode,
  payerCountryCode: 'US',
}
const upsRecipient = prepareCarrierWholeShipmentRateRequest(upsRecipientInput)
assert.deepEqual(
  plain(
    upsRecipient.body.RateRequest.Shipment.PaymentDetails.ShipmentCharge[0]
      .BillReceiver,
  ),
  {
    AccountNumber: 'RECIPIENT-44',
    Address: { PostalCode: '06611', CountryCode: 'US' },
  },
)

const upsThirdPartyInput = clone(base)
upsThirdPartyInput.billing = {
  relationship: 'third_party',
  payerAccountNumber: 'THIRD-PARTY-55',
  payerAccountNumberFingerprint: 'd'.repeat(64),
  payerPostalCode: '06103',
  payerCountryCode: 'US',
}
const upsThirdParty = prepareCarrierWholeShipmentRateRequest(upsThirdPartyInput)
assert.equal(
  upsThirdParty.body.RateRequest.Shipment.PaymentDetails.ShipmentCharge[0]
    .BillThirdParty.AccountNumber,
  'THIRD-PARTY-55',
)

const fedexThirdPartyInput = clone(upsThirdPartyInput)
fedexThirdPartyInput.binding.provider = 'fedex_rest'
for (const parcel of fedexThirdPartyInput.parcels) {
  parcel.packageCode = 'YOUR_PACKAGING'
}
fedexThirdPartyInput.fedexPickupType = 'CONTACT_FEDEX_TO_SCHEDULE'
const fedexThirdParty = prepareCarrierWholeShipmentRateRequest(
  fedexThirdPartyInput,
)
assert.equal(fedexThirdParty.body.accountNumber.value, 'THIRD-PARTY-55')
assert.equal(
  fedexThirdParty.redactedRequest.billing.relationship,
  'third_party',
)
assert.equal(
  fedexThirdParty.redactedRequest.billing.providerMapping,
  'fedex_rate_account_number',
)
assert.ok(
  !JSON.stringify(fedexThirdParty.redactedRequest).includes('THIRD-PARTY-55'),
)

const upsResult = parseCarrierWholeShipmentRateResponse(upsProduction, {
  payload: recorded('ups-whole-shipment-recorded.json'),
  providerReference: 'recorded-ups-rate-001',
  requestedAt: '2026-07-31T13:00:00.000Z',
  completedAt: '2026-07-31T13:00:01.250Z',
})
assert.equal(upsResult.environment, 'production')
assert.equal(upsResult.expectedCurrency, 'USD')
assert.equal(upsResult.packageCount, 2)
assert.equal(upsResult.rates.length, 2)
assert.deepEqual(plain(upsResult.rates[0]), {
  serviceCode: '03',
  serviceName: 'UPS Ground',
  amount: '21.45',
  currency: 'USD',
  rateType: 'NEGOTIATED',
  transitDays: 3,
  deliveryDate: '2026-08-03',
})
assert.equal(upsResult.rates[1].rateType, 'PUBLISHED')
assert.equal(upsResult.evidence.requestHash, upsProduction.requestHash)
assert.equal(upsResult.evidence.providerReference, 'recorded-ups-rate-001')
assert.match(upsResult.evidence.providerPayloadHash, /^[a-f0-9]{64}$/)
assert.equal(upsResult.evidence.redactedResponse.providerMutationCount, 0)
assert.equal(upsResult.evidence.redactedResponse.environment, 'production')
assert.equal(upsResult.evidence.redactedResponse.endpoint, upsProduction.endpoint)
assert.equal(upsResult.evidence.redactedResponse.rateCount, 2)
assert.ok(!JSON.stringify(upsResult.evidence).includes(accountNumber))
assertDeepFrozen(upsResult, 'parsed UPS response')

const fedexResult = parseCarrierWholeShipmentRateResponse(fedexProduction, {
  payload: recorded('fedex-whole-shipment-recorded.json'),
  providerReference: 'recorded-fedex-rate-001',
  requestedAt: '2026-07-31T13:00:00Z',
  completedAt: '2026-07-31T13:00:02Z',
})
assert.equal(fedexResult.rates.length, 2)
assert.equal(fedexResult.rates[0].serviceCode, 'FEDEX_GROUND')
assert.equal(fedexResult.rates[0].amount, '19.62')
assert.equal(fedexResult.rates[0].rateType, 'ACCOUNT')
assert.equal(fedexResult.rates[1].serviceCode, 'FEDEX_2_DAY')
assert.equal(fedexResult.rates[1].amount, '47.80')
assert.equal(fedexResult.rates[1].transitDays, 2)
assert.equal(fedexResult.evidence.redactedResponse.environment, 'production')
assert.equal(
  fedexResult.evidence.redactedRequest.binding.credentialRevision,
  7,
)
assertDeepFrozen(fedexResult, 'parsed FedEx response')

assert.throws(
  () => carrierWholeShipmentRateEndpoint('toString', 'production'),
  /provider is not supported/,
)

assert.throws(
  () => prepareCarrierWholeShipmentRateRequest({
    ...clone(base),
    parcels: Array.from(
      { length: MAX_CARRIER_WHOLE_SHIPMENT_RATE_PACKAGES + 1 },
      () => clone(base.parcels[0]),
    ),
  }),
  /requires 1-50 ordered packages/,
)
assert.throws(
  () => variant((input) => { input.binding.credentialRevision = 0 }),
  /positive integer/,
)
assert.throws(
  () => variant((input) => { input.binding.credentialFingerprint = 'unsafe' }),
  /SHA-256 fingerprint/,
)
assert.throws(
  () => variant((input) => { input.binding.carrierAccountId = 'not-a-uuid' }),
  /canonical UUID/,
)
assert.throws(
  () => variant((input) => { input.binding.accountNumberFingerprint = 'unsafe' }),
  /account-number fingerprint must be a SHA-256 fingerprint/,
)
assert.throws(
  () => variant((input) => { input.origin.phone = '555' }),
  /ten-digit US phone number/,
)
assert.throws(
  () => variant((input) => { delete input.destination.residential }),
  /residential classification must be true or false/,
)
assert.throws(
  () => variant((input) => { input.expectedCurrency = 'USX' }),
  /requires USD currency/,
)
assert.throws(
  () => variant((input) => { input.fedexPickupType = 'USE_SCHEDULED_PICKUP' }),
  /must be null for UPS rating/,
)
assert.throws(
  () => {
    const input = clone(fedexInput)
    input.fedexPickupType = null
    prepareCarrierWholeShipmentRateRequest(input)
  },
  /must be explicitly configured/,
)
assert.throws(
  () => variant((input) => {
    input.billing.payerAccountNumberFingerprint = 'e'.repeat(64)
  }),
  /Sender billing must use the bound carrier account/,
)
assert.throws(
  () => {
    const input = clone(upsRecipientInput)
    input.billing.payerPostalCode = '06103'
    prepareCarrierWholeShipmentRateRequest(input)
  },
  /Recipient billing address must match the bound destination/,
)
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(
    { ...upsProduction, endpoint: fedexProduction.endpoint },
    {
      payload: recorded('ups-whole-shipment-recorded.json'),
      requestedAt: '2026-07-31T13:00:00Z',
      completedAt: '2026-07-31T13:00:01Z',
    },
  ),
  /integrity check failed/,
)

const tamperedBody = clone(upsProduction)
tamperedBody.body.RateRequest.Shipment.Shipper.ShipperNumber = 'ALTERED-ACCOUNT'
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(tamperedBody),
  /integrity check failed/,
)

const tamperedHeaders = clone(upsProduction)
tamperedHeaders.headers.authorization = 'Bearer must-not-persist'
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(tamperedHeaders),
  /integrity check failed/,
)

const wrongExpectedOrigin = clone(base)
wrongExpectedOrigin.origin.line1 = '7001 Different Origin Street'
const wrongOriginRequest = prepareCarrierWholeShipmentRateRequest(
  wrongExpectedOrigin,
)
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(
    wrongOriginRequest,
    expectedBinding,
  ),
  /integrity check failed/,
)

const falselyClaimedAccount = clone(base)
falselyClaimedAccount.binding.accountNumber = 'UNBOUND-ACCOUNT-77'
falselyClaimedAccount.billing.payerAccountNumber = 'UNBOUND-ACCOUNT-77'
const falselyClaimedAccountRequest = prepareCarrierWholeShipmentRateRequest(
  falselyClaimedAccount,
)
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(
    falselyClaimedAccountRequest,
    expectedBinding,
  ),
  /integrity check failed/,
)

const falselyClaimedFedexAccount = clone(falselyClaimedAccount)
falselyClaimedFedexAccount.binding.provider = 'fedex_rest'
for (const parcel of falselyClaimedFedexAccount.parcels) {
  parcel.packageCode = 'YOUR_PACKAGING'
}
falselyClaimedFedexAccount.fedexPickupType = 'USE_SCHEDULED_PICKUP'
assert.throws(
  () => sealPreparedCarrierWholeShipmentRateRequest(
    prepareCarrierWholeShipmentRateRequest(falselyClaimedFedexAccount),
    expectedBinding,
  ),
  /integrity check failed/,
)
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(tamperedBody, {
    payload: recorded('ups-whole-shipment-recorded.json'),
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /integrity check failed/,
)

const tamperedEvidence = clone(upsProduction)
tamperedEvidence.redactedRequest.packageCount = 49
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(tamperedEvidence, {
    payload: recorded('ups-whole-shipment-recorded.json'),
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /integrity check failed/,
)

const malformedFedexRateType = recorded('fedex-whole-shipment-recorded.json')
malformedFedexRateType.output.rateReplyDetails[0].ratedShipmentDetails = [{
  rateType: 'ACCOUNT_PACKAGE',
  totalNetCharge: '19.62',
  currency: 'USD',
}]
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(fedexProduction, {
    payload: malformedFedexRateType,
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /requested ACCOUNT rate type/,
)

const missingFedexService = recorded('fedex-whole-shipment-recorded.json')
delete missingFedexService.output.rateReplyDetails[0].serviceType
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(fedexProduction, {
    payload: missingFedexService,
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /missing a usable service code/,
)

const wrongUpsCurrency = recorded('ups-whole-shipment-recorded.json')
wrongUpsCurrency.RateResponse.RatedShipment[0]
  .NegotiatedRateCharges.TotalCharge.CurrencyCode = 'CAD'
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(upsProduction, {
    payload: wrongUpsCurrency,
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /currency must match expected USD/,
)

const nonIsoFedexCurrency = recorded('fedex-whole-shipment-recorded.json')
nonIsoFedexCurrency.output.rateReplyDetails[0]
  .ratedShipmentDetails[2].currency = 'US_DOLLARS'
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(fedexProduction, {
    payload: nonIsoFedexCurrency,
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /currency must match expected USD/,
)

const invalidUpsDate = recorded('ups-whole-shipment-recorded.json')
invalidUpsDate.RateResponse.RatedShipment[0]
  .TimeInTransit.ServiceSummary.EstimatedArrival.Arrival.Date = '20260231'
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(upsProduction, {
    payload: invalidUpsDate,
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /calendar-valid YYYY-MM-DD date/,
)
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(upsProduction, {
    payload: { RateResponse: { RatedShipment: [] } },
    requestedAt: '2026-07-31T13:00:00Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /did not contain a usable rate/,
)
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(upsProduction, {
    payload: recorded('ups-whole-shipment-recorded.json'),
    requestedAt: '2026-07-31T13:00:02Z',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /cannot precede/,
)
assert.throws(
  () => parseCarrierWholeShipmentRateResponse(upsProduction, {
    payload: recorded('ups-whole-shipment-recorded.json'),
    requestedAt: '07/31/2026 13:00:00',
    completedAt: '2026-07-31T13:00:01Z',
  }),
  /ISO-8601 instant/,
)

console.log('Carrier whole-shipment rate foundation contracts passed')
