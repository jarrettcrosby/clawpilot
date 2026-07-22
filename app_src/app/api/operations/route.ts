import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import type {
  Address,
  MockOperationsProofInput,
  OperationsActivationState,
  OperationsExceptionStatus,
  OperationsOrderStatus,
} from '@/lib/operations/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  OperationsRequestError,
  readOperationsWorkspaceFromPostgres,
  runMockOperationsProofFromPostgres,
  updateOperationsActivationInPostgres,
  updateOperationsExceptionInPostgres,
} from '@/lib/persistence/operations'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 8 * 1024
const CUSTOMER_GLOBAL_ID = /^ga\d{7}$/
const PRODUCT_GLOBAL_ID = /^gp\d{7}$/
const ORDER_GLOBAL_ID = /^gor\d{7}$/
const EXCEPTION_GLOBAL_ID = /^gex\d{7}$/
const ORDER_STATUSES = new Set<OperationsOrderStatus>([
  'imported', 'validated', 'held', 'promised', 'reserved', 'planned',
  'released', 'picking', 'packed', 'shipped', 'cancelled', 'exception',
])
const EXCEPTION_STATUSES = new Set<OperationsExceptionStatus>([
  'open', 'acknowledged', 'resolved', 'dismissed',
])
const ACTIVATION_STATES = new Set<OperationsActivationState>([
  'disabled', 'shadow', 'read_only', 'active', 'frozen',
])
const PROOF_FIELDS = new Set([
  'customerGlobalId', 'productGlobalId', 'externalOrderId', 'orderNumber',
  'quantity', 'openingQuantity', 'requestedDeliveryAt', 'shipTo',
])
const ADDRESS_FIELDS = new Set(['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'])

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new OperationsRequestError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError('OPERATIONS_POSTGRES_REQUIRED', 'Operations requires Postgres storage', 503)
  }
}

function record(value: unknown, code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) requestError(code, `${label} is invalid`)
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: Set<string>, code: string, label: string) {
  const unsupported = Object.keys(value).find((field) => !allowed.has(field))
  if (unsupported) requestError(code, `${label} includes an unsupported field`)
}

