import { NextRequest, NextResponse } from 'next/server'
import { accountingCapabilities, activeAccountingOrganizationId } from '@/lib/accountingAuthorization'
import {
  refreshToastMenuCatalog,
  sanitizedToastIntegrationError,
  ToastIntegrationRequestError,
} from '@/lib/integrations/toastIntegrations'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { readPosCatalogFromPostgres } from '@/lib/persistence/posCatalog'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new ToastIntegrationRequestError(
      'POS catalog ingestion requires Postgres storage',
      503,
      'POS_CATALOG_POSTGRES_REQUIRED',
    )
  }
}

async function requestBody(req: NextRequest) {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new ToastIntegrationRequestError(
      'POS catalog refresh requests require JSON',
      415,
      'POS_CATALOG_CONTENT_TYPE_INVALID',
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ToastIntegrationRequestError(
      'POS catalog refresh request exceeded the supported size',
      413,
      'POS_CATALOG_REQUEST_TOO_LARGE',
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    throw new ToastIntegrationRequestError(
      'POS catalog refresh request exceeded the supported size',
      413,
      'POS_CATALOG_REQUEST_TOO_LARGE',
    )
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    const body = parsed as Record<string, unknown>
    const unsupported = Object.keys(body).find((field) => field !== 'force')
    if (unsupported || (body.force !== undefined && typeof body.force !== 'boolean')) {
      throw new Error('invalid')
    }
    return { force: body.force === true }
  } catch {
    throw new ToastIntegrationRequestError(
      'A valid POS catalog refresh request is required',
      400,
      'POS_CATALOG_REQUEST_INVALID',
    )
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  const sanitized = sanitizedToastIntegrationError(error)
  return json({ ok: false, error: sanitized.message, code: sanitized.code }, sanitized.status)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to POS catalog data',
        code: 'POS_CATALOG_VIEW_REQUIRED',
      }, 403)
    }
    const catalog = await readPosCatalogFromPostgres(activeAccountingOrganizationId(actor))
    return json({ ok: true, capabilities, catalog })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    requirePostgres()
    const capabilities = accountingCapabilities(actor)
    if (!capabilities.canManage) {
      return json({
        ok: false,
        error: 'You do not have permission to manage the POS catalog',
        code: 'POS_CATALOG_MANAGE_REQUIRED',
      }, 403)
    }
    const organizationId = activeAccountingOrganizationId(actor)
    const body = await requestBody(req)
    const result = await refreshToastMenuCatalog({
      organizationId,
      actorEmail: actor.email,
      force: body.force,
    })
    return json({ ok: true, capabilities, ...result })
  } catch (error) {
    return errorResponse(error)
  }
}
