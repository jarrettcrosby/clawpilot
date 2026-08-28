import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  planOperationalUnitMaterialPackages,
  planShopifyCheckoutUnitMaterialPackages,
  type OperationalUnitMaterialPlan,
} from '../../lib/operations/operationalUnitMaterialCartonization.ts'
import {
  reconcileOperationalMixedMaterialPlans,
} from '../../lib/operations/operationalMixedMaterialCartonization.ts'
import type {
  OperationalGeometryRatePlan,
} from '../../lib/operations/operationalGeometryCartonization.ts'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridRecipePackage,
} from '../../lib/operations/hybridCartonization.ts'

const line: HybridCartonizationLine = {
  lineGlobalId: 'gcol0000001',
  productGlobalId: 'gp0000001',
  title: 'Unit item',
  quantity: 3,
  unitWeightGrams: 500,
  unitDimensionsMm: { length: 100, width: 100, height: 50 },
  unitDimensionsAuthority: 'order_specific',
  profile: {
    versionGlobalId: 'unit-item:gcol0000001',
    capturedRowVersion: 0,
    currentRowVersion: 0,
    isCurrent: true,
    lifecycleState: 'active',
    fitModel: 'unconstrained_unit',
    evidenceType: 'provider',
    evidenceReference: 'shopify-revision-1',
    confirmedAt: null,
    packageLevel: 'each',
    baseEachQuantity: 1,
    shipsAsOwnPackage: false,
    outerDimensionsMm: null,
    grossWeightGrams: 500,
  },
}

const material = (input: {
  globalId: string
  inner: { length: number; width: number; height: number }
  outer?: { length: number; width: number; height: number }
  available: number
  unitCostMinor?: number
  maximumGrossWeightGrams?: number
}): HybridCartonizationMaterial => ({
  materialGlobalId: input.globalId,
  materialType: 'carton',
  capturedRowVersion: 2,
  currentRowVersion: 2,
  isCurrent: true,
  status: 'active',
  innerDimensionsMm: input.inner,
  dimensionBasis: 'inner',
  dimensionEvidenceType: 'measured',
  dimensionEvidenceReference: 'warehouse measurement',
  dimensionConfirmedAt: '2026-08-24T00:00:00.000Z',
  tareWeightGrams: 100,
  unitCostMinor: input.unitCostMinor ?? 125,
  currency: 'USD',
  stockRowVersion: 4,
  stockOnHandQuantity: input.available,
  activeClaimedQuantity: 0,
  maximumGrossWeightGrams: input.maximumGrossWeightGrams ?? 10_000,
  availableQuantity: input.available,
  ratedOuterDimensionsMm: input.outer ?? {
    length: input.inner.length + 10,
    width: input.inner.width + 10,
    height: input.inner.height + 10,
  },
})

const inventory = (available = 3) => [{
  productGlobalId: 'gp0000001',
  availabilityAuthority: 'shopify_provider_commitment' as const,
  providerCommittedQuantity: available,
  activeReservedQuantity: 0,
  effectiveAvailableQuantity: available,
  sourceLevelGlobalIds: ['giil0000001'],
  sourcePositionGlobalIds: ['gpos0000001'],
  sourcePositionVersion: 1,
}]

const retainedRecipePackage: HybridRecipePackage = {
  packageKey: 'recipe-package-1',
  sequence: 1,
  planningMethod: 'approved_recipe',
  packagingMaterialGlobalId: 'gmat0000001',
  packagingMaterialRowVersion: 2,
  materialEvidence: {
    innerDimensionsMm: { length: 500, width: 300, height: 200 },
    dimensionBasis: 'inner',
    dimensionEvidenceType: 'measured',
    dimensionEvidenceReference: 'warehouse measurement',
    dimensionConfirmedAt: '2026-08-24T00:00:00.000Z',
  },
  contentCompatibilityKey: null,
  mixedProducts: false,
  maximumInputQuantity: 1,
  minimumInputQuantity: 1,
  minimumBasis: 'approved_recipe',
  lineAllocations: [],
  totalInputQuantity: 1,
  contentWeightGrams: 500,
  rateReadiness: {
    status: 'ready',
    ratedOuterDimensionsMm: { length: 510, width: 310, height: 210 },
    tareWeightGrams: 100,
    ratedWeightGrams: 600,
    blockers: [],
  },
  recipeEvidence: [],
}

