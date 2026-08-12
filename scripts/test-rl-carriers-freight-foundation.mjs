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
const foundationPath =
  'app_src/lib/integrations/rlCarriersFreightFoundation.ts'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadFoundation() {
  const output = ts.transpileModule(read(foundationPath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: foundationPath,
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
  vm.runInNewContext(output, sandbox, { filename: foundationPath })
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

function variant(value, mutate) {
  const copy = clone(value)
  mutate(copy)
  return copy
}

function captureThrown(action) {
  let captured = null
  try {
    action()
  } catch (error) {
    captured = error
  }
  assert.ok(captured, 'expected action to throw')
  return captured
}

const source = read(foundationPath)
assert.doesNotMatch(source, /\bfetch\s*\(|\baxios\b|node:https|node:http/)
assert.doesNotMatch(source, /process\.env/)
assert.doesNotMatch(source, /\bapiKey\b|\bauthorization\b|\bpassword\b|\bclientSecret\b/i)
assert.doesNotMatch(source, /DigitalCouncil|CancelPickup|PrintBOL|PrintShippingLabels/)
assert.doesNotMatch(source, /\bCOD\b|codAmount|billOfLading\.void/i)
assert.deepEqual(
  [...source.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)]
    .map((match) => match[1]),
  ['node:crypto'],
)

const foundation = loadFoundation()
assert.deepEqual(
  Object.keys(foundation).sort(),
  [
    'RL_CARRIERS_EXECUTING_CARRIER',
    'RL_CARRIERS_FREIGHT_ENDPOINTS',
    'RL_CARRIERS_FREIGHT_PROVIDER',
    'RlCarriersPartialMutationOutcomeError',
    'parseRlCarriersBillOfLadingResponse',
    'parseRlCarriersQuotedPickupResponse',
    'parseRlCarriersRateQuoteResponse',
    'prepareRlCarriersBillOfLadingRequest',
    'prepareRlCarriersQuotedPickupRequest',
    'prepareRlCarriersRateQuoteRequest',
    'sealPreparedRlCarriersFreightRequest',
  ],
)

const {
  RL_CARRIERS_EXECUTING_CARRIER,
  RL_CARRIERS_FREIGHT_ENDPOINTS,
  RL_CARRIERS_FREIGHT_PROVIDER,
  RlCarriersPartialMutationOutcomeError,
  parseRlCarriersBillOfLadingResponse,
  parseRlCarriersQuotedPickupResponse,
  parseRlCarriersRateQuoteResponse,
  prepareRlCarriersBillOfLadingRequest,
  prepareRlCarriersQuotedPickupRequest,
  prepareRlCarriersRateQuoteRequest,
  sealPreparedRlCarriersFreightRequest,
} = foundation

assert.equal(RL_CARRIERS_FREIGHT_PROVIDER, 'rl_carriers')
assert.deepEqual(plain(RL_CARRIERS_EXECUTING_CARRIER), {
  code: 'RL_CARRIERS',
  name: 'R+L Carriers',
})
assert.deepEqual(plain(RL_CARRIERS_FREIGHT_ENDPOINTS), {
  servicePoint: 'https://api.rlc.com/ServicePoint',
  rateQuote: 'https://api.rlc.com/RateQuote',
  billOfLading: 'https://api.rlc.com/BillOfLading',
  pickupRequest: 'https://api.rlc.com/PickupRequest',
})

const origin = {
  city: 'Delaware',
  stateOrProvince: 'OH',
  zipOrPostalCode: '43015',
  countryCode: 'USA',
}
const destination = {
  city: 'Boston',
  stateOrProvince: 'MA',
  zipOrPostalCode: '02215',
  countryCode: 'USA',
}
const shipper = {
  companyName: 'Foundation Shipper LLC',
  addressLine1: '1250 Warehouse Avenue',
  addressLine2: 'Dock 4',
  phoneNumber: '(614) 555-0188',
  emailAddress: 'shipping@example.test',
  ...origin,
}
const consignee = {
  companyName: 'Foundation Consignee Inc',
  attention: 'Receiving Team',
  addressLine1: '90 Distribution Way',
  addressLine2: null,
  phoneNumber: '617-555-0114',
  emailAddress: 'receiving@example.test',
  ...destination,
}
const selectedQuoteNumber = '88973391'
const credentialVersion = 7
const credentialFingerprint = 'a'.repeat(64)
const rateAccessorials = ['OriginLiftgate', 'InsidePickup']

const rateInput = {
  credentialVersion,
  credentialFingerprint,
  pickupDate: '2026-08-14',
  origin,
  destination,
  items: [
    {
      freightClass: '60',
      weightLb: 500,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 45,
    },
    {
      freightClass: 70,
      weightLb: 250,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 36,
    },
  ],
  pallets: [
    { code: '0001', weightLb: 750, quantity: 2 },
  ],
  accessorials: rateAccessorials,
  declaredValueUsd: '2,500.00',
}

const preparedRate = prepareRlCarriersRateQuoteRequest(rateInput)
const preparedRateAgain = prepareRlCarriersRateQuoteRequest(clone(rateInput))
const rateSeal = sealPreparedRlCarriersFreightRequest(preparedRate)
assert.equal(preparedRate.operation, 'rate_quote')
assert.equal(preparedRate.providerMutationCount, 0)
assert.equal(preparedRate.method, 'POST')
assert.equal(preparedRate.endpoint, RL_CARRIERS_FREIGHT_ENDPOINTS.rateQuote)
assert.equal(preparedRate.requestHash, preparedRateAgain.requestHash)
assert.match(preparedRate.requestHash, /^[a-f0-9]{64}$/)
assert.equal(rateSeal.requestHash, preparedRate.requestHash)
assert.equal(rateSeal.redactedRequest.credentialVersion, credentialVersion)
assert.equal(
  rateSeal.redactedRequest.credentialFingerprint,
  credentialFingerprint,
)
assert.equal(rateSeal.body, undefined)
assertDeepFrozen(preparedRate, 'prepared rate')
assertDeepFrozen(rateSeal, 'rate seal')

const carrierRate = preparedRate.body.RateQuote
assert.deepEqual(plain(Object.keys(carrierRate)), [
  'Origin',
  'Destination',
  'Items',
  'AdditionalServices',
  'PickupDate',
  'Pallets',
  'DeclaredValue',
])
assert.equal(carrierRate.PickupDate, '08/14/2026')
assert.equal(carrierRate.ServiceLevel, undefined)
assert.equal(carrierRate.Items.length, 2)
assert.deepEqual(plain(carrierRate.Items[0]), {
  Width: 40,
  Height: 45,
  Length: 48,
  Class: '60',
  Weight: 500,
})
assert.deepEqual(plain(carrierRate.Pallets), [
  { Code: '0001', Weight: 750, Quantity: 2 },
])
assert.deepEqual(plain(carrierRate.AdditionalServices), [
  'InsidePickup',
  'OriginLiftgate',
])
assert.equal(carrierRate.DeclaredValue, 2500)
assert.equal(preparedRate.redactedRequest.freight.handlingUnitCount, 2)
assert.equal(preparedRate.redactedRequest.freight.totalWeightLb, 750)
assert.equal(preparedRate.redactedRequest.freight.palletTariffRequested, true)
assert.equal(preparedRate.redactedRequest.rateSelection, null)
assert.deepEqual(plain(preparedRate.redactedRequest.ratedPlan.pallets), [
  { code: '0001', weightLb: 750, quantity: 2 },
])
assert.equal(preparedRate.redactedRequest.ratedPlan.palletCount, 2)
assert.equal(preparedRate.redactedRequest.ratedPlan.palletWeightLb, 750)
const redactedRateRequest = JSON.stringify(preparedRate.redactedRequest)
for (const privateValue of [
  origin.city,
  origin.zipOrPostalCode,
  destination.city,
  destination.zipOrPostalCode,
]) {
  assert.ok(!redactedRateRequest.includes(privateValue))
}

const tamperedRate = clone(preparedRate)
tamperedRate.body.RateQuote.PickupDate = '08/15/2026'
assert.throws(
  () => sealPreparedRlCarriersFreightRequest(tamperedRate),
  /integrity check failed/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest({ ...rateInput, credentials: 'no' }),
  /unsupported field credentials/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.items[0].freightClass = '62.5'
  })),
  /recognized LTL freight class/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.items[0].weightLb = 500.5
  })),
  /must be an integer/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.pickupDate = '2026-02-30'
  })),
  /real calendar date/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['Residential Delivery']
  })),
  /not supported for rate_quote/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['originLiftgate']
  })),
  /not supported for rate_quote/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['ResidentialPickup', 'LimitedAccessPickup']
  })),
  /cannot combine ResidentialPickup and LimitedAccessPickup/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['ResidentialDelivery', 'LimitedAccessDelivery']
  })),
  /cannot combine ResidentialDelivery and LimitedAccessDelivery/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['ResidentialDelivery', 'ResidentialDelivery']
  })),
  /cannot repeat ResidentialDelivery/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.accessorials = ['Hazmat']
  })),
  /not supported for rate_quote/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.credentialFingerprint = 'not-a-fingerprint'
  })),
  /lowercase SHA-256 fingerprint/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.pallets[0].quantity = 1
  })),
  /pallet tariff count and combined weight must match its handling units/,
)
assert.throws(
  () => prepareRlCarriersRateQuoteRequest(variant(rateInput, (input) => {
    input.pallets[0].weightLb = 749
  })),
  /pallet tariff count and combined weight must match its handling units/,
)

