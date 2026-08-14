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

function loadFoundation() {
  const path = 'app_src/lib/integrations/wwexSpeedshipFoundation.ts'
  const result = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  )
  assert.deepEqual(errors, [], 'The WWEX foundation must transpile without syntax errors')
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    Array,
    Boolean,
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
  }, { filename: path })
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

const source = read('app_src/lib/integrations/wwexSpeedshipFoundation.ts')
assert.doesNotMatch(source, /\bfetch\s*\(/, 'The foundation must not make network calls')
assert.doesNotMatch(
  source,
  /clientSecret|accessToken|Authorization|oauth\/token/i,
  'The foundation must not acquire or transport authentication material',
)
assert.doesNotMatch(
  source,
  /integratedCancelFlow/,
  'Cancellation must remain unavailable while the supplied contract is ambiguous',
)
assert.deepEqual(
  [...source.matchAll(/^import .* from ['"]([^'"]+)['"]$/gm)].map((match) => match[1]),
  ['node:crypto'],
  'The pure foundation may import only deterministic hashing support',
)

const foundation = loadFoundation()
assert.deepEqual(
  Object.keys(foundation).sort(),
  [
    'WWEX_SPEEDSHIP_ADAPTER_VERSION',
    'WWEX_SPEEDSHIP_FLOW_PATHS',
    'WWEX_SPEEDSHIP_PROVIDER',
    'WWEX_LTL_PACKAGING_TYPES',
    'WWEX_SMALLPACK_PACKAGING_TYPES',
    'WwexSpeedshipPartialTenderOutcomeError',
    'parseWwexLtlShopResponse',
    'parseWwexLtlTenderResponse',
    'parseWwexSmallpackSchedulePickupResponse',
    'parseWwexSmallpackShopResponse',
    'parseWwexSmallpackTenderResponse',
    'prepareWwexLtlShopRequest',
    'prepareWwexLtlTenderRequest',
    'prepareWwexSmallpackSchedulePickupRequest',
    'prepareWwexSmallpackShopRequest',
    'prepareWwexSmallpackTenderRequest',
    'sealPreparedWwexSpeedshipShopRequest',
    'sealPreparedWwexSpeedshipTenderRequest',
    'sealPreparedWwexSmallpackSchedulePickupRequest',
  ].sort(),
)

const {
  WWEX_SPEEDSHIP_ADAPTER_VERSION,
  WWEX_SPEEDSHIP_FLOW_PATHS,
  WWEX_SPEEDSHIP_PROVIDER,
  WwexSpeedshipPartialTenderOutcomeError,
  parseWwexLtlShopResponse,
  parseWwexLtlTenderResponse,
  parseWwexSmallpackSchedulePickupResponse,
  parseWwexSmallpackShopResponse,
  parseWwexSmallpackTenderResponse,
  prepareWwexLtlShopRequest,
  prepareWwexLtlTenderRequest,
  prepareWwexSmallpackSchedulePickupRequest,
  prepareWwexSmallpackShopRequest,
  prepareWwexSmallpackTenderRequest,
  sealPreparedWwexSpeedshipShopRequest,
  sealPreparedWwexSpeedshipTenderRequest,
  sealPreparedWwexSmallpackSchedulePickupRequest,
} = foundation

assert.equal(WWEX_SPEEDSHIP_ADAPTER_VERSION, 'wwex-speedship-v1')
assert.equal(WWEX_SPEEDSHIP_PROVIDER, 'wwex_speedship')
assert.deepEqual(plain(WWEX_SPEEDSHIP_FLOW_PATHS), {
  shopFlow: '/svc/shopFlow',
  schedulePickupFlow: '/svc/schedulePickupFlow',
  integratedOrderFlow: '/svc/integratedOrderFlow',
  quoteOrderFlow: '/svc/quoteOrderFlow',
})

const origin = {
  line1: '7009 S 108th St',
  line2: null,
  locality: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
  companyName: 'AG Alchemy Warehouse',
  phone: '4025550100',
  contact: {
    firstName: 'Alex',
    lastName: 'Warehouse',
    phone: '4025550100',
    email: 'warehouse@example.test',
  },
  residential: false,
  locationType: 'COMMERCIAL',
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

const smallOrigin = {
  ...clone(origin),
  locationType: 'OTHER',
}
const smallDestination = {
  ...clone(destination),
  locationType: 'RESIDENTIAL',
}

const credentialVersion = 3
const credentialFingerprint = 'a'.repeat(64)
const smallpackInput = {
  credentialVersion,
  credentialFingerprint,
  planId: 'shipment-plan:SP-1001',
  correlationId: 'clawpilot:shop:SP-1001:r1',
  shipmentDate: '2026-08-18 14:30:00',
  shipmentDescription: 'Two loose customer packages',
  origin: smallOrigin,
  destination: smallDestination,
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
  }, {
    packageKey: 'polybag-1',
    packagingType: '02',
    length: 14,
    width: 10,
    height: 3,
    weight: 4,
    references: [{
      type: 'Shipment Reference 2',
      value: 'PACK-SP-2',
      isPrintAsBarCode: false,
    }],
  }],
  deliveryConfirmation: true,
  carbonNeutral: false,
  adultSignatureRequired: false,
  signatureRequired: true,
  shipperRelease: false,
  selfScheduled: false,
  returnLabel: false,
  returnServiceType: null,
}

