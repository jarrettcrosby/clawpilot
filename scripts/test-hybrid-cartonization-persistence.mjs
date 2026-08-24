#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}
function shopifyCheckoutRatingHash(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
}
function withReceiptLineHash(line) {
  return {
    ...line,
    line_hash: shopifyCheckoutRatingHash({
      lineKey: line.line_key,
      providerVariantId: line.provider_variant_id,
      sku: line.sku,
      quantity: line.quantity,
      unitWeightGrams: line.unit_weight_grams,
      requiresShipping: line.requires_shipping,
      lineSnapshot: line.line_snapshot,
    }),
  }
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
  require(specifier) {
    if (specifier === '@/lib/persistence/postgres') {
      return {
        getPostgresPool() {
          throw new Error('Database access is not part of this contract test')
        },
      }
    }
    if (specifier === '@/lib/persistence/shopifyCheckoutRating') {
      return {
        shopifyCheckoutRateLineageIsRequired(serviceCode) {
          return typeof serviceCode === 'string'
            && /^clawpilot:(ups|fedex):[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/.test(
              serviceCode.trim(),
            )
        },
        shopifyCheckoutRatingHash,
      }
    }
    if (
      specifier ===
      '@/lib/integrations/shopifyCheckoutChannelEligibility'
    ) {
      const isShopifySandboxCheckoutChannelEligible = (input) => {
        const normalizedStatus = String(
          input.normalizedStatus || '',
        ).trim().toLowerCase()
        const providerStatusRaw = String(
          input.providerStatusRaw || '',
        ).trim().toLowerCase()
        const lifecycleEligible = (
          normalizedStatus === 'active'
          && providerStatusRaw === 'active'
          && input.providerActive === true
        ) || (
          normalizedStatus === 'unlisted'
          && providerStatusRaw === 'unlisted'
          && input.providerActive === false
        )
        return (
          String(input.provider || '').trim().toLowerCase() === 'shopify'
          && String(input.accountEnvironment || '')
            .trim().toLowerCase() === 'sandbox'
          && lifecycleEligible
          && input.requiresShipping === true
          && Number.isSafeInteger(input.weightGrams)
          && Number(input.weightGrams) > 0
        )
      }
      return {
        isShopifySandboxCheckoutChannelEligible,
        isShopifyRatingCheckoutChannelEligible(input) {
          const environment = String(
            input.accountEnvironment || '',
          ).trim().toLowerCase()
          return (
            (environment === 'sandbox' || environment === 'production')
            && isShopifySandboxCheckoutChannelEligible({
              ...input,
              accountEnvironment: 'sandbox',
            })
          )
        },
      }
    }
    return requireFromApp(specifier)
  },
}, { filename: sourcePath })

