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

const operationsContract = runModule(
  'app_src/lib/operations/oneOffShipments.ts',
  (specifier) => specifier === '@/lib/operations/oneOffShipmentConstants'
    ? oneOffConstants
    : requireFromApp(specifier),
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
    if (specifier === '@/lib/operations/oneOffShipments') {
      return operationsContract
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
  OneOffShipmentPersistenceError,
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

const persistenceSource = read('app_src/lib/persistence/oneOffShipments.ts')
const routeSource = read('app_src/app/api/operations/one-off-shipments/route.ts')
const migrationSource = read('db/migrations/0258_operations_one_off_shipments.sql')
const uiSource = read('app_src/components/operations/OneOffShipmentDialog.tsx')

const commandPosition = persistenceSource.indexOf('const command = await prepareQuoteCommand')
const mutableScopePosition = persistenceSource.indexOf('resolveQuoteScope', commandPosition)
assert.ok(
  commandPosition >= 0 && mutableScopePosition > commandPosition,
  'An idempotent quote replay must be resolved before mutable scope and carrier checks',
)

for (const fragment of [
  'OPERATIONS_ONE_OFF_LIVE_RUNTIME_REQUIRED',
  "quote.executionMode === 'live' ? 'production' : 'sandbox'",
  "active.state !== 'shadow'",
  'OPERATIONS_ONE_OFF_QUOTE_STALE',
  'inventorySnapshotHash',
  "source_authority = 'clawpilot'",
  "sourceProvider: 'clawpilot_native'",
  "orderType: 'one_off'",
  'postagePurchases: 0',
  'shipmentWrites: 0',
  'labelCalls: 0',
]) {
  assert.ok(persistenceSource.includes(fragment), `One-off persistence is missing ${fragment}`)
}

assert.ok(
  (routeSource.match(/!capabilities\.canManage \|\| !capabilities\.canExecute/g) || []).length >= 2,
  'Workspace reads and mutations must both require management and execution permission',
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
