import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as casePackPlanning from '../../lib/operations/casePackPlanning.ts'
import type {
  CasePackPlanningInput,
} from '../../lib/operations/casePackPlanning.ts'

const { planCasePack } = casePackPlanning

function planningInput(
  orderedEachQuantity: number,
  unitsPerCase: number,
  overrides: Partial<CasePackPlanningInput> = {},
): CasePackPlanningInput {
  return {
    orderedEachQuantity,
    unitsPerCase,
    fulfillmentPolicy: 'prefer_full_case',
    remainderPolicy: 'case_plus_each',
    assemblyAllowed: false,
    inventory: {
      eachAvailableQuantity: orderedEachQuantity,
      intactCaseAvailableQuantity: null,
      evidence: 'each_only',
    },
    material: {
      optimizerReady: false,
      availableQuantity: null,
    },
    ...overrides,
  }
}

test('6 oz case packs use exact floor arithmetic for 12 and 24 eaches', () => {
  const oneCase = planCasePack(planningInput(12, 12, {
    inventory: {
      eachAvailableQuantity: 0,
      intactCaseAvailableQuantity: 1,
      evidence: 'pack_level_verified',
    },
  }))
  assert.equal(oneCase.status, 'ready')
  assert.equal(oneCase.fullCaseEquivalentCount, 1)
  assert.equal(oneCase.intactCaseCount, 1)
  assert.equal(oneCase.looseEachQuantity, 0)

  const twoCases = planCasePack(planningInput(24, 12, {
    inventory: {
      eachAvailableQuantity: 0,
      intactCaseAvailableQuantity: 2,
      evidence: 'pack_level_verified',
    },
  }))
  assert.equal(twoCases.status, 'ready')
  assert.equal(twoCases.fullCaseEquivalentCount, 2)
  assert.equal(twoCases.intactCaseCount, 2)
  assert.equal(twoCases.looseEachQuantity, 0)
})

test('13 6 oz bags use one evidenced case plus one remainder each', () => {
  const plan = planCasePack(planningInput(13, 12, {
    inventory: {
      eachAvailableQuantity: 1,
      intactCaseAvailableQuantity: 1,
      evidence: 'pack_level_verified',
    },
  }))

  assert.equal(plan.status, 'ready')
  assert.equal(plan.intactCaseCount, 1)
  assert.equal(plan.remainderEachQuantity, 1)
  assert.equal(plan.looseEachQuantity, 1)
  assert.equal(plan.eachInventoryRequired, 1)
  assert.ok(
    plan.explanations.some(({ code }) => code === 'REMAINDER_EACH_PICK'),
  )
})

test('2 oz case packs use 36 and 72 exact each quantities', () => {
  const oneCase = planCasePack(planningInput(36, 36, {
    inventory: {
      eachAvailableQuantity: 0,
      intactCaseAvailableQuantity: 1,
      evidence: 'pack_level_verified',
    },
  }))
  const twoCases = planCasePack(planningInput(72, 36, {
    inventory: {
      eachAvailableQuantity: 0,
      intactCaseAvailableQuantity: 2,
      evidence: 'pack_level_verified',
    },
  }))

  assert.equal(oneCase.intactCaseCount, 1)
  assert.equal(oneCase.remainderEachQuantity, 0)
  assert.equal(twoCases.intactCaseCount, 2)
  assert.equal(twoCases.remainderEachQuantity, 0)
})

test('case-required policy blocks a non-multiple before allocating inventory', () => {
  const plan = planCasePack(planningInput(13, 12, {
    fulfillmentPolicy: 'case_required',
    inventory: {
      eachAvailableQuantity: 1,
      intactCaseAvailableQuantity: 1,
      evidence: 'pack_level_verified',
    },
  }))

  assert.equal(plan.status, 'blocked')
  assert.equal(plan.intactCaseCount, 0)
  assert.equal(plan.looseEachQuantity, 0)
  assert.deepEqual(
    plan.blockers.map(({ code }) => code),
    ['CASE_PACK_MULTIPLE_REQUIRED'],
  )
})

test('case-equivalent quantity remains loose without intact or assembly evidence', () => {
  const plan = planCasePack(planningInput(12, 12))

  assert.equal(plan.status, 'ready')
  assert.equal(plan.fullCaseEquivalentCount, 1)
  assert.equal(plan.intactCaseCount, 0)
  assert.equal(plan.assembledCaseCount, 0)
  assert.equal(plan.looseEachQuantity, 12)
  assert.ok(
    plan.explanations.some(({ code }) => code === 'CASE_EQUIVALENT_ONLY'),
  )
  assert.ok(
    plan.explanations.some(
      ({ code }) => code === 'INVENTORY_PACK_LEVEL_UNVERIFIED',
    ),
  )
})

test('case-required assembly blocks when packaging material is unavailable', () => {
  const plan = planCasePack(planningInput(12, 12, {
    fulfillmentPolicy: 'case_required',
    assemblyAllowed: true,
    inventory: {
      eachAvailableQuantity: 12,
      intactCaseAvailableQuantity: null,
      evidence: 'each_only',
    },
    material: {
      optimizerReady: true,
      availableQuantity: 0,
    },
  }))

  assert.equal(plan.status, 'blocked')
  assert.equal(plan.assembledCaseCount, 0)
  assert.deepEqual(
    plan.blockers.map(({ code }) => code),
    ['CASE_PACK_MATERIAL_UNAVAILABLE'],
  )
})

test('an under-case quantity never rounds up to a case', () => {
  const plan = planCasePack(planningInput(1, 12, {
    inventory: {
      eachAvailableQuantity: 1,
      intactCaseAvailableQuantity: 99,
      evidence: 'pack_level_verified',
    },
  }))

  assert.equal(plan.status, 'ready')
  assert.equal(plan.fullCaseEquivalentCount, 0)
  assert.equal(plan.intactCaseCount, 0)
  assert.equal(plan.assembledCaseCount, 0)
  assert.equal(plan.looseEachQuantity, 1)
})

test('authorized assembly consumes exact each and material quantities', () => {
  const plan = planCasePack(planningInput(24, 12, {
    assemblyAllowed: true,
    materialQuantityPerCase: 1,
    inventory: {
      eachAvailableQuantity: 24,
      intactCaseAvailableQuantity: null,
      evidence: 'each_only',
    },
    material: {
      optimizerReady: true,
      availableQuantity: 2,
    },
  }))

  assert.equal(plan.status, 'ready')
  assert.equal(plan.assembledCaseCount, 2)
  assert.equal(plan.eachInventoryRequired, 24)
  assert.equal(plan.packagingMaterialQuantityRequired, 2)
  assert.equal(plan.looseEachQuantity, 0)
})
