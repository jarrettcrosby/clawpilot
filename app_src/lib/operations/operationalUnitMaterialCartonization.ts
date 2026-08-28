import { createHash } from 'node:crypto'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationResult,
  HybridRecipePackage,
} from '@/lib/operations/hybridCartonization'

export const OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION =
  'operational-unit-material-fixed-axis-v2' as const

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (
          left < right ? -1 : left > right ? 1 : 0
        ))
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

export type OperationalUnitMaterialInventoryProductEvidence = {
  productGlobalId: string
  availabilityAuthority:
    | 'operational_available'
    | 'shopify_provider_commitment'
    | 'shopify_checkout_available_snapshot'
    | 'shadow_training_simulated'
  providerCommittedQuantity?: number
  activeReservedQuantity?: number
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
    quantity: number
  }>
  unitMaterialEvidence: {
    policyVersion: typeof OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION
    productPackConstraint: 'not_required_for_ordinary_unit'
    packageSelectionBasis:
      'fewest_packages_then_material_cost_then_inner_cube'
      | 'largest_selected_factual_container_with_available_stock'
    unitsPerPackage: number
    unitWeightGrams: number
    unitWeightAuthority: 'provider_or_order_specific'
    unitDimensionsAuthority: 'order_specific' | 'unavailable'
    fitModel: 'fixed_axis_regular_grid' | 'one_each_without_fit_claim'
    rotationAllowed: false
    unitDimensionsMm: DimensionsMm | null
    axisCounts: DimensionsMm | null
    spatialCapacityUnits: number | null
    weightCapacityUnits: number
    effectiveCapacityUnits: number
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
        productPackConstraint: 'not_required_for_ordinary_unit'
        packageSelectionPolicies: {
          dimensioned: 'fewest_packages_then_material_cost_then_inner_cube'
          undimensioned:
            'largest_selected_factual_container_with_available_stock'
        }
        combinationPolicy: 'same_line_fixed_axis_only'
        unitWeightAuthority: 'provider_or_order_specific'
        unitDimensionsAuthority:
          'order_specific_or_one_each_without_fit_claim'
        rotationAllowed: false
        dimensionedLineCount: number
        oneEachUndimensionedLineCount: number
        materialAuthority:
          'current_active_material_and_unclaimed_warehouse_stock'
          | 'selected_material_stock_snapshot'
        inventoryAuthority:
          'shopify_provider_commitment_less_active_reservations'
          | 'shopify_checkout_available_snapshot'
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

type MaterialOption = {
  material: HybridCartonizationMaterial
  availableQuantity: number
  axisCounts: DimensionsMm | null
  spatialCapacityUnits: number | null
  weightCapacityUnits: number
  effectiveCapacityUnits: number
  unitCostMinor: number
  innerCubeMm3: number
}

type MaterialSelection = {
  packageCount: number
  coveredUnits: number
  materialCostMinor: number
  innerCubeMm3: number
  counts: number[]
}

function compareCounts(left: number[], right: number[]) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index]
  }
  return 0
}

function compareSelection(
  left: MaterialSelection,
  right: MaterialSelection,
) {
  return left.materialCostMinor - right.materialCostMinor
    || left.innerCubeMm3 - right.innerCubeMm3
    || compareCounts(left.counts, right.counts)
}

function enumerateMaterialCounts(input: {
  quantity: number
  maximumPackages: number
  options: MaterialOption[]
  preserveMaterialIds: Set<string>
  stateBudget: { remaining: number }
}) {
  let states = new Map<string, MaterialSelection>([['0:0:', {
    packageCount: 0,
    coveredUnits: 0,
    materialCostMinor: 0,
    innerCubeMm3: 0,
    counts: input.options.map(() => 0),
  }]])
  for (let optionIndex = 0; optionIndex < input.options.length; optionIndex += 1) {
    const option = input.options[optionIndex]
    const next = new Map<string, MaterialSelection>()
    for (const state of states.values()) {
      const maximumUse = Math.min(
        option.availableQuantity,
        input.maximumPackages - state.packageCount,
        input.quantity - state.packageCount,
      )
      for (let use = 0; use <= maximumUse; use += 1) {
        input.stateBudget.remaining -= 1
        if (input.stateBudget.remaining < 0) return null
        const counts = [...state.counts]
        counts[optionIndex] = use
        const candidate: MaterialSelection = {
          packageCount: state.packageCount + use,
          coveredUnits: Math.min(
            input.quantity,
            state.coveredUnits + use * option.effectiveCapacityUnits,
          ),
          materialCostMinor:
            state.materialCostMinor + use * option.unitCostMinor,
          innerCubeMm3: state.innerCubeMm3 + use * option.innerCubeMm3,
          counts,
        }
        const preservedCounts = input.options.flatMap((candidateOption, index) => (
          input.preserveMaterialIds.has(
            candidateOption.material.materialGlobalId,
          ) ? [counts[index]] : []
        )).join(',')
        const key = `${candidate.packageCount}:${candidate.coveredUnits}:${preservedCounts}`
        const retained = next.get(key)
        if (!retained || compareSelection(candidate, retained) < 0) {
          next.set(key, candidate)
        }
      }
    }
    states = next
  }
  return [...states.values()].filter((selection) => (
    selection.coveredUnits >= input.quantity
    && selection.packageCount <= input.quantity
  )).sort((left, right) => (
    left.packageCount - right.packageCount
    || compareSelection(left, right)
  ))
}

