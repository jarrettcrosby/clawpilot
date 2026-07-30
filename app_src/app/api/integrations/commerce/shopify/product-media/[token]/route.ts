import { NextRequest, NextResponse } from 'next/server'
import {
  assertShopifyProductMediaTokenIsDeliverable,
  resolveShopifyProductMediaSigningSecret,
  verifyShopifyProductMediaToken,
} from '@/lib/integrations/shopifyProductMediaTokens'
import {
  readShopifyProductMediaDeliveryAssetInPostgres,
} from '@/lib/persistence/shopifyProductMediaProjection'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

function unavailable() {
  return new NextResponse('Not found', {
    status: 404,
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params
    const nowEpoch = Math.floor(Date.now() / 1_000)
    const payload = verifyShopifyProductMediaToken(
      token,
      resolveShopifyProductMediaSigningSecret(),
      nowEpoch,
    )
    assertShopifyProductMediaTokenIsDeliverable(payload)
    const asset = await readShopifyProductMediaDeliveryAssetInPostgres({
      grantId: payload.g,
      organizationId: payload.o,
      productId: payload.p,
      imageAssetId: payload.a,
      contentSha256: payload.h,
      issuedAtEpoch: payload.iat,
      expiresAtEpoch: payload.exp,
      nowEpoch,
    })
    return new NextResponse(Buffer.from(asset.bytes), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        'Content-Type': asset.mimeType,
        'Content-Length': String(asset.byteLength),
        'Content-Disposition': 'inline',
      },
    })
  } catch {
    // Do not log signed URLs, token facts, tenant identifiers, or asset hashes.
    return unavailable()
  }
}
