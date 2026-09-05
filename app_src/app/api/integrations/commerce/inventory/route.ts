import { NextRequest, NextResponse } from 'next/server'
import {
  createShopifyInventoryWarehouseAndMap,
  getShopifyInventoryState,
  mapShopifyInventoryLocation,
  syncShopifyInventory,
} from '@/lib/integrations/commerceInventory'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import { integrationCredentialRuntimeMaintenanceResponse } from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 8 * 1024

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
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  const sanitized = sanitizedCommerceIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CommerceIntegrationRequestError(
      'Your organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

async function actor(req: NextRequest) {
  const user = await requireRequestUser(req)
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory requires Postgres storage',
      503,
      'SHOPIFY_INVENTORY_POSTGRES_REQUIRED',
    )
  }
  if (!operationsCapabilities(user).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required to synchronize inventory',
      403,
      'SHOPIFY_INVENTORY_MANAGER_REQUIRED',
    )
  }
  return user
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory request is too large',
      413,
      'SHOPIFY_INVENTORY_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory request is too large',
      413,
      'SHOPIFY_INVENTORY_REQUEST_TOO_LARGE',
    )
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new CommerceIntegrationRequestError(
      'Shopify inventory request must be a JSON object',
      400,
      'SHOPIFY_INVENTORY_REQUEST_INVALID',
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await actor(req)
    const inventory = await getShopifyInventoryState({
      organizationId: organizationId(user),
      accountGlobalId: req.nextUrl.searchParams.get('accountGlobalId'),
      mappingGlobalId: req.nextUrl.searchParams.get('mappingGlobalId'),
      idempotencyKey: req.headers.get('Idempotency-Key'),
      actorEmail: user.email,
    })
    return json({ ok: true, inventory })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await actor(req)
    const body = await requestBody(req)
    if (body.action === 'create-warehouse-and-map') {
      const result = await createShopifyInventoryWarehouseAndMap({
        organizationId: organizationId(user),
        accountGlobalId: body.accountGlobalId,
        externalLocationId: body.externalLocationId,
        warehouse: body.warehouse,
        idempotencyKey: body.idempotencyKey,
        actorEmail: user.email,
      })
      return json({ ok: true, ...result }, 201)
    }
    if (body.action === 'map-location') {
      const result = await mapShopifyInventoryLocation({
        organizationId: organizationId(user),
        accountGlobalId: body.accountGlobalId,
        externalLocationId: body.externalLocationId,
        warehouseGlobalId: body.warehouseGlobalId,
        locationGlobalId: body.locationGlobalId,
        mappingGlobalId: body.mappingGlobalId,
        expectedRowVersion: body.expectedRowVersion,
        idempotencyKey: body.idempotencyKey,
        actorEmail: user.email,
      })
      return json({ ok: true, ...result })
    }
    if (body.action !== 'sync') {
      throw new CommerceIntegrationRequestError(
        'Shopify inventory action is invalid',
        400,
        'SHOPIFY_INVENTORY_ACTION_INVALID',
      )
    }
    if (
      typeof body.mappingGlobalId !== 'string'
      || !body.mappingGlobalId.trim()
    ) {
      throw new CommerceIntegrationRequestError(
        'Choose a mapped Shopify inventory location to synchronize',
        400,
        'SHOPIFY_INVENTORY_LOCATION_MAPPING_REQUIRED',
      )
    }
    const result = await syncShopifyInventory({
      organizationId: organizationId(user),
      accountGlobalId: body.accountGlobalId,
      idempotencyKey: body.idempotencyKey,
      mappingGlobalId: body.mappingGlobalId,
      expectedMappingRowVersion: body.expectedMappingRowVersion,
      actorEmail: user.email,
    })
    return json({ ok: true, ...result })
  } catch (error) {
    return errorResponse(error)
  }
}
