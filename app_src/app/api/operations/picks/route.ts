import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readAssignedWearablePickQueueFromPostgres,
  readWearablePendingConfirmationStateFromPostgres,
} from '@/lib/persistence/wearablePicking'
import { appPublicUrl } from '@/lib/publicUrl'
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
    const pendingOrderGlobalId = String(
      req.nextUrl.searchParams.get('pendingConfirmationOrderGlobalId') || '',
    ).trim()
    const pendingRowVersionValue = String(
      req.nextUrl.searchParams.get('pendingConfirmationExpectedRowVersion') || '',
    ).trim()
    const pendingIdempotencyKey = String(
      req.nextUrl.searchParams.get('pendingConfirmationIdempotencyKey') || '',
    ).trim()
    const hasPendingConfirmationQuery = Boolean(
      pendingOrderGlobalId || pendingRowVersionValue || pendingIdempotencyKey,
    )
    if (
      hasPendingConfirmationQuery
      && (
        !/^gor(?:[0-9]{7}|[0-9a-v]{12})$/.test(pendingOrderGlobalId)
        || !/^(?:0|[1-9][0-9]{0,14})$/.test(pendingRowVersionValue)
        || !Number.isSafeInteger(Number(pendingRowVersionValue))
        || !/^[A-Za-z0-9._:-]{8,200}$/.test(pendingIdempotencyKey)
      )
    ) {
      return json({
        ok: false,
        code: 'OPERATIONS_PENDING_CONFIRMATION_QUERY_INVALID',
        error: 'Pending confirmation order and row version must be supplied together',
      }, 400)
    }

    const queue = await readAssignedWearablePickQueueFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      workerEmail: actor.email,
      publicOrigin: appPublicUrl(),
    })
    const pendingConfirmation = hasPendingConfirmationQuery
      ? await readWearablePendingConfirmationStateFromPostgres({
          organizationId: activeOperationsOrganizationId(actor),
          workerEmail: actor.email,
          orderGlobalId: pendingOrderGlobalId,
          expectedRowVersion: Number(pendingRowVersionValue),
          idempotencyKey: pendingIdempotencyKey,
        })
      : null
    return json({ ok: true, capabilities, queue, pendingConfirmation })
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