const rotatedCredentialRate = prepareRlCarriersRateQuoteRequest(
  variant(rateInput, (input) => {
    input.credentialVersion += 1
    input.credentialFingerprint = 'b'.repeat(64)
  }),
)
assert.notEqual(rotatedCredentialRate.requestHash, preparedRate.requestHash)
const tamperedCredentialBinding = clone(preparedRate)
tamperedCredentialBinding.redactedRequest.credentialVersion += 1
assert.throws(
  () => sealPreparedRlCarriersFreightRequest(tamperedCredentialBinding),
  /integrity check failed/,
)

const classRatePayload = {
  RateQuote: {
    Origin: { City: 'DELAWARE', StateOrProvince: 'OH' },
    Destination: { City: 'BOSTON', StateOrProvince: 'MA' },
    OriginServiceCenter: {
      Phone: 'do-not-retain-service-center-phone',
    },
    CustomerDiscounts: '$431.62',
    Charges: [
      {
        Type: '',
        Title: 'Class: 60',
        Weight: '750',
        Rate: '$199.70',
        Amount: '$199.70',
      },
      {
        Type: 'MINIMUM',
        Title: 'Minimum Charge',
        Weight: '',
        Rate: '',
        Amount: '$523.27',
      },
      {
        Type: 'FUEL',
        Title: 'Fuel Surcharge',
        Weight: '',
        Rate: '25%',
        Amount: '$22.91',
      },
      {
        Type: 'NET',
        Title: 'Net Charge',
        Weight: '',
        Rate: '',
        Amount: '$114.56',
      },
    ],
    ServiceLevels: [
      {
        QuoteNumber: '235431008',
        ServiceDays: 2,
        Charge: '$62.60',
        NetCharge: '$177.16',
        HourlyWindow: null,
        Name: 'Guaranteed Service',
        Code: 'GSDS',
      },
      {
        QuoteNumber: selectedQuoteNumber,
        ServiceDays: 2,
        Charge: '$523.27',
        NetCharge: '$114.56',
        HourlyWindow: null,
        Name: 'Standard Service',
        Code: 'STD',
      },
    ],
    IsDirect: true,
  },
  Code: 200,
  Errors: [],
  Messages: ['Quote generated'],
}

