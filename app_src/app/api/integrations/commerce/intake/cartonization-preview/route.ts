import { NextRequest, NextResponse } from 'next/server'
import { assertCommerceIntakeRuntime } from '@/lib/integrations/commerceIntake'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import { operationsCapabilities } from '@/lib/operations/authorization'
import {
  CartonizationPreviewRequestError,
  createCartonizationPreview,
  normalizeCartonizationPreviewRequest,
} from '@/lib/operations/cartonizationPreview'
import {
  configuredOrToolsFulfillmentOptimizer,
} from '@/lib/operations/orToolsFulfillmentOptimizer'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CartonizationPreviewPersistenceError,
  readCartonizationPreviewSnapshotFromPostgres,
} from '@/lib/persistence/cartonizationPreview'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 30

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

function organizationId(actor: AppUser) {
  if (!actor.organizationId) {
    throw new CommerceIntegrationRequestError(
      'Your active organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return actor.organizationId
}

function requirePreviewAccess(actor: AppUser) {
  if (!operationsCapabilities(actor).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required to preview cartonization',
      403,
      'CARTONIZATION_PREVIEW_MANAGER_REQUIRED',
    )
  }
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Cartonization preview requires Postgres storage',
      503,
      'CARTONIZATION_PREVIEW_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CartonizationPreviewRequestError(
      'Cartonization preview request is too large',
      413,
      'CARTONIZATION_PREVIEW_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new CartonizationPreviewRequestError(
      'Cartonization preview request is too large',
      413,
      'CARTONIZATION_PREVIEW_REQUEST_TOO_LARGE',
    )
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new CartonizationPreviewRequestError(
      'Request body must be valid JSON',
      400,
      'CARTONIZATION_PREVIEW_REQUEST_INVALID',
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json(
      { ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' },
      401,
    )
  }
  if (
    error instanceof CartonizationPreviewRequestError
    || error instanceof CartonizationPreviewPersistenceError
  ) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
    )
  }
  const sanitized = sanitizedCommerceIntegrationError(error)
  return json(
    { ok: false, error: sanitized.message, code: sanitized.code },
    sanitized.status,
  )
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePreviewAccess(actor)
    requirePostgres()
    assertCommerceIntakeRuntime()
    const request = normalizeCartonizationPreviewRequest(
      await requestBody(req),
    )
    const snapshot = await readCartonizationPreviewSnapshotFromPostgres({
      organizationId: organizationId(actor),
      request,
    })
    let optimizer = null
    try {
      optimizer = configuredOrToolsFulfillmentOptimizer()
    } catch {
      // The domain returns a structured configuration blocker.
    }
    const preview = await createCartonizationPreview({
      request,
      snapshot,
      optimizer,
      options: {
        deadlineMs: 10_000,
        maxCandidates: 8,
      },
    })
    return json({ ok: true, preview })
  } catch (error) {
    return errorResponse(error)
  }
}
