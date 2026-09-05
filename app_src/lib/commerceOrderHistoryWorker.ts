import { readCommerceOrderHistoryPage } from '@/lib/integrations/commerceOrderHistory'
import { SHOPIFY_HISTORY_PAGE_MAX_PROVIDER_READS } from '@/lib/integrations/commerceOrderHistoryReadLimits'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  appendCommerceOrderBackfillPageInPostgres,
  claimCommerceOrderBackfillsInPostgres,
  ensureContinuousCommerceOrderPollsInPostgres,
  failCommerceOrderBackfillInPostgres,
  materializeDeferredCommerceOrderHistoryRefreshesInPostgres,
  parkCommerceOrderBackfillForRuntimeMaintenanceInPostgres,
  parkCommerceOrderBackfillForStoreSyncPauseInPostgres,
  readCommerceOrderBackfillCursorFromPostgres,
  readCommerceOrderSyncCursorKeyReadinessFromPostgres,
  readCommerceOrderSyncHealthFromPostgres,
  redactExpiredCommerceOrderSensitiveEvidenceInPostgres,
} from '@/lib/persistence/commerceOrderSync'
import {
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

// One Shopify page is bounded to token + identity + list + one exact order
// and two optional native-activity pages. Failed attempts reserve the envelope because the adapter
// cannot report how many provider reads completed before it rejected.
const MAX_PROVIDER_READS_PER_PAGE = SHOPIFY_HISTORY_PAGE_MAX_PROVIDER_READS
const MAX_PAGE_ATTEMPTS_PER_RUN = 24
const MAX_PROVIDER_READ_RESERVATIONS_PER_RUN =
  MAX_PROVIDER_READS_PER_PAGE * MAX_PAGE_ATTEMPTS_PER_RUN
const PROVIDER_DRAIN_CLAIM_WINDOW_MS = 90_000

export const commerceOrderHistoryWorkerLimits = Object.freeze({
  maxPageAttemptsPerRun: MAX_PAGE_ATTEMPTS_PER_RUN,
  maxProviderReadReservationsPerRun:
    MAX_PROVIDER_READ_RESERVATIONS_PER_RUN,
  providerDrainClaimWindowMs: PROVIDER_DRAIN_CLAIM_WINDOW_MS,
  maxProviderReadsPerShopifyPage: MAX_PROVIDER_READS_PER_PAGE,
  maxProviderReadsPerFairePage: 2,
  providerWrites: 0 as const,
})

function providerReadLimit(provider: 'shopify' | 'faire') {
  return provider === 'shopify' ? MAX_PROVIDER_READS_PER_PAGE : 2
}

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

function assertBoundedProviderReads(input: {
  provider: 'shopify' | 'faire'
  providerReads: number
}) {
  const minimum = input.provider === 'shopify' ? 3 : 2
  const maximum = providerReadLimit(input.provider)
  if (
    !Number.isSafeInteger(input.providerReads)
    || input.providerReads < minimum
    || input.providerReads > maximum
  ) {
    throw new Error('Commerce order history provider read budget changed')
  }
}

export async function processCommerceOrderHistory(input: {
  workerId: string
  limit?: number
}) {
  const startedAt = Date.now()
  const claimDeadline = startedAt + PROVIDER_DRAIN_CLAIM_WINDOW_MS
  const limit = Math.max(1, Math.min(Number(input.limit || 1), 2))
  const sensitiveEvidenceRedaction =
    await redactExpiredCommerceOrderSensitiveEvidenceInPostgres({ limit: 250 })
  assertIntegrationCredentialProviderIoReady()
  // Full-history intent has priority over opening a new continuous-poll slot.
  // The second pass below consumes an intent released by a poll that reaches a
  // terminal state during this same drain.
  const deferredBeforeClaim =
    await materializeDeferredCommerceOrderHistoryRefreshesInPostgres({ limit })
  const continuousScheduling =
    await ensureContinuousCommerceOrderPollsInPostgres({ limit })
  let succeeded = 0
  let continued = 0
  let failed = 0
  let blocked = 0
  let dead = 0
  let providerReads = 0
  let providerRecordsSeen = 0
  let observationsAppended = 0
  let observationsPreserved = 0
  let claimed = 0
  let claimWaves = 0
  let pageAttempts = 0
  let providerReadReservations = 0
  let failurePersistenceErrors = 0
  let parked = 0
  const initialClaimWithinDeadline = Date.now() < claimDeadline
  let drainStopReason:
    | 'deadline'
    | 'page_limit'
    | 'provider_read_limit'
    | 'queue_empty'
    | 'terminal' = initialClaimWithinDeadline ? 'queue_empty' : 'deadline'
  let jobs = [] as Awaited<ReturnType<
    typeof claimCommerceOrderBackfillsInPostgres
  >>
  if (initialClaimWithinDeadline) {
    assertIntegrationCredentialProviderIoReady()
    jobs = await claimCommerceOrderBackfillsInPostgres({
      workerId: input.workerId,
      limit,
    })
  }

  while (jobs.length) {
    claimWaves += 1
    claimed += jobs.length
    let waveHasContinuation = false
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
      const job = jobs[jobIndex]
      // A wave is only claimed when enough page and worst-case provider-read
      // budget remains for every lease. Never abandon a claimed lease merely
      // because the deadline passes while its provider read is in flight.
      pageAttempts += 1
      providerReadReservations += MAX_PROVIDER_READS_PER_PAGE
      try {
        const providerCursor =
          await readCommerceOrderBackfillCursorFromPostgres(job)
        const captured = await withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: job.organizationId,
          integrationAccountId: job.integrationAccountId,
          authorityKind: 'automatic',
          readKind: 'order_history',
          intentKey: `${job.id}:${job.lockToken}:${job.pageCount + 1}`,
          acquiredBy: input.workerId,
          read: async (providerReadLease) => {
            const page = await readCommerceOrderHistoryPage({
              organizationId: job.organizationId,
              accountGlobalId: job.accountGlobalId,
              expectedCredentialGeneration: job.credentialGeneration,
              requestedFrom: job.requestedFrom,
              requestedThrough: job.requestedThrough,
              providerCursor,
              mode: job.sessionKind,
            })
            if (page.provider !== job.provider || page.providerWrites !== 0) {
              throw new Error('Commerce order history provider authority changed')
            }
            assertBoundedProviderReads({
              provider: job.provider,
              providerReads: page.providerReads,
            })
            const result = await appendCommerceOrderBackfillPageInPostgres({
              job,
              providerReadLease,
              pageNumber: job.pageCount + 1,
              providerRecordsSeen: page.providerRowsSeen,
              observations: page.observations,
              hasNextPage: page.nextProviderCursor !== null,
              nextProviderCursor: page.nextProviderCursor,
              readAllOrdersScopeObserved: page.readAllOrdersScopeObserved,
              returnHistoryScopeObserved: page.returnHistoryScopeObserved,
            })
            return { page, result }
          },
        })
        const { page, result } = captured
        providerReads += page.providerReads
        providerRecordsSeen += page.providerRowsSeen
        observationsAppended += result.appended
        observationsPreserved += result.preserved
        if (result.status === 'succeeded') succeeded += 1
        else {
          continued += 1
          waveHasContinuation = true
        }
      } catch (error) {
        if (isIntegrationCredentialRuntimeGateError(error)) {
          await Promise.allSettled(jobs.slice(jobIndex).map(async (claimedJob) => (
            await parkCommerceOrderBackfillForRuntimeMaintenanceInPostgres({
              job: claimedJob,
              errorCode: String((error as { code?: unknown }).code || ''),
            })
          )))
          throw error
        }
        if (isStoreSyncReadPause(error)) {
          const disposition =
            await parkCommerceOrderBackfillForStoreSyncPauseInPostgres({ job })
          if (disposition.parked) parked += 1
          else failurePersistenceErrors += 1
          continue
        }
        try {
          const result = await failCommerceOrderBackfillInPostgres({ job, error })
          failed += 'status' in result && result.status === 'failed' ? 1 : 0
          blocked += 'status' in result && result.status === 'blocked' ? 1 : 0
          dead += 'status' in result && result.status === 'dead' ? 1 : 0
        } catch {
          // Continue handling the rest of this already-claimed wave. The
          // unresolved lease will expire durably and health will expose it;
          // aborting here would unnecessarily strand every later lease too.
          failurePersistenceErrors += 1
        }
      }
    }

    if (!waveHasContinuation) {
      drainStopReason = 'terminal'
      break
    }
    if (Date.now() >= claimDeadline) {
      drainStopReason = 'deadline'
      break
    }
    const remainingPages = MAX_PAGE_ATTEMPTS_PER_RUN - pageAttempts
    if (remainingPages <= 0) {
      drainStopReason = 'page_limit'
      break
    }
    const remainingReadReservations =
      MAX_PROVIDER_READ_RESERVATIONS_PER_RUN - providerReadReservations
    if (remainingReadReservations < MAX_PROVIDER_READS_PER_PAGE) {
      drainStopReason = 'provider_read_limit'
      break
    }
    const nextLimit = Math.min(
      limit,
      remainingPages,
      Math.floor(remainingReadReservations / MAX_PROVIDER_READS_PER_PAGE),
    )
    assertIntegrationCredentialProviderIoReady()
    jobs = await claimCommerceOrderBackfillsInPostgres({
      workerId: input.workerId,
      limit: nextLimit,
    })
    if (!jobs.length) drainStopReason = 'queue_empty'
  }
  assertIntegrationCredentialProviderIoReady()
  const deferredAfterDrain =
    await materializeDeferredCommerceOrderHistoryRefreshesInPostgres({ limit })
  const [health, cursorKeyReadiness] = await Promise.all([
    readCommerceOrderSyncHealthFromPostgres(),
    readCommerceOrderSyncCursorKeyReadinessFromPostgres(),
  ])
  return {
    scheduled: continuousScheduling.scheduled,
    deferredHistoricalRefreshes: {
      beforeClaim: deferredBeforeClaim.materialized,
      afterDrain: deferredAfterDrain.materialized,
      materialized:
        deferredBeforeClaim.materialized + deferredAfterDrain.materialized,
      skipped: deferredBeforeClaim.skipped + deferredAfterDrain.skipped,
      providerWrites: 0 as const,
    },
    claimed,
    claimWaves,
    pageAttempts,
    succeeded,
    continued,
    failed,
    blocked,
    dead,
    providerReads,
    providerRecordsSeen,
    observationsAppended,
    observationsPreserved,
    providerReadReservations,
    failurePersistenceErrors,
    parked,
    drainStopReason,
    drainLimits: commerceOrderHistoryWorkerLimits,
    sensitiveEvidenceRedaction,
    health,
    cursorKeyReadiness,
    pollingCadenceMinutes: { shopify: 30, faire: 5 } as const,
    providerReadOnly: true,
    operationsOrderWrites: 0 as const,
    providerWrites: 0 as const,
  }
}
