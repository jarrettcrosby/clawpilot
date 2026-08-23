import { createHash } from 'node:crypto'
import {
  CommerceProviderImageSourceError,
  withCurrentCommerceProviderImageSources,
} from '@/lib/integrations/commerceProviderImageSource'
import {
  FaireProductImageRefreshError,
  type FaireProductImageRefreshTarget,
} from '@/lib/integrations/faireProductImageRefreshTypes'
import {
  CommerceProductImageImportError,
  type CommerceProductImageImportJobState,
} from '@/lib/persistence/commerceProductImageImports'
import {
  readFaireProductImageRefreshTargetInPostgres,
  reconcileExactFaireProductImageRefreshInPostgres,
} from '@/lib/persistence/faireProductImageRefresh'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_GLOBAL_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const CHANNEL_GLOBAL_PATTERN = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_REFERENCE_PATTERN = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const FAIRE_PRODUCT_PATTERN = /^p_[A-Za-z0-9_-]+$/
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u

export type FaireProductImageRefreshResult = Readonly<{
  productId: string
  productReferenceCode: string
  channelStateGlobalId: string
  integrationAccountGlobalId: string
  externalProductId: string
  externalVariantId: string
  providerSku: string
  credentialGeneration: number
  channelStateRowVersion: number
  channelSourceRevision: string
  logicalReadOperations: 1
  providerRequests: 2
  providerWrites: 0
  imageSetComplete: false
  removalsInferred: false
  staleSnapshotIgnored: boolean
  observedImages: number
  jobs: Record<CommerceProductImageImportJobState, number>
  nextAction: 'background_import'
}>

type Dependencies = {
  readTarget: typeof readFaireProductImageRefreshTargetInPostgres
  withSources: typeof withCurrentCommerceProviderImageSources
  reconcile: typeof reconcileExactFaireProductImageRefreshInPostgres
  now: () => Date
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  readTarget: readFaireProductImageRefreshTargetInPostgres,
  withSources: withCurrentCommerceProviderImageSources,
  reconcile: reconcileExactFaireProductImageRefreshInPostgres,
  now: () => new Date(),
}

function fail(code: string, message: string, status = 400): never {
  throw new FaireProductImageRefreshError(code, message, status)
}

function exactText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string') {
    fail('FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_INVALID', `${label} is required`)
  }
  const trimmed = value.trim()
  if (
    !trimmed
    || trimmed !== value
    || trimmed.length > maximum
    || !SAFE_TEXT_PATTERN.test(trimmed)
  ) {
    fail('FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_INVALID', `${label} is invalid`)
  }
  return trimmed
}

function uuid(value: unknown, label: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_INVALID',
      `${label} is invalid`,
      404,
    )
  }
  return normalized
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function evidenceHash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function emptyJobCounts(): Record<CommerceProductImageImportJobState, number> {
  return {
    waiting_mapping: 0,
    queued: 0,
    claimed: 0,
    retry: 0,
    succeeded: 0,
    dead: 0,
    cancelled: 0,
  }
}

function assertReviewedTarget(
  target: FaireProductImageRefreshTarget,
  reviewed: {
    expectedProductReferenceCode: string
    expectedIntegrationAccountGlobalId: string
    expectedChannelStateRowVersion: number
    expectedChannelSourceRevision: string
    expectedExternalProductId: string
    expectedExternalVariantId: string
    expectedProviderSku: string
  },
) {
  if (
    target.productReferenceCode !== reviewed.expectedProductReferenceCode
    || target.integrationAccountGlobalId
      !== reviewed.expectedIntegrationAccountGlobalId
    || target.channelStateRowVersion
      !== reviewed.expectedChannelStateRowVersion
    || target.channelSourceRevision
      !== reviewed.expectedChannelSourceRevision
    || target.externalProductId !== reviewed.expectedExternalProductId
    || target.externalVariantId !== reviewed.expectedExternalVariantId
    || target.providerSku !== reviewed.expectedProviderSku
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_STALE',
      'The reviewed ClawPilot Product, Faire listing, variant, or SKU changed before refresh',
      409,
    )
  }
}

function sanitizedFailure(error: unknown): never {
  if (error instanceof FaireProductImageRefreshError) throw error
  if (
    error instanceof CommerceProviderImageSourceError
    || error instanceof CommerceProductImageImportError
  ) {
    throw new FaireProductImageRefreshError(
      error.code,
      error.message,
      error.status,
    )
  }
  throw new FaireProductImageRefreshError(
    'FAIRE_PRODUCT_IMAGE_REFRESH_FAILED',
    'Faire Product images could not be refreshed',
    500,
  )
}

/**
 * Queue image imports for one exact mapped Faire Product. One logical source
 * read makes two bounded Faire GET requests: current brand profile followed by
 * the exact Product. This operation cannot issue Faire writes.
 * Raw image locators remain transient and are reduced to query-free SHA-256
 * fingerprints before the durable reconciliation boundary.
 */
