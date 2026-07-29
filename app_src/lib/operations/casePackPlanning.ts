export type CaseFulfillmentPolicy =
  | 'case_required'
  | 'prefer_full_case'
  | 'each_pick_only'

export type CaseRemainderPolicy = 'case_plus_each' | 'all_each' | 'block'

export type PackInventoryEvidence =
  | 'pack_level_verified'
  | 'each_only'
  | 'unknown'

export type CasePackPlanCode =
  | 'INTACT_CASE_INVENTORY_USED'
  | 'CASE_ASSEMBLED_FROM_EACH'
  | 'CASE_EQUIVALENT_ONLY'
  | 'INVENTORY_PACK_LEVEL_UNVERIFIED'
  | 'REMAINDER_EACH_PICK'
  | 'REMAINDER_POLICY_ALL_EACH'
  | 'CASE_PACK_MULTIPLE_REQUIRED'
  | 'CASE_PACK_MATERIAL_UNAVAILABLE'
  | 'CASE_PACK_INVENTORY_INSUFFICIENT'

export type CasePackPlanningInput = {
  orderedEachQuantity: number
  unitsPerCase: number
  fulfillmentPolicy: CaseFulfillmentPolicy
  remainderPolicy: CaseRemainderPolicy
  assemblyAllowed: boolean
  materialQuantityPerCase?: number
  inventory: {
    eachAvailableQuantity: number
    intactCaseAvailableQuantity: number | null
    evidence: PackInventoryEvidence
  }
  material: {
    optimizerReady: boolean
    availableQuantity: number | null
  }
}

export type CasePackPlanExplanation = {
  code: CasePackPlanCode
  quantity: number
  detail: string
}

export type CasePackPlanBlocker = {
  code: CasePackPlanCode
  detail: string
  action: string
}

export type CasePackPlan = {
  status: 'ready' | 'blocked'
  orderedEachQuantity: number
  unitsPerCase: number
  fullCaseEquivalentCount: number
  remainderEachQuantity: number
  intactCaseCount: number
  assembledCaseCount: number
  looseEachQuantity: number
  eachInventoryRequired: number
  packagingMaterialQuantityRequired: number
  explanations: CasePackPlanExplanation[]
  blockers: CasePackPlanBlocker[]
}

function requireNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function requirePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function blockedPlan(
  base: Omit<
    CasePackPlan,
    | 'status'
    | 'intactCaseCount'
    | 'assembledCaseCount'
    | 'looseEachQuantity'
    | 'eachInventoryRequired'
    | 'packagingMaterialQuantityRequired'
  >,
): CasePackPlan {
  return {
    ...base,
    status: 'blocked',
    intactCaseCount: 0,
    assembledCaseCount: 0,
    looseEachQuantity: 0,
    eachInventoryRequired: 0,
    packagingMaterialQuantityRequired: 0,
  }
}

/**
 * Produces a deterministic case-versus-each decision for one order line.
 *
 * Important inventory contract:
 * - `intactCaseAvailableQuantity` is used only with pack-level evidence.
 * - an arithmetic multiple of `unitsPerCase` is merely case-equivalent.
 * - assembling a case consumes each inventory and packaging material.
 * - intact cases consume separately evidenced case inventory.
 */
