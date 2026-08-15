import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  requireOperationsCapability,
} from '@/lib/operations/authorization'
import { readVerifiedPrintAgentRelease } from '@/lib/operations/printAgentReleaseService'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const DOWNLOAD_PATH = '/api/operations/print-agent/releases/download'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Cookie',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'OPERATIONS_FORBIDDEN') {
    return json({ ok: false, error: 'Operations access is required', code: error.message }, 403)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  return json({
    ok: false,
    error: 'A verified Print Agent release is not currently available',
    code: 'PRINT_AGENT_RELEASE_UNAVAILABLE',
  }, 503)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requireOperationsCapability(actor, 'canView')
    activeOperationsOrganizationId(actor)
    const release = await readVerifiedPrintAgentRelease()
    return json({
      ok: true,
      release: {
        schemaVersion: release.schemaVersion,
        product: release.product,
        version: release.version,
        customerReleaseReady: release.customerReleaseReady,
        artifacts: release.artifacts.map((artifact) => ({
          platform: artifact.platform,
          architecture: artifact.architecture,
          filename: artifact.filename,
          byteLength: artifact.byteLength,
          sha256: artifact.sha256,
          signed: artifact.signed,
          notarized: artifact.notarized,
          stapled: artifact.stapled,
          customerReleaseReady: artifact.customerReleaseReady,
          href: `${DOWNLOAD_PATH}?platform=${encodeURIComponent(artifact.platform)}&architecture=${encodeURIComponent(artifact.architecture)}`,
        })),
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
