import { createHash, randomUUID } from 'node:crypto'
import { recordAuditEvent } from '@/lib/auditWriter'
import { decryptCommerceCandidateSnapshot } from '@/lib/integrations/commerceCredentialCrypto'
import {
  carrierSandboxPartyFingerprint,
  normalizeCarrierSandboxParty,
  type CarrierSandboxParcel,
} from '@/lib/integrations/carrierSandboxRate'
import {
  canonicalOptimizerHash,
  parseFulfillmentOptimizationResult,
  validateFulfillmentOptimizationInput,
  type FulfillmentOptimizationInputV1,
} from '@/lib/operations/fulfillmentOptimizerContract'
import { orderShipToStorageValue } from '@/lib/operations/orderShipTo'
import {
  readOperationsOrderShipmentAddressInPostgres,
} from '@/lib/persistence/operationsOrderShipmentAddress'
import {
  acquireTransactionAdvisoryLock,
  getPostgresPool,
  withTransaction,
} from '@/lib/persistence/postgres'

// UPS Rating Shop accepts at most 50 package containers in one request.
// Cartonization comparisons are whole-shipment requests and must not split or
// sum independent package rates, so the shared evidence bound is 50.
export const MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES = 50

export const CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS = [
  'ups_rest',
  'fedex_rest',
] as const

export type CartonizationRateEvidenceCarrierProvider =
  typeof CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS[number]

export type CartonizationRateEvidenceAllocation = {
  lineGlobalId: string
  productGlobalId: string
  title: string
  quantity: number
}

export type CartonizationRateEvidenceRecipeInput = {
  recipeGlobalId: string
  recipeRowVersion: number
  productGlobalId: string
  inputProfileVersionGlobalId: string
  inputProfileVersionRowVersion: number
}

export type CartonizationRateEvidenceOrToolsProfileInput = {
  lineGlobalId: string
  productGlobalId: string
  inputProfileVersionGlobalId: string
  inputProfileVersionRowVersion: number
  fitModel: 'rigid_3d'
  unitDimensionsMm: CartonizationRateEvidenceDimensionsMm
  unitWeightGrams: number
  quantity: number
}

export type CartonizationRateEvidenceDimensionsMm = {
  length: number
  width: number
  height: number
}

export type CartonizationRateEvidenceMaterialRateAssumption = {
  materialGlobalId: string
  expectedRowVersion: number
  ratedOuterDimensionsMm: CartonizationRateEvidenceDimensionsMm
  tareWeightGrams: number
  operationalFacts: {
    materialType: 'carton' | 'poly_mailer' | 'padded_mailer'
    innerDimensionsMm: CartonizationRateEvidenceDimensionsMm
    maximumGrossWeightGrams: number
    unitCostMinor: number
    currency: string
    stock: null | {
      rowVersion: number
      onHandQuantity: number
      activeClaimedQuantity: number
      availableQuantity: number
    }
  } | null
}

export type CartonizationRateEvidencePackageInput = {
  packageKey: string
  packageSequence: number
  planningMethod:
    | 'approved_recipe'
    | 'or_tools'
    | 'sandbox_fixed_axis'
  packagingMaterialGlobalId: string
  materialRowVersion: number
  recipes: CartonizationRateEvidenceRecipeInput[]
  orToolsProfiles: CartonizationRateEvidenceOrToolsProfileInput[]
  innerDimensionsMm: CartonizationRateEvidenceDimensionsMm
  ratedOuterDimensionsMm: CartonizationRateEvidenceDimensionsMm
  contentWeightGrams: number
  tareWeightGrams: number
  ratedGrossWeightGrams: number
  maxWeightGrams: number | null
  allocations: CartonizationRateEvidenceAllocation[]
  carrierParcel: CarrierSandboxParcel
  packageHash: string
}

export type CartonizationRateEvidenceQuoteInput = {
  packageKey: string
  provider: CartonizationRateEvidenceCarrierProvider
  rateEvidenceGlobalId: string
}

export type CartonizationRateEvidenceWriteInput = {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
  candidateRowVersion: number
  destinationFingerprint: string
  warehouseGlobalId: string
  inventorySyncRunGlobalId: string | null
  evidenceMode: 'operational' | 'assumption_backed_sandbox'
  requiredCarrierProviders: CartonizationRateEvidenceCarrierProvider[]
  policyVersion: string
  algorithmVersion: string
  planInputHash: string
  planResultHash: string
  planSnapshot: Record<string, unknown>
  assumptionSnapshot: Record<string, unknown>
  status: 'succeeded' | 'partial' | 'failed'
  idempotencyKey: string
  actorEmail: string
  semanticRequestHash: string
  materialRateAssumptions:
    CartonizationRateEvidenceMaterialRateAssumption[]
  packages: CartonizationRateEvidencePackageInput[]
  quotes: CartonizationRateEvidenceQuoteInput[]
}

type EvidenceHeaderRow = {
  id: string
  global_id: string
  account_global_id: string
  candidate_global_id: string
  candidate_order_number: string
  candidate_row_version: string
  candidate_source_hash: string
  destination_fingerprint: string
  request_hash: string
  warehouse_global_id: string
  warehouse_name: string
  inventory_sync_run_global_id: string | null
  evidence_mode: 'operational' | 'assumption_backed_sandbox'
  required_carrier_providers: CartonizationRateEvidenceCarrierProvider[]
  policy_version: string
  algorithm_version: string
  plan_input_hash: string
  plan_result_hash: string
  plan_snapshot: Record<string, unknown>
  assumption_snapshot: Record<string, unknown>
  status: 'succeeded' | 'partial' | 'failed'
  idempotency_key: string
  actor_email: string | null
  created_at: Date | string
}

type EvidencePackageRow = {
  package_key: string
  package_sequence: number
  planning_method:
    | 'approved_recipe'
    | 'or_tools'
    | 'sandbox_fixed_axis'
  packaging_material_global_id: string
  packaging_material_name: string
  approved_pack_recipe_global_id: string | null
  approved_pack_recipe_name: string | null
  material_row_version: string
  recipe_row_version: string | null
  inner_dimensions_mm: {
    length: number
    width: number
    height: number
  }
  rated_outer_dimensions_mm: {
    length: number
    width: number
    height: number
  }
  content_weight_grams: number
  tare_weight_grams: number
  rated_gross_weight_grams: number
  max_weight_grams: number | null
  allocations: CartonizationRateEvidenceAllocation[]
  carrier_parcel_snapshot: CarrierSandboxParcel
  package_hash: string
}

type EvidenceRecipeRow = {
  package_key: string
  recipe_global_id: string
  recipe_name_snapshot: string
  product_global_id: string
  input_profile_version_global_id: string
  recipe_row_version: string
  input_profile_version_row_version: string
}

type EvidenceOrToolsProfileRow = {
  package_key: string
  line_global_id: string
  product_global_id: string
  input_profile_version_global_id: string
  input_profile_version_row_version: string
  fit_model: 'rigid_3d'
  unit_dimensions_mm: CartonizationRateEvidenceDimensionsMm
  unit_weight_grams: number
  quantity: number
}

type EvidenceQuoteRow = {
  package_key: string
  provider: CartonizationRateEvidenceCarrierProvider
  rate_evidence_global_id: string
  quote_status: 'succeeded' | 'failed'
  error_code: string | null
  carrier_request_hash: string
  package_rate_context_hash: string
  redacted_response: {
    rateScope?: 'multi_package_shipment'
    packageCount?: number
    rateCount?: number
    rates?: Array<{
      serviceCode: string
      serviceName: string
      amount: string
      currency: string
      rateType: string | null
      transitDays: number | null
      deliveryDate: string | null
    }>
  }
  requested_at: Date | string
  completed_at: Date | string
}

export type CartonizationRateEvidence = {
  globalId: string
  accountGlobalId: string
  candidateGlobalId: string
  candidateOrderNumber: string
  candidateRowVersion: number
  candidateSourceHash: string
  destinationFingerprint: string
  requestHash: string
  warehouse: {
    globalId: string
    name: string
  }
  inventorySyncRunGlobalId: string | null
  evidenceMode: 'operational' | 'assumption_backed_sandbox'
  requiredCarrierProviders: CartonizationRateEvidenceCarrierProvider[]
  policyVersion: string
  algorithmVersion: string
  planInputHash: string
  planResultHash: string
  planSnapshot: Record<string, unknown>
  assumptionSnapshot: Record<string, unknown>
  status: 'succeeded' | 'partial' | 'failed'
  idempotencyKey: string
  actorEmail: string | null
  createdAt: string
  shipmentRates: Array<{
    provider: CartonizationRateEvidenceCarrierProvider
    rateEvidenceGlobalId: string
    status: 'succeeded' | 'failed'
    errorCode: string | null
    carrierRequestHash: string
    shipmentRateContextHash: string
    packageCount: number
    packageKeys: string[]
    rates: Array<{
      serviceCode: string
      serviceName: string
      amount: string
      currency: string
      rateType: string | null
      transitDays: number | null
      deliveryDate: string | null
    }>
    requestedAt: string
    completedAt: string
  }>
  packages: Array<{
    packageKey: string
    packageSequence: number
    planningMethod:
      | 'approved_recipe'
      | 'or_tools'
      | 'sandbox_fixed_axis'
    packagingMaterialGlobalId: string
    packagingMaterialName: string
    approvedPackRecipeGlobalId: string | null
    approvedPackRecipeName: string | null
    materialRowVersion: number
    recipeRowVersion: number | null
    recipes: Array<{
      recipeGlobalId: string
      recipeName: string
      productGlobalId: string
      inputProfileVersionGlobalId: string
      recipeRowVersion: number
      inputProfileVersionRowVersion: number
    }>
    orToolsProfiles: CartonizationRateEvidenceOrToolsProfileInput[]
    innerDimensionsMm: {
      length: number
      width: number
      height: number
    }
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    }
    contentWeightGrams: number
    tareWeightGrams: number
    ratedGrossWeightGrams: number
    maxWeightGrams: number | null
    allocations: CartonizationRateEvidenceAllocation[]
    carrierParcel: CarrierSandboxParcel
    packageHash: string
    quotes: Array<{
      provider: CartonizationRateEvidenceCarrierProvider
      rateEvidenceGlobalId: string
      status: 'succeeded' | 'failed'
      errorCode: string | null
      carrierRequestHash: string
      packageRateContextHash: string
      shipmentRateContextHash: string | null
      rateScope: 'single_package' | 'multi_package_shipment'
      rates: Array<{
        serviceCode: string
        serviceName: string
        amount: string
        currency: string
        rateType: string | null
        transitDays: number | null
        deliveryDate: string | null
      }>
      requestedAt: string
      completedAt: string
    }>
  }>
}

export class CartonizationRateEvidencePersistenceError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status = 409,
    code = 'CARTONIZATION_RATE_EVIDENCE_INVALID',
  ) {
    super(message)
    this.name = 'CartonizationRateEvidencePersistenceError'
    this.status = status
    this.code = code
  }
}

export type CartonizationRateEvidenceCommandClaim =
  | { state: 'claimed' }
  | { state: 'pending' }
  | { state: 'completed'; evidenceGlobalId: string }
  | { state: 'failed'; errorCode: string }

export type CartonizationRateCandidateContext = {
  candidateSourceHash: string
  destinationFingerprint: string
  destination: {
    name: string
    line1: string
    line2: string | null
    city: string
    region: string
    postalCode: string
    countryCode: string
  }
}

function fail(
  message: string,
  status = 409,
  code = 'CARTONIZATION_RATE_EVIDENCE_INVALID',
): never {
  throw new CartonizationRateEvidencePersistenceError(message, status, code)
}

function safeInteger(value: string | number | null, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(
      `${label} is not an exact nonnegative integer`,
      500,
      'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
    )
  }
  return parsed
}

