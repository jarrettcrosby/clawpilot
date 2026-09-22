import type { NextRequest } from 'next/server'
import { architectureFailure, architecturePrivateHeaders, readArchitectureManifest, requireArchitectureAccess } from '@/lib/architectureViewer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    await requireArchitectureAccess(request)
    const artifact = await readArchitectureManifest()
    return Response.json({ ok: true, sourceHash: artifact.sourceHash, toolVersion: artifact.toolVersion, views: artifact.views }, { headers: architecturePrivateHeaders() })
  } catch (error) { return architectureFailure(error) }
}
