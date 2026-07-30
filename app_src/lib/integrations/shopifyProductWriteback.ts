import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
  type ShopifyCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  type ShopifyCommerceClientOptions,
  type ShopifyCommerceRuntimeCredential,
  type ShopifyConnectionProbe,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  assertRedactedCommerceExternalEffectEvidence,
  claimCommerceExternalEffectsInPostgres,
  commerceExternalEffectHash,
  finalizeCommerceExternalEffectInPostgres,
  prepareCommerceExternalEffectInPostgres,
  type ClaimedCommerceExternalEffect,
  type CommerceExternalEffect,
  type CommerceExternalEffectMode,
} from '@/lib/persistence/commerceExternalEffects'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'

const PRODUCT_GID_PATTERN =
  /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MEDIA_IMAGE_GID_PATTERN =
  /^gid:\/\/shopify\/MediaImage\/[1-9][0-9]*$/
const TAXONOMY_CATEGORY_GID_PATTERN =
  /^gid:\/\/shopify\/TaxonomyCategory\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SHOP_GID_PATTERN = /^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const SAFE_IDENTIFIER_PATTERN = /^[\x20-\x7e]+$/
const ACTIVE_TERMINAL_STATES = new Set([
  'succeeded',
  'failed',
  'unknown',
])

export const SHOPIFY_PRODUCT_WRITEBACK_API_VERSION = '2026-07'
export const SHOPIFY_PRODUCT_WRITEBACK_REQUIRED_SCOPE = 'write_products'
export const SHOPIFY_PRODUCT_WRITEBACK_ADAPTER_VERSION =
  'shopify-graphql-2026-07-product-update-v2'
export const SHOPIFY_PRODUCT_WRITEBACK_AGGREGATE_TYPE =
  'shopify_product_projection'
export const SHOPIFY_PRODUCT_MEDIA_ABSENCE_QUERY_CONTRACT =
  'shopify-graphql-2026-07-product-media-absence-v1'

export type ShopifyProductImageWriteback = {
  originalSource: string
  alt?: string | null
}

export type ShopifyProductWritebackPatch = {
  title?: string
  categoryGid?: string
  image?: ShopifyProductImageWriteback
}

export type ShopifyProductWritebackInput = {
  organizationId: unknown
  accountGlobalId: unknown
  mode: CommerceExternalEffectMode
  credentialGeneration: unknown
  activationRevision: unknown
  aggregateId: unknown
  aggregateRevision: unknown
  aggregateHash: unknown
  idempotencyKey: unknown
  productGid: unknown
  patch: ShopifyProductWritebackPatch
  productMediaAuthorizationId?: unknown
  productMediaDeliveryGrantId?: unknown
  actorEmail?: string | null
  workerId?: string
}

type NormalizedShopifyProductWritebackInput = {
  organizationId: string
  accountGlobalId: string
  mode: CommerceExternalEffectMode
  credentialGeneration: number
  activationRevision: number
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  productGid: string
  patch: ShopifyProductWritebackPatch
  productMediaAuthorizationId: string | null
  productMediaDeliveryGrantId: string | null
  actorEmail: string | null
  workerId: string
  action: 'shopify.product.update'
  redactedRequest: Record<string, unknown>
}

export type ShopifyProductWritebackProviderResult = {
  productGid: string
  title: string
  categoryGid: string | null
  mediaRequested: boolean
  media: ShopifyProductWritebackMediaResult | null
}

export type ShopifyProductWritebackMediaStatus =
  | 'FAILED'
  | 'PROCESSING'
  | 'READY'
  | 'UPLOADED'

export type ShopifyProductWritebackMediaError = {
  code: string
  message: string
  details: string | null
}

export type ShopifyProductWritebackMediaResult = {
  mediaImageGid: string
  status: ShopifyProductWritebackMediaStatus
  errors: ShopifyProductWritebackMediaError[]
  ready: boolean
}

export type ShopifyProductMediaAbsenceRead = {
  productGid: string
  title: string
  mediaCount: number
  latestMedia: {
    mediaGid: string
    mediaContentType: string
    status: ShopifyProductWritebackMediaStatus
  } | null
}

export type ShopifyProductWritebackResult = {
  effect: CommerceExternalEffect
  productGid: string
  replayed: boolean
  providerMutationAccepted: boolean
  media: ShopifyProductWritebackMediaResult | null
}

export class ShopifyProductWritebackError extends Error {
  readonly code: string
  readonly status: number
  readonly retryable: boolean
  readonly effectGlobalId: string | null
  readonly providerRejected: boolean

  constructor(input: {
    code: string
    message: string
    status?: number
    retryable?: boolean
    effectGlobalId?: string | null
    providerRejected?: boolean
  }) {
    super(input.message)
    this.name = 'ShopifyProductWritebackError'
    this.code = input.code
    this.status = input.status || 409
    this.retryable = Boolean(input.retryable)
    this.effectGlobalId = input.effectGlobalId || null
    this.providerRejected = Boolean(input.providerRejected)
  }
}

export type ShopifyProductWritebackDependencies = {
  prepareExternalEffect: typeof prepareCommerceExternalEffectInPostgres
  claimExternalEffects: typeof claimCommerceExternalEffectsInPostgres
  finalizeExternalEffect: typeof finalizeCommerceExternalEffectInPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  mutateProduct: typeof updateShopifyProduct
}

export type ShopifyProductMediaStatusReadDependencies = Pick<
  ShopifyProductWritebackDependencies,
  | 'readRuntimeCredential'
  | 'decryptCredential'
  | 'requestAccessToken'
  | 'probeConnection'
> & {
  readMediaStatus: typeof readShopifyProductMediaStatus
}

export type ShopifyProductMediaAbsenceReadDependencies = Pick<
  ShopifyProductWritebackDependencies,
  | 'readRuntimeCredential'
  | 'decryptCredential'
  | 'requestAccessToken'
  | 'probeConnection'
> & {
  readProductMedia: typeof readShopifyProductMediaAbsence
}

