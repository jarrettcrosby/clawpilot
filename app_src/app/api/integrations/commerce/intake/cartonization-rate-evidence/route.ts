import { NextRequest, NextResponse } from 'next/server'
import {
  CarrierIntegrationRequestError,
  getCarrierIntegrationsState,
  sanitizedCarrierIntegrationError,
  testCarrierSandboxShipmentRate,
} from '@/lib/integrations/carrierIntegrations'
import {
  normalizeCarrierSandboxParcel,
} from '@/lib/integrations/carrierSandboxRate'
import {
  assertCommerceIntakeRuntime,
} from '@/lib/integrations/commerceIntake'
import {
  inspectShopifyOrderPlanningAuthority,
  ShopifyOrderPlanningAuthorityError,
} from '@/lib/integrations/shopifyOrderPlanningAuthority'
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
import {
  planOperationalGeometryRatePackages,
} from '@/lib/operations/operationalGeometryCartonization'
import {
  configuredOrToolsFulfillmentOptimizer,
} from '@/lib/operations/orToolsFulfillmentOptimizer'
import {
  planSandboxGeometryRatePackages,
} from '@/lib/operations/sandboxCartonizationRatePlan'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS,
  cartonizationRateEvidenceHash,
  CartonizationRateEvidencePersistenceError,
  claimCartonizationRateEvidenceCommandInPostgres,
  failCartonizationRateEvidenceCommandInPostgres,
  MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES,
  readCartonizationRateCandidateContext,
  readCartonizationRateEvidenceByGlobalId,
  writeCartonizationRateEvidenceInPostgres,
  type CartonizationRateEvidenceMaterialRateAssumption,
  type CartonizationRateEvidencePackageInput,
  type CartonizationRateEvidenceQuoteInput,
  type CartonizationRateEvidenceCarrierProvider,
} from '@/lib/persistence/cartonizationRateEvidence'
import {
  HybridCartonizationPersistenceError,
  readHybridCartonizationInputFromPostgres,
} from '@/lib/persistence/hybridCartonization'
import {
  readOperationalOrderPlanningProviderFromPostgres,
  ShopifyOrderPlanningAuthorityPersistenceError,
} from '@/lib/persistence/shopifyOrderPlanningAuthority'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const EVIDENCE_GLOBAL_ID = /^gcte(?:[0-9]{7}|[0-9a-v]{12})$/
const MAX_REQUEST_BYTES = 32 * 1024
const MAX_SELECTED_MATERIALS = 8
const MILLIMETERS_PER_INCH = 25.4
const GRAMS_PER_POUND = 453.59237

type NormalizedRateEvidenceRequestBase = {
  accountGlobalId: string
  candidateGlobalId: string
  expectedCandidateRowVersion: number
  warehouseGlobalId: string
  idempotencyKey: string
}

type NormalizedOperationalRateEvidenceRequest =
  NormalizedRateEvidenceRequestBase & {
    evidenceMode: 'operational'
    selectedMaterials: Array<{
      materialGlobalId: string
      expectedRowVersion: number
    }>
  }

type NormalizedSandboxRateEvidenceRequest =
  NormalizedRateEvidenceRequestBase & {
    evidenceMode: 'assumption_backed_sandbox'
    selectedMaterials: Array<{
      materialGlobalId: string
      expectedRowVersion: number
      sandboxRateAssumptions: {
        ratedOuterDimensionsMm: {
          length: number
          width: number
          height: number
        }
        tareWeightGrams: number
      }
    }>
    assumedCommittedQuantities: Array<{
      lineGlobalId: string
      quantity: number
    }>
    sandboxAssumptions: {
      acknowledged: true
      reason: string
      allowUnderMinimum: boolean
      assumedMinimumInputQuantity: number | null
    }
  }

