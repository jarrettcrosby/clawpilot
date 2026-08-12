import { randomUUID } from 'node:crypto'
import {
  FaireOrderRevisionError,
  inspectFaireCanonicalOrderRevision,
} from '@/lib/integrations/faireOrderRevision'
import {
  captureCommerceOrderRevisionObservationInPostgres,
  claimCommerceOrderRevisionTargetsInPostgres,
  failCommerceOrderRevisionTargetInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'

function safeErrorCode(error: unknown) {
  if (
    error instanceof FaireOrderRevisionError
    && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.code)
  ) return error.code
  return 'FAIRE_ORDER_REVISION_FAILED'
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
  const failureCodes: Record<string, number> = {}
  for (const claim of claims) {
    try {
      const evidence = await inspectFaireCanonicalOrderRevision(claim)
      const result = await captureCommerceOrderRevisionObservationInPostgres({
        claim,
        sourceRevision: evidence.sourceRevision,
        sourceHash: evidence.sourceHash,
        revisionHash: evidence.revisionHash,
        normalizedSnapshot: JSON.parse(
          JSON.stringify(evidence.snapshot),
        ) as Record<string, unknown>,
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
    provider: 'faire' as const,
    claimed: claims.length,
    captured,
    changed,
    failed,
    failureCodes,
    providerReadsPerCapture: 2 as const,
    providerWrites: 0 as const,
    canonicalOrderWrites: 0 as const,
    managerDispositionRequired: changed,
  }
}
