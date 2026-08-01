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
  assertMatchedShopifyCheckoutPackLineage,
  assertHybridCartonizationCandidateEligible,
  HybridCartonizationPersistenceError,
  evaluateHybridCartonizationInventoryAvailability,
  hybridCartonizationInventoryProjectionStates,
  normalizeHybridCartonizationReadRequest,
  resolveOperationalShopifyCheckoutReconciliation,
} = module.exports

const matchedCheckoutDecision = {
  outcome: 'matched',
  source_shopify_service_code: 'clawpilot:ups:03',
  receipt_id: '00000000-0000-4000-8000-000000000040',
  receipt_global_id: 'gsqr0000001',
  receipt_status: 'succeeded',
}
assert.equal(
  resolveOperationalShopifyCheckoutReconciliation({
    candidateServiceCode: 'clawpilot:ups:03',
    rows: [matchedCheckoutDecision],
  }).receipt_global_id,
  'gsqr0000001',
  'A ClawPilot checkout must resolve only its exact current matched succeeded receipt',
)
for (const rows of [
  [],
  [{ ...matchedCheckoutDecision, outcome: 'rejected', receipt_id: null }],
  [{ ...matchedCheckoutDecision, receipt_status: 'failed' }],
]) {
  assert.throws(
    () => resolveOperationalShopifyCheckoutReconciliation({
      candidateServiceCode: 'clawpilot:ups:03',
      rows,
    }),
    (error) => (
      error instanceof HybridCartonizationPersistenceError
      && error.code
        === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
    ),
    'A ClawPilot checkout must fail closed without one current matched succeeded receipt',
  )
}
assert.equal(
  resolveOperationalShopifyCheckoutReconciliation({
    candidateServiceCode: 'shopify-standard',
    rows: [],
  }),
  null,
  'A genuinely non-ClawPilot Shopify shipping method may use candidate-captured pack facts',
)

const matchedCheckoutLineage = {
  candidateLineGlobalId: 'gcol0000001',
  candidateProductId: '00000000-0000-4000-8000-000000000010',
  candidateProductGlobalId: 'gp0000001',
  candidateExternalProductId: 'gid://shopify/Product/10',
  candidateExternalVariantId: 'gid://shopify/ProductVariant/20',
  receiptLine: {
    receipt_global_id: 'gsqr0000001',
    line_key: 'checkout-line-1',
    provider_variant_id: 'gid://shopify/ProductVariant/20',
    quantity: 50,
    unit_weight_grams: 170,
    line_snapshot: {
      productGid: 'gid://shopify/Product/10',
      variantGid: 'gid://shopify/ProductVariant/20',
      productGlobalId: 'gp0000001',
      packMappingGlobalId: 'gcvm0000001',
      packMappingRowVersion: 4,
      packProfileVersionGlobalId: 'gppv0000001',
      packProfileVersionRowVersion: 2,
      packageLevel: 'each',
      baseEachQuantity: 1,
      quantity: 50,
      unitWeightGrams: 170,
    },
    pack_mapping_id: '00000000-0000-4000-8000-000000000020',
    pack_mapping_global_id: 'gcvm0000001',
    pack_mapping_row_version: '4',
    pack_mapping_product_id: '00000000-0000-4000-8000-000000000010',
    pack_mapping_external_product_id: 'gid://shopify/Product/10',
    pack_mapping_external_variant_id: 'gid://shopify/ProductVariant/20',
    pack_mapping_purpose: 'shopify_checkout',
    pack_mapping_projection_state: 'current',
    pack_mapping_is_current: true,
    pack_mapping_source_revision: 'source-revision-1',
    pack_mapping_source_hash: 'source-hash-1',
    pack_mapping_pack_evidence_hash: 'pack-evidence-hash-1',
    product_global_id: 'gp0000001',
    channel_source_revision: 'source-revision-1',
    channel_source_hash: 'source-hash-1',
    channel_pack_evidence_hash: 'pack-evidence-hash-1',
    channel_weight_grams: 170,
    pack_profile_version_id: '00000000-0000-4000-8000-000000000030',
    pack_profile_version_global_id: 'gppv0000001',
    pack_profile_version_row_version: '2',
    pack_profile_is_current: true,
    pack_profile_lifecycle_state: 'active',
    pack_profile_fit_model: 'approved_recipe_only',
    pack_profile_evidence_type: 'customer_confirmed',
    pack_profile_evidence_reference: 'customer-dimensions',
    pack_profile_confirmed_at: '2026-07-30T00:00:00.000Z',
    pack_profile_status: 'active',
    pack_profile_package_level: 'each',
    pack_profile_base_each_quantity: 1,
    pack_profile_length_mm: null,
    pack_profile_width_mm: null,
    pack_profile_height_mm: null,
    pack_profile_dimension_basis: 'unspecified',
    pack_profile_gross_weight_grams: null,
    pack_profile_weight_basis: 'unspecified',
  },
}
assert.deepEqual(
  JSON.parse(JSON.stringify(
    assertMatchedShopifyCheckoutPackLineage(matchedCheckoutLineage),
  )),
  { mappingRowVersion: 4, profileRowVersion: 2 },
  'Operational cartonization must accept the exact checkout mapping/profile captured by the matched receipt',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: {
      ...matchedCheckoutLineage.receiptLine,
      line_snapshot: {
        ...matchedCheckoutLineage.receiptLine.line_snapshot,
        packMappingRowVersion: undefined,
      },
    },
  }))),
  { mappingRowVersion: 4, profileRowVersion: 2 },
  'A legacy immutable receipt still binds by exact mapping Global ID and current versioned mapping row',
)
assert.throws(
  () => assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: {
      ...matchedCheckoutLineage.receiptLine,
      pack_profile_version_global_id: 'gppv0000002',
    },
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
  ),
  'Operational cartonization must not fall back when checkout profile lineage conflicts',
)

