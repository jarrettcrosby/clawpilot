import { createHash } from 'node:crypto'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationResult,
  HybridRecipePackage,
} from '@/lib/operations/hybridCartonization'

export const OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION =
  'operational-unit-material-one-each-v1' as const

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    )
  }
  return value
}

function canonicalUnitMaterialHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

type InventoryProductEvidence = {
  productGlobalId: string
  availabilityAuthority:
    | 'operational_available'
    | 'shopify_provider_commitment'
    | 'shadow_training_simulated'
  providerCommittedQuantity: number
  activeReservedQuantity: number
  effectiveAvailableQuantity: number
  sourceLevelGlobalIds: string[]
  sourcePositionGlobalIds?: string[]
  sourcePositionVersion?: number
}

type DimensionsMm = { length: number; width: number; height: number }

export type OperationalUnitMaterialPackage = {
  packageKey: string
  packageSequence: number
  planningMethod: 'unit_material_selection'
  packagingMaterialGlobalId: string
  materialRowVersion: number
  recipes: []
  orToolsProfiles: []
  innerDimensionsMm: DimensionsMm
  ratedOuterDimensionsMm: DimensionsMm
  contentWeightGrams: number
  tareWeightGrams: number
  ratedGrossWeightGrams: number
  maxWeightGrams: number
  allocations: Array<{
    lineGlobalId: string
    productGlobalId: string
    title: string
    quantity: 1
  }>
  unitMaterialEvidence: {
    policyVersion: typeof OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION
    productPackConstraint: 'not_required_for_one_each_line'
    packageSelectionBasis:
      'largest_selected_factual_container_with_available_stock'
    unitsPerPackage: 1
    unitWeightAuthority: 'provider_or_order_specific'
  }
}

export type OperationalUnitMaterialPlan =
  | {
      status: 'blocked'
      packages: []
      blocker: { code: string; detail: string }
    }
  | {
      status: 'ready'
      policyVersion: typeof OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION
      packages: OperationalUnitMaterialPackage[]
      evidence: {
        policyVersion: typeof OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION
        productPackConstraint: 'not_required_for_one_each_line'
        packageSelectionBasis:
          'largest_selected_factual_container_with_available_stock'
        unitsPerPackage: 1
        unitWeightAuthority: 'provider_or_order_specific'
        materialAuthority:
          'current_active_material_and_unclaimed_warehouse_stock'
        inventoryAuthority:
          'shopify_provider_commitment_less_active_reservations'
          | 'shadow_training_simulated'
        transformationHash: string
      }
    }