const baseInput = {
  provider: 'shopify' as const,
  lines: [line],
  fallbackLines: [{
    lineGlobalId: line.lineGlobalId,
    productGlobalId: line.productGlobalId,
    quantity: line.quantity,
    fitModel: 'unconstrained_unit' as const,
  }],
  recipePackages: [],
  materials: [
    material({
      globalId: 'gmat0000001',
      inner: { length: 500, width: 300, height: 200 },
      available: 3,
    }),
    material({
      globalId: 'gmat0000002',
      inner: { length: 200, width: 100, height: 50 },
      available: 3,
    }),
  ],
  inventoryProducts: inventory(),
  availabilityMode: 'operational' as const,
  startingSequence: 1,
  maximumPackages: 50,
}

function persistenceCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(persistenceCanonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          persistenceCanonicalValue(
            (value as Record<string, unknown>)[key],
          ),
        ]),
    )
  }
  return value
}

function persistenceCanonicalHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(persistenceCanonicalValue(value)))
    .digest('hex')
}

test('dimensioned ordinary units combine in one factual carton without Product packs', () => {
  const result = planOperationalUnitMaterialPackages(baseInput)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].planningMethod, 'unit_material_selection')
  assert.equal(result.packages[0].packagingMaterialGlobalId, 'gmat0000001')
  assert.equal(result.packages[0].allocations.length, 1)
  assert.equal(result.packages[0].allocations[0].quantity, 3)
  assert.equal(result.packages[0].unitMaterialEvidence.unitWeightGrams, 500)
  assert.equal(result.packages[0].contentWeightGrams, 1_500)
  assert.equal(result.packages[0].ratedGrossWeightGrams, 1_600)
  assert.equal(
    result.packages[0].unitMaterialEvidence.fitModel,
    'fixed_axis_regular_grid',
  )
  assert.deepEqual(
    result.packages[0].unitMaterialEvidence.axisCounts,
    { length: 5, width: 3, height: 4 },
  )
  assert.equal(result.packages[0].unitMaterialEvidence.unitsPerPackage, 3)
  assert.equal(result.packages[0].recipes.length, 0)
  assert.equal(result.packages[0].orToolsProfiles.length, 0)
  assert.equal(
    result.evidence.productPackConstraint,
    'not_required_for_ordinary_unit',
  )
  assert.equal(result.evidence.dimensionedLineCount, 1)
  assert.equal(result.evidence.oneEachUndimensionedLineCount, 0)
  assert.equal(
    result.evidence.transformationHash,
    persistenceCanonicalHash(result.packages),
    'retained unit-material evidence must use the persistence validator hash contract',
  )
})

test('operational lines without item dimensions retain a truthful one-each fallback', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{
      ...line,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 3)
  assert.ok(result.packages.every((item) => (
    item.allocations[0].quantity === 1
    && item.unitMaterialEvidence.fitModel === 'one_each_without_fit_claim'
    && item.unitMaterialEvidence.unitDimensionsMm === null
  )))
  assert.equal(result.evidence.dimensionedLineCount, 0)
  assert.equal(result.evidence.oneEachUndimensionedLineCount, 1)
})

test('undimensioned units choose the largest rated outer carrier envelope and fall back only after stock is exhausted', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, unitDimensionsMm: null, unitDimensionsAuthority: null }],
    materials: [
      material({
        globalId: 'gmat-tiny',
        inner: { length: 10, width: 10, height: 10 },
        available: 2,
        unitCostMinor: 1,
      }),
      material({
        globalId: 'gmat-large',
        inner: { length: 1000, width: 1000, height: 1000 },
        available: 1,
        unitCostMinor: 999,
      }),
    ],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.deepEqual(
    result.packages.map((item) => item.packagingMaterialGlobalId),
    ['gmat-large', 'gmat-tiny', 'gmat-tiny'],
  )
  const large = result.packages.find((item) => (
    item.packagingMaterialGlobalId === 'gmat-large'
  ))
  assert.deepEqual(
    large?.ratedOuterDimensionsMm,
    { length: 1010, width: 1010, height: 1010 },
  )
  assert.ok(result.packages.every((item) => (
    item.allocations[0].quantity === 1
    && item.unitMaterialEvidence.packageSelectionBasis
      === 'largest_rated_outer_volume_then_sorted_axes_then_material_id'
  )))
})

test('undimensioned ranking uses rated outer carrier envelope rather than inverted inner cube', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{
      ...line,
      quantity: 1,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 1 }],
    materials: [
      material({
        globalId: 'gmat-larger-inner-smaller-outer',
        inner: { length: 500, width: 500, height: 500 },
        outer: { length: 510, width: 510, height: 510 },
        available: 1,
      }),
      material({
        globalId: 'gmat-smaller-inner-larger-outer',
        inner: { length: 400, width: 400, height: 400 },
        outer: { length: 800, width: 800, height: 800 },
        available: 1,
      }),
    ],
    inventoryProducts: inventory(1),
  })
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.equal(
    result.packages[0].packagingMaterialGlobalId,
    'gmat-smaller-inner-larger-outer',
  )
  assert.deepEqual(
    result.packages[0].ratedOuterDimensionsMm,
    { length: 800, width: 800, height: 800 },
  )
})

