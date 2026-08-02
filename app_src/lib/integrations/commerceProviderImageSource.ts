import {
  decryptCommerceCredential,
  normalizeCommerceAccountGlobalId,
  normalizeCommerceOrganizationId,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  getFaireProduct,
  probeFaireBrandProfile,
} from '@/lib/integrations/faireCommerceClient'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  commerceProductImageLocatorFingerprint,
} from '@/lib/operations/commerceNormalization'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'

const SHOPIFY_MEDIA_PAGE_SIZE = 50
const MAX_PROVIDER_IMAGES = 50
const SHOPIFY_TIMEOUT_MS = 8_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const HASH_PATTERN = /^[0-9a-f]{64}$/
const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/
const SHOPIFY_MEDIA_IMAGE_GID = /^gid:\/\/shopify\/MediaImage\/[1-9][0-9]*$/

export type CommerceProviderImageSourceProvider = 'shopify' | 'faire'

export type CommerceProviderImageSource = Readonly<{
  providerImageId: string | null
  locatorSha256: string
  sequence: number
  url: string
}>

export class CommerceProviderImageSourceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'CommerceProviderImageSourceError'
    this.code = code
    this.status = status
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new CommerceProviderImageSourceError(code, message, status)
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string') {
    fail('COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID', `${label} is required`)
  }
  const trimmed = value.trim()
  if (
    !trimmed
    || trimmed !== value
    || trimmed.length > maximum
    || CONTROL_CHARACTER.test(trimmed)
  ) {
    fail('COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID', `${label} is invalid`)
  }
  return trimmed
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedProviderImageId(
  value: unknown,
  provider: CommerceProviderImageSourceProvider,
) {
  if (value === null || value === undefined || value === '') return null
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > 512
    || CONTROL_CHARACTER.test(value)
    || /^https?:\/\//iu.test(value)
    || (provider === 'shopify' && !SHOPIFY_MEDIA_IMAGE_GID.test(value))
  ) return null
  return value
}

function sourceFromCandidate(input: {
  provider: CommerceProviderImageSourceProvider
  providerImageId: unknown
  url: unknown
  sequence: number
}): CommerceProviderImageSource | null {
  const providerImageId = normalizedProviderImageId(
    input.providerImageId,
    input.provider,
  )
  if (
    input.providerImageId !== null
    && input.providerImageId !== undefined
    && input.providerImageId !== ''
    && !providerImageId
  ) return null
  if (typeof input.url !== 'string') return null
  const locatorSha256 = commerceProductImageLocatorFingerprint(input.url)
  if (!locatorSha256 || !HASH_PATTERN.test(locatorSha256)) return null
  return Object.freeze({
    providerImageId,
    locatorSha256,
    sequence: input.sequence,
    // This URL is transient process memory only. Callers must never persist,
    // audit, log, or return it through an API response.
    url: input.url,
  })
}

function dedupeSources(sources: readonly CommerceProviderImageSource[]) {
  const seen = new Map<string, CommerceProviderImageSource>()
  const result: CommerceProviderImageSource[] = []
  for (const source of sources) {
    const key = source.providerImageId
      ? `provider:${source.providerImageId}`
      : `locator:${source.locatorSha256}`
    const prior = seen.get(key)
    if (prior) {
      if (prior.locatorSha256 !== source.locatorSha256) {
        fail(
          'COMMERCE_PROVIDER_IMAGE_SOURCE_AMBIGUOUS',
          'Provider product image source is ambiguous',
          409,
        )
      }
      continue
    }
    seen.set(key, source)
    result.push(Object.freeze({ ...source, sequence: result.length }))
  }
  return Object.freeze(result)
}

function shopifyMediaQuery() {
  return `query ClawPilotCommerceProviderImageSources(
    $productId: ID!
    $after: String
  ) {
    product(id: $productId) {
      id
      media(first: ${SHOPIFY_MEDIA_PAGE_SIZE}, after: $after) {
        nodes {
          ... on MediaImage {
            id
            image { url }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`
}

