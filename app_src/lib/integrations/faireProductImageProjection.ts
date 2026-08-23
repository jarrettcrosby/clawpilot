import { createHash, randomUUID } from 'node:crypto'
import {
  decryptCommerceCredential,
  type FaireCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  readCurrentCommerceProviderImageSources,
} from '@/lib/integrations/commerceProviderImageSource'
import {
  createFaireCommerceClient,
  type FaireCommerceClient,
  type FaireCommerceClientOptions,
  type FaireProductImageInput,
} from '@/lib/integrations/faireCommerceClient'
import {
  commerceProductImageLocatorFingerprint,
} from '@/lib/operations/commerceNormalization'
import {
  finalizeCommerceExternalEffectInPostgres,
} from '@/lib/persistence/commerceExternalEffects'
import {
  claimFaireProviderWriteInPostgres,
  type ClaimedFaireProviderWrite,
} from '@/lib/persistence/faireProviderWriteAuthorization'
import {
  prepareFaireProductImageProjectionInPostgres,
  readFaireProductImageAssetForClaimInPostgres,
  readFaireProductImageReconciliationContextInPostgres,
  recoverExpiredFaireProductImageClaimInPostgres,
  recordFaireProductImageProviderStepInPostgres,
  resolveFaireProductImageAppliedReconciliationInPostgres,
  resolveFaireProductImageSelectionInPostgres,
  type FaireProductImageProjectionGrant,
} from '@/lib/persistence/faireProductImageProjection'
import {
  readCommerceRuntimeCredentialFromPostgres,
  type CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'

export const FAIRE_PRODUCT_IMAGE_ACTION =
  'faire.product.image.publish' as const
export const FAIRE_PRODUCT_IMAGE_ADAPTER_VERSION =
  'faire-v2-product-image-publish-v1' as const
const REQUIRED_CAPABILITIES = Object.freeze([
  'product_draft_update',
  'product_image_upload',
] as const)
const REQUIRED_SCOPE = 'WRITE_PRODUCTS' as const
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const CHANNEL_GLOBAL_ID = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_REFERENCE = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const EFFECT_GLOBAL_ID = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const MAX_PROVIDER_IMAGES = 20
const CLAIM_LEASE_SECONDS = 180

export type FaireProductImagePublishResult = {
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
    uploadAccepted: boolean
    attachmentAccepted: boolean
  }
  images: {
    existingPreserved: boolean
    priorCount: number | null
    projectedCount: number | null
    uploadedLocatorSha256: string | null
  }
  externalEffect: {
    globalId: string
    state: string
    providerWriteCount: number
  }
}

export type FaireProductImageProjectionDependencies = {
  resolveSelection: typeof resolveFaireProductImageSelectionInPostgres
  prepareProjection: typeof prepareFaireProductImageProjectionInPostgres
  recoverExpiredClaim: typeof recoverExpiredFaireProductImageClaimInPostgres
  claimProviderWrite: typeof claimFaireProviderWriteInPostgres
  readAsset: typeof readFaireProductImageAssetForClaimInPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  readProviderImages: typeof readCurrentCommerceProviderImageSources
  createClient: (
    options: FaireCommerceClientOptions,
  ) => Pick<
    FaireCommerceClient,
    'uploadProductImage' | 'updateProductImages'
  >
  recordProviderStep: typeof recordFaireProductImageProviderStepInPostgres
  finalizeEffect: typeof finalizeCommerceExternalEffectInPostgres
}

export type FaireProductImageReconciliationDependencies = {
  readContext: typeof readFaireProductImageReconciliationContextInPostgres
  recoverExpiredClaim: typeof recoverExpiredFaireProductImageClaimInPostgres
  readProviderImages: typeof readCurrentCommerceProviderImageSources
  recordProviderStep: typeof recordFaireProductImageProviderStepInPostgres
  resolveApplied:
    typeof resolveFaireProductImageAppliedReconciliationInPostgres
}

const DEFAULT_DEPENDENCIES: FaireProductImageProjectionDependencies = {
  resolveSelection: resolveFaireProductImageSelectionInPostgres,
  prepareProjection: prepareFaireProductImageProjectionInPostgres,
  recoverExpiredClaim: recoverExpiredFaireProductImageClaimInPostgres,
  claimProviderWrite: claimFaireProviderWriteInPostgres,
  readAsset: readFaireProductImageAssetForClaimInPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  readProviderImages: readCurrentCommerceProviderImageSources,
  createClient: createFaireCommerceClient,
  recordProviderStep: recordFaireProductImageProviderStepInPostgres,
  finalizeEffect: finalizeCommerceExternalEffectInPostgres,
}

const DEFAULT_RECONCILIATION_DEPENDENCIES:
FaireProductImageReconciliationDependencies = {
  readContext: readFaireProductImageReconciliationContextInPostgres,
  recoverExpiredClaim: recoverExpiredFaireProductImageClaimInPostgres,
  readProviderImages: readCurrentCommerceProviderImageSources,
  recordProviderStep: recordFaireProductImageProviderStepInPostgres,
  resolveApplied: resolveFaireProductImageAppliedReconciliationInPostgres,
}

export class FaireProductImageProjectionError extends Error {
  readonly retryable = false

  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly externalEffectGlobalId: string | null = null,
  ) {
    super(message)
    this.name = 'FaireProductImageProjectionError'
  }
}

