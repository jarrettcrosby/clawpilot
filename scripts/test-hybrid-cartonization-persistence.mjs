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
  hybridCartonizationInventoryProjectionStates,
  normalizeHybridCartonizationReadRequest,
} = module.exports

assert.deepEqual(
  JSON.parse(JSON.stringify(
    hybridCartonizationInventoryProjectionStates('production'),
  )),
  ['projected'],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    hybridCartonizationInventoryProjectionStates('sandbox_demo'),
  )),
  ['projected', 'negative_available'],
)

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
    sourceProjectionStates: ['projected'],
  }],
  assumedCommittedQuantities:
    validRequest.assumedCommittedQuantities,
})
assert.deepEqual(
  JSON.parse(JSON.stringify(inventory.products[0])),
  {
    productGlobalId: 'gp0000001',
    requiredQuantity: 3,
    availabilityAuthority: 'operational_available',
    operationalAvailableQuantity: 1,
    providerCommittedQuantity: 2,
    assumedCommittedQuantity: 2,
    effectiveAvailableQuantity: 3,
    sourceLevelGlobalIds: ['giil0000001'],
    sourceProjectionStates: ['projected'],
  },
)

const negativeAvailableCommittedEvidence =
  evaluateHybridCartonizationInventoryAvailability({
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 2,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 0,
      providerCommittedQuantity: 2,
      sourceLevelGlobalIds: ['giil0000001'],
      sourceProjectionStates: ['negative_available'],
    }],
    assumedCommittedQuantities: [{
      lineGlobalId: 'gcol0000001',
      quantity: 2,
    }],
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(
    negativeAvailableCommittedEvidence.products[0],
  )),
  {
    productGlobalId: 'gp0000001',
    requiredQuantity: 2,
    availabilityAuthority: 'operational_available',
    operationalAvailableQuantity: 0,
    providerCommittedQuantity: 2,
    assumedCommittedQuantity: 2,
    effectiveAvailableQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
    sourceProjectionStates: ['negative_available'],
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
      sourceProjectionStates: ['projected'],
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

const shopifyProductionInventory =
  evaluateHybridCartonizationInventoryAvailability({
    mode: 'production',
    provider: 'shopify',
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 2,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 0,
      providerCommittedQuantity: 2,
      sourceLevelGlobalIds: ['giil0000001'],
      sourceProjectionStates: ['projected'],
    }],
    assumedCommittedQuantities: [],
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(shopifyProductionInventory.products[0])),
  {
    productGlobalId: 'gp0000001',
    requiredQuantity: 2,
    availabilityAuthority: 'shopify_provider_commitment',
    operationalAvailableQuantity: 0,
    providerCommittedQuantity: 2,
    assumedCommittedQuantity: 0,
    effectiveAvailableQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
    sourceProjectionStates: ['projected'],
  },
  'Shopify production evidence must use provider commitment without an operator attribution assumption',
)
assert.throws(
  () => evaluateHybridCartonizationInventoryAvailability({
    mode: 'production',
    provider: 'shopify',
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 1,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 1,
      providerCommittedQuantity: 1,
      sourceLevelGlobalIds: ['giil0000001'],
      sourceProjectionStates: ['projected'],
    }],
    assumedCommittedQuantities: [{
      lineGlobalId: 'gcol0000001',
      quantity: 1,
    }],
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_PRODUCTION_ASSUMPTIONS_FORBIDDEN'
  ),
  'Production evidence must reject operator-entered committed inventory assumptions',
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
      sourceProjectionStates: ['projected'],
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
  'pack_mapping.global_id AS pack_mapping_global_id',
  'pack_version.row_version::text',
  "row.pack_profile_fit_model === 'approved_recipe_only'",
  "row.packaging_state === 'unresolved'",
  'recipeOnlyAssociation',
  'row.channel_weight_grams',
  'variantPackMappingGlobalId',
  'channelSourceRevision',
  'channelSourceHash',
  'row.current_pack_profile_length_mm === null',
  "row.current_pack_profile_dimension_basis === 'unspecified'",
  'material.row_version::text',
  'material.rated_outer_length_mm',
  'ratedOuterDimensionsMm',
  'maximumGrossWeightGrams',
  'availableQuantity',
  'recipe.input_pack_profile_version_id',
  'recipe.packaging_material_id = ANY($3::uuid[])',
  'recipe.is_current = true',
  'level.projection_state = ANY($5::text[])',
  'hybridCartonizationInventoryProjectionStates(input.mode)',
  'provider: account.provider',
  "'shopify_provider_commitment'",
  'HYBRID_CARTONIZATION_MATERIAL_RATE_EVIDENCE_REQUIRED',
]) {
  assert.ok(source.includes(contract), `Missing persistence contract: ${contract}`)
}

console.log('Hybrid cartonization persistence contract passed')