async function readShopifySources(input: {
  runtime: NonNullable<Awaited<ReturnType<
    typeof readCommerceRuntimeCredentialFromPostgres
  >>>
  externalProductId: string
}) {
  if (!SHOPIFY_PRODUCT_GID.test(input.externalProductId)) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
      'Shopify product identity is invalid',
    )
  }
  const credential = decryptCommerceCredential(
    input.runtime.encrypted,
    input.runtime.organizationId,
    input.runtime.provider,
    input.runtime.environment,
    input.runtime.externalAccountId,
  )
  if (credential.provider !== 'shopify') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_CREDENTIAL_INVALID',
      'Stored commerce credential could not be used',
      409,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    input.runtime.configuration.shopDomain,
  )
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: credential.clientId,
    clientSecret: credential.clientSecret,
  })
  const probe = await probeShopifyConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (probe.shopId !== input.runtime.externalAccountId) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_ACCOUNT_CHANGED',
      'Shopify returned a different store identity',
      409,
    )
  }
  if (
    !hasEffectiveShopifyScope(grant.grantedScopes, 'read_products')
    || !hasEffectiveShopifyScope(probe.grantedScopes, 'read_products')
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_SCOPE_REQUIRED',
      'Shopify must grant product-read access for image import',
      409,
    )
  }
  const sources: CommerceProviderImageSource[] = []
  const after: string | null = null
  for (let page = 0; page < 1; page += 1) {
    const data = await shopifyAdminGraphql<Record<string, unknown>>(
      { shopDomain, accessToken: grant.accessToken },
      {
        query: shopifyMediaQuery(),
        operationName: 'ClawPilotCommerceProviderImageSources',
        variables: { productId: input.externalProductId, after },
      },
      { timeoutMs: SHOPIFY_TIMEOUT_MS },
    )
    const product = record(data.product)
    if (!product) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_SOURCE_NOT_FOUND',
        'Provider product image source is no longer available',
        404,
      )
    }
    if (product.id !== input.externalProductId) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_SOURCE_IDENTITY_CHANGED',
        'Provider product identity changed during image import',
        409,
      )
    }
    const media = record(product.media)
    const pageInfo = record(media?.pageInfo)
    if (
      !media
      || !Array.isArray(media.nodes)
      || !pageInfo
      || typeof pageInfo.hasNextPage !== 'boolean'
    ) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
        'Provider product images could not be read',
        502,
      )
    }
    const nodes = media.nodes
    if (
      nodes.length > MAX_PROVIDER_IMAGES
      || pageInfo.hasNextPage === true
    ) {
      fail(
        'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE',
        `Provider product has more than ${MAX_PROVIDER_IMAGES} supported images`,
        409,
      )
    }
    for (const node of nodes) {
      const mediaImage = record(node)
      const image = record(mediaImage?.image)
      const source = sourceFromCandidate({
        provider: 'shopify',
        providerImageId: mediaImage?.id,
        url: image?.url,
        sequence: sources.length,
      })
      if (source) sources.push(source)
    }
    return dedupeSources(sources)
  }
  fail(
    'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE',
    `Provider product has more than ${MAX_PROVIDER_IMAGES} supported images`,
    409,
  )
}

async function readFaireSources(input: {
  runtime: NonNullable<Awaited<ReturnType<
    typeof readCommerceRuntimeCredentialFromPostgres
  >>>
  externalProductId: string
}) {
  const externalProductId = requiredText(
    input.externalProductId,
    'Faire product identity',
    512,
  )
  if (/^https?:\/\//iu.test(externalProductId)) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
      'Faire product identity is invalid',
    )
  }
  const credential = decryptCommerceCredential(
    input.runtime.encrypted,
    input.runtime.organizationId,
    input.runtime.provider,
    input.runtime.environment,
    input.runtime.externalAccountId,
  )
  if (credential.provider !== 'faire') {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_CREDENTIAL_INVALID',
      'Stored commerce credential could not be used',
      409,
    )
  }
  if (
    credential.authMode === 'faire_oauth'
    && !credential.scopes.includes('READ_PRODUCTS')
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_SCOPE_REQUIRED',
      'Faire must grant product-read access for image import',
      409,
    )
  }
  const options = credential.authMode === 'faire_oauth'
    ? {
        accessToken: credential.accessToken,
        applicationId: credential.applicationId,
        applicationSecret: credential.applicationSecret,
        timeoutMs: 15_000,
      }
    : { accessToken: credential.accessToken, timeoutMs: 15_000 }
  const profile = record(await probeFaireBrandProfile(options))
  const profileIdentifiers = profile
    ? [profile.id, profile.brand_id, profile.brandId].filter(
        (value) => value !== undefined && value !== null,
      )
    : []
  if (
    profileIdentifiers.length < 1
    || profileIdentifiers.some((value) => (
      typeof value !== 'string'
      || value !== value.trim()
      || value.length < 1
      || value.length > 512
      || CONTROL_CHARACTER.test(value)
      || value !== input.runtime.externalAccountId
    ))
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_ACCOUNT_CHANGED',
      'Faire returned a different brand identity',
      409,
    )
  }
  const product = record(await getFaireProduct(options, externalProductId))
  if (!product) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_NOT_FOUND',
      'Provider product image source is no longer available',
      404,
    )
  }
  const returnedId = product.id ?? product.product_id
  if (returnedId !== externalProductId) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_IDENTITY_CHANGED',
      'Provider product identity changed during image import',
      409,
    )
  }
  const productBrandIdentifiers = [product.brand_id, product.brandId].filter(
    (value) => value !== undefined && value !== null,
  )
  if (productBrandIdentifiers.some((value) => (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > 512
    || CONTROL_CHARACTER.test(value)
    || value !== input.runtime.externalAccountId
  ))) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_ACCOUNT_CHANGED',
      'Faire returned a product for a different brand',
      409,
    )
  }
  if (!Array.isArray(product.images)) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
      'Provider product images could not be read',
      502,
    )
  }
  if (product.images.length > MAX_PROVIDER_IMAGES) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_SET_TOO_LARGE',
      `Provider product has more than ${MAX_PROVIDER_IMAGES} supported images`,
      409,
    )
  }
  const sources = product.images.flatMap((value, sequence) => {
    if (typeof value === 'string') {
      const source = sourceFromCandidate({
        provider: 'faire',
        providerImageId: null,
        url: value,
        sequence,
      })
      return source ? [source] : []
    }
    const image = record(value)
    if (!image) return []
    const source = sourceFromCandidate({
      provider: 'faire',
      providerImageId: image.id ?? image.image_id ?? image.imageId,
      url: image.url ?? image.image_url ?? image.imageUrl,
      sequence,
    })
    return source ? [source] : []
  })
  return dedupeSources(sources)
}

