import { createHash } from 'node:crypto'
import {
  planHybridCartonization,
  planHybridCartonizationCandidates,
  type HybridCartonizationInput,
  type HybridCartonizationResult,
} from '@/lib/operations/hybridCartonization'
import {
  planShopifyCheckoutUnitMaterialPackages,
  type OperationalUnitMaterialInventoryProductEvidence,
  type OperationalUnitMaterialPackage,
  type OperationalUnitMaterialPlan,
} from '@/lib/operations/operationalUnitMaterialCartonization'
import type { CheckoutRateParcel } from '@/lib/integrations/carrierCheckoutRate'

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/

export class ShopifyCheckoutRatingError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShopifyCheckoutRatingError'
    this.code = code
  }
}

function checkoutError(code: string, message: string): never {
  throw new ShopifyCheckoutRatingError(code, message)
}

function decimalId(value: unknown, label: string) {
  if (typeof value !== 'string' || !DECIMAL_ID.test(value)) {
    checkoutError(
      'SHOPIFY_CHECKOUT_IDENTIFIER_INVALID',
      `${label} is not an exact Shopify decimal identifier`,
    )
  }
  return value
}

export function shopifyProductGid(value: unknown) {
  return `gid://shopify/Product/${decimalId(value, 'Product ID')}`
}

export function shopifyVariantGid(value: unknown) {
  return `gid://shopify/ProductVariant/${decimalId(value, 'Variant ID')}`
}

type ShopifyCheckoutUnitMaterialPlan = Extract<
  OperationalUnitMaterialPlan,
  { status: 'ready' }
>

type ShopifyCheckoutPlannedPackage =
  | HybridCartonizationResult['selfPackages'][number]
  | HybridCartonizationResult['recipePackages'][number]
  | OperationalUnitMaterialPackage

function packageRateEvidence(plannedPackage: ShopifyCheckoutPlannedPackage) {
  if (plannedPackage.planningMethod === 'unit_material_selection') {
    return {
      sequence: plannedPackage.packageSequence,
      dimensions: plannedPackage.ratedOuterDimensionsMm,
      grossWeightGrams: plannedPackage.ratedGrossWeightGrams,
    }
  }
  if (
    plannedPackage.rateReadiness.status !== 'ready'
    || plannedPackage.rateReadiness.blockers.length
    || !plannedPackage.rateReadiness.ratedOuterDimensionsMm
    || !plannedPackage.rateReadiness.ratedWeightGrams
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_MISSING',
      `Package ${plannedPackage.packageKey} lacks verified rating dimensions or weight`,
    )
  }
  return {
    sequence: plannedPackage.sequence,
    dimensions: plannedPackage.rateReadiness.ratedOuterDimensionsMm,
    grossWeightGrams: plannedPackage.rateReadiness.ratedWeightGrams,
  }
}

function packageParcel(
  plannedPackage: ShopifyCheckoutPlannedPackage,
): CheckoutRateParcel {
  const {
    sequence,
    dimensions,
    grossWeightGrams,
  } = packageRateEvidence(plannedPackage)
  if (
    !Number.isSafeInteger(dimensions.length)
    || !Number.isSafeInteger(dimensions.width)
    || !Number.isSafeInteger(dimensions.height)
    || dimensions.length < 1
    || dimensions.width < 1
    || dimensions.height < 1
    || !Number.isSafeInteger(grossWeightGrams)
    || grossWeightGrams < 1
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_INVALID',
      `Package ${plannedPackage.packageKey} has invalid rating evidence`,
    )
  }
  const inches = (millimeters: number) => Math.ceil(
    millimeters / 25.4,
  )
  const pounds = Math.ceil(
    (grossWeightGrams / 453.59237) * 10,
  ) / 10
  return {
    packageKey: plannedPackage.packageKey,
    description: plannedPackage.planningMethod === 'self_package'
      ? `ClawPilot sealed case ${sequence}`
      : `ClawPilot carton ${sequence}`,
    exteriorInches: {
      length: inches(dimensions.length),
      width: inches(dimensions.width),
      height: inches(dimensions.height),
    },
    grossPounds: Math.max(0.1, pounds),
  }
}

function assertAllocationConservation(
  input: HybridCartonizationInput,
  plan: HybridCartonizationResult,
  unitMaterialPlan: ShopifyCheckoutUnitMaterialPlan | null,
) {
  const required = new Map(
    input.lines.map((line) => [line.lineGlobalId, line.quantity]),
  )
  const allocated = new Map<string, number>()
  for (const recipePackage of plan.recipePackages) {
    for (const allocation of recipePackage.lineAllocations) {
      allocated.set(
        allocation.lineGlobalId,
        (allocated.get(allocation.lineGlobalId) || 0) + allocation.quantity,
      )
    }
  }
  for (const selfPackage of plan.selfPackages) {
    for (const allocation of selfPackage.lineAllocations) {
      allocated.set(
        allocation.lineGlobalId,
        (allocated.get(allocation.lineGlobalId) || 0) + allocation.quantity,
      )
    }
  }
  for (const unitPackage of unitMaterialPlan?.packages ?? []) {
    for (const allocation of unitPackage.allocations) {
      allocated.set(
        allocation.lineGlobalId,
        (allocated.get(allocation.lineGlobalId) || 0) + allocation.quantity,
      )
    }
  }
  if (
    allocated.size !== required.size
    || [...required].some(
      ([lineGlobalId, quantity]) => allocated.get(lineGlobalId) !== quantity,
    )
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_ALLOCATION_CONSERVATION_FAILED',
      'Cartonization did not allocate every requested unit exactly once',
    )
  }
}

