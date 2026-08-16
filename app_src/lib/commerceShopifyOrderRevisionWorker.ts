import { randomUUID } from 'node:crypto'
import {
  inspectShopifyCanonicalOrderRevision,
  ShopifyOrderRevisionError,
} from '@/lib/integrations/shopifyOrderRevision'
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
    error instanceof ShopifyOrderRevisionError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  if (error instanceof CommerceOrderRevisionStoreSyncPausedError) {
    return error.code
  }
  if (error instanceof CommerceStoreSyncProviderReadFenceError) {
    return error.code
  }
  return 'SHOPIFY_ORDER_REVISION_FAILED'
}

function isStoreSyncReadPause(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

export async function processShopifyOrderRevisions(input: {
  workerId?: string
  limit?: number
} = {}) {
  const workerId = String(input.workerId || (
    process.env.RAILWAY_REPLICA_ID
    || process.env.HOSTNAME
    || randomUUID()
  )).slice(0, 200)
  const claims = await claimCommerceOrderRevisionTargetsInPostgres({
    provider: 'shopify',
    workerId,
    limit: Math.max(1, Math.min(Number(input.limit || 5), 25)),
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
            const evidence = await inspectShopifyCanonicalOrderRevision(claim)
            return captureCommerceOrderRevisionObservationInPostgres({
              claim,
              providerReadLease,
              sourceRevision: evidence.sourceRevision,
              sourceHash: evidence.sourceHash,
              revisionHash: evidence.revisionHash,
              normalizedSnapshot: JSON.parse(JSON.stringify(evidence.snapshot)) as Record<string, unknown>,
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
    provider: 'shopify' as const,
    claimed: claims.length,
    captured,
    changed,
    failed,
    parked,
    failureCodes,
    providerWrites: 0 as const,
    canonicalOrderWrites: 0 as const,
    managerDispositionRequired: changed,
  }
}