/**
 * Re-reads the exact current provider product and returns only transient image
 * locators. Raw URLs must be consumed in-process and must never enter durable
 * state, audit payloads, logs, API responses, or thrown messages.
 */
export async function readCurrentCommerceProviderImageSources(input: {
  organizationId: string
  accountGlobalId: string
  provider: CommerceProviderImageSourceProvider
  credentialGeneration: number
  externalProductId: string
}): Promise<readonly CommerceProviderImageSource[]> {
  const organizationId = normalizeCommerceOrganizationId(input.organizationId)
  const accountGlobalId = normalizeCommerceAccountGlobalId(input.accountGlobalId)
  if (
    !Number.isSafeInteger(input.credentialGeneration)
    || input.credentialGeneration < 1
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
      'Credential generation is invalid',
    )
  }
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId,
    accountGlobalId,
  })
  if (
    !runtime
    || runtime.verificationStatus !== 'verified'
    || runtime.status !== 'active'
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_CONNECTION_REQUIRED',
      'Repair and verify the commerce connection before importing images',
      409,
    )
  }
  if (
    runtime.provider !== input.provider
    || runtime.credentialVersion !== input.credentialGeneration
  ) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_FENCE_CHANGED',
      'Commerce image source authority changed before the provider read',
      409,
    )
  }
  try {
    return input.provider === 'shopify'
      ? await readShopifySources({ runtime, externalProductId: input.externalProductId })
      : await readFaireSources({ runtime, externalProductId: input.externalProductId })
  } catch (error) {
    if (error instanceof CommerceProviderImageSourceError) throw error
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_READ_FAILED',
      'Provider product images could not be read',
      502,
    )
  }
}

export function selectCommerceProviderImageSource(input: {
  sources: readonly CommerceProviderImageSource[]
  providerImageId: string | null
  locatorSha256: string
}) {
  if (!HASH_PATTERN.test(input.locatorSha256)) {
    fail(
      'COMMERCE_PROVIDER_IMAGE_SOURCE_INPUT_INVALID',
      'Image locator fingerprint is invalid',
    )
  }
  const exact = input.sources.filter((source) => (
    input.providerImageId
      ? source.providerImageId === input.providerImageId
        && source.locatorSha256 === input.locatorSha256
      : source.providerImageId === null
        && source.locatorSha256 === input.locatorSha256
  ))
  if (exact.length !== 1) {
    fail(
      exact.length === 0
        ? 'COMMERCE_PROVIDER_IMAGE_SOURCE_STALE'
        : 'COMMERCE_PROVIDER_IMAGE_SOURCE_AMBIGUOUS',
      exact.length === 0
        ? 'Provider product image source changed before import'
        : 'Provider product image source is ambiguous',
      409,
    )
  }
  return exact[0]!
}
