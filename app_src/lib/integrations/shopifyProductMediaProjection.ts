import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  executeShopifyProductMediaStatusRead,
  executeShopifyProductWriteback,
  type ShopifyProductWritebackMediaStatus,
  type ShopifyProductWritebackResult,
} from '@/lib/integrations/shopifyProductWriteback'
import {
  ShopifyProductMediaProjectionError,
  type ShopifyProductMediaProjectionGrant,
} from '@/lib/integrations/shopifyProductMediaProjectionTypes'
import {
  resolveShopifyProductMediaSigningSecret,
  signShopifyProductMediaToken,
} from '@/lib/integrations/shopifyProductMediaTokens'
import {
  prepareShopifyProductMediaProjectionInPostgres,
  readShopifyProductMediaReconciliationContextInPostgres,
  recordShopifyProductMediaStatusObservationInPostgres,
  recoverExpiredShopifyProductMediaClaimInPostgres,
  resolveShopifyProductMediaProviderIdentityInPostgres,
} from '@/lib/persistence/shopifyProductMediaProjection'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CHANNEL_GLOBAL_PATTERN = /^gpcs[0-9]{7}$/
const SAFE_IDENTIFIER_PATTERN = /^[\x20-\x7e]+$/
const PUBLIC_MEDIA_PATH =
  '/api/integrations/commerce/shopify/product-media/'
// Leave enough authority lifetime for the bounded credential exchange, live
// scope probe, and productUpdate calls plus ordinary network overhead. A
// command inside this window fails before any provider request.
const ACTIVE_EXECUTION_SAFETY_SECONDS = 120

export type ShopifyProductImagePublishResult = {
  productId: string
  productReferenceCode: string
  channelStateGlobalId: string
  imageAssetId: string
  imageAssetRevision: number
  imageContentSha256: string
  mode: 'shadow' | 'active'
  replayed: boolean
  providerMutation: {
    accepted: boolean
    writeCount: number
  }
  mediaPublication: {
    requested: true
    mediaImageGid: string | null
    status: ShopifyProductWritebackMediaStatus | null
    errors: {
      code: string
      message: string
      details: string | null
    }[]
    ready: boolean
    positioningRequested: false
    primaryPositionConfirmed: false
    nextAction:
      | 'shadow_simulation'
      | 'await_media_ready'
      | 'investigate_media_failure'
      | 'reorder_to_position_zero'
  }
  externalEffect: {
    globalId: string
    state: string
    providerWriteCount: number
    completedAt: string | null
  }
}

export type ShopifyProductMediaProjectionDependencies = {
  prepareProjection:
    typeof prepareShopifyProductMediaProjectionInPostgres
  resolveProviderIdentity:
    typeof resolveShopifyProductMediaProviderIdentityInPostgres
  executeWriteback: typeof executeShopifyProductWriteback
  signingSecret: () => Uint8Array
  nowEpoch: () => number
}

export type ShopifyProductMediaReconciliationDependencies = {
  readContext:
    typeof readShopifyProductMediaReconciliationContextInPostgres
  recoverExpiredClaim:
    typeof recoverExpiredShopifyProductMediaClaimInPostgres
  readProviderStatus: typeof executeShopifyProductMediaStatusRead
  recordObservation:
    typeof recordShopifyProductMediaStatusObservationInPostgres
}

const DEFAULT_RECONCILIATION_DEPENDENCIES:
ShopifyProductMediaReconciliationDependencies = {
  readContext: readShopifyProductMediaReconciliationContextInPostgres,
  recoverExpiredClaim:
    recoverExpiredShopifyProductMediaClaimInPostgres,
  readProviderStatus: executeShopifyProductMediaStatusRead,
  recordObservation:
    recordShopifyProductMediaStatusObservationInPostgres,
}

const DEFAULT_DEPENDENCIES: ShopifyProductMediaProjectionDependencies = {
  prepareProjection: prepareShopifyProductMediaProjectionInPostgres,
  resolveProviderIdentity:
    resolveShopifyProductMediaProviderIdentityInPostgres,
  executeWriteback: executeShopifyProductWriteback,
  signingSecret: resolveShopifyProductMediaSigningSecret,
  nowEpoch: () => Math.floor(Date.now() / 1_000),
}

function fail(code: string, message: string, status = 400): never {
  throw new ShopifyProductMediaProjectionError(code, message, status)
}

function uuid(value: unknown, label: string) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SELECTION_INVALID',
      `${label} is invalid`,
      404,
    )
  }
  return normalized
}

function channelStateGlobalId(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!CHANNEL_GLOBAL_PATTERN.test(normalized)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SELECTION_INVALID',
      'Shopify channel selection is invalid',
      404,
    )
  }
  return normalized
}