function fail(
  code: string,
  message: string,
  status = 409,
  externalEffectGlobalId: string | null = null,
): never {
  throw new FaireProductImageProjectionError(
    code,
    message,
    status,
    externalEffectGlobalId,
  )
}

function safeCode(error: unknown, fallback: string) {
  const candidate = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(candidate)
    ? candidate
    : fallback
}

function providerImageSetFingerprint(
  sources: Awaited<ReturnType<typeof readCurrentCommerceProviderImageSources>>,
) {
  return createHash('sha256').update(JSON.stringify(
    sources.map((source) => ({
      locatorSha256: source.locatorSha256,
      sequence: source.sequence,
    })),
  )).digest('hex')
}

function stringValue(value: unknown, label: string, maximum = 512) {
  const normalized = String(value || '').trim()
  if (
    !normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    fail('FAIRE_PRODUCT_IMAGE_SELECTION_INVALID', `${label} is invalid`, 400)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    fail('FAIRE_PRODUCT_IMAGE_SELECTION_INVALID', `${label} is invalid`, 400)
  }
  return number
}

function nonNegativeInteger(value: unknown, label: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('FAIRE_PRODUCT_IMAGE_SELECTION_INVALID', `${label} is invalid`, 400)
  }
  return number
}

function actorEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || !email.includes('@') || email.length > 320) {
    fail('FAIRE_PRODUCT_IMAGE_ACTOR_INVALID', 'A signed-in actor is required', 401)
  }
  return email
}

function idempotencyKey(input: {
  accountGlobalId: string
  externalProductId: string
  externalVariantId: string
  productReferenceCode: string
  channelStateGlobalId: string
  channelStateRowVersion: number
  channelSourceRevision: string
  channelSourceHash: string
  imageAssetId: string
  assetRevision: number
  assetRowVersion: number
  assetContentSha256: string
  mode: 'shadow' | 'active'
  shadowSimulationEffectGlobalId: string | null
}) {
  return `faire-product-image:${createHash('sha256').update(JSON.stringify({
    adapterVersion: FAIRE_PRODUCT_IMAGE_ADAPTER_VERSION,
    ...input,
  })).digest('hex')}`
}

function assertClaim(
  claim: ClaimedFaireProviderWrite,
  grant: FaireProductImageProjectionGrant,
) {
  if (
    claim.action !== FAIRE_PRODUCT_IMAGE_ACTION
    || claim.organizationId !== grant.organizationId
    || claim.integrationAccountId !== grant.integrationAccountId
    || claim.accountGlobalId !== grant.accountGlobalId
    || claim.externalAccountId !== grant.externalAccountId
    || claim.credentialGeneration !== grant.credentialGeneration
    || claim.activationRevision !== grant.activationRevision
    || claim.aggregateId !== grant.productReferenceCode
    || claim.aggregateRevision !== grant.aggregateRevision
    || claim.aggregateHash !== grant.aggregateHash
    || claim.idempotencyKey !== grant.idempotencyKey
    || claim.productImageDeliveryGrantId !== grant.id
    || claim.shadowSimulationEffectId === null
    || claim.effectId !== grant.effectId
    || claim.effectGlobalId !== grant.effectGlobalId
    || claim.state !== 'consumed'
    || claim.effectState !== 'claimed'
    || claim.attemptNumber !== 1
    || claim.capabilities.length !== 2
    || claim.capabilities[0] !== REQUIRED_CAPABILITIES[0]
    || claim.capabilities[1] !== REQUIRED_CAPABILITIES[1]
    || claim.verifiedWriteScopes.length !== 1
    || claim.verifiedWriteScopes[0] !== REQUIRED_SCOPE
    || claim.scopeVerificationSource !== 'oauth_grant'
    || !claim.leaseToken
    || !claim.providerAttemptId
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_CLAIM_MISMATCH',
      'Durable Faire Product-image claim is stale or mismatched',
      409,
      grant.effectGlobalId,
    )
  }
  return claim
}

function resolveCredential(
  runtime: CommerceRuntimeCredentialRecord | null,
  grant: FaireProductImageProjectionGrant,
  decryptCredential: typeof decryptCommerceCredential,
) {
  if (
    !runtime
    || runtime.organizationId !== grant.organizationId
    || runtime.integrationAccountId !== grant.integrationAccountId
    || runtime.globalId !== grant.accountGlobalId
    || runtime.provider !== 'faire'
    || runtime.environment !== 'production'
    || runtime.externalAccountId !== grant.externalAccountId
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== grant.credentialGeneration
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_CREDENTIAL_STALE',
      'Verified Faire credential no longer matches the one-use claim',
      409,
      grant.effectGlobalId,
    )
  }
  const credential = decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (
    credential.provider !== 'faire'
    || credential.authMode !== 'faire_oauth'
    || !credential.scopes.includes('READ_PRODUCTS')
    || !credential.scopes.includes('WRITE_PRODUCTS')
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_OAUTH_SCOPE_REQUIRED',
      'Faire OAuth must include current READ_PRODUCTS and WRITE_PRODUCTS grants',
      409,
      grant.effectGlobalId,
    )
  }
  return { runtime, credential }
}

