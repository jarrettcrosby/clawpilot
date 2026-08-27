import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  OperationsOrderUnitWeightError,
  readOrderUnitWeightWorkspaceInPostgres,
  recordOrderUnitWeightsInPostgres,
} from '@/lib/persistence/orderUnitWeightEvidence'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 128 * 1024
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const LINE_GLOBAL_ID = /^(?:gcol|gcal)(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function fail(code: string, message: string, status = 400): never {
  throw new ApiError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Operations requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
) {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    fail(
      'OPERATIONS_REQUEST_INVALID',
      `${label} includes missing or unsupported fields`,
    )
  }
}

function accountGlobalId(value: unknown) {
  const id = String(value || '').trim()
  if (!ACCOUNT_GLOBAL_ID.test(id)) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_ACCOUNT_INVALID',
      'The commerce account is invalid',
    )
  }
  return id
}

function candidateGlobalId(value: unknown) {
  const id = String(value || '').trim()
  if (!CANDIDATE_GLOBAL_ID.test(id)) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_CANDIDATE_INVALID',
      'The imported order is invalid',
    )
  }
  return id
}

function rowVersion(value: unknown) {
  if (
    !(
      typeof value === 'number'
      || (typeof value === 'string' && value.trim().length > 0)
    )
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_VERSION_INVALID',
      'The imported order version is invalid',
    )
  }
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 0) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_VERSION_INVALID',
      'The imported order version is invalid',
    )
  }
  return version
}

function requestBodyLines(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_LINES_INVALID',
      'Provide one unit weight for each missing order line',
    )
  }
  return value.map((entry, index) => {
    const line = record(entry, `Unit weight ${index + 1}`)
    exactFields(
      line,
      ['expectedFactVersion', 'lineGlobalId', 'unitWeightGrams'],
      `Unit weight ${index + 1}`,
    )
    const lineGlobalId = String(line.lineGlobalId || '').trim()
    const unitWeightGrams = line.unitWeightGrams
    const expectedFactVersion = line.expectedFactVersion === null
      ? null
      : line.expectedFactVersion
    if (!LINE_GLOBAL_ID.test(lineGlobalId)) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_LINE_INVALID',
        `Unit weight ${index + 1} has an invalid order line`,
      )
    }
    if (
      typeof unitWeightGrams !== 'number'
      || !Number.isSafeInteger(unitWeightGrams)
      || unitWeightGrams < 1
      || unitWeightGrams > 1_000_000
    ) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_INVALID',
        `Unit weight ${index + 1} must be a positive whole number of grams`,
      )
    }
    if (
      expectedFactVersion !== null
      && (
        typeof expectedFactVersion !== 'number'
        || !Number.isSafeInteger(expectedFactVersion)
        || expectedFactVersion < 1
      )
    ) {
      fail(
        'OPERATIONS_ORDER_UNIT_WEIGHT_VERSION_INVALID',
        `Unit weight ${index + 1} has an invalid evidence version`,
      )
    }
    return { lineGlobalId, unitWeightGrams, expectedFactVersion }
  })
}

function reason(value: unknown) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 8
    || value.length > 500
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'OPERATIONS_ORDER_UNIT_WEIGHT_REASON_INVALID',
      'Enter a short audit reason for these unit weights',
    )
  }
  return value
}

function idempotencyKey(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (!value || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    fail(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

async function jsonBody(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    fail(
      'OPERATIONS_CONTENT_TYPE_INVALID',
      'Unit weights require JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Unit weights exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    fail(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Unit weights exceeded the supported size',
      413,
    )
  }
  try {
    return record(JSON.parse(raw) as unknown, 'Unit weights')
  } catch (error) {
    if (error instanceof ApiError) throw error
    fail('OPERATIONS_REQUEST_INVALID', 'Valid unit weights are required')
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return response({ ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' }, 401)
  }
  if (
    error instanceof ApiError
    || error instanceof OperationsOrderUnitWeightError
  ) {
    return response(
      { ok: false, code: error.code, error: error.message },
      error.status,
    )
  }
  console.error('[operations-order-unit-weights] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return response({
    ok: false,
    code: 'OPERATIONS_ORDER_UNIT_WEIGHT_REQUEST_FAILED',
    error: 'Unit weights could not be loaded or saved',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canView) {
      return response({
        ok: false,
        code: 'OPERATIONS_VIEW_REQUIRED',
        error: 'You do not have permission to view Operations orders',
      }, 403)
    }
    const workspace = await readOrderUnitWeightWorkspaceInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      accountGlobalId: accountGlobalId(
        req.nextUrl.searchParams.get('accountGlobalId'),
      ),
      candidateGlobalId: candidateGlobalId(
        req.nextUrl.searchParams.get('candidateGlobalId'),
      ),
      expectedCandidateRowVersion: rowVersion(
        req.nextUrl.searchParams.get('candidateRowVersion'),
      ),
    })
    return response({ ok: true, workspace })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'You do not have permission to prepare Operations orders',
      }, 403)
    }
    const body = await jsonBody(req)
    exactFields(body, [
      'accountGlobalId',
      'candidateGlobalId',
      'candidateRowVersion',
      'lines',
      'reason',
    ], 'Unit weights')
    const result = await recordOrderUnitWeightsInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      idempotencyKey: idempotencyKey(req),
      accountGlobalId: accountGlobalId(body.accountGlobalId),
      candidateGlobalId: candidateGlobalId(body.candidateGlobalId),
      expectedCandidateRowVersion: rowVersion(body.candidateRowVersion),
      lines: requestBodyLines(body.lines),
      reason: reason(body.reason),
    })
    return response({ ok: true, result })
  } catch (error) {
    return errorResponse(error)
  }
}