function publishIdempotencyKey(input: {
  integrationAccountGlobalId: string
  productGid: string
  imageAssetId: string
  executeProviderWrite: boolean
}) {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      account: input.integrationAccountGlobalId,
      product: input.productGid,
      asset: input.imageAssetId,
      mode: input.executeProviderWrite ? 'active' : 'shadow',
    }), 'utf8')
    .digest('hex')
  const key = `shopify-product-image:${digest}`
  if (key.length > 255 || !SAFE_IDENTIFIER_PATTERN.test(key)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_IDEMPOTENCY_INVALID',
      'The server-derived product image command identity is invalid',
      500,
    )
  }
  return key
}

function normalizePublicOrigin(value: unknown) {
  const raw = String(value || '').trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_PUBLIC_ORIGIN_INVALID',
      'A public HTTPS application origin is required',
      503,
    )
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.origin.length > 2_048
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_PUBLIC_ORIGIN_INVALID',
      'A public HTTPS application origin is required',
      503,
    )
  }
  return url
}

function assertPublicForActive(url: URL) {
  const hostname = url.hostname.toLowerCase()
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || !hostname.includes('.')
    || isIP(hostname) !== 0
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_PUBLIC_ORIGIN_REQUIRED',
      'Active Shopify product media projection requires a public HTTPS application origin',
      503,
    )
  }
}

function deliveryUrl(
  grant: ShopifyProductMediaProjectionGrant,
  secret: Uint8Array,
) {
  const token = signShopifyProductMediaToken({
    v: 1,
    g: grant.id,
    o: grant.organizationId,
    p: grant.productId,
    a: grant.imageAssetId,
    h: grant.assetContentSha256,
    m: grant.mode,
    iat: grant.issuedAtEpoch,
    exp: grant.expiresAtEpoch,
  }, secret)
  return `${grant.publicOrigin}${PUBLIC_MEDIA_PATH}${token}`
}

function publicResult(
  grant: ShopifyProductMediaProjectionGrant,
  result: ShopifyProductWritebackResult,
): ShopifyProductImagePublishResult {
  const media = result.media
  const nextAction = grant.mode === 'shadow'
    ? 'shadow_simulation'
    : media?.status === 'FAILED'
      ? 'investigate_media_failure'
      : media?.ready
        ? 'reorder_to_position_zero'
        : 'await_media_ready'
  return {
    productId: grant.productId,
    productReferenceCode: grant.productReferenceCode,
    channelStateGlobalId: grant.channelStateGlobalId,
    imageAssetId: grant.imageAssetId,
    imageAssetRevision: grant.assetRevision,
    imageContentSha256: grant.assetContentSha256,
    mode: grant.mode,
    replayed: result.replayed,
    providerMutation: {
      accepted: result.providerMutationAccepted,
      writeCount: result.effect.providerWriteCount,
    },
    mediaPublication: {
      requested: true,
      mediaImageGid: media?.mediaImageGid || null,
      status: media?.status || null,
      errors: media?.errors || [],
      ready: media?.ready || false,
      positioningRequested: false,
      primaryPositionConfirmed: false,
      nextAction,
    },
    externalEffect: {
      globalId: result.effect.globalId,
      state: result.effect.state,
      providerWriteCount: result.effect.providerWriteCount,
      completedAt: result.effect.completedAt,
    },
  }
}

/**
 * Resolve all provider identities, revisions, credential fences, hashes, and
 * media facts server-side. The browser supplies only exact local selections,
 * while the server derives the replay-stable idempotency key and requires the
 * explicit Active-write confirmation flag.
 */