test('equal rated-outer volume ranks the longer carrier envelope first', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{
      ...line,
      quantity: 1,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 1 }],
    materials: [
      material({
        globalId: 'gmat-equal-cube-compact',
        inner: { length: 80, width: 80, height: 80 },
        outer: { length: 300, width: 300, height: 100 },
        available: 1,
      }),
      material({
        globalId: 'gmat-equal-cube-long',
        inner: { length: 80, width: 80, height: 80 },
        outer: { length: 900, width: 100, height: 100 },
        available: 1,
      }),
    ],
    inventoryProducts: inventory(1),
  })
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.equal(
    result.packages[0].packagingMaterialGlobalId,
    'gmat-equal-cube-long',
  )
})

test('checkout ignores synthetic dimensions until checkout retains its own item facts', () => {
  const result = planShopifyCheckoutUnitMaterialPackages({
    ...baseInput,
    materials: baseInput.materials.map((item) => ({
      ...item,
      unitCostMinor: null,
      currency: null,
    })),
    inventoryProducts: [{
      productGlobalId: line.productGlobalId,
      availabilityAuthority: 'shopify_checkout_available_snapshot',
      effectiveAvailableQuantity: 3,
      sourceLevelGlobalIds: ['giil0000001'],
    }],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 3)
  assert.ok(result.packages.every((item) => (
    item.allocations[0].quantity === 1
    && item.unitMaterialEvidence.fitModel === 'one_each_without_fit_claim'
  )))
})

test('checkout quotes unknown-size units in the largest factual carton, not the cheapest tiny carton', () => {
  const result = planShopifyCheckoutUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, quantity: 1 }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 1 }],
    materials: [
      material({
        globalId: 'gmat-tiny',
        inner: { length: 10, width: 10, height: 10 },
        available: 1,
        unitCostMinor: 1,
      }),
      material({
        globalId: 'gmat-large',
        inner: { length: 1000, width: 1000, height: 1000 },
        available: 1,
        unitCostMinor: 999,
      }),
    ].map((item) => ({ ...item, unitCostMinor: null, currency: null })),
    inventoryProducts: [{
      productGlobalId: line.productGlobalId,
      availabilityAuthority: 'shopify_checkout_available_snapshot',
      effectiveAvailableQuantity: 1,
      sourceLevelGlobalIds: ['giil0000001'],
    }],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages[0].packagingMaterialGlobalId, 'gmat-large')
  assert.deepEqual(
    result.packages[0].ratedOuterDimensionsMm,
    { length: 1010, width: 1010, height: 1010 },
  )
})

test('fixed-axis and gross-weight capacity both constrain grouping', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, quantity: 7 }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 7 }],
    inventoryProducts: inventory(7),
    materials: [{
      ...material({
        globalId: 'gmat0000001',
        inner: { length: 300, width: 200, height: 100 },
        available: 2,
      }),
      maximumGrossWeightGrams: 2_100,
    }],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.deepEqual(
    result.packages.map((item) => item.allocations[0].quantity),
    [4, 3],
  )
  assert.ok(result.packages.every((item) => (
    item.ratedGrossWeightGrams <= item.maxWeightGrams
  )))
})

test('global shared-stock search preserves the only feasible allocation independent of line IDs and input order', () => {
  const run = (reverse: boolean) => {
    const flexible = {
      ...line,
      lineGlobalId: reverse ? 'gcol-z' : 'gcol-a',
      productGlobalId: 'gp-flexible',
      quantity: 1,
    }
    const constrained = {
      ...line,
      lineGlobalId: reverse ? 'gcol-a' : 'gcol-z',
      productGlobalId: 'gp-constrained',
      quantity: 2,
      unitDimensionsMm: { length: 300, width: 100, height: 50 },
    }
    const lines = reverse
      ? [constrained, flexible]
      : [flexible, constrained]
    return planOperationalUnitMaterialPackages({
      ...baseInput,
      lines,
      fallbackLines: lines.map((item) => ({
        lineGlobalId: item.lineGlobalId,
        productGlobalId: item.productGlobalId,
        quantity: item.quantity,
        fitModel: 'unconstrained_unit' as const,
      })),
      materials: [
        material({
          globalId: 'gmat-x',
          inner: { length: 600, width: 100, height: 50 },
          available: 1,
          unitCostMinor: 1,
        }),
        material({
          globalId: 'gmat-y',
          inner: { length: 300, width: 100, height: 50 },
          available: 1,
          unitCostMinor: 999,
        }),
      ],
      inventoryProducts: [
        { ...inventory(1)[0], productGlobalId: 'gp-flexible' },
        { ...inventory(2)[0], productGlobalId: 'gp-constrained' },
      ],
    })
  }
  for (const result of [run(false), run(true)]) {
    assert.equal(result.status, 'ready', JSON.stringify(result))
    if (result.status !== 'ready') continue
    const materialByProduct = Object.fromEntries(result.packages.map((item) => [
      item.allocations[0].productGlobalId,
      item.packagingMaterialGlobalId,
    ]))
    assert.deepEqual(materialByProduct, {
      'gp-flexible': 'gmat-y',
      'gp-constrained': 'gmat-x',
    })
  }
})