function textValue(value: unknown, label: string, max: number, required = true): string {
  const text = String(value ?? '').trim()
  if ((!text && required) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

function globalIdValue(value: unknown, label: string, pattern: RegExp): string {
  const globalId = textValue(value, label, 16)
  if (!pattern.test(globalId)) requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  return globalId
}

function requestedDeliveryValue(value: unknown): string {
  const raw = textValue(value, 'Requested delivery date', 50)
  const date = new Date(raw)
  const now = Date.now()
  if (Number.isNaN(date.getTime()) || date.getTime() < now - 60_000 || date.getTime() > now + 366 * 24 * 60 * 60 * 1000) {
    requestError('OPERATIONS_REQUEST_INVALID', 'Requested delivery date must be within the next year')
  }
  return date.toISOString()
}

function addressValue(value: unknown): Address {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  assertFields(input, ADDRESS_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Ship-to address')
  const country = textValue(input.country, 'Ship-to country', 2).toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) requestError('OPERATIONS_REQUEST_INVALID', 'Ship-to country is invalid')
  return {
    name: textValue(input.name, 'Ship-to name', 120),
    line1: textValue(input.line1, 'Ship-to address', 160),
    line2: textValue(input.line2, 'Ship-to address line 2', 160, false) || undefined,
    city: textValue(input.city, 'Ship-to city', 100),
    region: textValue(input.region, 'Ship-to region', 100),
    postalCode: textValue(input.postalCode, 'Ship-to postal code', 30),
    country,
  }
}

function proofValue(value: unknown): MockOperationsProofInput {
  const input = record(value, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  assertFields(input, PROOF_FIELDS, 'OPERATIONS_REQUEST_INVALID', 'Proof order')
  return {
    customerGlobalId: globalIdValue(input.customerGlobalId, 'CRM customer', CUSTOMER_GLOBAL_ID),
    productGlobalId: globalIdValue(input.productGlobalId, 'CRM product', PRODUCT_GLOBAL_ID),
    externalOrderId: textValue(input.externalOrderId, 'External order ID', 120),
    orderNumber: textValue(input.orderNumber, 'Order number', 100),
    quantity: integerValue(input.quantity, 'Quantity', 1, 1_000),
    openingQuantity: integerValue(input.openingQuantity, 'Opening inventory', 1, 100_000),
    requestedDeliveryAt: requestedDeliveryValue(input.requestedDeliveryAt),
    shipTo: addressValue(input.shipTo),
  }
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (!String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    requestError('OPERATIONS_CONTENT_TYPE_INVALID', 'Operations commands require JSON', 415)
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError('OPERATIONS_REQUEST_TOO_LARGE', 'Operations command exceeded the supported size', 413)
  }
  try {
    return record(JSON.parse(raw) as unknown, 'OPERATIONS_REQUEST_INVALID', 'Operations command')
  } catch (error) {
    if (error instanceof OperationsRequestError) throw error
    requestError('OPERATIONS_REQUEST_INVALID', 'A valid operations command is required')
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({ ok: false, error: 'Select an active organization first', code: error.message }, 409)
  }
  if (error instanceof OperationsRequestError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status)
  }
  const code = error instanceof Error && /^OPERATIONS_[A-Z_]+$/.test(error.message)
    ? error.message
    : 'OPERATIONS_REQUEST_FAILED'
  const status = code === 'OPERATIONS_REQUEST_FAILED' ? 500 : 400
  return json({ ok: false, error: status === 500 ? 'Operations request failed' : code, code }, status)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return json({
        ok: false,
        error: 'Your organization administrator has not granted access to operations data',
        code: 'OPERATIONS_VIEW_REQUIRED',
      }, 403)
    }
    const statusValue = String(req.nextUrl.searchParams.get('status') || '').trim()
    if (statusValue && !ORDER_STATUSES.has(statusValue as OperationsOrderStatus)) {
      requestError('OPERATIONS_STATUS_INVALID', 'Order status is invalid')
    }
    const exceptionStatusValue = String(req.nextUrl.searchParams.get('exceptionStatus') || '').trim()
    if (exceptionStatusValue && !EXCEPTION_STATUSES.has(exceptionStatusValue as OperationsExceptionStatus)) {
      requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
    }
    const selectedValue = String(req.nextUrl.searchParams.get('order') || '').trim()
    if (selectedValue && !ORDER_GLOBAL_ID.test(selectedValue)) {
      requestError('OPERATIONS_ORDER_INVALID', 'Order is invalid')
    }
    const search = String(req.nextUrl.searchParams.get('search') || '').trim()
    if (search.length > 100 || /[\u0000-\u001f\u007f]/.test(search)) {
      requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
    }
    const operations = await readOperationsWorkspaceFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      capabilities,
      search,
      status: statusValue || null,
      exceptionStatus: (exceptionStatusValue as OperationsExceptionStatus) || null,
      selectedOrderGlobalId: selectedValue || null,
    })
    return json({ ok: true, operations })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    const body = await requestBody(req)
    const action = textValue(body.action, 'Operations action', 50)
    if (action === 'run-proof-order') {
      if (!capabilities.canManage || !capabilities.canExecute) {
        return json({
          ok: false,
          error: 'You do not have permission to prepare and execute warehouse operations',
          code: 'OPERATIONS_EXECUTE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'proof']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const result = await runMockOperationsProofFromPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        proof: proofValue(body.proof),
      })
      return json({ ok: true, capabilities, result }, result.duplicate ? 200 : 201)
    }
    if (action === 'update-exception') {
      if (!capabilities.canManage) {
        return json({
          ok: false,
          error: 'You do not have permission to manage operations exceptions',
          code: 'OPERATIONS_MANAGE_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'exceptionGlobalId', 'status']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const status = textValue(body.status, 'Exception status', 20) as OperationsExceptionStatus
      if (!EXCEPTION_STATUSES.has(status)) {
        requestError('OPERATIONS_EXCEPTION_STATUS_INVALID', 'Exception status is invalid')
      }
      const result = await updateOperationsExceptionInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        exceptionGlobalId: globalIdValue(body.exceptionGlobalId, 'Operations exception', EXCEPTION_GLOBAL_ID),
        status,
      })
      return json({ ok: true, capabilities, result })
    }
    if (action === 'update-activation') {
      if (!capabilities.canActivate) {
        return json({
          ok: false,
          error: 'Only an organization owner or authorized administrator may change Operations activation',
          code: 'OPERATIONS_ACTIVATION_REQUIRED',
        }, 403)
      }
      assertFields(body, new Set(['action', 'state', 'reason']), 'OPERATIONS_REQUEST_INVALID', 'Operations command')
      const state = textValue(body.state, 'Activation state', 20) as OperationsActivationState
      if (!ACTIVATION_STATES.has(state)) {
        requestError('OPERATIONS_ACTIVATION_STATE_INVALID', 'Operations activation state is invalid')
      }
      const result = await updateOperationsActivationInPostgres({
        organizationId: activeOperationsOrganizationId(actor),
        actorEmail: actor.email,
        state,
        reason: textValue(body.reason, 'Activation reason', 500, false) || null,
      })
      return json({ ok: true, capabilities, result })
    }
    requestError('OPERATIONS_ACTION_INVALID', 'Operations action is invalid')
  } catch (error) {
    return errorResponse(error)
  }
}