function timestamp(value: Date | string) {
  return new Date(value).toISOString()
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('Cartonization evidence cannot hash a non-finite number', 400)
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => {
          if (item === undefined) {
            fail('Cartonization evidence cannot hash an undefined value', 400)
          }
          return [key, canonicalValue(item)]
        }),
    )
  }
  fail('Cartonization evidence contains a non-canonical value', 400)
}

export function cartonizationRateEvidenceHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex')
}

function exactMaterialRateDimensions(
  value: CartonizationRateEvidenceDimensionsMm,
) {
  return (
    Number.isSafeInteger(value?.length)
    && value.length > 0
    && Number.isSafeInteger(value?.width)
    && value.width > 0
    && Number.isSafeInteger(value?.height)
    && value.height > 0
  )
}

function sameMaterialRateDimensions(
  left: CartonizationRateEvidenceDimensionsMm,
  right: CartonizationRateEvidenceDimensionsMm,
) {
  return (
    left.length === right.length
    && left.width === right.width
    && left.height === right.height
  )
}

export function assertCartonizationRateEvidenceOrToolsProfiles(
  input: Pick<
    CartonizationRateEvidenceWriteInput,
    'evidenceMode' | 'packages'
  >,
) {
  for (const packageInput of input.packages) {
    if (!Array.isArray(packageInput.orToolsProfiles)) {
      fail(
        `${packageInput.packageKey} requires an explicit OR-Tools profile evidence array`,
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
      )
    }
    if (packageInput.planningMethod !== 'or_tools') {
      if (packageInput.orToolsProfiles.length !== 0) {
        fail(
          `${packageInput.packageKey} cannot retain OR-Tools profile evidence`,
          400,
          'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
        )
      }
      continue
    }
    if (input.evidenceMode !== 'operational') {
      fail(
        `${packageInput.packageKey} requires operational evidence for OR-Tools geometry`,
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
      )
    }
    const allocationsByLine = new Map<
      string,
      CartonizationRateEvidenceAllocation
    >()
    for (const allocation of packageInput.allocations) {
      if (allocationsByLine.has(allocation.lineGlobalId)) {
        fail(
          `${packageInput.packageKey} repeats allocation line ${allocation.lineGlobalId}`,
          400,
          'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
        )
      }
      allocationsByLine.set(allocation.lineGlobalId, allocation)
    }
    if (
      packageInput.orToolsProfiles.length !== allocationsByLine.size
    ) {
      fail(
        `${packageInput.packageKey} requires one exact profile edge per allocation line`,
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
      )
    }
    const retainedLines = new Set<string>()
    for (const profile of packageInput.orToolsProfiles) {
      const allocation = allocationsByLine.get(profile?.lineGlobalId)
      if (
        !/^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/.test(
          profile?.lineGlobalId || '',
        )
        || !/^gp(?:[0-9]{7}|[0-9a-v]{12})$/.test(
          profile?.productGlobalId || '',
        )
        || !/^gppv(?:[0-9]{7}|[0-9a-v]{12})$/.test(
          profile?.inputProfileVersionGlobalId || '',
        )
        || !Number.isSafeInteger(profile?.inputProfileVersionRowVersion)
        || profile.inputProfileVersionRowVersion < 0
        || profile.fitModel !== 'rigid_3d'
        || !exactMaterialRateDimensions(profile?.unitDimensionsMm)
        || !Number.isSafeInteger(profile?.unitWeightGrams)
        || profile.unitWeightGrams <= 0
        || !Number.isSafeInteger(profile?.quantity)
        || profile.quantity <= 0
        || retainedLines.has(profile.lineGlobalId)
        || !allocation
        || allocation.productGlobalId !== profile.productGlobalId
        || allocation.quantity !== profile.quantity
      ) {
        fail(
          `${packageInput.packageKey} contains invalid or mismatched OR-Tools profile evidence`,
          400,
          'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_INVALID',
        )
      }
      retainedLines.add(profile.lineGlobalId)
    }
  }
}

export function assertCartonizationRateEvidenceOperationalGeometryProvenance(
  input: Pick<
    CartonizationRateEvidenceWriteInput,
    'evidenceMode' | 'packages' | 'planSnapshot'
  >,
) {
  const orToolsPackages = input.packages.filter(
    (packageInput) => packageInput.planningMethod === 'or_tools',
  )
  const retainedPlan = input.planSnapshot.operationalGeometryRatePlan
  if (orToolsPackages.length === 0) {
    if (retainedPlan !== null && retainedPlan !== undefined) {
      fail(
        'Operational geometry provenance cannot be retained without OR-Tools packages',
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
      )
    }
    return
  }
  if (
    input.evidenceMode !== 'operational'
    || !retainedPlan
    || typeof retainedPlan !== 'object'
    || Array.isArray(retainedPlan)
  ) {
    fail(
      'OR-Tools packages require one exact retained operational geometry plan',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
    )
  }
  const plan = retainedPlan as Record<string, unknown>
  const evidence = plan.evidence
  const optimizerInput = plan.optimizerInput
  const optimizerResult = plan.optimizerResult
  const transformedPackages = plan.packages
  if (
    !evidence
    || typeof evidence !== 'object'
    || Array.isArray(evidence)
    || !optimizerInput
    || typeof optimizerInput !== 'object'
    || Array.isArray(optimizerInput)
    || !optimizerResult
    || typeof optimizerResult !== 'object'
    || Array.isArray(optimizerResult)
    || !Array.isArray(transformedPackages)
  ) {
    fail(
      'Operational geometry provenance is incomplete',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
    )
  }
  const retainedEvidence = evidence as Record<string, unknown>
  const retainedResult = optimizerResult as Record<string, unknown>
  const selectedPlan = retainedResult.selectedPlan
  const selectedPlanId = selectedPlan
    && typeof selectedPlan === 'object'
    && !Array.isArray(selectedPlan)
    ? (selectedPlan as Record<string, unknown>).planId
    : null
  const writePackages = [...orToolsPackages].sort((left, right) => (
    left.packageSequence - right.packageSequence
    || left.packageKey.localeCompare(right.packageKey)
  )).map((packageInput) => Object.fromEntries(
    Object.entries(packageInput).filter(([key]) => (
      key !== 'carrierParcel' && key !== 'packageHash'
    )),
  ))
  const retainedPackages = [...transformedPackages].sort((left, right) => {
    if (
      !left
      || typeof left !== 'object'
      || Array.isArray(left)
      || !right
      || typeof right !== 'object'
      || Array.isArray(right)
    ) return 0
    const leftPackage = left as Record<string, unknown>
    const rightPackage = right as Record<string, unknown>
    return Number(leftPackage.packageSequence)
      - Number(rightPackage.packageSequence)
      || String(leftPackage.packageKey)
        .localeCompare(String(rightPackage.packageKey))
  })
  try {
    const exactOptimizerInput = optimizerInput as FulfillmentOptimizationInputV1
    validateFulfillmentOptimizationInput(exactOptimizerInput)
    const retainedProfilesByLine = new Map<string, {
      productGlobalId: string
      quantity: number
      unitDimensionsMm: CartonizationRateEvidenceDimensionsMm
      unitWeightGrams: number
    }>()
    for (const packageInput of orToolsPackages) {
      for (const profile of packageInput.orToolsProfiles) {
        const retained = retainedProfilesByLine.get(profile.lineGlobalId)
        if (
          retained
          && (
            retained.productGlobalId !== profile.productGlobalId
            || !sameMaterialRateDimensions(
              retained.unitDimensionsMm,
              profile.unitDimensionsMm,
            )
            || retained.unitWeightGrams !== profile.unitWeightGrams
          )
        ) {
          fail(
            'OR-Tools packages retain inconsistent profile facts for one order line',
            400,
            'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
          )
        }
        retainedProfilesByLine.set(profile.lineGlobalId, {
          productGlobalId: profile.productGlobalId,
          quantity: (retained?.quantity || 0) + profile.quantity,
          unitDimensionsMm: profile.unitDimensionsMm,
          unitWeightGrams: profile.unitWeightGrams,
        })
      }
    }
    if (
      exactOptimizerInput.lines.length !== retainedProfilesByLine.size
      || exactOptimizerInput.lines.some((line) => {
        const profile = retainedProfilesByLine.get(line.lineGlobalId)
        return (
          !profile
          || line.productGlobalId !== profile.productGlobalId
          || line.quantity !== profile.quantity
          || line.rotationAllowed !== false
          || !sameMaterialRateDimensions(
            line.unitDimensionsMm,
            profile.unitDimensionsMm,
          )
          || line.unitWeightGrams !== profile.unitWeightGrams
        )
      })
    ) {
      fail(
        'Optimizer demand does not match the retained exact package profile evidence',
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
      )
    }
    const optimizerInputHash = canonicalOptimizerHash(optimizerInput)
    const parsedResult = parseFulfillmentOptimizationResult(
      optimizerResult,
      exactOptimizerInput,
      { deadlineMs: 10_000, maxCandidates: 8 },
      optimizerInputHash,
      'or_tools',
    )
    const transformationHash = canonicalOptimizerHash(retainedPackages)
    if (
      retainedEvidence.optimizerMethod !== 'or_tools'
      || retainedEvidence.optimizerInputHash !== optimizerInputHash
      || parsedResult.inputHash !== optimizerInputHash
      || !['optimal', 'feasible'].includes(parsedResult.status)
      || !parsedResult.selectedPlan
      || selectedPlanId !== retainedEvidence.selectedPlanId
      || parsedResult.algorithmVersion
        !== retainedEvidence.optimizerAlgorithmVersion
      || retainedEvidence.transformationHash !== transformationHash
      || canonicalOptimizerHash(writePackages) !== transformationHash
    ) {
      fail(
        'Operational OR-Tools optimizer and transformed package provenance do not match',
        400,
        'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
      )
    }
  } catch (error) {
    if (error instanceof CartonizationRateEvidencePersistenceError) {
      throw error
    }
    fail(
      'Operational OR-Tools provenance is not canonical',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROVENANCE_INVALID',
    )
  }
}

export function assertCartonizationRateEvidenceCarrierCoverage(
  input: Pick<
    CartonizationRateEvidenceWriteInput,
    'requiredCarrierProviders' | 'packages' | 'quotes'
  >,
) {
  const requiredCarrierProviders = input.requiredCarrierProviders
  const providerSignature = Array.isArray(requiredCarrierProviders)
    ? requiredCarrierProviders.join(',')
    : ''
  if (![
    'ups_rest',
    'fedex_rest',
    'ups_rest,fedex_rest',
  ].includes(providerSignature)) {
    fail(
      'Cartonization rate evidence requires a canonical nonempty UPS and/or FedEx provider set',
      400,
      'CARTONIZATION_RATE_EVIDENCE_CARRIER_COVERAGE_INVALID',
    )
  }

  const packageKeys = new Set(input.packages.map((item) => item.packageKey))
  const quoteCounts = new Map<string, number>()
  if (
    packageKeys.size !== input.packages.length
    || !Array.isArray(input.quotes)
    || input.quotes.length
      !== input.packages.length * requiredCarrierProviders.length
  ) {
    fail(
      'Cartonization rate evidence requires exactly one quote from every retained carrier for every package',
      400,
      'CARTONIZATION_RATE_EVIDENCE_CARRIER_COVERAGE_INVALID',
    )
  }
  for (const quote of input.quotes) {
    if (
      !packageKeys.has(quote.packageKey)
      || !requiredCarrierProviders.includes(quote.provider)
    ) {
      fail(
        'Cartonization rate evidence contains a quote outside its retained package and carrier set',
        400,
        'CARTONIZATION_RATE_EVIDENCE_CARRIER_COVERAGE_INVALID',
      )
    }
    const key = `${quote.packageKey}:${quote.provider}`
    quoteCounts.set(key, (quoteCounts.get(key) || 0) + 1)
  }
  for (const packageKey of packageKeys) {
    for (const provider of requiredCarrierProviders) {
      if (quoteCounts.get(`${packageKey}:${provider}`) !== 1) {
        fail(
          'Cartonization rate evidence requires exactly one quote from every retained carrier for every package',
          400,
          'CARTONIZATION_RATE_EVIDENCE_CARRIER_COVERAGE_INVALID',
        )
      }
    }
  }
}

