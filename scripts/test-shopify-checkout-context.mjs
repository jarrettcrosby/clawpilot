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

function load(path, mocks = {}) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Date,
    Error,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    module,
    exports: module.exports,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const eligibility = load(
  'app_src/lib/integrations/shopifyCheckoutChannelEligibility.ts',
)

const sourceHash = 'a'.repeat(64)
const packHash = 'b'.repeat(64)
const now = new Date().toISOString()
let mappingMode = 'none'
let lineScenario = 'single'
let inventoryQueryCount = 0
let inventoryAvailableQuantity = '25'
let activeClaimedQuantity = '0'
let inventoryItemsPayload = null

function lineRow(overrides = {}) {
  const hasMapping = mappingMode !== 'none'
  const checkoutMapping = mappingMode === 'checkout'
  return {
    line_key: 'shopify-line-001',
    product_gid: 'gid://shopify/Product/1000000001',
    variant_gid: 'gid://shopify/ProductVariant/2000000001',
    product_id: '11111111-1111-4111-8111-111111111111',
    product_global_id: 'gp0000001',
    product_mapping_global_id: 'gpm0000001',
    product_title: 'Bakery Bites',
    provider_variant_title: 'Vanilla',
    provider_sku: 'BITES-VANILLA',
    external_inventory_item_id: '3000000001',
    state_requires_shipping: true,
    state_weight_grams: 170,
    state_provider_status_raw: 'ACTIVE',
    state_normalized_status: 'active',
    state_provider_active: true,
    state_source_revision: 'shopify-catalog-revision-1',
    state_source_hash: sourceHash,
    state_pack_evidence_hash: packHash,
    pack_mapping_global_id: hasMapping ? 'gcvm0000001' : null,
    pack_mapping_row_version: hasMapping ? 3 : null,
    pack_mapping_projection_state: hasMapping ? 'current' : null,
    pack_mapping_provider_lifecycle_state: hasMapping ? 'active' : null,
    pack_mapping_purpose: hasMapping
      ? checkoutMapping ? 'shopify_checkout' : 'catalog'
      : null,
    pack_mapping_source_revision: hasMapping
      ? 'shopify-catalog-revision-1'
      : null,
    pack_mapping_source_hash: hasMapping ? sourceHash : null,
    pack_mapping_pack_evidence_hash: hasMapping ? packHash : null,
    profile_version_id: checkoutMapping
      ? '22222222-2222-4222-8222-222222222222'
      : null,
    profile_version_global_id: checkoutMapping ? 'gppv0000001' : null,
    profile_version_row_version: checkoutMapping ? 7 : null,
    profile_version_is_current: checkoutMapping ? true : null,
    profile_version_lifecycle_state: checkoutMapping ? 'active' : null,
    profile_package_level: checkoutMapping ? 'each' : null,
    profile_base_each_quantity: checkoutMapping ? 1 : null,
    profile_length_mm: null,
    profile_width_mm: null,
    profile_height_mm: null,
    profile_dimension_basis: checkoutMapping ? 'unspecified' : null,
    profile_ships_as_own_package: checkoutMapping ? false : null,
    profile_fit_model: checkoutMapping ? 'approved_recipe_only' : null,
    profile_evidence_type: checkoutMapping ? 'customer_confirmed' : null,
    profile_evidence_reference: checkoutMapping ? 'Approved case pick' : null,
    profile_confirmed_at: checkoutMapping ? now : null,
    profile_gross_weight_grams: checkoutMapping ? 170 : null,
    profile_status: checkoutMapping ? 'active' : null,
    ...overrides,
  }
}

const materialRow = {
  material_id: '33333333-3333-4333-8333-333333333333',
  material_global_id: 'gmat0000001',
  expected_row_version: 4,
  current_row_version: 4,
  status: 'active',
  inner_length_mm: 300,
  inner_width_mm: 200,
  inner_height_mm: 150,
  dimension_basis: 'inner',
  dimension_evidence_type: 'measured',
  dimension_evidence_reference: null,
  dimension_confirmed_at: now,
  rated_outer_length_mm: 305,
  rated_outer_width_mm: 205,
  rated_outer_height_mm: 155,
  tare_weight_grams: 120,
  max_weight_grams: 10000,
  unit_cost_minor: 85,
  currency: 'USD',
  stock_global_id: 'gmas0000001',
  stock_row_version: 6,
  stock_is_available: true,
  stock_on_hand_quantity: 50,
  active_claimed_quantity: '0',
}

