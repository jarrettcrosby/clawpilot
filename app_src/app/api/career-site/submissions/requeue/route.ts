import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import {
  CareerSiteSubmissionConfigurationError,
  resolveCareerSiteSubmissionConfiguration,
} from '@/lib/careerSiteSubmissionContract'
import {
  CareerSiteSubmissionRequeueError,
  requeueDeadCareerSiteSubmissionInPostgres,
} from '@/lib/persistence/careerSiteSubmissions'
import { appPublicUrl } from '@/lib/publicUrl'
import { requireRequestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 4096
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  })
}

function requestError(message: string, status: number, code: string) {
  const error = new Error(message) as Error & { status: number; code: string }
  error.status = status
  error.code = code
  return error
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw requestError('Recovery request is too large', 413, 'CAREER_SITE_SUBMISSION_REQUEUE_TOO_LARGE')
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw requestError('Recovery request is too large', 413, 'CAREER_SITE_SUBMISSION_REQUEUE_TOO_LARGE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw requestError('Request body must be valid JSON', 400, 'CAREER_SITE_SUBMISSION_REQUEUE_INVALID')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw requestError('Request body must be an object', 400, 'CAREER_SITE_SUBMISSION_REQUEUE_INVALID')
  }
  const input = parsed as Record<string, unknown>
  if (Object.keys(input).some((key) => (
    key !== 'submissionId' && key !== 'expectedGeneration' && key !== 'reason'
  ))) {
    throw requestError('Recovery request contains unsupported fields', 400, 'CAREER_SITE_SUBMISSION_REQUEUE_INVALID')
  }
  const submissionId = typeof input.submissionId === 'string'
    ? input.submissionId.trim().toLowerCase()
    : ''
  const reason = typeof input.reason === 'string'
    ? input.reason.replace(/\s+/g, ' ').trim()
    : ''
  const expectedGeneration = input.expectedGeneration
  if (!UUID_PATTERN.test(submissionId)) {
    throw requestError('submissionId is invalid', 400, 'CAREER_SITE_SUBMISSION_REQUEUE_INVALID')
  }
  if (reason.length < 10 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw requestError('reason must be 10-500 characters', 400, 'CAREER_SITE_SUBMISSION_REQUEUE_INVALID')
  }
  if (!Number.isInteger(expectedGeneration) || Number(expectedGeneration) < 0 || Number(expectedGeneration) > 3) {
    throw requestError(
      'expectedGeneration must be an integer from 0 to 3',
      400,
      'CAREER_SITE_SUBMISSION_REQUEUE_INVALID',
    )
  }
  return { submissionId, expectedGeneration: Number(expectedGeneration), reason }
}

function errorResponse(error: unknown) {
  if (error instanceof CareerSiteSubmissionRequeueError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof CareerSiteSubmissionConfigurationError) {
    return json({
      ok: false,
      error: 'Career-site submissions are not configured',
      code: error.code,
    }, 503)
  }
  const status = error && typeof error === 'object' && 'status' in error
    ? Number(error.status)
    : 500
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : 'CAREER_SITE_SUBMISSION_REQUEUE_FAILED'
  const message = error instanceof Error && status >= 400 && status < 500
    ? error.message
    : 'Career-site submission delivery could not be requeued'
  return json({ ok: false, error: message, code }, status >= 400 && status <= 599 ? status : 500)
}

export async function POST(req: NextRequest) {
  try {
    const configuration = resolveCareerSiteSubmissionConfiguration()
    if (!configuration.enabled || !configuration.ownerEmail || !configuration.organizationId) {
      throw new CareerSiteSubmissionConfigurationError('Career-site submissions are disabled')
    }
    if (!isBrowserSameOriginRequest({
      headers: req.headers,
      requestOrigin: req.nextUrl.origin,
      trustedOrigins: [appPublicUrl()],
    })) {
      throw requestError(
        'Same-origin browser request required',
        403,
        'CAREER_SITE_SUBMISSION_REQUEUE_FORBIDDEN',
      )
    }
    const session = await requireRequestSession(req)
    const actor = await requireRequestUser(req)
    const role = effectiveAuthorizationRole(actor)
    if (
      session.legacy
      || session.impersonating
      || session.authenticatedUser !== session.effectiveUser
      || actor.email !== configuration.ownerEmail
      || session.effectiveUser !== configuration.ownerEmail
      || actor.organizationId !== configuration.organizationId
      || session.activeWorkspaceOrganizationId !== configuration.organizationId
      || (role !== 'owner' && role !== 'admin')
    ) {
      throw requestError(
        'Exact career-site owner or administrator session required',
        403,
        'CAREER_SITE_SUBMISSION_REQUEUE_FORBIDDEN',
      )
    }
    const result = await requeueDeadCareerSiteSubmissionInPostgres({
      actorEmail: actor.email,
      organizationId: actor.organizationId,
      ...await requestBody(req),
    })
    return json({ ok: true, delivery: result })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    return errorResponse(error)
  }
}
