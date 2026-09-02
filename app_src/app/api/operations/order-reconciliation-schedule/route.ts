import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceOrderSyncError,
  scheduleAllCommerceOrderHistoryRefreshesInPostgres,
} from '@/lib/persistence/commerceOrderSync'
import {
  CommerceOrderRevisionDispositionError,
  scheduleAllCommerceOrderRevisionRefreshesInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,120}$/u
const GLOBAL_ORDER_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAX_EXCLUDED_ORDERS = 100
const MAX_REQUEST_BYTES = 4096

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_POSTGRES_REQUIRED',
        error: 'Historical sales-channel order refresh requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'Operations management permission is required to refresh historical orders',
      }, 403)
    }
    if (req.nextUrl.search.length > 0) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_QUERY_INVALID',
        error: 'Historical sales-channel order refresh does not accept query parameters',
      }, 400)
    }
    const idempotencyKey = req.headers.get('idempotency-key') || ''
    if (
      idempotencyKey !== idempotencyKey.trim()
      || !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_IDEMPOTENCY_KEY_INVALID',
        error: 'A valid Idempotency-Key header is required',
      }, 400)
    }
    const rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
        error: 'Historical sales-channel order refresh input is invalid',
      }, 400)
    }
    let body: unknown = {}
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
        error: 'Historical sales-channel order refresh input is invalid',
      }, 400)
    }
    const record = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null
    const keys = record ? Object.keys(record) : []
    const excludeOrderGlobalIds = record?.excludeOrderGlobalIds === undefined
      ? []
      : record.excludeOrderGlobalIds
    if (
      !record
      || keys.some((key) => key !== 'excludeOrderGlobalIds')
      || !Array.isArray(excludeOrderGlobalIds)
      || excludeOrderGlobalIds.length > MAX_EXCLUDED_ORDERS
      || new Set(excludeOrderGlobalIds).size !== excludeOrderGlobalIds.length
      || excludeOrderGlobalIds.some((globalId) => (
        typeof globalId !== 'string' || !GLOBAL_ORDER_ID.test(globalId)
      ))
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_BODY_INVALID',
        error: 'Historical sales-channel order refresh input is invalid',
      }, 400)
    }

    const organizationId = activeOperationsOrganizationId(actor)
    const providerHistory =
      await scheduleAllCommerceOrderHistoryRefreshesInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey,
      })
    const result = await scheduleAllCommerceOrderRevisionRefreshesInPostgres({
      organizationId,
      actorEmail: actor.email,
      idempotencyKey,
      excludeOrderGlobalIds,
    })
    return response({
      ok: true,
      result: { ...result, providerHistory },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({ ok: false, error: 'Unauthorized' }, 401)
    }
    if (error instanceof CommerceOrderRevisionDispositionError) {
      return response({
        ok: false,
        code: error.code,
        error: error.message,
      }, error.status)
    }
    if (error instanceof CommerceOrderSyncError) {
      return response({
        ok: false,
        code: error.code,
        error: error.message,
      }, error.status)
    }
    console.error('[commerce-order-reconciliation-schedule] request failed')
    return response({
      ok: false,
      code: 'COMMERCE_ORDER_RECONCILIATION_SCHEDULE_FAILED',
      error: 'Historical sales-channel orders could not be queued for refresh',
    }, 500)
  }
}
