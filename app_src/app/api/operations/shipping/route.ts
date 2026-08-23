import { NextRequest, NextResponse } from 'next/server'

import {
  activeOperationsOrganizationId,
  shippingCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readShippingWorkspaceFromPostgres } from '@/lib/persistence/shipping'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'Shipping requires Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = shippingCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to shipping data',
        code: 'SHIPPING_VIEW_REQUIRED',
      }, 403)
    }
    const shipping = await readShippingWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      canView: capabilities.canView,
      canCreate: capabilities.canCreate,
      canPurchaseLivePostage: capabilities.canPurchaseLivePostage,
    })
    return json({ ok: true, shipping })
  } catch (error) {
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
    console.error('[operations-shipping] request failure', {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return json({
      ok: false,
      error: 'Shipping data is unavailable',
      code: 'SHIPPING_REQUEST_FAILED',
    }, 500)
  }
}
