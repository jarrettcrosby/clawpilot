import { randomUUID } from 'node:crypto'
import {
  inspectShopifyCanonicalOrderRevision,
  ShopifyOrderRevisionError,
} from '@/lib/integrations/shopifyOrderRevision'
import {
  captureCommerceOrderRevisionObservationInPostgres,
  claimCommerceOrderRevisionTargetsInPostgres,
  failCommerceOrderRevisionTargetInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'

function safeErrorCode(error: unknown) {
  if (
    error instanceof ShopifyOrderRevisionError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  return 'SHOPIFY_ORDER_REVISION_FAILED'
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
  const failureCodes: Record<string, number> = {}
  for (const claim of claims) {
    try {
      const evidence = await inspectShopifyCanonicalOrderRevision(claim)
      const result = await captureCommerceOrderRevisionObservationInPostgres({
        claim,
        sourceRevision: evidence.sourceRevision,
        sourceHash: evidence.sourceHash,
        revisionHash: evidence.revisionHash,
        normalizedSnapshot: JSON.parse(JSON.stringify(evidence.snapshot)) as Record<string, unknown>,
        providerReads: evidence.providerReads,
        providerWrites: 0,
        observedAt: evidence.snapshot.observedAt,
      })
      captured += 1
      if (result.changed) changed += 1
    } catch (error) {
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
    failureCodes,
    providerWrites: 0 as const,
    canonicalOrderWrites: 0 as const,
    managerDispositionRequired: changed,
  }
}
