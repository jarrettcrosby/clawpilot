import { NextRequest, NextResponse } from 'next/server'
import {
  setBrowserSessionCookie,
  switchBrowserSessionWorkspace,
} from '@/lib/authSessions'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, PIPELINE_SELECTION_COOKIE } from '@/lib/tenancy'
import { appUserHasDemoAccess, isRootAppOwner } from '@/lib/users'
import {
  createIndependentRootWorkspace,
  listWorkspaceMemberships,
} from '@/lib/workspaceMemberships'

function clearWorkspaceSelectionCookies(response: NextResponse) {
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  }
  response.cookies.set(BOARD_SELECTION_COOKIE, '', options)
  response.cookies.set(PIPELINE_SELECTION_COOKIE, '', options)
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Workspace request failed'
  const status = message === 'Unauthorized'
    ? 401
    : /access|required|available/i.test(message)
      ? 403
      : 400
  return NextResponse.json({ ok: false, error: message }, { status })
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const [memberships, canAccessDemo] = await Promise.all([
      listWorkspaceMemberships(actor.email),
      appUserHasDemoAccess(actor.email),
    ])
    return NextResponse.json({
      ok: true,
      activeOrganizationId: actor.organizationId,
      canCreateRoot: isRootAppOwner(actor),
      canAccessDemo,
      workspaces: canAccessDemo ? memberships : memberships.filter((membership) => !membership.isDemo),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const [session, body] = await Promise.all([
      requireRequestSession(req),
      req.json(),
    ])
    const action = String(body?.action || 'switch')
    let organizationId = String(body?.organizationId || '').trim()
    if (action === 'create-root') {
      const actor = await requireRequestUser(req)
      const membership = await createIndependentRootWorkspace({ actor, name: body?.name })
      organizationId = membership.organizationId
    } else if (action !== 'switch') {
      return NextResponse.json({ ok: false, error: 'Unsupported workspace action' }, { status: 400 })
    }

    const issued = await switchBrowserSessionWorkspace({ session, organizationId })
    const response = NextResponse.json({
      ok: true,
      activeWorkspace: {
        organizationId: issued.session.activeWorkspaceOrganizationId,
        referenceCode: issued.session.activeWorkspaceReferenceCode,
        name: issued.session.activeWorkspaceName,
        role: issued.session.activeWorkspaceRole,
      },
    })
    setBrowserSessionCookie(response, issued)
    clearWorkspaceSelectionCookies(response)
    return response
  } catch (error) {
    return errorResponse(error)
  }
}
