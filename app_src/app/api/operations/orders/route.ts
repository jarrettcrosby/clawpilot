import { NextRequest, NextResponse } from 'next/server'
import type { OperationsOrderStatus } from '@/lib/operations/types'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  OperationsRequestError,
  readOperationsOrderPageFromPostgres,
} from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_PAGE_SIZE = 250
type OperationsOrderPageStatus = OperationsOrderStatus | 'fulfilled_externally'
const ORDER_STATUSES = new Set<OperationsOrderPageStatus>([
  'fulfilled_externally',
  'imported',
  'validated',
  'held',
  'promised',
  'reserved',
  'planned',
  'released',
  'picking',
  'packed',
  'shipped',
  'cancelled',
  'exception',
])

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
  throw new OperationsRequestError(code, message, status)
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return response({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    }, 401)
  }
  if (error instanceof OperationsRequestError) {
    return response({
      ok: false,
      code: error.code,
      error: error.message,
    }, error.status)
  }
  console.error('[operations-orders] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return response({
    ok: false,
    code: 'OPERATIONS_ORDER_PAGE_FAILED',
    error: 'Orders could not be loaded',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      requestError(
        'OPERATIONS_POSTGRES_REQUIRED',
        'Operations requires Postgres storage',
        503,
      )
    }
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
    const statusValue = String(
      req.nextUrl.searchParams.get('status') || '',
    ).trim()
    if (
      statusValue
      && !ORDER_STATUSES.has(statusValue as OperationsOrderPageStatus)
    ) {
      requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
    }
    const cursor = String(
      req.nextUrl.searchParams.get('cursor') || '',
    ).trim()
    const limitValue = String(
      req.nextUrl.searchParams.get('limit') || MAX_PAGE_SIZE,
    ).trim()
    if (!/^\d{1,3}$/u.test(limitValue)) {
      requestError('OPERATIONS_ORDER_PAGE_SIZE_INVALID', 'Order page size is invalid')
    }
    const pageSize = Number(limitValue)
    if (
      !Number.isSafeInteger(pageSize)
      || pageSize < 1
      || pageSize > MAX_PAGE_SIZE
    ) {
      requestError('OPERATIONS_ORDER_PAGE_SIZE_INVALID', 'Order page size is invalid')
    }
    const result = await readOperationsOrderPageFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      search,
      status: (statusValue as OperationsOrderPageStatus) || null,
      cursor: cursor || null,
      pageSize,
    })
    return response({ ok: true, orders: result.orders, page: result.page })
  } catch (error) {
    return errorResponse(error)
  }
}
