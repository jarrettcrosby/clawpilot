import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  shopifyInventoryRuntimeAvailable,
} from '@/lib/integrations/commerceInventory'
import {
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import { isPostgresStorageEnabled } from '@/lib/persistence/config'
import {
  recordShopifyInventoryRefreshWorkerHeartbeatInPostgres,
} from '@/lib/persistence/shopifyInventoryRefresh'
import {
  recordFaireInventoryPollWorkerHeartbeatInPostgres,
} from '@/lib/persistence/faireInventoryPolling'
import {
  faireInventoryPollingRuntimeAvailable,
  processFaireInventoryPollOutbox,
} from '@/lib/faireInventoryPollingWorker'
import {
  processShopifyInventoryRefreshOutbox,
} from '@/lib/shopifyInventoryRefreshWorker'
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
  return (
    left.length === right.length
    && crypto.timingSafeEqual(left, right)
  )
}

function runtimeMaintenanceResponse(error: unknown) {
  if (!isIntegrationCredentialRuntimeGateError(error)) return null
  const code = String((error as { code?: unknown }).code || '')
  return NextResponse.json({
    ok: false,
    maintenance: true,
    retryable: true,
    code,
    error: 'Integration credential runtime is temporarily unavailable',
  }, {
    status: 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Retry-After': '60',
    },
  })
}

async function maintainRouteCommerceStorageSafely() {
  try {
    return await maintainCommerceStorageInPostgres({
      workerId: 'commerce-inventory-process-route',
    })
  } catch (error) {
    return commerceStorageMaintenanceFailureResult(error)
  }
}

async function runShopifyLane(input: {
  limit?: number
  workerId: string
}) {
  try {
    await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
      phase: 'started',
      workerId: input.workerId,
      resource: 'inventory',
      readOnly: true,
      providerWrites: 0,
      orderQuantityAdjustment: 0,
    })
    const result = await processShopifyInventoryRefreshOutbox(input)
    const heartbeat =
      await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
        phase: 'completed',
        workerId: input.workerId,
        ...result,
      })
    return { result, heartbeatAt: heartbeat.checkedAt }
  } catch (error) {
    await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
      phase: isIntegrationCredentialRuntimeGateError(error)
        ? 'maintenance'
        : 'failed',
      workerId: input.workerId,
      errorCode: isIntegrationCredentialRuntimeGateError(error)
        ? String((error as { code?: unknown }).code || '')
        : undefined,
      resource: 'inventory',
      readOnly: true,
      providerWrites: 0,
      orderQuantityAdjustment: 0,
    }).catch(() => undefined)
    throw error
  }
}

async function runFaireLane(input: {
  limit?: number
  workerId: string
}) {
  try {
    await recordFaireInventoryPollWorkerHeartbeatInPostgres({
      phase: 'started',
      workerId: input.workerId,
    })
    const result = await processFaireInventoryPollOutbox(input)
    const heartbeat = await recordFaireInventoryPollWorkerHeartbeatInPostgres({
      phase: 'completed',
      workerId: input.workerId,
      ...result,
    })
    return { result, heartbeatAt: heartbeat.checkedAt }
  } catch (error) {
    await recordFaireInventoryPollWorkerHeartbeatInPostgres({
      phase: isIntegrationCredentialRuntimeGateError(error)
        ? 'maintenance'
        : 'failed',
      workerId: input.workerId,
      errorCode: isIntegrationCredentialRuntimeGateError(error)
        ? String((error as { code?: unknown }).code || '')
        : undefined,
    }).catch(() => undefined)
    throw error
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 },
    )
  }
  const postgresEnabled = isPostgresStorageEnabled()
  const commerceStorageMaintenance = postgresEnabled
    ? await maintainRouteCommerceStorageSafely()
    : null
  const shopifyEnabled = shopifyInventoryRuntimeAvailable()
  const faireEnabled = faireInventoryPollingRuntimeAvailable()
  if (!shopifyEnabled && !faireEnabled) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'shopify-inventory-disabled',
      commerceStorageMaintenance,
    })
  }
  if (!postgresEnabled) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Commerce inventory workers require Postgres storage',
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
  const [shopifyLane, faireLane] = await Promise.allSettled([
    shopifyEnabled
      ? runShopifyLane({ limit: body.limit, workerId })
      : Promise.resolve(null),
    faireEnabled
      ? runFaireLane({ limit: body.limit, workerId })
      : Promise.resolve(null),
  ])
  // Both bounded lanes always settle before either error is rethrown, so a
  // provider-specific failure cannot prevent the other provider from working.
  if (shopifyLane.status === 'rejected') {
    const maintenance = runtimeMaintenanceResponse(shopifyLane.reason)
    if (maintenance) return maintenance
  }
  if (faireLane.status === 'rejected') {
    const maintenance = runtimeMaintenanceResponse(faireLane.reason)
    if (maintenance) return maintenance
  }
  if (shopifyLane.status === 'rejected') throw shopifyLane.reason
  if (faireLane.status === 'rejected') throw faireLane.reason
  const shopify = shopifyLane.value?.result || null
  const faire = faireLane.value?.result || null
  if (!shopify && faire) {
    return NextResponse.json({
      ok: true,
      // The poller reads top-level counters. When only Faire is enabled its
      // real work must remain observable rather than looking globally skipped.
      ...faire,
      shopify: {
        skipped: true,
        reason: 'shopify-inventory-disabled',
      },
      faire,
      routeCommerceStorageMaintenance: commerceStorageMaintenance,
      heartbeatAt: faireLane.value?.heartbeatAt || null,
    })
  }
  return NextResponse.json({
    ok: true,
    // Preserve the established Shopify top-level response while adding the
    // separately bounded Faire observation lane.
    ...shopify,
    shopify,
    faire: faire || {
      skipped: true,
      reason: 'faire-inventory-disabled',
    },
    routeCommerceStorageMaintenance: commerceStorageMaintenance,
    heartbeatAt: shopifyLane.value?.heartbeatAt || null,
  })
}
