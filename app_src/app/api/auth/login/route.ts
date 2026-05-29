import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, getCookieName, getLoginPassword } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const password = String(body?.password || '')
    const expected = getLoginPassword()
    if (!expected) {
      return NextResponse.json({ ok: false, error: 'APP_LOGIN_PASSWORD not configured' }, { status: 500 })
    }
    if (password !== expected) {
      return NextResponse.json({ ok: false, error: 'Invalid password' }, { status: 401 })
    }

    const token = createSessionToken('jarrett')
    const res = NextResponse.json({ ok: true })
    res.cookies.set({
      name: getCookieName(),
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 60 * 60 * 12,
    })
    return res
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
