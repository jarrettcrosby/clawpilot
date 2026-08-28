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

const hybrid = load('app_src/lib/operations/hybridCartonization.ts')
const unitMaterial = load(
  'app_src/lib/operations/operationalUnitMaterialCartonization.ts',
  { '@/lib/operations/hybridCartonization': hybrid },
)
const checkout = load(
  'app_src/lib/operations/shopifyCheckoutRating.ts',
  {
    '@/lib/operations/hybridCartonization': hybrid,
    '@/lib/operations/operationalUnitMaterialCartonization': unitMaterial,
  },
)

function input() {
  return {
    mode: 'production',
    lines: [{
      lineGlobalId: 'line-1',
      productGlobalId: 'gp0000001',
      title: 'Apple Crisp 6 oz',
      quantity: 12,
      unitWeightGrams: 170,
      profile: {
        versionGlobalId: 'gppv0000001',
        capturedRowVersion: 1,
        currentRowVersion: 1,
        isCurrent: true,
        lifecycleState: 'active',
        fitModel: 'approved_recipe_only',
        evidenceType: 'customer_confirmed',
        evidenceReference: 'AG customer pack dimensions',
        confirmedAt: '2026-07-29T12:00:00.000Z',
      },
    }],
    recipes: [{
      recipeGlobalId: 'gpre0000001',
      productGlobalId: 'gp0000001',
      inputPackProfileVersionGlobalId: 'gppv0000001',
      outputPackProfileVersionGlobalId: 'gppv0000002',
      packagingMaterialGlobalId: 'gpkm0000001',
      recipeType: 'exact_case',
      maximumInputQuantity: 12,
      minimumInputQuantity: 12,
      contentCompatibilityKey: 'ag-6oz',
      allowsMixedProducts: false,
      exclusiveContents: true,
      capturedRowVersion: 1,
      currentRowVersion: 1,
      isCurrent: true,
      lifecycleState: 'active',
      fitEvidenceType: 'customer_confirmed',
      fitEvidenceReference: 'AG12V2 case of 12',
      confirmedAt: '2026-07-29T12:00:00.000Z',
    }],
    materials: [{
      materialGlobalId: 'gpkm0000001',
      capturedRowVersion: 1,
      currentRowVersion: 1,
      isCurrent: true,
      status: 'active',
      innerDimensionsMm: {
        length: 279,
        width: 229,
        height: 178,
      },
      dimensionBasis: 'inner',
      dimensionEvidenceType: 'customer_confirmed',
      dimensionEvidenceReference: 'AG customer shipping-box dimensions',
      dimensionConfirmedAt: '2026-07-29T12:00:00.000Z',
      tareWeightGrams: 200,
      ratedOuterDimensionsMm: {
        length: 280,
        width: 230,
        height: 180,
      },
    }],
  }
}

assert.equal(
  checkout.shopifyProductGid('48447225880'),
  'gid://shopify/Product/48447225880',
)
assert.equal(
  checkout.shopifyVariantGid('258644705304'),
  'gid://shopify/ProductVariant/258644705304',
)
assert.throws(
  () => checkout.shopifyVariantGid('2.58644705304e11'),
  (error) => error.code === 'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID',
)

const ready = checkout.planShopifyCheckoutPackages(input())
assert.equal(ready.plan.status, 'ready')
assert.equal(ready.parcels.length, 1)
assert.match(ready.parcels[0].packageKey, /^hpkg-[a-f0-9]{20}$/)
assert.deepEqual(JSON.parse(JSON.stringify({
  ...ready.parcels[0],
  packageKey: 'stable-plan-package',
})), {
  packageKey: 'stable-plan-package',
  description: 'ClawPilot carton 1',
  exteriorInches: { length: 12, width: 10, height: 8 },
  grossPounds: 5,
})
assert.equal(ready.plan.recipePackages[0].lineAllocations[0].quantity, 12)

