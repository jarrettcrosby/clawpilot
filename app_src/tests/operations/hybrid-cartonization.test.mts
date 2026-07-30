import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as hybrid from '../../lib/operations/hybridCartonization.ts'
import type {
  HybridCartonizationInput,
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationRecipe,
} from '../../lib/operations/hybridCartonization.ts'

const {
  HYBRID_CARTONIZATION_ALGORITHM_VERSION,
  HYBRID_CARTONIZATION_POLICY_VERSION,
  boundedPoolPreferenceFrontier,
  planHybridCartonization,
} = hybrid

const COMPATIBILITY_KEY = 'ag-alchemy.loose-six-ounce-bags.v1'
const MATERIAL_ID = 'gmat0000001'

test('bounded preference frontier covers each pool before combinations', () => {
  const frontier = boundedPoolPreferenceFrontier([
    {
      identity: 'pool-a',
      materialGlobalIds: ['gmat0000001', 'gmat0000002'],
    },
    {
      identity: 'pool-b',
      materialGlobalIds: ['gmat0000003', 'gmat0000004'],
    },
    {
      identity: 'pool-c',
      materialGlobalIds: ['gmat0000005', 'gmat0000006'],
    },
  ], 4)

  assert.equal(frontier.length, 4)
  assert.deepEqual(frontier[0], {
    'pool-a': 'gmat0000001',
    'pool-b': 'gmat0000003',
    'pool-c': 'gmat0000005',
  })
  for (const [pool, alternative] of [
    ['pool-a', 'gmat0000002'],
    ['pool-b', 'gmat0000004'],
    ['pool-c', 'gmat0000006'],
  ] as const) {
    assert.ok(
      frontier.slice(1).some((preference) => (
        preference[pool] === alternative
      )),
      `${pool} first alternative should not be excluded by pool order`,
    )
  }
})

function line(
  sequence: number,
  overrides: Partial<HybridCartonizationLine> = {},
): HybridCartonizationLine {
  const suffix = String(sequence).padStart(7, '0')
  return {
    lineGlobalId: `gcol${suffix}`,
    productGlobalId: `gp${suffix}`,
    title: `Six ounce flavor ${sequence}`,
    quantity: 1,
    unitWeightGrams: 170,
    profile: {
      versionGlobalId: `gppv${suffix}`,
      capturedRowVersion: 3,
      currentRowVersion: 3,
      isCurrent: true,
      lifecycleState: 'active',
      fitModel: 'approved_recipe_only',
      evidenceType: 'customer_confirmed',
      evidenceReference: 'customer-email-2026-07-28',
      confirmedAt: '2026-07-28T12:00:00.000Z',
    },
    ...overrides,
  }
}

function material(
  overrides: Partial<HybridCartonizationMaterial> = {},
): HybridCartonizationMaterial {
  return {
    materialGlobalId: MATERIAL_ID,
    capturedRowVersion: 4,
    currentRowVersion: 4,
    isCurrent: true,
    status: 'active',
    innerDimensionsMm: {
      length: 279,
      width: 229,
      height: 178,
    },
    dimensionBasis: 'inner',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: 'customer-email-2026-07-28',
    dimensionConfirmedAt: '2026-07-28T12:00:00.000Z',
    tareWeightGrams: 180,
    ratedOuterDimensionsMm: {
      length: 286,
      width: 236,
      height: 185,
    },
    ...overrides,
  }
}

function recipe(
  sourceLine: HybridCartonizationLine,
  overrides: Partial<HybridCartonizationRecipe> = {},
): HybridCartonizationRecipe {
  return {
    recipeGlobalId:
      `gpre${sourceLine.lineGlobalId.slice(-7)}`,
    productGlobalId: sourceLine.productGlobalId,
    inputPackProfileVersionGlobalId:
      sourceLine.profile.versionGlobalId,
    outputPackProfileVersionGlobalId:
      `gppv9${sourceLine.lineGlobalId.slice(-6)}`,
    packagingMaterialGlobalId: MATERIAL_ID,
    recipeType: 'max_capacity',
    maximumInputQuantity: 18,
    minimumInputQuantity: 12,
    contentCompatibilityKey: COMPATIBILITY_KEY,
    allowsMixedProducts: true,
    exclusiveContents: false,
    capturedRowVersion: 2,
    currentRowVersion: 2,
    isCurrent: true,
    lifecycleState: 'active',
    fitEvidenceType: 'customer_confirmed',
    fitEvidenceReference: 'customer-email-2026-07-28',
    confirmedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  }
}

