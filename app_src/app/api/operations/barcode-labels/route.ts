import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  assertBarcodeArtifactGlobalId,
  generateOperationsBarcodeLabelBatchInPostgres,
  readOperationsBarcodeLabelWorkspaceFromPostgres,
} from '@/lib/persistence/operationBarcodeLabels'
import { enqueueOperationsPrintJobInPostgres } from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { updateWearableLocationScanPolicyInPostgres } from '@/lib/persistence/wearableLocationScanPolicy'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 24 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTER_GLOBAL_ID = /^gpr(?:[0-9]{7}|[0-9a-v]{12})$/
const ACTION_FIELDS: Record<string, Set<string>> = {
  'generate-batch': new Set([
    'action', 'warehouseGlobalId', 'targetType', 'media', 'selections',
  ]),
  'enqueue-batch': new Set([
    'action', 'warehouseId', 'sourceArtifactGlobalId',
    'preferredPrinterGlobalId', 'maxAttempts',
  ]),
  'update-location-scan-policy': new Set([
    'action', 'warehouseGlobalId', 'locationScanRequired', 'expectedRowVersion',
  ]),
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function textValue(value: unknown, label: string, maximum = 200) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', `${label} is invalid`)
  }
  return normalized
}

function idempotencyKey(req: NextRequest) {
  return textValue(req.headers.get('idempotency-key'), 'Idempotency-Key')
}

async function command(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    fail('OPERATIONS_BARCODE_LABEL_CONTENT_TYPE_INVALID', 'Barcode label commands require JSON', 415)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail('OPERATIONS_BARCODE_LABEL_REQUEST_TOO_LARGE', 'Barcode label command exceeded the supported size', 413)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'A valid barcode label command is required')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Barcode label command is invalid')
  }
  const value = parsed as Record<string, unknown>
  const action = String(value.action || '')
  const allowed = ACTION_FIELDS[action]
  if (!allowed || Object.keys(value).some((field) => !allowed.has(field))) {
    fail(
      'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
      'Barcode label command includes an unsupported action or field',
    )
  }
  return { action, value }
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
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  console.error('[barcode-labels] request failed', {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return json({
    ok: false,
    error: 'Barcode label request failed',
    code: 'OPERATIONS_BARCODE_LABEL_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      fail('OPERATIONS_POSTGRES_REQUIRED', 'Barcode labels require Postgres storage', 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const workspace = await readOperationsBarcodeLabelWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canManage: capabilities.canManage,
      canExecute: capabilities.canExecute,
    })
    return json({ ok: true, workspace })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      fail('OPERATIONS_POSTGRES_REQUIRED', 'Barcode labels require Postgres storage', 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      fail(
        'OPERATIONS_MANAGE_REQUIRED',
        'Operations management permission is required to manage barcode labels and scan policy',
        403,
      )
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const parsed = await command(req)
    const key = idempotencyKey(req)
    if (parsed.action === 'generate-batch') {
      const selections = parsed.value.selections
      if (!Array.isArray(selections)) {
        fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Barcode label selections are invalid')
      }
      const batch = await generateOperationsBarcodeLabelBatchInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        warehouseGlobalId: textValue(parsed.value.warehouseGlobalId, 'Warehouse', 16),
        targetType: textValue(parsed.value.targetType, 'Label type', 20) as 'product' | 'location',
        media: textValue(parsed.value.media, 'Label media', 20) as
          | 'label_2x1'
          | 'label_3x1'
          | 'label_4x2'
          | 'label_4x6'
          | 'label_4x8',
        selections: selections.map((selection) => {
          if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
            fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Barcode label selection is invalid')
          }
          const value = selection as Record<string, unknown>
          if (Object.keys(value).some((field) => field !== 'globalId' && field !== 'copies')) {
            fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Barcode label selection has unsupported fields')
          }
          return { globalId: String(value.globalId || ''), copies: Number(value.copies) }
        }),
      })
      return json({ ok: true, batch })
    }
    if (parsed.action === 'update-location-scan-policy') {
      if (typeof parsed.value.locationScanRequired !== 'boolean') {
        fail(
          'OPERATIONS_BARCODE_LABEL_REQUEST_INVALID',
          'Location scan setting must be true or false',
        )
      }
      const expectedRowVersion = Number(parsed.value.expectedRowVersion)
      if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 0) {
        fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Expected row version is invalid')
      }
      const policy = await updateWearableLocationScanPolicyInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        warehouseGlobalId: textValue(parsed.value.warehouseGlobalId, 'Warehouse', 16),
        locationScanRequired: parsed.value.locationScanRequired,
        expectedRowVersion,
      })
      return json({ ok: true, policy })
    }
    if (!capabilities.canExecute) {
      fail(
        'OPERATIONS_EXECUTE_REQUIRED',
        'Warehouse execution permission is required to queue barcode labels',
        403,
      )
    }
    const warehouseId = textValue(parsed.value.warehouseId, 'Warehouse', 40)
    if (!UUID.test(warehouseId)) {
      fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Warehouse is invalid')
    }
    const preferredPrinter = parsed.value.preferredPrinterGlobalId === null
      || parsed.value.preferredPrinterGlobalId === undefined
      || parsed.value.preferredPrinterGlobalId === ''
      ? null
      : textValue(parsed.value.preferredPrinterGlobalId, 'Preferred printer', 16)
    if (preferredPrinter && !PRINTER_GLOBAL_ID.test(preferredPrinter)) {
      fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Preferred printer is invalid')
    }
    const maxAttempts = parsed.value.maxAttempts === undefined
      ? undefined
      : Number(parsed.value.maxAttempts)
    if (maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
      fail('OPERATIONS_BARCODE_LABEL_REQUEST_INVALID', 'Maximum attempts is invalid')
    }
    const job = await enqueueOperationsPrintJobInPostgres({
      organizationId,
      actorEmail: actor.email,
      idempotencyKey: key,
      warehouseId,
      preferredPrinterGlobalId: preferredPrinter,
      maxAttempts,
      document: {
        type: 'barcode_label_artifact',
        sourceArtifactGlobalId: assertBarcodeArtifactGlobalId(parsed.value.sourceArtifactGlobalId),
      },
    })
    return json({ ok: true, job })
  } catch (error) {
    return errorResponse(error)
  }
}
