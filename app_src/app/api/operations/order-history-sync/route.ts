import { NextRequest, NextResponse } from 'next/server'
import {
  exactFaireOrderHistoryProviderReads,
  exactShopifyOrderHistoryProviderReads,
  readExactFaireOrderHistoryObservation,
  readExactShopifyOrderHistoryObservation,
} from '@/lib/integrations/commerceOrderHistory'
import { FaireCommerceClientError } from '@/lib/integrations/faireCommerceClient'
import { ShopifyCommerceClientError } from '@/lib/integrations/shopifyCommerceClient'
import {
  integrationCredentialRuntimeMaintenanceResponse,
} from '@/lib/integrations/integrationCredentialRuntimeHttp'
import {
  activeOperationsOrganizationId,
  operationsCapabilities,
} from '@/lib/operations/authorization'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  CommerceOrderHistoryBatchError,
  completeCommerceOrderHistoryBatchInPostgres,
  isCommerceOrderHistoryTerminalUnsupportedCode,
  listCommerceOrderHistoryBatchCandidatesInPostgres,
  prepareCommerceOrderHistoryBatchInPostgres,
  readLatestCommerceOrderExactHistorySourceHashInPostgres,
  type CommerceOrderHistoryBatchCandidate,
  type CommerceOrderHistoryBatchOutcome,
  type CommerceOrderHistoryBatchResult,
} from '@/lib/persistence/commerceOrderHistoryBatch'
import {
  appendCommerceOrderWorkbenchExactReadInPostgres,
  CommerceOrderSyncError,
  readCommerceOrderWorkbenchExactReadReplayInPostgres,
} from '@/lib/persistence/commerceOrderSync'
import {
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'
import { requireRequestUser } from '@/lib/requestUser'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const runtime = 'nodejs'
export const maxDuration = 300

const BATCH_LIMIT = 10
const MAX_ORDER_KEYS = 100
const MAX_REQUEST_BYTES = 4 * 1024
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,120}$/u
const ORDER_KEY = /^(?:canonical:gor(?:[0-9]{7}|[0-9a-v]{12})|imported:gcoc(?:[0-9]{7}|[0-9a-v]{12}))$/u
const DEGRADABLE_EXACT_HISTORY_CODES = new Set([
  'COMMERCE_ORDER_HISTORY_ACCOUNT_CHANGED',
  'COMMERCE_ORDER_HISTORY_NESTED_PAGINATION_LIMIT',
  'COMMERCE_ORDER_HISTORY_NORMALIZATION_REJECTED',
  'COMMERCE_ORDER_HISTORY_PROVIDER_RESPONSE_INVALID',
  'FAIRE_ORDER_HISTORY_EXACT_ID_INVALID',
  'SHOPIFY_ORDER_HISTORY_EXACT_ID_INVALID',
  'SHOPIFY_ORDER_HISTORY_EXACT_ORDER_UNAVAILABLE',
  'FAIRE_READ_ORDERS_REQUIRED',
  'SHOPIFY_READ_ORDERS_REQUIRED',
])

function response(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  })
}

function exactHistoryUnavailableCode(error: unknown) {
  if (
    error instanceof ShopifyCommerceClientError
    || error instanceof FaireCommerceClientError
  ) return error.code
  if (
    error instanceof CommerceOrderSyncError
    && DEGRADABLE_EXACT_HISTORY_CODES.has(error.code)
  ) return error.code
  return null
}

function exactHistoryProviderReads(
  provider: CommerceOrderHistoryBatchCandidate['provider'],
  error: unknown,
) {
  return provider === 'shopify'
    ? exactShopifyOrderHistoryProviderReads(error)
    : exactFaireOrderHistoryProviderReads(error)
}

