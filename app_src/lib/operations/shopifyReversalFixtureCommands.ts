import { createHash } from 'node:crypto'
import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import { hasEffectiveShopifyScope } from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  prepareShopifyFulfillmentProviderAttempt,
  readShopifyFulfillment,
  shopifyFulfillmentAttemptSignatureHash,
  shopifyReversalFixtureFulfillmentProviderPayloadHash,
  ShopifyFulfillmentWritebackError,
  executeShopifyReversalFixtureFulfillmentProviderAttempt,
  type ShopifyFulfillmentAttemptSignature,
  type ShopifyFulfillmentProviderInput,
} from '@/lib/integrations/shopifyFulfillmentWriteback'
import {
  readShopifyLocationAdministrationShop,
} from '@/lib/integrations/shopifyLocationAdministration'
import {
  createShopifyReversalFixtureOrder,
  reconcileShopifyReversalFixtureOrder,
  SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE,
  SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
  shopifyReversalFixtureOrderProviderPayloadHash,
  shopifyReversalFixtureTagFingerprint,
  ShopifyReversalFixtureProviderError,
} from '@/lib/integrations/shopifyReversalFixtureProvider'
import {
  SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
  SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID,
  SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN,
  SHOPIFY_REVERSAL_FIXTURE_SHOP_GID,
  shopifyReversalFixtureRuntime,
} from '@/lib/integrations/shopifyReversalFixtureRuntime'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  requireCurrentCommerceProviderWritesInPostgres,
} from '@/lib/persistence/commerceProviderWrites'
import {
  allocateShopifyReversalFixtureCommandGlobalIdInPostgres,
  approveShopifyReversalFixtureCommandInPostgres,
  claimShopifyReversalFixtureCommandInPostgres,
  insertShopifyReversalFixtureCommandInPostgres,
  readShopifyReversalFixtureAuthorityInPostgres,
  readShopifyReversalFixtureCommandByIdempotencyInPostgres,
  readShopifyReversalFixtureCommandInPostgres,
  readShopifyReversalFixtureCommandStateInPostgres,
  readShopifyReversalFixtureFulfillmentTargetInPostgres,
  readUnknownShopifyReversalFixtureCommandInPostgres,
  recordShopifyReversalFixtureOutcomeInPostgres,
  type ShopifyReversalFixtureAuthority,
  type ShopifyReversalFixtureCommand,
  type ShopifyReversalFixturePhase,
} from '@/lib/persistence/shopifyReversalFixture'

const REQUIRED_SCOPES = [
  'read_orders',
  'write_orders',
  'write_merchant_managed_fulfillment_orders',
] as const
const CREATE_CONFIRMATION_PREFIX = 'CREATE TEST ORDER'
const FULFILL_CONFIRMATION_PREFIX = 'FULFILL TEST ORDER'
const FIXTURE_CARRIER = 'ClawPilot Fixture'
const SAFE_ORDER_CREATE_PROVIDER_ERROR_CODES = new Set([
  'FULFILLMENT_SERVICE_INVALID',
  'INVALID',
  'INVENTORY_CLAIM_FAILED',
  'PROCESSED_AT_INVALID',
  'REDUNDANT_CUSTOMER_FIELDS',
  'SHOP_DORMANT',
  'TAX_LINE_RATE_MISSING',
  'UNSPECIFIED',
])
const SAFE_ORDER_CREATE_PROVIDER_ERROR_FACT =
  /^([A-Z][A-Z0-9_]{1,63})(?: at ([A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64}){0,15}))?$/u

export class ShopifyReversalFixtureCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
    this.name = 'ShopifyReversalFixtureCommandError'
  }
}

function fail(code: string, message: string, status = 409): never {
  throw new ShopifyReversalFixtureCommandError(code, message, status)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function hash(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function confirmationStatement(
  phase: ShopifyReversalFixturePhase,
  intentHash: string,
) {
  return `${phase === 'create_order'
    ? CREATE_CONFIRMATION_PREFIX
    : FULFILL_CONFIRMATION_PREFIX} ${intentHash.slice(0, 12)}`
}

function runtimeGate() {
  const runtime = shopifyReversalFixtureRuntime()
  if (!runtime.available) {
    fail(
      runtime.blockerCode || 'SHOPIFY_REVERSAL_FIXTURE_RUNTIME_DISABLED',
      'The hidden Shopify reversal fixture route is disabled in this runtime',
      403,
    )
  }
  return runtime
}

function idempotencyKey(value: unknown) {
  const normalized = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(normalized)) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_IDEMPOTENCY_INVALID',
      'A valid idempotency key is required',
      400,
    )
  }
  return normalized
}

