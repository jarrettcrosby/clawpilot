import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  requireOperationsCapability,
} from '@/lib/operations/authorization'
import { resolveVerifiedPrintAgentDownload } from '@/lib/operations/printAgentReleaseService'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  Vary: 'Cookie',
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: PRIVATE_HEADERS })
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
  if (error instanceof Error && error.message === 'PRINT_AGENT_RELEASE_ARTIFACT_NOT_FOUND') {
    return json({ ok: false, error: 'Requested Print Agent build is unavailable', code: error.message }, 404)
  }
  return json({
    ok: false,
    error: 'A verified Print Agent download is not currently available',
    code: 'PRINT_AGENT_RELEASE_DOWNLOAD_UNAVAILABLE',
  }, 503)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requireOperationsCapability(actor, 'canView')
    activeOperationsOrganizationId(actor)
    const keys = [...req.nextUrl.searchParams.keys()]
    if (keys.some((key) => key !== 'platform' && key !== 'architecture')) {
      return json({ ok: false, error: 'Unsupported download parameter', code: 'PRINT_AGENT_RELEASE_REQUEST_INVALID' }, 400)
    }
    if (req.nextUrl.searchParams.getAll('platform').length !== 1
      || req.nextUrl.searchParams.getAll('architecture').length !== 1) {
      return json({ ok: false, error: 'Download parameters must appear exactly once', code: 'PRINT_AGENT_RELEASE_REQUEST_INVALID' }, 400)
    }
    const platform = String(req.nextUrl.searchParams.get('platform') || '')
    const architecture = String(req.nextUrl.searchParams.get('architecture') || '')
    const valid = (platform === 'macos' && architecture === 'universal')
      || (platform === 'windows' && architecture === 'x64')
    if (!valid) {
      return json({ ok: false, error: 'Requested Print Agent build is invalid', code: 'PRINT_AGENT_RELEASE_REQUEST_INVALID' }, 400)
    }
    const location = await resolveVerifiedPrintAgentDownload({ platform, architecture })
    return new NextResponse(null, {
      status: 307,
      headers: { ...PRIVATE_HEADERS, Location: location },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