const DEFAULT_DEPENDENCIES: ShopifyProductWritebackDependencies = {
  prepareExternalEffect: prepareCommerceExternalEffectInPostgres,
  claimExternalEffects: claimCommerceExternalEffectsInPostgres,
  finalizeExternalEffect: finalizeCommerceExternalEffectInPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  mutateProduct: updateShopifyProduct,
}

const DEFAULT_MEDIA_STATUS_DEPENDENCIES:
ShopifyProductMediaStatusReadDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readMediaStatus: readShopifyProductMediaStatus,
}

const DEFAULT_MEDIA_ABSENCE_DEPENDENCIES:
ShopifyProductMediaAbsenceReadDependencies = {
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readProductMedia: readShopifyProductMediaAbsence,
}

function writebackError(
  code: string,
  message: string,
  status = 400,
  retryable = false,
  effectGlobalId?: string | null,
  providerRejected = false,
): never {
  throw new ShopifyProductWritebackError({
    code,
    message,
    status,
    retryable,
    effectGlobalId,
    providerRejected,
  })
}

function safeIdentifier(
  value: unknown,
  label: string,
  maximum = 512,
) {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > maximum
    || !SAFE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_INPUT_INVALID',
      `${label} is invalid`,
    )
  }
  return normalized
}

function positiveRevision(value: unknown, label: string) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_REVISION_INVALID',
      `${label} is invalid`,
    )
  }
  return revision
}

function aggregateRevision(value: unknown) {
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_REVISION_INVALID',
      'Product aggregate revision is invalid',
    )
  }
  return revision
}

function normalizeProductGid(value: unknown) {
  const gid = String(value || '').trim()
  if (!PRODUCT_GID_PATTERN.test(gid)) {
    writebackError(
      'SHOPIFY_PRODUCT_GID_REQUIRED',
      'An exact Shopify Product GID is required',
    )
  }
  return gid
}

function normalizeTitle(value: unknown) {
  if (typeof value !== 'string') {
    writebackError(
      'SHOPIFY_PRODUCT_TITLE_INVALID',
      'Shopify product title is invalid',
    )
  }
  const title = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || title.length > 255) {
    writebackError(
      'SHOPIFY_PRODUCT_TITLE_INVALID',
      'Shopify product title must contain 1-255 characters',
    )
  }
  return title
}

function normalizeCategoryGid(value: unknown) {
  const gid = String(value || '').trim()
  if (!TAXONOMY_CATEGORY_GID_PATTERN.test(gid)) {
    writebackError(
      'SHOPIFY_PRODUCT_CATEGORY_GID_INVALID',
      'Shopify category must be an exact TaxonomyCategory GID',
    )
  }
  return gid
}

function normalizeImage(value: ShopifyProductImageWriteback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    writebackError(
      'SHOPIFY_PRODUCT_IMAGE_INVALID',
      'Shopify product image input is invalid',
    )
  }
  let url: URL
  try {
    url = new URL(value.originalSource)
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_IMAGE_INVALID',
      'Shopify product image requires an HTTPS source URL',
    )
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || !url.hostname
    || value.originalSource.length > 2_048
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_IMAGE_INVALID',
      'Shopify product image requires a bounded public HTTPS source URL',
    )
  }
  let alt: string | undefined
  if (value.alt !== undefined && value.alt !== null) {
    if (typeof value.alt !== 'string') {
      writebackError(
        'SHOPIFY_PRODUCT_IMAGE_ALT_INVALID',
        'Shopify product image alternative text is invalid',
      )
    }
    alt = value.alt
      .normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (alt.length > 512) {
      writebackError(
        'SHOPIFY_PRODUCT_IMAGE_ALT_INVALID',
        'Shopify product image alternative text is too long',
      )
    }
  }
  return {
    originalSource: url.toString(),
    ...(alt !== undefined ? { alt } : {}),
  }
}

function normalizePatch(value: ShopifyProductWritebackPatch) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    writebackError(
      'SHOPIFY_PRODUCT_PATCH_REQUIRED',
      'A Shopify product change is required',
    )
  }
  const patch: ShopifyProductWritebackPatch = {}
  if (Object.prototype.hasOwnProperty.call(value, 'title')) {
    patch.title = normalizeTitle(value.title)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'categoryGid')) {
    patch.categoryGid = normalizeCategoryGid(value.categoryGid)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'image')) {
    patch.image = normalizeImage(value.image as ShopifyProductImageWriteback)
  }
  if (!Object.keys(patch).length) {
    writebackError(
      'SHOPIFY_PRODUCT_PATCH_REQUIRED',
      'At least one Shopify product field must change',
    )
  }
  return patch
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function redactedPatch(patch: ShopifyProductWritebackPatch) {
  return {
    ...(patch.title !== undefined
      ? {
          titleSha256: sha256(patch.title),
          titleLength: patch.title.length,
        }
      : {}),
    ...(patch.categoryGid !== undefined
      ? { categoryGid: patch.categoryGid }
      : {}),
    ...(patch.image
      ? {
          media: {
            mediaContentType: 'IMAGE',
            originalSourceSha256: sha256(patch.image.originalSource),
            sourceHost: new URL(patch.image.originalSource).hostname,
            ...(typeof patch.image.alt === 'string'
              ? {
                  altSha256: sha256(patch.image.alt),
                  altLength: patch.image.alt.length,
                }
              : {}),
          },
        }
      : {}),
  }
}

