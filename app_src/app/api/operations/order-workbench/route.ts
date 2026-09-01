import { NextRequest, NextResponse } from 'next/server'
import { refreshCommerceOrderWorkbenchCandidate } from '@/lib/integrations/commerceIntake'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  derivedOrderWorkbenchIdempotencyKey,
} from '@/lib/operations/orderWorkbenchIdempotency'
import {
  ORDER_SHIP_TO_FIELDS,
  type OrderShipToField,
  type OrderShipToPatch,
} from '@/lib/operations/orderShipTo'
import type {
  OperationsImportedOrderResolutionDraft,
} from '@/lib/operations/types'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  acceptCommerceOrderWorkbenchInPostgres,
  CommerceOrderWorkbenchError,
  readCommerceOrderWorkbenchRefreshTargetFromPostgres,
  readCommerceOrderWorkbenchFromPostgres,
  readCommerceOrderWorkbenchPageFromPostgres,
  rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres,
  updateCommerceOrderWorkbenchShipToInPostgres,
  type CommerceOrderWorkbenchLineRefreshResolution,
  type CommerceOrderWorkbenchRefreshResolution,
} from '@/lib/persistence/commerceOrderWorkbench'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_REQUEST_BYTES = 64 * 1024
const CANDIDATE_GLOBAL_ID = /^gcoc(?:[0-9]{7}|[0-9a-v]{12})$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const CUSTOMER_GLOBAL_ID = /^ga(?:[0-9]{7}|[0-9a-v]{12})$/u
const LINE_GLOBAL_ID = /^gcol(?:[0-9]{7}|[0-9a-v]{12})$/u
const PRODUCT_GLOBAL_ID = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/u
const PACKAGE_PROFILE_GLOBAL_ID = /^gpp(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAX_PAGE_SIZE = 250
const SHIP_TO_FIELDS = new Set<string>(ORDER_SHIP_TO_FIELDS)
const REFRESH_FIELDS = new Set<string>([
  ...ORDER_SHIP_TO_FIELDS,
  'requestedDeliveryAt',
])
const SHIP_TO_LIMITS: Record<OrderShipToField, number> = {
  name: 120,
  line1: 160,
  line2: 160,
  city: 100,
  region: 100,
  postalCode: 30,
  country: 64,
}

class CommerceOrderWorkbenchApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CommerceOrderWorkbenchApiError'
    this.code = code
    this.status = status
  }
}

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new CommerceOrderWorkbenchApiError(code, message, status)
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'OPERATIONS_POSTGRES_REQUIRED',
      'Operations requires Postgres storage',
      503,
    )
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError('OPERATIONS_REQUEST_INVALID', `${label} is invalid`)
  }
  return value as Record<string, unknown>
}

function assertFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    requestError(
      'OPERATIONS_REQUEST_INVALID',
      `${label} includes an unsupported field`,
    )
  }
}

function candidateGlobalIdValue(value: unknown) {
  const candidateGlobalId = String(value || '').trim()
  if (!CANDIDATE_GLOBAL_ID.test(candidateGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_INVALID',
      'Imported order is invalid',
    )
  }
  return candidateGlobalId
}

function rowVersionValue(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_VERSION_INVALID',
      'Imported order version is invalid',
    )
  }
  return Number(value)
}

function idempotencyKeyValue(req: NextRequest) {
  const value = req.headers.get('idempotency-key')
  if (!value || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'OPERATIONS_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

function shipToPatchValue(value: unknown): OrderShipToPatch {
  const input = record(value, 'Ship-to changes')
  assertFields(input, SHIP_TO_FIELDS, 'Ship-to changes')
  if (!Object.keys(input).length) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_EDIT_EMPTY',
      'Choose at least one ship-to field to update',
    )
  }
  const changes: OrderShipToPatch = {}
  for (const field of ORDER_SHIP_TO_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const raw = input[field]
    if (raw === null) {
      changes[field] = null
      continue
    }
    if (
      typeof raw !== 'string'
      || raw.length > SHIP_TO_LIMITS[field]
      || /[\u0000-\u001f\u007f]/u.test(raw)
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_SHIP_TO_INVALID',
        `Ship-to ${field} is invalid`,
      )
    }
    changes[field] = raw
  }
  return changes
}

