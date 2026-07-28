import { NextRequest, NextResponse } from 'next/server'
import {
  CarrierIntegrationRequestError,
  getCarrierIntegrationsState,
  sanitizedCarrierIntegrationError,
  testCarrierSandboxRate,
} from '@/lib/integrations/carrierIntegrations'
import {
  normalizeCarrierSandboxParcel,
} from '@/lib/integrations/carrierSandboxRate'
import {
  assertCommerceIntakeRuntime,
} from '@/lib/integrations/commerceIntake'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  planHybridCartonization,
  type HybridCartonizationMinimumOverride,
} from '@/lib/operations/hybridCartonization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  cartonizationRateEvidenceHash,
  cartonizationRateEvidenceRequestHash,
  CartonizationRateEvidencePersistenceError,
  claimCartonizationRateEvidenceCommandInPostgres,
  failCartonizationRateEvidenceCommandInPostgres,
  readCartonizationRateCandidateContext,
  readCartonizationRateEvidenceByGlobalId,
  writeCartonizationRateEvidenceInPostgres,
  type CartonizationRateEvidencePackageInput,
  type CartonizationRateEvidenceQuoteInput,
} from '@/lib/persistence/cartonizationRateEvidence'
import {
  HybridCartonizationPersistenceError,
  readHybridCartonizationInputFromPostgres,
} from '@/lib/persistence/hybridCartonization'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const EVIDENCE_GLOBAL_ID = /^gcte[0-9]{7}$/
const MAX_REQUEST_BYTES = 32 * 1024
const MILLIMETERS_PER_INCH = 25.4
const GRAMS_PER_POUND = 453.59237

type NormalizedRateEvidenceRequest = {
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  warehouseGlobalId: string
  selectedMaterials: Array<{
    materialGlobalId: string
    expectedRowVersion: number
  }>
  assumedCommittedQuantities: Array<{
    lineGlobalId: string
    quantity: number
  }>
  sandboxAssumptions: {
    acknowledged: true
    reason: string
    ratedOuterDimensionsMm: {
      length: number
      width: number
      height: number
    }
    tareWeightGrams: number
    allowUnderMinimum: boolean
    assumedMinimumInputQuantity: number | null
  }
  idempotencyKey: string
}

class RateEvidenceRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'CARTONIZATION_RATE_EVIDENCE_REQUEST_INVALID',
  ) {
    super(message)
    this.name = 'RateEvidenceRequestError'
  }
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function requestError(
  message: string,
  code = 'CARTONIZATION_RATE_EVIDENCE_REQUEST_INVALID',
): never {
  throw new RateEvidenceRequestError(message, 400, code)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function plainText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    typeof value !== 'string'
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    requestError(`${label} must be plain text`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length < minimum || normalized.length > maximum) {
    requestError(`${label} must be ${minimum}-${maximum} characters`)
  }
  return normalized
}

function exactReference(
  value: unknown,
  pattern: RegExp,
  label: string,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!pattern.test(normalized)) requestError(`${label} is invalid`)
  return normalized
}

function exactInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
  ) {
    requestError(`${label} must be a whole number from ${minimum} to ${maximum}`)
  }
  return Number(value)
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new RateEvidenceRequestError(
      'Cartonization rate evidence request is too large',
      413,
      'CARTONIZATION_RATE_EVIDENCE_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new RateEvidenceRequestError(
      'Cartonization rate evidence request is too large',
      413,
      'CARTONIZATION_RATE_EVIDENCE_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    requestError('Request body must be valid JSON')
  }
}

