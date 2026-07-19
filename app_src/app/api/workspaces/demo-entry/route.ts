import { NextRequest, NextResponse } from 'next/server'
import { demoEntryUrl } from '@/lib/demoMode'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const DEMO_HEALTH_TIMEOUT_MS = 3_000

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } })
}

export async function GET(req: NextRequest) {
  try {
    await requireRequestUser(req)
    const entryUrl = demoEntryUrl()
    const healthUrl = new URL('/api/health', entryUrl).toString()
    const response = await fetch(healthUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(DEMO_HEALTH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('Demo health check failed')
    return json({ ok: true, entryUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === 'Unauthorized') return json({ ok: false, error: 'Unauthorized' }, 401)
    return json({ ok: false, error: 'The demo workspace is temporarily unavailable.' }, 503)
  }
}