function resolutionDraftValue(
  value: unknown,
): OperationsImportedOrderResolutionDraft {
  if (value === undefined) {
    return { customerGlobalId: null, requestedDeliveryAt: null, lines: [] }
  }
  const input = record(value, 'Order details')
  assertFields(
    input,
    new Set(['customerGlobalId', 'requestedDeliveryAt', 'lines']),
    'Order details',
  )
  const customerGlobalId = input.customerGlobalId === null
    ? null
    : String(input.customerGlobalId || '').trim()
  if (customerGlobalId && !CUSTOMER_GLOBAL_ID.test(customerGlobalId)) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_CUSTOMER_INVALID',
      'Select an active customer',
    )
  }
  let requestedDeliveryAt: string | null = null
  if (
    input.requestedDeliveryAt !== null
    && input.requestedDeliveryAt !== undefined
  ) {
    if (typeof input.requestedDeliveryAt !== 'string') {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_DELIVERY_INVALID',
        'Requested delivery date is invalid',
      )
    }
    const parsed = new Date(input.requestedDeliveryAt)
    if (Number.isNaN(parsed.getTime())) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_DELIVERY_INVALID',
        'Requested delivery date is invalid',
      )
    }
    requestedDeliveryAt = parsed.toISOString()
  }
  const rawLines = input.lines === undefined ? [] : input.lines
  if (!Array.isArray(rawLines) || rawLines.length > 250) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_LINES_INVALID',
      'Order lines are invalid',
    )
  }
  const seen = new Set<string>()
  const lines = rawLines.map((value) => {
    const line = record(value, 'Order line')
    assertFields(
      line,
      new Set([
        'lineGlobalId',
        'productGlobalId',
        'unitPriceMinor',
        'currency',
        'packageProfileGlobalId',
      ]),
      'Order line',
    )
    const lineGlobalId = String(line.lineGlobalId || '').trim()
    const productGlobalId = String(line.productGlobalId || '').trim()
    const currency = String(line.currency || '').trim().toUpperCase()
    const packageProfileGlobalId = line.packageProfileGlobalId === null
      ? null
      : String(line.packageProfileGlobalId || '').trim()
    if (
      !LINE_GLOBAL_ID.test(lineGlobalId)
      || seen.has(lineGlobalId)
      || !PRODUCT_GLOBAL_ID.test(productGlobalId)
      || (
        line.unitPriceMinor !== null
        && (
          !Number.isSafeInteger(line.unitPriceMinor)
          || Number(line.unitPriceMinor) < 0
          || Number(line.unitPriceMinor) > 9_000_000_000_000
        )
      )
      || !/^[A-Z]{3}$/u.test(currency)
      || (
        packageProfileGlobalId
        && !PACKAGE_PROFILE_GLOBAL_ID.test(packageProfileGlobalId)
      )
    ) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_LINE_INVALID',
        'Complete each selected line with a real product and valid unit price',
      )
    }
    seen.add(lineGlobalId)
    return {
      lineGlobalId,
      productGlobalId,
      unitPriceMinor: line.unitPriceMinor === null
        ? null
        : Number(line.unitPriceMinor),
      currency,
      packageProfileGlobalId,
    }
  })
  return { customerGlobalId, requestedDeliveryAt, lines }
}

function refreshResolutionsValue(
  value: unknown,
): CommerceOrderWorkbenchRefreshResolution {
  if (value === undefined || value === null) return {}
  const input = record(value, 'Refresh choices')
  assertFields(input, REFRESH_FIELDS, 'Refresh choices')
  const resolutions: CommerceOrderWorkbenchRefreshResolution = {}
  for (const field of REFRESH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    if (!['local', 'provider'].includes(String(input[field] || ''))) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
        'Choose whether to keep the local or provider value',
      )
    }
    resolutions[field as keyof CommerceOrderWorkbenchRefreshResolution] =
      input[field] as 'local' | 'provider'
  }
  return resolutions
}