function normalizeInput(
  input: ShopifyProductWritebackInput,
): NormalizedShopifyProductWritebackInput {
  let organizationId: string
  let accountGlobalId: string
  try {
    organizationId = normalizeCommerceOrganizationId(input.organizationId)
    accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_IDENTITY_INVALID',
      'Shopify organization or connection identity is invalid',
    )
  }
  if (!['shadow', 'active'].includes(input.mode)) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_MODE_INVALID',
      'Shopify product writeback must be Shadow or Active',
    )
  }
  const productGid = normalizeProductGid(input.productGid)
  const patch = normalizePatch(input.patch)
  const productMediaAuthorizationId = input.productMediaAuthorizationId
    ? String(input.productMediaAuthorizationId).trim().toLowerCase()
    : null
  const productMediaDeliveryGrantId = input.productMediaDeliveryGrantId
    ? String(input.productMediaDeliveryGrantId).trim().toLowerCase()
    : null
  if (
    productMediaDeliveryGrantId
    && (
      !UUID_PATTERN.test(productMediaDeliveryGrantId)
      || !patch.image
      || Object.keys(patch).length !== 1
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_AUTHORITY_INVALID',
      'Exact Shopify Product-image authority can authorize only one Active image append',
    )
  }
  if (
    productMediaAuthorizationId
    && (
      !UUID_PATTERN.test(productMediaAuthorizationId)
      || !productMediaDeliveryGrantId
      || input.mode !== 'active'
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_AUTHORITY_INVALID',
      'Exact Shopify Product-image authority requires one Active image append and its delivery grant',
    )
  }
  if (
    input.mode === 'active'
    && patch.image
    && !productMediaAuthorizationId
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_AUTHORITY_REQUIRED',
      'A Shopify Product-image provider write requires exact resource authority',
    )
  }
  const aggregateHash = String(input.aggregateHash || '')
    .trim()
    .toLowerCase()
  if (!SHA256_PATTERN.test(aggregateHash)) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_AGGREGATE_HASH_INVALID',
      'Product aggregate hash is invalid',
    )
  }
  const aggregateId = safeIdentifier(
    input.aggregateId,
    'Product aggregate identity',
  )
  const idempotencyKey = safeIdentifier(
    input.idempotencyKey,
    'Product writeback idempotency key',
    255,
  )
  const workerId = input.workerId
    ? safeIdentifier(input.workerId, 'Product writeback worker', 255)
    : 'shopify-product-writeback'
  const credentialGeneration = positiveRevision(
    input.credentialGeneration,
    'Shopify credential generation',
  )
  const activationRevision = positiveRevision(
    input.activationRevision,
    'Operations activation revision',
  )
  const normalizedAggregateRevision = aggregateRevision(
    input.aggregateRevision,
  )
  const redactedRequest = {
    provider: 'shopify',
    apiVersion: SHOPIFY_PRODUCT_WRITEBACK_API_VERSION,
    requiredScope: SHOPIFY_PRODUCT_WRITEBACK_REQUIRED_SCOPE,
    operation: 'productUpdate',
    accountGlobalId,
    productGid,
    patch: redactedPatch(patch),
    ...(productMediaDeliveryGrantId
      ? {
          deliveryGrantId: productMediaDeliveryGrantId,
          ...(productMediaAuthorizationId
            ? { productMediaAuthorizationId }
            : {}),
        }
      : {}),
  }
  assertRedactedCommerceExternalEffectEvidence(
    redactedRequest,
    'Shopify product writeback request',
  )
  return {
    organizationId,
    accountGlobalId,
    mode: input.mode,
    credentialGeneration,
    activationRevision,
    aggregateId,
    aggregateRevision: normalizedAggregateRevision,
    aggregateHash,
    idempotencyKey,
    productGid,
    patch,
    productMediaAuthorizationId,
    productMediaDeliveryGrantId,
    actorEmail: input.actorEmail || null,
    workerId,
    action: 'shopify.product.update',
    redactedRequest,
  }
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeUserErrors(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      'Shopify returned invalid product-update errors',
      502,
    )
  }
  return value.map((entry) => {
    const error = safeRecord(entry)
    const field = Array.isArray(error?.field)
      ? error.field.filter((part) => typeof part === 'string').slice(0, 16)
      : []
    const code = typeof error?.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? error.code
      : 'USER_ERROR'
    return { field, code }
  })
}

function boundedProviderText(
  value: unknown,
  label: string,
  maximum: number,
  nullable = false,
) {
  if (nullable && (value === null || value === undefined)) return null
  if (typeof value !== 'string') {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
    )
  }
  const normalized = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized || normalized.length > maximum) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      `Shopify returned invalid ${label}`,
      502,
    )
  }
  return normalized
}

function safeMediaErrors(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      'Shopify returned invalid product-media errors',
      502,
    )
  }
  return value.map((entry) => {
    const error = safeRecord(entry)
    const code = error?.code
    if (
      !error
      || typeof code !== 'string'
      || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
        'Shopify returned invalid product-media error evidence',
        502,
      )
    }
    return {
      code,
      message: boundedProviderText(
        error.message,
        'product-media error message',
        2_048,
      ) as string,
      details: boundedProviderText(
        error.details,
        'product-media error details',
        4_096,
        true,
      ),
    }
  })
}

function safeMediaResult(
  value: unknown,
): ShopifyProductWritebackMediaResult {
  const media = safeRecord(value)
  const mediaImageGid = media?.id
  const status = media?.status
  if (
    media?.mediaContentType !== 'IMAGE'
    || typeof mediaImageGid !== 'string'
    || !MEDIA_IMAGE_GID_PATTERN.test(mediaImageGid)
    || !['FAILED', 'PROCESSING', 'READY', 'UPLOADED'].includes(
      String(status || ''),
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      'Shopify did not return the accepted product image',
      502,
    )
  }
  const normalizedStatus =
    status as ShopifyProductWritebackMediaStatus
  const errors = safeMediaErrors(media.mediaErrors)
  return {
    mediaImageGid,
    status: normalizedStatus,
    errors,
    ready: normalizedStatus === 'READY',
  }
}

const SHOPIFY_PRODUCT_UPDATE_MUTATION =
  `mutation ClawPilotShopifyProductUpdate(
    $product: ProductUpdateInput!
    $media: [CreateMediaInput!]
  ) {
    productUpdate(product: $product, media: $media) {
      product {
        id
        title
        category {
          id
        }
        media(first: 1, reverse: true, sortKey: POSITION) {
          nodes {
            id
            mediaContentType
            status
            mediaErrors {
              code
              details
              message
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }`