async function liveCredential(
  authority: ShopifyReversalFixtureAuthority,
): Promise<ShopifyCommerceRuntimeCredential> {
  if (
    authority.organizationId !== SHOPIFY_REVERSAL_FIXTURE_ORGANIZATION_ID
    || authority.accountGlobalId
      !== SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID
    || authority.externalAccountId !== SHOPIFY_REVERSAL_FIXTURE_SHOP_GID
    || authority.shopDomain !== SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_STORE_CHANGED',
      'The exact Test Pro Bakery Bites fixture identity is required',
      403,
    )
  }
  const providerWrites = await requireCurrentCommerceProviderWritesInPostgres({
    organizationId: authority.organizationId,
    accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
    provider: 'shopify',
    requiredScopes: REQUIRED_SCOPES,
    expectedControlRowVersion: authority.controlRowVersion,
    expectedCredentialGeneration: authority.credentialGeneration,
    expectedGrantedScopeDigest: authority.grantedScopeDigest,
  })
  if (
    providerWrites.environment !== 'sandbox'
    || providerWrites.accountGlobalId
      !== SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PROVIDER_WRITES_INVALID',
      'The exact current Shopify sandbox Provider writes authority is required',
    )
  }
  const runtime = await readCommerceRuntimeCredentialFromPostgres({
    organizationId: authority.organizationId,
    accountGlobalId: SHOPIFY_REVERSAL_FIXTURE_ACCOUNT_GLOBAL_ID,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.environment !== 'sandbox'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.integrationAccountId !== authority.integrationAccountId
    || runtime.externalAccountId !== authority.externalAccountId
    || runtime.credentialVersion !== authority.credentialGeneration
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_CONNECTION_INVALID',
      'The exact current verified Shopify sandbox credential is required',
    )
  }
  const decrypted = decryptCommerceCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_CREDENTIAL_INVALID',
      'The saved Shopify credential could not be decrypted',
      500,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  if (shopDomain !== authority.shopDomain) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_CONNECTION_CHANGED',
      'The Shopify canonical domain changed after preparation',
    )
  }
  const grant = await requestShopifyAccessToken({
    shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  })
  const credential = { shopDomain, accessToken: grant.accessToken }
  const probe = await probeShopifyConnection(credential)
  if (
    probe.shopId !== SHOPIFY_REVERSAL_FIXTURE_SHOP_GID
    || probe.shopDomain !== SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_STORE_CHANGED',
      'Shopify returned a different store identity',
    )
  }
  const missingScopes = REQUIRED_SCOPES.filter((scope) => (
    !hasEffectiveShopifyScope(authority.grantedScopes, scope)
    || !hasEffectiveShopifyScope(grant.grantedScopes, scope)
    || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
  ))
  if (missingScopes.length > 0) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_SCOPE_REQUIRED',
      `Shopify must grant ${missingScopes.join(' and ')} for this exact fixture`,
    )
  }
  const shop = await readShopifyLocationAdministrationShop(credential)
  if (
    shop.partnerDevelopment !== true
    || shop.id !== SHOPIFY_REVERSAL_FIXTURE_SHOP_GID
    || shop.domain !== SHOPIFY_REVERSAL_FIXTURE_SHOP_DOMAIN
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_PARTNER_STORE_REQUIRED',
      'The exact live Shopify store must remain a Partner development store',
    )
  }
  return credential
}

function prepareResponse(command: ShopifyReversalFixtureCommand) {
  return Object.freeze({
    commandGlobalId: command.globalId,
    phase: command.phase,
    intentHash: command.intentHash,
    confirmationStatement: confirmationStatement(
      command.phase,
      command.intentHash,
    ),
    expiresAt: command.expiresAt,
    orderGlobalId: command.orderGlobalId,
    approvalPath:
      `/api/dev/shopify-test-fixtures/approve?command=${command.globalId}`,
    providerWrites: 0 as const,
    normalUiAvailable: false as const,
  })
}

