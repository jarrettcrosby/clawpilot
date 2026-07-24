import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  acknowledgeOperationsPrintJobInPostgres,
  authenticateOperationsPrintAgentInPostgres,
  claimOperationsPrintJobsInPostgres,
  failOperationsPrintJobInPostgres,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024
const JOB_GLOBAL_ID = /^gpj\d{7}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTION_FIELDS: Record<string, Set<string>> = {
  claim: new Set(['action', 'limit', 'leaseSeconds']),
  acknowledge: new Set(['action', 'jobGlobalId', 'claimToken', 'deviceJobReference']),
  fail: new Set([
    'action', 'jobGlobalId', 'claimToken', 'errorCode', 'errorMessage',
    'retryable', 'printerUnavailable', 'retryAfterSeconds',
  ]),
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function text(value: unknown, label: string, max: number) {
  const parsed = String(value ?? '').trim()
  if (!parsed || parsed.length > max || /[\u0000-\u001f\u007f]/.test(parsed)) {
    requestError('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return parsed
}

function bearer(req: NextRequest) {
  const header = String(req.headers.get('authorization') || '')
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : ''
}

async function body(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError(
      'OPERATIONS_PRINT_AGENT_CONTENT_TYPE_INVALID',
      'Local print-agent requests require JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Local print-agent request exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Local print-agent request exceeded the supported size',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'A valid local print-agent request is required',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Local print-agent request is invalid',
    )
  }
  const value = parsed as Record<string, unknown>
  const action = String(value.action || '')
  const fields = ACTION_FIELDS[action]
  if (!fields || Object.keys(value).some((field) => !fields.has(field))) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Local print-agent request includes an unsupported action or field',
    )
  }
  return { action, value }
}

function idempotencyKey(req: NextRequest) {
  return text(req.headers.get('idempotency-key'), 'Idempotency-Key', 200)
}

function jobIdentity(value: Record<string, unknown>) {
  const jobGlobalId = text(value.jobGlobalId, 'Print job Global ID', 16)
  const claimToken = text(value.claimToken, 'Claim token', 40)
  if (!JOB_GLOBAL_ID.test(jobGlobalId) || !UUID.test(claimToken)) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
      'Print job identity or claim token is invalid',
    )
  }
  return { jobGlobalId, claimToken }
}

function errorResponse(error: unknown) {
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Local print-agent request failed',
    code: 'OPERATIONS_PRINT_AGENT_REQUEST_FAILED',
  }, 500)
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'Local print agents require Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    const agent = await authenticateOperationsPrintAgentInPostgres(bearer(req))
    if (!agent) {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    const command = await body(req)
    if (command.action === 'claim') {
      const limit = command.value.limit === undefined ? 1 : Number(command.value.limit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
        requestError('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', 'Claim limit is invalid')
      }
      const leaseSeconds = command.value.leaseSeconds === undefined
        ? 120
        : Number(command.value.leaseSeconds)
      if (
        !Number.isSafeInteger(leaseSeconds)
        || leaseSeconds < 30
        || leaseSeconds > 300
      ) {
        requestError(
          'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
          'Claim lease is invalid',
        )
      }
      const jobs = await claimOperationsPrintJobsInPostgres({
        agent,
        idempotencyKey: idempotencyKey(req),
        limit,
        leaseSeconds,
      })
      return json({ ok: true, jobs })
    }
    const identity = jobIdentity(command.value)
    if (command.action === 'acknowledge') {
      const job = await acknowledgeOperationsPrintJobInPostgres({
        agent,
        ...identity,
        idempotencyKey: idempotencyKey(req),
        deviceJobReference: command.value.deviceJobReference === undefined
          ? null
          : text(command.value.deviceJobReference, 'Device job reference', 200),
      })
      return json({ ok: true, job })
    }
    if (typeof command.value.retryable !== 'boolean') {
      requestError('OPERATIONS_PRINT_AGENT_REQUEST_INVALID', 'Retryable flag is invalid')
    }
    if (
      command.value.printerUnavailable !== undefined
      && typeof command.value.printerUnavailable !== 'boolean'
    ) {
      requestError(
        'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
        'Printer unavailable flag is invalid',
      )
    }
    const retryAfterSeconds = command.value.retryAfterSeconds === undefined
      ? 0
      : Number(command.value.retryAfterSeconds)
    if (
      !Number.isSafeInteger(retryAfterSeconds)
      || retryAfterSeconds < 0
      || retryAfterSeconds > 300
    ) {
      requestError(
        'OPERATIONS_PRINT_AGENT_REQUEST_INVALID',
        'Retry delay is invalid',
      )
    }
    const job = await failOperationsPrintJobInPostgres({
      agent,
      ...identity,
      idempotencyKey: idempotencyKey(req),
      errorCode: text(command.value.errorCode, 'Failure code', 64),
      errorMessage: text(command.value.errorMessage, 'Failure message', 1000),
      retryable: command.value.retryable,
      printerUnavailable: command.value.printerUnavailable === true,
      retryAfterSeconds,
    })
    return json({ ok: true, job })
  } catch (error) {
    return errorResponse(error)
  }
}