/**
 * Issue one exact Shopify productUpdate request. The caller must have already
 * claimed the durable external-effect intent.
 */
export async function updateShopifyProduct(
  credential: ShopifyCommerceRuntimeCredential,
  input: {
    productGid: string
    patch: ShopifyProductWritebackPatch
  },
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyProductWritebackProviderResult> {
  const product = {
    id: normalizeProductGid(input.productGid),
    ...(input.patch.title !== undefined
      ? { title: normalizeTitle(input.patch.title) }
      : {}),
    ...(input.patch.categoryGid !== undefined
      ? { category: normalizeCategoryGid(input.patch.categoryGid) }
      : {}),
  }
  const image = input.patch.image
    ? normalizeImage(input.patch.image)
    : null
  const data = await shopifyAdminGraphql<{
    productUpdate?: unknown
  }>(
    credential,
    {
      query: SHOPIFY_PRODUCT_UPDATE_MUTATION,
      operationName: 'ClawPilotShopifyProductUpdate',
      variables: {
        product,
        media: image
          ? [{
              mediaContentType: 'IMAGE',
              originalSource: image.originalSource,
              ...(image.alt !== undefined ? { alt: image.alt } : {}),
            }]
          : [],
      },
    },
    options,
  )
  const payload = safeRecord(data.productUpdate)
  if (!payload) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      'Shopify returned an invalid product-update response',
      502,
    )
  }
  const userErrors = safeUserErrors(payload.userErrors)
  if (userErrors.length) {
    throw new ShopifyProductWritebackError({
      code: 'SHOPIFY_PRODUCT_UPDATE_REJECTED',
      message: 'Shopify rejected the exact product update',
      status: 409,
      providerRejected: true,
    })
  }
  const providerProduct = safeRecord(payload.product)
  const category = safeRecord(providerProduct?.category)
  const productGid = providerProduct?.id
  const title = providerProduct?.title
  const categoryGid = category?.id ?? null
  if (
    !providerProduct
    || typeof productGid !== 'string'
    || !PRODUCT_GID_PATTERN.test(productGid)
    || typeof title !== 'string'
    || (
      categoryGid !== null
      && (
        typeof categoryGid !== 'string'
        || !TAXONOMY_CATEGORY_GID_PATTERN.test(categoryGid)
      )
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
      'Shopify returned invalid product identity data',
      502,
    )
  }
  if (
    productGid !== input.productGid
    || (
      input.patch.title !== undefined
      && title !== input.patch.title
    )
    || (
      input.patch.categoryGid !== undefined
      && categoryGid !== input.patch.categoryGid
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_UPDATE_RESPONSE_MISMATCH',
      'Shopify returned a different product projection than requested',
      502,
    )
  }
  let mediaResult: ShopifyProductWritebackMediaResult | null = null
  if (image) {
    const mediaConnection = safeRecord(providerProduct.media)
    if (
      !mediaConnection
      || !Array.isArray(mediaConnection.nodes)
      || mediaConnection.nodes.length !== 1
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_UPDATE_RESPONSE_INVALID',
        'Shopify did not return one accepted product image',
        502,
      )
    }
    mediaResult = safeMediaResult(mediaConnection.nodes[0])
  }
  return {
    productGid,
    title,
    categoryGid: categoryGid as string | null,
    mediaRequested: Boolean(image),
    media: mediaResult,
  }
}

const SHOPIFY_PRODUCT_MEDIA_STATUS_QUERY =
  `query ClawPilotShopifyProductMediaStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        mediaContentType
        status
        mediaErrors {
          code
          details
          message
        }
      }
    }
  }`

export async function readShopifyProductMediaStatus(
  credential: ShopifyCommerceRuntimeCredential,
  mediaImageGid: string,
  options: ShopifyCommerceClientOptions = {},
) {
  if (!MEDIA_IMAGE_GID_PATTERN.test(mediaImageGid)) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_GID_INVALID',
      'An exact Shopify MediaImage GID is required',
    )
  }
  const data = await shopifyAdminGraphql<{ node?: unknown }>(
    credential,
    {
      query: SHOPIFY_PRODUCT_MEDIA_STATUS_QUERY,
      operationName: 'ClawPilotShopifyProductMediaStatus',
      variables: { id: mediaImageGid },
    },
    options,
  )
  return safeMediaResult(data.node)
}

const SHOPIFY_PRODUCT_MEDIA_ABSENCE_QUERY =
  `query ClawPilotShopifyProductMediaAbsence($id: ID!) {
    product(id: $id) {
      id
      title
      mediaCount {
        count
      }
      media(first: 1, reverse: true, sortKey: POSITION) {
        nodes {
          id
          mediaContentType
          status
        }
      }
    }
  }`

const SHOPIFY_MEDIA_GID_PATTERN =
  /^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[1-9][0-9]*$/
const SHOPIFY_MEDIA_CONTENT_TYPES = new Set([
  'EXTERNAL_VIDEO',
  'IMAGE',
  'MODEL_3D',
  'VIDEO',
])

function containsControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) || 0
    return codePoint < 32 || codePoint === 127
  })
}

