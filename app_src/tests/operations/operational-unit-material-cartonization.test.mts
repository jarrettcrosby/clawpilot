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
} from '../../lib/operations/hybridCartonization.ts'

const line: HybridCartonizationLine = {
  lineGlobalId: 'gcol0000001',
  productGlobalId: 'gp0000001',
  title: 'Unit item',
  quantity: 3,
  unitWeightGrams: 500,
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
  unitCostMinor: 125,
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
  sourceLevelGlobalIds: ['gcil0000001'],
  sourcePositionGlobalIds: ['gpos0000001'],
  sourcePositionVersion: 1,
}]

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

test('unit items use one factual selected material per unit without Product packs', () => {
  const result = planOperationalUnitMaterialPackages(baseInput)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.packages.length, 3)
  assert.deepEqual(
    result.packages.map((item) => item.planningMethod),
    ['unit_material_selection', 'unit_material_selection', 'unit_material_selection'],
  )
  assert.deepEqual(
    result.packages.map((item) => item.packagingMaterialGlobalId),
    ['gmat0000001', 'gmat0000001', 'gmat0000001'],
  )
  assert.ok(result.packages.every((item) => (
    item.allocations.length === 1
    && item.allocations[0].quantity === 1
    && item.recipes.length === 0
    && item.orToolsProfiles.length === 0
  )))
  assert.equal(
    result.evidence.productPackConstraint,
    'not_required_for_one_each_line',
  )
  assert.equal(
    result.evidence.transformationHash,
    persistenceCanonicalHash(result.packages),
    'retained unit-material evidence must use the persistence validator hash contract',
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
    materials: baseInput.materials.map((item) => ({
      ...item,
      unitCostMinor: null,
      currency: null,
    })),
    inventoryProducts: [{
      productGlobalId: line.productGlobalId,
      availabilityAuthority: 'shopify_checkout_available_snapshot',
      effectiveAvailableQuantity: 3,
      sourceLevelGlobalIds: ['gcil0000001', 'gcil0000002'],
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
  )))
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
