import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { OperationsShadowTrainingError } from '@/lib/operations/shadowTraining'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  completeOperationsShadowTrainingInPostgres,
  confirmOperationsShadowTrainingPicksInPostgres,
  enableOperationsShadowTrainingInPostgres,
  planOperationsShadowTrainingInPostgres,
  readOperationsShadowTrainingForOrderInPostgres,
  releaseOperationsShadowTrainingInPostgres,
  resetOperationsShadowTrainingInPostgres,
  undoOperationsShadowTrainingInPostgres,
  verifyOperationsShadowTrainingPackInPostgres,
} from '@/lib/persistence/operationShadowTraining'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/
const RUN_GLOBAL_ID = /^gtrn(?:[0-9]{7}|[0-9a-v]{12})$/
const EVIDENCE_GLOBAL_ID = /^gcte(?:[0-9]{7}|[0-9a-v]{12})$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsShadowTrainingError(message, status, code)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Operations training requires Postgres storage.',
      503,
    )
  }
}

function textValue(value: unknown, label: string, max: number) {
  const normalized = String(value ?? '').trim()
  if (
    !normalized
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    requestError('OPERATIONS_SHADOW_TRAINING_REQUEST_INVALID', `${label} is invalid.`)
  }
  return normalized
}

function globalIdValue(value: unknown, label: string, pattern: RegExp) {
  const normalized = textValue(value, label, 40)
  if (!pattern.test(normalized)) {
    requestError('OPERATIONS_SHADOW_TRAINING_REQUEST_INVALID', `${label} is invalid.`)
  }
  return normalized
}

function integerValue(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    requestError('OPERATIONS_SHADOW_TRAINING_REQUEST_INVALID', `${label} is invalid.`)
  }
  return parsed
}

function assertFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const supported = new Set(allowed)
  const unsupported = Object.keys(value).find((field) => !supported.has(field))
  if (unsupported) {
    requestError(
      'OPERATIONS_SHADOW_TRAINING_REQUEST_INVALID',
      'Training command includes an unsupported field.',
    )
  }
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError(
      'OPERATIONS_SHADOW_TRAINING_CONTENT_TYPE_INVALID',
      'Training commands require JSON.',
      415,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_SHADOW_TRAINING_REQUEST_TOO_LARGE',
      'Training command exceeded the supported size.',
      413,
    )
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    requestError(
      'OPERATIONS_SHADOW_TRAINING_REQUEST_INVALID',
      'A valid training command is required.',
    )
  }
}

function idempotencyKey(req: NextRequest) {
  const value = String(req.headers.get('idempotency-key') || '').trim()
  if (!IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required.',
    )
  }
  return value
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first.',
      code: 'ACTIVE_ORGANIZATION_REQUIRED',
    }, 409)
  }
  if (error instanceof OperationsShadowTrainingError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  console.error('[operations-training] unhandled request failure', {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : 'Unknown error',
    stack: error instanceof Error ? error.stack : undefined,
  })
  return json({
    ok: false,
    error: 'Operations training request failed.',
    code: 'OPERATIONS_SHADOW_TRAINING_REQUEST_FAILED',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to operations data.',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const orderGlobalId = globalIdValue(
      req.nextUrl.searchParams.get('order'),
      'Operations order',
      ORDER_GLOBAL_ID,
    )
    const training = await readOperationsShadowTrainingForOrderInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      orderGlobalId,
    })
    return json({ ok: true, capabilities, training })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage || !capabilities.canExecute) {
      return json({
        ok: false,
        error: 'You do not have permission to run order training.',
        code: 'OPERATIONS_EXECUTE_REQUIRED',
      }, 403)
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const body = await requestBody(req)
    const action = textValue(body.action, 'Training action', 40)
    const key = idempotencyKey(req)

    if (action === 'enable') {
      assertFields(body, ['action', 'orderGlobalId', 'confirmation', 'reason'])
      const run = await enableOperationsShadowTrainingInPostgres({
        organizationId,
        actorEmail: actor.email,
        orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
        confirmation: textValue(body.confirmation, 'Training confirmation', 80),
        reason: textValue(body.reason, 'Training reason', 500),
        idempotencyKey: key,
      })
      return json({ ok: true, capabilities, run }, 201)
    }

    const commonFields = ['action', 'runGlobalId', 'expectedRowVersion', 'reason']
    const common = {
      organizationId,
      actorEmail: actor.email,
      runGlobalId: globalIdValue(body.runGlobalId, 'Training run', RUN_GLOBAL_ID),
      expectedRowVersion: integerValue(body.expectedRowVersion, 'Training run version'),
      reason: textValue(body.reason, 'Training reason', 500),
      idempotencyKey: key,
    }
    if (action === 'plan') {
      assertFields(body, [...commonFields, 'cartonizationEvidenceGlobalId'])
      const run = await planOperationsShadowTrainingInPostgres({
        ...common,
        cartonizationEvidenceGlobalId: globalIdValue(
          body.cartonizationEvidenceGlobalId,
          'Cartonization evidence',
          EVIDENCE_GLOBAL_ID,
        ),
      })
      return json({ ok: true, capabilities, run })
    }
    assertFields(body, commonFields)
    const command = action === 'release'
      ? releaseOperationsShadowTrainingInPostgres
      : action === 'confirm-picks'
        ? confirmOperationsShadowTrainingPicksInPostgres
        : action === 'verify-pack'
          ? verifyOperationsShadowTrainingPackInPostgres
          : action === 'complete'
            ? completeOperationsShadowTrainingInPostgres
            : action === 'undo'
              ? undoOperationsShadowTrainingInPostgres
            : action === 'reset'
              ? resetOperationsShadowTrainingInPostgres
              : null
    if (!command) {
      requestError(
        'OPERATIONS_SHADOW_TRAINING_ACTION_INVALID',
        'Training action is invalid.',
      )
    }
    const run = await command(common)
    return json({ ok: true, capabilities, run })
  } catch (error) {
    return errorResponse(error)
  }
}
