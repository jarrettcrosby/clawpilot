import { NextRequest, NextResponse } from 'next/server'
import {
  listImpersonationTargets,
  resolveRequestSession,
  setBrowserSessionCookie,
  startImpersonation,
  stopImpersonation,
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
    const targets = session.authenticatedRole === 'owner'
      ? await listImpersonationTargets(session.authenticatedUser)
      : []
    const response = NextResponse.json({
      ok: true,
      isRootAdmin: session.authenticatedRole === 'owner' && targets !== null,
      impersonation: session.impersonating ? {
        active: true,
        authenticatedUser: session.authenticatedUser,
        effectiveUser: session.effectiveUser,
        startedAt: session.impersonationStartedAt,
        expiresAt: session.impersonationExpiresAt,
      } : { active: false },
      targets,
    })
    if (issued) setBrowserSessionCookie(response, issued)
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load support mode'
    return NextResponse.json({ ok: false, error: message }, { status: message.includes('required') ? 403 : 503 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { session } = await durableRequestSession(req)
    if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    const body = await req.json()
    const issued = await startImpersonation({ session, targetEmail: body?.targetEmail })
    const response = NextResponse.json({ ok: true, effectiveUser: issued.session.effectiveUser })
    setBrowserSessionCookie(response, issued)
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to enter user view'
    return NextResponse.json({ ok: false, error: message }, { status: 403 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { session } = await durableRequestSession(req)
    if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    const issued = await stopImpersonation(session)
    const response = NextResponse.json({ ok: true })
    setBrowserSessionCookie(response, issued)
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to exit user view'
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
