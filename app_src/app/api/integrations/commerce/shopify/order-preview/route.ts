import { NextRequest, NextResponse } from 'next/server'
import {
  clearShopifyOrderPreview,
  CommerceIntegrationRequestError,
  getShopifyOrderPreview,
  importShopifyOrderPreview,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
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
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
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

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required to read Shopify order previews',
      403,
      'COMMERCE_MANAGER_REQUIRED',
    )
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Shopify order preview requires Postgres storage',
      503,
      'COMMERCE_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Shopify order-preview request is too large',
      413,
      'COMMERCE_REQUEST_TOO_LARGE',
    )
  }
  const reader = req.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new CommerceIntegrationRequestError(
          'Shopify order-preview request is too large',
          413,
          'COMMERCE_REQUEST_TOO_LARGE',
        )
      }
      chunks.push(value)
    }
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        length,
      ).toString('utf8'),
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new CommerceIntegrationRequestError(
      'Request body must be a JSON object',
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
}

function only(body: Record<string, unknown>, fields: string[]) {
  const unsupported = Object.keys(body).find(
    (field) => !fields.includes(field),
  )
  if (unsupported) {
    throw new CommerceIntegrationRequestError(
      `Unsupported Shopify order-preview field: ${unsupported}`,
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
}

async function actor(req: NextRequest) {
  const value = await requireRequestUser(req)
  requirePostgres()
  requireManager(value)
  return value
}

export async function GET(req: NextRequest) {
  try {
    const user = await actor(req)
    const preview = await getShopifyOrderPreview({
      organizationId: organizationId(user),
      accountGlobalId: req.nextUrl.searchParams.get('accountGlobalId'),
    })
    return json({ ok: true, preview })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await actor(req)
    const body = await requestBody(req)
    only(body, [
      'accountGlobalId',
      'idempotencyKey',
      'confirmReadOnly',
    ])
    if (body.confirmReadOnly !== true) {
      throw new CommerceIntegrationRequestError(
        'Confirm that ClawPilot may read and hold a minimized Shopify order preview',
        400,
        'SHOPIFY_ORDER_PREVIEW_CONFIRMATION_REQUIRED',
      )
    }
    const preview = await importShopifyOrderPreview({
      organizationId: organizationId(user),
      accountGlobalId: body.accountGlobalId,
      idempotencyKey: body.idempotencyKey,
      actorEmail: user.email,
    })
    return json({ ok: true, preview })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await actor(req)
    const body = await requestBody(req)
    only(body, ['accountGlobalId', 'confirmClear'])
    if (body.confirmClear !== true) {
      throw new CommerceIntegrationRequestError(
        'Confirm that the held Shopify order preview may be cleared',
        400,
        'SHOPIFY_ORDER_PREVIEW_CLEAR_CONFIRMATION_REQUIRED',
      )
    }
    const result = await clearShopifyOrderPreview({
      organizationId: organizationId(user),
      accountGlobalId: body.accountGlobalId,
      actorEmail: user.email,
    })
    return json({ ok: true, ...result })
  } catch (error) {
    return errorResponse(error)
  }
}