export async function refreshExactFaireProductImages(
  rawInput: {
    organizationId: unknown
    productId: unknown
    channelStateGlobalId: unknown
    expectedProductReferenceCode: unknown
    expectedIntegrationAccountGlobalId: unknown
    expectedChannelStateRowVersion: unknown
    expectedChannelSourceRevision: unknown
    expectedExternalProductId: unknown
    expectedExternalVariantId: unknown
    expectedProviderSku: unknown
    confirmReadOnlyProviderRequest: unknown
    idempotencyKey: unknown
    actorEmail: string
  },
  overrides: Partial<Dependencies> = {},
): Promise<FaireProductImageRefreshResult> {
  if (rawInput.confirmReadOnlyProviderRequest !== true) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_CONFIRMATION_REQUIRED',
      'Confirm one read-only Faire Product image refresh',
    )
  }
  const input = {
    organizationId: uuid(rawInput.organizationId, 'Organization'),
    productId: uuid(rawInput.productId, 'Product'),
    channelStateGlobalId: exactText(
      rawInput.channelStateGlobalId,
      'Faire channel selection',
      64,
    ).toLowerCase(),
    expectedProductReferenceCode: exactText(
      rawInput.expectedProductReferenceCode,
      'Product reference',
      64,
    ).toLowerCase(),
    expectedIntegrationAccountGlobalId: exactText(
      rawInput.expectedIntegrationAccountGlobalId,
      'Faire account reference',
      64,
    ).toLowerCase(),
    expectedChannelStateRowVersion: Number(
      rawInput.expectedChannelStateRowVersion,
    ),
    expectedChannelSourceRevision: exactText(
      rawInput.expectedChannelSourceRevision,
      'Faire channel revision',
      2_048,
    ),
    expectedExternalProductId: exactText(
      rawInput.expectedExternalProductId,
      'Faire Product identity',
      512,
    ),
    expectedExternalVariantId: exactText(
      rawInput.expectedExternalVariantId,
      'Faire variant identity',
      512,
    ),
    expectedProviderSku: exactText(
      rawInput.expectedProviderSku,
      'Faire SKU',
      255,
    ),
    actorEmail: exactText(rawInput.actorEmail, 'Actor email', 255),
    idempotencyKey: exactText(
      rawInput.idempotencyKey,
      'Idempotency key',
      200,
    ),
  }
  if (
    !CHANNEL_GLOBAL_PATTERN.test(input.channelStateGlobalId)
    || !PRODUCT_REFERENCE_PATTERN.test(input.expectedProductReferenceCode)
    || !ACCOUNT_GLOBAL_PATTERN.test(
      input.expectedIntegrationAccountGlobalId,
    )
    || !Number.isSafeInteger(input.expectedChannelStateRowVersion)
    || input.expectedChannelStateRowVersion < 0
    || !FAIRE_PRODUCT_PATTERN.test(input.expectedExternalProductId)
    || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REFRESH_SELECTION_INVALID',
      'The exact Product, Faire listing, variant, SKU, and revision evidence are required',
      409,
    )
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  try {
    const target = await dependencies.readTarget({
      organizationId: input.organizationId,
      productId: input.productId,
      channelStateGlobalId: input.channelStateGlobalId,
    })
    assertReviewedTarget(target, input)
    const observedAt = dependencies.now()
    if (!Number.isFinite(observedAt.getTime())) {
      fail(
        'FAIRE_PRODUCT_IMAGE_REFRESH_CLOCK_INVALID',
        'Faire Product image refresh time is invalid',
        500,
      )
    }
    return await dependencies.withSources({
      organizationId: target.organizationId,
      accountGlobalId: target.integrationAccountGlobalId,
      provider: 'faire',
      credentialGeneration: target.credentialGeneration,
      externalProductId: target.externalProductId,
      authorityKind: 'manual_read_only',
      intentKey: `faire-product-image-refresh:${input.idempotencyKey}`,
      acquiredBy: input.actorEmail,
      consume: async (sources, providerReadLease) => {
        const safeImages = sources.map((source) => ({
          providerImageId: source.providerImageId,
          locatorSha256: source.locatorSha256,
          sequence: source.sequence,
          altText: target.productName,
          pixelWidth: null,
          pixelHeight: null,
          sourceHash: evidenceHash({
            schema: 'faire-targeted-product-image-observation-v1',
            providerImageId: source.providerImageId,
            locatorSha256: source.locatorSha256,
            sequence: source.sequence,
            altText: target.productName,
          }),
        }))
        const productSourceHash = evidenceHash({
          schema: 'faire-targeted-product-image-refresh-v1',
          account: target.integrationAccountGlobalId,
          credentialGeneration: target.credentialGeneration,
          externalProductId: target.externalProductId,
          externalVariantId: target.externalVariantId,
          providerSku: target.providerSku,
          images: safeImages,
        })
        const reconciled = await dependencies.reconcile({
          target,
          observedAt,
          productSourceHash,
          actorEmail: input.actorEmail,
          images: safeImages,
          providerReadLease,
        })
        const jobs = emptyJobCounts()
        for (const receipt of reconciled.active) jobs[receipt.jobState] += 1
        return Object.freeze({
          productId: target.productId,
          productReferenceCode: target.productReferenceCode,
          channelStateGlobalId: target.channelStateGlobalId,
          integrationAccountGlobalId: target.integrationAccountGlobalId,
          externalProductId: target.externalProductId,
          externalVariantId: target.externalVariantId,
          providerSku: target.providerSku,
          credentialGeneration: target.credentialGeneration,
          channelStateRowVersion: target.channelStateRowVersion,
          channelSourceRevision: target.channelSourceRevision,
          logicalReadOperations: 1 as const,
          providerRequests: 2 as const,
          providerWrites: 0 as const,
          imageSetComplete: false as const,
          removalsInferred: false as const,
          staleSnapshotIgnored: reconciled.staleSnapshotIgnored,
          observedImages: reconciled.active.length,
          jobs,
          nextAction: 'background_import' as const,
        })
      },
    })
  } catch (error) {
    sanitizedFailure(error)
  }
}