function selectGlobalDimensionedMaterialCounts(input: {
  lines: Array<{
    lineGlobalId: string
    quantity: number
    options: MaterialOption[]
  }>
  maximumPackages: number
  materialRemaining: Map<string, number>
}) {
  const stateBudget = { remaining: 100_000 }
  const ordered = [...input.lines].sort((left, right) => (
    left.lineGlobalId.localeCompare(right.lineGlobalId)
  ))
  type GlobalSelection = {
    packageCount: number
    materialCostMinor: number
    innerCubeMm3: number
    byLine: Map<string, MaterialSelection>
  }
  let best: GlobalSelection | null = null
  let exceeded = false
  const visit = (
    lineIndex: number,
    packageCount: number,
    materialCostMinor: number,
    innerCubeMm3: number,
    remaining: Map<string, number>,
    byLine: Map<string, MaterialSelection>,
  ) => {
    stateBudget.remaining -= 1
    if (stateBudget.remaining < 0) {
      exceeded = true
      return
    }
    if (best && packageCount > best.packageCount) return
    if (lineIndex === ordered.length) {
      const candidate = {
        packageCount,
        materialCostMinor,
        innerCubeMm3,
        byLine: new Map(byLine),
      }
      if (
        !best
        || candidate.packageCount < best.packageCount
        || (
          candidate.packageCount === best.packageCount
          && (
            candidate.materialCostMinor < best.materialCostMinor
            || (
              candidate.materialCostMinor === best.materialCostMinor
              && candidate.innerCubeMm3 < best.innerCubeMm3
            )
          )
        )
      ) best = candidate
      return
    }
    const entry = ordered[lineIndex]
    const options = entry.options.map((option) => ({
      ...option,
      availableQuantity: Number(
        remaining.get(option.material.materialGlobalId) || 0,
      ),
    }))
    const candidates = enumerateMaterialCounts({
      quantity: entry.quantity,
      maximumPackages: input.maximumPackages - packageCount,
      options,
      preserveMaterialIds: new Set(ordered.slice(lineIndex + 1).flatMap(
        (future) => future.options.map(
          (option) => option.material.materialGlobalId,
        ),
      )),
      stateBudget,
    })
    if (!candidates) {
      exceeded = true
      return
    }
    for (const selection of candidates) {
      const nextRemaining = new Map(remaining)
      selection.counts.forEach((count, optionIndex) => {
        const materialId = options[optionIndex].material.materialGlobalId
        nextRemaining.set(
          materialId,
          Number(nextRemaining.get(materialId) || 0) - count,
        )
      })
      byLine.set(entry.lineGlobalId, selection)
      visit(
        lineIndex + 1,
        packageCount + selection.packageCount,
        materialCostMinor + selection.materialCostMinor,
        innerCubeMm3 + selection.innerCubeMm3,
        nextRemaining,
        byLine,
      )
      byLine.delete(entry.lineGlobalId)
    }
  }
  visit(0, 0, 0, 0, new Map(input.materialRemaining), new Map())
  const retained = best as GlobalSelection | null
  return {
    selections: retained ? retained.byLine : null,
    exceeded,
  }
}

