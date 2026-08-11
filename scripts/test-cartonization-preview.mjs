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

function loadFulfillmentContract() {
  const path = 'app_src/lib/operations/fulfillmentOptimizerContract.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Array,
    BigInt,
    Boolean,
    Buffer,
    Date,
    Error,
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
    require: requireFromApp,
  }, { filename: path })
  return module.exports
}

const fulfillmentContract = loadFulfillmentContract()
let capturedOptimizerInput = null

function loadDomain() {
  const path = 'app_src/lib/operations/cartonizationPreview.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const domainFulfillmentContract = {
    ...fulfillmentContract,
    validateFulfillmentOptimizationInput(value) {
      capturedOptimizerInput = value
      fulfillmentContract.validateFulfillmentOptimizationInput(value)
    },
  }
  const requireModule = (specifier) => {
    if (specifier === '@/lib/operations/fulfillmentOptimizerContract') {
      return domainFulfillmentContract
    }
    return requireFromApp(specifier)
  }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Date,
    Error,
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
    require: requireModule,
  }, { filename: path })
  return module.exports
}

function loadPersistence({
  mappingRows = [{
    id: '55555555-5555-4555-8555-555555555555',
    warehouse_id: '44444444-4444-4444-8444-444444444444',
  }],
  carrierConfigRows = [{
    warehouse_id: '44444444-4444-4444-8444-444444444444',
  }],
  warehouseRows = [{
    id: '44444444-4444-4444-8444-444444444444',
    global_id: 'gwh0000001',
    name: 'AG Alchemy',
  }],
} = {}) {
  const path = 'app_src/lib/persistence/cartonizationPreview.ts'
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (
        sql.startsWith('BEGIN')
        || sql === 'COMMIT'
        || sql === 'ROLLBACK'
      ) return { rowCount: 0, rows: [] }
      if (sql.includes('transaction_timestamp() AS read_at')) {
        return {
          rowCount: 1,
          rows: [{ read_at: '2026-08-10T21:00:00.000Z' }],
        }
      }
      if (sql.includes('FROM operations_integration_accounts account')) {
        return {
          rowCount: 1,
          rows: [{
            integration_account_id:
              '22222222-2222-4222-8222-222222222222',
            organization_global_id: 'go0000001',
            global_id: 'gia0000001',
            provider: 'shopify',
            status: 'active',
            activation_state: 'shadow',
            data_pipeline_id: null,
          }],
        }
      }
      if (sql.includes('FROM operations_commerce_order_candidates candidate')) {
        return {
          rowCount: 1,
          rows: [{
            order_candidate_id:
              '33333333-3333-4333-8333-333333333333',
            global_id: 'gcoc0000001',
            order_number_snapshot: '#6603',
            source_hash: 'a'.repeat(64),
            row_version: '3',
            workflow_state: 'ready',
            currency_code: 'USD',
            requires_shipping: true,
            expires_at: '2026-08-30T21:00:00.000Z',
          }],
        }
      }
      if (sql.includes('FROM operations_warehouses warehouse')) {
        assert.ok(
          sql.includes('warehouse.global_id = $2'),
          'Fit preview must query the exact selected warehouse',
        )
        return { rowCount: warehouseRows.length, rows: warehouseRows }
      }
      if (sql.includes(
        'FROM operations_commerce_inventory_location_mappings mapping',
      )) {
        return { rowCount: mappingRows.length, rows: mappingRows }
      }
      if (sql.includes(
        'FROM operations_shopify_carrier_service_configs config',
      )) {
        return {
          rowCount: carrierConfigRows.length,
          rows: carrierConfigRows,
        }
      }
      if (sql.includes(
        'FROM operations_commerce_order_candidate_lines line',
      )) {
        return {
          rowCount: 1,
          rows: [{
            global_id: 'gcol0000001',
            product_title_snapshot: 'Test Product',
            requires_shipping: true,
            unfulfilled_quantity: '1',
            mapping_state: 'resolved',
            packaging_state: 'resolved',
            product_global_id: 'gp0000001',
            weight_grams: 200,
            length_mm: 100,
            width_mm: 80,
            height_mm: 40,
            packaging_source: 'manual',
            packaging_weight_source: 'manual',
            commerce_variant_pack_mapping_global_id: null,
            commerce_variant_pack_mapping_row_version: null,
            pack_profile_version_global_id: null,
            pack_profile_version_row_version: null,
            pack_profile_package_level: null,
            pack_profile_base_each_quantity: null,
          }],
        }
      }
      if (sql.includes('FROM operations_commerce_inventory_sync_runs run')) {
        return {
          rowCount: 1,
          rows: [{
            sync_run_id: '66666666-6666-4666-8666-666666666666',
            global_id: 'gisr0000001',
            warehouse_global_id: 'gwh0000001',
            provider_fetched_at: '2026-08-10T20:55:00.000Z',
            completed_at: '2026-08-10T20:56:00.000Z',
          }],
        }
      }
      if (sql.includes('FROM operations_commerce_inventory_levels level')) {
        return {
          rowCount: 1,
          rows: [{
            position_global_id: 'giv0000001',
            warehouse_global_id: 'gwh0000001',
            product_global_id: 'gp0000001',
            atp_quantity: '1',
            provider_committed_quantity: '1',
            source_level_global_ids: ['giil0000001'],
          }],
        }
      }
      if (sql.includes('FROM operations_packaging_materials material')) {
        return {
          rowCount: 1,
          rows: [{
            global_id: 'gmat0000001',
            name: 'Small carton',
            material_type: 'carton',
            status: 'active',
            inner_length_mm: 250,
            inner_width_mm: 200,
            inner_height_mm: 150,
            tare_weight_grams: 120,
            max_weight_grams: 10_000,
            unit_cost_minor: '55',
            currency: 'USD',
            row_version: '1',
            stock_warehouse_global_id: 'gwh0000001',
            stock_warehouse_status: 'active',
            stock_is_available: true,
            stock_on_hand_quantity: 20,
            stock_row_version: '1',
          }],
        }
      }
      assert.fail(`Unexpected cartonization preview query: ${sql}`)
    },
    release() {},
  }
  const requireModule = (specifier) => {
    if (specifier === '@/lib/persistence/postgres') {
      return {
        getPostgresPool: () => ({
          connect: async () => client,
        }),
      }
    }
    return requireFromApp(specifier)
  }
  vm.runInNewContext(output, {
    Array,
    Boolean,
    Date,
    Error,
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
    require: requireModule,
  }, { filename: path })
  return { loaded: module.exports, queries }
}

