import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceOrderSyncError,
  readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres,
  readCommerceOrderHistorySummariesFromPostgres,
  readCommerceOrderSyncStateFromPostgres,
  requestCommerceOrderBackfillInPostgres,
} from '@/lib/persistence/commerceOrderSync'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const OBSERVATION_GLOBAL_ID = /^gcoo(?:[0-9]{7}|[0-9a-v]{12})$/u

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new CommerceOrderSyncError(code, message, status)
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
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
  if (error instanceof CommerceOrderSyncError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  console.error('[commerce-order-history] request failed', {
    kind: error instanceof Error ? 'unexpected_error' : 'unexpected_value',
    code: 'COMMERCE_ORDER_HISTORY_INTERNAL_ERROR',
  })
  return json({
    ok: false,
    error: 'Order history is temporarily unavailable',
    code: 'COMMERCE_ORDER_HISTORY_INTERNAL_ERROR',
  }, 500)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'COMMERCE_ORDER_HISTORY_POSTGRES_REQUIRED',
      'Order history requires Postgres storage',
      503,
    )
  }
}

async function manager(req: NextRequest) {
  const actor = await requireRequestUser(req)
  if (!operationsCapabilities(actor).canManage) {
    requestError(
      'COMMERCE_ORDER_HISTORY_MANAGER_REQUIRED',
      'Operations-management permission is required to view order history',
      403,
    )
  }
  requirePostgres()
  return actor
}

function accountGlobalId(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!ACCOUNT_GLOBAL_ID.test(normalized)) {
    requestError(
      'COMMERCE_ORDER_HISTORY_ACCOUNT_INVALID',
      'Select a valid sales-channel connection',
    )
  }
  return normalized
}

function optionalExternalOrderId(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    normalized.length < 1
    || normalized.length > 512
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    requestError(
      'COMMERCE_ORDER_HISTORY_ORDER_INVALID',
      'The selected provider order is invalid',
    )
  }
  return normalized
}

function optionalCursor(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!OBSERVATION_GLOBAL_ID.test(normalized)) {
    requestError(
      'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
      'Reload order history before requesting another page',
    )
  }
  return normalized
}

function pageLimit(value: unknown) {
  if (value === null || value === undefined || value === '') return 25
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 50) {
    requestError(
      'COMMERCE_ORDER_HISTORY_LIMIT_INVALID',
      'Order history page size must be between 1 and 50',
    )
  }
  return normalized
}

async function requestBody(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestError(
      'COMMERCE_ORDER_HISTORY_CONTENT_TYPE_INVALID',
      'Order history requests require JSON',
      415,
    )
  }
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      requestError(
        'COMMERCE_ORDER_HISTORY_CONTENT_LENGTH_INVALID',
        'Order history request length is invalid',
      )
    }
    if (length > MAX_REQUEST_BYTES) {
      requestError(
        'COMMERCE_ORDER_HISTORY_REQUEST_TOO_LARGE',
        'Order history request exceeded the supported size',
        413,
      )
    }
  }
  const chunks: Buffer[] = []
  let receivedBytes = 0
  const reader = req.body?.getReader()
  if (reader) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      receivedBytes += next.value.byteLength
      if (receivedBytes > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel('request_too_large')
        } catch {
          // The bounded request rejection remains authoritative.
        }
        requestError(
          'COMMERCE_ORDER_HISTORY_REQUEST_TOO_LARGE',
          'Order history request exceeded the supported size',
          413,
        )
      }
      chunks.push(Buffer.from(next.value))
    }
  }
  const bytes = Buffer.concat(chunks)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    requestError(
      'COMMERCE_ORDER_HISTORY_REQUEST_INVALID',
      'Order history request must be valid JSON',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    requestError(
      'COMMERCE_ORDER_HISTORY_REQUEST_INVALID',
      'Order history request is invalid',
    )
  }
  return parsed as Record<string, unknown>
}