function input(
  lines: HybridCartonizationLine[],
  recipes: HybridCartonizationRecipe[],
  overrides: Partial<HybridCartonizationInput> = {},
): HybridCartonizationInput {
  return {
    mode: 'production',
    lines,
    recipes,
    materials: [material()],
    ...overrides,
  }
}

test('six mixed 6 oz lines use one AG12V2 only with an explicit sandbox minimum assumption', () => {
  const lines = Array.from({ length: 6 }, (_, index) => line(index + 1))
  const withoutAssumption = planHybridCartonization(
    input(lines, lines.map((item) => recipe(item))),
  )

  assert.equal(withoutAssumption.status, 'blocked')
  assert.equal(withoutAssumption.recipePackages.length, 0)
  assert.deepEqual(
    withoutAssumption.blockers.map(({ code }) => code),
    [
      'MATERIAL_CAPACITY_UNAVAILABLE',
      'RECIPE_CAPACITY_MINIMUM_NOT_MET',
    ],
  )
  assert.equal(withoutAssumption.geometryFallbackLines.length, 0)

  const result = planHybridCartonization(input(
    lines,
    lines.map((item) => recipe(item)),
    {
      mode: 'sandbox_demo',
      minimumInputOverrides: [{
        contentCompatibilityKey: COMPATIBILITY_KEY,
        packagingMaterialGlobalId: MATERIAL_ID,
        minimumInputQuantity: 1,
        reason: 'Read-only sandbox option for order #6538',
        evidenceReference: 'sandbox-demo:#6538',
      }],
    },
  ))

  assert.equal(result.status, 'ready')
  assert.equal(result.policyVersion, HYBRID_CARTONIZATION_POLICY_VERSION)
  assert.equal(
    result.algorithmVersion,
    HYBRID_CARTONIZATION_ALGORITHM_VERSION,
  )
  assert.match(result.inputHash, /^[0-9a-f]{64}$/)
  assert.match(result.resultHash, /^[0-9a-f]{64}$/)
  assert.equal(result.recipePackages.length, 1)
  const [plannedPackage] = result.recipePackages
  assert.equal(plannedPackage.packagingMaterialGlobalId, MATERIAL_ID)
  assert.equal(plannedPackage.planningMethod, 'approved_recipe')
  assert.equal(plannedPackage.sequence, 1)
  assert.match(plannedPackage.packageKey, /^hpkg-[0-9a-f]{20}$/)
  assert.equal(plannedPackage.totalInputQuantity, 6)
  assert.equal(plannedPackage.contentWeightGrams, 1020)
  assert.equal(plannedPackage.mixedProducts, true)
  assert.equal(plannedPackage.minimumInputQuantity, 1)
  assert.equal(plannedPackage.minimumBasis, 'sandbox_assumption')
  assert.equal(plannedPackage.lineAllocations.length, 6)
  assert.equal(plannedPackage.recipeEvidence.length, 6)
  assert.equal(plannedPackage.packagingMaterialRowVersion, 4)
  assert.deepEqual(plannedPackage.materialEvidence.innerDimensionsMm, {
    length: 279,
    width: 229,
    height: 178,
  })
  assert.equal(plannedPackage.rateReadiness.status, 'ready')
  assert.equal(plannedPackage.rateReadiness.ratedWeightGrams, 1200)
  assert.equal(result.assumptions.length, 1)
  assert.equal(result.assumptions[0].approvedMinimumInputQuantity, 12)
  assert.equal(result.assumptions[0].assumedMinimumInputQuantity, 1)
})

