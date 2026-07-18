import { readQuickBooksCatalog } from '@/lib/integrations/quickBooksClient'
import {
  claimQuickBooksSyncJobsInPostgres,
  completeQuickBooksCatalogSyncInPostgres,
  failQuickBooksSyncJobInPostgres,
  queueAutomaticQuickBooksCatalogSyncsInPostgres,
} from '@/lib/persistence/quickBooksIntegrations'

export async function processQuickBooksSyncOutbox(input: { limit?: number; workerId: string }) {
  const autoQueued = await queueAutomaticQuickBooksCatalogSyncsInPostgres()
  const jobs = await claimQuickBooksSyncJobsInPostgres({
    limit: Math.max(1, Math.min(Number(input.limit || 2), 10)),
    workerId: input.workerId,
  })
  let succeeded = 0
  let failed = 0
  let dead = 0
  for (const job of jobs) {
    try {
      const catalog = await readQuickBooksCatalog(job.ownerEmail, job.connectionId)
      await completeQuickBooksCatalogSyncInPostgres({ job, ...catalog })
      succeeded += 1
    } catch (error) {
      const becameDead = await failQuickBooksSyncJobInPostgres({ job, error })
      if (becameDead) dead += 1
      else failed += 1
    }
  }
  return { autoQueued, claimed: jobs.length, succeeded, failed, dead }
}
