import {
  fetchCommerceProviderImage,
} from '@/lib/integrations/commerceProviderImageFetch'
import {
  assertIntegrationCredentialProviderIoReady,
  isIntegrationCredentialRuntimeGateError,
} from '@/lib/integrations/integrationCredentialRuntimeGate.mjs'
import {
  selectCommerceProviderImageSource,
  withCurrentCommerceProviderImageSources,
  type CommerceProviderImageSource,
} from '@/lib/integrations/commerceProviderImageSource'
import {
  assertCommerceProductImageImportClaimCurrentInPostgres,
  claimCommerceProductImageImportJobsInPostgres,
  completeCommerceProductImageImportJobInPostgres,
  failCommerceProductImageImportJobInPostgres,
  parkCommerceProductImageImportForRuntimeMaintenanceInPostgres,
  parkCommerceProductImageImportForStoreSyncPauseInPostgres,
  recordCommerceProductImageImportWorkerHeartbeatInPostgres,
  resolveWaitingCommerceProductImageImportJobsInPostgres,
  type CommerceProductImageImportClaim,
} from '@/lib/persistence/commerceProductImageImports'
import {
  withCommerceStoreSyncProviderReadFenceInPostgres,
} from '@/lib/persistence/commerceStoreSync'

const DEFAULT_JOB_LIMIT = 1
const MAX_JOB_LIMIT = 5
const JOB_LEASE_SECONDS = 120
const MAX_WAITING_RESOLUTIONS = 100
const MAX_RETRY_DELAY_SECONDS = 15 * 60
const RETRYABLE_DATABASE_ERROR_CODE =
  'COMMERCE_PRODUCT_IMAGE_DATABASE_RETRYABLE'
const RETRYABLE_DATABASE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
])
const RETRYABLE_ERROR_CODES = new Set([
  RETRYABLE_DATABASE_ERROR_CODE,
  'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_STORE_SYNC_PAUSED',
  'COMMERCE_PROVIDER_IMAGE_DNS_FAILED',
  'COMMERCE_PROVIDER_IMAGE_DNS_EMPTY',
  'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID',
  'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT',
  'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
  'COMMERCE_PROVIDER_IMAGE_TIMEOUT',
  'COMMERCE_PROVIDER_IMAGE_ABORTED',
  'COMMERCE_PROVIDER_IMAGE_STATUS_INVALID',
  'COMMERCE_PRODUCT_IMAGE_STORE_SYNC_PAUSED',
  'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED',
  'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST',
])

const PERMANENT_ERROR_CODES = new Set([
  'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_CREDENTIAL_INVALID',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_CONNECTION_REQUIRED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_FENCE_CHANGED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_ACCOUNT_CHANGED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_SCOPE_REQUIRED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_NOT_FOUND',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_IDENTITY_CHANGED',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE',
  'COMMERCE_PROVIDER_IMAGE_SOURCE_AMBIGUOUS',
  'COMMERCE_PROVIDER_IMAGE_URL_INVALID',
  'COMMERCE_PROVIDER_IMAGE_HTTPS_REQUIRED',
  'COMMERCE_PROVIDER_IMAGE_CREDENTIALS_FORBIDDEN',
  'COMMERCE_PROVIDER_IMAGE_HOST_FORBIDDEN',
  'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE',
  'COMMERCE_PROVIDER_IMAGE_DNS_MIXED',
  'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID',
  'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID',
  'COMMERCE_PROVIDER_IMAGE_MIME_UNSUPPORTED',
  'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH',
  'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
  'COMMERCE_PROVIDER_IMAGE_DIMENSIONS_INVALID',
  'COMMERCE_PRODUCT_IMAGE_DIMENSIONS_MISMATCH',
  'COMMERCE_PRODUCT_IMAGE_FANOUT_REVIEW_REQUIRED',
  'COMMERCE_PRODUCT_IMAGE_SOURCE_EVIDENCE_INVALID',
  'COMMERCE_PRODUCT_IMAGE_FENCE_STALE',
  'COMMERCE_PRODUCT_IMAGE_ACTOR_FENCE_MISMATCH',
  'COMMERCE_PRODUCT_IMAGE_PRODUCT_NOT_FOUND',
])

