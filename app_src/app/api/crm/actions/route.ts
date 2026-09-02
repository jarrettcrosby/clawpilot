import { NextRequest, NextResponse } from 'next/server'
import {
  CrmIntegrationActionError,
  crmIntegrationClientRequestHash,
  enqueueCrmIntegrationAction,
  processCrmIntegrationActionNow,
  readCrmIntegrationAction,
  replayCrmIntegrationActionByIdempotencyKey,
  retryCrmIntegrationAction,
} from '@/lib/crm/integrationActions'
import { resolveVerifiedPipelineCalendarSelection } from '@/lib/integrations/organizationCommunications'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import {
  PIPELINE_SELECTION_COOKIE,
  requireResourceEditor,
  resolvePipelineSpaceAccess,
} from '@/lib/tenancy'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 256 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof CrmIntegrationActionError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && /view-only|access denied/i.test(error.message)) {
    return json({ ok: false, error: 'CRM actions require editor access', code: 'CRM_ACTION_FORBIDDEN' }, 403)
  }
  const shaped = error as { status?: unknown; code?: unknown; message?: unknown }
  if (Number.isInteger(shaped?.status) && typeof shaped?.code === 'string' && typeof shaped?.message === 'string') {
    return json({ ok: false, error: shaped.message, code: shaped.code }, Number(shaped.status))
  }
  return json({ ok: false, error: 'CRM action request failed', code: 'CRM_ACTION_INTERNAL_ERROR' }, 500)
}

function requirePostgresStorage() {
  if (!isPostgresStorageEnabled()) {
    throw new CrmIntegrationActionError(
      'CRM actions require Postgres storage',
      409,
      'CRM_ACTION_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CrmIntegrationActionError('CRM action request is too large', 413, 'CRM_ACTION_REQUEST_TOO_LARGE')
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new CrmIntegrationActionError('CRM action request is too large', 413, 'CRM_ACTION_REQUEST_TOO_LARGE')
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body was not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new CrmIntegrationActionError('Request body must be valid JSON', 400, 'CRM_ACTION_REQUEST_INVALID')
  }
}

function requireOnlyFields(body: Record<string, unknown>) {
  const allowed = [
    'action',
    'actionType',
    'reference',
    'referenceCode',
    'payload',
    'idempotencyKey',
    'processNow',
    'calendarConnectionId',
    'calendarId',
  ]
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key))
  if (unsupported) {
    throw new CrmIntegrationActionError(`Unsupported CRM action request field: ${unsupported}`)
  }
}

function requireRetryOnlyFields(body: Record<string, unknown>) {
  const allowed = ['actionId', 'reason', 'reviewed', 'processNow']
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key))
  if (unsupported) {
    throw new CrmIntegrationActionError(`Unsupported CRM retry request field: ${unsupported}`)
  }
}

function aliasedValue(body: Record<string, unknown>, primary: string, alias: string, label: string) {
  const primaryValue = body[primary]
  const aliasValue = body[alias]
  if (
    primaryValue !== undefined
    && aliasValue !== undefined
    && String(primaryValue).trim() !== String(aliasValue).trim()
  ) {
    throw new CrmIntegrationActionError(`${label} fields do not match`)
  }
  return primaryValue ?? aliasValue
}

async function requestContext(req: NextRequest, options: { write?: boolean } = {}) {
  if (options.write) {
    const session = await requestSession(req)
    if (session?.impersonating || (session && session.authenticatedUser !== session.effectiveUser)) {
      throw new CrmIntegrationActionError(
        'Exit user view before changing CRM integration actions',
        403,
        'CRM_ACTION_IMPERSONATION_FORBIDDEN',
      )
    }
  }
  const actor = await requireRequestUser(req)
  const selected = req.cookies.get(PIPELINE_SELECTION_COOKIE)?.value || undefined
  const pipeline = await resolvePipelineSpaceAccess({ actorEmail: actor, pipelineId: selected })
    .catch(() => resolvePipelineSpaceAccess({ actorEmail: actor }))
  requireResourceEditor(pipeline)
  return { actor, pipeline }
}