function readyPlanPackages(
  input: HybridCartonizationInput,
  plan: HybridCartonizationResult,
  inventoryProducts:
    OperationalUnitMaterialInventoryProductEvidence[] = [],
) {
  if (plan.status !== 'ready' || plan.blockers.length) {
    checkoutError(
      'SHOPIFY_CHECKOUT_CARTONIZATION_BLOCKED',
      'Approved cartonization evidence is incomplete or stale',
    )
  }
  const unsupportedFallbackLines = plan.geometryFallbackLines.filter(
    (line) => line.fitModel !== 'unconstrained_unit',
  )
  if (unsupportedFallbackLines.length) {
    checkoutError(
      'SHOPIFY_CHECKOUT_GEOMETRY_FALLBACK_UNSUPPORTED',
      'Shopify checkout supports ordinary one-each fallback only; dimensional geometry fallback remains unsupported',
    )
  }
  const hybridPackages: ShopifyCheckoutPlannedPackage[] = [
    ...plan.selfPackages,
    ...plan.recipePackages,
  ]
  const unitFallbackLines = plan.geometryFallbackLines.filter(
    (line) => line.fitModel === 'unconstrained_unit',
  )
  let unitMaterialPlan: ShopifyCheckoutUnitMaterialPlan | null = null
  if (unitFallbackLines.length) {
    const maximumPackages = 50 - hybridPackages.length
    if (maximumPackages < 1) {
      checkoutError(
        'SHOPIFY_CHECKOUT_PACKAGE_COUNT_INVALID',
        'Shopify checkout requires between 1 and 50 complete packages',
      )
    }
    const result = planShopifyCheckoutUnitMaterialPackages({
      lines: input.lines,
      fallbackLines: unitFallbackLines,
      recipePackages: plan.recipePackages,
      materials: input.materials,
      inventoryProducts,
      startingSequence: Math.max(
        0,
        ...plan.selfPackages.map((item) => item.sequence),
        ...plan.recipePackages.map((item) => item.sequence),
      ) + 1,
      maximumPackages,
    })
    if (result.status === 'blocked') {
      checkoutError(result.blocker.code, result.blocker.detail)
    }
    unitMaterialPlan = result
  }
  const plannedPackages: ShopifyCheckoutPlannedPackage[] = [
    ...hybridPackages,
    ...(unitMaterialPlan?.packages ?? []),
  ].sort((left, right) => (
    packageRateEvidence(left).sequence
      - packageRateEvidence(right).sequence
  ))
  if (plannedPackages.length < 1 || plannedPackages.length > 50) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_COUNT_INVALID',
      'Shopify checkout requires between 1 and 50 complete packages',
    )
  }
  assertAllocationConservation(input, plan, unitMaterialPlan)
  return { plannedPackages, unitMaterialPlan }
}

function productionInput(input: HybridCartonizationInput) {
  if (input.mode !== 'production') {
    checkoutError(
      'SHOPIFY_CHECKOUT_PRODUCTION_EVIDENCE_REQUIRED',
      'Shopify checkout rating requires production evidence mode',
    )
  }
}

function cubeMm3(dimensions: {
  length: number
  width: number
  height: number
}) {
  const cube = dimensions.length * dimensions.width * dimensions.height
  if (!Number.isSafeInteger(cube) || cube < 1) {
    checkoutError(
      'SHOPIFY_CHECKOUT_PACKAGE_CUBE_INVALID',
      'Package volume exceeds the supported exact range',
    )
  }
  return cube
}

function contentCubeMm3(input: HybridCartonizationInput) {
  let total = 0
  for (const line of input.lines) {
    const dimensions = line.profile.outerDimensionsMm
    if (!dimensions) return null
    const lineCube = cubeMm3(dimensions) * line.quantity
    if (!Number.isSafeInteger(lineCube) || lineCube < 1) {
      checkoutError(
        'SHOPIFY_CHECKOUT_CONTENT_CUBE_INVALID',
        'Content volume exceeds the supported exact range',
      )
    }
    total += lineCube
    if (!Number.isSafeInteger(total)) {
      checkoutError(
        'SHOPIFY_CHECKOUT_CONTENT_CUBE_INVALID',
        'Content volume exceeds the supported exact range',
      )
    }
  }
  return total
}

