import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteGmailSourceConfigurationError,
  CareerSiteGmailSourceRequestError,
  parseCareerSiteGmailSourceRequest,
  resolveCareerSiteGmailSourceConfiguration,
} from '@/lib/careerSiteGmailSourceContract'
import {
  CareerSiteGmailSourceError,
  getCareerSiteGmailAccounts,
  searchCareerSiteGmailMessages,
} from '@/lib/careerSiteGmailSources'
import {
  resolveShortLinkActor,
  ShortLinkRequestError,
  validateShortLinkConfiguration,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_REQUEST_BYTES = 4 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof CareerSiteGmailSourceRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteGmailSourceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteGmailSourceConfigurationError) {
    return json({
      ok: false,
      error: 'Career Desk Gmail sources are not configured',
      code: 'CAREER_SITE_GMAIL_SOURCE_CONFIGURATION_INVALID',
    }, 503)
  }
  if (error instanceof ShortLinkRequestError) {
    return json({ ok: false, error: error.message }, error.status)
  }
  console.error('[career-site-gmail-sources] request failed', {
    name: error instanceof Error ? error.name : typeof error,
  })
  return json({
    ok: false,
    error: 'The Career Desk Gmail source request could not be completed',
    code: 'CAREER_SITE_GMAIL_SOURCE_FAILED',
  }, 503)
}

async function authorizedActor(req: NextRequest) {
  const configuration = resolveCareerSiteGmailSourceConfiguration()
  if (!configuration.enabled) {
    throw new CareerSiteGmailSourceConfigurationError(
      'Career Desk Gmail sources are disabled',
    )
  }
  try {
    validateShortLinkConfiguration({ requireServiceClient: true })
  } catch {
    throw new CareerSiteGmailSourceConfigurationError(
      'Career Desk Gmail sources require an isolated service identity',
    )
  }
  const actor = await resolveShortLinkActor(req)
  if (
    !actor.service
    || actor.sourceApp !== configuration.sourceApp
    || actor.ownerEmail !== configuration.ownerEmail
    || actor.organizationId !== configuration.organizationId
  ) {
    throw new CareerSiteGmailSourceRequestError(
      'Career Desk Gmail source client is not authorized',
      403,
      'CAREER_SITE_GMAIL_SOURCE_FORBIDDEN',
    )
  }
  return actor
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CareerSiteGmailSourceRequestError(
      'Career Desk Gmail source request is too large',
      413,
      'CAREER_SITE_GMAIL_SOURCE_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CareerSiteGmailSourceRequestError(
      'Career Desk Gmail source request is too large',
      413,
      'CAREER_SITE_GMAIL_SOURCE_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new CareerSiteGmailSourceRequestError('Request body must be valid JSON')
  }
}

export async function GET(req: NextRequest) {
  try {
    const actor = await authorizedActor(req)
    return json({
      ok: true,
      accounts: await getCareerSiteGmailAccounts(actor.ownerEmail),
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await authorizedActor(req)
    const request = parseCareerSiteGmailSourceRequest(await requestBody(req))
    return json({
      ok: true,
      messages: await searchCareerSiteGmailMessages({
        ownerEmail: actor.ownerEmail,
        request,
      }),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