const {
  applyMatchedCheckoutPackLineage,
  applyCurrentFulfillmentPackLineage,
  assertCurrentFulfillmentPackEvidenceAvailable,
  assertMatchedShopifyCheckoutPackLineage,
  assertHybridCartonizationCandidateEligible,
  buildShopifyFulfillmentPackEvidence,
  HybridCartonizationPersistenceError,
  evaluateHybridCartonizationInventoryAvailability,
  hybridCartonizationInventoryProjectionStates,
  isHybridCartonizationFulfillmentChannelEligible,
  mapCandidateLines,
  normalizeHybridCartonizationReadRequest,
  resolveOperationalShopifyCheckoutReconciliation,
  shouldResolveCurrentShopifyFulfillmentPackLineage,
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
assert.equal(
  resolveOperationalShopifyCheckoutReconciliation({
    candidateServiceCode: 'clawpilot:dev:test-zero',
    rows: [],
  }),
  null,
  'A test or manually entered shipping code must not impersonate genuine ClawPilot carrier-rate lineage',
)
assert.equal(
  shouldResolveCurrentShopifyFulfillmentPackLineage({
    mode: 'production',
    provider: 'shopify',
    accountEnvironment: 'sandbox',
    checkoutServiceCode: 'clawpilot:dev:test-zero',
    hasMatchedCheckoutReceipt: false,
  }),
  true,
  'A promoted receipt-exempt Shopify order must resolve its exact current fulfillment mapping',
)
assert.equal(
  shouldResolveCurrentShopifyFulfillmentPackLineage({
    mode: 'production',
    provider: 'shopify',
    accountEnvironment: 'sandbox',
    checkoutServiceCode: 'clawpilot:ups:03',
    hasMatchedCheckoutReceipt: false,
  }),
  false,
  'A genuine ClawPilot rate must never resolve current mapping without its required receipt',
)
assert.equal(
  shouldResolveCurrentShopifyFulfillmentPackLineage({
    mode: 'production',
    provider: 'shopify',
    accountEnvironment: 'production',
    checkoutServiceCode: 'clawpilot:ups:03',
    hasMatchedCheckoutReceipt: true,
  }),
  true,
  'A matched genuine checkout must preserve receipt A while resolving current fulfillment mapping B',
)
assert.equal(
  shouldResolveCurrentShopifyFulfillmentPackLineage({
    mode: 'sandbox_demo',
    provider: 'shopify',
    accountEnvironment: 'sandbox',
    checkoutServiceCode: 'clawpilot:dev:test-zero',
    hasMatchedCheckoutReceipt: false,
  }),
  false,
  'The late-mapping exception is only for promoted operational planning',
)
assert.equal(
  shouldResolveCurrentShopifyFulfillmentPackLineage({
    mode: 'production',
    provider: 'shopify',
    accountEnvironment: 'production',
    checkoutServiceCode: 'clawpilot:dev:test-zero',
    hasMatchedCheckoutReceipt: false,
  }),
  false,
  'A production Shopify account must retain candidate-captured evidence for receipt-exempt imports',
)

const matchedCheckoutLineage = {
  candidateLineGlobalId: 'gcol0000001',
  candidateProductId: '00000000-0000-4000-8000-000000000010',
  candidateProductGlobalId: 'gp0000001',
  candidateExternalProductId: 'gid://shopify/Product/10',
  candidateExternalVariantId: 'gid://shopify/ProductVariant/20',
  receiptLine: withReceiptLineHash({
    receipt_global_id: 'gsqr0000001',
    line_key: 'checkout-line-1',
    provider_variant_id: 'gid://shopify/ProductVariant/20',
    sku: 'TEST-6OZ',
    quantity: 50,
    unit_weight_grams: 170,
    requires_shipping: true,
    line_snapshot: {
      productGid: 'gid://shopify/Product/10',
      variantGid: 'gid://shopify/ProductVariant/20',
      productGlobalId: 'gp0000001',
      packMappingGlobalId: 'gcvm0000001',
      packMappingRowVersion: 4,
      packProfileVersionGlobalId: 'gppv0000001',
      packProfileVersionRowVersion: 2,
      snapshotVersion: 'shopify-checkout-line-pack-evidence-v1',
      packEvidenceHash: 'a'.repeat(64),
      packageLevel: 'each',
      baseEachQuantity: 1,
      shipsAsOwnPackage: false,
      inventoryLevelGlobalIds: ['giil0000001'],
      quantity: 50,
      unitWeightGrams: 170,
    },
    // These retired mutable rows are deliberately ignored. The receipt is the
    // immutable checkout baseline, not a live join back to mapping/profile A.
    pack_mapping_row_version: '5',
    pack_mapping_is_current: false,
    pack_mapping_projection_state: 'stale',
    pack_profile_version_global_id: 'gppv0000002',
    pack_profile_is_current: false,
    pack_profile_status: 'retired',
  }),
}
const checkoutPackBaseline = {
  snapshotVersion: 'shopify-checkout-line-pack-evidence-v1',
  packEvidenceHash: 'a'.repeat(64),
  providerProductId: 'gid://shopify/Product/10',
  providerVariantId: 'gid://shopify/ProductVariant/20',
  productGlobalId: 'gp0000001',
  mappingGlobalId: 'gcvm0000001',
  mappingRowVersion: 4,
  profileVersionGlobalId: 'gppv0000001',
  profileRowVersion: 2,
  packageLevel: 'each',
  baseEachQuantity: 1,
  shipsAsOwnPackage: false,
  inventoryLevelGlobalIds: ['giil0000001'],
  receiptLineKeys: ['checkout-line-1'],
  quantity: 50,
  unitWeightGrams: 170,
}
assert.deepEqual(
  JSON.parse(JSON.stringify(
    assertMatchedShopifyCheckoutPackLineage(matchedCheckoutLineage),
  )),
  checkoutPackBaseline,
  'Operational cartonization must retain the exact immutable checkout baseline even after mapping A is retired',
)
assert.throws(
  () => assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: {
      ...matchedCheckoutLineage.receiptLine,
      line_snapshot: {
        ...matchedCheckoutLineage.receiptLine.line_snapshot,
        packEvidenceHash: 'b'.repeat(64),
      },
    },
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
  ),
  'Operational cartonization must verify the immutable receipt-line hash before trusting snapshot A',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: withReceiptLineHash({
      ...matchedCheckoutLineage.receiptLine,
      line_snapshot: {
        ...matchedCheckoutLineage.receiptLine.line_snapshot,
        packMappingRowVersion: undefined,
        snapshotVersion: undefined,
        packEvidenceHash: undefined,
        shipsAsOwnPackage: undefined,
        inventoryLevelGlobalIds: undefined,
      },
    }),
  }))),
  {
    ...checkoutPackBaseline,
    snapshotVersion: null,
    packEvidenceHash: null,
    mappingRowVersion: null,
    shipsAsOwnPackage: null,
    inventoryLevelGlobalIds: null,
  },
  'A legacy immutable receipt remains usable without inventing a missing mapping row version',
)
assert.throws(
  () => assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: withReceiptLineHash({
      ...matchedCheckoutLineage.receiptLine,
      line_snapshot: {
        ...matchedCheckoutLineage.receiptLine.line_snapshot,
        variantGid: 'gid://shopify/ProductVariant/99',
      },
    }),
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
  ),
  'Operational cartonization must fail closed when the immutable checkout identity conflicts',
)
assert.throws(
  () => assertMatchedShopifyCheckoutPackLineage({
    ...matchedCheckoutLineage,
    receiptLine: withReceiptLineHash({
      ...matchedCheckoutLineage.receiptLine,
      line_snapshot: {
        ...matchedCheckoutLineage.receiptLine.line_snapshot,
        packEvidenceHash: undefined,
      },
    }),
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
  ),
  'Versioned checkout snapshots must retain their exact evidence hash',
)
for (const missingField of [
  'shipsAsOwnPackage',
  'inventoryLevelGlobalIds',
]) {
  assert.throws(
    () => assertMatchedShopifyCheckoutPackLineage({
      ...matchedCheckoutLineage,
      receiptLine: withReceiptLineHash({
        ...matchedCheckoutLineage.receiptLine,
        line_snapshot: {
          ...matchedCheckoutLineage.receiptLine.line_snapshot,
          [missingField]: undefined,
        },
      }),
    }),
    (error) => (
      error instanceof HybridCartonizationPersistenceError
      && error.code
        === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
    ),
    `Versioned checkout snapshots must retain ${missingField}`,
  )
}

const fulfillmentCandidate = {
  global_id: 'gcol0000001',
  provider: 'shopify',
  account_environment: 'sandbox',
  product_id: '00000000-0000-4000-8000-000000000010',
  product_global_id: 'gp0000001',
  product_title_snapshot: 'Test Product',
  variant_title_snapshot: 'Default Title',
  external_product_id: 'gid://shopify/Product/10',
  external_variant_id: 'gid://shopify/ProductVariant/20',
  requires_shipping: true,
  ordered_quantity: '50',
  unfulfilled_quantity: '50',
  unit_multiplier: '1',
  packaging_weight_source: 'provider_catalog',
  weight_grams: 170,
  mapping_state: 'resolved',
  packaging_state: 'resolved',
  packaging_source: 'variant_pack_mapping',
  pack_mapping_id: '00000000-0000-4000-8000-000000000020',
  pack_mapping_global_id: 'gcvm0000001',
  captured_pack_mapping_row_version: '4',
  current_pack_mapping_row_version: '4',
  pack_mapping_is_current: true,
  pack_mapping_projection_state: 'current',
  pack_mapping_source_revision: 'source-revision-a',
  pack_mapping_source_hash: 'source-hash-a',
  pack_mapping_pack_evidence_hash: 'a'.repeat(64),
  pack_mapping_purpose: 'shopify_checkout',
  channel_source_revision: 'source-revision-a',
  channel_source_hash: 'source-hash-a',
  channel_pack_evidence_hash: 'a'.repeat(64),
  channel_provider_status_raw: 'active',
  channel_weight_grams: 170,
  pack_profile_version_id: '00000000-0000-4000-8000-000000000030',
  pack_profile_version_global_id: 'gppv0000001',
  captured_pack_profile_row_version: '2',
  current_pack_profile_row_version: '2',
  pack_profile_is_current: true,
  pack_profile_lifecycle_state: 'active',
  pack_profile_fit_model: 'rigid_3d',
  pack_profile_evidence_type: 'customer_confirmed',
  pack_profile_evidence_reference: 'customer-dimensions',
  pack_profile_confirmed_at: '2026-07-30T00:00:00.000Z',
  pack_profile_status: 'active',
  pack_profile_base_each_quantity: 1,
  current_pack_profile_base_each_quantity: 1,
  current_pack_profile_length_mm: 203,
  current_pack_profile_width_mm: 152,
  current_pack_profile_height_mm: 51,
  current_pack_profile_dimension_basis: 'outer',
  current_pack_profile_package_level: 'each',
  current_pack_profile_ships_as_own_package: false,
  current_pack_profile_gross_weight_grams: 170,
  current_pack_profile_weight_basis: 'customer_confirmed',
  pack_lineage_source: 'matched_shopify_checkout_receipt',
  checkout_receipt_global_id: 'gsqr0000001',
  fulfillment_pack_source: 'candidate_capture',
  checkout_pack_baseline: checkoutPackBaseline,
}

const unconstrainedUnitCandidate = {
  ...fulfillmentCandidate,
  packaging_state: 'not_required',
  packaging_source: 'none',
  packaging_weight_source: null,
  weight_grams: null,
  pack_mapping_id: null,
  pack_mapping_global_id: null,
  captured_pack_mapping_row_version: null,
  current_pack_mapping_row_version: null,
  pack_mapping_is_current: null,
  pack_mapping_projection_state: null,
  pack_mapping_source_revision: null,
  pack_mapping_source_hash: null,
  pack_mapping_pack_evidence_hash: null,
  pack_mapping_purpose: null,
  channel_pack_evidence_hash: null,
  channel_weight_grams: 750,
  pack_profile_version_id: null,
  pack_profile_version_global_id: null,
  captured_pack_profile_row_version: null,
  current_pack_profile_row_version: null,
  pack_profile_is_current: null,
  pack_profile_lifecycle_state: null,
  pack_profile_fit_model: null,
  pack_profile_evidence_type: null,
  pack_profile_evidence_reference: null,
  pack_profile_confirmed_at: null,
  pack_profile_status: null,
  pack_profile_base_each_quantity: null,
  current_pack_profile_base_each_quantity: null,
  current_pack_profile_length_mm: null,
  current_pack_profile_width_mm: null,
  current_pack_profile_height_mm: null,
  current_pack_profile_dimension_basis: null,
  current_pack_profile_package_level: null,
  current_pack_profile_ships_as_own_package: null,
  current_pack_profile_gross_weight_grams: null,
  current_pack_profile_weight_basis: null,
  checkout_pack_baseline: null,
}
const mappedUnconstrainedUnit = mapCandidateLines(
  { mode: 'production' },
  [unconstrainedUnitCandidate],
)[0]
assert.equal(
  mappedUnconstrainedUnit.packProfileVersionId,
  null,
  'A one-each line must not invent a Product-pack version',
)
assert.equal(
  mappedUnconstrainedUnit.line.profile.fitModel,
  'unconstrained_unit',
  'A one-each line must enter the dedicated no-Product-pack planner',
)
assert.equal(
  mappedUnconstrainedUnit.line.unitWeightGrams,
  750,
  'A one-each line must retain exact provider catalog weight',
)
assert.throws(
  () => mapCandidateLines(
    { mode: 'production' },
    [{ ...unconstrainedUnitCandidate, channel_weight_grams: null }],
  ),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_UNIT_WEIGHT_REQUIRED'
  ),
  'A one-each line without a Product pack must still fail closed on weight',
)

