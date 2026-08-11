import { NextRequest, NextResponse } from 'next/server'
import { SESSION_POLICY, type BrowserSession } from '@/lib/authSessions'
import { GoogleSsoError } from '@/lib/googleSso'
import {
  getGoogleOrganizationAuthState,
  updateGoogleOrganizationPolicy,
} from '@/lib/persistence/googleIdentityLinking'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'
import { requireRequestSession } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_BODY_BYTES = 4 * 1024

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

async function requestContext(req: NextRequest) {
  const session = await requireRequestSession(req).catch(() => null)
  if (!session || session.legacy || !session.activeWorkspaceOrganizationId) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_SESSION_REQUIRED',
      'Sign in again before changing Google sign-in settings',
      401,
    )
  }
  const actor = await requireWorkspaceAppUser(
    session.effectiveUser,
    session.activeWorkspaceOrganizationId,
  )
  return { session, actor }
}

function requireRecentSession(session: BrowserSession) {
  const age = Date.now() - Date.parse(session.lastAuthenticatedAt)
  if (!Number.isFinite(age) || age > SESSION_POLICY.recentAuthSeconds * 1000) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_RECENT_AUTH_REQUIRED',
      'Sign out and sign in again before changing Google sign-in settings',
      403,
    )
  }
}

async function boundedBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_CONTENT_TYPE_INVALID',
      'Google sign-in settings require JSON',
      415,
    )
  }
  const declared = req.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_REQUEST_TOO_LARGE',
      'Google sign-in settings request is too large',
      413,
    )
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_REQUEST_TOO_LARGE',
      'Google sign-in settings request is too large',
      413,
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new GoogleSsoError(
      'GOOGLE_SSO_REQUEST_INVALID',
      'Google sign-in settings request is invalid',
      400,
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GoogleSsoError(
      'GOOGLE_SSO_REQUEST_INVALID',
      'Google sign-in settings request is invalid',
      400,
    )
  }
  return body as Record<string, unknown>
}

function failure(error: unknown) {
  const known = error instanceof GoogleSsoError
    ? error
    : new GoogleSsoError(
        'GOOGLE_SSO_POLICY_UNAVAILABLE',
        'Google sign-in settings are unavailable',
        503,
      )
  return json({ ok: false, code: known.code, error: known.message }, known.status)
}

export async function GET(req: NextRequest) {
  try {
    const { session, actor } = await requestContext(req)
    const state = await getGoogleOrganizationAuthState(actor)
    return json({
      ok: true,
      policy: {
        ...state,
        canManage: state.canManage && !session.impersonating,
        impersonating: session.impersonating,
      },
    })
  } catch (error) {
    return failure(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { session, actor } = await requestContext(req)
    if (session.impersonating) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_IMPERSONATION_FORBIDDEN',
        'Exit user view before changing Google sign-in settings',
        403,
      )
    }
    requireRecentSession(session)
    const body = await boundedBody(req)
    if (
      Object.keys(body).some((key) => !['enabled', 'expectedRowVersion'].includes(key))
      || typeof body.enabled !== 'boolean'
    ) {
      throw new GoogleSsoError(
        'GOOGLE_SSO_REQUEST_INVALID',
        'Google sign-in settings request is invalid',
        400,
      )
    }
    const policy = await updateGoogleOrganizationPolicy({
      actor,
      enabled: body.enabled,
      expectedRowVersion: body.expectedRowVersion,
      idempotencyKey: req.headers.get('idempotency-key'),
    })
    return json({ ok: true, policy })
  } catch (error) {
    return failure(error)
  }
}