const alternatives = input()
alternatives.lines[0].quantity = 20
alternatives.materials.push({
  ...structuredClone(alternatives.materials[0]),
  materialGlobalId: 'gpkm0000002',
  ratedOuterDimensionsMm: {
    length: 240,
    width: 180,
    height: 120,
  },
})
alternatives.recipes.push({
  ...structuredClone(alternatives.recipes[0]),
  recipeGlobalId: 'gpre0000002',
  packagingMaterialGlobalId: 'gpkm0000002',
  recipeType: 'max_capacity',
  maximumInputQuantity: 6,
  minimumInputQuantity: 1,
})
const bounded = checkout.planShopifyCheckoutPackageCandidates(
  alternatives,
  {
    maxCandidates: 4,
    materialPreferenceOrder: ['gpkm0000001', 'gpkm0000002'],
  },
)
assert.equal(bounded.length, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(bounded.map((candidate) => (
    candidate.parcels.length
  )))),
  [3, 4],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(bounded.map((candidate) => (
    candidate.candidateKey
  )))),
  JSON.parse(JSON.stringify(
    checkout.planShopifyCheckoutPackageCandidates(
      alternatives,
      {
        maxCandidates: 4,
        materialPreferenceOrder: ['gpkm0000001', 'gpkm0000002'],
      },
    ).map((candidate) => candidate.candidateKey),
  )),
)
assert.equal(
  checkout.planShopifyCheckoutPackageCandidates(
    alternatives,
    { maxCandidates: 1 },
  ).length,
  1,
)

const weightConstrained = input()
weightConstrained.lines[0].quantity = 20
weightConstrained.recipes[0].recipeType = 'max_capacity'
weightConstrained.recipes[0].maximumInputQuantity = 20
weightConstrained.recipes[0].minimumInputQuantity = 1
weightConstrained.materials[0].maximumGrossWeightGrams =
  weightConstrained.materials[0].tareWeightGrams
  + (10 * weightConstrained.lines[0].unitWeightGrams)
weightConstrained.materials[0].availableQuantity = 2
const weightConstrainedReady =
  checkout.planShopifyCheckoutPackages(weightConstrained)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    weightConstrainedReady.plan.recipePackages.map(
      (plannedPackage) => plannedPackage.totalInputQuantity,
    ),
  )),
  [10, 10],
  'an evidenced gross-weight limit must split an overweight carton during planning',
)

const stockConstrained = input()
stockConstrained.lines[0].quantity = 20
stockConstrained.recipes[0].recipeType = 'max_capacity'
stockConstrained.recipes[0].minimumInputQuantity = 1
stockConstrained.materials[0].availableQuantity = 1
stockConstrained.materials.push({
  ...structuredClone(stockConstrained.materials[0]),
  materialGlobalId: 'gpkm0000002',
  availableQuantity: 2,
})
stockConstrained.recipes.push({
  ...structuredClone(stockConstrained.recipes[0]),
  recipeGlobalId: 'gpre0000002',
  packagingMaterialGlobalId: 'gpkm0000002',
  maximumInputQuantity: 6,
})
const stockConstrainedReady =
  checkout.planShopifyCheckoutPackages(stockConstrained)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    stockConstrainedReady.plan.recipePackages.map(
      (plannedPackage) => plannedPackage.packagingMaterialGlobalId,
    ),
  )),
  ['gpkm0000001', 'gpkm0000002', 'gpkm0000002'],
  'material stock must cause a feasible mixed-material plan instead of a post-plan rejection',
)

const independentPools = input()
independentPools.materials.push({
  ...structuredClone(independentPools.materials[0]),
  materialGlobalId: 'gpkm0000002',
})
independentPools.recipes.push({
  ...structuredClone(independentPools.recipes[0]),
  recipeGlobalId: 'gpre0000002',
  packagingMaterialGlobalId: 'gpkm0000002',
})
independentPools.lines.push({
  ...structuredClone(independentPools.lines[0]),
  lineGlobalId: 'line-2',
  productGlobalId: 'gp0000002',
  title: 'Bacon Bites 6 oz',
  profile: {
    ...structuredClone(independentPools.lines[0].profile),
    versionGlobalId: 'gppv0000003',
  },
})
independentPools.recipes.push(
  {
    ...structuredClone(independentPools.recipes[0]),
    recipeGlobalId: 'gpre0000003',
    productGlobalId: 'gp0000002',
    inputPackProfileVersionGlobalId: 'gppv0000003',
  },
  {
    ...structuredClone(independentPools.recipes[1]),
    recipeGlobalId: 'gpre0000004',
    productGlobalId: 'gp0000002',
    inputPackProfileVersionGlobalId: 'gppv0000003',
  },
)
const mixedPoolCandidates = checkout.planShopifyCheckoutPackageCandidates(
  independentPools,
  {
    maxCandidates: 4,
    materialPreferenceOrder: ['gpkm0000001', 'gpkm0000002'],
  },
)
const mixedPoolMaterialChoices = mixedPoolCandidates.map((candidate) => (
  candidate.plan.recipePackages
    .map((plannedPackage) => plannedPackage.packagingMaterialGlobalId)
    .join('|')
))
assert.ok(
  mixedPoolMaterialChoices.includes('gpkm0000001|gpkm0000002'),
  'bounded search must generate mixed choices across independent pools',
)
assert.ok(
  mixedPoolMaterialChoices.includes('gpkm0000002|gpkm0000001'),
  'bounded search must explore the inverse independent-pool choice',
)