function idempotencyKey(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (value === null || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'COMMERCE_ORDER_HISTORY_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

export async function GET(req: NextRequest) {
  try {
    const actor = await manager(req)
    const allowed = new Set([
      'accountGlobalId',
      'cursorObservationGlobalId',
      'snapshotObservationGlobalId',
      'externalOrderId',
      'limit',
    ])
    if (Array.from(req.nextUrl.searchParams.keys()).some(
      (field) => !allowed.has(field),
    )) {
      requestError(
        'COMMERCE_ORDER_HISTORY_QUERY_INVALID',
        'Order history query parameters are invalid',
      )
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const selectedAccountGlobalId = accountGlobalId(
      req.nextUrl.searchParams.get('accountGlobalId'),
    )
    const externalOrderId = optionalExternalOrderId(
      req.nextUrl.searchParams.get('externalOrderId'),
    )
    const cursorObservationGlobalId = optionalCursor(
      req.nextUrl.searchParams.get('cursorObservationGlobalId'),
    )
    const snapshotObservationGlobalId = optionalCursor(
      req.nextUrl.searchParams.get('snapshotObservationGlobalId'),
    )
    if (
      (cursorObservationGlobalId === null)
      !== (snapshotObservationGlobalId === null)
    ) {
      requestError(
        'COMMERCE_ORDER_HISTORY_CURSOR_INVALID',
        'Reload order history before requesting another page',
      )
    }
    const [state, history, timeline] = await Promise.all([
      readCommerceOrderSyncStateFromPostgres({
        organizationId,
        accountGlobalId: selectedAccountGlobalId,
      }),
      readCommerceOrderHistorySummariesFromPostgres({
        organizationId,
        accountGlobalId: selectedAccountGlobalId,
        cursorObservationGlobalId,
        snapshotObservationGlobalId,
        limit: pageLimit(req.nextUrl.searchParams.get('limit')),
      }),
      externalOrderId
        ? readCommerceOrderEvidenceTimelineByExternalOrderFromPostgres({
            organizationId,
            accountGlobalId: selectedAccountGlobalId,
            externalOrderId,
          })
        : Promise.resolve(null),
    ])
    return json({
      ok: true,
      state,
      history,
      timeline: timeline ? {
        items: timeline.items.map((entry) => ({
          evidenceSource: entry.evidenceSource,
          evidenceGlobalId: entry.evidenceGlobalId,
          eventKind: entry.eventKind,
          eventStatus: entry.eventStatus,
          occurredAt: entry.occurredAt,
          attributionSource: entry.attributionSource,
          actorEmail: entry.actorEmail,
          locationReference: entry.locationReference,
          payload: entry.payload,
        })),
        truncated: timeline.truncated,
        limit: timeline.limit,
        providerWrites: 0,
      } : null,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await manager(req)
    const body = await requestBody(req)
    const allowed = new Set(['action', 'accountGlobalId', 'reason'])
    if (
      Object.keys(body).length !== allowed.size
      || Object.keys(body).some((field) => !allowed.has(field))
      || Array.from(allowed).some((field) => !(field in body))
      || body.action !== 'start'
    ) {
      requestError(
        'COMMERCE_ORDER_HISTORY_REQUEST_INVALID',
        'Order history request fields are invalid',
      )
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (
      reason.length < 10
      || reason.length > 500
      || /[\u0000-\u001f\u007f]/u.test(reason)
    ) {
      requestError(
        'COMMERCE_ORDER_HISTORY_REASON_INVALID',
        'Enter a reason between 10 and 500 characters',
      )
    }
    const result = await requestCommerceOrderBackfillInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      accountGlobalId: accountGlobalId(body.accountGlobalId),
      actorEmail: actor.email,
      idempotencyKey: idempotencyKey(req),
      reason,
    })
    return json({ ok: true, result })
  } catch (error) {
    return errorResponse(error)
  }
}
