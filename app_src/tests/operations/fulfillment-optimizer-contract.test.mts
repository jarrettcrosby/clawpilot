import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types test runner requires the .ts extension.
import * as contract from '../../lib/operations/fulfillmentOptimizerContract.ts'

const {
  ASSORTMENT_OBJECTIVE_SEQUENCE,
  FULFILLMENT_OBJECTIVE_SEQUENCE,
  OptimizerContractError,
  canonicalOptimizerHash,
  parseFulfillmentOptimizationResult,
  parsePackagingAssortmentResult,
  validateFulfillmentOptimizationInput,
  validateFulfillmentOptimizationOptions,
  validatePackagingAssortmentInput,
} = contract

function fulfillmentInput() {
  return {
    schemaVersion: 1 as const,
    inputSnapshotGlobalId: 'gosi0000001',
    organizationGlobalId: 'gorg0000001',
    orderGlobalId: 'gord0000001',
    orderRevision: 1,
    evaluatedAtUtc: '2026-07-27T16:00:00Z',
    currency: 'USD',
    lines: [{
      lineGlobalId: 'goln0000001',
      productGlobalId: 'gprd0000001',
      quantity: 1,
      unitWeightGrams: 500,
      unitDimensionsMm: { length: 40, width: 80, height: 30 },
      rotationAllowed: true,
      allowedWarehouseGlobalIds: ['gwhs0000001'],
      allowedCartonGlobalIds: ['gctn0000001'],
    }],
    eligiblePositions: [{
      positionGlobalId: 'gpos0000001',
      warehouseGlobalId: 'gwhs0000001',
      productGlobalId: 'gprd0000001',
      availableQuantity: 1,
      unitHandlingCostMinor: 10,
    }],
    warehouses: [{
      warehouseGlobalId: 'gwhs0000001',
      active: true,
      handlingCostMinor: 100,
    }],
    cartons: [{
      cartonGlobalId: 'gctn0000001',
      warehouseGlobalId: 'gwhs0000001',
      materialType: 'box' as const,
      innerDimensionsMm: { length: 100, width: 100, height: 80 },
      maxWeightGrams: 5_000,
      emptyWeightGrams: 100,
      availableQuantity: 1,
      materialCostMinor: 25,
      estimatedTransportCostMinor: 700,
    }],
    constraints: {
      schemaVersion: 1 as const,
      maxPackages: 1,
      maxPackageWeightGrams: 5_000,
      allowedWarehouseGlobalIds: ['gwhs0000001'],
      allowedCartonGlobalIds: ['gctn0000001'],
    },
    objectivePolicy: {
      schemaVersion: 1 as const,
      policyGlobalId: 'gopt0000001',
      sequence: FULFILLMENT_OBJECTIVE_SEQUENCE,
    },
    splitPolicy: { allowed: false, maxWarehouses: 1 },
  }
}

function validPlan() {
  return {
    planId: 'plan-0123456789abcdef',
    warehouseGlobalIds: ['gwhs0000001'],
    warehouseCount: 1,
    shipmentCount: 1,
    cartonCount: 1,
    estimatedTotalCostMinor: 835,
    unusedVolumeMm3: 704_000,
    packages: [{
      packageKey: 'gctn0000001#0001',
      warehouseGlobalId: 'gwhs0000001',
      cartonGlobalId: 'gctn0000001',
      innerDimensionsMm: { length: 100, width: 100, height: 80 },
      maxWeightGrams: 5_000,
      emptyWeightGrams: 100,
      totalWeightGrams: 600,
      usedVolumeMm3: 96_000,
      unusedVolumeMm3: 704_000,
      estimatedCostMinor: 735,
      allocations: [{
        lineGlobalId: 'goln0000001',
        productGlobalId: 'gprd0000001',
        positionGlobalId: 'gpos0000001',
        quantity: 1,
      }],
      placements: [{
        unitKey: 'goln0000001#000001',
        lineGlobalId: 'goln0000001',
        productGlobalId: 'gprd0000001',
        positionGlobalId: 'gpos0000001',
        dimensionsMm: { length: 80, width: 40, height: 30 },
        coordinatesMm: { x: 0, y: 0, z: 0 },
      }],
    }],
  }
}

test('canonical optimizer hash is key-order independent and response references balance exactly', () => {
  const input = fulfillmentInput()
  const options = { deadlineMs: 5_000, maxCandidates: 2 }
  validateFulfillmentOptimizationInput(input)
  validateFulfillmentOptimizationOptions(options)
  assert.equal(
    canonicalOptimizerHash({ z: 1, a: { y: 2, x: 3 } }),
    canonicalOptimizerHash({ a: { x: 3, y: 2 }, z: 1 }),
  )

  const inputHash = canonicalOptimizerHash(input)
  const plan = validPlan()
  const result = parseFulfillmentOptimizationResult({
    schemaVersion: 1,
    status: 'optimal',
    method: 'or_tools',
    algorithmVersion: 'clawpilot-fulfillment-cpsat-3d-v1+ortools-9.15.6755',
    inputHash,
    durationMs: 20,
    selectedPlan: plan,
    candidates: [plan],
    rejectedAlternatives: [],
    fallbackReason: null,
    explanation: [],
  }, input, options, inputHash, 'or_tools')

  assert.equal(result.selectedPlan?.packages[0].totalWeightGrams, 600)
  assert.equal(result.selectedPlan?.estimatedTotalCostMinor, 835)
})

