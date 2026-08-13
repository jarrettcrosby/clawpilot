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

function load(path) {
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
  assert.deepEqual(errors, [], `${path} must transpile without syntax errors`)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    Array,
    Boolean,
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
    Set,
    String,
    console,
    exports: module.exports,
    module,
    process,
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

const catalog = load('app_src/lib/operations/packageCatalog.ts')
const wwex = load('app_src/lib/integrations/wwexSpeedshipFoundation.ts')

const {
  packageProviderCode,
  packageCatalogEntry,
} = catalog
const {
  parseWwexLtlShopResponse,
  parseWwexSmallpackShopResponse,
  prepareWwexLtlShopRequest,
  prepareWwexSmallpackShopRequest,
  sealPreparedWwexSpeedshipShopRequest,
} = wwex

// This complete fixture exists only in this process. It deliberately mirrors
// AG Alchemy's known sandbox warehouse identity but never opens Postgres,
// starts the app, reads credentials, or performs provider I/O.
const fixture = Object.freeze({
  fixtureId: 'ag-alchemy-wwex-shipping-sandbox-regression-v1',
  organization: Object.freeze({
    name: 'AG Alchemy, LLC',
    environment: 'sandbox',
  }),
  warehouse: Object.freeze({
    globalId: 'gwh5366613',
    code: 'AG-ALCHEMY-01',
    name: 'AG Alchemy mock shipping warehouse',
    address: Object.freeze({
      line1: '7009 S 108th St',
      line2: null,
      locality: 'La Vista',
      region: 'NE',
      postalCode: '68128',
      countryCode: 'US',
      companyName: 'AG Alchemy Warehouse',
      phone: '4025550100',
      contact: Object.freeze({
        firstName: 'Alex',
        lastName: 'Warehouse',
        phone: '4025550100',
        email: 'warehouse@example.test',
      }),
      residential: false,
      locationType: 'COMMERCIAL',
    }),
  }),
  destination: Object.freeze({
    line1: '35 Saxony Drive',
    line2: null,
    locality: 'Trumbull',
    region: 'CT',
    postalCode: '06611',
    countryCode: 'US',
    companyName: 'AG Alchemy mock customer',
    phone: '2035550101',
    contact: Object.freeze({
      firstName: 'Jamie',
      lastName: 'Receiver',
      phone: '2035550101',
      email: 'receiver@example.test',
    }),
    residential: true,
    locationType: 'RESIDENTIAL',
  }),
  inventory: Object.freeze([
    Object.freeze({
      productGlobalId: 'gp0001001',
      sku: 'MOCK-BOXED-GOODS',
      availableQuantity: 24,
      unitWeightGrams: 11_340,
    }),
    Object.freeze({
      productGlobalId: 'gp0001002',
      sku: 'MOCK-MAILED-GOODS',
      availableQuantity: 4,
      unitWeightGrams: 1_814,
    }),
  ]),
  orders: Object.freeze([
    Object.freeze({
      orderGlobalId: 'gor0001001',
      referenceNumber: 'AG-MOCK-WWEX-PARCEL-1',
      transportMode: 'small_parcel',
      packages: Object.freeze([
        Object.freeze({
          packageKey: 'mock-box-1',
          catalogEntryId: 'box',
          dimensionsIn: Object.freeze({ length: 18, width: 13, height: 9 }),
          weightLb: 22,
        }),
        Object.freeze({
          packageKey: 'mock-envelope-1',
          catalogEntryId: 'envelope',
          dimensionsIn: Object.freeze({ length: 14, width: 10, height: 3 }),
          weightLb: 4,
        }),
      ]),
    }),
    Object.freeze({
      orderGlobalId: 'gor0001002',
      referenceNumber: 'AG-MOCK-WWEX-LTL-1',
      transportMode: 'ltl',
      pallet: Object.freeze({
        palletKey: 'mock-pallet-48x40-1',
        catalogEntryId: 'pallet_48x40',
        heightIn: 52,
        weightLb: 620,
        cartonCount: 24,
        commodityWeightLb: 590,
      }),
    }),
  ]),
})

assert.equal(fixture.organization.environment, 'sandbox')
assert.equal(fixture.warehouse.code, 'AG-ALCHEMY-01')
assert.equal(fixture.inventory.reduce(
  (sum, item) => sum + item.availableQuantity,
  0,
), 28)

const shippingSource = read('app_src/components/shipping/ShippingSection.tsx')
const parcelSource = read('app_src/components/operations/OneOffShipmentDialog.tsx')
const ltlSource = read('app_src/components/operations/LtlFreightClassAssessmentPanel.tsx')
const settingsSource = read('app_src/components/settings/IntegrationSettingsPanel.tsx')
for (const fragment of [
  'data-testid="shipping-mode-selector"',
  'aria-label="Shipment type"',
  'minHeight: 44',
  '<ToggleButton data-testid="shipping-mode-parcel" value="parcel">',
  '<ToggleButton data-testid="shipping-mode-ltl" value="ltl">',
]) {
  assert.ok(shippingSource.includes(fragment), `Shipping mode visibility is missing ${fragment}`)
}
for (const forbidden of [
  'catalog reference',
  'Worldwide Express catalog',
  'R+L confirmed',
  'provider packaging code',
]) {
  assert.ok(
    !shippingSource.includes(forbidden),
    `Shipping must not expose internal catalog attribution: ${forbidden}`,
  )
}
assert.ok(
  parcelSource.includes('data-testid={`parcel-package-profile-${packageIndex + 1}`}'),
  'Parcel package dropdown is not screenshot-addressable',
)
assert.ok(
  ltlSource.includes('data-testid="ltl-handling-unit-select"'),
  'LTL pallet dropdown is not screenshot-addressable',
)
assert.ok(
  ltlSource.includes("packageCatalogEntries({\n  usage: 'ltl_handling_unit'"),
  'Preparation-only LTL selector must contain only canonical handling units',
)
assert.ok(
  settingsSource.includes('data-testid="shipping-integration-capability-tabs"'),
  'Shipping capability tabs are not screenshot-addressable',
)

for (const entryId of ['box', 'envelope', 'tube', 'crate', 'custom']) {
  assert.equal(packageProviderCode({
    catalogEntryId: entryId,
    provider: 'wwex_speedship',
    usage: 'small_parcel_package',
  }), '02')
}
assert.equal(packageProviderCode({
  catalogEntryId: 'pallet_48x40',
  provider: 'wwex_speedship',
  usage: 'ltl_handling_unit',
}), 'PLT')
assert.equal(packageProviderCode({
  catalogEntryId: 'box',
  provider: 'wwex_speedship',
  usage: 'ltl_commodity',
}), 'CARTON')

const credentialVersion = 1
const credentialFingerprint = 'a'.repeat(64)
const parcelOrder = fixture.orders[0]
const parcelInput = {
  credentialVersion,
  credentialFingerprint,
  planId: `mock:${parcelOrder.orderGlobalId}:plan:1`,
  correlationId: `mock:${parcelOrder.referenceNumber}:rate:1`,
  shipmentDate: '2026-08-18 14:30:00',
  shipmentDescription: 'AG Alchemy in-memory sandbox parcel regression',
  origin: { ...clone(fixture.warehouse.address), locationType: 'OTHER' },
  destination: clone(fixture.destination),
  packages: parcelOrder.packages.map((item) => ({
    packageKey: item.packageKey,
    packagingType: packageProviderCode({
      catalogEntryId: item.catalogEntryId,
      provider: 'wwex_speedship',
      usage: 'small_parcel_package',
    }),
    length: item.dimensionsIn.length,
    width: item.dimensionsIn.width,
    height: item.dimensionsIn.height,
    weight: item.weightLb,
  })),
  deliveryConfirmation: false,
  carbonNeutral: false,
  adultSignatureRequired: false,
  signatureRequired: false,
  shipperRelease: false,
  selfScheduled: false,
  returnLabel: false,
  returnServiceType: null,
}
const parcelPrepared = prepareWwexSmallpackShopRequest(parcelInput)
const parcelReplay = prepareWwexSmallpackShopRequest(clone(parcelInput))
assert.equal(parcelPrepared.transportMode, 'small_parcel')
assert.equal(parcelPrepared.accessMode, 'prepare_only')
assert.equal(parcelPrepared.providerMutationCount, 0)
assert.equal(parcelPrepared.requestHash, parcelReplay.requestHash)
assert.equal(parcelPrepared.planHash, parcelReplay.planHash)
assert.equal(
  parcelPrepared.body.request.shipment.handlingUnitList.every(
    (item) => item.packagingType === '02' && item.packagingTypeName === 'Custom',
  ),
  true,
)
assert.equal(
  sealPreparedWwexSpeedshipShopRequest(parcelPrepared).body,
  undefined,
)

const parcelRateResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Recorded sandbox success' },
  correlationId: 'mock:wwex:parcel:rate:1',
  response: {
    productTransactionId: 'mock-parcel-transaction-1',
    offerList: [{
      primaryVendor: {
        vendorId: 'UPS',
        preferredName: 'United Parcel Service',
        scac: 'UPSN',
      },
      offerId: 'mock-parcel-offer-1',
      expirationDate: '2026-08-18 15:00:00',
      offeredProductList: [{
        offeredProductId: 'mock-ups-ground-1',
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
const parcelRates = parseWwexSmallpackShopResponse(
  parcelPrepared,
  parcelRateResponse,
)
const parcelRatesReplay = parseWwexSmallpackShopResponse(
  parcelReplay,
  clone(parcelRateResponse),
)
assert.equal(parcelRates.resultHash, parcelRatesReplay.resultHash)
assert.equal(parcelRates.offers[0].amount, '48.25')
assert.equal(parcelRates.offers[0].executingCarrier.vendorId, 'UPS')

const ltlOrder = fixture.orders[1]
const palletEntry = packageCatalogEntry(ltlOrder.pallet.catalogEntryId)
assert.ok(palletEntry)
const ltlInput = {
  credentialVersion,
  credentialFingerprint,
  planId: `mock:${ltlOrder.orderGlobalId}:plan:1`,
  correlationId: `mock:${ltlOrder.referenceNumber}:rate:1`,
  shipmentDate: '2026-08-18 14:30:00',
  origin: clone(fixture.warehouse.address),
  destination: clone(fixture.destination),
  pallets: [{
    palletKey: ltlOrder.pallet.palletKey,
    length: Math.round(palletEntry.defaultDimensionsMm.length / 25.4),
    width: Math.round(palletEntry.defaultDimensionsMm.width / 25.4),
    height: ltlOrder.pallet.heightIn,
    weight: ltlOrder.pallet.weightLb,
    isStackable: false,
    isMixedClass: false,
    commodities: [{
      commodityKey: 'mock-carton-commodity-1',
      commodityClass: '70',
      description: 'Mock boxed consumer goods',
      packagingType: packageProviderCode({
        catalogEntryId: 'box',
        provider: 'wwex_speedship',
        usage: 'ltl_commodity',
      }),
      quantity: ltlOrder.pallet.cartonCount,
      weight: ltlOrder.pallet.commodityWeightLb,
    }],
  }],
  accessorials: {
    liftgateDelivery: true,
  },
}
const ltlPrepared = prepareWwexLtlShopRequest(ltlInput)
const ltlReplay = prepareWwexLtlShopRequest(clone(ltlInput))
assert.equal(ltlPrepared.transportMode, 'ltl')
assert.equal(ltlPrepared.accessMode, 'prepare_only')
assert.equal(ltlPrepared.providerMutationCount, 0)
assert.equal(ltlPrepared.requestHash, ltlReplay.requestHash)
assert.equal(ltlPrepared.planHash, ltlReplay.planHash)
assert.equal(
  ltlPrepared.body.request.shipment.handlingUnitList[0].packagingType,
  'PLT',
)
assert.equal(
  ltlPrepared.body.request.shipment.handlingUnitList[0]
    .shippedItemList[0].packagingType,
  'CARTON',
)

const ltlRateResponse = {
  apiVersion: '1.9b',
  clientStatus: { success: true, message: 'Recorded sandbox success' },
  correlationId: 'mock:wwex:ltl:rate:1',
  response: {
    productTransactionId: 'mock-ltl-transaction-1',
    scacList: ['RLCA'],
    offerList: [{
      primaryVendor: {
        vendorID: 'RLCA',
        preferredName: 'R+L Carriers',
        scac: 'RLCA',
      },
      offerId: 'mock-ltl-offer-1',
      expirationDate: '2026-08-18 15:10:00',
      offeredProductList: [{
        offeredProductId: 'mock-rlca-standard-1',
        offerPrice: { value: '287.42', unit: 'USD' },
        serviceDetail: { name: 'DEFAULT' },
        chargeItemList: [],
        shopRQShipment: {
          timeInTransit: {
            serviceLevel: 'STANDARD',
            transitDays: 4,
            estimatedDeliveryDate: '2026-08-24',
          },
        },
      }],
    }],
  },
}
const ltlRates = parseWwexLtlShopResponse(ltlPrepared, ltlRateResponse)
const ltlRatesReplay = parseWwexLtlShopResponse(
  ltlReplay,
  clone(ltlRateResponse),
)
assert.equal(ltlRates.resultHash, ltlRatesReplay.resultHash)
assert.equal(ltlRates.offers[0].amount, '287.42')
assert.equal(ltlRates.offers[0].executingCarrier.scac, 'RLCA')

const changedParcelInput = clone(parcelInput)
changedParcelInput.packages[0].weight += 1
assert.notEqual(
  prepareWwexSmallpackShopRequest(changedParcelInput).requestHash,
  parcelPrepared.requestHash,
  'A changed physical package must not replay under the prior request hash',
)
assert.throws(() => packageProviderCode({
  catalogEntryId: 'pallet_48x40',
  provider: 'wwex_speedship',
  usage: 'small_parcel_package',
}), /PACKAGE_CATALOG_USAGE_UNSUPPORTED/)
assert.throws(() => packageProviderCode({
  catalogEntryId: 'crate',
  provider: 'rl_carriers',
  usage: 'ltl_commodity',
}), /PACKAGE_CATALOG_PROVIDER_MAPPING_UNSUPPORTED/)
assert.throws(() => prepareWwexSmallpackShopRequest({
  ...clone(parcelInput),
  packages: [{
    ...clone(parcelInput.packages[0]),
    packagingType: '99',
  }],
}), /packaging type is not supported/)
assert.throws(() => prepareWwexLtlShopRequest({
  ...clone(ltlInput),
  pallets: [{
    ...clone(ltlInput.pallets[0]),
    weight: 500,
  }],
}), /commodity weight cannot exceed gross pallet weight/)
assert.throws(() => parseWwexSmallpackShopResponse(parcelPrepared, {
  ...clone(parcelRateResponse),
  clientStatus: { success: false, message: 'Recorded sandbox failure' },
}), /reported failure/)

const foundationSource = read(
  'app_src/lib/integrations/wwexSpeedshipFoundation.ts',
)
assert.doesNotMatch(foundationSource, /\bfetch\s*\(/)
assert.equal(parcelPrepared.flow, 'shopFlow')
assert.equal(ltlPrepared.flow, 'shopFlow')
for (const prepared of [parcelPrepared, ltlPrepared]) {
  assert.equal(prepared.providerMutationCount, 0)
  assert.equal(prepared.accessMode, 'prepare_only')
  assert.ok(!Object.hasOwn(prepared, 'charge'))
  assert.ok(!Object.hasOwn(prepared, 'label'))
  assert.ok(!Object.hasOwn(prepared, 'pickup'))
  assert.ok(!Object.hasOwn(prepared, 'billOfLading'))
}

const evidence = Object.freeze({
  fixtureId: fixture.fixtureId,
  organization: fixture.organization.name,
  warehouseCode: fixture.warehouse.code,
  inventoryRows: fixture.inventory.length,
  mockOrders: fixture.orders.length,
  parcelRequestHash: parcelPrepared.requestHash,
  parcelResultHash: parcelRates.resultHash,
  ltlRequestHash: ltlPrepared.requestHash,
  ltlResultHash: ltlRates.resultHash,
  providerNetworkCalls: 0,
  providerMutations: 0,
  databaseConnections: 0,
  durableRowsCreated: 0,
  liveTenders: 0,
  liveCharges: 0,
  labels: 0,
  pickups: 0,
  cleanup: 'Process-local fixture only; process exit releases all fixture state.',
  screenshotSelectors: Object.freeze([
    '[data-testid="shipping-mode-selector"]',
    '[data-testid="parcel-package-profile-1"]',
    '[data-testid="ltl-handling-unit-select"]',
    '[data-testid="shipping-integration-capability-tabs"]',
  ]),
})

console.log('Worldwide Express AG Alchemy hermetic Shipping regression passed.')
console.log(JSON.stringify(evidence))
