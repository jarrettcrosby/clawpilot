import { NextRequest, NextResponse } from 'next/server'
import { createBrowserSession, setBrowserSessionCookie } from '@/lib/authSessions'
import { recordAuthActivity } from '@/lib/authAudit'
import { verifyAuthMagicCode } from '@/lib/authMagicCode'
import { queuePipelineProvisioning } from '@/lib/pipelineProvisioning'
import { syncAppUserProfileToOwnedPipelines } from '@/lib/persistence/crm'
import { ensureDefaultResourcesForUser } from '@/lib/tenancy'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      Vary: 'Cookie',
    },
  })
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({
      ok: false,
      code: 'AUTH_MAGIC_REQUEST_INVALID',
      error: 'The sign-in request is invalid.',
    }, 400)
  }

  try {
    const fields = body as { email?: unknown; code?: unknown } | null
    const email = String(fields?.email || '').trim().toLowerCase()
    const code = String(fields?.code || '').trim()
    if (!email.includes('@') || email.length > 254 || !/^\d{6}$/.test(code)) {
      await recordAuthActivity({ req, email, eventType: 'auth.login.failed', method: 'magic_code', reason: 'invalid_input' }).catch(() => undefined)
      return json({
        ok: false,
        code: 'AUTH_MAGIC_CODE_INVALID',
        error: 'The code is invalid or expired.',
      }, 401)
    }

    const result = await verifyAuthMagicCode({ email, code })
    if (result.status !== 'verified') {
      await recordAuthActivity({ req, email, eventType: 'auth.login.failed', method: 'magic_code', reason: result.status }).catch(() => undefined)
      return json({
        ok: false,
        code: 'AUTH_MAGIC_CODE_INVALID',
        error: 'The code is invalid or expired.',
      }, 401)
    }

    const actor = await requireWorkspaceAppUser(result.email, result.organizationId)
    const resources = await ensureDefaultResourcesForUser(actor)
    await syncAppUserProfileToOwnedPipelines(result.email).catch((error) => {
      console.error('[auth] CRM profile projection deferred', error instanceof Error ? error.message : 'unknown error')
    })
    if (resources.pipelineProvisioningRequired) {
      await queuePipelineProvisioning({ actorEmail: actor.email, pipelineId: resources.pipelineId }).catch((error) => {
        console.error('[auth] Personal pipeline Sheet provisioning deferred', error instanceof Error ? error.message : 'unknown error')
      })
    }

    const issued = await createBrowserSession({
      email: result.email,
      authMethod: 'magic_code',
      headers: req.headers,
      organizationId: actor.organizationId,
    })
    const response = json({ ok: true })
    setBrowserSessionCookie(response, issued)
    await recordAuthActivity({
      req,
      email: result.email,
      eventType: 'auth.login.succeeded',
      method: 'magic_code',
      organizationId: actor.organizationId,
    }).catch(() => undefined)
    return response
  } catch (error) {
    console.error('[auth] Magic-code verification failed', error instanceof Error ? error.message : 'unknown error')
    return json({
      ok: false,
      code: 'AUTH_MAGIC_VERIFICATION_UNAVAILABLE',
      error: 'Unable to verify the sign-in code.',
    }, 503)
  }
}