const publishedFaireSoldOutCandidate = {
  ...fulfillmentCandidate,
  provider: 'faire',
  external_product_id: 'p_testproduct',
  external_variant_id: 'po_testvariant',
  pack_mapping_purpose: 'catalog',
  channel_provider_status_raw: 'PUBLISHED',
  channel_normalized_status: 'unavailable',
  channel_provider_active: false,
  channel_requires_shipping: null,
  pack_lineage_source: 'order_candidate_capture',
  checkout_receipt_global_id: null,
  checkout_pack_baseline: null,
}
assert.doesNotThrow(
  () => mapCandidateLines(
    { mode: 'production' },
    [publishedFaireSoldOutCandidate],
  ),
  'A published Faire order may retain its exact catalog pack capture after the listing sells out',
)
assert.throws(
  () => mapCandidateLines(
    { mode: 'production' },
    [{
      ...publishedFaireSoldOutCandidate,
      channel_provider_status_raw: 'DRAFT',
    }],
  ),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code === 'HYBRID_CARTONIZATION_PACK_EVIDENCE_REQUIRED'
  ),
  'Faire order capture must not waive current-pack checks for nonpublished listings',
)

const aggregatedCandidateLines = [{
  ...fulfillmentCandidate,
  global_id: 'gcol0000002',
  ordered_quantity: '1',
  unfulfilled_quantity: '1',
}, {
  ...fulfillmentCandidate,
  global_id: 'gcol0000003',
  ordered_quantity: '4',
  unfulfilled_quantity: '4',
}]
const repeatedReceiptLines = [withReceiptLineHash({
  ...matchedCheckoutLineage.receiptLine,
  line_key: 'checkout-line-2',
  quantity: 2,
  line_snapshot: {
    ...matchedCheckoutLineage.receiptLine.line_snapshot,
    quantity: 2,
  },
}), withReceiptLineHash({
  ...matchedCheckoutLineage.receiptLine,
  line_key: 'checkout-line-1',
  quantity: 3,
  line_snapshot: {
    ...matchedCheckoutLineage.receiptLine.line_snapshot,
    quantity: 3,
  },
})]
const aggregatedLineage = applyMatchedCheckoutPackLineage(
  aggregatedCandidateLines,
  {
    receiptGlobalId: 'gsqr0000001',
    lines: repeatedReceiptLines,
  },
)
for (const row of aggregatedLineage) {
  assert.deepEqual(
    JSON.parse(JSON.stringify(row.checkout_pack_baseline)),
    {
      ...checkoutPackBaseline,
      receiptLineKeys: ['checkout-line-1', 'checkout-line-2'],
      quantity: 5,
    },
    'Repeated Shopify receipt rows must retain a deterministic variant-aggregate checkout baseline',
  )
}
assert.throws(
  () => applyMatchedCheckoutPackLineage(
    aggregatedCandidateLines,
    {
      receiptGlobalId: 'gsqr0000001',
      lines: [
        repeatedReceiptLines[0],
        withReceiptLineHash({
          ...repeatedReceiptLines[1],
          line_snapshot: {
            ...repeatedReceiptLines[1].line_snapshot,
            packageLevel: 'case',
            baseEachQuantity: 12,
          },
        }),
      ],
    },
  ),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID'
  ),
  'Repeated Shopify receipt rows must agree on all nonquantity physical facts',
)

