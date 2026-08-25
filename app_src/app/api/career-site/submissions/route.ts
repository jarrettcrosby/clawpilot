import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteSubmissionConfigurationError,
  CareerSiteSubmissionRequestError,
  parseCareerSiteSubmission,
  resolveCareerSiteSubmissionConfiguration,
} from '@/lib/careerSiteSubmissionContract'
import {
  CareerSiteSubmissionPersistenceConflictError,
  createCareerSiteSubmissionInPostgres,
} from '@/lib/persistence/careerSiteSubmissions'
import {
  resolveShortLinkActor,
  ShortLinkRequestError,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof CareerSiteSubmissionRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteSubmissionPersistenceConflictError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteSubmissionConfigurationError) {
    return json({
      ok: false,
      error: 'Career-site submissions are not configured',
      code: error.code,
    }, 503)
  }
  if (error instanceof ShortLinkRequestError) {
    return json({ ok: false, error: error.message }, error.status)
  }
  console.error('[career-site-submissions] request failed', {
    name: error instanceof Error ? error.name : typeof error,
  })
  return json({
    ok: false,
    error: 'Career-site submission could not be recorded',
    code: 'CAREER_SITE_SUBMISSION_FAILED',
  }, 500)
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CareerSiteSubmissionRequestError(
      'Career-site submission is too large',
      413,
      'CAREER_SITE_SUBMISSION_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CareerSiteSubmissionRequestError(
      'Career-site submission is too large',
      413,
      'CAREER_SITE_SUBMISSION_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new CareerSiteSubmissionRequestError('Request body must be valid JSON')
  }
}

export async function POST(req: NextRequest) {
  try {
    const configuration = resolveCareerSiteSubmissionConfiguration()
    if (!configuration.enabled || !configuration.ownerEmail) {
      throw new CareerSiteSubmissionConfigurationError('Career-site submissions are disabled')
    }
    const actor = await resolveShortLinkActor(req)
    if (
      !actor.service
      || actor.sourceApp !== configuration.sourceApp
      || actor.ownerEmail !== configuration.ownerEmail
    ) {
      throw new CareerSiteSubmissionRequestError(
        'Career-site submission client is not authorized',
        403,
        'CAREER_SITE_SUBMISSION_FORBIDDEN',
      )
    }
    const submission = parseCareerSiteSubmission(await requestBody(req))
    const result = await createCareerSiteSubmissionInPostgres({ actor, submission })
    return json({
      ok: true,
      submission: {
        id: result.externalSubmissionId,
        receivedAt: result.createdAt,
        sheetSyncStatus: result.sheetSyncStatus,
        duplicate: result.duplicate,
      },
    }, result.duplicate ? 200 : 201)
  } catch (error) {
    return errorResponse(error)
  }
}
