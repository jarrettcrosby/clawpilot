import { NextRequest, NextResponse } from 'next/server'
import { PRODUCT_AGENTS } from '@/lib/agents/routing'
import { getAgentRuntimeForOperator, stableAgentProfileId } from '@/lib/agents/provider'
import { requireRequestUser } from '@/lib/requestUser'

export async function GET(req: NextRequest) {
  let operatorId: string
  try {
    operatorId = (await requireRequestUser(req)).email
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const runtime = await getAgentRuntimeForOperator(operatorId)
  return NextResponse.json({
    agents: PRODUCT_AGENTS.map((agent) => ({
      ...agent,
      profileId: stableAgentProfileId(operatorId, agent.id),
      status: runtime.ready ? 'ready' : 'not connected',
    })),
    runtime,
  })
}
