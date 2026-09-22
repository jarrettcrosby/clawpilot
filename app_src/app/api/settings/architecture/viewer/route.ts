import type { NextRequest } from 'next/server'
import { architectureFailure, readArchitectureViewer, requireArchitectureAccess } from '@/lib/architectureViewer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    await requireArchitectureAccess(request)
    const viewer = await readArchitectureViewer()
    return new Response(viewer.html, { headers: viewer.headers })
  } catch (error) { return architectureFailure(error) }
}
