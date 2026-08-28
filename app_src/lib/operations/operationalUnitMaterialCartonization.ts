import { createHash } from 'node:crypto'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationResult,
  HybridRecipePackage,
} from '@/lib/operations/hybridCartonization'

export const OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION =
  'operational-unit-material-shared-stock-v3' as const

export const OPERATIONAL_UNIT_MATERIAL_SELECTION_POLICIES = {
  dimensioned: 'fewest_packages_then_material_cost_then_inner_cube',
  undimensioned:
    'largest_rated_outer_volume_then_sorted_axes_then_material_id',
  boundedFallback:
    'unknown_outer_rank_then_dimensioned_cost_rank_min_cost_max_flow_one_carton_per_unit',
} as const

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
      | 'largest_rated_outer_volume_then_sorted_axes_then_material_id'
      | 'deterministic_shared_stock_one_carton_per_unit'
    sharedStockSolver:
      | 'exact_bounded_search'
      | 'min_cost_max_flow_one_carton_per_unit_fallback'
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
            'largest_rated_outer_volume_then_sorted_axes_then_material_id'
          boundedFallback:
            'unknown_outer_rank_then_dimensioned_cost_rank_min_cost_max_flow_one_carton_per_unit'
        }
        sharedStockSolver:
          | 'exact_bounded_search'
          | 'min_cost_max_flow_one_carton_per_unit_fallback'
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
  ratedOuterVolumeMm3: bigint
  ratedOuterEnvelopeAxesMm: [number, number, number]
}

type MaterialSelection = {
  packageCount: number
  coveredUnits: number
  materialCostMinor: number
  innerCubeMm3: number
  undimensionedPreferenceCost: number
  counts: number[]
}

function compareCounts(left: number[], right: number[]) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index]
  }
  return 0
}

function compareDimensionedSelection(
  left: MaterialSelection,
  right: MaterialSelection,
) {
  return left.materialCostMinor - right.materialCostMinor
    || left.innerCubeMm3 - right.innerCubeMm3
    || compareCounts(left.counts, right.counts)
}

function compareRatedOuterCarrierEnvelope(
  left: MaterialOption,
  right: MaterialOption,
) {
  if (left.ratedOuterVolumeMm3 !== right.ratedOuterVolumeMm3) {
    return left.ratedOuterVolumeMm3 > right.ratedOuterVolumeMm3 ? -1 : 1
  }
  return right.ratedOuterEnvelopeAxesMm[0]
      - left.ratedOuterEnvelopeAxesMm[0]
    || right.ratedOuterEnvelopeAxesMm[1]
      - left.ratedOuterEnvelopeAxesMm[1]
    || right.ratedOuterEnvelopeAxesMm[2]
      - left.ratedOuterEnvelopeAxesMm[2]
    || left.material.materialGlobalId.localeCompare(
      right.material.materialGlobalId,
    )
}

type SharedStockLine = {
  lineGlobalId: string
  productGlobalId: string
  quantity: number
  dimensions: DimensionsMm | null
  options: MaterialOption[]
}

