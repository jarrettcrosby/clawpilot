import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  assertOperationsRegressionReplayRuntime,
  OperationsRegressionReplayError,
  readOperationsRegressionWalkthroughInPostgres,
  runOperationsRegressionReplayInPostgres,
} from '@/lib/persistence/operationsRegressionReplay'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,140}$/
const SCENARIO_ID = /^[a-z0-9][a-z0-9-]{2,119}$/

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new OperationsRegressionReplayError(code, message, status)
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first.',
      code: error.message,
    }, 409)
  }
  if (error instanceof OperationsRegressionReplayError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  console.error('[operations regression replay] request failed', error)
  return json({
    ok: false,
    error: 'Pack-and-rate regression replay request failed.',
    code: 'OPERATIONS_REGRESSION_REQUEST_FAILED',
  }, 500)
}

async function managerContext(req: NextRequest) {
  const actor = await requireRequestUser(req)
  const organizationId = activeOperationsOrganizationId(actor)
  if (!operationsCapabilities(actor).canManage) {
    fail(
      'OPERATIONS_REGRESSION_MANAGER_REQUIRED',
      'Operations manager permission is required to run regression replays.',
      403,
    )
  }
  assertOperationsRegressionReplayRuntime()
  return { actor, organizationId }
}

async function requestBody(req: NextRequest) {
  if (
    !String(req.headers.get('content-type') || '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    fail(
      'OPERATIONS_REGRESSION_CONTENT_TYPE_INVALID',
      'Regression replay commands require JSON.',
      415,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_REGRESSION_REQUEST_TOO_LARGE',
      'Regression replay command exceeded the supported size.',
      413,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    fail(
      'OPERATIONS_REGRESSION_REQUEST_INVALID',
      'A valid regression replay command is required.',
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'OPERATIONS_REGRESSION_REQUEST_INVALID',
      'A valid regression replay command is required.',
    )
  }
  const body = value as Record<string, unknown>
  const allowed = new Set(['action', 'scenarioId', 'idempotencyKey'])
  if (Object.keys(body).some((field) => !allowed.has(field))) {
    fail(
      'OPERATIONS_REGRESSION_REQUEST_INVALID',
      'Regression replay command includes an unsupported field.',
    )
  }
  if (body.action !== 'run-replay') {
    fail(
      'OPERATIONS_REGRESSION_ACTION_INVALID',
      'Regression replay action is invalid.',
    )
  }
  const scenarioId = String(body.scenarioId || '').trim()
  if (!SCENARIO_ID.test(scenarioId)) {
    fail(
      'OPERATIONS_REGRESSION_SCENARIO_INVALID',
      'Regression replay scenario is invalid.',
    )
  }
  const idempotencyKey = String(body.idempotencyKey || '').trim()
  const headerKey = String(req.headers.get('idempotency-key') || '').trim()
  if (
    !IDEMPOTENCY_KEY.test(idempotencyKey)
    || headerKey !== idempotencyKey
  ) {
    fail(
      'OPERATIONS_REGRESSION_IDEMPOTENCY_KEY_INVALID',
      'The body and Idempotency-Key header must contain the same valid key.',
    )
  }
  return { scenarioId, idempotencyKey }
}

export async function GET(req: NextRequest) {
  try {
    const { organizationId } = await managerContext(req)
    const walkthrough =
      await readOperationsRegressionWalkthroughInPostgres({ organizationId })
    return json({ ok: true, walkthrough })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const { actor, organizationId } = await managerContext(req)
    const command = await requestBody(req)
    const run = await runOperationsRegressionReplayInPostgres({
      organizationId,
      actorEmail: actor.email,
      scenarioId: command.scenarioId,
      idempotencyKey: command.idempotencyKey,
    })
    return json({ ok: true, run })
  } catch (error) {
    return errorResponse(error)
  }
}