export async function readShopifyReversalFixtureApprovalIntent(input: {
  organizationId: unknown
  actorEmail: unknown
  commandGlobalId: unknown
}) {
  runtimeGate()
  const authority = await readShopifyReversalFixtureAuthorityInPostgres(input)
  const command = await readShopifyReversalFixtureCommandInPostgres(input)
  if (
    command.actorEmail !== authority.actorEmail
    || command.organizationId !== authority.organizationId
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_ACTOR_MISMATCH',
      'The signed-in actor does not own this fixture approval',
      403,
    )
  }
  if (Date.parse(command.expiresAt) <= Date.now()) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_APPROVAL_EXPIRED',
      'This fixture approval window has expired',
      409,
    )
  }
  return prepareResponse(command)
}

export async function approveShopifyReversalFixtureCommand(input: {
  organizationId: unknown
  actorEmail: unknown
  browserSessionId: unknown
  commandGlobalId: unknown
  intentHash: unknown
  confirmationStatement: unknown
}) {
  runtimeGate()
  const approval =
    await approveShopifyReversalFixtureCommandInPostgres(input)
  return Object.freeze({
    approvalGlobalId: approval.globalId,
    commandGlobalId: input.commandGlobalId,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    providerWrites: 0 as const,
    oneTime: true as const,
  })
}

export async function prepareShopifyReversalFixtureOrder(input: {
  organizationId: unknown
  actorEmail: unknown
  idempotencyKey: unknown
}) {
  runtimeGate()
  const key = idempotencyKey(input.idempotencyKey)
  const authority = await readShopifyReversalFixtureAuthorityInPostgres(input)
  const replay = await readShopifyReversalFixtureCommandByIdempotencyInPostgres({
    organizationId: input.organizationId,
    phase: 'create_order',
    idempotencyKey: key,
  })
  if (replay) {
    if (replay.actorEmail !== authority.actorEmail) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_IDEMPOTENCY_CONFLICT',
        'Idempotency key is bound to another owner or administrator',
        403,
      )
    }
    return prepareResponse(replay)
  }
  const credential = await liveCredential(authority)
  const globalId =
    await allocateShopifyReversalFixtureCommandGlobalIdInPostgres()
  const sourceIdentifier = `clawpilot-reversal-fixture:${globalId}`
  const uniqueTag = `clawpilot-reversal-${hash({
    version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
    globalId,
    organizationId: authority.organizationId,
  }).slice(0, 24)}`
  const tagFingerprint = shopifyReversalFixtureTagFingerprint(uniqueTag)
  const providerPayloadHash =
    shopifyReversalFixtureOrderProviderPayloadHash({
      shopDomain: credential.shopDomain,
      sourceIdentifier,
      uniqueTag,
    })
  const intentHash = hash({
    version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
    phase: 'create_order',
    globalId,
    organizationId: authority.organizationId,
    actorEmail: authority.actorEmail,
    accountGlobalId: authority.accountGlobalId,
    externalAccountId: authority.externalAccountId,
    credentialGeneration: authority.credentialGeneration,
    controlRowVersion: authority.controlRowVersion,
    grantedScopeDigest: authority.grantedScopeDigest,
    sourceIdentifier,
    uniqueTag,
    tagFingerprint,
    providerPayloadHash,
    orderProfile: SHOPIFY_REVERSAL_FIXTURE_ORDER_PROFILE,
  })
  const statement = confirmationStatement('create_order', intentHash)
  const command = await insertShopifyReversalFixtureCommandInPostgres({
    commandGlobalId: globalId,
    authority,
    phase: 'create_order',
    idempotencyKey: key,
    intentHash,
    confirmationHash: createHash('sha256').update(statement).digest('hex'),
    providerPayloadHash,
    sourceIdentifier,
    uniqueTag,
    tagFingerprint,
  })
  return prepareResponse(command)
}

