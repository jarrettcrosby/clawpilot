import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  importOperationsExternalFulfillmentLabelInPostgres,
} from '@/lib/persistence/operationExternalFulfillmentLabels'
import { OperationsRequestError } from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 11 * 1024 * 1024

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

function formText(form: FormData, field: string, maxLength: number) {
  const value = form.get(field)
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    !normalized
    || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail('OPERATIONS_EXTERNAL_LABEL_REQUEST_INVALID', `${field} is invalid`)
  }
  return normalized
}

function formatFromUpload(file: File, requested: string) {
  const filename = file.name.toLowerCase()
  const mime = file.type.toLowerCase()
  const inferred = filename.endsWith('.zpl')
    || mime === 'application/vnd.zebra-zpl'
    || mime === 'text/plain'
    ? 'ZPL'
    : filename.endsWith('.pdf') || mime === 'application/pdf'
      ? 'PDF'
      : filename.endsWith('.png') || mime === 'image/png'
        ? 'PNG'
        : null
  if (!inferred || requested !== inferred) {
    fail(
      'OPERATIONS_EXTERNAL_LABEL_FORMAT_INVALID',
      'The selected format must match a .zpl, .pdf, or .png label file',
    )
  }
  return inferred
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
    error: 'External fulfillment label import failed',
    code: 'OPERATIONS_EXTERNAL_LABEL_IMPORT_FAILED',
  }, 500)
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      fail(
        'OPERATIONS_POSTGRES_REQUIRED',
        'External label artifacts require Postgres storage',
        503,
      )
    }
    const contentType = String(req.headers.get('content-type') || '')
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
      fail(
        'OPERATIONS_EXTERNAL_LABEL_CONTENT_TYPE_INVALID',
        'External label imports require multipart form data',
        415,
      )
    }
    const contentLength = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
      fail(
        'OPERATIONS_EXTERNAL_LABEL_REQUEST_TOO_LARGE',
        'External label import exceeded the 10 MB label limit',
        413,
      )
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage || !capabilities.canExecute) {
      return json({
        ok: false,
        error: 'External label import requires operations management and warehouse execution access',
        code: 'OPERATIONS_EXTERNAL_LABEL_IMPORT_REQUIRED',
      }, 403)
    }
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File) || file.size < 1 || file.size > 10 * 1024 * 1024) {
      fail(
        'OPERATIONS_EXTERNAL_LABEL_FILE_INVALID',
        'Choose one original ZPL, PDF, or PNG label up to 10 MB',
      )
    }
    const format = formatFromUpload(
      file,
      formText(form, 'format', 3).toUpperCase(),
    )
    const media = formText(form, 'media', 16)
    if (media !== 'label_4x6' && media !== 'label_4x8') {
      fail('OPERATIONS_EXTERNAL_LABEL_MEDIA_INVALID', 'Label media is invalid')
    }
    const expectedOrderRowVersion = Number(
      formText(form, 'expectedOrderRowVersion', 20),
    )
    if (!Number.isSafeInteger(expectedOrderRowVersion) || expectedOrderRowVersion < 0) {
      fail('OPERATIONS_EXTERNAL_LABEL_VERSION_INVALID', 'Order version is invalid')
    }
    const result = await importOperationsExternalFulfillmentLabelInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      idempotencyKey: String(req.headers.get('idempotency-key') || '').trim(),
      orderGlobalId: formText(form, 'orderGlobalId', 20),
      expectedOrderRowVersion,
      reconciliationGlobalId: formText(form, 'reconciliationGlobalId', 20),
      trackingNumber: formText(form, 'trackingNumber', 255),
      format,
      media,
      filename: file.name,
      payload: new Uint8Array(await file.arrayBuffer()),
      reason: formText(form, 'reason', 500),
    })
    return json({ ok: true, result }, result.replayed ? 200 : 201)
  } catch (error) {
    return errorResponse(error)
  }
}
