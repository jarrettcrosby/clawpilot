import { NextRequest, NextResponse } from 'next/server'
import {
  executeShopifyCarrierServiceCallback,
} from '@/lib/integrations/shopifyCarrierServiceCallback'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}

function genericNotFound() {
  return NextResponse.json(
    { ok: false, error: 'Carrier service callback was not found' },
    { status: 404, headers: RESPONSE_HEADERS },
  )
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{
      accountGlobalId: string
      token: string
    }>
  },
) {
  const parameters = await context.params
  const result = await executeShopifyCarrierServiceCallback({
    accountGlobalId: String(parameters.accountGlobalId || '').trim(),
    callbackToken: String(parameters.token || '').trim(),
    request,
  })
  if (!result.authenticated) return genericNotFound()
  return NextResponse.json(result.response, {
    status: result.httpStatus,
    headers: RESPONSE_HEADERS,
  })
}