const {
  createCartonizationPreview,
  normalizeCartonizationPreviewRequest,
} = loadDomain()

const request = {
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  expectedCandidateRowVersion: 3,
  warehouseGlobalId: 'gwh0000001',
  materialGlobalIds: ['gmat0000001'],
  assumedCommittedByLine: [],
}

const snapshot = {
  readAtUtc: '2026-07-28T12:00:00.000Z',
  organization: {
    globalId: 'go0000001',
  },
  account: {
    globalId: 'gia0000001',
    provider: 'shopify',
    status: 'active',
    activationState: 'shadow',
  },
  candidate: {
    globalId: 'gcoc0000001',
    orderNumber: '#6538',
    sourceHash: 'a'.repeat(64),
    rowVersion: 3,
    workflowState: 'ready',
    currency: 'USD',
    requiresShipping: true,
    expiresAt: '2026-08-28T12:00:00.000Z',
  },
  lines: [{
    globalId: 'gcol0000001',
    title: 'Measured product',
    requiresShipping: true,
    quantity: 2,
    mappingState: 'resolved',
    packagingState: 'resolved',
    productGlobalId: 'gp0000001',
    weightGrams: 200,
    dimensionsMm: {
      length: 100,
      width: 80,
      height: 40,
    },
    packEvidence: null,
  }],
  activeWarehouses: [{
    globalId: 'gwh0000001',
    name: 'AG Alchemy',
  }, {
    globalId: 'gwh0000002',
    name: 'Proof warehouse',
  }],
  latestInventoryRun: {
    globalId: 'gisr0000001',
    warehouseGlobalId: 'gwh0000001',
    providerFetchedAt: '2026-07-28T11:55:00.000Z',
    completedAt: '2026-07-28T11:56:00.000Z',
  },
  inventoryPositions: [{
    positionGlobalId: 'giv0000001',
    warehouseGlobalId: 'gwh0000001',
    productGlobalId: 'gp0000001',
    atpQuantity: 2,
    providerCommittedQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
  }],
  selectedMaterials: [{
    globalId: 'gmat0000001',
    name: 'Small carton',
    materialType: 'carton',
    status: 'active',
    innerDimensionsMm: {
      length: 250,
      width: 200,
      height: 150,
    },
    tareWeightGrams: 120,
    maxWeightGrams: 10_000,
    unitCostMinor: 55,
    currency: 'USD',
    rowVersion: 1,
    stock: [{
      warehouseGlobalId: 'gwh0000001',
      warehouseStatus: 'active',
      isAvailable: true,
      onHandQuantity: 20,
      rowVersion: 1,
    }],
  }],
}