const candidateEligibilityNow = new Date('2026-07-31T12:00:00.000Z')
assert.doesNotThrow(
  () => assertHybridCartonizationCandidateEligible({
    mode: 'production',
    workflowState: 'promoted',
    expiresAt: '2026-07-01T12:00:00.000Z',
    now: candidateEligibilityNow,
  }),
  'A promoted candidate is durable canonical lineage for operational planning even after its review window',
)
assert.throws(
  () => assertHybridCartonizationCandidateEligible({
    mode: 'sandbox_demo',
    workflowState: 'promoted',
    expiresAt: '2026-08-01T12:00:00.000Z',
    now: candidateEligibilityNow,
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_CANDIDATE_STATE_INVALID'
  ),
  'A promoted candidate must never re-enter the assumption-backed sandbox path',
)
assert.throws(
  () => assertHybridCartonizationCandidateEligible({
    mode: 'production',
    workflowState: 'ready',
    expiresAt: '2026-07-01T12:00:00.000Z',
    now: candidateEligibilityNow,
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_CANDIDATE_EXPIRED'
  ),
  'An unpromoted candidate remains bounded by its intake review window',
)

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
  'pack_mapping_pack_evidence_hash',
  'channel_pack_evidence_hash',
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
  'candidate.checkout_shipping_service_code',
  'reconciliation.outcome,',
  'operations_shopify_checkout_rate_current_reconciliations',
  'line.ordered_quantity::text',
  'row.ordered_quantity',
  'const activeCandidateLines = candidateLines.filter',
  'const unfulfilledRows = lineageRows.filter',
  "receipt_line.line_snapshot ->> 'packMappingGlobalId'",
  "receipt_line.line_snapshot ->> 'packProfileVersionGlobalId'",
  "pack_mapping.mapping_purpose AS pack_mapping_purpose",
  'applyMatchedCheckoutPackLineage',
  "packLineageSource: row.pack_lineage_source",
  'checkoutReceiptGlobalId: row.checkout_receipt_global_id',
  'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
]) {
  assert.ok(source.includes(contract), `Missing persistence contract: ${contract}`)
}

assert.doesNotMatch(
  source,
  /AND reconciliation\.outcome = 'matched'/,
  'Operational planning must inspect and fail closed on non-matched ClawPilot checkout decisions',
)
assert.doesNotMatch(
  source,
  /AND line\.unfulfilled_quantity > 0/,
  'Checkout lineage must include fulfilled and cancelled shippable source lines before remaining work is filtered',
)

console.log('Hybrid cartonization persistence contract passed')
