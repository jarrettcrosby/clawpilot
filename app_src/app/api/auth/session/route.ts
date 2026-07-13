import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { getAppUser } from '@/lib/users'

export async function GET(req: NextRequest) {
  const token = req.cookies.get(getCookieName())?.value
  const session = verifySessionToken(token)
  if (!session.ok) return NextResponse.json({ ok: false }, { status: 401 })
  try {
    const user = await getAppUser(session.user)
    if (!user || user.status !== 'active') return NextResponse.json({ ok: false }, { status: 401 })
    return NextResponse.json({ ok: true, user: user.email, role: user.role, status: user.status, exp: session.exp })
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
}
