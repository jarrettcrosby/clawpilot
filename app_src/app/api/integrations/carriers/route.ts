import { NextRequest, NextResponse } from 'next/server'
import {
  CarrierIntegrationRequestError,
  createCarrierAccount,
  deleteCarrierAccount,
  disconnectCarrierCredential,
  getCarrierIntegrationsState,
  revealCarrierCredential,
  sanitizedCarrierIntegrationError,
  setCarrierAccountStatus,
  setCarrierIntegrationEnabled,
  testCarrierSandboxRate,
  testCarrierCredential,
  updateCarrierAccount,
  updateCarrierCredential,
} from '@/lib/integrations/carrierIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024

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

function canRevealCredential(actor: AppUser) {
  const role = effectiveAuthorizationRole(actor)
  return role === 'owner' || role === 'admin'
}

function requireCredentialViewer(actor: AppUser) {
  if (!canRevealCredential(actor)) {
    throw new CarrierIntegrationRequestError(
      'Organization owner or administrator access is required to reveal carrier credentials',
      403,
      'CARRIER_CREDENTIAL_REVEAL_FORBIDDEN',
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
      canRevealCredentials: canRevealCredential(actor),
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
    if (action === 'reveal-credential') {
      only(body, ['action', 'provider', 'environment'])
      requireCredentialViewer(actor)
      const credential = await revealCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, canRevealCredentials: true, credential })
    }
    if (action === 'update-credential') {
      only(body, ['action', 'provider', 'environment', 'displayName', 'clientId', 'clientSecret'])
      const integrations = await updateCarrierCredential({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'create-account') {
      only(body, [
        'action', 'provider', 'environment', 'displayName', 'accountNumber',
        'registeredAddress', 'allowSenderBilling', 'allowRecipientBilling',
        'allowThirdPartyBilling',
      ])
      const integrations = await createCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        displayName: body.displayName,
        accountNumber: body.accountNumber,
        registeredAddress: body.registeredAddress,
        allowSenderBilling: body.allowSenderBilling,
        allowRecipientBilling: body.allowRecipientBilling,
        allowThirdPartyBilling: body.allowThirdPartyBilling,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'update-account') {
      only(body, [
        'action', 'provider', 'environment', 'carrierAccountGlobalId',
        'displayName', 'accountNumber', 'registeredAddress',
        'allowSenderBilling', 'allowRecipientBilling', 'allowThirdPartyBilling',
      ])
      const integrations = await updateCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        displayName: body.displayName,
        accountNumber: body.accountNumber,
        registeredAddress: body.registeredAddress,
        allowSenderBilling: body.allowSenderBilling,
        allowRecipientBilling: body.allowRecipientBilling,
        allowThirdPartyBilling: body.allowThirdPartyBilling,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'set-account-status') {
      only(body, ['action', 'provider', 'environment', 'carrierAccountGlobalId', 'status'])
      const integrations = await setCarrierAccountStatus({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        status: body.status,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, integrations })
    }
    if (action === 'delete-account') {
      only(body, ['action', 'provider', 'environment', 'carrierAccountGlobalId'])
      const integrations = await deleteCarrierAccount({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
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
    if (action === 'test-sandbox-rate') {
      only(body, ['action', 'provider', 'environment', 'carrierAccountGlobalId'])
      const rateTest = await testCarrierSandboxRate({
        organizationId: organization,
        provider: body.provider,
        environment: body.environment,
        carrierAccountGlobalId: body.carrierAccountGlobalId,
        actorEmail: actor.email,
      })
      return json({ ok: true, canManage: true, rateTest })
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
