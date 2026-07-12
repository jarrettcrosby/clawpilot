import { NextRequest, NextResponse } from 'next/server'
import { createSessionToken, getCookieName } from '@/lib/auth'
import { verifyAuthMagicCode } from '@/lib/authMagicCode'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const email = String(body?.email || '').trim().toLowerCase()
    const code = String(body?.code || '').trim()
    if (!email.includes('@') || email.length > 254 || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ ok: false, error: 'The code is invalid or expired.' }, { status: 401 })
    }

    const result = await verifyAuthMagicCode({ email, code })
    if (result.status !== 'verified') {
      return NextResponse.json({ ok: false, error: 'The code is invalid or expired.' }, { status: 401 })
    }

    const response = NextResponse.json({ ok: true })
    response.cookies.set({
      name: getCookieName(),
      value: createSessionToken(result.email),
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    })
    return response
  } catch (error) {
    console.error('[auth] Magic-code verification failed', error instanceof Error ? error.message : 'unknown error')
    return NextResponse.json({ ok: false, error: 'Unable to verify the sign-in code.' }, { status: 503 })
  }
}
