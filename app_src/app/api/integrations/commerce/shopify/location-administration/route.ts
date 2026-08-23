import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  executeShopifyLocationAdministration,
  prepareShopifyLocationAdministration,
  readShopifyLocationAdministrationState,
  reconcileShopifyLocationAdministration,
  ShopifyLocationAdministrationError,
} from '@/lib/integrations/shopifyLocationAdministration'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole, type AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 16 * 1024
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u

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

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (error instanceof ShopifyLocationAdministrationError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      outcomeUncertain: error.uncertain,
      providerMutationAttempted: error.providerMutationAttempted,
    }, error.status)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an organization before administering Shopify locations',
      code: 'ACTIVE_ORGANIZATION_REQUIRED',
    }, 409)
  }
  return json({
    ok: false,
    error: 'Shopify location administration is temporarily unavailable',
    code: 'SHOPIFY_LOCATION_ADMINISTRATION_INTERNAL_ERROR',
  }, 500)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_POSTGRES_REQUIRED',
      message: 'Shopify location administration requires Postgres storage',
      status: 503,
    })
  }
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_SAME_ORIGIN_REQUIRED',
      message: 'Shopify location administration requires a same-origin browser request',
      status: 403,
    })
  }
}

async function exactRequestActor(req: NextRequest) {
  const session = await requestSession(req)
  if (
    session?.impersonating
    || (
      session
      && session.authenticatedUser !== session.effectiveUser
    )
  ) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_IMPERSONATION_FORBIDDEN',
      message: 'Exit user view before administering Shopify locations',
      status: 403,
    })
  }
  return requireRequestUser(req)
}

function authorizedActor(actor: AppUser) {
  const capabilities = operationsCapabilities(actor)
  const role = effectiveAuthorizationRole(actor)
  if (
    (role !== 'owner' && role !== 'admin')
    || !capabilities.canActivate
    || !capabilities.canManage
    || !capabilities.canExecute
  ) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_AUTHORITY_REQUIRED',
      message: 'Owner or administrator activation, management, and execution authority is required',
      status: 403,
    })
  }
  return {
    organizationId: activeOperationsOrganizationId(actor),
    actorEmail: actor.email,
    actorRole: role,
    capabilities,
  } as const
}

function assertExactFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key))
  if (unknown.length) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_INVALID',
      message: `Unknown request field: ${unknown.sort()[0]}`,
      status: 400,
    })
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_TOO_LARGE',
      message: 'Shopify location administration request is too large',
      status: 413,
    })
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.length > MAX_REQUEST_BYTES) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_TOO_LARGE',
      message: 'Shopify location administration request is too large',
      status: 413,
    })
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_INVALID',
      message: 'Shopify location administration requires a JSON object',
      status: 400,
    })
  }
}

function idempotencyKey(req: NextRequest) {
  const value = String(req.headers.get('idempotency-key') || '').trim()
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_IDEMPOTENCY_REQUIRED',
      message: 'A stable Idempotency-Key header of 8-200 characters is required',
      status: 400,
    })
  }
  return value
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = authorizedActor(await exactRequestActor(req))
    const accountGlobalId = req.nextUrl.searchParams.get('accountGlobalId')
    if (!accountGlobalId) {
      throw new ShopifyLocationAdministrationError({
        code: 'SHOPIFY_LOCATION_ADMINISTRATION_ACCOUNT_REQUIRED',
        message: 'A Shopify account Global ID is required',
        status: 400,
      })
    }
    const state = await readShopifyLocationAdministrationState({
      organizationId: actor.organizationId,
      accountGlobalId,
      actorEmail: actor.actorEmail,
    })
    return json({
      ok: true,
      capabilities: actor.capabilities,
      state,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req)
    requirePostgres()
    const actor = authorizedActor(await exactRequestActor(req))
    const localIdempotencyKey = idempotencyKey(req)
    const body = await requestBody(req)
    if (body.action === 'prepare') {
      assertExactFields(body, [
        'action', 'accountGlobalId', 'mutation', 'warehouseGlobalId',
        'expectedWarehouseRowVersion', 'mappingGlobalId',
        'expectedMappingRowVersion', 'reason', 'confirmationStatement',
      ])
      const result = await prepareShopifyLocationAdministration({
        organizationId: actor.organizationId,
        actorEmail: actor.actorEmail,
        actorRole: actor.actorRole,
        accountGlobalId: body.accountGlobalId,
        action: body.mutation,
        warehouseGlobalId: body.warehouseGlobalId,
        expectedWarehouseRowVersion: body.expectedWarehouseRowVersion,
        mappingGlobalId: body.mappingGlobalId,
        expectedMappingRowVersion: body.expectedMappingRowVersion,
        reason: body.reason,
        confirmationStatement: body.confirmationStatement,
        idempotencyKey: localIdempotencyKey,
      })
      return json({ ok: true, result }, 201)
    }
    if (body.action === 'execute') {
      assertExactFields(body, ['action', 'authorizationGlobalId'])
      const result = await executeShopifyLocationAdministration({
        organizationId: actor.organizationId,
        actorEmail: actor.actorEmail,
        authorizationGlobalId: body.authorizationGlobalId,
        idempotencyKey: localIdempotencyKey,
      })
      return json({ ok: true, result })
    }
    if (body.action === 'reconcile') {
      assertExactFields(body, ['action', 'attemptGlobalId'])
      const result = await reconcileShopifyLocationAdministration({
        organizationId: actor.organizationId,
        actorEmail: actor.actorEmail,
        attemptGlobalId: body.attemptGlobalId,
        idempotencyKey: localIdempotencyKey,
      })
      return json({ ok: true, result })
    }
    throw new ShopifyLocationAdministrationError({
      code: 'SHOPIFY_LOCATION_ADMINISTRATION_REQUEST_INVALID',
      message: 'Supported actions are prepare, execute, and reconcile',
      status: 400,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
