import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  attestOperationsPrintJobPhysicalOutputInPostgres,
  cancelOperationsPrintJobInPostgres,
  enqueueOperationsPrintJobInPostgres,
  readOperationsPrintJobWorkspaceFromPostgres,
  reprintOperationsPrintJobInPostgres,
  retryOperationsPrintJobInPostgres,
  type EnqueueOperationsPrintJobInput,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 12 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRINTER_GLOBAL_ID = /^gpr(?:[0-9]{7}|[0-9a-v]{12})$/
const JOB_GLOBAL_ID = /^gpj(?:[0-9]{7}|[0-9a-v]{12})$/
const LABEL_GLOBAL_ID = /^glb(?:[0-9]{7}|[0-9a-v]{12})$/
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const SHIPMENT_GLOBAL_ID = /^gsh(?:[0-9]{7}|[0-9a-v]{12})$/
const ARTIFACT_GLOBAL_ID = /^gpf(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256 = /^[a-f0-9]{64}$/
const ACTION_FIELDS: Record<string, Set<string>> = {
  'enqueue-label': new Set([
    'action', 'warehouseId', 'sourceLabelGlobalId', 'media',
    'preferredPrinterGlobalId', 'maxAttempts',
  ]),
  'enqueue-packing-slip': new Set([
    'action', 'warehouseId', 'format', 'media', 'contentSha256',
    'byteLength', 'storageReference', 'sourceOrderGlobalId',
    'sourceShipmentGlobalId', 'preferredPrinterGlobalId', 'maxAttempts',
  ]),
  'enqueue-packing-slip-artifact': new Set([
    'action', 'warehouseId', 'sourceArtifactGlobalId',
    'preferredPrinterGlobalId', 'maxAttempts',
  ]),
  'enqueue-external-label-artifact': new Set([
    'action', 'warehouseId', 'sourceArtifactGlobalId',
    'preferredPrinterGlobalId', 'maxAttempts',
  ]),
  'retry-job': new Set(['action', 'jobGlobalId', 'reason']),
  'reprint-job': new Set(['action', 'jobGlobalId', 'reason']),
  'cancel-job': new Set(['action', 'jobGlobalId', 'reason']),
  'attest-physical-output': new Set([
    'action', 'jobGlobalId', 'expectedDeliveryAttemptId',
    'expectedDeliveryAttemptSequenceNumber', 'reason',
  ]),
}

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
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail('OPERATIONS_POSTGRES_REQUIRED', 'Print jobs require Postgres storage', 503)
  }
}

function text(value: unknown, label: string, max: number) {
  const parsed = String(value ?? '').trim()
  if (!parsed || parsed.length > max || /[\u0000-\u001f\u007f]/.test(parsed)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed
}

function idempotencyKey(req: NextRequest) {
  return text(req.headers.get('idempotency-key'), 'Idempotency-Key', 200)
}

function optionalPrinter(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const globalId = text(value, 'Preferred printer', 16)
  if (!PRINTER_GLOBAL_ID.test(globalId)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Preferred printer is invalid')
  }
  return globalId
}

function optionalSourceGlobalId(
  value: unknown,
  label: string,
  pattern: RegExp,
) {
  if (value === null || value === undefined || value === '') return null
  const globalId = text(value, label, 16)
  if (!pattern.test(globalId)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', `${label} is invalid`)
  }
  return globalId
}

function positiveInteger(value: unknown, label: string, min: number, max: number) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed
}

async function body(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    fail('OPERATIONS_PRINT_JOB_CONTENT_TYPE_INVALID', 'Print-job commands require JSON', 415)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_TOO_LARGE', 'Print-job command exceeded the supported size', 413)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'A valid print-job command is required')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Print-job command is invalid')
  }
  const value = parsed as Record<string, unknown>
  const action = String(value.action || '')
  const fields = ACTION_FIELDS[action]
  if (!fields || Object.keys(value).some((field) => !fields.has(field))) {
    fail(
      'OPERATIONS_PRINT_JOB_REQUEST_INVALID',
      'Print-job command includes an unsupported action or field',
    )
  }
  return { action, value }
}

function warehouseId(value: unknown) {
  const id = text(value, 'Warehouse', 40)
  if (!UUID.test(id)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Warehouse is invalid')
  }
  return id
}

function jobGlobalId(value: unknown) {
  const id = text(value, 'Print job Global ID', 16)
  if (!JOB_GLOBAL_ID.test(id)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Print job Global ID is invalid')
  }
  return id
}

