import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  PACKAGING_DIMENSION_BASES,
  PACKAGING_DIMENSION_EVIDENCE_TYPES,
  PACKAGING_MATERIAL_SOURCES,
  PACKAGING_MATERIAL_STATUSES,
  PACKAGING_MATERIAL_TYPES,
  packagingDimensionEvidenceReferenceRequired,
  type PackagingMaterialInput,
  type PackagingMaterialStockInput,
} from '@/lib/operations/packagingMaterials'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createStarterPackagingAssortmentInPostgres,
  PackagingMaterialRequestError,
  readPackagingMaterialsWorkspaceFromPostgres,
  savePackagingMaterialInPostgres,
  savePackagingMaterialStockInPostgres,
  removePackagingMaterialInPostgres,
} from '@/lib/persistence/packagingMaterials'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024
const MATERIAL_GLOBAL_ID = /^gmat(?:[0-9]{7}|[0-9a-v]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MATERIAL_FIELDS = new Set([
  'action',
  'globalId',
  'expectedRowVersion',
  'code',
  'name',
  'materialType',
  'innerLengthMm',
  'innerWidthMm',
  'innerHeightMm',
  'ratedOuterLengthMm',
  'ratedOuterWidthMm',
  'ratedOuterHeightMm',
  'ratedOuterDimensionEvidenceType',
  'ratedOuterDimensionEvidenceReference',
  'dimensionBasis',
  'dimensionEvidenceType',
  'dimensionEvidenceReference',
  'tareWeightGrams',
  'maxWeightGrams',
  'unitCostMinor',
  'currency',
  'status',
  'source',
])
const STOCK_FIELDS = new Set([
  'action',
  'materialGlobalId',
  'warehouseId',
  'expectedRowVersion',
  'isAvailable',
  'onHandQuantity',
  'reorderPointQuantity',
  'reorderToQuantity',
])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new PackagingMaterialRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'PACKAGING_MATERIAL_POSTGRES_REQUIRED',
      'Packaging materials require Postgres storage',
      503,
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Packaging material command is invalid')
  }
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Packaging material command includes an unsupported field',
    )
  }
}

function textValue(value: unknown, label: string, max: number) {
  const text = String(value ?? '').trim()
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function optionalTextValue(value: unknown, label: string, max: number) {
  if (value === null || value === undefined || value === '') return null
  return textValue(value, label, max)
}

function integerValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      `${label} must be an integer from ${minimum} to ${maximum}`,
    )
  }
  return parsed
}

function optionalIntegerValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === null || value === undefined || value === '') return null
  return integerValue(value, label, minimum, maximum)
}

function materialGlobalId(value: unknown, label = 'Packaging material') {
  const globalId = textValue(value, label, 16)
  if (!MATERIAL_GLOBAL_ID.test(globalId)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', `${label} is invalid`)
  }
  return globalId
}

