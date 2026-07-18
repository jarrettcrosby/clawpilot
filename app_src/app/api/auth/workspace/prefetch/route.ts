import { NextRequest, NextResponse } from 'next/server'
import { buildDashboardBootstrap } from '@/lib/dashboardBootstrapServer'
import { requireRequestUserForWorkspace } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function responseHeaders() {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
  }
}

export async function GET(req: NextRequest) {
  try {
    const organizationId = req.nextUrl.searchParams.get('organizationId') || ''
    if (!UUID_PATTERN.test(organizationId)) {
      return NextResponse.json({ ok: false, error: 'Business is required' }, {
        status: 400,
        headers: responseHeaders(),
      })
    }
    const actor = await requireRequestUserForWorkspace(req, organizationId)
    return NextResponse.json(await buildDashboardBootstrap(actor), { headers: responseHeaders() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Business prefetch failed'
    const status = message === 'Unauthorized'
      ? 401
      : /access|active|available/i.test(message)
        ? 403
        : 500
    return NextResponse.json({
      ok: false,
      error: status === 500 ? 'Business prefetch failed' : message,
    }, { status, headers: responseHeaders() })
  }
}
