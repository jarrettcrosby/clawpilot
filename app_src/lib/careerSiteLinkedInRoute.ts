import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteLinkedInConfigurationError,
  CareerSiteLinkedInRequestError,
  resolveCareerSiteLinkedInConfiguration,
} from '@/lib/careerSiteLinkedInContract'
import {
  CareerSiteLinkedInPersistenceError,
  registerCareerSiteLinkedInWorkerNonce,
} from '@/lib/persistence/careerSiteLinkedIn'
import { verifyCareerSiteLinkedInWorkerSignature } from '@/lib/careerSiteLinkedInWorkerAuth'
import {
  resolveShortLinkActor,
  ShortLinkRequestError,
  validateShortLinkConfiguration,
} from '@/lib/shortlinks'

export function careerSiteLinkedInJson(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

export function careerSiteLinkedInErrorResponse(error: unknown) {
  if (error instanceof CareerSiteLinkedInRequestError) {
    return careerSiteLinkedInJson({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteLinkedInPersistenceError) {
    return careerSiteLinkedInJson({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteLinkedInConfigurationError) {
    return careerSiteLinkedInJson({
      ok: false,
      error: 'Career Desk LinkedIn is not configured',
      code: 'CAREER_SITE_LINKEDIN_CONFIGURATION_INVALID',
    }, 503)
  }
  if (error instanceof ShortLinkRequestError) {
    return careerSiteLinkedInJson({ ok: false, error: error.message }, error.status)
  }
  console.error('[career-site-linkedin] request failed', {
    name: error instanceof Error ? error.name : typeof error,
  })
  return careerSiteLinkedInJson({
    ok: false,
    error: 'Career Desk LinkedIn could not complete this request',
    code: 'CAREER_SITE_LINKEDIN_FAILED',
  }, 503)
}

export async function readCareerSiteLinkedInJson(req: NextRequest, maximumBytes: number) {
  const contentType = String(req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new CareerSiteLinkedInRequestError('Content-Type must be application/json', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new CareerSiteLinkedInRequestError(
      'LinkedIn request is too large',
      413,
      'CAREER_SITE_LINKEDIN_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (!raw || Buffer.byteLength(raw, 'utf8') > maximumBytes) {
    throw new CareerSiteLinkedInRequestError(
      'LinkedIn request is empty or too large',
      Buffer.byteLength(raw, 'utf8') > maximumBytes ? 413 : 400,
      Buffer.byteLength(raw, 'utf8') > maximumBytes
        ? 'CAREER_SITE_LINKEDIN_REQUEST_TOO_LARGE'
        : 'CAREER_SITE_LINKEDIN_REQUEST_INVALID',
    )
  }
  try {
    return { raw, value: JSON.parse(raw) as unknown }
  } catch {
    throw new CareerSiteLinkedInRequestError('Request body must be valid JSON')
  }
}

export async function authorizeCareerSiteLinkedInActor(req: NextRequest) {
  const configuration = resolveCareerSiteLinkedInConfiguration()
  if (!configuration.enabled) {
    throw new CareerSiteLinkedInConfigurationError('Career Desk LinkedIn is disabled')
  }
  try {
    validateShortLinkConfiguration({ requireServiceClient: true })
  } catch {
    throw new CareerSiteLinkedInConfigurationError(
      'Career Desk LinkedIn requires an isolated service identity',
    )
  }
  const actor = await resolveShortLinkActor(req)
  if (
    !actor.service
    || actor.sourceApp !== configuration.sourceApp
    || actor.ownerEmail !== configuration.ownerEmail
    || actor.organizationId !== configuration.organizationId
  ) {
    throw new CareerSiteLinkedInRequestError(
      'Career Desk LinkedIn client is not authorized',
      403,
      'CAREER_SITE_LINKEDIN_FORBIDDEN',
    )
  }
  return { actor, configuration }
}

export async function authorizeCareerSiteLinkedInWorker(input: {
  req: NextRequest
  rawBody: string
}) {
  const configuration = resolveCareerSiteLinkedInConfiguration()
  if (!configuration.enabled) {
    throw new CareerSiteLinkedInConfigurationError('Career Desk LinkedIn is disabled')
  }
  const authorization = verifyCareerSiteLinkedInWorkerSignature({
    req: input.req,
    body: input.rawBody,
    bearerToken: configuration.workerToken,
    hmacSecret: configuration.workerHmacSecret,
  })
  await registerCareerSiteLinkedInWorkerNonce(authorization)
  return authorization
}