export async function prepareShopifyReversalFixtureFulfillment(input: {
  organizationId: unknown
  actorEmail: unknown
  idempotencyKey: unknown
  predecessorCommandGlobalId: unknown
  orderGlobalId: unknown
}) {
  runtimeGate()
  const key = idempotencyKey(input.idempotencyKey)
  const authority = await readShopifyReversalFixtureAuthorityInPostgres(input)
  const replay = await readShopifyReversalFixtureCommandByIdempotencyInPostgres({
    organizationId: input.organizationId,
    phase: 'create_fulfillment',
    idempotencyKey: key,
  })
  if (replay) {
    if (replay.actorEmail !== authority.actorEmail) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_IDEMPOTENCY_CONFLICT',
        'Idempotency key is bound to another owner or administrator',
        403,
      )
    }
    return prepareResponse(replay)
  }
  const target =
    await readShopifyReversalFixtureFulfillmentTargetInPostgres({
      organizationId: input.organizationId,
      predecessorCommandGlobalId: input.predecessorCommandGlobalId,
      orderGlobalId: input.orderGlobalId,
    })
  const credential = await liveCredential(authority)
  const globalId =
    await allocateShopifyReversalFixtureCommandGlobalIdInPostgres()
  const trackingNumbers = [`CP-REV-${globalId}`]
  const preparation = await prepareShopifyFulfillmentProviderAttempt(
    credential,
    {
      externalOrderId: target.externalOrderId,
      trackingNumbers,
      carrier: FIXTURE_CARRIER,
      notifyCustomer: false,
      expectedLineItems: target.expectedLines,
    },
  )
  if (preparation.existing) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_ALREADY_EXISTS',
      'The exact fixture fulfillment already exists; no new provider command was prepared',
    )
  }
  const signatureHash = shopifyFulfillmentAttemptSignatureHash(
    preparation.signature,
  )
  const providerPayloadHash =
    shopifyReversalFixtureFulfillmentProviderPayloadHash(
      credential,
      preparation.providerInput,
      preparation.signature,
    )
  const intentHash = hash({
    version: SHOPIFY_REVERSAL_FIXTURE_PROFILE_VERSION,
    phase: 'create_fulfillment',
    globalId,
    organizationId: authority.organizationId,
    actorEmail: authority.actorEmail,
    accountGlobalId: authority.accountGlobalId,
    externalAccountId: authority.externalAccountId,
    credentialGeneration: authority.credentialGeneration,
    controlRowVersion: authority.controlRowVersion,
    grantedScopeDigest: authority.grantedScopeDigest,
    target,
    notifyCustomer: false,
    carrier: FIXTURE_CARRIER,
    trackingNumbers,
    signatureHash,
    providerPayloadHash,
  })
  const statement = confirmationStatement('create_fulfillment', intentHash)
  const command = await insertShopifyReversalFixtureCommandInPostgres({
    commandGlobalId: globalId,
    authority,
    phase: 'create_fulfillment',
    idempotencyKey: key,
    intentHash,
    confirmationHash: createHash('sha256').update(statement).digest('hex'),
    providerPayloadHash,
    fulfillmentTarget: target,
    fulfillmentAttemptSignature: preparation.signature as unknown as
      Record<string, unknown>,
    fulfillmentAttemptSignatureHash: signatureHash,
  })
  return prepareResponse(command)
}

function safeErrorCode(error: unknown, fallback: string) {
  const value = error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
  return /^[A-Z][A-Z0-9_]{1,127}$/u.test(value) ? value : fallback
}

function safeProviderErrorSummary(
  error: unknown,
  providerMutationAttempted: boolean,
) {
  if (
    !providerMutationAttempted
    || !(error instanceof ShopifyReversalFixtureProviderError)
    || typeof error.providerErrorSummary !== 'string'
  ) return null
  const summary = error.providerErrorSummary
  if (
    summary.length < 1
    || summary.length > 500
    || summary !== summary.trim()
    || /[\u0000-\u001f\u007f-\u009f]/u.test(summary)
  ) return null
  const match = /^Shopify rejected order creation \((.+)\)$/u.exec(summary)
  if (!match) return null
  const facts = match[1].split('; ')
  if (facts.length < 1 || facts.some((fact) => {
    const parsed = SAFE_ORDER_CREATE_PROVIDER_ERROR_FACT.exec(fact)
    return !parsed || !SAFE_ORDER_CREATE_PROVIDER_ERROR_CODES.has(parsed[1])
  })) return null
  return summary
}

