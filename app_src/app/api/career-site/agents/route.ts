import { NextRequest, NextResponse } from 'next/server'
import {
  CareerSiteAgentConfigurationError,
  CareerSiteAgentRequestError,
  parseCareerSiteAgentRequest,
  resolveCareerSiteAgentConfiguration,
} from '@/lib/careerSiteAgentContract'
import {
  CareerSiteAgentConnectionError,
  getCareerSiteAgentStatus,
  runCareerSiteAgent,
} from '@/lib/careerSiteAgents'
import {
  resolveShortLinkActor,
  ShortLinkRequestError,
  validateShortLinkConfiguration,
} from '@/lib/shortlinks'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 300

const MAX_REQUEST_BYTES = 256 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof CareerSiteAgentRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteAgentConnectionError) {
    return json({
      ok: false,
      error: error.message,
      code: 'CAREER_SITE_AGENT_CHATGPT_CONNECTION_REQUIRED',
    }, 409)
  }
  if (error instanceof CareerSiteAgentConfigurationError) {
    return json({
      ok: false,
      error: 'Career Desk agents are not configured',
      code: 'CAREER_SITE_AGENT_CONFIGURATION_INVALID',
    }, 503)
  }
  if (error instanceof ShortLinkRequestError) {
    return json({ ok: false, error: error.message }, error.status)
  }
  console.error('[career-site-agents] request failed', {
    name: error instanceof Error ? error.name : typeof error,
  })
  return json({
    ok: false,
    error: 'The ClawPilot Career Desk agent could not complete this run',
    code: 'CAREER_SITE_AGENT_EXECUTION_FAILED',
  }, 503)
}

async function authorizedActor(req: NextRequest) {
  const configuration = resolveCareerSiteAgentConfiguration()
  if (!configuration.enabled) {
    throw new CareerSiteAgentConfigurationError('Career Desk agents are disabled')
  }
  try {
    validateShortLinkConfiguration({ requireServiceClient: true })
  } catch {
    throw new CareerSiteAgentConfigurationError(
      'Career Desk agents require an isolated service identity',
    )
  }
  const actor = await resolveShortLinkActor(req)
  if (
    !actor.service
    || actor.sourceApp !== configuration.sourceApp
    || actor.ownerEmail !== configuration.ownerEmail
    || actor.organizationId !== configuration.organizationId
  ) {
    throw new CareerSiteAgentRequestError(
      'Career Desk agent client is not authorized',
      403,
      'CAREER_SITE_AGENT_FORBIDDEN',
    )
  }
  return { actor, configuration }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CareerSiteAgentRequestError(
      'Career Desk agent request is too large',
      413,
      'CAREER_SITE_AGENT_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CareerSiteAgentRequestError(
      'Career Desk agent request is too large',
      413,
      'CAREER_SITE_AGENT_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new CareerSiteAgentRequestError('Request body must be valid JSON')
  }
}

export async function GET(req: NextRequest) {
  try {
    const { actor, configuration } = await authorizedActor(req)
    return json({
      ok: true,
      auth: await getCareerSiteAgentStatus(actor.ownerEmail),
      connectUrl: configuration.connectUrl,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const { actor } = await authorizedActor(req)
    const request = parseCareerSiteAgentRequest(await requestBody(req))
    const result = await runCareerSiteAgent({
      operatorId: actor.ownerEmail,
      request,
    })
    return json({ ok: true, result })
  } catch (error) {
    return errorResponse(error)
  }
}