test('different compatibility keys never pool even with one material', () => {
  const apple = line(1)
  const berry = line(2)
  const result = planHybridCartonization(input(
    [apple, berry],
    [
      recipe(apple, {
        minimumInputQuantity: 1,
        contentCompatibilityKey: 'ag-alchemy.apple-only.v1',
      }),
      recipe(berry, {
        minimumInputQuantity: 1,
        contentCompatibilityKey: 'ag-alchemy.berry-only.v1',
      }),
    ],
  ))

  assert.equal(result.status, 'ready')
  assert.equal(result.recipePackages.length, 2)
  assert.ok(result.recipePackages.every((item) => !item.mixedProducts))
  assert.deepEqual(
    result.recipePackages.map((item) => (
      item.lineAllocations.map(({ productGlobalId }) => productGlobalId)
    )),
    [[apple.productGlobalId], [berry.productGlobalId]],
  )
})

test('exact case remains the full-case path while loose each covers one and thirteen', () => {
  const sourceLine = line(1)
  const exactCase = recipe(sourceLine, {
    recipeGlobalId: 'gprex000001',
    recipeType: 'exact_case',
    maximumInputQuantity: 12,
    minimumInputQuantity: null,
    contentCompatibilityKey: null,
    allowsMixedProducts: false,
    exclusiveContents: true,
  })
  const looseEach = recipe(sourceLine, {
    recipeGlobalId: 'gprel000001',
    recipeType: 'max_capacity',
    maximumInputQuantity: 12,
    minimumInputQuantity: 1,
    contentCompatibilityKey: null,
    allowsMixedProducts: false,
    exclusiveContents: true,
  })
  const recipes = [looseEach, exactCase]

  const one = planHybridCartonization(input(
    [{ ...sourceLine, quantity: 1 }],
    recipes,
  ))
  assert.equal(one.status, 'ready')
  assert.equal(one.geometryFallbackLines.length, 0)
  assert.equal(one.recipePackages.length, 1)
  assert.equal(one.recipePackages[0].totalInputQuantity, 1)
  assert.equal(
    one.recipePackages[0].recipeEvidence[0]?.recipeGlobalId,
    looseEach.recipeGlobalId,
  )

  const twelve = planHybridCartonization(input(
    [{ ...sourceLine, quantity: 12 }],
    recipes,
  ))
  assert.equal(twelve.status, 'ready')
  assert.equal(twelve.geometryFallbackLines.length, 0)
  assert.equal(twelve.recipePackages.length, 1)
  assert.equal(twelve.recipePackages[0].totalInputQuantity, 12)
  assert.equal(
    twelve.recipePackages[0].recipeEvidence[0]?.recipeGlobalId,
    exactCase.recipeGlobalId,
  )

  const thirteen = planHybridCartonization(input(
    [{ ...sourceLine, quantity: 13 }],
    recipes,
  ))
  assert.equal(thirteen.status, 'ready')
  assert.equal(thirteen.geometryFallbackLines.length, 0)
  assert.deepEqual(
    thirteen.recipePackages.map((item) => item.totalInputQuantity),
    [12, 1],
  )
  assert.deepEqual(
    thirteen.recipePackages.map(
      (item) => item.recipeEvidence[0]?.recipeGlobalId,
    ),
    [exactCase.recipeGlobalId, looseEach.recipeGlobalId],
  )
})

test('stale and missing recipe evidence block recipe-only lines', () => {
  const stale = line(1)
  const missing = line(2)
  const result = planHybridCartonization(input(
    [stale, missing],
    [
      recipe(stale, {
        capturedRowVersion: 1,
        currentRowVersion: 2,
      }),
      recipe(missing, {
        fitEvidenceReference: null,
        confirmedAt: null,
      }),
    ],
  ))

  assert.equal(result.status, 'blocked')
  assert.deepEqual(
    result.blockers.map(({ code }) => code).sort(),
    ['RECIPE_EVIDENCE_MISSING', 'RECIPE_EVIDENCE_STALE'],
  )
  assert.equal(result.recipePackages.length, 0)
  assert.equal(result.geometryFallbackLines.length, 0)
})

test('approved-recipe-only flexible items never fall back to geometry', () => {
  const recipeOnlyLine = line(1)
  const result = planHybridCartonization(input(
    [recipeOnlyLine],
    [],
  ))

  assert.equal(result.status, 'blocked')
  assert.deepEqual(
    result.blockers.map(({ code }) => code),
    ['RECIPE_REQUIRED'],
  )
  assert.equal(result.geometryFallbackLines.length, 0)
})