export function assertCartonizationRateEvidenceMaterialAssumptions(
  input: Pick<
    CartonizationRateEvidenceWriteInput,
    | 'evidenceMode'
    | 'materialRateAssumptions'
    | 'assumptionSnapshot'
    | 'planSnapshot'
    | 'packages'
  >,
) {
  const rawShadowTraining = input.planSnapshot.shadowTraining
  const shadowTraining = rawShadowTraining
    && typeof rawShadowTraining === 'object'
    && !Array.isArray(rawShadowTraining)
    ? rawShadowTraining as Record<string, unknown>
    : null
  if (
    rawShadowTraining !== undefined
    && (
      input.evidenceMode !== 'operational'
      || !shadowTraining
      || shadowTraining.version !== 'shadow-training-evidence-v1'
      || !/^gtrn(?:[0-9]{7}|[0-9a-v]{12})$/.test(
        String(shadowTraining.runGlobalId || ''),
      )
      || !Number.isSafeInteger(shadowTraining.runRowVersion)
      || Number(shadowTraining.runRowVersion) < 0
      || shadowTraining.assignmentPolicy !== 'local_simulation_only'
      || shadowTraining.commerceProviderWrites !== 0
      || shadowTraining.inventoryWrites !== 0
      || shadowTraining.packagingStockWrites !== 0
      || shadowTraining.productionPostage !== 0
    )
  ) {
    fail(
      'Shadow training evidence authorization is invalid',
      400,
      'CARTONIZATION_RATE_EVIDENCE_SHADOW_TRAINING_INVALID',
    )
  }
  const sandboxFixedAxisPackageKeys = input.packages
    .filter((item) => item.planningMethod === 'sandbox_fixed_axis')
    .map((item) => item.packageKey)
    .sort()
  if (
    sandboxFixedAxisPackageKeys.length > 0
    && input.evidenceMode !== 'assumption_backed_sandbox'
  ) {
    fail(
      'Sandbox fixed-axis packages are forbidden in operational evidence',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN',
    )
  }
  if (sandboxFixedAxisPackageKeys.length > 0) {
    const assumptionGeometry = input.assumptionSnapshot
      .sandboxGeometryRatePlan
    const planGeometry = input.planSnapshot.sandboxGeometryRatePlan
    if (
      input.assumptionSnapshot.watermark
        !== 'ASSUMPTION-BACKED SANDBOX EVIDENCE - NOT EXECUTABLE OR ACTUAL BILLED COST'
      || !assumptionGeometry
      || typeof assumptionGeometry !== 'object'
      || Array.isArray(assumptionGeometry)
      || !planGeometry
      || typeof planGeometry !== 'object'
      || Array.isArray(planGeometry)
    ) {
      fail(
        'Sandbox fixed-axis packages require retained watermarked geometry evidence',
        400,
        'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_EVIDENCE_INVALID',
      )
    }
    const assumptionRecord = assumptionGeometry as Record<string, unknown>
    const planRecord = planGeometry as Record<string, unknown>
    const planEvidence = planRecord.evidence
    const planPackages = planRecord.packages
    const retainedPackageKeys = Array.isArray(assumptionRecord.packageKeys)
      ? [...assumptionRecord.packageKeys].sort()
      : []
    const plannedPackageKeys = Array.isArray(planPackages)
      ? planPackages.map((item) => (
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>).packageKey
            : null
        )).sort()
      : []
    if (
      assumptionRecord.policyVersion
        !== 'sandbox-fixed-axis-one-unit-per-parcel-v1'
      || assumptionRecord.fitEnvelopeBasis
        !== 'retained_material_fit_dimensions'
      || assumptionRecord.rotationAllowed !== false
      || assumptionRecord.unitsPerPackage !== 1
      || assumptionRecord.materialStockAuthority
        !== 'not_used_for_sandbox_comparison'
      || !planEvidence
      || typeof planEvidence !== 'object'
      || cartonizationRateEvidenceHash(planEvidence)
        !== cartonizationRateEvidenceHash({
          policyVersion: assumptionRecord.policyVersion,
          fitEnvelopeBasis: assumptionRecord.fitEnvelopeBasis,
          rotationAllowed: assumptionRecord.rotationAllowed,
          unitsPerPackage: assumptionRecord.unitsPerPackage,
          materialStockAuthority:
            assumptionRecord.materialStockAuthority,
        })
      || cartonizationRateEvidenceHash(retainedPackageKeys)
        !== cartonizationRateEvidenceHash(sandboxFixedAxisPackageKeys)
      || cartonizationRateEvidenceHash(plannedPackageKeys)
        !== cartonizationRateEvidenceHash(sandboxFixedAxisPackageKeys)
    ) {
      fail(
        'Sandbox fixed-axis package provenance does not match the retained plan',
        400,
        'CARTONIZATION_RATE_EVIDENCE_SANDBOX_GEOMETRY_EVIDENCE_INVALID',
      )
    }
  }
  if (
    input.evidenceMode === 'operational'
    && input.planSnapshot.carrierReadEnvironment !== 'sandbox'
  ) {
    fail(
      'Development operational evidence must explicitly retain its sandbox carrier-read environment',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_RATE_ENVIRONMENT_INVALID',
    )
  }
  if (
    !Array.isArray(input.materialRateAssumptions)
    || input.materialRateAssumptions.length < 1
    || input.materialRateAssumptions.length > 8
  ) {
    fail(
      'Cartonization rate evidence requires assumptions for one to eight packaging materials',
      400,
      'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_INVALID',
    )
  }
  const assumptionsByMaterial = new Map<
    string,
    CartonizationRateEvidenceMaterialRateAssumption
  >()
  for (const assumption of input.materialRateAssumptions) {
    if (
      !/^gmat(?:[0-9]{7}|[0-9a-v]{12})$/.test(assumption?.materialGlobalId || '')
      || !Number.isSafeInteger(assumption?.expectedRowVersion)
      || assumption.expectedRowVersion < 0
      || !exactMaterialRateDimensions(
        assumption?.ratedOuterDimensionsMm,
      )
      || !Number.isSafeInteger(assumption?.tareWeightGrams)
      || assumption.tareWeightGrams <= 0
      || (
        input.evidenceMode === 'operational'
        && (
          !assumption.operationalFacts
          || ![
            'carton',
            'poly_mailer',
            'padded_mailer',
          ].includes(assumption.operationalFacts.materialType)
          || !exactMaterialRateDimensions(
            assumption.operationalFacts.innerDimensionsMm,
          )
          || !Number.isSafeInteger(
            assumption.operationalFacts.maximumGrossWeightGrams,
          )
          || assumption.operationalFacts.maximumGrossWeightGrams
            <= assumption.tareWeightGrams
          || !Number.isSafeInteger(
            assumption.operationalFacts.unitCostMinor,
          )
          || assumption.operationalFacts.unitCostMinor <= 0
          || !/^[A-Z]{3}$/.test(
            assumption.operationalFacts.currency,
          )
          || (
            shadowTraining === null
            && (
              !assumption.operationalFacts.stock
              || !Number.isSafeInteger(
                assumption.operationalFacts.stock.rowVersion,
              )
              || assumption.operationalFacts.stock.rowVersion < 0
              || !Number.isSafeInteger(
                assumption.operationalFacts.stock.onHandQuantity,
              )
              || assumption.operationalFacts.stock.onHandQuantity < 0
              || !Number.isSafeInteger(
                assumption.operationalFacts.stock.activeClaimedQuantity,
              )
              || assumption.operationalFacts.stock.activeClaimedQuantity < 0
              || assumption.operationalFacts.stock.availableQuantity
                !== assumption.operationalFacts.stock.onHandQuantity
                  - assumption.operationalFacts.stock.activeClaimedQuantity
              || assumption.operationalFacts.stock.availableQuantity <= 0
            )
          )
          || (
            shadowTraining !== null
            && assumption.operationalFacts.stock !== null
          )
        )
      )
      || (
        input.evidenceMode === 'assumption_backed_sandbox'
        && assumption.operationalFacts !== null
      )
      || assumptionsByMaterial.has(assumption.materialGlobalId)
    ) {
      fail(
        'Cartonization material rate assumptions must be unique and exact',
        400,
        'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_INVALID',
      )
    }
    assumptionsByMaterial.set(assumption.materialGlobalId, assumption)
  }
  const canonicalAssumptions = [...assumptionsByMaterial.values()].sort(
    (left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ),
  )
  const retainedAssumptions = input.evidenceMode === 'operational'
    ? input.assumptionSnapshot.operationalMaterialFacts
    : input.assumptionSnapshot.materialRateAssumptions
  if (
    input.evidenceMode === 'operational'
    && Object.hasOwn(input.assumptionSnapshot, 'materialRateAssumptions')
  ) {
    fail(
      'Operational evidence cannot retain sandbox material assumptions',
      400,
      'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN',
    )
  }
  if (
    !Array.isArray(retainedAssumptions)
    || cartonizationRateEvidenceHash(retainedAssumptions)
      !== cartonizationRateEvidenceHash(canonicalAssumptions)
  ) {
    fail(
      'The retained material assumptions do not match the rating request',
      400,
      'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_INVALID',
    )
  }
  for (const packageInput of input.packages) {
    const assumption = assumptionsByMaterial.get(
      packageInput.packagingMaterialGlobalId,
    )
    if (
      !assumption
      || assumption.expectedRowVersion
        !== packageInput.materialRowVersion
      || !sameMaterialRateDimensions(
        assumption.ratedOuterDimensionsMm,
        packageInput.ratedOuterDimensionsMm,
      )
      || assumption.tareWeightGrams
        !== packageInput.tareWeightGrams
      || (
        input.evidenceMode === 'operational'
        && (
          !assumption.operationalFacts
          || !sameMaterialRateDimensions(
            assumption.operationalFacts.innerDimensionsMm,
            packageInput.innerDimensionsMm,
          )
          || assumption.operationalFacts.maximumGrossWeightGrams
            !== packageInput.maxWeightGrams
        )
      )
    ) {
      fail(
        `${packageInput.packageKey} does not match its selected material assumptions`,
        400,
        'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH',
      )
    }
  }
}

export function cartonizationRateEvidenceRequestHash(
  input: Omit<
    CartonizationRateEvidenceWriteInput,
    'quotes' | 'status' | 'actorEmail' | 'idempotencyKey'
      | 'semanticRequestHash'
  >,
) {
  const packages = [...input.packages].sort(
    (left, right) => (
      left.packageSequence - right.packageSequence
      || left.packageKey.localeCompare(right.packageKey)
    ),
  )
  const materialRateAssumptions = [...input.materialRateAssumptions].sort(
    (left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ),
  )
  return cartonizationRateEvidenceHash({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    candidateGlobalId: input.candidateGlobalId,
    candidateRowVersion: input.candidateRowVersion,
    destinationFingerprint: input.destinationFingerprint,
    warehouseGlobalId: input.warehouseGlobalId,
    inventorySyncRunGlobalId: input.inventorySyncRunGlobalId,
    evidenceMode: input.evidenceMode,
    requiredCarrierProviders: input.requiredCarrierProviders,
    rateScope: 'multi_package_shipment',
    carrierRatePurpose: 'cartonization_shipment_rate',
    policyVersion: input.policyVersion,
    algorithmVersion: input.algorithmVersion,
    planInputHash: input.planInputHash,
    planResultHash: input.planResultHash,
    planSnapshot: input.planSnapshot,
    assumptionSnapshot: input.assumptionSnapshot,
    materialRateAssumptions,
    packages,
  })
}

export function cartonizationPackageRateContextHash(input: {
  provider: CartonizationRateEvidenceCarrierProvider
  destinationFingerprint: string
  parcel: CarrierSandboxParcel
}) {
  return cartonizationRateEvidenceHash({
    version: 'cartonization-package-rate-context-v1',
    provider: input.provider,
    purpose: 'cartonization_package_rate',
    destinationFingerprint: input.destinationFingerprint,
    parcel: input.parcel,
  })
}

