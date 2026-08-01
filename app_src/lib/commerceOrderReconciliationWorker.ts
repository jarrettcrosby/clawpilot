import { createHash } from 'node:crypto'
import { commerceIntakeRuntimeAvailable, executeCommerceOrderPage } from '@/lib/integrations/commerceIntake'
import {
  claimCommerceOrderReconciliationTargetsInPostgres,
  completeCommerceOrderReconciliationInPostgres,
  failCommerceOrderReconciliationInPostgres,
  projectCommerceOrderReconciliationPageInPostgres,
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
  const automaticCustomerResolution = record(
    command.automaticCustomerResolution,
  )
  if (
    command.providerWrites !== 0
    || command.syncCursorAdvanced !== false
    || count(command.canonicalOrdersCreated) !== 0
    || count(command.inventoryTouched) !== 0
    || (
      Object.keys(automaticCustomerResolution).length > 0
      && (
        automaticCustomerResolution.providerWrites !== 0
        || automaticCustomerResolution.syncCursorAdvanced !== false
      )
    )
  ) {
    const error = new Error('Commerce order reconciliation crossed a read-only fence') as Error & { code?: string }
    error.code = 'COMMERCE_ORDER_RECONCILIATION_WRITE_FENCE'
    throw error
  }
}

const MAX_PAGES_PER_RECONCILIATION = 5
const MAX_PROVIDER_RECORDS_PER_RECONCILIATION = 250
const MAX_RECONCILIATION_RUNTIME_MS = 180_000
const MIN_REMAINING_RUNTIME_FOR_PAGE_MS = 30_000
const PROVIDER_PAGE_RECORD_LIMIT = {
  shopify: 25,
  faire: 50,
} as const

function configuredInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = String(process.env[name] || '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback
}

// Faire does not expose a safe immutable order timestamp fence equivalent to
// Shopify's query window. Keep a high emergency ceiling for malformed/live
// cursor chains while valid large catalogs continue across bounded invocations.
const MAX_PAGES_PER_SESSION = configuredInteger(
  'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_PAGES',
  2_000,
  100,
  10_000,
)
const MAX_PROVIDER_RECORDS_PER_SESSION = configuredInteger(
  'CLAWPILOT_COMMERCE_ORDER_MAX_SESSION_RECORDS',
  100_000,
  5_000,
  1_000_000,
)

function reconciliationError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

/**
 * Follows the encrypted continuation chain within strict invocation and
 * session budgets. A bounded invocation stores its continuation for the next
 * poll; a session that is too large fails closed for operator review.
 * It deliberately stages held candidates and normalization rejections;
 * it never promotes canonical orders, derives packages or shipments, changes
 * inventory, or calls a provider write API. Exact source-line quantities remain
 * in the held candidate for later cartonization. Historical backfill and
 * continuation remain explicit workflows.
 */
