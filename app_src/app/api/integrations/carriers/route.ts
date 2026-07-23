import { NextRequest, NextResponse } from 'next/server'
import {
  CarrierIntegrationRequestError,
  disconnectCarrierCredential,
  getCarrierIntegrationsState,
  sanitizedCarrierIntegrationError,
  setCarrierIntegrationEnabled,
  testCarrierCredential,
  updateCarrierCredential,
} from '@/lib/integrations/carrierIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

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
  const sanitized = sanitizedCarrierIntegrationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CarrierIntegrationRequestError(
      'Carrier integrations require Postgres storage',
      503,
      'CARRIER_POSTGRES_REQUIRED',
    )
  }
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CarrierIntegrationRequestError(
      'Your organization is not configured',
      409,
      'CARRIER_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CarrierIntegrationRequestError(
      'Operations-management permission is required to manage carrier accounts',
      403,
      'CARRIER_MANAGER_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CarrierIntegrationRequestError(
      'Carrier integration request is too large',
      413,
      'CARRIER_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CarrierIntegrationRequestError(
      'Carrier integration request is too large',
      413,
      'CARRIER_REQUEST_TOO_LARGE',
    )
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new CarrierIntegrationRequestError(
      'Request body must be valid JSON',
      400,
      'CARRIER_REQUEST_INVALID',
    )
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find((field) => !fields.includes(field))
  if (unsupported) {
    throw new CarrierIntegrationRequestError(
      `Unsupported carrier action field: ${unsupported}`,
      400,
      'CARRIER_REQUEST_INVALID',
    )
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
      integrations: await getCarrierIntegrationsState(organizationId(actor)),
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
      only(body, ['action', 'provider', 'environment', 'displayName', 'clientId', 'clientSecret', 'accountNumber'])
      const integrations = await updateCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        accountNumber: body.accountNumber,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'test-connection') {
      only(body, ['action', 'provider', 'environment'])
      const integrations = await testCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'set-enabled') {
      only(body, ['action', 'provider', 'environment', 'enabled'])
      const integrations = await setCarrierIntegrationEnabled({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        enabled: body.enabled,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'disconnect') {
      only(body, ['action', 'provider', 'environment'])
      const integrations = await disconnectCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    throw new CarrierIntegrationRequestError('Unsupported carrier action', 400, 'CARRIER_ACTION_INVALID')
  } catch (error) {
    return errorResponse(error)
  }
}
