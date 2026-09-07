import { NextRequest, NextResponse } from 'next/server'
import {
  accountingCapabilities,
  activeAccountingOrganizationId,
} from '@/lib/accountingAuthorization'
import {
  CommerceProviderImageFetchError,
  fetchCommerceProviderImage,
} from '@/lib/integrations/commerceProviderImageFetch'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readToastMenuCatalogItemDetailFromPostgres,
} from '@/lib/persistence/posCatalog'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const JSON_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Cookie',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: JSON_HEADERS })
}

function normalizedUuid(value: unknown) {
  const candidate = String(value || '').trim().toLowerCase()
  return UUID_PATTERN.test(candidate) ? candidate : null
}

export async function GET(
  req: NextRequest,
  context: {
    params: Promise<{ restaurantGuid: string; itemGuid: string }>
  },
) {
  try {
    const actor = await requireRequestUser(req)
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'POS catalog product images require Postgres storage',
        code: 'POS_CATALOG_POSTGRES_REQUIRED',
      }, 503)
    }
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to POS catalog data',
        code: 'POS_CATALOG_VIEW_REQUIRED',
      }, 403)
    }
    const params = await context.params
    const restaurantGuid = normalizedUuid(params.restaurantGuid)
    const itemGuid = normalizedUuid(params.itemGuid)
    if (!restaurantGuid || !itemGuid) {
      return json({
        ok: false,
        error: 'Toast product selection is invalid',
        code: 'POS_CATALOG_ITEM_SELECTION_INVALID',
      }, 404)
    }
    const item = await readToastMenuCatalogItemDetailFromPostgres({
      organizationId: activeAccountingOrganizationId(actor),
      restaurantGuid,
      itemGuid,
    })
    if (!item) {
      return json({
        ok: false,
        error: 'Toast product was not found for this location',
        code: 'POS_CATALOG_ITEM_NOT_FOUND',
      }, 404)
    }
    if (!item.sourceImageUrl) {
      return json({
        ok: false,
        error: 'Toast did not provide an image for this product',
        code: 'POS_CATALOG_ITEM_IMAGE_NOT_FOUND',
      }, 404)
    }
    const image = await fetchCommerceProviderImage({
      url: item.sourceImageUrl,
      signal: req.signal,
    })
    return new NextResponse(Buffer.from(image.bytes), {
      status: 200,
      headers: {
        'Cache-Control': 'private, max-age=300, must-revalidate',
        'Content-Length': String(image.byteLength),
        'Content-Type': image.mediaType,
        ETag: `\"${image.contentSha256}\"`,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        Vary: 'Cookie',
      },
    })
  } catch (error) {
    const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
    if (maintenance) {
      maintenance.headers.set('Cross-Origin-Resource-Policy', 'same-origin')
      return maintenance
    }
    if (error instanceof CommerceProviderImageFetchError) {
      return json({
        ok: false,
        error: 'Toast product image is temporarily unavailable',
        code: 'POS_CATALOG_ITEM_IMAGE_UNAVAILABLE',
      }, error.status)
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
      return json({
        ok: false,
        error: 'Select an active organization first',
        code: error.message,
      }, 409)
    }
    console.error('[pos catalog item image] request failed')
    return json({
      ok: false,
      error: 'Toast product image is temporarily unavailable',
      code: 'POS_CATALOG_ITEM_IMAGE_INTERNAL_ERROR',
    }, 500)
  }
}