test('shared stock jointly reserves a heavy unknown carton before a light dimensioned line', () => {
  const run = (reverse: boolean) => {
    const unknown = {
      ...line,
      lineGlobalId: reverse ? 'gcol-z' : 'gcol-a',
      productGlobalId: 'gp-heavy-unknown',
      title: 'Heavy unknown',
      quantity: 1,
      unitWeightGrams: 9_000,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }
    const dimensioned = {
      ...line,
      lineGlobalId: reverse ? 'gcol-a' : 'gcol-z',
      productGlobalId: 'gp-light-dimensioned',
      title: 'Light dimensioned',
      quantity: 1,
      unitWeightGrams: 100,
    }
    const lines = reverse ? [dimensioned, unknown] : [unknown, dimensioned]
    return planOperationalUnitMaterialPackages({
      ...baseInput,
      lines,
      fallbackLines: lines.map((item) => ({
        lineGlobalId: item.lineGlobalId,
        productGlobalId: item.productGlobalId,
        quantity: item.quantity,
        fitModel: 'unconstrained_unit' as const,
      })),
      materials: [
        material({
          globalId: 'gmat-heavy',
          inner: { length: 300, width: 300, height: 300 },
          outer: { length: 700, width: 700, height: 700 },
          available: 1,
          maximumGrossWeightGrams: 10_000,
        }),
        material({
          globalId: 'gmat-light',
          inner: { length: 300, width: 300, height: 300 },
          outer: { length: 310, width: 310, height: 310 },
          available: 1,
          maximumGrossWeightGrams: 1_000,
        }),
      ],
      inventoryProducts: [
        { ...inventory(1)[0], productGlobalId: unknown.productGlobalId },
        { ...inventory(1)[0], productGlobalId: dimensioned.productGlobalId },
      ],
    })
  }
  for (const result of [run(false), run(true)]) {
    assert.equal(result.status, 'ready', JSON.stringify(result))
    if (result.status !== 'ready') continue
    assert.deepEqual(
      Object.fromEntries(result.packages.map((item) => [
        item.allocations[0].productGlobalId,
        item.packagingMaterialGlobalId,
      ])),
      {
        'gp-heavy-unknown': 'gmat-heavy',
        'gp-light-dimensioned': 'gmat-light',
      },
    )
  }
})

test('shared stock jointly matches multiple unknown weights', () => {
  const lines = [
    {
      ...line,
      lineGlobalId: 'gcol-light-unknown',
      productGlobalId: 'gp-light-unknown',
      quantity: 1,
      unitWeightGrams: 100,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    },
    {
      ...line,
      lineGlobalId: 'gcol-heavy-unknown',
      productGlobalId: 'gp-heavy-unknown',
      quantity: 1,
      unitWeightGrams: 9_000,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    },
  ]
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines,
    fallbackLines: lines.map((item) => ({
      lineGlobalId: item.lineGlobalId,
      productGlobalId: item.productGlobalId,
      quantity: item.quantity,
      fitModel: 'unconstrained_unit' as const,
    })),
    materials: [
      material({
        globalId: 'gmat-heavy',
        inner: { length: 500, width: 500, height: 500 },
        outer: { length: 600, width: 600, height: 600 },
        available: 1,
        maximumGrossWeightGrams: 10_000,
      }),
      material({
        globalId: 'gmat-light',
        inner: { length: 300, width: 300, height: 300 },
        outer: { length: 310, width: 310, height: 310 },
        available: 1,
        maximumGrossWeightGrams: 1_000,
      }),
    ],
    inventoryProducts: lines.map((item) => ({
      ...inventory(1)[0],
      productGlobalId: item.productGlobalId,
    })),
  })
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.deepEqual(
    Object.fromEntries(result.packages.map((item) => [
      item.allocations[0].productGlobalId,
      item.packagingMaterialGlobalId,
    ])),
    {
      'gp-heavy-unknown': 'gmat-heavy',
      'gp-light-unknown': 'gmat-light',
    },
  )
})

