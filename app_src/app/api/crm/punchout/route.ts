import { NextRequest, NextResponse } from 'next/server'
import { suiteCrmPublicUrl } from '@/lib/crm/suiteCrmPublicUrl'
import { workspaceOrganizationById } from '@/lib/organizations'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unable to open SuiteCRM'
  const status = message === 'Unauthorized'
    ? 401
    : message === 'User access is not active'
      ? 403
      : message.startsWith('SUITECRM_PUBLIC_URL')
        ? 503
        : 500
  const responseMessage = status === 500 ? 'Unable to open SuiteCRM' : message
  return NextResponse.json({ ok: false, error: responseMessage }, { status, headers: NO_STORE_HEADERS })
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const role = effectiveAuthorizationRole(actor)
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { ok: false, error: 'SuiteCRM access requires an owner or administrator' },
        { status: 403, headers: NO_STORE_HEADERS },
      )
    }
    const organization = actor.organizationId
      ? await workspaceOrganizationById(actor.organizationId)
      : null
    if (!organization) {
      return NextResponse.json(
        { ok: false, error: 'Active workspace is not available' },
        { status: 403, headers: NO_STORE_HEADERS },
      )
    }
    if (organization.parentId !== null) {
      return NextResponse.json(
        { ok: false, error: 'Native SuiteCRM access is limited to root organization administrators' },
        { status: 403, headers: NO_STORE_HEADERS },
      )
    }
    if (req.nextUrl.search) {
      return NextResponse.json(
        { ok: false, error: 'SuiteCRM punchout does not accept query parameters' },
        { status: 400, headers: NO_STORE_HEADERS },
      )
    }

    return NextResponse.redirect(suiteCrmPublicUrl(), { status: 307, headers: NO_STORE_HEADERS })
  } catch (error) {
    return errorResponse(error)
  }
}
