import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  PRODUCT_PACK_ASSEMBLY_POLICIES,
  PRODUCT_PACK_DIMENSION_BASES,
  PRODUCT_PACK_EVIDENCE_TYPES,
  PRODUCT_PACK_FIT_MODELS,
  PRODUCT_PACK_FULFILLMENT_POLICIES,
  PRODUCT_PACK_INVENTORY_REQUIREMENTS,
  PRODUCT_PACK_LEVELS,
  PRODUCT_PACK_MAPPING_PURPOSES,
  PRODUCT_PACK_PROFILE_STATUSES,
  PRODUCT_PACK_RECIPE_ASSEMBLY_POLICIES,
  PRODUCT_PACK_RECIPE_STATES,
  PRODUCT_PACK_RECIPE_TYPES,
  PRODUCT_PACK_REMAINDER_POLICIES,
  PRODUCT_PACK_SOURCES,
  PRODUCT_PACK_VERSION_STATES,
  PRODUCT_PACK_WEIGHT_BASES,
  ProductPackInputError,
  type ApprovedPackRecipeInput,
  type ProductPackProfileVersionInput,
  type ProductPackVariantMappingInput,
} from '@/lib/operations/productPackManagement'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  ProductPackManagementRequestError,
  readProductPackManagementStateInPostgres,
  saveApprovedPackRecipeInPostgres,
  saveCommerceVariantPackMappingInPostgres,
  saveProductPackProfileVersionInPostgres,
} from '@/lib/persistence/productPackManagement'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const PROFILE_GLOBAL_ID = /^gpph(?:[0-9]{7}|[0-9a-v]{12})$/
const VERSION_GLOBAL_ID = /^gppv(?:[0-9]{7}|[0-9a-v]{12})$/
const CHANNEL_STATE_GLOBAL_ID = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const MAPPING_GLOBAL_ID = /^gcvm(?:[0-9]{7}|[0-9a-v]{12})$/
const RECIPE_GLOBAL_ID = /^gpre(?:[0-9]{7}|[0-9a-v]{12})$/
const MATERIAL_GLOBAL_ID = /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/
const PROFILE_FIELDS = new Set([
  'action',
  'productGlobalId',
  'profileGlobalId',
  'expectedProfileRowVersion',
  'expectedCurrentVersionGlobalId',
  'expectedCurrentVersionRowVersion',
  'profileKey',
  'profileName',
  'packageLevel',
  'isDefault',
  'profileStatus',
  'lifecycleState',
  'baseEachQuantity',
  'unitOfMeasure',
  'dimensionsMm',
  'dimensionBasis',
  'grossWeightGrams',
  'weightBasis',
  'fitModel',
  'shipsAsOwnPackage',
  'assemblyPolicy',
  'evidenceType',
  'evidenceReference',
  'source',
  'providerWeightEvidence',
])
const MAPPING_FIELDS = new Set([
  'action',
  'productGlobalId',
  'channelStateGlobalId',
  'expectedChannelStateRowVersion',
  'profileVersionGlobalId',
  'expectedProfileVersionRowVersion',
  'expectedCurrentMappingGlobalId',
  'expectedCurrentMappingRowVersion',
  'purpose',
])
const RECIPE_FIELDS = new Set([
  'action',
  'productGlobalId',
  'recipeGlobalId',
  'expectedRecipeRowVersion',
  'recipeKey',
  'recipeName',
  'inputProfileVersionGlobalId',
  'expectedInputProfileVersionRowVersion',
  'outputProfileVersionGlobalId',
  'expectedOutputProfileVersionRowVersion',
  'packagingMaterialGlobalId',
  'expectedPackagingMaterialRowVersion',
  'inputQuantity',
  'outputQuantity',
  'packagingMaterialQuantity',
  'recipeType',
  'minimumInputQuantity',
  'contentCompatibilityKey',
  'allowsMixedProducts',
  'fulfillmentPolicy',
  'remainderPolicy',
  'inventoryEvidenceRequirement',
  'assemblyPolicy',
  'exclusiveContents',
  'lifecycleState',
  'fitEvidenceType',
  'fitEvidenceReference',
  'source',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Cookie',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new ProductPackManagementRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'PRODUCT_PACK_POSTGRES_REQUIRED',
      'Product pack management requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PRODUCT_PACK_REQUEST_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      'Product pack command includes an unsupported field',
    )
  }
}

