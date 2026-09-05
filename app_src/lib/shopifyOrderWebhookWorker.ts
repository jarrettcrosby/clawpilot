import { SHOPIFY_EXACT_HISTORY_MAX_PROVIDER_READS } from '@/lib/integrations/commerceOrderHistoryReadLimits'
import {
  readExactShopifyOrderHistoryObservation,
} from '@/lib/integrations/commerceOrderHistory'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  appendShopifyOrderWebhookExactReadInPostgres,
  assertShopifyOrderWebhookClaimCurrentForProviderReadInPostgres,
  claimShopifyOrderWebhookTargetsInPostgres,
  failShopifyOrderWebhookExactReadInPostgres,
  parkShopifyOrderWebhookExactReadForRuntimeMaintenanceInPostgres,
  parkShopifyOrderWebhookExactReadForStoreSyncPauseInPostgres,
} from '@/lib/persistence/shopifyOrderWebhookSignals'
import {
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

const MAX_TARGETS_PER_RUN = 5
const PROVIDER_READS_PER_TARGET = SHOPIFY_EXACT_HISTORY_MAX_PROVIDER_READS

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
    || code === 'SHOPIFY_ORDER_WEBHOOK_PROVIDER_READ_FENCE_CHANGED'
}

export const shopifyOrderWebhookWorkerLimits = Object.freeze({
  maxTargetsPerRun: MAX_TARGETS_PER_RUN,
  providerReadsPerTarget: PROVIDER_READS_PER_TARGET,
  maxProviderReadReservationsPerRun:
    MAX_TARGETS_PER_RUN * PROVIDER_READS_PER_TARGET,
  providerWrites: 0 as const,
})

/**
 * Drain a bounded event-driven Shopify exact-read wave. The 60-second order
 * process loop invokes this independently from the 30-minute scheduled Shopify
 * history poll, which remains the durable missed-event backstop.
 */
export async function processShopifyOrderWebhookSignals(input: {
  workerId: string
  limit?: number
}) {
  const limit = Math.max(
    1,
    Math.min(Number(input.limit || 1), MAX_TARGETS_PER_RUN),
  )
  assertIntegrationCredentialProviderIoReady()
  const claims = await claimShopifyOrderWebhookTargetsInPostgres({
    workerId: input.workerId,
    limit,
  })
  let succeeded = 0
  let failed = 0
  let dead = 0
  let stale = 0
  let providerReads = 0
  let observationsAppended = 0
  let observationsPreserved = 0
  let linesAppended = 0
  let eventsAppended = 0
  let failurePersistenceErrors = 0
  let parked = 0
  for (let claimIndex = 0; claimIndex < claims.length; claimIndex += 1) {
    const claim = claims[claimIndex]
    try {
      await assertShopifyOrderWebhookClaimCurrentForProviderReadInPostgres(
        claim,
      )
      const completed = await withCommerceStoreSyncProviderReadFenceInPostgres({
        organizationId: claim.organizationId,
        integrationAccountId: claim.integrationAccountId,
        authorityKind: 'automatic',
        readKind: 'shopify_webhook_hydration',
        intentKey: `${claim.id}:${claim.lockToken}:${claim.capturedDirtyVersion}`,
        acquiredBy: input.workerId,
        read: async (providerReadLease) => {
          const read = await readExactShopifyOrderHistoryObservation({
            organizationId: claim.organizationId,
            accountGlobalId: claim.accountGlobalId,
            expectedCredentialGeneration: claim.credentialGeneration,
            externalOrderId: claim.externalOrderId,
            observationKind: 'webhook_exact_read',
          })
          if (
            read.provider !== 'shopify'
            || !Number.isSafeInteger(read.providerReads)
            || read.providerReads < 3 || read.providerReads > PROVIDER_READS_PER_TARGET
            || read.providerWrites !== 0
            || read.observation.externalOrderId !== claim.externalOrderId
            || read.observation.observationKind !== 'webhook_exact_read'
          ) {
            throw new Error('Shopify order webhook exact-read authority changed')
          }
          return appendShopifyOrderWebhookExactReadInPostgres({
            claim,
            providerReadLease,
            observation: read.observation,
            readAllOrdersScopeObserved: read.readAllOrdersScopeObserved,
            returnHistoryScopeObserved: read.returnHistoryScopeObserved,
          })
        },
      })
      succeeded += 1
      providerReads += completed.providerReads
      observationsAppended += completed.appended
      observationsPreserved += completed.preserved
      linesAppended += completed.linesAppended
      eventsAppended += completed.eventsAppended
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) {
        await Promise.allSettled(claims.slice(claimIndex).map(async (claimedTarget) => (
          await parkShopifyOrderWebhookExactReadForRuntimeMaintenanceInPostgres({
            claim: claimedTarget,
            errorCode: String((error as { code?: unknown }).code || ''),
          })
        )))
        throw error
      }
      if (isStoreSyncReadPause(error)) {
        const disposition =
          await parkShopifyOrderWebhookExactReadForStoreSyncPauseInPostgres({
            claim,
          })
        if (disposition.parked) parked += 1
        else stale += 1
        continue
      }
      try {
        const result = await failShopifyOrderWebhookExactReadInPostgres({
          claim,
          error,
        })
        if (result.status === 'dead') dead += 1
        else if (result.status === 'failed') failed += 1
        else stale += 1
      } catch {
        // Leave the exact captured lease to expire. The next process loop can
        // reclaim it; never abandon later claims in this bounded wave.
        failurePersistenceErrors += 1
      }
    }
  }
  return Object.freeze({
    claimed: claims.length,
    succeeded,
    failed,
    dead,
    stale,
    providerReads,
    providerReadReservations:
      claims.length * PROVIDER_READS_PER_TARGET,
    observationsAppended,
    observationsPreserved,
    linesAppended,
    eventsAppended,
    failurePersistenceErrors,
    parked,
    eventDrivenDrainCadenceSeconds: 60 as const,
    scheduledPollBackstopMinutes: 30 as const,
    providerReadOnly: true as const,
    operationsOrderWrites: 0 as const,
    providerWrites: 0 as const,
    limits: shopifyOrderWebhookWorkerLimits,
  })
}
