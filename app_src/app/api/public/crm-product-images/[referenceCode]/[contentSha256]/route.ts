import { NextRequest, NextResponse } from 'next/server'
import {
  CRM_PRODUCT_IMAGE_PUBLIC_CONTENT_SHA256_PATTERN,
  CRM_PRODUCT_IMAGE_PUBLIC_REFERENCE_PATTERN,
} from '@/lib/crm/productImagePublic'
import {
  readPublicCrmProductImageAssetBytesInPostgres,
} from '@/lib/persistence/crmProductImageAssets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NOT_FOUND_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=30, must-revalidate',
  'Content-Security-Policy': "default-src 'none'",
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
}

function notFound() {
  return NextResponse.json({
    ok: false,
    error: 'Product image was not found',
  }, {
    status: 404,
    headers: NOT_FOUND_HEADERS,
  })
}

export async function GET(
  req: NextRequest,
  context: {
    params: Promise<{
      referenceCode: string
      contentSha256: string
    }>
  },
) {
  const params = await context.params
  const referenceCode = String(params.referenceCode || '')
    .trim()
    .toLowerCase()
  const contentSha256 = String(params.contentSha256 || '')
    .trim()
    .toLowerCase()
  if (
    !CRM_PRODUCT_IMAGE_PUBLIC_REFERENCE_PATTERN.test(referenceCode)
    || !CRM_PRODUCT_IMAGE_PUBLIC_CONTENT_SHA256_PATTERN.test(contentSha256)
  ) return notFound()
  try {
    const asset = await readPublicCrmProductImageAssetBytesInPostgres({
      productReferenceCode: referenceCode,
      contentSha256,
    })
    if (!asset) return notFound()
    const etag = `"sha256-${asset.contentSha256}"`
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          'Access-Control-Allow-Origin': '*',
          ETag: etag,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    return new NextResponse(Buffer.from(asset.bytes), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.byteLength),
        'Content-Disposition': 'inline',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        ETag: etag,
      },
    })
  } catch {
    return notFound()
  }
}
