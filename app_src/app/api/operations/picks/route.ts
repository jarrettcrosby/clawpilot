import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readAssignedWearablePickQueueFromPostgres } from '@/lib/persistence/wearablePicking'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        code: 'OPERATIONS_POSTGRES_REQUIRED',
        error: 'Wearable picking requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView || !capabilities.canExecute) {
      return json({
        ok: false,
        code: 'OPERATIONS_WEARABLE_PICKING_REQUIRED',
        error: 'Wearable picking requires Operations view and warehouse execution permission',
      }, 403)
    }
    const queue = await readAssignedWearablePickQueueFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      workerEmail: actor.email,
      publicOrigin: req.nextUrl.origin,
    })
    return json({ ok: true, capabilities, queue })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({ ok: false, code: error.message, error: 'Select an active organization first' }, 409)
    }
    console.error('[wearable-picking] queue read failed', {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return json({
      ok: false,
      code: 'OPERATIONS_WEARABLE_PICKING_FAILED',
      error: 'Wearable pick queue could not be loaded',
    }, 500)
  }
}
