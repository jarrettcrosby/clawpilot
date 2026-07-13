import { NextRequest, NextResponse } from 'next/server'
import { getCookieName, verifySessionToken } from '@/lib/auth'
import { PRODUCT_AGENTS } from '@/lib/agents/routing'
import { getAgentRuntimeForOperator } from '@/lib/agents/provider'
import { requireActiveAppUser } from '@/lib/users'

export async function GET(req: NextRequest) {
  const session = verifySessionToken(req.cookies.get(getCookieName())?.value)
  if (!session.ok) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  let operatorId: string
  try {
    operatorId = (await requireActiveAppUser(session.user)).email
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const runtime = await getAgentRuntimeForOperator(operatorId)
  return NextResponse.json({
    agents: PRODUCT_AGENTS.map((agent) => ({
      ...agent,
      status: runtime.ready ? 'ready' : 'not connected',
    })),
    runtime,
  })
}
