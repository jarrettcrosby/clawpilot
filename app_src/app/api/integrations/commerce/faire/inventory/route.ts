import { NextRequest, NextResponse } from 'next/server'
import {
  normalizeCommerceAccountGlobalId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  assertCommerceReadRuntime,
} from '@/lib/integrations/commerceIntake'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import { integrationCredentialRuntimeMaintenanceResponse } from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { operationsCapabilities } from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readFaireInventoryPollStateFromPostgres,
  recoverFaireInventoryPollInPostgres,
} from '@/lib/persistence/faireInventoryPolling'
import { requireRequestUser } from '@/lib/requestUser'
import type { AppUser } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function responseError(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
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

function organizationId(user: AppUser) {
  if (!user.organizationId) {
    throw new CommerceIntegrationRequestError(
      'Your organization is not configured',
      409,
      'COMMERCE_ORGANIZATION_REQUIRED',
    )
  }
  return user.organizationId
}

async function actor(req: NextRequest) {
  const user = await requireRequestUser(req)
  assertCommerceReadRuntime()
  if (!isPostgresStorageEnabled()) {
    throw new CommerceIntegrationRequestError(
      'Faire inventory observation requires Postgres storage',
      503,
      'FAIRE_INVENTORY_POSTGRES_REQUIRED',
    )
  }
  if (!operationsCapabilities(user).canManage) {
    throw new CommerceIntegrationRequestError(
      'Operations-management permission is required for Faire inventory recovery',
      403,
      'FAIRE_INVENTORY_MANAGER_REQUIRED',
    )
  }
  return user
}

async function requestBody(req: NextRequest) {
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Faire inventory recovery request is too large',
      413,
      'FAIRE_INVENTORY_REQUEST_TOO_LARGE',
    )
  }
  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new CommerceIntegrationRequestError(
      'Faire inventory recovery request is too large',
      413,
      'FAIRE_INVENTORY_REQUEST_TOO_LARGE',
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
      'Faire inventory recovery request must be a JSON object',
      400,
      'FAIRE_INVENTORY_REQUEST_INVALID',
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await actor(req)
    const accountGlobalId = normalizeCommerceAccountGlobalId(
      req.nextUrl.searchParams.get('accountGlobalId'),
    )
    const inventory = await readFaireInventoryPollStateFromPostgres({
      organizationId: organizationId(user),
      accountGlobalId,
    })
    if (!inventory) {
      throw new CommerceIntegrationRequestError(
        'A configured Faire sales channel is required',
        404,
        'FAIRE_INVENTORY_ACCOUNT_REQUIRED',
      )
    }
    return json({ ok: true, inventory })
  } catch (error) {
    return responseError(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await actor(req)
    const body = await requestBody(req)
    if (
      body.action !== 'recover'
      || body.confirmReviewedRecovery !== true
    ) {
      throw new CommerceIntegrationRequestError(
        'Confirm reviewed Faire inventory recovery before continuing',
        400,
        'FAIRE_INVENTORY_RECOVERY_CONFIRMATION_REQUIRED',
      )
    }
    const recovery = await recoverFaireInventoryPollInPostgres({
      organizationId: organizationId(user),
      accountGlobalId: normalizeCommerceAccountGlobalId(
        body.accountGlobalId,
      ),
      failedJobId: String(body.failedJobId || ''),
      expectedCredentialVersion: Number(body.expectedCredentialVersion),
      expectedErrorCode: String(body.expectedErrorCode || ''),
      reason: String(body.reason || ''),
      actorEmail: user.email,
    })
    return json({ ok: true, recovery })
  } catch (error) {
    return responseError(error)
  }
}