const normalized = normalizeCartonizationPreviewRequest(request)
assert.equal(normalized.expectedCandidateRowVersion, 3)
assert.equal(normalized.warehouseGlobalId, 'gwh0000001')
assert.deepEqual(
  Array.from(normalized.materialGlobalIds),
  ['gmat0000001'],
)
assert.throws(
  () => normalizeCartonizationPreviewRequest({
    ...request,
    expectedCandidateRowVersion: '3',
  }),
  /Expected candidate row version is invalid/,
)
assert.throws(
  () => normalizeCartonizationPreviewRequest({
    ...request,
    warehouseGlobalId: 'gwh-invalid',
  }),
  /Warehouse Global ID is invalid/,
)
assert.throws(
  () => normalizeCartonizationPreviewRequest({
    ...request,
    materialGlobalIds: [],
  }),
  /Select between one and eight packaging materials/,
)
assert.throws(
  () => normalizeCartonizationPreviewRequest({
    ...request,
    materialGlobalIds: ['gmat0000001', 'gmat0000001'],
  }),
  /must be unique/,
)
assert.throws(
  () => normalizeCartonizationPreviewRequest({
    ...request,
    assumedCommittedByLine: null,
  }),
  /must be supplied as an array/,
)

function validSelectedPlan() {
  return {
    planId: 'plan-preview-1',
    warehouseGlobalIds: ['gwh0000001'],
    warehouseCount: 1,
    shipmentCount: 1,
    cartonCount: 1,
    estimatedTotalCostMinor: 55,
    unusedVolumeMm3: 6_860_000,
    packages: [{
      packageKey: 'package-preview-1',
      warehouseGlobalId: 'gwh0000001',
      cartonGlobalId: 'gmat0000001',
      innerDimensionsMm: {
        length: 250,
        width: 200,
        height: 150,
      },
      maxWeightGrams: 10_000,
      emptyWeightGrams: 120,
      totalWeightGrams: 520,
      usedVolumeMm3: 640_000,
      unusedVolumeMm3: 6_860_000,
      estimatedCostMinor: 55,
      allocations: [{
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        quantity: 2,
      }],
      placements: [{
        unitKey: 'unit-preview-1',
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        dimensionsMm: {
          length: 100,
          width: 80,
          height: 40,
        },
        coordinatesMm: { x: 0, y: 0, z: 0 },
      }, {
        unitKey: 'unit-preview-2',
        lineGlobalId: 'gcol0000001',
        productGlobalId: 'gp0000001',
        positionGlobalId: 'giv0000001',
        dimensionsMm: {
          length: 100,
          width: 80,
          height: 40,
        },
        coordinatesMm: { x: 100, y: 0, z: 0 },
      }],
    }],
  }
}