function materialInput(value: Record<string, unknown>): PackagingMaterialInput {
  assertFields(value, MATERIAL_FIELDS)
  const globalId = value.globalId === undefined
    ? undefined
    : materialGlobalId(value.globalId, 'Packaging material Global ID')
  const expectedRowVersion = globalId
    ? integerValue(
      value.expectedRowVersion,
      'Packaging material version',
      0,
      2_147_483_647,
    )
    : undefined
  const code = textValue(value.code, 'Packaging material code', 40).toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{1,39}$/.test(code)) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Packaging material code must use letters, numbers, periods, underscores, or hyphens',
    )
  }
  const materialType = textValue(
    value.materialType,
    'Material type',
    30,
  ) as PackagingMaterialInput['materialType']
  if (!PACKAGING_MATERIAL_TYPES.includes(materialType)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Material type is invalid')
  }
  const status = textValue(
    value.status,
    'Material status',
    20,
  ) as PackagingMaterialInput['status']
  if (!PACKAGING_MATERIAL_STATUSES.includes(status)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Material status is invalid')
  }
  if (status === 'retired') {
    fail(
      'PACKAGING_MATERIAL_ACTION_INVALID',
      'Use Remove material to retire a packaging material safely',
    )
  }
  const innerLengthMm = optionalIntegerValue(
    value.innerLengthMm,
    'Package length',
    1,
    100_000,
  )
  const innerWidthMm = optionalIntegerValue(
    value.innerWidthMm,
    'Package width',
    1,
    100_000,
  )
  const innerHeightMm = optionalIntegerValue(
    value.innerHeightMm,
    'Package height',
    1,
    100_000,
  )
  const ratedOuterLengthMm = optionalIntegerValue(
    value.ratedOuterLengthMm,
    'Rated outer package length',
    1,
    100_000,
  )
  const ratedOuterWidthMm = optionalIntegerValue(
    value.ratedOuterWidthMm,
    'Rated outer package width',
    1,
    100_000,
  )
  const ratedOuterHeightMm = optionalIntegerValue(
    value.ratedOuterHeightMm,
    'Rated outer package height',
    1,
    100_000,
  )
  const ratedOuterEvidenceValue = value
    .ratedOuterDimensionEvidenceType === null
    || value.ratedOuterDimensionEvidenceType === undefined
    || value.ratedOuterDimensionEvidenceType === ''
    ? null
    : textValue(
      value.ratedOuterDimensionEvidenceType,
      'Rated outer dimension evidence type',
      30,
    )
  if (
    ratedOuterEvidenceValue !== null
    && (
      ratedOuterEvidenceValue === 'unknown'
      || !PACKAGING_DIMENSION_EVIDENCE_TYPES.includes(
        ratedOuterEvidenceValue as typeof PACKAGING_DIMENSION_EVIDENCE_TYPES[number],
      )
    )
  ) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Rated outer dimension evidence type is invalid',
    )
  }
  const ratedOuterDimensionEvidenceType =
    ratedOuterEvidenceValue as PackagingMaterialInput[
      'ratedOuterDimensionEvidenceType'
    ]
  const ratedOuterDimensionEvidenceReference = optionalTextValue(
    value.ratedOuterDimensionEvidenceReference,
    'Rated outer dimension evidence reference',
    500,
  )
  const outerDimensions = [
    ratedOuterLengthMm,
    ratedOuterWidthMm,
    ratedOuterHeightMm,
  ]
  const hasAnyOuterDimension = outerDimensions.some(
    (dimension) => dimension !== null,
  )
  const hasAllOuterDimensions = outerDimensions.every(
    (dimension) => dimension !== null,
  )
  if (
    hasAnyOuterDimension !== hasAllOuterDimensions
    || (
      hasAllOuterDimensions
      && (
        ratedOuterDimensionEvidenceType === null
        || ratedOuterDimensionEvidenceReference === null
      )
    )
    || (
      !hasAnyOuterDimension
      && (
        ratedOuterDimensionEvidenceType !== null
        || ratedOuterDimensionEvidenceReference !== null
      )
    )
  ) {
    fail(
      'PACKAGING_MATERIAL_RATED_OUTER_FACTS_REQUIRED',
      'Rated outer dimensions require length, width, height, evidence type, and evidence reference together',
      409,
    )
  }
  const dimensionBasis = textValue(
    value.dimensionBasis || 'unspecified',
    'Dimension basis',
    20,
  ) as PackagingMaterialInput['dimensionBasis']
  if (!PACKAGING_DIMENSION_BASES.includes(dimensionBasis)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Dimension basis is invalid')
  }
  const dimensionEvidenceType = textValue(
    value.dimensionEvidenceType || 'unknown',
    'Dimension evidence type',
    30,
  ) as PackagingMaterialInput['dimensionEvidenceType']
  if (!PACKAGING_DIMENSION_EVIDENCE_TYPES.includes(dimensionEvidenceType)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Dimension evidence type is invalid')
  }
  const dimensionEvidenceReference = optionalTextValue(
    value.dimensionEvidenceReference,
    'Dimension evidence reference',
    500,
  )
  if (
    (
      ['customer_confirmed', 'provider'].includes(dimensionEvidenceType)
      || (
        status === 'active'
        && packagingDimensionEvidenceReferenceRequired(dimensionEvidenceType)
      )
    )
    && dimensionEvidenceReference === null
  ) {
    fail(
      'PACKAGING_MATERIAL_EVIDENCE_REQUIRED',
      'Provide the retained evidence reference for these dimensions',
      409,
    )
  }
  if (
    dimensionEvidenceType === 'measured'
    && (
      innerLengthMm === null
      || innerWidthMm === null
      || innerHeightMm === null
    )
  ) {
    fail(
      'PACKAGING_MATERIAL_PHYSICAL_FACTS_REQUIRED',
      'Measured evidence requires exact positive length, width, and height',
      409,
    )
  }
  const tareWeightGrams = optionalIntegerValue(
    value.tareWeightGrams,
    'Tare weight',
    1,
    100_000_000,
  )
  const maxWeightGrams = optionalIntegerValue(
    value.maxWeightGrams,
    'Maximum weight',
    1,
    100_000_000,
  )
  if (
    maxWeightGrams !== null
    && tareWeightGrams !== null
    && maxWeightGrams <= tareWeightGrams
  ) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Maximum weight must be greater than tare weight',
    )
  }
  const unitCostMinor = optionalIntegerValue(
    value.unitCostMinor,
    'Unit material cost',
    1,
    1_000_000_000,
  )
  const currency = unitCostMinor === null
    ? null
    : textValue(value.currency || 'USD', 'Currency', 3).toUpperCase()
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Currency must be a three-letter code')
  }
  if (status === 'active' && unitCostMinor === null) {
    fail(
      'PACKAGING_MATERIAL_COST_REQUIRED',
      'Record the actual unit material cost before activation',
      409,
    )
  }
  const source = textValue(
    value.source || 'manual',
    'Packaging material source',
    30,
  ) as PackagingMaterialInput['source']
  if (!PACKAGING_MATERIAL_SOURCES.includes(source)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Packaging material source is invalid')
  }
  if (source === 'shopify_import' && !globalId) {
    fail(
      'PACKAGING_MATERIAL_ACTION_INVALID',
      'Create Shopify package materials through the verified import workflow',
    )
  }
  if (
    status === 'active'
    && (
      innerLengthMm === null
      || innerWidthMm === null
      || innerHeightMm === null
      || dimensionBasis !== 'inner'
      || dimensionEvidenceType === 'unknown'
      || tareWeightGrams === null
      || maxWeightGrams === null
    )
  ) {
    fail(
      'PACKAGING_MATERIAL_PHYSICAL_FACTS_REQUIRED',
      'Activation requires verified inner dimensions, tare weight, and maximum weight',
      409,
    )
  }
  return {
    globalId,
    expectedRowVersion,
    code,
    name: textValue(value.name, 'Packaging material name', 120),
    materialType,
    innerLengthMm,
    innerWidthMm,
    innerHeightMm,
    ratedOuterLengthMm,
    ratedOuterWidthMm,
    ratedOuterHeightMm,
    ratedOuterDimensionEvidenceType,
    ratedOuterDimensionEvidenceReference,
    dimensionBasis,
    dimensionEvidenceType,
    dimensionEvidenceReference,
    tareWeightGrams,
    maxWeightGrams,
    unitCostMinor,
    currency,
    status,
    source,
  }
}