export type ShopifyCheckoutPackageCandidate = {
  candidateKey: string
  preferenceMaterialGlobalId: string | null
  preferenceMaterialGlobalIdsByPool: Record<string, string>
  plan: HybridCartonizationResult
  unitMaterialPlan: ShopifyCheckoutUnitMaterialPlan | null
  parcels: CheckoutRateParcel[]
  packageOuterCubeMm3: number
  unusedCubeMm3: number
  cubeBasis: 'content_subtracted' | 'outer_cube_proxy'
}

export type ShopifyCheckoutUnitMaterialPlanningOptions = {
  unitMaterialInventoryProducts?:
    OperationalUnitMaterialInventoryProductEvidence[]
}

function candidateKeyWithUnitMaterialPlan(
  candidateKey: string,
  unitMaterialPlan: ShopifyCheckoutUnitMaterialPlan | null,
) {
  if (!unitMaterialPlan) return candidateKey
  return `hcan-${createHash('sha256').update(JSON.stringify({
    candidateKey,
    inventoryAuthority: unitMaterialPlan.evidence.inventoryAuthority,
    materialAuthority: unitMaterialPlan.evidence.materialAuthority,
    transformationHash: unitMaterialPlan.evidence.transformationHash,
  })).digest('hex').slice(0, 20)}`
}

/**
 * Converts fully evidenced self-packaged cases, approved-recipe cartons, and
 * ordinary one-each material cartons into the package array used for both UPS
 * and FedEx. Dimensional geometry fallback remains non-shippable at checkout.
 */
export function planShopifyCheckoutPackages(
  input: HybridCartonizationInput,
  options: ShopifyCheckoutUnitMaterialPlanningOptions = {},
): {
  plan: HybridCartonizationResult
  unitMaterialPlan: ShopifyCheckoutUnitMaterialPlan | null
  parcels: CheckoutRateParcel[]
} {
  productionInput(input)
  const plan = planHybridCartonization(input)
  const { plannedPackages, unitMaterialPlan } = readyPlanPackages(
    input,
    plan,
    options.unitMaterialInventoryProducts,
  )
  return {
    plan,
    unitMaterialPlan,
    parcels: plannedPackages.map(packageParcel),
  }
}

/**
 * Produces a bounded, deterministic set of fully feasible alternatives. The
 * carrier layer rates every alternative as one complete multi-package
 * shipment before applying the tenant-owned objective.
 */
export function planShopifyCheckoutPackageCandidates(
  input: HybridCartonizationInput,
  options: {
    maxCandidates: number
    materialPreferenceOrder?: string[]
  } & ShopifyCheckoutUnitMaterialPlanningOptions,
): ShopifyCheckoutPackageCandidate[] {
  productionInput(input)
  if (
    !Number.isSafeInteger(options.maxCandidates)
    || options.maxCandidates < 1
    || options.maxCandidates > 4
  ) {
    checkoutError(
      'SHOPIFY_CHECKOUT_CANDIDATE_COUNT_INVALID',
      'Shopify checkout supports between 1 and 4 carton candidates',
    )
  }
  const candidates = planHybridCartonizationCandidates(input, options)
  if (!candidates.length) {
    checkoutError(
      'SHOPIFY_CHECKOUT_CARTONIZATION_BLOCKED',
      'Approved cartonization evidence is incomplete or stale',
    )
  }
  const contentCube = contentCubeMm3(input)
  return candidates.map((candidate) => {
    const { plannedPackages, unitMaterialPlan } = readyPlanPackages(
      input,
      candidate.plan,
      options.unitMaterialInventoryProducts,
    )
    const packageOuterCubeMm3 = plannedPackages.reduce(
      (total, plannedPackage) => {
        const dimensions = packageRateEvidence(
          plannedPackage,
        ).dimensions
        if (!dimensions) {
          checkoutError(
            'SHOPIFY_CHECKOUT_PACKAGE_RATE_EVIDENCE_MISSING',
            `Package ${plannedPackage.packageKey} lacks rating dimensions`,
          )
        }
        const next = total + cubeMm3(dimensions)
        if (!Number.isSafeInteger(next)) {
          checkoutError(
            'SHOPIFY_CHECKOUT_PACKAGE_CUBE_INVALID',
            'Package volume exceeds the supported exact range',
          )
        }
        return next
      },
      0,
    )
    return {
      candidateKey: candidateKeyWithUnitMaterialPlan(
        candidate.candidateKey,
        unitMaterialPlan,
      ),
      preferenceMaterialGlobalId:
        candidate.preferenceMaterialGlobalId,
      preferenceMaterialGlobalIdsByPool:
        candidate.preferenceMaterialGlobalIdsByPool,
      plan: candidate.plan,
      unitMaterialPlan,
      parcels: plannedPackages.map(packageParcel),
      packageOuterCubeMm3,
      unusedCubeMm3: contentCube === null
        ? packageOuterCubeMm3
        : Math.max(0, packageOuterCubeMm3 - contentCube),
      cubeBasis: contentCube === null
        ? 'outer_cube_proxy'
        : 'content_subtracted',
    }
  })
}