const SAFE_ERROR_CODES = new Set([
  ...RETRYABLE_ERROR_CODES,
  ...PERMANENT_ERROR_CODES,
  'COMMERCE_PRODUCT_IMAGE_IMPORT_FAILED',
  'COMMERCE_PRODUCT_IMAGE_LEASE_LOST',
  'SHOPIFY_TIMEOUT',
  'SHOPIFY_RATE_LIMITED',
  'SHOPIFY_UNAVAILABLE',
  'SHOPIFY_UPSTREAM_FAILED',
  'SHOPIFY_ACCESS_DENIED',
  'SHOPIFY_APP_NOT_INSTALLED',
  'SHOPIFY_CLIENT_CREDENTIALS_REJECTED',
  'SHOPIFY_SHOP_NOT_PERMITTED',
  'SHOPIFY_STORE_NOT_FOUND',
  'SHOPIFY_RESPONSE_INVALID',
  'FAIRE_REQUEST_FAILED',
  'FAIRE_INTERNAL_ERROR',
  'FAIRE_ACCESS_DENIED',
  'FAIRE_RESOURCE_NOT_FOUND',
])

export type CommerceProductImageImportWorkerResult = {
  waitingResolved: number
  waitingMapping: number
  claimed: number
  providerReads: number
  fetched: number
  succeeded: number
  retried: number
  dead: number
  cancelled: number
  leaseLost: number
  failed: number
  parked: number
  providerWrites: 0
  errorCodes: Record<string, number>
}

type WorkerDependencies = {
  assertProviderIoReady: typeof assertIntegrationCredentialProviderIoReady
  resolveWaiting: typeof resolveWaitingCommerceProductImageImportJobsInPostgres
  claim: typeof claimCommerceProductImageImportJobsInPostgres
  assertCurrent: typeof assertCommerceProductImageImportClaimCurrentInPostgres
  withProviderReadFence:
    typeof withCommerceStoreSyncProviderReadFenceInPostgres
  withSources: typeof withCurrentCommerceProviderImageSources
  selectSource: typeof selectCommerceProviderImageSource
  fetchImage: typeof fetchCommerceProviderImage
  complete: typeof completeCommerceProductImageImportJobInPostgres
  fail: typeof failCommerceProductImageImportJobInPostgres
  park: typeof parkCommerceProductImageImportForStoreSyncPauseInPostgres
  parkRuntime:
    typeof parkCommerceProductImageImportForRuntimeMaintenanceInPostgres
  heartbeat: typeof recordCommerceProductImageImportWorkerHeartbeatInPostgres
}

const defaultDependencies: WorkerDependencies = {
  assertProviderIoReady: assertIntegrationCredentialProviderIoReady,
  resolveWaiting: resolveWaitingCommerceProductImageImportJobsInPostgres,
  claim: claimCommerceProductImageImportJobsInPostgres,
  assertCurrent: assertCommerceProductImageImportClaimCurrentInPostgres,
  withProviderReadFence: withCommerceStoreSyncProviderReadFenceInPostgres,
  withSources: withCurrentCommerceProviderImageSources,
  selectSource: selectCommerceProviderImageSource,
  fetchImage: fetchCommerceProviderImage,
  complete: completeCommerceProductImageImportJobInPostgres,
  fail: failCommerceProductImageImportJobInPostgres,
  park: parkCommerceProductImageImportForStoreSyncPauseInPostgres,
  parkRuntime: parkCommerceProductImageImportForRuntimeMaintenanceInPostgres,
  heartbeat: recordCommerceProductImageImportWorkerHeartbeatInPostgres,
}

function boundedLimit(value: unknown) {
  const parsed = Number(value ?? DEFAULT_JOB_LIMIT)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_JOB_LIMIT
  return Math.min(parsed, MAX_JOB_LIMIT)
}

function safeErrorCode(error: unknown) {
  const candidate = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null
  if (
    typeof candidate === 'string'
    && RETRYABLE_DATABASE_SQLSTATES.has(candidate)
  ) return RETRYABLE_DATABASE_ERROR_CODE
  return typeof candidate === 'string' && SAFE_ERROR_CODES.has(candidate)
    ? candidate
    : 'COMMERCE_PRODUCT_IMAGE_IMPORT_FAILED'
}

function errorStatus(error: unknown) {
  const value = error && typeof error === 'object' && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN
  return Number.isSafeInteger(value) ? value : null
}

function retryableFailure(error: unknown, code: string) {
  if (PERMANENT_ERROR_CODES.has(code)) return false
  if (RETRYABLE_ERROR_CODES.has(code)) return true
  const status = errorStatus(error)
  return status === 408 || status === 429 || (status !== null && status >= 500)
}

