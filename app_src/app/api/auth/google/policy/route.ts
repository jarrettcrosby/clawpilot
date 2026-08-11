import { NextRequest, NextResponse } from 'next/server'
import { GoogleSsoError } from '@/lib/googleSso'
import { getGoogleUserAuthState } from '@/lib/persistence/googleIdentityLinking'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'
import { requireRequestSession } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

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
      'Sign in again before managing your Google account link',
      401,
    )
  }
  const actor = await requireWorkspaceAppUser(
    session.effectiveUser,
    session.activeWorkspaceOrganizationId,
  )
  return { session, actor }
}

function failure(error: unknown) {
  const known = error instanceof GoogleSsoError
    ? error
    : new GoogleSsoError(
        'GOOGLE_SSO_STATE_UNAVAILABLE',
        'Google account linking is unavailable',
        503,
      )
  return json({ ok: false, code: known.code, error: known.message }, known.status)
}

export async function GET(req: NextRequest) {
  try {
    const { session, actor } = await requestContext(req)
    const state = await getGoogleUserAuthState(actor)
    return json({
      ok: true,
      // Keep the `policy` envelope for released native/web clients. Its state
      // is now user-scoped; legacy organization flags are non-authoritative.
      policy: {
        ...state,
        impersonating: session.impersonating,
      },
    })
  } catch (error) {
    return failure(error)
  }
}

export async function PATCH() {
  return json({
    ok: false,
    code: 'GOOGLE_SSO_USER_SCOPED',
    error: 'Google linking is configured separately by each ClawPilot user',
  }, 409)
}
