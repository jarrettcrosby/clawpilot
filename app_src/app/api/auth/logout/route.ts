import { NextRequest, NextResponse } from 'next/server'
import {
  clearBrowserSessionCookies,
  resolveRequestSession,
  revokeBrowserSession,
} from '@/lib/authSessions'
import { recordAuthActivity } from '@/lib/authAudit'

export async function POST(req: NextRequest) {
  const session = await resolveRequestSession(req).catch(() => null)
  if (session) {
    if (!session.legacy) {
      await revokeBrowserSession({
        authenticatedUser: session.authenticatedUser,
        sessionId: session.id,
        actor: session.authenticatedUser,
        reason: 'user_logout',
        audit: false,
      }).catch(() => undefined)
    }
    await recordAuthActivity({
      req,
      email: session.authenticatedUser,
      eventType: 'auth.logout.succeeded',
      method: 'session',
      effectiveUser: session.effectiveUser,
      sessionId: session.legacy ? undefined : session.id,
    }).catch(() => undefined)
  }
  const response = NextResponse.json({ ok: true })
  clearBrowserSessionCookies(response)
  return response
}
