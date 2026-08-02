import {
  fetchCommerceProviderImage,
} from '@/lib/integrations/commerceProviderImageFetch'
import {
  readCurrentCommerceProviderImageSources,
  selectCommerceProviderImageSource,
  type CommerceProviderImageSource,
} from '@/lib/integrations/commerceProviderImageSource'
import {
  claimCommerceProductImageImportJobsInPostgres,
  completeCommerceProductImageImportJobInPostgres,
  failCommerceProductImageImportJobInPostgres,
  recordCommerceProductImageImportWorkerHeartbeatInPostgres,
  resolveWaitingCommerceProductImageImportJobsInPostgres,
  type CommerceProductImageImportClaim,
} from '@/lib/persistence/commerceProductImageImports'

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
  'COMMERCE_PROVIDER_IMAGE_DNS_FAILED',
  'COMMERCE_PROVIDER_IMAGE_DNS_EMPTY',
  'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID',
  'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT',
  'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED',
  'COMMERCE_PROVIDER_IMAGE_TIMEOUT',
  'COMMERCE_PROVIDER_IMAGE_ABORTED',
  'COMMERCE_PROVIDER_IMAGE_STATUS_INVALID',
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
  providerWrites: 0
  errorCodes: Record<string, number>
}

type WorkerDependencies = {
  resolveWaiting: typeof resolveWaitingCommerceProductImageImportJobsInPostgres
  claim: typeof claimCommerceProductImageImportJobsInPostgres
  readSources: typeof readCurrentCommerceProviderImageSources
  selectSource: typeof selectCommerceProviderImageSource
  fetchImage: typeof fetchCommerceProviderImage
  complete: typeof completeCommerceProductImageImportJobInPostgres
  fail: typeof failCommerceProductImageImportJobInPostgres
  heartbeat: typeof recordCommerceProductImageImportWorkerHeartbeatInPostgres
}

const defaultDependencies: WorkerDependencies = {
  resolveWaiting: resolveWaitingCommerceProductImageImportJobsInPostgres,
  claim: claimCommerceProductImageImportJobsInPostgres,
  readSources: readCurrentCommerceProviderImageSources,
  selectSource: selectCommerceProviderImageSource,
  fetchImage: fetchCommerceProviderImage,
  complete: completeCommerceProductImageImportJobInPostgres,
  fail: failCommerceProductImageImportJobInPostgres,
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
  const resolved = await dependencies.resolveWaiting({
    updatedBy: input.workerId,
    limit: Math.min(MAX_WAITING_RESOLUTIONS, Math.max(10, limit * 10)),
  })
  result.waitingResolved = resolved.filter((entry) => (
    entry.state === 'queued'
  )).length

  const sourceReads = new Map<string, readonly CommerceProviderImageSource[]>()
  for (let index = 0; index < limit; index += 1) {
    const [claim] = await dependencies.claim({
      workerId: input.workerId,
      limit: 1,
      leaseSeconds: JOB_LEASE_SECONDS,
    })
    if (!claim) break
    result.claimed += 1

    try {
      const readKey = sourceReadKey(claim)
      let sources = sourceReads.get(readKey)
      if (!sources) {
        sources = await dependencies.readSources({
          organizationId: claim.organizationId,
          accountGlobalId: claim.accountGlobalId,
          provider: claim.provider,
          credentialGeneration: claim.credentialGeneration,
          externalProductId: claim.externalProductId,
        })
        sourceReads.set(readKey, sources)
        result.providerReads += 1
      }
      const selected = dependencies.selectSource({
        sources,
        providerImageId: claim.providerImageId,
        locatorSha256: claim.locatorSha256,
      })
      const image = await dependencies.fetchImage({ url: selected.url })
      result.fetched += 1
      await dependencies.complete({
        organizationId: claim.organizationId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        actorEmail: claim.actorEmail,
        bytes: image.bytes,
        declaredMimeType: image.mediaType,
      })
      result.succeeded += 1
    } catch (error) {
      const code = safeErrorCode(error)
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
