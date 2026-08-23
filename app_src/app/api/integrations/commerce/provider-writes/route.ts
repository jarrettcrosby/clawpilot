import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceProviderWriteControlError,
  readCommerceProviderWriteControlsFromPostgres,
  setCommerceProviderWriteControlInPostgres,
} from '@/lib/persistence/commerceProviderWrites'
import { requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 16 * 1024
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

function fail(code: string, message: string, status = 400): never {
  throw new CommerceProviderWriteControlError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    fail(
      'COMMERCE_PROVIDER_WRITES_POSTGRES_REQUIRED',
      'Provider writes controls require Postgres storage',
      503,
    )
  }
}

function managerRequired() {
  return json({
    ok: false,
    error: 'Operations-management permission is required to manage Provider writes',
    code: 'COMMERCE_PROVIDER_WRITES_MANAGE_REQUIRED',
  }, 403)
}

function activatorRequired() {
  return json({
    ok: false,
    error: 'Organization owner or operations-administrator access is required to turn Provider writes on',
    code: 'COMMERCE_PROVIDER_WRITES_ACTIVATE_REQUIRED',
  }, 403)
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_CONTENT_TYPE_INVALID',
      'Provider writes changes require JSON',
      415,
    )
  }
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length < 0) {
      fail(
        'COMMERCE_PROVIDER_WRITES_CONTENT_LENGTH_INVALID',
        'Provider writes request length is invalid',
      )
    }
    if (length > MAX_REQUEST_BYTES) {
      fail(
        'COMMERCE_PROVIDER_WRITES_REQUEST_TOO_LARGE',
        'Provider writes request exceeded the supported size',
        413,
      )
    }
  }
  const reader = req.body?.getReader()
  const chunks: Buffer[] = []
  let receivedBytes = 0
  if (reader) {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      receivedBytes += next.value.byteLength
      if (receivedBytes > MAX_REQUEST_BYTES) {
        await reader.cancel('request_too_large').catch(() => undefined)
        fail(
          'COMMERCE_PROVIDER_WRITES_REQUEST_TOO_LARGE',
          'Provider writes request exceeded the supported size',
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
    fail(
      'COMMERCE_PROVIDER_WRITES_REQUEST_INVALID',
      'Provider writes request must be valid JSON',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_REQUEST_INVALID',
      'Provider writes request is invalid',
    )
  }
  return parsed as Record<string, unknown>
}

function assertExactFields(body: Record<string, unknown>) {
  const allowed = new Set(['accountGlobalId', 'mode', 'expectedRowVersion'])
  if (
    Object.keys(body).length !== allowed.size
    || Object.keys(body).some((field) => !allowed.has(field))
    || Array.from(allowed).some((field) => !(field in body))
  ) {
    fail(
      'COMMERCE_PROVIDER_WRITES_REQUEST_INVALID',
      'Provider writes request fields are invalid',
    )
  }
}

function idempotencyKey(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (value === null || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    fail(
      'COMMERCE_PROVIDER_WRITES_IDEMPOTENCY_KEY_INVALID',
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
  if (error instanceof CommerceProviderWriteControlError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  console.error('[commerce-provider-writes] request failed', {
    kind: error instanceof Error ? 'unexpected_error' : 'unexpected_value',
    code: 'COMMERCE_PROVIDER_WRITES_INTERNAL_ERROR',
  })
  return json({
    ok: false,
    error: 'Provider writes controls are temporarily unavailable',
    code: 'COMMERCE_PROVIDER_WRITES_INTERNAL_ERROR',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) return managerRequired()
    if (Array.from(req.nextUrl.searchParams.keys()).length > 0) {
      fail(
        'COMMERCE_PROVIDER_WRITES_QUERY_INVALID',
        'Provider writes query parameters are unsupported',
      )
    }
    requirePostgres()
    const state = await readCommerceProviderWriteControlsFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
    })
    return json({
      ok: true,
      state,
      canManage: true,
      canEnable: capabilities.canActivate,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) return managerRequired()
    requirePostgres()
    const body = await requestBody(req)
    assertExactFields(body)
    if (body.mode === 'on' && !capabilities.canActivate) {
      return activatorRequired()
    }
    const result = await setCommerceProviderWriteControlInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      accountGlobalId: body.accountGlobalId,
      mode: body.mode,
      expectedRowVersion: body.expectedRowVersion,
      actorEmail: actor.email,
      actorRole: effectiveAuthorizationRole(actor),
      idempotencyKey: idempotencyKey(req),
    })
    return json({
      ok: true,
      result,
      canManage: true,
      canEnable: capabilities.canActivate,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