function enumerateMaterialCounts(input: {
  quantity: number
  maximumPackages: number
  options: MaterialOption[]
  preserveMaterialIds: Set<string>
  stateBudget: { remaining: number }
  dimensioned: boolean
}) {
  const undimensionedRanks = new Map(
    [...input.options]
      .sort(compareRatedOuterCarrierEnvelope)
      .map((option, index) => [option.material.materialGlobalId, index]),
  )
  let states = new Map<string, MaterialSelection>([['0:0:', {
    packageCount: 0,
    coveredUnits: 0,
    materialCostMinor: 0,
    innerCubeMm3: 0,
    undimensionedPreferenceCost: 0,
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
          undimensionedPreferenceCost:
            state.undimensionedPreferenceCost + use * Number(
              undimensionedRanks.get(option.material.materialGlobalId) || 0,
            ),
          counts,
        }
        const preservedCounts = input.options.flatMap((candidateOption, index) => (
          input.preserveMaterialIds.has(
            candidateOption.material.materialGlobalId,
          ) ? [counts[index]] : []
        )).join(',')
        const key = `${candidate.packageCount}:${candidate.coveredUnits}:${preservedCounts}`
        const retained = next.get(key)
        const preference = !retained
          ? -1
          : input.dimensioned
            ? compareDimensionedSelection(candidate, retained)
            : candidate.undimensionedPreferenceCost
                - retained.undimensionedPreferenceCost
              || compareCounts(candidate.counts, retained.counts)
        if (!retained || preference < 0) {
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
    || (input.dimensioned
      ? compareDimensionedSelection(left, right)
      : left.undimensionedPreferenceCost
          - right.undimensionedPreferenceCost
        || compareCounts(left.counts, right.counts))
  ))
}

function selectionSignature(input: {
  ordered: SharedStockLine[]
  byLine: Map<string, MaterialSelection>
}) {
  return input.ordered.map((line) => {
    const selection = input.byLine.get(line.lineGlobalId)
    return `${line.productGlobalId}:${line.lineGlobalId}:${
      selection?.counts.join(',') || ''
    }`
  }).join('|')
}

function selectGlobalMaterialCounts(input: {
  lines: SharedStockLine[]
  maximumPackages: number
  materialRemaining: Map<string, number>
}) {
  const stateBudget = { remaining: 100_000 }
  const ordered = [...input.lines].sort((left, right) => (
    left.options.length - right.options.length
    || Number(Boolean(right.dimensions)) - Number(Boolean(left.dimensions))
    || left.productGlobalId.localeCompare(right.productGlobalId)
    || left.lineGlobalId.localeCompare(right.lineGlobalId)
  ))
  type GlobalSelection = {
    packageCount: number
    materialCostMinor: number
    innerCubeMm3: number
    undimensionedPreferenceCost: number
    byLine: Map<string, MaterialSelection>
  }
  let best: GlobalSelection | null = null
  let exceeded = false
  const visit = (
    lineIndex: number,
    packageCount: number,
    materialCostMinor: number,
    innerCubeMm3: number,
    undimensionedPreferenceCost: number,
    remaining: Map<string, number>,
    byLine: Map<string, MaterialSelection>,
  ) => {
    if (exceeded) return
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
        undimensionedPreferenceCost,
        byLine: new Map(byLine),
      }
      if (
        !best
        || candidate.packageCount < best.packageCount
        || (
          candidate.packageCount === best.packageCount
          && (
            candidate.undimensionedPreferenceCost
              < best.undimensionedPreferenceCost
            || (
              candidate.undimensionedPreferenceCost
                === best.undimensionedPreferenceCost
              && (
                candidate.materialCostMinor < best.materialCostMinor
                || (
                  candidate.materialCostMinor === best.materialCostMinor
                  && (
                    candidate.innerCubeMm3 < best.innerCubeMm3
                    || (
                      candidate.innerCubeMm3 === best.innerCubeMm3
                      && selectionSignature({ ordered, byLine: candidate.byLine })
                        < selectionSignature({ ordered, byLine: best.byLine })
                    )
                  )
                )
              )
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
      dimensioned: Boolean(entry.dimensions),
    })
    if (!candidates) {
      exceeded = true
      return
    }
    for (const selection of candidates) {
      if (exceeded) break
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
        undimensionedPreferenceCost + (
          entry.dimensions ? 0 : selection.undimensionedPreferenceCost
        ),
        nextRemaining,
        byLine,
      )
      byLine.delete(entry.lineGlobalId)
    }
  }
  visit(0, 0, 0, 0, 0, new Map(input.materialRemaining), new Map())
  const retained = best as GlobalSelection | null
  return {
    selections: retained ? retained.byLine : null,
    exceeded,
  }
}

type FlowEdge = {
  to: number
  reverse: number
  capacity: number
  cost: number
}

function addFlowEdge(
  graph: FlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: number,
) {
  const forward: FlowEdge = {
    to,
    reverse: graph[to].length,
    capacity,
    cost,
  }
  const reverse: FlowEdge = {
    to: from,
    reverse: graph[from].length,
    capacity: 0,
    cost: -cost,
  }
  graph[from].push(forward)
  graph[to].push(reverse)
}

/**
 * Polynomial fail-safe used only when the exact consolidating search exhausts
 * its explicit state budget. Every residual unit receives one independently
 * factual carton. Integral min-cost max-flow jointly reserves shared stock,
 * so a flexible line cannot consume the only carton that can carry another
 * line. Forward edge order and tie-breaking are canonical.
 */
function selectOneCartonPerUnitSharedStock(input: {
  lines: SharedStockLine[]
  maximumPackages: number
  materialRemaining: Map<string, number>
}) {
  const orderedLines = [...input.lines].sort((left, right) => (
    left.productGlobalId.localeCompare(right.productGlobalId)
    || left.lineGlobalId.localeCompare(right.lineGlobalId)
  ))
  const unitCount = orderedLines.reduce(
    (total, line) => total + line.quantity,
    0,
  )
  if (unitCount > input.maximumPackages) {
    return { selections: null, packageBoundExceeded: true }
  }
  const materialIds = [...input.materialRemaining.keys()].sort()
  const materialIndex = new Map(materialIds.map((id, index) => [id, index]))
  const source = 0
  const lineOffset = 1
  const materialOffset = lineOffset + orderedLines.length
  const sink = materialOffset + materialIds.length
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => [])
  const unknownPriorityMultiplier = unitCount * Math.max(1, materialIds.length)
    + 1
  const lineMaterialEdges = new Map<string, Map<string, FlowEdge>>()
  orderedLines.forEach((line, lineIndex) => {
    addFlowEdge(graph, source, lineOffset + lineIndex, line.quantity, 0)
    const preferred = [...line.options].sort((left, right) => (
      line.dimensions
        ? left.unitCostMinor - right.unitCostMinor
          || left.innerCubeMm3 - right.innerCubeMm3
          || left.material.materialGlobalId.localeCompare(
            right.material.materialGlobalId,
          )
        : compareRatedOuterCarrierEnvelope(left, right)
    ))
    const edges = new Map<string, FlowEdge>()
    preferred.forEach((option, preferenceRank) => {
      const id = option.material.materialGlobalId
      const index = materialIndex.get(id)
      if (index === undefined) return
      addFlowEdge(
        graph,
        lineOffset + lineIndex,
        materialOffset + index,
        line.quantity,
        preferenceRank * (line.dimensions ? 1 : unknownPriorityMultiplier),
      )
      edges.set(id, graph[lineOffset + lineIndex].at(-1) as FlowEdge)
    })
    lineMaterialEdges.set(line.lineGlobalId, edges)
  })
  materialIds.forEach((id, index) => {
    addFlowEdge(
      graph,
      materialOffset + index,
      sink,
      Number(input.materialRemaining.get(id) || 0),
      0,
    )
  })

  let flow = 0
  while (flow < unitCount) {
    const distance = Array(graph.length).fill(Number.POSITIVE_INFINITY)
    const previousNode = Array(graph.length).fill(-1)
    const previousEdge = Array(graph.length).fill(-1)
    distance[source] = 0
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false
      for (let from = 0; from < graph.length; from += 1) {
        if (!Number.isFinite(distance[from])) continue
        for (let edgeIndex = 0; edgeIndex < graph[from].length; edgeIndex += 1) {
          const edge = graph[from][edgeIndex]
          if (edge.capacity < 1) continue
          const candidate = distance[from] + edge.cost
          if (candidate < distance[edge.to]) {
            distance[edge.to] = candidate
            previousNode[edge.to] = from
            previousEdge[edge.to] = edgeIndex
            changed = true
          }
        }
      }
      if (!changed) break
    }
    if (previousNode[sink] < 0) {
      return { selections: null, packageBoundExceeded: false }
    }
    let augment = unitCount - flow
    for (let node = sink; node !== source; node = previousNode[node]) {
      augment = Math.min(
        augment,
        graph[previousNode[node]][previousEdge[node]].capacity,
      )
    }
    for (let node = sink; node !== source; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]]
      edge.capacity -= augment
      graph[node][edge.reverse].capacity += augment
    }
    flow += augment
  }

  const selections = new Map<string, MaterialSelection>()
  for (const line of orderedLines) {
    const counts = line.options.map((option) => {
      const edge = lineMaterialEdges.get(line.lineGlobalId)?.get(
        option.material.materialGlobalId,
      )
      return edge ? graph[edge.to][edge.reverse].capacity : 0
    })
    selections.set(line.lineGlobalId, {
      packageCount: line.quantity,
      coveredUnits: line.quantity,
      materialCostMinor: counts.reduce(
        (total, count, index) => total + count * line.options[index].unitCostMinor,
        0,
      ),
      innerCubeMm3: counts.reduce(
        (total, count, index) => total + count * line.options[index].innerCubeMm3,
        0,
      ),
      undimensionedPreferenceCost: counts.reduce((total, count, index) => {
        if (line.dimensions) return total
        const ranked = [...line.options].sort(compareRatedOuterCarrierEnvelope)
        const rank = ranked.findIndex((option) => (
          option.material.materialGlobalId
            === line.options[index].material.materialGlobalId
        ))
        return total + count * rank
      }, 0),
      counts,
    })
  }
  return { selections, packageBoundExceeded: false }
}