function safeProviderErrorMessage(
  error: unknown,
  providerMutationAttempted: boolean,
) {
  if (
    !providerMutationAttempted
    || !(error instanceof ShopifyReversalFixtureProviderError)
    || error.outcomeUnknown
    || error.code !== 'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED'
    || typeof error.providerErrorMessage !== 'string'
  ) return null
  const message = error.providerErrorMessage
  if (
    message.length < 1
    || message.length > 240
    || message !== message.trim()
    || /[^\x20-\x7e]/u.test(message)
  ) return null
  return message
}

async function recordOutcomeConservatively(
  input: Parameters<typeof recordShopifyReversalFixtureOutcomeInPostgres>[0],
) {
  try {
    return await recordShopifyReversalFixtureOutcomeInPostgres(input)
  } catch {
    return Object.freeze({
      outcomeGlobalId: null,
      state: 'unknown' as const,
      recordedAt: null,
      outcomePersistence: 'failed' as const,
      errorCode: 'SHOPIFY_REVERSAL_FIXTURE_OUTCOME_PERSISTENCE_UNKNOWN',
    })
  }
}

async function executeOrder(
  claimed: Awaited<ReturnType<
    typeof claimShopifyReversalFixtureCommandInPostgres
  >>,
) {
  const { command } = claimed
  let providerOrder: Awaited<ReturnType<
    typeof createShopifyReversalFixtureOrder
  >> | null = null
  let outcomeInput: Parameters<
    typeof recordShopifyReversalFixtureOutcomeInPostgres
  >[0]
  try {
    const credential = await liveCredential(command.authority)
    if (!command.sourceIdentifier || !command.uniqueTag) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_COMMAND_INVALID',
        'The order fixture command is incomplete',
        500,
      )
    }
    providerOrder = await createShopifyReversalFixtureOrder(credential, {
      sourceIdentifier: command.sourceIdentifier,
      uniqueTag: command.uniqueTag,
      claim: {
        organizationId: command.organizationId,
        commandId: command.id,
        attemptId: claimed.attemptId,
        actorEmail: command.actorEmail,
      },
    })
    outcomeInput = {
      command,
      attemptId: claimed.attemptId,
      outcomeState: 'succeeded',
      providerMutationAttempted: true,
      providerWrites: 1,
      providerReference: providerOrder.id,
      providerOrderId: providerOrder.id,
      providerOrderName: providerOrder.name,
      providerOrderUpdatedAt: providerOrder.updatedAt,
      evidenceHash: hash(providerOrder),
    }
  } catch (error) {
    const providerMutationAttempted =
      error instanceof ShopifyReversalFixtureProviderError
      && error.providerMutationAttempted
    const unknown = providerMutationAttempted
      && error instanceof ShopifyReversalFixtureProviderError
      && error.outcomeUnknown
    const providerErrorSummary = safeProviderErrorSummary(
      error,
      providerMutationAttempted,
    )
    const providerErrorMessage = safeProviderErrorMessage(
      error,
      providerMutationAttempted,
    )
    outcomeInput = {
      command,
      attemptId: claimed.attemptId,
      outcomeState: unknown ? 'unknown' : 'rejected',
      providerMutationAttempted,
      providerWrites: unknown ? null : 0,
      errorCode: safeErrorCode(
        error,
        unknown
          ? 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
          : 'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
      ),
      ...(providerErrorSummary ? { providerErrorSummary } : {}),
      ...(providerErrorMessage ? { providerErrorMessage } : {}),
    }
  }
  const outcome = await recordOutcomeConservatively(outcomeInput)
  const evidenceDurable = outcome.outcomeGlobalId !== null
  return {
    ...outcome,
    providerOrderId: evidenceDurable ? providerOrder?.id || null : null,
    providerOrderName: evidenceDurable ? providerOrder?.name || null : null,
  }
}