function validOptimizerResult(
  input,
  options,
  {
    status = 'optimal',
    method = 'or_tools',
  } = {},
) {
  const selectedPlan = ['optimal', 'feasible'].includes(status)
    ? validSelectedPlan()
    : null
  const inputHash = fulfillmentContract.canonicalOptimizerHash(input)
  return fulfillmentContract.parseFulfillmentOptimizationResult({
    schemaVersion: 1,
    status,
    method,
    algorithmVersion: 'test-or-tools-v1',
    inputHash,
    durationMs: 1,
    selectedPlan,
    candidates: selectedPlan ? [selectedPlan] : [],
    rejectedAlternatives: [],
    fallbackReason: method === 'or_tools' ? null : 'test_fallback',
    explanation: [],
  }, input, options, inputHash)
}
const ready = await createCartonizationPreview({
  request: normalized,
  snapshot,
  optimizer: {
    async optimize(input, options) {
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(ready.status, 'ready')
assert.equal(ready.readOnly, true)
assert.equal(ready.optimizer?.method, 'or_tools')
assert.equal(ready.optimizer?.selectedPlan?.shipmentCount, 1)
assert.equal(ready.optimizer?.selectedPlan?.cartonCount, 1)
assert.equal(ready.optimizer?.selectedPlan?.packages.length, 1)
assert.equal(ready.warehouse?.globalId, 'gwh0000001')
assert.equal(
  ready.optimizer?.selectedPlan?.packages[0].allocations[0].quantity,
  2,
)
let unavailableWarehouseOptimizerCalled = false
const unavailableWarehouse = await createCartonizationPreview({
  request: {
    ...normalized,
    warehouseGlobalId: 'gwh0000003',
  },
  snapshot,
  optimizer: {
    async optimize(input, options) {
      unavailableWarehouseOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(unavailableWarehouse.status, 'blocked')
assert.equal(unavailableWarehouseOptimizerCalled, false)
assert.ok(unavailableWarehouse.blockers.some((item) => (
  item.code === 'CARTONIZATION_SELECTED_WAREHOUSE_UNAVAILABLE'
)))
assert.deepEqual(
  JSON.parse(JSON.stringify(ready.evidence)),
  {
    databaseWrites: 0,
    providerWrites: 0,
    rateCalls: 0,
    labelCalls: 0,
    shipmentWrites: 0,
    transportCostBasis: 'excluded_from_read_only_preview',
    warehouseHandlingCostBasis: 'excluded_from_read_only_preview',
    inventoryHandlingCostBasis: 'excluded_from_read_only_preview',
    rotationPolicy: 'fixed_axes_conservative',
  },
)
let promotedPreviewOptimizerCalled = false
const promotedPreview = await createCartonizationPreview({
  request: normalized,
  snapshot: {
    ...snapshot,
    candidate: {
      ...snapshot.candidate,
      workflowState: 'promoted',
    },
  },
  optimizer: {
    async optimize(input, options) {
      promotedPreviewOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(promotedPreview.status, 'blocked')
assert.equal(promotedPreviewOptimizerCalled, false)
assert.ok(promotedPreview.blockers.some((item) => (
  item.code === 'CARTONIZATION_CANDIDATE_NOT_PREVIEWABLE'
)))
assert.equal(capturedOptimizerInput.orderRevision, 4)
assert.equal(capturedOptimizerInput.lines[0].rotationAllowed, false)
assert.equal(capturedOptimizerInput.lines[0].unitWeightGrams, 200)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    capturedOptimizerInput.lines[0].unitDimensionsMm,
  )),
  { length: 100, width: 80, height: 40 },
)
assert.equal(
  capturedOptimizerInput.eligiblePositions[0].availableQuantity,
  2,
  'ATP must not be reduced by candidate demand',
)
assert.equal(
  capturedOptimizerInput.cartons[0].estimatedTransportCostMinor,
  0,
)
const attributedCommitment = await createCartonizationPreview({
  request: {
    ...normalized,
    assumedCommittedByLine: [{
      lineGlobalId: 'gcol0000001',
      quantity: 1,
    }],
  },
  snapshot: {
    ...snapshot,
    inventoryPositions: [{
      ...snapshot.inventoryPositions[0],
      atpQuantity: 1,
    }],
  },
  optimizer: {
    async optimize(input, options) {
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(attributedCommitment.status, 'ready')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    attributedCommitment.inventoryEvidence.assumedCommittedByLine,
  )),
  [{ lineGlobalId: 'gcol0000001', quantity: 1 }],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    attributedCommitment.inventoryEvidence.positions[0],
  )),
  {
    productGlobalId: 'gp0000001',
    positionGlobalId: 'giv0000001',
    atpQuantity: 1,
    providerCommittedQuantity: 2,
  },
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    attributedCommitment.inventoryEvidence.products[0],
  )),
  {
    productGlobalId: 'gp0000001',
    demandQuantity: 2,
    assumedCommittedQuantity: 1,
    eligibleQuantity: 2,
    positionCount: 1,
  },
)
assert.equal(
  capturedOptimizerInput.eligiblePositions[0].availableQuantity,
  2,
  'Only the exact line-attributed commitment may be added back to ATP',
)
let ambiguousPositionOptimizerCalled = false
const ambiguousPosition = await createCartonizationPreview({
  request: {
    ...normalized,
    assumedCommittedByLine: [{
      lineGlobalId: 'gcol0000001',
      quantity: 1,
    }],
  },
  snapshot: {
    ...snapshot,
    inventoryPositions: [
      {
        ...snapshot.inventoryPositions[0],
        atpQuantity: 1,
      },
      {
        ...snapshot.inventoryPositions[0],
        positionGlobalId: 'giv0000002',
        atpQuantity: 0,
      },
    ],
  },
  optimizer: {
    async optimize(input, options) {
      ambiguousPositionOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(ambiguousPosition.status, 'blocked')
assert.equal(ambiguousPositionOptimizerCalled, false)
assert.ok(ambiguousPosition.blockers.some((item) => (
  item.code === 'CARTONIZATION_INVENTORY_POSITION_AMBIGUOUS'
)))
assert.deepEqual(
  JSON.parse(JSON.stringify(
    ambiguousPosition.inventoryEvidence.products[0],
  )),
  {
    productGlobalId: 'gp0000001',
    demandQuantity: 2,
    assumedCommittedQuantity: 1,
    eligibleQuantity: null,
    positionCount: 2,
  },
  'Product-level commitment must appear once and remain ineligible while inventory positions are ambiguous',
)
assert.equal(
  Object.hasOwn(
    ambiguousPosition.inventoryEvidence.positions[0],
    'assumedCommittedQuantity',
  ),
  false,
  'Position evidence must not duplicate a product-level assumed commitment',
)
await assert.rejects(
  () => createCartonizationPreview({
    request: {
      ...normalized,
      expectedCandidateRowVersion: 2,
    },
    snapshot,
    optimizer: null,
  }),
  /order candidate changed/i,
)

const fallback = await createCartonizationPreview({
  request: normalized,
  snapshot,
  optimizer: {
    async optimize(input, options) {
      return validOptimizerResult(input, options, {
        method: 'deterministic_fallback',
      })
    },
  },
})
assert.equal(fallback.status, 'blocked')
assert.equal(fallback.optimizer, null)
assert.ok(
  fallback.blockers.some(
    (item) => item.code === 'CARTONIZATION_DETERMINISTIC_FALLBACK_REJECTED',
  ),
)

const timeout = await createCartonizationPreview({
  request: normalized,
  snapshot,
  optimizer: {
    async optimize(input, options) {
      return validOptimizerResult(input, options, { status: 'timeout' })
    },
  },
})
assert.equal(timeout.status, 'blocked')
assert.ok(
  timeout.blockers.some(
    (item) => item.code === 'CARTONIZATION_STRICT_OPTIMIZER_INCOMPLETE',
  ),
)

let assumptionOptimizerCalled = false
const unsupportedAssumption = await createCartonizationPreview({
  request: {
    ...normalized,
    assumedCommittedByLine: [{
      lineGlobalId: 'gcol0000001',
      quantity: 3,
    }],
  },
  snapshot,
  optimizer: {
    async optimize(input, options) {
      assumptionOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(unsupportedAssumption.status, 'blocked')
assert.equal(assumptionOptimizerCalled, false)
assert.ok(unsupportedAssumption.blockers.some((item) => (
  item.code === 'CARTONIZATION_ASSUMED_COMMITTED_EXCEEDS_LINE'
)))

let staleOptimizerCalled = false
const staleInventory = await createCartonizationPreview({
  request: normalized,
  snapshot: {
    ...snapshot,
    latestInventoryRun: {
      ...snapshot.latestInventoryRun,
      providerFetchedAt: '2026-07-26T11:55:00.000Z',
      completedAt: '2026-07-28T11:59:00.000Z',
    },
  },
  optimizer: {
    async optimize(input, options) {
      staleOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(staleInventory.status, 'blocked')
assert.equal(staleOptimizerCalled, false)
assert.ok(staleInventory.blockers.some((item) => (
  item.code === 'CARTONIZATION_INVENTORY_EVIDENCE_STALE'
)))
assert.equal(
  staleInventory.inventoryEvidence.providerFetchedAt,
  '2026-07-26T11:55:00.000Z',
  'Provider capture time is the freshness boundary',
)
assert.equal(
  staleInventory.inventoryEvidence.completedAt,
  '2026-07-28T11:59:00.000Z',
  'Recent replay completion remains available as separate evidence',
)

let faireOptimizerCalled = false
const faireInventoryBoundary = await createCartonizationPreview({
  request: normalized,
  snapshot: {
    ...snapshot,
    account: {
      ...snapshot.account,
      provider: 'faire',
    },
    latestInventoryRun: null,
    inventoryPositions: [],
  },
  optimizer: {
    async optimize(input, options) {
      faireOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(faireInventoryBoundary.status, 'blocked')
assert.equal(faireOptimizerCalled, false)
assert.ok(faireInventoryBoundary.blockers.some((item) => (
  item.code === 'CARTONIZATION_PROVIDER_INVENTORY_UNSUPPORTED'
)))
assert.equal(faireInventoryBoundary.inventoryEvidence.syncRunGlobalId, null)

let missingMeasurementOptimizerCalled = false
const missingMeasurements = await createCartonizationPreview({
  request: normalized,
  snapshot: {
    ...snapshot,
    lines: [{
      ...snapshot.lines[0],
      packagingState: 'unresolved',
      dimensionsMm: null,
    }],
  },
  optimizer: {
    async optimize(input, options) {
      missingMeasurementOptimizerCalled = true
      return validOptimizerResult(input, options)
    },
  },
})
assert.equal(missingMeasurements.status, 'blocked')
assert.equal(missingMeasurementOptimizerCalled, false)
assert.ok(missingMeasurements.blockers.some((item) => (
  item.code === 'CARTONIZATION_CANONICAL_PACKAGE_REQUIRED'
)))

const previewOrganizationId =
  '11111111-1111-4111-8111-111111111111'
const persistenceScenario = loadPersistence()
const persistedSnapshot = await persistenceScenario.loaded
  .readCartonizationPreviewSnapshotFromPostgres({
    organizationId: previewOrganizationId,
    request: normalized,
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(persistedSnapshot.activeWarehouses)),
  [{ globalId: 'gwh0000001', name: 'AG Alchemy' }],
  'A multi-warehouse organization must retain only the exact selected active warehouse in preview evidence',
)
const selectedWarehouseQuery = persistenceScenario.queries.find(
  ({ sql }) => sql.includes('FROM operations_warehouses warehouse'),
)
assert.deepEqual(
  JSON.parse(JSON.stringify(selectedWarehouseQuery?.values)),
  [previewOrganizationId, 'gwh0000001'],
)
const selectedMappingQuery = persistenceScenario.queries.find(
  ({ sql }) => sql.includes(
    'FROM operations_commerce_inventory_location_mappings mapping',
  ),
)
assert.ok(selectedMappingQuery)
assert.ok(selectedMappingQuery.sql.includes(
  'mapping.warehouse_id = $3::uuid',
))
assert.deepEqual(
  JSON.parse(JSON.stringify(selectedMappingQuery.values)),
  [
    previewOrganizationId,
    '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444',
  ],
  'Location mapping authority must be scoped to the selected warehouse',
)
const selectedInventoryQuery = persistenceScenario.queries.find(
  ({ sql }) => sql.includes(
    'FROM operations_commerce_inventory_sync_runs run',
  ),
)
assert.ok(selectedInventoryQuery)
assert.ok(selectedInventoryQuery.sql.includes('run.warehouse_id = $3::uuid'))
assert.ok(selectedInventoryQuery.sql.includes(
  'run.location_mapping_id = $4::uuid',
))
assert.deepEqual(
  JSON.parse(JSON.stringify(selectedInventoryQuery.values)),
  [
    previewOrganizationId,
    '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
  ],
  'Inventory evidence must be scoped to the exact account, selected warehouse, and current active mapping',
)

const mappingAmbiguity = loadPersistence({
  mappingRows: [{
    id: '55555555-5555-4555-8555-555555555555',
    warehouse_id: '44444444-4444-4444-8444-444444444444',
  }, {
    id: '77777777-7777-4777-8777-777777777777',
    warehouse_id: '44444444-4444-4444-8444-444444444444',
  }],
})
await assert.rejects(
  () => mappingAmbiguity.loaded
    .readCartonizationPreviewSnapshotFromPostgres({
      organizationId: previewOrganizationId,
      request: normalized,
    }),
  (error) => (
    error.code === 'CARTONIZATION_PREVIEW_LOCATION_MAPPING_AMBIGUOUS'
  ),
)

const carrierConfigAmbiguity = loadPersistence({
  carrierConfigRows: [{
    warehouse_id: '44444444-4444-4444-8444-444444444444',
  }, {
    warehouse_id: '88888888-8888-4888-8888-888888888888',
  }],
})
await assert.rejects(
  () => carrierConfigAmbiguity.loaded
    .readCartonizationPreviewSnapshotFromPostgres({
      organizationId: previewOrganizationId,
      request: normalized,
    }),
  (error) => (
    error.code === 'CARTONIZATION_PREVIEW_CARRIER_CONFIG_AMBIGUOUS'
  ),
)

const warehouseAuthorityConflict = loadPersistence({
  carrierConfigRows: [{
    warehouse_id: '88888888-8888-4888-8888-888888888888',
  }],
})
await assert.rejects(
  () => warehouseAuthorityConflict.loaded
    .readCartonizationPreviewSnapshotFromPostgres({
      organizationId: previewOrganizationId,
      request: normalized,
    }),
  (error) => (
    error.code === 'CARTONIZATION_PREVIEW_WAREHOUSE_AUTHORITY_CONFLICT'
  ),
)

const selectedWarehouseMismatch = loadPersistence({
  mappingRows: [{
    id: '55555555-5555-4555-8555-555555555555',
    warehouse_id: '88888888-8888-4888-8888-888888888888',
  }],
  carrierConfigRows: [{
    warehouse_id: '88888888-8888-4888-8888-888888888888',
  }],
})
await assert.rejects(
  () => selectedWarehouseMismatch.loaded
    .readCartonizationPreviewSnapshotFromPostgres({
      organizationId: previewOrganizationId,
      request: normalized,
    }),
  (error) => (
    error.code === 'CARTONIZATION_PREVIEW_WAREHOUSE_AUTHORITY_MISMATCH'
  ),
)

const persistence = read(
  'app_src/lib/persistence/cartonizationPreview.ts',
)
for (const fragment of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'operations_commerce_order_candidates',
  'operations_commerce_order_candidate_lines',
  'operations_commerce_inventory_sync_runs',
  'operations_commerce_inventory_levels',
  'operations_inventory_positions',
  'operations_packaging_materials',
  'operations_packaging_material_stock',
  'sum(level.operational_available_quantity)',
  'sum(level.provider_committed_quantity)',
  'candidate.row_version::text',
  'line.weight_grams',
  'line.length_mm',
  'line.width_mm',
  'line.height_mm',
  'line.pack_profile_package_level',
  'line.commerce_variant_pack_mapping_row_version',
  'line.pack_profile_version_row_version',
  'pack_mapping.global_id',
  'pack_version.global_id',
  'operations_commerce_inventory_location_mappings',
  'operations_shopify_carrier_service_configs',
  'mapping.warehouse_id = $3::uuid',
  'run.warehouse_id = $3::uuid',
  'run.location_mapping_id = $4::uuid',
]) {
  assert.ok(
    persistence.includes(fragment),
    `Cartonization persistence missing ${fragment}`,
  )
}
assert.equal(
  persistence.includes('readActiveWarehouses'),
  false,
  'Fit preview must not fall back to an organization-wide active warehouse count',
)
assert.match(
  persistence,
  /ORDER BY\s+run\.provider_fetched_at DESC,\s+run\.completed_at DESC,\s+run\.id DESC/,
  'The newest provider capture wins even when an older capture is replayed later',
)
for (const forbidden of [
  'INSERT INTO ',
  'UPDATE ',
  'DELETE FROM ',
  'FOR UPDATE',
]) {
  assert.equal(
    persistence.includes(forbidden),
    false,
    `Read-only persistence contains forbidden SQL: ${forbidden}`,
  )
}

const route = read(
  'app_src/app/api/integrations/commerce/intake/cartonization-preview/route.ts',
)
for (const fragment of [
  'requireRequestUser(req)',
  'operationsCapabilities(actor).canManage',
  'requirePostgres()',
  'assertCommerceIntakeRuntime()',
  'normalizeCartonizationPreviewRequest',
  'readCartonizationPreviewSnapshotFromPostgres',
  'configuredOrToolsFulfillmentOptimizer',
  'createCartonizationPreview',
  "'Cache-Control': 'no-store",
]) {
  assert.ok(route.includes(fragment), `Cartonization route missing ${fragment}`)
}
for (const forbidden of [
  'shopifyCommerceClient',
  'faireCommerceClient',
  'carrierRate',
  'createLabel',
  'createShipment',
]) {
  assert.equal(
    route.includes(forbidden),
    false,
    `Read-only route imports forbidden capability: ${forbidden}`,
  )
}

const workflow = read(
  'app_src/components/settings/CommerceIntakeWorkflow.tsx',
)
for (const fragment of [
  'selectedPlan.shipmentCount',
  'Packages from the same warehouse form one multi-piece',
  'packing documents must remain grouped',
  'inventoryEvidence.products',
  'blocked until exactly one inventory position is resolved',
  'warehouseGlobalId: selectedCartonizationWarehouseGlobalId',
]) {
  assert.ok(
    workflow.includes(fragment),
    `Cartonization workflow missing ${fragment}`,
  )
}

console.log('Cartonization preview backend contracts passed')