export async function readShopifyProductMediaAbsence(
  credential: ShopifyCommerceRuntimeCredential,
  productGid: string,
  options: ShopifyCommerceClientOptions = {},
): Promise<ShopifyProductMediaAbsenceRead> {
  const exactProductGid = normalizeProductGid(productGid)
  const data = await shopifyAdminGraphql<{ product?: unknown }>(
    credential,
    {
      query: SHOPIFY_PRODUCT_MEDIA_ABSENCE_QUERY,
      operationName: 'ClawPilotShopifyProductMediaAbsence',
      variables: { id: exactProductGid },
    },
    options,
  )
  const product = safeRecord(data.product)
  const mediaCountNode = safeRecord(product?.mediaCount)
  const mediaConnection = safeRecord(product?.media)
  const returnedProductGid = product?.id
  const title = product?.title
  const mediaCount = mediaCountNode?.count
  const nodes = mediaConnection?.nodes
  if (
    typeof returnedProductGid !== 'string'
    || returnedProductGid !== exactProductGid
    || !PRODUCT_GID_PATTERN.test(returnedProductGid)
    || typeof title !== 'string'
    || !title.trim()
    || title.length > 255
    || containsControlCharacter(title)
    || !Number.isSafeInteger(mediaCount)
    || Number(mediaCount) < 0
    || Number(mediaCount) > 1_000_000_000
    || !Array.isArray(nodes)
    || (
      Number(mediaCount) === 0
      && nodes.length !== 0
    )
    || (
      Number(mediaCount) > 0
      && nodes.length !== 1
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_ABSENCE_RESPONSE_INVALID',
      'Shopify returned invalid exact-Product media evidence',
      502,
    )
  }
  let latestMedia: ShopifyProductMediaAbsenceRead['latestMedia'] = null
  if (Number(mediaCount) > 0) {
    const media = safeRecord(nodes[0])
    const mediaGid = media?.id
    const mediaContentType = media?.mediaContentType
    const status = media?.status
    if (
      typeof mediaGid !== 'string'
      || !SHOPIFY_MEDIA_GID_PATTERN.test(mediaGid)
      || typeof mediaContentType !== 'string'
      || !SHOPIFY_MEDIA_CONTENT_TYPES.has(mediaContentType)
      || !['FAILED', 'PROCESSING', 'READY', 'UPLOADED'].includes(
        String(status || ''),
      )
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_MEDIA_ABSENCE_RESPONSE_INVALID',
        'Shopify returned invalid exact-Product media evidence',
        502,
      )
    }
    latestMedia = {
      mediaGid,
      mediaContentType,
      status: status as ShopifyProductWritebackMediaStatus,
    }
  }
  return {
    productGid: returnedProductGid,
    title: title.trim(),
    mediaCount: Number(mediaCount),
    latestMedia,
  }
}

export async function executeShopifyProductMediaAbsenceRead(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    credentialGeneration: unknown
    productGid: unknown
  },
  overrides: Partial<ShopifyProductMediaAbsenceReadDependencies> = {},
) {
  let organizationId: string
  let accountGlobalId: string
  try {
    organizationId = normalizeCommerceOrganizationId(input.organizationId)
    accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_ABSENCE_IDENTITY_INVALID',
      'Shopify Product-media absence identity is invalid',
    )
  }
  const credentialGeneration = positiveRevision(
    input.credentialGeneration,
    'Shopify credential generation',
  )
  const productGid = normalizeProductGid(input.productGid)
  const dependencies = {
    ...DEFAULT_MEDIA_ABSENCE_DEPENDENCIES,
    ...overrides,
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId,
    accountGlobalId,
  })
  if (
    !runtime
    || runtime.organizationId !== organizationId
    || runtime.globalId !== accountGlobalId
    || runtime.provider !== 'shopify'
    || !SHOP_GID_PATTERN.test(runtime.externalAccountId)
    || !['active', 'disabled'].includes(runtime.status)
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== credentialGeneration
    || runtime.authMode !== 'shopify_client_credentials'
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_ABSENCE_RUNTIME_STALE',
      'The verified Shopify connection changed before unknown-outcome reconciliation',
      409,
    )
  }
  const storedCredential = decryptShopifyCredential(runtime, dependencies)
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await dependencies.requestAccessToken(
    {
      shopDomain,
      clientId: storedCredential.clientId,
      clientSecret: storedCredential.clientSecret,
    },
    { timeoutMs: 10_000 },
  )
  const providerCredential = {
    shopDomain,
    accessToken: grant.accessToken,
  }
  const probe = await dependencies.probeConnection(
    providerCredential,
    { timeoutMs: 10_000 },
  )
  if (
    probe.shopId !== runtime.externalAccountId
    || probe.shopDomain !== shopDomain
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_ABSENCE_STORE_IDENTITY_MISMATCH',
      'Shopify returned a different store identity',
      409,
    )
  }
  assertScopeInBoth(grant.grantedScopes, probe)
  const provider = await dependencies.readProductMedia(
    providerCredential,
    productGid,
    { timeoutMs: 10_000 },
  )
  if (provider.productGid !== productGid) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_ABSENCE_PRODUCT_MISMATCH',
      'Shopify returned a different Product during unknown-outcome reconciliation',
      502,
    )
  }
  return {
    ...provider,
    shopGid: probe.shopId,
  }
}

export async function executeShopifyProductMediaStatusRead(
  input: {
    organizationId: unknown
    accountGlobalId: unknown
    credentialGeneration: unknown
    mediaImageGid: unknown
  },
  overrides: Partial<ShopifyProductMediaStatusReadDependencies> = {},
) {
  let organizationId: string
  let accountGlobalId: string
  try {
    organizationId = normalizeCommerceOrganizationId(input.organizationId)
    accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_STATUS_IDENTITY_INVALID',
      'Shopify Product-media status identity is invalid',
    )
  }
  const credentialGeneration = positiveRevision(
    input.credentialGeneration,
    'Shopify credential generation',
  )
  const mediaImageGid = String(input.mediaImageGid || '').trim()
  if (!MEDIA_IMAGE_GID_PATTERN.test(mediaImageGid)) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_GID_INVALID',
      'An exact Shopify MediaImage GID is required',
    )
  }
  const dependencies = {
    ...DEFAULT_MEDIA_STATUS_DEPENDENCIES,
    ...overrides,
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId,
    accountGlobalId,
  })
  if (
    !runtime
    || runtime.organizationId !== organizationId
    || runtime.globalId !== accountGlobalId
    || runtime.provider !== 'shopify'
    || !SHOP_GID_PATTERN.test(runtime.externalAccountId)
    || !['active', 'disabled'].includes(runtime.status)
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== credentialGeneration
    || runtime.authMode !== 'shopify_client_credentials'
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_STATUS_RUNTIME_STALE',
      'The verified Shopify connection changed before media reconciliation',
      409,
    )
  }
  const storedCredential = decryptShopifyCredential(runtime, dependencies)
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await dependencies.requestAccessToken(
    {
      shopDomain,
      clientId: storedCredential.clientId,
      clientSecret: storedCredential.clientSecret,
    },
    { timeoutMs: 10_000 },
  )
  const providerCredential = {
    shopDomain,
    accessToken: grant.accessToken,
  }
  const probe = await dependencies.probeConnection(
    providerCredential,
    { timeoutMs: 10_000 },
  )
  if (
    probe.shopId !== runtime.externalAccountId
    || probe.shopDomain !== shopDomain
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_MEDIA_STATUS_STORE_IDENTITY_MISMATCH',
      'Shopify returned a different store identity',
      409,
    )
  }
  assertScopeInBoth(grant.grantedScopes, probe)
  return dependencies.readMediaStatus(
    providerCredential,
    mediaImageGid,
    { timeoutMs: 10_000 },
  )
}

