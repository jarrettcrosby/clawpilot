import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { recordAuthActivity } from '@/lib/authAudit'

export async function POST(req: NextRequest) {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  if (session.ok) {
    await recordAuthActivity({ req, email: session.user, eventType: 'auth.logout.succeeded', method: 'session' }).catch(() => undefined)
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set({
    name: getCookieName(),
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
  return res
}