test('returned quantity, references, and hash fail closed', () => {
  const input = fulfillmentInput()
  const options = { deadlineMs: 5_000, maxCandidates: 2 }
  const inputHash = canonicalOptimizerHash(input)
  const plan = validPlan()
  const invalid = structuredClone(plan)
  invalid.packages[0].allocations[0].quantity = 2

  assert.throws(() => parseFulfillmentOptimizationResult({
    schemaVersion: 1,
    status: 'optimal',
    method: 'or_tools',
    algorithmVersion: 'test',
    inputHash,
    durationMs: 1,
    selectedPlan: invalid,
    candidates: [invalid],
    rejectedAlternatives: [],
    fallbackReason: null,
    explanation: [],
  }, input, options, inputHash, 'or_tools'), OptimizerContractError)

  assert.throws(() => parseFulfillmentOptimizationResult({
    schemaVersion: 1,
    status: 'optimal',
    method: 'or_tools',
    algorithmVersion: 'test',
    inputHash: '0'.repeat(64),
    durationMs: 1,
    selectedPlan: plan,
    candidates: [plan],
    rejectedAlternatives: [],
    fallbackReason: null,
    explanation: [],
  }, input, options, inputHash, 'or_tools'), OptimizerContractError)
})

test('packaging assortment accepts only supplied demand, materials, and landed costs', () => {
  const input = {
    schemaVersion: 1 as const,
    inputSnapshotGlobalId: 'gasi0000001',
    organizationGlobalId: 'gorg0000001',
    evaluatedAtUtc: '2026-07-27T16:00:00Z',
    currency: 'USD',
    materials: [
      {
        materialGlobalId: 'gmat0000001',
        materialType: 'poly_mailer' as const,
        innerDimensionsMm: { length: 200, width: 150, height: 20 },
        maxWeightGrams: 1_000,
        materialCostMinor: 10,
      },
      {
        materialGlobalId: 'gmat0000002',
        materialType: 'box' as const,
        innerDimensionsMm: { length: 300, width: 200, height: 100 },
        maxWeightGrams: 5_000,
        materialCostMinor: 25,
      },
    ],
    demandSamples: [
      {
        sampleGlobalId: 'gdem0000001',
        frequency: 10,
        packedWeightGrams: 500,
        packedVolumeMm3: 300_000,
      },
      {
        sampleGlobalId: 'gdem0000002',
        frequency: 5,
        packedWeightGrams: 2_000,
        packedVolumeMm3: 3_000_000,
      },
    ],
    feasibleLandedCosts: [
      {
        sampleGlobalId: 'gdem0000001',
        materialGlobalId: 'gmat0000001',
        landedCostMinor: 500,
        wasteVolumeMm3: 300_000,
      },
      {
        sampleGlobalId: 'gdem0000001',
        materialGlobalId: 'gmat0000002',
        landedCostMinor: 500,
        wasteVolumeMm3: 5_700_000,
      },
      {
        sampleGlobalId: 'gdem0000002',
        materialGlobalId: 'gmat0000002',
        landedCostMinor: 800,
        wasteVolumeMm3: 3_000_000,
      },
    ],
    policy: {
      schemaVersion: 1 as const,
      policyGlobalId: 'gasp0000001',
      maxAssortmentSize: 2,
      hardCoverAll: true,
      minimumCoverageBasisPoints: 10_000,
    },
    objectivePolicy: {
      schemaVersion: 1 as const,
      policyGlobalId: 'gaop0000001',
      sequence: ASSORTMENT_OBJECTIVE_SEQUENCE,
    },
  }
  validatePackagingAssortmentInput(input)
  const inputHash = canonicalOptimizerHash(input)
  const result = parsePackagingAssortmentResult({
    schemaVersion: 1,
    status: 'optimal',
    method: 'or_tools',
    algorithmVersion: 'clawpilot-material-assortment-cpsat-v1+ortools-9.15.6755',
    inputHash,
    durationMs: 4,
    selectedAssortment: {
      selectedMaterialGlobalIds: ['gmat0000002'],
      assignments: [
        {
          sampleGlobalId: 'gdem0000001',
          materialGlobalId: 'gmat0000002',
          frequency: 10,
          landedCostMinor: 500,
          wasteVolumeMm3: 5_700_000,
        },
        {
          sampleGlobalId: 'gdem0000002',
          materialGlobalId: 'gmat0000002',
          frequency: 5,
          landedCostMinor: 800,
          wasteVolumeMm3: 3_000_000,
        },
      ],
      uncoveredSampleGlobalIds: [],
      coveredFrequency: 15,
      totalFrequency: 15,
      coverageBasisPoints: 10_000,
      weightedLandedCostMinor: 9_000,
      weightedWasteVolumeMm3: 72_000_000,
    },
    fallbackReason: null,
    explanation: [],
  }, input, inputHash)

  assert.deepEqual(result.selectedAssortment?.selectedMaterialGlobalIds, ['gmat0000002'])
})