function retryDelaySeconds(claim: CommerceProductImageImportClaim) {
  const exponent = Math.max(0, Math.min(claim.attemptCount - 1, 5))
  return Math.min(30 * (2 ** exponent), MAX_RETRY_DELAY_SECONDS)
}

function sourceReadKey(claim: CommerceProductImageImportClaim) {
  return JSON.stringify([
    claim.organizationId,
    claim.integrationAccountId,
    claim.accountGlobalId,
    claim.provider,
    claim.credentialGeneration,
    claim.externalProductId,
  ])
}

function emptyResult(): CommerceProductImageImportWorkerResult {
  return {
    waitingResolved: 0,
    waitingMapping: 0,
    claimed: 0,
    providerReads: 0,
    fetched: 0,
    succeeded: 0,
    retried: 0,
    dead: 0,
    cancelled: 0,
    leaseLost: 0,
    failed: 0,
    parked: 0,
    providerWrites: 0,
    errorCodes: Object.create(null) as Record<string, number>,
  }
}

function countError(
  result: CommerceProductImageImportWorkerResult,
  code: string,
) {
  result.errorCodes[code] = (result.errorCodes[code] || 0) + 1
}

function leaseWasLost(error: unknown) {
  return safeErrorCode(error) === 'COMMERCE_PRODUCT_IMAGE_LEASE_LOST'
}

function storeSyncReadPaused(error: unknown) {
  const code = safeErrorCode(error)
  return code === 'COMMERCE_PRODUCT_IMAGE_STORE_SYNC_PAUSED'
    || code === 'COMMERCE_PROVIDER_IMAGE_SOURCE_STORE_SYNC_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_PAUSED'
    || code === 'COMMERCE_STORE_SYNC_PROVIDER_READ_LEASE_LOST'
}

/**
 * Imports provider product images without any provider mutation. Claims are
 * deliberately acquired one at a time so no unprocessed job sits on a lease.
 * Exact product source reads may be reused only during this bounded invocation;
 * every claimed image is still matched by both provider identity and locator
 * fingerprint before its transient locator is fetched.
 */
