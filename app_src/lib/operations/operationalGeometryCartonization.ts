import {
  canonicalOptimizerHash,
  FULFILLMENT_OBJECTIVE_SEQUENCE,
  validateFulfillmentOptimizationInput,
  type FulfillmentOptimizationInputV1,
  type FulfillmentOptimizationResultV1,
  type FulfillmentOptimizerV1,
  type OptimizerDimensionsMm,
} from '@/lib/operations/fulfillmentOptimizerContract'
import type {
  HybridCartonizationLine,
  HybridCartonizationMaterial,
  HybridCartonizationResult,
  HybridRecipePackage,
} from '@/lib/operations/hybridCartonization'

export const OPERATIONAL_GEOMETRY_POLICY_VERSION =
  'operational-rigid-3d-or-tools-v1' as const

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

export type OperationalGeometryPackage = {
  packageKey: string
  packageSequence: number
  planningMethod: 'or_tools'
  packagingMaterialGlobalId: string
  materialRowVersion: number
  recipes: []
  innerDimensionsMm: OptimizerDimensionsMm
  ratedOuterDimensionsMm: OptimizerDimensionsMm
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
  orToolsProfiles: Array<{
    lineGlobalId: string
    productGlobalId: string
    inputProfileVersionGlobalId: string
    inputProfileVersionRowVersion: number
    fitModel: 'rigid_3d'
    unitDimensionsMm: OptimizerDimensionsMm
    unitWeightGrams: number
    quantity: number
  }>
}

export type OperationalGeometryRatePlan =
  | {
      status: 'blocked'
      blocker: {
        code: string
        detail: string
      }
    }
  | {
      status: 'ready'
      policyVersion: typeof OPERATIONAL_GEOMETRY_POLICY_VERSION
      optimizerInput: FulfillmentOptimizationInputV1
      optimizerResult: FulfillmentOptimizationResultV1
      packages: OperationalGeometryPackage[]
      evidence: {
        policyVersion: typeof OPERATIONAL_GEOMETRY_POLICY_VERSION
        optimizerMethod: 'or_tools'
        optimizerInputHash: string
        optimizerAlgorithmVersion: string
        selectedPlanId: string
        transformationHash: string
        rotationAllowed: false
        transportCostBasis: 'excluded_before_carrier_read'
        warehouseHandlingCostBasis: 'excluded_from_pack_feasibility'
        inventoryHandlingCostBasis: 'excluded_from_pack_feasibility'
        profileAuthority: 'current_active_outer_pack_profile'
        materialAuthority:
          'current_active_material_and_unclaimed_warehouse_stock'
        inventoryAuthority:
          'shopify_provider_commitment_less_active_reservations'
      }
    }

