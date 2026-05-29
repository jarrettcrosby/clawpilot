import { NextResponse } from 'next/server'
import { PRODUCT_AGENTS } from '@/lib/agents/routing'

export async function GET() {
  return NextResponse.json({
    agents: PRODUCT_AGENTS.map((agent) => ({
      ...agent,
      status: 'active',
    })),
  })
}
