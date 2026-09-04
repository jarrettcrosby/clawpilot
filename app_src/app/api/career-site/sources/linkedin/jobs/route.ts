import { NextRequest, NextResponse } from 'next/server'
import { CareerSiteLinkedInJobsError, parseCareerSiteLinkedInJobsRequest, resolveCareerSiteLinkedInJobsConfiguration } from '@/lib/careerSiteLinkedInJobsContract'
import { getCareerSiteLinkedInJobsStatus, searchCareerSiteLinkedInJobs } from '@/lib/careerSiteLinkedInJobs'
import { resolveShortLinkActor, ShortLinkRequestError, validateShortLinkConfiguration } from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60
const MAX_REQUEST_BYTES = 4096

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } })
}

function errorResponse(error: unknown) {
  if (error instanceof CareerSiteLinkedInJobsError) return json({ ok: false, error: error.message, code: error.code }, error.status)
  if (error instanceof ShortLinkRequestError) return json({ ok: false, error: error.message }, error.status)
  return json({ ok: false, error: 'LinkedIn job source could not complete this request', code: 'CAREER_SITE_LINKEDIN_JOBS_UNAVAILABLE' }, 503)
}

async function authorizedActor(req: NextRequest) {
  const configuration = resolveCareerSiteLinkedInJobsConfiguration()
  validateShortLinkConfiguration({ requireServiceClient: true })
  const actor = await resolveShortLinkActor(req)
  if (!actor.service || actor.sourceApp !== configuration.sourceApp || actor.ownerEmail !== configuration.ownerEmail || actor.organizationId !== configuration.organizationId) {
    throw new CareerSiteLinkedInJobsError('Career Desk job source client is not authorized', 403, 'CAREER_SITE_LINKEDIN_JOBS_FORBIDDEN')
  }
  return actor
}

export async function GET(req: NextRequest) {
  try {
    const actor = await authorizedActor(req)
    return json({ ok: true, ...await getCareerSiteLinkedInJobsStatus(actor.ownerEmail, req.signal) })
  } catch (error) { return errorResponse(error) }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await authorizedActor(req)
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new CareerSiteLinkedInJobsError('Content-Type must be application/json', 415)
    }
    if (Number(req.headers.get('content-length') || 0) > MAX_REQUEST_BYTES) throw new CareerSiteLinkedInJobsError('Request body is too large', 413)
    const raw = await req.text()
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) throw new CareerSiteLinkedInJobsError('Request body is too large', 413)
    let value: unknown
    try { value = JSON.parse(raw) } catch { throw new CareerSiteLinkedInJobsError('Request body must be valid JSON') }
    const request = parseCareerSiteLinkedInJobsRequest(value)
    return json({ ok: true, ...await searchCareerSiteLinkedInJobs({ ownerEmail: actor.ownerEmail, request, signal: req.signal }) })
  } catch (error) { return errorResponse(error) }
}