const classRate = parseRlCarriersRateQuoteResponse(
  preparedRate,
  classRatePayload,
)
assert.equal(classRate.provider, 'rl_carriers')
assert.equal(typeof classRate.provider, 'string')
assert.equal(classRate.executingCarrier.name, 'R+L Carriers')
assert.equal(typeof classRate.executingCarrier, 'object')
assert.equal(classRate.mode, 'ltl')
assert.equal(classRate.requestedPalletTariff, true)
assert.equal(classRate.tariffBasis, 'class_ltl')
assert.equal(classRate.customerDiscount, '431.62')
assert.deepEqual(plain(classRate.accessorials), [
  'InsidePickup',
  'OriginLiftgate',
])
assert.deepEqual(plain(classRate.rates.map((rate) => ({
  quoteNumber: rate.quoteNumber,
  serviceCode: rate.serviceCode,
  netCharge: rate.netCharge,
  grossCharge: rate.grossCharge,
  tariffBasis: rate.tariffBasis,
}))), [
  {
    quoteNumber: '88973391',
    serviceCode: 'STD',
    netCharge: '114.56',
    grossCharge: '523.27',
    tariffBasis: 'class_ltl',
  },
  {
    quoteNumber: '235431008',
    serviceCode: 'GSDS',
    netCharge: '177.16',
    grossCharge: '62.60',
    tariffBasis: 'class_ltl',
  },
])
assert.deepEqual(plain(classRate.rates[0].carrierChargeTypes), [
  'FUEL',
  'MINIMUM',
  'NET',
])
assertDeepFrozen(classRate, 'class rate result')
assert.equal(classRate.credentialVersion, credentialVersion)
assert.equal(classRate.credentialFingerprint, credentialFingerprint)
assert.match(classRate.integrityHash, /^[a-f0-9]{64}$/)
const rateEvidence = JSON.stringify(classRate.evidence)
assert.ok(!rateEvidence.includes('do-not-retain-service-center-phone'))
assert.ok(!rateEvidence.includes(selectedQuoteNumber))
assert.ok(!rateEvidence.includes('235431008'))
assert.match(classRate.evidence.providerPayloadHash, /^[a-f0-9]{64}$/)

const ratePayloadWithoutErrors = clone(classRatePayload)
delete ratePayloadWithoutErrors.Errors
const rateWithoutErrors = parseRlCarriersRateQuoteResponse(
  preparedRate,
  ratePayloadWithoutErrors,
)
assert.equal(rateWithoutErrors.rates.length, 2)
assert.match(rateWithoutErrors.integrityHash, /^[a-f0-9]{64}$/)

const palletRatePayload = clone(classRatePayload)
palletRatePayload.RateQuote.Charges.push({
  Type: ' pallet ',
  Title: 'Pallet Tariff',
  Weight: '750',
  Rate: '$0.12',
  Amount: '$90.00',
})
const palletRate = parseRlCarriersRateQuoteResponse(
  preparedRate,
  palletRatePayload,
)
assert.equal(palletRate.tariffBasis, 'pallet_tariff')
assert.ok(palletRate.rates.every((rate) => rate.tariffBasis === 'pallet_tariff'))