async function processBoundedCommerceProductImageImports(
  input: {
    limit?: number
    workerId: string
  },
  dependencies: WorkerDependencies,
): Promise<CommerceProductImageImportWorkerResult> {
  const result = emptyResult()
  const limit = boundedLimit(input.limit)
  dependencies.assertProviderIoReady()
  const resolved = await dependencies.resolveWaiting({
    updatedBy: input.workerId,
    limit: Math.min(MAX_WAITING_RESOLUTIONS, Math.max(10, limit * 10)),
  })
  result.waitingResolved = resolved.filter((entry) => (
    entry.state === 'queued'
  )).length

  const sourceReads = new Map<string, readonly CommerceProviderImageSource[]>()
  for (let index = 0; index < limit; index += 1) {
    dependencies.assertProviderIoReady()
    const [claim] = await dependencies.claim({
      workerId: input.workerId,
      limit: 1,
      leaseSeconds: JOB_LEASE_SECONDS,
    })
    if (!claim) break
    result.claimed += 1

    try {
      await dependencies.assertCurrent({
        organizationId: claim.organizationId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        workerId: input.workerId,
      })
      const readKey = sourceReadKey(claim)
      let sources = sourceReads.get(readKey)
      let completion
      if (!sources) {
        // One durable automatic-read lease owns both source discovery and the
        // selected byte fetch. The public manual source seam owns its own
        // lease, so the worker never nests transactions or pool connections.
        dependencies.assertProviderIoReady()
        completion = await dependencies.withSources({
          organizationId: claim.organizationId,
          accountGlobalId: claim.accountGlobalId,
          provider: claim.provider,
          credentialGeneration: claim.credentialGeneration,
          externalProductId: claim.externalProductId,
          authorityKind: claim.providerReadAuthority,
          intentKey: `${claim.jobId}:${claim.leaseToken}`,
          acquiredBy: input.workerId,
          consume: async (currentSources, providerReadLease) => {
            sources = currentSources
            sourceReads.set(readKey, currentSources)
            result.providerReads += 1
            const selected = dependencies.selectSource({
              sources: currentSources,
              providerImageId: claim.providerImageId,
              locatorSha256: claim.locatorSha256,
            })
            await dependencies.assertCurrent({
              organizationId: claim.organizationId,
              jobId: claim.jobId,
              leaseToken: claim.leaseToken,
              workerId: input.workerId,
            })
            dependencies.assertProviderIoReady()
            const image = await dependencies.fetchImage({ url: selected.url })
            result.fetched += 1
            return dependencies.complete({
              organizationId: claim.organizationId,
              jobId: claim.jobId,
              leaseToken: claim.leaseToken,
              actorEmail: claim.actorEmail,
              providerReadLease,
              bytes: image.bytes,
              declaredMimeType: image.mediaType,
              sourceByteLength: image.sourceByteLength,
              sourceContentSha256: image.sourceContentSha256,
              normalizationVersion: image.normalizationVersion,
            })
          },
        })
      } else {
        const selected = dependencies.selectSource({
          sources,
          providerImageId: claim.providerImageId,
          locatorSha256: claim.locatorSha256,
        })
        dependencies.assertProviderIoReady()
        completion = await dependencies.withProviderReadFence({
          organizationId: claim.organizationId,
          integrationAccountId: claim.integrationAccountId,
          authorityKind: claim.providerReadAuthority,
          readKind: 'product_image_import',
          intentKey: `${claim.jobId}:${claim.leaseToken}`,
          acquiredBy: input.workerId,
          read: async (providerReadLease) => {
            await dependencies.assertCurrent({
              organizationId: claim.organizationId,
              jobId: claim.jobId,
              leaseToken: claim.leaseToken,
              workerId: input.workerId,
            })
            dependencies.assertProviderIoReady()
            const image = await dependencies.fetchImage({ url: selected.url })
            result.fetched += 1
            return dependencies.complete({
              organizationId: claim.organizationId,
              jobId: claim.jobId,
              leaseToken: claim.leaseToken,
              actorEmail: claim.actorEmail,
              providerReadLease,
              bytes: image.bytes,
              declaredMimeType: image.mediaType,
              sourceByteLength: image.sourceByteLength,
              sourceContentSha256: image.sourceContentSha256,
              normalizationVersion: image.normalizationVersion,
            })
          },
        })
      }
      void completion
      result.succeeded += 1
    } catch (error) {
      if (isIntegrationCredentialRuntimeGateError(error)) {
        try {
          const disposition = await dependencies.parkRuntime({
            organizationId: claim.organizationId,
            jobId: claim.jobId,
            leaseToken: claim.leaseToken,
            workerId: input.workerId,
            errorCode: String(
              (error as { code?: unknown }).code || '',
            ),
          })
          if (disposition.parked) result.parked += 1
          else result.leaseLost += 1
        } catch {
          result.leaseLost += 1
        }
        throw error
      }
      const code = safeErrorCode(error)
      if (storeSyncReadPaused(error)) {
        try {
          const disposition = await dependencies.park({
            organizationId: claim.organizationId,
            jobId: claim.jobId,
            leaseToken: claim.leaseToken,
            workerId: input.workerId,
          })
          if (disposition.parked) result.parked += 1
          else result.leaseLost += 1
        } catch (parkError) {
          result.leaseLost += 1
          countError(result, safeErrorCode(parkError))
        }
        countError(result, code)
        continue
      }
      if (leaseWasLost(error)) {
        result.leaseLost += 1
        countError(result, code)
        continue
      }
      try {
        const failure = await dependencies.fail({
          organizationId: claim.organizationId,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          workerId: input.workerId,
          errorCode: code,
          retryable: retryableFailure(error, code),
          retryAfterSeconds: retryDelaySeconds(claim),
        })
        if (failure.state === 'waiting_mapping') {
          result.waitingMapping += 1
        } else if (failure.state === 'retry') {
          result.retried += 1
        } else if (failure.state === 'dead') {
          result.dead += 1
        } else {
          result.cancelled += 1
        }
        countError(result, code)
      } catch (failureError) {
        const failureCode = safeErrorCode(failureError)
        if (leaseWasLost(failureError)) {
          result.leaseLost += 1
          countError(result, failureCode)
          continue
        }
        result.failed += 1
        countError(result, failureCode)
      }
    }
  }
  return result
}

export async function processCommerceProductImageImports(
  input: {
    limit?: number
    workerId: string
  },
  injected: Partial<WorkerDependencies> = {},
): Promise<CommerceProductImageImportWorkerResult> {
  const dependencies = { ...defaultDependencies, ...injected }
  try {
    await dependencies.heartbeat({ phase: 'starting' })
    const result = await processBoundedCommerceProductImageImports(
      input,
      dependencies,
    )
    await dependencies.heartbeat({ phase: 'completed' })
    return result
  } catch (error) {
    await dependencies.heartbeat({ phase: 'degraded' }).catch(() => undefined)
    throw error
  }
}
