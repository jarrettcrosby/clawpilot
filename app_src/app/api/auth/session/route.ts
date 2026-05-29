import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const token = req.cookies.get(getCookieName())?.value
  const session = verifySessionToken(token)
  if (!session.ok) return NextResponse.json({ ok: false }, { status: 401 })
  return NextResponse.json({ ok: true, user: session.user, exp: session.exp })
}