function blocked(code: string, detail: string): OperationalUnitMaterialPlan {
  return { status: 'blocked', packages: [], blocker: { code, detail } }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function exactDimensions(
  value: DimensionsMm | null | undefined,
): value is DimensionsMm {
  return Boolean(
    value
    && positiveInteger(value.length)
    && positiveInteger(value.width)
    && positiveInteger(value.height),
  )
}

function volume(value: DimensionsMm) {
  return value.length * value.width * value.height
}

function recipeMaterialUsage(packages: HybridRecipePackage[]) {
  const counts = new Map<string, number>()
  for (const packagePlan of packages) {
    counts.set(
      packagePlan.packagingMaterialGlobalId,
      (counts.get(packagePlan.packagingMaterialGlobalId) || 0) + 1,
    )
  }
  return counts
}

function recipeProductUsage(packages: HybridRecipePackage[]) {
  const counts = new Map<string, number>()
  for (const packagePlan of packages) {
    for (const allocation of packagePlan.lineAllocations) {
      counts.set(
        allocation.productGlobalId,
        (counts.get(allocation.productGlobalId) || 0)
          + allocation.quantity,
      )
    }
  }
  return counts
}

/**
 * Plans ordinary one-each items without inventing a Product pack profile.
 * Each unit receives one explicitly selected, factual packaging material.
 * No fit or unit-combination claim is made; current provider/order weight,
 * material capacity, stock, and inventory authority remain fail-closed.
 */
export function planOperationalUnitMaterialPackages(input: {
  provider: 'shopify' | 'faire'
  lines: HybridCartonizationLine[]
  fallbackLines: HybridCartonizationResult['geometryFallbackLines']
  recipePackages: HybridRecipePackage[]
  materials: HybridCartonizationMaterial[]
  inventoryProducts: InventoryProductEvidence[]
  availabilityMode?: 'operational' | 'shadow_training_simulated'
  startingSequence: number
  maximumPackages: number
}): OperationalUnitMaterialPlan {
  const shadowTraining =
    input.availabilityMode === 'shadow_training_simulated'
  if (input.provider !== 'shopify' && !shadowTraining) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_PROVIDER_UNSUPPORTED',
      'Operational unit-material planning currently requires exact Shopify inventory authority.',
    )
  }
  if (!positiveInteger(input.startingSequence)
    || !positiveInteger(input.maximumPackages)) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_REQUEST_INVALID',
      'The unit-material package bound is invalid.',
    )
  }

  const lineById = new Map(input.lines.map((line) => [
    line.lineGlobalId,
    line,
  ]))
  let unitCount = 0
  const demandByProduct = new Map<string, number>()
  for (const fallback of input.fallbackLines) {
    const line = lineById.get(fallback.lineGlobalId)
    if (
      !line
      || line.productGlobalId !== fallback.productGlobalId
      || fallback.fitModel !== 'unconstrained_unit'
      || line.profile.fitModel !== 'unconstrained_unit'
      || !positiveInteger(line.unitWeightGrams)
      || !positiveInteger(fallback.quantity)
      || fallback.quantity > line.quantity
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_LINE_INVALID',
        `Line ${fallback.lineGlobalId} is not a valid one-each line with retained positive weight.`,
      )
    }
    unitCount += fallback.quantity
    demandByProduct.set(
      fallback.productGlobalId,
      (demandByProduct.get(fallback.productGlobalId) || 0)
        + fallback.quantity,
    )
  }
  if (!positiveInteger(unitCount) || unitCount > input.maximumPackages) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
      `The unit-material plan requires ${unitCount} package(s); the remaining bound is ${input.maximumPackages}.`,
    )
  }

  const recipeProducts = recipeProductUsage(input.recipePackages)
  const inventoryByProduct = new Map(input.inventoryProducts.map((item) => [
    item.productGlobalId,
    item,
  ]))
  for (const [productGlobalId, demand] of demandByProduct) {
    const inventory = inventoryByProduct.get(productGlobalId)
    const available = Number(inventory?.effectiveAvailableQuantity)
      - (recipeProducts.get(productGlobalId) || 0)
    const validShadow = shadowTraining
      && inventory?.availabilityAuthority === 'shadow_training_simulated'
      && available >= demand
    const validOperational = !shadowTraining
      && inventory?.availabilityAuthority === 'shopify_provider_commitment'
      && inventory.sourceLevelGlobalIds.length === 1
      && (inventory.sourcePositionGlobalIds || []).length === 1
      && nonnegativeInteger(inventory.sourcePositionVersion)
      && nonnegativeInteger(inventory.providerCommittedQuantity)
      && nonnegativeInteger(inventory.activeReservedQuantity)
      && inventory.providerCommittedQuantity - inventory.activeReservedQuantity
        === inventory.effectiveAvailableQuantity
      && available >= demand
    if (!validShadow && !validOperational) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_INVENTORY_REQUIRED',
        `Unit item ${productGlobalId} lacks exact available inventory authority for ${demand} unit(s).`,
      )
    }
  }

  const usedMaterials = recipeMaterialUsage(input.recipePackages)
  const materialRemaining = new Map<string, number>()
  const materials = input.materials.flatMap((material) => {
    const inner = material.innerDimensionsMm
    const outer = material.ratedOuterDimensionsMm
    const available = shadowTraining
      ? unitCount
      : Number(material.availableQuantity)
        - (usedMaterials.get(material.materialGlobalId) || 0)
    if (
      material.status !== 'active'
      || material.isCurrent !== true
      || material.capturedRowVersion !== material.currentRowVersion
      || !exactDimensions(inner)
      || !exactDimensions(outer)
      || outer.length < inner.length
      || outer.width < inner.width
      || outer.height < inner.height
      || !positiveInteger(material.tareWeightGrams)
      || !positiveInteger(material.maximumGrossWeightGrams)
      || !positiveInteger(material.unitCostMinor)
      || !material.currency
      || !positiveInteger(available)
    ) return []
    materialRemaining.set(material.materialGlobalId, available)
    return [material]
  }).sort((left, right) => (
    volume(right.innerDimensionsMm) - volume(left.innerDimensionsMm)
    || left.materialGlobalId.localeCompare(right.materialGlobalId)
  ))
  if (materials.length < 1) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_REQUIRED',
      'No exact selected material with factual dimensions, capacity, cost, and available warehouse stock can package the unit items.',
    )
  }

  const packages: OperationalUnitMaterialPackage[] = []
  for (const fallback of [...input.fallbackLines].sort((left, right) => (
    left.lineGlobalId.localeCompare(right.lineGlobalId)
  ))) {
    const line = lineById.get(fallback.lineGlobalId) as HybridCartonizationLine
    for (let unit = 1; unit <= fallback.quantity; unit += 1) {
      const material = materials.find((candidate) => (
        Number(materialRemaining.get(candidate.materialGlobalId) || 0) > 0
        && line.unitWeightGrams + Number(candidate.tareWeightGrams)
          <= Number(candidate.maximumGrossWeightGrams)
      ))
      if (!material
        || !material.ratedOuterDimensionsMm
        || !material.tareWeightGrams
        || !material.maximumGrossWeightGrams) {
        return blocked(
          'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
          `No selected factual material has remaining stock and gross-weight capacity for one unit of ${line.title}.`,
        )
      }
      materialRemaining.set(
        material.materialGlobalId,
        Number(materialRemaining.get(material.materialGlobalId)) - 1,
      )
      const packageSequence = input.startingSequence + packages.length
      const allocation = {
        lineGlobalId: line.lineGlobalId,
        productGlobalId: line.productGlobalId,
        title: line.title,
        quantity: 1 as const,
      }
      const keySnapshot = {
        policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
        packageSequence,
        unit,
        allocation,
        unitWeightGrams: line.unitWeightGrams,
        materialGlobalId: material.materialGlobalId,
        materialRowVersion: material.currentRowVersion,
      }
      packages.push({
        packageKey: `ump-${canonicalUnitMaterialHash(keySnapshot).slice(0, 20)}`,
        packageSequence,
        planningMethod: 'unit_material_selection',
        packagingMaterialGlobalId: material.materialGlobalId,
        materialRowVersion: material.currentRowVersion,
        recipes: [],
        orToolsProfiles: [],
        innerDimensionsMm: material.innerDimensionsMm,
        ratedOuterDimensionsMm: material.ratedOuterDimensionsMm,
        contentWeightGrams: line.unitWeightGrams,
        tareWeightGrams: material.tareWeightGrams,
        ratedGrossWeightGrams:
          line.unitWeightGrams + material.tareWeightGrams,
        maxWeightGrams: material.maximumGrossWeightGrams,
        allocations: [allocation],
        unitMaterialEvidence: {
          policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
          productPackConstraint: 'not_required_for_one_each_line',
          packageSelectionBasis:
            'largest_selected_factual_container_with_available_stock',
          unitsPerPackage: 1,
          unitWeightAuthority: 'provider_or_order_specific',
        },
      })
    }
  }
  return {
    status: 'ready',
    policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
    packages,
    evidence: {
      policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
      productPackConstraint: 'not_required_for_one_each_line',
      packageSelectionBasis:
        'largest_selected_factual_container_with_available_stock',
      unitsPerPackage: 1,
      unitWeightAuthority: 'provider_or_order_specific',
      materialAuthority:
        'current_active_material_and_unclaimed_warehouse_stock',
      inventoryAuthority: shadowTraining
        ? 'shadow_training_simulated'
        : 'shopify_provider_commitment_less_active_reservations',
      transformationHash: canonicalUnitMaterialHash(packages),
    },
  }
}
