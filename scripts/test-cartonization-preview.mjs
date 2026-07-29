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

const {
  createCartonizationPreview,
  normalizeCartonizationPreviewRequest,
} = loadDomain()

const request = {
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  expectedCandidateRowVersion: 3,
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
assert.equal(
  ready.optimizer?.selectedPlan?.packages[0].allocations[0].quantity,
  2,
)
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
]) {
  assert.ok(
    persistence.includes(fragment),
    `Cartonization persistence missing ${fragment}`,
  )
}
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
]) {
  assert.ok(
    workflow.includes(fragment),
    `Cartonization workflow missing ${fragment}`,
  )
}

console.log('Cartonization preview backend contracts passed')