const sealedCase = input()
sealedCase.lines[0] = {
  ...sealedCase.lines[0],
  quantity: 2,
  unitWeightGrams: 2268,
  profile: {
    ...sealedCase.lines[0].profile,
    packageLevel: 'case',
    baseEachQuantity: 12,
    shipsAsOwnPackage: true,
    outerDimensionsMm: {
      length: 279,
      width: 229,
      height: 178,
    },
    grossWeightGrams: 2268,
  },
}
sealedCase.recipes = []
sealedCase.materials = []
const oneSealedCase = structuredClone(sealedCase)
oneSealedCase.lines[0].quantity = 1
const oneSealedCaseReady =
  checkout.planShopifyCheckoutPackages(oneSealedCase)
assert.equal(oneSealedCaseReady.plan.selfPackages.length, 1)
assert.equal(oneSealedCaseReady.parcels.length, 1)
const sealedCaseReady = checkout.planShopifyCheckoutPackages(sealedCase)
assert.equal(sealedCaseReady.plan.recipePackages.length, 0)
assert.equal(sealedCaseReady.plan.selfPackages.length, 2)
assert.equal(sealedCaseReady.parcels.length, 2)
assert.deepEqual(
  JSON.parse(JSON.stringify(sealedCaseReady.plan.selfPackages.map(
    (item) => item.lineAllocations[0].quantity,
  ))),
  [1, 1],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    sealedCaseReady.parcels.map((item) => item.description),
  )),
  ['ClawPilot sealed case 1', 'ClawPilot sealed case 2'],
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    sealedCaseReady.parcels.map((item) => item.grossPounds),
  )),
  [5.1, 5.1],
)

