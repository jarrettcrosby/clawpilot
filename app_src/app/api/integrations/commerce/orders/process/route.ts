import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { commerceIntakeRuntimeAvailable } from '@/lib/integrations/commerceIntake'
import {
  faireAutomaticExactRefreshHealthSnapshot,
  faireAutomaticOrderPromotionHealthSnapshot,
  faireUnattributedAttentionHealthSnapshot,
} from '@/lib/integrations/commerceFaireAutomaticPromotion'
import {
  shopifyAutomaticOrderPromotionHealthSnapshot,
} from '@/lib/integrations/commerceShopifyAutomaticPromotion'
import { processCommerceOrderReconciliation } from '@/lib/commerceOrderReconciliationWorker'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  readCommerceOrderReconciliationHealthFromPostgres,
  recordCommerceOrderReconciliationWorkerHeartbeatInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'

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
  if (!commerceIntakeRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'commerce-intake-disabled',
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
    localCanonicalOrderWritesPossible: true,
    providerWrites: 0,
    ...startedAttentionHealth,
  })
  try {
    const result = await processCommerceOrderReconciliation({ limit: body.limit })
    const completedAttentionHealth = mergeDurableAutomaticAttentionHealth(
      result,
      await durableAutomaticAttentionHealth(),
    )
    const completedResult = {
      ...result,
      ...completedAttentionHealth,
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
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    const failedAttentionHealth = await durableAutomaticAttentionHealth()
    await recordCommerceOrderReconciliationWorkerHeartbeatInPostgres({
      phase: 'failed',
      workerId,
      providerReadOnly: true,
      localCanonicalOrderWritesPossible: true,
      providerWrites: 0,
      ...failedAttentionHealth,
    }).catch(() => undefined)
    throw error
  }
}
