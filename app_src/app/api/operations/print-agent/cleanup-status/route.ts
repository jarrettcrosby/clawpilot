import { NextRequest, NextResponse } from 'next/server'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  authenticateOperationsPrintAgentForCleanupInPostgres,
  resolveOperationsPrintAgentCleanupStatusInPostgres,
  type OperationsPrintAgentCleanupEntry,
} from '@/lib/persistence/operationPrintDelivery'
import { OperationsRequestError } from '@/lib/persistence/operations'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 48 * 1024
const MAX_ENTRIES = 128
const JOB_GLOBAL_ID = /^gpj(?:[0-9]{7}|[0-9a-v]{12})$/
const DOCUMENT_GLOBAL_ID = /^gpf(?:[0-9]{7}|[0-9a-v]{12})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const ENTRY_FIELDS = 'claimToken,contentSha256,documentGlobalId,jobGlobalId'

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function bearer(req: NextRequest) {
  const header = String(req.headers.get('authorization') || '')
  return /^Bearer\s+/i.test(header)
    ? header.replace(/^Bearer\s+/i, '').trim()
    : ''
}

function idempotencyKey(req: NextRequest) {
  const key = String(req.headers.get('idempotency-key') || '').trim()
  if (!IDEMPOTENCY_KEY.test(key)) {
    requestError(
      'OPERATIONS_PRINT_IDEMPOTENCY_REQUIRED',
      'A valid Idempotency-Key is required',
    )
  }
  return key
}

async function requestEntries(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError(
      'OPERATIONS_PRINT_AGENT_CONTENT_TYPE_INVALID',
      'Print-agent cleanup status requires JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Print-agent cleanup request exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_PRINT_AGENT_REQUEST_TOO_LARGE',
      'Print-agent cleanup request exceeded the supported size',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    requestError(
      'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
      'Print-agent cleanup request is invalid',
    )
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || Object.keys(parsed).join(',') !== 'entries'
  ) {
    requestError(
      'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
      'Print-agent cleanup request is invalid',
    )
  }
  const value = parsed as { entries?: unknown }
  if (
    !Array.isArray(value.entries)
    || value.entries.length < 1
    || value.entries.length > MAX_ENTRIES
  ) {
    requestError(
      'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
      'Print-agent cleanup entries are invalid',
    )
  }
  const entries: OperationsPrintAgentCleanupEntry[] = value.entries.map((candidate) => {
    if (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || Object.keys(candidate).sort().join(',') !== ENTRY_FIELDS
    ) {
      requestError(
        'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
        'Print-agent cleanup entry is invalid',
      )
    }
    const entry = candidate as Record<string, unknown>
    const jobGlobalId = String(entry.jobGlobalId || '').trim().toLowerCase()
    const claimToken = String(entry.claimToken || '').trim().toLowerCase()
    const documentGlobalId = String(entry.documentGlobalId || '').trim().toLowerCase()
    const contentSha256 = String(entry.contentSha256 || '').trim().toLowerCase()
    if (
      !JOB_GLOBAL_ID.test(jobGlobalId)
      || !UUID.test(claimToken)
      || !DOCUMENT_GLOBAL_ID.test(documentGlobalId)
      || !SHA256.test(contentSha256)
    ) {
      requestError(
        'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
        'Print-agent cleanup entry is invalid',
      )
    }
    return { jobGlobalId, claimToken, documentGlobalId, contentSha256 }
  })
  const identities = entries.map((entry) => (
    `${entry.jobGlobalId}:${entry.claimToken}`
  ))
  if (new Set(identities).size !== identities.length) {
    requestError(
      'OPERATIONS_PRINT_AGENT_CLEANUP_REQUEST_INVALID',
      'Print-agent cleanup entries must be unique',
    )
  }
  return entries
}

function errorResponse(error: unknown) {
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  return json({
    ok: false,
    error: 'Print-agent cleanup status failed',
    code: 'OPERATIONS_PRINT_AGENT_CLEANUP_FAILED',
  }, 500)
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return json({
        ok: false,
        error: 'Print-agent cleanup status requires Postgres storage',
        code: 'OPERATIONS_POSTGRES_REQUIRED',
      }, 503)
    }
    const agent = await authenticateOperationsPrintAgentForCleanupInPostgres(
      bearer(req),
    )
    if (!agent) {
      return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
    }
    const entries = await requestEntries(req)
    const resolved = await resolveOperationsPrintAgentCleanupStatusInPostgres({
      agent,
      entries,
      idempotencyKey: idempotencyKey(req),
    })
    return json({ ok: true, entries: resolved })
  } catch (error) {
    return errorResponse(error)
  }
}
