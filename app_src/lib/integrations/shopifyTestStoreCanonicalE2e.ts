import {
  decryptCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import {
  hasEffectiveShopifyScope,
} from '@/lib/integrations/commerceCapabilities'
import {
  normalizeShopifyShopDomain,
  probeShopifyConnection,
  requestShopifyAccessToken,
  shopifyAdminGraphql,
  ShopifyCommerceClientError,
  type ShopifyCommerceRuntimeCredential,
} from '@/lib/integrations/shopifyCommerceClient'
import {
  shopifyOrderManagementRuntime,
} from '@/lib/integrations/shopifyOrderManagementRuntime'
import {
  persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres,
  readShopifyTestStoreCanonicalE2eTargetFromPostgres,
  type ShopifyTestStoreCanonicalE2eProviderProof,
  type ShopifyTestStoreCanonicalE2eTarget,
} from '@/lib/persistence/shopifyTestStoreCanonicalE2e'
import {
  readCommerceRuntimeCredentialFromPostgres,
} from '@/lib/persistence/commerceIntegrations'
import {
  SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
} from '@/lib/operations/shopifyTestStoreCanonicalE2e'

const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/
const REQUIRED_SCOPES = [
  'read_orders',
  'write_merchant_managed_fulfillment_orders',
] as const

const SHOPIFY_TEST_ORDER_PROOF_QUERY = `query ClawPilotShopifyTestOrderProof($id: ID!) {
  order(id: $id) {
    id
    test
    updatedAt
  }
}`

export class ShopifyTestStoreCanonicalE2eError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ShopifyTestStoreCanonicalE2eError'
  }
}

function fail(
  code: string,
  message: string,
  status = 409,
  retryable = false,
): never {
  throw new ShopifyTestStoreCanonicalE2eError(
    code,
    message,
    status,
    retryable,
  )
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
      true,
    )
  }
  return value as Record<string, unknown>
}

function providerTimestamp(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || value.length < 20
    || value.length > 64
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
      true,
    )
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_RESPONSE_INVALID',
      `Shopify returned malformed ${label}`,
      502,
      true,
    )
  }
  return parsed.toISOString()
}

export function normalizeShopifyTestOrderProofResponse(
  value: unknown,
  target: ShopifyTestStoreCanonicalE2eTarget,
  verifiedAt: string,
): ShopifyTestStoreCanonicalE2eProviderProof {
  const response = record(value, 'test-order proof')
  if (response.order === null || response.order === undefined) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_ORDER_NOT_FOUND',
      'The exact Shopify order no longer exists',
      409,
    )
  }
  const order = record(response.order, 'test-order proof.order')
  if (
    typeof order.id !== 'string'
    || !SHOPIFY_ORDER_GID.test(order.id)
    || order.id !== target.order.externalOrderId
  ) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_ORDER_CHANGED',
      'Shopify returned a different order identity',
      409,
    )
  }
  if (typeof order.test !== 'boolean') {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_TEST_UNPROVEN',
      'Shopify did not return an authoritative boolean test-order field',
      502,
      true,
    )
  }
  if (order.test !== true) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_TEST_REQUIRED',
      'Shopify positively identifies this as a non-test order; authorization is blocked',
      422,
    )
  }
  const verified = providerTimestamp(verifiedAt, 'verification time')
  const updatedAt = providerTimestamp(order.updatedAt, 'order.updatedAt')
  if (Date.parse(updatedAt) > Date.parse(verified)) {
    fail(
      'SHOPIFY_TEST_E2E_PROVIDER_TIME_INVALID',
      'Shopify returned an order update time after the verification time',
      502,
      true,
    )
  }
  return {
    version: SHOPIFY_TEST_STORE_CANONICAL_E2E_PROOF_VERSION,
    activationRevision: target.activationRevision,
    accountGlobalId: target.account.globalId,
    externalAccountId: target.account.externalAccountId,
    credentialGeneration: target.account.credentialGeneration,
    orderGlobalId: target.order.globalId,
    orderRowVersion: target.order.rowVersion,
    externalOrderId: target.order.externalOrderId,
    candidateGlobalId: target.candidate.globalId,
    candidateRowVersion: target.candidate.rowVersion,
    candidateSourceRevision: target.candidate.sourceRevision,
    candidateSourceHash: target.candidate.sourceHash,
    providerOrderUpdatedAt: updatedAt,
    providerVerifiedAt: verified,
    test: true,
  }
}

export async function readShopifyTestOrderProof(
  credential: ShopifyCommerceRuntimeCredential,
  target: ShopifyTestStoreCanonicalE2eTarget,
  verifiedAt = new Date().toISOString(),
) {
  try {
    const data = await shopifyAdminGraphql<{ order?: unknown }>(
      credential,
      {
        query: SHOPIFY_TEST_ORDER_PROOF_QUERY,
        operationName: 'ClawPilotShopifyTestOrderProof',
        variables: { id: target.order.externalOrderId },
      },
      { timeoutMs: 12_000 },
    )
    return normalizeShopifyTestOrderProofResponse(data, target, verifiedAt)
  } catch (error) {
    if (error instanceof ShopifyTestStoreCanonicalE2eError) throw error
    if (error instanceof ShopifyCommerceClientError) {
      throw new ShopifyTestStoreCanonicalE2eError(
        'SHOPIFY_TEST_E2E_PROVIDER_READ_FAILED',
        'Shopify test-order verification is temporarily unavailable',
        error.status >= 500 ? error.status : 502,
        error.retryable,
      )
    }
    throw error
  }
}

