import {
  createQuickBooksEntity,
  QuickBooksProviderWriteError,
} from '@/lib/integrations/quickBooksClient'
import {
  claimQuickBooksWriteJobsInPostgres,
  completeQuickBooksWriteJobInPostgres,
  failQuickBooksWriteJobInPostgres,
} from '@/lib/persistence/quickBooksWrites'
import { queueQuickBooksCatalogSyncInPostgres } from '@/lib/persistence/quickBooksIntegrations'

function configuredWriteMode(): 'sandbox' | 'production' | null {
  if (process.env.QUICKBOOKS_WRITES_ENABLED !== '1') return null
  const mode = String(process.env.QUICKBOOKS_WRITE_MODE || '').trim()
  return mode === 'sandbox' || mode === 'production' ? mode : null
}

export async function processQuickBooksWriteOutbox(input: { limit?: number; workerId: string }) {
  const writeMode = configuredWriteMode()
  if (!writeMode) {
    return { enabled: false, mode: 'disabled', claimed: 0, succeeded: 0, failed: 0, dead: 0 }
  }
  const jobs = await claimQuickBooksWriteJobsInPostgres({
    limit: Math.max(1, Math.min(Number(input.limit || 2), 10)),
    workerId: input.workerId,
    writeMode,
  })
  let succeeded = 0
  let failed = 0
  let dead = 0
  for (const job of jobs) {
    try {
      const provider = await createQuickBooksEntity({
        ownerEmail: job.ownerEmail,
        connectionId: job.connectionId,
        operationKind: job.operationKind,
        payload: job.requestPayload,
        providerRequestId: job.providerRequestId,
      })
      await completeQuickBooksWriteJobInPostgres({
        job,
        providerEntityType: provider.entityType,
        providerEntityId: provider.entityId,
        providerSyncToken: provider.syncToken,
      })
      await queueQuickBooksCatalogSyncInPostgres({ organizationId: job.organizationId, actorEmail: null })
      succeeded += 1
    } catch (error) {
      const becameDead = await failQuickBooksWriteJobInPostgres({
        job,
        errorCode: error instanceof QuickBooksProviderWriteError ? error.code : 'QUICKBOOKS_WRITE_INTERNAL_ERROR',
        error,
      })
      if (becameDead) dead += 1
      else failed += 1
    }
  }
  return { enabled: true, mode: writeMode, claimed: jobs.length, succeeded, failed, dead }
}