const missingCurrentFulfillment = applyCurrentFulfillmentPackLineage(
  [fulfillmentCandidate],
  [],
)[0]
assert.equal(missingCurrentFulfillment.pack_mapping_global_id, null)
assert.deepEqual(
  JSON.parse(JSON.stringify(missingCurrentFulfillment.checkout_pack_baseline)),
  checkoutPackBaseline,
  'Resolving current fulfillment authority must never mutate checkout baseline A',
)
assert.throws(
  () => assertCurrentFulfillmentPackEvidenceAvailable({
    mode: 'production',
    productTitle: missingCurrentFulfillment.product_title_snapshot,
    checkoutPackBaseline: missingCurrentFulfillment.checkout_pack_baseline,
    source: missingCurrentFulfillment.fulfillment_pack_source,
    mappingPurpose: missingCurrentFulfillment.pack_mapping_purpose,
  }),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_FULFILLMENT_PACK_MAPPING_REQUIRED'
  ),
  'Fulfillment must fail closed with actionable evidence when replacement mapping B is missing',
)

const currentFulfillmentRow = {
    line_global_id: 'gcol0000001',
    pack_mapping_id: '00000000-0000-4000-8000-000000000021',
    pack_mapping_global_id: 'gcvm0000002',
    pack_mapping_row_version: '1',
    pack_mapping_is_current: true,
    pack_mapping_projection_state: 'current',
    pack_mapping_source_revision: 'source-revision-b',
    pack_mapping_source_hash: 'source-hash-b',
    pack_mapping_pack_evidence_hash: 'b'.repeat(64),
    pack_mapping_purpose: 'shopify_checkout',
    channel_source_revision: 'source-revision-b',
    channel_source_hash: 'source-hash-b',
    channel_pack_evidence_hash: 'b'.repeat(64),
    channel_provider_status_raw: 'ACTIVE',
    channel_normalized_status: 'active',
    channel_provider_active: true,
    channel_requires_shipping: true,
    channel_weight_grams: 2040,
    pack_profile_version_id: '00000000-0000-4000-8000-000000000031',
    pack_profile_version_global_id: 'gppv0000002',
    pack_profile_version_row_version: '1',
    pack_profile_is_current: true,
    pack_profile_lifecycle_state: 'active',
    pack_profile_fit_model: 'rigid_3d',
    pack_profile_evidence_type: 'customer_confirmed',
    pack_profile_evidence_reference: 'replacement-dimensions',
    pack_profile_confirmed_at: '2026-07-31T00:00:00.000Z',
    pack_profile_status: 'active',
    pack_profile_package_level: 'case',
    pack_profile_base_each_quantity: 12,
    pack_profile_ships_as_own_package: true,
    pack_profile_length_mm: 279,
    pack_profile_width_mm: 229,
    pack_profile_height_mm: 178,
    pack_profile_dimension_basis: 'outer',
    pack_profile_gross_weight_grams: 2040,
    pack_profile_weight_basis: 'customer_confirmed',
  }