function clientOptions(
  grant: FaireProductImageProjectionGrant,
  credential: FaireCommerceCredential,
): FaireCommerceClientOptions {
  if (credential.authMode !== 'faire_oauth') {
    fail(
      'FAIRE_PRODUCT_IMAGE_OAUTH_REQUIRED',
      'Faire Product-image publication requires OAuth',
      409,
      grant.effectGlobalId,
    )
  }
  return {
    accessToken: credential.accessToken,
    applicationId: credential.applicationId,
    applicationSecret: credential.applicationSecret,
    credentialBinding: {
      provider: 'faire',
      environment: 'production',
      accountGlobalId: grant.accountGlobalId,
      externalAccountId: grant.externalAccountId,
      credentialVersion: grant.credentialGeneration,
      connectionStatus: 'active',
      verificationStatus: 'verified',
    },
    writeAuthorization: {
      provider: 'faire',
      environment: 'production',
      accountGlobalId: grant.accountGlobalId,
      externalAccountId: grant.externalAccountId,
      credentialVersion: grant.credentialGeneration,
      authorizationRevision: 1,
      capabilities: REQUIRED_CAPABILITIES,
      verifiedWriteScopes: [REQUIRED_SCOPE],
      scopeVerificationSource: 'oauth_grant',
    },
  }
}

async function finalize(input: {
  dependencies: FaireProductImageProjectionDependencies
  grant: FaireProductImageProjectionGrant
  claim: ClaimedFaireProviderWrite
  outcome: 'succeeded' | 'failed' | 'unknown'
  stage: string
  errorCode: string | null
  providerWriteCount: number
  uploadedLocatorSha256: string | null
  priorImageCount: number | null
  projectedImageCount: number | null
}) {
  const evidence = {
    provider: 'faire',
    action: FAIRE_PRODUCT_IMAGE_ACTION,
    operation: 'productImagePublish',
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    deliveryGrantId: input.grant.id,
    authorizationGlobalId: input.claim.authorizationGlobalId,
    scopeEvidenceGlobalId: input.claim.scopeEvidenceGlobalId,
    providerAttemptGlobalId: input.claim.providerAttemptGlobalId,
    externalProductId: input.grant.externalProductId,
    assetContentSha256: input.grant.assetContentSha256,
    uploadedLocatorSha256: input.uploadedLocatorSha256,
    existingImagesPreserved: true,
    priorImageCount: input.priorImageCount,
    projectedImageCount: input.projectedImageCount,
    providerWritesKnown: input.outcome !== 'unknown',
    providerWriteCountLowerBound: input.providerWriteCount,
    providerWrites: input.providerWriteCount,
  }
  try {
    await input.dependencies.finalizeEffect({
      organizationId: input.grant.organizationId,
      globalId: input.grant.effectGlobalId,
      leaseToken: input.claim.leaseToken,
      outcome: input.outcome,
      redactedResult: evidence,
      providerReference: input.grant.externalProductId,
      errorCode: input.errorCode,
      providerWriteCount: input.providerWriteCount,
    })
  } catch {
    fail(
      'FAIRE_PRODUCT_IMAGE_FINALIZE_FAILED',
      'Faire Product-image outcome requires reconciliation; do not retry either provider write',
      500,
      input.grant.effectGlobalId,
    )
  }
  return {
    productId: input.grant.productId,
    productReferenceCode: input.grant.productReferenceCode,
    channelStateGlobalId: input.grant.channelStateGlobalId,
    imageAssetId: input.grant.imageAssetId,
    imageAssetRevision: input.grant.assetRevision,
    imageContentSha256: input.grant.assetContentSha256,
    mode: input.grant.mode,
    replayed: false,
    providerMutation: {
      accepted: input.outcome === 'succeeded',
      writeCount: input.providerWriteCount,
      uploadAccepted: input.providerWriteCount >= 1,
      attachmentAccepted: input.providerWriteCount >= 2,
    },
    images: {
      existingPreserved: true,
      priorCount: input.priorImageCount,
      projectedCount: input.projectedImageCount,
      uploadedLocatorSha256: input.uploadedLocatorSha256,
    },
    externalEffect: {
      globalId: input.grant.effectGlobalId,
      state: input.outcome,
      providerWriteCount: input.providerWriteCount,
    },
  } satisfies FaireProductImagePublishResult
}

function evidenceInteger(
  value: unknown,
  maximum: number,
): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum
    ? number
    : null
}