test('rigid items without a recipe remain eligible for geometric planning', () => {
  const rigidLine = line(1, {
    profile: {
      ...line(1).profile,
      fitModel: 'rigid_3d',
    },
  })
  const result = planHybridCartonization(input([rigidLine], []))

  assert.equal(result.status, 'ready')
  assert.deepEqual(result.geometryFallbackLines, [{
    lineGlobalId: rigidLine.lineGlobalId,
    productGlobalId: rigidLine.productGlobalId,
    quantity: 1,
    fitModel: 'rigid_3d',
  }])
})

test('production planning rejects sandbox minimum assumptions', () => {
  const sourceLine = line(1)
  assert.throws(
    () => planHybridCartonization(input(
      [sourceLine],
      [recipe(sourceLine)],
      {
        minimumInputOverrides: [{
          recipeGlobalId: 'gpre0000001',
          packagingMaterialGlobalId: MATERIAL_ID,
          minimumInputQuantity: 1,
          reason: 'Not valid in production',
          evidenceReference: 'sandbox-only',
        }],
      },
    )),
    /sandbox_demo/,
  )
})

test('customer-confirmed draft evidence is sandbox-only', () => {
  const sourceLine = line(1, {
    quantity: 12,
    profile: {
      ...line(1).profile,
      lifecycleState: 'customer_confirmed',
    },
  })
  const customerRecipe = recipe(sourceLine, {
    lifecycleState: 'customer_confirmed',
  })
  const customerMaterial = material({
    status: 'draft',
    dimensionBasis: 'outer',
    tareWeightGrams: null,
    ratedOuterDimensionsMm: null,
  })

  const sandbox = planHybridCartonization(input(
    [sourceLine],
    [customerRecipe],
    {
      mode: 'sandbox_demo',
      materials: [customerMaterial],
    },
  ))
  assert.equal(sandbox.status, 'ready')
  assert.equal(sandbox.recipePackages.length, 1)
  assert.equal(
    sandbox.recipePackages[0].rateReadiness.status,
    'blocked',
  )
  assert.deepEqual(
    sandbox.recipePackages[0].rateReadiness.blockers,
    [
      'RATING_OUTER_DIMENSIONS_MISSING',
      'RATING_TARE_WEIGHT_MISSING',
    ],
  )

  const production = planHybridCartonization(input(
    [sourceLine],
    [customerRecipe],
    {
      mode: 'production',
      materials: [customerMaterial],
    },
  ))
  assert.equal(production.status, 'blocked')
  assert.equal(production.recipePackages.length, 0)
  assert.equal(
    production.blockers[0]?.code,
    'PROFILE_EVIDENCE_STALE',
  )
})

test('sandbox may rate an unspecified customer carton only with explicit exterior assumptions', () => {
  const sourceLine = line(1, {
    quantity: 12,
    profile: {
      ...line(1).profile,
      lifecycleState: 'customer_confirmed',
    },
  })
  const customerRecipe = recipe(sourceLine, {
    lifecycleState: 'customer_confirmed',
  })
  const unconfirmedMaterial = material({
    status: 'draft',
    dimensionBasis: 'unconfirmed',
  })

  const sandbox = planHybridCartonization(input(
    [sourceLine],
    [customerRecipe],
    {
      mode: 'sandbox_demo',
      materials: [unconfirmedMaterial],
    },
  ))
  assert.equal(sandbox.status, 'ready')
  assert.equal(sandbox.recipePackages.length, 1)
  assert.equal(sandbox.recipePackages[0].rateReadiness.status, 'ready')

  const withoutRatedExterior = planHybridCartonization(input(
    [sourceLine],
    [customerRecipe],
    {
      mode: 'sandbox_demo',
      materials: [{
        ...unconfirmedMaterial,
        ratedOuterDimensionsMm: null,
      }],
    },
  ))
  assert.equal(withoutRatedExterior.status, 'blocked')
  assert.equal(withoutRatedExterior.recipePackages.length, 0)

  const production = planHybridCartonization(input(
    [sourceLine],
    [customerRecipe],
    {
      mode: 'production',
      materials: [unconfirmedMaterial],
    },
  ))
  assert.equal(production.status, 'blocked')
  assert.equal(production.recipePackages.length, 0)
})