type Dependencies = {
  readTarget: typeof readShopifyTestStoreCanonicalE2eTargetFromPostgres
  readRuntimeCredential: typeof readCommerceRuntimeCredentialFromPostgres
  decryptCredential: typeof decryptCommerceCredential
  requestAccessToken: typeof requestShopifyAccessToken
  probeConnection: typeof probeShopifyConnection
  readProof: typeof readShopifyTestOrderProof
  persistAuthorization:
    typeof persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres
  now: () => string
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  readTarget: readShopifyTestStoreCanonicalE2eTargetFromPostgres,
  readRuntimeCredential: readCommerceRuntimeCredentialFromPostgres,
  decryptCredential: decryptCommerceCredential,
  requestAccessToken: requestShopifyAccessToken,
  probeConnection: probeShopifyConnection,
  readProof: readShopifyTestOrderProof,
  persistAuthorization:
    persistShopifyTestStoreCanonicalE2eAuthorizationInPostgres,
  now: () => new Date().toISOString(),
}

export async function authorizeShopifyTestStoreCanonicalE2e(input: {
  organizationId: unknown
  actorEmail: unknown
  idempotencyKey: unknown
  orderGlobalId: unknown
  expectedOrderRowVersion: unknown
  confirmationStatement: unknown
  reason: unknown
  lifetimeMinutes?: unknown
}, dependencies: Dependencies = DEFAULT_DEPENDENCIES) {
  const runtimeGate = shopifyOrderManagementRuntime()
  if (!runtimeGate.available) {
    fail(
      runtimeGate.blockerCode || 'SHOPIFY_TEST_E2E_RUNTIME_DISABLED',
      'Exact Shopify test-order writes are disabled in this runtime',
      403,
    )
  }
  const target = await dependencies.readTarget({
    organizationId: input.organizationId,
    orderGlobalId: input.orderGlobalId,
    expectedOrderRowVersion: input.expectedOrderRowVersion,
  })
  if (!runtimeGate.allowedAccountGlobalIds.includes(target.account.globalId)) {
    fail(
      'SHOPIFY_TEST_E2E_ACCOUNT_NOT_ALLOWLISTED',
      'This Shopify sandbox account is not in the exact test-write allowlist',
      403,
    )
  }
  const runtime = await dependencies.readRuntimeCredential({
    organizationId: target.organizationId,
    accountGlobalId: target.account.globalId,
  })
  if (
    !runtime
    || runtime.provider !== 'shopify'
    || runtime.environment !== 'sandbox'
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.integrationAccountId !== target.account.id
    || runtime.externalAccountId !== target.account.externalAccountId
    || runtime.credentialVersion !== target.account.credentialGeneration
  ) {
    fail(
      'SHOPIFY_TEST_E2E_CONNECTION_INVALID',
      'The exact active verified Shopify sandbox credential is required',
    )
  }
  const decrypted = dependencies.decryptCredential(
    runtime.encrypted,
    runtime.organizationId,
    runtime.provider,
    runtime.environment,
    runtime.externalAccountId,
  )
  if (decrypted.provider !== 'shopify') {
    fail(
      'SHOPIFY_TEST_E2E_CREDENTIAL_INVALID',
      'Stored Shopify credentials could not be decrypted',
      500,
    )
  }
  const shopDomain = normalizeShopifyShopDomain(
    runtime.configuration.shopDomain,
  )
  const grant = await dependencies.requestAccessToken({
    shopDomain,
    clientId: decrypted.clientId,
    clientSecret: decrypted.clientSecret,
  })
  const probe = await dependencies.probeConnection({
    shopDomain,
    accessToken: grant.accessToken,
  })
  if (
    probe.shopId !== runtime.externalAccountId
    || probe.shopId !== target.account.externalAccountId
  ) {
    fail(
      'SHOPIFY_TEST_E2E_STORE_CHANGED',
      'Shopify returned a different store identity',
    )
  }
  const missingScopes = REQUIRED_SCOPES.filter((scope) => (
    !hasEffectiveShopifyScope(grant.grantedScopes, scope)
    || !hasEffectiveShopifyScope(probe.grantedScopes, scope)
  ))
  if (missingScopes.length) {
    fail(
      'SHOPIFY_TEST_E2E_SCOPE_REQUIRED',
      `Shopify must grant ${missingScopes.join(' and ')} for this exact test lane`,
    )
  }
  const verifiedAt = dependencies.now()
  const proof = await dependencies.readProof(
    { shopDomain, accessToken: grant.accessToken },
    target,
    verifiedAt,
  )
  return dependencies.persistAuthorization({
    organizationId: target.organizationId,
    actorEmail: input.actorEmail,
    idempotencyKey: input.idempotencyKey,
    confirmationStatement: input.confirmationStatement,
    reason: input.reason,
    lifetimeMinutes: input.lifetimeMinutes,
    proof,
  })
}