function assertEffectMatches(
  effect: CommerceExternalEffect,
  input: NormalizedShopifyProductWritebackInput,
) {
  if (
    effect.organizationId !== input.organizationId
    || effect.integrationAccountGlobalId !== input.accountGlobalId
    || effect.provider !== 'shopify'
    || effect.action !== input.action
    || effect.desiredMode !== input.mode
    || effect.credentialGeneration !== input.credentialGeneration
    || effect.activationRevision !== input.activationRevision
    || effect.aggregateType !== SHOPIFY_PRODUCT_WRITEBACK_AGGREGATE_TYPE
    || effect.aggregateId !== input.aggregateId
    || effect.aggregateRevision !== input.aggregateRevision
    || effect.aggregateHash !== input.aggregateHash
    || effect.idempotencyKey !== input.idempotencyKey
    || effect.requestHash !== commerceExternalEffectHash(
      input.redactedRequest,
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_MISMATCH',
      'The durable external effect does not match this product update',
      409,
      false,
      effect.globalId,
    )
  }
}

function assertClaimMatches(
  claim: ClaimedCommerceExternalEffect,
  prepared: CommerceExternalEffect,
  input: NormalizedShopifyProductWritebackInput,
) {
  assertEffectMatches(claim, input)
  if (
    claim.globalId !== prepared.globalId
    || claim.state !== 'claimed'
    || !claim.leaseToken
    || claim.integrationAccountId !== prepared.integrationAccountId
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_CLAIM_MISMATCH',
      'The claimed external effect does not match the prepared product update',
      409,
      false,
      prepared.globalId,
    )
  }
}

function assertRuntimeMatches(
  runtime: CommerceRuntimeCredentialRecord | null,
  claim: ClaimedCommerceExternalEffect,
  input: NormalizedShopifyProductWritebackInput,
): asserts runtime is CommerceRuntimeCredentialRecord {
  if (
    !runtime
    || runtime.organizationId !== input.organizationId
    || runtime.integrationAccountId !== claim.integrationAccountId
    || runtime.globalId !== input.accountGlobalId
    || runtime.provider !== 'shopify'
    || !SHOP_GID_PATTERN.test(runtime.externalAccountId)
    || (
      runtime.status !== 'active'
      && !(
        input.productMediaAuthorizationId
        && runtime.status === 'disabled'
      )
    )
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== input.credentialGeneration
    || runtime.authMode !== 'shopify_client_credentials'
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_RUNTIME_STALE',
      'The Shopify connection changed or is not Active and verified',
      409,
      false,
      claim.globalId,
    )
  }
}

function decryptShopifyCredential(
  runtime: CommerceRuntimeCredentialRecord,
  dependencies: Pick<
    ShopifyProductWritebackDependencies,
    'decryptCredential'
  >,
): ShopifyCommerceCredential {
  let credential
  try {
    credential = dependencies.decryptCredential(
      runtime.encrypted,
      runtime.organizationId,
      runtime.provider,
      runtime.environment,
      runtime.externalAccountId,
    )
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_CREDENTIAL_INVALID',
      'The verified Shopify credential could not be used',
      409,
    )
  }
  if (
    credential.provider !== 'shopify'
    || credential.authMode !== 'shopify_client_credentials'
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_CREDENTIAL_INVALID',
      'The verified Shopify credential could not be used',
      409,
    )
  }
  return credential
}

function assertScopeInBoth(
  tokenScopes: readonly string[],
  probe: ShopifyConnectionProbe,
) {
  if (
    !tokenScopes.includes(SHOPIFY_PRODUCT_WRITEBACK_REQUIRED_SCOPE)
    || !probe.grantedScopes.includes(
      SHOPIFY_PRODUCT_WRITEBACK_REQUIRED_SCOPE,
    )
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_SCOPE_REQUIRED',
      'Shopify must grant write_products in both token and installed-app evidence',
      409,
    )
  }
}

function safeErrorCode(error: unknown, fallback: string) {
  const candidate = error && typeof error === 'object'
    && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : fallback
}

function safeStatus(error: unknown, fallback: number) {
  const candidate = error && typeof error === 'object'
    && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : NaN
  return Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : fallback
}

function providerExplicitlyRejected(error: unknown) {
  return error instanceof ShopifyProductWritebackError
    && error.providerRejected
    && error.code === 'SHOPIFY_PRODUCT_UPDATE_REJECTED'
}

function failureEvidence(input: {
  productGid: string
  stage: string
  outcome: 'failed' | 'unknown'
  errorCode: string
  providerMutationAttempted: boolean
}) {
  return {
    provider: 'shopify',
    operation: 'productUpdate',
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    productGid: input.productGid,
    providerMutationAttempted: input.providerMutationAttempted,
    providerWritesKnown: input.outcome === 'failed',
    // The persistence contract requires a nonnegative write-count value. In
    // unknown state this is only the confirmed lower bound; the state and
    // providerWritesKnown flag prohibit interpreting it as zero-write proof.
    providerWrites: 0,
  }
}