function lineRefreshResolutionsValue(
  value: unknown,
): CommerceOrderWorkbenchLineRefreshResolution {
  if (value === undefined || value === null) return {}
  const input = record(value, 'Refreshed item choices')
  if (Object.keys(input).length > 250) {
    requestError(
      'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
      'Too many refreshed item choices were supplied',
    )
  }
  const resolutions: CommerceOrderWorkbenchLineRefreshResolution = {}
  for (const [lineGlobalId, resolution] of Object.entries(input)) {
    if (!LINE_GLOBAL_ID.test(lineGlobalId) || resolution !== 'provider') {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
        'Choose the refreshed provider item for each changed saved item match',
      )
    }
    resolutions[lineGlobalId] = 'provider'
  }
  return resolutions
}

async function requestBody(req: NextRequest) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestError(
      'OPERATIONS_CONTENT_TYPE_INVALID',
      'Order edits require JSON',
      415,
    )
  }
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Order edit exceeded the supported size',
      413,
    )
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
    requestError(
      'OPERATIONS_REQUEST_TOO_LARGE',
      'Order edit exceeded the supported size',
      413,
    )
  }
  try {
    return record(JSON.parse(raw) as unknown, 'Order edit')
  } catch (error) {
    if (error instanceof CommerceOrderWorkbenchApiError) throw error
    requestError('OPERATIONS_REQUEST_INVALID', 'A valid order edit is required')
  }
}

