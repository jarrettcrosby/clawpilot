import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  executeFaireProductImagePublish,
  FaireProductImageProjectionError,
  reconcileFaireProductImagePublish,
} from '@/lib/integrations/faireProductImageProjection'
import { appPublicUrl } from '@/lib/publicUrl'
import {
  FaireProviderWriteAuthorizationError,
} from '@/lib/persistence/faireProviderWriteAuthorization'
import {
  FaireProductImageProjectionPersistenceError,
  listFaireProductImageRecoveryEffectsInPostgres,
} from '@/lib/persistence/faireProductImageProjection'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHANNEL_GLOBAL_ID = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const EFFECT_GLOBAL_ID = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const MAX_COMMAND_BYTES = 4 * 1024
const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie, Origin',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: HEADERS })
}

function fail(code: string, message: string, status = 400): never {
  throw new FaireProductImageProjectionError(code, message, status)
}

function errorResponse(error: unknown) {
  if (
    error instanceof FaireProductImageProjectionError
    || error instanceof FaireProviderWriteAuthorizationError
    || error instanceof FaireProductImageProjectionPersistenceError
  ) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      ...('externalEffectGlobalId' in error
        ? { externalEffectGlobalId: error.externalEffectGlobalId }
        : {}),
    }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'unauthorized' }, 401)
  }
  console.error('[faire product image] request failed')
  return json({
    ok: false,
    error: 'Faire Product-image request failed',
    code: 'FAIRE_PRODUCT_IMAGE_REQUEST_FAILED',
  }, 500)
}

async function boundedJson(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '')
    .toLowerCase().startsWith('application/json')) {
    fail(
      'FAIRE_PRODUCT_IMAGE_CONTENT_TYPE_INVALID',
      'Faire Product-image commands require JSON',
      415,
    )
  }
  const declared = req.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared)
      || Number(declared) > MAX_COMMAND_BYTES)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REQUEST_TOO_LARGE',
      'Faire Product-image command exceeds the supported size',
      413,
    )
  }
  const text = await req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REQUEST_TOO_LARGE',
      'Faire Product-image command exceeds the supported size',
      413,
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    fail(
      'FAIRE_PRODUCT_IMAGE_COMMAND_INVALID',
      'Faire Product-image command must be valid JSON',
    )
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_COMMAND_INVALID',
      'Faire Product-image command must be a JSON object',
    )
  }
  return body as Record<string, unknown>
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    fail(
      'FAIRE_PRODUCT_IMAGE_SAME_ORIGIN_REQUIRED',
      'Faire Product-image commands require a same-origin browser request',
      403,
    )
  }
}

async function managerContext(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  const session = await requestSession(req)
  if (session?.impersonating) {
    fail(
      'FAIRE_PRODUCT_IMAGE_IMPERSONATION_FORBIDDEN',
      'Exit user view before accessing Faire Product-image publication',
      403,
    )
  }
  const actor = await requireRequestUser(req)
  const role = effectiveAuthorizationRole(actor)
  if (
    !['owner', 'admin'].includes(role)
    || actor.permissions.manageOperations !== true
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_MANAGER_REQUIRED',
      'Organization manager permission is required for Faire Product images',
      403,
    )
  }
  if (!actor.organizationId) {
    fail(
      'FAIRE_PRODUCT_IMAGE_ORGANIZATION_REQUIRED',
      'Active workspace is not available',
      403,
    )
  }
  if (!isPostgresStorageEnabled()) {
    fail(
      'FAIRE_PRODUCT_IMAGE_POSTGRES_REQUIRED',
      'Faire Product-image publication requires Postgres storage',
      503,
    )
  }
  const productId = String((await context.params).productId || '')
    .trim()
    .toLowerCase()
  if (!UUID.test(productId)) {
    fail('FAIRE_PRODUCT_IMAGE_SELECTION_INVALID', 'Product is invalid', 404)
  }
  return { actor, organizationId: actor.organizationId, productId }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  try {
    const { organizationId, productId } = await managerContext(req, context)
    const recoveryEffects =
      await listFaireProductImageRecoveryEffectsInPostgres({
        organizationId,
        productId,
      })
    return json({
      ok: true,
      recoveryEffects,
      providerReads: 0,
      providerWrites: 0,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  try {
    assertSameOrigin(req)
    const { actor, organizationId, productId } =
      await managerContext(req, context)
    const body = await boundedJson(req)
    if (body.action === 'reconcile-product-image') {
      if (
        Object.keys(body).some((key) => ![
          'action',
          'externalEffectGlobalId',
        ].includes(key))
        || !EFFECT_GLOBAL_ID.test(String(body.externalEffectGlobalId || '')
          .trim().toLowerCase())
      ) {
        fail(
          'FAIRE_PRODUCT_IMAGE_COMMAND_INVALID',
          'Faire Product-image reconciliation command is invalid',
        )
      }
      const reconciliation = await reconcileFaireProductImagePublish({
        organizationId,
        productId,
        externalEffectGlobalId: body.externalEffectGlobalId,
        actorEmail: actor.email,
      })
      return json({ ok: true, reconciliation })
    }
    const allowed = new Set([
      'action',
      'assetId',
      'channelStateGlobalId',
      'executeProviderWrite',
      'expectedProductReferenceCode',
      'expectedChannelStateRowVersion',
      'expectedChannelSourceRevision',
      'expectedAssetRevision',
      'expectedAssetRowVersion',
      'expectedAssetContentSha256',
      'shadowSimulationEffectGlobalId',
    ])
    if (
      body.action !== 'publish-product-image'
      || Object.keys(body).some((key) => !allowed.has(key))
      || !UUID.test(String(body.assetId || '').trim().toLowerCase())
      || !CHANNEL_GLOBAL_ID.test(
        String(body.channelStateGlobalId || '').trim().toLowerCase(),
      )
      || typeof body.executeProviderWrite !== 'boolean'
    ) {
      fail(
        'FAIRE_PRODUCT_IMAGE_COMMAND_INVALID',
        'Faire Product-image command is invalid',
      )
    }
    const publication = await executeFaireProductImagePublish({
      organizationId,
      productId,
      channelStateGlobalId: body.channelStateGlobalId,
      imageAssetId: body.assetId,
      executeProviderWrite: body.executeProviderWrite,
      expectedProductReferenceCode: body.expectedProductReferenceCode,
      expectedChannelStateRowVersion: body.expectedChannelStateRowVersion,
      expectedChannelSourceRevision: body.expectedChannelSourceRevision,
      expectedAssetRevision: body.expectedAssetRevision,
      expectedAssetRowVersion: body.expectedAssetRowVersion,
      expectedAssetContentSha256: body.expectedAssetContentSha256,
      shadowSimulationEffectGlobalId: body.shadowSimulationEffectGlobalId,
      actorEmail: actor.email,
    })
    return json({ ok: true, publication })
  } catch (error) {
    return errorResponse(error)
  }
}
