import {
  createQuickBooksEntity,
  QuickBooksProviderWriteError,
} from '@/lib/integrations/quickBooksClient'
import {
  claimQuickBooksWriteJobsInPostgres,
  completeQuickBooksWriteJobInPostgres,
  failQuickBooksWriteJobInPostgres,
  QuickBooksWriteRequestError,
  validateQuickBooksWriteJobBeforeProviderInPostgres,
} from '@/lib/persistence/quickBooksWrites'
import { queueQuickBooksCatalogSyncInPostgres } from '@/lib/persistence/quickBooksIntegrations'
import {
  reconcileOpenPosAccountingIssuesForMappedItemInPostgres,
  reconcilePosAccountingIssueForQuickBooksRequestInPostgres,
} from '@/lib/persistence/posAccountingNotifications'
import { configuredQuickBooksWritePolicy } from '@/lib/quickBooksWritePolicy'

export async function processQuickBooksWriteOutbox(input: { limit?: number; workerId: string }) {
  const policy = configuredQuickBooksWritePolicy()
  if (!policy.enabled || !policy.mode) {
    return { enabled: false, mode: 'disabled', claimed: 0, succeeded: 0, failed: 0, dead: 0 }
  }
  const jobs = await claimQuickBooksWriteJobsInPostgres({
    limit: Math.max(1, Math.min(Number(input.limit || 2), 10)),
    workerId: input.workerId,
    writeMode: policy.mode,
    allowedOperations: policy.allowedOperations,
  })
  let succeeded = 0
  let failed = 0
  let dead = 0
  let catalogSyncWarnings = 0
  let accountingNotificationWarnings = 0
  for (const job of jobs) {
    try {
      const readiness = await validateQuickBooksWriteJobBeforeProviderInPostgres(job)
      const provider = await createQuickBooksEntity({
        ownerEmail: job.ownerEmail,
        connectionId: job.connectionId,
        operationKind: job.operationKind,
        payload: job.requestPayload,
        providerRequestId: job.providerRequestId,
      })
      const completion = await completeQuickBooksWriteJobInPostgres({
        job,
        providerEntityType: provider.entityType,
        providerEntityId: provider.entityId,
        providerSyncToken: provider.syncToken,
        posAccountingSource: readiness.posAccountingSource,
      })
      succeeded += 1
      const mapping = completion.posAccountingMapping
      if (job.operationKind === 'item.create' && mapping?.active) {
        try {
          const reconciliation = await reconcileOpenPosAccountingIssuesForMappedItemInPostgres({
            organizationId: job.organizationId,
            restaurantGuid: mapping.sourceRestaurantGuid,
            mappingScope: mapping.mappingScope,
          })
          accountingNotificationWarnings += reconciliation.failed
        } catch {
          // The QuickBooks item and its mapping are already committed. Alert
          // reconciliation is retried by the stale accounting reconciler.
          accountingNotificationWarnings += 1
        }
      }
      try {
        await queueQuickBooksCatalogSyncInPostgres({ organizationId: job.organizationId, actorEmail: null })
      } catch {
        catalogSyncWarnings += 1
      }
    } catch (error) {
      const becameDead = await failQuickBooksWriteJobInPostgres({
        job,
        errorCode: error instanceof QuickBooksProviderWriteError || error instanceof QuickBooksWriteRequestError
          ? error.code
          : 'QUICKBOOKS_WRITE_INTERNAL_ERROR',
        error,
      })
      if (becameDead) dead += 1
      else failed += 1
    }
    if (job.operationKind === 'sales_receipt.create' || job.operationKind === 'journal_entry.create') {
      try {
        await reconcilePosAccountingIssueForQuickBooksRequestInPostgres({
          organizationId: job.organizationId,
          requestId: job.id,
        })
      } catch {
        // The QuickBooks result is already committed. Alert reconciliation is
        // retried by the stale accounting reconciler and must not rewrite it.
        accountingNotificationWarnings += 1
      }
    }
  }
  return {
    enabled: true,
    mode: policy.mode,
    allowedOperations: policy.allowedOperations,
    claimed: jobs.length,
    succeeded,
    failed,
    dead,
    catalogSyncWarnings,
    accountingNotificationWarnings,
  }
}
