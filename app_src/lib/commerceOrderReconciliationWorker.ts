import { createHash } from 'node:crypto'
import {
  processFaireOrderRevisions,
} from '@/lib/commerceFaireOrderRevisionWorker'
import {
  processShopifyOrderRevisions,
} from '@/lib/commerceShopifyOrderRevisionWorker'
import {
  commerceReadRuntimeAvailable,
  commerceReadRuntimeMode,
  executeCommerceFaireOrderExactRefresh,
  executeCommerceOrderPage,
} from '@/lib/integrations/commerceIntake'
import {
  markAutomaticFaireOrderPromotionAttentionInPostgres,
  readAutomaticFaireExactRefreshTargetsInPostgres,
} from '@/lib/persistence/commerceIntake'
import {
  shopifyAutomaticOrderPromotionHealthSnapshot,
} from '@/lib/integrations/commerceShopifyAutomaticPromotion'
import {
  faireAutomaticExactRefreshHealthSnapshot,
  faireAutomaticOrderPromotionHealthSnapshot,
  faireUnattributedAttentionHealthSnapshot,
} from '@/lib/integrations/commerceFaireAutomaticPromotion'
import {
  claimCommerceOrderReconciliationTargetsInPostgres,
  completeCommerceOrderReconciliationInPostgres,
  failCommerceOrderReconciliationInPostgres,
  projectCommerceOrderReconciliationPageInPostgres,
} from '@/lib/persistence/commerceOrderReconciliation'
import {
  purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres,
} from '@/lib/persistence/commerceOrderRevisions'

const PROTECTED_SNAPSHOT_PURGE_LIMIT_PER_CYCLE = 250

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

function deterministicFaireExactRefreshUuid(input: {
  organizationId: string
  accountGlobalId: string
  credentialVersion: number
  candidateGlobalId: string
  sourceHash: string
  cohortHash: string
  notBefore: string
}) {
  return deterministicRunUuid({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    credentialVersion: input.credentialVersion,
    startedAt: [
      'faire-exact-refresh-v1',
      input.candidateGlobalId,
      input.sourceHash,
      input.cohortHash,
      input.notBefore,
    ].join(':'),
  })
}

