import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  ORDER_SHIP_TO_FIELDS,
  type OrderShipToField,
  type OrderShipToPatch,
} from '@/lib/operations/orderShipTo'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceOrderWorkbenchError,
  readCommerceOrderWorkbenchFromPostgres,
  updateCommerceOrderWorkbenchShipToInPostgres,
} from '@/lib/persistence/commerceOrderWorkbench'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const SHIP_TO_FIELDS = new Set<string>(ORDER_SHIP_TO_FIELDS)
const SHIP_TO_LIMITS: Record<OrderShipToField, number> = {
  name: 120,
  line1: 160,
  line2: 160,
  city: 100,
  region: 100,
  postalCode: 30,
  country: 64,
}

class CommerceOrderWorkbenchApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CommerceOrderWorkbenchApiError'
    this.code = code
    this.status = status
  }
}

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new CommerceOrderWorkbenchApiError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Operations requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function assertFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      `${label} includes an unsupported field`,
    )
  }
}

function candidateGlobalIdValue(value: unknown) {
  const candidateGlobalId = String(value || '').trim()
  if (!CANDIDATE_GLOBAL_ID.test(candidateGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_INVALID',
      'Imported order is invalid',
    )
  }
  return candidateGlobalId
}

function rowVersionValue(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_VERSION_INVALID',
      'Imported order version is invalid',
    )
  }
  return Number(value)
}

function idempotencyKeyValue(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (!value || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

function shipToPatchValue(value: unknown): OrderShipToPatch {
  const input = record(value, 'Ship-to changes')
  assertFields(input, SHIP_TO_FIELDS, 'Ship-to changes')
  if (!Object.keys(input).length) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_EDIT_EMPTY',
      'Choose at least one ship-to field to update',
    )
  }
  const changes: OrderShipToPatch = {}
  for (const field of ORDER_SHIP_TO_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const raw = input[field]
    if (raw === null) {
      changes[field] = null
      continue
    }
    if (
      typeof raw !== 'string'
      || raw.length > SHIP_TO_LIMITS[field]
      || /[\u0000-\u001f\u007f]/u.test(raw)
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_SHIP_TO_INVALID',
        `Ship-to ${field} is invalid`,
      )
    }
    changes[field] = raw
  }
  return changes
}

async function requestBody(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestError(
      'OPERATIONS_CONTENT_TYPE_INVALID',
      'Order edits require JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Order edit exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Order edit exceeded the supported size',
      413,
    )
  }
  try {
    return record(JSON.parse(raw) as unknown, 'Order edit')
  } catch (error) {
    if (error instanceof CommerceOrderWorkbenchApiError) throw error
    requestError('OPERATIONS_REQUEST_INVALID', 'A valid order edit is required')
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return response({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    }, 401)
  }
  if (
    error instanceof CommerceOrderWorkbenchApiError
    || error instanceof CommerceOrderWorkbenchError
  ) {
    return response({
      ok: false,
      code: error.code,
      error: error.message,
    }, error.status)
  }
  console.error('[operations-order-workbench] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return response({
    ok: false,
    code: 'OPERATIONS_IMPORTED_ORDER_REQUEST_FAILED',
    error: 'Imported order could not be loaded or saved',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return response({
        ok: false,
        code: 'OPERATIONS_VIEW_REQUIRED',
        error: 'You do not have permission to view Operations orders',
      }, 403)
    }
    const search = String(req.nextUrl.searchParams.get('search') || '').trim()
    if (search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search)) {
      requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
    }
    const candidateValue = String(
      req.nextUrl.searchParams.get('candidate') || '',
    ).trim()
    const orders = await readCommerceOrderWorkbenchFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      search,
      candidateGlobalId: candidateValue
        ? candidateGlobalIdValue(candidateValue)
        : null,
    })
    return response({ ok: true, orders })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'You do not have permission to edit Operations orders',
      }, 403)
    }
    const body = await requestBody(req)
    assertFields(
      body,
      new Set(['candidateGlobalId', 'expectedRowVersion', 'shipTo']),
      'Order edit',
    )
    const candidateGlobalId = candidateGlobalIdValue(body.candidateGlobalId)
    const result = await updateCommerceOrderWorkbenchShipToInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      idempotencyKey: idempotencyKeyValue(req),
      candidateGlobalId,
      expectedRowVersion: rowVersionValue(body.expectedRowVersion),
      changes: shipToPatchValue(body.shipTo),
    })
    const [order] = await readCommerceOrderWorkbenchFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      candidateGlobalId,
    })
    return response({ ok: true, result, order: order || null })
  } catch (error) {
    return errorResponse(error)
  }
}
