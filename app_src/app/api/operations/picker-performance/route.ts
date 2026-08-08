import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readPickerPerformanceFromPostgres } from '@/lib/persistence/wearablePicking'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

export async function GET(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return response({ ok: false, error: 'Operations requires Postgres storage' }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView || (!capabilities.canExecute && !capabilities.canManage)) {
      return response({
        ok: false,
        code: 'OPERATIONS_PERFORMANCE_REQUIRED',
        error: 'Operations or picker access is required to view picker performance',
      }, 403)
    }
    const managerScope = capabilities.canManage
    const metrics = await readPickerPerformanceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      pickerEmail: managerScope ? null : actor.email,
    })
    return response({ ok: true, scope: managerScope ? 'manager' : 'self', metrics })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({ ok: false, error: 'Unauthorized' }, 401)
    }
    console.error('[operations-picker-performance] read failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return response({ ok: false, error: 'Picker performance could not be loaded' }, 500)
  }
}
