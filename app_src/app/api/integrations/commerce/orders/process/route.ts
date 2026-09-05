import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  commerceReadRuntimeAvailable,
  commerceReadRuntimeMode,
} from '@/lib/integrations/commerceIntake'
import {
  faireAutomaticExactRefreshHealthSnapshot,
  faireAutomaticOrderPromotionHealthSnapshot,
  faireUnattributedAttentionHealthSnapshot,
} from '@/lib/integrations/commerceFaireAutomaticPromotion'
import {
  shopifyAutomaticOrderPromotionHealthSnapshot,
} from '@/lib/integrations/commerceShopifyAutomaticPromotion'
import { processCommerceOrderReconciliation } from '@/lib/commerceOrderReconciliationWorker'
import { processCommerceOrderHistory } from '@/lib/commerceOrderHistoryWorker'
import {
  processShopifyOrderWebhookSignals,
} from '@/lib/shopifyOrderWebhookWorker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readCommerceOrderReconciliationHealthFromPostgres,
  recordCommerceOrderReconciliationWorkerHeartbeatInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'
import {
  purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  redactExpiredCommerceOrderSensitiveEvidenceInPostgres,
} from '@/lib/persistence/commerceOrderSync'
import {
  commerceStorageMaintenanceFailureResult,
  maintainCommerceStorageInPostgres,
} from '@/lib/persistence/commerceStorageMaintenance'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function maintainRouteCommerceStorageSafely() {
  try {
    return await maintainCommerceStorageInPostgres({
      workerId: 'commerce-orders-process-route',
    })
  } catch (error) {
    return commerceStorageMaintenanceFailureResult(error)
  }
}

function safeCommerceOrderHistoryFailureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
  return /^COMMERCE_ORDER_[A-Z0-9_]{1,96}$/u.test(code)
    ? code
    : 'COMMERCE_ORDER_HISTORY_WORKER_FAILED'
}

async function processCommerceOrderHistoryIsolated(input: {
  workerId: string
  limit?: number
}) {
  try {
    return await processCommerceOrderHistory(input)
  } catch (error) {
    return {
      degraded: true as const,
      errorCode: safeCommerceOrderHistoryFailureCode(error),
      providerReadOnly: true as const,
      operationsOrderWrites: 0 as const,
      providerWrites: 0 as const,
    }
  }
}

function safeShopifyOrderWebhookFailureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
  return /^SHOPIFY_ORDER_WEBHOOK_[A-Z0-9_]{1,96}$/u.test(code)
    ? code
    : 'SHOPIFY_ORDER_WEBHOOK_WORKER_FAILED'
}

async function processShopifyOrderWebhookSignalsIsolated(input: {
  workerId: string
  limit?: number
}) {
  try {
    return await processShopifyOrderWebhookSignals(input)
  } catch (error) {
    return {
      degraded: true as const,
      errorCode: safeShopifyOrderWebhookFailureCode(error),
      eventDrivenDrainCadenceSeconds: 60 as const,
      scheduledPollBackstopMinutes: 30 as const,
      providerReadOnly: true as const,
      operationsOrderWrites: 0 as const,
      providerWrites: 0 as const,
    }
  }
}

async function durableAutomaticAttentionHealth() {
  const health = await readCommerceOrderReconciliationHealthFromPostgres()
    .catch(() => null)
  const shopifyAttention = Number(
    health?.providerPromotionAttentionRequired.shopify || 0,
  )
  const fairePromotionAttention = Number(
    health?.providerPromotionAttentionRequired.faire || 0,
  )
  const faireExactRefreshAttention = Number(
    health?.faireExactRefreshAttentionRequired || 0,
  )
  const faireUnattributedAttention = Number(
    health?.faireUnattributedAttentionRequired || 0,
  )
  return {
    automaticShopifyOrderPromotion:
      shopifyAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          attentionRequiredAccounts: shopifyAttention,
          operatorReviewRequired: shopifyAttention,
        },
      }),
    automaticFaireOrderPromotion:
      faireAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          attentionRequiredAccounts: fairePromotionAttention,
          operatorReviewRequired: fairePromotionAttention,
        },
      }),
    automaticFaireExactRefresh:
      faireAutomaticExactRefreshHealthSnapshot({
        operatorReviewRequired: faireExactRefreshAttention,
      }),
    automaticFaireUnattributedAttention:
      faireUnattributedAttentionHealthSnapshot({
        attentionRequiredAccounts: faireUnattributedAttention,
        operatorReviewRequired: faireUnattributedAttention,
      }),
  }
}

