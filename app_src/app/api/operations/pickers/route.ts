import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { query } from '@/lib/persistence/postgres'
import { requireRequestUser } from '@/lib/requestUser'
import { permissionsForRole, type AppUserRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

type PickerRow = {
  email: string
  display_name: string | null
  role: AppUserRole
  permissions: unknown
}

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
    if (!capabilities.canView || !capabilities.canManage || !capabilities.canExecute) {
      return response({
        ok: false,
        code: 'OPERATIONS_EXECUTE_REQUIRED',
        error: 'Warehouse execution permission is required to assign picks',
      }, 403)
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const result = await query<PickerRow>(
      `SELECT membership.user_email AS email,
              app_user.display_name,
              membership.role,
              membership.permissions
       FROM app_user_organization_memberships membership
       JOIN app_users app_user ON app_user.email = membership.user_email
       WHERE membership.organization_id = $1::uuid
         AND membership.status = 'active'
         AND app_user.status = 'active'
       ORDER BY lower(COALESCE(app_user.display_name, membership.user_email)),
                membership.user_email`,
      [organizationId],
    )
    const pickers = result.rows.flatMap((row) => {
      const permissions = permissionsForRole(row.role, row.permissions)
      const eligible = row.role === 'owner' || (
        permissions.viewOperations
        && permissions.manageOperations
        && permissions.executeWarehouse
      )
      return eligible ? [{
        email: row.email,
        displayName: row.display_name,
      }] : []
    })
    return response({ ok: true, pickers })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({ ok: false, error: 'Unauthorized' }, 401)
    }
    console.error('[operations-pickers] read failed', {
      message: error instanceof Error ? error.message : 'Unknown error',
    })
    return response({ ok: false, error: 'Pickers could not be loaded' }, 500)
  }
}
