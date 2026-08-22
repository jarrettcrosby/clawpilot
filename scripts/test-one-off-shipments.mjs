#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function transpile(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
}

function runModule(path, requireModule) {
  const module = { exports: {} }
  vm.runInNewContext(transpile(path), {
    Array,
    BigInt,
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
    require: requireModule,
  }, { filename: path })
  return module.exports
}

const oneOffConstants = runModule(
  'app_src/lib/operations/oneOffShipmentConstants.ts',
  (specifier) => requireFromApp(specifier),
)

const productionLabelRuntime = runModule(
  'app_src/lib/integrations/carrierProductionLabelRuntime.ts',
  (specifier) => requireFromApp(specifier),
)

const operationsContract = runModule(
  'app_src/lib/operations/oneOffShipments.ts',
  (specifier) => {
    if (specifier === '@/lib/operations/oneOffShipmentConstants') return oneOffConstants
    if (specifier === '@/lib/integrations/carrierProductionLabelRuntime') {
      return productionLabelRuntime
    }
    return requireFromApp(specifier)
  },
)

assert.equal(
  operationsContract.oneOffRateEnvironment({
    CLAWPILOT_ENV: 'development',
    RAILWAY_ENVIRONMENT_NAME: 'development',
    RAILWAY_PROJECT_ID:
      productionLabelRuntime.CARRIER_PRODUCTION_LABEL_RAILWAY_PROJECT_ID,
    RAILWAY_SERVICE_ID:
      productionLabelRuntime.CARRIER_PRODUCTION_LABEL_RAILWAY_SERVICE_ID,
    RAILWAY_ENVIRONMENT_ID:
      productionLabelRuntime
        .CARRIER_PRODUCTION_LABEL_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
  }),
  'production',
  'Trusted Railway development must expose the production one-off carrier environment',
)
assert.equal(
  operationsContract.oneOffRateEnvironment({
    CLAWPILOT_ENV: 'development',
  }),
  'sandbox',
  'A generic local development runtime must not expose production postage',
)
assert.equal(
  operationsContract.oneOffRateEnvironment({
    CLAWPILOT_ENV: 'development',
    RAILWAY_ENVIRONMENT_NAME: 'development',
    RAILWAY_PROJECT_ID:
      productionLabelRuntime.CARRIER_PRODUCTION_LABEL_RAILWAY_PROJECT_ID,
    RAILWAY_SERVICE_ID:
      productionLabelRuntime.CARRIER_PRODUCTION_LABEL_RAILWAY_SERVICE_ID,
    RAILWAY_ENVIRONMENT_ID:
      productionLabelRuntime
        .CARRIER_PRODUCTION_LABEL_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
    VERCEL: '1',
    VERCEL_ENV: 'preview',
  }),
  'sandbox',
  'A Vercel preview must remain unable to select production postage',
)

for (const operationsState of [
  'absent', 'disabled', 'shadow', 'read_only', 'active', 'frozen',
]) {
  const readiness = operationsContract.oneOffShippingExecutionModes({
    runtimeEnvironment: 'production',
    canPurchaseLivePostage: true,
    sandboxCarrierCount: 1,
    productionCarrierCount: 1,
  })
  assert.equal(readiness[0].enabled, true, `${operationsState} must not affect TEST`)
  assert.equal(readiness[1].enabled, true, `${operationsState} must not affect LIVE`)
}
assert.equal(
  operationsContract.oneOffShippingExecutionModes({
    runtimeEnvironment: 'production',
    canPurchaseLivePostage: false,
    sandboxCarrierCount: 1,
    productionCarrierCount: 1,
  })[1].enabled,
  false,
  'LIVE must remain denied without explicit live-postage permission',
)

const clientAttempts = runModule(
  'app_src/lib/operations/oneOffShipmentClientAttempts.ts',
  (specifier) => requireFromApp(specifier),
)

