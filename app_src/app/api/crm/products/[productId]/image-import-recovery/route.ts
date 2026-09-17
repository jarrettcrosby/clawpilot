import { NextRequest, NextResponse } from 'next/server'
import { isBrowserSameOriginRequest } from '@/lib/browserSameOrigin'
import { commerceReadRuntimeAvailable } from '@/lib/integrations/commerceIntake'
import { integrationCredentialRuntimeMaintenanceResponse } from '@/lib/integrations/integrationCredentialRuntimeHttp'
import {
  CommerceProductImageImportError,
  listDeadCommerceProductImageImportRecoveriesInPostgres,
  retryDeadCommerceProductImageImportJobInPostgres,
} from '@/lib/persistence/commerceProductImageImports'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import { appPublicUrl } from '@/lib/publicUrl'
import { requestSession, requireRequestUser } from '@/lib/requestUser'
import { effectiveAuthorizationRole } from '@/lib/users'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_BYTES = 4096
type Context = { params: Promise<{ productId: string }> }

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: {
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Origin',
  } })
}
function fail(code: string, message: string, status = 400): never {
  throw new CommerceProductImageImportError(code, message, status)
}
function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof CommerceProductImageImportError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized' }, 401)
  }
  return json({ ok: false, error: 'Image import recovery is unavailable' }, 500)
}

async function manager(req: NextRequest, context: Context) {
  if ((await requestSession(req))?.impersonating) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_IMPERSONATION_FORBIDDEN',
      'Exit user view before reviewing image recovery', 403)
  }
  const actor = await requireRequestUser(req)
  const role = effectiveAuthorizationRole(actor)
  if ((role !== 'owner' && role !== 'admin')
    || actor.permissions.manageOperations !== true || !actor.organizationId) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_FORBIDDEN',
      'Active organization manager permission is required', 403)
  }
  if (!isPostgresStorageEnabled() || !commerceReadRuntimeAvailable()) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_UNAVAILABLE',
      'Image import recovery requires enabled commerce reconciliation and Postgres', 503)
  }
  const productId = String((await context.params).productId || '').trim().toLowerCase()
  if (!UUID.test(productId)) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_PRODUCT_NOT_FOUND', 'Product is invalid', 404)
  }
  return { organizationId: actor.organizationId, productId, actorEmail: actor.email }
}

async function boundedJson(req: NextRequest) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get('content-type') || '')) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_CONTENT_TYPE', 'A JSON command is required', 415)
  }
  const length = req.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_TOO_LARGE', 'Retry command is too large', 413)
  }
  if (!req.body) fail('COMMERCE_PRODUCT_IMAGE_RETRY_COMMAND_INVALID', 'A command is required')
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      fail('COMMERCE_PRODUCT_IMAGE_RETRY_TOO_LARGE', 'Retry command is too large', 413)
    }
    chunks.push(part.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { fail('COMMERCE_PRODUCT_IMAGE_RETRY_COMMAND_INVALID', 'A valid UTF-8 JSON command is required') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('COMMERCE_PRODUCT_IMAGE_RETRY_COMMAND_INVALID', 'A JSON object is required')
  }
  return body as Record<string, unknown>
}

export async function GET(req: NextRequest, context: Context) {
  try {
    const target = await manager(req, context)
    return json({ ok: true, ...await listDeadCommerceProductImageImportRecoveriesInPostgres(target) })
  } catch (error) { return errorResponse(error) }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    if (!isBrowserSameOriginRequest({ headers: req.headers,
      requestOrigin: req.nextUrl.origin, trustedOrigins: [appPublicUrl()] })) {
      fail('COMMERCE_PRODUCT_IMAGE_RETRY_SAME_ORIGIN_REQUIRED',
        'Image recovery requires a same-origin browser request', 403)
    }
    const target = await manager(req, context)
    const body = await boundedJson(req)
    const allowed = ['jobId', 'expectedJobGeneration', 'expectedErrorCode',
      'reason', 'confirmInboundOnly', 'idempotencyKey']
    if (Object.keys(body).some((field) => !allowed.includes(field))
      || typeof body.jobId !== 'string' || !UUID.test(body.jobId)
      || typeof body.expectedJobGeneration !== 'number'
      || !Number.isSafeInteger(body.expectedJobGeneration) || body.expectedJobGeneration < 1
      || typeof body.expectedErrorCode !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(body.expectedErrorCode)
      || typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.trim().length > 500
      || body.confirmInboundOnly !== true
      || typeof body.idempotencyKey !== 'string' || !UUID.test(body.idempotencyKey)) {
      fail('COMMERCE_PRODUCT_IMAGE_RETRY_COMMAND_INVALID',
        'Review the failed image, confirm inbound-only recovery and provide a 10–500 character reason')
    }
    const recovery = await retryDeadCommerceProductImageImportJobInPostgres({
      ...target, jobId: body.jobId, expectedJobGeneration: body.expectedJobGeneration,
      expectedErrorCode: body.expectedErrorCode, reason: body.reason.trim(),
      confirmInboundOnly: body.confirmInboundOnly, idempotencyKey: body.idempotencyKey,
    })
    return json({ ok: true, recovery })
  } catch (error) { return errorResponse(error) }
}
