import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  refreshCommerceOrderRevisionFromProvider,
} from '@/lib/operations/commerceOrderRevisionCommands'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  applyCommerceOrderRevisionToClawPilotInPostgres,
  cancelUnstartedCommerceOrderFromProviderRevisionInPostgres,
  CommerceOrderRevisionDispositionError,
  readManagerCommerceOrderRevisionStateFromPostgres,
} from '@/lib/persistence/commerceOrderRevisions'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'

const MAX_REQUEST_BYTES = 64 * 1024
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const OBSERVATION_GLOBAL_ID = /^gcor(?:[0-9]{7}|[0-9a-v]{12})$/u
const READ_GLOBAL_ID = /^gcrr(?:[0-9]{7}|[0-9a-v]{12})$/u
const APPLICATION_GLOBAL_ID = /^gcoa(?:[0-9]{7}|[0-9a-v]{12})$/u
const EXCEPTION_GLOBAL_ID = /^gex(?:[0-9]{7}|[0-9a-v]{12})$/u
const DISPOSITION_GLOBAL_ID = /^gcod(?:[0-9]{7}|[0-9a-v]{12})$/u
const SHA256 = /^[a-f0-9]{64}$/u
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/u
const RESULT_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u
const ORDER_STATUSES = new Set([
  'imported', 'validated', 'held', 'promised', 'reserved', 'planned',
  'released', 'picking', 'packed', 'shipped', 'cancelled', 'exception',
])
const MATERIAL_STATES = new Set([
  'current', 'review_required', 'provider_cancelled', 'provider_fulfilled',
])

type RevisionAction =
  | 'refresh-from-provider'
  | 'apply-to-clawpilot'
  | 'accept-provider-cancellation'

class CommerceOrderRevisionApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CommerceOrderRevisionApiError'
    this.code = code
    this.status = status
  }
}

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function requestError(code: string, message: string, status = 400): never {
  throw new CommerceOrderRevisionApiError(code, message, status)
}

function resultError(): never {
  requestError(
    'COMMERCE_ORDER_REVISION_RESULT_INVALID',
    'Provider order revision result is invalid',
    500,
  )
}

function requirePostgres() {
  if (!isPostgresStorageEnabled()) {
    requestError(
      'COMMERCE_ORDER_REVISION_POSTGRES_REQUIRED',
      'Provider order revision actions require Postgres storage',
      503,
    )
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    requestError(
      'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
      'A valid provider order revision request is required',
    )
  }
  return value as Record<string, unknown>
}

function assertFields(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    requestError(
      'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
      'Provider order revision request includes an unsupported field',
    )
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') {
    requestError('COMMERCE_ORDER_REVISION_REQUEST_INVALID', `${label} is invalid`)
  }
  const text = value.trim()
  if (
    text.length < 1
    || text.length > maximum
    || text !== value
    || /[\u0000-\u001f\u007f]/u.test(text)
  ) {
    requestError('COMMERCE_ORDER_REVISION_REQUEST_INVALID', `${label} is invalid`)
  }
  return text
}

function globalIdValue(value: unknown, label: string, pattern: RegExp): string {
  const globalId = boundedText(value, label, 16)
  if (!pattern.test(globalId)) {
    requestError('COMMERCE_ORDER_REVISION_REQUEST_INVALID', `${label} is invalid`)
  }
  return globalId
}

function hashValue(value: unknown, label: string): string {
  const hash = boundedText(value, label, 64)
  if (!SHA256.test(hash)) {
    requestError('COMMERCE_ORDER_REVISION_REQUEST_INVALID', `${label} is invalid`)
  }
  return hash
}

function rowVersionValue(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) {
    requestError(
      'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
      'Expected order version is invalid',
    )
  }
  return Number(value)
}

function reasonValue(value: unknown): string {
  const reason = boundedText(value, 'Provider revision reason', 500)
  if (reason.length < 10) {
    requestError(
      'COMMERCE_ORDER_REVISION_REASON_INVALID',
      'Provider revision reason must contain at least 10 characters',
    )
  }
  return reason
}

