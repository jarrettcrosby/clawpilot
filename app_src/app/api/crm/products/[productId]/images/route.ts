import { NextRequest, NextResponse } from 'next/server'
import {
  CRM_PRODUCT_IMAGE_MAX_BYTES,
  CrmProductImageAssetError,
} from '@/lib/crm/productImageAssets'
import {
  isBrowserSameOriginRequest,
} from '@/lib/browserSameOrigin'
import { commerceReadRuntimeAvailable } from '@/lib/integrations/commerceIntake'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import {
  listCrmProductImageAssetsInPostgres,
  setPrimaryCrmProductImageAssetInPostgres,
  uploadCrmProductImageAssetInPostgres,
} from '@/lib/persistence/crmProductImageAssets'
import {
  readCommerceStoreSyncControlsFromPostgres,
} from '@/lib/persistence/commerceStoreSync'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024
const MAX_COMMAND_BYTES = 4 * 1024
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new CrmProductImageAssetError(code, message, status)
}

function assertSameOrigin(req: NextRequest) {
  if (!isBrowserSameOriginRequest({
    headers: req.headers,
    requestOrigin: req.nextUrl.origin,
    trustedOrigins: [appPublicUrl()],
  })) {
    fail(
      'CRM_PRODUCT_IMAGE_SAME_ORIGIN_REQUIRED',
      'Product image changes require a same-origin browser request',
      403,
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof CrmProductImageAssetError) {
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
  console.error('[crm product images] request failed', error)
  return json({
    ok: false,
    error: 'Product image request failed',
    code: 'CRM_PRODUCT_IMAGE_REQUEST_FAILED',
  }, 500)
}

function requireContentLength(
  req: NextRequest,
  maximum: number,
  label: string,
): number {
  const raw = req.headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw)) {
    fail(
      'CRM_PRODUCT_IMAGE_CONTENT_LENGTH_REQUIRED',
      `${label} requires a valid Content-Length header`,
      411,
    )
  }
  const length = Number(raw)
  if (!Number.isSafeInteger(length) || length < 1) {
    fail(
      'CRM_PRODUCT_IMAGE_CONTENT_LENGTH_REQUIRED',
      `${label} requires a valid Content-Length header`,
      411,
    )
  }
  if (length > maximum) {
    fail(
      'CRM_PRODUCT_IMAGE_REQUEST_TOO_LARGE',
      `${label} exceeds the supported request size`,
      413,
    )
  }
  return length
}

async function boundedRequestText(
  req: NextRequest,
  maximum: number,
): Promise<string> {
  const declaredLength = req.headers.get('content-length')
  if (
    declaredLength
    && (
      !/^\d+$/.test(declaredLength)
      || Number(declaredLength) > maximum
    )
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_REQUEST_TOO_LARGE',
      'Product image command exceeds the supported request size',
      413,
    )
  }
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    total += part.value.byteLength
    if (total > maximum) {
      await reader.cancel()
      fail(
        'CRM_PRODUCT_IMAGE_REQUEST_TOO_LARGE',
        'Product image command exceeds the supported request size',
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
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(
      'CRM_PRODUCT_IMAGE_COMMAND_INVALID',
      'Product image command must use valid UTF-8 JSON',
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'CRM_PRODUCT_IMAGE_COMMAND_INVALID',
      'Product image command must be a JSON object',
    )
  }
  return value as Record<string, unknown>
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: string[],
) {
  if (Object.keys(value).some((field) => !allowed.includes(field))) {
    fail(
      'CRM_PRODUCT_IMAGE_COMMAND_INVALID',
      'Product image command includes an unsupported field',
    )
  }
}

function formEntryIsFile(
  value: FormDataEntryValue | null,
): value is File {
  return Boolean(
    value
    && typeof value !== 'string'
    && typeof value.arrayBuffer === 'function'
    && Number.isSafeInteger(value.size),
  )
}

