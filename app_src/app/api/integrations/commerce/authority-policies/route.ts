import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceAuthorityPolicyError,
  readCommerceAuthorityPoliciesFromPostgres,
  setCommerceAuthorityPolicyInPostgres,
} from '@/lib/persistence/commerceAuthorityPolicies'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 32 * 1024
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Pragma: 'no-cache',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CommerceAuthorityPolicyError(
      'COMMERCE_AUTHORITY_POSTGRES_REQUIRED',
      'Commerce authority policies require Postgres storage',
      503,
    )
  }
}

function managerRequired() {
  return json({
    ok: false,
    error: 'Operations-management permission is required to view commerce authority policies',
    code: 'COMMERCE_AUTHORITY_MANAGE_REQUIRED',
  }, 403)
}

function activatorRequired() {
  return json({
    ok: false,
    error: 'Organization owner or operations-administrator access is required to change commerce authority policies',
    code: 'COMMERCE_AUTHORITY_ACTIVATE_REQUIRED',
  }, 403)
}

function requestError(code: string, message: string, status = 400): never {
  throw new CommerceAuthorityPolicyError(code, message, status)
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestError(
      'COMMERCE_AUTHORITY_CONTENT_TYPE_INVALID',
      'Commerce authority policy changes require JSON',
      415,
    )
  }
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      requestError(
        'COMMERCE_AUTHORITY_CONTENT_LENGTH_INVALID',
        'Commerce authority policy request length is invalid',
      )
    }
    if (length > MAX_REQUEST_BYTES) {
      requestError(
        'COMMERCE_AUTHORITY_REQUEST_TOO_LARGE',
        'Commerce authority policy request exceeded the supported size',
        413,
      )
    }
  }
  const chunks: Buffer[] = []
  let receivedBytes = 0
  const reader = req.body?.getReader()
  if (reader) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      receivedBytes += next.value.byteLength
      if (receivedBytes > MAX_REQUEST_BYTES) {
        try {
          await reader.cancel('request_too_large')
        } catch {
          // Request rejection is authoritative; cancellation is best effort.
        }
        requestError(
          'COMMERCE_AUTHORITY_REQUEST_TOO_LARGE',
          'Commerce authority policy request exceeded the supported size',
          413,
        )
      }
      chunks.push(Buffer.from(next.value))
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    requestError(
      'COMMERCE_AUTHORITY_REQUEST_INVALID',
      'Commerce authority policy request must be valid JSON',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    requestError(
      'COMMERCE_AUTHORITY_REQUEST_INVALID',
      'Commerce authority policy request is invalid',
    )
  }
  return parsed as Record<string, unknown>
}

function assertExactFields(body: Record<string, unknown>) {
  const allowed = new Set([
    'accountGlobalId',
    'resource',
    'authorityMode',
    'expectedRevision',
    'reason',
  ])
  if (
    Object.keys(body).length !== allowed.size
    || Object.keys(body).some((field) => !allowed.has(field))
    || Array.from(allowed).some((field) => !(field in body))
  ) {
    requestError(
      'COMMERCE_AUTHORITY_REQUEST_INVALID',
      'Commerce authority policy request fields are invalid',
    )
  }
}

function idempotencyKey(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (value === null || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'COMMERCE_AUTHORITY_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (
    error instanceof Error
    && error.message === 'ACTIVE_ORGANIZATION_REQUIRED'
  ) {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (error instanceof CommerceAuthorityPolicyError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  console.error('[commerce-authority-policies] request failed', {
    kind: error instanceof Error ? 'unexpected_error' : 'unexpected_value',
    code: 'COMMERCE_AUTHORITY_INTERNAL_ERROR',
  })
  return json({
    ok: false,
    error: 'Commerce authority policies are temporarily unavailable',
    code: 'COMMERCE_AUTHORITY_INTERNAL_ERROR',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) return managerRequired()
    if (Array.from(req.nextUrl.searchParams.keys()).length > 0) {
      requestError(
        'COMMERCE_AUTHORITY_QUERY_INVALID',
        'Commerce authority policy query parameters are unsupported',
      )
    }
    requirePostgres()
    const state = await readCommerceAuthorityPoliciesFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
    })
    return json({ ok: true, state })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canActivate) return activatorRequired()
    requirePostgres()
    const body = await requestBody(req)
    assertExactFields(body)
    const result = await setCommerceAuthorityPolicyInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      accountGlobalId: body.accountGlobalId,
      resource: body.resource,
      authorityMode: body.authorityMode,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      actorEmail: actor.email,
      actorRole: effectiveAuthorizationRole(actor),
      idempotencyKey: idempotencyKey(req),
    })
    return json({ ok: true, result })
  } catch (error) {
    return errorResponse(error)
  }
}