function stockInput(value: Record<string, unknown>): PackagingMaterialStockInput {
  assertFields(value, STOCK_FIELDS)
  const warehouseId = textValue(value.warehouseId, 'Warehouse', 40)
  if (!UUID.test(warehouseId)) {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Warehouse is invalid')
  }
  const expectedRowVersion = value.expectedRowVersion === undefined
    ? undefined
    : integerValue(
      value.expectedRowVersion,
      'Warehouse stock version',
      0,
      2_147_483_647,
    )
  if (typeof value.isAvailable !== 'boolean') {
    fail('PACKAGING_MATERIAL_REQUEST_INVALID', 'Warehouse availability is invalid')
  }
  const onHandQuantity = optionalIntegerValue(
    value.onHandQuantity,
    'On-hand quantity',
    0,
    100_000_000,
  )
  if (value.isAvailable && onHandQuantity === null) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'On-hand quantity is required when a material is available',
    )
  }
  const reorderPointQuantity = optionalIntegerValue(
    value.reorderPointQuantity,
    'Reorder point',
    0,
    100_000_000,
  )
  const reorderToQuantity = optionalIntegerValue(
    value.reorderToQuantity,
    'Reorder-to quantity',
    1,
    100_000_000,
  )
  if ((reorderPointQuantity === null) !== (reorderToQuantity === null)) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Reorder point and reorder-to quantity must be set together',
    )
  }
  if (
    reorderPointQuantity !== null
    && reorderToQuantity !== null
    && reorderPointQuantity > reorderToQuantity
  ) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'Reorder-to quantity must be at least the reorder point',
    )
  }
  return {
    materialGlobalId: materialGlobalId(value.materialGlobalId),
    warehouseId,
    expectedRowVersion,
    isAvailable: value.isAvailable,
    onHandQuantity,
    reorderPointQuantity,
    reorderToQuantity,
  }
}

