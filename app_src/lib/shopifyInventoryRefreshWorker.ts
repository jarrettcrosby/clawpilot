import { syncShopifyInventory } from '@/lib/integrations/commerceInventory'
import {
  claimShopifyInventoryRefreshJobsInPostgres,
  completeShopifyInventoryRefreshJobInPostgres,
  failShopifyInventoryRefreshJobInPostgres,
  parkShopifyInventoryRefreshForStoreSyncPauseInPostgres,
  queueAutomaticShopifyInventoryRefreshesInPostgres,
  recordShopifyInventoryRefreshWorkerHeartbeatInPostgres,
  renewShopifyInventoryRefreshJobLeaseInPostgres,
} from '@/lib/persistence/shopifyInventoryRefresh'

function inventoryRefreshIdempotencyKey(jobId: string) {
  return `shopify-inventory-refresh:${jobId}`
}

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

export async function processShopifyInventoryRefreshOutbox(input: {
  limit?: number
  workerId: string
}) {
  const automatic = await queueAutomaticShopifyInventoryRefreshesInPostgres()
  let followUpQueued = 0
  const requestedLimit = Math.max(
    1,
    Math.min(Number(input.limit || 2), 10),
  )
  let claimed = 0
  let completed = 0
  let retried = 0
  let dead = 0
  let cancelled = 0
  let parked = 0
  for (let index = 0; index < requestedLimit; index += 1) {
    const [job] = await claimShopifyInventoryRefreshJobsInPostgres({
      limit: 1,
      workerId: input.workerId,
    })
    if (!job) break
    claimed += 1
    const idempotencyKey = inventoryRefreshIdempotencyKey(job.id)
    const expectedRefreshFence = {
      jobId: job.id,
      carrierServiceConfigId: job.carrierServiceConfigId,
      warehouseId: job.warehouseId,
      locationMappingId: job.locationMappingId,
      locationMappingRowVersion: job.locationMappingRowVersion,
      providerLocationId: job.providerLocationId,
      inventoryLocationId: job.inventoryLocationId,
      inventoryPoolId: job.inventoryPoolId,
      credentialGeneration: job.credentialGeneration,
      activationRevision: job.activationRevision,
      configRowVersion: job.configRowVersion,
      policyRevision: job.policyRevision,
      policyHash: job.policyHash,
      inventoryMaxAgeSeconds: job.inventoryMaxAgeSeconds,
      requestedDirtyVersion: job.requestedDirtyVersion,
      lockToken: job.lockToken,
    }
    try {
      const progress = async (current: {
        phase: string
        pageCount?: number
      }) => {
        const leaseCurrent =
          await renewShopifyInventoryRefreshJobLeaseInPostgres(job)
        if (!leaseCurrent) {
          const stale = new Error(
            'Shopify inventory refresh authority changed during provider read',
          ) as Error & { code?: string }
          stale.code = 'SHOPIFY_INVENTORY_REFRESH_FENCE_CHANGED'
          throw stale
        }
        await recordShopifyInventoryRefreshWorkerHeartbeatInPostgres({
          phase: 'processing',
          jobId: job.id,
          accountGlobalId: job.accountGlobalId,
          providerReadPhase: current.phase,
          pageCount: current.pageCount || 0,
          resource: 'inventory',
          readOnly: true,
          providerWrites: 0,
          orderQuantityAdjustment: 0,
        })
      }
      const synced = await syncShopifyInventory({
        organizationId: job.organizationId,
        accountGlobalId: job.accountGlobalId,
        idempotencyKey,
        actorEmail: null,
        expectedRefreshFence,
        onProgress: progress,
      })
      const completion =
        await completeShopifyInventoryRefreshJobInPostgres({
          job,
          effectiveIdempotencyKey: synced.effectiveIdempotencyKey,
          inventoryRunGlobalId: synced.inventoryRunGlobalId,
        })
      if (completion.status === 'succeeded') {
        completed += 1
        if (completion.followUpRequired) {
          const followUp =
            await queueAutomaticShopifyInventoryRefreshesInPostgres()
          followUpQueued += followUp.queued
        }
      } else cancelled += 1
    } catch (error) {
      if (isStoreSyncReadPause(error)) {
        const disposition =
          await parkShopifyInventoryRefreshForStoreSyncPauseInPostgres({ job })
        if (disposition.parked) parked += 1
        else cancelled += 1
        continue
      }
      const failure = await failShopifyInventoryRefreshJobInPostgres({
        job,
        error,
      })
      if (failure.leaseLost) cancelled += 1
      else if (failure.dead) dead += 1
      else retried += 1
    }
  }
  return {
    autoQueued: automatic.queued + followUpQueued,
    autoCancelled: automatic.cancelled,
    claimed,
    completed,
    retried,
    dead,
    cancelled,
    parked,
    resource: 'inventory',
    readOnly: true,
    providerWrites: 0,
    orderQuantityAdjustment: 0,
  }
}
