import { NextRequest, NextResponse } from 'next/server'
import {
  resolveRequestSession,
  setBrowserSessionCookie,
  touchBrowserSessionActivity,
  upgradeLegacyRequestSession,
} from '@/lib/authSessions'

export async function POST(req: NextRequest) {
  try {
    let session = await resolveRequestSession(req)
    if (!session) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    let issued = null
    if (session.legacy) {
      issued = await upgradeLegacyRequestSession(req, session)
      session = issued.session
    }
    const active = await touchBrowserSessionActivity(session, req.headers)
    if (!active) return NextResponse.json({ ok: false, error: 'Session expired' }, { status: 401 })
    const response = NextResponse.json({
      ok: true,
      idleExpiresAt: active.idleExpiresAt,
      absoluteExpiresAt: active.absoluteExpiresAt,
    })
    if (issued) setBrowserSessionCookie(response, issued)
    return response
  } catch {
    return NextResponse.json({ ok: false, error: 'Session unavailable' }, { status: 503 })
  }
}
