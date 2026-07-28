#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const sourcePath = 'app_src/lib/persistence/hybridCartonization.ts'
const source = readFileSync(resolve(root, sourcePath), 'utf8')
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText
const module = { exports: {} }
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
  require(specifier) {
    if (specifier === '@/lib/persistence/postgres') {
      return {
        getPostgresPool() {
          throw new Error('Database access is not part of this contract test')
        },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: sourcePath })

const {
  HybridCartonizationPersistenceError,
  evaluateHybridCartonizationInventoryAvailability,
  normalizeHybridCartonizationReadRequest,
} = module.exports

const validRequest = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  accountGlobalId: 'gia0000001',
  candidateGlobalId: 'gcoc0000001',
  expectedCandidateRowVersion: 7,
  warehouseGlobalId: 'gwh0000001',
  mode: 'sandbox_demo',
  selectedMaterials: [{
    materialGlobalId: 'gmat0000001',
    expectedRowVersion: 3,
  }],
  assumedCommittedQuantities: [{
    lineGlobalId: 'gcol0000001',
    quantity: 1,
  }, {
    lineGlobalId: 'gcol0000002',
    quantity: 1,
  }],
}

const normalized = normalizeHybridCartonizationReadRequest(validRequest)
assert.equal(normalized.expectedCandidateRowVersion, 7)
assert.equal(normalized.selectedMaterials[0].expectedRowVersion, 3)
assert.equal(normalized.assumedCommittedQuantities[0].quantity, 1)
assert.throws(
  () => normalizeHybridCartonizationReadRequest({
    ...validRequest,
    selectedMaterials: [
      validRequest.selectedMaterials[0],
      validRequest.selectedMaterials[0],
    ],
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_REQUEST_INVALID'
  ),
)
assert.throws(
  () => normalizeHybridCartonizationReadRequest({
    ...validRequest,
    assumedCommittedQuantities: [{
      lineGlobalId: 'gcol0000001',
      quantity: 0.5,
    }],
  }),
  /assumed committed quantity is invalid/,
)

const inventory = evaluateHybridCartonizationInventoryAvailability({
  lines: [{
    lineGlobalId: 'gcol0000001',
    productGlobalId: 'gp0000001',
    requiredQuantity: 2,
  }, {
    lineGlobalId: 'gcol0000002',
    productGlobalId: 'gp0000001',
    requiredQuantity: 1,
  }],
  positions: [{
    productGlobalId: 'gp0000001',
    operationalAvailableQuantity: 1,
    providerCommittedQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
  }],
  assumedCommittedQuantities:
    validRequest.assumedCommittedQuantities,
})
assert.deepEqual(
  JSON.parse(JSON.stringify(inventory.products[0])),
  {
    productGlobalId: 'gp0000001',
    requiredQuantity: 3,
    operationalAvailableQuantity: 1,
    providerCommittedQuantity: 2,
    assumedCommittedQuantity: 2,
    effectiveAvailableQuantity: 3,
    sourceLevelGlobalIds: ['giil0000001'],
  },
)
assert.throws(
  () => evaluateHybridCartonizationInventoryAvailability({
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 2,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 0,
      providerCommittedQuantity: 1,
      sourceLevelGlobalIds: ['giil0000001'],
    }],
    assumedCommittedQuantities: [{
      lineGlobalId: 'gcol0000001',
      quantity: 2,
    }],
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_COMMITTED_ASSUMPTION_UNSUPPORTED'
  ),
)
assert.throws(
  () => evaluateHybridCartonizationInventoryAvailability({
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 2,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 1,
      providerCommittedQuantity: 0,
      sourceLevelGlobalIds: ['giil0000001'],
    }],
    assumedCommittedQuantities: [{
      lineGlobalId: 'gcol0000001',
      quantity: 0,
    }],
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_INVENTORY_INSUFFICIENT'
  ),
)

for (const contract of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'candidate.organization_id = $1::uuid',
  'candidate.integration_account_id = $2::uuid',
  'candidate.global_id = $3',
  "warehouse.status = 'active'",
  "run.status = 'succeeded'",
  'pack_mapping.row_version::text',
  'pack_version.row_version::text',
  'material.row_version::text',
  'recipe.input_pack_profile_version_id',
  'recipe.packaging_material_id = ANY($3::uuid[])',
  'recipe.is_current = true',
  "level.projection_state = 'projected'",
]) {
  assert.ok(source.includes(contract), `Missing persistence contract: ${contract}`)
}

console.log('Hybrid cartonization persistence contract passed')
