import { createHash } from 'node:crypto'
import { executeCommerceCatalogProductPage } from '@/lib/integrations/commerceIntake'
import {
  claimCommerceCatalogSyncJobsInPostgres,
  completeCommerceCatalogSyncPageInPostgres,
  failCommerceCatalogSyncJobInPostgres,
  queueAutomaticCommerceCatalogSyncsInPostgres,
  type CommerceCatalogSyncJob,
} from '@/lib/persistence/commerceCatalogSync'

const MAX_CATALOG_SWEEP_PAGES = 1_000
const MAX_CATALOG_SWEEP_PROVIDER_RECORDS = 50_000
const MAX_CATALOG_SWEEP_DURATION_MS = 2 * 60 * 60 * 1_000

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

function catalogSweepError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

function sweepStartedAtMs(job: CommerceCatalogSyncJob) {
  const startedAt = Date.parse(job.startedAt)
  if (!Number.isFinite(startedAt)) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_STATE_INVALID',
      'Catalog sweep start time is invalid',
    )
  }
  return startedAt
}

export function assertCommerceCatalogSweepCanRead(
  job: CommerceCatalogSyncJob,
  nowMs = Date.now(),
) {
  if (job.pageCount >= MAX_CATALOG_SWEEP_PAGES) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
      'Catalog sweep page limit was reached',
    )
  }
  if (job.providerRecordsSeen >= MAX_CATALOG_SWEEP_PROVIDER_RECORDS) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_RECORD_LIMIT_EXCEEDED',
      'Catalog sweep provider-record limit was reached',
    )
  }
  if (nowMs - sweepStartedAtMs(job) >= MAX_CATALOG_SWEEP_DURATION_MS) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_DURATION_LIMIT_EXCEEDED',
      'Catalog sweep duration limit was reached',
    )
  }
}

export function assertCommerceCatalogSweepPageWithinLimits(input: {
  job: CommerceCatalogSyncJob
  continuationRunGlobalId: string | null
  hasNextBatch: boolean
  providerRecordsSeen: number
  nowMs?: number
}) {
  const nextPageCount = input.job.pageCount + 1
  const nextProviderRecordsSeen = input.job.providerRecordsSeen
    + count(input.providerRecordsSeen)
  if (
    nextPageCount > MAX_CATALOG_SWEEP_PAGES
    || (input.hasNextBatch && nextPageCount >= MAX_CATALOG_SWEEP_PAGES)
  ) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_PAGE_LIMIT_EXCEEDED',
      'Catalog sweep cannot continue past its page limit',
    )
  }
  if (
    nextProviderRecordsSeen > MAX_CATALOG_SWEEP_PROVIDER_RECORDS
    || (
      input.hasNextBatch
      && nextProviderRecordsSeen >= MAX_CATALOG_SWEEP_PROVIDER_RECORDS
    )
  ) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_RECORD_LIMIT_EXCEEDED',
      'Catalog sweep cannot continue past its provider-record limit',
    )
  }
  if (
    (input.nowMs ?? Date.now()) - sweepStartedAtMs(input.job)
      >= MAX_CATALOG_SWEEP_DURATION_MS
  ) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_DURATION_LIMIT_EXCEEDED',
      'Catalog sweep duration limit was reached',
    )
  }
  if (
    input.hasNextBatch
    && input.continuationRunGlobalId
    && input.continuationRunGlobalId === input.job.continuationRunGlobalId
  ) {
    throw catalogSweepError(
      'COMMERCE_CATALOG_SYNC_CONTINUATION_REPEATED',
      'Catalog sweep returned its current continuation handle',
    )
  }
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
      assertCommerceCatalogSweepCanRead(job)
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
      const providerRecordsSeen = count(pagination.providerRowsSeen)
      assertCommerceCatalogSweepPageWithinLimits({
        job,
        continuationRunGlobalId,
        hasNextBatch,
        providerRecordsSeen,
      })
      const completion = await completeCommerceCatalogSyncPageInPostgres({
        job,
        continuationRunGlobalId,
        hasNextBatch,
        totals: {
          providerRecordsSeen,
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
  const followUpQueued = await queueAutomaticCommerceCatalogSyncsInPostgres()
  return {
    autoQueued: autoQueued + followUpQueued,
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