function deterministicFaireAttentionUuid(input: {
  organizationId: string
  accountGlobalId: string
  credentialVersion: number
  candidateGlobalId: string
  sourceHash: string
  reasonCode: string
  cohortHash: string
  notBefore: string
}) {
  return deterministicRunUuid({
    organizationId: input.organizationId,
    accountGlobalId: input.accountGlobalId,
    credentialVersion: input.credentialVersion,
    startedAt: [
      'faire-auto-promotion-attention-v1',
      input.candidateGlobalId,
      input.sourceHash,
      input.reasonCode,
      input.cohortHash,
      input.notBefore,
    ].join(':'),
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

function assertReconciliationFence(
  command: Record<string, unknown>,
  productionReadOnly = false,
) {
  const automaticCustomerResolution = record(
    command.automaticCustomerResolution,
  )
  const automaticShopifyOrderPromotion = record(
    command.automaticShopifyOrderPromotion,
  )
  const automaticFaireOrderPromotion = record(
    command.automaticFaireOrderPromotion,
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
    || (
      productionReadOnly
      && (
        Object.keys(automaticCustomerResolution).length > 0
        || Object.keys(automaticShopifyOrderPromotion).length > 0
        || Object.keys(automaticFaireOrderPromotion).length > 0
      )
    )
    || (
      Object.keys(automaticShopifyOrderPromotion).length > 0
      && (
        automaticShopifyOrderPromotion.providerWrites !== 0
        || automaticShopifyOrderPromotion.inventoryWrites !== 0
        || automaticShopifyOrderPromotion.syncCursorAdvanced !== false
        || count(automaticShopifyOrderPromotion.canonicalOrderWrites)
          !== count(automaticShopifyOrderPromotion.promoted)
        || count(automaticShopifyOrderPromotion.rollbackFenced)
          > count(automaticShopifyOrderPromotion.failed)
        || count(automaticShopifyOrderPromotion.actionableHeld)
          > count(automaticShopifyOrderPromotion.held)
      )
    )
    || (
      Object.keys(automaticFaireOrderPromotion).length > 0
      && (
        automaticFaireOrderPromotion.providerWrites !== 0
        || automaticFaireOrderPromotion.inventoryWrites !== 0
        || automaticFaireOrderPromotion.syncCursorAdvanced !== false
        || count(automaticFaireOrderPromotion.canonicalOrderWrites)
          !== count(automaticFaireOrderPromotion.promoted)
      )
    )
  ) {
    const error = new Error('Commerce order reconciliation crossed its external-write fence') as Error & { code?: string }
    error.code = 'COMMERCE_ORDER_RECONCILIATION_WRITE_FENCE'
    throw error
  }
}

const MAX_PAGES_PER_RECONCILIATION = 5
const MAX_PROVIDER_RECORDS_PER_RECONCILIATION = 250
const MAX_RECONCILIATION_RUNTIME_MS = 180_000
const MIN_REMAINING_RUNTIME_FOR_PAGE_MS = 30_000
const MIN_REMAINING_RUNTIME_FOR_EXACT_REFRESH_MS = 30_000
const MAX_PROVIDER_REVISION_TARGETS_PER_RECONCILIATION = 2
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
const MAX_FAIRE_EXACT_REFRESHES_PER_RECONCILIATION = configuredInteger(
  'CLAWPILOT_COMMERCE_ORDER_MAX_FAIRE_EXACT_REFRESHES',
  10,
  1,
  25,
)

function reconciliationFailureCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(code)
    ? code
    : 'COMMERCE_FAIRE_EXACT_REFRESH_FAILED'
}

function reconciliationError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

async function persistAutomaticFaireAttention(
  input: Parameters<
    typeof markAutomaticFaireOrderPromotionAttentionInPostgres
  >[0],
) {
  try {
    return await markAutomaticFaireOrderPromotionAttentionInPostgres(input)
  } catch (cause) {
    const error = new Error(
      'Automatic Faire operator attention could not be durably persisted',
      { cause },
    ) as Error & { code?: string }
    error.code = 'COMMERCE_FAIRE_AUTO_PROMOTION_ATTENTION_PERSIST_FAILED'
    throw error
  }
}

/**
 * Follows the encrypted continuation chain within strict invocation and
 * session budgets. A bounded invocation stores its continuation for the next
 * poll; a session that is too large fails closed for operator review.
 * It stages candidates and normalization rejections, then permits a bounded
 * local-only promotion for a newly observed order whose customer,
 * provider variant/SKU, quantity, address, delivery, and packaging evidence is
 * unambiguous. Shopify additionally requires its exact default-off development
 * account cohort and one matched checkout quote. A bounded worker-only exact
 * read can supersede an untouched, stale Faire list candidate; ambiguous,
 * operator-owned, or failed evidence remains held for review.
 * It never derives packages or shipments, changes inventory, or calls a
 * provider write API.
 */
export async function processCommerceOrderReconciliation(input: {
  limit?: number
  /** Deterministic test seam; API callers never supply this. */
  clock?: () => number
}) {
  const protectedSnapshotPurge =
    await purgeExpiredCommerceOrderRevisionProtectedSnapshotsInPostgres({
      limit: PROTECTED_SNAPSHOT_PURGE_LIMIT_PER_CYCLE,
    })
  if (!commerceReadRuntimeAvailable()) {
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
      protectedSnapshotPurge,
      automaticShopifyOrderPromotion:
        shopifyAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireOrderPromotion:
        faireAutomaticOrderPromotionHealthSnapshot(),
      automaticFaireExactRefresh:
        faireAutomaticExactRefreshHealthSnapshot(),
      automaticFaireUnattributedAttention:
        faireUnattributedAttentionHealthSnapshot(),
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
      canonicalOrderRevisions: {
        shopify: {
          provider: 'shopify' as const,
          claimed: 0,
          captured: 0,
          changed: 0,
          failed: 0,
          failureCodes: {},
          providerWrites: 0 as const,
          canonicalOrderWrites: 0 as const,
          managerDispositionRequired: 0,
        },
        faire: {
          provider: 'faire' as const,
          claimed: 0,
          captured: 0,
          changed: 0,
          failed: 0,
          failureCodes: {},
          providerReadsPerCapture: 2 as const,
          providerWrites: 0 as const,
          canonicalOrderWrites: 0 as const,
          managerDispositionRequired: 0,
        },
        providerWrites: 0 as const,
        canonicalOrderWrites: 0 as const,
        managerDispositionRequired: 0,
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
  let exactRefreshBudgetStops = 0
  let customersMatched = 0
  let customersCreated = 0
  let customersAmbiguous = 0
  let customersSkipped = 0
  let customerResolutionFailed = 0
  let shopifyOrdersPromoted = 0
  let shopifyOrdersHeld = 0
  let shopifyActionableOrdersHeld = 0
  let shopifyPromotionFailed = 0
  let shopifyPromotionRollbackFenced = 0
  let shopifyPromotionAttentionRequiredAccounts = 0
  let faireOrdersPromoted = 0
  let faireOrdersHeld = 0
  let fairePromotionFailed = 0
  let fairePromotionOperatorReviewRequired = 0
  let fairePromotionAttentionRequiredAccounts = 0
  let faireExactRefreshAttempted = 0
  let faireExactRefreshSucceeded = 0
  let faireExactRefreshRejected = 0
  let faireExactRefreshFailed = 0
  let faireExactRefreshOperatorReviewRequired = 0
  let faireExactRefreshAttentionRequiredAccounts = 0
  let faireUnattributedAttentionRequiredAccounts = 0
  const faireExactRefreshFailureCodes: Record<string, number> = {}
  const fairePromotionFailureCodes: Record<string, number> = {}
  const shopifyPromotionHeldReasons: Record<string, number> = {}
  const shopifyPromotionFailureCodes: Record<string, number> = {}
  const customerResolutionFailureCodes: Record<string, number> = {}
  const failureCodes: Record<string, number> = {}
  const clock = input.clock || Date.now
  // Optional chaining keeps isolated VM contract tests compatible with their
  // intentionally minimal integration mock; the real module always exports it.
  const productionReadOnly = commerceReadRuntimeMode?.() === 'production'
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
      let targetShopifyOrdersPromoted = 0
      let targetShopifyOrdersHeld = 0
      let targetShopifyActionableOrdersHeld = 0
      let targetShopifyPromotionFailed = 0
      let targetShopifyPromotionRollbackFenced = 0
      let targetFaireOrdersPromoted = 0
      let targetFaireOrdersHeld = 0
      let targetFairePromotionFailed = 0
      let targetFairePromotionOperatorReviewRequired = 0
      let targetFaireExactRefreshAttempted = 0
      let targetFaireExactRefreshSucceeded = 0
      let targetFaireExactRefreshRejected = 0
      let targetFaireExactRefreshFailed = 0
      let targetFaireExactRefreshOperatorReviewRequired = 0
      let targetFaireExactRefreshPaused = false
      const targetFaireExactRefreshAttemptedCandidates = new Set<string>()
      const targetFaireExactRefreshFailureCodes: Record<string, number> = {}
      const targetFairePromotionFailureCodes: Record<string, number> = {}
      const targetShopifyPromotionHeldReasons: Record<string, number> = {}
      const targetShopifyPromotionFailureCodes: Record<string, number> = {}
      const targetCustomerResolutionFailureCodes: Record<string, number> = {}
      let hasNextBatch = false
      let budgetStopReason:
        | 'page'
        | 'records'
        | 'time'
        | 'exact-refresh'
        | null = null
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
        const automaticShopifyOrderPromotion = record(
          command.automaticShopifyOrderPromotion,
        )
        const automaticFaireOrderPromotion = record(
          command.automaticFaireOrderPromotion,
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
        targetShopifyOrdersPromoted += count(
          automaticShopifyOrderPromotion.promoted,
        )
        targetShopifyOrdersHeld += count(
          automaticShopifyOrderPromotion.held,
        )
        targetShopifyActionableOrdersHeld += count(
          automaticShopifyOrderPromotion.actionableHeld,
        )
        targetShopifyPromotionFailed += count(
          automaticShopifyOrderPromotion.failed,
        )
        targetShopifyPromotionRollbackFenced += count(
          automaticShopifyOrderPromotion.rollbackFenced,
        )
        targetFaireOrdersPromoted += count(
          automaticFaireOrderPromotion.promoted,
        )
        targetFaireOrdersHeld += count(automaticFaireOrderPromotion.held)
        targetFairePromotionFailed += count(
          automaticFaireOrderPromotion.failed,
        )
        targetFairePromotionOperatorReviewRequired += count(
          automaticFaireOrderPromotion.operatorReviewRequired,
        )
        const failedByCode = record(automaticCustomerResolution.failedByCode)
        for (const [code, value] of Object.entries(failedByCode)) {
          if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
          targetCustomerResolutionFailureCodes[code] = (
            targetCustomerResolutionFailureCodes[code] || 0
          ) + count(value)
        }
        const promotionFailedByCode = record(
          automaticFaireOrderPromotion.failedByCode,
        )
        for (const [code, value] of Object.entries(promotionFailedByCode)) {
          if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
          targetFairePromotionFailureCodes[code] = (
            targetFairePromotionFailureCodes[code] || 0
          ) + count(value)
        }
        const shopifyHeldByReason = record(
          automaticShopifyOrderPromotion.heldByReason,
        )
        for (const [reason, value] of Object.entries(shopifyHeldByReason)) {
          if (!/^[a-z][a-z0-9_]{2,127}$/u.test(reason)) continue
          targetShopifyPromotionHeldReasons[reason] = (
            targetShopifyPromotionHeldReasons[reason] || 0
          ) + count(value)
        }
        const shopifyFailedByCode = record(
          automaticShopifyOrderPromotion.failedByCode,
        )
        for (const [code, value] of Object.entries(shopifyFailedByCode)) {
          if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
          targetShopifyPromotionFailureCodes[code] = (
            targetShopifyPromotionFailureCodes[code] || 0
          ) + count(value)
        }
        targetPagesRead += 1
        const stagedRunGlobalId = typeof pagination.runGlobalId === 'string'
          ? pagination.runGlobalId
          : ''
        if (!/^gcir(?:[0-9]{7}|[0-9a-v]{12})$/u.test(stagedRunGlobalId)) {
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
        assertReconciliationFence(command, productionReadOnly)
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
        if (hasNextBatch && !next) {
          const error = new Error('Order page did not return a continuation handle') as Error & { code?: string }
          error.code = 'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_MISSING'
          throw error
        }
        if (next && seenRunGlobalIds.has(next)) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_CONTINUATION_REPEATED',
            'Order reconciliation repeated a continuation handle',
          )
        }
        if (next) seenRunGlobalIds.add(next)
        if (hasNextBatch && batchNumber >= MAX_PAGES_PER_SESSION) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_SESSION_PAGE_BUDGET_EXCEEDED',
            'Order reconciliation session reached its provider-page budget',
          )
        }
        if (
          hasNextBatch
          && target.recordsSeen >= MAX_PROVIDER_RECORDS_PER_SESSION
        ) {
          throw reconciliationError(
            'COMMERCE_ORDER_RECONCILIATION_SESSION_RECORD_BUDGET_EXCEEDED',
            'Order reconciliation session reached its provider-record budget',
          )
        }

        if (
          target.provider === 'faire'
          && !productionReadOnly
          && !targetFaireExactRefreshPaused
          && targetFaireExactRefreshAttempted
            < MAX_FAIRE_EXACT_REFRESHES_PER_RECONCILIATION
        ) {
          if (
            clock() - targetStartedAtMs
              >= MAX_RECONCILIATION_RUNTIME_MS
                - MIN_REMAINING_RUNTIME_FOR_EXACT_REFRESH_MS
          ) {
            budgetStopReason = 'time'
          } else {
            const exactTargets =
              await readAutomaticFaireExactRefreshTargetsInPostgres({
                runtime: {
                  organizationId: target.organizationId,
                  globalId: target.accountGlobalId,
                  provider: target.provider,
                  credentialVersion: target.credentialVersion,
                },
                preferredRunGlobalId: stagedRunGlobalId,
                limit: MAX_FAIRE_EXACT_REFRESHES_PER_RECONCILIATION
                  - targetFaireExactRefreshAttempted,
                excludedCandidateGlobalIds: [
                  ...targetFaireExactRefreshAttemptedCandidates,
                ],
              })
            for (const exactTarget of exactTargets) {
              if (
                clock() - targetStartedAtMs
                  >= MAX_RECONCILIATION_RUNTIME_MS
                    - MIN_REMAINING_RUNTIME_FOR_EXACT_REFRESH_MS
              ) {
                budgetStopReason = 'time'
                break
              }
              targetFaireExactRefreshAttemptedCandidates.add(
                exactTarget.candidateGlobalId,
              )
              targetFaireExactRefreshAttempted += 1
              try {
                const exactResponse =
                  await executeCommerceFaireOrderExactRefresh({
                    organizationId: target.organizationId,
                    accountGlobalId: target.accountGlobalId,
                    actorEmail: 'system:commerce-order-reconciliation',
                    idempotencyKey: deterministicFaireExactRefreshUuid({
                      organizationId: target.organizationId,
                      accountGlobalId: target.accountGlobalId,
                      credentialVersion: target.credentialVersion,
                      candidateGlobalId: exactTarget.candidateGlobalId,
                      sourceHash: exactTarget.sourceHash,
                      cohortHash: exactTarget.cohortHash,
                      notBefore: exactTarget.notBefore,
                    }),
                    candidateGlobalId: exactTarget.candidateGlobalId,
                    candidateRowVersion: exactTarget.candidateRowVersion,
                    sourceHash: exactTarget.sourceHash,
                    expectedCredentialVersion: target.credentialVersion,
                    cohortHash: exactTarget.cohortHash,
                    notBefore: exactTarget.notBefore,
                  })
                const exactCommand = record(exactResponse.command)
                assertReconciliationFence(exactCommand)
                const exactCustomerResolution = record(
                  exactCommand.automaticCustomerResolution,
                )
                const exactFairePromotion = record(
                  exactCommand.automaticFaireOrderPromotion,
                )
                const exactRejected = count(exactCommand.recordsRejected)
                if (exactRejected > 0) {
                  targetFaireExactRefreshRejected += exactRejected
                  const rejectionCode =
                    'COMMERCE_FAIRE_EXACT_REFRESH_NORMALIZATION_REJECTED'
                  const attention = await persistAutomaticFaireAttention({
                    runtime: {
                      organizationId: target.organizationId,
                      integrationAccountId: target.integrationAccountId,
                      globalId: target.accountGlobalId,
                      provider: 'faire',
                      credentialVersion: target.credentialVersion,
                    },
                    actorEmail: 'system:commerce-order-reconciliation',
                    idempotencyKey: deterministicFaireAttentionUuid({
                      organizationId: target.organizationId,
                      accountGlobalId: target.accountGlobalId,
                      credentialVersion: target.credentialVersion,
                      candidateGlobalId: exactTarget.candidateGlobalId,
                      sourceHash: exactTarget.sourceHash,
                      reasonCode: rejectionCode,
                      cohortHash: exactTarget.cohortHash,
                      notBefore: exactTarget.notBefore,
                    }),
                    candidateGlobalId: exactTarget.candidateGlobalId,
                    candidateRowVersion: exactTarget.candidateRowVersion,
                    sourceHash: exactTarget.sourceHash,
                    runGlobalId: exactTarget.originatingRunGlobalId,
                    reasonCode: rejectionCode,
                    cohortHash: exactTarget.cohortHash,
                    notBefore: exactTarget.notBefore,
                    attentionKind: 'exact_refresh',
                  })
                  if (record(attention).marked === true) {
                    targetFaireExactRefreshOperatorReviewRequired += 1
                  }
                } else {
                  targetFaireExactRefreshSucceeded += 1
                }
                targetCustomersMatched += count(
                  exactCustomerResolution.matched,
                )
                targetCustomersCreated += count(
                  exactCustomerResolution.created,
                )
                targetCustomersAmbiguous += count(
                  exactCustomerResolution.ambiguous,
                )
                targetCustomersSkipped += count(
                  exactCustomerResolution.skipped,
                )
                targetCustomerResolutionFailed += count(
                  exactCustomerResolution.failed,
                )
                targetFaireOrdersPromoted += count(
                  exactFairePromotion.promoted,
                )
                targetFaireOrdersHeld += count(exactFairePromotion.held)
                targetFairePromotionFailed += count(
                  exactFairePromotion.failed,
                )
                targetFairePromotionOperatorReviewRequired += count(
                  exactFairePromotion.operatorReviewRequired,
                )
                for (
                  const [code, value]
                  of Object.entries(record(
                    exactCustomerResolution.failedByCode,
                  ))
                ) {
                  if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
                  targetCustomerResolutionFailureCodes[code] = (
                    targetCustomerResolutionFailureCodes[code] || 0
                  ) + count(value)
                }
                for (
                  const [code, value]
                  of Object.entries(record(exactFairePromotion.failedByCode))
                ) {
                  if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) continue
                  targetFairePromotionFailureCodes[code] = (
                    targetFairePromotionFailureCodes[code] || 0
                  ) + count(value)
                }
              } catch (error) {
                if (
                  reconciliationFailureCode(error)
                    === 'COMMERCE_ORDER_RECONCILIATION_WRITE_FENCE'
                  || reconciliationFailureCode(error)
                    === 'COMMERCE_FAIRE_AUTO_PROMOTION_ATTENTION_PERSIST_FAILED'
                ) throw error
                targetFaireExactRefreshFailed += 1
                const code = reconciliationFailureCode(error)
                const attention = await persistAutomaticFaireAttention({
                  runtime: {
                    organizationId: target.organizationId,
                    integrationAccountId: target.integrationAccountId,
                    globalId: target.accountGlobalId,
                    provider: 'faire',
                    credentialVersion: target.credentialVersion,
                  },
                  actorEmail: 'system:commerce-order-reconciliation',
                  idempotencyKey: deterministicFaireAttentionUuid({
                    organizationId: target.organizationId,
                    accountGlobalId: target.accountGlobalId,
                    credentialVersion: target.credentialVersion,
                    candidateGlobalId: exactTarget.candidateGlobalId,
                    sourceHash: exactTarget.sourceHash,
                    reasonCode: code,
                    cohortHash: exactTarget.cohortHash,
                    notBefore: exactTarget.notBefore,
                  }),
                  candidateGlobalId: exactTarget.candidateGlobalId,
                  candidateRowVersion: exactTarget.candidateRowVersion,
                  sourceHash: exactTarget.sourceHash,
                  runGlobalId: exactTarget.originatingRunGlobalId,
                  reasonCode: code,
                  cohortHash: exactTarget.cohortHash,
                  notBefore: exactTarget.notBefore,
                  attentionKind: 'exact_refresh',
                })
                if (record(attention).marked === true) {
                  targetFaireExactRefreshOperatorReviewRequired += 1
                }
                targetFaireExactRefreshFailureCodes[code] = (
                  targetFaireExactRefreshFailureCodes[code] || 0
                ) + 1
                // A provider/read-fence failure pauses exact reads for this
                // account invocation; list continuation evidence remains
                // durable and can resume independently.
                targetFaireExactRefreshPaused = true
                break
              }
            }
          }
        }
        if (
          targetFaireExactRefreshAttempted
            >= MAX_FAIRE_EXACT_REFRESHES_PER_RECONCILIATION
        ) {
          budgetStopReason = 'exact-refresh'
        }
        if (budgetStopReason === 'time' || budgetStopReason === 'exact-refresh') {
          break
        }
        if (!hasNextBatch) {
          continuationRunGlobalId = null
          break
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
        shopifyOrdersPromoted: targetShopifyOrdersPromoted,
        shopifyOrdersHeld: targetShopifyOrdersHeld,
        shopifyPromotionActionableHeld:
          targetShopifyActionableOrdersHeld,
        shopifyPromotionHeldReasons: targetShopifyPromotionHeldReasons,
        shopifyPromotionFailed: targetShopifyPromotionFailed,
        shopifyPromotionFailureCodes: targetShopifyPromotionFailureCodes,
        shopifyPromotionRollbackFenced:
          targetShopifyPromotionRollbackFenced,
        faireOrdersPromoted: targetFaireOrdersPromoted,
        faireOrdersHeld: targetFaireOrdersHeld,
        fairePromotionFailed: targetFairePromotionFailed,
        fairePromotionFailureCodes: targetFairePromotionFailureCodes,
        fairePromotionOperatorReviewRequired:
          targetFairePromotionOperatorReviewRequired,
        faireExactRefreshAttempted: targetFaireExactRefreshAttempted,
        faireExactRefreshSucceeded: targetFaireExactRefreshSucceeded,
        faireExactRefreshRejected: targetFaireExactRefreshRejected,
        faireExactRefreshFailed: targetFaireExactRefreshFailed,
        faireExactRefreshOperatorReviewRequired:
          targetFaireExactRefreshOperatorReviewRequired,
        faireExactRefreshFailureCodes: targetFaireExactRefreshFailureCodes,
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
        shopifyOrdersPromoted += targetShopifyOrdersPromoted
        shopifyOrdersHeld += targetShopifyOrdersHeld
        shopifyActionableOrdersHeld += targetShopifyActionableOrdersHeld
        shopifyPromotionFailed += targetShopifyPromotionFailed
        shopifyPromotionRollbackFenced +=
          targetShopifyPromotionRollbackFenced
        if (completion.shopifyAutomaticPromotionAttentionRequired) {
          shopifyPromotionAttentionRequiredAccounts += 1
        }
        faireOrdersPromoted += targetFaireOrdersPromoted
        faireOrdersHeld += targetFaireOrdersHeld
        fairePromotionFailed += targetFairePromotionFailed
        fairePromotionOperatorReviewRequired +=
          targetFairePromotionOperatorReviewRequired
        if (completion.faireAutomaticPromotionAttentionRequired) {
          fairePromotionAttentionRequiredAccounts += 1
        }
        faireExactRefreshAttempted += targetFaireExactRefreshAttempted
        faireExactRefreshSucceeded += targetFaireExactRefreshSucceeded
        faireExactRefreshRejected += targetFaireExactRefreshRejected
        faireExactRefreshFailed += targetFaireExactRefreshFailed
        faireExactRefreshOperatorReviewRequired +=
          targetFaireExactRefreshOperatorReviewRequired
        if (completion.faireExactRefreshAttentionRequired) {
          faireExactRefreshAttentionRequiredAccounts += 1
        }
        if (completion.faireUnattributedAttentionRequired) {
          faireUnattributedAttentionRequiredAccounts += 1
        }
        for (
          const [code, value]
          of Object.entries(targetCustomerResolutionFailureCodes)
        ) {
          customerResolutionFailureCodes[code] = (
            customerResolutionFailureCodes[code] || 0
          ) + value
        }
        for (
          const [reason, value]
          of Object.entries(targetShopifyPromotionHeldReasons)
        ) {
          shopifyPromotionHeldReasons[reason] = (
            shopifyPromotionHeldReasons[reason] || 0
          ) + value
        }
        for (
          const [code, value]
          of Object.entries(targetShopifyPromotionFailureCodes)
        ) {
          shopifyPromotionFailureCodes[code] = (
            shopifyPromotionFailureCodes[code] || 0
          ) + value
        }
        for (
          const [code, value]
          of Object.entries(targetFairePromotionFailureCodes)
        ) {
          fairePromotionFailureCodes[code] = (
            fairePromotionFailureCodes[code] || 0
          ) + value
        }
        for (
          const [code, value]
          of Object.entries(targetFaireExactRefreshFailureCodes)
        ) {
          faireExactRefreshFailureCodes[code] = (
            faireExactRefreshFailureCodes[code] || 0
          ) + value
        }
        if (hasNextBatch) resumable += 1
        if (budgetStopReason === 'page') pageBudgetStops += 1
        if (budgetStopReason === 'records') recordBudgetStops += 1
        if (budgetStopReason === 'time') timeBudgetStops += 1
        if (budgetStopReason === 'exact-refresh') {
          exactRefreshBudgetStops += 1
        }
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
  const revisionLimit = Math.max(1, Math.min(
    Number(input.limit || 1),
    MAX_PROVIDER_REVISION_TARGETS_PER_RECONCILIATION,
  ))
  const [shopifyOrderRevisions, faireOrderRevisions] = await Promise.all([
    processShopifyOrderRevisions({ limit: revisionLimit }),
    processFaireOrderRevisions({ limit: revisionLimit }),
  ])
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
    maxFaireExactRefreshesPerReconciliation:
      MAX_FAIRE_EXACT_REFRESHES_PER_RECONCILIATION,
    minRemainingRuntimeForFaireExactRefreshMs:
      MIN_REMAINING_RUNTIME_FOR_EXACT_REFRESH_MS,
    budgetStops: {
      pages: pageBudgetStops,
      records: recordBudgetStops,
      time: timeBudgetStops,
      exactRefreshes: exactRefreshBudgetStops,
    },
    resource: 'orders',
    providerWrites: 0,
    canonicalOrderWrites: shopifyOrdersPromoted + faireOrdersPromoted,
    inventoryWrites: 0,
    protectedSnapshotPurge,
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
    automaticShopifyOrderPromotion:
      shopifyAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          promoted: shopifyOrdersPromoted,
          held: shopifyOrdersHeld,
          actionableHeld: shopifyActionableOrdersHeld,
          heldByReason: shopifyPromotionHeldReasons,
          failed: shopifyPromotionFailed,
          failedByCode: shopifyPromotionFailureCodes,
          rollbackFenced: shopifyPromotionRollbackFenced,
          attentionRequiredAccounts:
            shopifyPromotionAttentionRequiredAccounts,
          operatorReviewRequired:
            Math.max(
              shopifyActionableOrdersHeld + shopifyPromotionFailed,
              shopifyPromotionAttentionRequiredAccounts,
            ),
          providerWrites: 0,
          canonicalOrderWrites: shopifyOrdersPromoted,
          inventoryWrites: 0,
          syncCursorAdvanced: false,
        },
      }),
    automaticFaireOrderPromotion:
      faireAutomaticOrderPromotionHealthSnapshot({
        heartbeat: {
          promoted: faireOrdersPromoted,
          held: faireOrdersHeld,
          failed: fairePromotionFailed,
          failedByCode: fairePromotionFailureCodes,
          attentionRequiredAccounts:
            fairePromotionAttentionRequiredAccounts,
          operatorReviewRequired: Math.max(
            fairePromotionOperatorReviewRequired,
            fairePromotionAttentionRequiredAccounts,
          ),
          providerWrites: 0,
          canonicalOrderWrites: faireOrdersPromoted,
          inventoryWrites: 0,
          syncCursorAdvanced: false,
        },
      }),
    automaticFaireExactRefresh:
      faireAutomaticExactRefreshHealthSnapshot({
        attempted: faireExactRefreshAttempted,
        succeeded: faireExactRefreshSucceeded,
        rejected: faireExactRefreshRejected,
        failed: faireExactRefreshFailed,
        failedByCode: faireExactRefreshFailureCodes,
        operatorReviewRequired: Math.max(
          faireExactRefreshOperatorReviewRequired,
          faireExactRefreshAttentionRequiredAccounts,
        ),
        providerWrites: 0,
        inventoryWrites: 0,
        syncCursorAdvanced: false,
      }),
    automaticFaireUnattributedAttention:
      faireUnattributedAttentionHealthSnapshot({
        attentionRequiredAccounts:
          faireUnattributedAttentionRequiredAccounts,
        operatorReviewRequired:
          faireUnattributedAttentionRequiredAccounts,
      }),
    canonicalOrderRevisions: {
      shopify: shopifyOrderRevisions,
      faire: faireOrderRevisions,
      providerWrites: 0 as const,
      canonicalOrderWrites: 0 as const,
      managerDispositionRequired:
        shopifyOrderRevisions.managerDispositionRequired
        + faireOrderRevisions.managerDispositionRequired,
    },
    failureCodes,
  }
}
