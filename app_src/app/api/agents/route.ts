import { NextResponse } from 'next/server'
import { PRODUCT_AGENTS } from '@/lib/agents/routing'
import { getAgentRuntime } from '@/lib/agents/provider'

export async function GET() {
  const runtime = getAgentRuntime()
  return NextResponse.json({
    agents: PRODUCT_AGENTS.map((agent) => ({
      ...agent,
      status: runtime.ready ? 'ready' : 'not connected',
    })),
    runtime,
  })
}
