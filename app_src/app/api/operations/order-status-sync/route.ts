import { NextRequest, NextResponse } from 'next/server'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import {
  refreshCommerceOrderRevisionFromProvider,
} from '@/lib/operations/commerceOrderRevisionCommands'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceOrderRevisionDispositionError,
  completeCommerceOrderStatusSyncBatchInPostgres,
  listCommerceOrderRevisionRefreshCandidatesInPostgres,
  prepareCommerceOrderStatusSyncBatchInPostgres,
  type CommerceOrderRevisionMaterialState,
} from '@/lib/persistence/commerceOrderRevisions'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 300

const BATCH_LIMIT = 10
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,120}$/u
const ORDER_GLOBAL_ID = /^gor(?:[0-9]{7}|[0-9a-v]{12})$/u
const MAX_EXCLUDED_ORDERS = 500
const MAX_REQUEST_BYTES = 16 * 1024

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function safeFailureCode(error: unknown) {
  if (
    error instanceof CommerceOrderRevisionDispositionError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  return 'COMMERCE_ORDER_STATUS_SYNC_FAILED'
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_POSTGRES_REQUIRED',
        error: 'Sales-channel order status sync requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    const capabilities = operationsCapabilities(actor)
    if (!capabilities.canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'Operations management permission is required to sync order status',
      }, 403)
    }
    if (req.nextUrl.search.length > 0) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_QUERY_INVALID',
        error: 'Sales-channel order status sync does not accept query parameters',
      }, 400)
    }
    const idempotencyKey = req.headers.get('idempotency-key') || ''
    if (
      idempotencyKey !== idempotencyKey.trim()
      || !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_IDEMPOTENCY_KEY_INVALID',
        error: 'A valid Idempotency-Key header is required',
      }, 400)
    }
    const rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
        error: 'Sales-channel order status sync input is invalid',
      }, 400)
    }
    let body: unknown = {}
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
        error: 'Sales-channel order status sync input is invalid',
      }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
        error: 'Sales-channel order status sync input is invalid',
      }, 400)
    }
    const bodyRecord = body as Record<string, unknown>
    const bodyKeys = Object.keys(bodyRecord)
    const excluded = bodyRecord.excludeOrderGlobalIds ?? []
    if (
      bodyKeys.some((key) => key !== 'excludeOrderGlobalIds')
      || !Array.isArray(excluded)
      || excluded.length > MAX_EXCLUDED_ORDERS
      || new Set(excluded).size !== excluded.length
      || excluded.some((globalId) => (
        typeof globalId !== 'string' || !ORDER_GLOBAL_ID.test(globalId)
      ))
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_STATUS_SYNC_BODY_INVALID',
        error: 'Sales-channel order status sync input is invalid',
      }, 400)
    }
    const excludeOrderGlobalIds = excluded as string[]

    const organizationId = activeOperationsOrganizationId(actor)
    const selectedCandidates =
      await listCommerceOrderRevisionRefreshCandidatesInPostgres({
        organizationId,
        limit: BATCH_LIMIT,
        excludeOrderGlobalIds,
      })
    const batch = await prepareCommerceOrderStatusSyncBatchInPostgres({
      organizationId,
      actorEmail: actor.email,
      idempotencyKey,
      batchLimit: BATCH_LIMIT,
      candidates: selectedCandidates,
      excludeOrderGlobalIds,
    })
    if (batch.replayedResult) {
      return response({ ok: true, result: batch.replayedResult })
    }
    if (!batch.attemptToken) {
      throw new CommerceOrderRevisionDispositionError(
        'COMMERCE_ORDER_STATUS_SYNC_NOT_RETAINED',
        'The order status sync command was not retained',
        500,
      )
    }
    const candidates = batch.candidates
    const counts = {
      selected: candidates.length,
      attempted: 0,
      refreshed: 0,
      changed: 0,
      current: 0,
      providerFulfilled: 0,
      providerCancelled: 0,
      reviewRequired: 0,
      failed: 0,
      providerReads: 0,
    }
    const failedByCode: Record<string, number> = {}
    const outcomes: Array<{
      orderGlobalId: string
      provider: 'shopify' | 'faire'
      outcome: CommerceOrderRevisionMaterialState | 'failed'
      code: string | null
    }> = []

    // Deliberately sequential: one manager click must not create a provider
    // read burst against a shared commerce account.
    for (const candidate of candidates) {
      counts.attempted += 1
      try {
        const refreshed = await refreshCommerceOrderRevisionFromProvider({
          organizationId,
          actorEmail: actor.email,
          orderGlobalId: candidate.orderGlobalId,
          expectedRowVersion: candidate.orderRowVersion,
          idempotencyKey:
            `${idempotencyKey}:${candidate.orderGlobalId}:${candidate.orderRowVersion}`,
        })
        const exactCapture = refreshed.capture
        const state = exactCapture.materialState
        counts.refreshed += 1
        counts.providerReads += exactCapture.providerReads
        if (exactCapture.changed) counts.changed += 1
        if (state === 'current') counts.current += 1
        if (state === 'provider_fulfilled') counts.providerFulfilled += 1
        if (state === 'provider_cancelled') counts.providerCancelled += 1
        if (state === 'review_required') counts.reviewRequired += 1
        outcomes.push({
          orderGlobalId: candidate.orderGlobalId,
          provider: candidate.provider,
          outcome: state,
          code: null,
        })
      } catch (error) {
        const code = safeFailureCode(error)
        counts.failed += 1
        failedByCode[code] = (failedByCode[code] || 0) + 1
        outcomes.push({
          orderGlobalId: candidate.orderGlobalId,
          provider: candidate.provider,
          outcome: 'failed',
          code,
        })
      }
    }

    const totalEligible = candidates[0]?.totalEligible || 0
    const status = counts.failed === 0
      ? 'succeeded'
      : counts.refreshed > 0
        ? 'partial'
        : 'failed'
    const result = {
      status,
      batchLimit: BATCH_LIMIT,
      totalEligible,
      counts,
      failedByCode,
      outcomes,
      providerWrites: 0,
      canonicalOrderWrites: 0,
    }
    await completeCommerceOrderStatusSyncBatchInPostgres({
      organizationId,
      receiptId: batch.receiptId,
      attemptToken: batch.attemptToken,
      result,
    })
    return response({ ok: true, result })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({ ok: false, error: 'Unauthorized' }, 401)
    }
    if (error instanceof CommerceOrderRevisionDispositionError) {
      return response({
        ok: false,
        code: error.code,
        error: error.message,
      }, error.status)
    }
    console.error('[commerce-order-status-sync] request failed', {
      code: safeFailureCode(error),
    })
    return response({
      ok: false,
      code: 'COMMERCE_ORDER_STATUS_SYNC_FAILED',
      error: 'Sales-channel order status could not be synchronized',
    }, 500)
  }
}