const currentFulfillment = applyCurrentFulfillmentPackLineage(
  [fulfillmentCandidate],
  [currentFulfillmentRow],
)[0]
assert.equal(currentFulfillment.pack_mapping_global_id, 'gcvm0000002')
assert.equal(currentFulfillment.pack_profile_version_global_id, 'gppv0000002')
assert.deepEqual(
  JSON.parse(JSON.stringify(currentFulfillment.checkout_pack_baseline)),
  checkoutPackBaseline,
  'Current fulfillment mapping B must be independent from immutable checkout baseline A',
)
assert.doesNotThrow(
  () => assertCurrentFulfillmentPackEvidenceAvailable({
    mode: 'production',
    productTitle: currentFulfillment.product_title_snapshot,
    checkoutPackBaseline: currentFulfillment.checkout_pack_baseline,
    source: currentFulfillment.fulfillment_pack_source,
    mappingPurpose: currentFulfillment.pack_mapping_purpose,
  }),
  'An exact current Shopify checkout mapping B is valid fulfillment authority',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    buildShopifyFulfillmentPackEvidence(currentFulfillment),
  )),
  {
    providerProductId: 'gid://shopify/Product/10',
    providerVariantId: 'gid://shopify/ProductVariant/20',
    accountEnvironment: 'sandbox',
    mappingPurpose: 'shopify_checkout',
    mappingGlobalId: 'gcvm0000002',
    mappingRowVersion: 1,
    mappingSourceRevision: 'source-revision-b',
    mappingSourceHash: 'source-hash-b',
    mappingPackEvidenceHash: 'b'.repeat(64),
    channelSourceRevision: 'source-revision-b',
    channelSourceHash: 'source-hash-b',
    channelPackEvidenceHash: 'b'.repeat(64),
    channelProviderStatusRaw: 'ACTIVE',
    channelNormalizedStatus: 'active',
    channelProviderActive: true,
    channelRequiresShipping: true,
    profileVersionGlobalId: 'gppv0000002',
    profileRowVersion: 1,
    fitModel: 'rigid_3d',
    packageLevel: 'case',
    baseEachQuantity: 12,
    shipsAsOwnPackage: true,
    dimensionsMm: { length: 279, width: 229, height: 178 },
    dimensionBasis: 'outer',
    grossWeightGrams: 2040,
    weightBasis: 'customer_confirmed',
    channelWeightGrams: 2040,
  },
  'Fulfillment evidence must durably retain mapping B hashes, identity, version, and physical facts',
)
const lateMappedReceiptExempt = applyCurrentFulfillmentPackLineage(
  [{
    ...fulfillmentCandidate,
    mapping_state: 'unresolved',
    packaging_state: 'unresolved',
    packaging_source: 'manual_package',
    packaging_weight_source: 'provider_order',
    pack_mapping_id: null,
    pack_mapping_global_id: null,
    captured_pack_mapping_row_version: null,
    current_pack_mapping_row_version: null,
    pack_profile_version_id: null,
    pack_profile_version_global_id: null,
    captured_pack_profile_row_version: null,
    current_pack_profile_row_version: null,
    pack_lineage_source: 'order_candidate_capture',
    checkout_receipt_global_id: null,
    checkout_pack_baseline: null,
  }],
  [currentFulfillmentRow],
)[0]
const mappedLateReceiptExempt = mapCandidateLines(
  { mode: 'production' },
  [lateMappedReceiptExempt],
)[0]
assert.equal(
  mappedLateReceiptExempt.evidence.variantPackMappingGlobalId,
  'gcvm0000002',
  'A receipt-exempt promoted Shopify order must use the exact late current mapping',
)
assert.equal(
  mappedLateReceiptExempt.evidence.checkoutReceiptGlobalId,
  null,
  'Late current fulfillment mapping must not invent checkout receipt lineage',
)
assert.equal(
  mappedLateReceiptExempt.evidence.fulfillmentPackSource,
  'current_shopify_checkout_mapping',
  'Late current mapping authority must be explicit in durable line evidence',
)
const preservedReceiptExemptCapture =
  applyCurrentFulfillmentPackLineage(
    [{
      ...fulfillmentCandidate,
      channel_normalized_status: 'active',
      channel_provider_active: true,
      channel_requires_shipping: true,
      pack_lineage_source: 'order_candidate_capture',
      checkout_receipt_global_id: null,
      checkout_pack_baseline: null,
    }],
    [],
    { preserveCandidateWhenMissing: true },
  )[0]
