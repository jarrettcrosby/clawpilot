import { createHash } from 'node:crypto'
import type {
  OperationalGeometryRatePlan,
} from '@/lib/operations/operationalGeometryCartonization'
import type {
  OperationalUnitMaterialPlan,
} from '@/lib/operations/operationalUnitMaterialCartonization'

export const OPERATIONAL_MIXED_MATERIAL_POLICY_VERSION =
  'operational-mixed-material-conflict-backtracking-v1' as const

export const OPERATIONAL_MIXED_MATERIAL_MAX_BACKTRACK_STATES = 32

export type OperationalMaterialUsage = {
  materialGlobalId: string
  quantity: number
}

export type OperationalMaterialCapacity = {
  materialGlobalId: string
  quantity: number
}

type PackageMaterial = {
  packagingMaterialGlobalId: string
}

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

function canonicalHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function canonicalUsage(
  input: Iterable<readonly [string, number]>,
): OperationalMaterialUsage[] {
  return [...input]
    .filter(([, quantity]) => quantity > 0)
    .map(([materialGlobalId, quantity]) => ({
      materialGlobalId,
      quantity,
    }))
    .sort((left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ))
}

export function operationalPackageMaterialUsage(
  packages: readonly PackageMaterial[],
): OperationalMaterialUsage[] {
  const usage = new Map<string, number>()
  for (const packagePlan of packages) {
    const materialGlobalId = packagePlan.packagingMaterialGlobalId
    if (!materialGlobalId) {
      throw new Error('Operational package material lineage is missing')
    }
    const next = (usage.get(materialGlobalId) || 0) + 1
    if (!Number.isSafeInteger(next)) {
      throw new Error('Operational package material usage is not integer-safe')
    }
    usage.set(materialGlobalId, next)
  }
  return canonicalUsage(usage)
}

function combinedUsage(
  left: OperationalMaterialUsage[],
  right: OperationalMaterialUsage[],
) {
  const combined = new Map<string, number>()
  for (const usage of [...left, ...right]) {
    combined.set(
      usage.materialGlobalId,
      (combined.get(usage.materialGlobalId) || 0) + usage.quantity,
    )
  }
  return canonicalUsage(combined)
}

function usageSignature(usage: OperationalMaterialUsage[]) {
  return usage.map((item) => (
    `${item.materialGlobalId}:${item.quantity}`
  )).join('|')
}

export type OperationalMixedMaterialEvidence = {
  policyVersion: typeof OPERATIONAL_MIXED_MATERIAL_POLICY_VERSION
  solver:
    | 'ordinary_first'
    | 'bounded_geometry_material_conflict_backtracking'
  backtrackStateLimit:
    typeof OPERATIONAL_MIXED_MATERIAL_MAX_BACKTRACK_STATES
  backtrackStatesEvaluated: number
  geometryPlansEvaluated: number
  ordinaryReservationMaterialUsage: OperationalMaterialUsage[]
  unitMaterialUsage: OperationalMaterialUsage[]
  geometryMaterialUsage: OperationalMaterialUsage[]
  combinedMaterialUsage: OperationalMaterialUsage[]
  materialCapacities: OperationalMaterialCapacity[]
  decisionHash: string
}

export type OperationalMixedMaterialPlan =
  | {
      status: 'blocked'
      blocker: { code: string; detail: string }
    }
  | {
      status: 'ready'
      unitPlan: Extract<OperationalUnitMaterialPlan, { status: 'ready' }>
      geometryPlan: Extract<OperationalGeometryRatePlan, { status: 'ready' }>
      evidence: OperationalMixedMaterialEvidence
    }

type PlanUnit = (input: {
  reservedMaterialUsage: OperationalMaterialUsage[]
  maximumPackages: number
}) => OperationalUnitMaterialPlan

type PlanGeometry = (input: {
  reservedMaterialUsage: OperationalMaterialUsage[]
  maximumPackages: number
  precedingUnitPackageCount: number
  optimizerDeadlineMs?: number
}) => Promise<OperationalGeometryRatePlan>

function searchDeadlineBlocker(): OperationalMixedMaterialPlan {
  return {
    status: 'blocked',
    blocker: {
      code:
        'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_SEARCH_DEADLINE_EXCEEDED',
      detail: 'No shared-stock plan was proven within the bounded operational geometry-search deadline.',
    },
  }
}