const smallPrepared = prepareWwexSmallpackShopRequest(smallpackInput)
const smallPreparedAgain = prepareWwexSmallpackShopRequest(clone(smallpackInput))
const smallShopSeal = sealPreparedWwexSpeedshipShopRequest(smallPrepared)
assert.equal(smallPrepared.provider, 'wwex_speedship')
assert.equal(smallPrepared.transportMode, 'small_parcel')
assert.equal(smallPrepared.flow, 'shopFlow')
assert.equal(smallPrepared.path, '/svc/shopFlow')
assert.equal(smallPrepared.requestHash, smallPreparedAgain.requestHash)
assert.equal(smallShopSeal.requestHash, smallPrepared.requestHash)
assert.equal(smallShopSeal.body, undefined)
assert.equal(smallPrepared.planHash, smallPreparedAgain.planHash)
assert.match(smallPrepared.planHash, /^[a-f0-9]{64}$/)
assert.match(smallPrepared.requestHash, /^[a-f0-9]{64}$/)
assert.equal(smallPrepared.body.request.productType, 'SMALLPACK')
assert.equal(smallPrepared.body.request.shipment.totalHandlingUnitCount, 2)
assert.deepEqual(plain(smallPrepared.body.request.shipment.totalWeight), {
  value: 26,
  unit: 'LB',
})
assert.equal(
  smallPrepared.body.request.shipment.handlingUnitList[1].packagingTypeName,
  'Custom',
)
assert.equal(smallPrepared.evidence.expectedExecutingCarrier.vendorId, 'UPS')
assert.equal(smallPrepared.evidence.transportMode, 'small_parcel')
assert.equal(smallPrepared.evidence.credentialVersion, credentialVersion)
assert.equal(smallPrepared.evidence.credentialFingerprint, credentialFingerprint)
assertDeepFrozen(smallPrepared, 'prepared SMALLPACK shop plan')
assertDeepFrozen(smallShopSeal, 'sealed SMALLPACK shop plan')
assert.notEqual(
  prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    packages: [{ ...clone(smallpackInput.packages[0]), weight: 23 }],
  }).planHash,
  smallPrepared.planHash,
)
assert.equal(
  prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    origin: { ...clone(smallOrigin), locationType: 'SECURED_LOCATION' },
  }).body.request.shipment.originAddress.locationType,
  'SECURED_LOCATION',
)
assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    origin: { ...clone(smallOrigin), locationType: 'SECURED_ACCESS' },
  }),
  /location type is not supported/,
)

const smallEvidenceText = JSON.stringify(smallPrepared.evidence)
for (const sensitive of [
  origin.line1,
  origin.companyName,
  origin.phone,
  origin.contact.email,
  destination.line1,
  destination.companyName,
  destination.contact.lastName,
  'Two loose customer packages',
  '1001001',
  'PACK-SP-2',
]) {
  assert.ok(!smallEvidenceText.includes(sensitive), `Evidence leaked ${sensitive}`)
}

assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    packages: [{ ...clone(smallpackInput.packages[0]), weight: 2.5 }],
  }),
  /positive integer/,
)
assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    packages: [{ ...clone(smallpackInput.packages[0]), packagingType: 'ZZ' }],
  }),
  /packaging type is not supported/,
)
assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    packages: [
      clone(smallpackInput.packages[0]),
      { ...clone(smallpackInput.packages[0]) },
    ],
  }),
  /package keys must be unique/,
)
assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    packages: [{
      ...clone(smallpackInput.packages[0]),
      references: [{ type: 'SO', value: 'SO-123', isPrintAsBarCode: true }],
    }],
  }),
  /digits only/,
)
assert.throws(
  () => prepareWwexSmallpackShopRequest({
    ...clone(smallpackInput),
    destination: {
      ...clone(destination),
      locality: 'Toronto',
      region: 'ON',
      postalCode: 'M5H1P6',
      countryCode: 'CA',
      residential: false,
      locationType: 'OTHER',
    },
  }),
  /International SMALLPACK rating requires UPS billing and forms inputs/,
)
const alteredSmallPrepared = clone(smallPrepared)
alteredSmallPrepared.body.request.shipment.handlingUnitList[0].weight.value = 99
assert.throws(
  () => sealPreparedWwexSpeedshipShopRequest(alteredSmallPrepared),
  /integrity check/,
)

const smallResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Success' },
  correlationId: 'wwex:shop:SP-1001',
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
        chargeItemList: [{
          customerChargeCode: 'TRANSPORTATION',
          chargeCodeCategory: 'FREIGHT',
          customerDescription: 'Transportation charge',
          customerPrice: { value: '43.25', unit: 'USD' },
        }, {
          customerChargeCode: 'RESIDENTIAL',
          chargeCodeCategory: 'ACCESSORIAL',
          customerDescription: 'Residential delivery',
          customerPrice: { value: '5.00', unit: 'USD' },
        }],
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