function materialOptions(input: {
  line: HybridCartonizationLine
  dimensions: DimensionsMm | null
  materials: HybridCartonizationMaterial[]
  materialRemaining: Map<string, number>
}) {
  return input.materials.flatMap((material) => {
    const remaining = Number(
      input.materialRemaining.get(material.materialGlobalId) || 0,
    )
    const tare = Number(material.tareWeightGrams)
    const maximumGross = Number(material.maximumGrossWeightGrams)
    const weightCapacityUnits = Math.floor(
      Math.max(0, maximumGross - tare) / input.line.unitWeightGrams,
    )
    const axisCounts = input.dimensions
      ? {
          length: Math.floor(
            material.innerDimensionsMm.length / input.dimensions.length,
          ),
          width: Math.floor(
            material.innerDimensionsMm.width / input.dimensions.width,
          ),
          height: Math.floor(
            material.innerDimensionsMm.height / input.dimensions.height,
          ),
        }
      : null
    const spatialCapacityUnits = axisCounts
      ? axisCounts.length * axisCounts.width * axisCounts.height
      : null
    if (
      spatialCapacityUnits !== null
      && !positiveInteger(spatialCapacityUnits)
    ) return []
    const effectiveCapacityUnits = Math.min(
      weightCapacityUnits,
      spatialCapacityUnits ?? 1,
    )
    if (
      remaining < 1
      || weightCapacityUnits < 1
      || effectiveCapacityUnits < 1
      || (input.dimensions && material.materialType !== 'carton')
    ) return []
    return [{
      material,
      availableQuantity: remaining,
      axisCounts,
      spatialCapacityUnits,
      weightCapacityUnits,
      effectiveCapacityUnits,
      unitCostMinor: Number(material.unitCostMinor || 0),
      innerCubeMm3: volume(material.innerDimensionsMm),
    }]
  }).sort((left, right) => (
    left.material.materialGlobalId.localeCompare(
      right.material.materialGlobalId,
    )
  ))
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
 * Plans ordinary units without inventing a Product-pack profile. Exact
 * order-specific item dimensions permit conservative, fixed-axis regular-grid
 * combination of units from the same line. Lines without item dimensions may
 * remain one-each only where the caller explicitly permits a no-fit fallback;
 * no spatial-fit or mixed-product compatibility claim is made for them.
 */
export type OperationalUnitMaterialPlanInput = {
  provider: 'shopify' | 'faire'
  lines: HybridCartonizationLine[]
  fallbackLines: HybridCartonizationResult['geometryFallbackLines']
  recipePackages: HybridRecipePackage[]
  materials: HybridCartonizationMaterial[]
  inventoryProducts: OperationalUnitMaterialInventoryProductEvidence[]
  availabilityMode?:
    | 'operational'
    | 'shopify_checkout_available_snapshot'
    | 'shadow_training_simulated'
  startingSequence: number
  maximumPackages: number
}

export function planOperationalUnitMaterialPackages(
  input: OperationalUnitMaterialPlanInput,
): OperationalUnitMaterialPlan {
  const shadowTraining =
    input.availabilityMode === 'shadow_training_simulated'
  const checkoutAvailable =
    input.availabilityMode === 'shopify_checkout_available_snapshot'
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
  if (!positiveInteger(unitCount) || !Number.isSafeInteger(unitCount)) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_REQUEST_INVALID',
      'The unit-material demand is not a positive integer-safe quantity.',
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
    const validCheckout = checkoutAvailable
      && inventory?.availabilityAuthority
        === 'shopify_checkout_available_snapshot'
      && inventory.sourceLevelGlobalIds.length > 0
      && nonnegativeInteger(inventory.effectiveAvailableQuantity)
      && available >= demand
    const validOperational = !shadowTraining
      && !checkoutAvailable
      && inventory?.availabilityAuthority === 'shopify_provider_commitment'
      && inventory.sourceLevelGlobalIds.length === 1
      && (inventory.sourcePositionGlobalIds || []).length === 1
      && nonnegativeInteger(inventory.sourcePositionVersion)
      && nonnegativeInteger(inventory.providerCommittedQuantity)
      && nonnegativeInteger(inventory.activeReservedQuantity)
      && inventory.providerCommittedQuantity - inventory.activeReservedQuantity
        === inventory.effectiveAvailableQuantity
      && available >= demand
    if (!validShadow && !validCheckout && !validOperational) {
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
      || (
        !checkoutAvailable
        && (
          !positiveInteger(material.unitCostMinor)
          || !material.currency
        )
      )
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
  let dimensionedLineCount = 0
  let oneEachUndimensionedLineCount = 0
  const orderedFallbackLines = [...input.fallbackLines].sort((left, right) => {
    const leftLine = lineById.get(left.lineGlobalId)
    const rightLine = lineById.get(right.lineGlobalId)
    const leftDimensioned = Boolean(
      !checkoutAvailable && exactDimensions(leftLine?.unitDimensionsMm),
    )
    const rightDimensioned = Boolean(
      !checkoutAvailable && exactDimensions(rightLine?.unitDimensionsMm),
    )
    return Number(rightDimensioned) - Number(leftDimensioned)
      || left.lineGlobalId.localeCompare(right.lineGlobalId)
  })
  const dimensionedEntries = orderedFallbackLines.flatMap((fallback) => {
    const candidate = lineById.get(fallback.lineGlobalId)
    const dimensions = !checkoutAvailable
      && exactDimensions(candidate?.unitDimensionsMm)
      ? candidate.unitDimensionsMm
      : null
    if (!candidate || !dimensions) return []
    return [{
      lineGlobalId: fallback.lineGlobalId,
      quantity: fallback.quantity,
      options: materialOptions({
        line: candidate,
        dimensions,
        materials,
        materialRemaining,
      }),
    }]
  })
  const globalDimensionedResult = selectGlobalDimensionedMaterialCounts({
    lines: dimensionedEntries,
    maximumPackages: input.maximumPackages,
    materialRemaining,
  })
  if (globalDimensionedResult.exceeded) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_GLOBAL_SEARCH_BOUND_EXCEEDED',
      'Exact shared-stock cartonization exceeded its 100000-state safety bound.',
    )
  }
  const globalDimensionedSelections = globalDimensionedResult.selections
  const dimensionedOptionsByLine = new Map(dimensionedEntries.map((entry) => (
    [entry.lineGlobalId, entry.options]
  )))
  for (const fallback of orderedFallbackLines) {
    const line = lineById.get(fallback.lineGlobalId) as HybridCartonizationLine
    // Checkout has no independently retained item-dimension evidence today.
    // Keep its established no-fit, one-carton-per-unit quote behavior even if
    // a synthetic caller happens to attach dimensions to the shared line type.
    const dimensions = !checkoutAvailable && exactDimensions(line.unitDimensionsMm)
      ? line.unitDimensionsMm
      : null
    if (!checkoutAvailable && line.unitDimensionsMm && !dimensions) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_DIMENSIONS_INVALID',
        `Line ${line.lineGlobalId} has invalid ordinary-item dimensions.`,
      )
    }
    if (
      !checkoutAvailable
      && (
        (dimensions && line.unitDimensionsAuthority !== 'order_specific')
        || (!dimensions && line.unitDimensionsAuthority !== null
          && line.unitDimensionsAuthority !== undefined)
      )
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_DIMENSION_AUTHORITY_INVALID',
        `Line ${line.lineGlobalId} has ordinary-item dimensions without exact order-specific authority.`,
      )
    }
    if (dimensions) dimensionedLineCount += 1
    else oneEachUndimensionedLineCount += 1

    const options = dimensions
      ? dimensionedOptionsByLine.get(fallback.lineGlobalId) || []
      : materialOptions({
          line,
          dimensions,
          materials,
          materialRemaining,
        })
    const remainingPackageBound = input.maximumPackages - packages.length
    const selection = dimensions
      ? globalDimensionedSelections?.get(fallback.lineGlobalId) || null
      : fallback.quantity <= remainingPackageBound
          && options.reduce((sum, option) => sum + option.availableQuantity, 0)
            >= fallback.quantity
        ? {
            packageCount: fallback.quantity,
            coveredUnits: fallback.quantity,
            materialCostMinor: 0,
            innerCubeMm3: 0,
            counts: options.map(() => 0),
          }
        : null
    if (!dimensions && selection) {
      let unitsToAssign = fallback.quantity
      const largestFirst = options
        .map((option, optionIndex) => ({ option, optionIndex }))
        .sort((left, right) => (
          right.option.innerCubeMm3 - left.option.innerCubeMm3
          || left.option.material.materialGlobalId.localeCompare(
            right.option.material.materialGlobalId,
          )
        ))
      for (const { option, optionIndex } of largestFirst) {
        const use = Math.min(option.availableQuantity, unitsToAssign)
        selection.counts[optionIndex] = use
        unitsToAssign -= use
        if (unitsToAssign === 0) break
      }
    }
    if (!selection) {
      const stockCapacity = options.reduce((total, option) => (
        total + option.availableQuantity * option.effectiveCapacityUnits
      ), 0)
      if (stockCapacity >= fallback.quantity) {
        return blocked(
          'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
          `The minimum factual plan for ${line.title} exceeds the remaining ${remainingPackageBound} package bound.`,
        )
      }
      return blocked(
        dimensions
          ? 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_FIT_REQUIRED'
          : 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
        dimensions
          ? `No selected factual carton stock can fit and carry all ${fallback.quantity} unit(s) of ${line.title}.`
          : `No selected factual material has remaining stock and gross-weight capacity for ${line.title}.`,
      )
    }

    const selected = options.flatMap((option, optionIndex) => (
      Array.from(
        { length: selection.counts[optionIndex] },
        () => option,
      )
    )).sort((left, right) => dimensions
      ? right.effectiveCapacityUnits - left.effectiveCapacityUnits
        || left.unitCostMinor - right.unitCostMinor
        || left.innerCubeMm3 - right.innerCubeMm3
        || left.material.materialGlobalId.localeCompare(
          right.material.materialGlobalId,
        )
      : right.innerCubeMm3 - left.innerCubeMm3
        || left.material.materialGlobalId.localeCompare(
          right.material.materialGlobalId,
        ))
    let remainingUnits = fallback.quantity
    for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
      const option = selected[selectedIndex]
      const remainingPackages = selected.length - selectedIndex
      const quantity = Math.min(
        option.effectiveCapacityUnits,
        remainingUnits - remainingPackages + 1,
      )
      const material = option.material
      if (
        quantity < 1
        || !material.ratedOuterDimensionsMm
        || !material.tareWeightGrams
        || !material.maximumGrossWeightGrams
      ) {
        return blocked(
          'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_PLAN_INVALID',
          `The factual material allocation for ${line.title} is invalid.`,
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
        quantity,
      }
      const keySnapshot = {
        policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
        packageSequence,
        allocation,
        unitWeightGrams: line.unitWeightGrams,
        unitDimensionsMm: dimensions,
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
        contentWeightGrams: line.unitWeightGrams * quantity,
        tareWeightGrams: material.tareWeightGrams,
        ratedGrossWeightGrams:
          line.unitWeightGrams * quantity + material.tareWeightGrams,
        maxWeightGrams: material.maximumGrossWeightGrams,
        allocations: [allocation],
        unitMaterialEvidence: {
          policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
          productPackConstraint: 'not_required_for_ordinary_unit',
          packageSelectionBasis: dimensions
            ? 'fewest_packages_then_material_cost_then_inner_cube'
            : 'largest_selected_factual_container_with_available_stock',
          unitsPerPackage: quantity,
          unitWeightGrams: line.unitWeightGrams,
          unitWeightAuthority: 'provider_or_order_specific',
          unitDimensionsAuthority: dimensions
            ? 'order_specific'
            : 'unavailable',
          fitModel: dimensions
            ? 'fixed_axis_regular_grid'
            : 'one_each_without_fit_claim',
          rotationAllowed: false,
          unitDimensionsMm: dimensions,
          axisCounts: option.axisCounts,
          spatialCapacityUnits: option.spatialCapacityUnits,
          weightCapacityUnits: option.weightCapacityUnits,
          effectiveCapacityUnits: option.effectiveCapacityUnits,
        },
      })
      remainingUnits -= quantity
    }
    if (remainingUnits !== 0) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_PLAN_INVALID',
        `The factual material allocation for ${line.title} did not conserve quantity.`,
      )
    }
  }
  return {
    status: 'ready',
    policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
    packages,
    evidence: {
      policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
      productPackConstraint: 'not_required_for_ordinary_unit',
      packageSelectionPolicies: {
        dimensioned: 'fewest_packages_then_material_cost_then_inner_cube',
        undimensioned:
          'largest_selected_factual_container_with_available_stock',
      },
      combinationPolicy: 'same_line_fixed_axis_only',
      unitWeightAuthority: 'provider_or_order_specific',
      unitDimensionsAuthority:
        'order_specific_or_one_each_without_fit_claim',
      rotationAllowed: false,
      dimensionedLineCount,
      oneEachUndimensionedLineCount,
      materialAuthority: checkoutAvailable
        ? 'selected_material_stock_snapshot'
        : 'current_active_material_and_unclaimed_warehouse_stock',
      inventoryAuthority: shadowTraining
        ? 'shadow_training_simulated'
        : checkoutAvailable
          ? 'shopify_checkout_available_snapshot'
          : 'shopify_provider_commitment_less_active_reservations',
      transformationHash: canonicalUnitMaterialHash(packages),
    },
  }
}

/**
 * Checkout rating uses a fresh, read-only Shopify availability snapshot. It
 * does not imply provider commitment, reserve product inventory, or claim
 * packaging stock. The returned cartons are quote candidates only.
 */
export function planShopifyCheckoutUnitMaterialPackages(
  input: Omit<
    OperationalUnitMaterialPlanInput,
    'provider' | 'availabilityMode'
  >,
): OperationalUnitMaterialPlan {
  return planOperationalUnitMaterialPackages({
    ...input,
    provider: 'shopify',
    availabilityMode: 'shopify_checkout_available_snapshot',
  })
}