function readyEvidence(input: {
  solver: OperationalMixedMaterialEvidence['solver']
  backtrackStatesEvaluated: number
  geometryPlansEvaluated: number
  ordinaryReservationMaterialUsage: OperationalMaterialUsage[]
  unitPlan: Extract<OperationalUnitMaterialPlan, { status: 'ready' }>
  geometryPlan: Extract<OperationalGeometryRatePlan, { status: 'ready' }>
  materialCapacities: OperationalMaterialCapacity[]
}): OperationalMixedMaterialPlan {
  const unitMaterialUsage = operationalPackageMaterialUsage(
    input.unitPlan.packages,
  )
  const geometryMaterialUsage = operationalPackageMaterialUsage(
    input.geometryPlan.packages,
  )
  const combinedMaterialUsage = combinedUsage(
    unitMaterialUsage,
    geometryMaterialUsage,
  )
  const capacityById = new Map(input.materialCapacities.map((capacity) => (
    [capacity.materialGlobalId, capacity.quantity]
  )))
  if (combinedMaterialUsage.some((usage) => (
    usage.quantity > Number(capacityById.get(usage.materialGlobalId) ?? -1)
  ))) {
    return {
      status: 'blocked',
      blocker: {
        code: 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_STOCK_INVALID',
        detail: 'The reconciled ordinary and rigid package plans exceed shared factual material stock.',
      },
    }
  }
  const withoutHash: Omit<
    OperationalMixedMaterialEvidence,
    'decisionHash'
  > = {
    policyVersion: OPERATIONAL_MIXED_MATERIAL_POLICY_VERSION,
    solver: input.solver,
    backtrackStateLimit:
      OPERATIONAL_MIXED_MATERIAL_MAX_BACKTRACK_STATES,
    backtrackStatesEvaluated: input.backtrackStatesEvaluated,
    geometryPlansEvaluated: input.geometryPlansEvaluated,
    ordinaryReservationMaterialUsage:
      input.ordinaryReservationMaterialUsage,
    unitMaterialUsage,
    geometryMaterialUsage,
    combinedMaterialUsage,
    materialCapacities: input.materialCapacities,
  }
  return {
    status: 'ready',
    unitPlan: input.unitPlan,
    geometryPlan: input.geometryPlan,
    evidence: {
      ...withoutHash,
      decisionHash: canonicalHash(withoutHash),
    },
  }
}

/**
 * Reconciles ordinary-unit and rigid-geometry cartons against one stock pool.
 * The preferred ordinary-unit plan remains authoritative when it leaves a
 * feasible geometry plan. On conflict, a bounded deterministic search probes
 * geometry allocations, reserves each exact probe for ordinary planning, and
 * branches by lowering one used material's absolute carton cap. Every branch
 * excludes the conflicting geometry usage vector without inventing stock.
 */