test('exact search stays bounded with ten materials and fifty packages', () => {
  const startedAt = performance.now()
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, quantity: 50 }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 50 }],
    inventoryProducts: inventory(50),
    materials: Array.from({ length: 10 }, (_, index) => material({
      globalId: `gmat-perf-${String(index).padStart(2, '0')}`,
      inner: { length: 100, width: 100, height: 50 },
      available: 50,
      unitCostMinor: index + 1,
    })),
    maximumPackages: 50,
  })
  const elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 50)
  assert.ok(elapsedMs < 1_000, `bounded search took ${elapsedMs}ms`)
})

test('state-budget exhaustion falls back to deterministic shared-stock matching for 2x25 units', () => {
  const lines = Array.from({ length: 2 }, (_, index) => ({
    ...line,
    lineGlobalId: `gcol-bound-${index}`,
    productGlobalId: `gp-bound-${index}`,
    quantity: 25,
  }))
  const startedAt = performance.now()
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines,
    fallbackLines: lines.map((item) => ({
      lineGlobalId: item.lineGlobalId,
      productGlobalId: item.productGlobalId,
      quantity: item.quantity,
      fitModel: 'unconstrained_unit' as const,
    })),
    inventoryProducts: lines.map((item) => ({
      ...inventory(25)[0],
      productGlobalId: item.productGlobalId,
    })),
    materials: Array.from({ length: 4 }, (_, index) => material({
      globalId: `gmat-bound-${index}`,
      inner: { length: 100, width: 100, height: 50 },
      available: index < 2 ? 13 : 12,
      unitCostMinor: index + 1,
    })),
    maximumPackages: 50,
  })
  const elapsedMs = performance.now() - startedAt
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 50)
  assert.equal(
    result.evidence.sharedStockSolver,
    'min_cost_max_flow_one_carton_per_unit_fallback',
  )
  assert.ok(elapsedMs < 1_000, `bounded failure took ${elapsedMs}ms`)
})

test('bounded shared-stock fallback is invariant to line and material input permutations', () => {
  const run = (reverse: boolean) => {
    const lines = Array.from({ length: 2 }, (_, index) => ({
      ...line,
      lineGlobalId: `gcol-permutation-${index}`,
      productGlobalId: `gp-permutation-${index}`,
      quantity: 25,
    }))
    const materials = Array.from({ length: 4 }, (_, index) => material({
      globalId: `gmat-permutation-${index}`,
      inner: { length: 100, width: 100, height: 50 },
      available: index < 2 ? 13 : 12,
      unitCostMinor: index + 1,
    }))
    const result = planOperationalUnitMaterialPackages({
      ...baseInput,
      lines: reverse ? [...lines].reverse() : lines,
      fallbackLines: (reverse ? [...lines].reverse() : lines).map((item) => ({
        lineGlobalId: item.lineGlobalId,
        productGlobalId: item.productGlobalId,
        quantity: item.quantity,
        fitModel: 'unconstrained_unit' as const,
      })),
      inventoryProducts: (reverse ? [...lines].reverse() : lines).map(
        (item) => ({
          ...inventory(25)[0],
          productGlobalId: item.productGlobalId,
        }),
      ),
      materials: reverse ? [...materials].reverse() : materials,
      maximumPackages: 50,
    })
    assert.equal(result.status, 'ready', JSON.stringify(result))
    if (result.status !== 'ready') return null
    return result.packages.map((item) => ({
      key: item.packageKey,
      sequence: item.packageSequence,
      product: item.allocations[0].productGlobalId,
      material: item.packagingMaterialGlobalId,
      gross: item.ratedGrossWeightGrams,
      outer: item.ratedOuterDimensionsMm,
    }))
  }
  assert.deepEqual(run(false), run(true))
})

test('bounded fallback subtracts recipe and joint reservations before matching residual units', () => {
  const lines = Array.from({ length: 2 }, (_, index) => ({
    ...line,
    lineGlobalId: `gcol-recipe-bound-${index}`,
    productGlobalId: `gp-recipe-bound-${index}`,
    quantity: 25,
  }))
  const recipeMaterialId = 'gmat-recipe-bound-0'
  const recipePackages = [0, 1].map((index) => ({
    ...retainedRecipePackage,
    packageKey: `recipe-bound-${index}`,
    sequence: index + 1,
    packagingMaterialGlobalId: recipeMaterialId,
  }))
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines,
    fallbackLines: lines.map((item) => ({
      lineGlobalId: item.lineGlobalId,
      productGlobalId: item.productGlobalId,
      quantity: item.quantity,
      fitModel: 'unconstrained_unit' as const,
    })),
    recipePackages,
    reservedMaterialUsage: [{
      materialGlobalId: recipeMaterialId,
      quantity: 1,
    }],
    inventoryProducts: lines.map((item) => ({
      ...inventory(25)[0],
      productGlobalId: item.productGlobalId,
    })),
    materials: Array.from({ length: 4 }, (_, index) => material({
      globalId: `gmat-recipe-bound-${index}`,
      inner: { length: 100, width: 100, height: 50 },
      available: index === 0 ? 16 : index === 1 ? 13 : 12,
      unitCostMinor: index + 1,
    })),
    startingSequence: 3,
    maximumPackages: 50,
  })
  assert.equal(result.status, 'ready', JSON.stringify(result))
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 50)
  assert.equal(
    result.packages.filter((item) => (
      item.packagingMaterialGlobalId === recipeMaterialId
    )).length,
    13,
  )
})

