import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  planOperationalUnitMaterialPackages,
  planShopifyCheckoutUnitMaterialPackages,
} from '../../lib/operations/operationalUnitMaterialCartonization.ts'
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
  available: number
  unitCostMinor?: number
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
  maximumGrossWeightGrams: 10_000,
  availableQuantity: input.available,
  ratedOuterDimensionsMm: {
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

test('undimensioned units choose the largest factual carton and fall back only after its stock is exhausted', () => {
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
      === 'largest_selected_factual_container_with_available_stock'
  )))
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