export async function reconcileOperationalMixedMaterialPlans(input: {
  maximumPackages: number
  materialCapacities: OperationalMaterialCapacity[]
  geometrySearchDeadlineAtMs?: number
  planUnit: PlanUnit
  planGeometry: PlanGeometry
}): Promise<OperationalMixedMaterialPlan> {
  if (
    !positiveInteger(input.maximumPackages)
    || (
      input.geometrySearchDeadlineAtMs !== undefined
      && !positiveInteger(input.geometrySearchDeadlineAtMs)
    )
  ) {
    return {
      status: 'blocked',
      blocker: {
        code: 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_INPUT_INVALID',
        detail: 'Mixed cartonization requires one positive residual package bound.',
      },
    }
  }
  const materialCapacities = [...input.materialCapacities].sort(
    (left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ),
  )
  const capacityById = new Map<string, number>()
  for (const capacity of materialCapacities) {
    if (
      !capacity.materialGlobalId
      || capacityById.has(capacity.materialGlobalId)
      || !nonnegativeInteger(capacity.quantity)
    ) {
      return {
        status: 'blocked',
        blocker: {
          code: 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_INPUT_INVALID',
          detail: 'Mixed cartonization requires unique integer-safe factual material capacities.',
        },
      }
    }
    capacityById.set(capacity.materialGlobalId, capacity.quantity)
  }
  if (capacityById.size < 1) {
    return {
      status: 'blocked',
      blocker: {
        code: 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_STOCK_REQUIRED',
        detail: 'Mixed cartonization requires selected factual material stock.',
      },
    }
  }

  let geometryPlansEvaluated = 0
  const evaluateGeometry = async (geometryInput: Omit<
    Parameters<PlanGeometry>[0],
    'optimizerDeadlineMs'
  >) => {
    let optimizerDeadlineMs: number | undefined
    if (input.geometrySearchDeadlineAtMs !== undefined) {
      const remainingMs = Math.floor(
        input.geometrySearchDeadlineAtMs - Date.now(),
      )
      if (remainingMs < 50) return null
      optimizerDeadlineMs = Math.min(10_000, remainingMs)
    }
    geometryPlansEvaluated += 1
    return input.planGeometry({
      ...geometryInput,
      ...(optimizerDeadlineMs === undefined
        ? {}
        : { optimizerDeadlineMs }),
    })
  }
  const unitFirst = input.planUnit({
    reservedMaterialUsage: [],
    maximumPackages: input.maximumPackages,
  })
  if (unitFirst.status === 'blocked') return unitFirst
  const unitFirstUsage = operationalPackageMaterialUsage(unitFirst.packages)
  const unitFirstGeometryLimit = input.maximumPackages
    - unitFirst.packages.length
  if (unitFirstGeometryLimit > 0) {
    const geometryAfterUnit = await evaluateGeometry({
      reservedMaterialUsage: unitFirstUsage,
      maximumPackages: unitFirstGeometryLimit,
      precedingUnitPackageCount: unitFirst.packages.length,
    })
    if (geometryAfterUnit === null) return searchDeadlineBlocker()
    if (geometryAfterUnit.status === 'ready') {
      return readyEvidence({
        solver: 'ordinary_first',
        backtrackStatesEvaluated: 0,
        geometryPlansEvaluated,
        ordinaryReservationMaterialUsage: [],
        unitPlan: unitFirst,
        geometryPlan: geometryAfterUnit,
        materialCapacities,
      })
    }
  }

  const queue: OperationalMaterialUsage[][] = [[]]
  const seen = new Set([''])
  let backtrackStatesEvaluated = 0
  let sawGeometryPlan = false
  while (
    queue.length > 0
    && backtrackStatesEvaluated
      < OPERATIONAL_MIXED_MATERIAL_MAX_BACKTRACK_STATES
  ) {
    const state = queue.shift() as OperationalMaterialUsage[]
    backtrackStatesEvaluated += 1
    const geometryProbe = await evaluateGeometry({
      reservedMaterialUsage: state,
      maximumPackages: input.maximumPackages,
      precedingUnitPackageCount: 0,
    })
    if (geometryProbe === null) return searchDeadlineBlocker()
    if (geometryProbe.status === 'blocked') {
      // The empty state is the unreserved geometry problem. If that cannot be
      // planned, tighter material caps cannot recover it and the exact root
      // blocker (configuration, profile, inventory, optimizer, or stock) must
      // remain visible to the operator.
      if (state.length === 0) return geometryProbe
      continue
    }
    sawGeometryPlan = true
    const geometryReservation = operationalPackageMaterialUsage(
      geometryProbe.packages,
    )
    const unitLimit = input.maximumPackages - geometryProbe.packages.length
    if (unitLimit > 0) {
      const unitCandidate = input.planUnit({
        reservedMaterialUsage: geometryReservation,
        maximumPackages: unitLimit,
      })
      if (unitCandidate.status === 'ready') {
        const unitUsage = operationalPackageMaterialUsage(
          unitCandidate.packages,
        )
        const finalGeometryLimit = input.maximumPackages
          - unitCandidate.packages.length
        if (finalGeometryLimit > 0) {
          const finalGeometry = await evaluateGeometry({
            reservedMaterialUsage: unitUsage,
            maximumPackages: finalGeometryLimit,
            precedingUnitPackageCount: unitCandidate.packages.length,
          })
          if (finalGeometry === null) return searchDeadlineBlocker()
          if (finalGeometry.status === 'ready') {
            return readyEvidence({
              solver:
                'bounded_geometry_material_conflict_backtracking',
              backtrackStatesEvaluated,
              geometryPlansEvaluated,
              ordinaryReservationMaterialUsage: geometryReservation,
              unitPlan: unitCandidate,
              geometryPlan: finalGeometry,
              materialCapacities,
            })
          }
        }
      }
    }

    const stateById = new Map(state.map((usage) => (
      [usage.materialGlobalId, usage.quantity]
    )))
    for (const usage of geometryReservation) {
      const capacity = capacityById.get(usage.materialGlobalId)
      if (capacity === undefined || usage.quantity < 1) continue
      const requiredReservation = capacity - (usage.quantity - 1)
      if (requiredReservation <= (stateById.get(usage.materialGlobalId) || 0)) {
        continue
      }
      const next = new Map(stateById)
      next.set(usage.materialGlobalId, requiredReservation)
      const canonical = canonicalUsage(next)
      const signature = usageSignature(canonical)
      if (!seen.has(signature)) {
        seen.add(signature)
        queue.push(canonical)
      }
    }
  }

  const searchBoundExceeded = queue.length > 0
  return {
    status: 'blocked',
    blocker: {
      code: searchBoundExceeded
        ? 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_SEARCH_BOUND_EXCEEDED'
        : 'CARTONIZATION_RATE_EVIDENCE_MIXED_MATERIAL_STOCK_REQUIRED',
      detail: searchBoundExceeded
        ? `No shared-stock plan was proven within the deterministic ${
            OPERATIONAL_MIXED_MATERIAL_MAX_BACKTRACK_STATES
          }-state cartonization bound.`
        : sawGeometryPlan
          ? 'No jointly feasible ordinary-unit and rigid-geometry carton allocation remains in selected factual stock.'
          : 'No rigid-geometry carton allocation remains in selected factual stock.',
    },
  }
}