const noChargesPayload = clone(classRatePayload)
delete noChargesPayload.RateQuote.Charges
assert.equal(
  parseRlCarriersRateQuoteResponse(preparedRate, noChargesPayload).tariffBasis,
  'class_ltl',
)
assert.throws(
  () => parseRlCarriersRateQuoteResponse(
    preparedRate,
    variant(classRatePayload, (payload) => {
      payload.RateQuote.ServiceLevels[0].NetCharge = 'call for rate'
    }),
  ),
  /NetCharge must be non-negative USD money/,
)
assert.throws(
  () => parseRlCarriersRateQuoteResponse(preparedRate, {
    Code: 400,
    Errors: [{
      Property: 'RateQuote',
      ErrorMessage: 'private-carrier-error-must-not-escape',
    }],
    Messages: [],
  }),
  (error) => {
    assert.match(error.message, /failed with 1 carrier error/)
    assert.doesNotMatch(error.message, /private-carrier-error/)
    return true
  },
)

const bolInput = {
  bolDate: '2026-08-14',
  rateSelection: {
    parsedRateQuote: classRate,
    selectedQuoteNumber,
  },
  shipper,
  consignee,
  handlingUnits: [
    {
      unitType: 'PLT',
      quantity: 1,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 45,
      items: [
        {
          pieces: 10,
          packageType: 'CTN',
          description: 'Boxed aluminum radiators',
          freightClass: '60',
          weightLb: 500,
          nmfcItemNumber: '123456',
          nmfcSubNumber: '01',
        },
      ],
    },
    {
      unitType: 'PLT',
      quantity: 1,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 36,
      items: [
        {
          pieces: 5,
          packageType: 'CTN',
          description: 'Boxed cooling accessories',
          freightClass: '70',
          weightLb: 250,
        },
      ],
    },
  ],
  specialInstructions: 'Call receiving before arrival.',
  declaredValue: {
    amountUsd: '2500.00',
    per: 'Shipment',
  },
  referenceNumbers: {
    shipperNumber: 'SHIP-2026-0814',
    purchaseOrderNumber: 'PO-10042',
  },
  freightChargePaymentMethod: 'Prepaid',
  pickupRequest: {
    pickupDate: '2026-08-14',
    readyTime: '08:00',
    closeTime: '17:00',
    additionalInstructions: 'Freight staged at dock four.',
    loadAttributes: ['Stackable', 'Palletized', 'Stackable'],
    contact: {
      name: 'Shipping Desk',
      companyName: shipper.companyName,
      phoneNumber: shipper.phoneNumber,
      emailAddress: shipper.emailAddress,
    },
    sendEmailConfirmation: true,
    shipperReferenceNumber: 'SHIP-2026-0814',
  },
}

function parsedRateForService({ code, name, quoteNumber, hourlyWindow = null }) {
  const payload = clone(classRatePayload)
  payload.RateQuote.ServiceLevels = [{
    QuoteNumber: quoteNumber,
    ServiceDays: 2,
    Charge: '$523.27',
    NetCharge: '$114.56',
    HourlyWindow: hourlyWindow,
    Name: name,
    Code: code,
  }]
  return parseRlCarriersRateQuoteResponse(preparedRate, payload)
}

for (const service of [
  {
    code: 'STD',
    name: 'Standard Service',
    quoteNumber: '88973392',
    expected: 'Standard',
  },
  {
    code: 'GSDS',
    name: 'Guaranteed Service',
    quoteNumber: '88973393',
    expected: 'Guaranteed',
  },
  {
    code: 'GSAM',
    name: 'Guaranteed AM Service',
    quoteNumber: '88973394',
    expected: 'GuaranteedByNoon',
  },
  {
    code: 'GSHW',
    name: 'Guaranteed HW Service',
    quoteNumber: '88973395',
    expected: 'GuaranteedHourlyWindow',
    hourlyWindow: { Start: '09:00 AM', End: '11:00 AM' },
  },
]) {
  const parsedRate = parsedRateForService(service)
  const prepared = prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    rateSelection: {
      parsedRateQuote: parsedRate,
      selectedQuoteNumber: service.quoteNumber,
    },
  })
  assert.equal(prepared.body.BillOfLading.ServiceLevel, service.expected)
  if (service.code === 'GSHW') {
    assert.deepEqual(plain(prepared.body.BillOfLading.HourlyWindow), {
      Start: '09:00 AM',
      End: '11:00 AM',
    })
  }
}

