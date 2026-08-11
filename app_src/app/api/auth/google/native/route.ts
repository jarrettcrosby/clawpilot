import { NextRequest, NextResponse } from 'next/server'
import { createBrowserSession, setBrowserSessionCookie } from '@/lib/authSessions'
import { recordAuthActivity } from '@/lib/authAudit'
import { GoogleSsoError, verifyGoogleIdentityToken } from '@/lib/googleSso'
import { resolveLinkedGoogleIdentity } from '@/lib/persistence/googleIdentityLinking'
import { ensureDefaultResourcesForUser } from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 12 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
    },
  })
}

async function boundedBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new GoogleSsoError('GOOGLE_SSO_CONTENT_TYPE_INVALID', 'Google sign-in requires JSON', 415)
  }
  const declared = req.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_TOO_LARGE', 'Google sign-in request is too large', 413)
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_TOO_LARGE', 'Google sign-in request is too large', 413)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_INVALID', 'Google sign-in request is invalid', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_INVALID', 'Google sign-in request is invalid', 400)
  }
  return body as Record<string, unknown>
}

export async function POST(req: NextRequest) {
  let email: string | null = null
  try {
    const body = await boundedBody(req)
    if (Object.keys(body).some((key) => key !== 'idToken')) {
      throw new GoogleSsoError('GOOGLE_SSO_REQUEST_INVALID', 'Google sign-in request is invalid', 400)
    }
    const identity = await verifyGoogleIdentityToken(body.idToken)
    email = identity.email

    // Google proves the provider identity. ClawPilot only signs in a durable,
    // explicitly linked subject whose existing membership organization has
    // enabled Google sign-in. This route never creates users or memberships.
    const actor = await resolveLinkedGoogleIdentity(identity)
    await ensureDefaultResourcesForUser(actor)
    const issued = await createBrowserSession({
      email: actor.email,
      authMethod: 'google_sso',
      headers: req.headers,
      organizationId: actor.organizationId,
    })
    const response = json({ ok: true })
    setBrowserSessionCookie(response, issued)
    await recordAuthActivity({
      req,
      email: actor.email,
      eventType: 'auth.login.succeeded',
      method: 'google_sso',
      organizationId: actor.organizationId,
    }).catch(() => undefined)
    return response
  } catch (error) {
    const known = error instanceof GoogleSsoError
      ? error
      : new GoogleSsoError(
          'GOOGLE_SSO_ACCESS_DENIED',
          'This Google account is not authorized for ClawPilot',
          403,
        )
    await recordAuthActivity({
      req,
      email,
      eventType: 'auth.login.failed',
      method: 'google_sso',
      reason: known.code,
    }).catch(() => undefined)
    return json({ ok: false, code: known.code, error: known.message }, known.status)
  }
}