async function finalizeFailure(input: {
  claim: ClaimedCommerceExternalEffect
  normalized: NormalizedShopifyProductWritebackInput
  dependencies: ShopifyProductWritebackDependencies
  error: unknown
  stage: string
  providerMutationAttempted: boolean
}): Promise<never> {
  const outcome = input.providerMutationAttempted
    && !providerExplicitlyRejected(input.error)
    ? 'unknown'
    : 'failed'
  const fallbackCode = outcome === 'unknown'
    ? 'SHOPIFY_PRODUCT_WRITEBACK_OUTCOME_UNKNOWN'
    : 'SHOPIFY_PRODUCT_WRITEBACK_FAILED'
  const errorCode = safeErrorCode(input.error, fallbackCode)
  const redactedResult = failureEvidence({
    productGid: input.normalized.productGid,
    stage: input.stage,
    outcome,
    errorCode,
    providerMutationAttempted: input.providerMutationAttempted,
  })
  assertRedactedCommerceExternalEffectEvidence(
    redactedResult,
    'Shopify product writeback failure evidence',
  )
  try {
    await input.dependencies.finalizeExternalEffect({
      organizationId: input.normalized.organizationId,
      globalId: input.claim.globalId,
      leaseToken: input.claim.leaseToken,
      outcome,
      redactedResult,
      providerReference: null,
      errorCode,
      providerWriteCount: 0,
    })
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_EVIDENCE_FINALIZE_FAILED',
      'Shopify product-update evidence could not be finalized',
      500,
      false,
      input.claim.globalId,
    )
  }
  writebackError(
    errorCode,
    outcome === 'unknown'
      ? 'Shopify product-update outcome is unknown and must be reconciled before any retry'
      : 'Shopify product update did not complete and made zero provider writes',
    outcome === 'unknown' ? 503 : safeStatus(input.error, 409),
    false,
    input.claim.globalId,
  )
}

function successEvidence(
  input: NormalizedShopifyProductWritebackInput,
  result: ShopifyProductWritebackProviderResult,
) {
  return {
    provider: 'shopify',
    operation: 'productUpdate',
    outcome: 'succeeded',
    productGid: result.productGid,
    titleSha256: sha256(result.title),
    categoryGid: result.categoryGid,
    mediaRequested: result.mediaRequested,
    providerMutationAccepted: true,
    media: result.media
      ? {
          id: result.media.mediaImageGid,
          mediaContentType: 'IMAGE',
          status: result.media.status,
          mediaErrors: result.media.errors,
          ready: result.media.ready,
        }
      : null,
    requestSha256: commerceExternalEffectHash(input.redactedRequest),
    providerMutationAttempted: true,
    providerWritesKnown: true,
    providerWrites: 1,
  }
}

/**
 * Persist and execute a bounded Shopify product projection.
 *
 * Shadow is terminal after durable zero-write simulation. Active claims one
 * exact revision-fenced intent before credential decryption or any Shopify
 * request. An ambiguous post-dispatch result is terminal `unknown`; replaying
 * the same idempotency key never dispatches another mutation.
 */