async function uploadForm(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '')
    .toLowerCase()
  if (!contentType.startsWith('multipart/form-data;')) {
    fail(
      'CRM_PRODUCT_IMAGE_CONTENT_TYPE_INVALID',
      'Product image uploads require multipart form data',
      415,
    )
  }
  requireContentLength(
    req,
    CRM_PRODUCT_IMAGE_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES,
    'Product image upload',
  )
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    fail(
      'CRM_PRODUCT_IMAGE_UPLOAD_INVALID',
      'Product image upload form data is invalid',
    )
  }
  const allowedFields = new Set(['image', 'altText', 'setPrimary'])
  if (Array.from(form.keys()).some((field) => !allowedFields.has(field))) {
    fail(
      'CRM_PRODUCT_IMAGE_UPLOAD_INVALID',
      'Product image upload includes an unsupported field',
    )
  }
  for (const field of allowedFields) {
    if (form.getAll(field).length > 1) {
      fail(
        'CRM_PRODUCT_IMAGE_UPLOAD_INVALID',
        'Product image upload contains duplicate fields',
      )
    }
  }
  const image = form.get('image')
  if (!formEntryIsFile(image) || image.size < 1) {
    fail(
      'CRM_PRODUCT_IMAGE_BYTES_REQUIRED',
      'Product image file is required',
    )
  }
  if (image.size > CRM_PRODUCT_IMAGE_MAX_BYTES) {
    fail(
      'CRM_PRODUCT_IMAGE_SIZE_INVALID',
      `Product images must be no larger than ${CRM_PRODUCT_IMAGE_MAX_BYTES} bytes`,
      413,
    )
  }
  const altText = form.get('altText')
  if (typeof altText !== 'string') {
    fail(
      'CRM_PRODUCT_IMAGE_ALT_TEXT_REQUIRED',
      'Product image alt text is required',
    )
  }
  const primaryEntry = form.get('setPrimary')
  if (
    primaryEntry !== null
    && primaryEntry !== 'true'
    && primaryEntry !== 'false'
  ) {
    fail(
      'CRM_PRODUCT_IMAGE_PRIMARY_INVALID',
      'Product image primary selection must be true or false',
    )
  }
  return {
    bytes: new Uint8Array(await image.arrayBuffer()),
    declaredMimeType: image.type,
    altText,
    setPrimary: primaryEntry === 'true',
  }
}

async function managerContext(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  const actor = await requireRequestUser(req)
  const role = effectiveAuthorizationRole(actor)
  if (role !== 'owner' && role !== 'admin') {
    fail(
      'CRM_PRODUCT_IMAGE_MANAGER_REQUIRED',
      'Organization manager permission is required for Product images',
      403,
    )
  }
  if (!actor.organizationId) {
    fail(
      'CRM_PRODUCT_IMAGE_ORGANIZATION_REQUIRED',
      'Active workspace is not available',
      403,
    )
  }
  if (!isPostgresStorageEnabled()) {
    fail(
      'CRM_PRODUCT_IMAGE_POSTGRES_REQUIRED',
      'Product image management requires Postgres storage',
      503,
    )
  }
  const { productId: rawProductId } = await context.params
  const productId = String(rawProductId || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(productId)) {
    fail(
      'CRM_PRODUCT_IMAGE_PRODUCT_NOT_FOUND',
      'Product was not found in the active organization',
      404,
    )
  }
  return { actor, organizationId: actor.organizationId, productId }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  try {
    const { organizationId, productId } = await managerContext(req, context)
    const state = await listCrmProductImageAssetsInPostgres({
      organizationId,
      productId,
    })
    const storeSync = await readCommerceStoreSyncControlsFromPostgres(
      organizationId,
    )
    return json({
      ok: true,
      ...state,
      storeSync,
      imageImportAvailable: commerceReadRuntimeAvailable(),
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
    const upload = await uploadForm(req)
    const state = await uploadCrmProductImageAssetInPostgres({
      organizationId,
      productId,
      actorEmail: actor.email,
      ...upload,
    })
    return json({
      ok: true,
      ...state,
      imageImportAvailable: commerceReadRuntimeAvailable(),
    }, 201)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  try {
    assertSameOrigin(req)
    const { actor, organizationId, productId } =
      await managerContext(req, context)
    const contentType = String(req.headers.get('content-type') || '')
      .toLowerCase()
    if (!contentType.startsWith('application/json')) {
      fail(
        'CRM_PRODUCT_IMAGE_CONTENT_TYPE_INVALID',
        'Product image commands require JSON',
        415,
      )
    }
    const text = await boundedRequestText(req, MAX_COMMAND_BYTES)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      fail(
        'CRM_PRODUCT_IMAGE_COMMAND_INVALID',
        'Product image command must be valid JSON',
      )
    }
    const body = record(value)
    assertOnlyFields(body, ['action', 'assetId', 'expectedRowVersion'])
    if (body.action !== 'set-primary') {
      fail(
        'CRM_PRODUCT_IMAGE_ACTION_INVALID',
        'Product image action is invalid',
      )
    }
    const assetId = String(body.assetId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(assetId)) {
      fail(
        'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
        'Product image was not found for this Product',
        404,
      )
    }
    if (
      typeof body.expectedRowVersion !== 'number'
      || !Number.isSafeInteger(body.expectedRowVersion)
      || body.expectedRowVersion < 1
    ) {
      fail(
        'CRM_PRODUCT_IMAGE_REVISION_INVALID',
        'A valid Product image row revision is required',
      )
    }
    const state = await setPrimaryCrmProductImageAssetInPostgres({
      organizationId,
      productId,
      assetId,
      expectedRowVersion: body.expectedRowVersion,
      actorEmail: actor.email,
    })
    return json({
      ok: true,
      ...state,
      imageImportAvailable: commerceReadRuntimeAvailable(),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