function idempotencyKeyValue(req: NextRequest): string {
  const value = req.headers.get('idempotency-key')
  if (value === null || value !== value.trim() || !IDEMPOTENCY_KEY.test(value)) {
    requestError(
      'COMMERCE_ORDER_REVISION_IDEMPOTENCY_KEY_INVALID',
      'A valid Idempotency-Key header is required',
    )
  }
  return value
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase()
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    requestError(
      'COMMERCE_ORDER_REVISION_CONTENT_TYPE_INVALID',
      'Provider order revision actions require JSON',
      415,
    )
  }
  const declaredLength = req.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      requestError(
        'COMMERCE_ORDER_REVISION_CONTENT_LENGTH_INVALID',
        'Provider order revision request length is invalid',
      )
    }
    if (parsedLength > MAX_REQUEST_BYTES) {
      requestError(
        'COMMERCE_ORDER_REVISION_REQUEST_TOO_LARGE',
        'Provider order revision request exceeded the supported size',
        413,
      )
    }
  }
  const chunks: Buffer[] = []
  let receivedBytes = 0
  const reader = req.body?.getReader()
  if (reader) {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        receivedBytes += next.value.byteLength
        if (receivedBytes > MAX_REQUEST_BYTES) {
          try {
            await reader.cancel('request_too_large')
          } catch {
            // The request is already rejected; cancellation is best effort.
          }
          requestError(
            'COMMERCE_ORDER_REVISION_REQUEST_TOO_LARGE',
            'Provider order revision request exceeded the supported size',
            413,
          )
        }
        chunks.push(Buffer.from(next.value))
      }
    } finally {
      reader.releaseLock()
    }
  }
  const raw = Buffer.concat(chunks, receivedBytes).toString('utf8')
  try {
    return record(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof CommerceOrderRevisionApiError) throw error
    requestError(
      'COMMERCE_ORDER_REVISION_REQUEST_INVALID',
      'A valid provider order revision request is required',
    )
  }
}

function revisionAction(value: unknown): RevisionAction {
  const action = boundedText(value, 'Provider order revision action', 40)
  if (
    action !== 'refresh-from-provider'
    && action !== 'apply-to-clawpilot'
    && action !== 'accept-provider-cancellation'
  ) {
    requestError(
      'COMMERCE_ORDER_REVISION_ACTION_INVALID',
      'Provider order revision action is invalid',
    )
  }
  return action
}

function exactRevisionInput(body: Record<string, unknown>) {
  return {
    orderGlobalId: globalIdValue(body.orderGlobalId, 'Operations order', ORDER_GLOBAL_ID),
    observationGlobalId: globalIdValue(
      body.observationGlobalId,
      'Provider revision observation',
      OBSERVATION_GLOBAL_ID,
    ),
    readGlobalId: globalIdValue(
      body.readGlobalId,
      'Provider revision exact read',
      READ_GLOBAL_ID,
    ),
    expectedSourceHash: hashValue(body.expectedSourceHash, 'Expected provider source hash'),
    expectedRevisionHash: hashValue(body.expectedRevisionHash, 'Expected provider revision hash'),
    expectedRowVersion: rowVersionValue(body.expectedRowVersion),
    reason: reasonValue(body.reason),
  }
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) resultError()
  return value as Record<string, unknown>
}

function resultString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) resultError()
  return value
}

function resultInteger(value: unknown, minimum = 0, maximum = 2_147_483_647) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    resultError()
  }
  return Number(value)
}

function resultBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') resultError()
  return value
}

function zeroProviderWrites(value: unknown): 0 {
  if (value !== 0) {
    requestError(
      'COMMERCE_ORDER_REVISION_PROVIDER_WRITE_BLOCKED',
      'Provider writes are not authorized by this action',
      409,
    )
  }
  return 0
}

function publicRevisionState(value: unknown, expectedOrderGlobalId: string) {
  const source = resultRecord(value)
  const orderGlobalId = resultString(source.orderGlobalId, ORDER_GLOBAL_ID)
  if (orderGlobalId !== expectedOrderGlobalId) resultError()
  const provider = resultString(source.provider, /^(?:shopify|faire)$/u)
  const orderStatus = resultString(source.orderStatus, /^[a-z_]{3,32}$/u)
  if (!ORDER_STATUSES.has(orderStatus)) resultError()
  const stateSource = source.state === null ? null : resultRecord(source.state)
  const state = stateSource === null ? null : (() => {
    const materialState = resultString(stateSource.materialState, /^[a-z_]{3,32}$/u)
    if (!MATERIAL_STATES.has(materialState)) resultError()
    const capturedAt = resultString(
      stateSource.capturedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u,
    )
    if (!Number.isFinite(new Date(capturedAt).getTime())) resultError()
    const applyBlockedCode = stateSource.applyBlockedCode === null
      ? null
      : resultString(stateSource.applyBlockedCode, RESULT_CODE)
    const applicationGlobalId = stateSource.applicationGlobalId === null
      ? null
      : resultString(stateSource.applicationGlobalId, APPLICATION_GLOBAL_ID)
    const exceptionGlobalId = stateSource.exceptionGlobalId === null
      ? null
      : resultString(stateSource.exceptionGlobalId, EXCEPTION_GLOBAL_ID)
    return {
      observationGlobalId: resultString(
        stateSource.observationGlobalId,
        OBSERVATION_GLOBAL_ID,
      ),
      readGlobalId: resultString(stateSource.readGlobalId, READ_GLOBAL_ID),
      sourceHash: resultString(stateSource.sourceHash, SHA256),
      revisionHash: resultString(stateSource.revisionHash, SHA256),
      materialState,
      capturedAt: new Date(capturedAt).toISOString(),
      fresh: resultBoolean(stateSource.fresh),
      changed: resultBoolean(stateSource.changed),
      applyEligible: resultBoolean(stateSource.applyEligible),
      applyBlockedCode,
      cancellationEligible: resultBoolean(stateSource.cancellationEligible),
      providerReads: resultInteger(stateSource.providerReads, 1, 4),
      providerWrites: zeroProviderWrites(stateSource.providerWrites),
      applicationGlobalId,
      exceptionGlobalId,
    }
  })()
  return {
    eligible: resultBoolean(source.eligible),
    provider,
    orderGlobalId,
    orderRowVersion: resultInteger(source.orderRowVersion),
    orderStatus,
    state,
  }
}

