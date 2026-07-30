import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as productPackManagement from '../../lib/operations/productPackManagement.ts'
import type {
  ApprovedPackRecipeInput,
  ProductPackProfileVersionInput,
} from '../../lib/operations/productPackManagement.ts'

const {
  ProductPackInputError,
  validateApprovedPackRecipeInput,
  validateProductPackProfileVersionInput,
} = productPackManagement

function activeEachProfile(
  overrides: Partial<ProductPackProfileVersionInput> = {},
): ProductPackProfileVersionInput {
  return {
    productGlobalId: 'gp0000001',
    profileGlobalId: null,
    expectedProfileRowVersion: null,
    expectedCurrentVersionGlobalId: null,
    expectedCurrentVersionRowVersion: null,
    profileKey: 'shopify-each',
    profileName: 'Shopify each',
    packageLevel: 'each',
    isDefault: true,
    profileStatus: 'active',
    lifecycleState: 'active',
    baseEachQuantity: 1,
    unitOfMeasure: 'each',
    dimensionsMm: {
      length: 203,
      width: 152,
      height: 51,
    },
    dimensionBasis: 'outer',
    grossWeightGrams: 170,
    weightBasis: 'customer_stated',
    fitModel: 'compressible',
    shipsAsOwnPackage: false,
    assemblyPolicy: 'never',
    evidenceType: 'customer_confirmed',
    evidenceReference: 'AG Alchemy 6 oz bag specification',
    source: 'customer_supplied',
    providerWeightEvidence: null,
    ...overrides,
  }
}

function activeExactCaseRecipe(
  overrides: Partial<ApprovedPackRecipeInput> = {},
): ApprovedPackRecipeInput {
  return {
    productGlobalId: 'gp0000001',
    recipeGlobalId: null,
    expectedRecipeRowVersion: null,
    recipeKey: 'twelve-bags-to-case',
    recipeName: '12 bags to one case',
    inputProfileVersionGlobalId: 'gppv0000001',
    expectedInputProfileVersionRowVersion: 0,
    outputProfileVersionGlobalId: 'gppv0000002',
    expectedOutputProfileVersionRowVersion: 0,
    packagingMaterialGlobalId: 'gmat0000001',
    expectedPackagingMaterialRowVersion: 0,
    inputQuantity: 12,
    outputQuantity: 1,
    packagingMaterialQuantity: 1,
    recipeType: 'exact_case',
    minimumInputQuantity: null,
    contentCompatibilityKey: null,
    allowsMixedProducts: false,
    fulfillmentPolicy: 'prefer_full_case',
    remainderPolicy: 'case_plus_each',
    inventoryEvidenceRequirement: 'either',
    assemblyPolicy: 'never',
    exclusiveContents: true,
    lifecycleState: 'active',
    fitEvidenceType: 'customer_confirmed',
    fitEvidenceReference: 'AG Alchemy confirmed 12 bags fit AG12V2',
    source: 'customer_supplied',
    ...overrides,
  }
}

function assertInputError(
  invoke: () => unknown,
  expectedCode: string,
) {
  assert.throws(invoke, (error: unknown) => {
    assert.ok(error instanceof ProductPackInputError)
    assert.equal(error.code, expectedCode)
    return true
  })
}

test('active each profiles require exact each quantity and evidence', () => {
  const profile = activeEachProfile()
  assert.equal(
    validateProductPackProfileVersionInput(profile),
    profile,
  )

  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({ baseEachQuantity: 12 }),
    ),
    'PRODUCT_PACK_EACH_QUANTITY_INVALID',
  )
  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({ evidenceReference: null }),
    ),
    'PRODUCT_PACK_ACTIVE_EVIDENCE_REQUIRED',
  )
})

test('case profiles use case UOM and at least two base eaches', () => {
  const profile = activeEachProfile({
    profileKey: 'shopify-case',
    profileName: 'Shopify case of 12',
    packageLevel: 'case',
    baseEachQuantity: 12,
    unitOfMeasure: 'case',
    dimensionsMm: {
      length: 279,
      width: 229,
      height: 178,
    },
    grossWeightGrams: 2_200,
    fitModel: 'approved_recipe_only',
    assemblyPolicy: 'allow_from_child',
  })
  assert.equal(
    validateProductPackProfileVersionInput(profile),
    profile,
  )

  assertInputError(
    () => validateProductPackProfileVersionInput({
      ...profile,
      baseEachQuantity: 1,
    }),
    'PRODUCT_PACK_CASE_QUANTITY_INVALID',
  )
})

