import { NextRequest, NextResponse } from 'next/server'
import {
  configureToastAutomaticSync,
  disconnectToastCredential,
  getToastIntegrationState,
  queueToastSync,
  refreshToastAnalyticsLocations,
  sanitizedToastIntegrationError,
  selectToastLocation,
  testToastCredential,
  ToastIntegrationRequestError,
  updateToastCredential,
  verifyToastStandardLocation,
} from '@/lib/integrations/toastIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveUserPermissions, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  const sanitized = sanitizedToastIntegrationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new ToastIntegrationRequestError('Toast integrations require Postgres storage', 503, 'TOAST_POSTGRES_REQUIRED')
  }
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new ToastIntegrationRequestError('Your organization is not configured', 409, 'TOAST_ORGANIZATION_REQUIRED')
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  const permissions = effectiveUserPermissions(actor)
  if (actor.role !== 'owner' && (actor.role !== 'admin' || !permissions.manageUserAccess)) {
    throw new ToastIntegrationRequestError(
      'Only an organization owner or access administrator can manage Toast',
      403,
      'TOAST_MANAGER_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ToastIntegrationRequestError('Toast integration request is too large', 413, 'TOAST_REQUEST_TOO_LARGE')
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ToastIntegrationRequestError('Toast integration request is too large', 413, 'TOAST_REQUEST_TOO_LARGE')
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new ToastIntegrationRequestError('Request body must be valid JSON', 400, 'TOAST_REQUEST_INVALID')
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find((field) => !fields.includes(field))
  if (unsupported) {
    throw new ToastIntegrationRequestError(`Unsupported Toast action field: ${unsupported}`, 400, 'TOAST_REQUEST_INVALID')
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    return json({
      ok: true,
      canManage: true,
      integration: await getToastIntegrationState(organizationId(actor)),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const organization = organizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    if (action === 'update-credential') {
      only(body, ['action', 'accessType', 'apiBaseUrl', 'clientId', 'clientSecret'])
      const integration = await updateToastCredential({
        organizationId: organization,
        accessType: body.accessType,
        apiBaseUrl: body.apiBaseUrl,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'test-connection') {
      only(body, ['action', 'accessType'])
      const integration = await testToastCredential({ organizationId: organization, accessType: body.accessType })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'refresh-analytics-locations') {
      only(body, ['action'])
      const integration = await refreshToastAnalyticsLocations({ organizationId: organization, actorEmail: actor.email })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'verify-standard-location') {
      only(body, ['action', 'restaurantGuid'])
      const integration = await verifyToastStandardLocation({
        organizationId: organization, restaurantGuid: body.restaurantGuid, actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'select-location') {
      only(body, ['action', 'restaurantGuid', 'selected'])
      const integration = await selectToastLocation({
        organizationId: organization,
        restaurantGuid: body.restaurantGuid,
        selected: body.selected,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'configure-sync') {
      only(body, ['action', 'enabled'])
      const integration = await configureToastAutomaticSync({
        organizationId: organization, enabled: body.enabled, actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration })
    }
    if (action === 'queue-sync') {
      only(body, ['action', 'businessDate'])
      const result = await queueToastSync({
        organizationId: organization, businessDate: body.businessDate, actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration: result.state, queued: result.queued })
    }
    if (action === 'disconnect') {
      only(body, ['action', 'accessType'])
      const integration = await disconnectToastCredential({
        organizationId: organization, accessType: body.accessType, actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integration })
    }
    throw new ToastIntegrationRequestError('Unsupported Toast action', 400, 'TOAST_ACTION_INVALID')
  } catch (error) {
    return errorResponse(error)
  }
}