assert.equal(
  preservedReceiptExemptCapture.pack_mapping_global_id,
  fulfillmentCandidate.pack_mapping_global_id,
  'A receipt-exempt import must retain valid candidate capture when no current checkout mapping exists',
)
assert.doesNotThrow(
  () => mapCandidateLines(
    { mode: 'production' },
    [preservedReceiptExemptCapture],
  ),
  'Valid candidate-captured pack evidence remains usable for receipt-exempt imports',
)

const sandboxUnlistedFulfillment = applyCurrentFulfillmentPackLineage(
  [fulfillmentCandidate],
  [{
    ...currentFulfillmentRow,
    channel_provider_status_raw: 'UNLISTED',
    channel_normalized_status: 'unlisted',
    channel_provider_active: false,
  }],
)[0]
assert.equal(
  isHybridCartonizationFulfillmentChannelEligible({
    provider: sandboxUnlistedFulfillment.provider,
    accountEnvironment: sandboxUnlistedFulfillment.account_environment,
    providerStatusRaw:
      sandboxUnlistedFulfillment.channel_provider_status_raw,
    normalizedStatus:
      sandboxUnlistedFulfillment.channel_normalized_status,
    providerActive: sandboxUnlistedFulfillment.channel_provider_active,
    requiresShipping:
      sandboxUnlistedFulfillment.channel_requires_shipping,
    weightGrams: sandboxUnlistedFulfillment.channel_weight_grams,
    mappingPurpose: sandboxUnlistedFulfillment.pack_mapping_purpose,
  }),
  true,
  'Truthful Shopify sandbox UNLISTED evidence is eligible for fulfillment',
)
const mappedSandboxUnlisted = mapCandidateLines(
  { mode: 'production' },
  [sandboxUnlistedFulfillment],
)[0]
assert.deepEqual(
  {
    accountEnvironment:
      mappedSandboxUnlisted.evidence.fulfillmentPackEvidence
        .accountEnvironment,
    providerStatusRaw:
      mappedSandboxUnlisted.evidence.fulfillmentPackEvidence
        .channelProviderStatusRaw,
    normalizedStatus:
      mappedSandboxUnlisted.evidence.fulfillmentPackEvidence
        .channelNormalizedStatus,
    providerActive:
      mappedSandboxUnlisted.evidence.fulfillmentPackEvidence
        .channelProviderActive,
  },
  {
    accountEnvironment: 'sandbox',
    providerStatusRaw: 'UNLISTED',
    normalizedStatus: 'unlisted',
    providerActive: false,
  },
  'Fulfillment evidence must retain truthful sandbox UNLISTED lifecycle facts',
)
const productionUnlistedFulfillment = applyCurrentFulfillmentPackLineage(
  [{ ...fulfillmentCandidate, account_environment: 'production' }],
  [{
    ...currentFulfillmentRow,
    channel_provider_status_raw: 'UNLISTED',
    channel_normalized_status: 'unlisted',
    channel_provider_active: false,
  }],
)[0]
assert.doesNotThrow(
  () => mapCandidateLines(
    { mode: 'production' },
    [productionUnlistedFulfillment],
  ),
  'A truthful production Shopify UNLISTED checkout mapping remains eligible for rating',
)
for (const [label, candidatePatch, currentPatch] of [
  ['mock environment', { account_environment: 'mock' }, {}],
  ['raw lifecycle mismatch', {}, { channel_provider_status_raw: 'ACTIVE' }],
  ['provider-active mismatch', {}, { channel_provider_active: true }],
  ['non-shipping variant', {}, { channel_requires_shipping: false }],
  ['zero provider weight', {}, { channel_weight_grams: 0 }],
]) {
  const invalidUnlistedFulfillment =
    applyCurrentFulfillmentPackLineage(
      [{ ...fulfillmentCandidate, ...candidatePatch }],
      [{
        ...currentFulfillmentRow,
        channel_provider_status_raw: 'UNLISTED',
        channel_normalized_status: 'unlisted',
        channel_provider_active: false,
        ...currentPatch,
      }],
    )[0]
  assert.throws(
    () => mapCandidateLines(
      { mode: 'production' },
      [invalidUnlistedFulfillment],
    ),
    (error) => (
      error instanceof HybridCartonizationPersistenceError
      && error.code
        === 'HYBRID_CARTONIZATION_FULFILLMENT_PACK_EVIDENCE_INVALID'
    ),
    `Shopify UNLISTED fulfillment must reject ${label}`,
  )
}
const sandboxUnlistedCatalogMapping =
  applyCurrentFulfillmentPackLineage(
    [fulfillmentCandidate],
    [{
      ...currentFulfillmentRow,
      pack_mapping_purpose: 'catalog',
      channel_provider_status_raw: 'UNLISTED',
      channel_normalized_status: 'unlisted',
      channel_provider_active: false,
    }],
  )[0]