function normalizeRequest(value: unknown): NormalizedRateEvidenceRequest {
  const input = record(value, 'Request body')
  const selected = input.selectedMaterials
  if (!Array.isArray(selected) || selected.length !== 1) {
    requestError(
      'Select exactly one packaging material for a carrier comparison',
      'CARTONIZATION_RATE_EVIDENCE_ONE_MATERIAL_REQUIRED',
    )
  }
  const selectedMaterials = selected.map((entry, index) => {
    const item = record(entry, `Selected material ${index + 1}`)
    return {
      materialGlobalId: exactReference(
        item.materialGlobalId,
        /^gmat[0-9]{7}$/,
        `Selected material ${index + 1} Global ID`,
      ),
      expectedRowVersion: exactInteger(
        item.expectedRowVersion,
        `Selected material ${index + 1} row version`,
      ),
    }
  })
  if (!Array.isArray(input.assumedCommittedQuantities)) {
    requestError('Committed inventory assumptions must be an array')
  }
  const assumedCommittedQuantities = input.assumedCommittedQuantities.map(
    (entry, index) => {
      const item = record(entry, `Committed inventory assumption ${index + 1}`)
      return {
        lineGlobalId: exactReference(
          item.lineGlobalId,
          /^gcol[0-9]{7}$/,
          `Committed inventory assumption ${index + 1} line`,
        ),
        quantity: exactInteger(
          item.quantity,
          `Committed inventory assumption ${index + 1} quantity`,
          0,
          1_000_000,
        ),
      }
    },
  )
  const assumptions = record(
    input.sandboxAssumptions,
    'Sandbox assumptions',
  )
  if (assumptions.acknowledged !== true) {
    requestError(
      'Explicit acknowledgement of the sandbox-only evidence boundary is required',
      'CARTONIZATION_RATE_EVIDENCE_ACKNOWLEDGEMENT_REQUIRED',
    )
  }
  const dimensions = record(
    assumptions.ratedOuterDimensionsMm,
    'Rated exterior dimensions',
  )
  const allowUnderMinimum = assumptions.allowUnderMinimum === true
  const assumedMinimumInputQuantity = allowUnderMinimum
    ? exactInteger(
        assumptions.assumedMinimumInputQuantity,
        'Assumed minimum input quantity',
        1,
        1_000_000,
      )
    : null
  return {
    accountGlobalId: exactReference(
      input.accountGlobalId,
      /^gia[0-9]{7}$/,
      'Commerce account Global ID',
    ),
    candidateGlobalId: exactReference(
      input.candidateGlobalId,
      /^gcoc[0-9]{7}$/,
      'Order candidate Global ID',
    ),
    expectedCandidateRowVersion: exactInteger(
      input.expectedCandidateRowVersion,
      'Expected candidate row version',
    ),
    warehouseGlobalId: exactReference(
      input.warehouseGlobalId,
      /^gwh[0-9]{7}$/,
      'Warehouse Global ID',
    ),
    selectedMaterials,
    assumedCommittedQuantities,
    sandboxAssumptions: {
      acknowledged: true,
      reason: plainText(
        assumptions.reason,
        'Sandbox assumption reason',
        12,
        500,
      ),
      ratedOuterDimensionsMm: {
        length: exactInteger(
          dimensions.length,
          'Rated exterior length',
          1,
          2_743,
        ),
        width: exactInteger(
          dimensions.width,
          'Rated exterior width',
          1,
          2_743,
        ),
        height: exactInteger(
          dimensions.height,
          'Rated exterior height',
          1,
          2_743,
        ),
      },
      tareWeightGrams: exactInteger(
        assumptions.tareWeightGrams,
        'Sandbox tare weight',
        1,
        68_038,
      ),
      allowUnderMinimum,
      assumedMinimumInputQuantity,
    },
    idempotencyKey: plainText(
      input.idempotencyKey,
      'Idempotency key',
      8,
      160,
    ),
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (error instanceof CartonizationRateEvidencePersistenceError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  if (
    error instanceof RateEvidenceRequestError
    || error instanceof HybridCartonizationPersistenceError
  ) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  if (error instanceof CarrierIntegrationRequestError) {
    const sanitized = sanitizedCarrierIntegrationError(error)
    return json(
      { ok: false, error: sanitized.message, code: sanitized.code },
      sanitized.status,
    )
  }
  if (error instanceof CommerceIntegrationRequestError) {
    const sanitized = sanitizedCommerceIntegrationError(error)
    return json(
      { ok: false, error: sanitized.message, code: sanitized.code },
      sanitized.status,
    )
  }
  return json(
    {
      ok: false,
      error: 'Cartonization rate evidence is temporarily unavailable',
      code: 'CARTONIZATION_RATE_EVIDENCE_UNAVAILABLE',
    },
    503,
  )
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CartonizationRateEvidencePersistenceError(
      'Cartonization rate evidence requires Postgres storage',
      503,
      'CARTONIZATION_RATE_EVIDENCE_POSTGRES_REQUIRED',
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canView) {
      return json(
        {
          ok: false,
          error: 'Operations permission is required to view cartonization rate evidence',
          code: 'CARTONIZATION_RATE_EVIDENCE_VIEW_FORBIDDEN',
        },
        403,
      )
    }
    requirePostgres()
    const evidenceGlobalId = String(
      req.nextUrl.searchParams.get('evidenceGlobalId') || '',
    ).trim()
    if (!EVIDENCE_GLOBAL_ID.test(evidenceGlobalId)) {
      return json(
        {
          ok: false,
          error: 'Cartonization rate evidence reference is invalid',
          code: 'CARTONIZATION_RATE_EVIDENCE_REFERENCE_INVALID',
        },
        400,
      )
    }
    const evidence = await readCartonizationRateEvidenceByGlobalId({
      organizationId: activeOperationsOrganizationId(actor),
      evidenceGlobalId,
    })
    if (!evidence) {
      return json(
        {
          ok: false,
          error: 'Cartonization rate evidence was not found in the active organization',
          code: 'CARTONIZATION_RATE_EVIDENCE_NOT_FOUND',
        },
        404,
      )
    }
    return json({ ok: true, evidence })
  } catch (error) {
    return errorResponse(error)
  }
}

function roundCarrierDecimal(value: number) {
  return Math.round(value * 1_000) / 1_000
}

function minimumOverrides(
  request: NormalizedRateEvidenceRequest,
  input: Awaited<
    ReturnType<typeof readHybridCartonizationInputFromPostgres>
  >['input'],
  candidateGlobalId: string,
): HybridCartonizationMinimumOverride[] {
  if (!request.sandboxAssumptions.allowUnderMinimum) return []
  const assumedMinimum =
    request.sandboxAssumptions.assumedMinimumInputQuantity
  if (!assumedMinimum) return []
  const reference = [
    'operator-sandbox-minimum',
    candidateGlobalId,
    request.expectedCandidateRowVersion,
  ].join(':')
  const overrides = new Map<string, HybridCartonizationMinimumOverride>()
  for (const recipe of input.recipes) {
    const key = recipe.contentCompatibilityKey
      ? `compatibility:${recipe.packagingMaterialGlobalId}:${
          recipe.contentCompatibilityKey
        }`
      : `recipe:${recipe.recipeGlobalId}`
    if (overrides.has(key)) continue
    overrides.set(key, {
      ...(recipe.contentCompatibilityKey
        ? { contentCompatibilityKey: recipe.contentCompatibilityKey }
        : { recipeGlobalId: recipe.recipeGlobalId }),
      packagingMaterialGlobalId: recipe.packagingMaterialGlobalId,
      minimumInputQuantity: assumedMinimum,
      reason: request.sandboxAssumptions.reason,
      evidenceReference: reference,
    })
  }
  return [...overrides.values()]
}

export async function POST(req: NextRequest) {
  let claimedCommand: {
    organizationId: string
    idempotencyKey: string
    semanticRequestHash: string
  } | null = null
  try {
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      return json(
        {
          ok: false,
          error:
            'Operations-management permission is required to save a pack and carrier-rate comparison',
          code: 'CARTONIZATION_RATE_EVIDENCE_MANAGER_REQUIRED',
        },
        403,
      )
    }
    requirePostgres()
    assertCommerceIntakeRuntime()
    const organizationId = activeOperationsOrganizationId(actor)
    const request = normalizeRequest(await requestBody(req))
    const read = await readHybridCartonizationInputFromPostgres({
      organizationId,
      accountGlobalId: request.accountGlobalId,
      candidateGlobalId: request.candidateGlobalId,
      expectedCandidateRowVersion:
        request.expectedCandidateRowVersion,
      warehouseGlobalId: request.warehouseGlobalId,
      mode: 'sandbox_demo',
      selectedMaterials: request.selectedMaterials,
      assumedCommittedQuantities:
        request.assumedCommittedQuantities,
    })
    const destination = await readCartonizationRateCandidateContext({
      organizationId,
      accountGlobalId: request.accountGlobalId,
      candidateGlobalId: request.candidateGlobalId,
      expectedCandidateRowVersion:
        request.expectedCandidateRowVersion,
    })
    if (destination.candidateSourceHash !== read.candidate.sourceHash) {
      throw new CartonizationRateEvidencePersistenceError(
        'The confirmed destination no longer matches the exact candidate source evidence',
        409,
        'CARTONIZATION_RATE_DESTINATION_STALE',
      )
    }

    const assumptions = request.sandboxAssumptions
    const plan = planHybridCartonization({
      ...read.input,
      materials: read.input.materials.map((material) => ({
        ...material,
        ratedOuterDimensionsMm:
          assumptions.ratedOuterDimensionsMm,
        tareWeightGrams: assumptions.tareWeightGrams,
      })),
      minimumInputOverrides: minimumOverrides(
        request,
        read.input,
        read.candidate.globalId,
      ),
    })
    if (plan.status !== 'ready') {
      const first = plan.blockers[0]
      throw new RateEvidenceRequestError(
        first
          ? `${first.detail} Next action: ${first.action}`
          : 'The exact order and recipe evidence did not produce a rate-ready plan',
        422,
        first?.code || 'HYBRID_CARTONIZATION_PLAN_BLOCKED',
      )
    }
    if (plan.geometryFallbackLines.length > 0) {
      throw new RateEvidenceRequestError(
        'Saved carrier evidence currently requires an approved-recipe package for every line',
        422,
        'CARTONIZATION_RATE_EVIDENCE_RECIPE_PLAN_REQUIRED',
      )
    }
    if (
      plan.recipePackages.length < 1
      || plan.recipePackages.length > 8
    ) {
      throw new RateEvidenceRequestError(
        'The approved-recipe plan must contain between one and eight packages',
        422,
        'CARTONIZATION_RATE_EVIDENCE_PACKAGE_COUNT_INVALID',
      )
    }
    const notRateReady = plan.recipePackages.find(
      (packagePlan) => (
        packagePlan.rateReadiness.status !== 'ready'
        || !packagePlan.rateReadiness.ratedOuterDimensionsMm
        || !packagePlan.rateReadiness.tareWeightGrams
        || !packagePlan.rateReadiness.ratedWeightGrams
      ),
    )
    if (notRateReady) {
      throw new RateEvidenceRequestError(
        `Package ${notRateReady.packageKey} is missing exact rated exterior dimensions or tare`,
        422,
        'CARTONIZATION_RATE_EVIDENCE_PARCEL_FACTS_REQUIRED',
      )
    }

    const carrierState = await getCarrierIntegrationsState(organizationId)
    for (const provider of ['ups_rest', 'fedex_rest'] as const) {
      const connection = carrierState.accounts.find((account) => (
        account.provider === provider
        && account.environment === 'sandbox'
        && account.status === 'active'
      ))
      if (!connection) {
        throw new RateEvidenceRequestError(
          `An active ${provider === 'ups_rest' ? 'UPS' : 'FedEx'} sandbox rating connection is required`,
          422,
          'CARTONIZATION_RATE_EVIDENCE_CARRIER_REQUIRED',
        )
      }
      if (
        connection.senderOriginWarehouseGlobalId
        !== read.warehouse.globalId
      ) {
        throw new RateEvidenceRequestError(
          `${
            provider === 'ups_rest' ? 'UPS' : 'FedEx'
          } sandbox rating is not bound to ${read.warehouse.name}`,
          422,
          'CARTONIZATION_RATE_EVIDENCE_ORIGIN_MISMATCH',
        )
      }
    }

    const packageInputs: CartonizationRateEvidencePackageInput[] =
      plan.recipePackages.map((packagePlan) => {
        const ratedOuter =
          packagePlan.rateReadiness.ratedOuterDimensionsMm
        const tareWeight =
          packagePlan.rateReadiness.tareWeightGrams
        const ratedGrossWeight =
          packagePlan.rateReadiness.ratedWeightGrams
        if (!ratedOuter || !tareWeight || !ratedGrossWeight) {
          throw new RateEvidenceRequestError(
            `Package ${packagePlan.packageKey} is not rate ready`,
            422,
            'CARTONIZATION_RATE_EVIDENCE_PARCEL_FACTS_REQUIRED',
          )
        }
        const recipes = [...new Map(
          packagePlan.lineAllocations.map((allocation) => [
            allocation.recipeGlobalId,
            {
              recipeGlobalId: allocation.recipeGlobalId,
              recipeRowVersion: allocation.recipeRowVersion,
              productGlobalId: allocation.productGlobalId,
              inputProfileVersionGlobalId:
                allocation.profileVersionGlobalId,
              inputProfileVersionRowVersion:
                allocation.profileVersionRowVersion,
            },
          ]),
        ).values()].sort((left, right) => (
          left.recipeGlobalId.localeCompare(right.recipeGlobalId)
        ))
        const carrierParcelRequest = {
          description:
            `Sandbox cartonized order ${read.candidate.orderNumber}`.slice(
              0,
              120,
            ),
          exteriorInches: {
            length: roundCarrierDecimal(
              ratedOuter.length / MILLIMETERS_PER_INCH,
            ),
            width: roundCarrierDecimal(
              ratedOuter.width / MILLIMETERS_PER_INCH,
            ),
            height: roundCarrierDecimal(
              ratedOuter.height / MILLIMETERS_PER_INCH,
            ),
          },
          grossPounds: roundCarrierDecimal(
            ratedGrossWeight / GRAMS_PER_POUND,
          ),
        }
        const snapshot = {
          packageKey: packagePlan.packageKey,
          packageSequence: packagePlan.sequence,
          planningMethod: packagePlan.planningMethod,
          packagingMaterialGlobalId:
            packagePlan.packagingMaterialGlobalId,
          materialRowVersion:
            packagePlan.packagingMaterialRowVersion,
          recipes,
          innerDimensionsMm:
            packagePlan.materialEvidence.innerDimensionsMm,
          ratedOuterDimensionsMm: ratedOuter,
          contentWeightGrams: packagePlan.contentWeightGrams,
          tareWeightGrams: tareWeight,
          ratedGrossWeightGrams: ratedGrossWeight,
          maxWeightGrams: null,
          allocations: packagePlan.lineAllocations.map((allocation) => ({
            lineGlobalId: allocation.lineGlobalId,
            productGlobalId: allocation.productGlobalId,
            title: allocation.title,
            quantity: allocation.quantity,
          })),
          carrierParcel: normalizeCarrierSandboxParcel(
            carrierParcelRequest,
          ),
        }
        return {
          ...snapshot,
          packageHash: cartonizationRateEvidenceHash(snapshot),
        }
      })

    const planSnapshot = {
      mode: 'sandbox_demo',
      policyVersion: plan.policyVersion,
      algorithmVersion: plan.algorithmVersion,
      inputHash: plan.inputHash,
      domainResultHash: plan.resultHash,
      status: plan.status,
      recipePackages: plan.recipePackages,
      geometryFallbackLines: plan.geometryFallbackLines,
      assumptions: plan.assumptions,
      blockers: plan.blockers,
      readContext: {
        readAt: read.readAt,
        account: read.account,
        candidate: read.candidate,
        warehouse: read.warehouse,
        inventory: read.inventory,
        materialEvidence: read.materialEvidence,
        recipeEvidence: read.recipeEvidence,
      },
    }
    const assumptionSnapshot = {
      watermark:
        'ASSUMPTION-BACKED SANDBOX EVIDENCE - NOT EXECUTABLE OR ACTUAL BILLED COST',
      acknowledged: true,
      reason: assumptions.reason,
      ratedOuterDimensionsMm:
        assumptions.ratedOuterDimensionsMm,
      tareWeightGrams: assumptions.tareWeightGrams,
      allowUnderMinimum: assumptions.allowUnderMinimum,
      assumedMinimumInputQuantity:
        assumptions.assumedMinimumInputQuantity,
      minimumOverrides: plan.assumptions,
      committedInventory: read.inventory.lines,
      databaseEffects: {
        evidenceRowsOnly: true,
        inventoryWrites: 0,
        shipmentWrites: 0,
        labelCalls: 0,
        postagePurchases: 0,
        providerWrites: 0,
      },
    }
    const semanticInput = {
      organizationId,
      accountGlobalId: read.account.globalId,
      candidateGlobalId: read.candidate.globalId,
      candidateRowVersion: read.candidate.rowVersion,
      destinationFingerprint: destination.destinationFingerprint,
      warehouseGlobalId: read.warehouse.globalId,
      inventorySyncRunGlobalId: read.inventory.syncRunGlobalId,
      evidenceMode: 'assumption_backed_sandbox' as const,
      policyVersion: plan.policyVersion,
      algorithmVersion: plan.algorithmVersion,
      planInputHash: plan.inputHash,
      planResultHash: cartonizationRateEvidenceHash(planSnapshot),
      planSnapshot,
      assumptionSnapshot,
      packages: packageInputs,
    }
    const semanticRequestHash =
      cartonizationRateEvidenceRequestHash(semanticInput)
    const claim = await claimCartonizationRateEvidenceCommandInPostgres({
      organizationId,
      idempotencyKey: request.idempotencyKey,
      semanticRequestHash,
      actorEmail: actor.email,
    })
    if (claim.state === 'completed') {
      const evidence = await readCartonizationRateEvidenceByGlobalId({
        organizationId,
        evidenceGlobalId: claim.evidenceGlobalId,
      })
      if (!evidence) {
        throw new CartonizationRateEvidencePersistenceError(
          'The saved cartonization evidence could not be reloaded',
          500,
          'CARTONIZATION_RATE_EVIDENCE_CORRUPT',
        )
      }
      return json({
        ok: true,
        evidence,
        replayed: true,
        effects: {
          databaseEvidenceWrites: false,
          inventoryWrites: 0,
          shipmentWrites: 0,
          labelCalls: 0,
          postagePurchases: 0,
          providerWrites: 0,
          carrierRateReads: 0,
        },
      })
    }
    if (claim.state === 'pending') {
      throw new CartonizationRateEvidencePersistenceError(
        'This cartonization comparison is already in progress',
        409,
        'CARTONIZATION_RATE_EVIDENCE_IN_PROGRESS',
      )
    }
    if (claim.state === 'failed') {
      throw new CartonizationRateEvidencePersistenceError(
        `The prior attempt failed (${claim.errorCode}); use a new command key after correcting the cause`,
        409,
        'CARTONIZATION_RATE_EVIDENCE_PREVIOUS_ATTEMPT_FAILED',
      )
    }
    claimedCommand = {
      organizationId,
      idempotencyKey: request.idempotencyKey,
      semanticRequestHash,
    }

    const rateResults: Array<{
      packageKey: string
      provider: 'ups_rest' | 'fedex_rest'
      rateEvidenceGlobalId: string
    }> = []
    for (const packageInput of packageInputs) {
      const parcel = {
        description: packageInput.carrierParcel.description,
        exteriorInches: {
          length: packageInput.carrierParcel.length,
          width: packageInput.carrierParcel.width,
          height: packageInput.carrierParcel.height,
        },
        grossPounds: packageInput.carrierParcel.weight,
      }
      const providerResults = await Promise.all(
        (['ups_rest', 'fedex_rest'] as const).map(async (provider) => {
          const result = await testCarrierSandboxRate({
            organizationId,
            provider,
            environment: 'sandbox',
            destination: destination.destination,
            parcel,
            actorEmail: actor.email,
          })
          if (!result.evidenceGlobalId) {
            throw new CarrierIntegrationRequestError(
              'Carrier rate evidence was not persisted',
              503,
              'CARTONIZATION_RATE_EVIDENCE_CARRIER_WRITE_MISSING',
            )
          }
          return {
            packageKey: packageInput.packageKey,
            provider,
            rateEvidenceGlobalId: result.evidenceGlobalId,
          }
        }),
      )
      rateResults.push(...providerResults)
    }

    const quotes: CartonizationRateEvidenceQuoteInput[] =
      rateResults.map((result) => ({
        packageKey: result.packageKey,
        provider: result.provider,
        rateEvidenceGlobalId: result.rateEvidenceGlobalId,
      }))
    const evidence = await writeCartonizationRateEvidenceInPostgres({
      organizationId,
      accountGlobalId: read.account.globalId,
      candidateGlobalId: read.candidate.globalId,
      candidateRowVersion: read.candidate.rowVersion,
      destinationFingerprint: destination.destinationFingerprint,
      warehouseGlobalId: read.warehouse.globalId,
      inventorySyncRunGlobalId: read.inventory.syncRunGlobalId,
      evidenceMode: 'assumption_backed_sandbox',
      policyVersion: plan.policyVersion,
      algorithmVersion: plan.algorithmVersion,
      planInputHash: plan.inputHash,
      planResultHash: cartonizationRateEvidenceHash(planSnapshot),
      planSnapshot,
      assumptionSnapshot,
      status: 'succeeded',
      idempotencyKey: request.idempotencyKey,
      actorEmail: actor.email,
      semanticRequestHash,
      packages: packageInputs,
      quotes,
    })
    return json({
      ok: true,
      evidence,
      effects: {
        databaseEvidenceWrites: true,
        inventoryWrites: 0,
        shipmentWrites: 0,
        labelCalls: 0,
        postagePurchases: 0,
        providerWrites: 0,
        carrierRateReads: quotes.length,
      },
    })
  } catch (error) {
    if (claimedCommand) {
      const errorCode = (
        error
        && typeof error === 'object'
        && 'code' in error
        && typeof error.code === 'string'
      )
        ? error.code
        : 'CARTONIZATION_RATE_EVIDENCE_UNAVAILABLE'
      try {
        await failCartonizationRateEvidenceCommandInPostgres({
          ...claimedCommand,
          errorCode,
        })
      } catch {
        // Preserve the original failure; the pending reservation still
        // prevents a retry from issuing duplicate carrier requests.
      }
    }
    return errorResponse(error)
  }
}
