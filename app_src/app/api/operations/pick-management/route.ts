import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readOperationsPickManagementFromPostgres } from '@/lib/persistence/pickManagement'
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
      return response({
        ok: false,
        error: 'Operations requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView || !capabilities.canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'Operations manager permission is required to review pick assignments',
      }, 403)
    }
    const sectionValue = req.nextUrl.searchParams.get('section') || 'all'
    if (!['all', 'current', 'history'].includes(sectionValue)) {
      return response({
        ok: false,
        code: 'OPERATIONS_PICK_MANAGEMENT_SECTION_INVALID',
        error: 'Pick-management section must be all, current, or history',
      }, 400)
    }
    const pickManagement = await readOperationsPickManagementFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      section: sectionValue as 'all' | 'current' | 'history',
      currentCursor: req.nextUrl.searchParams.get('currentCursor'),
      historyCursor: req.nextUrl.searchParams.get('historyCursor'),
    })
    return response({ ok: true, pickManagement })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({ ok: false, error: 'Unauthorized' }, 401)
    }
    if (error instanceof Error && (
      error.message === 'Invalid pick-management cursor'
      || error.message === 'Invalid pick-management section'
    )) {
      return response({
        ok: false,
        code: 'OPERATIONS_PICK_MANAGEMENT_CURSOR_INVALID',
        error: error.message,
      }, 400)
    }
    console.error('[operations-pick-management] read failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return response({
      ok: false,
      error: 'Pick assignments could not be loaded',
    }, 500)
  }
}