export async function processCommerceOrderReconciliation(input: {
  limit?: number
  /** Deterministic test seam; API callers never supply this. */
  clock?: () => number
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
      automaticCustomerResolution: {
        matched: 0,
        created: 0,
        ambiguous: 0,
        skipped: 0,
        failed: 0,
        failedByCode: {},
        operatorReviewRequired: 0,
        providerWrites: 0,
        syncCursorAdvanced: false,
      },
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
  let pageBudgetStops = 0
  let recordBudgetStops = 0
  let timeBudgetStops = 0
  let customersMatched = 0
  let customersCreated = 0
  let customersAmbiguous = 0
  let customersSkipped = 0
  let customerResolutionFailed = 0
  const customerResolutionFailureCodes: Record<string, number> = {}
  const failureCodes: Record<string, number> = {}
  const clock = input.clock || Date.now
  for (const claimedTarget of targets) {
    let target = claimedTarget
    try {
      const targetStartedAtMs = clock()
      let continuationRunGlobalId = target.continuationRunGlobalId
      let continuationIdempotencyKey = target.continuationIdempotencyKey
      let targetPagesRead = 0
      let targetProviderRecordsSeen = 0
      let targetOrdersHeld = 0
      let targetRecordsRejected = 0
      let targetCustomersMatched = 0
      let targetCustomersCreated = 0
      let targetCustomersAmbiguous = 0
      let targetCustomersSkipped = 0
      let targetCustomerResolutionFailed = 0
      const targetCustomerResolutionFailureCodes: Record<string, number> = {}
      let hasNextBatch = false
      let budgetStopReason: 'page' | 'records' | 'time' | null = null
      let priorBatchNumber = target.continuationBatchNumber
      const seenRunGlobalIds = new Set<string>()
      if (continuationRunGlobalId) {
        seenRunGlobalIds.add(continuationRunGlobalId)
      }
      if (
        target.recordsSeen >= MAX_PROVIDER_RECORDS_PER_SESSION
        && continuationRunGlobalId
      ) {
        throw reconciliationError(
          'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
          'Order reconciliation session reached its provider-record budget',
        )
      }
      if (
        priorBatchNumber !== null
        && priorBatchNumber >= MAX_PAGES_PER_SESSION
      ) {
        throw reconciliationError(
          'COMMERCE_ORDER_RECONCILIATION_SESSION_PAGE_BUDGET_EXCEEDED',
          'Order reconciliation session reached its provider-page budget',
        )
      }
      while (true) {
        if (targetPagesRead >= MAX_PAGES_PER_RECONCILIATION) {
          budgetStopReason = 'page'
          break
        }
        const maximumNextPageRecords = PROVIDER_PAGE_RECORD_LIMIT[target.provider]
        if (
          targetProviderRecordsSeen + maximumNextPageRecords
          > MAX_PROVIDER_RECORDS_PER_RECONCILIATION
        ) {
          budgetStopReason = 'records'
          break
        }
        if (
          targetPagesRead > 0
          && clock() - targetStartedAtMs
            >= MAX_RECONCILIATION_RUNTIME_MS
              - MIN_REMAINING_RUNTIME_FOR_PAGE_MS
        ) {
          budgetStopReason = 'time'
          break
        }
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
        const pagination = record(command.pagination)
        const automaticCustomerResolution = record(
          command.automaticCustomerResolution,
        )
        const pageProviderRecordsSeen = count(pagination.providerRowsSeen)
        targetProviderRecordsSeen += pageProviderRecordsSeen
        targetOrdersHeld += count(command.ordersStaged)
        targetRecordsRejected += count(command.recordsRejected)
        targetCustomersMatched += count(automaticCustomerResolution.matched)
        targetCustomersCreated += count(automaticCustomerResolution.created)
        targetCustomersAmbiguous += count(automaticCustomerResolution.ambiguous)
        targetCustomersSkipped += count(automaticCustomerResolution.skipped)
        targetCustomerResolutionFailed += count(
          automaticCustomerResolution.failed,
        )
        const failedByCode = record(automaticCustomerResolution.failedByCode)
        for (const [code, value] of Object.entries(failedByCode)) {
          if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
          targetCustomerResolutionFailureCodes[code] = (
            targetCustomerResolutionFailureCodes[code] || 0
          ) + count(value)
        }
        targetPagesRead += 1
        const stagedRunGlobalId = typeof pagination.runGlobalId === 'string'
          ? pagination.runGlobalId
          : ''
        if (!/^gcir[0-9]{7}$/u.test(stagedRunGlobalId)) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
            'Order reconciliation staged page identity is invalid',
          )
        }
        const projection =
          await projectCommerceOrderReconciliationPageInPostgres({
            target,
            runGlobalId: stagedRunGlobalId,
          })
        if (projection.leaseLost || !projection.startedAt) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_LEASE_LOST',
            'Order reconciliation lease was lost during the provider read',
          )
        }
        target = {
          ...target,
          startedAt: projection.startedAt,
          recordsSeen: projection.recordsSeen,
          recordsHeld: projection.recordsHeld,
          continuationBatchNumber: projection.continuationBatchNumber,
        }
        assertReadOnly(command)
        if (pageProviderRecordsSeen > maximumNextPageRecords) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_PAGE_RECORD_LIMIT_EXCEEDED',
            'Order reconciliation provider page exceeded its record limit',
          )
        }
        if (projection.providerCursorRepeated) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_PROVIDER_CURSOR_REPEATED',
            'Order reconciliation provider repeated a pagination cursor',
          )
        }
        hasNextBatch = pagination.hasNextBatch === true
        const batchNumber = count(pagination.batchNumber)
        if (
          batchNumber < 1
          || projection.continuationBatchNumber !== batchNumber
          || (
            priorBatchNumber === null
              ? (
                  target.continuationRunGlobalId === null
                  && batchNumber !== 1
                )
              : batchNumber !== priorBatchNumber + 1
          )
        ) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_PAGE_SEQUENCE_INVALID',
            'Order reconciliation provider pages were not sequential',
          )
        }
        priorBatchNumber = batchNumber
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
        if (seenRunGlobalIds.has(next)) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
            'Order reconciliation repeated a continuation handle',
          )
        }
        seenRunGlobalIds.add(next)
        if (batchNumber >= MAX_PAGES_PER_SESSION) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_SESSION_PAGE_BUDGET_EXCEEDED',
            'Order reconciliation session reached its provider-page budget',
          )
        }
        if (target.recordsSeen >= MAX_PROVIDER_RECORDS_PER_SESSION) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
            'Order reconciliation session reached its provider-record budget',
          )
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
        customersMatched: targetCustomersMatched,
        customersCreated: targetCustomersCreated,
        customersAmbiguous: targetCustomersAmbiguous,
        customersSkipped: targetCustomersSkipped,
        customerResolutionFailed: targetCustomerResolutionFailed,
        customerResolutionFailureCodes: targetCustomerResolutionFailureCodes,
      })
      if (completion.leaseLost) {
        leaseLost += 1
      } else {
        pagesRead += targetPagesRead
        staged += targetOrdersHeld
        rejected += targetRecordsRejected
        customersMatched += targetCustomersMatched
        customersCreated += targetCustomersCreated
        customersAmbiguous += targetCustomersAmbiguous
        customersSkipped += targetCustomersSkipped
        customerResolutionFailed += targetCustomerResolutionFailed
        for (
          const [code, value]
          of Object.entries(targetCustomerResolutionFailureCodes)
        ) {
          customerResolutionFailureCodes[code] = (
            customerResolutionFailureCodes[code] || 0
          ) + value
        }
        if (hasNextBatch) resumable += 1
        if (budgetStopReason === 'page') pageBudgetStops += 1
        if (budgetStopReason === 'records') recordBudgetStops += 1
        if (budgetStopReason === 'time') timeBudgetStops += 1
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
    maxPagesPerSession: MAX_PAGES_PER_SESSION,
    maxProviderRecordsPerReconciliation:
      MAX_PROVIDER_RECORDS_PER_RECONCILIATION,
    maxProviderRecordsPerSession: MAX_PROVIDER_RECORDS_PER_SESSION,
    maxReconciliationRuntimeMs: MAX_RECONCILIATION_RUNTIME_MS,
    budgetStops: {
      pages: pageBudgetStops,
      records: recordBudgetStops,
      time: timeBudgetStops,
    },
    resource: 'orders',
    providerWrites: 0,
    canonicalOrderWrites: 0,
    inventoryWrites: 0,
    automaticCustomerResolution: {
      matched: customersMatched,
      created: customersCreated,
      ambiguous: customersAmbiguous,
      skipped: customersSkipped,
      failed: customerResolutionFailed,
      failedByCode: customerResolutionFailureCodes,
      operatorReviewRequired:
        customersAmbiguous + customersSkipped + customerResolutionFailed,
      providerWrites: 0,
      syncCursorAdvanced: false,
    },
    failureCodes,
  }
}
