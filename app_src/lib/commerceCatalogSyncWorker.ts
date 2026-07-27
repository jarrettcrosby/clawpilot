import { createHash } from 'node:crypto'
import { executeCommerceCatalogProductPage } from '@/lib/integrations/commerceIntake'
import {
  claimCommerceCatalogSyncJobsInPostgres,
  completeCommerceCatalogSyncPageInPostgres,
  failCommerceCatalogSyncJobInPostgres,
  queueAutomaticCommerceCatalogSyncsInPostgres,
} from '@/lib/persistence/commerceCatalogSync'

function deterministicPageUuid(input: {
  jobId: string
  credentialVersion: number
  policyRevision: number
  pageCount: number
  readGeneration: number
  continuationRunGlobalId: string | null
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function count(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export async function processCommerceCatalogSyncOutbox(input: {
  limit?: number
  workerId: string
}) {
  const autoQueued = await queueAutomaticCommerceCatalogSyncsInPostgres()
  const jobs = await claimCommerceCatalogSyncJobsInPostgres({
    limit: Math.max(1, Math.min(Number(input.limit || 2), 10)),
    workerId: input.workerId,
  })
  let pagesCompleted = 0
  let jobsCompleted = 0
  let jobsRequeued = 0
  let jobsFailed = 0
  let jobsDead = 0
  let jobsCancelled = 0
  for (const job of jobs) {
    try {
      const response = await executeCommerceCatalogProductPage({
        organizationId: job.organizationId,
        accountGlobalId: job.accountGlobalId,
        actorEmail: job.requestedBy,
        idempotencyKey: deterministicPageUuid({
          jobId: job.id,
          credentialVersion: job.credentialVersion,
          policyRevision: job.policyRevision,
          pageCount: job.pageCount,
          readGeneration: job.readGeneration,
          continuationRunGlobalId: job.continuationRunGlobalId,
        }),
        continuationRunGlobalId: job.continuationRunGlobalId,
      })
      const command = record(response.command)
      const pagination = record(command.pagination)
      const automatic = record(command.automaticProductCreation)
      if (automatic.failed === true) {
        const sweep = new Error(
          'Automatic catalog product creation did not complete',
        ) as Error & { code?: string }
        sweep.code = (
          typeof automatic.errorCode === 'string'
          && /^[A-Z][A-Z0-9_]{2,127}$/.test(automatic.errorCode)
        )
          ? automatic.errorCode
          : 'COMMERCE_PRODUCT_AUTO_CREATE_SWEEP_FAILED'
        throw sweep
      }
      const hasNextBatch = pagination.hasNextBatch === true
      const continuationRunGlobalId = hasNextBatch
        && typeof pagination.continuationRunGlobalId === 'string'
        ? pagination.continuationRunGlobalId
        : null
      if (hasNextBatch && !continuationRunGlobalId) {
        const invalid = new Error(
          'Catalog page did not return a continuation handle',
        ) as Error & { code?: string }
        invalid.code = 'COMMERCE_CATALOG_SYNC_CONTINUATION_MISSING'
        throw invalid
      }
      const completion = await completeCommerceCatalogSyncPageInPostgres({
        job,
        continuationRunGlobalId,
        hasNextBatch,
        totals: {
          providerRecordsSeen: count(pagination.providerRowsSeen),
          productsCreated: count(automatic.created),
          productsMapped: count(automatic.mappedExisting),
          productsUnchanged: count(command.productVariantsPreserved),
          productsSkipped: count(automatic.skipped),
          productsFailed: count(automatic.failed),
        },
      })
      if (completion.status === 'cancelled') {
        jobsCancelled += 1
        continue
      }
      pagesCompleted += 1
      if (completion.hasNextBatch) jobsRequeued += 1
      else jobsCompleted += 1
    } catch (error) {
      const failure = await failCommerceCatalogSyncJobInPostgres({
        job,
        error,
      })
      if (failure.leaseLost) {
        jobsCancelled += 1
      } else if (failure.dead) {
        jobsDead += 1
      } else {
        jobsFailed += 1
      }
    }
  }
  return {
    autoQueued,
    claimed: jobs.length,
    pagesCompleted,
    jobsCompleted,
    jobsRequeued,
    jobsFailed,
    jobsDead,
    jobsCancelled,
    resource: 'products',
    providerWrites: 0,
    ordersTouched: 0,
    inventoryTouched: 0,
  }
}