const expeditedRate = parsedRateForService({
  code: 'EXPD',
  name: 'Expedited Service',
  quoteNumber: '88973396',
})
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    rateSelection: {
      parsedRateQuote: expeditedRate,
      selectedQuoteNumber: '88973396',
    },
  }),
  /cannot tender Expedited without a distinct expedited quote binding/,
)
const unknownServiceRate = parsedRateForService({
  code: 'UNKNOWN',
  name: 'Unknown Service',
  quoteNumber: '88973397',
})
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    rateSelection: {
      parsedRateQuote: unknownServiceRate,
      selectedQuoteNumber: '88973397',
    },
  }),
  /does not map to a supported R\+L tender service level/,
)

for (const mutate of [
  (parsed) => { parsed.rates[0].netCharge = '999.99' },
  (parsed) => { parsed.evidence.requestHash = 'b'.repeat(64) },
  (parsed) => { parsed.tariffBasis = 'pallet_tariff' },
  (parsed) => { parsed.accessorials = ['InsidePickup'] },
  (parsed) => { parsed.credentialVersion += 1 },
  (parsed) => { parsed.credentialFingerprint = 'b'.repeat(64) },
  (parsed) => { parsed.ratedPlan.pallets[0].code = '0002' },
  (parsed) => { parsed.ratedPlan.pallets[0].quantity = 1 },
  (parsed) => { parsed.ratedPlan.pallets[0].weightLb = 749 },
]) {
  const parsedRateQuote = clone(classRate)
  mutate(parsedRateQuote)
  assert.throws(
    () => prepareRlCarriersBillOfLadingRequest({
      ...bolInput,
      rateSelection: { parsedRateQuote, selectedQuoteNumber },
    }),
    /integrity|drifted/,
  )
}
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    rateSelection: {
      parsedRateQuote: classRate,
      selectedQuoteNumber: '99999999',
    },
  }),
  /is not an offered quote/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    rateSelection: {
      quoteNumber: selectedQuoteNumber,
      serviceLevel: 'Standard',
    },
  }),
  /unsupported field quoteNumber/,
)

const preparedBol = prepareRlCarriersBillOfLadingRequest(bolInput)
const bolSeal = sealPreparedRlCarriersFreightRequest(preparedBol)
assert.equal(preparedBol.operation, 'bill_of_lading')
assert.equal(preparedBol.endpoint, RL_CARRIERS_FREIGHT_ENDPOINTS.billOfLading)
assert.equal(
  preparedBol.redactedRequest.providerWriteIntent,
  'bill_of_lading_with_pickup.create',
)
assert.equal(
  preparedBol.redactedRequest.pickupBinding,
  'bill_of_lading_embedded',
)
assert.equal(bolSeal.body, undefined)
assertDeepFrozen(preparedBol, 'prepared BOL')
const carrierBol = preparedBol.body.BillOfLading
assert.equal(carrierBol.BOLDate, '08/14/2026')
assert.equal(carrierBol.BolDate, undefined)
assert.equal(carrierBol.Items, undefined)
assert.equal(carrierBol.HandlingUnits.length, 2)
assert.equal(carrierBol.HandlingUnits[0].UnitType, 'PLT')
assert.equal(carrierBol.HandlingUnits[0].Dimensions[0].Count, 1)
assert.equal(carrierBol.HandlingUnits[0].Dimensions[0].Length, '48')
assert.equal(carrierBol.HandlingUnits[0].Items[0].Description, 'Boxed aluminum radiators')
assert.equal(carrierBol.ReferenceNumbers.RateQuoteNumber, selectedQuoteNumber)
assert.equal(carrierBol.ReferenceNumbers.PONumber, 'PO-10042')
assert.deepEqual(plain(carrierBol.AdditionalServices), [
  'InsidePickup',
  'OriginLiftgate',
])
assert.equal(carrierBol.ServiceLevel, 'Standard')
assert.equal(preparedBol.body.GenerateUniversalPro, true)
assert.equal(
  preparedBol.body.PickupRequest.PickupInformation.PickupDate,
  '08/14/2026',
)
assert.equal(
  preparedBol.body.PickupRequest.PickupInformation.ReadyTime,
  '08:00 AM',
)
assert.equal(
  preparedBol.body.PickupRequest.PickupInformation.CloseTime,
  '05:00 PM',
)
assert.deepEqual(
  plain(preparedBol.body.PickupRequest.PickupInformation.LoadAttributes),
  ['Palletized', 'Stackable'],
)
assert.equal(preparedBol.body.PickupRequest.Contact.Name, 'Shipping Desk')
assert.equal(
  preparedBol.body.PickupRequest.ShipperReferenceNumber,
  'SHIP-2026-0814',
)
assert.equal(preparedBol.body.PickupRequest.SendEmailConfirmation, true)
assert.equal(preparedBol.redactedRequest.freight.handlingUnitCount, 2)
assert.equal(preparedBol.redactedRequest.freight.totalWeightLb, 750)
assert.equal(preparedBol.redactedRequest.credentialVersion, credentialVersion)
assert.equal(
  preparedBol.redactedRequest.credentialFingerprint,
  credentialFingerprint,
)
assert.equal(
  preparedBol.redactedRequest.rateSelection.rateRequestHash,
  preparedRate.requestHash,
)
assert.equal(
  preparedBol.redactedRequest.rateSelection.rateResponseIntegrityHash,
  classRate.integrityHash,
)
assert.equal(
  preparedBol.redactedRequest.ratedPlan.planHash,
  preparedRate.redactedRequest.ratedPlan.planHash,
)
assert.deepEqual(plain(preparedBol.redactedRequest.ratedPlan.pallets), [
  { code: '0001', weightLb: 750, quantity: 2 },
])
assert.doesNotMatch(JSON.stringify(preparedBol.body), /"COD|codAmount|Void/)
const redactedBolRequest = JSON.stringify(preparedBol.redactedRequest)
for (const privateValue of [
  shipper.companyName,
  shipper.addressLine1,
  shipper.phoneNumber,
  consignee.companyName,
  consignee.addressLine1,
  selectedQuoteNumber,
]) {
  assert.ok(!redactedBolRequest.includes(privateValue))
}
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    items: [{ Description: 'root item is forbidden' }],
  }),
  /unsupported field items/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest({
    ...bolInput,
    codAmount: '100.00',
  }),
  /unsupported field codAmount/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, (input) => {
    input.freightChargePaymentMethod = 'Third Party'
  })),
  /freightChargePaymentMethod is unsupported/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, (input) => {
    input.accessorials = ['InsidePickup']
  })),
  /unsupported field accessorials/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, (input) => {
    delete input.handlingUnits[0].lengthIn
  })),
  /lengthIn must be greater than 0/,
)
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, (input) => {
    input.handlingUnits[0].heightIn = 0
  })),
  /heightIn must be greater than 0/,
)
for (const mutate of [
  (input) => { input.shipper.zipOrPostalCode = '43016' },
  (input) => { input.consignee.city = 'Cambridge' },
  (input) => { input.handlingUnits[0].items[0].weightLb = 501 },
  (input) => { input.handlingUnits[0].items[0].freightClass = '65' },
  (input) => { input.handlingUnits[0].lengthIn = 47 },
]) {
  assert.throws(
    () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, mutate)),
    /drifted from the selected R\+L rate request|pallet tariff count and combined weight/,
  )
}
assert.throws(
  () => prepareRlCarriersBillOfLadingRequest(variant(bolInput, (input) => {
    input.handlingUnits[0].quantity = 2
  })),
  /quantity must be 1 for exact rated-plan binding/,
)