const smallShop = parseWwexSmallpackShopResponse(smallPrepared, smallResponse)
assert.equal(smallShop.transportMode, 'small_parcel')
assert.equal(smallShop.productTransactionId, smallResponse.response.productTransactionId)
assert.equal(smallShop.offers.length, 1)
assert.deepEqual(plain(smallShop.offers[0].executingCarrier), {
  vendorId: 'UPS',
  name: 'UPS',
  scac: 'UPSN',
})
assert.equal(smallShop.offers[0].serviceCode, 'GND')
assert.equal(smallShop.offers[0].amount, '48.25')
assert.equal(smallShop.offers[0].charges.length, 2)
assert.match(smallShop.resultHash, /^[a-f0-9]{64}$/)
assertDeepFrozen(smallShop, 'parsed SMALLPACK shop response')
assert.throws(
  () => parseWwexSmallpackShopResponse(smallPrepared, {
    ...clone(smallResponse),
    clientStatus: { success: false, message: 'Sensitive provider error' },
  }),
  /reported failure/,
)
assert.throws(
  () => parseWwexSmallpackShopResponse(smallPrepared, {
    ...clone(smallResponse),
    response: {
      ...clone(smallResponse.response),
      offerList: [{
        ...clone(smallResponse.response.offerList[0]),
        primaryVendor: { vendorId: 'FEDEX', preferredName: 'FedEx', scac: 'FDEG' },
      }],
    },
  }),
  /must identify UPS/,
)
for (const invalidScac of ['UP1', 'UPSNX']) {
  assert.throws(
    () => parseWwexSmallpackShopResponse(smallPrepared, {
      ...clone(smallResponse),
      response: {
        ...clone(smallResponse.response),
        offerList: [{
          ...clone(smallResponse.response.offerList[0]),
          primaryVendor: {
            ...clone(smallResponse.response.offerList[0].primaryVendor),
            scac: invalidScac,
          },
        }],
      },
    }),
    /SCAC is invalid/,
  )
}

const pickupInput = {
  pickupPlanId: 'pickup-plan:SP-1001:r1',
  shop: smallShop,
  pickupDate: '2026-08-18 10:10:00',
  pickupAddress: smallOrigin,
  timeZone: 'America/Chicago',
  readyTime: '10:35:00',
  closeTime: '16:50:00',
  alternateAddress: false,
  saturdayAvailable: false,
  selfScheduled: false,
  correlationId: 'clawpilot:pickup:SP-1001:r1',
}
const pickupPrepared = prepareWwexSmallpackSchedulePickupRequest(pickupInput)
const pickupPreparedAgain = prepareWwexSmallpackSchedulePickupRequest(clone(pickupInput))
const pickupSeal = sealPreparedWwexSmallpackSchedulePickupRequest(pickupPrepared)
assert.equal(pickupPrepared.flow, 'schedulePickupFlow')
assert.equal(pickupPrepared.path, '/svc/schedulePickupFlow')
assert.equal(pickupPrepared.requestHash, pickupPreparedAgain.requestHash)
assert.equal(pickupPrepared.pickupPlanHash, pickupPreparedAgain.pickupPlanHash)
assert.equal(pickupSeal.body, undefined)
assert.equal(pickupSeal.requestHash, pickupPrepared.requestHash)
assert.deepEqual(
  plain(pickupPrepared.body.request.productTransactionIdList),
  [smallShop.productTransactionId],
)
assert.equal(pickupPrepared.body.request.vendorId, 'UPS')
assert.equal(pickupPrepared.body.request.pickupStop.address.timeZone, 'America/Chicago')
assert.equal(pickupPrepared.evidence.executingCarrier.vendorId, 'UPS')
assert.ok(!JSON.stringify(pickupPrepared.evidence).includes(smallOrigin.line1))
assertDeepFrozen(pickupPrepared, 'prepared SMALLPACK pickup')
assertDeepFrozen(pickupSeal, 'sealed SMALLPACK pickup')
const pickupWithTamperedShopEvidence = clone(pickupInput)
pickupWithTamperedShopEvidence.shop.evidence.shopRequest.origin.addressFingerprint =
  'f'.repeat(64)
assert.throws(
  () => prepareWwexSmallpackSchedulePickupRequest(pickupWithTamperedShopEvidence),
  /integrity check/,
)
const alteredPickupPrepared = clone(pickupPrepared)
alteredPickupPrepared.body.request.vendorId = 'NOT_UPS'
assert.throws(
  () => sealPreparedWwexSmallpackSchedulePickupRequest(alteredPickupPrepared),
  /integrity check/,
)
assert.throws(
  () => prepareWwexSmallpackSchedulePickupRequest({
    ...clone(pickupInput),
    readyTime: '17:00:00',
    closeTime: '16:00:00',
  }),
  /ready time must be before close time/,
)
assert.throws(
  () => prepareWwexSmallpackSchedulePickupRequest({
    ...clone(pickupInput),
    timeZone: 'Central Standard Time',
  }),
  /IANA time-zone/,
)

const pickupResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Pickup offered' },
  correlationId: 'wwex:pickup:SP-1001',
  response: {
    pickupDate: '2026-08-18 10:10:00',
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
        productType: 'SMALLPACK',
        pickup: {
          pickupDate: '2026-08-18',
          pickupType: 'ON_DEMAND',
          shipmentProductTransactionIdList: [smallShop.productTransactionId],
        },
      }],
    }],
  },
}
const pickup = parseWwexSmallpackSchedulePickupResponse(
  pickupPrepared,
  pickupResponse,
)
assert.equal(pickup.offers.length, 1)
assert.equal(
  pickup.offers[0].pickupOfferId,
  'fc85a46e-ccaa-4228-a3b4-2fbdda06e389',
)
assert.equal(
  pickup.offers[0].pickupProductTransactionId,
  'f6dcc8de-726e-40cf-af23-21f9bab64bac',
)
assert.equal(pickup.offers[0].pickupOfferedProductId, 'ups-on-demand-pickup-product-1')
assert.deepEqual(plain(pickup.offers[0].executingCarrier), {
  vendorId: 'UPS',
  name: 'UPS',
  scac: 'UPSN',
})
assertDeepFrozen(pickup, 'parsed SMALLPACK pickup response')
const rotatedShopPrepared = prepareWwexSmallpackShopRequest({
  ...clone(smallpackInput),
  credentialVersion: credentialVersion + 1,
})
assert.equal(rotatedShopPrepared.planHash, smallPrepared.planHash)
assert.notEqual(rotatedShopPrepared.requestHash, smallPrepared.requestHash)
const rotatedShop = parseWwexSmallpackShopResponse(
  rotatedShopPrepared,
  clone(smallResponse),
)
const rotatedPickupPrepared = prepareWwexSmallpackSchedulePickupRequest({
  ...clone(pickupInput),
  shop: rotatedShop,
})
const rotatedPickup = parseWwexSmallpackSchedulePickupResponse(
  rotatedPickupPrepared,
  clone(pickupResponse),
)
const mismatchedPickupResponse = clone(pickupResponse)
mismatchedPickupResponse.response.pickupOfferList[0]
  .offeredProductList[0].pickup.shipmentProductTransactionIdList = [
    'different-shipment-transaction',
  ]
assert.throws(
  () => parseWwexSmallpackSchedulePickupResponse(
    pickupPrepared,
    mismatchedPickupResponse,
  ),
  /not bound to the requested shipments/,
)

const billingAccount = 'WWEX-ACCOUNT-7788'
const billingAccountFingerprint = 'e'.repeat(64)
const smallTenderInput = {
  tenderPlanId: 'tender-plan:SP-1001:r1',
  shop: smallShop,
  selectedOfferId: smallShop.offers[0].offerId,
  selectedOfferedProductId: smallShop.offers[0].offeredProductId,
  pickup,
  selectedPickupOfferId: pickup.offers[0].pickupOfferId,
  selectedPickupOfferedProductId: pickup.offers[0].pickupOfferedProductId,
  billToType: 'SENDER',
  billToAccountNumber: billingAccount,
  billToAccountFingerprint: billingAccountFingerprint,
  billToPostalCode: origin.postalCode,
  billToCountryCode: origin.countryCode,
  sendersReceipt: false,
  internationalFormsPrepared: false,
  tenderedAtLocal: '2026-08-18 14:45:00',
  correlationId: 'clawpilot:tender:SP-1001:r1',
}
const smallTender = prepareWwexSmallpackTenderRequest(smallTenderInput)
const smallTenderAgain = prepareWwexSmallpackTenderRequest(clone(smallTenderInput))
const smallTenderSeal = sealPreparedWwexSpeedshipTenderRequest(smallTender)
assert.equal(smallTender.flow, 'integratedOrderFlow')
assert.equal(smallTender.path, '/svc/integratedOrderFlow')
assert.equal(smallTender.requestHash, smallTenderAgain.requestHash)
assert.equal(smallTenderSeal.requestHash, smallTender.requestHash)
assert.equal(smallTenderSeal.body, undefined)
assert.equal(smallTender.tenderPlanHash, smallTenderAgain.tenderPlanHash)
assert.equal(smallTender.body.request.orderRQList.length, 2)
assert.equal(
  smallTender.body.request.orderRQList[0].productTransactionId,
  smallShop.productTransactionId,
)
assert.equal(
  smallTender.body.request.orderRQList[1].productTransactionId,
  pickup.offers[0].pickupProductTransactionId,
)
assert.equal(smallTender.evidence.executingCarrier.vendorId, 'UPS')
assert.equal(smallTender.evidence.providerIdempotencySupported, false)
assert.equal(
  smallTender.evidence.retryDisposition,
  'outcome_unknown_requires_reconciliation',
)
assert.ok(!JSON.stringify(smallTender.evidence).includes(billingAccount))
assert.match(smallTender.evidence.billToAccountBinding, /^[a-f0-9]{64}$/)
assert.equal(smallTender.evidence.billToAccountBinding, billingAccountFingerprint)
assert.equal(smallTender.evidence.credentialVersion, credentialVersion)
assert.equal(smallTender.evidence.tenderedAtLocal, '2026-08-18 14:45:00')
assertDeepFrozen(smallTender, 'prepared SMALLPACK tender')
assertDeepFrozen(smallTenderSeal, 'sealed SMALLPACK tender')
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    pickup: rotatedPickup,
  }),
  /same credential revision/,
)
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    selectedOfferedProductId: 'not-from-the-shop-response',
  }),
  /does not belong/,
)
const tamperedSmallShop = clone(smallShop)
tamperedSmallShop.offers[0].amount = '0.01'
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    shop: tamperedSmallShop,
  }),
  /integrity check/,
)
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    tenderedAtLocal: smallShop.offers[0].expiresAt,
  }),
  /Selected shipment offer expired/,
)
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    billToAccountBinding: 'b'.repeat(64),
  }),
  /unsupported fields/,
)
const differentBillingAccountTender = prepareWwexSmallpackTenderRequest({
  ...clone(smallTenderInput),
  billToAccountNumber: 'WWEX-ACCOUNT-9900',
  billToAccountFingerprint: 'f'.repeat(64),
})
assert.notEqual(
  differentBillingAccountTender.evidence.billToAccountBinding,
  smallTender.evidence.billToAccountBinding,
)
assert.throws(
  () => prepareWwexSmallpackTenderRequest({
    ...clone(smallTenderInput),
    credentialFingerprint: 'b'.repeat(64),
  }),
  /unsupported fields/,
)
const alteredTenderCredentialEvidence = clone(smallTender)
alteredTenderCredentialEvidence.evidence.credentialVersion += 1
assert.throws(
  () => sealPreparedWwexSpeedshipTenderRequest(alteredTenderCredentialEvidence),
  /integrity check/,
)
const alteredSmallTender = clone(smallTender)
alteredSmallTender.path = '/svc/shopFlow'
assert.throws(
  () => sealPreparedWwexSpeedshipTenderRequest(alteredSmallTender),
  /integrity check/,
)

const smallTenderResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Ordered' },
  correlationId: 'wwex:tender:SP-1001',
  response: {
    pickupOrderResponse: {
      order: {
        orderId: 'pickup-order-sp-1001',
        orderedItemList: [{
          orderedItemId: 'pickup-item-sp-1001',
          pickupTxnId: 'pickup-txn-sp-1001',
        }],
      },
    },
    shipmentOrderResponse: {
      order: {
        orderId: 'shipment-order-sp-1001',
        orderedItemList: [{
          orderedItemId: 'shipment-item-sp-1001',
          secondaryTxnIdList: [{ type: 'TRACKING_ID', value: '1Z999AA10123456784' }],
          documentList: [{
            s3FileName: 'sp-1001-UPS_LABEL_ONLY.pdf',
            docType: 'UPS_LABEL_ONLY',
            docFormat: 'PDF',
            name: 'UPS shipping labels',
          }],
        }],
      },
    },
  },
}
const smallTenderResult = parseWwexSmallpackTenderResponse(
  smallTender,
  smallTenderResponse,
)
assert.equal(smallTenderResult.pickupTransactionId, 'pickup-txn-sp-1001')
assert.equal(smallTenderResult.shipmentOrderId, 'shipment-order-sp-1001')
assert.equal(smallTenderResult.quoteNumber, null)
assert.equal(smallTenderResult.secondaryTransactionIds[0].type, 'TRACKING_ID')
assert.equal(smallTenderResult.documents[0].docType, 'UPS_LABEL_ONLY')
assertDeepFrozen(smallTenderResult, 'parsed SMALLPACK tender response')

