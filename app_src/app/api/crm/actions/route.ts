import { NextRequest, NextResponse } from 'next/server'
import {
  CrmIntegrationActionError,
  enqueueCrmIntegrationAction,
  processCrmIntegrationActionNow,
  readCrmIntegrationAction,
} from '@/lib/crm/integrationActions'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
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
  ]
  const unsupported = Object.keys(body).find((key) => !allowed.includes(key))
  if (unsupported) {
    throw new CrmIntegrationActionError(`Unsupported CRM action request field: ${unsupported}`)
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

async function requestContext(req: NextRequest) {
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
    const { actor, pipeline } = await requestContext(req)
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

    const queued = await enqueueCrmIntegrationAction({
      pipelineId: pipeline.id,
      actorEmail: actor.email,
      actionType: aliasedValue(body, 'actionType', 'action', 'CRM action type'),
      referenceCode: aliasedValue(body, 'referenceCode', 'reference', 'CRM reference'),
      payload: body.payload,
      idempotencyKey: body.idempotencyKey ?? headerIdempotencyKey,
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