function fulfillmentProviderInput(
  command: ShopifyReversalFixtureCommand,
): ShopifyFulfillmentProviderInput {
  const signature = command.fulfillmentAttemptSignature as unknown as
    ShopifyFulfillmentAttemptSignature | null
  if (
    !signature
    || !command.externalOrderId
    || !command.expectedLines
    || shopifyFulfillmentAttemptSignatureHash(signature)
      !== command.fulfillmentAttemptSignatureHash
  ) {
    fail(
      'SHOPIFY_REVERSAL_FIXTURE_SIGNATURE_INVALID',
      'The immutable fulfillment signature is missing or corrupt',
      500,
    )
  }
  return {
    externalOrderId: command.externalOrderId,
    trackingNumbers: [...signature.trackingNumbers],
    carrier: signature.carrier,
    notifyCustomer: false,
    expectedLineItems: [...command.expectedLines],
    sandboxE2eAuthorityKind: null,
    allowLegacySignatureWithoutAuthorityKind: false,
  }
}

async function executeFulfillment(
  claimed: Awaited<ReturnType<
    typeof claimShopifyReversalFixtureCommandInPostgres
  >>,
) {
  const { command } = claimed
  let providerReference: string | null = null
  let outcomeInput: Parameters<
    typeof recordShopifyReversalFixtureOutcomeInPostgres
  >[0]
  try {
    const providerInput = fulfillmentProviderInput(command)
    const credential = await liveCredential(command.authority)
    const result = await executeShopifyReversalFixtureFulfillmentProviderAttempt(
      credential,
      providerInput,
      command.fulfillmentAttemptSignature,
      {
        organizationId: command.organizationId,
        commandId: command.id,
        attemptId: claimed.attemptId,
        actorEmail: command.actorEmail,
      },
    )
    providerReference = result.providerReference
    if (result.replayed) {
      outcomeInput = {
        command,
        attemptId: claimed.attemptId,
        outcomeState: 'rejected',
        providerMutationAttempted: false,
        providerWrites: 0,
        providerReference: result.providerReference,
        providerOrderId: command.externalOrderId,
        errorCode: 'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_ALREADY_EXISTS',
        evidenceHash: hash({
          signatureHash: command.fulfillmentAttemptSignatureHash,
          providerReference: result.providerReference,
          resolution: 'preexisting',
        }),
      }
    } else {
      outcomeInput = {
        command,
        attemptId: claimed.attemptId,
        outcomeState: 'succeeded',
        providerMutationAttempted: true,
        providerWrites: 1,
        providerReference: result.providerReference,
        providerOrderId: command.externalOrderId,
        evidenceHash: hash({
          signatureHash: command.fulfillmentAttemptSignatureHash,
          providerReference: result.providerReference,
        }),
      }
    }
  } catch (error) {
    const explicitRejection = error instanceof ShopifyFulfillmentWritebackError
      && error.code === 'SHOPIFY_FULFILLMENT_REJECTED'
    const providerMutationAttempted =
      error instanceof ShopifyFulfillmentWritebackError
      && (error.outcomeUnknown || explicitRejection)
    const unknown = error instanceof ShopifyFulfillmentWritebackError
      && error.outcomeUnknown
    outcomeInput = {
      command,
      attemptId: claimed.attemptId,
      outcomeState: unknown ? 'unknown' : 'rejected',
      providerMutationAttempted,
      providerWrites: unknown ? null : 0,
      providerOrderId: command.externalOrderId,
      errorCode: safeErrorCode(
        error,
        unknown
          ? 'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_OUTCOME_UNKNOWN'
          : 'SHOPIFY_REVERSAL_FIXTURE_FULFILLMENT_REJECTED',
      ),
    }
  }
  const outcome = await recordOutcomeConservatively(outcomeInput)
  return {
    ...outcome,
    providerOrderId: command.externalOrderId,
    providerReference: outcome.outcomeGlobalId === null
      ? null
      : providerReference,
  }
}

export async function executeShopifyReversalFixtureCommand(input: {
  organizationId: unknown
  actorEmail: unknown
  commandGlobalId: unknown
  intentHash: unknown
  confirmationStatement: unknown
}) {
  runtimeGate()
  const claimed = await claimShopifyReversalFixtureCommandInPostgres(input)
  const result = claimed.command.phase === 'create_order'
    ? await executeOrder(claimed)
    : await executeFulfillment(claimed)
  return Object.freeze({
    commandGlobalId: claimed.command.globalId,
    attemptGlobalId: claimed.attemptGlobalId,
    phase: claimed.command.phase,
    ...result,
    retryAllowed: false as const,
    reconciliationRequired: result.state === 'unknown',
  })
}

