import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  shopifyInventoryRuntimeAvailable,
} from '@/lib/integrations/commerceInventory'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  recordShopifyInventoryRefreshWorkerHeartbeatInPostgres,
} from '@/lib/persistence/shopifyInventoryRefresh'
import {
  processShopifyInventoryRefreshOutbox,
} from '@/lib/shopifyInventoryRefreshWorker'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: NextRequest) {
  const expected = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '')
  const provided = String(req.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
  if (expected.length < 32 || !provided) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  return (
    left.length === right.length
    && crypto.timingSafeEqual(left, right)
  )
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    )
  }
  if (!shopifyInventoryRuntimeAvailable()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'shopify-inventory-disabled',
    })
  }
  if (!isPostgresStorageEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Shopify inventory refresh requires Postgres storage',
      },
      { status: 409 },
    )
  }
  const body = await req.json().catch(() => ({})) as { limit?: number }
  const workerId = String(
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || crypto.randomUUID(),
  ).slice(0, 200)
  await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
    phase: 'started',
    workerId,
    resource: 'inventory',
    readOnly: true,
    providerWrites: 0,
    orderQuantityAdjustment: 0,
  })
  try {
    const result = await processShopifyInventoryRefreshOutbox({
      limit: body.limit,
      workerId,
    })
    const heartbeat =
      await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
        phase: 'completed',
        workerId,
        ...result,
      })
    return NextResponse.json({
      ok: true,
      ...result,
      heartbeatAt: heartbeat.checkedAt,
    })
  } catch (error) {
    await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
      phase: 'failed',
      workerId,
      resource: 'inventory',
      readOnly: true,
      providerWrites: 0,
      orderQuantityAdjustment: 0,
    }).catch(() => undefined)
    throw error
  }
}