function idempotencyKey(req: NextRequest) {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    fail(
      'PACKAGING_MATERIAL_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return key
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    fail(
      'PACKAGING_MATERIAL_CONTENT_TYPE_INVALID',
      'Packaging material commands require JSON',
      415,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'PACKAGING_MATERIAL_REQUEST_TOO_LARGE',
      'Packaging material command exceeded the supported size',
      413,
    )
  }
  try {
    return record(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof PackagingMaterialRequestError) throw error
    fail(
      'PACKAGING_MATERIAL_REQUEST_INVALID',
      'A valid packaging material command is required',
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof PackagingMaterialRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Packaging material request failed',
    code: 'PACKAGING_MATERIAL_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const packagingMaterials = await readPackagingMaterialsWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canManage: capabilities.canManage,
    })
    return json({ ok: true, packagingMaterials })
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
        error: 'You do not have permission to manage packaging materials',
        code: 'PACKAGING_MATERIAL_MANAGE_REQUIRED',
      }, 403)
    }
    const body = await requestBody(req)
    const action = textValue(body.action, 'Packaging material action', 60)
    const organizationId = activeOperationsOrganizationId(actor)
    if (action === 'save-material') {
      const result = await savePackagingMaterialInPostgres({
        organizationId,
        actorEmail: actor.email,
        material: materialInput(body),
      })
      return json({ ok: true, capabilities, result }, body.globalId ? 200 : 201)
    }
    if (action === 'save-stock') {
      const result = await savePackagingMaterialStockInPostgres({
        organizationId,
        actorEmail: actor.email,
        stock: stockInput(body),
      })
      return json({ ok: true, capabilities, result }, body.expectedRowVersion === undefined ? 201 : 200)
    }
    if (action === 'create-starter-assortment') {
      assertFields(body, new Set(['action']))
      const result = await createStarterPackagingAssortmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
      })
      return json({ ok: true, capabilities, result }, result.replayed ? 200 : 201)
    }
    if (action === 'remove-material') {
      assertFields(body, new Set([
        'action', 'materialGlobalId', 'expectedRowVersion',
      ]))
      const result = await removePackagingMaterialInPostgres({
        organizationId,
        actorEmail: actor.email,
        materialGlobalId: materialGlobalId(body.materialGlobalId),
        expectedRowVersion: integerValue(
          body.expectedRowVersion,
          'Packaging material version',
          0,
          2_147_483_647,
        ),
        idempotencyKey: idempotencyKey(req),
      })
      return json({ ok: true, capabilities, result })
    }
    fail('PACKAGING_MATERIAL_ACTION_INVALID', 'Packaging material action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
