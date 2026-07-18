import { NextRequest, NextResponse } from 'next/server'
import {
  clearBrowserSessionCookies,
  listBrowserSessions,
  resolveRequestSession,
  revokeBrowserSession,
  revokeOtherBrowserSessions,
  setBrowserSessionCookie,
  upgradeLegacyRequestSession,
} from '@/lib/authSessions'

async function durableRequestSession(req: NextRequest) {
  const session = await resolveRequestSession(req)
  if (!session) return { session: null, issued: null }
  if (!session.legacy) return { session, issued: null }
  const issued = await upgradeLegacyRequestSession(req, session)
  return { session: issued.session, issued }
}

export async function GET(req: NextRequest) {
  try {
    const { session, issued } = await durableRequestSession(req)
    if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    const sessions = await listBrowserSessions(session.authenticatedUser)
    const response = NextResponse.json({
      ok: true,
      currentSessionId: session.id,
      sessions: sessions.map((item) => ({ ...item, current: item.id === session.id })),
    })
    if (issued) setBrowserSessionCookie(response, issued)
    return response
  } catch {
    return NextResponse.json({ ok: false, error: 'Unable to load browser sessions' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session, issued } = await durableRequestSession(req)
    if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    if (session.impersonating) {
      return NextResponse.json({ ok: false, error: 'Exit user view before changing browser sessions' }, { status: 403 })
    }
    const body = await req.json()
    if (body?.action === 'revoke-others') {
      if (!session.activeWorkspaceOrganizationId) throw new Error('Active workspace is not available')
      const revoked = await revokeOtherBrowserSessions({
        authenticatedUser: session.authenticatedUser,
        currentSessionId: session.id,
        organizationId: session.activeWorkspaceOrganizationId,
      })
      const response = NextResponse.json({ ok: true, revoked })
      if (issued) setBrowserSessionCookie(response, issued)
      return response
    }
    if (body?.action !== 'revoke' || !/^[0-9a-f-]{36}$/i.test(String(body?.sessionId || ''))) {
      return NextResponse.json({ ok: false, error: 'Valid session action required' }, { status: 400 })
    }
    const targetSessionId = String(body.sessionId)
    const revoked = await revokeBrowserSession({
      authenticatedUser: session.authenticatedUser,
      sessionId: targetSessionId,
      actor: session.authenticatedUser,
    })
    if (!revoked) return NextResponse.json({ ok: false, error: 'Browser session was not found' }, { status: 404 })
    const response = NextResponse.json({ ok: true, revoked: 1, currentRevoked: targetSessionId === session.id })
    if (targetSessionId === session.id) clearBrowserSessionCookies(response)
    else if (issued) setBrowserSessionCookie(response, issued)
    return response
  } catch {
    return NextResponse.json({ ok: false, error: 'Unable to update browser sessions' }, { status: 503 })
  }
}
