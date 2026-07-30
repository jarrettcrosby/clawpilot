import { NextRequest, NextResponse } from 'next/server'
import {
  CrmProductImageAssetError,
} from '@/lib/crm/productImageAssets'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readCrmProductImageAssetBytesInPostgres,
} from '@/lib/persistence/crmProductImageAssets'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'Content-Security-Policy': "default-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
}

function json(payload: Record<string, unknown>, status = 400) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new CrmProductImageAssetError(code, message, status)
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
  console.error('[crm product image bytes] request failed')
  return json({
    ok: false,
    error: 'Product image could not be loaded',
    code: 'CRM_PRODUCT_IMAGE_BYTES_REQUEST_FAILED',
  }, 500)
}

export async function GET(
  req: NextRequest,
  context: {
    params: Promise<{
      productId: string
      assetId: string
    }>
  },
) {
  try {
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
    const params = await context.params
    const productId = String(params.productId || '').trim().toLowerCase()
    const assetId = String(params.assetId || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(productId) || !UUID_PATTERN.test(assetId)) {
      fail(
        'CRM_PRODUCT_IMAGE_ASSET_NOT_FOUND',
        'Product image was not found for this Product',
        404,
      )
    }
    const asset = await readCrmProductImageAssetBytesInPostgres({
      organizationId: actor.organizationId,
      productId,
      assetId,
    })
    return new NextResponse(Buffer.from(asset.bytes), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.byteLength),
        'Content-Disposition': 'inline',
        ETag: `"sha256-${asset.contentSha256}"`,
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