export function planCasePack(input: CasePackPlanningInput): CasePackPlan {
  requirePositiveInteger(input.orderedEachQuantity, 'Ordered each quantity')
  requirePositiveInteger(input.unitsPerCase, 'Units per case')
  requireNonNegativeInteger(
    input.inventory.eachAvailableQuantity,
    'Each inventory quantity',
  )

  if (input.inventory.intactCaseAvailableQuantity !== null) {
    requireNonNegativeInteger(
      input.inventory.intactCaseAvailableQuantity,
      'Intact case inventory quantity',
    )
  }
  if (input.material.availableQuantity !== null) {
    requireNonNegativeInteger(
      input.material.availableQuantity,
      'Packaging material quantity',
    )
  }

  const materialQuantityPerCase = input.materialQuantityPerCase ?? 1
  requirePositiveInteger(
    materialQuantityPerCase,
    'Packaging material quantity per case',
  )

  const fullCaseEquivalentCount = Math.floor(
    input.orderedEachQuantity / input.unitsPerCase,
  )
  const remainderEachQuantity =
    input.orderedEachQuantity % input.unitsPerCase
  const explanations: CasePackPlanExplanation[] = []
  const blockers: CasePackPlanBlocker[] = []
  const base = {
    orderedEachQuantity: input.orderedEachQuantity,
    unitsPerCase: input.unitsPerCase,
    fullCaseEquivalentCount,
    remainderEachQuantity,
    explanations,
    blockers,
  }

  if (
    remainderEachQuantity > 0
    && (
      input.fulfillmentPolicy === 'case_required'
      || input.remainderPolicy === 'block'
    )
  ) {
    blockers.push({
      code: 'CASE_PACK_MULTIPLE_REQUIRED',
      detail:
        `${input.orderedEachQuantity} eaches are not an exact multiple of `
        + `${input.unitsPerCase} eaches per case.`,
      action:
        'Change the ordered quantity to a full-case multiple or approve a '
        + 'remainder policy before release.',
    })
    return blockedPlan(base)
  }

  if (
    input.fulfillmentPolicy === 'each_pick_only'
    || (
      remainderEachQuantity > 0
      && input.remainderPolicy === 'all_each'
    )
  ) {
    if (input.inventory.eachAvailableQuantity < input.orderedEachQuantity) {
      blockers.push({
        code: 'CASE_PACK_INVENTORY_INSUFFICIENT',
        detail:
          `${input.orderedEachQuantity} eaches are required but only `
          + `${input.inventory.eachAvailableQuantity} are available.`,
        action: 'Replenish or reconcile each-level inventory before release.',
      })
      return blockedPlan(base)
    }
    if (fullCaseEquivalentCount > 0) {
      explanations.push({
        code:
          input.fulfillmentPolicy === 'each_pick_only'
            ? 'CASE_EQUIVALENT_ONLY'
            : 'REMAINDER_POLICY_ALL_EACH',
        quantity: input.orderedEachQuantity,
        detail:
          input.fulfillmentPolicy === 'each_pick_only'
            ? 'The quantity is case-equivalent, but policy requires loose each picking.'
            : 'A remainder is present, so policy routes the entire line to loose each picking.',
      })
    }
    return {
      ...base,
      status: 'ready',
      intactCaseCount: 0,
      assembledCaseCount: 0,
      looseEachQuantity: input.orderedEachQuantity,
      eachInventoryRequired: input.orderedEachQuantity,
      packagingMaterialQuantityRequired: 0,
    }
  }

  const hasVerifiedPackInventory =
    input.inventory.evidence === 'pack_level_verified'
  const intactCaseAvailableQuantity =
    hasVerifiedPackInventory
      ? input.inventory.intactCaseAvailableQuantity ?? 0
      : 0
  const intactCaseCount = Math.min(
    fullCaseEquivalentCount,
    intactCaseAvailableQuantity,
  )

  if (intactCaseCount > 0) {
    explanations.push({
      code: 'INTACT_CASE_INVENTORY_USED',
      quantity: intactCaseCount,
      detail: `${intactCaseCount} intact case(s) are supported by pack-level inventory evidence.`,
    })
  }
  if (
    fullCaseEquivalentCount > 0
    && !hasVerifiedPackInventory
  ) {
    explanations.push({
      code: 'INVENTORY_PACK_LEVEL_UNVERIFIED',
      quantity: fullCaseEquivalentCount,
      detail:
        'The source inventory is each-level or unknown, so ClawPilot does '
        + 'not assume intact cases exist.',
    })
  }

  const casesRemainingAfterIntact =
    fullCaseEquivalentCount - intactCaseCount
  const availableMaterialCases =
    input.assemblyAllowed
    && input.material.optimizerReady
    && input.material.availableQuantity !== null
      ? Math.floor(
        input.material.availableQuantity / materialQuantityPerCase,
      )
      : 0
  const availableEachAssemblyCases = Math.floor(
    input.inventory.eachAvailableQuantity / input.unitsPerCase,
  )
  const assembledCaseCount = input.assemblyAllowed
    ? Math.min(
      casesRemainingAfterIntact,
      availableMaterialCases,
      availableEachAssemblyCases,
    )
    : 0

  if (assembledCaseCount > 0) {
    explanations.push({
      code: 'CASE_ASSEMBLED_FROM_EACH',
      quantity: assembledCaseCount,
      detail:
        `${assembledCaseCount} case(s) will be assembled from each inventory `
        + 'using optimizer-ready packaging material.',
    })
  }

  const unfilledCaseEquivalentCount =
    casesRemainingAfterIntact - assembledCaseCount

  if (
    unfilledCaseEquivalentCount > 0
    && input.fulfillmentPolicy === 'case_required'
  ) {
    const eachNeededForUnfilledCases =
      unfilledCaseEquivalentCount * input.unitsPerCase
    const eachAfterAssembly =
      input.inventory.eachAvailableQuantity
      - assembledCaseCount * input.unitsPerCase
    const materialShort =
      input.assemblyAllowed
      && (
        !input.material.optimizerReady
        || input.material.availableQuantity === null
        || availableMaterialCases < casesRemainingAfterIntact
      )

    if (materialShort) {
      blockers.push({
        code: 'CASE_PACK_MATERIAL_UNAVAILABLE',
        detail:
          `${unfilledCaseEquivalentCount} required case(s) do not have `
          + 'optimizer-ready packaging material.',
        action:
          'Complete the material facts and replenish warehouse stock, or use '
          + 'verified intact-case inventory.',
      })
    }
    if (!input.assemblyAllowed || eachAfterAssembly < eachNeededForUnfilledCases) {
      blockers.push({
        code: 'CASE_PACK_INVENTORY_INSUFFICIENT',
        detail:
          `${unfilledCaseEquivalentCount} required case(s) cannot be satisfied `
          + 'from verified intact cases or authorized each-level assembly.',
        action:
          'Reconcile pack-level inventory or replenish each inventory before release.',
      })
    }
    return blockedPlan(base)
  }

  const looseEachQuantity =
    remainderEachQuantity
    + unfilledCaseEquivalentCount * input.unitsPerCase
  const eachInventoryRequired =
    assembledCaseCount * input.unitsPerCase + looseEachQuantity

  if (unfilledCaseEquivalentCount > 0) {
    explanations.push({
      code: 'CASE_EQUIVALENT_ONLY',
      quantity: unfilledCaseEquivalentCount,
      detail:
        `${unfilledCaseEquivalentCount} arithmetic case equivalent(s) lack `
        + 'intact-case or assembly evidence and will be picked as loose eaches.',
    })
  }
  if (remainderEachQuantity > 0) {
    explanations.push({
      code: 'REMAINDER_EACH_PICK',
      quantity: remainderEachQuantity,
      detail:
        `${remainderEachQuantity} remainder each(es) will be picked outside `
        + 'the full case quantity.',
    })
  }

  if (eachInventoryRequired > input.inventory.eachAvailableQuantity) {
    blockers.push({
      code: 'CASE_PACK_INVENTORY_INSUFFICIENT',
      detail:
        `${eachInventoryRequired} eaches are required for assembly and loose `
        + `picking, but only ${input.inventory.eachAvailableQuantity} are available.`,
      action: 'Replenish or reconcile each-level inventory before release.',
    })
    return blockedPlan(base)
  }

  return {
    ...base,
    status: 'ready',
    intactCaseCount,
    assembledCaseCount,
    looseEachQuantity,
    eachInventoryRequired,
    packagingMaterialQuantityRequired:
      assembledCaseCount * materialQuantityPerCase,
  }
}