export async function executeShopifyProductImagePublish(
  rawInput: {
    organizationId: unknown
    productId: unknown
    channelStateGlobalId: unknown
    imageAssetId: unknown
    executeProviderWrite: unknown
    publicOrigin: unknown
    actorEmail: string
  },
  overrides: Partial<ShopifyProductMediaProjectionDependencies> = {},
): Promise<ShopifyProductImagePublishResult> {
  if (typeof rawInput.executeProviderWrite !== 'boolean') {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_WRITE_CONFIRMATION_REQUIRED',
      'An explicit provider-write confirmation flag is required',
    )
  }
  const localSelection = {
    organizationId: uuid(rawInput.organizationId, 'Organization'),
    productId: uuid(rawInput.productId, 'Product'),
    channelStateGlobalId: channelStateGlobalId(
      rawInput.channelStateGlobalId,
    ),
    imageAssetId: uuid(rawInput.imageAssetId, 'Product image'),
    executeProviderWrite: rawInput.executeProviderWrite,
    publicOrigin: normalizePublicOrigin(rawInput.publicOrigin),
    actorEmail: rawInput.actorEmail,
  }
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  }
  const providerIdentity = await dependencies.resolveProviderIdentity({
    organizationId: localSelection.organizationId,
    productId: localSelection.productId,
    channelStateGlobalId: localSelection.channelStateGlobalId,
    imageAssetId: localSelection.imageAssetId,
  })
  const input = {
    ...localSelection,
    ...providerIdentity,
    idempotencyKey: publishIdempotencyKey({
      ...providerIdentity,
      imageAssetId: localSelection.imageAssetId,
      executeProviderWrite: localSelection.executeProviderWrite,
    }),
  }
  // Fail before inserting a public grant if the required HMAC secret is absent.
  const secret = dependencies.signingSecret()
  const grant = await dependencies.prepareProjection({
    organizationId: input.organizationId,
    productId: input.productId,
    channelStateGlobalId: input.channelStateGlobalId,
    imageAssetId: input.imageAssetId,
    idempotencyKey: input.idempotencyKey,
    expectedIntegrationAccountGlobalId:
      input.integrationAccountGlobalId,
    expectedProductGid: input.productGid,
    expectedMode: input.executeProviderWrite ? 'active' : 'shadow',
    publicOrigin: input.publicOrigin.origin,
    actorEmail: input.actorEmail,
  })
  if (
    grant.organizationId !== input.organizationId
    || grant.productId !== input.productId
    || grant.channelStateGlobalId !== input.channelStateGlobalId
    || grant.imageAssetId !== input.imageAssetId
    || grant.idempotencyKey !== input.idempotencyKey
    || grant.integrationAccountGlobalId
      !== input.integrationAccountGlobalId
    || grant.productGid !== input.productGid
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_SELECTION_MISMATCH',
      'Stored Shopify product media selection does not match this command',
      409,
    )
  }
  if (
    (grant.mode === 'active' && !input.executeProviderWrite)
    || (grant.mode === 'shadow' && input.executeProviderWrite)
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_MODE_CONFIRMATION_MISMATCH',
      grant.mode === 'active'
        ? 'Confirm the exact Active provider write before projecting product media'
        : 'Shadow mode cannot accept an Active provider-write confirmation',
      409,
    )
  }
  if (grant.mode === 'active') assertPublicForActive(
    normalizePublicOrigin(grant.publicOrigin),
  )
  const nowEpoch = dependencies.nowEpoch()
  if (
    !Number.isSafeInteger(nowEpoch)
    || nowEpoch < grant.issuedAtEpoch
    || nowEpoch >= grant.expiresAtEpoch
    || (
      grant.mode === 'active'
      && nowEpoch
        >= grant.expiresAtEpoch - ACTIVE_EXECUTION_SAFETY_SECONDS
    )
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_GRANT_EXPIRED',
      'The short-lived Shopify product media grant expired before execution',
      409,
    )
  }
  const result = await dependencies.executeWriteback({
    organizationId: grant.organizationId,
    accountGlobalId: grant.integrationAccountGlobalId,
    mode: grant.mode,
    credentialGeneration: grant.credentialGeneration,
    activationRevision: grant.activationRevision,
    aggregateId: grant.productReferenceCode,
    aggregateRevision: grant.aggregateRevision,
    aggregateHash: grant.aggregateHash,
    idempotencyKey: grant.idempotencyKey,
    productGid: grant.productGid,
    patch: {
      image: {
        originalSource: deliveryUrl(grant, secret),
        alt: grant.assetAltText,
      },
    },
    productMediaAuthorizationId:
      grant.productWriteAuthorizationId,
    actorEmail: input.actorEmail,
    workerId: 'shopify-product-image-publish',
  })
  if (
    result.effect.desiredMode !== grant.mode
    || result.effect.aggregateId !== grant.productReferenceCode
    || result.effect.aggregateRevision !== grant.aggregateRevision
    || result.effect.aggregateHash !== grant.aggregateHash
    || result.effect.idempotencyKey !== grant.idempotencyKey
    || (
      grant.mode === 'shadow'
      && (
        result.effect.state !== 'simulated'
        || result.effect.providerWriteCount !== 0
        || result.providerMutationAccepted
        || result.media !== null
      )
    )
    || (
      grant.mode === 'active'
      && (
        !result.providerMutationAccepted
        || result.effect.state !== 'succeeded'
        || result.effect.providerWriteCount !== 1
        || !result.media
      )
    )
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_EFFECT_MISMATCH',
      'Shopify product media evidence does not match the exact command',
      500,
    )
  }
  return publicResult(grant, result)
}

