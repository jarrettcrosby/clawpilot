import { NextRequest, NextResponse } from 'next/server'
import {
  ShopifyAppProxyVerificationError,
} from '@/lib/integrations/shopifyAppProxy'
import {
  ShopifyCustomerRateZoneError,
} from '@/lib/integrations/shopifyCustomerRateZones'
import {
  ShopifyRateWarmError,
} from '@/lib/integrations/shopifyRateWarm'
import {
  executeShopifyRateWarmRequest,
} from '@/lib/integrations/shopifyRateWarmRuntime'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}

function genericFailure(status: number) {
  return NextResponse.json(
    {
      version: 1,
      enabled: false,
      error: 'Shopify checkout rate warming is unavailable',
    },
    { status, headers: RESPONSE_HEADERS },
  )
}

function safeStatus(error: unknown) {
  if (
    error instanceof ShopifyAppProxyVerificationError
    || error instanceof ShopifyRateWarmError
  ) {
    return error.status >= 500 ? 503 : 404
  }
  if (error instanceof ShopifyCustomerRateZoneError) {
    return error.status === 409 ? 409 : 503
  }
  return 503
}

export async function GET(request: NextRequest) {
  try {
    const payload = await executeShopifyRateWarmRequest({
      parameters: request.nextUrl.searchParams,
    })
    return NextResponse.json(payload, {
      status: 200,
      headers: RESPONSE_HEADERS,
    })
  } catch (error) {
    return genericFailure(safeStatus(error))
  }
}