const preparedBolWithoutPickup = prepareRlCarriersBillOfLadingRequest(
  variant(bolInput, (input) => {
    input.pickupRequest = null
  }),
)
assert.equal(preparedBolWithoutPickup.body.PickupRequest, undefined)
assert.equal(
  preparedBolWithoutPickup.redactedRequest.providerWriteIntent,
  'bill_of_lading.create',
)
assert.equal(preparedBolWithoutPickup.redactedRequest.pickupBinding, 'none')

const parsedBol = parseRlCarriersBillOfLadingResponse(preparedBol, {
  ProNumber: '123456789',
  PickupRequestNumber: '7654321',
  Code: 200,
  Messages: ['BOL created'],
})
assert.equal(parsedBol.provider, 'rl_carriers')
assert.equal(parsedBol.executingCarrier.name, 'R+L Carriers')
assert.equal(parsedBol.quoteNumber, selectedQuoteNumber)
assert.equal(parsedBol.proNumber, '123456789')
assert.equal(parsedBol.pickupRequestId, '7654321')
const bolEvidence = JSON.stringify(parsedBol.evidence)
assert.ok(!bolEvidence.includes(selectedQuoteNumber))
assert.ok(!bolEvidence.includes('123456789'))
assert.ok(!bolEvidence.includes('7654321'))
assertDeepFrozen(parsedBol, 'parsed BOL')

const proOnlyBolError = captureThrown(
  () => parseRlCarriersBillOfLadingResponse(preparedBol, {
    ProNumber: '123456789',
    Code: 200,
    Messages: ['do-not-persist-response-message'],
    InternalDetail: 'do-not-persist-provider-payload',
  }),
)
assert.ok(proOnlyBolError instanceof RlCarriersPartialMutationOutcomeError)
assert.equal(proOnlyBolError.name, 'RlCarriersPartialMutationOutcomeError')
assert.equal(proOnlyBolError.code, 'RL_CARRIERS_PARTIAL_MUTATION_OUTCOME')
assert.deepEqual(plain(proOnlyBolError.reconciliation.providerIds), {
  proNumber: '123456789',
  pickupRequestId: null,
})
assert.deepEqual(
  plain(proOnlyBolError.reconciliation.missingRequiredIdentifiers),
  ['pickup_request_id'],
)
assert.equal(proOnlyBolError.reconciliation.operation, 'bill_of_lading')
assert.equal(proOnlyBolError.reconciliation.requestHash, preparedBol.requestHash)
assert.match(proOnlyBolError.reconciliation.providerPayloadHash, /^[a-f0-9]{64}$/)
assert.match(proOnlyBolError.reconciliation.fingerprints.quoteNumber, /^[a-f0-9]{64}$/)
assert.match(proOnlyBolError.reconciliation.fingerprints.proNumber, /^[a-f0-9]{64}$/)
assert.equal(proOnlyBolError.reconciliation.fingerprints.pickupRequestId, null)
assert.equal(proOnlyBolError.reconciliation.successCode, 200)
assert.equal(proOnlyBolError.reconciliation.messageCount, 1)
assertDeepFrozen(proOnlyBolError.reconciliation, 'PRO-only reconciliation')
const proOnlyReconciliation = JSON.stringify(proOnlyBolError.reconciliation)
assert.ok(!proOnlyReconciliation.includes('do-not-persist-response-message'))
assert.ok(!proOnlyReconciliation.includes('do-not-persist-provider-payload'))
assert.ok(!Object.hasOwn(proOnlyBolError.reconciliation, 'payload'))
assert.ok(!Object.hasOwn(proOnlyBolError.reconciliation, 'messages'))

