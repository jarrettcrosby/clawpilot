import { NextRequest, NextResponse } from 'next/server'
import { createBrowserSession, setBrowserSessionCookie } from '@/lib/authSessions'
import { assertDemoEnvironment, DEMO_USER_EMAIL, isDemoEnvironment } from '@/lib/demoMode'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET() {
  return json({ ok: true, available: isDemoEnvironment() })
}

export async function POST(req: NextRequest) {
  try {
    assertDemoEnvironment()
    const issued = await createBrowserSession({
      email: DEMO_USER_EMAIL,
      authMethod: 'demo',
      headers: req.headers,
    })
    const response = json({ ok: true })
    setBrowserSessionCookie(response, issued)
    return response
  } catch {
    return json({ ok: false, error: 'The demo is temporarily unavailable.' }, 503)
  }
}