function publicRefreshResult(
  value: unknown,
  expected: { orderGlobalId: string; rowVersion: number },
) {
  const source = resultRecord(value)
  const revision = publicRevisionState(source.revision, expected.orderGlobalId)
  if (revision.orderRowVersion !== expected.rowVersion) resultError()
  return {
    replayed: resultBoolean(source.replayed),
    revision,
  }
}

type ExactResultBinding = Readonly<{
  orderGlobalId: string
  observationGlobalId: string
  readGlobalId: string
  sourceHash: string
  revisionHash: string
  rowVersion: number
}>

function exactResultFields(value: unknown, expected: ExactResultBinding) {
  const source = resultRecord(value)
  const fields = {
    orderGlobalId: resultString(source.orderGlobalId, ORDER_GLOBAL_ID),
    observationGlobalId: resultString(source.observationGlobalId, OBSERVATION_GLOBAL_ID),
    readGlobalId: resultString(source.readGlobalId, READ_GLOBAL_ID),
    sourceHash: resultString(source.sourceHash, SHA256),
    revisionHash: resultString(source.revisionHash, SHA256),
    previousRowVersion: resultInteger(source.previousRowVersion),
    newRowVersion: resultInteger(source.newRowVersion),
  }
  if (
    fields.orderGlobalId !== expected.orderGlobalId
    || fields.observationGlobalId !== expected.observationGlobalId
    || fields.readGlobalId !== expected.readGlobalId
    || fields.sourceHash !== expected.sourceHash
    || fields.revisionHash !== expected.revisionHash
    || fields.previousRowVersion !== expected.rowVersion
    || fields.newRowVersion !== expected.rowVersion + 1
  ) resultError()
  return {
    source,
    fields,
    replayed: resultBoolean(source.replayed),
    providerReads: resultInteger(source.providerReads, 1, 4),
    providerWrites: zeroProviderWrites(source.providerWrites),
  }
}

function publicApplyResult(value: unknown, expected: ExactResultBinding) {
  const exact = exactResultFields(value, expected)
  const change = resultRecord(exact.source.changeSummary)
  return {
    applicationGlobalId: resultString(
      exact.source.applicationGlobalId,
      APPLICATION_GLOBAL_ID,
    ),
    ...exact.fields,
    replayed: exact.replayed,
    providerReads: exact.providerReads,
    providerWrites: exact.providerWrites,
    changeSummary: {
      headerChanged: resultBoolean(change.headerChanged),
      retainedLines: resultInteger(change.retainedLines),
      changedLines: resultInteger(change.changedLines),
      addedLines: resultInteger(change.addedLines),
      removedLines: resultInteger(change.removedLines),
    },
  }
}

function publicCancellationResult(value: unknown, expected: ExactResultBinding) {
  const exact = exactResultFields(value, expected)
  if (exact.source.previousStatus !== 'imported' || exact.source.status !== 'cancelled') {
    resultError()
  }
  return {
    dispositionGlobalId: resultString(
      exact.source.dispositionGlobalId,
      DISPOSITION_GLOBAL_ID,
    ),
    ...exact.fields,
    previousStatus: 'imported' as const,
    status: 'cancelled' as const,
    replayed: exact.replayed,
    providerReads: exact.providerReads,
    providerWrites: exact.providerWrites,
  }
}

function managerRequired() {
  return json({
    ok: false,
    error: 'You do not have permission to refresh provider orders',
    code: 'OPERATIONS_MANAGE_REQUIRED',
  }, 403)
}

function executionRequired() {
  return json({
    ok: false,
    error: 'You do not have permission to apply provider order changes',
    code: 'OPERATIONS_EXECUTE_REQUIRED',
  }, 403)
}