assert.throws(
  () => mapCandidateLines(
    { mode: 'production' },
    [sandboxUnlistedCatalogMapping],
  ),
  (error) => (
    error instanceof HybridCartonizationPersistenceError
    && error.code
      === 'HYBRID_CARTONIZATION_FULFILLMENT_PACK_MAPPING_REQUIRED'
  ),
  'Shopify sandbox UNLISTED must not accept a catalog mapping as checkout authority',
)
assert.doesNotThrow(
  () => mapCandidateLines(
    { mode: 'production' },
    [{ ...currentFulfillment, account_environment: 'production' }],
  ),
  'A truthful ACTIVE Shopify production channel remains eligible',
)
for (const [label, channelEligibilityPatch] of [
  ['inactive channel status', { channel_normalized_status: 'archived' }],
  ['provider-inactive channel', { channel_provider_active: false }],
  ['non-shipping channel', { channel_requires_shipping: false }],
  ['raw active lifecycle mismatch', {
    channel_provider_status_raw: 'UNLISTED',
  }],
]) {
  const ineligibleCurrentFulfillment = applyCurrentFulfillmentPackLineage(
    [fulfillmentCandidate],
    [{ ...currentFulfillmentRow, ...channelEligibilityPatch }],
  )[0]
  assert.throws(
    () => mapCandidateLines(
      { mode: 'production' },
      [ineligibleCurrentFulfillment],
    ),
    (error) => (
      error instanceof HybridCartonizationPersistenceError
      && error.code
        === 'HYBRID_CARTONIZATION_FULFILLMENT_PACK_EVIDENCE_INVALID'
    ),
    `Current fulfillment mapping B must reject ${label}`,
  )
}
const mappedCurrentFulfillment = mapCandidateLines(
  { mode: 'production' },
  [currentFulfillment],
)[0]
assert.deepEqual(
  JSON.parse(JSON.stringify(mappedCurrentFulfillment.line.profile)),
  {
    versionGlobalId: 'gppv0000002',
    capturedRowVersion: 1,
    currentRowVersion: 1,
    isCurrent: true,
    lifecycleState: 'active',
    fitModel: 'rigid_3d',
    evidenceType: 'customer_confirmed',
    evidenceReference: 'replacement-dimensions',
    confirmedAt: '2026-07-31T00:00:00.000Z',
    packageLevel: 'case',
    baseEachQuantity: 12,
    shipsAsOwnPackage: true,
    outerDimensionsMm: { length: 279, width: 229, height: 178 },
    grossWeightGrams: 2040,
  },
  'Optimizer input must use current fulfillment mapping B package-level physical facts',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    mappedCurrentFulfillment.evidence.fulfillmentPackEvidence,
  )),
  JSON.parse(JSON.stringify(
    buildShopifyFulfillmentPackEvidence(currentFulfillment),
  )),
  'Mapped line evidence must retain the same durable fulfillment mapping B proof',
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
    activeReservedQuantity: 0,
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
    activeReservedQuantity: 0,
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
    activeReservedQuantity: 0,
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
    activeReservedQuantity: 0,
    assumedCommittedQuantity: 0,
    effectiveAvailableQuantity: 2,
    sourceLevelGlobalIds: ['giil0000001'],
    sourceProjectionStates: ['projected'],
  },
  'Shopify production evidence must use provider commitment without an operator attribution assumption',
)
const faireProductionInventory =
  evaluateHybridCartonizationInventoryAvailability({
    mode: 'production',
    provider: 'faire',
    lines: [{
      lineGlobalId: 'gcol0000001',
      productGlobalId: 'gp0000001',
      requiredQuantity: 2,
    }],
    positions: [{
      productGlobalId: 'gp0000001',
      operationalAvailableQuantity: 3,
      providerCommittedQuantity: 0,
      sourceLevelGlobalIds: [],
      sourcePositionGlobalIds: ['giv0000001'],
      sourceProjectionStates: ['projected'],
    }],
    assumedCommittedQuantities: [],
  })