export async function executeShopifyProductWriteback(
  input: ShopifyProductWritebackInput,
  overrides: Partial<ShopifyProductWritebackDependencies> = {},
): Promise<ShopifyProductWritebackResult> {
  const normalized = normalizeInput(input)
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  }
  const simulationEvidence = normalized.mode === 'shadow'
    ? {
        provider: 'shopify',
        operation: 'productUpdate',
        outcome: 'simulated',
        productGid: normalized.productGid,
        requiredScope: SHOPIFY_PRODUCT_WRITEBACK_REQUIRED_SCOPE,
        providerCredentialDecrypted: false,
        providerNetworkCalls: 0,
        providerMutationAccepted: false,
        mediaRequested: Boolean(normalized.patch.image),
        media: null,
        providerWrites: 0,
        requestSha256: commerceExternalEffectHash(
          normalized.redactedRequest,
        ),
      }
    : null

  let prepared: CommerceExternalEffect
  try {
    prepared = await dependencies.prepareExternalEffect({
      organizationId: normalized.organizationId,
      accountGlobalId: normalized.accountGlobalId,
      provider: 'shopify',
      action: normalized.action,
      desiredMode: normalized.mode,
      credentialGeneration: normalized.credentialGeneration,
      activationRevision: normalized.activationRevision,
      aggregateType: SHOPIFY_PRODUCT_WRITEBACK_AGGREGATE_TYPE,
      aggregateId: normalized.aggregateId,
      aggregateRevision: normalized.aggregateRevision,
      aggregateHash: normalized.aggregateHash,
      idempotencyKey: normalized.idempotencyKey,
      redactedRequest: normalized.redactedRequest,
      ...(simulationEvidence ? { simulationEvidence } : {}),
      shopifyProductMediaAuthorizationId:
        normalized.productMediaAuthorizationId,
      actorEmail: normalized.actorEmail,
    })
  } catch (error) {
    if (error instanceof ShopifyProductWritebackError) throw error
    writebackError(
      safeErrorCode(
        error,
        'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_PREPARE_FAILED',
      ),
      'Shopify product writeback could not be prepared',
      safeStatus(error, 409),
    )
  }
  assertEffectMatches(prepared, normalized)

  if (normalized.mode === 'shadow') {
    if (
      prepared.state !== 'simulated'
      || prepared.providerWriteCount !== 0
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_WRITEBACK_SHADOW_EFFECT_INVALID',
        'Shadow product writeback did not produce terminal zero-write evidence',
        500,
        false,
        prepared.globalId,
      )
    }
    return {
      effect: prepared,
      productGid: normalized.productGid,
      replayed: false,
      providerMutationAccepted: false,
      media: null,
    }
  }

  if (prepared.state === 'succeeded') {
    const redactedResult = safeRecord(prepared.redactedResult)
    const storedMedia = redactedResult?.media === null
      ? null
      : redactedResult?.media
        ? safeMediaResult(redactedResult.media)
        : null
    return {
      effect: prepared,
      productGid: normalized.productGid,
      replayed: true,
      providerMutationAccepted:
        redactedResult?.providerMutationAccepted === true,
      media: storedMedia,
    }
  }
  if (prepared.state === 'unknown') {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_OUTCOME_UNKNOWN',
      'This exact Shopify product update has an unknown provider outcome and cannot be retried',
      409,
      false,
      prepared.globalId,
    )
  }
  if (prepared.state === 'failed') {
    writebackError(
      prepared.errorCode || 'SHOPIFY_PRODUCT_WRITEBACK_TERMINAL_FAILED',
      'This exact Shopify product update already failed and cannot be replayed',
      409,
      false,
      prepared.globalId,
    )
  }
  if (
    ACTIVE_TERMINAL_STATES.has(prepared.state)
    || prepared.state !== 'pending'
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_BUSY',
      'Shopify product writeback is already being reconciled',
      409,
      false,
      prepared.globalId,
    )
  }

  let claims: ClaimedCommerceExternalEffect[]
  try {
    claims = await dependencies.claimExternalEffects({
      workerId: normalized.workerId,
      adapterVersion: SHOPIFY_PRODUCT_WRITEBACK_ADAPTER_VERSION,
      provider: 'shopify',
      globalId: prepared.globalId,
      limit: 1,
      leaseSeconds: 60,
    })
  } catch (error) {
    writebackError(
      safeErrorCode(
        error,
        'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_CLAIM_FAILED',
      ),
      'Shopify product writeback could not claim its exact effect',
      safeStatus(error, 409),
      false,
      prepared.globalId,
    )
  }
  if (claims.length !== 1) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_EFFECT_NOT_CLAIMABLE',
      'Shopify product writeback is stale or no longer Active',
      409,
      false,
      prepared.globalId,
    )
  }
  const claim = claims[0]
  assertClaimMatches(claim, prepared, normalized)

  let runtime: CommerceRuntimeCredentialRecord | null
  try {
    runtime = await dependencies.readRuntimeCredential({
      organizationId: normalized.organizationId,
      accountGlobalId: normalized.accountGlobalId,
    })
    assertRuntimeMatches(runtime, claim, normalized)
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'runtime_fence',
      providerMutationAttempted: false,
    })
  }

  let providerCredential: ShopifyCommerceRuntimeCredential
  try {
    const storedCredential = decryptShopifyCredential(runtime, dependencies)
    const shopDomain = normalizeShopifyShopDomain(
      runtime.configuration.shopDomain,
    )
    const grant = await dependencies.requestAccessToken(
      {
        shopDomain,
        clientId: storedCredential.clientId,
        clientSecret: storedCredential.clientSecret,
      },
      { timeoutMs: 10_000 },
    )
    providerCredential = {
      shopDomain,
      accessToken: grant.accessToken,
    }
    const probe = await dependencies.probeConnection(
      providerCredential,
      { timeoutMs: 10_000 },
    )
    if (
      probe.shopId !== runtime.externalAccountId
      || probe.shopDomain !== shopDomain
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_WRITEBACK_STORE_IDENTITY_MISMATCH',
        'Shopify returned a different store identity',
        409,
      )
    }
    assertScopeInBoth(grant.grantedScopes, probe)
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'credential_scope_and_identity',
      providerMutationAttempted: false,
    })
  }

  let providerResult: ShopifyProductWritebackProviderResult
  try {
    providerResult = await dependencies.mutateProduct(
      providerCredential,
      {
        productGid: normalized.productGid,
        patch: normalized.patch,
      },
      { timeoutMs: 10_000 },
    )
    if (
      providerResult.productGid !== normalized.productGid
      || (
        normalized.patch.title !== undefined
        && providerResult.title !== normalized.patch.title
      )
      || (
        normalized.patch.categoryGid !== undefined
        && providerResult.categoryGid !== normalized.patch.categoryGid
      )
      || providerResult.mediaRequested !== Boolean(normalized.patch.image)
      || (
        normalized.patch.image !== undefined
        && providerResult.media === null
      )
      || (
        normalized.patch.image === undefined
        && providerResult.media !== null
      )
    ) {
      writebackError(
        'SHOPIFY_PRODUCT_UPDATE_RESPONSE_MISMATCH',
        'Shopify returned a different product projection than requested',
        502,
      )
    }
  } catch (error) {
    return finalizeFailure({
      claim,
      normalized,
      dependencies,
      error,
      stage: 'provider_mutation',
      providerMutationAttempted: true,
    })
  }

  const redactedResult = successEvidence(normalized, providerResult)
  assertRedactedCommerceExternalEffectEvidence(
    redactedResult,
    'Shopify product writeback success evidence',
  )
  let finalized: CommerceExternalEffect
  try {
    finalized = await dependencies.finalizeExternalEffect({
      organizationId: normalized.organizationId,
      globalId: claim.globalId,
      leaseToken: claim.leaseToken,
      outcome: 'succeeded',
      redactedResult,
      providerReference: providerResult.productGid,
      errorCode: null,
      providerWriteCount: 1,
    })
  } catch {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_EVIDENCE_FINALIZE_FAILED',
      'Shopify product was updated but durable provider evidence did not finalize',
      500,
      false,
      claim.globalId,
    )
  }
  if (
    finalized.state !== 'succeeded'
    || finalized.providerWriteCount !== 1
    || finalized.providerReference !== normalized.productGid
  ) {
    writebackError(
      'SHOPIFY_PRODUCT_WRITEBACK_SUCCESS_EFFECT_INVALID',
      'Shopify product writeback success evidence is inconsistent',
      500,
      false,
      claim.globalId,
    )
  }
  return {
    effect: finalized,
    productGid: normalized.productGid,
    replayed: false,
    providerMutationAccepted: true,
    media: providerResult.media,
  }
}
