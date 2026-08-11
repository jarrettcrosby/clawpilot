import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  refreshExactFaireProductImages,
} from '@/lib/integrations/faireProductImageRefresh'
import {
  FaireProductImageRefreshError,
} from '@/lib/integrations/faireProductImageRefreshTypes'
import { commerceReadRuntimeAvailable } from '@/lib/integrations/commerceIntake'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_COMMAND_BYTES = 8 * 1024
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, Origin',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: NO_STORE_HEADERS })
}

function fail(code: string, message: string, status = 400): never {
  throw new FaireProductImageRefreshError(code, message, status)
}

function errorResponse(error: unknown) {
  if (error instanceof FaireProductImageRefreshError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'unauthorized' }, 401)
  }
  console.error('[faire product image refresh] request failed')
  return json({
    ok: false,
    error: 'Faire Product images could not be refreshed',
    code: 'FAIRE_PRODUCT_IMAGE_REFRESH_REQUEST_FAILED',
  }, 500)
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_SAME_ORIGIN_REQUIRED',
      'Faire Product image refresh requires a same-origin browser request',
      403,
    )
  }
}

async function boundedJson(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '')
    .toLowerCase()
  if (!contentType.startsWith('application/json')) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_CONTENT_TYPE_INVALID',
      'Faire Product image refresh requires JSON',
      415,
    )
  }
  const declared = req.headers.get('content-length')
  if (
    declared
    && (!/^\d+$/.test(declared) || Number(declared) > MAX_COMMAND_BYTES)
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_REQUEST_TOO_LARGE',
      'Faire Product image refresh command exceeds the supported size',
      413,
    )
  }
  if (!req.body) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_COMMAND_INVALID',
      'Faire Product image refresh command must be a JSON object',
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
        'FAIRE_PRODUCT_IMAGE_REFRESH_REQUEST_TOO_LARGE',
        'Faire Product image refresh command exceeds the supported size',
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
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_COMMAND_INVALID',
      'Faire Product image refresh command must be valid UTF-8 JSON',
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_COMMAND_INVALID',
      'Faire Product image refresh command must be a JSON object',
    )
  }
  return body as Record<string, unknown>
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
        'FAIRE_PRODUCT_IMAGE_REFRESH_IMPERSONATION_FORBIDDEN',
        'Exit user view before refreshing Faire Product images',
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
        'FAIRE_PRODUCT_IMAGE_REFRESH_MANAGER_REQUIRED',
        'Organization manager permission is required for Faire Product image refresh',
        403,
      )
    }
    if (!actor.organizationId) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_ORGANIZATION_REQUIRED',
        'Active workspace is not available',
        403,
      )
    }
    if (!isPostgresStorageEnabled()) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_POSTGRES_REQUIRED',
        'Faire Product image refresh requires Postgres storage',
        503,
      )
    }
    const { productId: rawProductId } = await context.params
    const productId = String(rawProductId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(productId)) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_INVALID',
        'Product is invalid',
        404,
      )
    }
    if (!commerceReadRuntimeAvailable()) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_DISABLED',
        'Faire Product image import is unavailable while commerce reconciliation is disabled',
        409,
      )
    }
    const body = await boundedJson(req)
    const allowed = [
      'action',
      'channelStateGlobalId',
      'expectedProductReferenceCode',
      'expectedIntegrationAccountGlobalId',
      'expectedChannelStateRowVersion',
      'expectedChannelSourceRevision',
      'expectedExternalProductId',
      'expectedExternalVariantId',
      'expectedProviderSku',
      'confirmReadOnlyProviderRequest',
    ]
    if (
      body.action !== 'refresh-faire-product-images'
      || Object.keys(body).some((field) => !allowed.includes(field))
    ) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_COMMAND_INVALID',
        'Faire Product image refresh command is invalid',
      )
    }
    const refresh = await refreshExactFaireProductImages({
      organizationId: actor.organizationId,
      productId,
      channelStateGlobalId: body.channelStateGlobalId,
      expectedProductReferenceCode: body.expectedProductReferenceCode,
      expectedIntegrationAccountGlobalId:
        body.expectedIntegrationAccountGlobalId,
      expectedChannelStateRowVersion: body.expectedChannelStateRowVersion,
      expectedChannelSourceRevision: body.expectedChannelSourceRevision,
      expectedExternalProductId: body.expectedExternalProductId,
      expectedExternalVariantId: body.expectedExternalVariantId,
      expectedProviderSku: body.expectedProviderSku,
      confirmReadOnlyProviderRequest: body.confirmReadOnlyProviderRequest,
      actorEmail: actor.email,
    })
    return json({ ok: true, refresh })
  } catch (error) {
    return errorResponse(error)
  }
}