test('dimensions and weight cannot be stored without their evidence basis', () => {
  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({
        dimensionsMm: null,
        dimensionBasis: 'outer',
      }),
    ),
    'PRODUCT_PACK_DIMENSION_EVIDENCE_INVALID',
  )
  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({
        grossWeightGrams: null,
        weightBasis: 'customer_stated',
      }),
    ),
    'PRODUCT_PACK_WEIGHT_EVIDENCE_INVALID',
  )
})

test('stable profile and version activation cannot drift', () => {
  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({ lifecycleState: 'customer_confirmed' }),
    ),
    'PRODUCT_PACK_ACTIVATION_STATE_INVALID',
  )
})

test('provider weight requires an exact channel-state revision', () => {
  assertInputError(
    () => validateProductPackProfileVersionInput(
      activeEachProfile({ weightBasis: 'provider' }),
    ),
    'PRODUCT_PACK_PROVIDER_WEIGHT_EVIDENCE_REQUIRED',
  )

  const profile = activeEachProfile({
    weightBasis: 'provider',
    evidenceType: 'provider',
    providerWeightEvidence: {
      channelStateGlobalId: 'gpcs0000001',
      expectedChannelStateRowVersion: 4,
    },
  })
  assert.equal(
    validateProductPackProfileVersionInput(profile),
    profile,
  )
})

test('derived gross weight preserves its calculation evidence', () => {
  const profile = activeEachProfile({
    grossWeightGrams: 220,
    weightBasis: 'derived',
    evidenceType: 'derived',
    evidenceReference:
      '170 g measured contents plus 50 g evidenced inner retail packaging; outbound carton excluded',
    source: 'manual',
    providerWeightEvidence: null,
  })
  assert.equal(
    validateProductPackProfileVersionInput(profile),
    profile,
  )
})

test('active exact-case recipes preserve one-case semantics', () => {
  const recipe = activeExactCaseRecipe()
  assert.equal(validateApprovedPackRecipeInput(recipe), recipe)

  assertInputError(
    () => validateApprovedPackRecipeInput(
      activeExactCaseRecipe({ outputQuantity: 2 }),
    ),
    'PRODUCT_PACK_EXACT_CASE_OUTPUT_INVALID',
  )
  assertInputError(
    () => validateApprovedPackRecipeInput(
      activeExactCaseRecipe({
        inputProfileVersionGlobalId: 'gppv0000002',
      }),
    ),
    'PRODUCT_PACK_RECIPE_ENDPOINTS_INVALID',
  )
})

test('active and mixed recipes fail closed without fit evidence', () => {
  assertInputError(
    () => validateApprovedPackRecipeInput(
      activeExactCaseRecipe({ fitEvidenceReference: null }),
    ),
    'PRODUCT_PACK_ACTIVE_RECIPE_EVIDENCE_REQUIRED',
  )
  assertInputError(
    () => validateApprovedPackRecipeInput(
      activeExactCaseRecipe({
        recipeType: 'max_capacity',
        minimumInputQuantity: 6,
        contentCompatibilityKey: null,
        allowsMixedProducts: true,
        exclusiveContents: false,
      }),
    ),
    'PRODUCT_PACK_MIXED_RECIPE_EVIDENCE_REQUIRED',
  )
})

test('active loose-each capacity records an evidenced one-through-maximum range', () => {
  const looseEach = activeExactCaseRecipe({
    recipeKey: 'loose-each-carton',
    recipeName: 'Loose each carton (1 through 12)',
    recipeType: 'max_capacity',
    minimumInputQuantity: 1,
    fulfillmentPolicy: 'each_pick_only',
    remainderPolicy: 'all_each',
    inventoryEvidenceRequirement: 'each_assembly_allowed',
    assemblyPolicy: 'required',
    fitEvidenceReference:
      'Customer confirmed loose each quantities 1 through 12 fit AG12V2',
  })
  assert.equal(validateApprovedPackRecipeInput(looseEach), looseEach)

  assertInputError(
    () => validateApprovedPackRecipeInput({
      ...looseEach,
      minimumInputQuantity: 0,
    }),
    'PRODUCT_PACK_RECIPE_MINIMUM_REQUIRED',
  )
})