const ltlInput = {
  credentialVersion,
  credentialFingerprint,
  planId: 'shipment-plan:LTL-2001',
  correlationId: 'clawpilot:shop:LTL-2001:r1',
  shipmentDate: '2026-08-18 14:30:00',
  origin,
  destination,
  pallets: [{
    palletKey: 'pallet-1',
    length: 48,
    width: 40,
    height: 52,
    weight: 620,
    isStackable: false,
    isMixedClass: false,
    marksAndNumbers: 'PALLET-2001-1',
    commodities: [{
      commodityKey: 'commodity-1',
      commodityClass: '70',
      description: 'Packaged consumer goods',
      packagingType: 'CARTON',
      quantity: 24,
      weight: 590,
      nmfcNumber: '123456',
      nmfcDescription: 'Consumer goods, NOI',
    }],
  }],
  shipmentReferences: [{
    type: 'Shipment Reference 1',
    value: '987654321',
    isPrintAsBarCode: true,
  }],
  accessorials: {
    appointmentDelivery: true,
    liftgateDelivery: true,
    notifyBeforeDelivery: true,
    signatureRequired: false,
    sortAndSegregate: false,
    tradeshowDelivery: true,
    tradeshowDeliveryName: 'Expo Secret Booth 42',
  },
  pickupSpecialInstructions: 'Call shipping office at arrival',
  deliverySpecialInstructions: 'Delivery appointment required',
}
const ltlPrepared = prepareWwexLtlShopRequest(ltlInput)
const ltlPreparedAgain = prepareWwexLtlShopRequest(clone(ltlInput))
const ltlShopSeal = sealPreparedWwexSpeedshipShopRequest(ltlPrepared)
assert.equal(ltlPrepared.provider, 'wwex_speedship')
assert.equal(ltlPrepared.transportMode, 'ltl')
assert.equal(ltlPrepared.planHash, ltlPreparedAgain.planHash)
assert.equal(ltlPrepared.requestHash, ltlPreparedAgain.requestHash)
assert.equal(ltlShopSeal.requestHash, ltlPrepared.requestHash)
assert.equal(ltlPrepared.body.request.productType, 'LTL')
assert.equal(ltlPrepared.body.request.shipment.handlingUnitList[0].packagingType, 'PLT')
assert.equal(ltlPrepared.body.request.shipment.totalHandlingUnitCount, 1)
assert.equal(ltlPrepared.body.request.shipment.totalWeight.value, 620)
assert.equal(ltlPrepared.body.request.shipment.liftgateDeliveryFlag, true)
assert.equal(ltlPrepared.evidence.expectedExecutingCarrier, null)
assert.equal(ltlPrepared.evidence.handlingUnits[0].commodityClasses[0], '70')
assertDeepFrozen(ltlPrepared, 'prepared LTL shop plan')
assert.equal(
  prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    origin: { ...clone(origin), locationType: 'SECURED_ACCESS' },
  }).body.request.shipment.originAddress.locationType,
  'SECURED_ACCESS',
)
assert.throws(
  () => prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    origin: { ...clone(origin), locationType: 'SECURED_LOCATION' },
  }),
  /location type is not supported/,
)
const ltlEvidenceText = JSON.stringify(ltlPrepared.evidence)
for (const sensitive of [
  origin.line1,
  destination.line1,
  'Packaged consumer goods',
  'PALLET-2001-1',
  '987654321',
  'Call shipping office at arrival',
  'Expo Secret Booth 42',
]) {
  assert.ok(!ltlEvidenceText.includes(sensitive), `LTL evidence leaked ${sensitive}`)
}
assert.throws(
  () => prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    pallets: [{
      ...clone(ltlInput.pallets[0]),
      weight: 500,
    }],
  }),
  /commodity weight cannot exceed/,
)
const mixedClassPallet = {
  ...clone(ltlInput.pallets[0]),
  isMixedClass: true,
  commodities: [{
    ...clone(ltlInput.pallets[0].commodities[0]),
    weight: 300,
  }, {
    ...clone(ltlInput.pallets[0].commodities[0]),
    commodityKey: 'commodity-2',
    commodityClass: '85',
    description: 'Second packaged commodity',
    weight: 290,
  }],
}
assert.equal(
  prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    pallets: [mixedClassPallet],
  }).body.request.shipment.handlingUnitList[0].isMixedClass,
  true,
)
assert.throws(
  () => prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    pallets: [{ ...mixedClassPallet, isMixedClass: false }],
  }),
  /mixed-class flag must match/,
)
assert.throws(
  () => prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    pallets: [{
      ...clone(ltlInput.pallets[0]),
      commodities: [{
        ...clone(ltlInput.pallets[0].commodities[0]),
        commodityClass: '42',
      }],
    }],
  }),
  /valid 50-500 freight class/,
)
assert.throws(
  () => prepareWwexLtlShopRequest({
    ...clone(ltlInput),
    pickupSpecialInstructions: 'x'.repeat(61),
  }),
  /60 characters or fewer/,
)
assert.equal(
  ltlPrepared.evidence.accessorials.tradeshowDeliveryNameProvided,
  true,
)

const ltlResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Success' },
  correlationId: 'wwex:shop:LTL-2001',
  response: {
    productTransactionId: '25a39f20-77de-4423-bd45-0341c2fa8148',
    scacList: ['RLCA', 'EXLA'],
    offerList: [{
      primaryVendor: {
        vendorID: 'RLCA',
        preferredName: 'R+L Carriers',
        scac: 'RLCA',
      },
      offerId: '415cb526-7b53-434c-a384-20f0f3e24d6e',
      expirationDate: '2026-08-18 15:10:00',
      offeredProductList: [{
        offeredProductId: 'rlca-standard-product-1',
        offerPrice: { value: '287.42', unit: 'USD' },
        serviceDetail: { name: 'DEFAULT' },
        chargeItemList: [{
          customerChargeCode: 'LINEHAUL',
          chargeCodeCatagory: 'FREIGHT',
          customerDescription: 'Line haul',
          customerPrice: { value: '247.42', unit: 'USD' },
        }, {
          customerChargeCode: 'LIFTGATE_DELIVERY',
          chargeCodeCatagory: 'ACCESSORIAL',
          customerDescription: 'Liftgate delivery',
          customerPrice: { value: '40.00', unit: 'USD' },
        }],
        shopRQShipment: {
          timeInTransit: {
            serviceLevel: 'STANDARD',
            transitDays: 4,
            estimatedDeliveryDate: '2026-08-24',
          },
        },
      }],
    }, {
      primaryVendor: {
        vendorId: 'EXLA',
        preferredName: 'Estes Express Lines',
        scac: 'EXLA',
      },
      offerId: 'estes-offer-2001',
      expirationDate: '2026-08-18 15:10:00',
      offeredProductList: [{
        offeredProductId: 'estes-standard-product-1',
        offerPrice: { value: '301.11', unit: 'USD' },
        serviceDetail: { name: 'DEFAULT' },
        chargeItemList: [],
        shopRQShipment: {
          timeInTransit: {
            serviceLevel: 'STANDARD',
            transitDays: 3,
            estimatedDeliveryDate: '2026-08-21',
          },
        },
      }],
    }],
  },
}