function replayTerminalGrant(
  grant: FaireProductImageProjectionGrant,
): FaireProductImagePublishResult {
  if (!['succeeded', 'failed', 'unknown'].includes(grant.effectState)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REPLAY_NOT_TERMINAL',
      'Faire Product-image effect is not terminal',
      409,
      grant.effectGlobalId,
    )
  }
  const result = grant.effectResult
  const providerWriteCount = evidenceInteger(
    result?.providerWrites,
    2,
  )
  if (
    !result
    || result.provider !== 'faire'
    || result.operation !== 'productImagePublish'
    || result.outcome !== grant.effectState
    || providerWriteCount === null
    || providerWriteCount !== grant.providerWriteCount
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_REPLAY_EVIDENCE_INVALID',
      'Durable Faire Product-image outcome evidence is incomplete',
      500,
      grant.effectGlobalId,
    )
  }
  const priorImageCount = result.priorImageCount === null
    ? null
    : evidenceInteger(result.priorImageCount, MAX_PROVIDER_IMAGES)
  const projectedImageCount = result.projectedImageCount === null
    ? null
    : evidenceInteger(result.projectedImageCount, MAX_PROVIDER_IMAGES)
  const uploadedLocatorSha256 = typeof result.uploadedLocatorSha256 === 'string'
    && HASH.test(result.uploadedLocatorSha256)
    ? result.uploadedLocatorSha256
    : null
  return {
    productId: grant.productId,
    productReferenceCode: grant.productReferenceCode,
    channelStateGlobalId: grant.channelStateGlobalId,
    imageAssetId: grant.imageAssetId,
    imageAssetRevision: grant.assetRevision,
    imageContentSha256: grant.assetContentSha256,
    mode: 'active',
    replayed: true,
    providerMutation: {
      accepted: grant.effectState === 'succeeded',
      writeCount: providerWriteCount,
      uploadAccepted: providerWriteCount >= 1,
      attachmentAccepted: providerWriteCount >= 2,
    },
    images: {
      existingPreserved: result.existingImagesPreserved === true,
      priorCount: priorImageCount,
      projectedCount: projectedImageCount,
      uploadedLocatorSha256,
    },
    externalEffect: {
      globalId: grant.effectGlobalId,
      state: grant.effectState,
      providerWriteCount,
    },
  }
}

function recoveredClaimResult(
  grant: FaireProductImageProjectionGrant,
  context: Awaited<ReturnType<
    typeof recoverExpiredFaireProductImageClaimInPostgres
  >>,
): FaireProductImagePublishResult {
  return {
    productId: grant.productId,
    productReferenceCode: grant.productReferenceCode,
    channelStateGlobalId: grant.channelStateGlobalId,
    imageAssetId: grant.imageAssetId,
    imageAssetRevision: grant.assetRevision,
    imageContentSha256: grant.assetContentSha256,
    mode: 'active',
    replayed: true,
    providerMutation: {
      accepted: false,
      writeCount: context.providerWriteCount,
      uploadAccepted: context.providerWriteCount >= 1,
      attachmentAccepted: context.providerWriteCount >= 2,
    },
    images: {
      existingPreserved:
        context.reconciliationEligibility === 'readback_terminalizable',
      priorCount: context.priorImageCount,
      projectedCount: context.projectedImageCount,
      uploadedLocatorSha256: context.uploadedLocatorSha256,
    },
    externalEffect: {
      globalId: context.externalEffectGlobalId,
      state: context.effectState,
      providerWriteCount: context.providerWriteCount,
    },
  }
}

