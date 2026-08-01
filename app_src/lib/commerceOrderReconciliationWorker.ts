import { createHash } from 'node:crypto'
import { commerceIntakeRuntimeAvailable, executeCommerceOrderPage } from '@/lib/integrations/commerceIntake'
import {
  claimCommerceOrderReconciliationTargetsInPostgres,
  completeCommerceOrderReconciliationInPostgres,
  failCommerceOrderReconciliationInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'

function deterministicRunUuid(input: {
  organizationId: string
  accountGlobalId: string
  credentialVersion: number
  startedAt: string
}) {
  const bytes = Buffer.from(
    createHash('sha256').update(JSON.stringify(input)).digest().subarray(0, 16),
  )
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function deterministicContinuationUuid(input: {
  organizationId: string
  accountGlobalId: string
  credentialVersion: number
  continuationRunGlobalId: string
}) {
  return deterministicRunUuid({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    credentialVersion: input.credentialVersion,
    startedAt: `continuation:${input.continuationRunGlobalId}`,
  })
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function count(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function assertReadOnly(command: Record<string, unknown>) {
  if (
    command.providerWrites !== 0
    || command.syncCursorAdvanced !== false
    || count(command.canonicalOrdersCreated) !== 0
    || count(command.inventoryTouched) !== 0
  ) {
    const error = new Error('Commerce order reconciliation crossed a read-only fence') as Error & { code?: string }
    error.code = 'COMMERCE_ORDER_RECONCILIATION_WRITE_FENCE'
    throw error
  }
}

const MAX_PAGES_PER_RECONCILIATION = 10

/**
 * Follows the encrypted continuation chain to exhaustion. When a particularly
 * large account reaches the per-invocation page budget, its stored encrypted
 * continuation is claimed on the next poll instead of starting over.
 * It deliberately stages held candidates and normalization rejections;
 * it never promotes canonical orders, derives packages or shipments, changes
 * inventory, or calls a provider write API. Exact source-line quantities remain
 * in the held candidate for later cartonization. Historical backfill and
 * continuation remain explicit workflows.
 */
export async function processCommerceOrderReconciliation(input: {
  limit?: number
}) {
  if (!commerceIntakeRuntimeAvailable()) {
    return {
      skipped: true,
      reason: 'commerce-intake-disabled',
      claimed: 0,
      staged: 0,
      rejected: 0,
      failed: 0,
      leaseLost: 0,
      resource: 'orders',
      providerWrites: 0,
      canonicalOrderWrites: 0,
      inventoryWrites: 0,
      failureCodes: {},
    }
  }
  const targets = await claimCommerceOrderReconciliationTargetsInPostgres({
    limit: Math.max(1, Math.min(Number(input.limit || 1), 5)),
  })
  let staged = 0
  let rejected = 0
  let failed = 0
  let leaseLost = 0
  let pagesRead = 0
  let resumable = 0
  const failureCodes: Record<string, number> = {}
  for (const target of targets) {
    try {
      let continuationRunGlobalId = target.continuationRunGlobalId
      let continuationIdempotencyKey = target.continuationIdempotencyKey
      let targetPagesRead = 0
      let targetProviderRecordsSeen = 0
      let targetOrdersHeld = 0
      let targetRecordsRejected = 0
      let hasNextBatch = false
      while (targetPagesRead < MAX_PAGES_PER_RECONCILIATION) {
        const response = await executeCommerceOrderPage({
          organizationId: target.organizationId,
          accountGlobalId: target.accountGlobalId,
          actorEmail: 'system:commerce-order-reconciliation',
          idempotencyKey: continuationRunGlobalId
            ? (
                continuationIdempotencyKey
                || deterministicContinuationUuid({
                  organizationId: target.organizationId,
                  accountGlobalId: target.accountGlobalId,
                  credentialVersion: target.credentialVersion,
                  continuationRunGlobalId,
                })
              )
            : deterministicRunUuid({
                organizationId: target.organizationId,
                accountGlobalId: target.accountGlobalId,
                credentialVersion: target.credentialVersion,
                startedAt: `${target.startedAt}:${targetPagesRead}:first`,
              }),
          continuationRunGlobalId,
        })
        const command = record(response.command)
        assertReadOnly(command)
        const pagination = record(command.pagination)
        targetProviderRecordsSeen += count(pagination.providerRowsSeen)
        targetOrdersHeld += count(command.ordersStaged)
        targetRecordsRejected += count(command.recordsRejected)
        targetPagesRead += 1
        hasNextBatch = pagination.hasNextBatch === true
        const next = typeof pagination.continuationRunGlobalId === 'string'
          ? pagination.continuationRunGlobalId
          : null
        if (!hasNextBatch) {
          continuationRunGlobalId = null
          break
        }
        if (!next) {
          const error = new Error('Order page did not return a continuation handle') as Error & { code?: string }
          error.code = 'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_MISSING'
          throw error
        }
        continuationRunGlobalId = next
        // A new continuation has no prior read intent. Its deterministic key
        // remains stable across worker claims; a later claim instead receives
        // the exact original key when a captured read still needs staging.
        continuationIdempotencyKey = null
      }
      const completion = await completeCommerceOrderReconciliationInPostgres({
        target,
        providerRecordsSeen: targetProviderRecordsSeen,
        ordersHeld: targetOrdersHeld,
        recordsRejected: targetRecordsRejected,
        pagesRead: targetPagesRead,
        hasNextBatch,
      })
      if (completion.leaseLost) {
        leaseLost += 1
      } else {
        pagesRead += targetPagesRead
        staged += targetOrdersHeld
        rejected += targetRecordsRejected
        if (hasNextBatch) resumable += 1
      }
    } catch (error) {
      const failure = await failCommerceOrderReconciliationInPostgres({
        target,
        error,
      })
      if (failure.leaseLost) leaseLost += 1
      else {
        failed += 1
        failureCodes[failure.errorCode] =
          (failureCodes[failure.errorCode] || 0) + 1
      }
    }
  }
  return {
    skipped: false,
    claimed: targets.length,
    staged,
    rejected,
    failed,
    leaseLost,
    pagesRead,
    resumable,
    maxPagesPerReconciliation: MAX_PAGES_PER_RECONCILIATION,
    resource: 'orders',
    providerWrites: 0,
    canonicalOrderWrites: 0,
    inventoryWrites: 0,
    failureCodes,
  }
}