assert.deepEqual(
  JSON.parse(JSON.stringify(faireProductionInventory.products[0])),
  {
    productGlobalId: 'gp0000001',
    requiredQuantity: 2,
    availabilityAuthority: 'operational_available',
    operationalAvailableQuantity: 3,
    providerCommittedQuantity: 0,
    activeReservedQuantity: 0,
    assumedCommittedQuantity: 0,
    effectiveAvailableQuantity: 3,
    sourceLevelGlobalIds: [],
    sourcePositionGlobalIds: ['giv0000001'],
    sourceProjectionStates: ['projected'],
  },
  'Faire production evidence must use current ClawPilot-local inventory positions',
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
  "const inventoryRun = account.provider === 'shopify'",
  "position.source_authority = 'clawpilot'",
  'sourcePositionGlobalIds',
  'syncRunGlobalId: inventoryRun?.global_id || null',
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
  'reservation.position_id = position.id',
  "reservation.reservation_authority = 'provider_commitment'",
  'activeReservedQuantity',
  'HYBRID_CARTONIZATION_MATERIAL_RATE_EVIDENCE_REQUIRED',
  'candidate.checkout_shipping_service_code',
  'reconciliation.outcome,',
  'operations_shopify_checkout_rate_current_reconciliations',
  'line.ordered_quantity::text',
  'row.ordered_quantity',
  'const activeCandidateLines = candidateLines.filter',
  'const unfulfilledRows = lineageRows.filter',
  "pack_mapping.mapping_purpose = 'shopify_checkout'",
  'product_mapping.external_product_id = line.external_product_id',
  'product_mapping.external_variant_id = line.external_variant_id',
  'product_mapping.active = true',
  'applyMatchedCheckoutPackLineage',
  'applyCurrentFulfillmentPackLineage',
  "packLineageSource: row.pack_lineage_source",
  'checkoutReceiptGlobalId: row.checkout_receipt_global_id',
  'fulfillmentPackSource:',
  'checkoutPackBaseline: row.checkout_pack_baseline',
  'HYBRID_CARTONIZATION_CHECKOUT_PACK_LINEAGE_INVALID',
  'HYBRID_CARTONIZATION_FULFILLMENT_PACK_MAPPING_REQUIRED',
  'HYBRID_CARTONIZATION_FULFILLMENT_PACK_EVIDENCE_INVALID',
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

const receiptBaselineReadSource = source.slice(
  source.indexOf('async function readMatchedCheckoutPackLineage'),
  source.indexOf('function applyMatchedCheckoutPackLineage'),
)
for (const mutableCheckoutJoin of [
  'operations_commerce_variant_pack_mappings',
  'operations_product_pack_profile_versions',
  'operations_product_channel_states',
]) {
  assert.doesNotMatch(
    receiptBaselineReadSource,
    new RegExp(mutableCheckoutJoin),
    `Immutable checkout receipt reads must not join mutable ${mutableCheckoutJoin}`,
  )
}
assert.doesNotMatch(
  source,
  /shopify.*mutation|mutation.*shopify/i,
  'Hybrid cartonization evidence reads must not write back to Shopify',
)

console.log('Hybrid cartonization persistence contract passed')