function fakeClient() {
  return {
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
      if (sql.includes('transaction_timestamp()')) {
        return { rows: [{ read_at: now }] }
      }
      if (sql.includes('operations_product_mappings product_mapping')) {
        if (lineScenario === 'duplicate_inventory_item') {
          return { rows: [
            lineRow(),
            lineRow({
              line_key: 'shopify-line-002',
              variant_gid: 'gid://shopify/ProductVariant/2000000002',
              product_mapping_global_id: 'gpm0000002',
            }),
          ] }
        }
        if (lineScenario === 'split_variant') {
          return { rows: [
            lineRow(),
            lineRow({ line_key: 'shopify-line-002' }),
          ] }
        }
        return { rows: [lineRow()] }
      }
      if (sql.includes('operations_shopify_carrier_service_configs config')) {
        return { rows: [{
          ...materialRow,
          active_claimed_quantity: activeClaimedQuantity,
        }] }
      }
      if (sql.includes('operations_approved_pack_recipes recipe')) {
        return { rows: [{
          global_id: 'gpre0000001',
          row_version: 2,
          product_id: '11111111-1111-4111-8111-111111111111',
          product_global_id: 'gp0000001',
          input_profile_version_id:
            '22222222-2222-4222-8222-222222222222',
          input_profile_version_global_id: 'gppv0000001',
          output_profile_version_global_id: 'gppv0000002',
          packaging_material_global_id: 'gmat0000001',
          recipe_type: 'max_capacity',
          input_quantity: 12,
          minimum_input_quantity: 1,
          content_compatibility_key: null,
          allows_mixed_products: false,
          exclusive_contents: true,
          lifecycle_state: 'active',
          fit_evidence_type: 'customer_confirmed',
          fit_evidence_reference: 'Approved carton fit',
          confirmed_at: now,
          is_current: true,
        }] }
      }
      if (sql.includes('operations_shopify_inventory_refresh_watermarks')) {
        return { rows: [{ dirty_version: '1', reconciled_version: '1' }] }
      }
      if (sql.includes('operations_commerce_inventory_sync_runs')) {
        return { rows: [{
          id: '44444444-4444-4444-8444-444444444444',
          global_id: 'gisr0000001',
          provider_fetched_at: now,
        }] }
      }
      if (sql.includes('operations_commerce_inventory_levels level')) {
        inventoryQueryCount += 1
        inventoryItemsPayload = JSON.parse(params[4])
        return { rows: [{
          external_inventory_item_id: '3000000001',
          operational_available_quantity: inventoryAvailableQuantity,
          source_level_global_ids: ['giil0000001'],
        }] }
      }
      throw new Error(`Unexpected checkout-context SQL: ${sql.slice(0, 120)}`)
    },
    release() {},
  }
}

const contextModule = load(
  'app_src/lib/persistence/shopifyCheckoutContext.ts',
  {
    '@/lib/integrations/shopifyCheckoutChannelEligibility': eligibility,
    '@/lib/persistence/postgres': {
      getPostgresPool: () => ({ connect: async () => fakeClient() }),
    },
  },
)

const account = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  integrationAccountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  warehouseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  configGlobalId: 'gscf0000001',
  configRowVersion: 5,
  inventoryMaxAgeSeconds: 600,
  environment: 'sandbox',
  materials: [{}],
}
const lines = [{
  lineKey: 'shopify-line-001',
  productGid: 'gid://shopify/Product/1000000001',
  variantGid: 'gid://shopify/ProductVariant/2000000001',
  sku: 'BITES-VANILLA',
  quantity: 3,
  grams: 170,
  requiresShipping: true,
}]

mappingMode = 'none'
const unitContext = await contextModule
  .readShopifyCheckoutContextFromPostgres({ account, lines })
assert.equal(unitContext.lines[0].cartonizationAuthority,
  'unit_material_selection')
