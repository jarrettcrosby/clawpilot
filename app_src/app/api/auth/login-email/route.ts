import { NextRequest, NextResponse } from 'next/server'
import { currentLoginEmail } from '@/lib/authLoginIdentity'
import { clearBrowserSessionCookies } from '@/lib/authSessions'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { confirmLoginEmailChange, loginEmailChangeEnabled, LoginEmailChangeError, LOGIN_EMAIL_CHANGE_UNAVAILABLE, requestLoginEmailChange } from '@/lib/loginEmailChange'
import { requireRequestSession } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
const json = (body: object, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })

export async function GET(req: NextRequest) {
  try {
    const session = await requireRequestSession(req)
    const changeEnabled = loginEmailChangeEnabled()
    return json({ ok: true, loginEmail: await currentLoginEmail(session.effectiveUser), changeEnabled,
      changeUnavailableReason: changeEnabled ? null : LOGIN_EMAIL_CHANGE_UNAVAILABLE })
  } catch { return json({ ok: false, error: 'Sign in to view your login email.' }, 401) }
}

async function mutate(req: NextRequest, confirm: boolean) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers, requestOrigin: req.nextUrl.origin })) {
      return json({ ok: false, error: 'A same-origin request is required.' }, 403)
    }
    const session = await requireRequestSession(req).catch(() => null)
    if (!session) return json({ ok: false, error: 'Sign in again before changing your login email.' }, 401)
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new LoginEmailChangeError('JSON is required.', 415)
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > 2048) throw new LoginEmailChangeError('Request is too large.', 413)
    let body: Record<string, unknown>
    try { body = JSON.parse(text) } catch { throw new LoginEmailChangeError('Invalid request.') }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['email', 'code'].includes(key))) throw new LoginEmailChangeError('Invalid request.')
    const result = confirm ? await confirmLoginEmailChange(session, { email: body.email, code: body.code }) : await requestLoginEmailChange(session, body.email)
    const response = json({ ok: true, ...result })
    if (confirm) clearBrowserSessionCookies(response)
    return response
  } catch (error) {
    return json({ ok: false, error: error instanceof LoginEmailChangeError ? error.message : 'Unable to change login email.' }, error instanceof LoginEmailChangeError ? error.status : 400)
  }
}
export const POST = (req: NextRequest) => mutate(req, false)
export const PATCH = (req: NextRequest) => mutate(req, true)
