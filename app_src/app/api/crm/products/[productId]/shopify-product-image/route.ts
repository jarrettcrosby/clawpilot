import { NextRequest, NextResponse } from 'next/server'
import {
  executeShopifyProductImagePublish,
  reconcileShopifyProductImagePublish,
  shopifyProductMediaPublicOrigin,
} from '@/lib/integrations/shopifyProductMediaProjection'
import {
  ShopifyProductMediaProjectionError,
} from '@/lib/integrations/shopifyProductMediaProjectionTypes'
import {
  ShopifyProductMediaTokenError,
} from '@/lib/integrations/shopifyProductMediaTokens'
import {
  ShopifyProductWritebackError,
} from '@/lib/integrations/shopifyProductWriteback'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  requestSession,
  requireRequestUser,
} from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHANNEL_GLOBAL_PATTERN = /^gpcs[0-9]{7}$/
const MAX_COMMAND_BYTES = 4 * 1024
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, Origin',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyProductMediaProjectionError(code, message, status)
}

function errorResponse(error: unknown) {
  if (
    error instanceof ShopifyProductMediaProjectionError
    || error instanceof ShopifyProductMediaTokenError
    || error instanceof ShopifyProductWritebackError
  ) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({
      ok: false,
      error: 'Unauthorized',
      code: 'unauthorized',
    }, 401)
  }
  console.error('[shopify product image publish] request failed')
  return json({
    ok: false,
    error: 'Shopify product image publish failed',
    code: 'SHOPIFY_PRODUCT_MEDIA_REQUEST_FAILED',
  }, 500)
}

async function boundedJson(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '')
    .toLowerCase()
  if (!contentType.startsWith('application/json')) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_CONTENT_TYPE_INVALID',
      'Shopify product media commands require JSON',
      415,
    )
  }
  const declared = req.headers.get('content-length')
  if (
    declared
    && (
      !/^\d+$/.test(declared)
      || Number(declared) > MAX_COMMAND_BYTES
    )
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_REQUEST_TOO_LARGE',
      'Shopify product media command exceeds the supported size',
      413,
    )
  }
  if (!req.body) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_COMMAND_INVALID',
      'Shopify product media command must be a JSON object',
    )
  }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > MAX_COMMAND_BYTES) {
      await reader.cancel()
      fail(
        'SHOPIFY_PRODUCT_MEDIA_REQUEST_TOO_LARGE',
        'Shopify product media command exceeds the supported size',
        413,
      )
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let body: unknown
  try {
    body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    )
  } catch {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_COMMAND_INVALID',
      'Shopify product media command must be valid UTF-8 JSON',
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_COMMAND_INVALID',
      'Shopify product media command must be a JSON object',
    )
  }
  return body as Record<string, unknown>
}

function assertSameOrigin(req: NextRequest) {
  const origin = String(req.headers.get('origin') || '').trim()
  let normalized: string
  try {
    normalized = new URL(origin).origin
  } catch {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SAME_ORIGIN_REQUIRED',
      'Shopify product media commands require a same-origin browser request',
      403,
    )
  }
  if (
    normalized !== req.nextUrl.origin
    || req.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SAME_ORIGIN_REQUIRED',
      'Shopify product media commands require a same-origin browser request',
      403,
    )
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  try {
    assertSameOrigin(req)
    const session = await requestSession(req)
    if (session?.impersonating) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_IMPERSONATION_FORBIDDEN',
        'Exit user view before accessing Shopify Product-image publication',
        403,
      )
    }
    const actor = await requireRequestUser(req)
    const role = effectiveAuthorizationRole(actor)
    if (
      (role !== 'owner' && role !== 'admin')
      || actor.permissions.manageOperations !== true
    ) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_MANAGER_REQUIRED',
        'Organization manager permission is required for Shopify product media',
        403,
      )
    }
    if (!actor.organizationId) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_ORGANIZATION_REQUIRED',
        'Active workspace is not available',
        403,
      )
    }
    if (!isPostgresStorageEnabled()) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_POSTGRES_REQUIRED',
        'Shopify product media projection requires Postgres storage',
        503,
      )
    }
    const { productId: rawProductId } = await context.params
    const productId = String(rawProductId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(productId)) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_SELECTION_INVALID',
        'Product is invalid',
        404,
      )
    }
    const body = await boundedJson(req)
    if (body.action === 'refresh-product-image-status') {
      const allowed = ['action', 'externalEffectGlobalId']
      if (
        Object.keys(body).some((field) => !allowed.includes(field))
        || !/^gcef[0-9]{7}$/.test(
          String(body.externalEffectGlobalId || '')
            .trim()
            .toLowerCase(),
        )
      ) {
        fail(
          'SHOPIFY_PRODUCT_MEDIA_COMMAND_INVALID',
          'Shopify Product-media reconciliation command is invalid',
        )
      }
      const reconciliation = await reconcileShopifyProductImagePublish({
        organizationId: actor.organizationId,
        productId,
        externalEffectGlobalId: body.externalEffectGlobalId,
        actorEmail: actor.email,
      })
      return json({ ok: true, reconciliation })
    }
    const publishAllowed = [
      'action',
      'assetId',
      'channelStateGlobalId',
      'executeProviderWrite',
    ]
    if (
      Object.keys(body).some((field) => !publishAllowed.includes(field))
      || body.action !== 'publish-product-image'
      || !UUID_PATTERN.test(
        String(body.assetId || '').trim().toLowerCase(),
      )
      || !CHANNEL_GLOBAL_PATTERN.test(
        String(body.channelStateGlobalId || '').trim().toLowerCase(),
      )
    ) {
      fail(
        'SHOPIFY_PRODUCT_MEDIA_COMMAND_INVALID',
        'Shopify product media command is invalid',
      )
    }
    const result = await executeShopifyProductImagePublish({
      organizationId: actor.organizationId,
      productId,
      channelStateGlobalId: body.channelStateGlobalId,
      imageAssetId: body.assetId,
      executeProviderWrite: body.executeProviderWrite,
      publicOrigin: shopifyProductMediaPublicOrigin(req.nextUrl.origin),
      actorEmail: actor.email,
    })
    return json({ ok: true, publication: result })
  } catch (error) {
    return errorResponse(error)
  }
}
