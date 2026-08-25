import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteMailConfigurationError,
  CareerSiteMailRequestError,
  parseCareerSiteMailRequest,
  resolveCareerSiteMailConfiguration,
} from '@/lib/careerSiteMailContract'
import {
  CareerSiteMailPersistenceConflictError,
  createCareerSiteMailInPostgres,
} from '@/lib/persistence/careerSiteMailOutbox'
import {
  resolveShortLinkActor,
  ShortLinkRequestError,
  validateShortLinkConfiguration,
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
  if (error instanceof CareerSiteMailRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteMailPersistenceConflictError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteMailConfigurationError) {
    return json({
      ok: false,
      error: 'Career-site mail is not configured',
      code: 'CAREER_SITE_MAIL_CONFIGURATION_INVALID',
    }, 503)
  }
  if (error instanceof ShortLinkRequestError) {
    return json({ ok: false, error: error.message }, error.status)
  }
  console.error('[career-site-mail] request failed', {
    name: error instanceof Error ? error.name : typeof error,
  })
  return json({
    ok: false,
    error: 'Career-site email could not be queued',
    code: 'CAREER_SITE_MAIL_FAILED',
  }, 500)
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CareerSiteMailRequestError(
      'Career-site email request is too large',
      413,
      'CAREER_SITE_MAIL_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CareerSiteMailRequestError(
      'Career-site email request is too large',
      413,
      'CAREER_SITE_MAIL_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new CareerSiteMailRequestError('Request body must be valid JSON')
  }
}

export async function POST(req: NextRequest) {
  try {
    const configuration = resolveCareerSiteMailConfiguration()
    if (!configuration.enabled || !configuration.ownerEmail) {
      throw new CareerSiteMailConfigurationError('Career-site mail is disabled')
    }
    try {
      validateShortLinkConfiguration({ requireServiceClient: true })
    } catch {
      throw new CareerSiteMailConfigurationError(
        'Career-site mail requires an isolated service identity',
      )
    }
    const actor = await resolveShortLinkActor(req)
    if (
      !actor.service
      || actor.sourceApp !== configuration.sourceApp
      || actor.ownerEmail !== configuration.ownerEmail
    ) {
      throw new CareerSiteMailRequestError(
        'Career-site mail client is not authorized',
        403,
        'CAREER_SITE_MAIL_FORBIDDEN',
      )
    }
    const request = parseCareerSiteMailRequest(await requestBody(req))
    const headerIdempotencyKey = String(req.headers.get('idempotency-key') || '').trim()
    if (!headerIdempotencyKey || headerIdempotencyKey !== request.idempotencyKey) {
      throw new CareerSiteMailRequestError(
        'Idempotency-Key header must match idempotencyKey',
        400,
        'CAREER_SITE_MAIL_IDEMPOTENCY_KEY_INVALID',
      )
    }
    const result = await createCareerSiteMailInPostgres({ actor, request })
    return json({
      ok: true,
      delivery: {
        idempotencyKey: result.idempotencyKey,
        status: result.status,
        duplicate: result.duplicate,
      },
    }, result.duplicate ? 200 : 202)
  } catch (error) {
    return errorResponse(error)
  }
}
