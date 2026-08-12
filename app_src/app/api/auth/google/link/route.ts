import { NextRequest, NextResponse } from 'next/server'
import { SESSION_POLICY } from '@/lib/authSessions'
import { GoogleSsoError, verifyGoogleIdentityToken } from '@/lib/googleSso'
import { linkGoogleIdentity } from '@/lib/persistence/googleIdentityLinking'
import { requireRequestSession } from '@/lib/requestUser'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

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
    throw new GoogleSsoError('GOOGLE_SSO_CONTENT_TYPE_INVALID', 'Google account linking requires JSON', 415)
  }
  const declared = req.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_TOO_LARGE', 'Google account linking request is too large', 413)
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_TOO_LARGE', 'Google account linking request is too large', 413)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_INVALID', 'Google account linking request is invalid', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleSsoError('GOOGLE_SSO_REQUEST_INVALID', 'Google account linking request is invalid', 400)
  }
  return body as Record<string, unknown>
}

function failure(error: unknown) {
  const known = error instanceof GoogleSsoError
    ? error
    : new GoogleSsoError(
        'GOOGLE_SSO_LINK_UNAVAILABLE',
        'Google account linking is unavailable',
        503,
      )
  return json({ ok: false, code: known.code, error: known.message }, known.status)
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireRequestSession(req).catch(() => null)
    if (!session || session.legacy || !session.activeWorkspaceOrganizationId) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_SESSION_REQUIRED',
        'Sign in again before linking a Google account',
        401,
      )
    }
    if (session.impersonating || session.authenticatedUser !== session.effectiveUser) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_IMPERSONATION_FORBIDDEN',
        'Exit user view before linking a Google account',
        403,
      )
    }
    const age = Date.now() - Date.parse(session.lastAuthenticatedAt)
    if (!Number.isFinite(age) || age > SESSION_POLICY.recentAuthSeconds * 1000) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_RECENT_AUTH_REQUIRED',
        'Sign out and sign in again before linking a Google account',
        403,
      )
    }
    const body = await boundedBody(req)
    // `expectedPolicyRowVersion` is accepted and ignored for released-client
    // compatibility. It is not part of user-link authorization or idempotency.
    if (Object.keys(body).some((key) => !['idToken', 'expectedPolicyRowVersion'].includes(key))) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_REQUEST_INVALID',
        'Google account linking request is invalid',
        400,
      )
    }
    const identity = await verifyGoogleIdentityToken(body.idToken)
    const actor = await requireWorkspaceAppUser(
      session.authenticatedUser,
      session.activeWorkspaceOrganizationId,
    )
    const link = await linkGoogleIdentity({
      actor,
      identity,
      idempotencyKey: req.headers.get('idempotency-key'),
    })
    return json({ ok: true, identity: link })
  } catch (error) {
    return failure(error)
  }
}