const pickupOnlyBolError = captureThrown(
  () => parseRlCarriersBillOfLadingResponse(preparedBol, {
    PickupRequestNumber: '7654322',
    Code: 200,
    Errors: null,
    Messages: ['do-not-persist-pickup-only-message'],
  }),
)
assert.ok(pickupOnlyBolError instanceof RlCarriersPartialMutationOutcomeError)
assert.deepEqual(plain(pickupOnlyBolError.reconciliation.providerIds), {
  proNumber: null,
  pickupRequestId: '7654322',
})
assert.deepEqual(
  plain(pickupOnlyBolError.reconciliation.missingRequiredIdentifiers),
  ['pro_number'],
)
assert.equal(pickupOnlyBolError.reconciliation.fingerprints.proNumber, null)
assert.match(
  pickupOnlyBolError.reconciliation.fingerprints.pickupRequestId,
  /^[a-f0-9]{64}$/,
)
assertDeepFrozen(pickupOnlyBolError.reconciliation, 'pickup-only reconciliation')
assert.ok(
  !JSON.stringify(pickupOnlyBolError.reconciliation)
    .includes('do-not-persist-pickup-only-message'),
)

const parsedBolWithoutPickup = parseRlCarriersBillOfLadingResponse(
  preparedBolWithoutPickup,
  {
    ProNumber: '123456790',
    Code: 200,
    Errors: null,
    Messages: ['BOL created without pickup'],
  },
)
assert.equal(parsedBolWithoutPickup.proNumber, '123456790')
assert.equal(parsedBolWithoutPickup.pickupRequestId, null)

const pickupInput = {
  rateSelection: {
    parsedRateQuote: classRate,
    selectedQuoteNumber,
  },
  shipper: {
    ...shipper,
    contactName: 'Shipping Desk',
    shipperReferenceNumber: 'SHIP-2026-0814',
  },
  contact: {
    name: 'Shipping Desk',
    companyName: shipper.companyName,
    phoneNumber: shipper.phoneNumber,
    emailAddress: shipper.emailAddress,
  },
  destination,
  handlingUnits: [
    {
      quantity: 1,
      freightClass: '60',
      weightLb: 500,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 45,
    },
    {
      quantity: 1,
      freightClass: '70',
      weightLb: 250,
      lengthIn: 48,
      widthIn: 40,
      heightIn: 36,
    },
  ],
  pickupDate: '2026-08-14',
  readyTime: '08:00',
  closeTime: '17:00',
  additionalInstructions: 'Freight staged at dock four.',
  loadAttributes: ['Stackable', 'Palletized', 'Stackable'],
  sendEmailConfirmation: true,
}

