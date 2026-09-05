import { NextRequest, NextResponse } from 'next/server'
import {
  isOperationsOrderProviderFilter,
  isOperationsOrderSortDirection,
  isOperationsOrderTrackingFilter,
  isOperationsOrderUpdatedAfter,
} from '@/lib/operations/orderListQuery'
import {
  MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE,
  isUnifiedOperationsOrderSort,
  type UnifiedOperationsOrderStatus,
} from '@/lib/operations/unifiedOrderPage'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { OperationsRequestError } from '@/lib/persistence/operations'
import {
  readUnifiedOperationsOrderPageFromPostgres,
} from '@/lib/persistence/unifiedOperationsOrderPage'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const ORDER_STATUSES = new Set<UnifiedOperationsOrderStatus>([
  'fulfilled_externally',
  'closed_externally',
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
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return response({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    }, 401)
  }
  if (
    error instanceof Error
    && error.message === 'ACTIVE_ORGANIZATION_REQUIRED'
  ) {
    return response({
      ok: false,
      code: 'ACTIVE_ORGANIZATION_REQUIRED',
      error: 'Select an active organization first',
    }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return response({
      ok: false,
      code: error.code,
      error: error.message,
    }, error.status)
  }
  console.error('[operations-unified-orders] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return response({
    ok: false,
    code: 'OPERATIONS_UNIFIED_ORDER_PAGE_FAILED',
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
      && !ORDER_STATUSES.has(statusValue as UnifiedOperationsOrderStatus)
    ) {
      requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
    }

    const sortValue = String(
      req.nextUrl.searchParams.get('sort') || 'updated',
    ).trim()
    if (!isUnifiedOperationsOrderSort(sortValue)) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_SORT_INVALID',
        'Unified order sort is invalid',
      )
    }

    const directionValue = String(
      req.nextUrl.searchParams.get('direction') || 'desc',
    ).trim()
    if (!isOperationsOrderSortDirection(directionValue)) {
      requestError(
        'OPERATIONS_ORDER_SORT_DIRECTION_INVALID',
        'Order sort direction is invalid',
      )
    }

    const providerValue = String(
      req.nextUrl.searchParams.get('provider') || '',
    ).trim()
    if (providerValue && !isOperationsOrderProviderFilter(providerValue)) {
      requestError(
        'OPERATIONS_ORDER_PROVIDER_INVALID',
        'Order provider is invalid',
      )
    }

    const trackingValue = String(
      req.nextUrl.searchParams.get('tracking') || '',
    ).trim()
    if (trackingValue && !isOperationsOrderTrackingFilter(trackingValue)) {
      requestError(
        'OPERATIONS_ORDER_TRACKING_FILTER_INVALID',
        'Order tracking filter is invalid',
      )
    }

    const updatedAfterValue = String(
      req.nextUrl.searchParams.get('updatedAfter') || '',
    ).trim()
    if (
      updatedAfterValue
      && !isOperationsOrderUpdatedAfter(updatedAfterValue)
    ) {
      requestError(
        'OPERATIONS_ORDER_UPDATED_AFTER_INVALID',
        'Order updated-after value is invalid',
      )
    }

    const cursor = String(
      req.nextUrl.searchParams.get('cursor') || '',
    ).trim()
    const snapshot = String(
      req.nextUrl.searchParams.get('snapshot') || '',
    ).trim()
    if (snapshot && !/^[A-Za-z0-9_-]{1,16384}$/u.test(snapshot)) {
      requestError(
        'OPERATIONS_ORDER_PAGE_SNAPSHOT_INVALID',
        'The order page snapshot is invalid',
      )
    }
    const pageValue = req.nextUrl.searchParams.get('page')
    let page: number | null = null
    if (pageValue !== null) {
      const normalizedPage = pageValue.trim()
      if (!/^[1-9]\d*$/u.test(normalizedPage)) {
        requestError(
          'OPERATIONS_UNIFIED_ORDER_PAGE_INVALID',
          'Unified order page is invalid',
        )
      }
      page = Number(normalizedPage)
      if (!Number.isSafeInteger(page) || page < 1) {
        requestError(
          'OPERATIONS_UNIFIED_ORDER_PAGE_INVALID',
          'Unified order page is invalid',
        )
      }
    }
    if (cursor && page !== null) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_PAGE_CURSOR_CONFLICT',
        'Unified order page and cursor cannot be combined',
      )
    }
    const pageSizeValue = String(
      req.nextUrl.searchParams.get('pageSize') || '50',
    ).trim()
    if (!/^\d{1,3}$/u.test(pageSizeValue)) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_PAGE_SIZE_INVALID',
        'Unified order page size is invalid',
      )
    }
    const pageSize = Number(pageSizeValue)
    if (
      !Number.isSafeInteger(pageSize)
      || pageSize < 1
      || pageSize > MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE
    ) {
      requestError(
        'OPERATIONS_UNIFIED_ORDER_PAGE_SIZE_INVALID',
        'Unified order page size is invalid',
      )
    }

    const result = await readUnifiedOperationsOrderPageFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      search,
      status: (statusValue as UnifiedOperationsOrderStatus) || null,
      sort: sortValue,
      direction: directionValue,
      provider: providerValue || null,
      tracking: isOperationsOrderTrackingFilter(trackingValue)
        ? trackingValue
        : null,
      updatedAfter: updatedAfterValue || null,
      cursor: cursor || null,
      page,
      snapshot: snapshot || null,
      pageSize,
    })
    return response({ ok: true, rows: result.rows, page: result.page })
  } catch (error) {
    return errorResponse(error)
  }
}