function blocked(code: string, detail: string): OperationalGeometryRatePlan {
  return { status: 'blocked', blocker: { code, detail } }
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function exactDimensions(
  value: OptimizerDimensionsMm | null | undefined,
): value is OptimizerDimensionsMm {
  return Boolean(
    value
    && positiveInteger(value.length)
    && positiveInteger(value.width)
    && positiveInteger(value.height),
  )
}

function materialFamily(
  value: HybridCartonizationMaterial['materialType'],
): 'box' | 'poly_mailer' | null {
  if (value === 'carton') return 'box'
  if (value === 'poly_mailer' || value === 'padded_mailer') {
    return 'poly_mailer'
  }
  return null
}

function recipeMaterialUsage(
  packages: HybridRecipePackage[],
): Map<string, number> {
  const result = new Map<string, number>()
  for (const packagePlan of packages) {
    result.set(
      packagePlan.packagingMaterialGlobalId,
      (result.get(packagePlan.packagingMaterialGlobalId) || 0) + 1,
    )
  }
  return result
}

function recipeProductUsage(
  packages: HybridRecipePackage[],
): Map<string, number> {
  const result = new Map<string, number>()
  for (const packagePlan of packages) {
    for (const allocation of packagePlan.lineAllocations) {
      result.set(
        allocation.productGlobalId,
        (result.get(allocation.productGlobalId) || 0)
          + allocation.quantity,
      )
    }
  }
  return result
}

export async function planOperationalGeometryRatePackages(input: {
  organizationGlobalId: string
  provider: 'shopify' | 'faire'
  candidateGlobalId: string
  candidateRowVersion: number
  currency: string
  readAt: string
  warehouseGlobalId: string
  lines: HybridCartonizationLine[]
  fallbackLines: HybridCartonizationResult['geometryFallbackLines']
  recipePackages: HybridRecipePackage[]
  preplannedMaterialUsage: Array<{
    materialGlobalId: string
    quantity: number
  }>
  materials: HybridCartonizationMaterial[]
  inventoryProducts: InventoryProductEvidence[]
  availabilityMode?: 'operational' | 'shadow_training_simulated'
  startingSequence: number
  maximumPackages: number
  optimizer: FulfillmentOptimizerV1 | null
  options?: {
    deadlineMs?: number
    maxCandidates?: number
  }
}): Promise<OperationalGeometryRatePlan> {
  const shadowTraining =
    input.availabilityMode === 'shadow_training_simulated'
  if (input.provider !== 'shopify' && !shadowTraining) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_GEOMETRY_PROVIDER_UNSUPPORTED',
      'Operational geometry cartonization currently requires exact Shopify inventory authority.',
    )
  }
  if (!input.optimizer) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPTIMIZER_REQUIRED',
      'The configured OR-Tools fulfillment optimizer is required for operational geometry cartonization.',
    )
  }
  if (
    input.fallbackLines.length < 1
    || !positiveInteger(input.startingSequence)
    || !positiveInteger(input.maximumPackages)
  ) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_GEOMETRY_INPUT_INVALID',
      'Operational geometry cartonization received no bounded fallback demand.',
    )
  }

  const lineById = new Map(input.lines.map((line) => [
    line.lineGlobalId,
    line,
  ]))
  let fallbackUnitCount = 0
  for (const fallback of input.fallbackLines) {
    const line = lineById.get(fallback.lineGlobalId)
    if (
      !line
      || line.productGlobalId !== fallback.productGlobalId
      || fallback.fitModel !== 'rigid_3d'
      || line.profile.fitModel !== 'rigid_3d'
      || line.profile.isCurrent !== true
      || line.profile.lifecycleState !== 'active'
      || line.profile.currentRowVersion
        !== line.profile.capturedRowVersion
      || !exactDimensions(line.profile.outerDimensionsMm)
      || !positiveInteger(line.profile.grossWeightGrams)
      || line.profile.grossWeightGrams !== line.unitWeightGrams
      || !positiveInteger(fallback.quantity)
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_PROFILE_REQUIRED',
        `Line ${fallback.lineGlobalId} requires one exact current active rigid-3D outer pack profile and matching profile weight.`,
      )
    }
    fallbackUnitCount += fallback.quantity
    if (!Number.isSafeInteger(fallbackUnitCount) || fallbackUnitCount > 80) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OPTIMIZER_UNIT_BOUND_EXCEEDED',
        'Operational geometry cartonization supports at most 80 residual units in one atomic optimizer request.',
      )
    }
  }

  const usedMaterialQuantity = recipeMaterialUsage(input.recipePackages)
  const preplannedMaterialIds = new Set<string>()
  for (const usage of input.preplannedMaterialUsage) {
    if (
      !usage.materialGlobalId
      || preplannedMaterialIds.has(usage.materialGlobalId)
      || !positiveInteger(usage.quantity)
      || !input.materials.some((material) => (
        material.materialGlobalId === usage.materialGlobalId
      ))
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_USAGE_INVALID',
        'Preplanned packages must retain one positive, unique material-usage count for selected factual stock.',
      )
    }
    preplannedMaterialIds.add(usage.materialGlobalId)
    const next = (usedMaterialQuantity.get(usage.materialGlobalId) || 0)
      + usage.quantity
    if (!Number.isSafeInteger(next)) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_USAGE_INVALID',
        'Preplanned package material usage exceeds the integer-safe stock boundary.',
      )
    }
    usedMaterialQuantity.set(usage.materialGlobalId, next)
  }
  const invalidMaterial = input.materials.find((material) => {
    const type = materialFamily(material.materialType)
    return (
      material.status !== 'active'
      || material.isCurrent !== true
      || material.capturedRowVersion !== material.currentRowVersion
      || !type
      || !exactDimensions(material.innerDimensionsMm)
      || !exactDimensions(material.ratedOuterDimensionsMm)
      || material.ratedOuterDimensionsMm.length
        < material.innerDimensionsMm.length
      || material.ratedOuterDimensionsMm.width
        < material.innerDimensionsMm.width
      || material.ratedOuterDimensionsMm.height
        < material.innerDimensionsMm.height
      || !positiveInteger(material.tareWeightGrams)
      || !positiveInteger(material.maximumGrossWeightGrams)
      || material.maximumGrossWeightGrams <= material.tareWeightGrams
      || !positiveInteger(material.unitCostMinor)
      || material.currency !== input.currency
      || (
        !shadowTraining
        && (
          !nonnegativeInteger(material.stockRowVersion)
          || !nonnegativeInteger(material.stockOnHandQuantity)
          || !nonnegativeInteger(material.activeClaimedQuantity)
          || material.stockOnHandQuantity - material.activeClaimedQuantity
            !== material.availableQuantity
        )
      )
    )
  })
  if (invalidMaterial) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_FACTS_REQUIRED',
      'Every selected material must retain exact active inner and rated outer dimensions, tare, capacity, cost, currency, and unclaimed warehouse stock.',
    )
  }
  const cartons: FulfillmentOptimizationInputV1['cartons'] =
    input.materials.flatMap((material) => {
      const materialType = materialFamily(material.materialType)
      const innerDimensionsMm = material.innerDimensionsMm
      const maxWeightGrams = material.maximumGrossWeightGrams
      const emptyWeightGrams = material.tareWeightGrams
      const materialCostMinor = material.unitCostMinor
      // The aggregate validation above rejects this branch. Repeat the narrow
      // guards here so the optimizer contract receives non-null factual values.
      if (
        !materialType
        || !exactDimensions(innerDimensionsMm)
        || !positiveInteger(maxWeightGrams)
        || !positiveInteger(emptyWeightGrams)
        || !positiveInteger(materialCostMinor)
      ) return []
      const available = shadowTraining
        ? fallbackUnitCount
        : Number(material.availableQuantity)
          - (usedMaterialQuantity.get(material.materialGlobalId) || 0)
      if (!positiveInteger(available)) return []
      return [{
        cartonGlobalId: material.materialGlobalId,
        warehouseGlobalId: input.warehouseGlobalId,
        materialType,
        innerDimensionsMm,
        maxWeightGrams,
        emptyWeightGrams,
        availableQuantity: available,
        materialCostMinor,
        estimatedTransportCostMinor: 0,
      }]
    })
  if (cartons.length < 1) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_REQUIRED',
      'No exact selected material stock remains after retained recipe packages.',
    )
  }

  const usedProductQuantity = recipeProductUsage(input.recipePackages)
  const inventoryByProduct = new Map(
    input.inventoryProducts.map((product) => [
      product.productGlobalId,
      product,
    ]),
  )
  const fallbackProducts = new Set(
    input.fallbackLines.map((line) => line.productGlobalId),
  )
  const eligiblePositions = [...fallbackProducts]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((productGlobalId) => {
      const product = inventoryByProduct.get(productGlobalId)
      const positionIds = product?.sourcePositionGlobalIds || []
      const available = Number(product?.effectiveAvailableQuantity)
        - (usedProductQuantity.get(productGlobalId) || 0)
      if (
        shadowTraining
        && product?.availabilityAuthority === 'shadow_training_simulated'
        && positiveInteger(available)
      ) {
        return [{
          positionGlobalId: `training-${productGlobalId}`,
          warehouseGlobalId: input.warehouseGlobalId,
          productGlobalId,
          availableQuantity: available,
          unitHandlingCostMinor: 0,
        }]
      }
      if (
        !product
        || product.availabilityAuthority
          !== 'shopify_provider_commitment'
        || positionIds.length !== 1
        || product.sourceLevelGlobalIds.length !== 1
        || !nonnegativeInteger(product.sourcePositionVersion)
        || !nonnegativeInteger(product.providerCommittedQuantity)
        || !nonnegativeInteger(product.activeReservedQuantity)
        || product.providerCommittedQuantity
          - product.activeReservedQuantity
          !== product.effectiveAvailableQuantity
        || !positiveInteger(available)
      ) {
        return []
      }
      return [{
        positionGlobalId: positionIds[0],
        warehouseGlobalId: input.warehouseGlobalId,
        productGlobalId,
        availableQuantity: available,
        unitHandlingCostMinor: 0,
      }]
    })
  if (eligiblePositions.length !== fallbackProducts.size) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_INVENTORY_REQUIRED',
      'Every geometry product requires one exact Shopify inventory level and position with unclaimed committed quantity at the selected warehouse.',
    )
  }

  const allowedCartonGlobalIds = cartons
    .map((carton) => carton.cartonGlobalId)
    .sort((left, right) => left.localeCompare(right))
  const inputSnapshotHash = canonicalOptimizerHash({
    policyVersion: OPERATIONAL_GEOMETRY_POLICY_VERSION,
    organizationGlobalId: input.organizationGlobalId,
    candidateGlobalId: input.candidateGlobalId,
    candidateRowVersion: input.candidateRowVersion,
    warehouseGlobalId: input.warehouseGlobalId,
    readAt: input.readAt,
    availabilityMode: input.availabilityMode || 'operational',
    fallbackLines: input.fallbackLines,
    recipePackageKeys: input.recipePackages.map((item) => item.packageKey),
    preplannedMaterialUsage: [...input.preplannedMaterialUsage].sort(
      (left, right) => (
        left.materialGlobalId.localeCompare(right.materialGlobalId)
      ),
    ),
    materialFacts: input.materials,
    inventoryFacts: input.inventoryProducts,
  })
  const optimizationInput: FulfillmentOptimizationInputV1 = {
    schemaVersion: 1,
    inputSnapshotGlobalId:
      `operational-${inputSnapshotHash.slice(0, 24)}`,
    organizationGlobalId: input.organizationGlobalId,
    orderGlobalId: input.candidateGlobalId,
    // Commerce candidate row_version is zero-based; optimizer revisions are
    // one-based. The exact source revision is retained in the snapshot hash.
    orderRevision: input.candidateRowVersion + 1,
    evaluatedAtUtc: input.readAt,
    currency: input.currency,
    lines: input.fallbackLines.map((fallback) => {
      const line = lineById.get(fallback.lineGlobalId) as
        HybridCartonizationLine
      return {
        lineGlobalId: fallback.lineGlobalId,
        productGlobalId: fallback.productGlobalId,
        quantity: fallback.quantity,
        unitWeightGrams: line.unitWeightGrams,
        unitDimensionsMm:
          line.profile.outerDimensionsMm as OptimizerDimensionsMm,
        rotationAllowed: false,
        allowedWarehouseGlobalIds: [input.warehouseGlobalId],
        allowedCartonGlobalIds,
      }
    }),
    eligiblePositions,
    warehouses: [{
      warehouseGlobalId: input.warehouseGlobalId,
      active: true,
      handlingCostMinor: 0,
    }],
    cartons,
    constraints: {
      schemaVersion: 1,
      maxPackages: Math.min(input.maximumPackages, fallbackUnitCount),
      maxPackageWeightGrams: null,
      allowedWarehouseGlobalIds: [input.warehouseGlobalId],
      allowedCartonGlobalIds,
    },
    objectivePolicy: {
      schemaVersion: 1,
      policyGlobalId: OPERATIONAL_GEOMETRY_POLICY_VERSION,
      sequence: FULFILLMENT_OBJECTIVE_SEQUENCE,
    },
    splitPolicy: {
      allowed: false,
      maxWarehouses: 1,
    },
  }
  try {
    validateFulfillmentOptimizationInput(optimizationInput)
  } catch {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OPTIMIZER_INPUT_INVALID',
      'Exact operational facts could not form one valid bounded optimizer request.',
    )
  }

  const optimizerResult = await input.optimizer.optimize(
    optimizationInput,
    {
      deadlineMs: input.options?.deadlineMs ?? 10_000,
      maxCandidates: input.options?.maxCandidates ?? 8,
    },
  )
  const selectedPlan = optimizerResult.selectedPlan
  if (
    optimizerResult.method !== 'or_tools'
    || !['optimal', 'feasible'].includes(optimizerResult.status)
    || optimizerResult.inputHash
      !== canonicalOptimizerHash(optimizationInput)
    || !selectedPlan
    || selectedPlan.warehouseCount !== 1
    || selectedPlan.shipmentCount !== 1
    || selectedPlan.warehouseGlobalIds.length !== 1
    || selectedPlan.warehouseGlobalIds[0] !== input.warehouseGlobalId
    || selectedPlan.packages.length < 1
  ) {
    return blocked(
      'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_RESULT_REQUIRED',
      'OR-Tools did not return one validated feasible selected-warehouse package plan; deterministic fallback is not operational evidence.',
    )
  }

  const materialById = new Map(
    input.materials.map((material) => [
      material.materialGlobalId,
      material,
    ]),
  )
  const packages: OperationalGeometryPackage[] = []
  const packageKeys = new Set(input.recipePackages.map((item) => item.packageKey))
  for (let index = 0; index < selectedPlan.packages.length; index += 1) {
    const packagePlan = selectedPlan.packages[index]
    const material = materialById.get(packagePlan.cartonGlobalId)
    if (
      packageKeys.has(packagePlan.packageKey)
      || !material
      || !exactDimensions(material.ratedOuterDimensionsMm)
      || !positiveInteger(material.tareWeightGrams)
      || !positiveInteger(material.maximumGrossWeightGrams)
    ) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_TRANSFORMATION_INVALID',
        'The selected optimizer package lost its exact material lineage.',
      )
    }
    packageKeys.add(packagePlan.packageKey)
    const aggregate = new Map<string, {
      lineGlobalId: string
      productGlobalId: string
      quantity: number
    }>()
    for (const allocation of packagePlan.allocations) {
      const key = `${allocation.lineGlobalId}:${allocation.productGlobalId}`
      const current = aggregate.get(key)
      aggregate.set(key, {
        lineGlobalId: allocation.lineGlobalId,
        productGlobalId: allocation.productGlobalId,
        quantity: (current?.quantity || 0) + allocation.quantity,
      })
    }
    const allocations = [] as OperationalGeometryPackage['allocations']
    for (const allocation of [...aggregate.values()].sort(
      (left, right) => (
        left.lineGlobalId.localeCompare(right.lineGlobalId)
        || left.productGlobalId.localeCompare(right.productGlobalId)
      ),
    )) {
      const line = lineById.get(allocation.lineGlobalId)
      if (!line || line.productGlobalId !== allocation.productGlobalId) {
        return blocked(
          'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_TRANSFORMATION_INVALID',
          'The selected optimizer package contains an allocation outside the exact order lines.',
        )
      }
      allocations.push({
        ...allocation,
        title: line.title,
      })
    }
    const contentWeightGrams = packagePlan.totalWeightGrams
      - packagePlan.emptyWeightGrams
    if (!positiveInteger(contentWeightGrams)) {
      return blocked(
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_TRANSFORMATION_INVALID',
        'The selected optimizer package has invalid exact content weight.',
      )
    }
    packages.push({
      packageKey: packagePlan.packageKey,
      packageSequence: input.startingSequence + index,
      planningMethod: 'or_tools',
      packagingMaterialGlobalId: material.materialGlobalId,
      materialRowVersion: material.currentRowVersion,
      recipes: [],
      innerDimensionsMm: packagePlan.innerDimensionsMm,
      ratedOuterDimensionsMm: material.ratedOuterDimensionsMm,
      contentWeightGrams,
      tareWeightGrams: packagePlan.emptyWeightGrams,
      ratedGrossWeightGrams: packagePlan.totalWeightGrams,
      maxWeightGrams: packagePlan.maxWeightGrams,
      allocations,
      orToolsProfiles: allocations.map((allocation) => {
        const line = lineById.get(allocation.lineGlobalId) as
          HybridCartonizationLine
        return {
          lineGlobalId: allocation.lineGlobalId,
          productGlobalId: allocation.productGlobalId,
          inputProfileVersionGlobalId: line.profile.versionGlobalId,
          inputProfileVersionRowVersion:
            line.profile.currentRowVersion,
          fitModel: 'rigid_3d' as const,
          unitDimensionsMm:
            line.profile.outerDimensionsMm as OptimizerDimensionsMm,
          unitWeightGrams: line.unitWeightGrams,
          quantity: allocation.quantity,
        }
      }),
    })
  }

  return {
    status: 'ready',
    policyVersion: OPERATIONAL_GEOMETRY_POLICY_VERSION,
    optimizerInput: optimizationInput,
    optimizerResult,
    packages,
    evidence: {
      policyVersion: OPERATIONAL_GEOMETRY_POLICY_VERSION,
      optimizerMethod: 'or_tools',
      optimizerInputHash: optimizerResult.inputHash,
      optimizerAlgorithmVersion: optimizerResult.algorithmVersion,
      selectedPlanId: selectedPlan.planId,
      transformationHash: canonicalOptimizerHash(packages),
      rotationAllowed: false,
      transportCostBasis: 'excluded_before_carrier_read',
      warehouseHandlingCostBasis: 'excluded_from_pack_feasibility',
      inventoryHandlingCostBasis: 'excluded_from_pack_feasibility',
      profileAuthority: 'current_active_outer_pack_profile',
      materialAuthority:
        'current_active_material_and_unclaimed_warehouse_stock',
      inventoryAuthority:
        'shopify_provider_commitment_less_active_reservations',
    },
  }
}