export async function executeFaireProductImagePublish(
  rawInput: {
    organizationId: unknown
    productId: unknown
    channelStateGlobalId: unknown
    imageAssetId: unknown
    executeProviderWrite: unknown
    expectedProductReferenceCode: unknown
    expectedChannelStateRowVersion: unknown
    expectedChannelSourceRevision: unknown
    expectedAssetRevision: unknown
    expectedAssetRowVersion: unknown
    expectedAssetContentSha256: unknown
    shadowSimulationEffectGlobalId: unknown
    actorEmail: unknown
  },
  overrides: Partial<FaireProductImageProjectionDependencies> = {},
): Promise<FaireProductImagePublishResult> {
  const input = {
    organizationId: stringValue(rawInput.organizationId, 'Organization', 36).toLowerCase(),
    productId: stringValue(rawInput.productId, 'Product', 36).toLowerCase(),
    channelStateGlobalId: stringValue(rawInput.channelStateGlobalId, 'Faire channel', 32).toLowerCase(),
    imageAssetId: stringValue(rawInput.imageAssetId, 'Image asset', 36).toLowerCase(),
    executeProviderWrite: rawInput.executeProviderWrite === true,
    expectedProductReferenceCode: stringValue(rawInput.expectedProductReferenceCode, 'Product reference', 32).toLowerCase(),
    expectedChannelStateRowVersion: nonNegativeInteger(rawInput.expectedChannelStateRowVersion, 'Channel revision'),
    expectedChannelSourceRevision: stringValue(rawInput.expectedChannelSourceRevision, 'Channel source revision', 2_048),
    expectedAssetRevision: positiveInteger(rawInput.expectedAssetRevision, 'Asset revision'),
    expectedAssetRowVersion: positiveInteger(rawInput.expectedAssetRowVersion, 'Asset row revision'),
    expectedAssetContentSha256: stringValue(rawInput.expectedAssetContentSha256, 'Asset hash', 64).toLowerCase(),
    shadowSimulationEffectGlobalId: rawInput.shadowSimulationEffectGlobalId === null
      || rawInput.shadowSimulationEffectGlobalId === undefined
      ? null
      : String(rawInput.shadowSimulationEffectGlobalId).trim().toLowerCase(),
    actorEmail: actorEmail(rawInput.actorEmail),
  }
  if (
    !UUID.test(input.organizationId)
    || !UUID.test(input.productId)
    || !UUID.test(input.imageAssetId)
    || !CHANNEL_GLOBAL_ID.test(input.channelStateGlobalId)
    || !PRODUCT_REFERENCE.test(input.expectedProductReferenceCode)
    || !HASH.test(input.expectedAssetContentSha256)
    || (
      input.executeProviderWrite
      && !EFFECT_GLOBAL_ID.test(input.shadowSimulationEffectGlobalId || '')
    )
    || (!input.executeProviderWrite && input.shadowSimulationEffectGlobalId !== null)
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_SELECTION_INVALID',
      'The exact Product, Faire listing, primary image revision, and Shadow evidence are required',
      400,
    )
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const selection = await dependencies.resolveSelection({
    organizationId: input.organizationId,
    productId: input.productId,
    channelStateGlobalId: input.channelStateGlobalId,
    imageAssetId: input.imageAssetId,
  })
  if (
    selection.productReferenceCode !== input.expectedProductReferenceCode
    || selection.channelStateRowVersion !== input.expectedChannelStateRowVersion
    || selection.channelSourceRevision !== input.expectedChannelSourceRevision
    || selection.assetRevision !== input.expectedAssetRevision
    || selection.assetRowVersion !== input.expectedAssetRowVersion
    || selection.assetContentSha256 !== input.expectedAssetContentSha256
  ) {
    fail(
      'FAIRE_PRODUCT_IMAGE_SELECTION_STALE',
      'The Product, Faire listing, or primary image revision changed after review',
    )
  }
  const mode = input.executeProviderWrite ? 'active' : 'shadow'
  const commandId = idempotencyKey({
    accountGlobalId: selection.accountGlobalId,
    externalProductId: selection.externalProductId,
    externalVariantId: selection.externalVariantId,
    productReferenceCode: selection.productReferenceCode,
    channelStateGlobalId: input.channelStateGlobalId,
    channelStateRowVersion: selection.channelStateRowVersion,
    channelSourceRevision: selection.channelSourceRevision,
    channelSourceHash: selection.channelSourceHash,
    imageAssetId: input.imageAssetId,
    assetRevision: selection.assetRevision,
    assetRowVersion: selection.assetRowVersion,
    assetContentSha256: selection.assetContentSha256,
    mode,
    shadowSimulationEffectGlobalId: input.shadowSimulationEffectGlobalId,
  })
  const grant = await dependencies.prepareProjection({
    organizationId: input.organizationId,
    productId: input.productId,
    channelStateGlobalId: input.channelStateGlobalId,
    imageAssetId: input.imageAssetId,
    idempotencyKey: commandId,
    mode,
    expectedAccountGlobalId: selection.accountGlobalId,
    expectedExternalProductId: selection.externalProductId,
    expectedExternalVariantId: selection.externalVariantId,
    expectedProductReferenceCode: selection.productReferenceCode,
    expectedChannelStateRowVersion: selection.channelStateRowVersion,
    expectedChannelSourceRevision: selection.channelSourceRevision,
    expectedChannelSourceHash: selection.channelSourceHash,
    expectedAssetRevision: selection.assetRevision,
    expectedAssetRowVersion: selection.assetRowVersion,
    expectedAssetContentSha256: selection.assetContentSha256,
    shadowSimulationEffectGlobalId: input.shadowSimulationEffectGlobalId,
    actorEmail: input.actorEmail,
  })
  if (grant.mode === 'shadow') {
    return {
      productId: grant.productId,
      productReferenceCode: grant.productReferenceCode,
      channelStateGlobalId: grant.channelStateGlobalId,
      imageAssetId: grant.imageAssetId,
      imageAssetRevision: grant.assetRevision,
      imageContentSha256: grant.assetContentSha256,
      mode: 'shadow',
      replayed: grant.replayed,
      providerMutation: {
        accepted: false,
        writeCount: 0,
        uploadAccepted: false,
        attachmentAccepted: false,
      },
      images: {
        existingPreserved: true,
        priorCount: null,
        projectedCount: null,
        uploadedLocatorSha256: null,
      },
      externalEffect: {
        globalId: grant.effectGlobalId,
        state: grant.effectState,
        providerWriteCount: 0,
      },
    }
  }
  if (!grant.authorization) {
    fail(
      'FAIRE_PRODUCT_IMAGE_AUTHORIZATION_MISSING',
      'The exact one-use Faire Product-image authorization is missing',
      409,
      grant.effectGlobalId,
    )
  }
  if (['succeeded', 'failed', 'unknown'].includes(grant.effectState)) {
    return replayTerminalGrant(grant)
  }
  if (grant.effectState === 'claimed') {
    if (grant.leaseExpired) {
      const recovered = await dependencies.recoverExpiredClaim({
        organizationId: grant.organizationId,
        productId: grant.productId,
        externalEffectGlobalId: grant.effectGlobalId,
        actorEmail: input.actorEmail,
      })
      return recoveredClaimResult(grant, recovered)
    }
    fail(
      'FAIRE_PRODUCT_IMAGE_RECONCILIATION_REQUIRED',
      'Faire Product-image publication is already in flight; do not repeat either provider write',
      409,
      grant.effectGlobalId,
    )
  }
  if (grant.effectState !== 'pending') {
    fail(
      'FAIRE_PRODUCT_IMAGE_EFFECT_STATE_INVALID',
      'Faire Product-image effect state is invalid',
      500,
      grant.effectGlobalId,
    )
  }

  const claim = assertClaim(await dependencies.claimProviderWrite({
    organizationId: grant.organizationId,
    authorizationGlobalId: grant.authorization.globalId,
    expectedAuthorizationFenceHash: grant.authorization.fenceHash,
    workerId: 'faire-product-image-publish',
    adapterVersion: FAIRE_PRODUCT_IMAGE_ADAPTER_VERSION,
    leaseSeconds: CLAIM_LEASE_SECONDS,
  }), grant)

  let asset: Awaited<ReturnType<typeof readFaireProductImageAssetForClaimInPostgres>>
  let runtime: CommerceRuntimeCredentialRecord | null
  let credential: FaireCommerceCredential
  let providerImages: Awaited<ReturnType<typeof readCurrentCommerceProviderImageSources>>
  let client: Pick<FaireCommerceClient, 'uploadProductImage' | 'updateProductImages'>
  try {
    asset = await dependencies.readAsset({
      organizationId: grant.organizationId,
      deliveryGrantId: grant.id,
      externalEffectGlobalId: grant.effectGlobalId,
      imageAssetId: grant.imageAssetId,
      contentSha256: grant.assetContentSha256,
    })
    runtime = await dependencies.readRuntimeCredential({
      organizationId: grant.organizationId,
      accountGlobalId: grant.accountGlobalId,
    })
    const resolved = resolveCredential(runtime, grant, dependencies.decryptCredential)
    credential = resolved.credential
    providerImages = await dependencies.readProviderImages({
      organizationId: grant.organizationId,
      accountGlobalId: grant.accountGlobalId,
      provider: 'faire',
      credentialGeneration: grant.credentialGeneration,
      externalProductId: grant.externalProductId,
      requireExactOrderedSet: true,
      intentKey:
        `${claim.providerAttemptId}:${claim.leaseToken}:predispatch-image-set`,
      acquiredBy: input.actorEmail,
    })
    if (providerImages.length >= MAX_PROVIDER_IMAGES) {
      fail(
        'FAIRE_PRODUCT_IMAGE_LIMIT_REACHED',
        `Faire already has ${MAX_PROVIDER_IMAGES} Product images; remove one before publication`,
        409,
        grant.effectGlobalId,
      )
    }
    client = dependencies.createClient(clientOptions(grant, credential))
  } catch (error) {
    return finalize({
      dependencies,
      grant,
      claim,
      outcome: 'failed',
      stage: 'predispatch_fence',
      errorCode: safeCode(error, 'FAIRE_PRODUCT_IMAGE_PREDISPATCH_FAILED'),
      providerWriteCount: 0,
      uploadedLocatorSha256: null,
      priorImageCount: null,
      projectedImageCount: null,
    })
  }

  let uploadedLocatorSha256: string | null = null
  let uploadedUrl: string
  try {
    const uploaded = await client.uploadProductImage({
      attachmentBase64: Buffer.from(asset.bytes).toString('base64'),
    })
    uploadedUrl = uploaded.url
    uploadedLocatorSha256 = commerceProductImageLocatorFingerprint(uploadedUrl)
    if (!uploadedLocatorSha256 || !HASH.test(uploadedLocatorSha256)) {
      throw Object.assign(new Error('Faire upload locator is invalid'), {
        code: 'FAIRE_PRODUCT_IMAGE_UPLOAD_READBACK_INVALID',
      })
    }
    await dependencies.recordProviderStep({
      organizationId: grant.organizationId,
      deliveryGrantId: grant.id,
      externalEffectId: grant.effectId,
      providerAttemptId: claim.providerAttemptId,
      stage: 'upload',
      outcome: 'succeeded',
      uploadedLocatorSha256,
      providerWriteCount: 1,
      redactedEvidence: {
        provider: 'faire',
        operation: 'productImageUpload',
        outcome: 'succeeded',
        assetContentSha256: grant.assetContentSha256,
        uploadedLocatorSha256,
        providerWrites: 1,
      },
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    return finalize({
      dependencies,
      grant,
      claim,
      outcome: 'unknown',
      stage: uploadedLocatorSha256
        ? 'upload_evidence_persistence'
        : 'upload_dispatch',
      errorCode: safeCode(error, 'FAIRE_PRODUCT_IMAGE_UPLOAD_OUTCOME_UNKNOWN'),
      providerWriteCount: uploadedLocatorSha256 ? 1 : 0,
      uploadedLocatorSha256,
      priorImageCount: providerImages.length,
      projectedImageCount: null,
    })
  }

  const projectedImages: FaireProductImageInput[] = [
    ...providerImages.map((source, sequence) => ({
      url: source.url,
      sequence,
    })),
    { url: uploadedUrl, sequence: providerImages.length },
  ]
  const expectedCurrentImages: FaireProductImageInput[] =
    providerImages.map((source, sequence) => ({
      url: source.url,
      sequence,
    }))
  try {
    await client.updateProductImages(
      grant.externalProductId,
      { expectedCurrentImages, images: projectedImages },
    )
    await dependencies.recordProviderStep({
      organizationId: grant.organizationId,
      deliveryGrantId: grant.id,
      externalEffectId: grant.effectId,
      providerAttemptId: claim.providerAttemptId,
      stage: 'attach',
      outcome: 'succeeded',
      uploadedLocatorSha256,
      providerWriteCount: 2,
      redactedEvidence: {
        provider: 'faire',
        operation: 'productImageAttach',
        outcome: 'succeeded',
        externalProductId: grant.externalProductId,
        assetContentSha256: grant.assetContentSha256,
        uploadedLocatorSha256,
        priorImageCount: providerImages.length,
        projectedImageCount: projectedImages.length,
        existingImagesPreserved: true,
        providerWritesKnown: true,
        providerWriteCountLowerBound: 2,
        providerWrites: 2,
      },
      actorEmail: input.actorEmail,
    })
  } catch (error) {
    try {
      await dependencies.recordProviderStep({
        organizationId: grant.organizationId,
        deliveryGrantId: grant.id,
        externalEffectId: grant.effectId,
        providerAttemptId: claim.providerAttemptId,
        stage: 'attach',
        outcome: 'unknown',
        uploadedLocatorSha256,
        providerWriteCount: 1,
        redactedEvidence: {
          provider: 'faire',
          operation: 'productImageAttach',
          outcome: 'unknown',
          errorCode: safeCode(error, 'FAIRE_PRODUCT_IMAGE_ATTACH_OUTCOME_UNKNOWN'),
          externalProductId: grant.externalProductId,
          assetContentSha256: grant.assetContentSha256,
          uploadedLocatorSha256,
          priorImageCount: providerImages.length,
          projectedImageCount: projectedImages.length,
          existingImagesPreserved: true,
          knownProviderWrites: 1,
          providerWritesKnown: false,
          providerWriteCountLowerBound: 1,
          providerWrites: 1,
        },
        actorEmail: input.actorEmail,
      })
    } catch {
      // Terminal effect evidence below remains the durable lower bound. Never
      // repeat either provider call when append-only step recording fails.
    }
    return finalize({
      dependencies,
      grant,
      claim,
      outcome: 'unknown',
      stage: 'attach_dispatch_or_readback',
      errorCode: safeCode(error, 'FAIRE_PRODUCT_IMAGE_ATTACH_OUTCOME_UNKNOWN'),
      providerWriteCount: 1,
      uploadedLocatorSha256,
      priorImageCount: providerImages.length,
      projectedImageCount: projectedImages.length,
    })
  }

  return finalize({
    dependencies,
    grant,
    claim,
    outcome: 'succeeded',
    stage: 'exact_product_readback',
    errorCode: null,
    providerWriteCount: 2,
    uploadedLocatorSha256,
    priorImageCount: providerImages.length,
    projectedImageCount: projectedImages.length,
  })
}

export async function reconcileFaireProductImagePublish(
  rawInput: {
    organizationId: unknown
    productId: unknown
    externalEffectGlobalId: unknown
    actorEmail: unknown
  },
  overrides: Partial<FaireProductImageReconciliationDependencies> = {},
) {
  const organizationId = stringValue(rawInput.organizationId, 'Organization', 36).toLowerCase()
  const productId = stringValue(rawInput.productId, 'Product', 36).toLowerCase()
  const externalEffectGlobalId = stringValue(
    rawInput.externalEffectGlobalId,
    'External effect',
    32,
  ).toLowerCase()
  const reconciledBy = actorEmail(rawInput.actorEmail)
  if (!UUID.test(organizationId) || !UUID.test(productId)
      || !EFFECT_GLOBAL_ID.test(externalEffectGlobalId)) {
    fail('FAIRE_PRODUCT_IMAGE_RECONCILIATION_INVALID', 'Reconciliation selection is invalid', 404)
  }
  const dependencies = {
    ...DEFAULT_RECONCILIATION_DEPENDENCIES,
    ...overrides,
  }
  let context = await dependencies.readContext({
    organizationId,
    productId,
    externalEffectGlobalId,
  })
  if (context.effectState === 'claimed' && context.leaseExpired) {
    context = await dependencies.recoverExpiredClaim({
      organizationId,
      productId,
      externalEffectGlobalId,
      actorEmail: reconciledBy,
    })
  }
  if (
    context.effectState === 'succeeded'
    && context.reconciliationApplied
  ) {
    return {
      externalEffectGlobalId,
      outcome: 'observed_applied' as const,
      confirmedApplied: true,
      providerImageCount: context.reconciledProviderImageCount,
      exactLocatorMatchCount: 1,
      terminalized: true,
      replayed: true,
    }
  }
  if (!['unknown', 'failed'].includes(context.effectState)) {
    fail(
      'FAIRE_PRODUCT_IMAGE_RECONCILIATION_NOT_REQUIRED',
      context.effectState === 'claimed'
        ? 'Faire Product-image publication is still inside its claim lease'
        : 'Only an uncertain or failed Faire Product-image publication can be reconciled',
    )
  }
  if (
    context.effectState === 'unknown'
    && context.reconciliationEligibility !== 'readback_terminalizable'
  ) {
    const evidence = {
      provider: 'faire',
      operation: 'productImagePublishReconciliation',
      outcome: 'manual_review',
      reason: context.reconciliationReason,
      externalProductId: context.externalProductId,
      uploadedLocatorSha256: context.uploadedLocatorSha256,
      providerWrites: context.providerWriteCount,
      reconciledBy,
    }
    await dependencies.recordProviderStep({
      organizationId,
      deliveryGrantId: context.deliveryGrantId,
      externalEffectId: context.externalEffectId,
      providerAttemptId: null,
      stage: 'reconcile',
      outcome: 'manual_review',
      uploadedLocatorSha256: context.uploadedLocatorSha256,
      providerWriteCount: context.providerWriteCount,
      redactedEvidence: evidence,
      actorEmail: reconciledBy,
    })
    return {
      externalEffectGlobalId,
      outcome: 'manual_review' as const,
      confirmedApplied: false,
      reason: context.reconciliationReason,
      terminalized: false,
      replayed: false,
    }
  }
  if (!context.uploadedLocatorSha256) {
    const evidence = {
      provider: 'faire',
      operation: 'productImagePublishReconciliation',
      outcome: 'manual_review',
      reason: 'upload_locator_unavailable',
      providerWrites: 0,
      reconciledBy,
    }
    await dependencies.recordProviderStep({
      organizationId,
      deliveryGrantId: context.deliveryGrantId,
      externalEffectId: context.externalEffectId,
      providerAttemptId: null,
      stage: 'reconcile',
      outcome: 'manual_review',
      uploadedLocatorSha256: null,
      providerWriteCount: context.providerWriteCount,
      redactedEvidence: evidence,
      actorEmail: reconciledBy,
    })
    return {
      externalEffectGlobalId,
      outcome: 'manual_review' as const,
      confirmedApplied: false,
      reason: 'upload_locator_unavailable' as const,
    }
  }
  let sources: Awaited<ReturnType<typeof readCurrentCommerceProviderImageSources>>
  try {
    sources = await dependencies.readProviderImages({
      organizationId,
      accountGlobalId: context.accountGlobalId,
      provider: 'faire',
      credentialGeneration: context.credentialGeneration,
      externalProductId: context.externalProductId,
      requireExactOrderedSet: true,
      intentKey:
        `${context.externalEffectGlobalId}:reconcile:${randomUUID()}`,
      acquiredBy: reconciledBy,
    })
  } catch (error) {
    const errorCode = safeCode(
      error,
      'FAIRE_PRODUCT_IMAGE_RECONCILIATION_READ_FAILED',
    )
    await dependencies.recordProviderStep({
      organizationId,
      deliveryGrantId: context.deliveryGrantId,
      externalEffectId: context.externalEffectId,
      providerAttemptId: null,
      stage: 'reconcile',
      outcome: 'manual_review',
      uploadedLocatorSha256: context.uploadedLocatorSha256,
      providerWriteCount: context.providerWriteCount,
      redactedEvidence: {
        provider: 'faire',
        operation: 'productImagePublishReconciliation',
        outcome: 'manual_review',
        reason: 'provider_image_set_not_authoritative',
        errorCode,
        externalProductId: context.externalProductId,
        uploadedLocatorSha256: context.uploadedLocatorSha256,
        providerWrites: context.providerWriteCount,
        reconciledBy,
      },
      actorEmail: reconciledBy,
    })
    return {
      externalEffectGlobalId,
      outcome: 'manual_review' as const,
      confirmedApplied: false,
      reason: 'provider_image_set_not_authoritative' as const,
    }
  }
  const matches = sources.filter(
    (source) => source.locatorSha256 === context.uploadedLocatorSha256,
  )
  const providerImageSetSha256 = providerImageSetFingerprint(sources)
  if (matches.length === 1 && context.effectState === 'unknown') {
    const resolution = await dependencies.resolveApplied({
      organizationId,
      productId,
      externalEffectGlobalId,
      expectedDeliveryGrantId: context.deliveryGrantId,
      expectedExternalEffectId: context.externalEffectId,
      expectedAccountGlobalId: context.accountGlobalId,
      expectedCredentialGeneration: context.credentialGeneration,
      expectedExternalProductId: context.externalProductId,
      expectedAssetContentSha256: context.assetContentSha256,
      expectedUploadedLocatorSha256: context.uploadedLocatorSha256,
      providerImageCount: sources.length,
      exactLocatorMatchCount: matches.length,
      providerImageSetSha256,
      actorEmail: reconciledBy,
    })
    return {
      externalEffectGlobalId,
      outcome: 'observed_applied' as const,
      confirmedApplied: true,
      providerImageCount: resolution.providerImageCount,
      exactLocatorMatchCount: resolution.exactLocatorMatchCount,
      terminalized: resolution.effectState === 'succeeded',
      replayed: resolution.replayed,
    }
  }
  const outcome = matches.length === 0
    ? 'observed_absent'
    : 'manual_review'
  const reason = matches.length > 1
    ? 'ambiguous_exact_locator_matches'
    : context.effectState === 'failed'
      ? 'effect_state_conflicts_with_readback'
      : null
  await dependencies.recordProviderStep({
    organizationId,
    deliveryGrantId: context.deliveryGrantId,
    externalEffectId: context.externalEffectId,
    providerAttemptId: null,
    stage: 'reconcile',
    outcome,
    uploadedLocatorSha256: context.uploadedLocatorSha256,
    providerWriteCount: context.providerWriteCount,
    redactedEvidence: {
      provider: 'faire',
      operation: 'productImagePublishReconciliation',
      outcome,
      externalProductId: context.externalProductId,
      assetContentSha256: context.assetContentSha256,
      uploadedLocatorSha256: context.uploadedLocatorSha256,
      providerImageCount: sources.length,
      exactLocatorMatchCount: matches.length,
      providerImageSetSha256,
      providerWrites: context.providerWriteCount,
      ...(reason ? { reason } : {}),
      reconciledBy,
    },
    actorEmail: reconciledBy,
  })
  return {
    externalEffectGlobalId,
    outcome,
    confirmedApplied: false,
    providerImageCount: sources.length,
    exactLocatorMatchCount: matches.length,
    ...(reason ? { reason } : {}),
    terminalized: false,
    replayed: false,
  }
}