test('one-carton fallback rejects the same 2x25 demand at a 49-package limit', () => {
  const lines = Array.from({ length: 2 }, (_, index) => ({
    ...line,
    lineGlobalId: `gcol-limit-${index}`,
    productGlobalId: `gp-limit-${index}`,
    quantity: 25,
  }))
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines,
    fallbackLines: lines.map((item) => ({
      lineGlobalId: item.lineGlobalId,
      productGlobalId: item.productGlobalId,
      quantity: item.quantity,
      fitModel: 'unconstrained_unit' as const,
    })),
    inventoryProducts: lines.map((item) => ({
      ...inventory(25)[0],
      productGlobalId: item.productGlobalId,
    })),
    materials: Array.from({ length: 4 }, (_, index) => material({
      globalId: `gmat-limit-${index}`,
      inner: { length: 100, width: 100, height: 50 },
      available: index < 2 ? 13 : 12,
      unitCostMinor: index + 1,
    })),
    maximumPackages: 49,
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
  )
})

test('undimensioned overweight demand fails closed without a carrying carton', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{
      ...line,
      quantity: 1,
      unitWeightGrams: 9_000,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }],
    fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 1 }],
    inventoryProducts: inventory(1),
    materials: [material({
      globalId: 'gmat-overweight',
      inner: { length: 500, width: 500, height: 500 },
      available: 1,
      maximumGrossWeightGrams: 5_000,
    })],
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
  )
})

test('fixed-axis fit blocks volume-only false positives', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    materials: [material({
      globalId: 'gmat0000001',
      inner: { length: 99, width: 1_000, height: 1_000 },
      available: 3,
    })],
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_FIT_REQUIRED',
  )
})

test('ordinary-item dimensions require explicit order-specific authority', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, unitDimensionsAuthority: null }],
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_UNIT_DIMENSION_AUTHORITY_INVALID',
  )
})

test('unit-material planning fails closed without retained unit weight', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, unitWeightGrams: 0 }],
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_LINE_INVALID',
  )
})

