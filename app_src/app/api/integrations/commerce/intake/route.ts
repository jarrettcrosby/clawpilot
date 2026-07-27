import { NextRequest, NextResponse } from 'next/server'
import {
  executeCommerceIntakeCommand,
  getCommerceIntake,
} from '@/lib/integrations/commerceIntake'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 32 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  const sanitized = sanitizedCommerceIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CommerceIntegrationRequestError(
      'Your organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requireManager(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required to resolve and promote commerce orders',
      403,
      'COMMERCE_MANAGER_REQUIRED',
    )
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake requires Postgres storage',
      503,
      'COMMERCE_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake request is too large',
      413,
      'COMMERCE_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Commerce intake request is too large',
      413,
      'COMMERCE_REQUEST_TOO_LARGE',
    )
  }
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new CommerceIntegrationRequestError(
      'Request body must be a JSON object',
      400,
      'COMMERCE_REQUEST_INVALID',
    )
  }
}

async function actor(req: NextRequest) {
  const value = await requireRequestUser(req)
  requirePostgres()
  requireManager(value)
  return value
}

export async function GET(req: NextRequest) {
  try {
    const user = await actor(req)
    const intake = await getCommerceIntake({
      organizationId: organizationId(user),
      accountGlobalId: req.nextUrl.searchParams.get('accountGlobalId'),
    })
    return json({ ok: true, intake })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await actor(req)
    const body = await requestBody(req)
    const result = await executeCommerceIntakeCommand({
      organizationId: organizationId(user),
      actorEmail: user.email,
      body,
    })
    return json({ ok: true, ...result })
  } catch (error) {
    return errorResponse(error)
  }
}