export function cartonizationShipmentRateContextHash(input: {
  provider: CartonizationRateEvidenceCarrierProvider
  destinationFingerprint: string
  parcels: CarrierSandboxParcel[]
}) {
  return cartonizationRateEvidenceHash({
    version: 'cartonization-shipment-rate-context-v1',
    provider: input.provider,
    purpose: 'cartonization_shipment_rate',
    destinationFingerprint: input.destinationFingerprint,
    parcels: input.parcels,
  })
}

function destinationText(
  value: unknown,
  label: string,
  maximum: number,
  optional = false,
) {
  if (value === null || value === undefined || value === '') {
    if (optional) return ''
    fail(
      `The confirmed ship-to ${label} is missing`,
      409,
      'CARTONIZATION_RATE_DESTINATION_REQUIRED',
    )
  }
  if (
    typeof value !== 'string'
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      `The confirmed ship-to ${label} is invalid`,
      409,
      'CARTONIZATION_RATE_DESTINATION_INVALID',
    )
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if ((!optional && !normalized) || normalized.length > maximum) {
    fail(
      `The confirmed ship-to ${label} is invalid`,
      409,
      'CARTONIZATION_RATE_DESTINATION_INVALID',
    )
  }
  return normalized
}

export async function readCartonizationRateCandidateContext(input: {
  organizationId: string
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
}): Promise<CartonizationRateCandidateContext> {
  const result = await getPostgresPool().query<{
    organization_id: string
    account_global_id: string
    external_order_id: string
    source_hash: string
    row_version: string
    ship_to_snapshot_state: string
    ship_to_snapshot_ciphertext: Buffer | null
    ship_to_snapshot_iv: Buffer | null
    ship_to_snapshot_tag: Buffer | null
    canonical_order_global_id: string | null
  }>(
    `SELECT
       candidate.organization_id::text,
       account.global_id AS account_global_id,
       candidate.external_order_id,
       candidate.source_hash,
       candidate.row_version::text,
       candidate.ship_to_snapshot_state,
       candidate.ship_to_snapshot_ciphertext,
       candidate.ship_to_snapshot_iv,
       candidate.ship_to_snapshot_tag,
       canonical_order.global_id AS canonical_order_global_id
     FROM operations_commerce_order_candidates candidate
     JOIN operations_integration_accounts account
       ON account.organization_id = candidate.organization_id
      AND account.id = candidate.integration_account_id
     LEFT JOIN operations_orders canonical_order
       ON canonical_order.organization_id = candidate.organization_id
      AND canonical_order.id = candidate.canonical_order_id
     WHERE candidate.organization_id = $1::uuid
       AND account.global_id = $2
       AND candidate.global_id = $3
     LIMIT 1`,
    [
      input.organizationId,
      input.accountGlobalId,
      input.candidateGlobalId,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    fail(
      'The selected order candidate is unavailable for this commerce account',
      404,
      'CARTONIZATION_RATE_CANDIDATE_NOT_FOUND',
    )
  }
  if (
    safeInteger(row.row_version, 'Candidate row version')
    !== input.expectedCandidateRowVersion
  ) {
    fail(
      'The selected order candidate changed; reload it before rating',
      409,
      'CARTONIZATION_RATE_CANDIDATE_REVISION_CONFLICT',
    )
  }
  const decrypted = row.canonical_order_global_id
    ? orderShipToStorageValue((
        await readOperationsOrderShipmentAddressInPostgres({
          organizationId: row.organization_id,
          orderGlobalId: row.canonical_order_global_id,
        })
      ).value)
    : (() => {
        if (
          row.ship_to_snapshot_state !== 'confirmed'
          || !row.ship_to_snapshot_ciphertext
          || !row.ship_to_snapshot_iv
          || !row.ship_to_snapshot_tag
        ) {
          fail(
            'Add the ship-to details needed to compare carrier rates',
            409,
            'CARTONIZATION_RATE_DESTINATION_REQUIRED',
          )
        }
        return decryptCommerceCandidateSnapshot(
          {
            ciphertext: row.ship_to_snapshot_ciphertext!,
            iv: row.ship_to_snapshot_iv!,
            tag: row.ship_to_snapshot_tag!,
          },
          row.organization_id,
          row.account_global_id,
          row.external_order_id,
          row.source_hash,
          'ship_to',
        )
      })()
  const destination = (() => {
    try {
      return normalizeCarrierSandboxParty({
        name: destinationText(decrypted.name, 'recipient name', 120),
        line1: destinationText(decrypted.line1, 'address line 1', 160),
        line2: destinationText(
          decrypted.line2,
          'address line 2',
          120,
          true,
        ) || null,
        city: destinationText(decrypted.city, 'city', 100),
        region: destinationText(decrypted.region, 'region', 64),
        postalCode: destinationText(
          decrypted.postalCode,
          'postal code',
          20,
        ),
        countryCode: destinationText(
          decrypted.country,
          'country code',
          3,
        ).toUpperCase(),
      })
    } catch (error) {
      fail(
        `The confirmed ship-to address is not carrier-ready: ${
          error instanceof Error ? error.message : 'invalid address'
        }`,
        409,
        'CARTONIZATION_RATE_DESTINATION_INVALID',
      )
    }
  })()
  return {
    candidateSourceHash: row.source_hash,
    destinationFingerprint: carrierSandboxPartyFingerprint(destination),
    destination,
  }
}

function assertHash(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a canonical SHA-256 hash`, 400)
  }
}

function mapEvidence(
  header: EvidenceHeaderRow,
  packageRows: EvidencePackageRow[],
  recipeRows: EvidenceRecipeRow[],
  orToolsProfileRows: EvidenceOrToolsProfileRow[],
  quoteRows: EvidenceQuoteRow[],
): CartonizationRateEvidence {
  const quotesByPackage = new Map<string, EvidenceQuoteRow[]>()
  for (const quote of quoteRows) {
    const current = quotesByPackage.get(quote.package_key) || []
    current.push(quote)
    quotesByPackage.set(quote.package_key, current)
  }
  const recipesByPackage = new Map<string, EvidenceRecipeRow[]>()
  for (const recipe of recipeRows) {
    const current = recipesByPackage.get(recipe.package_key) || []
    current.push(recipe)
    recipesByPackage.set(recipe.package_key, current)
  }
  const orToolsProfilesByPackage = new Map<
    string,
    EvidenceOrToolsProfileRow[]
  >()
  for (const profile of orToolsProfileRows) {
    const current = orToolsProfilesByPackage.get(profile.package_key) || []
    current.push(profile)
    orToolsProfilesByPackage.set(profile.package_key, current)
  }
  const shipmentRates = header.required_carrier_providers.flatMap((provider) => {
    const providerQuotes = quoteRows.filter(
      (quote) => quote.provider === provider,
    )
    const first = providerQuotes[0]
    if (
      !first
      || first.redacted_response?.rateScope
        !== 'multi_package_shipment'
      || providerQuotes.some((quote) => (
        quote.rate_evidence_global_id
          !== first.rate_evidence_global_id
        || quote.package_rate_context_hash
          !== first.package_rate_context_hash
      ))
    ) {
      return []
    }
    return [{
      provider,
      rateEvidenceGlobalId: first.rate_evidence_global_id,
      status: first.quote_status,
      errorCode: first.error_code,
      carrierRequestHash: first.carrier_request_hash,
      shipmentRateContextHash: first.package_rate_context_hash,
      packageCount: first.redacted_response.packageCount
        || providerQuotes.length,
      packageKeys: packageRows.map((row) => row.package_key),
      rates: Array.isArray(first.redacted_response?.rates)
        ? first.redacted_response.rates
        : [],
      requestedAt: timestamp(first.requested_at),
      completedAt: timestamp(first.completed_at),
    }]
  })
  return {
    globalId: header.global_id,
    accountGlobalId: header.account_global_id,
    candidateGlobalId: header.candidate_global_id,
    candidateOrderNumber: header.candidate_order_number,
    candidateRowVersion: safeInteger(
      header.candidate_row_version,
      'Candidate row version',
    ),
    candidateSourceHash: header.candidate_source_hash,
    destinationFingerprint: header.destination_fingerprint,
    requestHash: header.request_hash,
    warehouse: {
      globalId: header.warehouse_global_id,
      name: header.warehouse_name,
    },
    inventorySyncRunGlobalId: header.inventory_sync_run_global_id,
    evidenceMode: header.evidence_mode,
    requiredCarrierProviders: header.required_carrier_providers,
    policyVersion: header.policy_version,
    algorithmVersion: header.algorithm_version,
    planInputHash: header.plan_input_hash,
    planResultHash: header.plan_result_hash,
    planSnapshot: header.plan_snapshot,
    assumptionSnapshot: header.assumption_snapshot,
    status: header.status,
    idempotencyKey: header.idempotency_key,
    actorEmail: header.actor_email,
    createdAt: timestamp(header.created_at),
    shipmentRates,
    packages: packageRows.map((row) => {
      const packageRecipes = (recipesByPackage.get(row.package_key) || [])
        .map((recipe) => ({
          recipeGlobalId: recipe.recipe_global_id,
          recipeName: recipe.recipe_name_snapshot,
          productGlobalId: recipe.product_global_id,
          inputProfileVersionGlobalId:
            recipe.input_profile_version_global_id,
          recipeRowVersion: safeInteger(
            recipe.recipe_row_version,
            `${row.package_key} recipe row version`,
          ),
          inputProfileVersionRowVersion: safeInteger(
            recipe.input_profile_version_row_version,
            `${row.package_key} input profile row version`,
          ),
        }))
      const orToolsProfiles = (
        orToolsProfilesByPackage.get(row.package_key) || []
      ).map((profile) => ({
        lineGlobalId: profile.line_global_id,
        productGlobalId: profile.product_global_id,
        inputProfileVersionGlobalId:
          profile.input_profile_version_global_id,
        inputProfileVersionRowVersion: safeInteger(
          profile.input_profile_version_row_version,
          `${row.package_key} OR-Tools profile row version`,
        ),
        fitModel: profile.fit_model,
        unitDimensionsMm: profile.unit_dimensions_mm,
        unitWeightGrams: profile.unit_weight_grams,
        quantity: profile.quantity,
      }))
      return {
      packageKey: row.package_key,
      packageSequence: row.package_sequence,
      planningMethod: row.planning_method,
      packagingMaterialGlobalId: row.packaging_material_global_id,
      packagingMaterialName: row.packaging_material_name,
      approvedPackRecipeGlobalId:
        packageRecipes[0]?.recipeGlobalId
        || row.approved_pack_recipe_global_id,
      approvedPackRecipeName:
        packageRecipes[0]?.recipeName
        || row.approved_pack_recipe_name,
      materialRowVersion: safeInteger(
        row.material_row_version,
        `${row.package_key} material row version`,
      ),
      recipeRowVersion: row.recipe_row_version === null
        ? null
        : safeInteger(
            row.recipe_row_version,
            `${row.package_key} recipe row version`,
          ),
      recipes: packageRecipes,
      orToolsProfiles,
      innerDimensionsMm: row.inner_dimensions_mm,
      ratedOuterDimensionsMm: row.rated_outer_dimensions_mm,
      contentWeightGrams: row.content_weight_grams,
      tareWeightGrams: row.tare_weight_grams,
      ratedGrossWeightGrams: row.rated_gross_weight_grams,
      maxWeightGrams: row.max_weight_grams,
      allocations: row.allocations,
      carrierParcel: row.carrier_parcel_snapshot,
      packageHash: row.package_hash,
      quotes: (quotesByPackage.get(row.package_key) || []).map((quote) => ({
        provider: quote.provider,
        rateEvidenceGlobalId: quote.rate_evidence_global_id,
        status: quote.quote_status,
        errorCode: quote.error_code,
        carrierRequestHash: quote.carrier_request_hash,
        packageRateContextHash: quote.package_rate_context_hash,
        shipmentRateContextHash:
          quote.redacted_response?.rateScope
            === 'multi_package_shipment'
            ? quote.package_rate_context_hash
            : null,
        rateScope:
          quote.redacted_response?.rateScope
            === 'multi_package_shipment'
            ? 'multi_package_shipment'
            : 'single_package',
        rates: Array.isArray(quote.redacted_response?.rates)
          ? quote.redacted_response.rates
          : [],
        requestedAt: timestamp(quote.requested_at),
        completedAt: timestamp(quote.completed_at),
      })),
      }
    }),
  }
}

async function readEvidenceRows(
  organizationId: string,
  whereSql: string,
  value: string,
) {
  const client = await getPostgresPool().connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const headerResult = await client.query<EvidenceHeaderRow>(
      `SELECT
         evidence.id::text,
         evidence.global_id,
         account.global_id AS account_global_id,
         candidate.global_id AS candidate_global_id,
         candidate.order_number_snapshot AS candidate_order_number,
         evidence.candidate_row_version::text,
         evidence.candidate_source_hash,
         evidence.destination_fingerprint,
         evidence.request_hash,
         warehouse.global_id AS warehouse_global_id,
         warehouse.name AS warehouse_name,
         inventory_run.global_id AS inventory_sync_run_global_id,
         evidence.evidence_mode,
         evidence.required_carrier_providers,
         evidence.policy_version,
         evidence.algorithm_version,
         evidence.plan_input_hash,
         evidence.plan_result_hash,
         evidence.plan_snapshot,
         evidence.assumption_snapshot,
         evidence.status,
         evidence.idempotency_key,
         evidence.actor_email,
         evidence.created_at
       FROM operations_cartonization_rate_evidence evidence
       JOIN operations_integration_accounts account
         ON account.organization_id = evidence.organization_id
        AND account.id = evidence.integration_account_id
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = evidence.organization_id
        AND candidate.integration_account_id = evidence.integration_account_id
        AND candidate.id = evidence.order_candidate_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = evidence.organization_id
        AND warehouse.id = evidence.warehouse_id
       LEFT JOIN operations_commerce_inventory_sync_runs inventory_run
         ON inventory_run.organization_id = evidence.organization_id
        AND inventory_run.id = evidence.inventory_sync_run_id
       WHERE evidence.organization_id = $1::uuid
         AND evidence.sealed_at IS NOT NULL
         AND ${whereSql}
       LIMIT 1`,
      [organizationId, value],
    )
    const header = headerResult.rows[0]
    if (!header) {
      await client.query('COMMIT')
      return null
    }
    const [
      packageResult,
      recipeResult,
      orToolsProfileResult,
      quoteResult,
    ] = await Promise.all([
      client.query<EvidencePackageRow>(
        `SELECT
           package.package_key,
           package.package_sequence,
           package.planning_method,
           material.global_id AS packaging_material_global_id,
           material.name AS packaging_material_name,
           recipe.global_id AS approved_pack_recipe_global_id,
           recipe.recipe_name AS approved_pack_recipe_name,
           package.material_row_version::text,
           package.recipe_row_version::text,
           package.inner_dimensions_mm,
           package.rated_outer_dimensions_mm,
           package.content_weight_grams,
           package.tare_weight_grams,
           package.rated_gross_weight_grams,
           package.max_weight_grams,
           package.allocations,
           package.carrier_parcel_snapshot,
           package.package_hash
         FROM operations_cartonization_rate_evidence_packages package
         JOIN operations_packaging_materials material
           ON material.organization_id = package.organization_id
          AND material.id = package.packaging_material_id
         LEFT JOIN operations_approved_pack_recipes recipe
           ON recipe.organization_id = package.organization_id
          AND recipe.packaging_material_id = package.packaging_material_id
          AND recipe.id = package.approved_pack_recipe_id
         WHERE package.organization_id = $1::uuid
           AND package.evidence_id = $2::uuid
        ORDER BY package.package_sequence, package.package_key`,
        [organizationId, header.id],
      ),
      client.query<EvidenceRecipeRow>(
        `SELECT
           recipe_edge.package_key,
           recipe_edge.recipe_global_id,
           recipe_edge.recipe_name_snapshot,
           recipe_edge.product_global_id,
           recipe_edge.input_profile_version_global_id,
           recipe_edge.recipe_row_version::text,
           recipe_edge.input_profile_version_row_version::text
         FROM operations_cartonization_rate_evidence_package_recipes
           recipe_edge
         WHERE recipe_edge.organization_id = $1::uuid
           AND recipe_edge.evidence_id = $2::uuid
         ORDER BY
           recipe_edge.package_key, recipe_edge.recipe_global_id`,
        [organizationId, header.id],
      ),
      client.query<EvidenceOrToolsProfileRow>(
        `SELECT
           profile_edge.package_key,
           profile_edge.line_global_id,
           profile_edge.product_global_id,
           profile_edge.input_profile_version_global_id,
           profile_edge.input_profile_version_row_version::text,
           profile_edge.fit_model,
           profile_edge.unit_dimensions_mm,
           profile_edge.unit_weight_grams,
           profile_edge.quantity
         FROM operations_cartonization_rate_evidence_package_profiles
           profile_edge
         WHERE profile_edge.organization_id = $1::uuid
           AND profile_edge.evidence_id = $2::uuid
         ORDER BY
           profile_edge.package_key, profile_edge.line_global_id`,
        [organizationId, header.id],
      ),
      client.query<EvidenceQuoteRow>(
        `SELECT
           quote.package_key,
           quote.provider,
           rate.global_id AS rate_evidence_global_id,
           quote.quote_status,
           quote.error_code,
           quote.carrier_request_hash,
           quote.package_rate_context_hash,
           rate.redacted_response,
           rate.requested_at,
           rate.completed_at
         FROM operations_cartonization_rate_evidence_quotes quote
         JOIN operations_carrier_rate_requests rate
           ON rate.organization_id = quote.organization_id
          AND rate.provider = quote.provider
          AND rate.purpose = quote.rate_purpose
          AND rate.id = quote.carrier_rate_request_id
         WHERE quote.organization_id = $1::uuid
           AND quote.evidence_id = $2::uuid
         ORDER BY quote.package_key, quote.provider`,
        [organizationId, header.id],
      ),
    ])
    await client.query('COMMIT')
    return mapEvidence(
      header,
      packageResult.rows,
      recipeResult.rows,
      orToolsProfileResult.rows,
      quoteResult.rows,
    )
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original read error.
    }
    throw error
  } finally {
    client.release()
  }
}

export function readCartonizationRateEvidenceByGlobalId(input: {
  organizationId: string
  evidenceGlobalId: string
}) {
  return readEvidenceRows(
    input.organizationId,
    'evidence.global_id = $2',
    input.evidenceGlobalId,
  )
}

export function readCartonizationRateEvidenceByIdempotencyKey(input: {
  organizationId: string
  idempotencyKey: string
}) {
  return readEvidenceRows(
    input.organizationId,
    'evidence.idempotency_key = $2',
    input.idempotencyKey,
  )
}

export async function claimCartonizationRateEvidenceCommandInPostgres(
  input: {
    organizationId: string
    idempotencyKey: string
    semanticRequestHash: string
    actorEmail: string
  },
): Promise<CartonizationRateEvidenceCommandClaim> {
  assertHash(input.semanticRequestHash, 'Semantic request hash')
  return withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `cartonization-rate-evidence:${input.organizationId}:${input.idempotencyKey}`,
    )
    const current = await client.query<{
      semantic_request_hash: string
      state: 'pending' | 'completed' | 'failed'
      evidence_global_id: string | null
      error_code: string | null
    }>(
      `SELECT
         command.semantic_request_hash,
         command.state,
         evidence.global_id AS evidence_global_id,
         command.error_code
       FROM operations_cartonization_rate_evidence_commands command
       LEFT JOIN operations_cartonization_rate_evidence evidence
         ON evidence.organization_id = command.organization_id
        AND evidence.id = command.evidence_id
        AND evidence.sealed_at IS NOT NULL
       WHERE command.organization_id = $1::uuid
         AND command.idempotency_key = $2
       LIMIT 1
       FOR UPDATE OF command`,
      [input.organizationId, input.idempotencyKey],
    )
    const row = current.rows[0]
    if (row) {
      if (row.semantic_request_hash !== input.semanticRequestHash) {
        fail(
          'The idempotency key is already bound to a different cartonization request',
          409,
          'CARTONIZATION_RATE_EVIDENCE_IDEMPOTENCY_CONFLICT',
        )
      }
      if (row.state === 'completed') {
        if (!row.evidence_global_id) {
          fail(
            'Completed cartonization evidence command lost its sealed aggregate',
            500,
            'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
          )
        }
        return {
          state: 'completed',
          evidenceGlobalId: row.evidence_global_id,
        }
      }
      if (row.state === 'failed') {
        return {
          state: 'failed',
          errorCode: row.error_code
            || 'CARTONIZATION_RATE_EVIDENCE_PREVIOUS_ATTEMPT_FAILED',
        }
      }
      return { state: 'pending' }
    }
    await client.query(
      `INSERT INTO operations_cartonization_rate_evidence_commands (
         organization_id, idempotency_key, semantic_request_hash,
         actor_email
       ) VALUES ($1::uuid, $2, $3, $4)`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.semanticRequestHash,
        input.actorEmail,
      ],
    )
    return { state: 'claimed' }
  })
}

export async function failCartonizationRateEvidenceCommandInPostgres(
  input: {
    organizationId: string
    idempotencyKey: string
    semanticRequestHash: string
    errorCode: string
  },
) {
  assertHash(input.semanticRequestHash, 'Semantic request hash')
  const errorCode = input.errorCode.trim().slice(0, 128)
  if (!/^[A-Z0-9_]{3,128}$/.test(errorCode)) {
    fail('Cartonization evidence command failure code is invalid', 500)
  }
  await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `cartonization-rate-evidence:${input.organizationId}:${input.idempotencyKey}`,
    )
    await client.query(
      `UPDATE operations_cartonization_rate_evidence_commands
       SET state = 'failed',
           error_code = $4,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND idempotency_key = $2
         AND semantic_request_hash = $3
         AND state = 'pending'`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.semanticRequestHash,
        errorCode,
      ],
    )
  })
}

export async function writeCartonizationRateEvidenceInPostgres(
  input: CartonizationRateEvidenceWriteInput,
) {
  assertHash(input.planInputHash, 'Plan input hash')
  assertHash(input.planResultHash, 'Plan result hash')
  if (!Array.isArray(input.packages) || input.packages.length < 1) {
    fail('Cartonization rate evidence requires at least one package', 400)
  }
  if (input.packages.length > MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES) {
    fail(
      `Cartonization rate evidence supports at most ${
        MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES
      } packages`,
      400,
    )
  }
  assertCartonizationRateEvidenceCarrierCoverage(input)
  assertCartonizationRateEvidenceOrToolsProfiles(input)
  assertCartonizationRateEvidenceOperationalGeometryProvenance(input)
  assertCartonizationRateEvidenceMaterialAssumptions(input)
  const shadowTrainingEvidence = Object.hasOwn(
    input.planSnapshot,
    'shadowTraining',
  )
  const inputPlanResultHash = cartonizationRateEvidenceHash(input.planSnapshot)
  if (inputPlanResultHash !== input.planResultHash) {
    fail('Plan result hash does not match the exact plan snapshot', 400)
  }
  const requestHash = cartonizationRateEvidenceRequestHash(input)
  assertHash(input.semanticRequestHash, 'Semantic request hash')
  const writeToken = randomUUID()
  const writeTokenHash = createHash('sha256')
    .update(writeToken)
    .digest('hex')

  const globalId = await withTransaction(async (client) => {
    await acquireTransactionAdvisoryLock(
      client,
      `cartonization-rate-evidence:${input.organizationId}:${input.idempotencyKey}`,
    )
    const command = await client.query<{
      semantic_request_hash: string
      state: 'pending' | 'completed' | 'failed'
      evidence_global_id: string | null
    }>(
      `SELECT
         command.semantic_request_hash,
         command.state,
         evidence.global_id AS evidence_global_id
       FROM operations_cartonization_rate_evidence_commands command
       LEFT JOIN operations_cartonization_rate_evidence evidence
         ON evidence.organization_id = command.organization_id
        AND evidence.id = command.evidence_id
        AND evidence.sealed_at IS NOT NULL
       WHERE command.organization_id = $1::uuid
         AND command.idempotency_key = $2
       LIMIT 1
       FOR UPDATE OF command`,
      [input.organizationId, input.idempotencyKey],
    )
    const commandRow = command.rows[0]
    if (!commandRow) {
      fail(
        'Cartonization evidence command was not reserved before carrier rating',
        409,
        'CARTONIZATION_RATE_EVIDENCE_COMMAND_REQUIRED',
      )
    }
    if (commandRow.semantic_request_hash !== input.semanticRequestHash) {
        fail(
          'The idempotency key is already bound to different cartonization evidence',
          409,
          'CARTONIZATION_RATE_EVIDENCE_IDEMPOTENCY_CONFLICT',
        )
    }
    if (commandRow.state === 'completed' && commandRow.evidence_global_id) {
      return commandRow.evidence_global_id
    }
    if (commandRow.state !== 'pending') {
      fail(
        'The cartonization evidence command is already terminal',
        409,
        'CARTONIZATION_RATE_EVIDENCE_COMMAND_TERMINAL',
      )
    }

    const context = await client.query<{
      integration_account_id: string
      candidate_id: string
      candidate_row_version: string
      candidate_source_hash: string
      account_global_id: string
      external_order_id: string
      ship_to_snapshot_state: string
      ship_to_snapshot_ciphertext: Buffer | null
      ship_to_snapshot_iv: Buffer | null
      ship_to_snapshot_tag: Buffer | null
      canonical_order_global_id: string | null
      warehouse_id: string
      inventory_sync_run_id: string | null
    }>(
      `SELECT
         account.id::text AS integration_account_id,
         candidate.id::text AS candidate_id,
         candidate.row_version::text AS candidate_row_version,
         candidate.source_hash AS candidate_source_hash,
         account.global_id AS account_global_id,
         candidate.external_order_id,
         candidate.ship_to_snapshot_state,
         candidate.ship_to_snapshot_ciphertext,
         candidate.ship_to_snapshot_iv,
         candidate.ship_to_snapshot_tag,
         canonical_order.global_id AS canonical_order_global_id,
         warehouse.id::text AS warehouse_id,
         inventory_run.id::text AS inventory_sync_run_id
       FROM operations_integration_accounts account
       JOIN operations_commerce_order_candidates candidate
         ON candidate.organization_id = account.organization_id
        AND candidate.integration_account_id = account.id
        AND candidate.global_id = $3
       LEFT JOIN operations_orders canonical_order
         ON canonical_order.organization_id = candidate.organization_id
        AND canonical_order.id = candidate.canonical_order_id
       JOIN operations_warehouses warehouse
         ON warehouse.organization_id = account.organization_id
        AND warehouse.global_id = $5
       LEFT JOIN operations_commerce_inventory_sync_runs inventory_run
         ON inventory_run.organization_id = account.organization_id
        AND inventory_run.integration_account_id = account.id
        AND inventory_run.warehouse_id = warehouse.id
        AND inventory_run.global_id = $6
       WHERE account.organization_id = $1::uuid
         AND account.global_id = $2
         AND candidate.row_version = $4
         AND (
           $6::text IS NULL
           OR inventory_run.global_id IS NOT NULL
         )
       LIMIT 1
       FOR SHARE OF account, candidate, warehouse`,
      [
        input.organizationId,
        input.accountGlobalId,
        input.candidateGlobalId,
        input.candidateRowVersion,
        input.warehouseGlobalId,
        input.inventorySyncRunGlobalId,
      ],
    )
    const exactContext = context.rows[0]
    if (!exactContext) {
      fail(
        'The account, candidate, warehouse, or inventory evidence changed before the proof could be saved',
        409,
        'CARTONIZATION_RATE_EVIDENCE_REVISION_CONFLICT',
      )
    }
    const exactDestinationSnapshot = exactContext.canonical_order_global_id
      ? orderShipToStorageValue((
          await readOperationsOrderShipmentAddressInPostgres({
            organizationId: input.organizationId,
            orderGlobalId: exactContext.canonical_order_global_id,
            client,
            lock: true,
          })
        ).value)
      : (() => {
          if (
            exactContext.ship_to_snapshot_state !== 'confirmed'
            || !exactContext.ship_to_snapshot_ciphertext
            || !exactContext.ship_to_snapshot_iv
            || !exactContext.ship_to_snapshot_tag
          ) {
            fail(
              'The destination changed before the proof could be saved',
              409,
              'CARTONIZATION_RATE_DESTINATION_STALE',
            )
          }
          return decryptCommerceCandidateSnapshot(
            {
              ciphertext: exactContext.ship_to_snapshot_ciphertext!,
              iv: exactContext.ship_to_snapshot_iv!,
              tag: exactContext.ship_to_snapshot_tag!,
            },
            input.organizationId,
            exactContext.account_global_id,
            exactContext.external_order_id,
            exactContext.candidate_source_hash,
            'ship_to',
          )
        })()
    const exactDestination = normalizeCarrierSandboxParty({
      name: destinationText(
        exactDestinationSnapshot.name,
        'recipient name',
        120,
      ),
      line1: destinationText(
        exactDestinationSnapshot.line1,
        'address line 1',
        160,
      ),
      line2: destinationText(
        exactDestinationSnapshot.line2,
        'address line 2',
        120,
        true,
      ) || null,
      city: destinationText(exactDestinationSnapshot.city, 'city', 100),
      region: destinationText(
        exactDestinationSnapshot.region,
        'region',
        16,
      ),
      postalCode: destinationText(
        exactDestinationSnapshot.postalCode,
        'postal code',
        20,
      ),
      countryCode: destinationText(
        exactDestinationSnapshot.country,
        'country code',
        3,
      ).toUpperCase(),
    })
    if (
      carrierSandboxPartyFingerprint(exactDestination)
      !== input.destinationFingerprint
    ) {
      fail(
        'The confirmed destination changed before the proof could be saved',
        409,
        'CARTONIZATION_RATE_DESTINATION_STALE',
      )
    }

    const packageContexts = new Map<string, {
      materialId: string
      recipes: Array<{
        recipeId: string
        recipeGlobalId: string
        recipeName: string
        recipeRowVersion: number
        productId: string
        productGlobalId: string
        inputProfileVersionId: string
        inputProfileVersionGlobalId: string
        inputProfileVersionRowVersion: number
      }>
      orToolsProfiles: Array<{
        lineGlobalId: string
        productGlobalId: string
        inputProfileVersionId: string
        inputProfileVersionGlobalId: string
        inputProfileVersionRowVersion: number
        fitModel: 'rigid_3d'
        unitDimensionsMm: CartonizationRateEvidenceDimensionsMm
        unitWeightGrams: number
        quantity: number
      }>
    }>()
    const packageSequences = new Set<number>()
    const requiredMaterialQuantities = input.packages.reduce(
      (counts, packageInput) => {
        counts.set(
          packageInput.packagingMaterialGlobalId,
          (counts.get(packageInput.packagingMaterialGlobalId) || 0) + 1,
        )
        return counts
      },
      new Map<string, number>(),
    )
    for (const packageInput of input.packages) {
      if (packageContexts.has(packageInput.packageKey)) {
        fail(`Duplicate package key ${packageInput.packageKey}`, 400)
      }
      if (packageSequences.has(packageInput.packageSequence)) {
        fail(`Duplicate package sequence ${packageInput.packageSequence}`, 400)
      }
      packageSequences.add(packageInput.packageSequence)
      assertHash(packageInput.packageHash, `${packageInput.packageKey} hash`)
      if (
        cartonizationRateEvidenceHash({
          packageKey: packageInput.packageKey,
          packageSequence: packageInput.packageSequence,
          planningMethod: packageInput.planningMethod,
          packagingMaterialGlobalId:
            packageInput.packagingMaterialGlobalId,
          materialRowVersion: packageInput.materialRowVersion,
          recipes: packageInput.recipes,
          orToolsProfiles: packageInput.orToolsProfiles,
          innerDimensionsMm: packageInput.innerDimensionsMm,
          ratedOuterDimensionsMm: packageInput.ratedOuterDimensionsMm,
          contentWeightGrams: packageInput.contentWeightGrams,
          tareWeightGrams: packageInput.tareWeightGrams,
          ratedGrossWeightGrams: packageInput.ratedGrossWeightGrams,
          maxWeightGrams: packageInput.maxWeightGrams,
          allocations: packageInput.allocations,
          carrierParcel: packageInput.carrierParcel,
        }) !== packageInput.packageHash
      ) {
        fail(`${packageInput.packageKey} hash does not match its package snapshot`, 400)
      }
      const resolvedMaterial = await client.query<{
        material_id: string
        status: 'draft' | 'active'
        rated_outer_length_mm: number | null
        rated_outer_width_mm: number | null
        rated_outer_height_mm: number | null
        rated_outer_dimension_evidence_type: string | null
        rated_outer_dimension_evidence_reference: string | null
        rated_outer_dimension_confirmed_at: Date | string | null
        material_type: 'carton' | 'poly_mailer' | 'padded_mailer'
        inner_length_mm: number | null
        inner_width_mm: number | null
        inner_height_mm: number | null
        tare_weight_grams: number | null
        max_weight_grams: number | null
        unit_cost_minor: string | null
        currency: string | null
      }>(
        `SELECT
           material.id::text AS material_id,
           material.status,
           material.rated_outer_length_mm,
           material.rated_outer_width_mm,
           material.rated_outer_height_mm,
           material.rated_outer_dimension_evidence_type,
           material.rated_outer_dimension_evidence_reference,
           material.rated_outer_dimension_confirmed_at,
           material.material_type,
           material.inner_length_mm,
           material.inner_width_mm,
           material.inner_height_mm,
           material.tare_weight_grams,
           material.max_weight_grams,
           material.unit_cost_minor::text,
           material.currency
         FROM operations_packaging_materials material
         WHERE material.organization_id = $1::uuid
           AND material.global_id = $2
           AND material.row_version = $3
         LIMIT 1
         FOR SHARE OF material`,
        [
          input.organizationId,
          packageInput.packagingMaterialGlobalId,
          packageInput.materialRowVersion,
        ],
      )
      const material = resolvedMaterial.rows[0]
      if (!material) {
        fail(
          `${packageInput.packageKey} material evidence changed`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_REVISION_CONFLICT',
        )
      }
      if (
        input.evidenceMode === 'operational'
        && (
          !input.materialRateAssumptions.find((assumption) => (
            assumption.materialGlobalId
              === packageInput.packagingMaterialGlobalId
          ))?.operationalFacts
          || material.status !== 'active'
          || material.rated_outer_length_mm
            !== packageInput.ratedOuterDimensionsMm.length
          || material.rated_outer_width_mm
            !== packageInput.ratedOuterDimensionsMm.width
          || material.rated_outer_height_mm
            !== packageInput.ratedOuterDimensionsMm.height
          || !['customer_confirmed', 'measured', 'provider'].includes(
            material.rated_outer_dimension_evidence_type || '',
          )
          || (
            material.rated_outer_dimension_evidence_type !== 'measured'
            && !material.rated_outer_dimension_evidence_reference?.trim()
          )
          || material.rated_outer_dimension_confirmed_at === null
          || material.tare_weight_grams !== packageInput.tareWeightGrams
        )
      ) {
        fail(
          `${packageInput.packageKey} does not match a current factual rated packaging measurement`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STALE',
        )
      }
      if (input.evidenceMode === 'operational') {
        const operationalFacts = input.materialRateAssumptions.find(
          (assumption) => (
            assumption.materialGlobalId
              === packageInput.packagingMaterialGlobalId
          ),
        )?.operationalFacts
        if (
          !operationalFacts
          || material.material_type !== operationalFacts.materialType
          || material.inner_length_mm
            !== operationalFacts.innerDimensionsMm.length
          || material.inner_width_mm
            !== operationalFacts.innerDimensionsMm.width
          || material.inner_height_mm
            !== operationalFacts.innerDimensionsMm.height
          || packageInput.innerDimensionsMm.length
            !== operationalFacts.innerDimensionsMm.length
          || packageInput.innerDimensionsMm.width
            !== operationalFacts.innerDimensionsMm.width
          || packageInput.innerDimensionsMm.height
            !== operationalFacts.innerDimensionsMm.height
          || material.max_weight_grams
            !== operationalFacts.maximumGrossWeightGrams
          || packageInput.maxWeightGrams
            !== operationalFacts.maximumGrossWeightGrams
          || Number(material.unit_cost_minor)
            !== operationalFacts.unitCostMinor
          || material.currency !== operationalFacts.currency
        ) {
          fail(
            `${packageInput.packagingMaterialGlobalId} exact operational material facts changed before evidence sealing`,
            409,
            'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STALE',
          )
        }
        if (!shadowTrainingEvidence) {
          const operationalStock = operationalFacts.stock
          if (!operationalStock) {
            fail(
              `${packageInput.packagingMaterialGlobalId} is missing operational stock evidence`,
              409,
              'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_STALE',
            )
          }
          const stock = await client.query<{
            is_available: boolean
            on_hand_quantity: number | null
            row_version: string
            active_claimed_quantity: string
          }>(
            `SELECT
               stock.is_available,
               stock.on_hand_quantity,
               stock.row_version::text,
               COALESCE((
                 SELECT sum(claim.quantity)
                 FROM operations_packaging_material_claims claim
                 WHERE claim.organization_id = stock.organization_id
                   AND claim.packaging_material_id =
                        stock.packaging_material_id
                   AND claim.warehouse_id = stock.warehouse_id
                   AND claim.status = 'active'
               ), 0)::text AS active_claimed_quantity
             FROM operations_packaging_material_stock stock
             WHERE stock.organization_id = $1::uuid
               AND stock.packaging_material_id = $2::uuid
               AND stock.warehouse_id = $3::uuid
             LIMIT 1
             FOR SHARE OF stock`,
            [
              input.organizationId,
              material.material_id,
              exactContext.warehouse_id,
            ],
          )
          const currentStock = stock.rows[0]
          const activeClaimedQuantity = currentStock
            ? safeInteger(
                currentStock.active_claimed_quantity,
                `${packageInput.packagingMaterialGlobalId} active claims`,
              )
            : 0
          const requiredQuantity = requiredMaterialQuantities.get(
            packageInput.packagingMaterialGlobalId,
          ) || 0
          if (
            !currentStock
            || currentStock.is_available !== true
            || currentStock.on_hand_quantity === null
            || safeInteger(
              currentStock.row_version,
              `${packageInput.packagingMaterialGlobalId} stock row version`,
            ) !== operationalStock.rowVersion
            || currentStock.on_hand_quantity
              !== operationalStock.onHandQuantity
            || activeClaimedQuantity
              !== operationalStock.activeClaimedQuantity
            || currentStock.on_hand_quantity - activeClaimedQuantity
              !== operationalStock.availableQuantity
            || currentStock.on_hand_quantity - activeClaimedQuantity
              < requiredQuantity
          ) {
            fail(
              `${packageInput.packagingMaterialGlobalId} has insufficient current stock for ${requiredQuantity} planned package(s)`,
              409,
              'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_STOCK_STALE',
            )
          }
        }
      }
      if (
        (packageInput.planningMethod === 'approved_recipe'
          && packageInput.recipes.length < 1)
        || (
          packageInput.planningMethod !== 'approved_recipe'
          && packageInput.recipes.length !== 0
        )
      ) {
        fail(
          `${packageInput.packageKey} recipe evidence does not match its planning method`,
          400,
        )
      }
      const recipeIds = new Set<string>()
      const resolvedRecipes: Array<{
        recipeId: string
        recipeGlobalId: string
        recipeName: string
        recipeRowVersion: number
        productId: string
        productGlobalId: string
        inputProfileVersionId: string
        inputProfileVersionGlobalId: string
        inputProfileVersionRowVersion: number
      }> = []
      for (const recipeInput of packageInput.recipes) {
        if (recipeIds.has(recipeInput.recipeGlobalId)) {
          fail(
            `${packageInput.packageKey} repeats recipe ${recipeInput.recipeGlobalId}`,
            400,
          )
        }
        recipeIds.add(recipeInput.recipeGlobalId)
        const recipeResult = await client.query<{
          recipe_id: string
          recipe_global_id: string
          recipe_name: string
          recipe_row_version: string
          product_id: string
          product_global_id: string
          input_profile_version_id: string
          input_profile_version_global_id: string
          input_profile_version_row_version: string
        }>(
          `SELECT
             recipe.id::text AS recipe_id,
             recipe.global_id AS recipe_global_id,
             recipe.recipe_name,
             recipe.row_version::text AS recipe_row_version,
             product.id::text AS product_id,
             product.reference_code AS product_global_id,
             profile_version.id::text AS input_profile_version_id,
             profile_version.global_id AS input_profile_version_global_id,
             profile_version.row_version::text
               AS input_profile_version_row_version
           FROM operations_approved_pack_recipes recipe
           JOIN crm_products product
             ON product.pipeline_id = recipe.pipeline_id
            AND product.id = recipe.product_id
           JOIN operations_product_pack_profile_versions profile_version
             ON profile_version.organization_id = recipe.organization_id
            AND profile_version.pipeline_id = recipe.pipeline_id
            AND profile_version.product_id = recipe.product_id
            AND profile_version.id = recipe.input_pack_profile_version_id
           WHERE recipe.organization_id = $1::uuid
             AND recipe.packaging_material_id = $2::uuid
             AND recipe.global_id = $3
             AND recipe.row_version = $4
             AND product.reference_code = $5
             AND profile_version.global_id = $6
             AND profile_version.row_version = $7
           LIMIT 1
           FOR SHARE OF recipe, product, profile_version`,
          [
            input.organizationId,
            material.material_id,
            recipeInput.recipeGlobalId,
            recipeInput.recipeRowVersion,
            recipeInput.productGlobalId,
            recipeInput.inputProfileVersionGlobalId,
            recipeInput.inputProfileVersionRowVersion,
          ],
        )
        const recipe = recipeResult.rows[0]
        if (!recipe) {
          fail(
            `${packageInput.packageKey} recipe or input profile evidence changed`,
            409,
            'CARTONIZATION_RATE_EVIDENCE_REVISION_CONFLICT',
          )
        }
        resolvedRecipes.push({
          recipeId: recipe.recipe_id,
          recipeGlobalId: recipe.recipe_global_id,
          recipeName: recipe.recipe_name,
          recipeRowVersion: safeInteger(
            recipe.recipe_row_version,
            `${packageInput.packageKey} recipe row version`,
          ),
          productId: recipe.product_id,
          productGlobalId: recipe.product_global_id,
          inputProfileVersionId: recipe.input_profile_version_id,
          inputProfileVersionGlobalId:
            recipe.input_profile_version_global_id,
          inputProfileVersionRowVersion: safeInteger(
            recipe.input_profile_version_row_version,
            `${packageInput.packageKey} input profile row version`,
          ),
        })
      }
      const resolvedOrToolsProfiles: Array<{
        lineGlobalId: string
        productGlobalId: string
        inputProfileVersionId: string
        inputProfileVersionGlobalId: string
        inputProfileVersionRowVersion: number
        fitModel: 'rigid_3d'
        unitDimensionsMm: CartonizationRateEvidenceDimensionsMm
        unitWeightGrams: number
        quantity: number
      }> = []
      for (const profileInput of packageInput.orToolsProfiles) {
        const profileResult = await client.query<{
          input_profile_version_id: string
          input_profile_version_global_id: string
          input_profile_version_row_version: string
        }>(
          `SELECT
             profile_version.id::text AS input_profile_version_id,
             profile_version.global_id
               AS input_profile_version_global_id,
             profile_version.row_version::text
               AS input_profile_version_row_version
           FROM operations_commerce_current_planning_lines candidate_line
           JOIN crm_products product
             ON product.pipeline_id = candidate_line.pipeline_id
            AND product.id = candidate_line.product_id
           JOIN operations_product_pack_profile_versions profile_version
             ON profile_version.organization_id =
                  candidate_line.organization_id
            AND profile_version.pipeline_id = candidate_line.pipeline_id
            AND profile_version.product_id = candidate_line.product_id
            AND profile_version.id = candidate_line.pack_profile_version_id
           WHERE candidate_line.organization_id = $1::uuid
             AND candidate_line.integration_account_id = $2::uuid
             AND candidate_line.order_candidate_id = $3::uuid
             AND candidate_line.global_id = $4
             AND candidate_line.requires_shipping = true
             AND candidate_line.mapping_state = 'resolved'
             AND candidate_line.packaging_state = 'resolved'
             AND product.reference_code = $5
             AND profile_version.global_id = $6
             AND profile_version.row_version = $7
             AND candidate_line.pack_profile_version_row_version =
                  profile_version.row_version
             AND profile_version.lifecycle_state = 'active'
             AND profile_version.is_current = true
             AND profile_version.dimension_basis = 'outer'
             AND profile_version.fit_model = 'rigid_3d'
             AND profile_version.length_mm = $8
             AND profile_version.width_mm = $9
             AND profile_version.height_mm = $10
             AND profile_version.gross_weight_grams = $11
           LIMIT 1
           FOR SHARE OF product, profile_version`,
          [
            input.organizationId,
            exactContext.integration_account_id,
            exactContext.candidate_id,
            profileInput.lineGlobalId,
            profileInput.productGlobalId,
            profileInput.inputProfileVersionGlobalId,
            profileInput.inputProfileVersionRowVersion,
            profileInput.unitDimensionsMm.length,
            profileInput.unitDimensionsMm.width,
            profileInput.unitDimensionsMm.height,
            profileInput.unitWeightGrams,
          ],
        )
        const profile = profileResult.rows[0]
        if (!profile) {
          fail(
            `${packageInput.packageKey} line ${profileInput.lineGlobalId} no longer has the exact active outer rigid profile used by OR-Tools`,
            409,
            'CARTONIZATION_RATE_EVIDENCE_OR_TOOLS_PROFILE_STALE',
          )
        }
        resolvedOrToolsProfiles.push({
          lineGlobalId: profileInput.lineGlobalId,
          productGlobalId: profileInput.productGlobalId,
          inputProfileVersionId: profile.input_profile_version_id,
          inputProfileVersionGlobalId:
            profile.input_profile_version_global_id,
          inputProfileVersionRowVersion: safeInteger(
            profile.input_profile_version_row_version,
            `${packageInput.packageKey} OR-Tools profile row version`,
          ),
          fitModel: profileInput.fitModel,
          unitDimensionsMm: profileInput.unitDimensionsMm,
          unitWeightGrams: profileInput.unitWeightGrams,
          quantity: profileInput.quantity,
        })
      }
      packageContexts.set(packageInput.packageKey, {
        materialId: material.material_id,
        recipes: resolvedRecipes,
        orToolsProfiles: resolvedOrToolsProfiles,
      })
    }

    const quoteContexts = new Map<string, {
      rateRequestId: string
      status: 'succeeded' | 'failed'
      errorCode: string | null
      carrierRequestHash: string
      packageRateContextHash: string
    }>()
    type ResolvedCarrierRateEvidence = {
      id: string
      status: 'succeeded' | 'failed'
      error_code: string | null
      request_hash: string
      redacted_request: Record<string, unknown>
    }
    const rateContextsByEvidence =
      new Map<string, ResolvedCarrierRateEvidence>()
    const orderedShipmentParcels = [...input.packages]
      .sort((left, right) => (
        left.packageSequence - right.packageSequence
        || left.packageKey.localeCompare(right.packageKey)
      ))
      .map((packageInput) => packageInput.carrierParcel)
    const rateEvidenceByProvider = new Map<
      CartonizationRateEvidenceCarrierProvider,
      string
    >()
    for (const quote of input.quotes) {
      const key = `${quote.packageKey}:${quote.provider}`
      if (quoteContexts.has(key)) {
        fail(`Duplicate carrier quote edge ${key}`, 400)
      }
      if (!packageContexts.has(quote.packageKey)) {
        fail(`Quote ${key} references an unknown package`, 400)
      }
      const retainedEvidence = rateEvidenceByProvider.get(quote.provider)
      if (
        retainedEvidence
        && retainedEvidence !== quote.rateEvidenceGlobalId
      ) {
        fail(
          `${quote.provider} must use one whole-shipment carrier result for every package`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_QUOTE_CONTEXT_MISMATCH',
        )
      }
      rateEvidenceByProvider.set(
        quote.provider,
        quote.rateEvidenceGlobalId,
      )
      const rateEvidenceKey =
        `${quote.provider}:${quote.rateEvidenceGlobalId}`
      let rate = rateContextsByEvidence.get(rateEvidenceKey)
      if (!rate) {
        const result = await client.query<ResolvedCarrierRateEvidence>(
          `SELECT
             id::text, status, error_code, request_hash, redacted_request
           FROM operations_carrier_rate_requests
           WHERE organization_id = $1::uuid
             AND global_id = $2
             AND provider = $3
             AND purpose = 'cartonization_shipment_rate'
           LIMIT 1
           FOR SHARE`,
          [
            input.organizationId,
            quote.rateEvidenceGlobalId,
            quote.provider,
          ],
        )
        rate = result.rows[0]
        if (rate) rateContextsByEvidence.set(rateEvidenceKey, rate)
      }
      if (!rate) {
        fail(
          `Quote evidence ${quote.rateEvidenceGlobalId} is unavailable for this cartonization proof`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_QUOTE_INVALID',
        )
      }
      const shipment = rate.redacted_request?.shipment
      if (!shipment || typeof shipment !== 'object' || Array.isArray(shipment)) {
        fail(
          `Quote evidence ${quote.rateEvidenceGlobalId} has no exact shipment context`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_QUOTE_CONTEXT_MISMATCH',
        )
      }
      const exactShipment = shipment as Record<string, unknown>
      if (
        exactShipment.rateScope !== 'multi_package_shipment'
        || exactShipment.packageCount !== orderedShipmentParcels.length
        || exactShipment.destinationFingerprint
          !== input.destinationFingerprint
        || cartonizationRateEvidenceHash(exactShipment.parcels)
          !== cartonizationRateEvidenceHash(orderedShipmentParcels)
      ) {
        fail(
          `Quote evidence ${quote.rateEvidenceGlobalId} does not match the ordered whole shipment`,
          409,
          'CARTONIZATION_RATE_EVIDENCE_QUOTE_CONTEXT_MISMATCH',
        )
      }
      assertHash(rate.request_hash, 'Carrier request hash')
      quoteContexts.set(key, {
        rateRequestId: rate.id,
        status: rate.status,
        errorCode: rate.error_code,
        carrierRequestHash: rate.request_hash,
        packageRateContextHash: cartonizationShipmentRateContextHash({
          provider: quote.provider,
          destinationFingerprint: input.destinationFingerprint,
          parcels: orderedShipmentParcels,
        }),
      })
    }
    const carrierReads = [...rateContextsByEvidence.values()]
    const failedCarrierReadCount = carrierReads.filter(
      (rate) => rate.status === 'failed',
    ).length
    const expectedStatus = failedCarrierReadCount === 0
      ? 'succeeded'
      : failedCarrierReadCount === carrierReads.length
        ? 'failed'
        : 'partial'
    if (input.status !== expectedStatus) {
      fail(
        `Evidence status must be ${expectedStatus} for the retained carrier results`,
        400,
      )
    }

    await client.query(
      `SELECT set_config(
         'clawpilot.cartonization_evidence_write_token',
         $1,
         true
       )`,
      [writeToken],
    )
    const inserted = await client.query<{ id: string; global_id: string }>(
      `INSERT INTO operations_cartonization_rate_evidence (
         organization_id, integration_account_id, order_candidate_id,
         candidate_row_version, candidate_source_hash,
         destination_fingerprint, warehouse_id,
         inventory_sync_run_id, evidence_mode, policy_version,
         algorithm_version, plan_input_hash, plan_result_hash,
         plan_snapshot, assumption_snapshot, status, idempotency_key,
         actor_email, request_hash, write_token_hash,
         required_carrier_providers
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid,
         $8::uuid, $9, $10, $11, $12, $13,
         $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20,
         $21::text[]
       )
       RETURNING id::text, global_id`,
      [
        input.organizationId,
        exactContext.integration_account_id,
        exactContext.candidate_id,
        input.candidateRowVersion,
        exactContext.candidate_source_hash,
        input.destinationFingerprint,
        exactContext.warehouse_id,
        exactContext.inventory_sync_run_id,
        input.evidenceMode,
        input.policyVersion,
        input.algorithmVersion,
        input.planInputHash,
        input.planResultHash,
        JSON.stringify(input.planSnapshot),
        JSON.stringify(input.assumptionSnapshot),
        input.status,
        input.idempotencyKey,
        input.actorEmail,
        requestHash,
        writeTokenHash,
        input.requiredCarrierProviders,
      ],
    )
    const evidence = inserted.rows[0]

    for (const packageInput of input.packages) {
      const contextForPackage = packageContexts.get(packageInput.packageKey)!
      const primaryRecipe = contextForPackage.recipes[0] || null
      await client.query(
        `INSERT INTO operations_cartonization_rate_evidence_packages (
           organization_id, evidence_id, package_key,
           package_sequence, planning_method,
           packaging_material_id, approved_pack_recipe_id,
           material_row_version, recipe_row_version,
           inner_dimensions_mm, rated_outer_dimensions_mm,
           content_weight_grams, tare_weight_grams,
           rated_gross_weight_grams, max_weight_grams,
           allocations, carrier_parcel_snapshot, package_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid,
           $8, $9, $10::jsonb, $11::jsonb,
           $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18
         )`,
        [
          input.organizationId,
          evidence.id,
          packageInput.packageKey,
          packageInput.packageSequence,
          packageInput.planningMethod,
          contextForPackage.materialId,
          primaryRecipe?.recipeId || null,
          packageInput.materialRowVersion,
          primaryRecipe?.recipeRowVersion ?? null,
          JSON.stringify(packageInput.innerDimensionsMm),
          JSON.stringify(packageInput.ratedOuterDimensionsMm),
          packageInput.contentWeightGrams,
          packageInput.tareWeightGrams,
          packageInput.ratedGrossWeightGrams,
          packageInput.maxWeightGrams,
          JSON.stringify(packageInput.allocations),
          JSON.stringify(packageInput.carrierParcel),
          packageInput.packageHash,
        ],
      )
      for (const recipe of contextForPackage.recipes) {
        await client.query(
          `INSERT INTO
             operations_cartonization_rate_evidence_package_recipes (
               organization_id, evidence_id, package_key,
               packaging_material_id, approved_pack_recipe_id,
               product_id, input_pack_profile_version_id,
               recipe_global_id, recipe_name_snapshot,
               product_global_id, input_profile_version_global_id,
               recipe_row_version, input_profile_version_row_version
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
               $6::uuid, $7::uuid, $8, $9, $10, $11, $12, $13
             )`,
          [
            input.organizationId,
            evidence.id,
            packageInput.packageKey,
            contextForPackage.materialId,
            recipe.recipeId,
            recipe.productId,
            recipe.inputProfileVersionId,
            recipe.recipeGlobalId,
            recipe.recipeName,
            recipe.productGlobalId,
            recipe.inputProfileVersionGlobalId,
            recipe.recipeRowVersion,
            recipe.inputProfileVersionRowVersion,
          ],
        )
      }
      for (const profile of contextForPackage.orToolsProfiles) {
        await client.query(
          `INSERT INTO
             operations_cartonization_rate_evidence_package_profiles (
               organization_id, evidence_id, package_key,
               line_global_id, product_global_id,
               input_pack_profile_version_id,
               input_profile_version_global_id,
               input_profile_version_row_version, fit_model,
               unit_dimensions_mm, unit_weight_grams, quantity
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7, $8,
               $9, $10::jsonb, $11, $12
             )`,
          [
            input.organizationId,
            evidence.id,
            packageInput.packageKey,
            profile.lineGlobalId,
            profile.productGlobalId,
            profile.inputProfileVersionId,
            profile.inputProfileVersionGlobalId,
            profile.inputProfileVersionRowVersion,
            profile.fitModel,
            JSON.stringify(profile.unitDimensionsMm),
            profile.unitWeightGrams,
            profile.quantity,
          ],
        )
      }
    }
    for (const quote of input.quotes) {
      const contextForQuote = quoteContexts.get(
        `${quote.packageKey}:${quote.provider}`,
      )!
      await client.query(
        `INSERT INTO operations_cartonization_rate_evidence_quotes (
           organization_id, evidence_id, package_key, provider,
           rate_purpose, carrier_rate_request_id,
           quote_status, error_code, carrier_request_hash,
           package_rate_context_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4,
           'cartonization_shipment_rate', $5::uuid, $6, $7, $8, $9
         )`,
        [
          input.organizationId,
          evidence.id,
          quote.packageKey,
          quote.provider,
          contextForQuote.rateRequestId,
          contextForQuote.status,
          contextForQuote.errorCode,
          contextForQuote.carrierRequestHash,
          contextForQuote.packageRateContextHash,
        ],
      )
    }
    const sealed = await client.query(
      `UPDATE operations_cartonization_rate_evidence
       SET sealed_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND sealed_at IS NULL`,
      [input.organizationId, evidence.id],
    )
    if (sealed.rowCount !== 1) {
      fail(
        'Cartonization rate evidence could not be sealed',
        500,
        'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
      )
    }
    const completedCommand = await client.query(
      `UPDATE operations_cartonization_rate_evidence_commands
       SET state = 'completed',
           evidence_id = $4::uuid,
           completed_at = now()
       WHERE organization_id = $1::uuid
         AND idempotency_key = $2
         AND semantic_request_hash = $3
         AND state = 'pending'`,
      [
        input.organizationId,
        input.idempotencyKey,
        input.semanticRequestHash,
        evidence.id,
      ],
    )
    if (completedCommand.rowCount !== 1) {
      fail(
        'Cartonization evidence command could not be completed atomically',
        500,
        'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
      )
    }
    await recordAuditEvent({
      actor: input.actorEmail,
      eventType: 'operations.cartonization_rate_evidence.created',
      aggregateType: 'operations.cartonization_rate_evidence',
      aggregateId: evidence.global_id,
      organizationId: input.organizationId,
      eventKey: `cartonization-rate-evidence:${input.organizationId}:${input.idempotencyKey}`,
      payload: {
        accountGlobalId: input.accountGlobalId,
        candidateGlobalId: input.candidateGlobalId,
        packageCount: input.packages.length,
        quoteCount: input.quotes.length,
        requiredCarrierProviders: input.requiredCarrierProviders,
        evidenceMode: input.evidenceMode,
        status: input.status,
        requestHash,
        planInputHash: input.planInputHash,
        planResultHash: input.planResultHash,
      },
    }, client)
    return evidence.global_id
  })

  const evidence = await readCartonizationRateEvidenceByGlobalId({
    organizationId: input.organizationId,
    evidenceGlobalId: globalId,
  })
  if (!evidence) {
    fail(
      'Cartonization rate evidence was committed but could not be reloaded',
      500,
      'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
    )
  }
  return evidence
}