export async function reconcileShopifyProductImagePublish(
  rawInput: {
    organizationId: unknown
    productId: unknown
    externalEffectGlobalId: unknown
    actorEmail: string
  },
  overrides: Partial<ShopifyProductMediaReconciliationDependencies> = {},
) {
  const input = {
    organizationId: uuid(rawInput.organizationId, 'Organization'),
    productId: uuid(rawInput.productId, 'Product'),
    externalEffectGlobalId: String(
      rawInput.externalEffectGlobalId || '',
    ).trim().toLowerCase(),
    actorEmail: rawInput.actorEmail,
  }
  if (!/^gcef[0-9]{7}$/.test(input.externalEffectGlobalId)) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_EFFECT_INVALID',
      'Shopify Product-image publication evidence is invalid',
      404,
    )
  }
  const dependencies = {
    ...DEFAULT_RECONCILIATION_DEPENDENCIES,
    ...overrides,
  }
  let context = await dependencies.readContext(input)
  if (context.effectState === 'claimed') {
    if (!context.leaseExpired) {
      return {
        externalEffectGlobalId: context.externalEffectGlobalId,
        effectState: context.effectState,
        mediaImageGid: context.mediaImageGid,
        status: context.mediaStatus,
        errors: context.mediaErrors,
        ready: false,
        terminal: false,
        providerNetworkCalls: 0,
        providerWriteCount: 0,
        nextAction: 'await_provider_attempt' as const,
      }
    }
    context = await dependencies.recoverExpiredClaim({
      ...input,
      externalEffectGlobalId: context.externalEffectGlobalId,
    })
  }
  if (
    context.effectState === 'pending'
    || context.effectState === 'failed'
    || context.effectState === 'unknown'
  ) {
    return {
      externalEffectGlobalId: context.externalEffectGlobalId,
      effectState: context.effectState,
      mediaImageGid: context.mediaImageGid,
      status: context.mediaStatus,
      errors: context.mediaErrors,
      ready: false,
      terminal:
        context.effectState === 'failed'
        || context.effectState === 'unknown',
      providerNetworkCalls: 0,
      providerWriteCount: 0,
      nextAction: context.effectState === 'pending'
        ? 'await_provider_attempt' as const
        : context.effectState === 'unknown'
          ? 'investigate_unknown_provider_outcome' as const
          : 'investigate_provider_failure' as const,
    }
  }
  if (
    context.effectState !== 'succeeded'
    || !context.mediaImageGid
    || !context.mediaStatus
  ) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_RECONCILIATION_EVIDENCE_INVALID',
      'Successful Shopify Product-image evidence is incomplete',
      500,
    )
  }
  if (
    context.mediaStatus === 'READY'
    || context.mediaStatus === 'FAILED'
  ) {
    return {
      externalEffectGlobalId: context.externalEffectGlobalId,
      effectState: context.effectState,
      mediaImageGid: context.mediaImageGid,
      status: context.mediaStatus,
      errors: context.mediaErrors,
      ready: context.mediaStatus === 'READY',
      terminal: true,
      providerNetworkCalls: 0,
      providerWriteCount: 0,
      nextAction: context.mediaStatus === 'READY'
        ? 'reorder_to_position_zero' as const
        : 'investigate_media_failure' as const,
    }
  }
  const provider = await dependencies.readProviderStatus({
    organizationId: input.organizationId,
    accountGlobalId: context.integrationAccountGlobalId,
    credentialGeneration: context.credentialGeneration,
    mediaImageGid: context.mediaImageGid,
  })
  if (provider.mediaImageGid !== context.mediaImageGid) {
    fail(
      'SHOPIFY_PRODUCT_MEDIA_STATUS_IDENTITY_MISMATCH',
      'Shopify returned a different MediaImage identity',
      502,
    )
  }
  const observation = await dependencies.recordObservation({
    organizationId: input.organizationId,
    deliveryGrantId: context.deliveryGrantId,
    externalEffectId: context.externalEffectId,
    mediaImageGid: provider.mediaImageGid,
    status: provider.status,
    errors: provider.errors,
    actorEmail: input.actorEmail,
  })
  return {
    externalEffectGlobalId: context.externalEffectGlobalId,
    effectState: context.effectState,
    mediaImageGid: provider.mediaImageGid,
    status: provider.status,
    errors: observation.errors,
    ready: provider.status === 'READY',
    terminal:
      provider.status === 'READY' || provider.status === 'FAILED',
    providerNetworkCalls: 3,
    providerWriteCount: 0,
    observedAt: observation.observedAt,
    nextAction: provider.status === 'READY'
      ? 'reorder_to_position_zero' as const
      : provider.status === 'FAILED'
        ? 'investigate_media_failure' as const
        : 'await_media_ready' as const,
  }
}

export function shopifyProductMediaPublicOrigin(
  requestOrigin: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured = String(
    environment.SHOPIFY_PRODUCT_MEDIA_PUBLIC_ORIGIN
      || requestOrigin,
  ).trim()
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured)
    ? configured
    : `https://${configured}`
  return normalizePublicOrigin(withProtocol).origin
}
