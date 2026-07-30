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
const checkout = load(
  'app_src/lib/operations/shopifyCheckoutRating.ts',
  { '@/lib/operations/hybridCartonization': hybrid },
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