type NormalizedRateEvidenceRequest =
  | NormalizedOperationalRateEvidenceRequest
  | NormalizedSandboxRateEvidenceRequest

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
  const evidenceMode = input.evidenceMode === undefined
    ? 'assumption_backed_sandbox'
    : input.evidenceMode
  if (
    evidenceMode !== 'operational'
    && evidenceMode !== 'assumption_backed_sandbox'
  ) {
    requestError(
      'Evidence mode must be operational or assumption-backed sandbox',
      'CARTONIZATION_RATE_EVIDENCE_MODE_INVALID',
    )
  }
  const selected = input.selectedMaterials
  if (
    !Array.isArray(selected)
    || selected.length < 1
    || selected.length > MAX_SELECTED_MATERIALS
  ) {
    requestError(
      `Select between one and ${MAX_SELECTED_MATERIALS} packaging materials for a carrier comparison`,
      'CARTONIZATION_RATE_EVIDENCE_MATERIAL_COUNT_INVALID',
    )
  }
  const materialGlobalIds = new Set<string>()
  const selectedMaterials = selected.map((entry, index) => {
    const item = record(entry, `Selected material ${index + 1}`)
    const materialGlobalId = exactReference(
      item.materialGlobalId,
      /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/,
      `Selected material ${index + 1} Global ID`,
    )
    if (materialGlobalIds.has(materialGlobalId)) {
      requestError(
        'Selected packaging materials must be unique',
        'CARTONIZATION_RATE_EVIDENCE_MATERIAL_DUPLICATE',
      )
    }
    materialGlobalIds.add(materialGlobalId)
    const expectedRowVersion = exactInteger(
      item.expectedRowVersion,
      `${materialGlobalId} row version`,
    )
    if (evidenceMode === 'operational') {
      if (item.sandboxRateAssumptions !== undefined) {
        requestError(
          'Operational evidence cannot accept sandbox parcel assumptions',
          'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN',
        )
      }
      return { materialGlobalId, expectedRowVersion }
    }
    const rateAssumptions = record(
      item.sandboxRateAssumptions,
      `${materialGlobalId} sandbox rate assumptions`,
    )
    const dimensions = record(
      rateAssumptions.ratedOuterDimensionsMm,
      `${materialGlobalId} rated exterior dimensions`,
    )
    return {
      materialGlobalId,
      expectedRowVersion,
      sandboxRateAssumptions: {
        ratedOuterDimensionsMm: {
          length: exactInteger(
            dimensions.length,
            `${materialGlobalId} rated exterior length`,
            1,
            2_743,
          ),
          width: exactInteger(
            dimensions.width,
            `${materialGlobalId} rated exterior width`,
            1,
            2_743,
          ),
          height: exactInteger(
            dimensions.height,
            `${materialGlobalId} rated exterior height`,
            1,
            2_743,
          ),
        },
        tareWeightGrams: exactInteger(
          rateAssumptions.tareWeightGrams,
          `${materialGlobalId} sandbox tare weight`,
          1,
          68_038,
        ),
      },
    }
  })
  const base = {
    accountGlobalId: exactReference(
      input.accountGlobalId,
      /^gia(?:[0-9]{7}|[0-9a-v]{12})$/,
      'Commerce account Global ID',
    ),
    candidateGlobalId: exactReference(
      input.candidateGlobalId,
      /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/,
      'Order candidate Global ID',
    ),
    expectedCandidateRowVersion: exactInteger(
      input.expectedCandidateRowVersion,
      'Expected candidate row version',
    ),
    warehouseGlobalId: exactReference(
      input.warehouseGlobalId,
      /^gwh(?:[0-9]{7}|[0-9a-v]{12})$/,
      'Warehouse Global ID',
    ),
    idempotencyKey: plainText(
      input.idempotencyKey,
      'Idempotency key',
      8,
      160,
    ),
  }
  if (evidenceMode === 'operational') {
    if (
      input.assumedCommittedQuantities !== undefined
      || input.sandboxAssumptions !== undefined
    ) {
      requestError(
        'Operational evidence uses current provider inventory authority and packaging master facts only; operator assumptions are not accepted',
        'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_ASSUMPTIONS_FORBIDDEN',
      )
    }
    return {
      ...base,
      evidenceMode,
      selectedMaterials,
    } as NormalizedOperationalRateEvidenceRequest
  }
  if (!Array.isArray(input.assumedCommittedQuantities)) {
    requestError('Committed inventory assumptions must be an array')
  }
  const assumedCommittedQuantities = input.assumedCommittedQuantities.map(
    (entry, index) => {
      const item = record(entry, `Committed inventory assumption ${index + 1}`)
      return {
        lineGlobalId: exactReference(
          item.lineGlobalId,
          /^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/,
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
    ...base,
    evidenceMode,
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
      allowUnderMinimum,
      assumedMinimumInputQuantity,
    },
  } as NormalizedSandboxRateEvidenceRequest
}

function cartonizationRateEvidenceCommandHash(
  organizationId: string,
  request: NormalizedRateEvidenceRequest,
) {
  const selectedMaterials = [...request.selectedMaterials].sort(
    (left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ),
  )
  const common = {
    version: 'cartonization-rate-evidence-command-v1',
    organizationId,
    accountGlobalId: request.accountGlobalId,
    candidateGlobalId: request.candidateGlobalId,
    expectedCandidateRowVersion:
      request.expectedCandidateRowVersion,
    warehouseGlobalId: request.warehouseGlobalId,
    evidenceMode: request.evidenceMode,
    selectedMaterials,
  }
  if (request.evidenceMode === 'operational') {
    return cartonizationRateEvidenceHash(common)
  }
  return cartonizationRateEvidenceHash({
    ...common,
    assumedCommittedQuantities: [
      ...request.assumedCommittedQuantities,
    ].sort((left, right) => (
      left.lineGlobalId.localeCompare(right.lineGlobalId)
    )),
    sandboxAssumptions: request.sandboxAssumptions,
  })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (
    error instanceof Error
    && error.message === 'ACTIVE_ORGANIZATION_REQUIRED'
  ) {
    return json(
      {
        ok: false,
        error: 'Select an active organization before saving rate evidence',
        code: 'ACTIVE_ORGANIZATION_REQUIRED',
      },
      409,
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
    || error instanceof ShopifyOrderPlanningAuthorityError
    || error instanceof ShopifyOrderPlanningAuthorityPersistenceError
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

function sandboxMaterialRateAssumptions(
  request: NormalizedSandboxRateEvidenceRequest,
): CartonizationRateEvidenceMaterialRateAssumption[] {
  return request.selectedMaterials
    .map((material) => ({
      materialGlobalId: material.materialGlobalId,
      expectedRowVersion: material.expectedRowVersion,
      ratedOuterDimensionsMm:
        material.sandboxRateAssumptions.ratedOuterDimensionsMm,
      tareWeightGrams:
        material.sandboxRateAssumptions.tareWeightGrams,
      operationalFacts: null,
    }))
    .sort((left, right) => (
      left.materialGlobalId.localeCompare(right.materialGlobalId)
    ))
}

function minimumOverrides(
  request: NormalizedSandboxRateEvidenceRequest,
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
    const semanticRequestHash =
      cartonizationRateEvidenceCommandHash(organizationId, request)
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
          providerOrderReads: 0,
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
    const operationalProvider = request.evidenceMode === 'operational'
      ? await readOperationalOrderPlanningProviderFromPostgres({
          organizationId,
          accountGlobalId: request.accountGlobalId,
          candidateGlobalId: request.candidateGlobalId,
          expectedCandidateRowVersion:
            request.expectedCandidateRowVersion,
        })
      : null
    const shopifyOrderPlanningAuthority =
      operationalProvider === 'shopify'
        ? await inspectShopifyOrderPlanningAuthority({
            organizationId,
            accountGlobalId: request.accountGlobalId,
            candidateGlobalId: request.candidateGlobalId,
            expectedCandidateRowVersion:
              request.expectedCandidateRowVersion,
            warehouseGlobalId: request.warehouseGlobalId,
          })
        : null
    const read = await readHybridCartonizationInputFromPostgres({
      organizationId,
      accountGlobalId: request.accountGlobalId,
      candidateGlobalId: request.candidateGlobalId,
      expectedCandidateRowVersion:
        request.expectedCandidateRowVersion,
      warehouseGlobalId: request.warehouseGlobalId,
      mode: request.evidenceMode === 'operational'
        ? 'production'
        : 'sandbox_demo',
      selectedMaterials: request.selectedMaterials.map((material) => ({
        materialGlobalId: material.materialGlobalId,
        expectedRowVersion: material.expectedRowVersion,
      })),
      assumedCommittedQuantities: request.evidenceMode === 'operational'
        ? []
        : request.assumedCommittedQuantities,
    })
    const selectedMaterialRateAssumptions =
      request.evidenceMode === 'operational'
        ? read.input.materials.map((material) => {
            if (
              !material.ratedOuterDimensionsMm
              || material.tareWeightGrams === null
              || material.tareWeightGrams <= 0
              || !material.materialType
              || !material.maximumGrossWeightGrams
              || !material.unitCostMinor
              || !material.currency
              || material.stockRowVersion === null
              || material.stockRowVersion === undefined
              || material.stockOnHandQuantity === null
              || material.stockOnHandQuantity === undefined
              || material.activeClaimedQuantity === undefined
              || !material.availableQuantity
            ) {
              throw new RateEvidenceRequestError(
                `${material.materialGlobalId} lacks factual rated exterior dimensions or tare`,
                422,
                'CARTONIZATION_RATE_EVIDENCE_OPERATIONAL_MATERIAL_FACTS_REQUIRED',
              )
            }
            return {
              materialGlobalId: material.materialGlobalId,
              expectedRowVersion: material.currentRowVersion,
              ratedOuterDimensionsMm:
                material.ratedOuterDimensionsMm,
              tareWeightGrams: material.tareWeightGrams,
              operationalFacts: {
                materialType: material.materialType,
                innerDimensionsMm: material.innerDimensionsMm,
                maximumGrossWeightGrams:
                  material.maximumGrossWeightGrams,
                unitCostMinor: material.unitCostMinor,
                currency: material.currency,
                stock: {
                  rowVersion: material.stockRowVersion,
                  onHandQuantity: material.stockOnHandQuantity,
                  activeClaimedQuantity:
                    material.activeClaimedQuantity,
                  availableQuantity: material.availableQuantity,
                },
              },
            }
          }).sort((left, right) => (
            left.materialGlobalId.localeCompare(right.materialGlobalId)
          ))
        : sandboxMaterialRateAssumptions(request)
    const rateAssumptionsByMaterial = new Map(
      selectedMaterialRateAssumptions.map((assumption) => [
        assumption.materialGlobalId,
        assumption,
      ]),
    )
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

    const plan = planHybridCartonization({
      ...read.input,
      materials: request.evidenceMode === 'operational'
        ? read.input.materials
        : read.input.materials.map((material) => {
            const rateAssumption = rateAssumptionsByMaterial.get(
              material.materialGlobalId,
            )
            if (!rateAssumption) {
              throw new RateEvidenceRequestError(
                `${material.materialGlobalId} is missing its sandbox rate assumptions`,
                400,
                'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTIONS_MISSING',
              )
            }
            return {
              ...material,
              ratedOuterDimensionsMm:
                rateAssumption.ratedOuterDimensionsMm,
              tareWeightGrams: rateAssumption.tareWeightGrams,
            }
          }),
      minimumInputOverrides: request.evidenceMode === 'operational'
        ? []
        : minimumOverrides(
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
    if (plan.selfPackages.length > 0) {
      throw new RateEvidenceRequestError(
        'Saved carrier evidence does not yet support self-package lines',
        422,
        'CARTONIZATION_RATE_EVIDENCE_SELF_PACKAGE_UNSUPPORTED',
      )
    }
    let operationalGeometryRatePlan = null
    if (
      request.evidenceMode === 'operational'
      && plan.geometryFallbackLines.length > 0
    ) {
      if (read.activationState !== 'shadow') {
        throw new RateEvidenceRequestError(
          'Operational OR-Tools cartonization with sandbox carrier reads is limited to Operations Shadow mode',
          422,
          'CARTONIZATION_RATE_EVIDENCE_SHADOW_REQUIRED',
        )
      }
      let optimizer = null
      try {
        optimizer = configuredOrToolsFulfillmentOptimizer()
      } catch {
        // The operational planner returns a fail-closed configuration blocker.
      }
      operationalGeometryRatePlan =
        await planOperationalGeometryRatePackages({
          organizationGlobalId: read.organizationGlobalId,
          provider: read.account.provider,
          candidateGlobalId: read.candidate.globalId,
          candidateRowVersion: read.candidate.rowVersion,
          currency: read.candidate.currency,
          readAt: read.readAt,
          warehouseGlobalId: read.warehouse.globalId,
          lines: read.input.lines,
          fallbackLines: plan.geometryFallbackLines,
          recipePackages: plan.recipePackages,
          materials: read.input.materials,
          inventoryProducts: read.inventory.products,
          startingSequence: (
            Math.max(
              0,
              ...plan.recipePackages.map((item) => item.sequence),
            ) + 1
          ),
          maximumPackages:
            MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES
              - plan.recipePackages.length,
          optimizer,
        })
      if (operationalGeometryRatePlan.status === 'blocked') {
        throw new RateEvidenceRequestError(
          operationalGeometryRatePlan.blocker.detail,
          422,
          operationalGeometryRatePlan.blocker.code,
        )
      }
    }
    const sandboxGeometryRatePlan = (
      request.evidenceMode === 'assumption_backed_sandbox'
      && plan.geometryFallbackLines.length > 0
    )
      ? planSandboxGeometryRatePackages({
          lines: read.input.lines,
          fallbackLines: plan.geometryFallbackLines,
          materials: read.input.materials,
          materialAssumptions: selectedMaterialRateAssumptions,
          startingSequence: (
            Math.max(
              0,
              ...plan.recipePackages.map((item) => item.sequence),
            ) + 1
          ),
          maximumPackages:
            MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES
              - plan.recipePackages.length,
        })
      : null
    if (sandboxGeometryRatePlan?.status === 'blocked') {
      throw new RateEvidenceRequestError(
        sandboxGeometryRatePlan.blocker.detail,
        422,
        sandboxGeometryRatePlan.blocker.code,
      )
    }
    const expectedQuantityByLine = new Map(
      read.input.lines.map((line) => [
        line.lineGlobalId,
        line.quantity,
      ]),
    )
    const allocatedQuantityByLine = new Map<string, number>()
    const addAllocation = (lineGlobalId: string, quantity: number) => {
      const next = (allocatedQuantityByLine.get(lineGlobalId) || 0)
        + quantity
      if (
        !expectedQuantityByLine.has(lineGlobalId)
        || !Number.isSafeInteger(quantity)
        || quantity < 1
        || !Number.isSafeInteger(next)
      ) {
        throw new RateEvidenceRequestError(
          'The retained package plan contains an invalid line allocation',
          422,
          'CARTONIZATION_RATE_EVIDENCE_ALLOCATION_COVERAGE_INVALID',
        )
      }
      allocatedQuantityByLine.set(lineGlobalId, next)
    }
    for (const packagePlan of plan.recipePackages) {
      for (const allocation of packagePlan.lineAllocations) {
        addAllocation(allocation.lineGlobalId, allocation.quantity)
      }
    }
    for (const packagePlan of sandboxGeometryRatePlan?.packages || []) {
      for (const allocation of packagePlan.allocations) {
        addAllocation(allocation.lineGlobalId, allocation.quantity)
      }
    }
    for (const packagePlan of operationalGeometryRatePlan?.status === 'ready'
      ? operationalGeometryRatePlan.packages
      : []) {
      for (const allocation of packagePlan.allocations) {
        addAllocation(allocation.lineGlobalId, allocation.quantity)
      }
    }
    const uncoveredLine = [...expectedQuantityByLine].find(
      ([lineGlobalId, quantity]) => (
        allocatedQuantityByLine.get(lineGlobalId) !== quantity
      ),
    )
    const fallbackQuantityByLine = new Map(
      plan.geometryFallbackLines.map((line) => [
        line.lineGlobalId,
        line.quantity,
      ]),
    )
    const sandboxQuantityByLine = new Map<string, number>()
    for (const packagePlan of sandboxGeometryRatePlan?.packages || []) {
      for (const allocation of packagePlan.allocations) {
        sandboxQuantityByLine.set(
          allocation.lineGlobalId,
          (sandboxQuantityByLine.get(allocation.lineGlobalId) || 0)
            + allocation.quantity,
        )
      }
    }
    for (const packagePlan of operationalGeometryRatePlan?.status === 'ready'
      ? operationalGeometryRatePlan.packages
      : []) {
      for (const allocation of packagePlan.allocations) {
        sandboxQuantityByLine.set(
          allocation.lineGlobalId,
          (sandboxQuantityByLine.get(allocation.lineGlobalId) || 0)
            + allocation.quantity,
        )
      }
    }
    const uncoveredFallback = [...fallbackQuantityByLine].find(
      ([lineGlobalId, quantity]) => (
        sandboxQuantityByLine.get(lineGlobalId) !== quantity
      ),
    )
    if (
      uncoveredLine
      || uncoveredFallback
      || sandboxQuantityByLine.size !== fallbackQuantityByLine.size
    ) {
      throw new RateEvidenceRequestError(
        'The retained package plan does not allocate every shippable unit exactly once',
        422,
        'CARTONIZATION_RATE_EVIDENCE_ALLOCATION_COVERAGE_INVALID',
      )
    }
    const packagePlanCount = plan.recipePackages.length
      + (sandboxGeometryRatePlan?.packages.length || 0)
      + (operationalGeometryRatePlan?.status === 'ready'
        ? operationalGeometryRatePlan.packages.length
        : 0)
    if (
      packagePlanCount < 1
      || packagePlanCount > MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES
    ) {
      throw new RateEvidenceRequestError(
        `The retained package plan must contain between one and ${
          MAX_CARTONIZATION_RATE_EVIDENCE_PACKAGES
        } packages`,
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
    const carrierAccountGlobalIds = new Map<
      CartonizationRateEvidenceCarrierProvider,
      string
    >()
    const providers = CARTONIZATION_RATE_EVIDENCE_CARRIER_PROVIDERS.filter(
      (provider) => carrierState.accounts.some((account) => (
        account.provider === provider
        && account.environment === 'sandbox'
        && account.status === 'active'
        && account.configured
        && account.verificationStatus === 'verified'
      )),
    )
    if (providers.length < 1) {
      throw new RateEvidenceRequestError(
        'At least one enabled and verified UPS or FedEx sandbox rating connection is required',
        422,
        'CARTONIZATION_RATE_EVIDENCE_CARRIER_REQUIRED',
      )
    }
    for (const provider of providers) {
      const connection = carrierState.accounts.find((account) => (
        account.provider === provider
        && account.environment === 'sandbox'
        && account.status === 'active'
        && account.configured
        && account.verificationStatus === 'verified'
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
      const senderAccounts = connection.carrierAccounts.filter(
        (account) => (
          account.status === 'active'
          && account.allowSenderBilling
        ),
      )
      if (senderAccounts.length !== 1) {
        throw new RateEvidenceRequestError(
          `Exactly one active sender-billing ${
            provider === 'ups_rest' ? 'UPS' : 'FedEx'
          } sandbox account is required`,
          422,
          'CARTONIZATION_RATE_EVIDENCE_CARRIER_ACCOUNT_REQUIRED',
        )
      }
      carrierAccountGlobalIds.set(provider, senderAccounts[0].globalId)
    }

    const recipePackageInputs: CartonizationRateEvidencePackageInput[] =
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
        const rateAssumption = rateAssumptionsByMaterial.get(
          packagePlan.packagingMaterialGlobalId,
        )
        if (
          !rateAssumption
          || rateAssumption.expectedRowVersion
            !== packagePlan.packagingMaterialRowVersion
          || rateAssumption.tareWeightGrams !== tareWeight
          || rateAssumption.ratedOuterDimensionsMm.length
            !== ratedOuter.length
          || rateAssumption.ratedOuterDimensionsMm.width
            !== ratedOuter.width
          || rateAssumption.ratedOuterDimensionsMm.height
            !== ratedOuter.height
        ) {
          throw new RateEvidenceRequestError(
            `Package ${packagePlan.packageKey} lost its selected material assumptions`,
            500,
            'CARTONIZATION_RATE_EVIDENCE_MATERIAL_ASSUMPTION_MISMATCH',
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
            `${
              request.evidenceMode === 'operational'
                ? 'Operational'
                : 'Sandbox'
            } cartonized order ${read.candidate.orderNumber}`.slice(
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
          orToolsProfiles: [],
          innerDimensionsMm:
            packagePlan.materialEvidence.innerDimensionsMm,
          ratedOuterDimensionsMm: ratedOuter,
          contentWeightGrams: packagePlan.contentWeightGrams,
          tareWeightGrams: tareWeight,
          ratedGrossWeightGrams: ratedGrossWeight,
          maxWeightGrams: read.input.materials.find((material) => (
            material.materialGlobalId
              === packagePlan.packagingMaterialGlobalId
          ))?.maximumGrossWeightGrams ?? null,
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
    const sandboxGeometryPackageInputs:
      CartonizationRateEvidencePackageInput[] = (
        sandboxGeometryRatePlan?.packages || []
      ).map((packagePlan) => {
        const carrierParcelRequest = {
          description:
            `Sandbox cartonized order ${
              read.candidate.orderNumber
            }`.slice(0, 120),
          exteriorInches: {
            length: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.length
                / MILLIMETERS_PER_INCH,
            ),
            width: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.width
                / MILLIMETERS_PER_INCH,
            ),
            height: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.height
                / MILLIMETERS_PER_INCH,
            ),
          },
          grossPounds: roundCarrierDecimal(
            packagePlan.ratedGrossWeightGrams / GRAMS_PER_POUND,
          ),
        }
        const snapshot = {
          packageKey: packagePlan.packageKey,
          packageSequence: packagePlan.packageSequence,
          planningMethod: packagePlan.planningMethod,
          packagingMaterialGlobalId:
            packagePlan.packagingMaterialGlobalId,
          materialRowVersion: packagePlan.materialRowVersion,
          recipes: packagePlan.recipes,
          orToolsProfiles: [],
          innerDimensionsMm: packagePlan.innerDimensionsMm,
          ratedOuterDimensionsMm:
            packagePlan.ratedOuterDimensionsMm,
          contentWeightGrams: packagePlan.contentWeightGrams,
          tareWeightGrams: packagePlan.tareWeightGrams,
          ratedGrossWeightGrams:
            packagePlan.ratedGrossWeightGrams,
          maxWeightGrams: packagePlan.maxWeightGrams,
          allocations: packagePlan.allocations,
          carrierParcel: normalizeCarrierSandboxParcel(
            carrierParcelRequest,
          ),
        }
        return {
          ...snapshot,
          packageHash: cartonizationRateEvidenceHash(snapshot),
        }
      })
    const operationalGeometryPackageInputs:
      CartonizationRateEvidencePackageInput[] = (
        operationalGeometryRatePlan?.status === 'ready'
          ? operationalGeometryRatePlan.packages
          : []
      ).map((packagePlan) => {
        const carrierParcelRequest = {
          description:
            `Operational cartonized order ${
              read.candidate.orderNumber
            }`.slice(0, 120),
          exteriorInches: {
            length: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.length
                / MILLIMETERS_PER_INCH,
            ),
            width: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.width
                / MILLIMETERS_PER_INCH,
            ),
            height: roundCarrierDecimal(
              packagePlan.ratedOuterDimensionsMm.height
                / MILLIMETERS_PER_INCH,
            ),
          },
          grossPounds: roundCarrierDecimal(
            packagePlan.ratedGrossWeightGrams / GRAMS_PER_POUND,
          ),
        }
        const snapshot = {
          packageKey: packagePlan.packageKey,
          packageSequence: packagePlan.packageSequence,
          planningMethod: packagePlan.planningMethod,
          packagingMaterialGlobalId:
            packagePlan.packagingMaterialGlobalId,
          materialRowVersion: packagePlan.materialRowVersion,
          recipes: packagePlan.recipes,
          orToolsProfiles: packagePlan.orToolsProfiles,
          innerDimensionsMm: packagePlan.innerDimensionsMm,
          ratedOuterDimensionsMm:
            packagePlan.ratedOuterDimensionsMm,
          contentWeightGrams: packagePlan.contentWeightGrams,
          tareWeightGrams: packagePlan.tareWeightGrams,
          ratedGrossWeightGrams:
            packagePlan.ratedGrossWeightGrams,
          maxWeightGrams: packagePlan.maxWeightGrams,
          allocations: packagePlan.allocations,
          carrierParcel: normalizeCarrierSandboxParcel(
            carrierParcelRequest,
          ),
        }
        return {
          ...snapshot,
          packageHash: cartonizationRateEvidenceHash(snapshot),
        }
      })
    const packageInputs = [
      ...recipePackageInputs,
      ...operationalGeometryPackageInputs,
      ...sandboxGeometryPackageInputs,
    ].sort((left, right) => (
      left.packageSequence - right.packageSequence
      || left.packageKey.localeCompare(right.packageKey)
    ))

    const planSnapshot = {
      mode: request.evidenceMode === 'operational'
        ? 'production'
        : 'sandbox_demo',
      carrierReadEnvironment: 'sandbox',
      requiredCarrierProviders: providers,
      policyVersion: plan.policyVersion,
      algorithmVersion: plan.algorithmVersion,
      inputHash: plan.inputHash,
      domainResultHash: plan.resultHash,
      status: plan.status,
      recipePackages: plan.recipePackages,
      geometryFallbackLines: plan.geometryFallbackLines,
      sandboxGeometryRatePlan: sandboxGeometryRatePlan?.status === 'ready'
        ? {
            evidence: sandboxGeometryRatePlan.evidence,
            packages: sandboxGeometryRatePlan.packages,
          }
        : null,
      operationalGeometryRatePlan:
        operationalGeometryRatePlan?.status === 'ready'
          ? {
              evidence: operationalGeometryRatePlan.evidence,
              optimizerInput:
                operationalGeometryRatePlan.optimizerInput,
              optimizerResult:
                operationalGeometryRatePlan.optimizerResult,
              packages: operationalGeometryRatePlan.packages,
            }
          : null,
      assumptions: plan.assumptions,
      blockers: plan.blockers,
      ...(shopifyOrderPlanningAuthority
        ? {
            shopifyOrderPlanningAuthorityHash:
              shopifyOrderPlanningAuthority.authorityHash,
            shopifyOrderPlanningAuthority:
              shopifyOrderPlanningAuthority.snapshot,
          }
        : {}),
      readContext: {
        readAt: read.readAt,
        account: read.account,
        candidate: read.candidate,
        warehouse: read.warehouse,
        inventory: read.inventory,
        materialEvidence: read.materialEvidence,
        recipeEvidence: read.recipeEvidence,
        lineEvidence: read.lineEvidence,
      },
    }
    const databaseEffects = {
      evidenceRowsOnly: true,
      inventoryWrites: 0,
      shipmentWrites: 0,
      labelCalls: 0,
      postagePurchases: 0,
      providerWrites: 0,
      providerOrderReads:
        shopifyOrderPlanningAuthority?.providerReads || 0,
    }
    const assumptionSnapshot = request.evidenceMode === 'operational'
      ? {
          boundary:
            'OPERATIONAL PACK FACTS WITH READ-ONLY SANDBOX CARRIER ESTIMATES',
          operatorSuppliedAssumptions: false,
          operationalMaterialFacts: selectedMaterialRateAssumptions,
          minimumOverrides: [],
          inventoryAuthority: read.account.provider === 'shopify'
            ? 'shopify_provider_commitment_preflight'
            : 'projected_atp_only',
          orderEligibilityAuthority: read.account.provider === 'shopify'
            ? 'live_shopify_order_fulfillment_preflight'
            : 'canonical_commerce_order',
          shopifyOrderPlanningAuthorityHash:
            shopifyOrderPlanningAuthority?.authorityHash || null,
          providerOrderReads:
            shopifyOrderPlanningAuthority?.providerReads || 0,
          planClaimAuthority: read.account.provider === 'shopify'
            ? 'transactional_provider_commitment_lock'
            : 'transactional_local_balance_lock',
          committedInventory: read.inventory.lines,
          inventoryProducts: read.inventory.products,
          databaseEffects,
        }
      : {
          watermark:
            'ASSUMPTION-BACKED SANDBOX EVIDENCE - NOT EXECUTABLE OR ACTUAL BILLED COST',
          acknowledged: true,
          reason: request.sandboxAssumptions.reason,
          materialRateAssumptions: selectedMaterialRateAssumptions,
          allowUnderMinimum:
            request.sandboxAssumptions.allowUnderMinimum,
          assumedMinimumInputQuantity:
            request.sandboxAssumptions.assumedMinimumInputQuantity,
          minimumOverrides: plan.assumptions,
          sandboxGeometryRatePlan:
            sandboxGeometryRatePlan?.status === 'ready'
              ? {
                  ...sandboxGeometryRatePlan.evidence,
                  packageKeys: sandboxGeometryRatePlan.packages.map(
                    (item) => item.packageKey,
                  ),
                }
              : null,
          committedInventory: read.inventory.lines,
          orderEligibilityAuthority: 'sandbox_assumption_only',
          shopifyOrderPlanningAuthorityHash: null,
          providerOrderReads: 0,
          databaseEffects,
        }
    const orderedParcels = [...packageInputs]
      .sort((left, right) => (
        left.packageSequence - right.packageSequence
        || left.packageKey.localeCompare(right.packageKey)
      ))
      .map((packageInput) => ({
        description: packageInput.carrierParcel.description,
        exteriorInches: {
          length: packageInput.carrierParcel.length,
          width: packageInput.carrierParcel.width,
          height: packageInput.carrierParcel.height,
        },
        grossPounds: packageInput.carrierParcel.weight,
      }))
    const rateResults = await Promise.all(
      providers.map(async (provider) => {
        const carrierAccountGlobalId =
          carrierAccountGlobalIds.get(provider)
        if (!carrierAccountGlobalId) {
          throw new RateEvidenceRequestError(
            `${provider} lost its selected sender-billing account`,
            500,
            'CARTONIZATION_RATE_EVIDENCE_CARRIER_ACCOUNT_REQUIRED',
          )
        }
        const result = await testCarrierSandboxShipmentRate({
          organizationId,
          provider,
          environment: 'sandbox',
          carrierAccountGlobalId,
          destination: destination.destination,
          parcels: orderedParcels,
          actorEmail: actor.email,
        })
        if (!result.evidenceGlobalId) {
          throw new CarrierIntegrationRequestError(
            'Carrier shipment-rate evidence was not persisted',
            503,
            'CARTONIZATION_RATE_EVIDENCE_CARRIER_WRITE_MISSING',
          )
        }
        return {
          provider,
          rateEvidenceGlobalId: result.evidenceGlobalId,
        }
      }),
    )
    const shipmentRateEvidenceByProvider = new Map(
      rateResults.map((result) => [
        result.provider,
        result.rateEvidenceGlobalId,
      ]),
    )
    const quotes: CartonizationRateEvidenceQuoteInput[] =
      packageInputs.flatMap((packageInput) => providers.map((provider) => {
        const rateEvidenceGlobalId =
          shipmentRateEvidenceByProvider.get(provider)
        if (!rateEvidenceGlobalId) {
          throw new CarrierIntegrationRequestError(
            'Shipment-rate evidence was not retained for all selected carriers',
            503,
            'CARTONIZATION_RATE_EVIDENCE_CARRIER_WRITE_MISSING',
          )
        }
        return {
          packageKey: packageInput.packageKey,
          provider,
          rateEvidenceGlobalId,
        }
      }))
    const evidence = await writeCartonizationRateEvidenceInPostgres({
      organizationId,
      accountGlobalId: read.account.globalId,
      candidateGlobalId: read.candidate.globalId,
      candidateRowVersion: read.candidate.rowVersion,
      destinationFingerprint: destination.destinationFingerprint,
      warehouseGlobalId: read.warehouse.globalId,
      inventorySyncRunGlobalId: read.inventory.syncRunGlobalId,
      evidenceMode: request.evidenceMode,
      requiredCarrierProviders: providers,
      policyVersion: plan.policyVersion,
      algorithmVersion: plan.algorithmVersion,
      planInputHash: plan.inputHash,
      planResultHash: cartonizationRateEvidenceHash(planSnapshot),
      planSnapshot,
      assumptionSnapshot,
      materialRateAssumptions: selectedMaterialRateAssumptions,
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
        providerOrderReads:
          shopifyOrderPlanningAuthority?.providerReads || 0,
        carrierRateReads: rateResults.length,
        carrierQuoteEdges: quotes.length,
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
