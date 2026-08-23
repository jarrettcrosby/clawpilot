import { randomUUID } from 'node:crypto'
import {
  FaireOrderRevisionError,
  inspectFaireCanonicalOrderRevision,
} from '@/lib/integrations/faireOrderRevision'
import {
  assertCommerceOrderRevisionStoreSyncRunningInPostgres,
  captureCommerceOrderRevisionObservationInPostgres,
  claimCommerceOrderRevisionTargetsInPostgres,
  CommerceOrderRevisionStoreSyncPausedError,
  failCommerceOrderRevisionTargetInPostgres,
  parkCommerceOrderRevisionTargetForStoreSyncPauseInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'
import {
  CommerceStoreSyncProviderReadFenceError,
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

function safeErrorCode(error: unknown) {
  if (
    error instanceof FaireOrderRevisionError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  if (error instanceof CommerceOrderRevisionStoreSyncPausedError) {
    return error.code
  }
  if (error instanceof CommerceStoreSyncProviderReadFenceError) {
    return error.code
  }
  return 'FAIRE_ORDER_REVISION_FAILED'
}

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

/**
 * Bounded exact-ID backstop for already-canonical Faire orders.
 *
 * Each claim performs only the adapter's exact brand and order reads, then
 * appends immutable local evidence. Material changes create or refresh the
 * shared manager-review exception and block downstream execution. This worker
 * never mutates the canonical order and never calls a Faire write endpoint.
 */
export async function processFaireOrderRevisions(input: {
  workerId?: string
  limit?: number
} = {}) {
  const workerId = String(input.workerId || (
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || randomUUID()
  )).slice(0, 200)
  const claims = await claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'faire',
    workerId,
    limit: Math.max(1, Math.min(Number(input.limit || 2), 25)),
  })
  let captured = 0
  let changed = 0
  let failed = 0
  let parked = 0
  const failureCodes: Record<string, number> = {}
  for (const claim of claims) {
    try {
      await assertCommerceOrderRevisionStoreSyncRunningInPostgres(claim)
      const result =
        await withCommerceStoreSyncProviderReadFenceInPostgres({
          organizationId: claim.organizationId,
          integrationAccountId: claim.integrationAccountId,
          authorityKind: 'automatic',
          readKind: 'order_revision',
          intentKey: `${claim.targetId}:${claim.leaseToken}`,
          acquiredBy: workerId,
          read: async (providerReadLease) => {
            const evidence = await inspectFaireCanonicalOrderRevision(claim)
            return captureCommerceOrderRevisionObservationInPostgres({
              claim,
              providerReadLease,
              sourceRevision: evidence.sourceRevision,
              sourceHash: evidence.sourceHash,
              revisionHash: evidence.revisionHash,
              normalizedSnapshot: JSON.parse(
                JSON.stringify(evidence.snapshot),
              ) as Record<string, unknown>,
              protectedParty: evidence.protectedParty,
              protectedShipTo: evidence.protectedShipTo,
              providerReads: evidence.providerReads,
              providerWrites: 0,
              observedAt: evidence.snapshot.observedAt,
            })
          },
        })
      captured += 1
      if (result.changed) changed += 1
    } catch (error) {
      if (
        error instanceof CommerceOrderRevisionStoreSyncPausedError
        || isStoreSyncReadPause(error)
      ) {
        if (await parkCommerceOrderRevisionTargetForStoreSyncPauseInPostgres({
          claim,
          workerId,
        })) parked += 1
        continue
      }
      const errorCode = safeErrorCode(error)
      failureCodes[errorCode] = (failureCodes[errorCode] || 0) + 1
      failed += 1
      await failCommerceOrderRevisionTargetInPostgres({
        claim,
        workerId,
        errorCode,
      })
    }
  }
  return {
    provider: 'faire' as const,
    claimed: claims.length,
    captured,
    changed,
    failed,
    parked,
    failureCodes,
    providerReadsPerCapture: 2 as const,
    providerWrites: 0 as const,
    canonicalOrderWrites: 0 as const,
    managerDispositionRequired: changed,
  }
}