test('unit-material planning fails closed when provider inventory is short', () => {
  const result = planOperationalUnitMaterialPackages({
    ...baseInput,
    inventoryProducts: inventory(2),
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_INVENTORY_REQUIRED',
  )
})

test('checkout unit-material planning retains quote-only availability authority', () => {
  const result = planShopifyCheckoutUnitMaterialPackages({
    ...baseInput,
    lines: [{
      ...line,
      unitDimensionsMm: null,
      unitDimensionsAuthority: null,
    }],
    materials: baseInput.materials.map((item) => ({
      ...item,
      unitCostMinor: null,
      currency: null,
    })),
    inventoryProducts: [{
      productGlobalId: line.productGlobalId,
      availabilityAuthority: 'shopify_checkout_available_snapshot',
      effectiveAvailableQuantity: 3,
      sourceLevelGlobalIds: ['giil0000001', 'giil0000002'],
    }],
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 3)
  assert.equal(
    result.evidence.inventoryAuthority,
    'shopify_checkout_available_snapshot',
  )
  assert.equal(
    result.evidence.materialAuthority,
    'selected_material_stock_snapshot',
  )
  assert.ok(result.packages.every((item) => (
    item.allocations.length === 1
    && item.allocations[0].quantity === 1
    && item.unitMaterialEvidence.fitModel === 'one_each_without_fit_claim'
  )))
})

test('checkout unit planning counts recipe packages against unclaimed stock', () => {
  const result = planShopifyCheckoutUnitMaterialPackages({
    ...baseInput,
    lines: [{ ...line, quantity: 1 }],
    fallbackLines: [{
      ...baseInput.fallbackLines[0],
      quantity: 1,
    }],
    recipePackages: [retainedRecipePackage],
    materials: [{
      ...material({
        globalId: 'gmat0000001',
        inner: { length: 500, width: 300, height: 200 },
        available: 1,
      }),
      stockOnHandQuantity: 5,
      activeClaimedQuantity: 4,
      availableQuantity: 1,
    }],
    inventoryProducts: [{
      productGlobalId: line.productGlobalId,
      availabilityAuthority: 'shopify_checkout_available_snapshot',
      effectiveAvailableQuantity: 1,
      sourceLevelGlobalIds: ['giil0000001'],
    }],
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_REQUIRED',
  )
})

test('checkout unit-material planning rejects order-commitment authority substitution', () => {
  const result = planShopifyCheckoutUnitMaterialPackages({
    ...baseInput,
    inventoryProducts: inventory(),
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_INVENTORY_REQUIRED',
  )
})

function mixedReadyUnitPlan(
  materialGlobalIds: string[],
): OperationalUnitMaterialPlan {
  return {
    status: 'ready',
    packages: materialGlobalIds.map((materialGlobalId, index) => ({
      packagingMaterialGlobalId: materialGlobalId,
      packageKey: `unit-${materialGlobalId}-${index}`,
    })),
  } as unknown as OperationalUnitMaterialPlan
}

function mixedBlockedUnitPlan(): OperationalUnitMaterialPlan {
  return {
    status: 'blocked',
    packages: [],
    blocker: {
      code: 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
      detail: 'The reserved carton stock cannot carry the ordinary units.',
    },
  }
}

function mixedReadyGeometryPlan(
  materialGlobalIds: string[],
): OperationalGeometryRatePlan {
  return {
    status: 'ready',
    packages: materialGlobalIds.map((materialGlobalId, index) => ({
      packagingMaterialGlobalId: materialGlobalId,
      packageKey: `geometry-${materialGlobalId}-${index}`,
    })),
  } as unknown as OperationalGeometryRatePlan
}

function mixedBlockedGeometryPlan(): OperationalGeometryRatePlan {
  return {
    status: 'blocked',
    blocker: {
      code: 'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_RESULT_REQUIRED',
      detail: 'No rigid carton remains after shared-stock reservations.',
    },
  }
}

function usageMap(
  usage: Array<{ materialGlobalId: string; quantity: number }>,
) {
  return new Map(usage.map((item) => [
    item.materialGlobalId,
    item.quantity,
  ]))
}

test('mixed reconciliation reserves the only rigid carton and moves the ordinary unit to its smaller alternate', async () => {
  const run = (reverseInputs: boolean) => {
    const large = material({
      globalId: 'large-a',
      inner: { length: 1000, width: 1000, height: 1000 },
      available: 1,
    })
    const small = material({
      globalId: 'small-b',
      inner: { length: 10, width: 10, height: 10 },
      available: 1,
    })
    const materials = reverseInputs ? [small, large] : [large, small]
    const planOrdinary = ({
      reservedMaterialUsage,
      maximumPackages,
    }: {
      reservedMaterialUsage: Array<{
        materialGlobalId: string
        quantity: number
      }>
      maximumPackages: number
    }) => planOperationalUnitMaterialPackages({
      ...baseInput,
      lines: [{
        ...line,
        quantity: 1,
        unitDimensionsMm: null,
        unitDimensionsAuthority: null,
      }],
      fallbackLines: [{ ...baseInput.fallbackLines[0], quantity: 1 }],
      materials,
      inventoryProducts: inventory(1),
      reservedMaterialUsage,
      maximumPackages,
    })
    const ordinaryPreferred = planOrdinary({
      reservedMaterialUsage: [],
      maximumPackages: 2,
    })
    assert.equal(ordinaryPreferred.status, 'ready')
    if (ordinaryPreferred.status === 'ready') {
      assert.equal(
        ordinaryPreferred.packages[0].packagingMaterialGlobalId,
        'large-a',
        'The factual ordinary-unit policy must exercise the large-carton conflict',
      )
    }
    return reconcileOperationalMixedMaterialPlans({
      maximumPackages: 2,
      materialCapacities: (reverseInputs
        ? [{ materialGlobalId: 'small-b', quantity: 1 },
            { materialGlobalId: 'large-a', quantity: 1 }]
        : [{ materialGlobalId: 'large-a', quantity: 1 },
            { materialGlobalId: 'small-b', quantity: 1 }]),
      planUnit: planOrdinary,
      async planGeometry({
        reservedMaterialUsage,
        maximumPackages,
      }) {
        assert.ok(maximumPackages >= 1)
        return usageMap(reservedMaterialUsage).has('large-a')
          ? mixedBlockedGeometryPlan()
          : mixedReadyGeometryPlan(['large-a'])
      },
    })
  }
  const first = await run(false)
  const permuted = await run(true)
  assert.equal(first.status, 'ready')
  assert.equal(permuted.status, 'ready')
  if (first.status !== 'ready' || permuted.status !== 'ready') return
  assert.equal(
    first.evidence.solver,
    'bounded_geometry_material_conflict_backtracking',
  )
  assert.deepEqual(first.evidence.unitMaterialUsage, [{
    materialGlobalId: 'small-b',
    quantity: 1,
  }])
  assert.deepEqual(first.evidence.geometryMaterialUsage, [{
    materialGlobalId: 'large-a',
    quantity: 1,
  }])
  assert.deepEqual(first.evidence.combinedMaterialUsage, [{
    materialGlobalId: 'large-a',
    quantity: 1,
  }, {
    materialGlobalId: 'small-b',
    quantity: 1,
  }])
  const {
    decisionHash,
    ...decisionEvidence
  } = first.evidence
  assert.match(first.evidence.decisionHash, /^[a-f0-9]{64}$/u)
  assert.equal(
    decisionHash,
    persistenceCanonicalHash(decisionEvidence),
    'The retained decision hash must seal the complete shared-stock allocation',
  )
  assert.notEqual(
    decisionHash,
    persistenceCanonicalHash({
      ...decisionEvidence,
      materialCapacities: [{
        materialGlobalId: 'large-a',
        quantity: 2,
      }, ...decisionEvidence.materialCapacities.slice(1)],
    }),
    'A stock-capacity change must change the joint allocation hash',
  )
  assert.equal(
    first.evidence.decisionHash,
    permuted.evidence.decisionHash,
    'Joint stock evidence must be invariant to material-capacity input order',
  )
})

test('mixed reconciliation deterministically branches past mutually greedy ordinary and geometry choices', async () => {
  const result = await reconcileOperationalMixedMaterialPlans({
    maximumPackages: 3,
    materialCapacities: [
      { materialGlobalId: 'a', quantity: 1 },
      { materialGlobalId: 'b', quantity: 1 },
      { materialGlobalId: 'c', quantity: 1 },
    ],
    planUnit({ reservedMaterialUsage }) {
      const reserved = usageMap(reservedMaterialUsage)
      if (reserved.size === 0) return mixedReadyUnitPlan(['a', 'b'])
      if (reserved.has('a')) return mixedBlockedUnitPlan()
      if (reserved.has('b')) return mixedReadyUnitPlan(['a', 'c'])
      return mixedBlockedUnitPlan()
    },
    async planGeometry({ reservedMaterialUsage }) {
      const reserved = usageMap(reservedMaterialUsage)
      if (!reserved.has('a')) return mixedReadyGeometryPlan(['a'])
      if (!reserved.has('b')) return mixedReadyGeometryPlan(['b'])
      return mixedBlockedGeometryPlan()
    },
  })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.evidence.backtrackStatesEvaluated, 2)
  assert.deepEqual(result.evidence.unitMaterialUsage, [{
    materialGlobalId: 'a',
    quantity: 1,
  }, {
    materialGlobalId: 'c',
    quantity: 1,
  }])
  assert.deepEqual(result.evidence.geometryMaterialUsage, [{
    materialGlobalId: 'b',
    quantity: 1,
  }])
  assert.deepEqual(result.evidence.combinedMaterialUsage, [{
    materialGlobalId: 'a',
    quantity: 1,
  }, {
    materialGlobalId: 'b',
    quantity: 1,
  }, {
    materialGlobalId: 'c',
    quantity: 1,
  }])
})

test('mixed reconciliation fails closed before exceeding its shared geometry-search deadline', async () => {
  let geometryCalled = false
  const result = await reconcileOperationalMixedMaterialPlans({
    maximumPackages: 2,
    materialCapacities: [{
      materialGlobalId: 'large-a',
      quantity: 2,
    }],
    geometrySearchDeadlineAtMs: Date.now() - 1,
    planUnit: () => mixedReadyUnitPlan(['large-a']),
    async planGeometry() {
      geometryCalled = true
      return mixedReadyGeometryPlan(['large-a'])
    },
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_SEARCH_DEADLINE_EXCEEDED',
  )
  assert.equal(geometryCalled, false)
})

test('mixed reconciliation preserves an unreserved geometry root blocker', async () => {
  const result = await reconcileOperationalMixedMaterialPlans({
    maximumPackages: 2,
    materialCapacities: [{
      materialGlobalId: 'large-a',
      quantity: 2,
    }],
    planUnit: () => mixedReadyUnitPlan(['large-a']),
    async planGeometry() {
      return {
        status: 'blocked',
        blocker: {
          code: 'CARTONIZATION_RATE_EVIDENCE_OPTIMIZER_REQUIRED',
          detail: 'The operational optimizer is not configured.',
        },
      }
    },
  })
  assert.equal(result.status, 'blocked')
  if (result.status !== 'blocked') return
  assert.equal(
    result.blocker.code,
    'CARTONIZATION_RATE_EVIDENCE_OPTIMIZER_REQUIRED',
  )
})
