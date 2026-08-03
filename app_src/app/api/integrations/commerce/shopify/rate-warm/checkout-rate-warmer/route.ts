import { NextRequest } from 'next/server'
import { GET as handleRateWarmRequest } from '../route'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

/**
 * Shopify app proxies append child paths below the configured proxy root to
 * the destination URL. The theme app embed calls
 * /apps/clawpilot/checkout-rate-warmer, so the configured rate-warm proxy root
 * reaches this alias. Keep request verification and response handling in the
 * parent route.
 */
export async function GET(request: NextRequest) {
  return handleRateWarmRequest(request)
}