function materialOptions(input: {
  line: HybridCartonizationLine
  dimensions: DimensionsMm | null
  materials: HybridCartonizationMaterial[]
  materialRemaining: Map<string, number>
}) {
  return input.materials.flatMap((material) => {
    const ratedOuter = material.ratedOuterDimensionsMm
    if (!ratedOuter) return []
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
      ratedOuterVolumeMm3:
        BigInt(ratedOuter.length)
        * BigInt(ratedOuter.width)
        * BigInt(ratedOuter.height),
      ratedOuterEnvelopeAxesMm: [
        ratedOuter.length,
        ratedOuter.width,
        ratedOuter.height,
      ].sort((left, right) => right - left) as [number, number, number],
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
  reservedMaterialUsage?: Array<{
    materialGlobalId: string
    quantity: number
  }>
  simulatedMaterialAvailableQuantity?: number
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
  const reservedMaterialIds = new Set<string>()
  for (const usage of input.reservedMaterialUsage || []) {
    if (
      !usage.materialGlobalId
      || reservedMaterialIds.has(usage.materialGlobalId)
      || !positiveInteger(usage.quantity)
      || !input.materials.some((material) => (
        material.materialGlobalId === usage.materialGlobalId
      ))
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_RESERVATION_INVALID',
        'Joint cartonization reservations require one positive, unique count for selected factual material stock.',
      )
    }
    reservedMaterialIds.add(usage.materialGlobalId)
    const next = (usedMaterials.get(usage.materialGlobalId) || 0)
      + usage.quantity
    if (!Number.isSafeInteger(next)) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_RESERVATION_INVALID',
        'Joint cartonization material reservations exceed the integer-safe stock boundary.',
      )
    }
    usedMaterials.set(usage.materialGlobalId, next)
  }
  const simulatedMaterialAvailableQuantity = shadowTraining
    ? input.simulatedMaterialAvailableQuantity ?? unitCount
    : null
  if (
    shadowTraining
    && !positiveInteger(simulatedMaterialAvailableQuantity)
  ) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_RESERVATION_INVALID',
      'Shadow-training joint cartonization requires one positive simulated material-stock boundary.',
    )
  }
  const materialRemaining = new Map<string, number>()
  const materials = input.materials.flatMap((material) => {
    const inner = material.innerDimensionsMm
    const outer = material.ratedOuterDimensionsMm
    const available = (
      shadowTraining
        ? Number(simulatedMaterialAvailableQuantity)
        : Number(material.availableQuantity)
    ) - (usedMaterials.get(material.materialGlobalId) || 0)
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

  const orderedFallbackLines = [...input.fallbackLines].sort((left, right) => {
    const leftLine = lineById.get(left.lineGlobalId)
    const rightLine = lineById.get(right.lineGlobalId)
    return String(leftLine?.productGlobalId || '').localeCompare(
      String(rightLine?.productGlobalId || ''),
    ) || left.lineGlobalId.localeCompare(right.lineGlobalId)
  })
  const sharedStockLines: SharedStockLine[] = []
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
    const options = materialOptions({
      line,
      dimensions,
      materials,
      materialRemaining,
    })
    if (options.length < 1) {
      return blocked(
        dimensions
          ? 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_FIT_REQUIRED'
          : 'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
        dimensions
          ? `No selected factual carton stock can fit and carry all ${fallback.quantity} unit(s) of ${line.title}.`
          : `No selected factual material has remaining stock and gross-weight capacity for ${line.title}.`,
      )
    }
    sharedStockLines.push({
      lineGlobalId: line.lineGlobalId,
      productGlobalId: line.productGlobalId,
      quantity: fallback.quantity,
      dimensions,
      options,
    })
  }

  const exact = selectGlobalMaterialCounts({
    lines: sharedStockLines,
    maximumPackages: input.maximumPackages,
    materialRemaining,
  })
  let sharedStockSolver:
    | 'exact_bounded_search'
    | 'min_cost_max_flow_one_carton_per_unit_fallback'
  let selections = exact.selections
  if (exact.exceeded || !selections) {
    const bounded = selectOneCartonPerUnitSharedStock({
      lines: sharedStockLines,
      maximumPackages: input.maximumPackages,
      materialRemaining,
    })
    if (!bounded.selections) {
      if (bounded.packageBoundExceeded) {
        return blocked(
          'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
          `The bounded factual fallback requires ${unitCount} packages, exceeding the ${input.maximumPackages}-package residual limit.`,
        )
      }
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_CAPACITY_REQUIRED',
        'Selected factual material stock cannot jointly fit and carry every residual ordinary unit.',
      )
    }
    selections = bounded.selections
    sharedStockSolver = 'min_cost_max_flow_one_carton_per_unit_fallback'
  } else {
    sharedStockSolver = 'exact_bounded_search'
  }

  const packages: OperationalUnitMaterialPackage[] = []
  const sharedStockLineById = new Map(sharedStockLines.map((entry) => (
    [entry.lineGlobalId, entry]
  )))
  for (const fallback of orderedFallbackLines) {
    const line = lineById.get(fallback.lineGlobalId) as HybridCartonizationLine
    const entry = sharedStockLineById.get(fallback.lineGlobalId)
    const dimensions = entry?.dimensions || null
    const options = entry?.options || []
    const selection = selections.get(fallback.lineGlobalId)
    if (!selection) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_PLAN_INVALID',
        `The shared-stock allocation for ${line.title} is incomplete.`,
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
      : compareRatedOuterCarrierEnvelope(left, right))
    let remainingUnits = fallback.quantity
    for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex += 1) {
      const option = selected[selectedIndex]
      const remainingPackages = selected.length - selectedIndex
      const quantity = sharedStockSolver
        === 'min_cost_max_flow_one_carton_per_unit_fallback'
        ? 1
        : Math.min(
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
        sharedStockSolver,
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
            ? sharedStockSolver === 'exact_bounded_search'
              ? OPERATIONAL_UNIT_MATERIAL_SELECTION_POLICIES.dimensioned
              : 'deterministic_shared_stock_one_carton_per_unit'
            : OPERATIONAL_UNIT_MATERIAL_SELECTION_POLICIES.undimensioned,
          sharedStockSolver,
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
  const dimensionedLineIds = new Set(packages.flatMap((item) => (
    item.unitMaterialEvidence.fitModel === 'fixed_axis_regular_grid'
      ? [item.allocations[0].lineGlobalId]
      : []
  )))
  const oneEachUndimensionedLineIds = new Set(packages.flatMap((item) => (
    item.unitMaterialEvidence.fitModel === 'one_each_without_fit_claim'
      ? [item.allocations[0].lineGlobalId]
      : []
  )))
  if ([...dimensionedLineIds].some((id) => (
    oneEachUndimensionedLineIds.has(id)
  ))) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_UNIT_MATERIAL_PLAN_INVALID',
      'One ordinary line cannot retain both dimensioned and undimensioned package evidence.',
    )
  }
  return {
    status: 'ready',
    policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
    packages,
    evidence: {
      policyVersion: OPERATIONAL_UNIT_MATERIAL_POLICY_VERSION,
      productPackConstraint: 'not_required_for_ordinary_unit',
      packageSelectionPolicies:
        OPERATIONAL_UNIT_MATERIAL_SELECTION_POLICIES,
      sharedStockSolver,
      combinationPolicy: 'same_line_fixed_axis_only',
      unitWeightAuthority: 'provider_or_order_specific',
      unitDimensionsAuthority:
        'order_specific_or_one_each_without_fit_claim',
      rotationAllowed: false,
      dimensionedLineCount: dimensionedLineIds.size,
      oneEachUndimensionedLineCount: oneEachUndimensionedLineIds.size,
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