function errorResponse(error: unknown) {
  const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
  if (maintenance) return maintenance
  if (error instanceof Error && error.message === 'Unauthorized') {
    return json({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)
  }
  if (error instanceof Error && error.message === 'ACTIVE_ORGANIZATION_REQUIRED') {
    return json({
      ok: false,
      error: 'Select an active organization first',
      code: error.message,
    }, 409)
  }
  if (
    error instanceof CommerceOrderRevisionApiError
    || error instanceof CommerceOrderRevisionDispositionError
  ) {
    return json({
      ok: false,
      error: error.message,
      code: error.code,
      ...(error instanceof CommerceOrderRevisionDispositionError
        && error.retryWithNewIdempotencyKey
        ? { retryWithNewIdempotencyKey: true }
        : {}),
    }, error.status)
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && 'status' in error
    && error.code === 'OPERATIONS_SHIPPING_ONE_OFF_PACK_EVIDENCE_BUSY'
    && error.status === 409
  ) {
    return json({
      ok: false,
      error: 'Pack confirmation is using this exact evidence; retry after refreshing status',
      code: error.code,
    }, error.status)
  }
  console.error('[commerce-order-revisions] request failed', {
    kind: error instanceof Error ? 'unexpected_error' : 'unexpected_value',
    code: 'COMMERCE_ORDER_REVISION_INTERNAL_ERROR',
  })
  return json({
    ok: false,
    error: 'Provider order revision action is temporarily unavailable',
    code: 'COMMERCE_ORDER_REVISION_INTERNAL_ERROR',
  }, 500)
}

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) return managerRequired()
    const organizationId = activeOperationsOrganizationId(actor)
    requirePostgres()
    const queryFields = Array.from(new Set(req.nextUrl.searchParams.keys()))
    if (
      queryFields.length !== 1
      || queryFields[0] !== 'orderGlobalId'
      || req.nextUrl.searchParams.getAll('orderGlobalId').length !== 1
    ) {
      requestError(
        'COMMERCE_ORDER_REVISION_QUERY_INVALID',
        'Exactly one Operations order is required',
      )
    }
    const orderGlobalId = globalIdValue(
      req.nextUrl.searchParams.get('orderGlobalId'),
      'Operations order',
      ORDER_GLOBAL_ID,
    )
    const revision = await readManagerCommerceOrderRevisionStateFromPostgres({
      organizationId,
      orderGlobalId,
    })
    return json({
      ok: true,
      capabilities,
      revision: publicRevisionState(revision, orderGlobalId),
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
    const organizationId = activeOperationsOrganizationId(actor)
    const body = await requestBody(req)
    const action = revisionAction(body.action)

    if (action !== 'refresh-from-provider' && !capabilities.canExecute) {
      return executionRequired()
    }
    requirePostgres()

    if (action === 'refresh-from-provider') {
      assertFields(body, new Set(['action', 'orderGlobalId', 'expectedRowVersion']))
      const orderGlobalId = globalIdValue(
        body.orderGlobalId,
        'Operations order',
        ORDER_GLOBAL_ID,
      )
      const expectedRowVersion = rowVersionValue(body.expectedRowVersion)
      const result = await refreshCommerceOrderRevisionFromProvider({
        organizationId,
        actorEmail: actor.email,
        orderGlobalId,
        expectedRowVersion,
        idempotencyKey: idempotencyKeyValue(req),
      })
      return json({
        ok: true,
        capabilities,
        result: publicRefreshResult(result, {
          orderGlobalId,
          rowVersion: expectedRowVersion,
        }),
      })
    }

    const idempotencyKey = idempotencyKeyValue(req)
    assertFields(body, new Set([
      'action',
      'orderGlobalId',
      'observationGlobalId',
      'readGlobalId',
      'expectedSourceHash',
      'expectedRevisionHash',
      'expectedRowVersion',
      'reason',
    ]))
    const exactRevision = exactRevisionInput(body)

    const result = action === 'apply-to-clawpilot'
      ? await applyCommerceOrderRevisionToClawPilotInPostgres({
          organizationId,
          actorEmail: actor.email,
          ...exactRevision,
          idempotencyKey,
        })
      : await cancelUnstartedCommerceOrderFromProviderRevisionInPostgres({
          organizationId,
          actorEmail: actor.email,
          ...exactRevision,
          idempotencyKey,
        })
    const expectedResult = {
      orderGlobalId: exactRevision.orderGlobalId,
      observationGlobalId: exactRevision.observationGlobalId,
      readGlobalId: exactRevision.readGlobalId,
      sourceHash: exactRevision.expectedSourceHash,
      revisionHash: exactRevision.expectedRevisionHash,
      rowVersion: exactRevision.expectedRowVersion,
    }
    return json({
      ok: true,
      capabilities,
      result: action === 'apply-to-clawpilot'
        ? publicApplyResult(result, expectedResult)
        : publicCancellationResult(result, expectedResult),
    })
  } catch (error) {
    return errorResponse(error)
  }
}