const firstCreateAttempt = clientAttempts.resolveOneOffShipmentCreateAttempt({
  current: null,
  fingerprint: 'quote-1:offer-1:reason-1',
  nextIdempotencyKey: () => 'create-key-1',
})
const sameBodyRetry = clientAttempts.resolveOneOffShipmentCreateAttempt({
  current: firstCreateAttempt,
  fingerprint: 'quote-1:offer-1:reason-1',
  nextIdempotencyKey: () => 'must-not-be-used',
})
const changedBodyRetry = clientAttempts.resolveOneOffShipmentCreateAttempt({
  current: firstCreateAttempt,
  fingerprint: 'quote-1:offer-1:reason-2',
  nextIdempotencyKey: () => 'create-key-2',
})
assert.equal(sameBodyRetry.idempotencyKey, 'create-key-1')
assert.equal(changedBodyRetry.idempotencyKey, 'create-key-2')
assert.notEqual(changedBodyRetry.idempotencyKey, firstCreateAttempt.idempotencyKey)

const packageCatalog = runModule(
  'app_src/lib/operations/packageCatalog.ts',
  (specifier) => requireFromApp(specifier),
)

class CarrierIntegrationRequestError extends Error {
  constructor(message, status = 409, code = 'CARRIER_ERROR', rateEvidenceGlobalId = null) {
    super(message)
    this.status = status
    this.code = code
    this.rateEvidenceGlobalId = rateEvidenceGlobalId
  }
}

class CarrierWholeShipmentRateClientError extends Error {
  constructor(message, status = 409, code = 'CARRIER_RATE_ERROR', uncertain = false) {
    super(message)
    this.status = status
    this.code = code
    this.uncertain = uncertain
  }
}

class WwexSpeedshipClientError extends Error {
  constructor(message, status = 409, code = 'WWEX_RATE_ERROR', uncertain = false) {
    super(message)
    this.status = status
    this.code = code
    this.uncertain = uncertain
  }
}

let capturedWwexSmallpackInput = null