assert.equal(unitContext.lines[0].productMappingGlobalId, 'gpm0000001')
assert.equal(unitContext.lines[0].packMappingGlobalId, null)
assert.equal(unitContext.input.lines[0].profile.fitModel, 'unconstrained_unit')
assert.equal(unitContext.input.lines[0].profile.grossWeightGrams, 170)
assert.deepEqual(JSON.parse(JSON.stringify(unitContext.inventoryProducts)), [{
  productGlobalId: 'gp0000001',
  availabilityAuthority: 'shopify_checkout_available_snapshot',
  effectiveAvailableQuantity: 25,
  sourceLevelGlobalIds: ['giil0000001'],
}])
assert.equal(unitContext.input.materials[0].unitCostMinor, 85)
assert.equal(unitContext.input.materials[0].currency, 'USD')

mappingMode = 'catalog'
await assert.rejects(
  () => contextModule.readShopifyCheckoutContextFromPostgres({ account, lines }),
  (error) => error.code === 'SHOPIFY_CHECKOUT_ASSIGNED_PACK_NOT_READY',
  'an assigned catalog pack must not silently downgrade to unit fallback',
)

mappingMode = 'checkout'
const packContext = await contextModule
  .readShopifyCheckoutContextFromPostgres({ account, lines })
assert.equal(packContext.lines[0].cartonizationAuthority, 'product_pack')
assert.equal(packContext.lines[0].packMappingGlobalId, 'gcvm0000001')
assert.equal(packContext.lines[0].packProfileVersionGlobalId, 'gppv0000001')
assert.equal(packContext.input.lines[0].profile.fitModel,
  'approved_recipe_only')
assert.equal(packContext.input.recipes.length, 1)

mappingMode = 'none'
lineScenario = 'duplicate_inventory_item'
inventoryQueryCount = 0
const conflictingLines = [
  { ...lines[0], quantity: 6 },
  {
    ...lines[0],
    lineKey: 'shopify-line-002',
    variantGid: 'gid://shopify/ProductVariant/2000000002',
    quantity: 6,
  },
]
await assert.rejects(
  () => contextModule.readShopifyCheckoutContextFromPostgres({
    account,
    lines: conflictingLines,
  }),
  (error) => error.code === 'SHOPIFY_CHECKOUT_INVENTORY_IDENTITY_CONFLICT',
  'two variants must never share one retained inventory item at checkout',
)
assert.equal(
  inventoryQueryCount,
  0,
  'conflicting inventory identity must fail before reading inventory levels',
)

lineScenario = 'split_variant'
inventoryAvailableQuantity = '10'
inventoryQueryCount = 0
inventoryItemsPayload = null
const splitVariantContext = await contextModule
  .readShopifyCheckoutContextFromPostgres({
    account,
    lines: [
      { ...lines[0], quantity: 3 },
      { ...lines[0], lineKey: 'shopify-line-002', quantity: 4 },
    ],
  })
assert.equal(inventoryQueryCount, 1)
assert.deepEqual(inventoryItemsPayload, [{
  product_id: '11111111-1111-4111-8111-111111111111',
  external_inventory_item_id: '3000000001',
}], 'the $5 inventory payload must deduplicate split cart lines by item')
assert.equal(splitVariantContext.inventoryProducts[0]
  .effectiveAvailableQuantity, 10)
assert.deepEqual(
  JSON.parse(JSON.stringify(splitVariantContext.lines.map((line) => (
    line.inventoryLevelGlobalIds
  )))),
  [['giil0000001'], ['giil0000001']],
  'split cart lines for one variant must share one retained level identity',
)

lineScenario = 'single'
activeClaimedQuantity = '49'
const nearlyClaimedContext = await contextModule
  .readShopifyCheckoutContextFromPostgres({ account, lines })
assert.equal(nearlyClaimedContext.materials[0].activeClaimedQuantity, 49)
assert.equal(nearlyClaimedContext.materials[0].availableQuantity, 1)
assert.equal(nearlyClaimedContext.input.materials[0].availableQuantity, 1)

activeClaimedQuantity = '50'
await assert.rejects(
  () => contextModule.readShopifyCheckoutContextFromPostgres({
    account,
    lines,
  }),
  (error) => error.code === 'SHOPIFY_CHECKOUT_MATERIAL_EVIDENCE_NOT_READY',
  'fully claimed packaging stock must not be offered to checkout cartonization',
)

console.log('Shopify checkout context unit-material contracts passed.')