function deliveryAttemptId(value: unknown) {
  const id = text(value, 'Delivered attempt', 36).toLowerCase()
  if (!UUID.test(id)) {
    fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Delivered attempt is invalid')
  }
  return id
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
  return json({
    ok: false,
    error: 'Print-job request failed',
    code: 'OPERATIONS_PRINT_JOB_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const jobs = await readOperationsPrintJobWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canManage: capabilities.canManage,
      canExecute: capabilities.canExecute,
    })
    return json({ ok: true, jobs })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const command = await body(req)
    const organizationId = activeOperationsOrganizationId(actor)
    const key = idempotencyKey(req)
    if (command.action === 'attest-physical-output') {
      if (!capabilities.canExecute) {
        return json({
          ok: false,
          error: 'Confirming physical output requires warehouse execution access',
          code: 'OPERATIONS_PRINT_PHYSICAL_OUTPUT_VERIFY_REQUIRED',
        }, 403)
      }
      const job = await attestOperationsPrintJobPhysicalOutputInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        jobGlobalId: jobGlobalId(command.value.jobGlobalId),
        expectedDeliveryAttemptId: deliveryAttemptId(
          command.value.expectedDeliveryAttemptId,
        ),
        expectedDeliveryAttemptSequenceNumber: positiveInteger(
          command.value.expectedDeliveryAttemptSequenceNumber,
          'Delivered attempt sequence',
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        reason: text(
          command.value.reason,
          'Physical-output confirmation reason',
          500,
        ),
      })
      return json({ ok: true, job })
    }
    if (command.action === 'reprint-job') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'Reprinting requires printer management and warehouse execution access',
          code: 'OPERATIONS_PRINT_REPRINT_REQUIRED',
        }, 403)
      }
      const job = await reprintOperationsPrintJobInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        jobGlobalId: jobGlobalId(command.value.jobGlobalId),
        reason: text(command.value.reason, 'Reprint reason', 500),
      })
      return json({ ok: true, job })
    }
    if (command.action === 'cancel-job') {
      if (!capabilities.canExecute && !capabilities.canManage) {
        return json({
          ok: false,
          error: 'Cancelling print jobs requires warehouse execution or printer management access',
          code: 'OPERATIONS_PRINT_CANCEL_REQUIRED',
        }, 403)
      }
      const job = await cancelOperationsPrintJobInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        jobGlobalId: jobGlobalId(command.value.jobGlobalId),
        reason: text(command.value.reason, 'Cancellation reason', 500),
      })
      return json({ ok: true, job })
    }
    if (!capabilities.canExecute) {
      return json({
        ok: false,
        error: 'Print-job commands require warehouse execution access',
        code: 'OPERATIONS_PRINT_EXECUTE_REQUIRED',
      }, 403)
    }
    if (command.action === 'retry-job') {
      const job = await retryOperationsPrintJobInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: key,
        jobGlobalId: jobGlobalId(command.value.jobGlobalId),
        reason: text(command.value.reason, 'Retry reason', 500),
      })
      return json({ ok: true, job })
    }
    const common = {
      organizationId,
      actorEmail: actor.email,
      idempotencyKey: key,
      warehouseId: warehouseId(command.value.warehouseId),
      preferredPrinterGlobalId: optionalPrinter(command.value.preferredPrinterGlobalId),
      maxAttempts: command.value.maxAttempts === undefined
        ? undefined
        : positiveInteger(command.value.maxAttempts, 'Maximum attempts', 1, 10),
    }
    let enqueue: EnqueueOperationsPrintJobInput
    if (command.action === 'enqueue-label') {
      const sourceLabelGlobalId = text(command.value.sourceLabelGlobalId, 'Shipping label', 16)
      if (!LABEL_GLOBAL_ID.test(sourceLabelGlobalId)) {
        fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Shipping label is invalid')
      }
      if (command.value.media !== 'label_4x6' && command.value.media !== 'label_4x8') {
        fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Shipping-label media is invalid')
      }
      enqueue = {
        ...common,
        document: {
          type: 'shipping_label',
          sourceLabelGlobalId,
          media: command.value.media,
        },
      }
    } else if (command.action === 'enqueue-packing-slip-artifact') {
      const sourceArtifactGlobalId = text(
        command.value.sourceArtifactGlobalId,
        'Pack Work Instruction artifact',
        16,
      )
      if (!ARTIFACT_GLOBAL_ID.test(sourceArtifactGlobalId)) {
        fail(
          'OPERATIONS_PRINT_JOB_REQUEST_INVALID',
          'Pack Work Instruction artifact is invalid',
        )
      }
      enqueue = {
        ...common,
        document: {
          type: 'packing_slip_artifact',
          sourceArtifactGlobalId,
        },
      }
    } else if (command.action === 'enqueue-external-label-artifact') {
      const sourceArtifactGlobalId = text(
        command.value.sourceArtifactGlobalId,
        'External shipping-label artifact',
        16,
      )
      if (!ARTIFACT_GLOBAL_ID.test(sourceArtifactGlobalId)) {
        fail(
          'OPERATIONS_PRINT_JOB_REQUEST_INVALID',
          'External shipping-label artifact is invalid',
        )
      }
      enqueue = {
        ...common,
        document: {
          type: 'external_shipping_label_artifact',
          sourceArtifactGlobalId,
        },
      }
    } else {
      if (command.value.format !== 'PDF' && command.value.format !== 'PNG') {
        fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Packing-slip format is invalid')
      }
      if (command.value.media !== 'letter' && command.value.media !== 'a4') {
        fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Packing-slip media is invalid')
      }
      const contentSha256 = text(command.value.contentSha256, 'Content checksum', 64).toLowerCase()
      if (!SHA256.test(contentSha256)) {
        fail('OPERATIONS_PRINT_JOB_REQUEST_INVALID', 'Content checksum is invalid')
      }
      enqueue = {
        ...common,
        document: {
          type: 'packing_slip',
          format: command.value.format,
          media: command.value.media,
          contentSha256,
          byteLength: positiveInteger(
            command.value.byteLength,
            'Artifact byte length',
            1,
            50 * 1024 * 1024,
          ),
          storageReference: text(command.value.storageReference, 'Storage reference', 1000),
          sourceOrderGlobalId: optionalSourceGlobalId(
            command.value.sourceOrderGlobalId,
            'Source order',
            ORDER_GLOBAL_ID,
          ),
          sourceShipmentGlobalId: optionalSourceGlobalId(
            command.value.sourceShipmentGlobalId,
            'Source shipment',
            SHIPMENT_GLOBAL_ID,
          ),
        },
      }
    }
    const job = await enqueueOperationsPrintJobInPostgres(enqueue)
    return json({ ok: true, job })
  } catch (error) {
    return errorResponse(error)
  }
}
