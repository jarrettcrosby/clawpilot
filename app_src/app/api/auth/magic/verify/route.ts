import { NextRequest, NextResponse } from 'next/server'
import { createBrowserSession, setBrowserSessionCookie } from '@/lib/authSessions'
import { recordAuthActivity } from '@/lib/authAudit'
import { verifyAuthMagicCode } from '@/lib/authMagicCode'
import { queuePipelineProvisioning } from '@/lib/pipelineProvisioning'
import { syncAppUserProfileToOwnedPipelines } from '@/lib/persistence/crm'
import { ensureDefaultResourcesForUser } from '@/lib/tenancy'
import { requireWorkspaceAppUser } from '@/lib/workspaceMemberships'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const email = String(body?.email || '').trim().toLowerCase()
    const code = String(body?.code || '').trim()
    if (!email.includes('@') || email.length > 254 || !/^\d{6}$/.test(code)) {
      await recordAuthActivity({ req, email, eventType: 'auth.login.failed', method: 'magic_code', reason: 'invalid_input' }).catch(() => undefined)
      return NextResponse.json({ ok: false, error: 'The code is invalid or expired.' }, { status: 401 })
    }

    const result = await verifyAuthMagicCode({ email, code })
    if (result.status !== 'verified') {
      await recordAuthActivity({ req, email, eventType: 'auth.login.failed', method: 'magic_code', reason: result.status }).catch(() => undefined)
      return NextResponse.json({ ok: false, error: 'The code is invalid or expired.' }, { status: 401 })
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
    const response = NextResponse.json({ ok: true })
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
    return NextResponse.json({ ok: false, error: 'Unable to verify the sign-in code.' }, { status: 503 })
  }
}