function mergeDurableAutomaticAttentionHealth(
  result: Awaited<ReturnType<typeof processCommerceOrderReconciliation>>,
  durable: Awaited<ReturnType<typeof durableAutomaticAttentionHealth>>,
) {
  return {
    automaticShopifyOrderPromotion:
      shopifyAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          ...result.automaticShopifyOrderPromotion,
          attentionRequiredAccounts: Math.max(
            result.automaticShopifyOrderPromotion.attentionRequiredAccounts,
            durable.automaticShopifyOrderPromotion.attentionRequiredAccounts,
          ),
          operatorReviewRequired: Math.max(
            result.automaticShopifyOrderPromotion.operatorReviewRequired,
            durable.automaticShopifyOrderPromotion.operatorReviewRequired,
          ),
        },
      }),
    automaticFaireOrderPromotion:
      faireAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          ...result.automaticFaireOrderPromotion,
          attentionRequiredAccounts: Math.max(
            result.automaticFaireOrderPromotion.attentionRequiredAccounts,
            durable.automaticFaireOrderPromotion.attentionRequiredAccounts,
          ),
          operatorReviewRequired: Math.max(
            result.automaticFaireOrderPromotion.operatorReviewRequired,
            durable.automaticFaireOrderPromotion.operatorReviewRequired,
          ),
        },
      }),
    automaticFaireExactRefresh:
      faireAutomaticExactRefreshHealthSnapshot({
        ...result.automaticFaireExactRefresh,
        operatorReviewRequired: Math.max(
          result.automaticFaireExactRefresh.operatorReviewRequired,
          durable.automaticFaireExactRefresh.operatorReviewRequired,
        ),
      }),
    automaticFaireUnattributedAttention:
      faireUnattributedAttentionHealthSnapshot({
        ...result.automaticFaireUnattributedAttention,
        attentionRequiredAccounts: Math.max(
          result.automaticFaireUnattributedAttention
            .attentionRequiredAccounts,
          durable.automaticFaireUnattributedAttention
            .attentionRequiredAccounts,
        ),
        operatorReviewRequired: Math.max(
          result.automaticFaireUnattributedAttention.operatorReviewRequired,
          durable.automaticFaireUnattributedAttention.operatorReviewRequired,
        ),
      }),
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const commerceStorageMaintenance = isPostgresStorageEnabled()
    ? await maintainRouteCommerceStorageSafely()
    : null
  if (!commerceReadRuntimeAvailable()) {
    const [protectedSnapshotPurge, orderSensitiveEvidenceRedaction] =
      isPostgresStorageEnabled()
        ? await Promise.all([
            purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres(),
            redactExpiredCommerceOrderSensitiveEvidenceInPostgres(),
          ])
        : [null, null]
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'commerce-read-reconciliation-disabled',
      protectedSnapshotPurge,
      orderSensitiveEvidenceRedaction,
      commerceStorageMaintenance,
      automaticShopifyOrderPromotion:
        shopifyAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireOrderPromotion:
        faireAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireExactRefresh:
        faireAutomaticExactRefreshHealthSnapshot(),
      automaticFaireUnattributedAttention:
        faireUnattributedAttentionHealthSnapshot(),
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Commerce order reconciliation requires Postgres storage' },
      { status: 409 },
    )
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || crypto.randomUUID(),
  ).slice(0, 200)
  const startedAttentionHealth = await durableAutomaticAttentionHealth()
  await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId,
    providerReadOnly: true,
    localCanonicalOrderWritesPossible:
      commerceReadRuntimeMode?.() === 'development',
    runtimeMode: commerceReadRuntimeMode?.() || null,
    providerWrites: 0,
    ...startedAttentionHealth,
  })
  try {
    const [result, orderHistory] = await Promise.all([
      processCommerceOrderReconciliation({ limit: body.limit }),
      processCommerceOrderHistoryIsolated({ workerId, limit: body.limit }),
    ])
    // History may advance the shared order-observation policy revision. Drain
    // exact Shopify targets only after that transition so claim/append lineage
    // cannot be invalidated mid-read by this same process invocation.
    const shopifyOrderWebhooks =
      await processShopifyOrderWebhookSignalsIsolated({
        workerId,
        limit: body.limit,
      })
    const completedAttentionHealth = mergeDurableAutomaticAttentionHealth(
      result,
      await durableAutomaticAttentionHealth(),
    )
    const completedResult = {
      ...result,
      ...completedAttentionHealth,
      orderHistory,
      shopifyOrderWebhooks,
    }
    const heartbeat =
      await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
        phase: 'completed',
        workerId,
        ...completedResult,
      })
    return NextResponse.json({
      ok: true,
      ...completedResult,
      routeCommerceStorageMaintenance: commerceStorageMaintenance,
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    const failedAttentionHealth = await durableAutomaticAttentionHealth()
    await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
      phase: 'failed',
      workerId,
      providerReadOnly: true,
      localCanonicalOrderWritesPossible:
        commerceReadRuntimeMode?.() === 'development',
      runtimeMode: commerceReadRuntimeMode?.() || null,
      providerWrites: 0,
      ...failedAttentionHealth,
    }).catch(() => undefined)
    throw error
  }
}
