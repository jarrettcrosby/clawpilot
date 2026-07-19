import { NextRequest, NextResponse } from 'next/server'
import { setBrowserSessionCookie, switchBrowserSessionWorkspace } from '@/lib/authSessions'
import { DEMO_WORKSPACE_ID } from '@/lib/demoMode'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'
import { BOARD_SELECTION_COOKIE, PIPELINE_SELECTION_COOKIE } from '@/lib/tenancy'
import { AppUserAuthorizationError } from '@/lib/users'
import { ensureDemoWorkspaceMembership } from '@/lib/workspaceMemberships'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}

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

export async function POST(req: NextRequest) {
  try {
    const [session, actor] = await Promise.all([
      requireRequestSession(req),
      requireRequestUser(req),
    ])
    await ensureDemoWorkspaceMembership(actor)
    const issued = await switchBrowserSessionWorkspace({
      session,
      organizationId: DEMO_WORKSPACE_ID,
    })
    const response = json({
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
    const message = error instanceof Error ? error.message : ''
    if (message === 'Unauthorized') return json({ ok: false, error: 'Unauthorized' }, 401)
    if (error instanceof AppUserAuthorizationError) return json({ ok: false, error: message }, 403)
    return json({ ok: false, error: 'The demo account is temporarily unavailable.' }, 503)
  }
}
