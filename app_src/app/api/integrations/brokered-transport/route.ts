import { NextRequest, NextResponse } from 'next/server'
import {
  BrokeredTransportIntegrationError,
  disconnectBrokeredTransportCredential,
  getBrokeredTransportIntegrations,
  sanitizedBrokeredTransportIntegrationError,
  updateBrokeredTransportCredential,
  verifyAndActivateBrokeredTransportRates,
} from '@/lib/integrations/brokeredTransportIntegrations'
import { integrationCredentialRuntimeMaintenanceResponse } from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  const sanitized = sanitizedBrokeredTransportIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new BrokeredTransportIntegrationError(
      'Transport integrations require Postgres storage',
      503,
      'TRANSPORT_POSTGRES_REQUIRED',
    )
  }
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new BrokeredTransportIntegrationError(
      'Your organization is not configured',
      409,
      'TRANSPORT_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new BrokeredTransportIntegrationError(
      'Operations-management permission is required to manage transport connections',
      403,
      'TRANSPORT_MANAGER_REQUIRED',
    )
  }
}

function requireActivator(actor: AppUser) {
  if (!operationsCapabilities(actor).canActivate) {
    throw new BrokeredTransportIntegrationError(
      'Operations activation permission is required to enable carrier rates',
      403,
      'TRANSPORT_ACTIVATION_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new BrokeredTransportIntegrationError(
      'Transport integration request is too large',
      413,
      'TRANSPORT_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new BrokeredTransportIntegrationError(
      'Transport integration request is too large',
      413,
      'TRANSPORT_REQUEST_TOO_LARGE',
    )
  }
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value as Record<string, unknown>
  } catch {
    throw new BrokeredTransportIntegrationError(
      'Request body must be valid JSON',
      400,
      'TRANSPORT_REQUEST_INVALID',
    )
  }
}

function only(body: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key))
  if (unexpected.length) {
    throw new BrokeredTransportIntegrationError(
      `Unexpected request field: ${unexpected[0]}`,
      400,
      'TRANSPORT_REQUEST_INVALID',
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    requireManager(actor)
    const integrations = await getBrokeredTransportIntegrations(
      organizationId(actor),
    )
    return json({
      ok: true,
      canActivate: operationsCapabilities(actor).canActivate,
      integrations,
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
    const canActivate = operationsCapabilities(actor).canActivate
    const organization = organizationId(actor)
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    if (action === 'update-credential') {
      only(body, [
        'action',
        'provider',
        'environment',
        'displayName',
        'credential',
      ])
      const integrations = await updateBrokeredTransportCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        credential: body.credential,
        idempotencyKey: req.headers.get('idempotency-key'),
        actorEmail: actor.email,
      })
      return json({ ok: true, canActivate, integrations })
    }
    if (action === 'disconnect') {
      only(body, ['action', 'provider', 'environment'])
      const integrations = await disconnectBrokeredTransportCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canActivate, integrations })
    }
    if (action === 'verify-and-activate-rates') {
      requireActivator(actor)
      only(body, [
        'action',
        'provider',
        'environment',
        'ratingModes',
        'verificationPostalCode',
        'verificationCountryCode',
      ])
      const integrations = await verifyAndActivateBrokeredTransportRates({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        ratingModes: body.ratingModes,
        verificationPostalCode: body.verificationPostalCode,
        verificationCountryCode: body.verificationCountryCode,
        actorEmail: actor.email,
      })
      return json({ ok: true, canActivate, integrations })
    }
    throw new BrokeredTransportIntegrationError(
      'Unsupported transport integration action',
      400,
      'TRANSPORT_ACTION_UNSUPPORTED',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
