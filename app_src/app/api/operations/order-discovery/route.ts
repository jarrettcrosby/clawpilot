import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  CommerceIntegrationRequestError,
  sanitizedCommerceIntegrationError,
} from '@/lib/integrations/commerceIntegrations'
import {
  processCommerceOrderReconciliation,
} from '@/lib/commerceOrderReconciliationWorker'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readCommerceStoreSyncControlsFromPostgres,
} from '@/lib/persistence/commerceStoreSync'
import {
  readCommerceOrderReconciliationStateInPostgres,
  resetCommerceOrderReconciliationInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'
import {
  completeCommerceOrderDiscoveryCommandInPostgres,
  prepareCommerceOrderDiscoveryCommandInPostgres,
  type CommerceOrderDiscoveryHttpResult,
} from '@/lib/persistence/commerceOrderDiscovery'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ACCOUNT_GLOBAL_ID = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAX_REQUEST_BYTES = 4 * 1024

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function count(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function deterministicUuid(input: Record<string, unknown>) {
  const bytes = Buffer.from(
    createHash('sha256').update(JSON.stringify(input)).digest().subarray(0, 16),
  )
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function errorResult(error: unknown): CommerceOrderDiscoveryHttpResult {
  if (error instanceof Error && error.message === 'Unauthorized') {
    return {
      status: 401,
      body: { ok: false, code: 'UNAUTHORIZED', error: 'Unauthorized' },
    }
  }
  if (error instanceof CommerceIntegrationRequestError) {
    const sanitized = sanitizedCommerceIntegrationError(error)
    return {
      status: sanitized.status,
      body: {
        ok: false,
        code: sanitized.code,
        error: sanitized.message,
      },
    }
  }
  console.error('[commerce-order-discovery] request failed', {
    message: error instanceof Error ? error.message : 'Unknown error',
  })
  return {
    status: 500,
    body: {
      ok: false,
      code: 'COMMERCE_ORDER_DISCOVERY_FAILED',
      error: 'Connected-store orders could not be refreshed',
    },
  }
}

export async function POST(req: NextRequest) {
  let receipt: {
    organizationId: string
    accountGlobalId: string
    idempotencyKey: string
    receiptId: string
    attemptToken: string
  } | null = null
  try {
    if (!isPostgresStorageEnabled()) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_POSTGRES_REQUIRED',
        error: 'Connected-store order refresh requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'Operations management permission is required to refresh orders',
      }, 403)
    }
    if (req.nextUrl.search.length > 0) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_QUERY_INVALID',
        error: 'Connected-store order refresh does not accept query parameters',
      }, 400)
    }
    const requestKey = String(req.headers.get('idempotency-key') || '').trim()
      .toLowerCase()
    if (!UUID.test(requestKey)) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_IDEMPOTENCY_KEY_INVALID',
        error: 'A UUID Idempotency-Key header is required',
      }, 400)
    }
    const rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_BODY_INVALID',
        error: 'Connected-store order refresh input is invalid',
      }, 400)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_BODY_INVALID',
        error: 'Connected-store order refresh input is invalid',
      }, 400)
    }
    const body = parsed as Record<string, unknown>
    if (Object.keys(body).some((key) => key !== 'accountGlobalId')) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_BODY_INVALID',
        error: 'Connected-store order refresh input is invalid',
      }, 400)
    }
    const accountGlobalId = String(body.accountGlobalId || '').trim()
    if (!ACCOUNT_GLOBAL_ID.test(accountGlobalId)) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_BODY_INVALID',
        error: 'Connected-store order refresh input is invalid',
      }, 400)
    }

    const organizationId = activeOperationsOrganizationId(actor)
    const controls = await readCommerceStoreSyncControlsFromPostgres(
      organizationId,
    )
    const control = controls.find((candidate) => (
      candidate.accountGlobalId === accountGlobalId
    ))
    if (!control) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_DISCOVERY_ACCOUNT_NOT_FOUND',
        error: 'Connected store was not found in the active organization',
      }, 404)
    }
    const prepared = await prepareCommerceOrderDiscoveryCommandInPostgres({
      organizationId,
      accountGlobalId,
      actorEmail: actor.email,
      idempotencyKey: requestKey,
    })
    if (prepared.kind === 'replay') {
      return response(prepared.result.body, prepared.result.status)
    }
    receipt = {
      organizationId,
      accountGlobalId,
      idempotencyKey: requestKey,
      receiptId: prepared.receiptId,
      attemptToken: prepared.attemptToken,
    }
    if (
      control.effectiveState !== 'running'
      || control.accountStatus !== 'active'
    ) {
      throw new CommerceIntegrationRequestError(
        `${control.displayName} Store sync is not running`,
        409,
        'COMMERCE_ORDER_DISCOVERY_ACCOUNT_PAUSED',
      )
    }

    const priorState = await readCommerceOrderReconciliationStateInPostgres({
      organizationId,
      accountGlobalId,
    })
    let reset: Record<string, unknown> | null = null
    if (
      priorState?.resetRequired
      && priorState.lastErrorCode
      && priorState.lastStartedAt
    ) {
      reset = await resetCommerceOrderReconciliationInPostgres({
        organizationId,
        accountGlobalId,
        actorEmail: actor.email,
        idempotencyKey: deterministicUuid({
          version: 'operations-order-discovery-reset-v1',
          organizationId,
          accountGlobalId,
          requestKey,
          lastErrorCode: priorState.lastErrorCode,
          lastStartedAt: priorState.lastStartedAt,
        }),
        expectedLastErrorCode: priorState.lastErrorCode,
        expectedLastStartedAt: priorState.lastStartedAt,
        reason: 'Manager requested a connected-store order refresh',
        confirmReset: true,
      }) as Record<string, unknown>
    }
    const executed = await processCommerceOrderReconciliation({
      limit: 1,
      organizationId,
      accountGlobalIds: [accountGlobalId],
      force: true,
      processRevisionWorkers: false,
    })
    if (
      executed.providerWrites !== 0
      || executed.inventoryWrites !== 0
    ) {
      throw new CommerceIntegrationRequestError(
        'Connected-store order refresh returned invalid evidence',
        500,
        'COMMERCE_ORDER_DISCOVERY_EVIDENCE_INVALID',
      )
    }
    if (executed.skipped) {
      throw new CommerceIntegrationRequestError(
        'Connected-store order refresh is not available in this runtime',
        503,
        'COMMERCE_ORDER_DISCOVERY_RUNTIME_UNAVAILABLE',
      )
    }
    if (count(executed.failed) > 0) {
      throw new CommerceIntegrationRequestError(
        'The connected store could not be read; retry the order refresh',
        502,
        'COMMERCE_ORDER_DISCOVERY_PROVIDER_READ_FAILED',
      )
    }
    const state = await readCommerceOrderReconciliationStateInPostgres({
      organizationId,
      accountGlobalId,
    })
    if (
      count(executed.claimed) === 0
      && !['running', 'succeeded'].includes(String(state?.status || ''))
    ) {
      throw new CommerceIntegrationRequestError(
        'Connected-store order refresh did not start; retry the order refresh',
        409,
        'COMMERCE_ORDER_DISCOVERY_NOT_STARTED',
      )
    }
    const result = {
      status: state?.status === 'running' ? 202 : 200,
      body: {
        ok: true,
        result: {
          accountGlobalId,
          displayName: control.displayName,
          provider: control.provider,
          counts: {
            providerRowsSeen: count(executed.providerRecordsSeen),
            eligibleOrdersSeen:
              count(executed.staged)
              + count(executed.preserved)
              + count(executed.skippedCanonical),
            ordersStaged: count(executed.staged),
            ordersPreserved: count(executed.preserved),
            ordersSkippedCanonical: count(executed.skippedCanonical),
            recordsRejected: count(executed.rejected),
            canonicalOrdersCreated: count(executed.canonicalOrderWrites),
          },
          pagination: {
            batchNumber: count(executed.pagesRead),
            continuationRunGlobalId: null,
            hasNextBatch:
              state?.status === 'running'
              || count(executed.resumable) > 0,
            sessionComplete:
              state?.status !== 'running'
              && count(executed.resumable) === 0,
          },
          refresh: {
            claimed: count(executed.claimed),
            failed: count(executed.failed),
            failureCodes: record(executed.failureCodes),
            reset: Boolean(reset),
            status: state?.status || 'idle',
            resumable: state?.resumable === true,
          },
          providerWrites: 0,
        },
      },
    } satisfies CommerceOrderDiscoveryHttpResult
    const completed = await completeCommerceOrderDiscoveryCommandInPostgres({
      ...receipt,
      result,
    })
    return response(completed.body, completed.status)
  } catch (error) {
    const failure = errorResult(error)
    if (receipt) {
      try {
        const completed = await completeCommerceOrderDiscoveryCommandInPostgres({
          ...receipt,
          result: failure,
        })
        return response(completed.body, completed.status)
      } catch (receiptError) {
        console.error('[commerce-order-discovery] receipt completion failed', {
          message: receiptError instanceof Error
            ? receiptError.message
            : 'Unknown error',
        })
        return response({
          ok: false,
          code: 'COMMERCE_ORDER_DISCOVERY_RECEIPT_FAILED',
          error: 'Connected-store refresh completion could not be recorded safely',
        }, 500)
      }
    }
    return response(failure.body, failure.status)
  }
}