function errorResponse(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return response({
      ok: false,
      code: 'UNAUTHORIZED',
      error: 'Unauthorized',
    }, 401)
  }
  if (
    error instanceof CommerceOrderWorkbenchApiError
    || error instanceof CommerceOrderWorkbenchError
  ) {
    return response({
      ok: false,
      code: error.code,
      error: error.message,
      ...(error instanceof CommerceOrderWorkbenchError && error.details
        ? error.details
        : {}),
    }, error.status)
  }
  if (error instanceof CommerceIntegrationRequestError) {
    const commerceError = sanitizedCommerceIntegrationError(error)
    return response({
      ok: false,
      code: commerceError.code,
      error: commerceError.message,
    }, commerceError.status)
  }
  console.error('[operations-order-workbench] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return response({
    ok: false,
    code: 'OPERATIONS_IMPORTED_ORDER_REQUEST_FAILED',
    error: 'Imported order could not be loaded or saved',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canView) {
      return response({
        ok: false,
        code: 'OPERATIONS_VIEW_REQUIRED',
        error: 'You do not have permission to view Operations orders',
      }, 403)
    }
    const search = String(req.nextUrl.searchParams.get('search') || '').trim()
    if (search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search)) {
      requestError('OPERATIONS_SEARCH_INVALID', 'Order search is invalid')
    }
    const candidateValue = String(
      req.nextUrl.searchParams.get('candidate') || '',
    ).trim()
    const cursor = String(
      req.nextUrl.searchParams.get('cursor') || '',
    ).trim()
    const limitValue = String(
      req.nextUrl.searchParams.get('limit') || MAX_PAGE_SIZE,
    ).trim()
    if (!/^\d{1,3}$/u.test(limitValue)) {
      requestError('OPERATIONS_PAGE_SIZE_INVALID', 'Order page size is invalid')
    }
    const pageSize = Number(limitValue)
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      requestError('OPERATIONS_PAGE_SIZE_INVALID', 'Order page size is invalid')
    }
    if (candidateValue && cursor) {
      requestError(
        'OPERATIONS_PAGE_CURSOR_INVALID',
        'A single-order read cannot use an order-page cursor',
      )
    }
    const result = await readCommerceOrderWorkbenchPageFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      search,
      candidateGlobalId: candidateValue
        ? candidateGlobalIdValue(candidateValue)
        : null,
      includeResolutionDetails: Boolean(candidateValue),
      cursor: cursor || null,
      pageSize: candidateValue ? 1 : pageSize,
    })
    return response({ ok: true, orders: result.orders, page: result.page })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'You do not have permission to edit Operations orders',
      }, 403)
    }
    const body = await requestBody(req)
    assertFields(
      body,
      new Set([
        'candidateGlobalId',
        'expectedRowVersion',
        'shipTo',
        'resolution',
      ]),
      'Order edit',
    )
    const candidateGlobalId = candidateGlobalIdValue(body.candidateGlobalId)
    const result = await updateCommerceOrderWorkbenchShipToInPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      actorEmail: actor.email,
      idempotencyKey: idempotencyKeyValue(req),
      candidateGlobalId,
      expectedRowVersion: rowVersionValue(body.expectedRowVersion),
      changes: shipToPatchValue(body.shipTo),
      resolutionDraft: resolutionDraftValue(body.resolution),
    })
    const [order] = await readCommerceOrderWorkbenchFromPostgres({
      organizationId: activeOperationsOrganizationId(actor),
      candidateGlobalId,
      includeResolutionDetails: true,
    })
    return response({ ok: true, result, order: order || null })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(req: NextRequest) {
  try {
    requirePostgres()
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'You do not have permission to refresh Operations orders',
      }, 403)
    }
    const organizationId = activeOperationsOrganizationId(actor)
    const body = await requestBody(req)
    if (body.action === 'accept') {
      assertFields(
        body,
        new Set(['action', 'candidateGlobalId', 'expectedRowVersion']),
        'Order import',
      )
      const candidateGlobalId = candidateGlobalIdValue(body.candidateGlobalId)
      const result = await acceptCommerceOrderWorkbenchInPostgres({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey: idempotencyKeyValue(req),
        candidateGlobalId,
        expectedRowVersion: rowVersionValue(body.expectedRowVersion),
      })
      const [order] = await readCommerceOrderWorkbenchFromPostgres({
        organizationId,
        candidateGlobalId,
        includeResolutionDetails: true,
      })
      return response({ ok: true, result, order: order || null })
    }
    assertFields(
      body,
      new Set([
        'action',
        'candidateGlobalId',
        'expectedRowVersion',
        'latestCandidateGlobalId',
        'resolutions',
        'lineResolutions',
      ]),
      'Order refresh',
    )
    if (body.action !== 'refresh') {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_INVALID',
        'Order refresh action is invalid',
      )
    }
    const candidateGlobalId = candidateGlobalIdValue(body.candidateGlobalId)
    const expectedRowVersion = rowVersionValue(body.expectedRowVersion)
    const resolutions = refreshResolutionsValue(body.resolutions)
    const lineResolutions = lineRefreshResolutionsValue(body.lineResolutions)
    const resolvingConflict = Object.keys(resolutions).length > 0
      || Object.keys(lineResolutions).length > 0
    const latestCandidateGlobalId = body.latestCandidateGlobalId === undefined
      || body.latestCandidateGlobalId === null
      ? null
      : candidateGlobalIdValue(body.latestCandidateGlobalId)
    if (resolvingConflict && !latestCandidateGlobalId) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESOLUTION_INVALID',
        'Reload the provider conflict before choosing values',
      )
    }
    const requestKey = idempotencyKeyValue(req)
    if (!resolvingConflict) {
      const target = await readCommerceOrderWorkbenchRefreshTargetFromPostgres({
        organizationId,
        candidateGlobalId,
      })
      await refreshCommerceOrderWorkbenchCandidate({
        organizationId,
        accountGlobalId: target.accountGlobalId,
        actorEmail: actor.email,
        idempotencyKey: derivedOrderWorkbenchIdempotencyKey({
          organizationId,
          idempotencyKey: requestKey,
          candidateGlobalId,
          purpose: 'provider',
        }),
        candidateGlobalId: target.candidateGlobalId,
      })
    }
    const result = await rebaseCommerceOrderWorkbenchFromLatestCandidateInPostgres({
      organizationId,
      actorEmail: actor.email,
      idempotencyKey: derivedOrderWorkbenchIdempotencyKey({
        organizationId,
        idempotencyKey: requestKey,
        candidateGlobalId,
        purpose: 'rebase',
      }),
      candidateGlobalId,
      expectedRowVersion,
      expectedLatestCandidateGlobalId: latestCandidateGlobalId,
      resolutions,
      lineResolutions,
    })
    const [order] = await readCommerceOrderWorkbenchFromPostgres({
      organizationId,
      candidateGlobalId: result.candidateGlobalId,
      includeResolutionDetails: true,
    })
    if (!order) {
      requestError(
        'OPERATIONS_IMPORTED_ORDER_REFRESH_RESULT_INVALID',
        'The refreshed order could not be reloaded',
        500,
      )
    }
    return response({ ok: true, refreshResult: result, order })
  } catch (error) {
    return errorResponse(error)
  }
}
