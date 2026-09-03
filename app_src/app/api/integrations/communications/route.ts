import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  bindOrganizationCommunication,
  disconnectOrganizationCommunication,
  getOrganizationCommunicationState,
  sanitizeOrganizationCommunicationError,
} from '@/lib/integrations/organizationCommunications'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, effectiveUserPermissions, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    throw Object.assign(new Error('Organization communication management requires a same-origin browser request'), {
      status: 403,
      code: 'ORGANIZATION_COMMUNICATION_SAME_ORIGIN_REQUIRED',
    })
  }
}

async function exactRequestActor(req: NextRequest) {
  const session = await requestSession(req)
  if (session?.impersonating || (session && session.authenticatedUser !== session.effectiveUser)) {
    throw Object.assign(new Error('Exit user view before managing organization communications'), {
      status: 403,
      code: 'ORGANIZATION_COMMUNICATION_IMPERSONATION_FORBIDDEN',
    })
  }
  return requireRequestUser(req)
}

function organizationId(actor: AppUser): string {
  if (!actor.organizationId) {
    throw Object.assign(new Error('Your active organization is not configured'), {
      status: 409,
      code: 'ORGANIZATION_COMMUNICATION_ORGANIZATION_REQUIRED',
    })
  }
  return actor.organizationId
}

function canManageOrganizationCommunications(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  const permissions = effectiveUserPermissions(actor)
  return role === 'owner' || (role === 'admin' && permissions.manageUserAccess)
}

function requireManager(actor: AppUser) {
  if (!canManageOrganizationCommunications(actor)) {
    throw Object.assign(new Error('Only an organization owner or access administrator can manage communication identities'), {
      status: 403,
      code: 'ORGANIZATION_COMMUNICATION_MANAGER_REQUIRED',
    })
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw Object.assign(new Error('Organization communications require Postgres storage'), {
      status: 503,
      code: 'ORGANIZATION_COMMUNICATION_POSTGRES_REQUIRED',
    })
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('Organization communication request is too large'), {
      status: 413,
      code: 'ORGANIZATION_COMMUNICATION_REQUEST_TOO_LARGE',
    })
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid body')
    return parsed as Record<string, unknown>
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), {
      status: 400,
      code: 'ORGANIZATION_COMMUNICATION_REQUEST_INVALID',
    })
  }
}

function requireOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const unsupported = Object.keys(body).find((field) => !allowed.includes(field))
  if (unsupported) {
    throw Object.assign(new Error(`Unsupported organization communication field: ${unsupported}`), {
      status: 400,
      code: 'ORGANIZATION_COMMUNICATION_REQUEST_INVALID',
    })
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  const shaped = error as { status?: unknown; code?: unknown; message?: unknown }
  if (Number.isInteger(shaped?.status) && typeof shaped?.code === 'string' && typeof shaped?.message === 'string') {
    return json({ ok: false, error: shaped.message, code: shaped.code }, Number(shaped.status))
  }
  const sanitized = sanitizeOrganizationCommunicationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

export async function GET(req: NextRequest) {
  try {
    // Personal Gmail aliases and writable calendars belong to the authenticated
    // actor, not an impersonated/effective user. Keep this read path under the
    // same exact-actor boundary as bind and disconnect.
    const actor = await exactRequestActor(req)
    requirePostgres()
    const canManage = canManageOrganizationCommunications(actor)
    const communication = await getOrganizationCommunicationState({
      organizationId: organizationId(actor),
      actorEmail: actor.email,
    })
    return json({
      ok: true,
      canManage,
      communication: canManage
        ? communication
        : { ...communication, bindings: [] },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req)
    const actor = await exactRequestActor(req)
    requirePostgres()
    requireManager(actor)
    const body = await requestBody(req)
    requireOnlyFields(body, ['action', 'app', 'connectionId', 'identityEmail', 'gmailSendAsEmail', 'calendarId'])
    if (String(body.action || '').trim() !== 'bind') {
      throw Object.assign(new Error('Unsupported organization communication action'), {
        status: 400,
        code: 'ORGANIZATION_COMMUNICATION_REQUEST_INVALID',
      })
    }
    const communication = await bindOrganizationCommunication({
      organizationId: organizationId(actor),
      actorEmail: actor.email,
      app: body.app,
      connectionId: body.connectionId,
      identityEmail: body.identityEmail,
      gmailSendAsEmail: body.gmailSendAsEmail,
      calendarId: body.calendarId,
    })
    return json({ ok: true, communication })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertSameOrigin(req)
    const actor = await exactRequestActor(req)
    requirePostgres()
    requireManager(actor)
    const app = req.nextUrl.searchParams.get('app')
    const communication = await disconnectOrganizationCommunication({
      organizationId: organizationId(actor),
      actorEmail: actor.email,
      app,
    })
    return json({ ok: true, communication })
  } catch (error) {
    return errorResponse(error)
  }
}