const mixedUnitMaterial = input()
mixedUnitMaterial.materials[0].availableQuantity = 3
mixedUnitMaterial.materials[0].maximumGrossWeightGrams = 10_000
mixedUnitMaterial.lines.push({
  lineGlobalId: 'line-self',
  productGlobalId: 'gp0000002',
  title: 'Sealed Bakery Bites case',
  quantity: 1,
  unitWeightGrams: 2268,
  profile: {
    ...structuredClone(mixedUnitMaterial.lines[0].profile),
    versionGlobalId: 'gppv0000003',
    packageLevel: 'case',
    baseEachQuantity: 12,
    shipsAsOwnPackage: true,
    outerDimensionsMm: {
      length: 279,
      width: 229,
      height: 178,
    },
    grossWeightGrams: 2268,
  },
}, {
  lineGlobalId: 'line-unit',
  productGlobalId: 'gp0000003',
  title: 'Ordinary Bakery Bites unit',
  quantity: 2,
  unitWeightGrams: 340,
  profile: {
    versionGlobalId: 'unit-item:line-unit',
    capturedRowVersion: 0,
    currentRowVersion: 0,
    isCurrent: true,
    lifecycleState: 'active',
    fitModel: 'unconstrained_unit',
    evidenceType: 'provider',
    evidenceReference: 'shopify-checkout-revision-1',
    confirmedAt: null,
    packageLevel: 'each',
    baseEachQuantity: 1,
    shipsAsOwnPackage: false,
    outerDimensionsMm: null,
    grossWeightGrams: 340,
  },
})
const checkoutUnitInventory = [{
  productGlobalId: 'gp0000003',
  availabilityAuthority: 'shopify_checkout_available_snapshot',
  effectiveAvailableQuantity: 2,
  sourceLevelGlobalIds: ['gcil0000003'],
}]
const mixedUnitCandidates = checkout.planShopifyCheckoutPackageCandidates(
  mixedUnitMaterial,
  {
    maxCandidates: 1,
    unitMaterialInventoryProducts: checkoutUnitInventory,
  },
)
assert.equal(mixedUnitCandidates.length, 1)
assert.equal(mixedUnitCandidates[0].plan.selfPackages.length, 1)
assert.equal(mixedUnitCandidates[0].plan.recipePackages.length, 1)
assert.equal(mixedUnitCandidates[0].unitMaterialPlan.status, 'ready')
assert.deepEqual(
  JSON.parse(JSON.stringify(
    mixedUnitCandidates[0].unitMaterialPlan.packages.map((item) => ({
      sequence: item.packageSequence,
      method: item.planningMethod,
      quantity: item.allocations[0].quantity,
    })),
  )),
  [
    { sequence: 3, method: 'unit_material_selection', quantity: 1 },
    { sequence: 4, method: 'unit_material_selection', quantity: 1 },
  ],
)
assert.equal(
  mixedUnitCandidates[0].unitMaterialPlan.evidence.inventoryAuthority,
  'shopify_checkout_available_snapshot',
)
assert.equal(
  mixedUnitCandidates[0].unitMaterialPlan.evidence.materialAuthority,
  'selected_material_stock_snapshot',
)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    mixedUnitCandidates[0].parcels.map((item) => item.description),
  )),
  [
    'ClawPilot sealed case 1',
    'ClawPilot carton 2',
    'ClawPilot carton 3',
    'ClawPilot carton 4',
  ],
  'self, recipe, and one-each material packages must form one conserved shipment',
)
assert.equal(mixedUnitCandidates[0].parcels.length, 4)
assert.match(mixedUnitCandidates[0].candidateKey, /^hcan-[a-f0-9]{20}$/)
assert.equal(
  checkout.planShopifyCheckoutPackageCandidates(
    mixedUnitMaterial,
    {
      maxCandidates: 1,
      unitMaterialInventoryProducts: checkoutUnitInventory,
    },
  )[0].candidateKey,
  mixedUnitCandidates[0].candidateKey,
  'unit-material candidate evidence must remain deterministic',
)

const mixedUnitReady = checkout.planShopifyCheckoutPackages(
  mixedUnitMaterial,
  { unitMaterialInventoryProducts: checkoutUnitInventory },
)
assert.equal(mixedUnitReady.unitMaterialPlan.packages.length, 2)
assert.equal(mixedUnitReady.parcels.length, 4)

assert.throws(
  () => checkout.planShopifyCheckoutPackageCandidates(
    mixedUnitMaterial,
    {
      maxCandidates: 1,
      unitMaterialInventoryProducts: [{
        ...checkoutUnitInventory[0],
        effectiveAvailableQuantity: 1,
      }],
    },
  ),
  (error) => (
    error.code
      === 'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_INVENTORY_REQUIRED'
  ),
  'checkout availability is a fail-closed quote snapshot, not a reservation',
)

const mixedUnitMaterialStockShort = structuredClone(mixedUnitMaterial)
mixedUnitMaterialStockShort.materials[0].availableQuantity = 2
assert.throws(
  () => checkout.planShopifyCheckoutPackageCandidates(
    mixedUnitMaterialStockShort,
    {
      maxCandidates: 1,
      unitMaterialInventoryProducts: checkoutUnitInventory,
    },
  ),
  (error) => (
    error.code
      === 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED'
  ),
  'unit cartons must consume only stock remaining after recipe cartons',
)

const fallback = input()
fallback.lines[0].profile.fitModel = 'rigid_3d'
fallback.recipes = []
assert.throws(
  () => checkout.planShopifyCheckoutPackages(fallback),
  (error) => error.code === 'SHOPIFY_CHECKOUT_GEOMETRY_FALLBACK_UNSUPPORTED',
)

const missingOuter = input()
missingOuter.materials[0].ratedOuterDimensionsMm = null
assert.throws(
  () => checkout.planShopifyCheckoutPackages(missingOuter),
  (error) => error.code === 'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_MISSING',
)

const sandbox = input()
sandbox.mode = 'sandbox_demo'
assert.throws(
  () => checkout.planShopifyCheckoutPackages(sandbox),
  (error) => error.code === 'SHOPIFY_CHECKOUT_PRODUCTION_EVIDENCE_REQUIRED',
)

console.log('Shopify checkout cartonization tests passed')