export async function GET(req: NextRequest) {
  try {
    requirePostgresStorage()
    const { actor, pipeline } = await requestContext(req)
    const actionId = req.nextUrl.searchParams.get('id') || req.nextUrl.searchParams.get('actionId')
    if (!actionId) {
      throw new CrmIntegrationActionError('CRM action ID is required')
    }
    const action = await readCrmIntegrationAction({
      actionId,
      pipelineId: pipeline.id,
      actorEmail: actor.email,
    })
    return json({ ok: true, action })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgresStorage()
    const { actor, pipeline } = await requestContext(req, { write: true })
    const body = await requestBody(req)
    requireOnlyFields(body)
    if (body.processNow !== undefined && typeof body.processNow !== 'boolean') {
      throw new CrmIntegrationActionError('processNow must be a boolean')
    }
    const headerIdempotencyKey = req.headers.get('idempotency-key') || undefined
    if (
      body.idempotencyKey !== undefined
      && headerIdempotencyKey !== undefined
      && String(body.idempotencyKey).trim() !== headerIdempotencyKey.trim()
    ) {
      throw new CrmIntegrationActionError('Idempotency key fields do not match')
    }

    const actionType = aliasedValue(body, 'actionType', 'action', 'CRM action type')
    const referenceCode = aliasedValue(body, 'referenceCode', 'reference', 'CRM reference')
    const idempotencyKey = body.idempotencyKey ?? headerIdempotencyKey
    const calendarConnectionSupplied = body.calendarConnectionId !== undefined
    const calendarIdSupplied = body.calendarId !== undefined
    if (calendarConnectionSupplied !== calendarIdSupplied) {
      throw new CrmIntegrationActionError(
        'Per-meeting Calendar selection requires both calendarConnectionId and calendarId',
        400,
        'CRM_CALENDAR_SELECTION_INCOMPLETE',
      )
    }
    if (calendarConnectionSupplied && actionType !== 'create_calendar_event') {
      throw new CrmIntegrationActionError(
        'Per-meeting Calendar selection is only supported for Calendar event actions',
        400,
        'CRM_CALENDAR_SELECTION_INVALID',
      )
    }
    const clientRequestHash = actionType === 'create_calendar_event'
      ? crmIntegrationClientRequestHash({
          contract: 'crm-calendar-action-v1',
          pipelineId: pipeline.id,
          actorEmail: actor.email,
          actionType: 'create_calendar_event',
          referenceCode: String(referenceCode ?? '').trim().toLowerCase(),
          payload: body.payload ?? null,
          calendarSelection: calendarConnectionSupplied
            ? {
                connectionId: String(body.calendarConnectionId ?? '').trim(),
                calendarId: String(body.calendarId ?? '').trim(),
              }
            : null,
        })
      : undefined
    if (clientRequestHash && idempotencyKey !== undefined) {
      const replay = await replayCrmIntegrationActionByIdempotencyKey({
        pipelineId: pipeline.id,
        actorEmail: actor.email,
        idempotencyKey,
        clientRequestHash,
        actionType,
        referenceCode,
      })
      if (replay) {
        return json({
          ok: true,
          created: false,
          attemptedSynchronously: false,
          action: replay.action,
        })
      }
    }
    const communicationOverride = calendarConnectionSupplied
      ? await resolveVerifiedPipelineCalendarSelection({
          pipelineId: pipeline.id,
          actorEmail: actor.email,
          connectionId: body.calendarConnectionId,
          calendarId: body.calendarId,
        })
      : undefined

    const queued = await enqueueCrmIntegrationAction({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      actionType,
      referenceCode,
      payload: body.payload,
      idempotencyKey,
      clientRequestHash,
      communicationOverride,
    })
    const attemptedSynchronously = queued.created && body.processNow !== false
    let action = queued.action
    if (attemptedSynchronously) {
      try {
        action = await processCrmIntegrationActionNow({
          actionId: queued.action.id,
          pipelineId: pipeline.id,
          actorEmail: actor.email,
        })
      } catch {
        action = await readCrmIntegrationAction({
          actionId: queued.action.id,
          pipelineId: pipeline.id,
          actorEmail: actor.email,
        })
      }
    }

    return json({
      ok: true,
      created: queued.created,
      attemptedSynchronously,
      action,
    }, queued.created ? 201 : 200)
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requirePostgresStorage()
    const { actor, pipeline } = await requestContext(req, { write: true })
    const body = await requestBody(req)
    requireRetryOnlyFields(body)
    if (body.reviewed !== true) {
      throw new CrmIntegrationActionError(
        'CRM action retry requires explicit review',
        409,
        'CRM_ACTION_RETRY_REVIEW_REQUIRED',
      )
    }
    if (body.processNow !== undefined && typeof body.processNow !== 'boolean') {
      throw new CrmIntegrationActionError('processNow must be a boolean')
    }
    let action = await retryCrmIntegrationAction({
      actionId: body.actionId,
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      reviewed: true,
      reason: body.reason,
    })
    const attemptedSynchronously = body.processNow !== false
    if (attemptedSynchronously) {
      action = await processCrmIntegrationActionNow({
        actionId: action.id,
        pipelineId: pipeline.id,
        actorEmail: actor.email,
      })
    }
    return json({ ok: true, attemptedSynchronously, action })
  } catch (error) {
    return errorResponse(error)
  }
}