const ltlShop = parseWwexLtlShopResponse(ltlPrepared, ltlResponse)
assert.equal(ltlShop.transportMode, 'ltl')
assert.equal(ltlShop.offers.length, 2)
assert.deepEqual(plain(ltlShop.offers[0].executingCarrier), {
  vendorId: 'RLCA',
  name: 'R+L Carriers',
  scac: 'RLCA',
})
assert.deepEqual(plain(ltlShop.offers[1].executingCarrier), {
  vendorId: 'EXLA',
  name: 'Estes Express Lines',
  scac: 'EXLA',
})
assert.equal(ltlShop.offers[0].amount, '287.42')
assert.equal(ltlShop.offers[0].charges[1].category, 'ACCESSORIAL')
assertDeepFrozen(ltlShop, 'parsed LTL shop response')

const ltlTenderInput = {
  tenderPlanId: 'tender-plan:LTL-2001:r1',
  shop: ltlShop,
  selectedOfferId: ltlShop.offers[0].offerId,
  selectedOfferedProductId: ltlShop.offers[0].offeredProductId,
  origin,
  destination,
  shipmentReferences: [{
    type: 'Shipment Reference 1',
    value: '987654321',
    isPrintAsBarCode: true,
  }],
  pickupDate: '2026-08-18 11:31:00',
  readyTime: '13:00:00',
  closeTime: '17:00:00',
  selfScheduled: false,
  internationalFormsPrepared: false,
  tenderedAtLocal: '2026-08-18 14:45:00',
  pickupSpecialInstructions: 'Use shipping dock 2',
  deliverySpecialInstructions: 'Appointment required',
  specialInstructions: 'Do not double stack',
}
const ltlTender = prepareWwexLtlTenderRequest(ltlTenderInput)
const ltlTenderAgain = prepareWwexLtlTenderRequest(clone(ltlTenderInput))
const ltlTenderSeal = sealPreparedWwexSpeedshipTenderRequest(ltlTender)
assert.equal(ltlTender.flow, 'quoteOrderFlow')
assert.equal(ltlTender.path, '/svc/quoteOrderFlow')
assert.equal(ltlTender.tenderPlanHash, ltlTenderAgain.tenderPlanHash)
assert.equal(ltlTender.requestHash, ltlTenderAgain.requestHash)
assert.equal(ltlTenderSeal.requestHash, ltlTender.requestHash)
assert.equal(
  ltlTender.body.request.shipmentProductTransactionId,
  ltlShop.productTransactionId,
)
assert.equal(ltlTender.body.request.shipmentOfferId, ltlShop.offers[0].offerId)
assert.equal(ltlTender.evidence.provider, 'wwex_speedship')
assert.deepEqual(plain(ltlTender.evidence.executingCarrier), {
  vendorId: 'RLCA',
  name: 'R+L Carriers',
  scac: 'RLCA',
})
assert.equal(ltlTender.evidence.pickupOfferId, null)
assert.equal(ltlTender.evidence.tenderedAtLocal, '2026-08-18 14:45:00')
assert.equal(ltlTender.evidence.credentialFingerprint, credentialFingerprint)
assert.equal(ltlTender.evidence.credentialVersion, credentialVersion)
assert.ok(!JSON.stringify(ltlTender.evidence).includes(origin.line1))
assertDeepFrozen(ltlTender, 'prepared LTL tender')
assert.throws(
  () => prepareWwexLtlTenderRequest({
    ...clone(ltlTenderInput),
    destination: { ...clone(destination), postalCode: '10001' },
  }),
  /full factual rated addresses/,
)
assert.throws(
  () => prepareWwexLtlTenderRequest({
    ...clone(ltlTenderInput),
    origin: { ...clone(origin), line1: '7011 S 108th St' },
  }),
  /full factual rated addresses/,
)
assert.throws(
  () => prepareWwexLtlTenderRequest({
    ...clone(ltlTenderInput),
    tenderedAtLocal: ltlShop.offers[0].expiresAt,
  }),
  /Selected LTL offer expired/,
)
assert.throws(
  () => prepareWwexLtlTenderRequest({
    ...clone(ltlTenderInput),
    readyTime: '17:00:00',
    closeTime: '13:00:00',
  }),
  /ready time must be before close time/,
)

const ltlTenderResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Booked' },
  correlationId: 'wwex:tender:LTL-2001',
  response: {
    pickupOrderResponse: {
      order: {
        orderId: 'pickup-order-ltl-2001',
        orderedItemList: [{
          orderedItemId: 'pickup-item-ltl-2001',
          pickupTxnId: 'pickup-txn-ltl-2001',
        }],
      },
    },
    shipmentOrderResponse: {
      order: {
        orderId: 'shipment-order-ltl-2001',
        quoteNumber: 'WWE12502469',
        orderedItemList: [{
          orderedItemId: 'shipment-item-ltl-2001',
          secondaryTxnIdList: [{ type: 'BILL OF LADING', value: 'WWE12502469' }],
          documentList: [{
            s3FileName: 'ltl-2001-BILL_OF_LADING.pdf',
            docType: 'BILL_OF_LADING',
            docFormat: 'PDF',
            name: 'WWEX Bill of Lading',
          }, {
            s3fileName: 'ltl-2001-PALLET_LABEL.pdf',
            docType: 'PALLET_LABEL',
            docFormat: 'PDF',
            name: 'Pallet labels',
          }],
        }],
      },
    },
  },
}
const ltlTenderResult = parseWwexLtlTenderResponse(ltlTender, ltlTenderResponse)
assert.equal(ltlTenderResult.pickupOrderId, 'pickup-order-ltl-2001')
assert.equal(ltlTenderResult.pickupTransactionId, 'pickup-txn-ltl-2001')
assert.equal(ltlTenderResult.shipmentOrderId, 'shipment-order-ltl-2001')
assert.equal(ltlTenderResult.quoteNumber, 'WWE12502469')
assert.equal(ltlTenderResult.secondaryTransactionIds[0].type, 'BILL OF LADING')
assert.equal(ltlTenderResult.documents.length, 2)
assert.equal(ltlTenderResult.evidence.tender.executingCarrier.scac, 'RLCA')
assert.match(ltlTenderResult.resultHash, /^[a-f0-9]{64}$/)
assertDeepFrozen(ltlTenderResult, 'parsed LTL tender response')
assert.throws(
  () => parseWwexLtlTenderResponse(ltlTender, {
    ...clone(ltlTenderResponse),
    response: {
      ...clone(ltlTenderResponse.response),
      shipmentOrderResponse: {
        order: {
          ...clone(ltlTenderResponse.response.shipmentOrderResponse.order),
          orderedItemList: [{
            orderedItemId: 'shipment-item-ltl-2001',
            documentList: [],
          }],
        },
      },
    },
  }),
  (error) => {
    assert.ok(error instanceof WwexSpeedshipPartialTenderOutcomeError)
    assert.equal(error.code, 'WWEX_SPEEDSHIP_PARTIAL_TENDER_OUTCOME')
    assert.deepEqual(plain(error.reconciliation.providerIds), {
      pickupOrderId: 'pickup-order-ltl-2001',
      pickupTransactionId: 'pickup-txn-ltl-2001',
      shipmentOrderId: 'shipment-order-ltl-2001',
      quoteNumber: 'WWE12502469',
    })
    assert.deepEqual(
      plain(error.reconciliation.missingRequiredEvidence),
      ['shipment_documents'],
    )
    assertDeepFrozen(error.reconciliation, 'partial WWEX tender reconciliation')
    return true
  },
)

const canadianDestination = {
  ...clone(destination),
  locality: 'Toronto',
  region: 'ON',
  postalCode: 'M5H1P6',
  countryCode: 'CA',
  residential: false,
  locationType: 'COMMERCIAL',
}
const internationalPrepared = prepareWwexLtlShopRequest({
  ...clone(ltlInput),
  planId: 'shipment-plan:LTL-INTL-1',
  correlationId: 'clawpilot:shop:LTL-INTL-1:r1',
  destination: canadianDestination,
})
assert.deepEqual(
  plain(internationalPrepared.body.request.shipment.shipmentForm),
  {
    allowPaperless: false,
    shipmentFormRequestDetails: [{
      shipmentFormName: 'CI',
      shipmentFormRequestType: 'PRINT_POPULATED',
    }, {
      shipmentFormName: 'CO',
      shipmentFormRequestType: 'PRINT_POPULATED',
    }],
  },
)
const internationalResponse = clone(ltlResponse)
internationalResponse.response.productTransactionId = 'intl-product-transaction-1'
internationalResponse.response.offerList = [clone(ltlResponse.response.offerList[0])]
internationalResponse.response.offerList[0].offerId = 'intl-offer-1'
internationalResponse.response.offerList[0].offeredProductList[0].offeredProductId = 'intl-product-1'
const internationalShop = parseWwexLtlShopResponse(
  internationalPrepared,
  internationalResponse,
)
assert.equal(internationalShop.evidence.shopRequest.isInternational, true)
assert.throws(
  () => prepareWwexLtlTenderRequest({
    ...clone(ltlTenderInput),
    tenderPlanId: 'tender-plan:LTL-INTL-1:r1',
    shop: internationalShop,
    selectedOfferId: internationalShop.offers[0].offerId,
    selectedOfferedProductId: internationalShop.offers[0].offeredProductId,
    destination: canadianDestination,
    internationalFormsPrepared: false,
  }),
  /requires prepared shipment forms/,
)

console.log('WWEX SpeedShip foundation tests passed')