export async function reconcileShopifyReversalFixtureCommand(input: {
  organizationId: unknown
  actorEmail: unknown
  commandGlobalId: unknown
}) {
  runtimeGate()
  const unknown = await readUnknownShopifyReversalFixtureCommandInPostgres(input)
  const { command } = unknown
  const credential = await liveCredential(command.authority)
  if (command.phase === 'create_order') {
    if (!command.sourceIdentifier || !command.uniqueTag) {
      fail(
        'SHOPIFY_REVERSAL_FIXTURE_COMMAND_INVALID',
        'The order fixture command is incomplete',
        500,
      )
    }
    const result = await reconcileShopifyReversalFixtureOrder(credential, {
      sourceIdentifier: command.sourceIdentifier,
      uniqueTag: command.uniqueTag,
    })
    const state = `reconciled_${result.resolution}` as const
    const outcome = await recordShopifyReversalFixtureOutcomeInPostgres({
      command,
      attemptId: unknown.attemptId,
      outcomeState: state,
      providerMutationAttempted: false,
      providerWrites: 0,
      providerReference: result.order?.id || null,
      providerOrderId: result.order?.id || null,
      providerOrderName: result.order?.name || null,
      providerOrderUpdatedAt: result.order?.updatedAt || null,
      evidenceHash: result.evidenceHash,
    })
    return Object.freeze({
      commandGlobalId: command.globalId,
      phase: command.phase,
      ...outcome,
      providerOrderId: result.order?.id || null,
      retryAllowed: false as const,
      providerWrites: 0 as const,
    })
  }
  const providerInput = fulfillmentProviderInput(command)
  let result
  try {
    result = await readShopifyFulfillment(
      credential,
      providerInput,
      command.fulfillmentAttemptSignature,
    )
  } catch (error) {
    if (
      error instanceof ShopifyFulfillmentWritebackError
      && error.code === 'SHOPIFY_FULFILLMENT_RECONCILIATION_AMBIGUOUS'
    ) {
      const outcome = await recordShopifyReversalFixtureOutcomeInPostgres({
        command,
        attemptId: unknown.attemptId,
        outcomeState: 'reconciled_ambiguous',
        providerMutationAttempted: false,
        providerWrites: 0,
        providerOrderId: command.externalOrderId,
        errorCode: error.code,
        evidenceHash: hash({
          signatureHash: command.fulfillmentAttemptSignatureHash,
          resolution: 'ambiguous',
        }),
      })
      return Object.freeze({
        commandGlobalId: command.globalId,
        phase: command.phase,
        ...outcome,
        providerReference: null,
        retryAllowed: false as const,
        providerWrites: 0 as const,
      })
    }
    throw error
  }
  const outcome = await recordShopifyReversalFixtureOutcomeInPostgres({
    command,
    attemptId: unknown.attemptId,
    outcomeState: result ? 'reconciled_applied' : 'reconciled_absent',
    providerMutationAttempted: false,
    providerWrites: 0,
    providerReference: result?.providerReference || null,
    providerOrderId: command.externalOrderId,
    evidenceHash: hash({
      signatureHash: command.fulfillmentAttemptSignatureHash,
      resolution: result ? 'applied' : 'absent',
      providerReference: result?.providerReference || null,
    }),
  })
  return Object.freeze({
    commandGlobalId: command.globalId,
    phase: command.phase,
    ...outcome,
    providerReference: result?.providerReference || null,
    retryAllowed: false as const,
    providerWrites: 0 as const,
  })
}

export async function readShopifyReversalFixtureStatus(input: {
  organizationId: unknown
  commandGlobalId: unknown
}) {
  runtimeGate()
  return readShopifyReversalFixtureCommandStateInPostgres(input)
}

export const SHOPIFY_REVERSAL_FIXTURE_CONFIRMATIONS = Object.freeze({
  createOrderPrefix: CREATE_CONFIRMATION_PREFIX,
  createFulfillmentPrefix: FULFILL_CONFIRMATION_PREFIX,
})