const persistence = runModule(
  'app_src/lib/persistence/oneOffShipments.ts',
  (specifier) => {
    if (specifier === '@/lib/auditWriter') {
      return { recordAuditEvent: async () => {} }
    }
    if (specifier === '@/lib/integrations/carrierIntegrations') {
      return {
        CarrierIntegrationRequestError,
        getCarrierIntegrationsState: async () => ({ accounts: [] }),
        testCarrierSandboxShipmentRate: async () => {
          throw new Error('Carrier access is outside the validation contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/carrierWholeShipmentRateClient') {
      return {
        CarrierWholeShipmentRateClientError,
        executeCarrierWholeShipmentRateRequest: async () => {
          throw new Error('Carrier access is outside the validation contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/carrierWholeShipmentRateFoundation') {
      return {
        prepareCarrierWholeShipmentRateRequest: () => {
          throw new Error('Carrier request preparation is outside the validation contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/brokeredTransportIntegrations') {
      return {
        getBrokeredTransportIntegrations: async () => ({ integrations: [] }),
        readActiveBrokeredTransportRuntimeCredential: async () => null,
      }
    }
    if (specifier === '@/lib/integrations/wwexSpeedshipClient') {
      return {
        WwexSpeedshipClientError,
        executeWwexSpeedshipShopRequest: async () => {
          throw new Error('Carrier access is outside the validation contract')
        },
      }
    }
    if (specifier === '@/lib/integrations/wwexSpeedshipFoundation') {
      return {
        WWEX_SPEEDSHIP_ADAPTER_VERSION: 'test-adapter',
        prepareWwexSmallpackShopRequest: (input) => {
          capturedWwexSmallpackInput = structuredClone(input)
          return { prepared: true }
        },
      }
    }
    if (specifier === '@/lib/operations/transport') {
      return {
        TRANSPORT_PLAN_CONTRACT_VERSION: 'operations.transport_plan.v1',
        loosePackagePlanHash: () => 'test-plan-hash',
        normalizeLoosePackagePlan: () => {
          throw new Error('Transport planning is outside the validation contract')
        },
        transportRequestProfileHash: () => 'test-request-profile-hash',
      }
    }
    if (specifier === '@/lib/operations/oneOffShipments') {
      return operationsContract
    }
    if (specifier === '@/lib/operations/packageCatalog') {
      return packageCatalog
    }
    if (specifier === '@/lib/persistence/crm') {
      return { stageCrmRecordWithClient: async () => ({}) }
    }
    if (specifier === '@/lib/persistence/postgres') {
      return {
        acquireTransactionAdvisoryLock: async () => {},
        query: async () => ({ rows: [] }),
        withTransaction: async () => {
          throw new Error('Postgres access is outside the validation contract')
        },
      }
    }
    if (specifier === '@/lib/persistence/productPackaging') {
      return { upsertProductPackagingProfileWithClient: async () => ({}) }
    }
    return requireFromApp(specifier)
  },
)

const {
  nextOneOffWwexShipmentDateTime,
  OneOffShipmentPersistenceError,
  prepareOneOffWwexSmallpackRateRequest,
  validateOneOffShipmentQuoteInput,
} = persistence

function validQuote() {
  return {
    executionMode: 'test',
    customerGlobalId: 'ga0000001',
    warehouseGlobalId: 'gwh0000001',
    inventoryPoolGlobalId: 'gip0000001',
    receivingLocationGlobalId: 'gwl0000001',
    referenceNumber: 'ONE-OFF-TEST-1',
    currency: 'USD',
    requestedDeliveryAt: null,
    shipFromPhone: '6175550100',
    shipToPhone: '6175550101',
    shipToResidential: false,
    selectedCarriers: [{
      provider: 'ups_rest',
      integrationAccountGlobalId: 'gia0000001',
      carrierAccountGlobalId: 'gac0000001',
    }],
    shipTo: {
      name: 'Warehouse Customer',
      line1: '100 Test Street',
      line2: null,
      city: 'Boston',
      region: 'MA',
      postalCode: '02108',
      country: 'US',
    },
    lines: [{
      kind: 'existing',
      lineKey: 'line-1',
      productGlobalId: 'gp0000001',
      quantity: 2,
    }],
    packages: [{
      packageKey: 'parcel-1',
      description: 'Physical parcel',
      dimensionsMm: { length: 300, width: 200, height: 150 },
      grossWeightGrams: 1_000,
      allocations: [{ lineKey: 'line-1', quantity: 2 }],
    }],
  }
}

const normalized = validateOneOffShipmentQuoteInput(validQuote())
assert.equal(normalized.shipTo.region, 'MA')
assert.equal(normalized.shipTo.postalCode, '02108')
assert.equal(normalized.packages[0].allocations[0].quantity, 2)
assert.equal(normalized.packages[0].packageProfile.catalogEntryId, 'custom')
assert.equal(normalized.selectedCarriers[0].provider, 'ups_rest')

const directRecipientAdHoc = validQuote()
directRecipientAdHoc.customerGlobalId = null
directRecipientAdHoc.inventoryPoolGlobalId = null
directRecipientAdHoc.receivingLocationGlobalId = null
directRecipientAdHoc.lines = [{
  kind: 'ad_hoc',
  lineKey: 'line-adhoc-1',
  name: 'Documents / paperwork',
  sku: null,
  quantity: 1,
  unitPriceMinor: 0,
  unitWeightGrams: null,
  unitDimensionsMm: null,
}]
directRecipientAdHoc.packages[0].allocations = [{
  lineKey: 'line-adhoc-1',
  quantity: 1,
}]
const normalizedAdHoc = validateOneOffShipmentQuoteInput(directRecipientAdHoc)
assert.equal(normalizedAdHoc.customerGlobalId, null)
assert.equal(normalizedAdHoc.inventoryPoolGlobalId, null)
assert.equal(normalizedAdHoc.receivingLocationGlobalId, null)
assert.equal(normalizedAdHoc.lines[0].kind, 'ad_hoc')
assert.equal(normalizedAdHoc.lines[0].unitWeightGrams, null)
assert.equal(normalizedAdHoc.lines[0].unitDimensionsMm, null)

const measuredAdHoc = structuredClone(directRecipientAdHoc)
measuredAdHoc.lines[0].unitWeightGrams = 450
measuredAdHoc.lines[0].unitDimensionsMm = { length: 220, width: 140, height: 80 }
assert.equal(
  validateOneOffShipmentQuoteInput(measuredAdHoc).lines[0].unitWeightGrams,
  450,
  'Existing factual ad-hoc unit measurements remain supported',
)

const partialAdHocMeasurements = structuredClone(directRecipientAdHoc)
partialAdHocMeasurements.lines[0].unitWeightGrams = 450
assert.throws(
  () => validateOneOffShipmentQuoteInput(partialAdHocMeasurements),
  (error) => error instanceof OneOffShipmentPersistenceError
    && error.code === 'OPERATIONS_ONE_OFF_REQUEST_INVALID',
  'Ad-hoc unit facts must be wholly present or wholly omitted',
)

const mixedMissingMeasurements = validQuote()
mixedMissingMeasurements.lines.push({
  ...structuredClone(directRecipientAdHoc.lines[0]),
  lineKey: 'line-adhoc-mixed',
})
mixedMissingMeasurements.packages[0].allocations.push({
  lineKey: 'line-adhoc-mixed',
  quantity: 1,
})
assert.throws(
  () => validateOneOffShipmentQuoteInput(mixedMissingMeasurements),
  (error) => error instanceof OneOffShipmentPersistenceError
    && error.code === 'OPERATIONS_ONE_OFF_AD_HOC_PHYSICAL_FACTS_REQUIRED',
  'Only pure productless shipments may rely solely on parcel physical facts',
)

assert.equal(
  nextOneOffWwexShipmentDateTime(new Date('2026-08-14T23:59:59.000Z')),
  '2026-08-17 10:30:00',
  'WWEX one-off rates use the next valid future weekday in SpeedShip local format',
)
const wwexQuoteInput = validQuote()
wwexQuoteInput.selectedCarriers = [{
  provider: 'wwex_speedship',
  integrationAccountGlobalId: 'gia0000003',
  carrierAccountGlobalId: null,
}]
const wwexQuote = validateOneOffShipmentQuoteInput(wwexQuoteInput)
const wwexCarrier = {
  provider: 'wwex_speedship',
  integrationAccountGlobalId: 'gia0000003',
  integrationAccountId: '11111111-1111-4111-8111-111111111113',
  carrierAccountGlobalId: null,
  carrierAccountId: null,
  credentialVersion: 7,
  displayName: 'Worldwide Express',
  senderOriginWarehouseGlobalId: 'gwh0000001',
}
prepareOneOffWwexSmallpackRateRequest({
  organizationId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'wwex-one-off-request-contract',
  carrier: wwexCarrier,
  quote: wwexQuote,
  scope: {
    warehouseAddress: {
      name: 'AG Alchemy Warehouse',
      line1: '7009 S 108th Street',
      line2: null,
      city: 'La Vista',
      region: 'NE',
      postalCode: '68128',
      country: 'US',
    },
  },
  credentialVersion: 7,
  credentialFingerprint: 'f'.repeat(64),
})
assert.match(
  capturedWwexSmallpackInput?.shipmentDate || '',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  'the actual one-off WWEX request builder must pass SpeedShip local date-time format',
)
assert.equal(capturedWwexSmallpackInput?.credentialVersion, 7)
assert.equal(capturedWwexSmallpackInput?.packages?.[0]?.packageKey, 'parcel-1')

const reorderedCarriers = validQuote()
reorderedCarriers.selectedCarriers = [
  {
    provider: 'fedex_rest',
    integrationAccountGlobalId: 'gia0000002',
    carrierAccountGlobalId: 'gac0000002',
  },
  reorderedCarriers.selectedCarriers[0],
]
assert.deepEqual(
  Array.from(
    validateOneOffShipmentQuoteInput(reorderedCarriers).selectedCarriers,
    (selection) => selection.provider,
  ),
  ['ups_rest', 'fedex_rest'],
)

const threeCarrierQuote = structuredClone(reorderedCarriers)
threeCarrierQuote.selectedCarriers.push({
  provider: 'wwex_speedship',
  integrationAccountGlobalId: 'gia0000003',
  carrierAccountGlobalId: null,
})
const canonicalThreeCarriers = validateOneOffShipmentQuoteInput(threeCarrierQuote)
assert.deepEqual(
  Array.from(canonicalThreeCarriers.selectedCarriers, (selection) => selection.provider),
  ['ups_rest', 'fedex_rest', 'wwex_speedship'],
)
const reorderedThreeCarrierQuote = structuredClone(threeCarrierQuote)
reorderedThreeCarrierQuote.selectedCarriers.reverse()
assert.equal(
  operationsContract.oneOffShipmentHash(
    validateOneOffShipmentQuoteInput(reorderedThreeCarrierQuote),
  ),
  operationsContract.oneOffShipmentHash(canonicalThreeCarriers),
  'carrier selection order must not change the canonical quote fingerprint',
)

const catalogedQuote = validQuote()
catalogedQuote.packages[0].packageProfile = {
  contractVersion: 'operations.package_catalog.v1',
  catalogEntryId: 'box',
  packageKind: 'box',
  packagingMaterialGlobalId: 'gmat0000001',
}
assert.equal(
  validateOneOffShipmentQuoteInput(catalogedQuote)
    .packages[0].packageProfile.packagingMaterialGlobalId,
  'gmat0000001',
)

function assertRequestError(mutator, code = 'OPERATIONS_ONE_OFF_REQUEST_INVALID') {
  const input = structuredClone(validQuote())
  mutator(input)
  assert.throws(
    () => validateOneOffShipmentQuoteInput(input),
    (error) => (
      error instanceof OneOffShipmentPersistenceError
      && error.code === code
    ),
  )
}

assertRequestError((input) => {
  input.shipTo.region = 'Massachusetts'
})
assertRequestError((input) => {
  input.shipTo.postalCode = '2108'
})
assertRequestError((input) => {
  input.packages[0].allocations[0].quantity = 1
}, 'OPERATIONS_ONE_OFF_PACKAGE_ALLOCATION_INVALID')
assertRequestError((input) => {
  input.lines.push({
    kind: 'existing',
    lineKey: 'line-2',
    productGlobalId: 'gp0000001',
    quantity: 1,
  })
  input.packages[0].allocations.push({ lineKey: 'line-2', quantity: 1 })
})
assertRequestError((input) => {
  input.packages[0].packageProfile = {
    contractVersion: 'operations.package_catalog.v1',
    catalogEntryId: 'pallet_48x40',
    packageKind: 'pallet',
    packagingMaterialGlobalId: null,
  }
}, 'OPERATIONS_ONE_OFF_PACKAGE_PROFILE_INVALID')
assertRequestError((input) => {
  input.selectedCarriers = []
}, 'OPERATIONS_ONE_OFF_CARRIER_SELECTION_REQUIRED')
assertRequestError((input) => {
  input.packages[0].packageKey = 'parcel one'
}, 'OPERATIONS_ONE_OFF_PACKAGE_KEY_UNSUPPORTED')
assertRequestError((input) => {
  input.packages[0].packageKey = 'parcél-1'
}, 'OPERATIONS_ONE_OFF_PACKAGE_KEY_UNSUPPORTED')
assertRequestError((input) => {
  input.selectedCarriers.push({
    provider: 'ups_rest',
    integrationAccountGlobalId: 'gia0000002',
    carrierAccountGlobalId: 'gac0000002',
  })
}, 'OPERATIONS_ONE_OFF_CARRIER_PROVIDER_DUPLICATE')
assertRequestError((input) => {
  input.packages[0].packageProfile = {
    contractVersion: 'operations.package_catalog.v1',
    catalogEntryId: 'fedex_your_packaging',
    packageKind: 'custom',
    packagingMaterialGlobalId: null,
  }
}, 'OPERATIONS_ONE_OFF_PACKAGE_SELECTION_UNSUPPORTED')
assertRequestError((input) => {
  input.selectedCarriers = [{
    provider: 'fedex_rest',
    integrationAccountGlobalId: 'gia0000002',
    carrierAccountGlobalId: 'gac0000002',
  }]
  input.packages[0].packageProfile = {
    contractVersion: 'operations.package_catalog.v1',
    catalogEntryId: 'ups_express_box_21',
    packageKind: 'box',
    packagingMaterialGlobalId: null,
  }
}, 'OPERATIONS_ONE_OFF_PACKAGE_SELECTION_UNSUPPORTED')
assertRequestError((input) => {
  input.selectedCarriers = [{
    provider: 'fedex_rest',
    integrationAccountGlobalId: 'gia0000002',
    carrierAccountGlobalId: 'gac0000002',
  }]
  input.packages = [
    {
      ...input.packages[0],
      packageKey: 'parcel-1',
      packageProfile: {
        contractVersion: 'operations.package_catalog.v1',
        catalogEntryId: 'fedex_envelope',
        packageKind: 'envelope',
        packagingMaterialGlobalId: null,
      },
      allocations: [{ lineKey: 'line-1', quantity: 1 }],
    },
    {
      ...input.packages[0],
      packageKey: 'parcel-2',
      packageProfile: {
        contractVersion: 'operations.package_catalog.v1',
        catalogEntryId: 'fedex_box',
        packageKind: 'box',
        packagingMaterialGlobalId: null,
      },
      allocations: [{ lineKey: 'line-1', quantity: 1 }],
    },
  ]
}, 'OPERATIONS_ONE_OFF_FEDEX_MIXED_PACKAGING_UNSUPPORTED')
assertRequestError((input) => {
  input.packages[0].packageProfile = {
    contractVersion: 'operations.package_catalog.v1',
    catalogEntryId: 'wwex_ups_express_box_21',
    packageKind: 'box',
    packagingMaterialGlobalId: null,
  }
}, 'OPERATIONS_ONE_OFF_PACKAGE_SELECTION_UNSUPPORTED')

const persistenceSource = read('app_src/lib/persistence/oneOffShipments.ts')
const groupPersistenceSource = read(
  'app_src/lib/persistence/operationOneOffShipping.ts',
)
const routeSource = read('app_src/app/api/operations/one-off-shipments/route.ts')
const migrationSource = read('db/migrations/0258_operations_one_off_shipments.sql')
const uiSource = read('app_src/components/operations/OneOffShipmentDialog.tsx')

const commandPosition = persistenceSource.indexOf('const command = await prepareQuoteCommand')
const mutableScopePosition = persistenceSource.indexOf('resolveQuoteScope', commandPosition)
assert.ok(
  commandPosition >= 0 && mutableScopePosition > commandPosition,
  'An idempotent quote replay must be resolved before mutable scope and carrier checks',
)
assert.match(
  persistenceSource,
  /enabledOneOffRateSources\(organizationId, undefined, 'sandbox'\)[\s\S]*enabledOneOffRateSources\(organizationId, undefined, 'production'\)/,
  'The workspace must retain both sandbox TEST and production LIVE carrier choices',
)
assert.ok(
  persistenceSource.includes('oneOffShippingExecutionModes({'),
  'Workspace readiness must use the activation-independent TEST/LIVE helper',
)
assert.match(
  groupPersistenceSource,
  /input\.executionMode === 'live'[\s\S]*resolveCarrierProductionShippingRuntime\([\s\S]*resolveCarrierSandboxShippingRuntime\(/,
  'The selected execution mode must resolve the matching production or sandbox provider runtime',
)

for (const fragment of [
  'OPERATIONS_ONE_OFF_LIVE_RUNTIME_REQUIRED',
  "quote.executionMode === 'live' ? 'production' : 'sandbox'",
  'shippingScope(client, organizationId',
  'operations_one_off_ad_hoc_order_lines',
  'operations_one_off_ad_hoc_package_contents',
  "shipmentLine.kind === 'ad_hoc'",
  'OPERATIONS_ONE_OFF_QUOTE_STALE',
  'inventorySnapshotHash',
  "source_authority = 'clawpilot'",
  "sourceProvider: 'clawpilot_native'",
  "orderType: 'one_off'",
  'postagePurchases: 0',
  'shipmentWrites: 0',
  'labelCalls: 0',
  'lockOneOffPackagingMaterialClaims',
  'FOR UPDATE OF material, stock',
  'material.tare_weight_grams, material.max_weight_grams',
  'shipmentPackage.grossWeightGrams < stock.tare_weight_grams',
  'shipmentPackage.grossWeightGrams > stock.max_weight_grams',
  "AND status = 'active'",
  'stock.on_hand_quantity - activeClaimed < quantity',
  'INSERT INTO operations_packaging_material_claims',
  'packagingMaterialClaimCount: packagingClaimInputs.length',
  'packagingStockDecremented: false',
  'OPERATIONS_ONE_OFF_RATE_ONLY_OFFER',
  'const selectedOfferCapability = await query',
  'const command = await prepareCreateCommand',
]) {
  assert.ok(persistenceSource.includes(fragment), `One-off persistence is missing ${fragment}`)
}

assert.ok(
  persistenceSource.indexOf('const selectedOfferCapability = await query')
    < persistenceSource.indexOf('const command = await prepareCreateCommand'),
  'Rate-only offers must fail before reserving a create command receipt',
)

let rateOnlyReadCount = 0
let rateOnlyTransactionCount = 0
const rateOnlyPersistence = runModule(
  'app_src/lib/persistence/oneOffShipments.ts',
  (specifier) => {
    if (specifier === '@/lib/persistence/postgres') {
      return {
        query: async () => {
          rateOnlyReadCount += 1
          return { rows: [{ provider: 'wwex_speedship' }] }
        },
        withTransaction: async () => {
          rateOnlyTransactionCount += 1
          throw new Error('A rate-only offer must not start a write transaction')
        },
        acquireTransactionAdvisoryLock: async () => {},
      }
    }
    if (specifier === '@/lib/operations/oneOffShipments') return operationsContract
    if (specifier === '@/lib/operations/packageCatalog') return packageCatalog
    if (specifier.startsWith('@/')) return {}
    return requireFromApp(specifier)
  },
)
await assert.rejects(
  rateOnlyPersistence.createAndPlanOneOffShipmentInPostgres({
    organizationId: '00000000-0000-4000-8000-000000000001',
    actorEmail: 'manager@example.test',
    idempotencyKey: 'rate-only-no-write-0001',
    quoteGlobalId: 'goq0000001',
    selectedOfferGlobalId: 'goo0000001',
    reason: 'Review comparison rate only',
  }),
  (error) => error?.code === 'OPERATIONS_ONE_OFF_RATE_ONLY_OFFER'
    && error?.status === 409,
)
assert.equal(rateOnlyReadCount, 1)
assert.equal(rateOnlyTransactionCount, 0)

const packagingClaimLockPosition = persistenceSource.indexOf(
  'const packagingClaimInputs = await lockOneOffPackagingMaterialClaims',
)

const quoteScopePosition = persistenceSource.indexOf(
  'async function resolveQuoteScope',
)
const packedRerateScopePosition = persistenceSource.indexOf(
  'const packedRerate = inventoryReservationOrderGlobalId',
  quoteScopePosition,
)
const quoteActiveClaimPosition = persistenceSource.indexOf(
  'const activeClaims = selectedMaterials.rows.length',
  quoteScopePosition,
)
assert.ok(
  packedRerateScopePosition > quoteScopePosition
    && quoteActiveClaimPosition > packedRerateScopePosition
    && persistenceSource.includes(
      'AND ($4::uuid IS NULL OR plan_id <> $4::uuid)',
    ),
  'Packed rerating must establish its exact plan before excluding only that plan own packaging claim from availability',
)
const oneOffProductWritePosition = persistenceSource.indexOf(
  'const existingProducts = new Map',
  packagingClaimLockPosition,
)
const oneOffPlanWritePosition = persistenceSource.indexOf(
  '`INSERT INTO operations_fulfillment_plans (',
  packagingClaimLockPosition,
)
const packagingClaimWritePosition = persistenceSource.indexOf(
  '`INSERT INTO operations_packaging_material_claims (',
  oneOffPlanWritePosition,
)
assert.ok(
  packagingClaimLockPosition >= 0
    && oneOffProductWritePosition > packagingClaimLockPosition
    && oneOffPlanWritePosition > oneOffProductWritePosition
    && packagingClaimWritePosition > oneOffPlanWritePosition,
  'One-off creation must lock/revalidate packaging before product/order writes and claim it immediately after creating the plan',
)

assert.ok(
  (routeSource.match(/!capabilities\.canCreate/g) || []).length >= 2,
  'Workspace reads and mutations must both require Shipping creation permission',
)
assert.doesNotMatch(
  routeSource,
  /operationsCapabilities|canManage|canExecute/,
  'One-off routes must not depend on Operations capabilities',
)
assert.match(
  routeSource,
  /executionMode === 'live' && !capabilities\.canPurchaseLivePostage/,
  'LIVE actions must require the independent live-postage capability',
)

for (const fragment of [
  'operations_carrier_rate_requests_org_global_unique',
  'FOREIGN KEY (organization_id, rate_evidence_global_id)',
  "evidence.purpose = 'cartonization_shipment_rate'",
  "evidence.status = 'succeeded'",
  'validate_operations_one_off_quote_seal',
  'DEFERRABLE INITIALLY DEFERRED',
  "'one_off'",
]) {
  assert.ok(migrationSource.includes(fragment), `One-off migration is missing ${fragment}`)
}

for (const fragment of [
  'quoteIdempotencyKey',
  "payload.code === 'OPERATIONS_COMMAND_EXPIRED'",
  'Retry current rates',
]) {
  assert.ok(uiSource.includes(fragment), `One-off UI is missing ${fragment}`)
}

console.log('one-off shipment contract tests passed')