const preparedPickup = prepareRlCarriersQuotedPickupRequest(pickupInput)
const pickupSeal = sealPreparedRlCarriersFreightRequest(preparedPickup)
assert.equal(preparedPickup.operation, 'pickup_request')
assert.equal(preparedPickup.endpoint, RL_CARRIERS_FREIGHT_ENDPOINTS.pickupRequest)
assert.equal(preparedPickup.redactedRequest.providerWriteIntent, 'pickup_request.create')
assert.equal(preparedPickup.redactedRequest.pickupBinding, 'direct_quote')
assert.equal(preparedPickup.redactedRequest.credentialVersion, credentialVersion)
assert.equal(
  preparedPickup.redactedRequest.credentialFingerprint,
  credentialFingerprint,
)
assert.equal(
  preparedPickup.redactedRequest.rateSelection.selectedRateFingerprint,
  preparedBol.redactedRequest.rateSelection.selectedRateFingerprint,
)
assert.equal(pickupSeal.body, undefined)
assertDeepFrozen(preparedPickup, 'prepared pickup')
const carrierPickup = preparedPickup.body.Pickup
assert.equal(carrierPickup.QuoteNumber, selectedQuoteNumber)
assert.equal(carrierPickup.ServiceLevel, 'Standard')
assert.equal(carrierPickup.PickupDate, '08/14/2026')
assert.equal(carrierPickup.ReadyTime, '08:00 AM')
assert.equal(carrierPickup.CloseTime, '05:00 PM')
assert.equal(carrierPickup.Destinations.length, 1)
assert.equal(carrierPickup.Destinations[0].Weight, 750)
assert.equal(carrierPickup.Destinations[0].Pieces, 2)
assert.equal(carrierPickup.Destinations[0].PackageType, 'PLT')
assert.deepEqual(
  plain(carrierPickup.Destinations[0].Dimensions.map((dimension) => dimension.Units)),
  [1, 1],
)
assert.deepEqual(plain(carrierPickup.LoadAttributes), ['Palletized', 'Stackable'])
assert.deepEqual(plain(carrierPickup.AdditionalServices), ['InsidePickup', 'Liftgate'])
assert.equal(preparedPickup.body.SendEmailConfirmation, true)
const redactedPickupRequest = JSON.stringify(preparedPickup.redactedRequest)
for (const privateValue of [
  shipper.companyName,
  shipper.addressLine1,
  shipper.phoneNumber,
  destination.city,
  destination.zipOrPostalCode,
  selectedQuoteNumber,
]) {
  assert.ok(!redactedPickupRequest.includes(privateValue))
}
assert.throws(
  () => prepareRlCarriersQuotedPickupRequest(variant(pickupInput, (input) => {
    input.closeTime = '08:00'
  })),
  /closeTime must be later than readyTime/,
)
assert.throws(
  () => prepareRlCarriersQuotedPickupRequest(variant(pickupInput, (input) => {
    input.handlingUnits[0].widthIn = 97
  })),
  /no more than 96/,
)
assert.throws(
  () => prepareRlCarriersQuotedPickupRequest(variant(pickupInput, (input) => {
    input.accessorials = ['InsidePickup']
  })),
  /unsupported field accessorials/,
)
for (const mutate of [
  (input) => { input.shipper.zipOrPostalCode = '43016' },
  (input) => { input.destination.city = 'Cambridge' },
  (input) => { input.handlingUnits[0].weightLb = 501 },
  (input) => { input.handlingUnits[0].freightClass = '65' },
  (input) => { input.handlingUnits[0].heightIn = 44 },
]) {
  assert.throws(
    () => prepareRlCarriersQuotedPickupRequest(variant(pickupInput, mutate)),
    /drifted from the selected R\+L rate request|pallet tariff count and combined weight/,
  )
}

const parsedPickup = parseRlCarriersQuotedPickupResponse(preparedPickup, {
  PickupRequestId: 2468135,
  Code: 200,
  Messages: ['Pickup scheduled'],
})
assert.equal(parsedPickup.provider, 'rl_carriers')
assert.equal(parsedPickup.executingCarrier.name, 'R+L Carriers')
assert.equal(parsedPickup.quoteNumber, selectedQuoteNumber)
assert.equal(parsedPickup.pickupRequestId, '2468135')
const pickupEvidence = JSON.stringify(parsedPickup.evidence)
assert.ok(!pickupEvidence.includes(selectedQuoteNumber))
assert.ok(!pickupEvidence.includes('2468135'))
assertDeepFrozen(parsedPickup, 'parsed pickup')

const missingStandalonePickupError = captureThrown(
  () => parseRlCarriersQuotedPickupResponse(preparedPickup, {
    Code: 200,
    Messages: ['do-not-persist-standalone-pickup-message'],
  }),
)
assert.ok(
  missingStandalonePickupError instanceof RlCarriersPartialMutationOutcomeError,
)
assert.equal(
  missingStandalonePickupError.code,
  'RL_CARRIERS_PARTIAL_MUTATION_OUTCOME',
)
assert.equal(
  missingStandalonePickupError.reconciliation.operation,
  'pickup_request',
)
assert.equal(
  missingStandalonePickupError.reconciliation.requestHash,
  preparedPickup.requestHash,
)
assert.deepEqual(
  plain(missingStandalonePickupError.reconciliation.providerIds),
  { proNumber: null, pickupRequestId: null },
)
assert.deepEqual(
  plain(missingStandalonePickupError.reconciliation.missingRequiredIdentifiers),
  ['pickup_request_id'],
)
assert.equal(missingStandalonePickupError.reconciliation.messageCount, 1)
assertDeepFrozen(
  missingStandalonePickupError.reconciliation,
  'missing standalone pickup reconciliation',
)
assert.ok(
  !JSON.stringify(missingStandalonePickupError.reconciliation)
    .includes('do-not-persist-standalone-pickup-message'),
)

assert.throws(
  () => parseRlCarriersRateQuoteResponse(preparedBol, classRatePayload),
  /Prepared R\+L rate_quote request is invalid/,
)

console.log('R+L Carriers freight foundation tests passed')