function textValue(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const text = String(value ?? '').trim()
  if (
    !text
    || text.length > maximum
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    fail('PRODUCT_PACK_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function optionalTextValue(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined || value === '') return null
  return textValue(value, label, maximum)
}

function globalId(
  value: unknown,
  label: string,
  pattern: RegExp,
) {
  const text = textValue(value, label, 16)
  if (!pattern.test(text)) {
    fail('PRODUCT_PACK_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function optionalGlobalId(
  value: unknown,
  label: string,
  pattern: RegExp,
) {
  if (value === null || value === undefined || value === '') return null
  return globalId(value, label, pattern)
}

function integerValue(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = 2_147_483_647,
) {
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      `${label} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return parsed
}

function optionalIntegerValue(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = 2_147_483_647,
) {
  if (value === null || value === undefined || value === '') return null
  return integerValue(value, label, minimum, maximum)
}

function booleanValue(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    fail('PRODUCT_PACK_REQUEST_INVALID', `${label} must be true or false`)
  }
  return value
}

function enumValue<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  const text = textValue(value, label, 80)
  if (!allowed.includes(text as T)) {
    fail('PRODUCT_PACK_REQUEST_INVALID', `${label} is invalid`)
  }
  return text as T
}

function profileKey(value: unknown, label: string) {
  const key = textValue(value, label, 80).toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      `${label} must use lowercase letters, numbers, periods, underscores, or hyphens`,
    )
  }
  return key
}

function dimensionsValue(
  value: unknown,
): ProductPackProfileVersionInput['dimensionsMm'] {
  if (value === null || value === undefined) return null
  const dimensions = record(value, 'Dimensions')
  if (
    Object.keys(dimensions).some(
      (field) => !['length', 'width', 'height'].includes(field),
    )
    || Object.keys(dimensions).length !== 3
  ) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      'Dimensions must contain only length, width, and height',
    )
  }
  return {
    length: integerValue(
      dimensions.length,
      'Package length',
      1,
      100_000,
    ),
    width: integerValue(
      dimensions.width,
      'Package width',
      1,
      100_000,
    ),
    height: integerValue(
      dimensions.height,
      'Package height',
      1,
      100_000,
    ),
  }
}

function providerWeightEvidenceValue(
  value: unknown,
): ProductPackProfileVersionInput['providerWeightEvidence'] {
  if (value === null || value === undefined) return null
  const evidence = record(value, 'Provider weight evidence')
  if (
    Object.keys(evidence).some(
      (field) => ![
        'channelStateGlobalId',
        'expectedChannelStateRowVersion',
      ].includes(field),
    )
    || Object.keys(evidence).length !== 2
  ) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      'Provider weight evidence is invalid',
    )
  }
  return {
    channelStateGlobalId: globalId(
      evidence.channelStateGlobalId,
      'Channel-state Global ID',
      CHANNEL_STATE_GLOBAL_ID,
    ),
    expectedChannelStateRowVersion: integerValue(
      evidence.expectedChannelStateRowVersion,
      'Channel-state row version',
    ),
  }
}

function profileInput(
  body: Record<string, unknown>,
): ProductPackProfileVersionInput {
  assertFields(body, PROFILE_FIELDS)
  return {
    productGlobalId: globalId(
      body.productGlobalId,
      'Product Global ID',
      PRODUCT_GLOBAL_ID,
    ),
    profileGlobalId: optionalGlobalId(
      body.profileGlobalId,
      'Profile Global ID',
      PROFILE_GLOBAL_ID,
    ),
    expectedProfileRowVersion: optionalIntegerValue(
      body.expectedProfileRowVersion,
      'Expected profile row version',
    ),
    expectedCurrentVersionGlobalId: optionalGlobalId(
      body.expectedCurrentVersionGlobalId,
      'Current version Global ID',
      VERSION_GLOBAL_ID,
    ),
    expectedCurrentVersionRowVersion: optionalIntegerValue(
      body.expectedCurrentVersionRowVersion,
      'Expected current version row version',
    ),
    profileKey: profileKey(body.profileKey, 'Profile key'),
    profileName: textValue(body.profileName, 'Profile name', 160),
    packageLevel: enumValue(
      body.packageLevel,
      'Package level',
      PRODUCT_PACK_LEVELS,
    ),
    isDefault: booleanValue(body.isDefault, 'Default profile'),
    profileStatus: enumValue(
      body.profileStatus,
      'Profile status',
      PRODUCT_PACK_PROFILE_STATUSES,
    ),
    lifecycleState: enumValue(
      body.lifecycleState,
      'Profile version lifecycle',
      PRODUCT_PACK_VERSION_STATES,
    ),
    baseEachQuantity: integerValue(
      body.baseEachQuantity,
      'Base-each quantity',
      1,
      1_000_000,
    ),
    unitOfMeasure: enumValue(
      body.unitOfMeasure,
      'Unit of measure',
      ['each', 'case'] as const,
    ),
    dimensionsMm: dimensionsValue(body.dimensionsMm),
    dimensionBasis: enumValue(
      body.dimensionBasis,
      'Dimension basis',
      PRODUCT_PACK_DIMENSION_BASES,
    ),
    grossWeightGrams: optionalIntegerValue(
      body.grossWeightGrams,
      'Gross weight',
      1,
      100_000_000,
    ),
    weightBasis: enumValue(
      body.weightBasis,
      'Weight basis',
      PRODUCT_PACK_WEIGHT_BASES,
    ),
    fitModel: enumValue(
      body.fitModel,
      'Fit model',
      PRODUCT_PACK_FIT_MODELS,
    ),
    shipsAsOwnPackage: booleanValue(
      body.shipsAsOwnPackage,
      'Ships-as-own-package',
    ),
    assemblyPolicy: enumValue(
      body.assemblyPolicy,
      'Assembly policy',
      PRODUCT_PACK_ASSEMBLY_POLICIES,
    ),
    evidenceType: enumValue(
      body.evidenceType,
      'Evidence type',
      PRODUCT_PACK_EVIDENCE_TYPES,
    ),
    evidenceReference: optionalTextValue(
      body.evidenceReference,
      'Evidence reference',
      500,
    ),
    source: enumValue(
      body.source,
      'Profile source',
      PRODUCT_PACK_SOURCES,
    ),
    providerWeightEvidence: providerWeightEvidenceValue(
      body.providerWeightEvidence,
    ),
  }
}

function mappingInput(
  body: Record<string, unknown>,
): ProductPackVariantMappingInput {
  assertFields(body, MAPPING_FIELDS)
  return {
    productGlobalId: globalId(
      body.productGlobalId,
      'Product Global ID',
      PRODUCT_GLOBAL_ID,
    ),
    channelStateGlobalId: globalId(
      body.channelStateGlobalId,
      'Channel-state Global ID',
      CHANNEL_STATE_GLOBAL_ID,
    ),
    expectedChannelStateRowVersion: integerValue(
      body.expectedChannelStateRowVersion,
      'Expected channel-state row version',
    ),
    profileVersionGlobalId: globalId(
      body.profileVersionGlobalId,
      'Profile version Global ID',
      VERSION_GLOBAL_ID,
    ),
    expectedProfileVersionRowVersion: integerValue(
      body.expectedProfileVersionRowVersion,
      'Expected profile-version row version',
    ),
    expectedCurrentMappingGlobalId: optionalGlobalId(
      body.expectedCurrentMappingGlobalId,
      'Current mapping Global ID',
      MAPPING_GLOBAL_ID,
    ),
    expectedCurrentMappingRowVersion: optionalIntegerValue(
      body.expectedCurrentMappingRowVersion,
      'Expected current mapping row version',
    ),
    purpose: enumValue(
      body.purpose,
      'Mapping purpose',
      PRODUCT_PACK_MAPPING_PURPOSES,
    ),
  }
}

function recipeInput(
  body: Record<string, unknown>,
): ApprovedPackRecipeInput {
  assertFields(body, RECIPE_FIELDS)
  const compatibilityKey = optionalTextValue(
    body.contentCompatibilityKey,
    'Content compatibility key',
    120,
  )?.toLowerCase() || null
  if (
    compatibilityKey
    && !/^[a-z0-9][a-z0-9._-]*$/.test(compatibilityKey)
  ) {
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      'Content compatibility key is invalid',
    )
  }
  return {
    productGlobalId: globalId(
      body.productGlobalId,
      'Product Global ID',
      PRODUCT_GLOBAL_ID,
    ),
    recipeGlobalId: optionalGlobalId(
      body.recipeGlobalId,
      'Recipe Global ID',
      RECIPE_GLOBAL_ID,
    ),
    expectedRecipeRowVersion: optionalIntegerValue(
      body.expectedRecipeRowVersion,
      'Expected recipe row version',
    ),
    recipeKey: profileKey(body.recipeKey, 'Recipe key'),
    recipeName: textValue(body.recipeName, 'Recipe name', 160),
    inputProfileVersionGlobalId: globalId(
      body.inputProfileVersionGlobalId,
      'Input profile version Global ID',
      VERSION_GLOBAL_ID,
    ),
    expectedInputProfileVersionRowVersion: integerValue(
      body.expectedInputProfileVersionRowVersion,
      'Expected input profile-version row version',
    ),
    outputProfileVersionGlobalId: globalId(
      body.outputProfileVersionGlobalId,
      'Output profile version Global ID',
      VERSION_GLOBAL_ID,
    ),
    expectedOutputProfileVersionRowVersion: integerValue(
      body.expectedOutputProfileVersionRowVersion,
      'Expected output profile-version row version',
    ),
    packagingMaterialGlobalId: globalId(
      body.packagingMaterialGlobalId,
      'Packaging material Global ID',
      MATERIAL_GLOBAL_ID,
    ),
    expectedPackagingMaterialRowVersion: integerValue(
      body.expectedPackagingMaterialRowVersion,
      'Expected packaging material row version',
    ),
    inputQuantity: integerValue(
      body.inputQuantity,
      'Recipe input quantity',
      1,
      1_000_000,
    ),
    outputQuantity: integerValue(
      body.outputQuantity,
      'Recipe output quantity',
      1,
      1_000_000,
    ),
    packagingMaterialQuantity: integerValue(
      body.packagingMaterialQuantity,
      'Packaging material quantity',
      1,
      1_000_000,
    ),
    recipeType: enumValue(
      body.recipeType,
      'Recipe type',
      PRODUCT_PACK_RECIPE_TYPES,
    ),
    minimumInputQuantity: optionalIntegerValue(
      body.minimumInputQuantity,
      'Minimum input quantity',
      1,
      1_000_000,
    ),
    contentCompatibilityKey: compatibilityKey,
    allowsMixedProducts: booleanValue(
      body.allowsMixedProducts,
      'Mixed-product permission',
    ),
    fulfillmentPolicy: enumValue(
      body.fulfillmentPolicy,
      'Fulfillment policy',
      PRODUCT_PACK_FULFILLMENT_POLICIES,
    ),
    remainderPolicy: enumValue(
      body.remainderPolicy,
      'Remainder policy',
      PRODUCT_PACK_REMAINDER_POLICIES,
    ),
    inventoryEvidenceRequirement: enumValue(
      body.inventoryEvidenceRequirement,
      'Inventory evidence requirement',
      PRODUCT_PACK_INVENTORY_REQUIREMENTS,
    ),
    assemblyPolicy: enumValue(
      body.assemblyPolicy,
      'Recipe assembly policy',
      PRODUCT_PACK_RECIPE_ASSEMBLY_POLICIES,
    ),
    exclusiveContents: booleanValue(
      body.exclusiveContents,
      'Exclusive-contents setting',
    ),
    lifecycleState: enumValue(
      body.lifecycleState,
      'Recipe lifecycle',
      PRODUCT_PACK_RECIPE_STATES,
    ),
    fitEvidenceType: enumValue(
      body.fitEvidenceType,
      'Fit evidence type',
      PRODUCT_PACK_EVIDENCE_TYPES,
    ),
    fitEvidenceReference: optionalTextValue(
      body.fitEvidenceReference,
      'Fit evidence reference',
      500,
    ),
    source: enumValue(
      body.source,
      'Recipe source',
      PRODUCT_PACK_SOURCES,
    ),
  }
}

function idempotencyKey(req: NextRequest) {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    fail(
      'PRODUCT_PACK_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return key
}

async function requestBody(req: NextRequest) {
  if (
    !String(req.headers.get('content-type') || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    fail(
      'PRODUCT_PACK_CONTENT_TYPE_INVALID',
      'Product pack commands require JSON',
      415,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'PRODUCT_PACK_REQUEST_TOO_LARGE',
      'Product pack command exceeded the supported size',
      413,
    )
  }
  try {
    return record(JSON.parse(raw) as unknown, 'Request body')
  } catch (error) {
    if (
      error instanceof ProductPackManagementRequestError
      || error instanceof ProductPackInputError
    ) {
      throw error
    }
    fail(
      'PRODUCT_PACK_REQUEST_INVALID',
      'A valid Product pack command is required',
    )
  }
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
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof ProductPackManagementRequestError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  if (error instanceof ProductPackInputError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      400,
    )
  }
  return json({
    ok: false,
    error: 'Product pack request failed',
    code: 'PRODUCT_PACK_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'You do not have permission to view Product pack profiles',
        code: 'PRODUCT_PACK_VIEW_REQUIRED',
      }, 403)
    }
    const productGlobalId = globalId(
      req.nextUrl.searchParams.get('productGlobalId'),
      'Product Global ID',
      PRODUCT_GLOBAL_ID,
    )
    const productPack = await readProductPackManagementStateInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      productGlobalId,
    })
    return json({ ok: true, capabilities, productPack })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return json({
        ok: false,
        error: 'You do not have permission to manage Product pack profiles',
        code: 'PRODUCT_PACK_MANAGE_REQUIRED',
      }, 403)
    }
    const body = await requestBody(req)
    const action = textValue(body.action, 'Product pack action', 80)
    const commandKey = idempotencyKey(req)
    const organizationId = activeOperationsOrganizationId(actor)
    if (action === 'save-profile-version') {
      const result = await saveProductPackProfileVersionInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: commandKey,
        profile: profileInput(body),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'save-variant-mapping') {
      const result = await saveCommerceVariantPackMappingInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: commandKey,
        mapping: mappingInput(body),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'save-approved-recipe') {
      const result = await saveApprovedPackRecipeInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: commandKey,
        recipe: recipeInput(body),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    fail('PRODUCT_PACK_ACTION_INVALID', 'Product pack action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