function safeFailureCode(error: unknown) {
  if (
    error instanceof CommerceOrderHistoryBatchError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  return 'COMMERCE_ORDER_HISTORY_BATCH_FAILED'
}

async function refreshCandidate(input: {
  organizationId: string
  actorEmail: string
  idempotencyKey: string
  candidate: CommerceOrderHistoryBatchCandidate
}): Promise<CommerceOrderHistoryBatchOutcome> {
  const { candidate } = input
  const intentKey = [
    'order-history-sync',
    input.idempotencyKey,
    candidate.candidateGlobalId,
  ].join(':')
  const replay = await readCommerceOrderWorkbenchExactReadReplayInPostgres({
    organizationId: input.organizationId,
    integrationAccountId: candidate.integrationAccountId,
    provider: candidate.provider,
    externalOrderId: candidate.externalOrderId,
    intentKey,
  })
  if (replay?.status === 'in_progress') {
    throw new CommerceOrderHistoryBatchError(
      'COMMERCE_ORDER_HISTORY_BATCH_EXACT_READ_IN_PROGRESS',
      'An exact provider-history read is still in progress',
    )
  }
  if (replay?.status === 'unavailable' || replay?.status === 'excluded') {
    return Object.freeze({
      candidateGlobalId: candidate.candidateGlobalId,
      accountGlobalId: candidate.accountGlobalId,
      provider: candidate.provider,
      outcome: 'unavailable',
      changed: false,
      code: replay.code || 'COMMERCE_ORDER_HISTORY_PREVIOUSLY_UNAVAILABLE',
      terminalUnsupported: candidate.terminal
        && isCommerceOrderHistoryTerminalUnsupportedCode(
          replay.code || 'COMMERCE_ORDER_HISTORY_PREVIOUSLY_UNAVAILABLE',
        ),
      providerReads: 0,
    })
  }
  if (replay?.status === 'captured') {
    const sourceHash =
      await readLatestCommerceOrderExactHistorySourceHashInPostgres({
        organizationId: input.organizationId,
        integrationAccountId: candidate.integrationAccountId,
        provider: candidate.provider,
        externalOrderId: candidate.externalOrderId,
      })
    if (!sourceHash) {
      throw new CommerceOrderHistoryBatchError(
        'COMMERCE_ORDER_HISTORY_BATCH_REPLAY_INVALID',
        'Exact provider-history replay evidence is incomplete',
        500,
      )
    }
    return Object.freeze({
      candidateGlobalId: candidate.candidateGlobalId,
      accountGlobalId: candidate.accountGlobalId,
      provider: candidate.provider,
      outcome: 'captured',
      changed: sourceHash !== candidate.previousEvidenceSourceHash,
      code: null,
      terminalUnsupported: false,
      providerReads: 0,
    })
  }

  return withCommerceStoreSyncProviderReadFenceInPostgres({
    organizationId: input.organizationId,
    integrationAccountId: candidate.integrationAccountId,
    authorityKind: 'manual_read_only',
    readKind: 'order_history',
    intentKey,
    acquiredBy: input.actorEmail,
    read: async (providerReadLease) => {
      try {
        const exact = candidate.provider === 'shopify'
          ? await readExactShopifyOrderHistoryObservation({
              organizationId: input.organizationId,
              accountGlobalId: candidate.accountGlobalId,
              expectedCredentialGeneration: candidate.credentialGeneration,
              externalOrderId: candidate.externalOrderId,
              observationKind: 'manual_exact_read',
            })
          : await readExactFaireOrderHistoryObservation({
              organizationId: input.organizationId,
              accountGlobalId: candidate.accountGlobalId,
              expectedCredentialGeneration: candidate.credentialGeneration,
              externalOrderId: candidate.externalOrderId,
              observationKind: 'manual_exact_read',
            })
        const captured = await appendCommerceOrderWorkbenchExactReadInPostgres({
          organizationId: input.organizationId,
          integrationAccountId: candidate.integrationAccountId,
          accountGlobalId: candidate.accountGlobalId,
          provider: candidate.provider,
          credentialGeneration: candidate.credentialGeneration,
          externalOrderId: candidate.externalOrderId,
          providerReadLease,
          observation: exact.observation,
        })
        if ('status' in captured && captured.status === 'excluded') {
          return Object.freeze({
            candidateGlobalId: candidate.candidateGlobalId,
            accountGlobalId: candidate.accountGlobalId,
            provider: candidate.provider,
            outcome: 'unavailable' as const,
            changed: false,
            code: 'COMMERCE_ORDER_HISTORY_POLICY_EXCLUDED',
            terminalUnsupported: false,
            providerReads: captured.providerReads,
          })
        }
        return Object.freeze({
          candidateGlobalId: candidate.candidateGlobalId,
          accountGlobalId: candidate.accountGlobalId,
          provider: candidate.provider,
          outcome: 'captured' as const,
          changed:
            exact.observation.sourceHash
              !== candidate.previousEvidenceSourceHash,
          code: null,
          terminalUnsupported: false,
          providerReads: captured.providerReads,
        })
      } catch (error) {
        const code = exactHistoryUnavailableCode(error)
        if (!code) throw error
        return Object.freeze({
          candidateGlobalId: candidate.candidateGlobalId,
          accountGlobalId: candidate.accountGlobalId,
          provider: candidate.provider,
          outcome: 'unavailable' as const,
          changed: false,
          code,
          terminalUnsupported: candidate.terminal
            && isCommerceOrderHistoryTerminalUnsupportedCode(code),
          providerReads:
            exactHistoryProviderReads(candidate.provider, error) ?? 0,
        })
      }
    },
  })
}

export async function POST(req: NextRequest) {
  try {
    if (!isPostgresStorageEnabled()) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_HISTORY_BATCH_POSTGRES_REQUIRED',
        error: 'Exact provider-history refresh requires Postgres storage',
      }, 503)
    }
    const actor = await requireRequestUser(req)
    if (!operationsCapabilities(actor).canManage) {
      return response({
        ok: false,
        code: 'OPERATIONS_MANAGE_REQUIRED',
        error: 'Operations management permission is required to refresh order history',
      }, 403)
    }
    if (req.nextUrl.search.length > 0) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_HISTORY_BATCH_QUERY_INVALID',
        error: 'Exact provider-history refresh does not accept query parameters',
      }, 400)
    }
    const idempotencyKey = req.headers.get('idempotency-key') || ''
    if (
      idempotencyKey !== idempotencyKey.trim()
      || !IDEMPOTENCY_KEY.test(idempotencyKey)
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_HISTORY_BATCH_IDEMPOTENCY_KEY_INVALID',
        error: 'A valid Idempotency-Key header is required',
      }, 400)
    }
    const rawBody = await req.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_REQUEST_BYTES) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_HISTORY_BATCH_BODY_INVALID',
        error: 'Exact provider-history refresh input is invalid',
      }, 400)
    }
    let body: unknown = {}
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      body = null
    }
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null
    const bodyKeys = bodyRecord ? Object.keys(bodyRecord) : []
    const rawOrderKeys = bodyRecord
      && Object.prototype.hasOwnProperty.call(bodyRecord, 'orderKeys')
      ? bodyRecord.orderKeys
      : undefined
    if (
      !bodyRecord
      || bodyKeys.some((key) => key !== 'orderKeys')
      || (
        rawOrderKeys !== undefined
        && (
          !Array.isArray(rawOrderKeys)
          || rawOrderKeys.length > MAX_ORDER_KEYS
          || rawOrderKeys.some((orderKey) => (
            typeof orderKey !== 'string' || !ORDER_KEY.test(orderKey)
          ))
        )
      )
    ) {
      return response({
        ok: false,
        code: 'COMMERCE_ORDER_HISTORY_BATCH_BODY_INVALID',
        error: 'Exact provider-history refresh input is invalid',
      }, 400)
    }
    const orderKeys = rawOrderKeys === undefined
      ? undefined
      : [...new Set(rawOrderKeys as string[])]

    const organizationId = activeOperationsOrganizationId(actor)
    const selected = await listCommerceOrderHistoryBatchCandidatesInPostgres({
      organizationId,
      limit: BATCH_LIMIT,
      orderKeys,
    })
    const batch = await prepareCommerceOrderHistoryBatchInPostgres({
      organizationId,
      actorEmail: actor.email,
      idempotencyKey,
      batchLimit: BATCH_LIMIT,
      orderKeys,
      candidates: selected,
    })
    if (batch.replayedResult) {
      return response({ ok: true, replayed: true, result: batch.replayedResult })
    }
    if (!batch.attemptToken) {
      throw new CommerceOrderHistoryBatchError(
        'COMMERCE_ORDER_HISTORY_BATCH_NOT_RETAINED',
        'The exact provider-history batch was not retained',
        500,
      )
    }
    const outcomes: CommerceOrderHistoryBatchOutcome[] = []
    // Sequential by design: one operator click cannot burst provider reads
    // across every connected commerce account.
    for (const candidate of batch.candidates) {
      outcomes.push(await refreshCandidate({
        organizationId,
        actorEmail: actor.email,
        idempotencyKey,
        candidate,
      }))
    }
    const remainingCandidates =
      await listCommerceOrderHistoryBatchCandidatesInPostgres({
        organizationId,
        limit: 1,
        orderKeys,
        excludeProviderIdentities: batch.candidates.map((candidate) => ({
          integrationAccountId: candidate.integrationAccountId,
          provider: candidate.provider,
          externalOrderId: candidate.externalOrderId,
        })),
      })
    const remaining = remainingCandidates[0]?.totalEligible || 0
    const refreshed = outcomes.filter((outcome) => (
      outcome.outcome === 'captured'
    )).length
    const unavailable = outcomes.length - refreshed
    const changed = outcomes.filter((outcome) => outcome.changed).length
    const failedByCode: Record<string, number> = {}
    for (const outcome of outcomes) {
      if (!outcome.code) continue
      failedByCode[outcome.code] = (failedByCode[outcome.code] || 0) + 1
    }
    const result: CommerceOrderHistoryBatchResult = Object.freeze({
      status: unavailable === 0
        ? 'succeeded'
        : refreshed > 0
          ? 'partial'
          : 'failed',
      batchLimit: BATCH_LIMIT,
      totalEligible: batch.candidates[0]?.totalEligible || 0,
      remaining,
      hasMore: remaining > 0,
      continuation: remaining > 0
        ? Object.freeze({ mode: 'refresh_again' as const, remaining })
        : null,
      counts: Object.freeze({
        selected: batch.candidates.length,
        attempted: outcomes.length,
        refreshed,
        changed,
        unavailable,
        providerReads: outcomes.reduce(
          (sum, outcome) => sum + outcome.providerReads,
          0,
        ),
      }),
      failedByCode: Object.freeze(failedByCode),
      outcomes: Object.freeze(outcomes),
      providerWrites: 0,
      canonicalOrderWrites: 0,
    })
    await completeCommerceOrderHistoryBatchInPostgres({
      organizationId,
      receiptId: batch.receiptId,
      attemptToken: batch.attemptToken,
      result,
    })
    return response({ ok: true, replayed: false, result })
  } catch (error) {
    const maintenance = integrationCredentialRuntimeMaintenanceResponse(error)
    if (maintenance) return maintenance
    if (error instanceof Error && error.message === 'Unauthorized') {
      return response({
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Unauthorized',
      }, 401)
    }
    if (
      error instanceof Error
      && error.message === 'ACTIVE_ORGANIZATION_REQUIRED'
    ) {
      return response({
        ok: false,
        code: 'ACTIVE_ORGANIZATION_REQUIRED',
        error: 'Select an active organization first',
      }, 409)
    }
    if (error instanceof CommerceOrderHistoryBatchError) {
      return response({
        ok: false,
        code: error.code,
        error: error.message,
      }, error.status)
    }
    console.error('[commerce-order-history-sync] request failed', {
      code: safeFailureCode(error),
    })
    return response({
      ok: false,
      code: 'COMMERCE_ORDER_HISTORY_BATCH_FAILED',
      error: 'Exact provider-order history could not be refreshed',
    }, 500)
  }
}
