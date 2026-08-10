import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  createAndPlanOneOffShipmentInPostgres,
  OneOffShipmentPersistenceError,
  quoteOneOffShipmentInPostgres,
  readOneOffShipmentWorkspaceFromPostgres,
} from '@/lib/persistence/oneOffShipments'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 256 * 1024

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function errorResponse(error: unknown) {
  if (error instanceof OneOffShipmentPersistenceError) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
    }, error.status)
  }
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'OPERATIONS_ONE_OFF_REQUEST_FAILED'
  const status = code === 'OPERATIONS_ONE_OFF_REQUEST_FAILED' ? 500 : 400
  if (status === 500) {
    console.error('[operations-one-off-shipments] request failure', {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
  return json({
    ok: false,
    error: status === 500 ? 'One-off shipment request failed' : code,
    code,
  }, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'One-off shipments require Postgres storage',
      503,
    )
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const bodyText = await req.text()
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_REQUEST_BYTES) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_TOO_LARGE',
      'One-off shipment request is too large',
      413,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'One-off shipment request must be valid JSON',
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_REQUEST_INVALID',
      'One-off shipment request is invalid',
    )
  }
  return parsed as Record<string, unknown>
}

function idempotencyKey(req: NextRequest) {
  return String(req.headers.get('idempotency-key') || '').trim()
}

function forbidden(message: string, code: string) {
  return json({ ok: false, error: message, code }, 403)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage || !capabilities.canExecute) {
      return forbidden(
        'You need Operations management and warehouse execution permission to use one-off shipments',
        'OPERATIONS_ONE_OFF_PERMISSION_REQUIRED',
      )
    }
    const workspace = await readOneOffShipmentWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
    })
    return json({ ok: true, workspace })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage || !capabilities.canExecute) {
      return forbidden(
        'You need Operations management and warehouse execution permission to use one-off shipments',
        'OPERATIONS_ONE_OFF_PERMISSION_REQUIRED',
      )
    }
    const body = await requestBody(req)
    const action = String(body.action || '').trim()
    const organizationId = activeOperationsOrganizationId(actor)
    if (action === 'quote') {
      const unsupported = Object.keys(body).find((key) => !['action', 'quote'].includes(key))
      if (unsupported || !('quote' in body)) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'One-off quote command is invalid',
        )
      }
      const quote = await quoteOneOffShipmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        quote: body.quote,
      })
      return json({ ok: true, quote }, 201)
    }
    if (action === 'create-and-plan') {
      const unsupported = Object.keys(body).find((key) => ![
        'action', 'quoteGlobalId', 'selectedOfferGlobalId', 'reason',
      ].includes(key))
      if (unsupported) {
        throw new OneOffShipmentPersistenceError(
          'OPERATIONS_ONE_OFF_REQUEST_INVALID',
          'One-off create-and-plan command is invalid',
        )
      }
      const result = await createAndPlanOneOffShipmentInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKey(req),
        quoteGlobalId: String(body.quoteGlobalId || ''),
        selectedOfferGlobalId: String(body.selectedOfferGlobalId || ''),
        reason: String(body.reason || ''),
      })
      return json({ ok: true, result }, result.replayed ? 200 : 201)
    }
    throw new OneOffShipmentPersistenceError(
      'OPERATIONS_ONE_OFF_ACTION_INVALID',
      'One-off shipment action is invalid',
    )
  } catch (error) {
    return errorResponse(error)
  }
}
